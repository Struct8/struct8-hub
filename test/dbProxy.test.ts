/**
 * The database, through an RDS Proxy.
 *
 * A proxy is a way into a database and not a database of its own, so the module writes the row
 * `aws_db_instance` writes, through the same port (`providers/sql.ts`), and database.test.ts already
 * locks what the two share: values in parameters, one row per message, the secret kept out of
 * errors. What is locked here is what the proxy's wire changes:
 *
 *   * ENGINE_FAMILY decides the driver, and every refusal comes BEFORE the credential is read.
 *   * The host is the proxy's, the port is the wire's PORT, and the database is the one the proxy
 *     fronts (DB_NAME): the proxy has no database name of its own.
 *   * ENGINE_FAMILY is read as a key of its own, and not as ENGINE with a label.
 *   * The connection trusts Node's authorities as well as the Lambda bundle: a proxy's certificate
 *     comes from AWS Certificate Manager and chains to an Amazon Root CA, which is in Node's list.
 *   * The startup message carries nothing a proxy refuses. The first apply measured one: `pg` sent
 *     `statement_timeout` there, and every connection was refused with 0A000.
 *
 * The rest of the handshake is proved by the apply, not here: on 2026-10-04 the proxy accepted the
 * TLS connection and refused the startup message, which is as far as the first run got.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import pg from 'pg';

import '../dist/resources/aws_db_instance/index.js';
import '../dist/resources/aws_db_proxy/index.js';
import * as registry from '../dist/core/registry.js';
import * as aws from '../dist/providers/aws.js';
import * as sql from '../dist/providers/sql.js';
import { clientConfig, describe as describeFailure, trustedAuthorities } from '../dist/providers/postgres.js';
import { discover } from '../dist/core/discovery.js';
import { open } from '../dist/core/envelope.js';
import type { Ctx, Envelope, Neighbor } from '../dist/core/types.js';

aws.credentials({
	accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
	secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
});

const SECRET = JSON.stringify({ username: 'dbadmin', password: 'correct-horse-battery' });

interface Seen {
	readonly connects: { target: sql.Target; credentials: sql.Credentials }[];
	readonly statements: { text: string; params: readonly unknown[] }[];
	closed: number;
}

/** A driver that records. `failing` makes the Nth statement (0-based) reject. */
function fakeDriver(failing: ReadonlySet<number> = new Set()): { driver: sql.Driver; seen: Seen } {
	const seen: Seen = { connects: [], statements: [], closed: 0 };
	let n = 0;
	const driver: sql.Driver = {
		async connect(target, credentials) {
			seen.connects.push({ target, credentials });
			return {
				async run(text, params = []) {
					const index = n++;
					seen.statements.push({ text, params });
					if (failing.has(index)) throw new Error(`statement ${index} failed`);
				},
				async close() {
					seen.closed++;
				},
			};
		},
	};
	return { driver, seen };
}

/** A Secrets Manager that answers with the secret, and remembers which calls were made. */
function fakeSecrets() {
	const targets: string[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		targets.push(request.headers.get('x-amz-target') ?? '');
		return new Response(JSON.stringify({ SecretString: SECRET }), { status: 200 });
	};
	return { targets, fetchImpl };
}

const ctxWith = (fetchImpl: typeof fetch): Ctx => ({
	self: 'Fn',
	fetch: fetchImpl,
	region: (n) => n?.props['REGION'] ?? 'us-west-2',
	account: () => '111122223333',
	now: () => new Date(0),
});

/** What the catalog exports for a Postgres proxy with Secrets Manager authentication. */
const EXPORTED: Readonly<Record<string, string>> = {
	NAME: 'app-proxy',
	ENDPOINT: 'app-proxy.proxy-abc123.us-west-2.rds.amazonaws.com',
	PORT: '5432',
	ENGINE_FAMILY: 'POSTGRESQL',
	SECRET_ARN: 'arn:aws:secretsmanager:us-west-2:111122223333:secret:app-db-AbCdEf',
	DB_NAME: 'appdb',
};

