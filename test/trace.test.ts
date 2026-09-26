/**
 * The X-Ray trace.
 *
 * Every mistake this file catches is one that leaves a green suite and an empty console. A trace id
 * in the wrong format, a subsegment parented to a segment nobody wrote, a queue message sent without
 * the system attribute: X-Ray answers 200 to all three and shows nothing, or shows two disconnected
 * traces where there should be one. Nothing downstream complains, which is why the assertions have
 * to be here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isTraceId, parseTraceHeader, spanId, traceHeader, traceId } from '../dist/core/envelope.js';
import { segments } from '../dist/core/report.js';
import * as aws from '../dist/providers/aws.js';
import * as registry from '../dist/core/registry.js';
import { lambda } from '../dist/runtimes/lambda.js';
import '../dist/resources/aws_sqs_queue/index.js';
import type { Ctx, Envelope, Hop, Neighbor, Report, TraceContext } from '../dist/core/types.js';

aws.credentials({ accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' });

/** Captures the outgoing request instead of sending it. */
function capture(body = '{}') {
	const seen: Request[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		seen.push(input instanceof Request ? input : new Request(input, init));
		return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
	};
	return { seen, fetchImpl };
}

// ---------------------------------------------------------------------------
// The header
// ---------------------------------------------------------------------------

test('the trace header is read into its three parts', () => {
	const trace = parseTraceHeader('Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8;Sampled=1');

	assert.equal(trace?.root, '1-5759e988-bd862e3fe1be46a994272793');
	assert.equal(trace?.parent, '53995c3f42cd8ad8');
	assert.equal(trace?.sampled, true);
});

test('field order does not matter, and unknown fields are ignored', () => {
	// `Lineage` turns up on some paths and is none of our business. A parser that refuses the header
	// because of it loses the trace on exactly those paths and nowhere else.
	const trace = parseTraceHeader('Sampled=1;Lineage=1:aa1bb2:0;Root=1-5759e988-bd862e3fe1be46a994272793');

	assert.equal(trace?.root, '1-5759e988-bd862e3fe1be46a994272793');
	assert.equal(trace?.sampled, true);
	assert.equal(trace?.parent, undefined);
});

test('an undecided Sampled reads as not recording', () => {
	// The costly direction of this default. Guessing `true` starts billing X-Ray on a deployment that
	// never asked for it, and nothing in the function's own log would say where the charge came from.
	assert.equal(parseTraceHeader('Root=1-5759e988-bd862e3fe1be46a994272793')?.sampled, false);
	assert.equal(parseTraceHeader('Root=1-5759e988-bd862e3fe1be46a994272793;Sampled=0')?.sampled, false);
});

test('what cannot be parsed is no trace, not an error', () => {
	for (const raw of [undefined, null, '', 'garbage', 'Root=;Sampled=1', 'Root=not-a-trace-id;Sampled=1']) {
		assert.equal(parseTraceHeader(raw), null, `expected no trace from ${JSON.stringify(raw)}`);
	}
});

test('a minted id is in the format X-Ray accepts', () => {
	assert.ok(isTraceId(traceId()));
	// The timestamp half is read by X-Ray as the trace's age, and a trace far from now is refused —
	// so it has to be the real clock rather than a constant.
	const at = new Date('2026-09-26T12:00:00.000Z');
	assert.equal(traceId(at).split('-')[1], Math.floor(at.getTime() / 1000).toString(16));
	// What this replaced. A UUID correlates just as well and X-Ray rejects it outright.
	assert.equal(isTraceId(crypto.randomUUID()), false);
});

test('a span id is the eight bytes X-Ray accepts', () => {
	assert.match(spanId(), /^[0-9a-f]{16}$/);
});

test('the header written out is the header read back', () => {
	const trace: TraceContext = { root: traceId(), parent: spanId(), sampled: true };
	assert.deepEqual(parseTraceHeader(traceHeader(trace)), trace);
});

// ---------------------------------------------------------------------------
// The documents
// ---------------------------------------------------------------------------

const AT = 1_700_000_000_000;

const hop = (over: Partial<Hop> = {}): Hop => ({
	n: 1,
	to: 'orders-table',
	type: 'aws_dynamodb_table',
	label: '0',
	ok: true,
	ms: 120,
	at: AT,
	...over,
});

