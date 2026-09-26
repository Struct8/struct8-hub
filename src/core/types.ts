/**
 * The type spine.
 *
 * Everything else in this package hangs off these shapes. Nothing here imports a cloud SDK, and
 * nothing here performs I/O — that rule is what keeps the core testable offline and what makes a
 * new provider additive rather than invasive. See docs/architecture.md.
 */

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * A resource this workload was wired to, rebuilt from its own environment.
 *
 * Identity is the pair (`type`, `label`), never the variable name: several variables describing
 * the same target merge into one neighbor. Two wires to the same target with different labels are
 * two neighbors, and both are meant to fire — the diagram drew two wires.
 */
export interface Neighbor {
	/** Catalog type, lowercase: `aws_sqs_queue`. */
	readonly type: string;
	/** The wire's label in the diagram. `'0'` when the wire carries no text. */
	readonly label: string;
	/** Values carried by the wire, keyed by grammar key: `NAME`, `ARN`, `URL`, … */
	readonly props: Readonly<Record<string, string>>;
	/**
	 * Reserved for contract v2. Where a platform hands the workload a live object instead of an
	 * identifier — a Cloudflare Workers binding, for instance — it lands here. A sender branches
	 * on its presence; it never becomes a second sender.
	 */
	readonly handle?: unknown;
}

/**
 * Rebuilds the neighbor list from whatever the platform offers as configuration: `process.env` on
 * a Lambda, the `env` argument on a Worker.
 */
export type Discovery = (source: unknown) => Neighbor[];

// ---------------------------------------------------------------------------
// Ingress
// ---------------------------------------------------------------------------

/**
 * One unit of work.
 *
 * `id` exists only where the source delivers a batch and accepts a partial-failure report — a
 * queue or a stream. Elsewhere it is absent, because there is nothing to report a failure
 * against.
 */
export interface Item {
	readonly id?: string;
	readonly body: string;
}

/** What arrived, reduced to one shape regardless of which platform or source produced it. */
export interface Arrival {
	/** Stable source identifier: `aws:sqs`, `aws:s3`, `http`, … */
	readonly origin: string;
	/** Human-readable, for the report: `SQS OrdersQueue (3 records)`. */
	readonly describe: string;
	/**
	 * Every record in the batch. A batched source must be read in full — taking only the first
	 * record silently discards up to `batchSize - 1` of them.
	 */
	readonly items: readonly Item[];
}

/**
 * Normalizes a platform-specific event into an {@link Arrival}.
 *
 * Returns `null` when the event did not come from this resource. Detection lives with the
 * resource that understands the shape, not in a central switch that has to be edited every time a
 * source is added.
 */
export type Ingress = (raw: unknown) => Arrival | null | Promise<Arrival | null>;

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * What travels between hops.
 *
 * `hops` decrements at every forward and stops the chain at zero. This is loop control by
 * counter, deliberately not by inspecting the message text: a content check suppresses legitimate
 * messages that happen to mention the workload, and a suppressed item that is not reported as
 * failed lets a batched source advance its checkpoint over a record that was never processed.
 */
export interface Envelope {
	/** Correlation id, minted at the first hop and carried unchanged through the chain. */
	readonly trace: string;
	/** Forwards remaining. Zero means stop. */
	readonly hops: number;
	/** The workloads this message has passed through, in order. */
	readonly path: readonly string[];
	/** ISO 8601, stamped at the first hop. */
	readonly at: string;
	readonly body: string;
}

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

/**
 * The X-Ray trace this run belongs to.
 *
 * Read from what the platform already supplies rather than invented. On Lambda that is
 * `_X_AMZN_TRACE_ID`, whose `Root` the Lambda service has *already* used for the invocation
 * segment: minting our own there would put every hop in a second trace sharing nothing with the
 * one the console shows, which reads exactly like no instrumentation at all.
 *
 * `parent` is the id of a segment somebody else wrote. Present on Lambda, absent in a container,
 * and that absence decides the shape of what gets sent — subsegments hang off a parent, a run
 * with no parent needs a segment of its own first. See `segments` in core/report.ts.
 */
