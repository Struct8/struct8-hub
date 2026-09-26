/**
 * The AWS transport.
 *
 * These assertions exist because the mistakes they catch are invisible to every other test: a
 * fake transport answers 200 whatever the request said, so a wrong content type, a wrong endpoint
 * or a wrong encoding sails through the suite and fails on the first real invocation.
 *
 * `scripts/probe-aws.mjs` is the other half — it asks a live account the questions that cannot be
 * asked offline. What is locked down here is what that script measured.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as aws from '../dist/providers/aws.js';

aws.credentials({ accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' });

/**
 * Captures the outgoing request instead of sending it.
 *
 * Normalized to a `Request` because the two paths call `fetch` differently: a signed call hands
 * over a ready `Request`, an unsigned one hands over a URL and an init. Both are legitimate uses
 * of `fetch`, and a capture that only understands one of them tests only half the transport.
 */
function capture() {
	const seen: Request[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		seen.push(input instanceof Request ? input : new Request(input, init));
		return new Response('{}', { status: 200 });
	};
	return { seen, fetchImpl };
}

/**
 * Measured against the live APIs, and mutually exclusive: the wrong one is a bare 404 that says
 * nothing about content types, so it reads as a broken endpoint and sends you looking in entirely
 * the wrong place. This was wrong for five of the seven until a live probe said so.
 */
const DIALECT: Record<string, string> = {
	sqs: '1.0',
	dynamodb: '1.0',
	kinesis: '1.1',
	firehose: '1.1',
	logs: '1.1',
	ssm: '1.1',
	secretsmanager: '1.1',
	events: '1.1',
};

for (const [service, dialect] of Object.entries(DIALECT)) {
	test(`${service} is addressed with JSON ${dialect}`, async () => {
		const { seen, fetchImpl } = capture();
		await aws.json(service, 'us-east-1', `Test.Action`, {}, fetchImpl);

		assert.equal(seen[0]?.headers.get('content-type'), `application/x-amz-json-${dialect}`);
		assert.equal(seen[0]?.headers.get('x-amz-target'), 'Test.Action');
		assert.equal(new URL(seen[0]!.url).host, `${service}.us-east-1.amazonaws.com`);
	});
}

test('an unlisted service is refused rather than guessed', async () => {
	// Guessing produces a 404 in production and a green suite, because the fake transport does not
	// care what the content type said.
	const { fetchImpl } = capture();
	await assert.rejects(
		() => aws.json('somethingnew', 'us-east-1', 'X.Y', {}, fetchImpl),
		/unknown JSON dialect/
	);
});

test('requests are signed', async () => {
	const { seen, fetchImpl } = capture();
	await aws.json('sqs', 'us-east-1', 'AmazonSQS.ListQueues', {}, fetchImpl);

	const auth = seen[0]?.headers.get('authorization') ?? '';
	assert.match(auth, /^AWS4-HMAC-SHA256 /);
	assert.match(auth, /Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-east-1\/sqs\/aws4_request/);
	assert.ok(seen[0]?.headers.get('x-amz-date'), 'no signing date');
});

test('an unsigned request carries no authorization', async () => {
	// Behind a load balancer sits somebody's application, which never asked to be signed at.
	const { seen, fetchImpl } = capture();
	await aws.plain('https://example.invalid/', { method: 'POST', body: 'x' }, 'POST', fetchImpl);
	assert.equal(seen[0]?.headers.get('authorization'), null);
});

test('a service refusal becomes a readable reason', async () => {
	const denied: typeof fetch = async () =>
		new Response('{"__type":"com.amazon.coral.service#AccessDeniedException","message":"user is not authorized"}', { status: 403 });

	await assert.rejects(
		() => aws.json('sqs', 'us-east-1', 'AmazonSQS.SendMessage', {}, denied),
		/AccessDeniedException: user is not authorized/
	);
});

test('an XML refusal becomes a readable reason too', async () => {
	const denied: typeof fetch = async () =>
		new Response('<Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message></Error>', { status: 404 });

	await assert.rejects(
		() => aws.rest('https://b.s3.us-east-1.amazonaws.com/k', 's3', 'us-east-1', { method: 'PUT' }, 's3:PutObject', denied),
		/NoSuchBucket: The specified bucket does not exist/
	);
});

test('base64 survives text that is not ASCII', async () => {
	// btoa throws on anything above U+00FF, so encoding the string directly would fail for an
	// accented message and succeed for a plain one — a bug that only some users ever see.
	for (const text of ['plain', 'ação', 'ünïcödé', '日本語', 'emoji 🚀', '']) {
		assert.equal(aws.unb64(aws.b64(text)), text);
	}
});
