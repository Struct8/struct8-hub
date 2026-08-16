import { seal } from '../../core/envelope.js';
import { register } from '../../core/registry.js';
import * as aws from '../../providers/aws.js';
import type { Arrival, Item } from '../../core/types.js';

interface SqsRecord {
	readonly eventSource?: string;
	readonly eventSourceARN?: string;
	readonly messageId?: string;
	readonly body?: string;
}

register({
	type: 'aws_sqs_queue',
	keys: ['QUEUE_URL'],
	capabilities: ['queue'],

	async send(n, envelope, ctx) {
		const region = ctx.region(n);
		if (!region) throw new Error('no region for the queue and none for the workload');

		// Composed from the parts rather than resolved through the API. The policy the generator
		// writes for a queue wire grants SendMessage, ReceiveMessage, DeleteMessage and
		// GetQueueAttributes — it does not grant GetQueueUrl, so asking AWS to resolve the name
		// would fail on permission in every diagram that has not been edited by hand.
		const url =
			n.props['QUEUE_URL'] ??
			n.props['URL'] ??
			`https://sqs.${region}.amazonaws.com/${ctx.account(n) ?? ''}/${n.props['NAME'] ?? ''}`;

		await aws.json(
			'sqs',
			region,
			'AmazonSQS.SendMessage',
			{ QueueUrl: url, MessageBody: seal(envelope) },
			ctx.fetch
		);
	},

	receive(raw): Arrival | null {
		const records = (raw as { Records?: SqsRecord[] } | null)?.Records;
		if (!Array.isArray(records) || records[0]?.eventSource !== 'aws:sqs') return null;

		const queue = records[0]?.eventSourceARN?.split(':').pop() ?? '?';
		const items: Item[] = records.map((r) => ({
			// Present because a queue accepts a partial-batch report: without the id, one failed
			// message forces the whole batch to be redelivered.
			...(r.messageId === undefined ? {} : { id: r.messageId }),
			body: r.body ?? '',
		}));

		return { origin: 'aws:sqs', describe: `SQS ${queue} (${items.length} record(s))`, items };
	},
});
