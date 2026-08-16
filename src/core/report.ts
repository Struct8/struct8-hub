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
import type { Hop, Neighbor, Report } from './types.js';

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

	#push(neighbor: Neighbor, started: number, ok: boolean, err?: string): void {
		this.#hops.push({
			n: this.#hops.length + 1,
			to: displayName(neighbor),
			type: neighbor.type,
			label: neighbor.label,
			ok,
			ms: this.now() - started,
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
		};
	}
}
