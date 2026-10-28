import { seal } from '../../core/envelope.js';
import { register } from '../../core/registry.js';
import * as google from '../../providers/google.js';

/** Object names may contain colons, but they make the object awkward to handle from a shell. */
const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');

register({
	type: 'google_storage_bucket',
	capabilities: ['object-store'],

	/**
	 * One object per message, named as on S3 (`<workload>/<time>.json`), so the two buckets can be
	 * read the same way. The simple upload of the JSON API: the body is the object.
	 * https://docs.cloud.google.com/storage/docs/uploading-objects#uploading-an-object
	 */
	async send(n, envelope, ctx) {
		const bucket = n.props['BUCKET'] ?? n.props['NAME'];
		if (!bucket) throw new Error('no bucket name on the wire');

		const name = `${ctx.self}/${stamp()}.json`;
		await google.api(
			`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(name)}`,
			{ method: 'POST', headers: { 'content-type': 'application/json' }, body: seal(envelope) },
			'storage.objects.create',
			ctx.fetch
		);
	},
});
