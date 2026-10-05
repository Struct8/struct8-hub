/**
 * An Aurora cluster, on the wire, reached three ways.
 *
 * The cluster writes the row an RDS instance writes (database.test.ts locks what they share), and
 * the compile tells each function how to reach it. What is locked here is each of the three ways and
 * the decisions inside them that read as arbitrary and are not:
 *
 *   * Over TCP with the master user's secret, waiting long enough for a paused Aurora Serverless v2
 *     cluster to resume.
 *   * Over TCP as an IAM user, with a token that is a SigV4 presigned URL — checked here against a
 *     signature computed independently, because a wrong token fails only against a real database.
 *     The user is created when the database has none, and only then: a user that exists keeps its
 *     own way of logging in.
 *   * Over HTTP through the RDS Data API, for a function outside the VPC, in PostgreSQL or MySQL,
 *     repeating the request while a paused cluster resumes.
 *
 * Every refusal comes before anything is read or sent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';

import '../dist/resources/aws_db_instance/index.js';
import '../dist/resources/aws_db_proxy/index.js';
import '../dist/resources/aws_rds_cluster/index.js';
import * as registry from '../dist/core/registry.js';
import * as aws from '../dist/providers/aws.js';
import * as sql from '../dist/providers/sql.js';
import * as dataApi from '../dist/providers/dataApi.js';
import { authToken } from '../dist/providers/rdsIam.js';
import { describe as describeFailure } from '../dist/providers/postgres.js';
import { discover } from '../dist/core/discovery.js';
import { open } from '../dist/core/envelope.js';
import type { Ctx, Envelope, Neighbor } from '../dist/core/types.js';

const ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
// The characters a real session token carries and a URL has to encode: `/`, `+` and `=`.
const SESSION_TOKEN = 'IQoJb3JpZ2luX2VjE+/session/token==';

aws.credentials({ accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, sessionToken: SESSION_TOKEN });

const SECRET = JSON.stringify({ username: 'dbadmin', password: 'correct-horse-battery' });

/** A failure as the Postgres driver reports one: the SQLSTATE in `code` and at the head of the text. */
const failure = (code: string, message: string): Error => Object.assign(new Error(`${code}: ${message}`), { code });

interface Connect {
	readonly target: sql.Target;
	readonly credentials: sql.Credentials;
	readonly options: sql.ConnectOptions | undefined;
}

interface Seen {
	readonly connects: Connect[];
	readonly statements: { user: string; text: string; params: readonly unknown[] }[];
	closed: number;
}

/**
 * A driver that records, and answers each connection and statement from a script.
 *
 * `login(user, n)` decides the n-th connection (0-based): undefined accepts, an Error refuses.
 * `statement(user, text, n)` does the same for the n-th statement.
 */
