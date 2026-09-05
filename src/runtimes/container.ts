/**
 * The container runtime: ECS, and anything else that runs a process instead of a function.
 *
 * Exactly two things differ from Lambda, and it is worth naming them because everything else —
 * discovery, fan-out, the report, all eighteen resources — is the same code running unchanged.
 *
 * **Work arrives over HTTP.** A function is invoked; a process has to be reachable. There is no
 * event, so there is nothing to parse: `normalize` already treats an unrecognized body as a direct
 * arrival, which is exactly what an HTTP request is.
 *
 * **Credentials have to be fetched.** The Lambda runtime puts the execution role in
 * `AWS_ACCESS_KEY_ID` and friends. ECS does not: it publishes a task-role credential endpoint and
 * the values expire, so reading them once at startup produces a container that works all morning
 * and starts failing after lunch.
 *
 * What is deliberately absent is a queue consumer. Reading a queue means knowing which queue, and
 * the generator emits only the wires that *leave* a node — see CONTRACT.md §8.1. Guessing from the
 * outgoing wires would poll whatever the workload also sends to, which is a workload consuming its
 * own messages.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import { discover } from '../core/discovery.js';
import { handle, normalize } from '../core/hub.js';
import * as registry from '../core/registry.js';
import { credentials } from '../providers/aws.js';
import type { AwsCredentials } from '../providers/aws.js';
import type { Ctx, Neighbor } from '../core/types.js';

/** The link-local address ECS answers the credential request on. Fixed by AWS, not configurable. */
const CREDENTIAL_HOST = 'http://169.254.170.2';

/** Refresh this far ahead of expiry, so a request never races the rotation. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/** Used only when the endpoint returns no expiry, which it is not supposed to do. */
const ASSUMED_LIFETIME_MS = 15 * 60_000;

/**
 * Default cap on the request body.
 *
 * Unlike a Lambda, this port is reachable from a load balancer, and an unbounded read is a way to
 * exhaust the task's memory from outside. The payload here is a message being forwarded, not an
 * upload.
 */
const MAX_BODY_BYTES = 1024 * 1024;

type Env = Record<string, string | undefined>;

const environment = (): Env => (typeof process === 'undefined' ? {} : (process.env as Env));

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export interface TaskCredentials extends AwsCredentials {
	/** Epoch milliseconds. Absent when the endpoint did not say, which is not expected. */
	readonly expiresAt?: number;
}

interface CredentialOptions {
	readonly env?: Env;
	readonly fetch?: typeof fetch;
}

/**
 * Reads the task role from the container credential endpoint.
 *
 * Returns `null` when none of the variables are set — that is not an error, it is a container
 * running somewhere other than ECS, and `providers/aws.ts` then falls back to the ambient
 * variables the same way it does on Lambda. One binary, both places.
 *
 * ECS sets `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` and answers on a fixed link-local address.
 * `AWS_CONTAINER_CREDENTIALS_FULL_URI` is the other accepted form — EKS Pod Identity uses it — and
 * it carries an authorization token, which is why the header is not conditional on ECS.
 */
export async function taskCredentials(opts: CredentialOptions = {}): Promise<TaskCredentials | null> {
	const env = opts.env ?? environment();
	const fetchImpl = opts.fetch ?? globalThis.fetch;

	const relative = env['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI'];
	const url = relative ? `${CREDENTIAL_HOST}${relative}` : env['AWS_CONTAINER_CREDENTIALS_FULL_URI'];
	if (!url) return null;

	const token = authorizationToken(env);
	const res = await fetchImpl(url, {
		...(token === undefined ? {} : { headers: { authorization: token } }),
	});

	if (!res.ok) {
		throw new Error(`container credential endpoint answered ${res.status} ${res.statusText}`);
	}

	// `Token`, not `SessionToken`. The credential endpoint and the STS API name the same value
	// differently, and reading the STS name here yields an unsigned-looking request that AWS
	// rejects as an invalid security token — a message that says nothing about the typo.
	const body = (await res.json()) as {
		AccessKeyId?: string;
		SecretAccessKey?: string;
		Token?: string;
		Expiration?: string;
	};

	if (!body.AccessKeyId || !body.SecretAccessKey) {
		throw new Error('container credential endpoint answered without a key pair');
	}

	const expiry = body.Expiration === undefined ? Number.NaN : Date.parse(body.Expiration);

	return {
		accessKeyId: body.AccessKeyId,
		secretAccessKey: body.SecretAccessKey,
		...(body.Token === undefined ? {} : { sessionToken: body.Token }),
		...(Number.isNaN(expiry) ? {} : { expiresAt: expiry }),
	};
}