const report = (hops: Hop[], over: Partial<Report> = {}): Report => ({
	trace: '1-5759e988-bd862e3fe1be46a994272793',
	origin: 'aws:apigateway',
	hops,
	failed: [],
	dropped: 0,
	...over,
});

const LAMBDA: TraceContext = { root: '1-5759e988-bd862e3fe1be46a994272793', parent: '53995c3f42cd8ad8', sampled: true };
const CONTAINER: TraceContext = { root: '1-5759e988-bd862e3fe1be46a994272793', parent: 'aabbccdd11223344', opens: true, sampled: true };

const parsed = (docs: string[]): Record<string, any>[] => docs.map((d) => JSON.parse(d) as Record<string, any>);

test('on Lambda each hop is a standalone subsegment under the invocation segment', () => {
	const docs = parsed(segments(report([hop(), hop({ n: 2, to: 'order-events', type: 'aws_sns_topic', at: AT + 120, ms: 80 })]), LAMBDA, 'api-handler'));

	assert.equal(docs.length, 2);
	for (const doc of docs) {
		// Without `type`, X-Ray reads the document as a segment and the trace gains a second root —
		// the console then shows the function twice and draws no edge to either copy.
		assert.equal(doc['type'], 'subsegment');
		assert.equal(doc['parent_id'], LAMBDA.parent);
		assert.equal(doc['trace_id'], LAMBDA.root);
		assert.equal(doc['namespace'], 'remote');
		assert.match(String(doc['id']), /^[0-9a-f]{16}$/);
	}

	assert.equal(docs[0]?.['name'], 'orders-table');
	assert.equal(docs[1]?.['name'], 'order-events');
});

test('times are seconds with a fraction, which is the only form X-Ray reads', () => {
	const [doc] = parsed(segments(report([hop({ at: AT, ms: 120 })]), LAMBDA, 'api-handler'));

	assert.equal(doc?.['start_time'], 1_700_000_000);
	assert.equal(doc?.['end_time'], 1_700_000_000.12);
});

test('in a container the run writes its own segment, with the hops inside it', () => {
	const docs = parsed(segments(report([hop(), hop({ n: 2, at: AT + 120, ms: 80 })]), CONTAINER, 'hub_1'));

	assert.equal(docs.length, 1);
	const segment = docs[0]!;
	assert.equal(segment['type'], undefined);
	assert.equal(segment['name'], 'hub_1');
	// The id the runtime already handed downstream in the trace header. A fresh one here would leave
	// the next workload parented to a segment that was never written — accepted by the API, never
	// displayed.
	assert.equal(segment['id'], CONTAINER.parent);
	assert.equal((segment['subsegments'] as unknown[]).length, 2);
	assert.equal(segment['start_time'], 1_700_000_000);
	assert.equal(segment['end_time'], 1_700_000_000.2);
});

test('a failed hop carries the reason the report carries', () => {
	const docs = parsed(segments(report([hop({ ok: false, err: 'AccessDenied: sqs:SendMessage' })]), LAMBDA, 'api-handler'));

	assert.equal(docs[0]?.['error'], true);
	assert.equal(docs[0]?.['cause']?.exceptions?.[0]?.message, 'AccessDenied: sqs:SendMessage');
});

test('the wire is annotated, so a red node can be found in the drawing', () => {
	const docs = parsed(segments(report([hop({ label: 'orders' })]), LAMBDA, 'api-handler'));

	assert.equal(docs[0]?.['annotations']?.wire, 'orders');
	assert.equal(docs[0]?.['annotations']?.resource_type, 'aws_dynamodb_table');
});

test('nothing is built when nothing is being recorded, or when nothing happened', () => {
	assert.deepEqual(segments(report([hop()]), { ...LAMBDA, sampled: false }, 'api-handler'), []);
	assert.deepEqual(segments(report([]), LAMBDA, 'api-handler'), []);
});

// ---------------------------------------------------------------------------
// Getting the trace to the next workload
// ---------------------------------------------------------------------------

const ctx = (over: Partial<Ctx> = {}): Ctx => ({
	self: 'api-handler',
	fetch: globalThis.fetch,
	region: () => 'us-west-2',
	account: () => '111122223333',
	now: () => new Date(AT),
	...over,
});

