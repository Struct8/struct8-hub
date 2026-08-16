import { register } from '../../core/registry.js';
import * as aws from '../../providers/aws.js';

const LIMIT = 200;

register({
	type: 'aws_ssm_parameter',
	capabilities: ['parameter'],

	/**
	 * Reads, rather than writes.
	 *
	 * The policy the generator writes for this wire grants `GetParameter` and `GetParameters`. A
	 * `PutParameter` would fail on permission in every diagram nobody has edited by hand, so the
	 * wire is exercised the way it is actually allowed to be used. Reading still proves what
	 * matters: the parameter exists, the name resolved, and the permission is there.
	 */
	async send(n, _envelope, ctx) {
		const name = n.props['NAME'];
		if (!name) throw new Error('no parameter name on the wire');

		const region = ctx.region(n);
		if (!region) throw new Error('no region for the parameter and none for the workload');

		const response = (await aws.json(
			'ssm',
			region,
			'AmazonSSM.GetParameter',
			{ Name: name, WithDecryption: true },
			ctx.fetch
		)) as { Parameter?: { Value?: string } } | null;

		const value = response?.Parameter?.Value ?? '';
		console.log(
			`[ssm] ${name} = ${value.length > LIMIT ? value.slice(0, LIMIT) + '…' : value}`
		);
	},
});
