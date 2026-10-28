/**
 * The Google Cloud Functions (2nd gen) shim. Cloud Run as well: a 2nd gen function is a Cloud
 * Run service, and both receive the request through the Functions Framework.
 *
 * Everything interesting happens in the core; this file answers the questions the platform asks
 * differently from Lambda: how the message arrives (an HTTP request, with the body already parsed
 * when it is JSON), where the project and the region come from (the metadata server), and what
 * the answer looks like (an HTTP status and the report).
 *
 * ```js
 * import { cloudfunctions } from '@struct8/hub/runtimes/cloudfunctions';
 * import '@struct8/hub/r/google_pubsub_topic';
 * export const handler = cloudfunctions();
 * ```
 *
 * The function's `build_config.entry_point` is `handler`.
 */

import { discover } from '../core/discovery.js';
import { handle, normalize } from '../core/hub.js';
import * as registry from '../core/registry.js';
import * as google from '../providers/google.js';
import type { Ctx, Neighbor } from '../core/types.js';
import { onish } from './flags.js';

/** The fields of the Functions Framework's request (an Express request) this shim reads. */
export interface HttpRequest {
	/** Parsed by the framework when the content type is JSON; a string or a Buffer otherwise. */
	readonly body?: unknown;
	/** The bytes as they arrived. */
	readonly rawBody?: { toString(encoding?: string): string };
}

/** The fields of the Functions Framework's response this shim calls. */
export interface HttpResponse {
	status(code: number): HttpResponse;
	set(field: string, value: string): HttpResponse;
	send(body: string): unknown;
}

/**
 * Sources that redeliver a message the function answered with an error. A failed hop has to fail
 * the request there, or the message is acknowledged and lost: it is the one-message equivalent of
 * the partial-batch report on Lambda.
 */
const REDELIVERED = new Set(['gcp:pubsub']);

const env = (name: string): string | undefined =>
	typeof process === 'undefined' ? undefined : (process.env as Record<string, string | undefined>)[name];

/** What arrived, as the core reads it: the parsed JSON, or the text of the body. */
function eventOf(req: HttpRequest): unknown {
	const body = req.body;
	if (body === undefined || body === null) return req.rawBody?.toString('utf8') ?? null;
	if (typeof body === 'string') return body;
	// A Buffer or another byte container: the framework did not parse it.
	if (typeof body === 'object' && !Array.isArray(body) && body.constructor !== Object) {
		return req.rawBody?.toString('utf8') ?? String(body);
	}
	return body;
}

export interface CloudFunctionsOptions {
	/** Forward budget for messages entering the chain here. */
	readonly hops?: number;
}

/** Builds the HTTP handler. */
export function cloudfunctions(opts: CloudFunctionsOptions = {}) {
	let neighbors: readonly Neighbor[] | undefined;

	return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
		// Resolved on first request rather than at module load, so that a shim which registers
		// resources after calling cloudfunctions() still sees a complete vocabulary.
		neighbors ??= discover(typeof process === 'undefined' ? {} : process.env, registry.vocabulary());

		// NAME is the function's logical name in the diagram. K_SERVICE is the name Cloud Run
		// gives the service, which for a function is the function's name.
		const self = env('NAME') ?? env('K_SERVICE') ?? 'hub';
		const here = await google.whereAmI(globalThis.fetch);

		const ctx: Ctx = {
			self,
			fetch: globalThis.fetch,
			region: (n) => n?.props['REGION'] ?? here.region,
			// On Google the account is the project: the catalog's project box declares its
			// `project_id` as the account field.
			account: (n) => n?.props['ACCOUNT'] ?? here.project,
			now: () => new Date(),
		};

		const arrival = await normalize(eventOf(req));
		const report = await handle(arrival, neighbors, ctx, {
			...(opts.hops === undefined ? {} : { hops: opts.hops }),
			// Waiting out the deadline, for a message that asked for `slow`: the platform ends the
			// request at the function's timeout, which this shim cannot read.
			...(onish(env('HUB_FAULTS')) ? { faults: { stall: () => new Promise<void>(() => {}) } } : {}),
		});

		console.log(JSON.stringify({ hub: report, describe: arrival.describe }));

		// 200 even when a wire failed, as on Lambda's HTTP sources: the report is the result, and
		// `hops[].ok` names the wire and the reason. Two exceptions. A message that asked to fail
		// fails the request, as any failing function would. And a source that redelivers on an
		// error must see one when an item failed, or the message is gone.
		const failed =
			(report.faults ?? []).length > 0 || (REDELIVERED.has(arrival.origin) && report.failed.length > 0);
		res.status(failed ? 500 : 200).set('content-type', 'application/json').send(JSON.stringify(report));
	};
}
