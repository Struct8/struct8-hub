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

import { container, taskCredentials, resetCredentialCache } from '../dist/runtimes/container.js';
import * as registry from '../dist/core/registry.js';
import type { Envelope, Neighbor } from '../dist/core/types.js';

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
