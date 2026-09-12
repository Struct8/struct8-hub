/**
 * The container runtime.
 *
 * Two things here are worth locking down because both fail quietly in production and pass in a
 * naive test: the credential endpoint names the session token `Token` rather than `SessionToken`,
 * and the health check must not forward — a target group calls it every thirty seconds, so a
 * health check that fanned out would fire the diagram twice a minute for as long as the task runs.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';

import {
	container,
	taskCredentials,
	resetCredentialCache,
	selectSource,
	consumeOnce,
} from '../dist/runtimes/container.js';
import * as registry from '../dist/core/registry.js';
import { open, seal } from '../dist/core/envelope.js';
import type { Ctx, Envelope, Item, Neighbor } from '../dist/core/types.js';

const running: Server[] = [];
const touched: string[] = [];

beforeEach(() => {
	registry.reset();
	resetCredentialCache();
});

afterEach(async () => {
	for (const key of touched.splice(0)) delete process.env[key];
	await Promise.all(
		running.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
	);
});

/** Registers a sender that records what it was handed. */
function spy(type: string) {
	const seen: { neighbor: Neighbor; envelope: Envelope }[] = [];
	registry.register({
		type,
		async send(n: Neighbor, e: Envelope) {
			seen.push({ neighbor: n, envelope: e });
		},
	});
	return seen;
}

/** Starts a server on an ephemeral port and returns its base URL. */
async function start(options: Record<string, unknown> = {}): Promise<string> {
	const server = container({ port: 0, ...options });
	running.push(server);
	if (!server.listening) await once(server, 'listening');

	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('server has no port');
	return `http://127.0.0.1:${address.port}`;
}

/** Sets environment variables for one test; the shared afterEach removes them again. */
function withEnv(vars: Record<string, string>): void {
	for (const [key, value] of Object.entries(vars)) {
		process.env[key] = value;
		touched.push(key);
	}
}

const jsonResponse = (body: unknown, status = 200, statusText = 'OK'): Response =>
	new Response(JSON.stringify(body), {
		status,
		statusText,
		headers: { 'content-type': 'application/json' },
	});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

test('no container credential variables means no credentials to install', async () => {
	// Not an error: this is the same binary running locally or on Lambda, where the signer's
	// ambient fallback is correct.
	const creds = await taskCredentials({
		env: {},
		fetch: (() => {
			throw new Error('must not reach the network');
		}) as unknown as typeof fetch,
	});

	assert.equal(creds, null);
});

test('the relative URI is resolved against the link-local address', async () => {
	let requested: string | undefined;

	const creds = await taskCredentials({
		env: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/f4d1' },
		fetch: (async (url: string | URL) => {
			requested = String(url);
			return jsonResponse({
				AccessKeyId: 'AKIAEXAMPLE',
				SecretAccessKey: 'shh',
				Token: 'session-token',
				Expiration: '2026-09-05T12:00:00Z',
			});
		}) as unknown as typeof fetch,
	});

	assert.equal(requested, 'http://169.254.170.2/v2/credentials/f4d1');
	assert.equal(creds?.accessKeyId, 'AKIAEXAMPLE');
	assert.equal(creds?.secretAccessKey, 'shh');
	// The trap: the endpoint says `Token`, the STS API says `SessionToken`. Reading the STS name
	// produces a request AWS rejects as an invalid security token, which says nothing about a typo.
	assert.equal(creds?.sessionToken, 'session-token');
	assert.equal(creds?.expiresAt, Date.parse('2026-09-05T12:00:00Z'));
});

test('the full URI is used as given and carries the authorization token', async () => {
	let requested: string | undefined;
	let authorization: string | undefined;

	await taskCredentials({
		env: {
			AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.23/v1/credentials',
			AWS_CONTAINER_AUTHORIZATION_TOKEN: 'bearer-ish',
		},
		fetch: (async (url: string | URL, init?: RequestInit) => {
			requested = String(url);
			authorization = (init?.headers as Record<string, string> | undefined)?.['authorization'];
			return jsonResponse({ AccessKeyId: 'A', SecretAccessKey: 'B' });
		}) as unknown as typeof fetch,
	});

	assert.equal(requested, 'http://169.254.170.23/v1/credentials');
	assert.equal(authorization, 'bearer-ish');
});

