/**
 * A DocumentDB cluster, on the wire.
 *
 * A database is a TCP connection and a wire protocol, and this one is written here rather than
 * bundled (providers/mongo.ts says why). So the protocol is checked against what the server side
 * publishes, not against itself:
 *
 *   * BSON byte for byte against the two documents of the specification, and every type the
 *     specification defines read back from bytes built by hand.
 *   * SCRAM message for message against RFC 5802 (SHA-1), RFC 7677 (SHA-256) and the example of the
 *     MongoDB authentication specification, which adds MongoDB's digest of the password to SHA-1.
 *
 * Then the module, against a cluster in this process: a TCP server that speaks OP_MSG and checks
 * the login with its own SCRAM, written separately below. What is locked there is each decision
 * that reads as arbitrary and is not: the record's id as `_id`, so a redelivery is not a second
 * document; the index made sure of once; a server that cannot sign believed in nothing; and every
 * failure saying where to look, without the password in it.
 *
 * None of this proves the TLS handshake with a real cluster, nor that DocumentDB answers exactly as
 * this server does. That is the first apply.
 */

import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import * as net from 'node:net';

import '../dist/resources/aws_docdb_cluster/index.js';
import * as registry from '../dist/core/registry.js';
import * as aws from '../dist/providers/aws.js';
import { decode, encode } from '../dist/providers/bson.js';
import * as mongo from '../dist/providers/mongo.js';
import { recordOf } from '../dist/providers/record.js';
import { discover } from '../dist/core/discovery.js';
import { open } from '../dist/core/envelope.js';
import type { Ctx, Envelope, Neighbor } from '../dist/core/types.js';

aws.credentials({
	accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
	secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
});

type Doc = Record<string, unknown>;

// ---------------------------------------------------------------------------
// BSON
// ---------------------------------------------------------------------------

const le32 = (n: number): Buffer => {
	const b = Buffer.alloc(4);
	b.writeInt32LE(n);
	return b;
};
const le64 = (n: bigint): Buffer => {
	const b = Buffer.alloc(8);
	b.writeBigInt64LE(n);
	return b;
};
const cstr = (s: string): Buffer => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.of(0)]);
const str = (s: string): Buffer => {
	const b = Buffer.from(s, 'utf8');
	return Buffer.concat([le32(b.length + 1), b, Buffer.of(0)]);
};
const el = (type: number, name: string, ...payload: Buffer[]): Buffer => Buffer.concat([Buffer.of(type), cstr(name), ...payload]);
const doc = (...elements: Buffer[]): Buffer => {
	const body = Buffer.concat(elements);
	return Buffer.concat([le32(body.length + 5), body, Buffer.of(0)]);
};
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

test('the two documents of the BSON specification encode byte for byte', () => {
	assert.equal(hex(encode({ hello: 'world' })), '160000000268656c6c6f0006000000776f726c640000');
	assert.equal(
		hex(encode({ BSON: ['awesome', 5.05, 1986] })),
		'31000000' + '04' + '42534f4e00' + '26000000' +
			'02' + '3000' + '08000000' + '617765736f6d6500' +
			'01' + '3100' + '3333333333331440' +
			'10' + '3200' + 'c2070000' +
			'00' + '00'
	);
	assert.deepEqual(decode(Buffer.from('160000000268656c6c6f0006000000776f726c640000', 'hex')), { hello: 'world' });
});

