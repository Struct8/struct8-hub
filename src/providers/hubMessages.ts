/**
 * What a workload writes into a relational database.
 *
 * Shared by every resource that is a way into a database: an RDS instance, an Aurora cluster, and
 * an RDS Proxy in front of either. They reach the same table and write the same row; what differs
 * is how the wire says where the database is and how to log in (`providers/rdsLogin.ts`), which
 * stays in each module.
 */

import type { Ctx, Envelope } from '../core/types.js';
import * as rdsLogin from './rdsLogin.js';
import * as sql from './sql.js';

/** One dialect's way of creating the table and writing a row into it. */
interface Statements {
	readonly create: string;
	readonly insert: string;
	row(envelope: Envelope, ctx: Ctx): Promise<unknown[]>;
}

const sha256 = async (text: string): Promise<string> =>
	[...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');

/** The columns every dialect stores, in the order the statements below take them. */
const columns = async (envelope: Envelope, ctx: Ctx) => ({
	trace: envelope.trace,
	path: envelope.path.join(' > '),
	receiver: ctx.self,
	digest: await sha256(envelope.body),
	hops: envelope.hops,
	at: envelope.at,
	body: envelope.body,
});

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
 * `cast(... as timestamptz)` because the RDS Data API sends a string typed as `varchar`, and
 * PostgreSQL turns a string into a timestamp only when told to. `pg` sends it untyped, which the
 * cast types the same way the column did before it.
 */
const POSTGRES: Statements = {
	create: `create table if not exists hub_messages (
	trace      text        not null,
	path       text        not null,
	receiver   text        not null,
	digest     text        not null,
	hops       integer     not null,
	sent_at    timestamptz not null,
	body       text        not null,
	stored_at  timestamptz not null default now(),
	primary key (trace, path, receiver, digest)
)`,
	insert: `insert into hub_messages (trace, path, receiver, digest, hops, sent_at, body)
	values ($1, $2, $3, $4, $5, cast($6 as timestamptz), $7)
	on conflict do nothing`,
	async row(envelope, ctx) {
		const c = await columns(envelope, ctx);
		return [c.trace, c.path, c.receiver, c.digest, c.hops, c.at, c.body];
	},
};

/**
 * The same table in MySQL, which an Aurora MySQL cluster reaches through the RDS Data API.
 *
 * Two differences, both forced. A key in MySQL cannot hold a `text` column, and the four columns
 * that identify a message can be longer together than an index takes, so the key is one column, the
 * SHA-256 of the four. And a MySQL `datetime` refuses the `T` and the `Z` of an ISO timestamp, so
 * the time is written the way it takes it, in UTC.
 */
const MYSQL: Statements = {
	create: `create table if not exists hub_messages (
	id         char(64)     not null,
	trace      varchar(255) not null,
	path       text         not null,
	receiver   varchar(255) not null,
	digest     char(64)     not null,
	hops       integer      not null,
	sent_at    datetime(3)  not null,
	body       longtext     not null,
	stored_at  datetime(3)  not null default current_timestamp(3),
	primary key (id)
)`,
	insert: `insert ignore into hub_messages (id, trace, path, receiver, digest, hops, sent_at, body)
	values ($1, $2, $3, $4, $5, $6, $7, $8)`,
	async row(envelope, ctx) {
		const c = await columns(envelope, ctx);
		const id = await sha256([c.trace, c.path, c.receiver, c.digest].join('\n'));
		const when = new Date(c.at);
		const sentAt = Number.isNaN(when.getTime()) ? c.at : when.toISOString().replace('T', ' ').replace('Z', '');
		return [id, c.trace, c.path, c.receiver, c.digest, c.hops, sentAt, c.body];
	},
};

const STATEMENTS: Readonly<Record<sql.Dialect, Statements>> = { postgres: POSTGRES, mysql: MYSQL };

/**
 * Whether a failure says the user may not create a table, where it may still write into one.
 *
 * PostgreSQL checks the schema permission before it looks for the table, so `create table if not
 * exists` fails for such a user even when the table is there — and from PostgreSQL 15 on, a user
 * that is not the database owner has no permission to create in `public` unless it is granted. The
 * IAM user is the ordinary case.
 */
const mayNotCreate = (err: unknown): boolean => {
	const code = sql.codeOf(err);
	if (code === '42501') return true;
	return code === '42000' && err instanceof Error && /command denied/i.test(err.message);
};

/**
 * Creates the table if it is missing.
 *
 * Tried twice, on purpose. Two functions running the same `create table if not exists` at the same
 * moment can still collide inside the catalog (a unique violation on the type name), and the one
 * that loses sees an error although the table now exists. The retry finds it there. A second
 * failure is a real one and is not hidden.
 *
 * A user that may not create tables is not refused here: the insert that follows is what says
 * whether it may write into the table that exists, and a table that does not exist is reported by
 * that insert.
 */
export async function ensureTable(connection: sql.Connection, dialect: sql.Dialect = 'postgres'): Promise<void> {
	const create = STATEMENTS[dialect].create;
	try {
		await connection.run(create);
	} catch (err) {
		if (mayNotCreate(err)) return;
		try {
			await connection.run(create);
		} catch (again) {
			if (mayNotCreate(again)) return;
			throw again;
		}
	}
}

/** Writes the message into `hub_messages`, creating the table first if it is missing. */
export async function store(
	connection: sql.Connection,
	envelope: Envelope,
	ctx: Ctx,
	dialect: sql.Dialect = 'postgres'
): Promise<void> {
	await ensureTable(connection, dialect);

	// The columns, and not `seal(envelope)`. Sealing is for a message that another Hub will read
	// back, so that the chain keeps its id and its remaining budget; nothing reads a row of this
	// table as a message, and the same fields are here as columns, where they can be queried.
	const statements = STATEMENTS[dialect];
	await connection.run(statements.insert, await statements.row(envelope, ctx));
}

/**
 * The failures of an IAM user's write that the secret's user can fix: the table does not exist and
 * the IAM user may not create it (`42P01`), or the table exists and the IAM user may not write into
 * it (`42501`).
 */
const NEEDS_GRANT = new Set(['42P01', '42501']);

/**
 * Creates the table, if it is missing, and lets `user` write into it — logged in as the secret's
 * user, the master user of a database reached directly.
 */
async function grantTable(
	engine: string,
	target: sql.Target,
	user: string,
	secretArn: string,
	region: string,
	fetchImpl: typeof fetch,
	options?: sql.ConnectOptions
): Promise<void> {
	const connection = await rdsLogin.asSecretUser(engine, target, secretArn, region, fetchImpl, options);
	try {
		await ensureTable(connection, 'postgres');
		await connection.run(`grant insert on hub_messages to ${rdsLogin.quoted(user)}`);
	} finally {
		await connection.close();
	}
}

/**
 * Logs in the way the wire says and writes the message.
 *
 * An IAM user is a user with no privilege of its own, and the database gives it none. When its
 * write fails for want of the table or of the permission to write into it, and the wire carries the
 * master user's secret, the table is created and the permission granted as that user, and the
 * write is tried once more. Through a proxy it never is (see `rdsLogin.Login.proxy`).
 */
export async function write(
	engine: string,
	target: sql.Target,
	login: rdsLogin.Login,
	region: string,
	envelope: Envelope,
	ctx: Ctx,
	options?: sql.ConnectOptions
): Promise<void> {
	const once = async (): Promise<void> => {
		const connection = await rdsLogin.open(engine, target, login, region, ctx.fetch, options);
		try {
			await store(connection, envelope, ctx);
		} finally {
			await connection.close();
		}
	};

	try {
		await once();
		return;
	} catch (err) {
		const fixable =
			login.iamUser && login.secretArn && !login.proxy && sql.dialectOf(engine) === 'postgres' && NEEDS_GRANT.has(sql.codeOf(err));
		if (!fixable) throw err;
	}

	await grantTable(engine, target, login.iamUser!, login.secretArn!, region, ctx.fetch, options);
	await once();
}
