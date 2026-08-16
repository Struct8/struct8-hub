/**
 * Rebuilding the neighbor list from the workload's own configuration.
 *
 * Pure: no I/O, no clock, no environment access of its own. Give it a plain object and a
 * vocabulary and it returns neighbors. That is what makes the interesting half of this package
 * testable in milliseconds without a cloud account.
 *
 * See CONTRACT.md §1–§5 for the grammar this implements.
 */

import type { Neighbor } from './types.js';

/**
 * Keys every resource may use without declaring them. A resource declares only what is unusual
 * to it — `QUEUE_URL`, `DB_NAME` — through {@link ResourceModule.keys}.
 */
export const COMMON_KEYS: readonly string[] = [
	'NAME',
	'ARN',
	'URL',
	'ID',
	'BUCKET',
	'PATH',
	'ENDPOINT',
	'REGION',
	'ACCOUNT',
	'HANDLE',
];

export interface Vocabulary {
	/** Catalog types, lowercase: `aws_sqs_queue`. */
	readonly types: readonly string[];
	/** Grammar keys, uppercase. */
	readonly keys: readonly string[];
}

export interface ParsedName {
	/** Catalog type, lowercase. */
	readonly type: string;
	readonly key: string;
	readonly label: string;
}

/** `aws_sqs_queue` → `AWS_SQS_QUEUE`. Mirrors what the generator does when it builds the name. */
export const toEnvType = (catalogType: string): string =>
	catalogType.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();

/**
 * Splits a variable name into its three segments.
 *
 * Matching is against known vocabularies, longest first, and this is the whole reason the
 * function exists. Consider:
 *
 *     AWS_LAMBDA_FUNCTION_URL_NAME_0
 *
 * `AWS_LAMBDA_FUNCTION` + `URL_NAME_0` and `AWS_LAMBDA_FUNCTION_URL` + `NAME_0` are both
 * syntactically valid, and only the second is right. No pattern can choose between them, because
 * both types are real. Longest-first over a known vocabulary can.
 *
 * Returns `null` for anything that is not part of the contract — the environment is full of
 * variables that have nothing to do with wiring, and they must be ignored in silence.
 */
export function parseName(name: string, vocab: Vocabulary): ParsedName | null {
	const byLength = (a: string, b: string): number => b.length - a.length;

	const envTypes = vocab.types
		.map((t) => [toEnvType(t), t] as const)
		.sort((a, b) => byLength(a[0], b[0]));

	const match = envTypes.find(([envType]) => name.startsWith(envType + '_'));
	if (!match) return null;
	const [envType, catalogType] = match;

	const afterType = name.slice(envType.length + 1);
	const key = [...vocab.keys].sort(byLength).find((k) => afterType.startsWith(k + '_'));
	if (key === undefined) return null;

	const label = afterType.slice(key.length + 1);

	// An empty label means the name ended at the key, which the generator never emits: a wire with
	// no text gets the label '0'. This is not a nicety — the AWS runtime itself sets
	// AWS_LAMBDA_FUNCTION_NAME, which parses as type AWS_LAMBDA_FUNCTION, key NAME, empty label.
	// Without this guard the function would discover itself as one of its own neighbors.
	if (label === '') return null;

	return { type: catalogType, key, label };
}

/**
 * Reads a configuration source — `process.env` on a Lambda, the `env` argument on a Worker — and
 * returns the neighbors it describes.
 *
 * A neighbor is identified by the pair (type, label), never by the variable name: several
 * variables describing the same target merge into one. Two wires to the same target with
 * different labels stay two neighbors, and both are meant to fire — the diagram drew two wires.
 *
 * Values that are not strings land in `handle` instead of `props`, which is how a platform that
 * delivers a live object rather than an identifier is read by this same function. See
 * CONTRACT.md §4.
 */
export function discover(source: unknown, vocab: Vocabulary): Neighbor[] {
	if (source === null || typeof source !== 'object') return [];

	const byIdentity = new Map<string, { type: string; label: string; props: Record<string, string>; handle?: unknown }>();

	for (const [name, value] of Object.entries(source as Record<string, unknown>)) {
		if (value === undefined || value === null) continue;

		const parsed = parseName(name, vocab);
		if (!parsed) continue;

		const identity = `${parsed.type}#${parsed.label}`;
		let neighbor = byIdentity.get(identity);
		if (!neighbor) {
			neighbor = { type: parsed.type, label: parsed.label, props: {} };
			byIdentity.set(identity, neighbor);
		}

		if (typeof value === 'string') neighbor.props[parsed.key] = value;
		else neighbor.handle = value;
	}

	// Sorted so the result never depends on the iteration order of the source object.
	return [...byIdentity.values()]
		.sort((a, b) => a.type.localeCompare(b.type) || a.label.localeCompare(b.label))
		.map((n) => (n.handle === undefined ? { type: n.type, label: n.label, props: n.props } : n));
}

/** The name to show for a neighbor in a report. */
export const displayName = (n: Neighbor): string =>
	n.props['NAME'] ?? n.props['ARN'] ?? n.props['URL'] ?? n.props['ID'] ?? n.label;
