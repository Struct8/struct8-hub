/**
 * Google credentials for a workload that runs on AWS: workload identity federation.
 *
 * A Lambda function has no Google metadata server and no Google key. What it has is its own AWS
 * role, and Google accepts proof of that role in exchange for a token: the workload signs an STS
 * GetCallerIdentity request and hands Google the signature, Google sends it to AWS, and AWS answers
 * with the role that signed. No key is stored anywhere. Google's guide:
 * https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-other-clouds
 *
 * THE CONFIGURATION is Google's own credential configuration file (`"type": "external_account"`),
 * the one `gcloud iam workload-identity-pools create-cred-config` writes and every Google client
 * library reads. The Google state of the diagram writes it into a parameter of Systems Manager, in
 * the workload's account and Region, and the workload gets the parameter's name as
 * `CROSS_CLOUD_PARAMETER`. The project NUMBER is in the configuration's audience, and the AWS state
 * has no way to learn it: that is why the file travels through the parameter and not through
 * variables.
 *
 * THE EXCHANGE, in three requests:
 *   1. Google STS (`token_url`) takes the signed GetCallerIdentity and returns a federated token;
 *   2. IAM Credentials (`service_account_impersonation_url`) takes the federated token and returns
 *      the access token of the service account the Google state created for this workload: that
 *      account holds the grants of the diagram's connections;
 *   3. for a Cloud Run service or a function, IAM Credentials returns an identity token of the same
 *      account, for the URL being called.
 */

import * as aws from './aws.js';

/** The variable that names the parameter holding the configuration. */
export const PARAMETER_VARIABLE = 'CROSS_CLOUD_PARAMETER';

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const AWS_SUBJECT = 'urn:ietf:params:aws:token-type:aws4_request';
const DEFAULT_VERIFICATION = 'https://sts.{region}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15';

/** Renewed this long before Google says a token expires, as in providers/google.ts. */
const EARLY_MS = 60_000;

/** Identity tokens last an hour; IAM Credentials does not say so in the answer. */
const IDENTITY_TTL_MS = 55 * 60_000;

/** The fields of Google's credential configuration file that the exchange reads. */
export interface ExternalAccount {
	readonly type: 'external_account';
	/** `//iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>` */
	readonly audience: string;
	readonly subject_token_type: string;
	readonly token_url: string;
	readonly service_account_impersonation_url?: string;
	readonly credential_source?: {
		readonly environment_id?: string;
		readonly regional_cred_verification_url?: string;
	};
}

interface Cached {
	readonly value: string;
	readonly until: number;
}

let config: Promise<ExternalAccount> | undefined;
let federated: Cached | undefined;
let access: Cached | undefined;
const identities = new Map<string, Cached>();

function env(): Record<string, string | undefined> {
	return typeof process === 'undefined' ? {} : (process.env as Record<string, string | undefined>);
}

/** True when this workload reaches Google through federation: the compile named the parameter. */
export function configured(): boolean {
	return Boolean(env()[PARAMETER_VARIABLE]);
}

/** Test seam. Never call this from library or application code. */
export function resetFederation(): void {
	config = undefined;
	federated = undefined;
	access = undefined;
	identities.clear();
}

function regionOf(): string {
	const region = env()['AWS_REGION'] ?? env()['AWS_DEFAULT_REGION'];
	if (!region) throw new Error('no AWS Region in the environment to read the Google configuration from');
	return region;
}

/** The configuration, read once per instance. A failure is not cached: the next message tries again. */
function configuration(fetchImpl: typeof fetch): Promise<ExternalAccount> {
	if (config) return config;
	const name = env()[PARAMETER_VARIABLE];
	const pending = (async (): Promise<ExternalAccount> => {
		if (!name) throw new Error(`no Google credentials: ${PARAMETER_VARIABLE} is not set`);
		const answer = (await aws.json(
			'ssm',
			regionOf(),
			'AmazonSSM.GetParameter',
			{ Name: name, WithDecryption: true },
			fetchImpl
		)) as { Parameter?: { Value?: unknown } } | null;
		const value = answer?.Parameter?.Value;
		if (typeof value !== 'string' || !value) throw new Error(`the parameter ${name} has no value`);
		let parsed: Partial<ExternalAccount>;
		try {
			parsed = JSON.parse(value) as Partial<ExternalAccount>;
		} catch {
			throw new Error(`the parameter ${name} does not hold JSON`);
		}
		if (parsed.type !== 'external_account' || !parsed.audience || !parsed.token_url) {
			throw new Error(`the parameter ${name} does not hold a Google external account configuration`);
		}
		if (parsed.subject_token_type !== AWS_SUBJECT) {
			throw new Error(`the parameter ${name} is not a configuration for AWS (subject_token_type ${String(parsed.subject_token_type)})`);
		}
		return parsed as ExternalAccount;
	})();
	config = pending;
	pending.catch(() => {
		if (config === pending) config = undefined;
	});
	return pending;
}

/**
 * The signed GetCallerIdentity, as Google takes it: JSON with the URL, the method and every header
 * the signature covers, URL-encoded. `x-goog-cloud-target-resource` names the provider, so a
 * signature made for this provider cannot be replayed against another.
 */
export async function subjectToken(cfg: ExternalAccount, region: string): Promise<string> {
	const url = (cfg.credential_source?.regional_cred_verification_url ?? DEFAULT_VERIFICATION).replace('{region}', region);
	const request = await aws.signed(url, 'sts', region, {
		method: 'POST',
		headers: { 'x-goog-cloud-target-resource': cfg.audience },
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
async function federatedToken(cfg: ExternalAccount, fetchImpl: typeof fetch): Promise<string> {
	if (federated && federated.until > Date.now()) return federated.value;
	const res = await fetchImpl(cfg.token_url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
			audience: cfg.audience,
			scope: SCOPE,
			requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
			subject_token: await subjectToken(cfg, regionOf()),
			subject_token_type: cfg.subject_token_type,
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

/** Step 2: the access token of the service account, or the federated token when there is none to act as. */
export async function accessToken(fetchImpl: typeof fetch = fetch): Promise<string> {
	if (access && access.until > Date.now()) return access.value;
	const cfg = await configuration(fetchImpl);
	const token = await federatedToken(cfg, fetchImpl);
	const url = cfg.service_account_impersonation_url;
	if (!url) return token;

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
	const cfg = await configuration(fetchImpl);
	const url = cfg.service_account_impersonation_url;
	if (!url) {
		throw new Error('no identity token without a service account: the configuration names none to act as');
	}
	const token = await federatedToken(cfg, fetchImpl);
	const res = await fetchImpl(url.replace(/:generateAccessToken$/, ':generateIdToken'), {
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