/** The proxy's wire, with `changes` applied; `undefined` removes the variable. */
const wire = (changes: Record<string, string | undefined> = {}): Neighbor => {
	const props: Record<string, string> = { ...EXPORTED };
	for (const [key, value] of Object.entries(changes)) {
		if (value === undefined) delete props[key];
		else props[key] = value;
	}
	return { type: 'aws_db_proxy', label: '0', props };
};

const envelope = (body = 'the message'): Envelope =>
	open(body, 'Worker', { trace: 'trace-1', at: '2026-10-04T12:00:00.000Z' });

const send = (n: Neighbor, e: Envelope, ctx: Ctx) => {
	const sender = registry.get('aws_db_proxy')?.send;
	assert.ok(sender, 'aws_db_proxy declares no sender');
	return sender(n, e, ctx);
};

test('the message is written through the proxy into the database it fronts', async () => {
	const { driver, seen } = fakeDriver();
	sql.useDriver('postgres', driver);
	const secrets = fakeSecrets();

	await send(wire(), envelope(), ctxWith(secrets.fetchImpl));

	assert.deepEqual(secrets.targets, ['secretsmanager.GetSecretValue']);
	assert.equal(seen.connects.length, 1);
	assert.deepEqual(seen.connects[0]!.target, {
		host: 'app-proxy.proxy-abc123.us-west-2.rds.amazonaws.com',
		port: 5432,
		database: 'appdb',
	});
	assert.deepEqual(seen.connects[0]!.credentials, { user: 'dbadmin', password: 'correct-horse-battery' });

	assert.equal(seen.statements.length, 2);
	assert.match(seen.statements[0]!.text, /create table if not exists hub_messages/);
	assert.match(seen.statements[1]!.text, /insert into hub_messages/);
	const [trace, path, receiver, , , , body] = seen.statements[1]!.params;
	assert.equal(trace, 'trace-1');
	assert.equal(path, 'Worker');
	assert.equal(receiver, 'Fn');
	assert.equal(body, 'the message');
	assert.equal(seen.closed, 1);
});

test("the connection uses the wire's port, and the family's port when the wire has none", async () => {
	const { driver, seen } = fakeDriver();
	sql.useDriver('postgres', driver);
	const ctx = ctxWith(fakeSecrets().fetchImpl);

	await send(wire({ PORT: '6543' }), envelope(), ctx);
	await send(wire({ PORT: undefined }), envelope(), ctx);

	assert.deepEqual(
		seen.connects.map((c) => c.target.port),
		[6543, 5432]
	);
});

const REFUSALS: readonly [string, Record<string, string | undefined>, RegExp][] = [
	['no endpoint', { ENDPOINT: undefined }, /no endpoint on the wire/],
	['no engine family', { ENGINE_FAMILY: undefined }, /no engine family on the wire: .*compile it again/],
	['a family with no driver', { ENGINE_FAMILY: 'MYSQL' }, /no driver for the "mysql" engine/],
	['a value that is not a family', { ENGINE_FAMILY: 'ORACLE' }, /"ORACLE" is not an RDS Proxy engine family/],
	['IAM authentication', { SECRET_ARN: '' }, /no secret on the wire: the proxy uses IAM authentication/],
	['no database behind the proxy', { DB_NAME: '' }, /no database name on the wire/],
	['a port that is not a port', { PORT: 'notaport' }, /invalid port/],
];

for (const [what, changes, reason] of REFUSALS) {
	test(`${what} is refused before the secret is read`, async () => {
		const { driver, seen } = fakeDriver();
		sql.useDriver('postgres', driver);
		const secrets = fakeSecrets();

		await assert.rejects(() => send(wire(changes), envelope(), ctxWith(secrets.fetchImpl)), reason);
		assert.deepEqual(secrets.targets, [], 'a credential was read for a connection that was never going to open');
		assert.equal(seen.connects.length, 0);
	});
}

test('the connection is closed when the write fails, and the password is in no error', async () => {
	// Statement 0 is the table, statement 1 its retry or the insert.
	for (const failing of [new Set([0, 1]), new Set([1])]) {
		const { driver, seen } = fakeDriver(failing);
		sql.useDriver('postgres', driver);

		await assert.rejects(
			() => send(wire(), envelope(), ctxWith(fakeSecrets().fetchImpl)),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.match(err.message, /statement 1 failed/);
				assert.ok(!err.message.includes('correct-horse-battery'));
				return true;
			}
		);
		assert.equal(seen.closed, 1);
	}
});

