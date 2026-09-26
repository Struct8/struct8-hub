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

import type { Envelope, TraceContext } from './types.js';

/** Marks a body as a Hub envelope rather than a payload that merely looks like JSON. */
const MARKER = '$hub';
const VERSION = 1;

/** How many forwards a message gets before the chain stops. */
export const DEFAULT_HOPS = 3;

interface WireEnvelope extends Envelope {
	readonly [MARKER]: number;
}

/** Random lowercase hex, `bytes * 2` characters long. */
const hex = (bytes: number): string =>
	[...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Mints a correlation id in X-Ray's trace format: `1-<8 hex seconds>-<24 hex random>`.
 *
 * A UUID would do the correlating just as well, and that is what this used to be. The format
 * matters because the id is not only ours: stamped onto an outgoing message it becomes the trace
 * the *next* workload reports under, and X-Ray rejects an id it cannot parse — leaving a chain
 * that correlates perfectly in the logs and not at all in the console.
 *
 * The timestamp half is not decoration. X-Ray reads it as the trace's age and refuses a trace
 * whose seconds are more than a few hours from now, so it has to be the real clock.
 */
export const traceId = (at: Date = new Date()): string =>
	`1-${Math.floor(at.getTime() / 1000)
		.toString(16)
		.padStart(8, '0')}-${hex(12)}`;

/** Whether a correlation id is in X-Ray's trace format, and so usable as one. */
export const isTraceId = (value: string): boolean => /^1-[0-9a-f]{8}-[0-9a-f]{24}$/.test(value);

/** A segment or subsegment id: 8 random bytes, which is what X-Ray accepts. */
export const spanId = (): string => hex(8);

/**
 * Reads the trace header AWS puts in the environment and in message attributes.
 *
 * The format is `Root=1-…;Parent=…;Sampled=1`, semicolon-separated, order not guaranteed and
 * fields beyond these three permitted — `Lineage` shows up on some paths. Anything unparseable is
 * no trace rather than an error: a run that cannot tell which trace it belongs to still has work
 * to do, and failing the invocation to protect the telemetry has the priorities backwards.
 */
export function parseTraceHeader(raw: string | undefined | null): TraceContext | null {
	if (!raw) return null;

	const fields = new Map<string, string>();
	for (const part of raw.split(';')) {
		const eq = part.indexOf('=');
		if (eq > 0) fields.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
	}

	const root = fields.get('Root');
	if (!root || !isTraceId(root)) return null;

	const parent = fields.get('Parent');
	return {
		root,
		...(parent ? { parent } : {}),
		// Absent means undecided, and the safe reading of undecided is "not recording". A default of
		// true would start billing X-Ray on every deployment that never asked for it.
		sampled: fields.get('Sampled') === '1',
	};
}

/** Writes the header back out, for the next workload to read. */
export const traceHeader = (trace: TraceContext): string =>
	`Root=${trace.root}${trace.parent ? `;Parent=${trace.parent}` : ''};Sampled=${trace.sampled ? '1' : '0'}`;

/** Starts a chain. `trace` is injectable so that reports are deterministic under test. */
export function open(body: string, self: string, opts: { trace?: string; at?: string; hops?: number } = {}): Envelope {
	return {
		trace: opts.trace ?? traceId(),
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
