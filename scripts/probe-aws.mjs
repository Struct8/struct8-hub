/**
 * The test the offline suite cannot run.
 *
 * `npm test` proves the logic against a fake transport, and a fake transport answers 200 to
 * anything. It cannot tell you whether AWS accepts the signature, whether the endpoint exists, or
 * whether the service speaks the dialect we send. Those are exactly the mistakes that pass every
 * unit test and fail on the first real invocation.
 *
 * Every call here is read-only — list and describe, nothing that writes. Run it against any
 * account:
 *
 *     node scripts/probe-aws.mjs <profile> [region]
 *
 * A 200 means accepted. AccessDenied also means accepted: authenticated but not authorised is a
 * permission answer, not a protocol answer, and this script is only asking about the protocol.
 */

import { execFileSync } from 'node:child_process';
import { AwsClient } from 'aws4fetch';

const PROFILE = process.argv[2] ?? 'default';
const REGION = process.argv[3] ?? 'us-east-1';

const cred = (key) =>
	execFileSync('aws', ['configure', 'get', key, '--profile', PROFILE], { encoding: 'utf8' }).trim();

const client = new AwsClient({
	accessKeyId: cred('aws_access_key_id'),
	secretAccessKey: cred('aws_secret_access_key'),
});

/** The one answer that means the signing itself is wrong, as opposed to the request. */
const SIGNING_BROKEN = /InvalidSignature|SignatureDoesNotMatch|UnrecognizedClient|InvalidClientTokenId|MissingAuthentication/i;
const NOT_AUTHORISED = /AccessDenied|not authorized|UnauthorizedOperation/i;

const dialects = { dynamodb: '1.0', sqs: '1.0', kinesis: '1.1', firehose: '1.1', logs: '1.1', ssm: '1.1', secretsmanager: '1.1', events: '1.1' };

const rpc = (service, target, body) => ({
	service,
	url: `https://${service}.${REGION}.amazonaws.com/`,
	init: {
		method: 'POST',
		headers: { 'content-type': `application/x-amz-json-${dialects[service]}`, 'x-amz-target': target },
		body: JSON.stringify(body),
	},
});

const PROBES = {
	'sqs (json 1.0)': rpc('sqs', 'AmazonSQS.ListQueues', { MaxResults: 1 }),
	'dynamodb (json 1.0)': rpc('dynamodb', 'DynamoDB_20120810.ListTables', { Limit: 1 }),
	'kinesis (json 1.1)': rpc('kinesis', 'Kinesis_20131202.ListStreams', { Limit: 1 }),
	'firehose (json 1.1)': rpc('firehose', 'Firehose_20150804.ListDeliveryStreams', { Limit: 1 }),
	'logs (json 1.1)': rpc('logs', 'Logs_20140328.DescribeLogGroups', { limit: 1 }),
	'ssm (json 1.1)': rpc('ssm', 'AmazonSSM.DescribeParameters', { MaxResults: 1 }),
	'secretsmanager (json 1.1)': rpc('secretsmanager', 'secretsmanager.ListSecrets', { MaxResults: 1 }),
	'events (json 1.1)': rpc('events', 'AWSEvents.ListEventBuses', { Limit: 1 }),

	'sns (query)': {
		service: 'sns',
		url: `https://sns.${REGION}.amazonaws.com/`,
		init: {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ Action: 'ListTopics', Version: '2010-03-31' }).toString(),
		},
	},

	's3 (rest)': { service: 's3', url: `https://s3.${REGION}.amazonaws.com/`, init: { method: 'GET' } },

	'lambda (rest)': {
		service: 'lambda',
		url: `https://lambda.${REGION}.amazonaws.com/2015-03-31/functions?MaxItems=1`,
		init: { method: 'GET' },
	},

	'kinesisvideo (rest)': {
		service: 'kinesisvideo',
		url: `https://kinesisvideo.${REGION}.amazonaws.com/listStreams`,
		init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ MaxResults: 1 }) },
	},
};

console.log(`profile ${PROFILE}, region ${REGION}\n`);

let broken = 0;

for (const [name, probe] of Object.entries(PROBES)) {
	const signed = await client.sign(probe.url, { ...probe.init, aws: { service: probe.service, region: REGION } });
	const res = await fetch(signed);
	const body = res.ok ? '' : await res.text().catch(() => '');

	let verdict;
	if (res.ok) verdict = 'ok';
	else if (SIGNING_BROKEN.test(body)) { verdict = 'SIGNING REJECTED'; broken += 1; }
	else if (NOT_AUTHORISED.test(body)) verdict = 'ok (signed; no permission)';
	else { verdict = `UNEXPECTED ${res.status}`; broken += 1; }

	console.log(`  ${name.padEnd(28)} ${String(res.status).padEnd(4)} ${verdict}`);
	if (verdict.startsWith('UNEXPECTED')) console.log(`      ${body.slice(0, 200).replace(/\s+/g, ' ')}`);
}

console.log(broken === 0 ? '\nall protocols accepted' : `\n${broken} probe(s) failed`);
process.exit(broken === 0 ? 0 : 1);
