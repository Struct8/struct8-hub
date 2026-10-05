import { register } from '../../core/registry.js';
import * as dataApi from '../../providers/dataApi.js';
import { store, write } from '../../providers/hubMessages.js';
import '../../providers/postgres.js';
import * as sql from '../../providers/sql.js';

/**
 * How long to wait for an Aurora cluster to accept a connection, in milliseconds.
 *
 * An Aurora Serverless v2 cluster with a minimum of 0 ACUs pauses when idle, and the connection that
 * finds it paused is held until it resumes: about fifteen seconds, says AWS, which recommends client
 * timeouts longer than that. The five seconds an RDS instance gets (providers/postgres.ts) would
 * fail every first run after a pause. The cost is paid only by a function that cannot reach the
 * cluster at all, which now waits twenty seconds instead of five before saying so.
 */
const AURORA_CONNECT_TIMEOUT_MS = 20_000;

register({
	type: 'aws_rds_cluster',
	keys: ['PORT', 'ENGINE', 'SECRET_ARN', 'DB_NAME', 'IAM_USER', 'DATA_API'],
	capabilities: ['table'],

	/**
	 * Writes the message into `hub_messages` (providers/hubMessages.ts) — the table and the row an
	 * RDS instance gets.
	 *
	 * THREE WAYS IN, AND THE WIRE SAYS WHICH. The compile decides it from the diagram, connection by
	 * connection, because three functions on one cluster can each reach it differently:
	 *
	 *   * `DATA_API` on the wire: the function is outside the VPC and the cluster's Data API is on.
	 *     The statement goes over HTTP (providers/dataApi.ts), to `ARN`, logged in with `SECRET_ARN`.
	 *   * `IAM_USER` on the wire: the function's role is granted `rds-db:connect` on the cluster for
	 *     that user. It connects to ENDPOINT and logs in as the user with an IAM token, creating the
	 *     user first when the database has none (providers/rdsLogin.ts).
	 *   * Neither: it connects to ENDPOINT and logs in with the master user's secret.
	 *
	 * ENDPOINT is the writer endpoint, the host alone; PORT is the cluster's. ENGINE picks the driver
	 * and the SQL: an Aurora PostgreSQL speaks the Postgres protocol.
	 *
	 * AN ENGINE WITH NO DRIVER GOES THROUGH THE DATA API when the wire carries `ARN`, which it does
	 * whenever the cluster has the Data API on. That is Aurora MySQL: no MySQL driver is bundled (one
	 * would add more than a megabyte to every function), and the Data API needs none. From inside a
	 * VPC it needs a NAT gateway or an rds-data interface endpoint, and the failure says so. It logs
	 * in with the secret, as the Data API does, so `IAM_USER` does not apply there.
	 *
	 * Every refusal comes before anything is read or sent.
	 */
	async send(n, envelope, ctx) {
		const engine = n.props['ENGINE'];
		if (!engine) {
			throw new Error('no engine on the wire: the diagram was compiled before the cluster exported it, compile it again');
		}

		const secretArn = n.props['SECRET_ARN'];
		const database = n.props['DB_NAME'];
		const region = ctx.region(n);

		const noDriver = !sql.canConnect(engine) && Boolean(n.props['ARN']) && sql.dialectOf(engine) !== undefined;
		if (n.props['DATA_API'] || noDriver) {
			const dialect = sql.dialectOf(engine);
			if (!dialect) throw new Error(`the Data API writes here in PostgreSQL or MySQL, and the cluster's engine is "${engine}"`);

			const resourceArn = n.props['ARN'];
			if (!resourceArn) throw new Error('no cluster ARN on the wire: the Data API addresses the cluster by it');
			if (!secretArn) {
				throw new Error('no secret on the wire: the Data API logs in with a secret, and the cluster has no managed master password');
			}
			if (!database) throw new Error('no database name on the wire: the Data API writes into a named database');
			if (!region) throw new Error('no region for the cluster and none for the workload');

			await store(dataApi.connection({ resourceArn, secretArn, database, region }, ctx.fetch), envelope, ctx, dialect);
			return;
		}

		const endpoint = n.props['ENDPOINT'];
		if (!endpoint) throw new Error('no endpoint on the wire');

		const iamUser = n.props['IAM_USER'];
		if (!secretArn && !iamUser) {
			throw new Error('no secret on the wire: the cluster has no managed master password, and no IAM user is on the wire');
		}
		if (!database) throw new Error('no database name on the wire');
		if (!region) throw new Error('no region for the cluster and none for the workload');

		sql.assertSupported(engine);
		const { host, port: fromEndpoint } = sql.parseEndpoint(endpoint, engine);
		const portOnWire = n.props['PORT'];
		const port = portOnWire ? sql.parseEndpoint(`${host}:${portOnWire}`, engine).port : fromEndpoint;

		const resumes = engine.trim().toLowerCase().startsWith('aurora');
		await write(
			engine,
			{ host, port, database },
			{ secretArn, iamUser },
			region,
			envelope,
			ctx,
			resumes ? { connectTimeoutMs: AURORA_CONNECT_TIMEOUT_MS } : undefined
		);
	},
});
