/**
 * The custom event bus, on the wire.
 *
 * A workload could not publish to one until 2026-09-26: no connection in the catalog went from a
 * compute node to `aws_cloudwatch_event_bus`, so no variable was emitted and there was nothing to
 * discover. The catalog opened that wire — it grants `events:PutEvents` on the bus ARN and writes
 * `AWS_CLOUDWATCH_EVENT_BUS_NAME_<label>` into the environment — and this is the other half.
 *
 * What is locked here is the part of PutEvents that no fake transport can teach you, measured
 * against the live API on 2026-09-26:
 *
 *   * A REJECTED ENTRY ANSWERS HTTP 200. A malformed detail comes back `FailedEntryCount: 1` with
 *     the reason in the body, so a sender that reads the status code alone reports a delivered hop
 *     for an event that was never published.
 *   * A BUS THAT DOES NOT EXIST ANSWERS SUCCESS, with an EventId, and the event is dropped. There
 *     is nothing to assert about that and it is why the bus is never named from a guess here — the
 *     name comes off the wire, which is the diagram's own.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../dist/resources/aws_cloudwatch_event_bus/index.js';
import '../dist/resources/aws_cloudwatch_event_rule/index.js';
import * as registry from '../dist/core/registry.js';
import * as aws from '../dist/providers/aws.js';
import { open, read } from '../dist/core/envelope.js';
import type { Ctx, Neighbor } from '../dist/core/types.js';

aws.credentials({
	accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
	secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
});

interface Entry {
	readonly EventBusName?: string;
	readonly Source?: string;
	readonly DetailType?: string;
	readonly Detail?: string;
	readonly TraceHeader?: string;
}

interface Call {
	readonly target: string;
	readonly contentType: string;
	readonly host: string;
	readonly entries: Entry[];
}

/** Captures the request instead of sending it. `answer` is what PutEvents replies. */
function capture(answer: unknown = {}) {
	const seen: Call[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		const body = (await request.text()) || '{}';
		seen.push({
			target: request.headers.get('x-amz-target') ?? '',
			contentType: request.headers.get('content-type') ?? '',
			host: new URL(request.url).host,
			entries: (JSON.parse(body) as { Entries?: Entry[] }).Entries ?? [],
		});
		return new Response(JSON.stringify(answer), { status: 200 });
	};
	return { seen, fetchImpl };
}

const contextWith = (fetchImpl: typeof fetch, trace?: Ctx['trace']): Ctx => ({
	self: 'event-publisher',
	fetch: fetchImpl,
	region: () => 'us-east-1',
	account: () => '111122223333',
	now: () => new Date(0),
	...(trace === undefined ? {} : { trace }),
});

const ENVELOPE = open('the message', 'event-publisher', {
	trace: '1-68d70000-0123456789abcdef01234567',
	at: '2026-09-26T00:00:00.000Z',
});

const BUS: Neighbor = { type: 'aws_cloudwatch_event_bus', label: '0', props: { NAME: 'tour-bus' } };

const publish = () => {
	const send = registry.get('aws_cloudwatch_event_bus')?.send;
	assert.ok(send, 'the bus declares no sender');
	return send;
};

test('the event goes to the bus the wire names, as PutEvents', async () => {
	const { seen, fetchImpl } = capture();

	await publish()(BUS, ENVELOPE, contextWith(fetchImpl));

	assert.equal(seen[0]?.target, 'AWSEvents.PutEvents');
	// Measured, not read off a page: the wrong dialect is a bare 404 that says nothing about
	// content types, so it reads as a broken endpoint.
	assert.equal(seen[0]?.contentType, 'application/x-amz-json-1.1');
	assert.equal(seen[0]?.host, 'events.us-east-1.amazonaws.com');
	assert.equal(seen[0]?.entries[0]?.EventBusName, 'tour-bus');
});

test('the event says who published it, because PutEvents requires both', async () => {
	// Source and DetailType are required and the contract carries neither. Constants, so that one
	// rule on the bus matches everything Hub publishes from any workload.
	const { seen, fetchImpl } = capture();

	await publish()(BUS, ENVELOPE, contextWith(fetchImpl));

	assert.equal(seen[0]?.entries[0]?.Source, 'struct8.hub');
	assert.equal(seen[0]?.entries[0]?.DetailType, 'Hub Message');
});

