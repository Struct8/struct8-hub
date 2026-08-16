import { test } from 'node:test';
import assert from 'node:assert/strict';

import { discover, parseName, type Vocabulary } from '../dist/core/discovery.js';

const VOCAB: Vocabulary = {
	types: [
		'aws_sqs_queue',
		'aws_s3_bucket',
		'aws_lambda_function',
		'aws_lambda_function_url',
		'aws_db_instance',
	],
	keys: ['NAME', 'ARN', 'URL', 'REGION', 'ACCOUNT', 'HANDLE', 'QUEUE_URL', 'USER_NAME', 'ENDPOINT'],
};

test('splits a name into type, key and label', () => {
	assert.deepEqual(parseName('AWS_SQS_QUEUE_NAME_0', VOCAB), {
		type: 'aws_sqs_queue',
		key: 'NAME',
		label: '0',
	});
});

test('prefers the longest type — the case no pattern can decide', () => {
	// AWS_LAMBDA_FUNCTION + URL_NAME_0 and AWS_LAMBDA_FUNCTION_URL + NAME_0 are both valid
	// splits. Only the second is right, and only a vocabulary can tell.
	assert.deepEqual(parseName('AWS_LAMBDA_FUNCTION_URL_NAME_0', VOCAB), {
		type: 'aws_lambda_function_url',
		key: 'NAME',
		label: '0',
	});
});

test('prefers the longest key', () => {
	assert.deepEqual(parseName('AWS_DB_INSTANCE_USER_NAME_DB', VOCAB), {
		type: 'aws_db_instance',
		key: 'USER_NAME',
		label: 'DB',
	});
});

test('rejects a name with no label — the function must not discover itself', () => {
	// AWS_LAMBDA_FUNCTION_NAME is set by the AWS runtime for every Lambda. It parses as type
	// AWS_LAMBDA_FUNCTION, key NAME, empty label. Without the guard, every function would appear
	// in its own neighbor list and forward to itself.
	assert.equal(parseName('AWS_LAMBDA_FUNCTION_NAME', VOCAB), null);
	assert.deepEqual(discover({ AWS_LAMBDA_FUNCTION_NAME: 'my-function' }, VOCAB), []);
});

test('ignores names that are not part of the contract', () => {
	for (const name of ['AWS_REGION', 'PATH', 'AWS_LAMBDA_FUNCTION_MEMORY_SIZE', 'NODE_ENV', '']) {
		assert.equal(parseName(name, VOCAB), null, name);
	}
});

test('rejects the retired format with the direction segment', () => {
	// CONTRACT.md §8.2. TARGET is not a key, so the name simply does not parse.
	assert.equal(parseName('AWS_S3_BUCKET_TARGET_NAME_0', VOCAB), null);
});

test('merges every variable describing the same target', () => {
	const found = discover(
		{
			AWS_SQS_QUEUE_NAME_ORDERS: 'OrdersQueue',
			AWS_SQS_QUEUE_REGION_ORDERS: 'eu-west-1',
			AWS_SQS_QUEUE_QUEUE_URL_ORDERS: 'https://sqs.eu-west-1.amazonaws.com/1/OrdersQueue',
		},
		VOCAB
	);

	assert.equal(found.length, 1);
	assert.equal(found[0]?.type, 'aws_sqs_queue');
	assert.equal(found[0]?.label, 'ORDERS');
	assert.deepEqual(found[0]?.props, {
		NAME: 'OrdersQueue',
		REGION: 'eu-west-1',
		QUEUE_URL: 'https://sqs.eu-west-1.amazonaws.com/1/OrdersQueue',
	});
});

test('two wires to the same target stay two neighbors', () => {
	// The diagram drew two wires, so two things are meant to happen.
	const found = discover(
		{ AWS_S3_BUCKET_NAME_RAW: 'bucket', AWS_S3_BUCKET_NAME_ARCHIVE: 'bucket' },
		VOCAB
	);

	assert.equal(found.length, 2);
	assert.deepEqual(
		found.map((n) => n.label),
		['ARCHIVE', 'RAW']
	);
});

test('a non-string value lands in handle, not in props', () => {
	// How a Cloudflare binding is read by the same function. CONTRACT.md §4.
	const binding = { send: () => undefined };
	const found = discover(
		{ AWS_SQS_QUEUE_HANDLE_0: binding, AWS_SQS_QUEUE_NAME_0: 'OrdersQueue' },
		VOCAB
	);

	assert.equal(found.length, 1);
	assert.equal(found[0]?.handle, binding);
	assert.deepEqual(found[0]?.props, { NAME: 'OrdersQueue' });
});

test('order does not depend on the order of the source object', () => {
	const a = discover({ AWS_S3_BUCKET_NAME_B: 'x', AWS_SQS_QUEUE_NAME_A: 'y' }, VOCAB);
	const b = discover({ AWS_SQS_QUEUE_NAME_A: 'y', AWS_S3_BUCKET_NAME_B: 'x' }, VOCAB);
	assert.deepEqual(a, b);
});

test('survives a source that is not an object', () => {
	for (const source of [null, undefined, 'string', 42]) {
		assert.deepEqual(discover(source, VOCAB), []);
	}
});