function scriptedDriver(
	login: (user: string, n: number) => Error | undefined = () => undefined,
	statement: (user: string, text: string, n: number) => Error | undefined = () => undefined
): { driver: sql.Driver; seen: Seen } {
	const seen: Seen = { connects: [], statements: [], closed: 0 };
	let logins = 0;
	let statements = 0;
	const driver: sql.Driver = {
		async connect(target, credentials, options) {
			seen.connects.push({ target, credentials, options });
			const refusal = login(credentials.user, logins++);
			if (refusal) throw refusal;
			return {
				async run(text, params = []) {
					seen.statements.push({ user: credentials.user, text, params });
					const failed = statement(credentials.user, text, statements++);
					if (failed) throw failed;
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
function fakeSecrets(secretString: string = SECRET) {
	const targets: string[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		targets.push(request.headers.get('x-amz-target') ?? request.url);
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

const CLUSTER_ARN = 'arn:aws:rds:us-west-2:111122223333:cluster:demo-aurora';
const SECRET_ARN = 'arn:aws:secretsmanager:us-west-2:111122223333:secret:rds!cluster-1-AbCdEf';
const WRITER = 'demo-aurora.cluster-abc123.us-west-2.rds.amazonaws.com';

/** What the catalog exports for an Aurora PostgreSQL cluster with a managed master password. */
const EXPORTED: Readonly<Record<string, string>> = {
	NAME: 'demo-aurora',
	ENGINE: 'aurora-postgresql',
	ENDPOINT: WRITER,
	PORT: '5432',
	DB_NAME: 'appdb',
	SECRET_ARN,
	ARN: CLUSTER_ARN,
};

/** The cluster's wire, with `changes` applied; `undefined` removes the variable. */
const wire = (changes: Record<string, string | undefined> = {}): Neighbor => {
	const props: Record<string, string> = { ...EXPORTED };
	for (const [key, value] of Object.entries(changes)) {
		if (value === undefined) delete props[key];
		else props[key] = value;
	}
	return { type: 'aws_rds_cluster', label: '0', props };
};

const envelope = (body = 'the message'): Envelope =>
	open(body, 'Worker', { trace: 'trace-1', at: '2026-10-04T12:00:00.000Z' });

const sendTo = (type: string) => (n: Neighbor, e: Envelope, ctx: Ctx) => {
	const sender = registry.get(type)?.send;
	assert.ok(sender, `${type} declares no sender`);
	return sender(n, e, ctx);
};
const send = sendTo('aws_rds_cluster');

// ---------------------------------------------------------------------------
// Over TCP, with the secret
// ---------------------------------------------------------------------------

test('the message is written to the writer endpoint with the master user, waiting for a resume', async () => {
	const { driver, seen } = scriptedDriver();
	sql.useDriver('postgres', driver);
	const secrets = fakeSecrets();

	await send(wire(), envelope(), ctxWith(secrets.fetchImpl));

	assert.deepEqual(secrets.targets, ['secretsmanager.GetSecretValue']);
	assert.equal(seen.connects.length, 1);
	assert.deepEqual(seen.connects[0]!.target, { host: WRITER, port: 5432, database: 'appdb' });
	assert.deepEqual(seen.connects[0]!.credentials, { user: 'dbadmin', password: 'correct-horse-battery' });
	assert.deepEqual(seen.connects[0]!.options, { connectTimeoutMs: 20_000 }, 'an Aurora cluster may be resuming from a pause');

	assert.equal(seen.statements.length, 2);
	assert.match(seen.statements[0]!.text, /create table if not exists hub_messages/);
	assert.match(seen.statements[1]!.text, /insert into hub_messages/);
	const [trace, path, receiver, , hops, sentAt, body] = seen.statements[1]!.params;
	assert.equal(trace, 'trace-1');
	assert.equal(path, 'Worker');
	assert.equal(receiver, 'Fn');
	assert.equal(hops, 3);
	assert.equal(sentAt, '2026-10-04T12:00:00.000Z');
	assert.equal(body, 'the message');
	assert.equal(seen.closed, 1);
});

test('a Multi-AZ DB cluster does not pause, and gets the ordinary wait', async () => {
	const { driver, seen } = scriptedDriver();
	sql.useDriver('postgres', driver);

	await send(wire({ ENGINE: 'postgres', PORT: '6543' }), envelope(), ctxWith(fakeSecrets().fetchImpl));

	assert.equal(seen.connects[0]!.options, undefined);
	assert.equal(seen.connects[0]!.target.port, 6543, "the wire's PORT is the port");
});

test('the endpoint\'s own port is used when the wire carries none', async () => {
	const { driver, seen } = scriptedDriver();
	sql.useDriver('postgres', driver);

	await send(wire({ PORT: undefined, ENDPOINT: `${WRITER}:5433` }), envelope(), ctxWith(fakeSecrets().fetchImpl));

	assert.equal(seen.connects[0]!.target.port, 5433);
});

// ---------------------------------------------------------------------------
// Over TCP, as an IAM user
// ---------------------------------------------------------------------------

/** RFC 3986 encoding, the one SigV4 canonicalizes the query with. */
const rfc3986 = (value: string): string =>
	encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Recomputes a presigned URL's signature from the SigV4 specification, with nothing from the code
 * under test: the canonical request, the string to sign and the derived key.
 */
function expectedSignature(url: URL, service: string, region: string): string {
	const params = [...url.searchParams].filter(([k]) => k !== 'X-Amz-Signature');
	const query = params
		.map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([k, v]) => `${k}=${v}`)
		.join('&');
	const emptyHash = createHash('sha256').update('').digest('hex');
	const canonical = ['GET', url.pathname, query, `host:${url.host}`, '', 'host', emptyHash].join('\n');

	const datetime = url.searchParams.get('X-Amz-Date')!;
	const scope = `${datetime.slice(0, 8)}/${region}/${service}/aws4_request`;
	const toSign = ['AWS4-HMAC-SHA256', datetime, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');

	let key: Buffer = createHmac('sha256', `AWS4${SECRET_KEY}`).update(datetime.slice(0, 8)).digest();
	for (const part of [region, service, 'aws4_request']) key = createHmac('sha256', key).update(part).digest();
	return createHmac('sha256', key).update(toSign).digest('hex');
}

test('an IAM token is a presigned URL for rds-db, for the endpoint the client connects to', async () => {
	const token = await authToken(WRITER, 5432, 'lambda_iam', 'us-west-2');

	assert.ok(!token.startsWith('https://'), 'the scheme is not part of a token');
	assert.ok(token.startsWith(`${WRITER}:5432/?`), 'the host and the port are the ones the client connects to');

	const url = new URL(`https://${token}`);
	assert.equal(url.searchParams.get('Action'), 'connect');
	assert.equal(url.searchParams.get('DBUser'), 'lambda_iam');
	assert.equal(url.searchParams.get('X-Amz-Expires'), '900', 'RDS accepts a token for fifteen minutes at most');
	assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
	assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'host');
	assert.equal(url.searchParams.get('X-Amz-Security-Token'), SESSION_TOKEN);
	assert.match(url.searchParams.get('X-Amz-Credential') ?? '', new RegExp(`^${ACCESS_KEY}/\\d{8}/us-west-2/rds-db/aws4_request$`));
	assert.equal(url.searchParams.get('X-Amz-Signature'), expectedSignature(url, 'rds-db', 'us-west-2'));
});

test('an IAM user logs in with a token, and the secret is never read', async () => {
	const { driver, seen } = scriptedDriver();
	sql.useDriver('postgres', driver);
	const secrets = fakeSecrets();

	await send(wire({ IAM_USER: 'lambda_iam' }), envelope(), ctxWith(secrets.fetchImpl));

	assert.deepEqual(secrets.targets, [], 'a function that logs in by IAM has no reason to read the password');
	assert.equal(seen.connects.length, 1);
	assert.equal(seen.connects[0]!.credentials.user, 'lambda_iam');
	assert.ok(seen.connects[0]!.credentials.password.startsWith(`${WRITER}:5432/?`));
	assert.equal(seen.statements.filter((s) => /insert/.test(s.text)).length, 1);
});

test('an IAM user the database does not have is created with the secret, and the login tried again', async () => {
	// The first login is the token, refused as a password; the second is the master user; the third
	// is the token again, now accepted.
	const { driver, seen } = scriptedDriver((user, n) =>
		user === 'lambda_iam' && n === 0 ? failure('28P01', 'password authentication failed for user "lambda_iam"') : undefined
	);
	sql.useDriver('postgres', driver);
	const secrets = fakeSecrets();

	await send(wire({ IAM_USER: 'lambda_iam' }), envelope(), ctxWith(secrets.fetchImpl));

	assert.deepEqual(
		seen.connects.map((c) => c.credentials.user),
		['lambda_iam', 'dbadmin', 'lambda_iam']
	);
	assert.deepEqual(secrets.targets, ['secretsmanager.GetSecretValue']);

	const asMaster = seen.statements.filter((s) => s.user === 'dbadmin');
	assert.equal(asMaster.length, 1);
	assert.match(asMaster[0]!.text, /create role "lambda_iam" login/);
	assert.match(asMaster[0]!.text, /grant rds_iam to "lambda_iam"/);
	assert.match(asMaster[0]!.text, /if exists \(select from pg_catalog\.pg_roles where rolname = 'lambda_iam'\)/);
	assert.match(asMaster[0]!.text, /exception when duplicate_object/, 'a concurrent run creating the same user is not a failure');

	assert.equal(seen.statements.filter((s) => s.user === 'lambda_iam' && /insert/.test(s.text)).length, 1);
	assert.equal(seen.closed, 2, 'both connections are closed');
});

test('a user that exists and logs in with a password is left as it is', async () => {
	const { driver, seen } = scriptedDriver(
		(user, n) => (user === 'lambda_iam' && n === 0 ? failure('28P01', 'password authentication failed for user "lambda_iam"') : undefined),
		(user, text) =>
			user === 'dbadmin' && /do \$\$/.test(text)
				? failure('P0001', 'the user lambda_iam exists and logs in with a password; granting it rds_iam would end that, so it is left as it is')
				: undefined
	);
	sql.useDriver('postgres', driver);

	await assert.rejects(
		() => send(wire({ IAM_USER: 'lambda_iam' }), envelope(), ctxWith(fakeSecrets().fetchImpl)),
		/exists and logs in with a password/
	);
	assert.equal(seen.closed, 1, 'the master connection is closed after the refusal');
	assert.ok(!seen.statements.some((s) => /grant rds_iam/.test(s.text) && s.user !== 'dbadmin'));
});

test('the master user is never made an IAM user', async () => {
	const { driver, seen } = scriptedDriver((user, n) =>
		n === 0 ? failure('28P01', 'password authentication failed for user "dbadmin"') : undefined
	);
	sql.useDriver('postgres', driver);

	await assert.rejects(
		() => send(wire({ IAM_USER: 'dbadmin' }), envelope(), ctxWith(fakeSecrets().fetchImpl)),
		/dbadmin is the master user/
	);
	assert.equal(seen.connects.length, 1, 'nothing was run as the master user');
});

test('a user name that cannot be written into a statement is not created', async () => {
	const { driver, seen } = scriptedDriver((_, n) => (n === 0 ? failure('28P01', 'password authentication failed') : undefined));
	sql.useDriver('postgres', driver);
	const secrets = fakeSecrets();

	await assert.rejects(
		() => send(wire({ IAM_USER: `x'; drop table hub_messages; --` }), envelope(), ctxWith(secrets.fetchImpl)),
		/cannot be set up from here/
	);
	assert.deepEqual(secrets.targets, [], 'the secret was read for a user that was never going to be created');
	assert.equal(seen.connects.length, 1);
});

test('an IAM user with no privilege gets the table and the permission from the master user', async () => {
	// PostgreSQL 15 on: no CREATE in `public` for a user that does not own the database, and no
	// table yet. Its create is refused (42501), its insert finds nothing (42P01).
	let tableExists = false;
	let granted = false;
	const { driver, seen } = scriptedDriver(undefined, (user, text) => {
		if (user === 'lambda_iam' && /create table/.test(text)) return failure('42501', 'permission denied for schema public');
		if (user === 'lambda_iam' && /insert/.test(text)) {
			if (!tableExists) return failure('42P01', 'relation "hub_messages" does not exist');
			if (!granted) return failure('42501', 'permission denied for table hub_messages');
		}
		if (user === 'dbadmin' && /create table/.test(text)) tableExists = true;
		if (user === 'dbadmin' && /grant insert on hub_messages to "lambda_iam"/.test(text)) granted = true;
		return undefined;
	});
	sql.useDriver('postgres', driver);

	await send(wire({ IAM_USER: 'lambda_iam' }), envelope(), ctxWith(fakeSecrets().fetchImpl));

	assert.ok(tableExists && granted);
	assert.deepEqual(
		seen.connects.map((c) => c.credentials.user),
		['lambda_iam', 'dbadmin', 'lambda_iam']
	);
	assert.equal(seen.closed, 3);
});

test('a token the database refuses says what the role needs', async () => {
	const { driver } = scriptedDriver(() => failure('28000', 'PAM authentication failed for user "lambda_iam"'));
	sql.useDriver('postgres', driver);

	await assert.rejects(
		() => send(wire({ IAM_USER: 'lambda_iam' }), envelope(), ctxWith(fakeSecrets().fetchImpl)),
		/PAM authentication failed .*rds-db:connect on dbuser:<resource id>\/lambda_iam/
	);
});

test('with no secret on the wire, a missing IAM user is reported with the SQL that creates it', async () => {
	const { driver, seen } = scriptedDriver(() => failure('28P01', 'password authentication failed for user "lambda_iam"'));
	sql.useDriver('postgres', driver);

	await assert.rejects(
		() => send(wire({ IAM_USER: 'lambda_iam', SECRET_ARN: undefined }), envelope(), ctxWith(fakeSecrets().fetchImpl)),
		/CREATE USER lambda_iam; GRANT rds_iam TO lambda_iam;/
	);
	assert.equal(seen.connects.length, 1);
});

test('an RDS instance and an RDS Proxy log in by IAM the same way, and a proxy never creates a user', async () => {
	const { driver, seen } = scriptedDriver();
	sql.useDriver('postgres', driver);
	const secrets = fakeSecrets();

	await sendTo('aws_db_instance')(
		{
			type: 'aws_db_instance',
			label: '0',
			props: { ENDPOINT: 'demo.abc.us-west-2.rds.amazonaws.com:5432', ENGINE: 'postgres', DB_NAME: 'appdb', IAM_USER: 'app_iam' },
		},
		envelope(),
		ctxWith(secrets.fetchImpl)
	);
	assert.equal(seen.connects[0]!.credentials.user, 'app_iam');
	assert.ok(seen.connects[0]!.credentials.password.startsWith('demo.abc.us-west-2.rds.amazonaws.com:5432/?'));
	assert.equal(seen.connects[0]!.options, undefined, 'an instance keeps the ordinary wait');

	const refusing = scriptedDriver(() => failure('28P01', 'password authentication failed for user "app_iam"'));
	sql.useDriver('postgres', refusing.driver);
	await assert.rejects(
		() =>
			sendTo('aws_db_proxy')(
				{
					type: 'aws_db_proxy',
					label: '0',
					props: {
						ENDPOINT: 'app-proxy.proxy-abc.us-west-2.rds.amazonaws.com',
						PORT: '5432',
						ENGINE_FAMILY: 'POSTGRESQL',
						SECRET_ARN: SECRET_ARN,
						DB_NAME: 'appdb',
						IAM_USER: 'app_iam',
					},
				},
				envelope(),
				ctxWith(secrets.fetchImpl)
			),
		/the proxy refused the token for app_iam/
	);
	assert.equal(refusing.seen.connects.length, 1, 'nothing was tried as the secret user through the proxy');
	assert.ok(refusing.seen.connects[0]!.credentials.password.startsWith('app-proxy.proxy-abc.us-west-2.rds.amazonaws.com:5432/?'));
	assert.deepEqual(secrets.targets, []);
});

test('through a proxy that requires IAM, the user of its secret logs in with a token, never the password', async () => {
	const { driver, seen } = scriptedDriver();
	sql.useDriver('postgres', driver);
	const secrets = fakeSecrets();

	await sendTo('aws_db_proxy')(
		{
			type: 'aws_db_proxy',
			label: '0',
			props: {
				ENDPOINT: 'app-proxy.proxy-abc.us-west-2.rds.amazonaws.com',
				PORT: '5432',
				ENGINE_FAMILY: 'POSTGRESQL',
				SECRET_ARN,
				DB_NAME: 'appdb',
				IAM_AUTH: 'REQUIRED',
			},
		},
		envelope(),
		ctxWith(secrets.fetchImpl)
	);

	assert.deepEqual(secrets.targets, ['secretsmanager.GetSecretValue'], 'the secret is read, for the user name it holds');
	assert.equal(seen.connects.length, 1);
	assert.equal(seen.connects[0]!.credentials.user, 'dbadmin');
	assert.ok(seen.connects[0]!.credentials.password.startsWith('app-proxy.proxy-abc.us-west-2.rds.amazonaws.com:5432/?'));
	assert.ok(!seen.connects[0]!.credentials.password.includes('correct-horse-battery'), 'the password was sent');
});

// ---------------------------------------------------------------------------
// Over HTTP, through the Data API
// ---------------------------------------------------------------------------

interface DataApiCall {
	readonly url: string;
	readonly authorization: string;
	readonly body: {
		resourceArn: string;
		secretArn: string;
		database: string;
		sql: string;
		parameters: { name: string; value: Record<string, unknown> }[];
	};
}

/** A Data API that answers from a script: undefined is a 200, a Response is that response. */
function fakeDataApi(answer: (call: DataApiCall, n: number) => Response | undefined = () => undefined) {
	const calls: DataApiCall[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		const call: DataApiCall = {
			url: request.url,
			authorization: request.headers.get('authorization') ?? '',
			body: JSON.parse(await request.text()),
		};
		calls.push(call);
		return answer(call, calls.length - 1) ?? new Response('{"numberOfRecordsUpdated":1}', { status: 200 });
	};
	return { calls, fetchImpl };
}

const dataApiError = (type: string, message: string, status = 400): Response =>
	new Response(JSON.stringify({ message }), {
		status,
		headers: { 'content-type': 'application/json', 'x-amzn-errortype': `${type}:http://internal.amazon.com/coral/com.amazon.rdsdataservice/` },
	});

test('outside the VPC, the message goes to the Data API, signed for rds-data, with named parameters', async () => {
	const { driver, seen } = scriptedDriver();
	sql.useDriver('postgres', driver);
	const api = fakeDataApi();

	await send(wire({ DATA_API: 'true' }), envelope(), ctxWith(api.fetchImpl));

	assert.equal(seen.connects.length, 0, 'nothing is opened over TCP');
	assert.equal(api.calls.length, 2);
	for (const call of api.calls) {
		assert.equal(call.url, 'https://rds-data.us-west-2.amazonaws.com/Execute');
		assert.match(call.authorization, /\/us-west-2\/rds-data\/aws4_request/);
		assert.equal(call.body.resourceArn, CLUSTER_ARN);
		assert.equal(call.body.secretArn, SECRET_ARN);
		assert.equal(call.body.database, 'appdb');
	}

	assert.match(api.calls[0]!.body.sql, /create table if not exists hub_messages/);
	const insert = api.calls[1]!.body;
	assert.match(insert.sql, /insert into hub_messages/);
	assert.match(insert.sql, /values \(:p1, :p2, :p3, :p4, :p5, cast\(:p6 as timestamptz\), :p7\)/);
	assert.ok(!insert.sql.includes('$'), 'a $ placeholder reached the Data API');
	assert.deepEqual(
		insert.parameters.map((p) => p.name),
		['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']
	);
	assert.deepEqual(insert.parameters[0]!.value, { stringValue: 'trace-1' });
	assert.deepEqual(insert.parameters[4]!.value, { longValue: 3 });
	assert.deepEqual(insert.parameters[5]!.value, { stringValue: '2026-10-04T12:00:00.000Z' });
	assert.deepEqual(insert.parameters[6]!.value, { stringValue: 'the message' });
});

test('an Aurora MySQL cluster gets the MySQL table and no driver is needed', async () => {
	sql.resetDrivers();
	const api = fakeDataApi();

	await send(wire({ DATA_API: 'true', ENGINE: 'aurora-mysql', PORT: '3306' }), envelope(), ctxWith(api.fetchImpl));

	assert.match(api.calls[0]!.body.sql, /id\s+char\(64\)\s+not null/);
	assert.match(api.calls[0]!.body.sql, /primary key \(id\)/);
	const insert = api.calls[1]!.body;
	assert.match(insert.sql, /^insert ignore into hub_messages/);
	assert.equal(insert.parameters.length, 8);
	assert.match(String(insert.parameters[0]!.value['stringValue']), /^[0-9a-f]{64}$/, 'the key is the hash of what identifies the message');
	assert.deepEqual(insert.parameters[6]!.value, { stringValue: '2026-10-04 12:00:00.000' }, 'MySQL refuses the T and the Z');
});

test('inside the VPC, an engine with no driver takes the Data API when the cluster has it on', async () => {
	const { driver, seen } = scriptedDriver();
	sql.useDriver('postgres', driver);
	const api = fakeDataApi();

	await send(wire({ ENGINE: 'aurora-mysql', PORT: '3306', IAM_USER: 'app_iam' }), envelope(), ctxWith(api.fetchImpl));

	assert.equal(seen.connects.length, 0, 'there is no MySQL driver to open a connection with');
	assert.equal(api.calls.length, 2);
	assert.equal(api.calls[1]!.body.secretArn, SECRET_ARN, 'the Data API logs in with the secret, whatever IAM_USER says');
	assert.match(api.calls[1]!.body.sql, /^insert ignore into hub_messages/);
});

test('a statement is repeated while a paused cluster resumes, and only then', async () => {
	const waits: number[] = [];
	let n = 0;
	const fetchImpl: typeof fetch = async () =>
		n++ < 2
			? dataApiError('DatabaseResumingException', 'The Aurora DB instance db-1 is resuming after being auto-paused. Please wait a few seconds and try again.')
			: new Response('{}', { status: 200 });

	const connection = dataApi.connection(
		{ resourceArn: CLUSTER_ARN, secretArn: SECRET_ARN, database: 'appdb', region: 'us-west-2' },
		fetchImpl,
		{ sleep: async (ms) => void waits.push(ms) }
	);
	await connection.run('select 1');

	assert.equal(n, 3);
	assert.deepEqual(waits, [2000, 3000]);

	const always: typeof fetch = async () => dataApiError('DatabaseResumingException', 'still resuming');
	const patient = dataApi.connection(
		{ resourceArn: CLUSTER_ARN, secretArn: SECRET_ARN, database: 'appdb', region: 'us-west-2' },
		always,
		{ sleep: async () => {} }
	);
	await assert.rejects(() => patient.run('select 1'), /DatabaseResumingException: still resuming/);
});

test("the database's SQLSTATE travels on a Data API failure, so a user that may not create a table still writes", async () => {
	const api = fakeDataApi((call) =>
		/create table/.test(call.body.sql)
			? dataApiError('BadRequestException', 'ERROR: permission denied for schema public; SQLState: 42501')
			: undefined
	);

	await send(wire({ DATA_API: 'true' }), envelope(), ctxWith(api.fetchImpl));

	assert.equal(api.calls.filter((c) => /insert/.test(c.body.sql)).length, 1);
});

test('a Data API that never answers points at the route out of the VPC', async () => {
	const unreachable: typeof fetch = async () => {
		throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
	};

	await assert.rejects(
		() => send(wire({ DATA_API: 'true' }), envelope(), ctxWith(unreachable)),
		/the Data API did not answer \(UND_ERR_CONNECT_TIMEOUT\): .*NAT gateway or an rds-data interface endpoint/
	);
});

test('a role without the Data API permission is told which one', async () => {
	const denied: typeof fetch = async () => dataApiError('AccessDeniedException', 'User is not authorized to perform: rds-data:ExecuteStatement', 403);

	await assert.rejects(
		() => send(wire({ DATA_API: 'true' }), envelope(), ctxWith(denied)),
		/^Error: AccessDeniedException: .*\(the function's role needs rds-data:ExecuteStatement/
	);
});

// ---------------------------------------------------------------------------
// Refusals, and the grammar
// ---------------------------------------------------------------------------

const REFUSALS: readonly [string, Record<string, string | undefined>, RegExp][] = [
	['no engine', { ENGINE: undefined }, /no engine on the wire: .*compile it again/],
	['no endpoint', { ENDPOINT: undefined }, /no endpoint on the wire/],
	['no secret and no IAM user', { SECRET_ARN: '' }, /no secret on the wire: the cluster has no managed master password/],
	['no database name', { DB_NAME: '' }, /no database name on the wire/],
	['an engine with no driver and no Data API', { ENGINE: 'aurora-mysql', ARN: undefined }, /no driver for the "aurora-mysql" engine/],
	['a port that is not a port', { PORT: 'notaport' }, /invalid port/],
	['the Data API with no ARN', { DATA_API: 'true', ARN: undefined }, /no cluster ARN on the wire/],
	['the Data API with no secret', { DATA_API: 'true', SECRET_ARN: '' }, /the Data API logs in with a secret/],
	['the Data API with no database', { DATA_API: 'true', DB_NAME: '' }, /the Data API writes into a named database/],
	['the Data API on an engine it does not write', { DATA_API: 'true', ENGINE: 'oracle-ee' }, /PostgreSQL or MySQL/],
];

for (const [what, changes, reason] of REFUSALS) {
	test(`${what} is refused before anything is read or sent`, async () => {
		const { driver, seen } = scriptedDriver();
		sql.useDriver('postgres', driver);
		const secrets = fakeSecrets();

		await assert.rejects(() => send(wire(changes), envelope(), ctxWith(secrets.fetchImpl)), reason);
		assert.deepEqual(secrets.targets, [], 'something was read or sent for a write that was never going to happen');
		assert.equal(seen.connects.length, 0);
	});
}

test("a cluster's variables are read as one neighbor with its own keys", () => {
	const neighbors = discover(
		{
			AWS_RDS_CLUSTER_NAME_0: 'demo-aurora',
			AWS_RDS_CLUSTER_ENGINE_0: 'aurora-postgresql',
			AWS_RDS_CLUSTER_ENDPOINT_0: WRITER,
			AWS_RDS_CLUSTER_PORT_0: '5432',
			AWS_RDS_CLUSTER_DB_NAME_0: 'appdb',
			AWS_RDS_CLUSTER_SECRET_ARN_0: SECRET_ARN,
			AWS_RDS_CLUSTER_ARN_0: CLUSTER_ARN,
			AWS_RDS_CLUSTER_IAM_USER_0: 'lambda_iam',
			AWS_RDS_CLUSTER_DATA_API_0: 'true',
		},
		registry.vocabulary()
	);

	assert.equal(neighbors.length, 1);
	assert.equal(neighbors[0]!.type, 'aws_rds_cluster');
	assert.deepEqual(Object.keys(neighbors[0]!.props).sort(), [
		'ARN',
		'DATA_API',
		'DB_NAME',
		'ENDPOINT',
		'ENGINE',
		'IAM_USER',
		'NAME',
		'PORT',
		'SECRET_ARN',
	]);
});

test('after the long wait, the pointer names the pause as well as the subnet', () => {
	const silence = new Error('timeout expired');
	assert.match(describeFailure(silence, 20_000).message, /no answer in 20 s: the function has to be in a subnet that can reach the database, or the database took longer than that to resume/);
	assert.doesNotMatch(describeFailure(silence).message, /resume/, 'the ordinary wait keeps the ordinary pointer');
	assert.equal((describeFailure(Object.assign(new Error('x'), { code: '42501' })) as Error & { code?: string }).code, '42501');
});
