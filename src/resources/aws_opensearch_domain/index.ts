import { register } from '../../core/registry.js';
import * as aws from '../../providers/aws.js';
import { recordOf } from '../../providers/record.js';

/** The index every message goes to, named after the table a database keeps them in. */
const INDEX = 'hub_messages';

/**
 * How the index is created when the Hub is the first to write to it: the identifying fields as
 * `keyword`, so a search for one trace or one receiver is an exact match and not a full-text one,
 * and the two times as dates, so OpenSearch Dashboards can use either as the time field.
 */
const INDEX_DEFINITION = {
	mappings: {
		properties: {
			trace: { type: 'keyword' },
			path: { type: 'keyword' },
			receiver: { type: 'keyword' },
			digest: { type: 'keyword' },
			hops: { type: 'integer' },
			sent_at: { type: 'date' },
			body: { type: 'text' },
			stored_at: { type: 'date' },
		},
	},
};

/**
 * The domains whose index this process has made sure of, by host. One request per domain per warm
 * container instead of one per message; a domain whose index is deleted later is noticed by the
 * write, which asks again.
 */
const ensured = new Set<string>();

/** The host of an endpoint the wire may write bare (`vpc-x.es.amazonaws.com`) or as a URL. */
const hostOf = (endpoint: string): string =>
	endpoint
		.trim()
		.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
		.split(/[/?#]/)[0] ?? '';

/** Whether a failure is OpenSearch answering with this error type. */
const answered = (err: unknown, type: string): boolean => err instanceof Error && err.message.startsWith(`${type}:`);

/** A failure, with a pointer to its cause when it has one outside the request. */
function explained(err: unknown): Error {
	if (err instanceof TypeError) {
		const cause = (err as { cause?: { code?: unknown; message?: unknown } }).cause;
		const why = typeof cause?.code === 'string' ? cause.code : typeof cause?.message === 'string' ? cause.message : err.message;
		return new Error(
			`the domain did not answer (${why}): the function has to be in a subnet of the domain's VPC, and the domain's security group has to admit it on port 443`
		);
	}

	const message = err instanceof Error ? err.message : String(err);
	if (answered(err, 'security_exception')) {
		return new Error(
			`${message} (the domain has fine-grained access control on: the function's role has to be its master user, or be mapped in OpenSearch to a role that writes to ${INDEX})`
		);
	}
	if (/not authorized to perform: es:ESHttp/i.test(message)) {
		return new Error(`${message} (the function's role needs es:ESHttpPut on the domain, which the policy statement of the connection grants)`);
	}
	return err instanceof Error ? err : new Error(message);
}

register({
	type: 'aws_opensearch_domain',
	capabilities: ['table'],

	/**
	 * Indexes the message as a document of `hub_messages`: the fields a database row carries
	 * (providers/record.ts), plus the time it was stored.
	 *
	 * WHERE: ENDPOINT, the domain's own endpoint, which the catalog exports. A domain drawn in
	 * CloudMan always lives in a VPC, so the function has to be in a subnet of it, and the domain's
	 * security group has to admit the function on 443.
	 *
	 * AS WHOM: the function's role, with a SigV4 signature for `es` -- the same signer every other
	 * destination uses, which is what makes this work unchanged in a Lambda function and in a
	 * container. The policy statement of the connection grants `es:ESHttp*` on the domain, and with
	 * no access policy of its own the domain accepts what the role's policy allows. With fine-grained
	 * access control on, OpenSearch also wants the role mapped to one of its roles, and the failure
	 * says so.
	 *
	 * ONCE PER MESSAGE: `_create` with the record's id, so a redelivery finds the document there
	 * (409) and is not a second one -- the rule the primary key of the table is in a database.
	 *
	 * THE INDEX is created with its mapping the first time a container writes to the domain. One
	 * that exists is kept as it is, and a role that may not create indexes still writes into one
	 * that exists, or into the one OpenSearch creates on first write.
	 */
	async send(n, envelope, ctx) {
		const endpoint = n.props['ENDPOINT'];
		if (!endpoint) {
			throw new Error('no endpoint on the wire: the diagram was compiled before the domain exported it, compile it again');
		}
		const host = hostOf(endpoint);
		if (!host) throw new Error(`the endpoint ${JSON.stringify(endpoint)} has no host`);

		const region = ctx.region(n);
		if (!region) throw new Error('no region for the domain and none for the workload');

		const call = (method: string, path: string, body: unknown) =>
			aws.rest(
				`https://${host}${path}`,
				'es',
				region,
				{ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
				`${method} ${path}`,
				ctx.fetch
			);

		const ensureIndex = async (): Promise<void> => {
			if (ensured.has(host)) return;
			try {
				await call('PUT', `/${INDEX}`, INDEX_DEFINITION);
			} catch (err) {
				// There already, or not ours to create: either way the write decides.
				if (!answered(err, 'resource_already_exists_exception') && !answered(err, 'security_exception')) throw err;
			}
			ensured.add(host);
		};

		const record = await recordOf(envelope, ctx);
		const document = {
			trace: record.trace,
			path: record.path,
			receiver: record.receiver,
			digest: record.digest,
			hops: record.hops,
			sent_at: record.sentAt,
			body: record.body,
			stored_at: ctx.now().toISOString(),
		};

		const create = async (): Promise<void> => {
			try {
				await call('PUT', `/${INDEX}/_create/${record.id}`, document);
			} catch (err) {
				// The same message, delivered again: it is stored already.
				if (!answered(err, 'version_conflict_engine_exception')) throw err;
			}
		};

		try {
			await ensureIndex();
			try {
				await create();
			} catch (err) {
				// The index was deleted after this container made sure of it, on a domain that does
				// not create indexes on first write.
				if (!answered(err, 'index_not_found_exception')) throw err;
				ensured.delete(host);
				await ensureIndex();
				await create();
			}
		} catch (err) {
			throw explained(err);
		}
	},
});
