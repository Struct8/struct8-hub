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

// ---------------------------------------------------------------------------
// The same trace in W3C's words
// ---------------------------------------------------------------------------

/**
 * The W3C trace id of an X-Ray root: the same 128 bits without the version and the hyphens.
 *
 * One trace, two spellings. X-Ray documents the mapping both ways ("W3C trace ID
 * `4efaaf4d1e8720b39541901950019ee5` should be formatted as `1-4efaaf4d-1e8720b39541901950019ee5`
 * when sending to X-Ray", xray-api-sendingdata.html), so a request that starts on AWS and ends on
 * Google is searched for by the same 32 characters in both consoles.
 */
export const w3cTraceId = (root: string): string => root.slice(2).replace('-', '');

/**
 * The X-Ray root of a W3C trace id.
 *
 * The first 8 hex digits stop being a timestamp when the trace began outside X-Ray, and X-Ray
 * accepts that: the timestamp "isn't required when sending W3C trace IDs in X-Ray format" (same
 * page).
 */
export const xrayRoot = (w3c: string): string => `1-${w3c.slice(0, 8)}-${w3c.slice(8)}`;

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;

/**
 * Reads a W3C `traceparent`: `00-<32 hex trace>-<16 hex parent>-<2 hex flags>`.
 *
 * What the spec says to discard is discarded rather than repaired: version `ff`, an all-zero trace
 * or parent id, trailing data on version `00`, anything malformed. As with the X-Ray header, no
 * trace is never an error. A later version is read by its first four fields, which is what the
 * spec asks of a parser meeting a version it does not know.
 */
export function parseTraceparent(raw: string | undefined | null): TraceContext | null {
	if (!raw) return null;
	const match = TRACEPARENT.exec(raw.trim().toLowerCase());
	if (!match) return null;
	const [, version, trace, parent, flags, rest] = match;
	if (version === 'ff' || (version === '00' && rest !== undefined)) return null;
	if (/^0+$/.test(trace!) || /^0+$/.test(parent!)) return null;
	return {
		root: xrayRoot(trace!),
		parent: parent!,
		// Bit 0 of the flags is `sampled`; the other bits are reserved and say nothing to us.
		sampled: (parseInt(flags!, 16) & 1) === 1,
	};
}

/**
 * Writes the `traceparent` the next workload reads, or `null` when there is no span to name as
 * its parent: the field is not optional in the spec.
 */
export const traceparent = (trace: TraceContext): string | null =>
	trace.parent ? `00-${w3cTraceId(trace.root)}-${trace.parent}-${trace.sampled ? '01' : '00'}` : null;

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
