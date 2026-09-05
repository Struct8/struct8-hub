/**
 * The SQS consumer, on the wire.
 *
 * This is the work AWS does invisibly for a Lambda — the event source mapping *is* a poller. Doing
 * it by hand means two things nothing else in the suite would notice: that the receive long-polls
 * (at `WaitTimeSeconds: 0` an idle queue answers instantly and the loop becomes a billed spin), and
 * that the delete carries the *receipt handle* rather than the message id. Those are different
 * strings, both plausible-looking, and sending the wrong one deletes nothing while reporting
 * success — after which the message reappears and is processed again, forever.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../dist/resources/aws_sqs_queue/index.js';
import * as registry from '../dist/core/registry.js';
import * as aws from '../dist/providers/aws.js';
import type { Ctx, Neighbor } from '../dist/core/types.js';

aws.credentials({
	accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
	secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
});

const QUEUE: Neighbor = { type: 'aws_sqs_queue', label: '0', props: { NAME: 'orders' } };

interface Call {
	readonly target: string;
	readonly body: Record<string, unknown>;
}

/** Answers each call with the next prepared body, recording what was asked. */
function stub(answers: unknown[]) {
	const seen: Call[] = [];
	let next = 0;

	const fetchImpl: typeof fetch = async (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		const text = await request.text();
		seen.push({
			target: request.headers.get('x-amz-target') ?? '',
			body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
		});
		return new Response(JSON.stringify(answers[next++] ?? {}), { status: 200 });
	};

	return { seen, fetchImpl };
}

const contextWith = (fetchImpl: typeof fetch): Ctx => ({
	self: 'Worker',
	fetch: fetchImpl,
	region: () => 'us-east-1',
	account: () => '111122223333',
	now: () => new Date(0),
});

const consumeQueue = () => {
	const consume = registry.get('aws_sqs_queue')?.consume;
	assert.ok(consume, 'the queue declares no consumer');
	return consume;
};

const message = (id: string, handle: string, body: string) => ({
	MessageId: id,
	ReceiptHandle: handle,
	Body: body,
});

test('the receive long-polls and asks for a full batch', async () => {
	const { seen, fetchImpl } = stub([{ Messages: [] }]);

	await consumeQueue()(QUEUE, contextWith(fetchImpl));

	assert.equal(seen[0]?.target, 'AmazonSQS.ReceiveMessage');
	assert.equal(seen[0]?.body['QueueUrl'], 'https://sqs.us-east-1.amazonaws.com/111122223333/orders');
	// Twenty is the maximum AWS allows and the whole point: at zero this becomes a paid busy loop.
	assert.equal(seen[0]?.body['WaitTimeSeconds'], 20);
	assert.equal(seen[0]?.body['MaxNumberOfMessages'], 10);
});

test('an empty queue is an empty batch, not a failure', async () => {
	const { fetchImpl } = stub([{}]);

	const batch = await consumeQueue()(QUEUE, contextWith(fetchImpl));

	assert.deepEqual(batch.items, []);
	assert.equal(batch.origin, 'aws:sqs');
});

test('messages arrive with their id, which is what a partial-batch report needs', async () => {
	const { fetchImpl } = stub([
		{ Messages: [message('m-1', 'handle-1', 'first'), message('m-2', 'handle-2', 'second')] },
	]);

	const batch = await consumeQueue()(QUEUE, contextWith(fetchImpl));

	assert.deepEqual(
		batch.items.map((i) => ({ id: i.id, body: i.body })),
		[
			{ id: 'm-1', body: 'first' },
			{ id: 'm-2', body: 'second' },
		]
	);
	assert.match(batch.describe, /orders/);
});

test('acknowledging deletes by receipt handle, never by message id', async () => {
	const { seen, fetchImpl } = stub([{ Messages: [message('m-1', 'handle-1', 'first')] }, {}]);
	const ctx = contextWith(fetchImpl);

	const batch = await consumeQueue()(QUEUE, ctx);
	await batch.ack(batch.items);

	assert.equal(seen[1]?.target, 'AmazonSQS.DeleteMessageBatch');
	assert.deepEqual(seen[1]?.body['Entries'], [{ Id: 'm-1', ReceiptHandle: 'handle-1' }]);
});

test('only the acknowledged items are deleted', async () => {
	const { seen, fetchImpl } = stub([
		{ Messages: [message('m-1', 'handle-1', 'first'), message('m-2', 'handle-2', 'second')] },
		{},
	]);

	const batch = await consumeQueue()(QUEUE, contextWith(fetchImpl));
	await batch.ack(batch.items.filter((i) => i.id === 'm-2'));

	assert.deepEqual(seen[1]?.body['Entries'], [{ Id: 'm-2', ReceiptHandle: 'handle-2' }]);
});

test('acknowledging nothing sends no request at all', async () => {
	const { seen, fetchImpl } = stub([{ Messages: [message('m-1', 'handle-1', 'first')] }]);

	const batch = await consumeQueue()(QUEUE, contextWith(fetchImpl));
	await batch.ack([]);

	assert.equal(seen.length, 1, 'an empty delete was sent');
});

test('a message with no receipt handle is left on the queue rather than half-processed', async () => {
	// It could not be deleted afterwards, so forwarding it would guarantee a duplicate. The
	// visibility timeout brings it back, which is the recoverable outcome.
	const { fetchImpl } = stub([{ Messages: [{ MessageId: 'm-1', Body: 'orphan' }] }]);

	const batch = await consumeQueue()(QUEUE, contextWith(fetchImpl));

	assert.deepEqual(batch.items, []);
});

test('the queue URL on the wire is used as given', async () => {
	const { seen, fetchImpl } = stub([{ Messages: [] }]);
	const wired: Neighbor = {
		type: 'aws_sqs_queue',
		label: 'IN',
		props: { QUEUE_URL: 'https://sqs.eu-west-1.amazonaws.com/999988887777/other' },
	};

	await consumeQueue()(wired, contextWith(fetchImpl));

	assert.equal(seen[0]?.body['QueueUrl'], 'https://sqs.eu-west-1.amazonaws.com/999988887777/other');
});
