import { seal } from '../../core/envelope.js';
import { register } from '../../core/registry.js';
import * as google from '../../providers/google.js';

register({
	type: 'google_cloudfunctions2_function',
	capabilities: ['function'],

	/**
	 * A POST of the sealed envelope to the function's URL, with an identity token for it. The
	 * connection's grant label gives the caller Cloud Run Invoker on the function's service, which
	 * is what Google checks. A Hub on the other side reads the envelope and continues the chain.
	 */
	async send(n, envelope, ctx) {
		const url = n.props['URL'];
		if (!url) {
			throw new Error('no function URL on the wire: the function is in another state, or the compile did not export it');
		}
		await google.invoke(url, seal(envelope), `invoke ${n.props['NAME'] ?? url}`, ctx.fetch);
	},
});
