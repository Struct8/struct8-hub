import { register } from '../../core/registry.js';
import type { Ctx } from '../../core/types.js';
import * as mongo from '../../providers/mongo.js';
import { credentialsFrom } from '../../providers/rdsLogin.js';
import { recordOf, type MessageRecord } from '../../providers/record.js';

/**
 * Where the messages land: the collection named after the table a relational database keeps them
 * in, so that a query written for one reads the other. A DocumentDB cluster has no database of its
 * own to put it in — the cluster is created empty — so the Hub names one, and the first insert
 * creates both.
 */
const DATABASE = 'hub';
const COLLECTION = 'hub_messages';

/** DocumentDB's port, for a wire that names none. */
const DEFAULT_PORT = 27017;

/** The answer to an insert whose `_id` is already there. */
const DUPLICATE_KEY = 11000;

/**
 * Created the first time a container writes to a cluster: a search for one trace is the query this
 * collection exists for. `_id` is indexed by the server already.
 */
const INDEXES = [{ key: { trace: 1 }, name: 'trace_1' }];

/** The clusters whose index this process has made sure of, by host and port. */
const ensured = new Set<string>();

/** The endpoint as the wire carries it — the host alone, as the catalog exports it — and the port. */
function whereTo(endpoint: string, portOnWire: string | undefined): mongo.Target {
	const bare = endpoint.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0] ?? '';
	const at = bare.lastIndexOf(':');
	const host = at > 0 ? bare.slice(0, at) : bare;
	const raw = portOnWire?.trim() || (at > 0 ? bare.slice(at + 1) : String(DEFAULT_PORT));
	const port = Number(raw);
	if (!host) throw new Error(`the endpoint ${JSON.stringify(endpoint)} has no host`);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`the port ${JSON.stringify(raw)} is not a port`);
	return { host, port };
}

/** A record as a document: the identity as `_id`, so the server refuses a second copy. */
function documentOf(record: MessageRecord, ctx: Ctx): mongo.Document {
	const sentAt = new Date(record.sentAt);
	return {
		_id: record.id,
		trace: record.trace,
		path: record.path,
		receiver: record.receiver,
		digest: record.digest,
		hops: record.hops,
		// A date, so a query can compare it; kept as written if it is not one.
		sent_at: Number.isNaN(sentAt.getTime()) ? record.sentAt : sentAt,
		body: record.body,
		stored_at: ctx.now(),
	};
}

/** A write error of an insert answer, as an error that keeps the server's code. */
function writeError(reported: mongo.Document, fallback: string): Error {
	const code = typeof reported['code'] === 'number' ? reported['code'] : undefined;
	const errmsg = typeof reported['errmsg'] === 'string' ? reported['errmsg'] : fallback;
	const err = new Error(`${code ?? ''}${code === undefined ? '' : ': '}${errmsg}`);
	return code === undefined ? err : Object.assign(err, { code });
}

/**
 * The failure an insert answer reports while saying `ok: 1`, if any. A duplicate key is not one:
 * it is the message already stored.
 */
function failedWrite(answer: mongo.Document): Error | undefined {
	const errors = Array.isArray(answer['writeErrors']) ? (answer['writeErrors'] as mongo.Document[]) : [];
	const failed = errors.find((e) => e['code'] !== DUPLICATE_KEY);
	if (failed) return writeError(failed, 'the insert was refused');
	const concern = answer['writeConcernError'];
	if (concern && typeof concern === 'object') return writeError(concern as mongo.Document, 'the write concern was not met');
	return undefined;
}

/** A failure, with a pointer to its cause when the server's code names one. */
function explained(err: unknown): Error {
	const message = err instanceof Error ? err.message : String(err);
	const code = mongo.codeOf(err);
	if (code === 18) {
		return new Error(`${message} (the cluster refused the user name and password the secret holds)`);
	}
	if (code === 13) {
		return new Error(`${message} (the secret's user may not write to ${DATABASE}.${COLLECTION})`);
	}
	return err instanceof Error ? err : new Error(message);
}

register({
	type: 'aws_docdb_cluster',
	keys: ['PORT', 'SECRET_ARN'],
	capabilities: ['table'],

	/**
	 * Inserts the message as a document of `hub.hub_messages`: the fields a database row carries
	 * (providers/record.ts), plus the time it was stored.
	 *
	 * WHERE: ENDPOINT and PORT, the cluster endpoint and its port, which the catalog exports. The
	 * cluster endpoint always names the primary instance, the one that takes writes. A cluster lives
	 * in a VPC, so the workload has to be in a subnet of it, and the cluster's security group has to
	 * admit it on the port — the rule the connection on the diagram carries.
	 *
	 * AS WHOM: the master user, whose user name and password are in SECRET_ARN, the secret DocumentDB
	 * keeps while it manages the password; the generated policy grants reading it. The login is
	 * SCRAM over TLS, verified against the Amazon RDS authorities (providers/mongo.ts) — the same code
	 * in a Lambda function and in a container. A cluster with a typed password exports no secret and
	 * is refused before anything is sent.
	 *
	 * ONCE PER MESSAGE: the record's id is the document's `_id`, so a redelivery is refused as a
	 * duplicate key (11000) and is not a second document — the rule the primary key of the table is
	 * in a database.
	 *
	 * Every refusal comes before anything is read or sent.
	 */
	async send(n, envelope, ctx) {
		const endpoint = n.props['ENDPOINT'];
		if (!endpoint) {
			throw new Error('no endpoint on the wire: the diagram was compiled before the cluster exported it, compile it again');
		}
		const target = whereTo(endpoint, n.props['PORT']);

		const secretArn = n.props['SECRET_ARN'];
		if (!secretArn) {
			throw new Error('no secret on the wire: the cluster does not keep its master password in Secrets Manager (manage_master_user_password), and a typed password cannot be read from here');
		}
		const region = ctx.region(n);
		if (!region) throw new Error('no region for the cluster and none for the workload');

		const credentials = await credentialsFrom(secretArn, region, ctx.fetch);
		const record = await recordOf(envelope, ctx);

		const connection = await mongo.connect(target, credentials).catch((err: unknown) => {
			throw explained(err);
		});
		try {
			const where = `${target.host}:${target.port}`;
			if (!ensured.has(where)) {
				try {
					await connection.command(DATABASE, { createIndexes: COLLECTION, indexes: INDEXES });
				} catch (err) {
					// Not the server's to give: the insert decides, and says why if it is refused too.
					if (mongo.codeOf(err) === undefined) throw err;
				}
				ensured.add(where);
			}

			const answer = await connection.command(DATABASE, { insert: COLLECTION, documents: [documentOf(record, ctx)], ordered: true });
			const failed = failedWrite(answer);
			if (failed) throw failed;
		} catch (err) {
			throw explained(err);
		} finally {
			await connection.close();
		}
	},
});
