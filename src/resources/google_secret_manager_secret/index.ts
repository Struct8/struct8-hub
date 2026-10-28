import { seal } from '../../core/envelope.js';
import { register } from '../../core/registry.js';
import { b64 } from '../../providers/base64.js';
import * as google from '../../providers/google.js';

register({
	type: 'google_secret_manager_secret',
	capabilities: ['secret'],

	/**
	 * Adds a version holding the message, as the AWS module puts a value into a Secrets Manager
	 * secret: a reader of the latest version reads the last message. The value is never logged and
	 * never put in the report.
	 *
	 * The connection's grant label is born with Secret Accessor, which reads. Adding a version
	 * needs Secret Version Adder (`secretmanager.versions.add`) on the label; without it the hop
	 * fails with PERMISSION_DENIED, naming that permission.
	 */
	async send(n, envelope, ctx) {
		const name = n.props['NAME'];
		if (!name) throw new Error('no secret id on the wire');

		const path = name.startsWith('projects/')
			? name
			: `projects/${google.projectOf(ctx.account(n), 'secret')}/secrets/${name}`;
		await google.api(
			`https://secretmanager.googleapis.com/v1/${path}:addVersion`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ payload: { data: b64(seal(envelope)) } }),
			},
			'secretmanager.versions.add',
			ctx.fetch
		);
	},
});
