import { isEnvelope, seal } from '../../core/envelope.js';
import { register } from '../../core/registry.js';
import * as aws from '../../providers/aws.js';
import type { Arrival } from '../../core/types.js';

register({
	type: 'aws_lambda_function',
	capabilities: ['function'],

	async send(n, envelope, ctx) {
		const name = n.props['NAME'];
		if (!name) throw new Error('no function name on the wire');

		const region = ctx.region(n);
		if (!region) throw new Error('no region for the function and none for the workload');

		await aws.rest(
			`${aws.endpoint('lambda', region)}/2015-03-31/functions/${encodeURIComponent(name)}/invocations`,
			'lambda',
			region,
			{
				method: 'POST',
				// Asynchronous on purpose. A synchronous invoke would hold this workload open for
				// the whole downstream chain, and a chain of four would time out before the report
				// could be written.
				headers: { 'x-amz-invocation-type': 'Event', 'content-type': 'application/json' },
				body: seal(envelope),
			},
			'lambda:InvokeFunction',
			ctx.fetch
		);
	},

	/**
	 * A hub invoked by another hub receives the envelope as the payload itself, already parsed.
	 * Recognising it here keeps the chain intact; falling through to the generic arrival would
	 * re-wrap it and reset the hop budget, and a cycle would then never terminate.
	 */
	receive(raw): Arrival | null {
		if (!isEnvelope(raw)) return null;
		return {
			origin: 'aws:lambda',
			describe: 'invoked by another workload',
			items: [{ body: JSON.stringify(raw) }],
		};
	},
});