/**
 * The token that goes with `FULL_URI`.
 *
 * The file form is the one EKS Pod Identity actually uses; the inline variable is the older shape.
 * Reading is synchronous because it happens once per rotation, not per request.
 */
function authorizationToken(env: Env): string | undefined {
	const inline = env['AWS_CONTAINER_AUTHORIZATION_TOKEN'];
	if (inline) return inline;

	const file = env['AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE'];
	if (!file) return undefined;
	return readFileSync(file, 'utf8').trim();
}

let expiresAt = 0;
let inflight: Promise<void> | undefined;

/**
 * Installs the task role, refreshing when it is close to expiry.
 *
 * The in-flight promise is shared rather than recomputed: several requests arriving during a
 * rotation would otherwise each call the endpoint, and ECS rate-limits it.
 */
async function ensureCredentials(env: Env, fetchImpl: typeof fetch): Promise<void> {
	if (Date.now() < expiresAt - REFRESH_MARGIN_MS) return;

	inflight ??= refreshCredentials(env, fetchImpl).finally(() => {
		inflight = undefined;
	});
	await inflight;
}

async function refreshCredentials(env: Env, fetchImpl: typeof fetch): Promise<void> {
	const creds = await taskCredentials({ env, fetch: fetchImpl });

	if (!creds) {
		// Not on ECS, and no amount of waiting changes that. Stop asking, and leave the signer on
		// its ambient fallback.
		expiresAt = Number.POSITIVE_INFINITY;
		return;
	}

	credentials(creds);
	expiresAt = creds.expiresAt ?? Date.now() + ASSUMED_LIFETIME_MS;
}

