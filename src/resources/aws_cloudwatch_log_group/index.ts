import { seal } from '../../core/envelope.js';
import { register } from '../../core/registry.js';
import * as aws from '../../providers/aws.js';

/** Log streams the hub has already created, per cold start. */
const created = new Set<string>();

register({
	type: 'aws_cloudwatch_log_group',
	capabilities: ['stream'],

	async send(n, envelope, ctx) {
		const group = n.props['NAME'];
		if (!group) throw new Error('no log group name on the wire');

		const region = ctx.region(n);
		if (!region) throw new Error('no region for the log group and none for the workload');

		// One stream per workload, so a diagram with several hubs writing to the same group stays
		// readable instead of interleaving.
		const stream = ctx.self;
		const key = `${region}/${group}/${stream}`;

		if (!created.has(key)) {
			try {
				await aws.json('logs', region, 'Logs_20140328.CreateLogStream', { logGroupName: group, logStreamName: stream }, ctx.fetch);
			} catch (err) {
				// Already there is the expected answer on every invocation after the first, and on
				// every concurrent one. Anything else is a real failure and must surface.
				if (!/ResourceAlreadyExists/i.test(err instanceof Error ? err.message : String(err))) throw err;
			}
			created.add(key);
		}

		await aws.json(
			'logs',
			region,
			'Logs_20140328.PutLogEvents',
			{
				logGroupName: group,
				logStreamName: stream,
				logEvents: [{ timestamp: ctx.now().getTime(), message: seal(envelope) }],
			},
			ctx.fetch
		);
	},
});
