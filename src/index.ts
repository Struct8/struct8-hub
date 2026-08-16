/**
 * @struct8/hub — the code that runs inside the resources you draw.
 *
 * Resources are not imported here. A deployment brings only what its diagram uses:
 *
 * ```js
 * import { hub } from '@struct8/hub';
 * import '@struct8/hub/r/aws_sqs_queue';
 * import '@struct8/hub/r/aws_s3_bucket';
 * export const handler = hub.lambda();
 * ```
 */

import { discover, type Vocabulary } from './core/discovery.js';
import { ack, handle, normalize } from './core/hub.js';
import * as registry from './core/registry.js';
import { lambda } from './runtimes/lambda.js';
import type { Neighbor } from './core/types.js';

/** Rebuilds the neighbor list from an environment-shaped object. */
export const fromEnv = (source: unknown, vocab: Vocabulary = registry.vocabulary()): Neighbor[] =>
	discover(source, vocab);

/**
 * Reads the neighbor list from a platform that hands over live objects instead of identifiers —
 * Cloudflare Workers bindings. The same function: only the type of the value differs, which is
 * the whole point of the grammar in CONTRACT.md §4.
 */
export const fromBindings = fromEnv;

export const hub = { handle, normalize, ack, lambda, fromEnv, fromBindings };

export { register } from './core/registry.js';
export { open, read, advance, seal, DEFAULT_HOPS } from './core/envelope.js';
export { discover, parseName, displayName, COMMON_KEYS, toEnvType } from './core/discovery.js';
export { Trail } from './core/report.js';
export { handle, normalize, ack, lambda };

export type {
	Arrival,
	Capability,
	Ctx,
	Discovery,
	Envelope,
	Hop,
	Ingress,
	Item,
	Neighbor,
	Report,
	ResourceModule,
	Sender,
} from './core/types.js';
export type { Vocabulary, ParsedName } from './core/discovery.js';