test('credentials with no expiry are accepted and left for the caller to age', async () => {
	const creds = await taskCredentials({
		env: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/x' },
		fetch: (async () => jsonResponse({ AccessKeyId: 'A', SecretAccessKey: 'B' })) as unknown as typeof fetch,
	});

	assert.equal(creds?.expiresAt, undefined);
});

test('a refused credential request names the status', async () => {
	await assert.rejects(
		() =>
			taskCredentials({
				env: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/x' },
				fetch: (async () => new Response('no', { status: 403, statusText: 'Forbidden' })) as unknown as typeof fetch,
			}),
		/403/
	);
});

test('a credential answer without a key pair is refused rather than half-installed', async () => {
	await assert.rejects(
		() =>
			taskCredentials({
				env: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/x' },
				fetch: (async () => jsonResponse({ Token: 'orphan' })) as unknown as typeof fetch,
			}),
		/key pair/
	);
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

test('the health check answers without forwarding anything', async () => {
	withEnv({ AWS_SQS_QUEUE_NAME_0: 'orders', NAME: 'Worker' });
	const queue = spy('aws_sqs_queue');

	const base = await start();
	const res = await fetch(`${base}/health`);

	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { ok: true, self: 'Worker' });
	assert.equal(queue.length, 0, 'the health check fanned out');
});

test('a posted body reaches every wired neighbor and comes back as a report', async () => {
	withEnv({
		AWS_SQS_QUEUE_NAME_0: 'orders',
		AWS_SNS_TOPIC_NAME_0: 'events',
		NAME: 'Worker',
		REGION: 'us-east-1',
		ACCOUNT: '111122223333',
	});
	const queue = spy('aws_sqs_queue');
	const topic = spy('aws_sns_topic');

	const base = await start();
	const res = await fetch(base, { method: 'POST', body: 'hello' });
	const report = (await res.json()) as {
		origin: string;
		hops: { to: string; type: string; label: string; ok: boolean }[];
		dropped: number;
	};

	assert.equal(res.status, 200);
	// `direct` is the documented fallback in normalize(): no receiver claims an HTTP body, and that
	// is a legitimate way in rather than an error. It is what makes the HTTP path need no core change.
	assert.equal(report.origin, 'direct');
	assert.equal(report.hops.length, 2);
	assert.ok(report.hops.every((h) => h.ok));
	assert.deepEqual(
		report.hops.map((h) => h.type).sort(),
		['aws_sns_topic', 'aws_sqs_queue']
	);

	assert.equal(queue.length, 1);
	assert.equal(topic.length, 1);
	assert.equal(queue[0]?.neighbor.props['NAME'], 'orders');
	assert.equal(queue[0]?.envelope.body, 'hello');
	// Twice, and that is the existing shape rather than a slip here: a message entering the chain
	// is opened with this workload as its origin and then advanced through it. Locked down for the
	// same reason in hub.test.ts.
	assert.deepEqual(queue[0]?.envelope.path, ['Worker', 'Worker']);
});

test('a failed hop is reported, not turned into a 5xx', async () => {
	withEnv({ AWS_SQS_QUEUE_NAME_0: 'orders', NAME: 'Worker' });
	registry.register({
		type: 'aws_sqs_queue',
		async send() {
			throw new Error('AccessDenied: sqs:SendMessage');
		},
	});

	const base = await start();
	const res = await fetch(base, { method: 'POST', body: 'hello' });
	const report = (await res.json()) as { hops: { ok: boolean; err?: string }[] };

	// Answering 5xx here would make the load balancer read a correctly reported failure as a
	// broken task and pull it out of service.
	assert.equal(res.status, 200);
	assert.equal(report.hops.length, 1);
	assert.equal(report.hops[0]?.ok, false);
	assert.match(String(report.hops[0]?.err), /AccessDenied/);
});

test('an oversized body is refused with 413', async () => {
	withEnv({ NAME: 'Worker' });

	const base = await start({ maxBodyBytes: 16 });
	const res = await fetch(base, { method: 'POST', body: 'x'.repeat(64) });

	assert.equal(res.status, 413);
	assert.match(String(((await res.json()) as { error?: string }).error), /exceeds 16 bytes/);
});

test('a method that is neither the health check nor the work is refused', async () => {
	withEnv({ NAME: 'Worker' });

	const base = await start();
	const res = await fetch(base, { method: 'DELETE' });

	assert.equal(res.status, 405);
});

// ---------------------------------------------------------------------------
// Load-test endpoint (educational, opt-in)
// ---------------------------------------------------------------------------

test('the load-test endpoint does not exist unless it is turned on', async () => {
	// No HUB_LOADTEST. A CPU-burn route that answered by default would be a denial-of-service
	// vector in an account that never asked for it, so absent means 404, not 405.
	withEnv({ NAME: 'Worker' });

	const base = await start();
	const res = await fetch(`${base}/loadtest`, { method: 'POST' });

	assert.equal(res.status, 404);
});

test('when enabled, the load-test endpoint burns CPU and reports how long', async () => {
	withEnv({ NAME: 'Worker', HUB_LOADTEST: 'on' });

	const base = await start();
	const res = await fetch(`${base}/loadtest?ms=60`, { method: 'POST' });
	const body = (await res.json()) as { loadtest: boolean; requestedMs: number; burnedMs: number };

	assert.equal(res.status, 200);
	assert.equal(body.loadtest, true);
	assert.equal(body.requestedMs, 60);
	// It really spent time, and roughly the amount asked for (a lower bound is enough; the machine
	// running the test decides the upper one).
	assert.ok(body.burnedMs >= 55, `burned ${body.burnedMs}ms, expected around 60`);
});

test('the load-test endpoint refuses a non-POST even when enabled', async () => {
	withEnv({ NAME: 'Worker', HUB_LOADTEST: 'on' });

	const base = await start();
	const res = await fetch(`${base}/loadtest`, { method: 'GET' });

	assert.equal(res.status, 405);
});

test('turning the load-test endpoint on leaves health and fan-out untouched', async () => {
	// The endpoint lives on its own path; the contract paths must behave exactly as they did.
	withEnv({ AWS_SQS_QUEUE_NAME_0: 'orders', NAME: 'Worker', REGION: 'us-east-1', ACCOUNT: '111122223333', HUB_LOADTEST: 'on' });
	const queue = spy('aws_sqs_queue');

	const base = await start();

	const health = await fetch(`${base}/`);
	assert.equal(health.status, 200);
	assert.deepEqual(await health.json(), { ok: true, self: 'Worker' });
	assert.equal(queue.length, 0, 'the health check fanned out');

	const work = await fetch(base, { method: 'POST', body: 'hello' });
	const report = (await work.json()) as { hops: { ok: boolean }[] };
	assert.equal(work.status, 200);
	assert.equal(report.hops.length, 1);
	assert.equal(queue.length, 1, 'the fan-out did not reach the queue');
});

// ---------------------------------------------------------------------------
// Consuming
// ---------------------------------------------------------------------------

const CTX: Ctx = {
	self: 'Worker',
	fetch: globalThis.fetch,
	region: () => 'us-east-1',
	account: () => '111122223333',
	now: () => new Date(0),
};

const wire = (type: string, label: string, name: string): Neighbor => ({
	type,
	label,
	props: { NAME: name },
});

/**
 * A source that is also a destination — which is not a contrived pairing but the only shape the
 * contract can express today: the wire that makes a queue discoverable is a wire drawn outward.
 */
function consumable(type: string, items: Item[]) {
	const acked: Item[][] = [];
	const sent: Envelope[] = [];
	registry.register({
		type,
		async send(_n: Neighbor, e: Envelope) {
			sent.push(e);
		},
		async consume() {
			return {
				origin: 'fake:poll',
				describe: `${type} (${items.length})`,
				items,
				async ack(delivered: readonly Item[]) {
					acked.push([...delivered]);
				},
			};
		},
	});
	return { acked, sent };
}

test('the only consumable neighbor is the source, whatever the value says', () => {
	consumable('aws_sqs_queue', []);
	spy('aws_dynamodb_table');

	const source = selectSource([wire('aws_dynamodb_table', '0', 'T'), wire('aws_sqs_queue', '0', 'Q')], 'anything');

	assert.equal(source.type, 'aws_sqs_queue');
});

test('the label picks the source when more than one could be consumed', () => {
	consumable('aws_sqs_queue', []);

	const source = selectSource(
		[wire('aws_sqs_queue', 'IN', 'inbound'), wire('aws_sqs_queue', 'RETRY', 'retries')],
		'retry'
	);

	assert.equal(source.props['NAME'], 'retries');
});

test('the queue name picks the source too, since that is what a person reaches for', () => {
	// A wire drawn without text has the label `0`, and HUB_POLL=0 reads as *off* to anyone who
	// meets it. The queue's own name is the value people actually write.
	consumable('aws_sqs_queue', []);

	const source = selectSource(
		[wire('aws_sqs_queue', '0', 'hub-in'), wire('aws_sqs_queue', '1', 'hub-retry')],
		'hub-in'
	);

	assert.equal(source.label, '0');
});

test('an ambiguous choice is refused rather than guessed', () => {
	consumable('aws_sqs_queue', []);

	assert.throws(
		() => selectSource([wire('aws_sqs_queue', 'IN', 'a'), wire('aws_sqs_queue', 'RETRY', 'b')], 'neither'),
		// Picking the first would look exactly like success until someone noticed the other queue
		// never emptied.
		/does not name exactly one source.*IN.*RETRY/s
	);
});

test('nothing to consume points at the contract gap, not at a typo', () => {
	spy('aws_dynamodb_table');

	assert.throws(
		() => selectSource([wire('aws_dynamodb_table', '0', 'T')], 'x'),
		/wired FROM this workload.*8\.1/s
	);
});

test('the source is not a destination of what it produced', async () => {
	const queue = consumable('aws_sqs_queue', [{ id: 'm-1', body: 'hello' }]);
	const table = spy('aws_dynamodb_table');

	const source = wire('aws_sqs_queue', '0', 'Q');
	const target = wire('aws_dynamodb_table', '0', 'T');

	const report = await consumeOnce(source, [target], CTX);

	assert.equal(table.length, 1, 'the real destination did not receive it');
	// The wire exists and carries a sender; forwarding to it here would write every message read
	// straight back onto the queue that produced it.
	assert.equal(queue.sent.length, 0, 'the message was written back to its own source');
	assert.equal(report?.hops.length, 1);
});

test('only what was forwarded is acknowledged', async () => {
	const queue = consumable('aws_sqs_queue', [
		{ id: 'm-1', body: 'good' },
		{ id: 'm-2', body: 'bad' },
	]);
	registry.register({
		type: 'aws_dynamodb_table',
		async send(_n: Neighbor, e: Envelope) {
			if (e.body === 'bad') throw new Error('ValidationException: item too large');
		},
	});

	await consumeOnce(wire('aws_sqs_queue', '0', 'Q'), [wire('aws_dynamodb_table', '0', 'T')], CTX);

	// Deleting m-2 would lose it in silence; leaving it costs a redelivery once the visibility
	// timeout expires, which is the recoverable half of the two.
	assert.deepEqual(queue.acked, [[{ id: 'm-1', body: 'good' }]]);
});

test('an item that ran out of hops is acknowledged, because redelivering it drops it again', async () => {
	const spent = seal(open('looping', 'Upstream', { hops: 0 }));
	const queue = consumable('aws_sqs_queue', [{ id: 'm-1', body: spent }]);
	const table = spy('aws_dynamodb_table');

	const report = await consumeOnce(wire('aws_sqs_queue', '0', 'Q'), [wire('aws_dynamodb_table', '0', 'T')], CTX);

	assert.equal(report?.dropped, 1);
	assert.equal(table.length, 0);
	assert.deepEqual(queue.acked, [[{ id: 'm-1', body: spent }]]);
});

test('an empty poll acknowledges nothing and reports nothing', async () => {
	const queue = consumable('aws_sqs_queue', []);
	spy('aws_dynamodb_table');

	const report = await consumeOnce(wire('aws_sqs_queue', '0', 'Q'), [wire('aws_dynamodb_table', '0', 'T')], CTX);

	assert.equal(report, null);
	assert.deepEqual(queue.acked, []);
});