test('every type the specification defines is read back, from bytes built by hand', () => {
	const id = Buffer.from('0102030405060708090a0b0c', 'hex');
	const scope = doc(el(0x10, 'a', le32(1)));
	const codeWithScope = Buffer.concat([str('g()'), scope]);
	const bytes = doc(
		el(0x01, 'double', Buffer.from('3333333333331440', 'hex')),
		el(0x02, 'string', str('é')),
		el(0x03, 'document', doc(el(0x08, 'yes', Buffer.of(1)))),
		el(0x04, 'array', doc(el(0x10, '0', le32(7)), el(0x0a, '1'))),
		el(0x05, 'binary', le32(3), Buffer.of(0x80), Buffer.from('abc')),
		el(0x06, 'undefined'),
		el(0x07, 'objectId', id),
		el(0x08, 'boolean', Buffer.of(0)),
		el(0x09, 'date', le64(1759687200000n)),
		el(0x0a, 'null'),
		el(0x0b, 'regex', cstr('ab+c'), cstr('i')),
		el(0x0c, 'dbPointer', str('coll'), id),
		el(0x0d, 'code', str('f()')),
		el(0x0e, 'symbol', str('x')),
		el(0x0f, 'codeWithScope', le32(4 + codeWithScope.length), codeWithScope),
		el(0x10, 'int32', le32(-5)),
		el(0x11, 'timestamp', le32(5), le32(1700000000)),
		el(0x12, 'int64', le64(42n)),
		el(0x12, 'bigInt64', le64(1n << 60n)),
		el(0x13, 'decimal128', Buffer.alloc(16, 0xab)),
		el(0xff, 'minKey'),
		el(0x7f, 'maxKey')
	);

	assert.deepEqual(decode(bytes), {
		double: 5.05,
		string: 'é',
		document: { yes: true },
		array: [7, null],
		binary: new Uint8Array([97, 98, 99]),
		undefined: undefined,
		objectId: { $oid: '0102030405060708090a0b0c' },
		boolean: false,
		date: new Date(1759687200000),
		null: null,
		regex: { $regex: 'ab+c', $options: 'i' },
		dbPointer: { $dbPointer: { $ref: 'coll', $id: { $oid: '0102030405060708090a0b0c' } } },
		code: { $code: 'f()' },
		symbol: 'x',
		codeWithScope: { $code: 'g()', $scope: { a: 1 } },
		int32: -5,
		timestamp: { $timestamp: { t: 1700000000, i: 5 } },
		int64: 42,
		bigInt64: 1n << 60n,
		decimal128: { $numberDecimal: 'ab'.repeat(16) },
		minKey: { $minKey: 1 },
		maxKey: { $maxKey: 1 },
	});
});

test('what the Hub writes comes back as itself', () => {
	const value = {
		s: 'text',
		i: 2147483647,
		negative: -2147483648,
		d: 0.5,
		beyondInt32: 2147483648,
		l: 1n << 40n,
		t: true,
		n: null,
		when: new Date('2026-10-05T18:00:00.000Z'),
		bytes: new Uint8Array([0, 255]),
		nested: { list: ['a', 1, { deep: false }] },
	};
	assert.deepEqual(decode(encode(value)), { ...value, beyondInt32: 2147483648, l: Number(1n << 40n) });
	// An integer past int32 goes out as a double, so it keeps its value, not its integer type.
	assert.equal(encode({ x: 2147483648 })[4], 0x01);
	assert.equal(encode({ x: 7 })[4], 0x10);
});

test('a value BSON is not written with here is refused, and so is a malformed document', () => {
	assert.throws(() => encode({ f: () => 1 } as Doc), /holds a function/);
	assert.throws(() => encode({ s: Symbol('x') } as Doc), /holds a symbol/);
	assert.throws(() => encode({ 'a\0b': 1 }), /cannot contain a NUL/);
	assert.throws(() => encode({ when: new Date('not a date') }), /invalid date/);

	const whole = encode({ hello: 'world' });
	assert.throws(() => decode(whole.subarray(0, whole.length - 3)), /malformed BSON/);
	assert.throws(() => decode(doc(el(0x42, 'what'))), /unknown element type 0x42/);
});

test('a key named __proto__ stays a key, and does not reach the prototype', () => {
	const read = decode(doc(el(0x10, '__proto__', le32(1))));
	assert.equal(Object.getPrototypeOf(read), Object.prototype);
	assert.deepEqual(Object.keys(read), ['__proto__']);
});

// ---------------------------------------------------------------------------
// OP_MSG
// ---------------------------------------------------------------------------

test('a command goes out as one OP_MSG, with its name as the first key', () => {
	const message = Buffer.from(mongo.opMsg(7, { insert: 'hub_messages', documents: [{ _id: 'x' }], $db: 'hub' }));

	assert.equal(message.readInt32LE(0), message.length, 'messageLength');
	assert.equal(message.readInt32LE(4), 7, 'requestID');
	assert.equal(message.readInt32LE(8), 0, 'responseTo');
	assert.equal(message.readInt32LE(12), 2013, 'opCode is OP_MSG');
	assert.equal(message.readUInt32LE(16), 0, 'no flags');
	assert.equal(message[20], 0, 'one body section');
	const body = decode(message.subarray(21));
	assert.deepEqual(Object.keys(body), ['insert', 'documents', '$db']);
});

