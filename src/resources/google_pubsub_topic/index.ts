import { seal } from '../../core/envelope.js';
import { register } from '../../core/registry.js';
import { b64, unb64 } from '../../providers/base64.js';
import * as google from '../../providers/google.js';
import type { Arrival, Ctx, Neighbor } from '../../core/types.js';

/**
 * What a push subscription POSTs, and what an Eventarc trigger on a topic delivers to a function
 * over HTTP: the same body in both cases.
 * https://docs.cloud.google.com/pubsub/docs/push#receive_push
 */
interface PushBody {
	readonly message?: {
		readonly data?: string;
		readonly messageId?: string;
		readonly message_id?: string;
		readonly attributes?: Record<string, string>;
	};
	readonly subscription?: string;
	/** Present only when the subscription has a dead-letter topic. */
	readonly deliveryAttempt?: number;
}

/** `projects/<project>/topics/<topic>`, from the wire's name or from a full path already on it. */
function topicPath(n: Neighbor, ctx: Ctx): string {
	const name = n.props['NAME'];
	if (!name) throw new Error('no topic name on the wire');
	if (name.startsWith('projects/')) return name;
	return `projects/${google.projectOf(ctx.account(n), 'topic')}/topics/${name}`;
}

register({
	type: 'google_pubsub_topic',
	capabilities: ['topic'],

	async send(n, envelope, ctx) {
		const path = topicPath(n, ctx);
		const res = await google.api(
			`https://pubsub.googleapis.com/v1/${path}:publish`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ messages: [{ data: b64(seal(envelope)) }] }),
			},
			'pubsub.topics.publish',
			ctx.fetch
		);
		// The answer lists one id per message published. An empty list is a publish that did not
		// happen, whatever the status said.
		const answer = (await res.json().catch(() => null)) as { messageIds?: unknown[] } | null;
		if (answer && Array.isArray(answer.messageIds) && answer.messageIds.length === 0) {
			throw new Error(`Pub/Sub accepted the request to ${path} and published nothing`);
		}
	},

	receive(raw): Arrival | null {
		const body = raw as PushBody | null;
		const message = body?.message;
		if (!message || typeof message !== 'object' || typeof body?.subscription !== 'string') return null;

		const id = message.messageId ?? message.message_id;
		let text = '';
		try {
			text = message.data ? unb64(message.data) : '';
		} catch {
			text = `message ${id ?? '?'} (data is not base64)`;
		}
		const attempt = Number(body.deliveryAttempt);
		const subscription = body.subscription.split('/').pop() ?? body.subscription;

		return {
			origin: 'gcp:pubsub',
			describe: `Pub/Sub ${subscription} (1 message)`,
			items: [
				{
					// The id is what lets a failed hop fail the request, so Pub/Sub delivers the
					// message again (runtimes/cloudfunctions.ts).
					...(id === undefined ? {} : { id }),
					body: text,
					...(Number.isInteger(attempt) && attempt > 0 ? { attempt } : {}),
				},
			],
		};
	},
});
