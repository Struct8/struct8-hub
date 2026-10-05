/**
 * A MongoDB-compatible database, over its own wire protocol: what a workload needs to write a
 * document into Amazon DocumentDB.
 *
 * WHAT IS SPOKEN. One connection, over TLS, to one endpoint. An `isMaster` to learn which SCRAM
 * mechanisms the user has, the SCRAM conversation that logs in, and then the commands the caller
 * sends — each an OP_MSG with one body, answered by one OP_MSG. No pool, no topology monitoring,
 * no retryable writes: a DocumentDB cluster endpoint always names the primary, and a function that
 * writes one document per message has no use for the rest of a driver.
 *
 * WHY THE PROTOCOL BY HAND HERE, WHEN POSTGRES GOT A LIBRARY (`providers/postgres.ts`). The reason
 * given there is authentication: a mistake in SCRAM fails only against a real server, and the
 * databases this reaches are private. Two things are different here. SCRAM has published test
 * vectors — RFC 5802 for SHA-1, RFC 7677 for SHA-256, and the MongoDB authentication specification
 * for the password digest MongoDB adds to SHA-1 — and the tests check this exchange against all
 * three, message for message. And the official driver is the opposite trade from `pg`: a client
 * with connection pools, server monitoring and a dependency tree, for one insert, in a bundle that
 * is kept readable on purpose and that every function carries.
 *
 * Specifications: the OP_MSG section of the MongoDB wire protocol, and the authentication
 * specification of the MongoDB drivers.
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import * as tls from 'node:tls';

import { decode, encode, type Document } from './bson.js';
import { lambdaBundle, trustedAuthorities, UNTRUSTED, UNTRUSTED_HINT } from './rdsCa.js';

export type { Document } from './bson.js';

/** Where the database listens. */
export interface Target {
	readonly host: string;
	readonly port: number;
}

/** Who to be. Never logged, never placed in an error message. */
export interface Credentials {
	readonly user: string;
	readonly password: string;
}

export interface ConnectOptions {
	/** How long to wait for the connection and its TLS handshake, in milliseconds. */
	readonly connectTimeoutMs?: number;
	/** How long to wait for the answer to each command, in milliseconds. */
	readonly commandTimeoutMs?: number;
}

/** One open, logged-in connection. */
export interface Connection {
	/**
	 * Runs one command in `db` and resolves with the server's answer. An answer with `ok: 0` rejects,
	 * carrying the server's numeric `code` ({@link codeOf}).
	 *
	 * An answer can be `ok: 1` and still report a failure: an insert that hits a duplicate key
	 * answers `ok: 1` with `writeErrors`. Reading those is the caller's, because whether one is a
	 * failure is the caller's to say.
	 */
	command(db: string, body: Document): Promise<Document>;
	/** Releases the connection. Safe to call after a failure, and never throws. */
	close(): Promise<void>;
}

/** Opens the byte stream a connection talks over: TLS, unless a test hands in its own. */
export type Dial = (target: Target, timeoutMs: number) => Promise<Duplex>;

export type Mechanism = 'SCRAM-SHA-1' | 'SCRAM-SHA-256';

/**
 * How long to wait, in milliseconds: for the connection, then for each command.
 *
 * Not decoration, for the reason `providers/postgres.ts` gives: a workload in a subnet with no
 * route to the database does not fail, it WAITS, and a function is billed for the wait.
 */
const CONNECT_TIMEOUT_MS = 5000;
const COMMAND_TIMEOUT_MS = 5000;

const OP_MSG = 2013;
/** OP_MSG flag: the message ends in a CRC-32C checksum. */
const CHECKSUM_PRESENT = 1;
/** Far above the 48 MB a server answers with; a length beyond it is a stream out of step. */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const HEADER_BYTES = 16;

/** The SCRAM iteration count below which the drivers' specification says to refuse the server. */
const MIN_ITERATIONS = 4096;

/** Answers that mean the server is a replica, and writes have to go to the primary. */
const NOT_PRIMARY = new Set([10107, 13435, 11602, 189]);

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** One command as an OP_MSG: the header, no flags, and one body section holding the document. */
export function opMsg(requestId: number, body: Document): Uint8Array {
	const doc = encode(body);
	const message = new Uint8Array(HEADER_BYTES + 4 + 1 + doc.length);
	const view = new DataView(message.buffer);
	view.setInt32(0, message.length, true);
	view.setInt32(4, requestId, true);
	view.setInt32(8, 0, true);
	view.setInt32(12, OP_MSG, true);
	view.setUint32(16, 0, true);
	message[20] = 0;
	message.set(doc, 21);
	return message;
}

