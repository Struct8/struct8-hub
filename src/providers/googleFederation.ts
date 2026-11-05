/**
 * Google credentials for a workload that runs on AWS: workload identity federation.
 *
 * A Lambda function has no Google metadata server and no Google key. What it has is its own AWS
 * role, and Google accepts proof of that role in exchange for a token: the workload signs an STS
 * GetCallerIdentity request and hands Google the signature, Google sends it to AWS, and AWS answers
 * with the role that signed. No key is stored anywhere. Google's guide:
 * https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-other-clouds
 *
 * THE CONFIGURATION is two variables: `GOOGLE_WORKLOAD_PROVIDER`, the full name of the provider that
 * checks the role, and `GOOGLE_SERVICE_ACCOUNT`, the e-mail of the account the role acts as. The
 * endpoints are fixed here. Google warns that a credential configuration read from outside holds URLs
 * a workload must validate, so this one reads none: what it signs goes to Google and nowhere else.
 *
 * THE EXCHANGE, in three requests:
 *   1. Google STS takes the signed GetCallerIdentity and returns a federated token;
 *   2. IAM Credentials takes the federated token and returns the access token of the service account
 *      the Google state created for this workload: that account holds the grants of the diagram's
 *      connections. Cloud Run and functions refuse a federated identity, so the account is the one
 *      way in, and the same account serves every other destination;
 *   3. for a Cloud Run service or a function, IAM Credentials returns an identity token of the same
 *      account, for the URL being called.
 */

import * as aws from './aws.js';

/** The full name of the provider, `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`. */
export const PROVIDER_VARIABLE = 'GOOGLE_WORKLOAD_PROVIDER';

/** The e-mail of the service account the workload acts as. */
export const ACCOUNT_VARIABLE = 'GOOGLE_SERVICE_ACCOUNT';

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const AWS_SUBJECT = 'urn:ietf:params:aws:token-type:aws4_request';
const TOKEN_URL = 'https://sts.googleapis.com/v1/token';
const CREDENTIALS_URL = 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts';
const VERIFICATION_URL = 'https://sts.{region}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15';

/** Renewed this long before Google says a token expires, as in providers/google.ts. */
const EARLY_MS = 60_000;

/** Identity tokens last an hour; IAM Credentials does not say so in the answer. */
const IDENTITY_TTL_MS = 55 * 60_000;

interface Cached {
	readonly value: string;
	readonly until: number;
}

let federated: Cached | undefined;
let access: Cached | undefined;
const identities = new Map<string, Cached>();

function env(): Record<string, string | undefined> {
	return typeof process === 'undefined' ? {} : (process.env as Record<string, string | undefined>);
}

/** True when this workload reaches Google through federation: the compile named the provider. */
export function configured(): boolean {
	return Boolean(env()[PROVIDER_VARIABLE]);
}

/** Test seam. Never call this from library or application code. */
export function resetFederation(): void {
	federated = undefined;
	access = undefined;
	identities.clear();
}

function regionOf(): string {
	const region = env()['AWS_REGION'] ?? env()['AWS_DEFAULT_REGION'];
	if (!region) throw new Error('no AWS Region in the environment to sign the Google exchange for');
	return region;
}

/** The audience of the exchange: the provider, as Google names it there. */
function audienceOf(): string {
	const provider = env()[PROVIDER_VARIABLE];
	if (!provider) throw new Error(`no Google credentials: ${PROVIDER_VARIABLE} is not set`);
	return `//iam.googleapis.com/${provider}`;
}

/** The address of a method of the service account, in IAM Credentials. */
function accountMethod(method: 'generateAccessToken' | 'generateIdToken'): string {
	const account = env()[ACCOUNT_VARIABLE];
	if (!account) throw new Error(`no Google credentials: ${ACCOUNT_VARIABLE} is not set`);
	return `${CREDENTIALS_URL}/${account}:${method}`;
}

/**
 * The signed GetCallerIdentity, as Google takes it: JSON with the URL, the method and every header
 * the signature covers, URL-encoded. `x-goog-cloud-target-resource` names the provider, so a
 * signature made for this provider cannot be replayed against another.
 */
