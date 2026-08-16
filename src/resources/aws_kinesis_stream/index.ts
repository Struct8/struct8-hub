import { seal } from '../../core/envelope.js';
import { register } from '../../core/registry.js';
import * as aws from '../../providers/aws.js';
import type { Arrival, Item } from '../../core/types.js';

interface KinesisRecord {
	readonly eventSource?: string;
	readonly eventSourceARN?: string;
	readonly kinesis?: { readonly sequenceNumber?: string; readonly data?: string };
}

register({
	type: 'aws_kinesis_stream',
	capabilities: ['stream'],

	async send(n, envelope, ctx) {
		const stream = n.props['NAME'];
		if (!stream) throw new Error('no stream name on the wire');

		const region = ctx.region(n);
		if (!region) throw new Error('no region for the stream and none for the workload');

		await aws.json(
			'kinesis',
			region,
			'Kinesis_20131202.PutRecord',
			{
				StreamName: stream,
				// The JSON protocol carries Data base64-encoded; the SDKs hide this and hand-written
				// callers routinely forget it, which produces a record that reads back as garbage.
				Data: aws.b64(seal(envelope) + '\n'),
				// A fixed key keeps a test run in one shard and therefore in order. With several
				// shards and a varying key the records still arrive, just not in the order sent —
				// which looks like a bug when you are trying to prove a wire works.
				PartitionKey: ctx.self,
			},
			ctx.fetch
		);
	},

	receive(raw): Arrival | null {
		const records = (raw as { Records?: KinesisRecord[] } | null)?.Records;
		if (!Array.isArray(records) || records[0]?.eventSource !== 'aws:kinesis') return null;

		const arn = records[0]?.eventSourceARN ?? '';
		const stream = arn.includes('/') ? arn.split('/')[1] : arn.split(':').pop();

		const items: Item[] = records.map((r) => {
			let body: string;
			try {
				// Forwarding without decoding "works" and proves nothing: the next hop receives a
				// base64 string it has no reason to understand.
				body = aws.unb64(r.kinesis?.data ?? '').trimEnd();
			} catch {
				body = '<record is not valid base64>';
			}
			return {
				...(r.kinesis?.sequenceNumber === undefined ? {} : { id: r.kinesis.sequenceNumber }),
				body,
			};
		});

		return {
			origin: 'aws:kinesis',
			describe: `Kinesis ${stream ?? '?'} (${items.length} record(s))`,
			items,
		};
	},
});