test('an answer is read from its body section, past a document sequence and a checksum', () => {
	const body = encode({ ok: 1, n: 1 });
	const sequence = Buffer.concat([le32(4 + 3 + 5), cstr('ab'), encode({})]);
	const sections = Buffer.concat([Buffer.of(1), sequence, Buffer.of(0), body]);
	const header = Buffer.alloc(20);
	const length = 20 + sections.length + 4;
	header.writeInt32LE(length, 0);
	header.writeInt32LE(99, 4);
	header.writeInt32LE(7, 8);
	header.writeInt32LE(2013, 12);
	header.writeUInt32LE(1, 16);
	const message = Buffer.concat([header, sections, Buffer.alloc(4)]);

	assert.deepEqual(mongo.readReply(message), { responseTo: 7, body: { ok: 1, n: 1 } });
});

// ---------------------------------------------------------------------------
// SCRAM
// ---------------------------------------------------------------------------

test('the SCRAM exchange matches RFC 5802 (SHA-1), message for message', () => {
	const { clientFinal, serverSignature } = mongo.scramFinal(
		'sha1',
		'pencil',
		'n=user,r=fyko+d2lbbFgONRv9qkxdawL',
		'fyko+d2lbbFgONRv9qkxdawL',
		'r=fyko+d2lbbFgONRv9qkxdawL3rfcNHYJY1ZVvWVs7j,s=QSXCR+Q6sek8bf92,i=4096'
	);
	assert.equal(clientFinal, 'c=biws,r=fyko+d2lbbFgONRv9qkxdawL3rfcNHYJY1ZVvWVs7j,p=v0X8v3Bz2T0CJGbJQyF0X+HI4Ts=');
	assert.equal(serverSignature.toString('base64'), 'rmF9pqV8S7suAoZWja4dJRkFsKQ=');
});

test('SCRAM-SHA-256 matches RFC 7677, message for message', () => {
	const scram = new mongo.Scram('SCRAM-SHA-256', { user: 'user', password: 'pencil' }, 'rOprNGfwEbeRWgbNEkqO');
	assert.equal(scram.first(), 'n,,n=user,r=rOprNGfwEbeRWgbNEkqO');
	assert.equal(
		scram.final('r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096'),
		'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ='
	);
	assert.doesNotThrow(() => scram.verify('v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4='));
});

test("SCRAM-SHA-1 hashes MongoDB's digest of the password, as in the MongoDB specification's example", () => {
	const scram = new mongo.Scram('SCRAM-SHA-1', { user: 'user', password: 'pencil' }, 'fyko+d2lbbFgONRv9qkxdawL');
	assert.equal(scram.first(), 'n,,n=user,r=fyko+d2lbbFgONRv9qkxdawL');
	assert.equal(
		scram.final('r=fyko+d2lbbFgONRv9qkxdawLHo+Vgk7qvUOKUwuWLIWg4l/9SraGMHEE,s=rQ9ZY3MntBeuP3E1TDVC4w==,i=10000'),
		'c=biws,r=fyko+d2lbbFgONRv9qkxdawLHo+Vgk7qvUOKUwuWLIWg4l/9SraGMHEE,p=MC2T8BvbmWRckDw8oWl5IVghwCY='
	);
	assert.doesNotThrow(() => scram.verify('v=UMWeI25JD1yNYZRMpZ4VHvhZ9e0='));
});

