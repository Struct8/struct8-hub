/**
 * Logging in to an RDS database with an IAM token instead of a password.
 *
 * The token is a SigV4 presigned URL for the `rds-db` service, with the scheme cut off:
 *
 *     <host>:<port>/?Action=connect&DBUser=<user>&X-Amz-Algorithm=...&X-Amz-Signature=...
 *
 * The client sends it as the password, over TLS. The database checks the signature and the
 * permission, `rds-db:connect` on `dbuser:<resource id>/<user>`, against the role that signed it;
 * nothing of the role's own credentials leaves the function. It is what the AWS SDKs build with
 * their RDS signer, and building it here keeps the SDK out of the bundle (docs/architecture.md).
 *
 * Making one is local work, and that matters in the subnet a database lives in: there is no call
 * to make, so no endpoint to reach.
 */

import * as aws from './aws.js';

/** How long a token is accepted, in seconds: fifteen minutes, the most RDS takes. */
const TOKEN_SECONDS = 900;

/**
 * The token for logging in to `host:port` as `user`.
 *
 * The host is the one the client connects to — an instance, a cluster endpoint or an RDS Proxy —
 * because it is part of what is signed: a token made for one endpoint is refused by another. The
 * region is the database's, which is where the signature is checked.
 */
export async function authToken(host: string, port: number, user: string, region: string): Promise<string> {
	const url = new URL(`https://${host}:${port}/`);
	url.searchParams.set('Action', 'connect');
	url.searchParams.set('DBUser', user);
	url.searchParams.set('X-Amz-Expires', String(TOKEN_SECONDS));

	const signed = await aws.presign(url.toString(), 'rds-db', region);
	return signed.replace(/^https:\/\//, '');
}