/** The request an answer belongs to, and its body. */
export function readReply(message: Uint8Array): { responseTo: number; body: Document } {
	const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
	const length = view.getInt32(0, true);
	if (length !== message.length || length < HEADER_BYTES + 5) throw new Error(`malformed answer: ${length} bytes claimed, ${message.length} read`);
	const responseTo = view.getInt32(8, true);
	const opCode = view.getInt32(12, true);
	if (opCode !== OP_MSG) throw new Error(`the server answered with opcode ${opCode}, where OP_MSG (${OP_MSG}) was expected`);

	const flags = view.getUint32(16, true);
	const end = length - (flags & CHECKSUM_PRESENT ? 4 : 0);
	let body: Document | undefined;
	let p = HEADER_BYTES + 4;
	while (p < end) {
		const kind = message[p++];
		const size = view.getInt32(p, true);
		if (size < 5 || p + size > end) throw new Error('malformed answer: a section runs past the message');
		// Kind 1 is a document sequence, which the answer to a command does not use.
		if (kind === 0) body = decode(message.subarray(p, p + size));
		else if (kind !== 1) throw new Error(`malformed answer: unknown section kind ${kind}`);
		p += size;
	}
	if (!body) throw new Error('malformed answer: no body section');
	return { responseTo, body };
}

/** Splits a byte stream into whole messages, however the network cut it. */
class Framer {
	private pending: Buffer = Buffer.alloc(0);

	push(chunk: Buffer): Uint8Array[] {
		this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
		const messages: Uint8Array[] = [];
		while (this.pending.length >= 4) {
			const length = this.pending.readInt32LE(0);
			if (length < HEADER_BYTES + 5 || length > MAX_MESSAGE_BYTES) {
				throw new Error(`malformed answer: a message claims ${length} bytes`);
			}
			if (this.pending.length < length) break;
			messages.push(this.pending.subarray(0, length));
			this.pending = this.pending.subarray(length);
		}
		return messages;
	}
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/** The numeric code a server refusal carries, or `undefined` for a failure of any other kind. */
export const codeOf = (err: unknown): number | undefined => {
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === 'number' ? code : undefined;
};

/** An `ok: 0` answer, as an error that keeps the server's code. */
function refusal(answer: Document): Error {
	const code = typeof answer['code'] === 'number' ? answer['code'] : undefined;
	const codeName = typeof answer['codeName'] === 'string' ? answer['codeName'] : '';
	const errmsg = typeof answer['errmsg'] === 'string' ? answer['errmsg'] : 'the server refused the command';
	const label = [code, codeName].filter((part) => part !== undefined && part !== '').join(' ');
	let hint = '';
	if (code !== undefined && NOT_PRIMARY.has(code)) {
		hint = ' (the endpoint answered from a replica, and only the primary takes writes: ENDPOINT has to be the cluster endpoint)';
	}
	const err = new Error(`${label ? `${label}: ` : ''}${errmsg}${hint}`);
	return code === undefined ? err : Object.assign(err, { code, codeName });
}

const seconds = (ms: number): string => `${Math.round(ms / 100) / 10} s`;

/** Node's codes for a connection that got no answer at all. */
const NO_ANSWER = new Set(['ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH']);

/**
 * Turns a failure to connect into a line a report can carry, with a pointer to its likely cause.
 *
 * Nothing here can contain the password: the connection is not logged in yet, and the credential
 * is not an argument. The code stays on the error as `code`, as a string, the way Node gave it.
 *
 * Exported for the tests.
 */
export function describeConnect(err: unknown, target: Target, waitedMs: number): Error {
	const e = (err ?? {}) as { code?: unknown; message?: unknown };
	const code = typeof e.code === 'string' ? e.code : '';
	const message = typeof e.message === 'string' && e.message ? e.message : String(err);

	let hint = '';
	if (UNTRUSTED.has(code)) {
		hint = UNTRUSTED_HINT;
	} else if (NO_ANSWER.has(code)) {
		hint = `no answer in ${seconds(waitedMs)}: the workload has to be in a subnet of the cluster's VPC, and the cluster's security group has to admit it on port ${target.port}`;
	} else if (code === 'ECONNREFUSED') {
		hint = `nothing accepts connections on port ${target.port} at that address`;
	} else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
		hint = 'the endpoint does not resolve';
	} else if (code === 'ECONNRESET' || code === 'EPROTO' || code.startsWith('ERR_SSL_')) {
		hint = 'the TLS handshake failed: the Hub always connects with TLS, and a cluster whose parameter group turns TLS off refuses it';
	}

