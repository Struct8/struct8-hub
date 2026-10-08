/**
 * The orchestration, and the only place that knows the whole story.
 *
 * It performs no I/O of its own: discovery is handed to it, sending goes through the registry,
 * time and transport come from the context. That is what lets the interesting behavior — batching,
 * loop control, partial failure — be tested against fake senders in milliseconds.
 */

import { advance, open, read, seal, traceId } from './envelope.js';
import { directive, fails, spelled } from './faults.js';
import * as registry from './registry.js';
import { Trail } from './report.js';
import type { Arrival, Ctx, Envelope, Neighbor, Report } from './types.js';

export interface HandleOptions {
	/** Injectable so reports are deterministic under test. */
	readonly trace?: string;
	readonly now?: () => number;
	readonly at?: string;
	/** Forward budget for messages entering the chain here. */
	readonly hops?: number;
	/**
	 * Failures on request (core/faults.ts). Absent is off, and off is the default: a runtime passes
	 * this only when its environment asks for it.
	 */
	readonly faults?: {
		/** Waits out the invocation, for `slow`. On a platform with a deadline it never returns. */
		readonly stall: () => Promise<void>;
	};
}

/**
 * Normalizes a raw platform event by asking each registered receiver whether it recognizes it.
 *
 * Detection lives with the resource that understands the shape. A central switch would have to be
 * edited for every source ever added, which is the coupling this package exists to avoid.
 *
 * Returns a generic arrival when nobody claims the event — a manual invocation or an HTTP request
 * is a legitimate way in, not an error.
 */
export async function normalize(raw: unknown): Promise<Arrival> {
	for (const mod of registry.receivers()) {
		const arrival = await mod.receive!(raw);
		if (arrival) return arrival;
	}

	const body = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
	return { origin: 'direct', describe: 'direct invocation', items: [{ body }] };
}

/**
 * Delivers everything that arrived to everything that is wired, and reports each attempt.
 *
 * Every item in the batch is processed. Reading only the first record would silently discard up
 * to `batchSize - 1` messages while reporting success, which is the kind of bug that survives for
 * months because nothing ever complains.
 */
export async function handle(
	arrival: Arrival,
	neighbors: readonly Neighbor[],
	ctx: Ctx,
	opts: HandleOptions = {}
): Promise<Report> {
	const chains = arrival.items.map((item) => read(item.body));
	// `opts.trace` outranks the envelope on purpose, and it is the runtime that passes it. On Lambda
	// the platform has already opened a segment under its own trace id before this code runs; taking
	// the envelope's id instead would file every hop under a trace the invocation is not in.
	const trace = opts.trace ?? chains.find((c) => c !== null)?.trace ?? traceId();

	const trail = new Trail(trace, arrival.origin, opts.now);
	const reachable = neighbors.filter((n) => registry.get(n.type)?.send);

	for (const [index, item] of arrival.items.entries()) {
		// Before the fan-out, so a message that asked to fail is not delivered anywhere first: on a
		// queue it comes back, and a downstream that already had it would get it once per delivery.
		const asked = opts.faults ? directive(item.body) : null;
		if (asked?.kind === 'slow') await opts.faults!.stall();
		else if (asked && fails(asked, item.attempt)) {
			trail.fault(item.id, spelled(asked), item.attempt);
			continue;
		}

		const incoming: Envelope =
			chains[index] ??
			open(item.body, ctx.self, {
				trace,
				...(opts.at === undefined ? {} : { at: opts.at }),
				...(opts.hops === undefined ? {} : { hops: opts.hops }),
			});

		const outgoing = advance(incoming, ctx.self);
		if (!outgoing) {
			// Out of budget. Counted, not hidden: from outside, a silently dropped item is
			// indistinguishable from a delivered one.
			trail.drop();
			continue;
		}

		// Sequential on purpose. These are test diagrams, and a readable trail in wire order is
		// worth more here than the milliseconds concurrency would save.
		for (const neighbor of reachable) {
			const send = registry.get(neighbor.type)!.send!;
			await trail.record(neighbor, item.id, () => send(neighbor, outgoing, ctx));
		}
	}

	return trail.done();
}

/**
 * The answer a batched source expects, per the `ReportBatchItemFailures` contract.
 *
 * An empty list is the success answer and must still be sent. Omitting it makes the source treat
 * the whole batch as failed; on a stream the checkpoint then rewinds to the lowest sequence
 * number reported and everything from there is redelivered.
 */
export const ack = (report: Report): { batchItemFailures: { itemIdentifier: string }[] } => ({
	batchItemFailures: report.failed.map((itemIdentifier) => ({ itemIdentifier })),
});

export { seal };
