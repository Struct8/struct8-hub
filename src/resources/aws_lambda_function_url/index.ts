import { seal } from '../../core/envelope.js';
import { register } from '../../core/registry.js';
import * as aws from '../../providers/aws.js';
import type { Arrival } from '../../core/types.js';

interface HttpEvent {
	readonly body?: string;
	readonly isBase64Encoded?: boolean;
	readonly requestContext?: {
		readonly domainName?: string;
		readonly http?: { readonly method?: string; readonly path?: string };
	};
}

register({
	type: 'aws_lambda_function_url',
	capabilities: ['http'],

	async send(n, envelope, ctx) {
		const url = n.props['URL'] ?? n.props['ENDPOINT'];
		if (!url) throw new Error('no URL on the wire for the function URL');

		const region = ctx.region(n);
		if (!region) throw new Error('no region for the function URL and none for the workload');

		// Signed even though the URL may be public. A function URL with AuthType NONE ignores the
		// Authorization header, and one with AWS_IAM requires it — signing always is correct for
		// both, and nothing on the wire tells us which of the two this is.
		await aws.rest(
			url,
			'lambda',
			region,
			{ method: 'POST', headers: { 'content-type': 'application/json' }, body: seal(envelope) },
			'lambda function URL',
			ctx.fetch
		);
	},

	receive(raw): Arrival | null {
		const event = raw as HttpEvent | null;
		const domain = event?.requestContext?.domainName;
		if (!domain?.includes('.lambda-url.')) return null;

		const http = event?.requestContext?.http;
		const body = event?.isBase64Encoded ? aws.unb64(event.body ?? '') : (event?.body ?? '');

		return {
			origin: 'aws:lambda_url',
			describe: `function URL ${http?.method ?? '?'} ${http?.path ?? '/'}`,
			items: [{ body }],
		};
	},
});