const envelope: Envelope = { trace: LAMBDA.root, hops: 3, path: ['api-handler'], at: '2026-09-26T12:00:00.000Z', body: 'hello' };

const queue: Neighbor = { type: 'aws_sqs_queue', label: '0', props: { NAME: 'order-processing' } };

test('a queue send carries the trace in the system attribute', async () => {
	const { seen, fetchImpl } = capture();
	await registry.get('aws_sqs_queue')!.send!(queue, envelope, ctx({ fetch: fetchImpl, trace: LAMBDA }));

	const body = JSON.parse(await seen[0]!.text()) as Record<string, any>;
	// A message attribute would not do. The event source mapping reads `AWSTraceHeader` from the
	// SYSTEM attributes and nowhere else, and it is the one hop no HTTP header can carry, because the
	// sender and the consumer never speak to each other.
	assert.equal(body['MessageSystemAttributes']?.AWSTraceHeader?.DataType, 'String');
	assert.equal(body['MessageSystemAttributes']?.AWSTraceHeader?.StringValue, traceHeader(LAMBDA));
});

test('a queue send with no trace is the request it always was', async () => {
	const { seen, fetchImpl } = capture();
	await registry.get('aws_sqs_queue')!.send!(queue, envelope, ctx({ fetch: fetchImpl }));

	const body = JSON.parse(await seen[0]!.text()) as Record<string, any>;
	assert.deepEqual(Object.keys(body).sort(), ['MessageBody', 'QueueUrl']);
});

test('the trace header rides every signed request, and only while one is set', async () => {
	// This is what SNS reads. A publish without it starts a new trace at the topic however carefully
	// the message body was stamped, because the topic never opens the body.
	aws.setTraceHeader(traceHeader(LAMBDA));
	const on = capture();
	await aws.query('sns', 'us-west-2', { Action: 'Publish', TopicArn: 'arn', Message: 'hi' }, on.fetchImpl);
	assert.equal(on.seen[0]?.headers.get('x-amzn-trace-id'), traceHeader(LAMBDA));

	aws.resetTraceHeader();
	const off = capture();
	await aws.query('sns', 'us-west-2', { Action: 'Publish', TopicArn: 'arn', Message: 'hi' }, off.fetchImpl);
	assert.equal(off.seen[0]?.headers.get('x-amzn-trace-id'), null);
});

// ---------------------------------------------------------------------------
// Sending it
// ---------------------------------------------------------------------------

test('the segments go to the X-Ray endpoint of the region', async () => {
	const { seen, fetchImpl } = capture();
	await aws.emitTrace(report([hop()]), LAMBDA, 'api-handler', 'us-west-2', fetchImpl);

	assert.equal(seen.length, 1);
	assert.equal(new URL(seen[0]!.url).host, 'xray.us-west-2.amazonaws.com');
	assert.equal(new URL(seen[0]!.url).pathname, '/TraceSegments');
	assert.equal(seen[0]?.headers.get('content-type'), 'application/json');

	const body = JSON.parse(await seen[0]!.text()) as { TraceSegmentDocuments: string[] };
	// Documents go up as STRINGS, not as objects. Sending them nested is a 200 with everything in
	// `UnprocessedTraceSegments`, which is the failure that looks like success.
	assert.equal(typeof body.TraceSegmentDocuments[0], 'string');
	assert.equal(JSON.parse(body.TraceSegmentDocuments[0]!)['trace_id'], LAMBDA.root);
});

test('nothing is sent without a trace, without a region, or without hops', async () => {
	const cases: [string, (f: typeof fetch) => Promise<void>][] = [
		['no trace', (f) => aws.emitTrace(report([hop()]), undefined, 'api-handler', 'us-west-2', f)],
		['no region', (f) => aws.emitTrace(report([hop()]), LAMBDA, 'api-handler', undefined, f)],
		['no hops', (f) => aws.emitTrace(report([]), LAMBDA, 'api-handler', 'us-west-2', f)],
		['not sampled', (f) => aws.emitTrace(report([hop()]), { ...LAMBDA, sampled: false }, 'api-handler', 'us-west-2', f)],
	];

	for (const [why, call] of cases) {
		const { seen, fetchImpl } = capture();
		await call(fetchImpl);
		// A request here would be a billed trace for a run that asked for none.
		assert.equal(seen.length, 0, `sent something with ${why}`);
	}
});

