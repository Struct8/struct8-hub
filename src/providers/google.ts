/**
 * Talking to Google Cloud over `fetch`, with the token of the workload's service account.
 *
 * Not the Google client libraries, for the reason `providers/aws.ts` gives for the AWS SDK: they
 * would mean a different code path per runtime and a heavy bundle, and several of them speak gRPC,
 * which a Worker cannot. Every Google API used here also answers JSON over HTTPS.
 *
 * Google needs no request signing. A request carries `Authorization: Bearer <token>`, and inside
 * Google Cloud the token comes from the metadata server, which answers only from the machine the
 * workload runs on: a Cloud Function, a Cloud Run service, a Compute Engine VM. The same server
 * says which project and region the workload is in, which is why the generator writes neither
 * (`data.aws_*` has no Google equivalent it could write instead).
 *
 * Two tokens, for two kinds of destination. A Google API takes an ACCESS token. A Cloud Run
 * service or a 2nd gen function takes an IDENTITY token, issued for its own URL (the audience),
 * and refuses an access token with 401.
 *
 * Outside Google Cloud, a workload on AWS gets both tokens through workload identity federation,
 * with its own role and no key (`providers/googleFederation.ts`), when the compile gave it
 * `CROSS_CLOUD_PARAMETER`.
 */

import * as federation from './googleFederation.js';

const METADATA = 'http://metadata.google.internal/computeMetadata/v1';
const FLAVOR = { 'Metadata-Flavor': 'Google' };

/** Renewed this long before Google says the token expires, so no request carries a dying one. */
const EARLY_MS = 60_000;

/** Identity tokens last an hour; the metadata server does not say so in the answer. */
const IDENTITY_TTL_MS = 55 * 60_000;

interface Cached {
	readonly value: string;
	readonly until: number;
}

export interface GoogleCredentials {
	/** Sent to every Google API. */
	readonly accessToken: string;
	/** Sent to a Cloud Run service or a function. Absent: the access token is sent instead. */
	readonly identityToken?: string;
}

let supplied: GoogleCredentials | undefined;
let access: Cached | undefined;
const identities = new Map<string, Cached>();
let place: Promise<Place> | undefined;

/**
 * Supplies the tokens explicitly. Required anywhere there is no metadata server: a Lambda or a
 * Worker reaching into Google, or a test.
 *
 * The placeholder for the identity port, as `credentials()` is in providers/aws.ts. A token
 * supplied here is never renewed: whoever supplies it renews it.
 */
export function credentials(creds: GoogleCredentials): void {
	supplied = creds;
}

/** Test seam. Never call this from library or application code. */
export function resetCredentials(): void {
	supplied = undefined;
	access = undefined;
	identities.clear();
	place = undefined;
	federation.resetFederation();
}

async function metadata(path: string, what: string, fetchImpl: typeof fetch): Promise<Response> {
	let res: Response;
	try {
		res = await fetchImpl(`${METADATA}/${path}`, { headers: FLAVOR });
	} catch (err) {
		// The hostname resolves only inside Google Cloud. Elsewhere this is a DNS failure, and the
		// network's own message ("fetch failed") says nothing about why.
		throw new Error(
			`no Google credentials: the metadata server did not answer ${what} (${err instanceof Error ? err.message : String(err)}), and none were supplied through credentials()`
		);
	}
	if (!res.ok) await fail(res, what);
	return res;
}

/** The access token of the workload's service account. */
export async function accessToken(fetchImpl: typeof fetch = fetch): Promise<string> {
	if (supplied) return supplied.accessToken;
	if (federation.configured()) return federation.accessToken(fetchImpl);
	if (access && access.until > Date.now()) return access.value;

	const res = await metadata('instance/service-accounts/default/token', 'the access token', fetchImpl);
	const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown };
	if (typeof body.access_token !== 'string' || !body.access_token) {
		throw new Error('the metadata server answered without an access token');
	}
	const seconds = typeof body.expires_in === 'number' ? body.expires_in : 300;
	access = { value: body.access_token, until: Date.now() + seconds * 1000 - EARLY_MS };
	return access.value;
}

/**
 * An identity token for one audience: the URL of the service or function being called.
 *
 * Per audience, because a token names the one it was issued for and a service refuses another's.
 */
