/**
 * Failures on request, for the lessons that are about failure (educational, off by default).
 *
 * A dead-letter queue fills only when a consumer fails, and a Hub never does: it records a wire
 * that failed and carries on. That is what makes it useful everywhere else, and what makes it
 * useless for showing a redrive. With the switch on, a message can ask to fail.
 *
 * ONLY THE MESSAGE THAT ASKS FAILS. The rest of its batch is processed as always, which is what a
 * partial-batch report is for and what a lesson about one needs to show.
 *
 * The message asks in a `behavior` field of its own JSON:
 *
 *   ok             processed as always, the same as no field
 *   fail           fails at every delivery
 *   fail-times:N   fails while the source has delivered it N times or fewer, then is processed
 *   slow           outlasts the invocation, which fails everything that came with it
 *
 * Anything else in the field is ignored, and the message is processed.
 *
 * OFF unless the runtime turns it on, which on Lambda is `HUB_FAULTS` set to an on-ish value. A
 * function that fails because a message said so can be made to fail by anyone allowed to publish
 * to what feeds it, and that must not be the default in an account that never asked for it.
 *
 * The field is looked for through the layers a message gains on its way: the Hub's own envelope
 * (`body`), an SNS notification delivered to a queue (`Message`) and an EventBridge event
 * (`detail`). A message that crosses a topic into a queue and on to a function still says, at the
 * last hop, what it asked for at the first.
 */

/** What a message asked for. */
export type Directive =
	| { readonly kind: 'fail' }
	| { readonly kind: 'fail-times'; readonly times: number }
	| { readonly kind: 'slow' };

/** The fields a payload can be wrapped in on its way here, in the order they are tried. */
const LAYERS = ['body', 'Message', 'detail'] as const;

/**
 * How many levels to look through. SNS into a queue is five (the notification, its `Message`, the
 * envelope, its `body`, the payload); the limit only stops a payload nested on purpose from
 * walking the stack.
 */
const DEPTH = 12;

function find(value: unknown, depth: number): string | undefined {
	if (depth > DEPTH) return undefined;

	if (typeof value === 'string') {
		const text = value.trim();
		if (!text.startsWith('{')) return undefined;
		try {
			return find(JSON.parse(text), depth + 1);
		} catch {
			return undefined;
		}
	}

	if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;

	const fields = value as Record<string, unknown>;
	if (typeof fields['behavior'] === 'string') return fields['behavior'];

	for (const layer of LAYERS) {
		const found = find(fields[layer], depth + 1);
		if (found !== undefined) return found;
	}
	return undefined;
}

/** Reads what a message body asks for, or `null` when it asks for nothing this module knows. */
export function directive(body: string): Directive | null {
	const asked = find(body, 0)?.trim().toLowerCase();
	if (asked === 'fail') return { kind: 'fail' };
	if (asked === 'slow') return { kind: 'slow' };

	const times = /^fail-times:(\d+)$/.exec(asked ?? '');
	if (times) return { kind: 'fail-times', times: Number(times[1]) };

	return null;
}

/**
 * Whether this delivery fails.
 *
 * `fail-times` needs to know which delivery this is, and only a queue says: SQS counts receives,
 * and nothing else that invokes a function counts anything. Where the count is missing every
 * delivery reads as the first, so `fail-times` fails every time, like `fail`.
 */
export const fails = (asked: Directive, attempt: number | undefined): boolean =>
	asked.kind === 'fail' || (asked.kind === 'fail-times' && (attempt ?? 1) <= asked.times);

/** The directive as the message wrote it, for the report. */
export const spelled = (asked: Directive): string =>
	asked.kind === 'fail-times' ? `fail-times:${asked.times}` : asked.kind;
