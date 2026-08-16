import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import * as registry from '../dist/core/registry.js';

beforeEach(() => registry.reset());

const noop = async (): Promise<void> => undefined;

test('refuses a resource that can be discovered but never reached', () => {
	// The failure this design exists to remove: the variable parses, a neighbor appears in the
	// list, and nothing ever happens to it. Silent, and indistinguishable from working.
	assert.throws(
		() => registry.register({ type: 'aws_thing' }),
		/neither send nor receive/
	);
});

test('refuses a type that is not a catalog type', () => {
	for (const type of ['AWS_SQS_QUEUE', '', 'aws-sqs-queue', '9lives']) {
		assert.throws(() => registry.register({ type, send: noop }), /invalid resource type/, type);
	}
});

test('refuses a second registration of the same type', () => {
	registry.register({ type: 'aws_sqs_queue', send: noop });
	assert.throws(() => registry.register({ type: 'aws_sqs_queue', send: noop }), /already registered/);
});

test('registering the very same module twice is not an error', () => {
	// Two import paths reaching the same module object must not blow up at load.
	const mod = { type: 'aws_sqs_queue', send: noop };
	registry.register(mod);
	registry.register(mod);
	assert.equal(registry.all().length, 1);
});

test('the vocabulary is derived from what is registered', () => {
	registry.register({ type: 'aws_sqs_queue', keys: ['QUEUE_URL'], send: noop });
	registry.register({ type: 'aws_s3_bucket', send: noop });

	const vocab = registry.vocabulary();
	assert.deepEqual([...vocab.types].sort(), ['aws_s3_bucket', 'aws_sqs_queue']);
	assert.ok(vocab.keys.includes('QUEUE_URL'), 'declared key');
	assert.ok(vocab.keys.includes('NAME'), 'common key');
	assert.ok(vocab.keys.includes('HANDLE'), 'reserved key');
});

test('receivers lists only what can normalize an event', () => {
	registry.register({ type: 'aws_sqs_queue', send: noop, receive: () => null });
	registry.register({ type: 'aws_s3_bucket', send: noop });

	assert.deepEqual(
		registry.receivers().map((m) => m.type),
		['aws_sqs_queue']
	);
});
