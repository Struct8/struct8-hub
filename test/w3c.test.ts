/**
 * One trace across two clouds: the W3C `traceparent` on every hop that leaves for or arrives from
 * Google, and the spans a Cloud Function sends to Cloud Trace.
 *
 * The failure these tests guard against is the quiet one. A trace id spelled the wrong way, or a
 * span parented to an id nobody sent, is accepted by both backends and shown as two unrelated
 * traces, which reads exactly like tracing that works on each side and not across.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../dist/resources/index.js';
import * as registry from '../dist/core/registry.js';
import { open, parseTraceparent, traceparent, w3cTraceId, xrayRoot } from '../dist/core/envelope.js';
import { segments, spans } from '../dist/core/report.js';
import * as google from '../dist/providers/google.js';
import { cloudfunctions } from '../dist/runtimes/cloudfunctions.js';
import type { Ctx, Neighbor, Report, TraceContext } from '../dist/core/types.js';

const ROOT = '1-5759e988-bd862e3fe1be46a994272793';
const W3C = '5759e988bd862e3fe1be46a994272793';

// ---------------------------------------------------------------------------
// The two spellings
// ---------------------------------------------------------------------------

test('an X-Ray root and a W3C trace id are the same 128 bits', () => {
	assert.equal(w3cTraceId(ROOT), W3C);
	assert.equal(xrayRoot(W3C), ROOT);
	// The example X-Ray's documentation gives for the mapping.
	assert.equal(xrayRoot('4efaaf4d1e8720b39541901950019ee5'), '1-4efaaf4d-1e8720b39541901950019ee5');
});

test('a traceparent is read into the X-Ray root, the parent and the sampled flag', () => {
	const trace = parseTraceparent(`00-${W3C}-53995c3f42cd8ad8-01`);
	assert.deepEqual(trace, { root: ROOT, parent: '53995c3f42cd8ad8', sampled: true });
	assert.equal(parseTraceparent(`00-${W3C}-53995c3f42cd8ad8-00`)?.sampled, false);
	// Bits other than bit 0 are reserved, and say nothing about sampling.
	assert.equal(parseTraceparent(`00-${W3C}-53995c3f42cd8ad8-02`)?.sampled, false);
	assert.equal(parseTraceparent(`00-${W3C.toUpperCase()}-53995C3F42CD8AD8-01`)?.root, ROOT);
});

test('what the specification says to discard is discarded, not repaired', () => {
	for (const bad of [
		`ff-${W3C}-53995c3f42cd8ad8-01`,
		`00-${'0'.repeat(32)}-53995c3f42cd8ad8-01`,
		`00-${W3C}-${'0'.repeat(16)}-01`,
		`00-${W3C}-53995c3f42cd8ad8-01-extra`,
		`00-${W3C.slice(1)}-53995c3f42cd8ad8-01`,
		'Root=1-5759e988-bd862e3fe1be46a994272793;Sampled=1',
		'',
	]) {
		assert.equal(parseTraceparent(bad), null, bad);
	}
	// A later version is read by its first four fields.
	assert.equal(parseTraceparent(`01-${W3C}-53995c3f42cd8ad8-01-future`)?.root, ROOT);
});

test('a traceparent names the span downstream hangs from, and is not written without one', () => {
	assert.equal(traceparent({ root: ROOT, parent: '53995c3f42cd8ad8', sampled: true }), `00-${W3C}-53995c3f42cd8ad8-01`);
	assert.equal(traceparent({ root: ROOT, sampled: true }), null);
});

// ---------------------------------------------------------------------------
// The spans
// ---------------------------------------------------------------------------

const HOPS: Report = {
	trace: ROOT,
	origin: 'gcp:pubsub',
	hops: [
		{ n: 1, to: 'orders', type: 'google_pubsub_topic', label: 'ORDERS', ok: true, ms: 40, at: 1_700_000_000_000 },
		{ n: 2, to: 'archive', type: 'google_storage_bucket', label: '0', ok: false, ms: 10, at: 1_700_000_000_050, err: 'PERMISSION_DENIED: denied' },
	],
	failed: ['m-1'],
	dropped: 0,
};

const OPENING: TraceContext = { root: ROOT, parent: 'aaaaaaaaaaaaaaaa', opens: true, sampled: true, upstream: '53995c3f42cd8ad8' };

test('the run is one span, the hops its children, all in the W3C trace id', () => {
	const request = spans(HOPS, OPENING, { service: 'relay', attributes: { 'gcp.project_id': 'my-project' } }) as any;
	const scope = request.resourceSpans[0].scopeSpans[0];
	const [run, ...hops] = scope.spans;

	assert.deepEqual(request.resourceSpans[0].resource.attributes, [
		{ key: 'service.name', value: { stringValue: 'relay' } },
		{ key: 'gcp.project_id', value: { stringValue: 'my-project' } },
	]);
	assert.equal(run.traceId, W3C);
	// The id the runtime already handed downstream, and the caller's span as its parent.
	assert.equal(run.spanId, 'aaaaaaaaaaaaaaaa');
	assert.equal(run.parentSpanId, '53995c3f42cd8ad8');
	assert.equal(run.kind, 5, 'a Pub/Sub delivery is consumed, not served');
	assert.equal(run.startTimeUnixNano, '1700000000000000000');
	assert.equal(run.endTimeUnixNano, '1700000000060000000');
	assert.equal(run.status.code, 2);

	assert.equal(hops.length, 2);
	for (const hop of hops) {
		assert.equal(hop.traceId, W3C);
		assert.equal(hop.parentSpanId, 'aaaaaaaaaaaaaaaa');
		assert.match(hop.spanId, /^[0-9a-f]{16}$/);
	}
	assert.deepEqual(hops[0].status, { code: 0 });
	assert.deepEqual(hops[1].status, { code: 2, message: 'PERMISSION_DENIED: denied' });
	assert.deepEqual(hops[0].attributes, [
		{ key: 'struct8.wire', value: { stringValue: 'ORDERS' } },
		{ key: 'struct8.resource_type', value: { stringValue: 'google_pubsub_topic' } },
		{ key: 'struct8.hop', value: { intValue: '1' } },
	]);
});

test('nothing is recorded when the trace is not sampled or no hop ran', () => {
	assert.equal(spans(HOPS, { ...OPENING, sampled: false }, { service: 'x', attributes: {} }), null);
	assert.equal(spans({ ...HOPS, hops: [] }, OPENING, { service: 'x', attributes: {} }), null);
});

test('an opening X-Ray segment names the caller as its parent', () => {
	const [doc] = segments(HOPS, OPENING, 'relay');
	assert.equal(JSON.parse(doc!).parent_id, '53995c3f42cd8ad8');
	const [without] = segments(HOPS, { ...OPENING, upstream: undefined }, 'relay');
	assert.equal('parent_id' in JSON.parse(without!), false);
});

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

interface Seen {
	readonly url: string;
	readonly headers: Headers;
	readonly body: string;
}

function fakeGoogle(api: (seen: Seen) => Response = () => Response.json({ messageIds: ['1'] })) {
	const seen: Seen[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		const s: Seen = { url: request.url, headers: request.headers, body: request.method === 'GET' ? '' : await request.text() };
		seen.push(s);
		const url = new URL(s.url);
		if (url.hostname === 'metadata.google.internal') {
			if (url.pathname.endsWith('/token')) return Response.json({ access_token: 'ya29.from-metadata', expires_in: 3599 });
			if (url.pathname.endsWith('/identity')) return new Response(`id-for:${url.searchParams.get('audience')}`);
			if (url.pathname.endsWith('/project/project-id')) return new Response('my-project');
			if (url.pathname.endsWith('/instance/region')) return new Response('projects/123456/regions/us-central1');
			return new Response('not found', { status: 404 });
		}
		return api(s);
	};
	return { fetchImpl, calls: () => seen.filter((s) => !s.url.startsWith('http://metadata.google.internal')) };
}

const ENVELOPE = open('payload', 'Fn', { trace: ROOT, at: '2026-10-28T12:00:00.000Z' });
const neighbor = (type: string, props: Record<string, string>): Neighbor => ({ type, label: '0', props });

const ctxWith = (fetchImpl: typeof fetch, trace?: TraceContext): Ctx => ({
	self: 'Fn',
	fetch: fetchImpl,
	region: () => 'us-central1',
	account: (n) => n?.props['ACCOUNT'] ?? 'my-project',
	now: () => new Date('2026-10-28T12:00:00Z'),
	...(trace === undefined ? {} : { trace }),
});

// What a Lambda with tracing on has as its trace: the X-Ray header, read.
const LAMBDA: TraceContext = { root: ROOT, parent: '53995c3f42cd8ad8', sampled: true };

test('a message published to Pub/Sub carries the trace as googclient_traceparent', async () => {
	google.resetCredentials();
	const g = fakeGoogle();
	await registry.get('google_pubsub_topic')!.send!(neighbor('google_pubsub_topic', { NAME: 'orders' }), ENVELOPE, ctxWith(g.fetchImpl, LAMBDA));

	const body = JSON.parse(g.calls()[0]!.body);
	assert.deepEqual(body.messages[0].attributes, { googclient_traceparent: `00-${W3C}-53995c3f42cd8ad8-01` });
});

test('with no trace being recorded the message carries no attribute', async () => {
	google.resetCredentials();
	const g = fakeGoogle();
	await registry.get('google_pubsub_topic')!.send!(neighbor('google_pubsub_topic', { NAME: 'orders' }), ENVELOPE, ctxWith(g.fetchImpl));
	assert.equal('attributes' in JSON.parse(g.calls()[0]!.body).messages[0], false);
});

test('a function and a Cloud Run service are called with traceparent', async () => {
	google.resetCredentials();
	const g = fakeGoogle(() => Response.json({}));
	await registry.get('google_cloudfunctions2_function')!.send!(
		neighbor('google_cloudfunctions2_function', { URL: 'https://us-central1-my-project.cloudfunctions.net/resize' }),
		ENVELOPE,
		ctxWith(g.fetchImpl, LAMBDA)
	);
	await registry.get('google_cloud_run_v2_service')!.send!(
		neighbor('google_cloud_run_v2_service', { URL: 'https://api-abc123-uc.a.run.app' }),
		ENVELOPE,
		ctxWith(g.fetchImpl)
	);
	const [fn, run] = g.calls();
	assert.equal(fn!.headers.get('traceparent'), `00-${W3C}-53995c3f42cd8ad8-01`);
	assert.equal(run!.headers.get('traceparent'), null);
});

test('a Pub/Sub push carrying the attribute arrives with the trace', async () => {
	const arrival = await registry.get('google_pubsub_topic')!.receive!({
		message: { data: 'aGk=', messageId: 'm-1', attributes: { googclient_traceparent: `00-${W3C}-53995c3f42cd8ad8-01` } },
		subscription: 'projects/my-project/subscriptions/orders-push',
	});
	assert.deepEqual(arrival?.trace, { root: ROOT, parent: '53995c3f42cd8ad8', sampled: true });
});

// ---------------------------------------------------------------------------
// The Cloud Functions shim
// ---------------------------------------------------------------------------

function fakeResponse() {
	const out = { status: 0, body: '' };
	const res = {
		status(code: number) {
			out.status = code;
			return res;
		},
		set() {
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

const PUSH = {
	message: {
		data: Buffer.from('hello').toString('base64'),
		messageId: 'm-1',
		attributes: { googclient_traceparent: `00-${W3C}-53995c3f42cd8ad8-01` },
	},
	subscription: 'projects/my-project/subscriptions/orders-push',
};

test('with HUB_TRACE on, a function continues the message trace and writes it to Cloud Trace', async () => {
	google.resetCredentials();
	const g = fakeGoogle((s) => (s.url.startsWith(google.TELEMETRY_TRACES) ? Response.json({}) : Response.json({ messageIds: ['1'] })));
	const { res, out } = fakeResponse();

	await withEnvironment({ NAME: 'relay', HUB_TRACE: 'on', GOOGLE_PUBSUB_TOPIC_NAME_NEXT: 'next' }, () =>
		withFetch(g.fetchImpl, () => cloudfunctions()({ body: PUSH, headers: { traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01` } }, res))
	);

	assert.equal(out.status, 200);
	assert.equal((JSON.parse(out.body) as Report).trace, ROOT, 'the message trace outranks the push request header');

	const telemetry = g.calls().find((c) => c.url === google.TELEMETRY_TRACES);
	assert.ok(telemetry, 'spans were sent');
	assert.equal(telemetry!.headers.get('authorization'), 'Bearer ya29.from-metadata');
	const request = JSON.parse(telemetry!.body);
	const attrs = Object.fromEntries(
		request.resourceSpans[0].resource.attributes.map((a: any) => [a.key, a.value.stringValue])
	);
	assert.deepEqual(attrs, { 'service.name': 'relay', 'gcp.project_id': 'my-project', 'cloud.provider': 'gcp', 'cloud.region': 'us-central1' });
	const [run] = request.resourceSpans[0].scopeSpans[0].spans;
	assert.equal(run.traceId, W3C);
	assert.equal(run.parentSpanId, '53995c3f42cd8ad8');

	// The next message names THIS run's span as its parent, so the chain goes on from here.
	const publish = g.calls().find((c) => c.url.includes(':publish'))!;
	const forwarded = JSON.parse(publish.body).messages[0].attributes.googclient_traceparent;
	assert.equal(forwarded, `00-${W3C}-${run.spanId}-01`);
});

test('a request with only the header continues the header trace', async () => {
	google.resetCredentials();
	const g = fakeGoogle((s) => (s.url.startsWith(google.TELEMETRY_TRACES) ? Response.json({}) : Response.json({ messageIds: ['1'] })));
	const { res } = fakeResponse();

	await withEnvironment({ NAME: 'relay', HUB_TRACE: 'on', GOOGLE_PUBSUB_TOPIC_NAME_NEXT: 'next' }, () =>
		withFetch(g.fetchImpl, () =>
			cloudfunctions()({ body: { order: 1 }, headers: { traceparent: `00-${W3C}-53995c3f42cd8ad8-01` } }, res)
		)
	);

	const run = JSON.parse(g.calls().find((c) => c.url === google.TELEMETRY_TRACES)!.body).resourceSpans[0].scopeSpans[0].spans[0];
	assert.equal(run.traceId, W3C);
	assert.equal(run.parentSpanId, '53995c3f42cd8ad8');
	assert.equal(run.kind, 2);
});

test('with HUB_TRACE off nothing goes to Cloud Trace and nothing carries a trace', async () => {
	google.resetCredentials();
	const g = fakeGoogle();
	const { res } = fakeResponse();

	await withEnvironment({ NAME: 'relay', GOOGLE_PUBSUB_TOPIC_NAME_NEXT: 'next' }, () =>
		withFetch(g.fetchImpl, () => cloudfunctions()({ body: PUSH }, res))
	);

	assert.equal(g.calls().some((c) => c.url === google.TELEMETRY_TRACES), false);
	const publish = g.calls().find((c) => c.url.includes(':publish'))!;
	assert.equal('attributes' in JSON.parse(publish.body).messages[0], false);
});

test('a refused trace is logged and does not fail the request', async () => {
	google.resetCredentials();
	const g = fakeGoogle((s) =>
		s.url.startsWith(google.TELEMETRY_TRACES)
			? Response.json({ error: { status: 'PERMISSION_DENIED', message: 'telemetry.traces.write denied' } }, { status: 403 })
			: Response.json({ messageIds: ['1'] })
	);
	const { res, out } = fakeResponse();
	const errors: string[] = [];
	const before = console.error;
	console.error = (line: string) => errors.push(line);
	try {
		await withEnvironment({ NAME: 'relay', HUB_TRACE: 'on', GOOGLE_PUBSUB_TOPIC_NAME_NEXT: 'next' }, () =>
			withFetch(g.fetchImpl, () => cloudfunctions()({ body: PUSH }, res))
		);
	} finally {
		console.error = before;
	}

	assert.equal(out.status, 200);
	assert.ok(errors.some((e) => e.includes('trace not sent') && e.includes('PERMISSION_DENIED')), errors.join('\n'));
});
