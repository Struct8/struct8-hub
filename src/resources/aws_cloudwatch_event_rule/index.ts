import { register } from '../../core/registry.js';
import type { Arrival } from '../../core/types.js';

interface EventBridgeEvent {
	readonly source?: string;
	readonly 'detail-type'?: string;
	readonly detail?: unknown;
	readonly time?: string;
	readonly resources?: string[];
}

register({
	type: 'aws_cloudwatch_event_rule',
	capabilities: ['topic'],

	/**
	 * Receive only. A rule is a way in — it delivers to the workload and is never a destination.
	 *
	 * Both shapes are accepted: a schedule, which carries no payload of its own and whose whole
	 * meaning is "the clock fired", and a pattern match, which carries the matched event.
	 */
	receive(raw): Arrival | null {
		const event = raw as EventBridgeEvent | null;
		if (typeof event?.source !== 'string' || typeof event['detail-type'] !== 'string') return null;

		const rule = event.resources?.[0]?.split('/').pop() ?? '?';
		const scheduled = event.source === 'aws.events' && event['detail-type'] === 'Scheduled Event';

		return {
			origin: 'aws.events',
			describe: `EventBridge ${rule} (${event['detail-type']})`,
			items: [
				{
					body: scheduled
						? `scheduled fire of ${rule} at ${event.time ?? 'unknown time'}`
						: JSON.stringify(event.detail ?? {}),
				},
			],
		};
	},
});
