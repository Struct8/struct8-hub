import { seal } from '../../core/envelope.js';
import { register } from '../../core/registry.js';
import * as google from '../../providers/google.js';

register({
	type: 'google_cloud_run_v2_service',
	capabilities: ['http'],

	/**
	 * A POST of the sealed envelope to the service's URL, with an identity token for it. The
	 * connection's grant label gives the caller Cloud Run Invoker on the service. A public service
	 * accepts the token as well, so one sender serves both.
	 */
	async send(n, envelope, ctx) {
		const url = n.props['URL'];
		if (!url) {
			throw new Error('no service URL on the wire: the service is in another state, or the compile did not export it');
		}
		await google.invoke(url, seal(envelope), `POST ${n.props['NAME'] ?? url}`, ctx.fetch, ctx.trace);
	},
});