test('a proxy and an instance on one workload are read as two neighbors, each with its own keys', () => {
	const neighbors = discover(
		{
			AWS_DB_PROXY_NAME_0: 'app-proxy',
			AWS_DB_PROXY_ENDPOINT_0: 'app-proxy.proxy-abc123.us-west-2.rds.amazonaws.com',
			AWS_DB_PROXY_PORT_0: '5432',
			AWS_DB_PROXY_ENGINE_FAMILY_0: 'POSTGRESQL',
			AWS_DB_PROXY_SECRET_ARN_0: 'arn:aws:secretsmanager:us-west-2:1:secret:p',
			AWS_DB_PROXY_DB_NAME_0: 'appdb',
			AWS_DB_INSTANCE_ENDPOINT_0: 'h.rds.amazonaws.com:5432',
			AWS_DB_INSTANCE_DB_NAME_0: 'appdb',
			AWS_DB_INSTANCE_SECRET_ARN_0: 'arn:aws:secretsmanager:us-west-2:1:secret:s',
			AWS_DB_INSTANCE_ENGINE_0: 'postgres',
		},
		registry.vocabulary()
	);

	assert.deepEqual(
		neighbors.map((n) => [n.type, n.label, Object.keys(n.props).sort()]),
		[
			['aws_db_instance', '0', ['DB_NAME', 'ENDPOINT', 'ENGINE', 'SECRET_ARN']],
			['aws_db_proxy', '0', ['DB_NAME', 'ENDPOINT', 'ENGINE_FAMILY', 'NAME', 'PORT', 'SECRET_ARN']],
		]
	);
});

test('a connection trusts the Lambda bundle without dropping the authorities Node trusts', () => {
	assert.equal(trustedAuthorities(undefined), undefined, 'without a bundle, Node keeps its own defaults');

	const bundle = '-----BEGIN CERTIFICATE-----\nthe RDS authorities\n-----END CERTIFICATE-----\n';
	const trusted = trustedAuthorities(bundle);
	assert.ok(trusted?.includes(bundle), 'the bundle an instance certificate chains to is missing');

	const subjects = trusted.filter((pem) => pem !== bundle).map((pem) => new X509Certificate(pem).subject);
	assert.ok(
		subjects.some((subject) => subject.split('\n').includes('CN=Amazon Root CA 1')),
		'the authority a proxy certificate chains to is missing'
	);
});

test('the startup message carries only what an RDS Proxy accepts, and statements still have a limit', () => {
	const config = clientConfig(
		{ host: 'app-proxy.proxy-abc123.us-west-2.rds.amazonaws.com', port: 5432, database: 'appdb' },
		{ user: 'dbadmin', password: 'correct-horse-battery' },
		undefined
	);

	// `getStartupConf` is what `pg` itself sends after the TLS handshake. It is not in pg's types,
	// and reading it here is the point: the parameters are derived from the config, and a new one
	// would arrive in the message without anyone writing it there.
	const startup = (new pg.Client(config) as unknown as { getStartupConf(): Record<string, string> }).getStartupConf();
	assert.deepEqual(Object.keys(startup).sort(), ['application_name', 'database', 'user']);

	assert.equal(config.query_timeout, 5000, 'a statement must still give up, on the client side');
	assert.equal(config.connectionTimeoutMillis, 5000);
});

test('the subnet is blamed only when the server never answered', () => {
	// The refusal the first apply produced. The server sent it, so the network was fine, and the
	// word "timeout" in it once earned it the subnet pointer.
	const refusal = Object.assign(
		new pg.DatabaseError("Feature not supported: RDS Proxy currently doesn't support the option statement_timeout.", 0, 'error'),
		{ code: '0A000' }
	);
	assert.equal(
		describeFailure(refusal).message,
		"0A000: Feature not supported: RDS Proxy currently doesn't support the option statement_timeout."
	);

	for (const silence of [new Error('timeout expired'), Object.assign(new Error('connect ETIMEDOUT 10.8.0.181:5432'), { code: 'ETIMEDOUT' })]) {
		assert.match(describeFailure(silence).message, /the function has to be in a subnet that can reach the database/);
	}
});