test('a server that cannot sign, or that weakens the exchange, is not believed', () => {
	const signed = () => {
		const scram = new mongo.Scram('SCRAM-SHA-256', { user: 'user', password: 'pencil' }, 'rOprNGfwEbeRWgbNEkqO');
		scram.final('r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096');
		return scram;
	};
	// One character changed in the middle. The last one before the `=` would not do: in a 32-byte
	// signature its low two bits are padding, and `...G5=` decodes to the same bytes as `...G4=`.
	assert.throws(() => signed().verify('v=6rriTRBi23WpRR/wtup+mMhUZUn/dB6nLTJRsjl95G4='), /could not prove/);
	assert.throws(() => signed().verify(''), /could not prove/);
	assert.throws(() => signed().verify('e=invalid-proof'), /ended the login: invalid-proof/);

	const fresh = () => new mongo.Scram('SCRAM-SHA-256', { user: 'user', password: 'pencil' }, 'rOprNGfwEbeRWgbNEkqO');
	assert.throws(() => fresh().final('r=rOprNGfwEbeRWgbNEkqOabc,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=1000'), /no fewer than 4096/);
	assert.throws(() => fresh().final('r=someoneElse,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096'), /does not extend the client nonce/);
	assert.throws(() => fresh().final('r=rOprNGfwEbeRWgbNEkqO,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096'), /does not extend the client nonce/);
});

test('the user name is escaped where SCRAM would read it as the end of an attribute', () => {
	assert.equal(new mongo.Scram('SCRAM-SHA-1', { user: 'a=b,c', password: 'p' }, 'N').first(), 'n,,n=a=3Db=2Cc,r=N');
});

test('the mechanism is SCRAM-SHA-256 when the user has it, and SCRAM-SHA-1 otherwise', () => {
	assert.equal(mongo.mechanismFor({ saslSupportedMechs: ['SCRAM-SHA-1', 'SCRAM-SHA-256'] }), 'SCRAM-SHA-256');
	assert.equal(mongo.mechanismFor({ saslSupportedMechs: ['SCRAM-SHA-1'] }), 'SCRAM-SHA-1');
	assert.equal(mongo.mechanismFor({ ismaster: true }), 'SCRAM-SHA-1', 'a server that lists none');
});

// ---------------------------------------------------------------------------
// A cluster in this process
// ---------------------------------------------------------------------------

const USER = 'docdbadmin';
const PASSWORD = 'correct-horse-battery';
const SECRET = JSON.stringify({ username: USER, password: PASSWORD });

interface FakeOptions {
	/** What `isMaster` lists in `saslSupportedMechs`; absent, it lists nothing. */
	readonly mechs?: readonly string[];
	/** The password the server checks the proof against. */
	readonly password?: string;
	/** False: the server wants the empty round `skipEmptyExchange` exists to skip. */
	readonly honoursSkip?: boolean;
	/** True: the server answers the proof with a signature it did not compute. */
	readonly forgesSignature?: boolean;
	/** A code to refuse `createIndexes` with. */
	readonly refusesIndex?: number;
	/** An `ok: 0` answer to every insert. */
	readonly refusesInsert?: Doc;
	/** A write error to report, with `ok: 1`, on every insert of a new document. */
	readonly writeError?: Doc;
}

interface FakeCluster {
	readonly port: number;
	readonly commands: Doc[];
	readonly stored: Map<string, Doc>;
	/** Resolves once every connection the server accepted is closed. */
	closed(): Promise<void>;
}

