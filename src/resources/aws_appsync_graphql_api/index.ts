import { seal } from '../../core/envelope.js';
import { register } from '../../core/registry.js';
import * as aws from '../../providers/aws.js';

/**
 * An introspection query.
 *
 * Nothing on the wire says what this API's schema looks like, so there is no mutation that could
 * be written blind. Introspection is the one request every GraphQL endpoint answers, which makes
 * it the honest way to prove the wire: the host resolved, the signature was accepted, the API is
 * there. It does not prove a write, and the report should not be read as if it did.
 */
const PROBE = '{ __schema { queryType { name } } }';

register({
	type: 'aws_appsync_graphql_api',
	capabilities: ['http'],

	async send(n, envelope, ctx) {
		const url = n.props['URL'] ?? n.props['ENDPOINT'];
		if (!url) throw new Error('no GraphQL URL on the wire');

		const region = ctx.region(n);
		if (!region) throw new Error('no region for the API and none for the workload');

		// Signed for IAM authorisation, which is the mode the generator wires. An API on API keys
		// or Cognito answers 401 here, and the report names it — a clear refusal beats a silent
		// wrong assumption.
		await aws.rest(
			url,
			'appsync',
			region,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ query: PROBE, variables: { trace: envelope.trace } }),
			},
			'appsync:GraphQL',
			ctx.fetch
		);
	},
});
