/**
 * The database, on the wire.
 *
 * Every other destination is a request to an HTTPS API, and a database is a TCP connection. The
 * transport is a port (`providers/sql.ts`), so these tests run the module against a driver that
 * records what it was asked, and a Secrets Manager that answers from memory. What is locked here
 * is each decision that reads as arbitrary and is not:
 *
 *   * The ENGINE decides the driver, and an engine nobody can talk to is refused BY NAME and
 *     BEFORE the credential is read.
 *   * Values travel as parameters. The thing being stored is somebody else's message.
 *   * Nothing of the secret's content reaches an error, including the text `JSON.parse` quotes.
 *   * The connection is closed on every path, and a redelivery does not become a second row.
 *
 * None of this proves the handshake with a real server. That needs a database, and the ones this
 * talks to are private; it is the first thing to look at after the first apply.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../dist/resources/aws_db_instance/index.js';
import * as registry from '../dist/core/registry.js';
import * as aws from '../dist/providers/aws.js';
import * as sql from '../dist/providers/sql.js';
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

/**
 * A driver that records. `failing` makes the Nth statement (0-based) reject, so a test can break
 * the table creation or the insert without reaching for a network.
 */
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

/** A Secrets Manager that answers with `secretString`, and remembers which calls were made. */
function fakeSecrets(secretString: string | null = SECRET) {
	const targets: string[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		targets.push(request.headers.get('x-amz-target') ?? '');
		return new Response(JSON.stringify({ SecretString: secretString }), { status: 200 });
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

const wire = (props: Record<string, string> = {}): Neighbor => ({
	type: 'aws_db_instance',
	label: '0',
	props: {
		ENDPOINT: 'demo.abc123.us-west-2.rds.amazonaws.com:5432',
		DB_NAME: 'appdb',
		SECRET_ARN: 'arn:aws:secretsmanager:us-west-2:111122223333:secret:rds!db-1-AbCdEf',
		ENGINE: 'postgres',
		...props,
	},
});

const envelope = (body = 'the message', opts: { trace?: string } = {}): Envelope =>
	open(body, 'Worker', { trace: opts.trace ?? 'trace-1', at: '2026-10-04T12:00:00.000Z' });

const send = (n: Neighbor, e: Envelope, ctx: Ctx) => {
	const sender = registry.get('aws_db_instance')?.send;
	assert.ok(sender, 'aws_db_instance declares no sender');
	return sender(n, e, ctx);
};

test('the message is written through the driver the engine names', async () => {
	const { driver, seen } = fakeDriver();
	sql.useDriver('postgres', driver);
	const secrets = fakeSecrets();

	await send(wire(), envelope(), ctxWith(secrets.fetchImpl));

	assert.deepEqual(secrets.targets, ['secretsmanager.GetSecretValue']);
	assert.equal(seen.connects.length, 1);
	assert.deepEqual(seen.connects[0]!.target, {
		host: 'demo.abc123.us-west-2.rds.amazonaws.com',
		port: 5432,
		database: 'appdb',
	});
	assert.deepEqual(seen.connects[0]!.credentials, { user: 'dbadmin', password: 'correct-horse-battery' });

	assert.equal(seen.statements.length, 2);
	assert.match(seen.statements[0]!.text, /create table if not exists hub_messages/);
	assert.match(seen.statements[1]!.text, /insert into hub_messages/);
	assert.match(seen.statements[1]!.text, /on conflict do nothing/);

	const [trace, path, receiver, digest, hops, sentAt, body] = seen.statements[1]!.params;
	assert.equal(trace, 'trace-1');
	assert.equal(path, 'Worker');
	assert.equal(receiver, 'Fn');
	assert.match(String(digest), /^[0-9a-f]{64}$/);
	assert.equal(hops, 3);
	assert.equal(sentAt, '2026-10-04T12:00:00.000Z');
	assert.equal(body, 'the message');
	assert.equal(seen.closed, 1);
});

test('the values go in parameters, never in the statement text', async () => {
	const { driver, seen } = fakeDriver();
	sql.useDriver('postgres', driver);
	const hostile = "'); drop table hub_messages; --";

	await send(wire(), envelope(hostile), ctxWith(fakeSecrets().fetchImpl));

	for (const s of seen.statements) assert.ok(!s.text.includes('drop table'), `spliced into: ${s.text}`);
	assert.ok(seen.statements[1]!.params.includes(hostile));
});

test('a redelivery is one row and a different message is another', async () => {
	const { driver, seen } = fakeDriver();
	sql.useDriver('postgres', driver);
	const ctx = ctxWith(fakeSecrets().fetchImpl);

	await send(wire(), envelope('same'), ctx);
	await send(wire(), envelope('same'), ctx);
	await send(wire(), envelope('other'), ctx);

	const digests = seen.statements.filter((s) => /insert/.test(s.text)).map((s) => s.params[3]);
	assert.equal(digests[0], digests[1], 'the same message must carry the same key');
	assert.notEqual(digests[0], digests[2], 'two messages of one batch must not collapse into one row');
});

test('the connection is closed when the write fails, and the reason surfaces', async () => {
	// Statement 0 is the table, statement 1 is the insert.
	const { driver, seen } = fakeDriver(new Set([1]));
	sql.useDriver('postgres', driver);

	await assert.rejects(() => send(wire(), envelope(), ctxWith(fakeSecrets().fetchImpl)), /statement 1 failed/);
	assert.equal(seen.closed, 1);
});

test('a lost race on the table creation is retried once', async () => {
	const { driver, seen } = fakeDriver(new Set([0]));
	sql.useDriver('postgres', driver);

	await send(wire(), envelope(), ctxWith(fakeSecrets().fetchImpl));

	const creates = seen.statements.filter((s) => /create table/.test(s.text));
	assert.equal(creates.length, 2, 'the creation should have been attempted again');
	assert.equal(seen.statements.filter((s) => /insert/.test(s.text)).length, 1);
});

test('a table that cannot be created twice is a real failure', async () => {
	const { driver, seen } = fakeDriver(new Set([0, 1]));
	sql.useDriver('postgres', driver);

	await assert.rejects(() => send(wire(), envelope(), ctxWith(fakeSecrets().fetchImpl)), /statement 1 failed/);
	assert.equal(seen.statements.filter((s) => /insert/.test(s.text)).length, 0, 'must not insert after failing');
	assert.equal(seen.closed, 1);
});

test('a wire with no engine is refused before anything is read', async () => {
	const { driver, seen } = fakeDriver();
	sql.useDriver('postgres', driver);
	const secrets = fakeSecrets();
	const noEngine = wire();
	const props = { ...noEngine.props };
	delete props['ENGINE'];

	await assert.rejects(
		() => send({ ...noEngine, props }, envelope(), ctxWith(secrets.fetchImpl)),
		/no engine on the wire/
	);
	assert.deepEqual(secrets.targets, []);
	assert.equal(seen.connects.length, 0);
});

test('an engine with no driver is refused by name, before the secret is read', async () => {
	const { driver, seen } = fakeDriver();
	sql.useDriver('postgres', driver);
	const secrets = fakeSecrets();

	await assert.rejects(
		() => send(wire({ ENGINE: 'mysql' }), envelope(), ctxWith(secrets.fetchImpl)),
		/no driver for the "mysql" engine/
	);
	assert.deepEqual(secrets.targets, [], 'a credential was read for a database nobody can open');
	assert.equal(seen.connects.length, 0);
});

test('an Aurora Postgres engine speaks the Postgres protocol', async () => {
	const { driver, seen } = fakeDriver();
	sql.useDriver('postgres', driver);

	await send(wire({ ENGINE: 'aurora-postgresql' }), envelope(), ctxWith(fakeSecrets().fetchImpl));

	assert.equal(seen.connects.length, 1);
});

test('a secret that is not a username and a password is refused without quoting it', async () => {
	const { driver } = fakeDriver();
	sql.useDriver('postgres', driver);

	for (const content of ['SUPERSECRET-not-json', '{"username":"u","token":"SUPERSECRET"}', null]) {
		await assert.rejects(
			() => send(wire(), envelope(), ctxWith(fakeSecrets(content).fetchImpl)),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.match(err.message, /does not carry a username and a password/);
				assert.ok(!/SUPERSECRET/.test(err.message), `the secret leaked into: ${err.message}`);
				return true;
			}
		);
	}
});

test('the password is in no error the module raises', async () => {
	// Every failure the module can produce after the credential is read.
	for (const failing of [new Set([0, 1]), new Set([1])]) {
		const { driver } = fakeDriver(failing);
		sql.useDriver('postgres', driver);
		await assert.rejects(
			() => send(wire(), envelope(), ctxWith(fakeSecrets().fetchImpl)),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.ok(!err.message.includes('correct-horse-battery'));
				return true;
			}
		);
	}
});

