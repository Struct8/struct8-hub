import { register } from '../../core/registry.js';
import type { Arrival } from '../../core/types.js';

interface EdgeRecord {
	readonly cf?: {
		readonly config?: { readonly distributionId?: string; readonly eventType?: string };
		readonly request?: { readonly method?: string; readonly uri?: string };
	};
}

register({
	type: 'aws_cloudfront_distribution',
	capabilities: ['http'],

	/**
	 * Receive only, for Lambda@Edge.
	 *
	 * Two things about this source are unlike the others, and both are limits rather than choices.
	 *
	 * The function runs in whichever edge location served the request, not in the region the
	 * diagram drew, so every destination it forwards to is a cross-region call. Expect the report
	 * to show slower hops than the same wire would in a regional function.
	 *
	 * Lambda@Edge also forbids environment variables entirely. This receiver works, but a hub
	 * deployed *as* an edge function discovers no neighbours at all — the wiring contract has no
	 * way to reach it. Reading a CloudFront event in an ordinary regional function is the case
	 * that works.
	 */
	receive(raw): Arrival | null {
		const cf = (raw as { Records?: EdgeRecord[] } | null)?.Records?.[0]?.cf;
		if (!cf?.config) return null;

		const { distributionId = '?', eventType = '?' } = cf.config;
		const request = cf.request;

		return {
			origin: 'aws:cloudfront',
			describe: `CloudFront ${eventType} on ${distributionId}`,
			items: [{ body: `${request?.method ?? '?'} ${request?.uri ?? '/'}` }],
		};
	},
});
