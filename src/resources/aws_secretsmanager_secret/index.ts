import { seal } from '../../core/envelope.js';
import { register } from '../../core/registry.js';
import * as aws from '../../providers/aws.js';

register({
	type: 'aws_secretsmanager_secret',
	keys: ['SECRET_ARN'],
	capabilities: ['secret'],

	/**
	 * Writes the message as the secret's current value.
	 *
	 * Same reasoning as the parameter store: the wire leaving a workload is that workload's runtime
	 * permission, and a destination that is only ever read produces a report line indistinguishable
	 * from one that received something.
	 *
	 * Secrets Manager has no overwrite. `PutSecretValue` adds a version and moves the `AWSCURRENT`
	 * label onto it, which from the reader's side is the same outcome — a read returns the last
	 * write — with the previous value kept as `AWSPREVIOUS` because that is the service's model and
	 * not a choice available here.
	 *
	 * `ClientRequestToken` is minted per call. The SDKs fill it in and the raw API does not, and
	 * without it the service's idempotency check cannot tell two writes of the same message apart.
	 *
	 * Nothing about the value reaches the log or the report — the same rule as when this read, for
	 * the same reason: a tool that prints what lives in a secret store is one nobody may run.
	 */
	async send(n, envelope, ctx) {
		const id = n.props['SECRET_ARN'] ?? n.props['ARN'] ?? n.props['NAME'];
		if (!id) throw new Error('no secret identifier on the wire');

		const region = ctx.region(n);
		if (!region) throw new Error('no region for the secret and none for the workload');

		await aws.json(
			'secretsmanager',
			region,
			'secretsmanager.PutSecretValue',
			{ SecretId: id, SecretString: seal(envelope), ClientRequestToken: crypto.randomUUID() },
			ctx.fetch
		);
	},
});
