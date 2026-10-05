/**
 * What a TLS connection to an Amazon database trusts.
 *
 * An RDS instance, an Aurora cluster and a DocumentDB cluster present a certificate issued by an
 * Amazon RDS certificate authority — DocumentDB has none of its own. Those authorities are not in
 * Node's list, so every driver that verifies the server needs them added, and each of the drivers
 * here (`providers/postgres.ts`, `providers/mongo.ts`) takes them from this file.
 *
 * The connection is never downgraded to an unverified one. A database that insists on TLS
 * (`rds.force_ssl`, DocumentDB's default) is told who is connecting by the password, and verifying
 * is how the client knows WHICH server it is telling.
 */

import { readFileSync } from 'node:fs';
import { rootCertificates } from 'node:tls';

/**
 * The Amazon certificate authorities, as Lambda ships them.
 *
 * FROM NODE.JS 20 ON, LAMBDA NO LONGER TRUSTS THE RDS CERTIFICATE AUTHORITY BY DEFAULT. The file
 * is in the runtime, and the documented way to use it is to set `NODE_EXTRA_CA_CERTS` to it — an
 * environment variable Node reads when the process starts, which a function cannot set for itself.
 * Reading the file here does the same job (see {@link trustedAuthorities}), and needs no setting in
 * the diagram.
 *
 * Where the file is absent — a container, a laptop — Node's own trust applies, and that includes
 * `NODE_EXTRA_CA_CERTS` when the process was started with it: the image of this repository sets it
 * to the RDS bundle (`image/Dockerfile`). Without either, a database certificate fails to verify
 * with a message that says so ({@link UNTRUSTED_HINT}).
 */
export const LAMBDA_CA_BUNDLE = '/var/runtime/ca-cert.pem';

/** The Lambda runtime's bundle, or `undefined` where there is none. */
export function lambdaBundle(): string | undefined {
	try {
		return readFileSync(LAMBDA_CA_BUNDLE, 'utf8');
	} catch {
		return undefined;
	}
}

/**
 * What a connection trusts, given the Lambda bundle when there is one: Node's own list AND the
 * bundle, which is what `NODE_EXTRA_CA_CERTS` does — the variable ADDS the file to the list.
 *
 * Handing the file alone to the connection REPLACES the list instead, and that is how the Postgres
 * driver worked until an RDS Proxy was wired. An instance's certificate is issued by the RDS
 * authority, which is in the file. A proxy's comes from AWS Certificate Manager and chains to an
 * Amazon Root CA, which is in Node's list. Both, then, as the variable would have it.
 *
 * `undefined` without a bundle, which leaves Node's defaults in place.
 */
export const trustedAuthorities = (bundle: string | undefined): string[] | undefined =>
	bundle ? [...rootCertificates, bundle] : undefined;

/** TLS failures that mean the server's certificate authority is not trusted, by Node's codes. */
export const UNTRUSTED: ReadonlySet<string> = new Set([
	'SELF_SIGNED_CERT_IN_CHAIN',
	'DEPTH_ZERO_SELF_SIGNED_CERT',
	'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
	'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
	'CERT_HAS_EXPIRED',
]);

/** What to say about one of {@link UNTRUSTED}, on either runtime. */
export const UNTRUSTED_HINT =
	'the runtime does not trust the database certificate authority; on Lambda the Amazon bundle is /var/runtime/ca-cert.pem, and in a container NODE_EXTRA_CA_CERTS has to name the RDS bundle, as image/Dockerfile does';
