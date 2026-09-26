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

import { segments } from '../core/report.js';
import type { Report, TraceContext } from '../core/types.js';

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

// ---------------------------------------------------------------------------
// Trace propagation
// ---------------------------------------------------------------------------

let outgoingTrace: string | undefined;

/**
 * The trace header to put on every signed request from here on.
 *
 * Module state, like the credentials above, and for the same reason: `send` below is reached from
 * eighteen resource modules that pass a context they should not have to know carries telemetry.
 * The runtime sets this once it knows which trace the run belongs to, and clears it otherwise.
 *
 * WHAT THIS BUYS, because it is not the same thing the queue's message attribute buys: the services
 * that keep traces of their own — SNS, API Gateway, Step Functions, Lambda's invoke path — read the
 * caller's trace off this HTTP header. Without it an SNS publish starts a new trace at the topic
 * however carefully the message body was stamped, because the topic never opens the body.
 */
export function setTraceHeader(header: string | undefined): void {
	outgoingTrace = header;
}

/** Test seam. Never call this from library or application code. */
export function resetTraceHeader(): void {
	outgoingTrace = undefined;
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

/**
 * Signs and sends. Service and region are stated rather than inferred from the hostname.
 *
 * The trace header goes on BEFORE signing, not onto the `Request` that comes back. A header added
 * afterwards is outside the signature, and whether AWS tolerates that varies by service — so the
 * one arrangement that cannot produce a sporadic `SignatureDoesNotMatch` is to let the signer see
 * it. Nothing is added when no trace is being recorded, which keeps the signed set unchanged for
 * every deployment that is not tracing.
 */
async function send(
	url: string,
	service: string,
	region: string,
	init: RequestInit,
	what: string,
	fetchImpl: typeof fetch
): Promise<Response> {
	const headers = new Headers(init.headers);
	if (outgoingTrace) headers.set('x-amzn-trace-id', outgoingTrace);

	const signed = await signer().sign(url, { ...init, headers, aws: { service, region } });
	const res = await fetchImpl(signed);
	if (!res.ok) await fail(res, what);
	return res;
}

/**
 * Which JSON-RPC dialect each service speaks.
 *
 * There is no negotiating and no default that works: send 1.0 to Kinesis and the answer is a bare
 * 404, send 1.1 to DynamoDB and it is a bare 404 the other way. Neither says anything about
 * content types, so the failure looks like a wrong endpoint and sends you looking in the wrong
 * place. Measured against the live APIs, not read off a page.
 */
const JSON_DIALECT: Record<string, '1.0' | '1.1'> = {
	dynamodb: '1.0',
	sqs: '1.0',
	kinesis: '1.1',
	firehose: '1.1',
	logs: '1.1',
	ssm: '1.1',
	secretsmanager: '1.1',
	events: '1.1',
};

/** JSON-RPC protocol: SQS, DynamoDB, Kinesis, Firehose, CloudWatch Logs, SSM, Secrets Manager, EventBridge. */
export async function json(
	service: string,
	region: string,
	target: string,
	body: unknown,
	fetchImpl: typeof fetch = fetch
): Promise<unknown> {
	const dialect = JSON_DIALECT[service];
	if (!dialect) {
		// Refused rather than guessed. A wrong guess here is a 404 in production and a green test
		// suite, because a fake transport answers 200 whatever the content type says.
		throw new Error(`unknown JSON dialect for service ${service}: add it to JSON_DIALECT in providers/aws.ts`);
	}

	const res = await send(
		endpoint(service, region),
		service,
		region,
		{
			method: 'POST',
			headers: { 'content-type': `application/x-amz-json-${dialect}`, 'x-amz-target': target },
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

/** Plain REST: S3, Lambda's invoke path, and anything else addressed by URL rather than by action. */
export const rest = (
	url: string,
	service: string,
	region: string,
	init: RequestInit,
	what: string,
	fetchImpl: typeof fetch = fetch
): Promise<Response> => send(url, service, region, init, what, fetchImpl);

/**
 * An ordinary request, unsigned.
 *
 * For destinations that are not AWS APIs even though AWS runs them: a load balancer in front of
 * somebody's application, for instance. Signing those would add an `Authorization` header the
 * application did not ask for and may well reject.
 */
export async function plain(
	url: string,
	init: RequestInit,
	what: string,
	fetchImpl: typeof fetch = fetch
): Promise<Response> {
	const res = await fetchImpl(url, init);
	if (!res.ok) throw new Error(`HTTP ${res.status} on ${what}`);
	return res;
}

/**
 * Base64 for the JSON protocols that carry binary — Kinesis and Firehose both take `Data` that
 * way. Encoding through TextEncoder rather than handing `btoa` a string directly: `btoa` throws on
 * any character above U+00FF, so a message with an accent in it would fail and a plain one would
 * not, which is a bug that only shows up in production and only for some users.
 */
export const b64 = (text: string): string => {
	const bytes = new TextEncoder().encode(text);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
};

/** The inverse, for reading records off a stream. */
export const unb64 = (encoded: string): string => {
	const binary = atob(encoded);
	const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
	return new TextDecoder().decode(bytes);
};

// ---------------------------------------------------------------------------
// X-Ray
// ---------------------------------------------------------------------------

/**
 * How many documents go up in one request.
 *
 * The API caps the request body, not the count, so a cap on the count is the cheap approximation:
 * a fan-out wide enough to exceed it does not exist in a test diagram, and the chunking is here so
 * that the day it does the segments still arrive.
 */
const SEGMENT_BATCH = 50;

/**
 * Ships segment documents.
 *
 * REST rather than JSON-RPC: X-Ray takes a path and a JSON body and has no `x-amz-target`, which is
 * why it needs no entry in `JSON_DIALECT`.
 */
export async function putTraceSegments(
	region: string,
	documents: readonly string[],
	fetchImpl: typeof fetch = fetch
): Promise<string[]> {
	const unprocessed: string[] = [];

	for (let i = 0; i < documents.length; i += SEGMENT_BATCH) {
		const res = await rest(
			`${endpoint('xray', region)}/TraceSegments`,
			'xray',
			region,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ TraceSegmentDocuments: documents.slice(i, i + SEGMENT_BATCH) }),
			},
			'PutTraceSegments',
			fetchImpl
		);

		// A rejected document does NOT fail the request. X-Ray answers 200 and lists what it threw
		// away, so a malformed segment is invisible unless this list is read — the exact silent gap
		// this package exists to close, reappearing in its own telemetry.
		const answer = (await res.json().catch(() => null)) as {
			UnprocessedTraceSegments?: { Id?: string; ErrorCode?: string; Message?: string }[];
		} | null;

		for (const bad of answer?.UnprocessedTraceSegments ?? []) {
			unprocessed.push(`${bad.ErrorCode ?? 'rejected'}: ${bad.Message ?? bad.Id ?? 'no reason given'}`);
		}
	}

	return unprocessed;
}

/**
 * Sends the trail to X-Ray, and never lets that failure become the workload's failure.
 *
 * Telemetry is not the job. A queue message that was forwarded to five destinations has been
 * forwarded whether or not the trace arrived, and throwing here would turn a successful fan-out
 * into a retried one — duplicating real work to protect a record of it.
 *
 * The reason is logged rather than swallowed, because the failure that matters is the likely one:
 * `AccessDenied` until the execution role carries `xray:PutTraceSegments`, which the diagram does
 * not grant today.
 */
export async function emitTrace(
	report: Report,
	trace: TraceContext | undefined,
	self: string,
	region: string | undefined,
	fetchImpl: typeof fetch = fetch
): Promise<void> {
	if (!trace || !region) return;

	const documents = segments(report, trace, self);
	if (documents.length === 0) return;

	try {
		const unprocessed = await putTraceSegments(region, documents, fetchImpl);
		if (unprocessed.length > 0) {
			console.error(JSON.stringify({ hub: 'trace rejected', trace: trace.root, reasons: unprocessed }));
		}
	} catch (err) {
		console.error(
			JSON.stringify({
				hub: 'trace not sent',
				trace: trace.root,
				error: err instanceof Error ? err.message : String(err),
			})
		);
	}
}
