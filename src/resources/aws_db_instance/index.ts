import { register } from '../../core/registry.js';
import { write } from '../../providers/hubMessages.js';
import '../../providers/postgres.js';
import * as sql from '../../providers/sql.js';

register({
	type: 'aws_db_instance',
	keys: ['DB_NAME', 'SECRET_ARN', 'ENGINE', 'IAM_USER'],
	capabilities: ['table'],

	/**
	 * Writes the message into `hub_messages` (providers/hubMessages.ts).
	 *
	 * WHICH DATABASE IS IT? The wire says: `ENGINE` is exported by the catalog from the instance's
	 * own `engine`, so nothing is guessed from a port number (a Postgres on 3306 is legal) and the
	 * RDS API is never called (it would need a permission the wire does not grant, and an endpoint
	 * inside the VPC). The engine picks the driver in `providers/sql.ts`; a MySQL arrives as an
	 * engine with no driver and is refused by name.
	 *
	 * AS WHOM? With `IAM_USER` on the wire, as that user with an IAM token; otherwise with the master
	 * user's secret (providers/rdsLogin.ts). The compile writes `IAM_USER` when the function's role
	 * is granted `rds-db:connect` on this instance.
	 *
	 * The refusal comes before the secret is read: there is no reason to fetch a credential for a
	 * database this build cannot open.
	 */
	async send(n, envelope, ctx) {
		const endpoint = n.props['ENDPOINT'];
		if (!endpoint) throw new Error('no endpoint on the wire');

		const engine = n.props['ENGINE'];
		if (!engine) {
			throw new Error('no engine on the wire: the diagram was compiled before the engine was exported, compile it again');
		}

		const secretArn = n.props['SECRET_ARN'];
		const iamUser = n.props['IAM_USER'];
		if (!secretArn && !iamUser) {
			throw new Error('no secret on the wire: the instance has no managed master password, and no IAM user is on the wire');
		}

		const database = n.props['DB_NAME'];
		if (!database) throw new Error('no database name on the wire');

		const region = ctx.region(n);
		if (!region) throw new Error('no region for the database and none for the workload');

		sql.assertSupported(engine);
		const { host, port } = sql.parseEndpoint(endpoint, engine);

		await write(engine, { host, port, database }, { secretArn, iamUser }, region, envelope, ctx);
	},
});
