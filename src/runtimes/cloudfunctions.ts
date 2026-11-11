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
 *
 * A function with an `event_trigger` is not called the way an HTTP function is, and the entry point
 * is the same name in every case, so the handler tells the signatures apart by its second argument
 * (src/function_wrappers.ts of the Functions Framework):
 *
 *   http         (request, response)    an object with `status`.
 *   event        (data, context)        a plain object. Measured on a function with a trigger on
 *                                       a topic, 2026-11-05: the framework converts the CloudEvent,
 *                                       and the first argument is the message itself.
 *   cloudevent   (cloudEvent, callback) a function. The framework takes it for this handler
 *                                       because the handler declares two parameters.
 */

import { discover } from '../core/discovery.js';
import { isTraceId, parseTraceparent, read, spanId, traceHeader, traceId, w3cTraceId } from '../core/envelope.js';
import { handle, normalize } from '../core/hub.js';
import * as registry from '../core/registry.js';
import * as aws from '../providers/aws.js';
import * as google from '../providers/google.js';
import type { Arrival, Ctx, Neighbor, TraceContext } from '../core/types.js';
import { onish } from './flags.js';

/** The fields of the Functions Framework's request (an Express request) this shim reads. */
export interface HttpRequest {
	/** Parsed by the framework when the content type is JSON; a string or a Buffer otherwise. */
	readonly body?: unknown;
	/** The bytes as they arrived. */
	readonly rawBody?: { toString(encoding?: string): string };
	/** Lowercase names, as Node gives them. Read for `traceparent` only. */
	readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
}

/** The fields of the Functions Framework's response this shim calls. */
export interface HttpResponse {
	status(code: number): HttpResponse;
	set(field: string, value: string): HttpResponse;
	send(body: string): unknown;
}

/**
 * The fields of a CloudEvent this shim reads. On a trigger on a topic, `data` is the body a push
 * subscription POSTs: `{ message, subscription }`.
 */
export interface CloudEvent {
	readonly data?: unknown;
}

/**
 * How a function with the `cloudevent` signature answers. An error makes the framework answer 500,
 * and Pub/Sub then delivers the message again; a value becomes the body of a 200.
 */
export type CloudEventCallback = (err: Error | null, result?: string) => void;

/**
 * The second argument under the `event` signature. A value the handler returns is the body of a
 * 200, and an error it throws makes the framework answer 500.
 */
export interface EventContext {
	/** The Pub/Sub message id: the framework removes `messageId` from the message. */
	readonly eventId?: string;
	readonly eventType?: string;
	readonly resource?: string | { readonly name?: string };
}

/** The event type the framework gives a message published to a topic. */
const TOPIC_PUBLISH = 'google.pubsub.topic.publish';

/** Whether the framework called the `cloudevent` signature. */
const completes = (res: unknown): res is CloudEventCallback => typeof res === 'function';

/** Whether the framework called the `http` signature. */
const answersHttp = (res: unknown): res is HttpResponse => typeof (res as HttpResponse | null)?.status === 'function';

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

/**
 * What arrived under the `event` signature. A message goes back to the shape of a push body, which
 * is what the topic's receiver reads. The topic stands in for the subscription, which the framework
 * does not pass on: the receiver only names it in the report.
 */
function eventOfContext(data: unknown, context: EventContext): unknown {
	if (context.eventType !== TOPIC_PUBLISH) return data;
	const resource = context.resource;
	return {
		message: { ...(data as object), messageId: context.eventId },
		subscription: (typeof resource === 'string' ? resource : resource?.name) ?? 'topic',
	};
}

/** What arrived, under whichever signature the framework called. */
function delivered(first: unknown, second: unknown): unknown {
	if (completes(second)) return (first as CloudEvent).data;
	if (answersHttp(second)) return eventOf(first as HttpRequest);
	return eventOfContext(first, second as EventContext);
}

/**
 * Reads whether to send traces to Cloud Trace.
 *
 * A variable, as in a container (runtimes/container.ts), and for the same reason: there is no
 * platform setting to read. Cloud Run samples requests for its own spans and says so in the
 * `traceparent` it passes on, but following that flag would start writing spans from every
 * function whose account cannot write them, and every such request would log the refusal. The
 * compile sets `HUB_TRACE` together with the permission and the API.
 */
const tracingEnabled = (): boolean => onish(env('HUB_TRACE'));

/** One header, the first value when the request repeated it. */
function header(req: HttpRequest, name: string): string | undefined {
	const value = req.headers?.[name];
	return typeof value === 'string' ? value : value?.[0];
}