export interface TraceContext {
	/** X-Ray trace id: `1-<8 hex seconds>-<24 hex random>`. */
	readonly root: string;
	/**
	 * The id this run's hops hang from, and the id the *next* workload names as its parent.
	 *
	 * One field for both because they are the same id. A downstream segment that names no parent
	 * still lands in the right trace, and the console still draws no arrow to it — the trace holds
	 * two unconnected nodes, which looks like the instrumentation half working.
	 */
	readonly parent?: string;
	/**
	 * Whether `parent` names a segment THIS run has to write.
	 *
	 * Absent on Lambda: the service wrote the invocation segment and owns it, so writing another
	 * under the same trace shows the function twice. Set in a container, where nobody wrote one and
	 * subsegments pointing at a segment that does not exist are accepted by the API and then never
	 * displayed. The runtime is the only place that knows which of the two it is.
	 */
	readonly opens?: boolean;
	/**
	 * Whether this trace is being recorded.
	 *
	 * The platform's answer, not ours, and on Lambda it is also the entire opt-in: the runtime
	 * says `Sampled=0` unless tracing is switched on for the function, so a deployment that never
	 * asked for X-Ray sends nothing and is billed nothing, with no flag of ours involved.
	 */
	readonly sampled: boolean;
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

/**
 * What a sender is given.
 *
 * Note what is absent: credentials. A sender never receives one and never reaches for one. When
 * the identity port lands, it attaches here, and cross-provider sending costs no change in any
 * sender — which is the whole reason the work stays at (resources + runtimes) rather than
 * (resources × runtimes).
 */
export interface Ctx {
	/** The workload's own logical name. */
	readonly self: string;
	/** Universal transport. Present natively on every target runtime. */
	readonly fetch: typeof fetch;
	/** The neighbor's region, or the workload's own when the wire did not override it. */
	region(n?: Neighbor): string | undefined;
	/** The neighbor's account, or the workload's own when the wire did not override it. */
	account(n?: Neighbor): string | undefined;
	/** Injected so that reports are deterministic under test. */
	now(): Date;
	/**
	 * The trace this run belongs to.
	 *
	 * A sender reads it only to hand the trace to the *next* workload — the queue that carries a
	 * message also has to carry the trace, or the chain restarts at every hop and the console shows
	 * one trace per resource instead of one per request.
	 *
	 * PRESENT MEANS RECORDING. The runtime leaves it out when the trace is not being sampled, so a
	 * sender never has to ask: absent is the ordinary case and every sender must tolerate it, and
	 * present is permission to put the trace on the wire.
	 */
	readonly trace?: TraceContext;
}

/**
 * Forwards one message to one neighbor.
 *
 * Must not throw for a missing value: a neighbor may arrive with nothing but `NAME`. Fall back,
 * or let the failure be recorded — an exception here takes the other destinations down with it.
 */
export type Sender = (n: Neighbor, e: Envelope, ctx: Ctx) => Promise<void>;

// ---------------------------------------------------------------------------
// Consume
// ---------------------------------------------------------------------------

/**
 * What one poll returned, and how to forget it.
 *
 * `ack` is a closure the resource builds rather than a second method taking ids, because what a
 * source needs in order to forget a message is its own business: SQS wants a receipt handle, which
 * is *not* the message id and has no reason to exist anywhere outside the module that read it.
 */
export interface Batch extends Arrival {
	/**
	 * Called with the items whose fan-out succeeded, and only those.
	 *
	 * Acknowledging an item that was never forwarded is how a diagram loses a message in silence.
	 * The opposite mistake — leaving one behind — costs a redelivery, which is the recoverable half
	 * of the two.
	 */
	ack(delivered: readonly Item[]): Promise<void>;
}

/**
 * Takes work off a source that nothing delivers from.
 *
 * Only a runtime with no platform poller of its own needs this. On Lambda the event source mapping
 * *is* this function, run by AWS, which is why the Lambda runtime never calls it.
 *
 * Returning an empty batch is the ordinary answer for an idle source, not a failure. An
 * implementation is expected to long-poll rather than return immediately, or the caller's loop
 * becomes a billed spin.
 */
export type Consume = (n: Neighbor, ctx: Ctx) => Promise<Batch>;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** One attempt to cross one wire. Recorded on success and on failure alike. */
export interface Hop {
	readonly n: number;
	/** The target's name as the report should show it. */
	readonly to: string;
	readonly type: string;
	/** The wire's label — what maps this line back to the drawing. */
	readonly label: string;
	readonly ok: boolean;
	readonly ms: number;
	/**
	 * When the attempt started, epoch milliseconds.
	 *
	 * A duration alone cannot be turned into a trace. X-Ray places a subsegment by absolute start
	 * and end, and reconstructing starts by laying durations end to end assumes the hops ran with
	 * no gap between them — true today, and a timing chart that silently lies the day it stops
	 * being true.
	 */
	readonly at: number;
	readonly err?: string;
}

/**
 * The point of the whole exercise.
 *
 * A wire that carried a message and a wire that was never exercised are different facts, and both
 * matter: the second is what lets a diagram show a wire as untested rather than as working.
 */
export interface Report {
	readonly trace: string;
	readonly origin: string;
	readonly hops: readonly Hop[];
	/**
	 * Ids of items whose fan-out failed, for sources that accept a partial-batch report. Empty is
	 * the success answer and must still be sent: an absent list makes the source treat the whole
	 * batch as failed and redeliver all of it.
	 */
	readonly failed: readonly string[];
	/**
	 * Items stopped because the envelope ran out of hops. Counted rather than hidden — a silently
	 * dropped item looks exactly like a delivered one from outside.
	 */
	readonly dropped: number;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * What kind of thing a resource is, independent of provider.
 *
 * Governs what may be drawn, never what it is allowed to do. Permission is a separate output; the
 * day the two merge, the ability to refuse a wire at drawing time is lost, and that is the
 * cheapest place to refuse one.
 */
export type Capability =
	| 'queue'
	| 'topic'
	| 'stream'
	| 'object-store'
	| 'table'
	| 'secret'
	| 'parameter'
	| 'filesystem'
	| 'function'
	| 'http';

/**
 * One resource type's contribution. One folder, one file, no core changes.
 *
 * `type` and `keys` feed the parser's vocabularies, so registering a resource makes it
 * discoverable and reachable in the same act. A module with neither `send` nor `receive` is
 * rejected: a neighbor that can be discovered but never reached is the silent failure this design
 * exists to prevent.
 */
export interface ResourceModule {
	readonly type: string;
	/** Grammar keys beyond the common set, e.g. `['QUEUE_URL']`. */
	readonly keys?: readonly string[];
	readonly capabilities?: readonly Capability[];
	/** Omit for a resource that can only ever be a source. */
	readonly send?: Sender;
	/** Omit for a resource that can only ever be a target. */
	readonly receive?: Ingress;
	/**
	 * Omit unless the resource can be read on demand. Present on a queue, absent on a bucket — and
	 * absent on a stream on purpose, because shards, iterators and lease coordination are a
	 * different job from this one.
	 */
	readonly consume?: Consume;
}
