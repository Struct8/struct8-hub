import { seal, traceHeader } from '../../core/envelope.js';
import { register } from '../../core/registry.js';
import * as aws from '../../providers/aws.js';
import type { Arrival, Batch, Ctx, Item, Neighbor } from '../../core/types.js';

interface SqsRecord {
	readonly eventSource?: string;
	readonly eventSourceARN?: string;
	readonly messageId?: string;
	readonly body?: string;
}

interface SqsMessage {
	readonly MessageId?: string;
	readonly ReceiptHandle?: string;
	readonly Body?: string;
}

/** The largest a single ReceiveMessage may ask for. */
const BATCH = 10;

/**
 * The longest AWS will hold a receive open.
 *
 * At zero, an empty queue answers instantly and the caller's loop asks again immediately — a
 * consumer that costs money and CPU to do nothing. Twenty turns an idle task into roughly three
 * requests a minute.
 */
const WAIT_SECONDS = 20;

/**
 * The queue's address, composed from the parts rather than resolved through the API.
 *
 * The policy the generator writes for a queue wire grants SendMessage, ReceiveMessage,
 * DeleteMessage and GetQueueAttributes — it does not grant GetQueueUrl, so asking AWS to resolve
 * the name would fail on permission in every diagram that has not been edited by hand.
 *
 * Composing needs every part. Falling back to an empty name builds a URL that is a valid string
 * and a nonsense address, and the failure then arrives from AWS as something about a queue that
 * does not exist — a long way from "the wire carried no name".
 */
function queueUrl(n: Neighbor, ctx: Ctx, region: string): string {
	const given = n.props['QUEUE_URL'] ?? n.props['URL'];
	if (given) return given;

	const name = n.props['NAME'];
	const account = ctx.account(n);
	if (!name) throw new Error('no queue name and no queue URL on the wire');
	if (!account) throw new Error(`no account for queue ${name}, and none for the workload`);
	return `https://sqs.${region}.amazonaws.com/${account}/${name}`;
}

function regionFor(n: Neighbor, ctx: Ctx): string {
	const region = ctx.region(n);
	if (!region) throw new Error('no region for the queue and none for the workload');
	return region;
}

register({
	type: 'aws_sqs_queue',
	keys: ['QUEUE_URL'],
	capabilities: ['queue'],

	async send(n, envelope, ctx) {
		const region = regionFor(n, ctx);
		await aws.json(
			'sqs',
			region,
			'AmazonSQS.SendMessage',
			{
				QueueUrl: queueUrl(n, ctx, region),
				MessageBody: seal(envelope),
				// A SYSTEM attribute, and the only one SQS defines. It is what a consumer inherits the
				// trace from — a Lambda event source mapping reads it and opens its invocation under
				// the same trace, which is the one hop no HTTP header can carry, because the sender and
				// the consumer never speak to each other. Absent when nothing is being recorded, so a
				// queue that is not traced is sent exactly the request it was sent before.
				...(ctx.trace === undefined
					? {}
					: {
							MessageSystemAttributes: {
								AWSTraceHeader: { DataType: 'String', StringValue: traceHeader(ctx.trace) },
							},
						}),
			},
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

	/**
	 * Reads the queue directly, for a runtime AWS does not poll on its behalf.
	 *
	 * This is the same work the Lambda event source mapping does invisibly. Nothing here is new
	 * behaviour — it is the half of the queue that Lambda hid.
	 */
	async consume(n, ctx): Promise<Batch> {
		const region = regionFor(n, ctx);
		const url = queueUrl(n, ctx, region);

		const answer = (await aws.json(
			'sqs',
			region,
			'AmazonSQS.ReceiveMessage',
			{ QueueUrl: url, MaxNumberOfMessages: BATCH, WaitTimeSeconds: WAIT_SECONDS },
			ctx.fetch
		)) as { Messages?: SqsMessage[] } | null;

		// The receipt handle never leaves this closure. It is not the message id, it changes on
		// every receive, and nothing outside this module has any use for it.
		const handles = new Map<string, string>();
		const items: Item[] = [];

		for (const message of answer?.Messages ?? []) {
			// A message with no id cannot be acknowledged individually, and acknowledging the batch
			// as a whole would delete it whether or not it was forwarded. Left on the queue instead,
			// where the visibility timeout returns it.
			if (message.MessageId === undefined || message.ReceiptHandle === undefined) continue;
			handles.set(message.MessageId, message.ReceiptHandle);
			items.push({ id: message.MessageId, body: message.Body ?? '' });
		}

		const name = n.props['NAME'] ?? url.split('/').pop() ?? '?';

		return {
			origin: 'aws:sqs',
			describe: `SQS ${name} (${items.length} message(s), polled)`,
			items,

			async ack(delivered) {
				const entries = delivered
					.map((item) => {
						const handle = item.id === undefined ? undefined : handles.get(item.id);
						return handle === undefined ? undefined : { Id: item.id as string, ReceiptHandle: handle };
					})
					.filter((entry): entry is { Id: string; ReceiptHandle: string } => entry !== undefined);

				if (entries.length === 0) return;

				await aws.json(
					'sqs',
					region,
					'AmazonSQS.DeleteMessageBatch',
					{ QueueUrl: url, Entries: entries },
					ctx.fetch
				);
			},
		};
	},
});