export async function identityToken(audience: string, fetchImpl: typeof fetch = fetch): Promise<string> {
	if (supplied) return supplied.identityToken ?? supplied.accessToken;
	if (federation.configured()) return federation.identityToken(audience, fetchImpl);
	const cached = identities.get(audience);
	if (cached && cached.until > Date.now()) return cached.value;

	const res = await metadata(
		`instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`,
		`an identity token for ${audience}`,
		fetchImpl
	);
	const value = (await res.text()).trim();
	if (!value) throw new Error(`the metadata server answered without an identity token for ${audience}`);
	identities.set(audience, { value, until: Date.now() + IDENTITY_TTL_MS });
	return value;
}

export interface Place {
	/** The project id, `my-project`, never the project number. */
	readonly project?: string;
	/** `us-central1`. */
	readonly region?: string;
}

/**
 * The project and region the workload runs in, read once per instance.
 *
 * A failure is not cached and does not throw: outside Google Cloud there is no metadata server,
 * and a workload there either names the project on every wire (`ACCOUNT`) or reports the hop as
 * failed with a reason, which is the sender's job.
 */
export function whereAmI(fetchImpl: typeof fetch = fetch): Promise<Place> {
	place ??= (async (): Promise<Place> => {
		const read = async (path: string): Promise<string | undefined> => {
			try {
				const res = await fetchImpl(`${METADATA}/${path}`, { headers: FLAVOR });
				return res.ok ? (await res.text()).trim() || undefined : undefined;
			} catch {
				return undefined;
			}
		};
		const [project, region] = await Promise.all([read('project/project-id'), read('instance/region')]);
		// The region comes back as `projects/<number>/regions/<region>`.
		return {
			...(project ? { project } : {}),
			...(region ? { region: region.split('/').pop()! } : {}),
		};
	})();
	const pending = place;
	pending.then(
		(p) => {
			if (!p.project && place === pending) place = undefined;
		},
		() => {
			if (place === pending) place = undefined;
		}
	);
	return pending;
}

/**
 * Turns a failed response into a message worth putting in a report.
 *
 * Google APIs answer `{ "error": { "code", "message", "status" } }`. The status is the code a
 * person searches for (`PERMISSION_DENIED`), and the message names the permission that is missing,
 * which is what tells you which connection's grant to fix.
 */
export async function fail(res: Response, what: string): Promise<never> {
	const body = await res.text().catch(() => '');
	if (body.startsWith('{')) {
		try {
			const json = JSON.parse(body) as { error?: { status?: unknown; message?: unknown } | string; message?: unknown };
			const error = json.error;
			if (error && typeof error === 'object') {
				const status = typeof error.status === 'string' && error.status ? error.status : `HTTP ${res.status}`;
				const message = typeof error.message === 'string' && error.message ? error.message : what;
				throw new Error(`${status}: ${message}`);
			}
			if (typeof json.message === 'string' && json.message) {
				throw new Error(`HTTP ${res.status} on ${what}: ${json.message}`);
			}
		} catch (err) {
			if (err instanceof Error && err.message.includes(':')) throw err;
		}
	}
	throw new Error(`HTTP ${res.status} on ${what}`);
}

/** A Google API call, with the access token. */
export async function api(
	url: string,
	init: RequestInit,
	what: string,
	fetchImpl: typeof fetch = fetch
): Promise<Response> {
	const token = await accessToken(fetchImpl);
	const headers = new Headers(init.headers);
	headers.set('authorization', `Bearer ${token}`);
	const res = await fetchImpl(url, { ...init, headers });
	if (!res.ok) await fail(res, what);
	return res;
}

/**
 * A POST to a Cloud Run service or a 2nd gen function, with an identity token for its URL.
 *
 * The audience is the URL the wire carries, without a query: the service's `uri`
 * (`https://<service>-<hash>.a.run.app`) or the function's `url`
 * (`https://<region>-<project>.cloudfunctions.net/<function>`), which is the audience Google's
 * guide to invoking a function uses.
 */
export async function invoke(
	url: string,
	body: string,
	what: string,
	fetchImpl: typeof fetch = fetch
): Promise<Response> {
	const parsed = new URL(url);
	const audience = parsed.pathname === '/' ? parsed.origin : `${parsed.origin}${parsed.pathname}`;
	const token = await identityToken(audience, fetchImpl);
	const res = await fetchImpl(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
		body,
	});
	if (!res.ok) await fail(res, what);
	return res;
}

/** The project a neighbor lives in: the wire's, or the workload's own. */
export function projectOf(project: string | undefined, kind: string): string {
	if (!project) {
		throw new Error(`no project for the ${kind}: none on the wire and none from the metadata server`);
	}
	return project;
}