	const described = new Error(`${code ? `${code}: ` : ''}${message}${hint ? ` (${hint})` : ''}`);
	return code ? Object.assign(described, { code }) : described;
}

// ---------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------

/** The default way in: TLS, verifying the server against the Amazon authorities (`providers/rdsCa.ts`). */
const tlsDial: Dial = (target, timeoutMs) =>
	new Promise((resolve, reject) => {
		const socket = tls.connect({
			host: target.host,
			port: target.port,
			// The name the certificate is checked against. An address has none to send.
			...(isIP(target.host) ? {} : { servername: target.host }),
			ca: trustedAuthorities(lambdaBundle()),
			rejectUnauthorized: true,
		});
		const timer = setTimeout(() => {
			socket.off('error', failed);
			socket.destroy();
			reject(Object.assign(new Error(`no answer from ${target.host}:${target.port}`), { code: 'ETIMEDOUT' }));
		}, timeoutMs);
		function failed(err: Error): void {
			clearTimeout(timer);
			socket.destroy();
			reject(err);
		}
		socket.once('error', failed);
		socket.once('secureConnect', () => {
			clearTimeout(timer);
			socket.off('error', failed);
			resolve(socket);
		});
	});

let dialOverride: Dial | undefined;

/** Test seam: replaces how the byte stream is opened. `undefined` restores TLS. */
export function useDial(dial: Dial | undefined): void {
	dialOverride = dial;
}

/** Opens a logged-in connection: {@link connect}, unless a test replaced it. */
export type Connector = (target: Target, credentials: Credentials, options?: ConnectOptions) => Promise<Connection>;

let connectorOverride: Connector | undefined;

/**
 * Test seam at the level of `sql.useDriver`: replaces the whole connection, protocol included, for
 * a test about the module and not about the wire. `undefined` restores the protocol.
 */
export function useConnector(connector: Connector | undefined): void {
	connectorOverride = connector;
}

/** A logged-out connection: commands over an open stream, matched to their answers. */
function over(socket: Duplex, target: Target, commandTimeoutMs: number): Connection {
	const framer = new Framer();
	const waiting = new Map<number, { settle(answer: Document): void; fail(err: Error): void; timer: NodeJS.Timeout }>();
	let broken: Error | undefined;
	let nextId = 1;

	const breakWith = (err: Error): void => {
		broken ??= err;
		for (const pending of waiting.values()) {
			clearTimeout(pending.timer);
			pending.fail(broken);
		}
		waiting.clear();
	};

	socket.on('data', (chunk: Buffer) => {
		try {
			for (const message of framer.push(chunk)) {
				const { responseTo, body } = readReply(message);
				const pending = waiting.get(responseTo);
				if (!pending) continue;
				waiting.delete(responseTo);
				clearTimeout(pending.timer);
				pending.settle(body);
			}
		} catch (err) {
			breakWith(err instanceof Error ? err : new Error(String(err)));
			socket.destroy();
		}
	});
	// After the handshake, a failure is the connection being lost, not a cause to point at.
	socket.on('error', (err: Error & { code?: unknown }) => {
		const code = typeof err.code === 'string' ? err.code : '';
		breakWith(Object.assign(new Error(`${code ? `${code}: ` : ''}the connection to ${target.host} was lost: ${err.message}`), code ? { code } : {}));
	});
	socket.on('close', () => breakWith(new Error('the connection closed before the server answered')));

	return {
		command(db, body) {
			if (broken) return Promise.reject(broken);
			const id = nextId++;
			// `$db` after the body: a command is named by its first key.
			const message = opMsg(id, { ...body, $db: db });
			return new Promise<Document>((resolve, reject) => {
				const timer = setTimeout(() => {
					waiting.delete(id);
					reject(new Error(`no answer to ${Object.keys(body)[0] ?? 'the command'} in ${seconds(commandTimeoutMs)}`));
					socket.destroy();
				}, commandTimeoutMs);
				waiting.set(id, {
					settle: (answer) => (Number(answer['ok']) === 1 ? resolve(answer) : reject(refusal(answer))),
					fail: reject,
					timer,
				});
				socket.write(message);
			});
		},
		async close() {
			breakWith(new Error('the connection is closed'));
			socket.destroy();
		},
	};
}