const servers: net.Server[] = [];
after(async () => {
	await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

/**
 * A server that answers OP_MSG, and checks the login with its own SCRAM: the stored key derived
 * from the password it knows, the client key recovered from the proof, and the signature it sends
 * back — the server half of RFC 5802, independent of the client half under test.
 */
async function fakeCluster(options: FakeOptions = {}): Promise<FakeCluster> {
	const commands: Doc[] = [];
	const stored = new Map<string, Doc>();
	let connections = 0;
	let waiters: (() => void)[] = [];
	let serverId = 1000;

	const answerTo = (requestId: number, body: Doc): Buffer => {
		const message = Buffer.from(mongo.opMsg(serverId++, body));
		message.writeInt32LE(requestId, 8);
		return message;
	};

	const server = net.createServer((socket) => {
		connections++;
		socket.on('close', () => {
			connections--;
			if (connections === 0) for (const w of waiters.splice(0)) w();
		});
		socket.on('error', () => {});

		let pending = Buffer.alloc(0);
		let loggedIn = false;
		let login: { hash: 'sha1' | 'sha256'; bare: string; serverFirst: string; salt: Buffer; iterations: number; nonce: string; done: boolean } | undefined;

		const respond = (body: Doc): Doc => {
			const name = Object.keys(body)[0];
			switch (name) {
				case 'isMaster':
					return { ismaster: true, maxWireVersion: 13, ...(options.mechs ? { saslSupportedMechs: options.mechs } : {}), ok: 1 };
				case 'saslStart': {
					const mechanism = String(body['mechanism']);
					const first = Buffer.from(body['payload'] as Uint8Array).toString('utf8');
					const bare = first.slice('n,,'.length);
					const clientNonce = /r=([^,]+)/.exec(bare)?.[1] ?? '';
					const nonce = `${clientNonce}SeRvEr`;
					const salt = Buffer.from('salt-of-the-test');
					const iterations = 4096;
					const serverFirst = `r=${nonce},s=${salt.toString('base64')},i=${iterations}`;
					login = { hash: mechanism === 'SCRAM-SHA-256' ? 'sha256' : 'sha1', bare, serverFirst, salt, iterations, nonce, done: false };
					return { conversationId: 1, payload: Buffer.from(serverFirst), done: false, ok: 1 };
				}
				case 'saslContinue': {
					if (!login) return { ok: 0, code: 17, errmsg: 'no conversation' };
					if (login.done) return { conversationId: 1, payload: new Uint8Array(0), done: true, ok: 1 };
					const final = Buffer.from(body['payload'] as Uint8Array).toString('utf8');
					const withoutProof = final.slice(0, final.lastIndexOf(',p='));
					const proof = Buffer.from(final.slice(final.lastIndexOf(',p=') + 3), 'base64');
					const password = options.password ?? PASSWORD;
					const secret =
						login.hash === 'sha1' ? createHash('md5').update(`${USER}:mongo:${password}`).digest('hex') : password;
					const salted = pbkdf2Sync(secret, login.salt, login.iterations, login.hash === 'sha1' ? 20 : 32, login.hash);
					const storedKey = createHash(login.hash).update(createHmac(login.hash, salted).update('Client Key').digest()).digest();
					const authMessage = `${login.bare},${login.serverFirst},${withoutProof}`;
					const signature = createHmac(login.hash, storedKey).update(authMessage).digest();
					const clientKey = Buffer.from(proof.map((b, i) => b ^ signature[i]!));
					const recovered = createHash(login.hash).update(clientKey).digest();
					if (withoutProof !== `c=biws,r=${login.nonce}` || recovered.length !== storedKey.length || !timingSafeEqual(recovered, storedKey)) {
						return { ok: 0, code: 18, codeName: 'AuthenticationFailed', errmsg: 'Authentication failed.' };
					}
					const serverKey = createHmac(login.hash, salted).update('Server Key').digest();
					const serverSignature = options.forgesSignature
						? Buffer.alloc(serverKey.length, 7)
						: createHmac(login.hash, serverKey).update(authMessage).digest();
					loggedIn = true;
					login.done = true;
					return {
						conversationId: 1,
						payload: Buffer.from(`v=${serverSignature.toString('base64')}`),
						done: options.honoursSkip !== false,
						ok: 1,
					};
				}
				case 'createIndexes':
					if (!loggedIn) return { ok: 0, code: 13, codeName: 'Unauthorized', errmsg: 'command createIndexes requires authentication' };
					if (options.refusesIndex) return { ok: 0, code: options.refusesIndex, codeName: 'Unauthorized', errmsg: 'not authorized' };
					return { numIndexesBefore: 1, numIndexesAfter: 2, ok: 1 };
				case 'insert': {
					if (!loggedIn) return { ok: 0, code: 13, codeName: 'Unauthorized', errmsg: 'command insert requires authentication' };
					if (options.refusesInsert) return { ok: 0, ...options.refusesInsert };
					const [document] = body['documents'] as Doc[];
					const id = String(document!['_id']);
					if (stored.has(id)) {
						return { n: 0, writeErrors: [{ index: 0, code: 11000, errmsg: `E11000 duplicate key error collection: hub.hub_messages index: _id_ dup key: { _id: "${id}" }` }], ok: 1 };
					}
					if (options.writeError) return { n: 0, writeErrors: [{ index: 0, ...options.writeError }], ok: 1 };
					stored.set(id, document!);
					return { n: 1, ok: 1 };
				}
				default:
					return { ok: 0, code: 59, codeName: 'CommandNotFound', errmsg: `no such command: '${name}'` };
			}
		};

		socket.on('data', (chunk: Buffer) => {
			pending = Buffer.concat([pending, chunk]);
			while (pending.length >= 4 && pending.length >= pending.readInt32LE(0)) {
				const message = pending.subarray(0, pending.readInt32LE(0));
				pending = pending.subarray(message.length);
				assert.equal(message.readInt32LE(12), 2013, 'the client speaks OP_MSG');
				const body = decode(message.subarray(21));
				commands.push(body);
				socket.write(answerTo(message.readInt32LE(4), respond(body)));
			}
		});
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	servers.push(server);
	const port = (server.address() as net.AddressInfo).port;

	return {
		port,
		commands,
		stored,
		closed: () =>
			connections === 0
				? Promise.resolve()
				: new Promise<void>((resolve, reject) => {
						const timer = setTimeout(() => reject(new Error('a connection was left open')), 2000);
						waiters.push(() => {
							clearTimeout(timer);
							resolve();
						});
					}),
	};
}

/** Plain TCP to the cluster above: the test has no certificate for it, so TLS is not what is under test here. */
const plainDial: mongo.Dial = (target) =>
	new Promise((resolve, reject) => {
		const socket = net.connect(target.port, target.host);
		socket.once('connect', () => {
			socket.off('error', reject);
			resolve(socket);
		});
		socket.once('error', reject);
	});

beforeEach(() => mongo.useDial(plainDial));

/** A Secrets Manager that answers with `secretString`, and remembers which calls were made. */
function fakeSecrets(secretString: string = SECRET) {
	const targets: string[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		targets.push(request.headers.get('x-amz-target') ?? '');
		return new Response(JSON.stringify({ SecretString: secretString }), { status: 200 });
	};
	return { targets, fetchImpl };
}

const NOW = new Date('2026-10-05T18:00:00.000Z');

const ctxWith = (fetchImpl: typeof fetch): Ctx => ({
	self: 'Fn',
	fetch: fetchImpl,
	region: (n) => n?.props['REGION'] ?? 'us-west-2',
	account: () => '111122223333',
	now: () => NOW,
});

const wire = (cluster: FakeCluster, props: Record<string, string> = {}): Neighbor => ({
	type: 'aws_docdb_cluster',
	label: '0',
	props: {
		NAME: 'catalog',
		ENDPOINT: '127.0.0.1',
		PORT: String(cluster.port),
		SECRET_ARN: 'arn:aws:secretsmanager:us-west-2:111122223333:secret:rds!cluster-1-AbCdEf',
		...props,
	},
});

const envelope = (body = 'the message'): Envelope => open(body, 'Worker', { trace: 'trace-1', at: '2026-10-04T12:00:00.000Z' });

const send = (n: Neighbor, e: Envelope, ctx: Ctx) => {
	const sender = registry.get('aws_docdb_cluster')?.send;
	assert.ok(sender, 'aws_docdb_cluster declares no sender');
	return sender(n, e, ctx);
};

const names = (commands: Doc[]): string[] => commands.map((c) => Object.keys(c)[0]!);

test('the wire is read as the catalog writes it', () => {
	const neighbors = discover(
		{
			AWS_DOCDB_CLUSTER_NAME_0: 'catalog',
			AWS_DOCDB_CLUSTER_ENDPOINT_0: 'catalog.cluster-abc.us-west-2.docdb.amazonaws.com',
			AWS_DOCDB_CLUSTER_PORT_0: '27017',
			AWS_DOCDB_CLUSTER_SECRET_ARN_0: 'arn:aws:secretsmanager:us-west-2:111122223333:secret:rds!cluster-1',
		},
		registry.vocabulary()
	);
	assert.deepEqual(
		neighbors.map((n) => [n.type, n.label, Object.keys(n.props).sort()]),
		[['aws_docdb_cluster', '0', ['ENDPOINT', 'NAME', 'PORT', 'SECRET_ARN']]]
	);
});

test('the message becomes one document of hub.hub_messages, written after logging in with the secret', async () => {
	const cluster = await fakeCluster({ mechs: ['SCRAM-SHA-1', 'SCRAM-SHA-256'] });
	const secrets = fakeSecrets();
	const ctx = ctxWith(secrets.fetchImpl);
	const e = envelope();

	await send(wire(cluster), e, ctx);

	assert.deepEqual(secrets.targets, ['secretsmanager.GetSecretValue']);
	assert.deepEqual(names(cluster.commands), ['isMaster', 'saslStart', 'saslContinue', 'createIndexes', 'insert']);

	const [hello, start, , index, insert] = cluster.commands;
	assert.equal(hello!['saslSupportedMechs'], `admin.${USER}`);
	assert.equal(hello!['$db'], 'admin');
	assert.equal(start!['mechanism'], 'SCRAM-SHA-256', 'the stronger mechanism, since the user has it');
	assert.equal(start!['$db'], 'admin');
	assert.deepEqual([index!['createIndexes'], index!['$db'], index!['indexes']], ['hub_messages', 'hub', [{ key: { trace: 1 }, name: 'trace_1' }]]);
	assert.deepEqual([insert!['insert'], insert!['$db'], insert!['ordered']], ['hub_messages', 'hub', true]);

	const record = await recordOf(e, ctx);
	assert.deepEqual([...cluster.stored.values()], [
		{
			_id: record.id,
			trace: 'trace-1',
			path: 'Worker',
			receiver: 'Fn',
			digest: record.digest,
			hops: record.hops,
			sent_at: new Date('2026-10-04T12:00:00.000Z'),
			body: 'the message',
			stored_at: NOW,
		},
	]);
	await cluster.closed();
});

test('a redelivery is not a second document, and the index is made sure of once per container', async () => {
	const cluster = await fakeCluster();
	const ctx = ctxWith(fakeSecrets().fetchImpl);

	await send(wire(cluster), envelope(), ctx);
	await send(wire(cluster), envelope(), ctx);
	await send(wire(cluster), envelope('another message'), ctx);

	assert.equal(cluster.stored.size, 2);
	assert.equal(names(cluster.commands).filter((c) => c === 'createIndexes').length, 1);
	assert.equal(names(cluster.commands).filter((c) => c === 'insert').length, 3);
	await cluster.closed();
});

test('a server that lists no mechanism, as one before DocumentDB 5.0.1, is logged in with SCRAM-SHA-1', async () => {
	const cluster = await fakeCluster();

	await send(wire(cluster), envelope(), ctxWith(fakeSecrets().fetchImpl));

	assert.equal(cluster.commands.find((c) => 'saslStart' in c)!['mechanism'], 'SCRAM-SHA-1');
	assert.equal(cluster.stored.size, 1);
});

test('a server that wants the empty round of the login gets it', async () => {
	const cluster = await fakeCluster({ honoursSkip: false });

	await send(wire(cluster), envelope(), ctxWith(fakeSecrets().fetchImpl));

	assert.deepEqual(names(cluster.commands).slice(0, 4), ['isMaster', 'saslStart', 'saslContinue', 'saslContinue']);
	assert.equal(cluster.stored.size, 1);
});

test('a refused password says so, and the password is in no report', async () => {
	const cluster = await fakeCluster({ password: 'not-the-one-in-the-secret' });

	await assert.rejects(send(wire(cluster), envelope(), ctxWith(fakeSecrets().fetchImpl)), (err: Error) => {
		assert.match(err.message, /^18 AuthenticationFailed: Authentication failed\./);
		assert.match(err.message, /refused the user name and password the secret holds/);
		assert.ok(!err.message.includes(PASSWORD), 'the password reached the report');
		return true;
	});
	assert.ok(!names(cluster.commands).includes('insert'));
	await cluster.closed();
});

test('a server that cannot prove it knows the password is not written to', async () => {
	const cluster = await fakeCluster({ forgesSignature: true });

	await assert.rejects(send(wire(cluster), envelope(), ctxWith(fakeSecrets().fetchImpl)), /could not prove that it knows the password/);
	assert.ok(!names(cluster.commands).includes('insert'));
	await cluster.closed();
});

test('an index the user may not create does not stop the write', async () => {
	const cluster = await fakeCluster({ refusesIndex: 13 });

	await send(wire(cluster), envelope(), ctxWith(fakeSecrets().fetchImpl));

	assert.equal(cluster.stored.size, 1);
});

test('a write the server refuses fails with its words, whether it answers ok or not', async () => {
	const rejected = await fakeCluster({ writeError: { code: 121, errmsg: 'Document failed validation' } });
	await assert.rejects(send(wire(rejected), envelope(), ctxWith(fakeSecrets().fetchImpl)), /121: Document failed validation/);
	await rejected.closed();

	const replica = await fakeCluster({ refusesInsert: { code: 10107, codeName: 'NotWritablePrimary', errmsg: 'not primary' } });
	await assert.rejects(send(wire(replica), envelope(), ctxWith(fakeSecrets().fetchImpl)), (err: Error) => {
		assert.match(err.message, /^10107 NotWritablePrimary: not primary/);
		assert.match(err.message, /ENDPOINT has to be the cluster endpoint/);
		return true;
	});
	await replica.closed();
});

test('a cluster with a typed password is refused before anything is read or sent', async () => {
	const cluster = await fakeCluster();
	const secrets = fakeSecrets();

	await assert.rejects(send(wire(cluster, { SECRET_ARN: '' }), envelope(), ctxWith(secrets.fetchImpl)), /manage_master_user_password/);
	await assert.rejects(send(wire(cluster, { ENDPOINT: '' }), envelope(), ctxWith(secrets.fetchImpl)), /compile it again/);
	await assert.rejects(send(wire(cluster, { PORT: 'twenty' }), envelope(), ctxWith(secrets.fetchImpl)), /"twenty" is not a port/);

	assert.deepEqual(secrets.targets, []);
	assert.deepEqual(cluster.commands, []);
});

test('the endpoint may carry its port, as an instance endpoint does', async () => {
	const cluster = await fakeCluster();
	const { PORT: _, ...props } = wire(cluster).props;

	await send({ type: 'aws_docdb_cluster', label: '0', props: { ...props, ENDPOINT: `127.0.0.1:${cluster.port}` } }, envelope(), ctxWith(fakeSecrets().fetchImpl));

	assert.equal(cluster.stored.size, 1);
});

test('a cluster that does not answer says where to look, after the wait it was given', async () => {
	// A TCP server that never answers the TLS handshake: what a security group that drops the
	// connection looks like from the client, except that it fails faster.
	const sockets: net.Socket[] = [];
	const silent = net.createServer((socket) => {
		sockets.push(socket);
		socket.on('error', () => {});
	});
	await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
	servers.push(silent);
	const port = (silent.address() as net.AddressInfo).port;
	mongo.useDial(undefined);

	try {
		await assert.rejects(mongo.connect({ host: '127.0.0.1', port }, { user: USER, password: PASSWORD }, { connectTimeoutMs: 200 }), (err: Error & { code?: string }) => {
			assert.equal(err.code, 'ETIMEDOUT');
			assert.match(err.message, /no answer in 0\.2 s/);
			assert.match(err.message, new RegExp(`subnet of the cluster's VPC, and the cluster's security group has to admit it on port ${port}`));
			return true;
		});
	} finally {
		for (const s of sockets) s.destroy();
	}
});

test('every failure to connect points at its cause', () => {
	const target = { host: 'catalog.cluster-abc.us-west-2.docdb.amazonaws.com', port: 27017 };
	const described = (code: string) => mongo.describeConnect(Object.assign(new Error('failed'), { code }), target, 5000).message;

	assert.match(described('DEPTH_ZERO_SELF_SIGNED_CERT'), /does not trust the database certificate authority.*NODE_EXTRA_CA_CERTS/);
	assert.match(described('UNABLE_TO_GET_ISSUER_CERT_LOCALLY'), /\/var\/runtime\/ca-cert\.pem/);
	assert.match(described('ERR_SSL_WRONG_VERSION_NUMBER'), /turns TLS off/);
	assert.match(described('ECONNREFUSED'), /port 27017/);
	assert.match(described('ENOTFOUND'), /does not resolve/);
	assert.match(described('EHOSTUNREACH'), /no answer in 5 s/);
	assert.equal(mongo.describeConnect(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), target, 1).code, 'ECONNREFUSED');
});
