import { register } from '../../core/registry.js';
import * as google from '../../providers/google.js';
import { recordOf } from '../../providers/record.js';

/** The table every message lands in, as `hub_messages` is the table and the collection elsewhere. */
const TABLE = 'hub_messages';

/**
 * The columns of the database row (`providers/record.ts`) plus `stored_at`, as BigQuery types.
 * https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/tables#TableSchema
 */
const SCHEMA = {
	fields: [
		{ name: 'id', type: 'STRING', mode: 'REQUIRED' },
		{ name: 'trace', type: 'STRING' },
		{ name: 'path', type: 'STRING' },
		{ name: 'receiver', type: 'STRING' },
		{ name: 'digest', type: 'STRING' },
		{ name: 'hops', type: 'INT64' },
		{ name: 'sent_at', type: 'TIMESTAMP' },
		{ name: 'body', type: 'STRING' },
		{ name: 'stored_at', type: 'TIMESTAMP' },
	],
};

/**
 * The dataset and the project go into the statement inside backticks, so a backtick, a backslash,
 * a dot or a blank in either would change the statement: those are refused before anything is
 * sent. BigQuery itself refuses the rest of what is not a valid id.
 */
const QUOTABLE = /^[^`\\.\s]+$/;
const QUOTABLE_PROJECT = /^[^`\\\s]+$/;

/** Datasets whose `hub_messages` this instance already created or found, so it asks once. */
const ready = new Set<string>();

register({
	type: 'google_bigquery_dataset',
	capabilities: ['table'],

	/**
	 * One row of `hub_messages` per message.
	 *
	 * A DML statement through `jobs.query`, not the streaming `insertAll`: rows streamed into a
	 * table created moments before can be dropped while BigQuery still propagates the table, and
	 * the first message of a dataset always meets a new table. The statement is a MERGE on the
	 * record's id, the hash of what identifies a message, so a redelivery is stored once.
	 *
	 * The connection grants BigQuery Data Editor on the dataset (it creates the table and writes
	 * the row) and BigQuery Job User on the project (it runs the statement).
	 * https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/jobs/query
	 * https://docs.cloud.google.com/bigquery/docs/data-manipulation-language
	 */
	async send(n, envelope, ctx) {
		const dataset = n.props['NAME'];
		if (!dataset) throw new Error('no dataset name on the wire');
		if (!QUOTABLE.test(dataset)) throw new Error(`"${dataset}" is not a BigQuery dataset id`);
		const project = google.projectOf(ctx.account(n), 'dataset');
		if (!QUOTABLE_PROJECT.test(project)) throw new Error(`"${project}" is not a Google Cloud project id`);

		const base = `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(project)}`;
		const key = `${project}.${dataset}`;

		if (!ready.has(key)) {
			try {
				await google.api(
					`${base}/datasets/${encodeURIComponent(dataset)}/tables`,
					{
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ tableReference: { projectId: project, datasetId: dataset, tableId: TABLE }, schema: SCHEMA }),
					},
					'bigquery.tables.create',
					ctx.fetch
				);
			} catch (err) {
				if (!(err instanceof Error && err.message.startsWith('ALREADY_EXISTS'))) throw err;
			}
			ready.add(key);
		}

		const record = await recordOf(envelope, ctx);
		const table = `\`${project}.${dataset}.${TABLE}\``;
		const param = (name: string, type: string, value: string) => ({
			name,
			parameterType: { type },
			parameterValue: { value },
		});

		const res = await google.api(
			`${base}/queries`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					query:
						`MERGE ${table} t USING (SELECT @id AS id) s ON t.id = s.id ` +
						'WHEN NOT MATCHED THEN INSERT (id, trace, path, receiver, digest, hops, sent_at, body, stored_at) ' +
						'VALUES (@id, @trace, @path, @receiver, @digest, @hops, TIMESTAMP(@sent_at), @body, CURRENT_TIMESTAMP())',
					useLegacySql: false,
					parameterMode: 'NAMED',
					queryParameters: [
						param('id', 'STRING', record.id),
						param('trace', 'STRING', record.trace),
						param('path', 'STRING', record.path),
						param('receiver', 'STRING', record.receiver),
						param('digest', 'STRING', record.digest),
						param('hops', 'INT64', String(record.hops)),
						param('sent_at', 'STRING', record.sentAt),
						param('body', 'STRING', record.body),
					],
					timeoutMs: 20_000,
				}),
			},
			'bigquery.jobs.create',
			ctx.fetch
		);

		// A statement still running after `timeoutMs` comes back with `jobComplete: false`; it may yet
		// fail, so it is not counted as stored.
		const out = (await res.json()) as { jobComplete?: boolean; jobReference?: { jobId?: string } };
		if (out.jobComplete === false) {
			throw new Error(`the insert into ${dataset}.${TABLE} had not finished after 20 s (job ${out.jobReference?.jobId ?? '?'})`);
		}
	},
});