// ---------------------------------------------------------------------------
// Logging in
// ---------------------------------------------------------------------------

const hmac = (hash: string, key: Buffer, data: string): Buffer => createHmac(hash, key).update(data, 'utf8').digest();

const xor = (a: Buffer, b: Buffer): Buffer => Buffer.from(a.map((byte, i) => byte ^ b[i]!));

/** The attributes of a SCRAM message, `k=v,k=v`; a value may hold `=`, as base64 does. */
function attributes(message: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const part of message.split(',')) {
		const at = part.indexOf('=');
		if (at > 0) out.set(part.slice(0, at), part.slice(at + 1));
	}
	return out;
}

/** A user name in a SCRAM message: `=` and `,` would end the attribute, so they are escaped. */
const saslName = (user: string): string => user.replace(/=/g, '=3D').replace(/,/g, '=2C');

/**
 * A password as SCRAM-SHA-256 hashes it: SASLprep (RFC 4013), which leaves printable ASCII as it
 * is. Beyond ASCII, this maps the spaces and the "commonly mapped to nothing" characters and
 * normalizes to NFKC; it does not check for the characters SASLprep prohibits, which a server then
 * refuses as a wrong password.
 */
function saslprep(password: string): string {
	if (/^[\x20-\x7e]*$/.test(password)) return password;
	return password
		.replace(/[   -​  　]/g, ' ')
		.replace(/[­͏᠆᠋-᠍‌‍⁠︀-️﻿]/g, '')
		.normalize('NFKC');
}

/**
 * The client side of a SCRAM exchange, given the secret it hashes: everything that does not depend
 * on MongoDB. Exported so a test can check it against the vectors of RFC 5802 and RFC 7677.
 */
export function scramFinal(
	hash: 'sha1' | 'sha256',
	secret: string,
	clientFirstBare: string,
	clientNonce: string,
	serverFirst: string
): { clientFinal: string; serverSignature: Buffer } {
	const server = attributes(serverFirst);
	const nonce = server.get('r') ?? '';
	const salt = server.get('s') ?? '';
	const iterations = Number(server.get('i'));
	if (!nonce.startsWith(clientNonce) || nonce.length === clientNonce.length) {
		throw new Error('the server answered the login with a nonce that does not extend the client nonce');
	}
	if (!salt) throw new Error('the server answered the login with no salt');
	if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS) {
		throw new Error(`the server asked for ${server.get('i')} iterations, and the protocol takes no fewer than ${MIN_ITERATIONS}`);
	}

	const salted = pbkdf2Sync(secret, Buffer.from(salt, 'base64'), iterations, hash === 'sha1' ? 20 : 32, hash);
	const clientKey = hmac(hash, salted, 'Client Key');
	const storedKey = createHash(hash).update(clientKey).digest();
	// `biws` is "n,," in base64: no channel binding, and the same user as the first message.
	const withoutProof = `c=biws,r=${nonce}`;
	const authMessage = `${clientFirstBare},${serverFirst},${withoutProof}`;
	const proof = xor(clientKey, hmac(hash, storedKey, authMessage));
	const serverSignature = hmac(hash, hmac(hash, salted, 'Server Key'), authMessage);
	return { clientFinal: `${withoutProof},p=${proof.toString('base64')}`, serverSignature };
}

/** One login, as the three messages a client sends and checks. */
export class Scram {
	private readonly hash: 'sha1' | 'sha256';
	private readonly bare: string;
	private expected: Buffer | undefined;

	constructor(
		readonly mechanism: Mechanism,
		private readonly credentials: Credentials,
		private readonly nonce: string = randomBytes(24).toString('base64')
	) {
		this.hash = mechanism === 'SCRAM-SHA-256' ? 'sha256' : 'sha1';
		this.bare = `n=${saslName(credentials.user)},r=${this.nonce}`;
	}

