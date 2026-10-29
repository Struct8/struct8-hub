/**
 * Google Cloud: the metadata server, the requests each module sends, and the Cloud Functions shim
 * end to end. Nothing here reaches the network: every request goes to a fake `fetch` that answers
 * as Google does and records what it was asked.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../dist/resources/index.js';
import * as registry from '../dist/core/registry.js';
import { open, read } from '../dist/core/envelope.js';
import * as google from '../dist/providers/google.js';
import { cloudfunctions } from '../dist/runtimes/cloudfunctions.js';
import type { Ctx, Neighbor, Report } from '../dist/core/types.js';

interface Seen {
	readonly url: string;
	readonly method: string;
	readonly headers: Headers;
	readonly body: string;
}

/** A fake Google: the metadata server, plus whatever `api` answers for the rest. */
function fakeGoogle(api: (seen: Seen) => Response = () => Response.json({})) {
	const seen: Seen[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		const s: Seen = {
			url: request.url,
			method: request.method,
			headers: request.headers,
			body: request.method === 'GET' ? '' : await request.text(),
		};
		seen.push(s);
		const url = new URL(s.url);
		if (url.hostname === 'metadata.google.internal') {
			if (request.headers.get('metadata-flavor') !== 'Google') return new Response('missing header', { status: 403 });
			if (url.pathname.endsWith('/token')) return Response.json({ access_token: 'ya29.from-metadata', expires_in: 3599 });
			if (url.pathname.endsWith('/identity')) return new Response(`id-for:${url.searchParams.get('audience')}`);
			if (url.pathname.endsWith('/project/project-id')) return new Response('my-project');
			if (url.pathname.endsWith('/instance/region')) return new Response('projects/123456/regions/us-central1');
			return new Response('not found', { status: 404 });
		}
		return api(s);
	};
	return { seen, fetchImpl, calls: () => seen.filter((s) => !s.url.startsWith('http://metadata.google.internal')) };
}

const ENVELOPE = open('payload', 'Fn', { trace: 'T', at: '2026-10-28T12:00:00.000Z' });

const ctxWith = (fetchImpl: typeof fetch): Ctx => ({
	self: 'Fn',
	fetch: fetchImpl,
	region: (n) => n?.props['REGION'] ?? 'us-central1',
	account: (n) => n?.props['ACCOUNT'] ?? 'my-project',
	now: () => new Date('2026-10-28T12:00:00Z'),
});

const neighbor = (type: string, props: Record<string, string>): Neighbor => ({ type, label: '0', props });
const send = (type: string) => registry.get(type)!.send!;

test('the access token comes from the metadata server once, and goes as a bearer token', async () => {
	google.resetCredentials();
	const g = fakeGoogle();
	await send('google_storage_bucket')(neighbor('google_storage_bucket', { NAME: 'b' }), ENVELOPE, ctxWith(g.fetchImpl));
	await send('google_storage_bucket')(neighbor('google_storage_bucket', { NAME: 'b' }), ENVELOPE, ctxWith(g.fetchImpl));

	const tokens = g.seen.filter((s) => s.url.endsWith('/token'));
	assert.equal(tokens.length, 1, 'the token was not cached');
	for (const call of g.calls()) assert.equal(call.headers.get('authorization'), 'Bearer ya29.from-metadata');
});

test('the project and the region come from the metadata server', async () => {
	google.resetCredentials();
	const g = fakeGoogle();
	assert.deepEqual(await google.whereAmI(g.fetchImpl), { project: 'my-project', region: 'us-central1' });
});

test('outside Google Cloud the failure names the missing credential', async () => {
	google.resetCredentials();
	const offline: typeof fetch = async () => {
		throw new TypeError('fetch failed');
	};
	await assert.rejects(() => google.accessToken(offline), /no Google credentials/);
	assert.deepEqual(await google.whereAmI(offline), {});
});

test('a refusal from Google names its status and the missing permission', async () => {
	google.resetCredentials();
	const g = fakeGoogle(() =>
		Response.json(
			{ error: { code: 403, status: 'PERMISSION_DENIED', message: "Permission 'pubsub.topics.publish' denied" } },
			{ status: 403 }
		)
	);
	await assert.rejects(
		() => send('google_pubsub_topic')(neighbor('google_pubsub_topic', { NAME: 'orders' }), ENVELOPE, ctxWith(g.fetchImpl)),
		/^Error: PERMISSION_DENIED: Permission 'pubsub\.topics\.publish' denied$/
	);
});

test('a topic receives the sealed envelope, in base64, at the project of the workload', async () => {
	google.resetCredentials();
	const g = fakeGoogle(() => Response.json({ messageIds: ['1'] }));
	await send('google_pubsub_topic')(neighbor('google_pubsub_topic', { NAME: 'orders' }), ENVELOPE, ctxWith(g.fetchImpl));

	const [call] = g.calls();
	assert.equal(call!.url, 'https://pubsub.googleapis.com/v1/projects/my-project/topics/orders:publish');
	const data = (JSON.parse(call!.body) as { messages: { data: string }[] }).messages[0]!.data;
	const sealed = read(Buffer.from(data, 'base64').toString('utf8'));
	assert.equal(sealed?.trace, 'T');
	assert.equal(sealed?.body, 'payload');
});