test('a wire for another region reads the secret from there', async () => {
	const { driver } = fakeDriver();
	sql.useDriver('postgres', driver);
	const urls: string[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		urls.push(request.url);
		return new Response(JSON.stringify({ SecretString: SECRET }), { status: 200 });
	};

	await send(wire({ REGION: 'eu-west-1' }), envelope(), ctxWith(fetchImpl));

	assert.match(urls[0] ?? '', /secretsmanager\.eu-west-1\.amazonaws\.com/);
});

test('the engine is part of the grammar the workload is read with', () => {
	const neighbors = discover(
		{
			AWS_DB_INSTANCE_ENDPOINT_0: 'h.rds.amazonaws.com:5432',
			AWS_DB_INSTANCE_DB_NAME_0: 'appdb',
			AWS_DB_INSTANCE_SECRET_ARN_0: 'arn:aws:secretsmanager:us-west-2:1:secret:s',
			AWS_DB_INSTANCE_ENGINE_0: 'postgres',
		},
		registry.vocabulary()
	);

	assert.equal(neighbors.length, 1, 'four variables of one wire must merge into one neighbor');
	assert.equal(neighbors[0]!.type, 'aws_db_instance');
	assert.deepEqual(Object.keys(neighbors[0]!.props).sort(), ['DB_NAME', 'ENDPOINT', 'ENGINE', 'SECRET_ARN']);
});

test('endpoints are read as the generator writes them, and as people write them', () => {
	const p = (raw: string) => sql.parseEndpoint(raw, 'postgres');

	assert.deepEqual(p('db.x.us-west-2.rds.amazonaws.com:5432'), { host: 'db.x.us-west-2.rds.amazonaws.com', port: 5432 });
	assert.deepEqual(p('db.x.rds.amazonaws.com:6543'), { host: 'db.x.rds.amazonaws.com', port: 6543 });
	assert.deepEqual(p('db.x.rds.amazonaws.com'), { host: 'db.x.rds.amazonaws.com', port: 5432 });
	assert.deepEqual(p('https://example.invalid/endpoint'), { host: 'example.invalid', port: 5432 });
	assert.deepEqual(p('  db.x:5432  '), { host: 'db.x', port: 5432 });

	assert.throws(() => p(''), /no host/);
	assert.throws(() => p(':5432'), /no host/);
	assert.throws(() => p('db.x:notaport'), /invalid port/);
	assert.throws(() => p('db.x:0'), /invalid port/);
	assert.throws(() => p('db.x:70000'), /invalid port/);
	assert.throws(() => sql.parseEndpoint('db.x', 'mysql'), /no port and the engine has no default/);
});