/**
 * The trace this run records, or `undefined` when it records none.
 *
 * The run opens a span of its own, as a container does: no platform wrote one the Hub could hang
 * its hops from. The trace it continues is, in this order:
 *
 *   the message's   — the `traceparent` a Pub/Sub message carries. It outranks the header because
 *                     a push request is Pub/Sub calling, and the trace of that call starts at the
 *                     subscription, not at the workload that published.
 *   the request's   — the `traceparent` header: the Hub, or any other caller, that invoked this
 *                     function over HTTP.
 *   the envelope's  — the correlation id a Hub message always carries, with no span to name as
 *                     the parent: the trace is the same, and the console draws no line to it.
 *
 * With none of them the run starts a trace.
 */
function traceOf(req: HttpRequest, arrival: Arrival): TraceContext | undefined {
	if (!tracingEnabled()) return undefined;
	const incoming = arrival.trace ?? parseTraceparent(header(req, 'traceparent'));
	const carried = arrival.items.map((item) => read(item.body)?.trace).find((t) => t !== undefined && isTraceId(t));
	return {
		root: incoming?.root ?? carried ?? traceId(),
		parent: spanId(),
		opens: true,
		sampled: true,
		...(incoming?.parent ? { upstream: incoming.parent } : {}),
	};
}

export interface CloudFunctionsOptions {
	/** Forward budget for messages entering the chain here. */
	readonly hops?: number;
}

/** Builds the HTTP handler. */
export function cloudfunctions(opts: CloudFunctionsOptions = {}) {
	let neighbors: readonly Neighbor[] | undefined;

	return async function handler(
		req: unknown,
		res: HttpResponse | CloudEventCallback | EventContext
	): Promise<string | void> {
		// The run's own timing, which places its span when it delivers nothing (spans in
		// core/report.ts). The receiver at the end of a chain is such a run.
		const started = Date.now();

		// Resolved on first request rather than at module load, so that a shim which registers
		// resources after calling cloudfunctions() still sees a complete vocabulary.
		neighbors ??= discover(typeof process === 'undefined' ? {} : process.env, registry.vocabulary());

		// NAME is the function's logical name in the diagram. K_SERVICE is the name Cloud Run
		// gives the service, which for a function is the function's name.
		const self = env('NAME') ?? env('K_SERVICE') ?? 'hub';
		const here = await google.whereAmI(globalThis.fetch);

		const arrival = await normalize(delivered(req, res));
		const trace = traceOf(req as HttpRequest, arrival);

		const ctx: Ctx = {
			self,
			fetch: globalThis.fetch,
			region: (n) => n?.props['REGION'] ?? here.region,
			// On Google the account is the project: the catalog's project box declares its
			// `project_id` as the account field.
			account: (n) => n?.props['ACCOUNT'] ?? here.project,
			now: () => new Date(),
			...(trace === undefined ? {} : { trace }),
		};

		// A request signed for AWS carries the trace as AWS reads it, as on Lambda. Cleared after
		// the fan-out: the module outlives the request, and the next one may record nothing.
		aws.setTraceHeader(trace ? traceHeader(trace) : undefined);
		const report = await handle(arrival, neighbors, ctx, {
			...(opts.hops === undefined ? {} : { hops: opts.hops }),
			...(trace === undefined ? {} : { trace: trace.root }),
			// Waiting out the deadline, for a message that asked for `slow`: the platform ends the
			// request at the function's timeout, which this shim cannot read.
			...(onish(env('HUB_FAULTS')) ? { faults: { stall: () => new Promise<void>(() => {}) } } : {}),
		});
		const run = { at: started, ms: Date.now() - started };

		aws.setTraceHeader(undefined);

		// The W3C id beside the report, because that is the spelling the Cloud Trace console searches.
		console.log(
			JSON.stringify({
				hub: report,
				describe: arrival.describe,
				...(trace === undefined ? {} : { traceId: w3cTraceId(trace.root) }),
			})
		);

		// Before the answer, and awaited: Cloud Run may throttle the instance's CPU once the response
		// is sent, and a request still in flight then may never leave.
		await google.emitTrace(report, trace, self, here, globalThis.fetch, run);

		// 200 even when a wire failed, as on Lambda's HTTP sources: the report is the result, and
		// `hops[].ok` names the wire and the reason. Two exceptions. A message that asked to fail
		// fails the request, as any failing function would. And a source that redelivers on an
		// error must see one when an item failed, or the message is gone.
		const failed =
			(report.faults ?? []).length > 0 || (REDELIVERED.has(arrival.origin) && report.failed.length > 0);
		const body = JSON.stringify(report);
		if (completes(res)) {
			res(failed ? new Error(`the Hub failed this message: ${body}`) : null, failed ? undefined : body);
			return;
		}
		if (answersHttp(res)) {
			res.status(failed ? 500 : 200).set('content-type', 'application/json').send(body);
			return;
		}
		if (failed) throw new Error(`the Hub failed this message: ${body}`);
		return body;
	};
}