test('a topic in another project is addressed in that project', async () => {
	google.resetCredentials();
	const g = fakeGoogle(() => Response.json({ messageIds: ['1'] }));
	await send('google_pubsub_topic')(
		neighbor('google_pubsub_topic', { NAME: 'orders', ACCOUNT: 'other-project' }),
		ENVELOPE,
		ctxWith(g.fetchImpl)
	);
	assert.match(g.calls()[0]!.url, /\/projects\/other-project\/topics\/orders:publish$/);
});

test('a bucket receives one object per message, named as on S3', async () => {
	google.resetCredentials();
	const g = fakeGoogle();
	await send('google_storage_bucket')(neighbor('google_storage_bucket', { NAME: 'archive' }), ENVELOPE, ctxWith(g.fetchImpl));

	const url = new URL(g.calls()[0]!.url);
	assert.equal(url.pathname, '/upload/storage/v1/b/archive/o');
	assert.equal(url.searchParams.get('uploadType'), 'media');
	assert.match(url.searchParams.get('name') ?? '', /^Fn\/\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/);
	assert.equal(read(g.calls()[0]!.body)?.body, 'payload');
});

test('a secret receives a new version', async () => {
	google.resetCredentials();
	const g = fakeGoogle();
	await send('google_secret_manager_secret')(
		neighbor('google_secret_manager_secret', { NAME: 'api-key' }),
		ENVELOPE,
		ctxWith(g.fetchImpl)
	);
	assert.equal(g.calls()[0]!.url, 'https://secretmanager.googleapis.com/v1/projects/my-project/secrets/api-key:addVersion');
});

test('a Firestore database keeps one document per message, and a redelivery counts as stored', async () => {
	google.resetCredentials();
	const g = fakeGoogle(() =>
		Response.json({ error: { code: 409, status: 'ALREADY_EXISTS', message: 'Document already exists' } }, { status: 409 })
	);
	await send('google_firestore_database')(
		neighbor('google_firestore_database', { NAME: '(default)' }),
		ENVELOPE,
		ctxWith(g.fetchImpl)
	);

	const url = new URL(g.calls()[0]!.url);
	assert.equal(url.pathname, '/v1/projects/my-project/databases/(default)/documents/hub_messages');
	assert.match(url.searchParams.get('documentId') ?? '', /^[0-9a-f]{64}$/);
	const fields = (JSON.parse(g.calls()[0]!.body) as { fields: Record<string, Record<string, string>> }).fields;
	assert.equal(fields['body']!['stringValue'], 'payload');
	assert.equal(fields['hops']!['integerValue'], String(ENVELOPE.hops));
});

test('a BigQuery dataset gets hub_messages once, and each message is a MERGE on its id', async () => {
	google.resetCredentials();
	const g = fakeGoogle((s) =>
		s.url.endsWith('/tables')
			? Response.json({ error: { code: 409, status: 'ALREADY_EXISTS', message: 'Already Exists: Table' } }, { status: 409 })
			: Response.json({ jobComplete: true, numDmlAffectedRows: '1' })
	);
	const dataset = neighbor('google_bigquery_dataset', { NAME: 'events_ds' });
	await send('google_bigquery_dataset')(dataset, ENVELOPE, ctxWith(g.fetchImpl));
	await send('google_bigquery_dataset')(dataset, ENVELOPE, ctxWith(g.fetchImpl));

	const [create, first, second] = g.calls();
	assert.equal(g.calls().length, 3, 'the table is asked for once per dataset');
	assert.equal(create!.url, 'https://bigquery.googleapis.com/bigquery/v2/projects/my-project/datasets/events_ds/tables');
	assert.equal((JSON.parse(create!.body) as { tableReference: { tableId: string } }).tableReference.tableId, 'hub_messages');
	assert.equal(first!.url, 'https://bigquery.googleapis.com/bigquery/v2/projects/my-project/queries');
	const job = JSON.parse(first!.body) as { query: string; queryParameters: { name: string; parameterValue: { value: string } }[] };
	assert.match(job.query, /^MERGE `my-project\.events_ds\.hub_messages` t USING \(SELECT @id AS id\) s ON t\.id = s\.id /);
	const value = (name: string) => job.queryParameters.find((p) => p.name === name)?.parameterValue.value;
	assert.equal(value('body'), 'payload');
	assert.match(value('id') ?? '', /^[0-9a-f]{64}$/);
	assert.equal(second!.body, first!.body, 'a redelivery sends the same id');
});

test('a BigQuery insert that has not finished is not counted as stored, and an unquotable id sends nothing', async () => {
	google.resetCredentials();
	const g = fakeGoogle((s) =>
		s.url.endsWith('/tables') ? Response.json({}) : Response.json({ jobComplete: false, jobReference: { jobId: 'job_1' } })
	);
	await assert.rejects(
		send('google_bigquery_dataset')(neighbor('google_bigquery_dataset', { NAME: 'slow_ds' }), ENVELOPE, ctxWith(g.fetchImpl)),
		/had not finished after 20 s \(job job_1\)/
	);
	await assert.rejects(
		send('google_bigquery_dataset')(neighbor('google_bigquery_dataset', { NAME: 'x`; DROP' }), ENVELOPE, ctxWith(g.fetchImpl)),
		/is not a BigQuery dataset id/
	);
	assert.equal(g.calls().length, 2);
});

