import { register } from '../../core/registry.js';
import * as aws from '../../providers/aws.js';
import type { Arrival } from '../../core/types.js';

interface ApiEvent {
	readonly body?: string;
	readonly path?: string;
	readonly rawPath?: string;
	readonly httpMethod?: string;
	readonly isBase64Encoded?: boolean;
	readonly requestContext?: {
		readonly apiId?: string;
		readonly domainName?: string;
		readonly stage?: string;
		readonly http?: { readonly method?: string; readonly path?: string };
	};
}

register({
	type: 'aws_api_gateway_rest_api',
	capabilities: ['http'],

	/**
	 * Receive only.
	 *
	 * An API Gateway in a diagram sits in *front* of the workload; it is a way in, never a
	 * destination. A wire pointing the other way would mean calling one's own front door.
	 */
	receive(raw): Arrival | null {
		const event = raw as ApiEvent | null;
		const rc = event?.requestContext;
		if (!rc?.apiId) return null;

		// A function URL event has the same v2 shape. Its domain is the tell, and it has its own
		// resource, so this one steps aside.
		if (rc.domainName?.includes('.lambda-url.')) return null;

		const method = event?.httpMethod ?? rc.http?.method ?? '?';
		const path = event?.path ?? event?.rawPath ?? rc.http?.path ?? '/';
		const body = event?.isBase64Encoded ? aws.unb64(event.body ?? '') : (event?.body ?? '');

		return {
			origin: 'aws:apigateway',
			describe: `API Gateway ${method} ${path}${rc.stage ? ` (${rc.stage})` : ''}`,
			items: [{ body }],
		};
	},
});