	/** What `saslStart` carries. */
	first(): string {
		return `n,,${this.bare}`;
	}

	/** What `saslContinue` carries, given the server's first message. */
	final(serverFirst: string): string {
		const { clientFinal, serverSignature } = scramFinal(this.hash, this.secret(), this.bare, this.nonce, serverFirst);
		this.expected = serverSignature;
		return clientFinal;
	}

	/**
	 * Checks the server's last message. A server that cannot produce the signature does not know the
	 * password, whatever it answered before: this is the half of SCRAM that authenticates the server.
	 */
	verify(serverFinal: string): void {
		const server = attributes(serverFinal);
		const refused = server.get('e');
		if (refused) throw new Error(`the server ended the login: ${refused}`);
		const signature = Buffer.from(server.get('v') ?? '', 'base64');
		if (!this.expected || signature.length !== this.expected.length || !timingSafeEqual(signature, this.expected)) {
			throw new Error('the server could not prove that it knows the password: its signature does not match');
		}
	}

	/**
	 * What is hashed. SCRAM-SHA-1 hashes MongoDB's digest of the password, MD5 of
	 * `user:mongo:password` in hex, and not the password itself; SCRAM-SHA-256 hashes the password.
	 */
	private secret(): string {
		const { user, password } = this.credentials;
		return this.hash === 'sha1' ? createHash('md5').update(`${user}:mongo:${password}`, 'utf8').digest('hex') : saslprep(password);
	}
}

/**
 * The mechanism to log in with, from the `isMaster` answer: SCRAM-SHA-256 when the user has it,
 * SCRAM-SHA-1 otherwise — which is what the answer of a server that does not list them means, and
 * what every DocumentDB user created before engine 5.0.1 has.
 */
export function mechanismFor(hello: Document): Mechanism {
	const listed = hello['saslSupportedMechs'];
	return Array.isArray(listed) && listed.includes('SCRAM-SHA-256') ? 'SCRAM-SHA-256' : 'SCRAM-SHA-1';
}

const asText = (payload: unknown): string => (payload instanceof Uint8Array ? Buffer.from(payload).toString('utf8') : '');

/** Logs a connection in as `credentials`, in `admin`, where DocumentDB keeps its users. */
export async function authenticate(connection: Connection, scram: Scram): Promise<void> {
	const started = await connection.command('admin', {
		saslStart: 1,
		mechanism: scram.mechanism,
		payload: Buffer.from(scram.first(), 'utf8'),
		autoAuthorize: 1,
		options: { skipEmptyExchange: true },
	});
	const conversationId = started['conversationId'];

	let answer = await connection.command('admin', {
		saslContinue: 1,
		conversationId,
		payload: Buffer.from(scram.final(asText(started['payload'])), 'utf8'),
	});
	scram.verify(asText(answer['payload']));

	// A server that does not honour `skipEmptyExchange` wants one more, empty, round before it says
	// done. Two is already a server that is not finishing.
	for (let round = 0; answer['done'] !== true; round++) {
		if (round === 2) throw new Error('the server did not finish the login');
		answer = await connection.command('admin', { saslContinue: 1, conversationId, payload: new Uint8Array(0) });
	}
}

/**
 * Opens a connection to `target` and logs in as `credentials`.
 *
 * Every failure before the login closes what was opened, and a failure to connect says where to
 * look ({@link describeConnect}). The login's own failures keep the server's code: 18 is the user
 * name and password refused.
 */
export async function connect(target: Target, credentials: Credentials, options: ConnectOptions = {}): Promise<Connection> {
	if (connectorOverride) return connectorOverride(target, credentials, options);
	const waitMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
	let socket: Duplex;
	try {
		socket = await (dialOverride ?? tlsDial)(target, waitMs);
	} catch (err) {
		throw describeConnect(err, target, waitMs);
	}

	const connection = over(socket, target, options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS);
	try {
		// Only to learn the mechanism: a server that refuses the question still takes SCRAM-SHA-1.
		const hello = await connection
			.command('admin', { isMaster: 1, saslSupportedMechs: `admin.${credentials.user}` })
			.catch((err: unknown) => {
				if (codeOf(err) === undefined) throw err;
				return {} as Document;
			});
		await authenticate(connection, new Scram(mechanismFor(hello), credentials));
		return connection;
	} catch (err) {
		await connection.close();
		throw err;
	}
}
