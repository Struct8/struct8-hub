import { seal } from '../../core/envelope.js';
import { register } from '../../core/registry.js';
import * as aws from '../../providers/aws.js';
import type { Arrival } from '../../core/types.js';

interface ElbEvent {
	readonly body?: string;
	readonly path?: string;
	readonly httpMethod?: string;
	readonly isBase64Encoded?: boolean;
	readonly requestContext?: { readonly elb?: { readonly targetGroupArn?: string } };
}

register({
	type: 'aws_lb',
	capabilities: ['http'],

	async send(n, envelope, ctx) {
		const host = n.props['URL'] ?? n.props['ENDPOINT'] ?? n.props['NAME'];
		if (!host) throw new Error('no DNS name on the wire for the load balancer');

		const url = /^https?:\/\//.test(host) ? host : `http://${host}/`;

		// Unsigned. Behind a load balancer sits somebody's application, not an AWS API — a
		// signature it never asked for is at best ignored and at worst rejected.
		await aws.plain(
			url,
			{ method: 'POST', headers: { 'content-type': 'application/json' }, body: seal(envelope) },
			`POST ${url}`,
			ctx.fetch
		);
	},

	receive(raw): Arrival | null {
		const event = raw as ElbEvent | null;
		const elb = event?.requestContext?.elb;
		if (!elb) return null;

		const target = elb.targetGroupArn?.split(':').pop() ?? '?';
		const body = event?.isBase64Encoded ? aws.unb64(event.body ?? '') : (event?.body ?? '');

		return {
			origin: 'aws:elb',
			describe: `ALB ${event?.httpMethod ?? '?'} ${event?.path ?? '/'} → ${target}`,
			items: [{ body }],
		};
	},
});
