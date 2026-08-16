import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { handle, normalize, ack } from '../dist/core/hub.js';
import { open, read, seal } from '../dist/core/envelope.js';
import * as registry from '../dist/core/registry.js';
import type { Arrival, Ctx, Envelope, Neighbor } from '../dist/core/types.js';

beforeEach(() => registry.reset());

const CTX: Ctx = {
	self: 'Fn',
	fetch: globalThis.fetch,
	region: () => 'us-east-1',
	account: () => '111122223333',
	now: () => new Date(0),
};

const neighbor = (type: string, label: string, name: string): Neighbor => ({
	type,
	label,
	props: { NAME: name },
});

const arrival = (items: { id?: string; body: string }[], origin = 'aws:sqs'): Arrival => ({
	origin,
	describe: 'test',
	items,
});

/** Registers a sender that records what it was given. */
function spy(type: string, behavior?: () => never) {
	const seen: { neighbor: Neighbor; envelope: Envelope }[] = [];
	registry.register({
		type,
		async send(n, e) {
			seen.push({ neighbor: n, envelope: e });
			behavior?.();
		},
	});
	return seen;
}

test('every wired destination receives every item', () => {
	const queue = spy('aws_sqs_queue');
	const bucket = spy('aws_s3_bucket');

	return handle(
		arrival([{ body: 'one' }, { body: 'two' }]),
		[neighbor('aws_sqs_queue', '0', 'Q'), neighbor('aws_s3_bucket', 'ARCHIVE', 'B')],
		CTX
	).then((report) => {
		assert.equal(queue.length, 2);
		assert.equal(bucket.length, 2);
		assert.equal(report.hops.length, 4);
		assert.ok(report.hops.every((h) => h.ok));
	});
});

test('a batched source is read in full, not just the first record', async () => {
	// Reading Records[0] alone would discard up to batchSize - 1 messages while reporting success.
	const queue = spy('aws_sqs_queue');
	await handle(
		arrival([{ body: 'a' }, { body: 'b' }, { body: 'c' }]),
		[neighbor('aws_sqs_queue', '0', 'Q')],
		CTX
	);
	assert.deepEqual(
		queue.map((s) => s.envelope.body),
		['a', 'b', 'c']
	);
});

test('one broken wire does not take the others down', async () => {
	const good = spy('aws_sqs_queue');
	spy('aws_s3_bucket', () => {
		throw new Error('AccessDenied: s3:PutObject');
	});

	const report = await handle(
		arrival([{ id: 'm1', body: 'hello' }]),
		[neighbor('aws_s3_bucket', 'ARCHIVE', 'B'), neighbor('aws_sqs_queue', '0', 'Q')],
		CTX
	);

	assert.equal(good.length, 1, 'the healthy destination still received it');

	const failed = report.hops.find((h) => !h.ok);
	assert.equal(failed?.type, 'aws_s3_bucket');
	assert.equal(failed?.label, 'ARCHIVE');
	assert.match(failed?.err ?? '', /AccessDenied: s3:PutObject/);
});

test('a failed item is reported by id so only it is redelivered', async () => {
	spy('aws_s3_bucket', () => {
		throw new Error('nope');
	});

	const report = await handle(
		arrival([{ id: 'm1', body: 'a' }, { id: 'm2', body: 'b' }]),
		[neighbor('aws_s3_bucket', '0', 'B')],
		CTX
	);

	assert.deepEqual(report.failed, ['m1', 'm2']);
	assert.deepEqual(ack(report), {
		batchItemFailures: [{ itemIdentifier: 'm1' }, { itemIdentifier: 'm2' }],
	});
});

test('success answers with an empty list, which must still be sent', () => {
	// Omitting it makes the source treat the whole batch as failed and redeliver all of it.
	assert.deepEqual(ack({ trace: 't', origin: 'aws:sqs', hops: [], failed: [], dropped: 0 }), {
		batchItemFailures: [],
	});
});

test('a chain keeps its trace and grows its path', async () => {
	const queue = spy('aws_sqs_queue');
	const incoming = seal(open('payload', 'Upstream', { trace: 'T1', hops: 3, at: 'now' }));

	const report = await handle(
		arrival([{ body: incoming }]),
		[neighbor('aws_sqs_queue', '0', 'Q')],
		CTX
	);

	assert.equal(report.trace, 'T1', 'adopted the incoming trace rather than minting a new one');
	assert.deepEqual(queue[0]?.envelope.path, ['Upstream', 'Fn']);
	assert.equal(queue[0]?.envelope.hops, 2, 'one hop spent');
	assert.equal(queue[0]?.envelope.body, 'payload', 'the payload is not re-wrapped');
});

test('the chain stops at the hop limit, and the item is counted', async () => {
	const queue = spy('aws_sqs_queue');
	const exhausted = seal(open('payload', 'Upstream', { trace: 'T1', hops: 0 }));

	const report = await handle(
		arrival([{ body: exhausted }]),
		[neighbor('aws_sqs_queue', '0', 'Q')],
		CTX
	);

	assert.equal(queue.length, 0, 'nothing was forwarded');
	assert.equal(report.dropped, 1, 'and it is visible in the report, not silently swallowed');
	assert.equal(report.hops.length, 0);
});

test('a message that merely looks like JSON is a payload, not an envelope', async () => {
	const queue = spy('aws_sqs_queue');
	await handle(
		arrival([{ body: '{"trace":"not-ours","hops":9}' }]),
		[neighbor('aws_sqs_queue', '0', 'Q')],
		CTX
	);
	assert.equal(queue[0]?.envelope.body, '{"trace":"not-ours","hops":9}');
	assert.deepEqual(queue[0]?.envelope.path, ['Fn', 'Fn']);
});

test('a neighbor that cannot be sent to is skipped, not reported as a wire', async () => {
	registry.register({ type: 'aws_kinesis_stream', receive: () => null });

	const report = await handle(
		arrival([{ body: 'x' }]),
		[neighbor('aws_kinesis_stream', '0', 'S')],
		CTX
	);

	assert.equal(report.hops.length, 0);
});

test('an unparseable body round-trips as an ordinary payload', () => {
	assert.equal(read('not json'), null);
	assert.equal(read('{ broken'), null);
	assert.equal(read('{"$hub":99,"trace":"t","body":"b"}'), null, 'wrong envelope version');
});

test('normalize asks each receiver and falls back to a direct invocation', async () => {
	registry.register({
		type: 'aws_sqs_queue',
		send: async () => undefined,
		receive: (raw) =>
			(raw as { Records?: { eventSource?: string }[] })?.Records?.[0]?.eventSource === 'aws:sqs'
				? { origin: 'aws:sqs', describe: 'SQS', items: [{ body: 'claimed' }] }
				: null,
	});

	const claimed = await normalize({ Records: [{ eventSource: 'aws:sqs' }] });
	assert.equal(claimed.origin, 'aws:sqs');

	const unclaimed = await normalize({ hello: 'world' });
	assert.equal(unclaimed.origin, 'direct');
	assert.equal(unclaimed.items[0]?.body, '{"hello":"world"}');
});
