import { seal, traceHeader } from '../../core/envelope.js';
import { register } from '../../core/registry.js';
import * as aws from '../../providers/aws.js';

/**
 * Who the event says it came from, and what it says it is.
 *
 * `Source` and `DetailType` are required by PutEvents and the contract carries neither — the same
 * situation the table's partition key is in. Constants, so that one rule matches everything this
 * publishes: `{"source": ["struct8.hub"]}`. The workload's own name is not lost by fixing them;
 * it travels in the detail, where the envelope's `path` already records every hop.
 *
 * A rule written against some other source will never fire, and nothing reports that: an event no
 * rule matches is accepted and dropped. The hop here claims the event was published, which is the
 * whole of what the publisher can honestly know.
 */
const SOURCE = 'struct8.hub';
const DETAIL_TYPE = 'Hub Message';

interface PutEventsAnswer {
	readonly FailedEntryCount?: number;
	readonly Entries?: { readonly ErrorCode?: string; readonly ErrorMessage?: string }[];
}

register({
	type: 'aws_cloudwatch_event_bus',
	capabilities: ['topic'],

	/**
	 * Send only, and the mirror of the rule next door: a bus is where events are published, a rule
	 * is how they come back out. `aws_cloudwatch_event_rule` receives and never sends; this one
	 * sends and never receives.
	 */
	async send(n, envelope, ctx) {
		// ARN before NAME: a bus in another account or another region can only be addressed by ARN,
		// and that is the case where the generator emits one.
		//
		// A bus that does not exist is NOT an error. Measured against the live API on 2026-09-26:
		// PutEvents answers `FailedEntryCount: 0` with an EventId and the event is dropped. So the
		// name has to come from the wire, which is the diagram's own, and never from a guess here.
		const bus = n.props['ARN'] ?? n.props['NAME'];
		if (!bus) throw new Error('no bus name and no bus ARN on the wire');

		const region = ctx.region(n);
		if (!region) throw new Error('no region for the bus and none for the workload');

		const answer = (await aws.json(
			'events',
			region,
			'AWSEvents.PutEvents',
			{
				Entries: [
					{
						EventBusName: bus,
						Source: SOURCE,
						DetailType: DETAIL_TYPE,
						// The sealed envelope IS the detail, so the chain survives the bus: a rule
						// hands its target the detail as an object, the Hub on the other side
						// serializes it back, and the marker, the trace and the remaining hops are
						// all still in it.
						Detail: seal(envelope),
						// EventBridge's equivalent of the queue's system attribute, and it matters for
						// the same reason: the publisher and the rule's target never speak to each
						// other, so no HTTP header can carry the trace across. Absent when nothing is
						// being recorded.
						...(ctx.trace === undefined ? {} : { TraceHeader: traceHeader(ctx.trace) }),
					},
				],
			},
			ctx.fetch
		)) as PutEventsAnswer | null;

		// A REJECTED ENTRY DOES NOT FAIL THE REQUEST. Measured the same day: a malformed detail, or
		// a missing Source, answers HTTP 200 with `FailedEntryCount: 1` and the reason inside the
		// body. A sender that reads only the status code reports a delivered hop for an event that
		// was never published — the silence this package exists to remove, in its own transport.
		// Same shape as PutTraceSegments, and read here for the same reason.
		const rejected = answer?.Entries?.find((e) => e.ErrorCode);
		if (rejected || answer?.FailedEntryCount) {
			throw new Error(
				`${rejected?.ErrorCode ?? 'rejected'}: ${rejected?.ErrorMessage ?? 'the bus rejected the event'}`
			);
		}
	},
});