export async function subjectToken(audience: string, region: string): Promise<string> {
	const url = VERIFICATION_URL.replace('{region}', region);
	const request = await aws.signed(url, 'sts', region, {
		method: 'POST',
		headers: { 'x-goog-cloud-target-resource': audience },
	});
	const headers: { key: string; value: string }[] = [{ key: 'host', value: new URL(url).host }];
	request.headers.forEach((value, key) => headers.push({ key, value }));
	return encodeURIComponent(JSON.stringify({ url, method: 'POST', headers }));
}

async function failed(res: Response, what: string): Promise<never> {
	const body = await res.text().catch(() => '');
	let reason = '';
	try {
		const json = JSON.parse(body) as { error?: unknown; error_description?: unknown };
		const error = json.error;
		if (typeof error === 'string') {
			reason = typeof json.error_description === 'string' ? `${error}: ${json.error_description}` : error;
		} else if (error && typeof error === 'object') {
			const e = error as { status?: unknown; message?: unknown };
			reason = `${typeof e.status === 'string' ? e.status : `HTTP ${res.status}`}: ${typeof e.message === 'string' ? e.message : what}`;
		}
	} catch {
		// Not JSON: the status is all there is.
	}
	throw new Error(reason ? `${reason} (${what})` : `HTTP ${res.status} on ${what}`);
}

/** Step 1: the federated token, from Google STS. */
async function federatedToken(fetchImpl: typeof fetch): Promise<string> {
	if (federated && federated.until > Date.now()) return federated.value;
	const audience = audienceOf();
	const res = await fetchImpl(TOKEN_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
			audience,
			scope: SCOPE,
			requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
			subject_token: await subjectToken(audience, regionOf()),
			subject_token_type: AWS_SUBJECT,
		}),
	});
	if (!res.ok) await failed(res, 'the token exchange with Google STS');
	const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown };
	if (typeof body.access_token !== 'string' || !body.access_token) {
		throw new Error('Google STS answered without a token');
	}
	const seconds = typeof body.expires_in === 'number' ? body.expires_in : 300;
	federated = { value: body.access_token, until: Date.now() + seconds * 1000 - EARLY_MS };
	return federated.value;
}

/** Step 2: the access token of the service account. */
export async function accessToken(fetchImpl: typeof fetch = fetch): Promise<string> {
	if (access && access.until > Date.now()) return access.value;
	const url = accountMethod('generateAccessToken');
	const token = await federatedToken(fetchImpl);

	const res = await fetchImpl(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
		body: JSON.stringify({ scope: [SCOPE], lifetime: '3600s' }),
	});
	if (!res.ok) await failed(res, 'the access token of the service account');
	const body = (await res.json().catch(() => ({}))) as { accessToken?: unknown; expireTime?: unknown };
	if (typeof body.accessToken !== 'string' || !body.accessToken) {
		throw new Error('IAM Credentials answered without an access token');
	}
	const expires = typeof body.expireTime === 'string' ? Date.parse(body.expireTime) : NaN;
	access = { value: body.accessToken, until: (Number.isFinite(expires) ? expires : Date.now() + 300_000) - EARLY_MS };
	return access.value;
}

/** Step 3: an identity token of the service account, for one audience. */
export async function identityToken(audience: string, fetchImpl: typeof fetch = fetch): Promise<string> {
	const cached = identities.get(audience);
	if (cached && cached.until > Date.now()) return cached.value;
	const url = accountMethod('generateIdToken');
	const token = await federatedToken(fetchImpl);
	const res = await fetchImpl(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
		body: JSON.stringify({ audience, includeEmail: true }),
	});
	if (!res.ok) await failed(res, `an identity token for ${audience}`);
	const body = (await res.json().catch(() => ({}))) as { token?: unknown };
	if (typeof body.token !== 'string' || !body.token) {
		throw new Error(`IAM Credentials answered without an identity token for ${audience}`);
	}
	identities.set(audience, { value: body.token, until: Date.now() + IDENTITY_TTL_MS });
	return body.token;
}
