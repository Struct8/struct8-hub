/**
 * The Lambda runtime's answer.
 *
 * How the message arrives is covered by each resource's own receive; what is locked down here is
 * the other half — the shape that goes back — because every way of getting it wrong fails on the
 * platform's side of the boundary, where the function's own log looks healthy.
 *
 * The case that brought this file into existence: behind an API Gateway REST proxy integration the
 * handler returned the report unwrapped, the gateway could not find `statusCode`, and every
 * request answered `502 Internal server error` while the invocation succeeded and printed a
 * perfectly good report.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { lambda } from '../dist/runtimes/lambda.js';
import * as registry from '../dist/core/registry.js';
import type { Envelope, Neighbor, Report } from '../dist/core/types.js';

// Side-effect registration of the receivers under test. Deliberately not reset between tests: the
// modules self-register on import, and an ESM import runs once, so a reset would leave the rest of
// the file testing an empty registry.
import '../dist/resources/aws_api_gateway_rest_api/index.js';
import '../dist/resources/aws_lambda_function_url/index.js';
import '../dist/resources/aws_sqs_queue/index.js';

const delivered: Neighbor[] = [];

registry.register({
	type: 'test_target',
	async send(n: Neighbor, _e: Envelope) {
		delivered.push(n);
	},
});

registry.register({
	type: 'test_broken',
	async send() {
		throw new Error('the destination refused');
	},
});

const touched: string[] = [];

afterEach(() => {
	for (const key of touched.splice(0)) delete process.env[key];
	delivered.splice(0);
});

/** Sets environment variables for one test; the shared afterEach removes them again. */
function withEnv(vars: Record<string, string>): void {
	for (const [key, value] of Object.entries(vars)) {
		process.env[key] = value;
		touched.push(key);
	}
}

interface ProxyResponse {
	readonly statusCode: number;
	readonly headers: Record<string, string>;
	readonly body: string;
}

/** An API Gateway REST proxy event, reduced to the fields the receiver reads. */
const restEvent = (body = 'hello') => ({
	httpMethod: 'POST',
	path: '/demo-handler',
	body,
	isBase64Encoded: false,
	requestContext: { apiId: 'abc123', stage: 'prod' },
});

/** A function URL event. The domain is what separates it from an HTTP API event. */
const functionUrlEvent = (body = 'hello') => ({
	body,
	isBase64Encoded: false,
	requestContext: {
		domainName: 'xyz.lambda-url.us-east-1.on.aws',
		http: { method: 'POST', path: '/' },
	},
});

test('an API Gateway arrival comes back as a proxy response', async () => {
	withEnv({ TEST_TARGET_NAME_0: 'downstream' });

	const response = (await lambda()(restEvent())) as ProxyResponse;

	// The three fields a proxy integration requires. Missing `statusCode` is the whole bug.
	assert.equal(response.statusCode, 200);
	assert.equal(response.headers['content-type'], 'application/json');
	assert.equal(typeof response.body, 'string');

	const report = JSON.parse(response.body) as Report;
	assert.equal(report.origin, 'aws:apigateway');
	assert.equal(report.hops.length, 1);
	assert.equal(report.hops[0]?.ok, true);
	assert.equal(delivered.length, 1);
});

test('a failed wire is still 200, and the reason travels in the body', async () => {
	withEnv({ TEST_BROKEN_NAME_0: 'downstream' });

	const response = (await lambda()(restEvent())) as ProxyResponse;

	// 200 on purpose. A 502 is what the gateway itself returns when the integration is wrong, so
	// reusing it for a reported wire failure would make a working Hub with one bad destination
	// read as a broken deployment.
	assert.equal(response.statusCode, 200);

	const report = JSON.parse(response.body) as Report;
	assert.equal(report.hops.length, 1);
	assert.equal(report.hops[0]?.ok, false);
	assert.match(report.hops[0]?.err ?? '', /the destination refused/);

	// The trap this test exists to hold shut: `failed` is empty even though the wire failed,
	// because the list only takes items that carry an id and an HTTP arrival carries none. Any
	// status derived from it would answer 200 always and look like it was working.
	assert.deepEqual(report.failed, []);
});

test('a function URL arrival comes back as a proxy response', async () => {
	withEnv({ TEST_TARGET_NAME_0: 'downstream' });

	const response = (await lambda()(functionUrlEvent())) as ProxyResponse;

	assert.equal(response.statusCode, 200);
	assert.equal((JSON.parse(response.body) as Report).origin, 'aws:lambda_url');
});

test('a direct invocation still gets the report unwrapped', async () => {
	withEnv({ TEST_TARGET_NAME_0: 'downstream' });

	const report = (await lambda()({ hello: 'world' })) as Report;

	// No envelope here. A caller reading `Payload` off an Invoke parses the report itself, and
	// wrapping it would make every direct caller unwrap a `body` string that is not an HTTP body.
	assert.equal((report as unknown as ProxyResponse).statusCode, undefined);
	assert.equal(report.origin, 'direct');
	assert.equal(report.hops.length, 1);
});

test('a batched arrival still gets batchItemFailures', async () => {
	withEnv({ TEST_BROKEN_NAME_0: 'downstream' });

	const event = {
		Records: [
			{
				eventSource: 'aws:sqs',
				eventSourceARN: 'arn:aws:sqs:us-east-1:1:OrdersQueue',
				messageId: 'm-1',
				body: 'hello',
			},
		],
	};

	const answer = (await lambda()(event)) as { batchItemFailures: { itemIdentifier: string }[] };

	// Unchanged by the proxy envelope, and checked here because the branch that chooses between
	// the two answers was rewritten. An SQS arrival that came back with `statusCode` would make
	// the source redeliver the whole batch forever.
	assert.deepEqual(answer.batchItemFailures, [{ itemIdentifier: 'm-1' }]);
});