test('a function and a Cloud Run service are called with an identity token for their URL', async () => {
	google.resetCredentials();
	const g = fakeGoogle();
	await send('google_cloudfunctions2_function')(
		neighbor('google_cloudfunctions2_function', { URL: 'https://us-central1-my-project.cloudfunctions.net/resize' }),
		ENVELOPE,
		ctxWith(g.fetchImpl)
	);
	await send('google_cloud_run_v2_service')(
		neighbor('google_cloud_run_v2_service', { URL: 'https://api-abc123-uc.a.run.app' }),
		ENVELOPE,
		ctxWith(g.fetchImpl)
	);

	const [fn, run] = g.calls();
	assert.equal(fn!.headers.get('authorization'), 'Bearer id-for:https://us-central1-my-project.cloudfunctions.net/resize');
	assert.equal(run!.headers.get('authorization'), 'Bearer id-for:https://api-abc123-uc.a.run.app');
	assert.equal(read(run!.body)?.body, 'payload');
});

// ---------------------------------------------------------------------------
// The Cloud Functions shim
// ---------------------------------------------------------------------------

/** The Functions Framework's response, reduced to what the shim calls. */
function fakeResponse() {
	const out = { status: 0, headers: {} as Record<string, string>, body: '' };
	const res = {
		status(code: number) {
			out.status = code;
			return res;
		},
		set(field: string, value: string) {
			out.headers[field] = value;
			return res;
		},
		send(body: string) {
			out.body = body;
		},
	};
	return { res, out };
}

async function withEnvironment<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
	const before = { ...process.env };
	Object.assign(process.env, vars);
	try {
		return await fn();
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
		Object.assign(process.env, before);
	}
}

async function withFetch<T>(fetchImpl: typeof fetch, fn: () => Promise<T>): Promise<T> {
	const before = globalThis.fetch;
	globalThis.fetch = fetchImpl;
	try {
		return await fn();
	} finally {
		globalThis.fetch = before;
	}
}

test('a request reaches every wired destination, in the project the metadata server names', async () => {
	google.resetCredentials();
	const g = fakeGoogle(() => Response.json({ messageIds: ['1'] }));
	const { res, out } = fakeResponse();

	await withEnvironment(
		{ NAME: 'resizer', GOOGLE_PUBSUB_TOPIC_NAME_ORDERS: 'orders', GOOGLE_STORAGE_BUCKET_NAME_0: 'archive' },
		() => withFetch(g.fetchImpl, () => cloudfunctions()({ body: { order: 42 } }, res))
	);

	assert.equal(out.status, 200);
	const report = JSON.parse(out.body) as Report;
	assert.equal(report.origin, 'direct');
	assert.deepEqual(report.hops.map((h) => [h.type, h.label, h.ok]).sort(), [
		['google_pubsub_topic', 'ORDERS', true],
		['google_storage_bucket', '0', true],
	]);
	assert.ok(g.calls().some((c) => c.url.includes('/projects/my-project/topics/orders:publish')));
});

test('a Pub/Sub delivery whose forward failed answers 500, so Pub/Sub delivers it again', async () => {
	google.resetCredentials();
	const g = fakeGoogle(() =>
		Response.json({ error: { status: 'PERMISSION_DENIED', message: 'denied' } }, { status: 403 })
	);
	const { res, out } = fakeResponse();
	const push = {
		message: { data: Buffer.from('hello').toString('base64'), messageId: 'm-1' },
		subscription: 'projects/my-project/subscriptions/orders-push',
	};

	await withEnvironment({ NAME: 'relay', GOOGLE_STORAGE_BUCKET_NAME_0: 'archive' }, () =>
		withFetch(g.fetchImpl, () => cloudfunctions()({ body: push }, res))
	);

	assert.equal(out.status, 500);
	const report = JSON.parse(out.body) as Report;
	assert.equal(report.origin, 'gcp:pubsub');
	assert.deepEqual(report.failed, ['m-1']);
	assert.match(report.hops[0]!.err ?? '', /PERMISSION_DENIED/);
});

test('a direct request whose forward failed still answers 200: the report carries the failure', async () => {
	google.resetCredentials();
	const g = fakeGoogle(() => Response.json({ error: { status: 'NOT_FOUND', message: 'no bucket' } }, { status: 404 }));
	const { res, out } = fakeResponse();

	await withEnvironment({ NAME: 'relay', GOOGLE_STORAGE_BUCKET_NAME_0: 'archive' }, () =>
		withFetch(g.fetchImpl, () => cloudfunctions()({ body: 'plain text' }, res))
	);

	assert.equal(out.status, 200);
	assert.equal((JSON.parse(out.body) as Report).hops[0]!.ok, false);
});
