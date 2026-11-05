/**
 * A workload on AWS reaching Google through workload identity federation: the signed
 * GetCallerIdentity handed to Google STS, the service account's tokens, and a Pub/Sub publish from a
 * Lambda carrying them. Nothing here reaches the network.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import '../dist/resources/index.js';
import * as registry from '../dist/core/registry.js';
import { open } from '../dist/core/envelope.js';
import * as aws from '../dist/providers/aws.js';
import * as google from '../dist/providers/google.js';
import { subjectToken } from '../dist/providers/googleFederation.js';
import type { Ctx, Neighbor } from '../dist/core/types.js';

const PROVIDER = 'projects/123456789/locations/global/workloadIdentityPools/hub-pool/providers/aws';
const AUDIENCE = `//iam.googleapis.com/${PROVIDER}`;
const ACCOUNT = 'hub-reader@my-project.iam.gserviceaccount.com';
const IMPERSONATE = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${ACCOUNT}:generateAccessToken`;

const ENV = {
	AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
	AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
	AWS_SESSION_TOKEN: 'session-token',
	AWS_REGION: 'us-east-1',
	GOOGLE_WORKLOAD_PROVIDER: PROVIDER,
	GOOGLE_SERVICE_ACCOUNT: ACCOUNT,
};

const before = { ...process.env };
function withEnv(vars: Record<string, string>): void {
	Object.assign(process.env, vars);
	aws.resetCredentials();
	google.resetCredentials();
}
afterEach(() => {
	for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
	Object.assign(process.env, before);
	aws.resetCredentials();
	google.resetCredentials();
});

interface Seen {
	readonly url: string;
	readonly headers: Headers;
	readonly body: string;
}

/** A fake Google: STS, IAM Credentials and Pub/Sub. */
function fake() {
	const seen: Seen[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		const s: Seen = { url: request.url, headers: request.headers, body: await request.text() };
		seen.push(s);
		const url = new URL(s.url);
		if (url.hostname === 'sts.googleapis.com') return Response.json({ access_token: 'federated', expires_in: 3600 });
		if (url.pathname.endsWith(':generateAccessToken')) {
			return Response.json({ accessToken: 'ya29.account', expireTime: new Date(Date.now() + 3600_000).toISOString() });
		}
		if (url.pathname.endsWith(':generateIdToken')) return Response.json({ token: 'id.account' });
		if (url.hostname === 'pubsub.googleapis.com') return Response.json({ messageIds: ['1'] });
		return new Response('not found', { status: 404 });
	};
	return { seen, fetchImpl };
}

test('the access token is the service account\'s, through STS and IAM Credentials', async () => {
	withEnv(ENV);
	const { seen, fetchImpl } = fake();
	assert.equal(await google.accessToken(fetchImpl), 'ya29.account');

	const [sts, impersonate] = seen;
	assert.equal(sts!.url, 'https://sts.googleapis.com/v1/token');
	const exchange = JSON.parse(sts!.body) as Record<string, string>;
	assert.equal(exchange['audience'], AUDIENCE);
	assert.equal(exchange['subject_token_type'], 'urn:ietf:params:aws:token-type:aws4_request');
	assert.equal(exchange['grant_type'], 'urn:ietf:params:oauth:grant-type:token-exchange');

	assert.equal(impersonate!.url, IMPERSONATE);
	assert.equal(impersonate!.headers.get('authorization'), 'Bearer federated');

	// Cached: a second call asks nobody.
	assert.equal(await google.accessToken(fetchImpl), 'ya29.account');
	assert.equal(seen.length, 2);
});

test('the subject token is the signed GetCallerIdentity, bound to the provider', async () => {
	withEnv(ENV);
	const token = JSON.parse(decodeURIComponent(await subjectToken(AUDIENCE, 'us-east-1'))) as {
		url: string;
		method: string;
		headers: { key: string; value: string }[];
	};
	assert.equal(token.url, 'https://sts.us-east-1.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15');
	assert.equal(token.method, 'POST');
	const header = (name: string) => token.headers.find((h) => h.key.toLowerCase() === name)?.value;
	assert.equal(header('host'), 'sts.us-east-1.amazonaws.com');
	assert.equal(header('x-goog-cloud-target-resource'), AUDIENCE);
	assert.equal(header('x-amz-security-token'), 'session-token');
	assert.ok(header('x-amz-date'));
	// The signature covers the header that binds it to the provider.
	assert.match(header('authorization') ?? '', /SignedHeaders=[^,]*x-goog-cloud-target-resource/);
});

test('an identity token is generated for the URL being called', async () => {
	withEnv(ENV);
	const { seen, fetchImpl } = fake();
	assert.equal(await google.identityToken('https://us-central1-my-project.cloudfunctions.net/fn', fetchImpl), 'id.account');
	const call = seen.find((s) => s.url.endsWith(':generateIdToken'))!;
	assert.equal(call.url, IMPERSONATE.replace(':generateAccessToken', ':generateIdToken'));
	assert.deepEqual(JSON.parse(call.body), { audience: 'https://us-central1-my-project.cloudfunctions.net/fn', includeEmail: true });
});

test('the exchange asks nothing of AWS: every request goes to Google', async () => {
	withEnv(ENV);
	const { seen, fetchImpl } = fake();
	await google.accessToken(fetchImpl);
	await google.identityToken('https://us-central1-my-project.cloudfunctions.net/fn', fetchImpl);
	for (const s of seen) assert.match(new URL(s.url).hostname, /.googleapis.com$/);
});

test('a provider with no service account to act as is refused by name', async () => {
	withEnv({ ...ENV, GOOGLE_SERVICE_ACCOUNT: '' });
	const { fetchImpl } = fake();
	await assert.rejects(google.accessToken(fetchImpl), /GOOGLE_SERVICE_ACCOUNT is not set/);
});

test('Google STS refusing the exchange says why', async () => {
	withEnv(ENV);
	const fetchImpl: typeof fetch = async () => {
		return Response.json(
			{ error: 'unauthorized_client', error_description: 'The given credential is rejected by the attribute condition.' },
			{ status: 400 }
		);
	};
	await assert.rejects(google.accessToken(fetchImpl), /unauthorized_client: The given credential is rejected/);
});

test('a Lambda publishes to a Google topic with the federated token and the project on the wire', async () => {
	withEnv(ENV);
	const { seen, fetchImpl } = fake();
	const ctx: Ctx = {
		self: 'Fn',
		fetch: fetchImpl,
		region: () => 'us-east-1',
		account: (n) => n?.props['ACCOUNT'] ?? '123456789012',
		now: () => new Date('2026-10-28T12:00:00Z'),
	};
	const topic: Neighbor = { type: 'google_pubsub_topic', label: '0', props: { NAME: 'orders', ACCOUNT: 'my-project' } };
	await registry.get('google_pubsub_topic')!.send!(topic, open('payload', 'Fn', { trace: 'T', at: '2026-10-28T12:00:00.000Z' }), ctx);
	const publish = seen.find((s) => s.url.includes('pubsub.googleapis.com'))!;
	assert.equal(publish.url, 'https://pubsub.googleapis.com/v1/projects/my-project/topics/orders:publish');
	assert.equal(publish.headers.get('authorization'), 'Bearer ya29.account');
});
