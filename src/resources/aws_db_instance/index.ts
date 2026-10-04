import { register } from '../../core/registry.js';
import { credentialsFrom, store } from '../../providers/hubMessages.js';
import '../../providers/postgres.js';
import * as sql from '../../providers/sql.js';

register({
	type: 'aws_db_instance',
	keys: ['DB_NAME', 'SECRET_ARN', 'ENGINE'],
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
		if (!secretArn) {
			throw new Error('no secret on the wire: the instance has no managed master password');
		}

		const database = n.props['DB_NAME'];
		if (!database) throw new Error('no database name on the wire');

		const region = ctx.region(n);
		if (!region) throw new Error('no region for the database and none for the workload');

		sql.assertSupported(engine);
		const { host, port } = sql.parseEndpoint(endpoint, engine);

		const credentials = await credentialsFrom(secretArn, region, ctx.fetch);
		const connection = await sql.connect(engine, { host, port, database }, credentials);
		try {
			await store(connection, envelope, ctx);
		} finally {
			await connection.close();
		}
	},
});
