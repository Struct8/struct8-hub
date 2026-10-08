/**
 * Failures on request (core/faults.ts).
 *
 * What is held here is the answer to "does it fail all of them or only some": only the message
 * that asks fails, the rest of its batch is delivered, and with the switch off nothing fails at
 * all. Each source learns of the failure the way it can — a queue from the partial-batch answer,
 * an asynchronous invocation from the invocation failing, an HTTP caller from a 500.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { lambda } from '../dist/runtimes/lambda.js';
import { handle } from '../dist/core/hub.js';
import { directive } from '../dist/core/faults.js';
import { open, seal } from '../dist/core/envelope.js';
import * as registry from '../dist/core/registry.js';
import type { Ctx, Envelope, Neighbor, Report } from '../dist/core/types.js';

import '../dist/resources/aws_lambda_function_url/index.js';
import '../dist/resources/aws_sns_topic/index.js';
import '../dist/resources/aws_sqs_queue/index.js';

/** The payload of every message that reached the wired destination. */
const delivered: string[] = [];

registry.register({
	type: 'test_target',
	async send(_n: Neighbor, e: Envelope) {
		delivered.push(e.body);
	},
});

const touched: string[] = [];

afterEach(() => {
	for (const key of touched.splice(0)) delete process.env[key];
	delivered.splice(0);
});

function withEnv(vars: Record<string, string>): void {
	for (const [key, value] of Object.entries(vars)) {
		process.env[key] = value;
		touched.push(key);
	}
}

const WIRED = { TEST_TARGET_NAME_0: 'downstream' };
const ON = { ...WIRED, HUB_FAULTS: 'on' };

/** A message body as a producer would send it. */
const ask = (order: number, behavior?: string) =>
	JSON.stringify(behavior === undefined ? { order } : { order, behavior });

/** One SQS record, with the receive count the event source mapping sends. */
const record = (id: string, body: string, receives = 1) => ({
	eventSource: 'aws:sqs',
	eventSourceARN: 'arn:aws:sqs:us-east-1:111122223333:orders',
	messageId: id,
	body,
	attributes: { ApproximateReceiveCount: String(receives) },
});

const sqs = (...records: ReturnType<typeof record>[]) => ({ Records: records });

type BatchAnswer = { batchItemFailures: { itemIdentifier: string }[] };

const failedIds = (answer: unknown): string[] =>
	(answer as BatchAnswer).batchItemFailures.map((f) => f.itemIdentifier);

test('off by default: a message that asks to fail is processed like any other', async () => {
	withEnv(WIRED);

	const answer = await lambda()(sqs(record('m1', ask(1, 'fail'))));

	// Off is the default because a function that fails on request can be made to fail by anyone
	// allowed to publish to what feeds it.
	assert.deepEqual(failedIds(answer), []);
	assert.deepEqual(delivered, [ask(1, 'fail')]);
});

test('only the message that asks fails; the rest of the batch is delivered', async () => {
	withEnv(ON);

	const answer = await lambda()(
		sqs(record('m1', ask(1, 'ok')), record('m2', ask(2, 'fail')), record('m3', ask(3)))
	);

	assert.deepEqual(failedIds(answer), ['m2']);
	// Not delivered anywhere first: the queue sends it again, and a destination that already had
	// it would get it once per delivery.
	assert.deepEqual(delivered, [ask(1, 'ok'), ask(3)]);
});

test('fail-times fails until the queue has delivered it that many times', async () => {
	withEnv(ON);
	const handler = lambda();

	for (const receives of [1, 2]) {
		assert.deepEqual(failedIds(await handler(sqs(record('m1', ask(1, 'fail-times:2'), receives)))), ['m1']);
	}
	assert.deepEqual(failedIds(await handler(sqs(record('m1', ask(1, 'fail-times:2'), 3)))), []);
	assert.deepEqual(delivered, [ask(1, 'fail-times:2')]);
});

