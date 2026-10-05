/**
 * Logging in to an RDS database: with the secret RDS keeps for it, or with an IAM token.
 *
 * Which of the two is the wire's to say. `IAM_USER` is on it when the function's role is granted
 * `rds-db:connect` for a database user — the compile reads that grant off the diagram — and then
 * the function logs in as that user with a token (`providers/rdsIam.ts`). Otherwise it logs in with
 * the user name and password of `SECRET_ARN`.
 *
 * Shared by every way into a database: an RDS instance, an Aurora cluster reached over TCP, and an
 * RDS Proxy in front of either.
 */

import * as aws from './aws.js';
import { authToken } from './rdsIam.js';
import * as sql from './sql.js';

/** What the wire says about logging in. */
export interface Login {
	/** The database user to log in as with an IAM token. Absent or empty: log in with the secret. */
	readonly iamUser?: string | undefined;
	/** A Secrets Manager secret holding `username` and `password`. */
	readonly secretArn?: string | undefined;
	/**
	 * Whether the endpoint is an RDS Proxy. A proxy logs in to the database with the secrets of its
	 * own auth entries, so a database user is never created through one (see {@link open}).
	 */
	readonly proxy?: boolean;
	/**
	 * Log in with a token as the user the secret names, when no IAM user is given: a proxy whose
	 * auth entry requires IAM refuses the password, and checks the token against that user.
	 */
	readonly iamUserInSecret?: boolean;
}

/**
 * The answers to an IAM token that say what is wrong, as PostgreSQL codes them.
 *
 * `28P01`, password authentication failed: the user is not a member of `rds_iam`, so the database
 * took the token for a password. It is what a user that does not exist gets too — the database does
 * not say which. `28000`, PAM authentication failed: the user logs in by IAM and the token was
 * refused, which is the role's permission, the database's IAM setting, or a token signed for
 * another endpoint.
 */
const NOT_AN_IAM_USER = '28P01';
const TOKEN_REFUSED = '28000';

/** The user names written into a statement, where a parameter cannot go. */
const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * A user name as an identifier in a statement: a role is an identifier, and a parameter cannot
 * stand in for one. Only {@link PLAIN_NAME} is accepted, which is what makes writing it safe.
 */
export function quoted(user: string): string {
	if (!PLAIN_NAME.test(user)) {
		throw new Error(`the database user ${JSON.stringify(user)} cannot be set up from here: only letters, digits and underscores`);
	}
	return `"${user}"`;
}

/**
 * Reads a database credential out of a Secrets Manager secret: the one RDS manages for an
 * instance's or a cluster's master user, or the one an RDS Proxy checks its clients against.
 *
 * The generated policy grants `secretsmanager:GetSecretValue` on exactly that secret, which is why
 * the module reads it and does not ask for a password in an environment variable: the variable
 * would sit in the function's configuration, readable by anyone who can read the function.
 *
 * Read on every send and not cached. The secret rotates, and a cached copy is the rotation's
 * failure waiting for a warm container to hit it; the call costs a fraction of a cent per
 * thousand.
 *
 * NOTHING OF THE SECRET'S CONTENT GOES INTO AN ERROR. `JSON.parse` quotes the text it choked on,
 * which here is a password, so a parse failure is caught and replaced by a sentence that says
 * nothing about what was inside.
 */
export async function credentialsFrom(secretArn: string, region: string, fetchImpl: typeof fetch): Promise<sql.Credentials> {
	const answer = (await aws.json(
		'secretsmanager',
		region,
		'secretsmanager.GetSecretValue',
		{ SecretId: secretArn },
		fetchImpl
	)) as { SecretString?: unknown } | null;

	let parsed: { username?: unknown; password?: unknown } | null = null;
	if (typeof answer?.SecretString === 'string') {
		try {
			parsed = JSON.parse(answer.SecretString) as { username?: unknown; password?: unknown };
		} catch {
			parsed = null;
		}
	}

	if (typeof parsed?.username !== 'string' || typeof parsed.password !== 'string') {
		throw new Error('the secret does not carry a username and a password as JSON');
	}
	return { user: parsed.username, password: parsed.password };
}

/** A failure with a pointer appended, keeping its code. */
function hinted(err: unknown, hint: string): Error {
	const message = err instanceof Error ? err.message : String(err);
	const code = sql.codeOf(err);
	const described = new Error(`${message} (${hint})`);
	return code ? Object.assign(described, { code }) : described;
}

/** Opens a connection as the secret's user — on a database reached directly, its master user. */
export async function asSecretUser(
	engine: string,
	target: sql.Target,
	secretArn: string,
	region: string,
	fetchImpl: typeof fetch,
	options?: sql.ConnectOptions
): Promise<sql.Connection> {
	const credentials = await credentialsFrom(secretArn, region, fetchImpl);
	return sql.connect(engine, target, credentials, options);
}

