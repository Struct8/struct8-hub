import { register } from '../../core/registry.js';
import type { Ctx, Envelope } from '../../core/types.js';
import * as aws from '../../providers/aws.js';
import '../../providers/postgres.js';
import * as sql from '../../providers/sql.js';

/**
 * Where the messages land. One table, created on first use.
 *
 * The primary key is the idempotency rule. A batched source redelivers, and an insert with no key
 * turns one redelivery into a second row indistinguishable from a real second message. A message
 * is identified by the chain it belongs to (`trace`), the hops it has made (`path`), who stored it
 * (`receiver`) and what it said (`digest`): the last one is there because several items of one
 * batch can share a trace and a path, and without it the second would be dropped as a duplicate of
 * the first.
 */
const CREATE_TABLE = `create table if not exists hub_messages (
	trace      text        not null,
	path       text        not null,
	receiver   text        not null,
	digest     text        not null,
	hops       integer     not null,
	sent_at    timestamptz not null,
	body       text        not null,
	stored_at  timestamptz not null default now(),
	primary key (trace, path, receiver, digest)
)`;

const INSERT = `insert into hub_messages (trace, path, receiver, digest, hops, sent_at, body)
	values ($1, $2, $3, $4, $5, $6, $7)
	on conflict do nothing`;

const sha256 = async (text: string): Promise<string> =>
	[...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');

/**
 * Reads the master credential out of the secret RDS manages for the instance.
 *
 * The generated policy grants `secretsmanager:GetSecretValue` on exactly this secret, which is why
 * the module reads it and does not ask for a password in an environment variable: the variable
 * would sit in the function's configuration, readable by anyone who can read the function.
 *
 * Read on every send and not cached. The secret rotates, and a cached copy is the rotation's
 * failure waiting for a warm container to hit it; the call costs a fraction of a cent per
 * thousand.
 *
 * NOTHING OF THE SECRET'S CONTENT GOES INTO AN ERROR. `JSON.parse` quotes the text it choked on,
 * which here is a password, so a parse failure is caught and replaced by a sentence that says
 * nothing about what was inside.
 */
async function credentialsFrom(secretArn: string, region: string, fetchImpl: typeof fetch): Promise<sql.Credentials> {
	const answer = (await aws.json(
		'secretsmanager',
		region,
		'secretsmanager.GetSecretValue',
		{ SecretId: secretArn },
		fetchImpl
	)) as { SecretString?: unknown } | null;

	let parsed: { username?: unknown; password?: unknown } | null = null;
	if (typeof answer?.SecretString === 'string') {
		try {
			parsed = JSON.parse(answer.SecretString) as { username?: unknown; password?: unknown };
		} catch {
			parsed = null;
		}
	}

	if (typeof parsed?.username !== 'string' || typeof parsed.password !== 'string') {
		throw new Error('the secret does not carry a username and a password as JSON');
	}
	return { user: parsed.username, password: parsed.password };
}

/**
 * Creates the table if it is missing.
 *
 * Tried twice, on purpose. Two functions running the same `create table if not exists` at the same
 * moment can still collide inside the catalog (a unique violation on the type name), and the one
 * that loses sees an error although the table now exists. The retry finds it there. A second
 * failure is a real one and is not hidden.
 */
async function ensureTable(connection: sql.Connection): Promise<void> {
	try {
		await connection.run(CREATE_TABLE);
	} catch {
		await connection.run(CREATE_TABLE);
	}
}

async function store(connection: sql.Connection, envelope: Envelope, ctx: Ctx): Promise<void> {
	await ensureTable(connection);

	// The columns, and not `seal(envelope)`. Sealing is for a message that another Hub will read
	// back, so that the chain keeps its id and its remaining budget; nothing reads a row of this
	// table as a message, and the same fields are here as columns, where they can be queried.
	await connection.run(INSERT, [
		envelope.trace,
		envelope.path.join(' > '),
		ctx.self,
		await sha256(envelope.body),
		envelope.hops,
		envelope.at,
		envelope.body,
	]);
}

register({
	type: 'aws_db_instance',
	keys: ['DB_NAME', 'SECRET_ARN', 'ENGINE'],
	capabilities: ['table'],

	/**
	 * Writes the message into `hub_messages`.
	 *
	 * WHICH DATABASE IS IT? The wire says: `ENGINE` is exported by the catalog from the instance's
	 * own `engine`, so nothing is guessed from a port number (a Postgres on 3306 is legal) and the
	 * RDS API is never called (it would need a permission the wire does not grant, and an endpoint
	 * inside the VPC). The engine picks the driver in `providers/sql.ts`; a MySQL arrives as an
	 * engine with no driver and is refused by name.
	 *
	 * The refusal comes before the secret is read: there is no reason to fetch a credential for a
	 * database this build cannot open.
	 */
	async send(n, envelope, ctx) {
		const endpoint = n.props['ENDPOINT'];
		if (!endpoint) throw new Error('no endpoint on the wire');

		const engine = n.props['ENGINE'];
		if (!engine) {
			throw new Error('no engine on the wire: the diagram was compiled before the engine was exported, compile it again');
		}

		const secretArn = n.props['SECRET_ARN'];
		if (!secretArn) {
			throw new Error('no secret on the wire: the instance has no managed master password');
		}

		const database = n.props['DB_NAME'];
		if (!database) throw new Error('no database name on the wire');

		const region = ctx.region(n);
		if (!region) throw new Error('no region for the database and none for the workload');

		sql.assertSupported(engine);
		const { host, port } = sql.parseEndpoint(endpoint, engine);

		const credentials = await credentialsFrom(secretArn, region, ctx.fetch);
		const connection = await sql.connect(engine, { host, port, database }, credentials);
		try {
			await store(connection, envelope, ctx);
		} finally {
			await connection.close();
		}
	},
});