test('the request survives a topic and the Hub envelope on the way to the queue', async () => {
	withEnv(ON);

	// What a queue subscribed to a topic receives when raw delivery is off: the SNS notification,
	// whose Message is the envelope a Hub published, whose body is what the producer was sent.
	const notification = JSON.stringify({
		Type: 'Notification',
		TopicArn: 'arn:aws:sns:us-east-1:111122223333:orders',
		Message: seal(open(ask(7, 'fail'), 'producer')),
	});

	const answer = await lambda()(sqs(record('m7', notification)));

	assert.deepEqual(failedIds(answer), ['m7']);
});

test('an SNS invocation that asks to fail fails, which is what its retries and DLQ react to', async () => {
	withEnv(ON);

	const sns = (body: string) => ({
		Records: [{ EventSource: 'aws:sns', Sns: { TopicArn: 'arn:aws:sns:us-east-1:1:orders', Message: body } }],
	});

	await assert.rejects(lambda()(sns(seal(open(ask(1, 'fail'), 'producer')))), {
		name: 'RequestedFailure',
		message: /fail/,
	});
	assert.deepEqual(delivered, []);

	// The same topic, a message that asks for nothing: the invocation succeeds.
	const report = (await lambda()(sns(seal(open(ask(2), 'producer'))))) as Report;
	assert.equal(report.origin, 'aws:sns');
	assert.equal(report.faults, undefined);
});

test("a schedule's input that asks to fail fails the invocation", async () => {
	withEnv(ON);

	// EventBridge Scheduler invokes the function with its `input` as the whole event.
	await assert.rejects(lambda()({ behavior: 'fail' }), { name: 'RequestedFailure' });
});

test('a function URL request that asks to fail answers 500, and the report says why', async () => {
	withEnv(ON);

	const response = (await lambda()({
		body: ask(1, 'fail'),
		isBase64Encoded: false,
		requestContext: { domainName: 'xyz.lambda-url.us-east-1.on.aws', http: { method: 'POST', path: '/' } },
	})) as { statusCode: number; body: string };

	assert.equal(response.statusCode, 500);
	assert.deepEqual((JSON.parse(response.body) as Report).faults, [{ behavior: 'fail' }]);
});

test('slow waits out the invocation, and the item is processed if it is still alive', async () => {
	let stalled = 0;
	const ctx: Ctx = {
		self: 'Fn',
		fetch: globalThis.fetch,
		region: () => 'us-east-1',
		account: () => '111122223333',
		now: () => new Date(0),
	};

	const report = await handle(
		{ origin: 'aws:sqs', describe: 'test', items: [{ id: 'm1', body: ask(1, 'slow'), attempt: 1 }] },
		[{ type: 'test_target', label: '0', props: { NAME: 'downstream' } }],
		ctx,
		{ faults: { stall: async () => void (stalled += 1) } }
	);

	// On Lambda the stall never returns: the timeout ends the invocation and the whole batch comes
	// back. Here it returns, and a slow message is a processed one.
	assert.equal(stalled, 1);
	assert.deepEqual(report.failed, []);
	assert.equal(report.faults, undefined);
	assert.deepEqual(delivered, [ask(1, 'slow')]);
});

test('the report records which delivery failed', async () => {
	withEnv(ON);
	const logged: string[] = [];
	const log = console.log;
	console.log = (line: string) => void logged.push(line);
	try {
		await lambda()(sqs(record('m1', ask(1, 'fail-times:3'), 2)));
	} finally {
		console.log = log;
	}

	const report = (JSON.parse(logged[0] ?? '{}') as { hub: Report }).hub;
	assert.deepEqual(report.faults, [{ item: 'm1', behavior: 'fail-times:3', attempt: 2 }]);
});

test('only a behavior field in JSON is a request', () => {
	assert.deepEqual(directive(ask(1, 'FAIL')), { kind: 'fail' });
	assert.deepEqual(directive(ask(1, 'fail-times:2')), { kind: 'fail-times', times: 2 });
	assert.deepEqual(directive(JSON.stringify({ detail: { behavior: 'slow' } })), { kind: 'slow' });

	// A word in a text payload is not a request, and neither is a value this module does not know.
	assert.equal(directive('fail'), null);
	assert.equal(directive(ask(1, 'explode')), null);
	assert.equal(directive(ask(1, 'fail-times:x')), null);
	assert.equal(directive('{not json'), null);
});