test('a rejected document is reported rather than swallowed', async () => {
	const answer = JSON.stringify({
		UnprocessedTraceSegments: [{ Id: 'abc', ErrorCode: 'InvalidTraceId', Message: 'bad id' }],
	});
	const { fetchImpl } = capture(answer);

	const unprocessed = await aws.putTraceSegments('us-west-2', ['{}'], fetchImpl);
	assert.deepEqual(unprocessed, ['InvalidTraceId: bad id']);
});

test('a failure to send is not a failure of the work', async () => {
	const refused: typeof fetch = async () => new Response('{"__type":"AccessDeniedException","message":"no"}', { status: 403 });

	// The fan-out already happened. Throwing here would turn a delivered message into a retried one,
	// duplicating real work to protect a record of it.
	await aws.emitTrace(report([hop()]), LAMBDA, 'api-handler', 'us-west-2', refused);
});

// ---------------------------------------------------------------------------
// The whole chain, through the Lambda runtime
// ---------------------------------------------------------------------------

/**
 * One invocation, both halves observable.
 *
 * The queue is the destination on purpose: what the diagram needs is the trace reaching the NEXT
 * function, and a signed `fetch` only carries it to the queue's API. The hand-off to the consumer is
 * the system attribute, and this is the only test where both appear in the same call.
 */
async function invoke(header: string | undefined): Promise<Request[]> {
	const { seen, fetchImpl } = capture();
	const real = globalThis.fetch;
	globalThis.fetch = fetchImpl;

	const before = { ...process.env };
	process.env['NAME'] = 'api-handler';
	process.env['REGION'] = 'us-west-2';
	process.env['ACCOUNT'] = '111122223333';
	process.env['AWS_SQS_QUEUE_NAME_0'] = 'order-processing';
	if (header === undefined) delete process.env['_X_AMZN_TRACE_ID'];
	else process.env['_X_AMZN_TRACE_ID'] = header;

	try {
		await lambda()({ body: 'hello' });
	} finally {
		globalThis.fetch = real;
		aws.resetTraceHeader();
		for (const key of ['NAME', 'REGION', 'ACCOUNT', 'AWS_SQS_QUEUE_NAME_0', '_X_AMZN_TRACE_ID']) {
			if (before[key] === undefined) delete process.env[key];
			else process.env[key] = before[key];
		}
	}

	return seen;
}

const xray = (seen: Request[]): Request[] => seen.filter((r) => new URL(r.url).host.startsWith('xray.'));
const sqs = (seen: Request[]): Request[] => seen.filter((r) => new URL(r.url).host.startsWith('sqs.'));

test('a sampled invocation forwards the trace and reports its trail', async () => {
	const seen = await invoke(`Root=${LAMBDA.root};Parent=${LAMBDA.parent};Sampled=1`);

	const message = JSON.parse(await sqs(seen)[0]!.text()) as Record<string, any>;
	assert.equal(message['MessageSystemAttributes']?.AWSTraceHeader?.StringValue, traceHeader(LAMBDA));
	assert.equal(sqs(seen)[0]?.headers.get('x-amzn-trace-id'), traceHeader(LAMBDA));

	const documents = JSON.parse(await xray(seen)[0]!.text()) as { TraceSegmentDocuments: string[] };
	const subsegment = JSON.parse(documents.TraceSegmentDocuments[0]!) as Record<string, any>;
	// The platform's trace id, not one of ours. The invocation segment is already filed under it.
	assert.equal(subsegment['trace_id'], LAMBDA.root);
	assert.equal(subsegment['parent_id'], LAMBDA.parent);
	assert.equal(subsegment['name'], 'order-processing');
});

test('an unsampled invocation sends the message it always sent, and no trace', async () => {
	for (const header of [`Root=${LAMBDA.root};Parent=${LAMBDA.parent};Sampled=0`, undefined]) {
		const seen = await invoke(header);

		assert.equal(xray(seen).length, 0, `sent a trace with ${header ?? 'no header'}`);
		const message = JSON.parse(await sqs(seen)[0]!.text()) as Record<string, any>;
		assert.deepEqual(Object.keys(message).sort(), ['MessageBody', 'QueueUrl']);
		assert.equal(sqs(seen)[0]?.headers.get('x-amzn-trace-id'), null);
	}
});