/**
 * The statement that makes `user` a database user who logs in by IAM, run as the master user.
 *
 * ONLY A USER THAT DOES NOT EXIST IS CREATED. `GRANT rds_iam` ends a user's password login, so a
 * user that already exists without it — the master user, an application user — is left as it is,
 * and the statement fails saying why. A concurrent run that creates the same user first is not a
 * failure: the user it created is this one.
 *
 * The name is written into the statement ({@link quoted}), also inside two string literals, which
 * {@link PLAIN_NAME} keeps free of quotes.
 */
export function createIamUser(user: string): string {
	const role = quoted(user);
	return `do $$
begin
	if exists (select from pg_catalog.pg_roles where rolname = '${user}') then
		if not pg_catalog.pg_has_role('${user}', 'rds_iam', 'member') then
			raise exception 'the user ${user} exists and logs in with a password; granting it rds_iam would end that, so it is left as it is';
		end if;
		return;
	end if;
	begin
		create role ${role} login;
	exception when duplicate_object then
		null;
	end;
	grant rds_iam to ${role};
end
$$`;
}

/**
 * Creates the IAM user the wire names, logged in as the secret's user.
 *
 * WHY THE HUB DOES THIS. A diagram can say that a function logs in by IAM — the policy granting
 * `rds-db:connect` — and cannot draw the database user that grant names: a user is created inside
 * the database, with SQL, and nothing in Terraform's AWS provider does it. Without this the drawing
 * compiles, applies, and fails at the first login until somebody opens a SQL client. The secret is
 * the master user's, which the diagram already lets the function read.
 */
async function provisionIamUser(
	engine: string,
	target: sql.Target,
	user: string,
	secretArn: string,
	region: string,
	fetchImpl: typeof fetch,
	options?: sql.ConnectOptions
): Promise<void> {
	const statement = createIamUser(user);
	if (sql.dialectOf(engine) !== 'postgres') {
		throw new Error(`the database has no user ${user} that logs in by IAM, and creating one is written for PostgreSQL only`);
	}

	const credentials = await credentialsFrom(secretArn, region, fetchImpl);
	if (credentials.user === user) {
		throw new Error(`${user} is the master user: granting it rds_iam would end the password login the secret depends on`);
	}

	const connection = await sql.connect(engine, target, credentials, options);
	try {
		await connection.run(statement);
	} finally {
		await connection.close();
	}
}

/**
 * Opens a connection the way the wire says.
 *
 * With an IAM user, the token is made for the endpoint the connection goes to. If the database
 * answers that the user does not log in by IAM, and the wire also carries the secret of a database
 * reached directly, the user is created (`provisionIamUser`) and the login is tried once more.
 * Through a proxy it never is: there the user is the one in the proxy's secret, and it exists.
 *
 * With `iamUserInSecret` and no IAM user, the user is read out of the secret and logs in with a
 * token: the password is not sent.
 */
export async function open(
	engine: string,
	target: sql.Target,
	login: Login,
	region: string,
	fetchImpl: typeof fetch,
	options?: sql.ConnectOptions
): Promise<sql.Connection> {
	let named = login.iamUser;
	if (!named) {
		if (!login.secretArn) throw new Error('no secret and no IAM user on the wire: nothing to log in with');
		if (!login.iamUserInSecret) return asSecretUser(engine, target, login.secretArn, region, fetchImpl, options);
		named = (await credentialsFrom(login.secretArn, region, fetchImpl)).user;
	}
	const user: string = named;

	const withToken = async (): Promise<sql.Connection> =>
		sql.connect(engine, target, { user, password: await authToken(target.host, target.port, user, region) }, options);

	const explained = (err: unknown): unknown => {
		const code = sql.codeOf(err);
		if (code !== NOT_AN_IAM_USER && code !== TOKEN_REFUSED) return err;
		if (code === NOT_AN_IAM_USER && !login.proxy) {
			return hinted(err, `the database has no user ${user} that logs in by IAM: CREATE USER ${user}; GRANT rds_iam TO ${user};`);
		}
		return hinted(
			err,
			login.proxy
				? `the proxy refused the token for ${user}: the function's role needs rds-db:connect on the proxy, and its auth entry for ${user} IAM authentication`
				: `the database refused the token for ${user}: the function's role needs rds-db:connect on dbuser:<resource id>/${user}, and the database IAM authentication turned on`
		);
	};

	try {
		return await withToken();
	} catch (err) {
		if (sql.codeOf(err) !== NOT_AN_IAM_USER || login.proxy || !login.secretArn) throw explained(err);
	}

	await provisionIamUser(engine, target, user, login.secretArn, region, fetchImpl, options);
	try {
		return await withToken();
	} catch (err) {
		throw explained(err);
	}
}
