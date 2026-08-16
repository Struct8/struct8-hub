import { seal } from '../../core/envelope.js';
import { register } from '../../core/registry.js';
import * as aws from '../../providers/aws.js';
import type { Arrival } from '../../core/types.js';

interface S3Record {
	readonly awsRegion?: string;
	readonly s3?: {
		readonly bucket?: { readonly name?: string };
		readonly object?: { readonly key?: string; readonly size?: number };
	};
}

/** S3 keys may contain colons, but they make the object awkward to handle from a shell. */
const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');

register({
	type: 'aws_s3_bucket',
	capabilities: ['object-store'],

	async send(n, envelope, ctx) {
		const bucket = n.props['BUCKET'] ?? n.props['NAME'];
		if (!bucket) throw new Error('no bucket name on the wire');

		const region = ctx.region(n);
		if (!region) throw new Error('no region for the bucket and none for the workload');

		const key = `${ctx.self}/${stamp()}.json`;
		await aws.rest(
			`https://${bucket}.s3.${region}.amazonaws.com/${key}`,
			's3',
			region,
			{ method: 'PUT', headers: { 'content-type': 'application/json' }, body: seal(envelope) },
			's3:PutObject',
			ctx.fetch
		);
	},

	async receive(raw): Promise<Arrival | null> {
		const records = (raw as { Records?: S3Record[] } | null)?.Records;
		const first = Array.isArray(records) ? records[0] : undefined;
		if (!first?.s3) return null;

		const bucket = first.s3.bucket?.name ?? '?';
		const key = decodeURIComponent((first.s3.object?.key ?? '').replace(/\+/g, ' '));
		const size = first.s3.object?.size ?? 0;
		const region = first.awsRegion ?? '';

		// The object's content is fetched so that what flows onward is the thing the user put in
		// the bucket, not a description of it. Only for text: reading an arbitrary binary into a
		// message body proves nothing and can be very large.
		let body = `object ${key} (${size} bytes, not text)`;
		if (/\.(txt|json|csv|log|md)$/i.test(key) && region) {
			try {
				const res = await aws.rest(
					`https://${bucket}.s3.${region}.amazonaws.com/${key}`,
					's3',
					region,
					{ method: 'GET' },
					's3:GetObject'
				);
				body = await res.text();
			} catch (err) {
				body = `object ${key} could not be read: ${err instanceof Error ? err.message : String(err)}`;
			}
		}

		return {
			origin: 'aws:s3',
			describe: `S3 ${bucket}/${key} (${size} bytes)`,
			items: [{ body }],
		};
	},
});