/** Test seam. Never call this from library or application code. */
export function resetCredentialCache(): void {
	expiresAt = 0;
	inflight = undefined;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface ContainerOptions {
	/** Forward budget for messages entering the chain here. */
	readonly hops?: number;
	/** Defaults to `PORT`, then 8080. Pass 0 to let the operating system choose. */
	readonly port?: number;
	/** Largest accepted request body, in bytes. Defaults to 1 MiB. */
	readonly maxBodyBytes?: number;
	/** Injectable so the credential endpoint can be tested without one. */
	readonly fetch?: typeof fetch;
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
	// The declared length is checked first so an oversized body is refused before any of it is
	// held. The running total below is the backstop: a chunked request declares no length, and a
	// dishonest one declares the wrong length.
	const declared = Number(req.headers['content-length']);
	if (Number.isFinite(declared) && declared > limit) throw new PayloadTooLarge(limit);

	const chunks: Buffer[] = [];
	let size = 0;

	for await (const chunk of req) {
		const buffer = chunk as Buffer;
		size += buffer.length;
		if (size > limit) throw new PayloadTooLarge(limit);
		chunks.push(buffer);
	}

	return Buffer.concat(chunks).toString('utf8');
}

class PayloadTooLarge extends Error {
	constructor(limit: number) {
		super(`body exceeds ${limit} bytes`);
		this.name = 'PayloadTooLarge';
	}
}

function respond(res: ServerResponse, status: number, payload: unknown): void {
	const text = JSON.stringify(payload);
	res.writeHead(status, {
		'content-type': 'application/json',
		'content-length': Buffer.byteLength(text),
	});
	res.end(text);
}

/**
 * Starts the server.
 *
 * ```js
 * import { container } from '@struct8/hub/runtimes/container';
 * import '@struct8/hub/r/aws_sqs_queue';
 * container();
 * ```
 *
 * `GET` is the health check and `POST` is the work. Keeping them apart is not tidiness: an ALB
 * target group calls the health check every thirty seconds by default, so a health check that
 * forwarded would fire the whole diagram twice a minute, for as long as the task is up, and bill
 * for every hop.
 */
export function container(opts: ContainerOptions = {}): Server {
	const env = environment();
	const fetchImpl = opts.fetch ?? globalThis.fetch;

	let neighbors: readonly Neighbor[] | undefined;

	const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		if (req.method === 'GET' || req.method === 'HEAD') {
			respond(res, 200, { ok: true, self: env['NAME'] ?? null });
			return;
		}

		if (req.method !== 'POST') {
			respond(res, 405, { error: `${req.method ?? 'method'} not allowed; use POST` });
			return;
		}

		// Resolved on first request rather than at module load, so a shim that registers resources
		// after calling container() still sees a complete vocabulary.
		neighbors ??= discover(env, registry.vocabulary());

		const body = await readBody(req, opts.maxBodyBytes ?? MAX_BODY_BYTES);
		await ensureCredentials(env, fetchImpl);

		const ctx: Ctx = {
			// The generator writes NAME for every node it injects variables into, and on ECS it
			// carries the container's own logical name rather than the task's — which is the name
			// the report should show, because the container is what ran.
			self: env['NAME'] ?? env['HOSTNAME'] ?? 'hub',
			fetch: fetchImpl,
			// REGION and ACCOUNT are written unconditionally by the generator, so unlike the Lambda
			// runtime there is no account to recover from an invocation ARN. When they are absent
			// the senders refuse with a reason naming the wire, which is the right failure.
			region: (n) => n?.props['REGION'] ?? env['REGION'] ?? env['AWS_REGION'],
			account: (n) => n?.props['ACCOUNT'] ?? env['ACCOUNT'],
			now: () => new Date(),
		};

		const arrival = await normalize(body);
		const report = await handle(
			arrival,
			neighbors,
			ctx,
			opts.hops === undefined ? {} : { hops: opts.hops }
		);

		console.log(JSON.stringify({ hub: report, describe: arrival.describe }));

		// 200 even when hops failed. The report *is* the answer, and a failed wire is a fact it
		// carries, not a transport error — answering 5xx would make the load balancer treat a
		// correctly reported failure as a broken task and take it out of service.
		respond(res, 200, report);
	};

	const server = createServer((req, res) => {
		// An async handler whose rejection escapes takes the process down with it, which on ECS is
		// a task that dies on the first malformed request and restarts in a loop.
		route(req, res).catch((err: unknown) => {
			const status = err instanceof PayloadTooLarge ? 413 : 500;
			const error = err instanceof Error ? err.message : String(err);
			console.error(JSON.stringify({ hub: 'request failed', error }));
			if (!res.headersSent) respond(res, status, { error });
			else res.end();
		});
	});

	// 0.0.0.0, never localhost. Bound to the loopback the port still maps and the container still
	// starts; what fails is the health check, and the symptom is a task that is replaced every few
	// minutes with nothing in its log to say why.
	server.listen(opts.port ?? Number(env['PORT'] ?? 8080), '0.0.0.0');

	// ECS sends SIGTERM and kills the container after StopTimeout, 30 seconds by default. Without
	// this, every deployment severs the requests in flight.
	const stop = (): void => {
		server.close(() => process.exit(0));
	};
	process.once('SIGTERM', stop);
	process.once('SIGINT', stop);

	return server;
}
