import { seal } from '../../core/envelope.js';
import { register } from '../../core/registry.js';
import * as aws from '../../providers/aws.js';

register({
	type: 'aws_kinesis_firehose_delivery_stream',
	capabilities: ['stream'],

	async send(n, envelope, ctx) {
		const stream = n.props['NAME'];
		if (!stream) throw new Error('no delivery stream name on the wire');

		const region = ctx.region(n);
		if (!region) throw new Error('no region for the delivery stream and none for the workload');

		await aws.json(
			'firehose',
			region,
			'Firehose_20150804.PutRecord',
			{
				DeliveryStreamName: stream,
				// The trailing newline is what separates records inside the object Firehose
				// eventually writes to its destination. Without it the delivered file is one
				// concatenated line and nothing downstream can split it back apart.
				Record: { Data: aws.b64(seal(envelope) + '\n') },
			},
			ctx.fetch
		);
	},
});