test('the detail is the envelope, so the chain survives the bus', async () => {
	const { seen, fetchImpl } = capture();

	await publish()(BUS, ENVELOPE, contextWith(fetchImpl));

	const carried = read(String(seen[0]?.entries[0]?.Detail));
	assert.equal(carried?.trace, '1-68d70000-0123456789abcdef01234567');
	assert.equal(carried?.body, 'the message');
});

test('the round trip closes: what the rule delivers is still an envelope', async () => {
	// The bus is only half a hop. EventBridge hands the rule's target the detail as an OBJECT, and
	// the Hub on the other side has to find the marker, the trace and the remaining budget in it —
	// otherwise the next workload starts a fresh chain with a full budget, which is a loop that
	// does not terminate.
	const { seen, fetchImpl } = capture();
	await publish()(BUS, ENVELOPE, contextWith(fetchImpl));

	const receive = registry.get('aws_cloudwatch_event_rule')?.receive;
	assert.ok(receive, 'the rule declares no receiver');

	const arrival = await receive({
		source: 'struct8.hub',
		'detail-type': 'Hub Message',
		detail: JSON.parse(String(seen[0]?.entries[0]?.Detail)),
		resources: ['arn:aws:events:us-east-1:111122223333:rule/tour-bus/rule-event-pattern'],
	});

	assert.ok(arrival, 'the rule did not claim an event published by the bus');
	const carried = read(arrival.items[0]?.body ?? '');
	assert.equal(carried?.trace, '1-68d70000-0123456789abcdef01234567');
	assert.equal(carried?.body, 'the message');
	// One hop spent by the publisher, and the budget the next workload inherits.
	assert.equal(carried?.hops, ENVELOPE.hops);
});

test('an entry the bus rejected is a failed hop, however green the status code was', async () => {
	// HTTP 200, FailedEntryCount 1. This is the exact answer the live API gives a malformed detail,
	// and reading only the status code would report the wire as working.
	const { fetchImpl } = capture({
		FailedEntryCount: 1,
		Entries: [{ ErrorCode: 'MalformedDetail', ErrorMessage: 'Detail is malformed.' }],
	});

	await assert.rejects(() => publish()(BUS, ENVELOPE, contextWith(fetchImpl)), /MalformedDetail/);
});

test('the ARN identifies the bus when the wire carries one', async () => {
	// A bus in another account or region can only be addressed by ARN.
	const { seen, fetchImpl } = capture();
	const crossAccount: Neighbor = {
		type: 'aws_cloudwatch_event_bus',
		label: 'AUDIT',
		props: {
			NAME: 'tour-bus',
			ARN: 'arn:aws:events:us-east-1:999988887777:event-bus/tour-bus',
		},
	};

	await publish()(crossAccount, ENVELOPE, contextWith(fetchImpl));

	assert.match(String(seen[0]?.entries[0]?.EventBusName), /^arn:aws:events:/);
});

test('a wire with neither name nor ARN is refused, not composed', async () => {
	const { fetchImpl } = capture();
	const bare: Neighbor = { type: 'aws_cloudwatch_event_bus', label: '0', props: {} };

	await assert.rejects(() => publish()(bare, ENVELOPE, contextWith(fetchImpl)), /no bus name/);
});

test('the trace travels on the entry when the run is being recorded, and only then', async () => {
	// The publisher and the rule's target never speak to each other, so no HTTP header reaches
	// across. `TraceHeader` on the entry is EventBridge's equivalent of the queue's system
	// attribute.
	const recording = capture();
	await publish()(
		BUS,
		ENVELOPE,
		contextWith(recording.fetchImpl, {
			root: '1-68d70000-0123456789abcdef01234567',
			parent: '53995c3f42cd8ad8',
			sampled: true,
		})
	);
	assert.equal(
		recording.seen[0]?.entries[0]?.TraceHeader,
		'Root=1-68d70000-0123456789abcdef01234567;Parent=53995c3f42cd8ad8;Sampled=1'
	);

	const quiet = capture();
	await publish()(BUS, ENVELOPE, contextWith(quiet.fetchImpl));
	assert.ok(
		!('TraceHeader' in (quiet.seen[0]?.entries[0] ?? {})),
		'a run that is not recording sent a trace header anyway'
	);
});
