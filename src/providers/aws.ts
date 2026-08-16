/**
 * Talking to AWS over signed `fetch`.
 *
 * Not the AWS SDK, on purpose. The SDK would mean a different code path per runtime and a heavy
 * bundle where bundles are capped; a signed request is the same code in a Lambda, a container and
 * a Worker. Transport being universal is what keeps the work at (resources + runtimes) instead of
 * their product — see docs/architecture.md.
 *
 * Signing and sending are kept apart: `sign()` produces a `Request`, and whoever asked supplies
 * the `fetch` that carries it. That is what makes senders testable without a network, and it is
 * the seam the identity port will attach to — signing is the part that will vary by credential
 * source, and it is already the only part that knows about credentials at all.
 *
 * AWS does not speak one protocol. SQS is JSON-RPC, SNS is form-encoded query, S3 is plain REST
 * over XML. The three helpers below are that reality, not an abstraction leak.
 */

import { AwsClient } from 'aws4fetch';

export interface AwsCredentials {
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly sessionToken?: string;
}

let client: AwsClient | undefined;

/**
 * Supplies credentials explicitly. Required anywhere they are not in the ambient environment — a
 * Worker reaching into AWS, for instance.
 *
 * This is the placeholder for the identity port. When that lands, credentials arrive through the
 * context and this function becomes the manual override rather than the main path.
 */
export function credentials(creds: AwsCredentials): void {
	client = new AwsClient({ ...creds });
}

/**
 * Falls back to the variables the Lambda runtime sets for the execution role.
 *
 * ECS tasks and EC2 instances do not get these: they expose credentials through the container
 * credential endpoint or IMDS, which this does not yet fetch. A known limit of the first runtime,
 * not a design position.
 */
function signer(): AwsClient {
	if (client) return client;

	const env: Record<string, string | undefined> =
		typeof process === 'undefined' ? {} : (process.env as Record<string, string | undefined>);

	const accessKeyId = env['AWS_ACCESS_KEY_ID'];
	const secretAccessKey = env['AWS_SECRET_ACCESS_KEY'];
	if (!accessKeyId || !secretAccessKey) {
		throw new Error('no AWS credentials: none in the environment and none supplied through credentials()');
	}

	const sessionToken = env['AWS_SESSION_TOKEN'];
	client = new AwsClient({
		accessKeyId,
		secretAccessKey,
		...(sessionToken === undefined ? {} : { sessionToken }),
	});
	return client;
}

/** Test seam. Never call this from library or application code. */
export function resetCredentials(): void {
	client = undefined;
}

export const endpoint = (service: string, region: string): string =>
	`https://${service}.${region}.amazonaws.com`;

/**
 * Turns a failed response into a message worth putting in a report.
 *
 * `AccessDenied: s3:PutObject` tells you which wire to fix. `HTTP 403` does not, and the report is
 * the entire product here.
 */
async function fail(res: Response, what: string): Promise<never> {
	const body = await res.text().catch(() => '');

	if (body.startsWith('{')) {
		try {
			const json = JSON.parse(body) as Record<string, unknown>;
			const code = String(json['__type'] ?? json['code'] ?? res.status).split('#').pop();
			const message = json['message'] ?? json['Message'] ?? '';
			throw new Error(`${code}: ${message || what}`);
		} catch (err) {
			if (err instanceof Error && err.message.includes(':')) throw err;
		}
	}

	const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
	if (code) {
		const message = /<Message>([^<]+)<\/Message>/.exec(body)?.[1];
		throw new Error(`${code}: ${message ?? what}`);
	}

	throw new Error(`HTTP ${res.status} on ${what}`);
}

/** Signs and sends. Service and region are stated rather than inferred from the hostname. */
async function send(
	url: string,
	service: string,
	region: string,
	init: RequestInit,
	what: string,
	fetchImpl: typeof fetch
): Promise<Response> {
	const signed = await signer().sign(url, { ...init, aws: { service, region } });
	const res = await fetchImpl(signed);
	if (!res.ok) await fail(res, what);
	return res;
}

/** JSON-RPC protocol: SQS, DynamoDB, Kinesis, Firehose, Lambda's control plane. */
export async function json(
	service: string,
	region: string,
	target: string,
	body: unknown,
	fetchImpl: typeof fetch = fetch
): Promise<unknown> {
	const res = await send(
		endpoint(service, region),
		service,
		region,
		{
			method: 'POST',
			headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': target },
			body: JSON.stringify(body),
		},
		target,
		fetchImpl
	);

	const text = await res.text();
	return text ? JSON.parse(text) : null;
}

/** Query protocol: SNS, and the older services that never moved. */
export async function query(
	service: string,
	region: string,
	params: Record<string, string>,
	fetchImpl: typeof fetch = fetch
): Promise<void> {
	await send(
		endpoint(service, region),
		service,
		region,
		{
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(params).toString(),
		},
		params['Action'] ?? service,
		fetchImpl
	);
}

/** Plain REST: S3, and anything else addressed by URL rather than by action. */
export const rest = (
	url: string,
	service: string,
	region: string,
	init: RequestInit,
	what: string,
	fetchImpl: typeof fetch = fetch
): Promise<Response> => send(url, service, region, init, what, fetchImpl);
