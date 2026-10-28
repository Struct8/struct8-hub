/**
 * The trail.
 *
 * This is the point of the package. Forwarding a message is easy; saying afterwards which wire
 * carried it, which one failed and why, is what turns a diagram into something you can trust.
 *
 * Every attempt produces exactly one hop, success or failure. A destination that succeeds
 * silently is a wire the diagram cannot color.
 */

import { displayName } from './discovery.js';
import { spanId, w3cTraceId } from './envelope.js';
import type { Fault, Hop, Neighbor, Report, TraceContext } from './types.js';

/**
 * Trims an error to something a report line can hold without losing the useful part.
 *
 * The bare name `Error` is dropped rather than printed. Services already answer with their own —
 * `NoSuchBucket: The specified bucket does not exist` — and prefixing that with `Error:` adds a
 * word to every line and information to none.
 */
const reason = (err: unknown): string => {
	let text: string;
	if (err instanceof Error) text = err.name === 'Error' ? err.message : `${err.name}: ${err.message}`;
	else text = String(err);
	return text.length <= 300 ? text : text.slice(0, 300) + '…';
};

export class Trail {
	readonly #hops: Hop[] = [];
	readonly #failed = new Set<string>();
	readonly #faults: Fault[] = [];
	#dropped = 0;

	constructor(
		private readonly trace: string,
		private readonly origin: string,
		private readonly now: () => number = () => Date.now()
	) {}

	/**
	 * Runs one delivery and records it either way.
	 *
	 * Never rethrows. One broken wire must not take the other destinations down with it — that is
	 * the difference between a report saying "three of four arrived" and an invocation that dies
	 * on the first failure and tells you nothing about the rest.
	 */
	async record(neighbor: Neighbor, itemId: string | undefined, deliver: () => Promise<void>): Promise<boolean> {
		const started = this.now();
		try {
			await deliver();
			this.#push(neighbor, started, true);
			return true;
		} catch (err) {
			this.#push(neighbor, started, false, reason(err));
			if (itemId !== undefined) this.#failed.add(itemId);
			return false;
		}
	}

	/** Notes an item that ran out of hops. Counted, never hidden. */
	drop(): void {
		this.#dropped += 1;
	}

