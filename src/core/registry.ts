/**
 * The registry.
 *
 * One folder per resource, each registering itself. The core never learns their names, and adding
 * a resource never edits anything here.
 *
 * The parser's vocabulary is *derived from this registry* rather than written down a second time.
 * That closes a failure mode by construction: a type listed in the vocabulary but with no way to
 * be reached parses fine, produces a neighbor, and then silently does nothing. Here, registering
 * a resource makes it discoverable and reachable in the same act, or the registration is refused.
 */

import { COMMON_KEYS, type Vocabulary } from './discovery.js';
import type { ResourceModule } from './types.js';

const modules = new Map<string, ResourceModule>();

/**
 * Adds a resource to the registry.
 *
 * @throws if the module is unusable — a bad type, or neither `send` nor `receive`. Failing at
 * load is deliberate: the alternative is a neighbor that can be discovered and never reached,
 * which looks like success from every angle except the one that matters.
 */
export function register(mod: ResourceModule): void {
	if (!mod.type || !/^[a-z][a-z0-9_]*$/.test(mod.type)) {
		throw new Error(`hub: invalid resource type ${JSON.stringify(mod.type)} (expected lowercase catalog type)`);
	}
	if (!mod.send && !mod.receive && !mod.consume) {
		throw new Error(`hub: resource ${mod.type} declares neither send nor receive nor consume; it could be discovered but never reached`);
	}

	const existing = modules.get(mod.type);
	if (existing && existing !== mod) {
		throw new Error(`hub: resource ${mod.type} is already registered`);
	}

	modules.set(mod.type, mod);
}

export const get = (type: string): ResourceModule | undefined => modules.get(type);

export const all = (): ResourceModule[] => [...modules.values()];

/** Every registered resource that can normalize an incoming event. */
export const receivers = (): ResourceModule[] => all().filter((m) => m.receive);

/** Every registered resource a runtime without a platform poller can read on demand. */
export const consumers = (): ResourceModule[] => all().filter((m) => m.consume);

/** The vocabulary the parser matches against, assembled from what is registered. */
export function vocabulary(): Vocabulary {
	const keys = new Set(COMMON_KEYS);
	for (const mod of modules.values()) for (const k of mod.keys ?? []) keys.add(k);
	return { types: [...modules.keys()], keys: [...keys] };
}

/** Test seam. Never call this from library or application code. */
export function reset(): void {
	modules.clear();
}
