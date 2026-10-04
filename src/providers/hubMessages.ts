/**
 * What a workload writes into a relational database, and the credential it writes with.
 *
 * Shared by every resource that is a way into a database: an RDS instance, and an RDS Proxy in front
 * of one. The two reach the same table and write the same row; what differs is how the wire says
 * where the database is, which stays in each module.
 */

import type { Ctx, Envelope } from '../core/types.js';
import * as aws from './aws.js';
import type * as sql from './sql.js';

/**
 * Where the messages land. One table, created on first use.
 *
 * The primary key is the idempotency rule. A batched source redelivers, and an insert with no key
 * turns one redelivery into a second row indistinguishable from a real second message. A message
 * is identified by the chain it belongs to (`trace`), the hops it has made (`path`), who stored it
 * (`receiver`) and what it said (`digest`): the last one is there because several items of one
 * batch can share a trace and a path, and without it the second would be dropped as a duplicate of
 * the first.
 *
 * Postgres SQL, as is the insert below: `$n` placeholders, `timestamptz`, `on conflict`. A family
 * with another dialect (MySQL takes `?`, `insert ignore`, and no `text` column in a key) brings its
 * own pair.
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
 * Reads a database credential out of a Secrets Manager secret: the one RDS manages for an
 * instance's master user, or the one an RDS Proxy checks its clients against.
 *
 * The generated policy grants `secretsmanager:GetSecretValue` on exactly that secret, which is why
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
export async function credentialsFrom(secretArn: string, region: string, fetchImpl: typeof fetch): Promise<sql.Credentials> {
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

/** Writes the message into `hub_messages`, creating the table first if it is missing. */
export async function store(connection: sql.Connection, envelope: Envelope, ctx: Ctx): Promise<void> {
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