	/**
	 * Notes an item that failed because its message asked to (core/faults.ts).
	 *
	 * It goes in `failed` like an item whose wire failed, so a queue delivers it again and, after
	 * as many deliveries as its redrive policy allows, moves it to the dead-letter queue — which is
	 * what the request is for.
	 */
	fault(itemId: string | undefined, behavior: string, attempt: number | undefined): void {
		this.#faults.push({
			...(itemId === undefined ? {} : { item: itemId }),
			behavior,
			...(attempt === undefined ? {} : { attempt }),
		});
		if (itemId !== undefined) this.#failed.add(itemId);
	}

	#push(neighbor: Neighbor, started: number, ok: boolean, err?: string): void {
		this.#hops.push({
			n: this.#hops.length + 1,
			to: displayName(neighbor),
			type: neighbor.type,
			label: neighbor.label,
			ok,
			ms: this.now() - started,
			at: started,
			...(err === undefined ? {} : { err }),
		});
	}

	done(): Report {
		return {
			trace: this.trace,
			origin: this.origin,
			hops: this.#hops,
			failed: [...this.#failed],
			dropped: this.#dropped,
			...(this.#faults.length === 0 ? {} : { faults: [...this.#faults] }),
		};
	}
}

// ---------------------------------------------------------------------------
// The same trail, in X-Ray's words
// ---------------------------------------------------------------------------

/**
 * One X-Ray segment document, as the API takes it.
 *
 * Loose on purpose. The schema has dozens of optional fields and no generated types worth carrying
 * a dependency for; what matters is that every value below is one X-Ray accepts, which is checked
 * by sending them, not by typing them.
 */
type Document = Record<string, unknown>;

/** Seconds with a fraction, which is how X-Ray states time. Milliseconds are rejected outright. */
const seconds = (ms: number): number => ms / 1000;

/**
 * One hop as a subsegment.
 *
 * `namespace: 'remote'` rather than `'aws'`, which is the honest one of the two. `'aws'` promises
 * an `aws` block naming an SDK operation, and there is no SDK here — a signed `fetch` is not
 * pretending to be one. `'remote'` gives the same downstream node on the map without the claim.
 */
function subsegment(hop: Hop, trace: TraceContext): Document {
	return {
		id: spanId(),
		name: hop.to,
		start_time: seconds(hop.at),
		end_time: seconds(hop.at + hop.ms),
		namespace: 'remote',
		trace_id: trace.root,
		// The wire, so a red node in the console can be found in the drawing. `label` is the text on
		// the arrow and `n` its position in the fan-out; both are how the report already reads.
		annotations: { wire: hop.label, resource_type: hop.type, hop: hop.n },
		...(hop.ok
			? {}
			: {
					error: true,
					cause: {
						exceptions: [{ id: spanId(), type: 'DeliveryFailed', message: hop.err ?? 'delivery failed' }],
					},
				}),
	};
}

/**
 * Turns a finished report into the documents to send to X-Ray, or an empty list when there is
 * nothing to record.
 *
 * TWO SHAPES, decided by `trace.opens` — that is, by whether anybody already wrote the segment:
 *
 *   not opening — Lambda. The invocation segment exists and belongs to the service, so what goes up
 *                 is standalone subsegments pointing at it. A segment of our own under the same
 *                 trace shows the function twice in the console.
 *   opening     — a container. Nobody wrote one, so the run writes it, with the hops nested inside.
 *                 A subsegment whose parent does not exist is accepted by the API and then never
 *                 displayed, which is the worst of the available failures: it looks like it worked.
 *
 * Pure: it builds strings. Sending them is a provider's job — see `emitTrace` in providers/aws.ts.
 */
export function segments(report: Report, trace: TraceContext, self: string): string[] {
	if (!trace.sampled || report.hops.length === 0) return [];

	if (trace.parent && !trace.opens) {
		return report.hops.map((hop) =>
			JSON.stringify({ ...subsegment(hop, trace), type: 'subsegment', parent_id: trace.parent })
		);
	}

	const starts = report.hops.map((hop) => hop.at);
	const ends = report.hops.map((hop) => hop.at + hop.ms);

	return [
		JSON.stringify({
			// The id the runtime already handed downstream, when it had one. Minting a fresh one here
			// would leave the next workload parented to a segment that was never written.
			id: trace.parent ?? spanId(),
			name: self,
			trace_id: trace.root,
			// The caller's span, so the console draws the line from it to this one.
			...(trace.upstream ? { parent_id: trace.upstream } : {}),
			start_time: seconds(Math.min(...starts)),
			end_time: seconds(Math.max(...ends)),
			annotations: { origin: report.origin, dropped: report.dropped },
			...(report.hops.some((hop) => !hop.ok) ? { error: true } : {}),
			subsegments: report.hops.map((hop) => subsegment(hop, trace)),
		}),
	];
}

// ---------------------------------------------------------------------------
// The same trail, in OpenTelemetry's words
// ---------------------------------------------------------------------------

/** One OTLP key-value, in the JSON encoding of the protocol. */
type Attribute = { key: string; value: { stringValue: string } | { intValue: string } | { boolValue: boolean } };

const str = (key: string, value: string): Attribute => ({ key, value: { stringValue: value } });
/** OTLP's JSON encoding writes a 64-bit integer as a decimal string. */
const int = (key: string, value: number): Attribute => ({ key, value: { intValue: String(Math.trunc(value)) } });

/** Epoch milliseconds as OTLP states time: nanoseconds, a decimal string. */
const nanos = (ms: number): string => `${Math.round(ms)}000000`;

/** `SpanKind` in the OTLP enum. */
const KIND = { server: 2, client: 3, consumer: 5 } as const;

/** A source that delivers a message the run consumes, rather than a request it answers. */
const CONSUMED = /^(gcp:pubsub|aws:sqs|aws:sns|aws:kinesis|aws:dynamodb)$/;

/** Where the spans come from, for the `resource` of the request. */
export interface SpanResource {
	/** `service.name`: the workload's logical name. */
	readonly service: string;
	/** Other resource attributes: `gcp.project_id`, `cloud.region`. */
	readonly attributes: Readonly<Record<string, string>>;
}

/**
 * Turns a finished report into an OTLP `ExportTraceServiceRequest`, in the protocol's JSON
 * encoding, or `null` when there is nothing to record.
 *
 * One shape only, the one `segments` calls "opening": nobody else wrote a span for this run, so
 * the run's own span goes up with the hops as its children. Its id is `trace.parent`, the id the
 * runtime already handed downstream, and its parent is `trace.upstream`, the caller's span.
 *
 * The hop attributes carry what the X-Ray annotations carry, under a `struct8.` prefix: the
 * names OpenTelemetry defines say nothing about a wire in a diagram.
 *
 * Status: `ERROR` with the reason on a failed hop, and `UNSET` everywhere else, which is what the
 * specification asks of instrumentation for an operation that did not fail.
 *
 * Pure: it builds an object. Sending it is a provider's job — see `emitTrace` in providers/google.ts.
 */
export function spans(report: Report, trace: TraceContext, resource: SpanResource): Record<string, unknown> | null {
	if (!trace.sampled || report.hops.length === 0) return null;

	const traceId = w3cTraceId(trace.root);
	const runId = trace.parent ?? spanId();
	const starts = report.hops.map((hop) => hop.at);
	const ends = report.hops.map((hop) => hop.at + hop.ms);

	const run = {
		traceId,
		spanId: runId,
		...(trace.upstream ? { parentSpanId: trace.upstream } : {}),
		name: resource.service,
		kind: CONSUMED.test(report.origin) ? KIND.consumer : KIND.server,
		startTimeUnixNano: nanos(Math.min(...starts)),
		endTimeUnixNano: nanos(Math.max(...ends)),
		attributes: [str('struct8.origin', report.origin), int('struct8.dropped', report.dropped)],
		status: report.hops.some((hop) => !hop.ok)
			? { code: 2, message: `${report.hops.filter((hop) => !hop.ok).length} of ${report.hops.length} hops failed` }
			: { code: 0 },
	};

	const hops = report.hops.map((hop) => ({
		traceId,
		spanId: spanId(),
		parentSpanId: runId,
		name: hop.to,
		kind: KIND.client,
		startTimeUnixNano: nanos(hop.at),
		endTimeUnixNano: nanos(hop.at + hop.ms),
		// The wire, so a failed span can be found in the drawing: `label` is the text on the arrow
		// and `n` its position in the fan-out, as in the report.
		attributes: [str('struct8.wire', hop.label), str('struct8.resource_type', hop.type), int('struct8.hop', hop.n)],
		status: hop.ok ? { code: 0 } : { code: 2, message: hop.err ?? 'delivery failed' },
	}));

	return {
		resourceSpans: [
			{
				resource: {
					attributes: [
						str('service.name', resource.service),
						...Object.entries(resource.attributes).map(([key, value]) => str(key, value)),
					],
				},
				scopeSpans: [{ scope: { name: '@struct8/hub' }, spans: [run, ...hops] }],
			},
		],
	};
}
