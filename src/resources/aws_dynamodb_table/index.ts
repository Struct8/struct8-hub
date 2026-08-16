import { seal } from '../../core/envelope.js';
import { register } from '../../core/registry.js';
import * as aws from '../../providers/aws.js';
import type { Arrival, Item } from '../../core/types.js';

interface StreamRecord {
	readonly eventSource?: string;
	readonly eventName?: string;
	readonly eventSourceARN?: string;
	readonly dynamodb?: { readonly SequenceNumber?: string; readonly Keys?: unknown };
}

/**
 * The partition key this writes under.
 *
 * Nothing on the wire says what a table's key is called, and asking would need
 * `dynamodb:DescribeTable`, which the generated policy does not grant. `ID` is the convention the
 * Struct8 templates use and what the predecessor assumed. A table keyed on anything else will
 * come back as ValidationException, which the report shows plainly — a wrong answer that says so
 * is better than a guess that silently writes nothing.
 */
const KEY = 'ID';

/** A day is long enough to inspect a test run and short enough not to accumulate. */
const TTL_SECONDS = 24 * 60 * 60;

register({
	type: 'aws_dynamodb_table',
	capabilities: ['table'],

	async send(n, envelope, ctx) {
		const table = n.props['NAME'];
		if (!table) throw new Error('no table name on the wire');

		const region = ctx.region(n);
		if (!region) throw new Error('no region for the table and none for the workload');

		const now = ctx.now();
		await aws.json(
			'dynamodb',
			region,
			'DynamoDB_20120810.PutItem',
			{
				TableName: table,
				Item: {
					[KEY]: { S: `${ctx.self}:${now.toISOString()}` },
					Message: { S: seal(envelope) },
					Trace: { S: envelope.trace },
					TTL: { N: String(Math.floor(now.getTime() / 1000) + TTL_SECONDS) },
				},
			},
			ctx.fetch
		);
	},

	receive(raw): Arrival | null {
		const records = (raw as { Records?: StreamRecord[] } | null)?.Records;
		if (!Array.isArray(records) || records[0]?.eventSource !== 'aws:dynamodb') return null;

		const arn = records[0]?.eventSourceARN ?? '';
		const table = arn.includes('/') ? arn.split('/')[1] : arn.split(':').pop();

		// Summarised rather than passed through whole. The raw change envelope is unreadable in a
		// test log, and what matters there is which operation touched which key — not the entire
		// before-and-after image of the item.
		const items: Item[] = records.map((r) => ({
			...(r.dynamodb?.SequenceNumber === undefined ? {} : { id: r.dynamodb.SequenceNumber }),
			body: `${r.eventName ?? '?'} on ${table ?? '?'}, key ${JSON.stringify(r.dynamodb?.Keys ?? {})}`,
		}));

		return {
			origin: 'aws:dynamodb',
			describe: `DynamoDB Stream ${table ?? '?'} (${items.length} record(s))`,
			items,
		};
	},
});
