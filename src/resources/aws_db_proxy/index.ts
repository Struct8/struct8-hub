import { register } from '../../core/registry.js';
import { write } from '../../providers/hubMessages.js';
import '../../providers/postgres.js';
import * as sql from '../../providers/sql.js';

/**
 * The engine whose wire protocol a proxy of each family speaks, in the names `providers/sql.ts`
 * knows. A proxy answers in its database's protocol, which is what lets a client use it in place of
 * the database. `MYSQL` also fronts MariaDB and Aurora MySQL, `POSTGRESQL` Aurora PostgreSQL.
 */
const ENGINE_OF_FAMILY: Readonly<Record<string, string>> = {
	POSTGRESQL: 'postgres',
	MYSQL: 'mysql',
	SQLSERVER: 'sqlserver',
};

register({
	type: 'aws_db_proxy',
	// `ENGINE_FAMILY` starts with `ENGINE`, the instance's key. Keys match longest first, so a proxy's
	// variable reads as the family; the cost is an instance wire whose label starts with `FAMILY_`,
	// which would read as a family too.
	keys: ['PORT', 'ENGINE_FAMILY', 'SECRET_ARN', 'DB_NAME', 'IAM_USER', 'IAM_AUTH'],
	capabilities: ['table'],

	/**
	 * Writes the message into `hub_messages` (providers/hubMessages.ts) through the proxy: the table
	 * and the row an `aws_db_instance` wire writes, because the proxy is a way into that database and
	 * not a database of its own.
	 *
	 * WHAT THE WIRE CARRIES. ENDPOINT is the proxy's host alone, and PORT is fixed by the engine
	 * family, not by the database. ENGINE_FAMILY picks the driver, as ENGINE does for the instance.
	 * SECRET_ARN is the secret of the proxy's first auth entry: under Secrets Manager authentication
	 * the proxy checks a client's user name and password against its secrets, so the secret it logs
	 * in to the database with is also the one a client logs in to it with, and the generated policy
	 * grants the workload `GetSecretValue` on it. DB_NAME comes from the database the proxy fronts:
	 * the proxy keeps no database name of its own.
	 *
	 * IAM_USER is on the wire when the function's role is granted `rds-db:connect` on the proxy, and
	 * then the client logs in as that user with a token made for the proxy's endpoint
	 * (providers/rdsLogin.ts). The proxy checks the token and logs in to the database with its own
	 * secret for that user. No database user is ever created through a proxy.
	 *
	 * IAM_AUTH is `REQUIRED` when an auth entry of the proxy refuses passwords. The client still
	 * reads SECRET_ARN, for the user name only, and logs in as that user with a token; the generator
	 * grants it `rds-db:connect` on the proxy.
	 *
	 * The certificate is the one difference in the handshake, and the driver absorbs it: a proxy's
	 * comes from AWS Certificate Manager (`trustedAuthorities`, providers/postgres.ts).
	 *
	 * Every refusal comes before the secret is read.
	 */
	async send(n, envelope, ctx) {
		const endpoint = n.props['ENDPOINT'];
		if (!endpoint) throw new Error('no endpoint on the wire');

		const family = n.props['ENGINE_FAMILY'];
		if (!family) {
			throw new Error('no engine family on the wire: the diagram was compiled before the proxy exported it, compile it again');
		}
		const engine = ENGINE_OF_FAMILY[family.trim().toUpperCase()];
		if (!engine) throw new Error(`${JSON.stringify(family)} is not an RDS Proxy engine family`);

		// Empty under IAM authentication, where a client presents a token instead of a password.
		const secretArn = n.props['SECRET_ARN'];
		const iamUser = n.props['IAM_USER'];
		if (!secretArn && !iamUser) {
			throw new Error(
				'no secret on the wire: the proxy uses IAM authentication, and no IAM user is on the wire (a policy granting rds-db:connect on the proxy names it)'
			);
		}

		const database = n.props['DB_NAME'];
		if (!database) {
			throw new Error('no database name on the wire: the proxy is connected to no database, or the database has no name');
		}

		const region = ctx.region(n);
		if (!region) throw new Error('no region for the proxy and none for the workload');

		sql.assertSupported(engine);
		const { host, port: fromEndpoint } = sql.parseEndpoint(endpoint, engine);
		const portOnWire = n.props['PORT'];
		const port = portOnWire ? sql.parseEndpoint(`${host}:${portOnWire}`, engine).port : fromEndpoint;

		const iamRequired = (n.props['IAM_AUTH'] ?? '').trim().toUpperCase() === 'REQUIRED';
		await write(
			engine,
			{ host, port, database },
			{ secretArn, iamUser, proxy: true, iamUserInSecret: iamRequired },
			region,
			envelope,
			ctx
		);
	},
});
