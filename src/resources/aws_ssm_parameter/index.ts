import { seal } from '../../core/envelope.js';
import { register } from '../../core/registry.js';
import * as aws from '../../providers/aws.js';

register({
	type: 'aws_ssm_parameter',
	capabilities: ['parameter'],

	/**
	 * Writes the message, replacing whatever was there.
	 *
	 * A parameter is a destination like any other here: the wire leaving a workload for it is that
	 * workload's runtime permission, and an application keeping state in a parameter writes to it.
	 * The bucket beside it gets `PutObject` and the table gets `PutItem`; this one used to get
	 * reading alone, which produced a report line shaped exactly like theirs while nothing arrived.
	 *
	 * `Overwrite` rather than a version: a parameter holds one value, and a read returns the last
	 * write. Nothing accumulates.
	 *
	 * `Type` is deliberately absent. AWS requires it only for a parameter that does not exist yet,
	 * and sending it on an overwrite is how you get a refusal for changing the type of a
	 * `SecureString` somebody chose on purpose. A parameter drawn on the diagram exists; if it does
	 * not, AWS says exactly that and the report carries it.
	 *
	 * Standard-tier parameters cap at 4 KB, so a larger message is refused by AWS in its own words.
	 */
	async send(n, envelope, ctx) {
		const name = n.props['NAME'];
		if (!name) throw new Error('no parameter name on the wire');

		const region = ctx.region(n);
		if (!region) throw new Error('no region for the parameter and none for the workload');

		await aws.json(
			'ssm',
			region,
			'AmazonSSM.PutParameter',
			{ Name: name, Value: seal(envelope), Overwrite: true },
			ctx.fetch
		);
	},
});
