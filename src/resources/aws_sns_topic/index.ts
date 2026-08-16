import { seal } from '../../core/envelope.js';
import { register } from '../../core/registry.js';
import * as aws from '../../providers/aws.js';
import type { Arrival } from '../../core/types.js';

interface SnsRecord {
	readonly Sns?: { readonly TopicArn?: string; readonly Message?: string };
}

register({
	type: 'aws_sns_topic',
	capabilities: ['topic'],

	async send(n, envelope, ctx) {
		const region = ctx.region(n);
		if (!region) throw new Error('no region for the topic and none for the workload');

		// Same reasoning as the queue: the generated policy grants sns:Publish and nothing else,
		// so the ARN is composed rather than looked up.
		const arn =
			n.props['ARN'] ?? `arn:aws:sns:${region}:${ctx.account(n) ?? ''}:${n.props['NAME'] ?? ''}`;

		await aws.query(
			'sns',
			region,
			{ Action: 'Publish', Version: '2010-03-31', TopicArn: arn, Message: seal(envelope) },
			ctx.fetch
		);
	},

	receive(raw): Arrival | null {
		const records = (raw as { Records?: SnsRecord[] } | null)?.Records;
		const sns = Array.isArray(records) ? records[0]?.Sns : undefined;
		if (!sns) return null;

		const topic = sns.TopicArn?.split(':').pop() ?? '?';

		// SNS delivers one notification per invocation, so there is no id to report against and
		// no partial-batch contract to honour.
		return {
			origin: 'aws:sns',
			describe: `SNS ${topic}`,
			items: [{ body: sns.Message ?? '' }],
		};
	},
});
