/**
 * What a destination that keeps messages stores of each one.
 *
 * The same fields wherever the message lands -- a row of `hub_messages` in a database, a document of
 * the `hub_messages` index in OpenSearch -- so that what two destinations kept can be compared field
 * by field, and a query written for one reads the other.
 *
 * The columns, and not `seal(envelope)`. Sealing is for a message that another Hub will read back,
 * so that the chain keeps its id and its remaining budget; nothing reads a stored record as a
 * message, and the same fields are here one by one, where they can be queried.
 */

import type { Ctx, Envelope } from '../core/types.js';

export interface MessageRecord {
	/**
	 * What identifies the message, as one value: the SHA-256 of `trace`, `path`, `receiver` and
	 * `digest`. A destination keyed by it stores a redelivery once.
	 */
	readonly id: string;
	/** The chain the message belongs to. */
	readonly trace: string;
	/** The workloads it passed through, joined by ` > `. */
	readonly path: string;
	/** The workload that stored it. */
	readonly receiver: string;
	/** The SHA-256 of the body: several items of one batch can share a trace and a path. */
	readonly digest: string;
	readonly hops: number;
	/** When the chain started, ISO 8601. */
	readonly sentAt: string;
	readonly body: string;
}

export const sha256 = async (text: string): Promise<string> =>
	[...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');

export async function recordOf(envelope: Envelope, ctx: Ctx): Promise<MessageRecord> {
	const trace = envelope.trace;
	const path = envelope.path.join(' > ');
	const receiver = ctx.self;
	const digest = await sha256(envelope.body);
	return {
		id: await sha256([trace, path, receiver, digest].join('\n')),
		trace,
		path,
		receiver,
		digest,
		hops: envelope.hops,
		sentAt: envelope.at,
		body: envelope.body,
	};
}
