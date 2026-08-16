import { register } from '../../core/registry.js';
import * as aws from '../../providers/aws.js';

register({
	type: 'aws_secretsmanager_secret',
	keys: ['SECRET_ARN'],
	capabilities: ['secret'],

	/**
	 * Reads, and deliberately does not report what it read.
	 *
	 * Same reasoning as the parameter store — the generated policy grants `GetSecretValue` and
	 * nothing that writes — with one difference that matters: the value is a secret. The report
	 * says the wire works and how long it took. It does not say what came back, and neither does
	 * the log. A test tool that prints credentials into CloudWatch is a test tool nobody is
	 * allowed to run.
	 */
	async send(n, _envelope, ctx) {
		const id = n.props['SECRET_ARN'] ?? n.props['ARN'] ?? n.props['NAME'];
		if (!id) throw new Error('no secret identifier on the wire');

		const region = ctx.region(n);
		if (!region) throw new Error('no region for the secret and none for the workload');

		const response = (await aws.json(
			'secretsmanager',
			region,
			'secretsmanager.GetSecretValue',
			{ SecretId: id },
			ctx.fetch
		)) as { SecretString?: string; SecretBinary?: string } | null;

		const size = (response?.SecretString ?? response?.SecretBinary ?? '').length;
		console.log(`[secretsmanager] ${n.props['NAME'] ?? id} read, ${size} bytes (value not logged)`);
	},
});
