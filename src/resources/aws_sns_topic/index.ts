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

		// Same reasoning as the queue: the generated policy grants sns:Publish and nothing else, so
		// the ARN is composed rather than looked up — and composing needs every part. An ARN with
		// an empty topic segment is still a string, and the failure it produces says nothing about
		// the wire that was missing a name.
		let arn = n.props['ARN'];
		if (!arn) {
			const name = n.props['NAME'];
			const account = ctx.account(n);
			if (!name) throw new Error('no topic name and no topic ARN on the wire');
			if (!account) throw new Error(`no account for topic ${name}, and none for the workload`);
			arn = `arn:aws:sns:${region}:${account}:${name}`;
		}

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
