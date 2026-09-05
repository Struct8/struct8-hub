/**
 * The two parameter stores, on the wire.
 *
 * They read until 2026-09-05, because the wire's generated policy granted reading and nothing
 * else. The result was a report line for a wire that had confirmed a permission, shaped exactly
 * like the S3 line beside it that had actually delivered something — and nobody reading the report
 * could tell them apart. The catalog now grants the write, and these two send like every other
 * destination.
 *
 * What is locked here is the shape of those writes, because each carries a decision that reads as
 * arbitrary and is not:
 *
 *   * `Overwrite: true` with no `Type`. AWS wants `Type` only for a parameter that does not exist,
 *     and sending it on an overwrite is how a `SecureString` somebody chose on purpose gets
 *     refused.
 *   * `ClientRequestToken` on the secret. The SDKs mint one and the raw API does not; without it
 *     the service cannot tell two writes of the same message apart.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../dist/resources/aws_ssm_parameter/index.js';
import '../dist/resources/aws_secretsmanager_secret/index.js';
import * as registry from '../dist/core/registry.js';
import * as aws from '../dist/providers/aws.js';
import { open, read } from '../dist/core/envelope.js';
import type { Ctx, Neighbor } from '../dist/core/types.js';

aws.credentials({
	accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
	secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
});

interface Call {
	readonly target: string;
	readonly body: Record<string, unknown>;
}

/** Captures the request instead of sending it. */
function capture() {
	const seen: Call[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		const text = await request.text();
		seen.push({
			target: request.headers.get('x-amz-target') ?? '',
			body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
		});
		return new Response('{}', { status: 200 });
	};
	return { seen, fetchImpl };
}

const contextWith = (fetchImpl: typeof fetch): Ctx => ({
	self: 'Worker',
	fetch: fetchImpl,
	region: () => 'ca-central-1',
	account: () => '111122223333',
	now: () => new Date(0),
});

const ENVELOPE = open('the message', 'Worker', { trace: 'trace-1', at: '2026-09-05T00:00:00.000Z' });

const sendTo = (type: string) => {
	const send = registry.get(type)?.send;
	assert.ok(send, `${type} declares no sender`);
	return send;
};

test('the parameter is written, not read', async () => {
	const { seen, fetchImpl } = capture();
	const wired: Neighbor = { type: 'aws_ssm_parameter', label: '0', props: { NAME: 'hub-param' } };

	await sendTo('aws_ssm_parameter')(wired, ENVELOPE, contextWith(fetchImpl));

	assert.equal(seen[0]?.target, 'AmazonSSM.PutParameter');
	assert.equal(seen[0]?.body['Name'], 'hub-param');
	// One value, last write wins. A version per message would turn a test tool into a bill.
	assert.equal(seen[0]?.body['Overwrite'], true);
	// Absent on purpose: see the header.
	assert.ok(!('Type' in (seen[0]?.body ?? {})), 'Type was sent on an overwrite');
});

test('what the parameter receives is the envelope, so the chain survives it', async () => {
	const { seen, fetchImpl } = capture();
	const wired: Neighbor = { type: 'aws_ssm_parameter', label: '0', props: { NAME: 'hub-param' } };

	await sendTo('aws_ssm_parameter')(wired, ENVELOPE, contextWith(fetchImpl));

	const carried = read(String(seen[0]?.body['Value']));
	assert.equal(carried?.trace, 'trace-1');
	assert.equal(carried?.body, 'the message');
});

test('a parameter wire with no name is refused rather than composed', async () => {
	const { fetchImpl } = capture();
	const wired: Neighbor = { type: 'aws_ssm_parameter', label: '0', props: {} };

	await assert.rejects(
		() => sendTo('aws_ssm_parameter')(wired, ENVELOPE, contextWith(fetchImpl)),
		/no parameter name/
	);
});

test('the secret is written as a new current version', async () => {
	const { seen, fetchImpl } = capture();
	const wired: Neighbor = {
		type: 'aws_secretsmanager_secret',
		label: '0',
		props: { NAME: 'hub-secret' },
	};

	await sendTo('aws_secretsmanager_secret')(wired, ENVELOPE, contextWith(fetchImpl));

	assert.equal(seen[0]?.target, 'secretsmanager.PutSecretValue');
	assert.equal(seen[0]?.body['SecretId'], 'hub-secret');

	const carried = read(String(seen[0]?.body['SecretString']));
	assert.equal(carried?.trace, 'trace-1');
});

test('the secret write carries a request token, which the raw API does not mint', async () => {
	const { seen, fetchImpl } = capture();
	const wired: Neighbor = {
		type: 'aws_secretsmanager_secret',
		label: '0',
		props: { NAME: 'hub-secret' },
	};

	await sendTo('aws_secretsmanager_secret')(wired, ENVELOPE, contextWith(fetchImpl));

	const token = String(seen[0]?.body['ClientRequestToken'] ?? '');
	// AWS wants 32 to 64 characters; a UUID is 36.
	assert.ok(token.length >= 32 && token.length <= 64, `token was ${token.length} characters`);
});

test('the ARN on the wire identifies the secret when it is there', async () => {
	const { seen, fetchImpl } = capture();
	const wired: Neighbor = {
		type: 'aws_secretsmanager_secret',
		label: '0',
		props: {
			NAME: 'hub-secret',
			SECRET_ARN: 'arn:aws:secretsmanager:ca-central-1:111122223333:secret:hub-secret-AbCdEf',
		},
	};

	await sendTo('aws_secretsmanager_secret')(wired, ENVELOPE, contextWith(fetchImpl));

	assert.match(String(seen[0]?.body['SecretId']), /^arn:aws:secretsmanager:/);
});
