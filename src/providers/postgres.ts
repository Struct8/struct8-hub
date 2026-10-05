/**
 * The Postgres driver: `pg`, bundled into the function.
 *
 * Importing this file registers it (see `providers/sql.ts`), so a resource that can reach a
 * Postgres imports it and a deployment that has no such resource never carries it.
 *
 * WHY A LIBRARY AND NOT THE PROTOCOL BY HAND. The part of a database client that goes wrong is
 * authentication — SCRAM-SHA-256 is a three-message exchange with PBKDF2 and two HMACs, and a
 * mistake in it fails only against a real server. The databases this talks to are private, so a
 * mistake would surface one apply at a time. `pg` has years of use under exactly that exchange.
 *
 * It does not need a Lambda layer: the bundler inlines it, the same way it inlines `aws4fetch`,
 * and the function still ships one file. (`pg-native`, the optional compiled binding, is never
 * reached and is left external.)
 */

import pg from 'pg';
import type { ClientConfig } from 'pg';

import { lambdaBundle, trustedAuthorities, UNTRUSTED, UNTRUSTED_HINT } from './rdsCa.js';
import { useDriver, type ConnectOptions, type Connection, type Credentials, type Driver, type Target } from './sql.js';

/**
 * What a connection trusts: Node's own list plus the Lambda runtime's bundle of the RDS authorities.
 * `providers/rdsCa.ts` says why both, and why a connection is never downgraded to an unverified
 * one. It lives there because a DocumentDB cluster is issued its certificate by the same authorities.
 */
export { trustedAuthorities };

/**
 * How long to wait, in milliseconds: for the connection, then for each statement.
 *
 * Not decoration: a function in a subnet with no route to the database does not fail, it WAITS,
 * and the wait is billed up to the function's own timeout. Five seconds is far above a healthy
 * handshake and far below thirty.
 *
 * THE STATEMENT LIMIT IS THE CLIENT'S (`query_timeout`), NOT THE SERVER'S (`statement_timeout`).
 * `pg` sends `statement_timeout` in the startup message, and an RDS Proxy refuses the connection
 * over it: "0A000: Feature not supported: RDS Proxy currently doesn't support the option
 * statement_timeout", measured on 2026-10-04. Sending it after connecting, with `SET`, would pin
 * the client to one database connection, which is what a proxy exists to avoid. A database reached
 * directly accepted it; what it loses is the cancellation on the server side, while the function
 * still stops waiting after the same five seconds.
 */
const CONNECT_TIMEOUT_MS = 5000;
const QUERY_TIMEOUT_MS = 5000;

/** What `pg` rejects with when `connectionTimeoutMillis` runs out before the server answers. */
const CONNECT_TIMEOUT_MESSAGE = 'timeout expired';

/**
 * Turns a driver failure into a line a report can carry.
 *
 * `pg` rejects with a mix of Node errors (`code: 'ENOTFOUND'`), server errors (`code: '28P01'`,
 * a SQLSTATE) and bare strings. The code goes first because it is what a person searches for, and
 * the two failures that have a cause outside the database get a pointer to it.
 *
 * Nothing here can contain the password: `pg` never puts it in a message, and the credential is
 * not an argument to this function. An IAM token is a password too, and the same holds for it.
 *
 * The pointer to the subnet goes only on a connection that got no answer. An error the server sent
 * proves the network works, and a word in its text is no evidence: the RDS Proxy refusal of
 * `statement_timeout` contains "timeout", and was reported as a routing problem until this was
 * narrowed. After a long wait — the one a caller asks for when the database may be resuming from
 * a pause — the pointer says that too, because then it is the other likely cause.
 *
 * The code stays on the error as `code`, and not only in the text: a caller decides on some of
 * them (`providers/hubMessages.ts`, `providers/rdsLogin.ts`).
 *
 * Exported for the tests.
 */
export function describe(err: unknown, waitedMs: number = CONNECT_TIMEOUT_MS): Error {
	const e = (err ?? {}) as { code?: unknown; message?: unknown };
	const code = typeof e.code === 'string' ? e.code : '';
	const message = typeof e.message === 'string' && e.message ? e.message : String(err);
	const fromServer = err instanceof pg.DatabaseError;

	let hint = '';
	if (UNTRUSTED.has(code)) {
		hint = ` (${UNTRUSTED_HINT})`;
	} else if (!fromServer && (code === 'ETIMEDOUT' || message === CONNECT_TIMEOUT_MESSAGE)) {
		hint =
			waitedMs > CONNECT_TIMEOUT_MS
				? ` (no answer in ${Math.round(waitedMs / 1000)} s: the function has to be in a subnet that can reach the database, or the database took longer than that to resume from a pause)`
				: ' (the function has to be in a subnet that can reach the database)';
	}

	const described = new Error(`${code ? `${code}: ` : ''}${message}${hint}`);
	return code ? Object.assign(described, { code }) : described;
}

/**
 * What a client is built with, given what it trusts.
 *
 * Exported so a test can read the startup message `pg` derives from it. That message reaches the
 * server before the password does, and an RDS Proxy refuses a parameter it does not support
 * instead of ignoring it (see QUERY_TIMEOUT_MS).
 */
export const clientConfig = (
	target: Target,
	credentials: Credentials,
	ca: string[] | undefined,
	connectTimeoutMs: number = CONNECT_TIMEOUT_MS
): ClientConfig => ({
	host: target.host,
	port: target.port,
	database: target.database,
	user: credentials.user,
	password: credentials.password,
	ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
	connectionTimeoutMillis: connectTimeoutMs,
	query_timeout: QUERY_TIMEOUT_MS,
	application_name: 'struct8-hub',
});

const driver: Driver = {
	async connect(target: Target, credentials: Credentials, options?: ConnectOptions): Promise<Connection> {
		const waitMs = options?.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
		const client = new pg.Client(clientConfig(target, credentials, trustedAuthorities(lambdaBundle()), waitMs));

		// An error on an idle connection is an event, and an event nobody listens to is an
		// uncaught exception. The statement that was running reports its own failure.
		client.on('error', () => {});

		try {
			await client.connect();
		} catch (err) {
			await client.end().catch(() => {});
			throw describe(err, waitMs);
		}

		return {
			async run(text, params = []) {
				try {
					await client.query(text, [...params]);
				} catch (err) {
					throw describe(err);
				}
			},
			async close() {
				await client.end().catch(() => {});
			},
		};
	},
};

useDriver('postgres', driver);
