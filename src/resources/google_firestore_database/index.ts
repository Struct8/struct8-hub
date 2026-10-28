import { register } from '../../core/registry.js';
import * as google from '../../providers/google.js';
import { recordOf } from '../../providers/record.js';

/** The collection every message lands in, as `hub_messages` is the table and the index elsewhere. */
const COLLECTION = 'hub_messages';

register({
	type: 'google_firestore_database',
	capabilities: ['table'],

	/**
	 * One document of `hub_messages` per message, with the fields of the database row
	 * (`providers/record.ts`) plus `stored_at`. The document id is the record's id, the hash of
	 * what identifies a message, so a redelivery is stored once: Firestore answers ALREADY_EXISTS,
	 * which counts as stored.
	 * https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.databases.documents/createDocument
	 */
	async send(n, envelope, ctx) {
		const database = n.props['NAME'];
		if (!database) throw new Error('no database name on the wire');
		const project = google.projectOf(ctx.account(n), 'database');

		const record = await recordOf(envelope, ctx);
		const fields = {
			trace: { stringValue: record.trace },
			path: { stringValue: record.path },
			receiver: { stringValue: record.receiver },
			digest: { stringValue: record.digest },
			hops: { integerValue: String(record.hops) },
			sent_at: { stringValue: record.sentAt },
			body: { stringValue: record.body },
			stored_at: { timestampValue: ctx.now().toISOString() },
		};

		try {
			await google.api(
				`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project)}/databases/${encodeURIComponent(database)}/documents/${COLLECTION}?documentId=${record.id}`,
				{ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fields }) },
				'datastore.entities.create',
				ctx.fetch
			);
		} catch (err) {
			if (err instanceof Error && err.message.startsWith('ALREADY_EXISTS')) return;
			throw err;
		}
	},
});
