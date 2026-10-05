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

import { readFileSync } from 'node:fs';
import { rootCertificates } from 'node:tls';
import pg from 'pg';
import type { ClientConfig } from 'pg';

import { useDriver, type Connection, type Credentials, type Driver, type Target } from './sql.js';

/**
 * The Amazon certificate authorities, as Lambda ships them.
 *
 * FROM NODE.JS 20 ON, LAMBDA NO LONGER TRUSTS THE RDS CERTIFICATE AUTHORITY BY DEFAULT. The file
 * is in the runtime, and the documented way to use it is to set `NODE_EXTRA_CA_CERTS` to it — an
 * environment variable Node reads when the process starts, which a function cannot set for itself.
 * Reading the file here does the same job (see `trustedAuthorities`), and needs no setting in the
 * diagram.
 *
 * Where the file is absent — a container, a laptop — the platform's own trust store applies, and a
 * database whose certificate it does not know fails with a message that says so (see `describe`).
 * The connection is never downgraded to an unverified one: `rds.force_ssl` makes the database
 * insist on TLS, and the point of verifying is knowing WHICH server is on the other end before the
 * password is sent to it.
 */
const LAMBDA_CA_BUNDLE = '/var/runtime/ca-cert.pem';

/**
 * What a connection trusts, given the Lambda bundle when there is one: Node's own list AND the
 * bundle, which is what `NODE_EXTRA_CA_CERTS` does — the variable ADDS the file to the list.
 *
 * Handing the file alone to the connection REPLACES the list instead, and that is how this worked
 * until an RDS Proxy was wired. An instance's certificate is issued by the RDS authority, which is
 * in the file. A proxy's comes from AWS Certificate Manager and chains to an Amazon Root CA, which
 * is in Node's list. Both, then, as the variable would have it.
 *
 * `undefined` without a bundle, which leaves Node's defaults in place.
 */
export const trustedAuthorities = (bundle: string | undefined): string[] | undefined =>
	bundle ? [...rootCertificates, bundle] : undefined;

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

const authorities = (): string | undefined => {
	try {
		return readFileSync(LAMBDA_CA_BUNDLE, 'utf8');
	} catch {
		return undefined;
	}
};

/** TLS failures worth naming, from Node's own error codes. */
const UNTRUSTED = new Set([
	'SELF_SIGNED_CERT_IN_CHAIN',
	'DEPTH_ZERO_SELF_SIGNED_CERT',
	'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
	'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
	'CERT_HAS_EXPIRED',
]);

/**
 * Turns a driver failure into a line a report can carry.
 *
 * `pg` rejects with a mix of Node errors (`code: 'ENOTFOUND'`), server errors (`code: '28P01'`,
 * a SQLSTATE) and bare strings. The code goes first because it is what a person searches for, and
 * the two failures that have a cause outside the database get a pointer to it.
 *
 * Nothing here can contain the password: `pg` never puts it in a message, and the credential is
 * not an argument to this function.
 *
 * The pointer to the subnet goes only on a connection that got no answer. An error the server sent
 * proves the network works, and a word in its text is no evidence: the RDS Proxy refusal of
 * `statement_timeout` contains "timeout", and was reported as a routing problem until this was
 * narrowed.
 *
 * Exported for the tests.
 */
export function describe(err: unknown): Error {
	const e = (err ?? {}) as { code?: unknown; message?: unknown };
	const code = typeof e.code === 'string' ? e.code : '';
	const message = typeof e.message === 'string' && e.message ? e.message : String(err);
	const fromServer = err instanceof pg.DatabaseError;

	let hint = '';
	if (UNTRUSTED.has(code)) {
		hint = ' (the runtime does not trust the database certificate authority; on Lambda the Amazon bundle is /var/runtime/ca-cert.pem)';
	} else if (!fromServer && (code === 'ETIMEDOUT' || message === CONNECT_TIMEOUT_MESSAGE)) {
		hint = ' (the function has to be in a subnet that can reach the database)';
	}

	return new Error(`${code ? `${code}: ` : ''}${message}${hint}`);
}

/**
 * What a client is built with, given what it trusts.
 *
 * Exported so a test can read the startup message `pg` derives from it. That message reaches the
 * server before the password does, and an RDS Proxy refuses a parameter it does not support
 * instead of ignoring it (see QUERY_TIMEOUT_MS).
 */
export const clientConfig = (target: Target, credentials: Credentials, ca: string[] | undefined): ClientConfig => ({
	host: target.host,
	port: target.port,
	database: target.database,
	user: credentials.user,
	password: credentials.password,
	ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
	connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
	query_timeout: QUERY_TIMEOUT_MS,
	application_name: 'struct8-hub',
});

const driver: Driver = {
	async connect(target: Target, credentials: Credentials): Promise<Connection> {
		const client = new pg.Client(clientConfig(target, credentials, trustedAuthorities(authorities())));

		// An error on an idle connection is an event, and an event nobody listens to is an
		// uncaught exception. The statement that was running reports its own failure.
		client.on('error', () => {});

		try {
			await client.connect();
		} catch (err) {
			await client.end().catch(() => {});
			throw describe(err);
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
