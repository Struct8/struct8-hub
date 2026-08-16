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

/** Normalizes a platform-specific event into an {@link Arrival}. */
export type Ingress = (raw: unknown) => Arrival | Promise<Arrival>;

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
}

/**
 * Forwards one message to one neighbor.
 *
 * Must not throw for a missing value: a neighbor may arrive with nothing but `NAME`. Fall back,
 * or let the failure be recorded — an exception here takes the other destinations down with it.
 */
export type Sender = (n: Neighbor, e: Envelope, ctx: Ctx) => Promise<void>;

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
}
