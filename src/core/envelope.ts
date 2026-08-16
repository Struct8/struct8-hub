/**
 * The envelope: what travels between hops.
 *
 * A message forwarded by one Hub and received by the next arrives as a serialized envelope, so
 * the chain keeps its correlation id and its remaining budget. A message from outside arrives as
 * anything at all, and gets a fresh envelope wrapped around it.
 *
 * Loop control is the counter in `hops`, deliberately not a search through the message text for
 * the workload's own name. That check is wrong in both directions: a legitimate message that
 * happens to mention the resource suppresses itself, and — worse — a suppressed item that is not
 * reported as failed lets a batched source advance its checkpoint past a record nobody processed.
 * A counter cannot be fooled by content.
 */

import type { Envelope } from './types.js';

/** Marks a body as a Hub envelope rather than a payload that merely looks like JSON. */
const MARKER = '$hub';
const VERSION = 1;

/** How many forwards a message gets before the chain stops. */
export const DEFAULT_HOPS = 3;

interface WireEnvelope extends Envelope {
	readonly [MARKER]: number;
}

/** Starts a chain. `trace` is injectable so that reports are deterministic under test. */
export function open(body: string, self: string, opts: { trace?: string; at?: string; hops?: number } = {}): Envelope {
	return {
		trace: opts.trace ?? crypto.randomUUID(),
		hops: opts.hops ?? DEFAULT_HOPS,
		path: [self],
		at: opts.at ?? new Date().toISOString(),
		body,
	};
}

/**
 * Reads an envelope out of a message body, or returns `null` when the body is an ordinary
 * payload. Anything unparseable is an ordinary payload — never an error.
 */
export function read(body: string): Envelope | null {
	if (!body.startsWith('{')) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}

	if (parsed === null || typeof parsed !== 'object') return null;
	const candidate = parsed as Partial<WireEnvelope>;
	if (candidate[MARKER] !== VERSION) return null;
	if (typeof candidate.trace !== 'string' || typeof candidate.body !== 'string') return null;

	return {
		trace: candidate.trace,
		hops: typeof candidate.hops === 'number' ? candidate.hops : 0,
		path: Array.isArray(candidate.path) ? candidate.path.filter((p): p is string => typeof p === 'string') : [],
		at: typeof candidate.at === 'string' ? candidate.at : new Date(0).toISOString(),
		body: candidate.body,
	};
}

/**
 * Spends one hop.
 *
 * Returns `null` when the budget is exhausted, which is the caller's signal to stop and to count
 * the item as dropped rather than to pretend it was delivered.
 */
export function advance(envelope: Envelope, self: string): Envelope | null {
	if (envelope.hops <= 0) return null;
	return {
		...envelope,
		hops: envelope.hops - 1,
		path: [...envelope.path, self],
	};
}

/** Serializes for the wire. */
export const seal = (envelope: Envelope): string =>
	JSON.stringify({ [MARKER]: VERSION, ...envelope });

/**
 * Whether an already-parsed value is one of ours.
 *
 * For arrivals that hand over a decoded object rather than a string — a direct Lambda invocation
 * carries the payload as JSON, not as text.
 */
export const isEnvelope = (value: unknown): boolean =>
	value !== null && typeof value === 'object' && (value as Record<string, unknown>)[MARKER] === VERSION;
