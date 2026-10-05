/**
 * BSON, the encoding a MongoDB-compatible database speaks: enough of it to send a command and to
 * read the answer.
 *
 * ENCODED: only what this package writes — strings, numbers, booleans, null, dates, binary data,
 * arrays and documents. Anything else is refused instead of guessed at: a value silently written
 * as something else is a document nobody can query for.
 *
 * DECODED: every type the specification defines. The answer is the server's to shape — a replica
 * set's `isMaster` carries an ObjectId and a Timestamp, and an element can only be stepped over by
 * a reader that knows its size. The types JavaScript has no value for come back as the
 * `{ $oid }`, `{ $timestamp }`... objects of MongoDB's Extended JSON.
 *
 * Little-endian throughout, as the specification says: https://bsonspec.org/spec.html
 */

const utf8 = new TextEncoder();
const text = new TextDecoder();

/** Element types, by the byte that precedes the element's name. */
const DOUBLE = 0x01;
const STRING = 0x02;
const DOCUMENT = 0x03;
const ARRAY = 0x04;
const BINARY = 0x05;
const UNDEFINED = 0x06;
const OBJECT_ID = 0x07;
const BOOLEAN = 0x08;
const DATETIME = 0x09;
const NULL = 0x0a;
const REGEX = 0x0b;
const DB_POINTER = 0x0c;
const CODE = 0x0d;
const SYMBOL = 0x0e;
const CODE_WITH_SCOPE = 0x0f;
const INT32 = 0x10;
const TIMESTAMP = 0x11;
const INT64 = 0x12;
const DECIMAL128 = 0x13;
const MAX_KEY = 0x7f;
const MIN_KEY = 0xff;

export type Document = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
};

const int32 = (n: number): Uint8Array => {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setInt32(0, n, true);
	return out;
};

const int64 = (n: bigint): Uint8Array => {
	const out = new Uint8Array(8);
	new DataView(out.buffer).setBigInt64(0, n, true);
	return out;
};

const double = (n: number): Uint8Array => {
	const out = new Uint8Array(8);
	new DataView(out.buffer).setFloat64(0, n, true);
	return out;
};

/** A name, NUL-terminated. A name cannot carry a NUL of its own: it would end there. */
const cstring = (name: string): Uint8Array => {
	if (name.includes('\0')) throw new TypeError(`a BSON name cannot contain a NUL: ${JSON.stringify(name)}`);
	return concat([utf8.encode(name), Uint8Array.of(0)]);
};

const string = (value: string): Uint8Array => {
	const bytes = utf8.encode(value);
	return concat([int32(bytes.length + 1), bytes, Uint8Array.of(0)]);
};

const isInt32 = (n: number): boolean => Number.isInteger(n) && n >= -0x80000000 && n <= 0x7fffffff;

function element(name: string, value: unknown): Uint8Array {
	const key = cstring(name);
	const typed = (type: number, ...payload: Uint8Array[]): Uint8Array => concat([Uint8Array.of(type), key, ...payload]);

	if (typeof value === 'string') return typed(STRING, string(value));
	if (typeof value === 'number') return isInt32(value) ? typed(INT32, int32(value)) : typed(DOUBLE, double(value));
	if (typeof value === 'bigint') return typed(INT64, int64(value));
	if (typeof value === 'boolean') return typed(BOOLEAN, Uint8Array.of(value ? 1 : 0));
	if (value === null) return typed(NULL);
	if (value instanceof Date) {
		const ms = value.getTime();
		if (Number.isNaN(ms)) throw new TypeError(`${JSON.stringify(name)} is an invalid date`);
		return typed(DATETIME, int64(BigInt(ms)));
	}
	if (value instanceof Uint8Array) return typed(BINARY, int32(value.length), Uint8Array.of(0), value);
	// An array is a document whose names are its indexes. A hole has no name to skip to, so it is
	// written as null.
	if (Array.isArray(value)) return typed(ARRAY, document(value.map((v, i) => [String(i), v === undefined ? null : v])));
	if (typeof value === 'object') return typed(DOCUMENT, document(Object.entries(value as Document)));

	throw new TypeError(`${JSON.stringify(name)} holds a ${typeof value}, which BSON is not written with here`);
}

function document(entries: readonly (readonly [string, unknown])[]): Uint8Array {
	// `undefined` is a key without a value in JavaScript, and is left out, as JSON leaves it out.
	const elements = entries.filter(([, v]) => v !== undefined).map(([name, v]) => element(name, v));
	const size = 4 + elements.reduce((n, e) => n + e.length, 0) + 1;
	return concat([int32(size), ...elements, Uint8Array.of(0)]);
}

/**
 * A document, as bytes. The keys go out in the object's own order — which matters, because a
 * command is named by its FIRST key — and JavaScript keeps that order for every key that is not an
 * array index.
 */
export const encode = (doc: Readonly<Document>): Uint8Array => document(Object.entries(doc));

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

const malformed = (what: string): Error => new Error(`malformed BSON: ${what}`);

/** Sets a key without letting a name like `__proto__` reach the object's prototype. */
function put(out: Document, name: string, value: unknown): void {
	if (name === '__proto__') Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true });
	else out[name] = value;
}

class Reader {
	private readonly view: DataView;

	constructor(private readonly bytes: Uint8Array) {
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}

	private need(at: number, n: number, end: number): void {
		if (at < 0 || at + n > end) throw malformed('an element runs past the end of its document');
	}

	private cstringAt(at: number, end: number): [string, number] {
		const stop = this.bytes.indexOf(0, at);
		if (stop < 0 || stop >= end) throw malformed('a name has no end');
		return [text.decode(this.bytes.subarray(at, stop)), stop + 1];
	}

	private stringAt(at: number, end: number): [string, number] {
		this.need(at, 4, end);
		const length = this.view.getInt32(at, true);
		if (length < 1) throw malformed('a string has a length below one');
		this.need(at + 4, length, end);
		if (this.bytes[at + 4 + length - 1] !== 0) throw malformed('a string does not end in NUL');
		return [text.decode(this.bytes.subarray(at + 4, at + 4 + length - 1)), at + 4 + length];
	}

	private hex(at: number, n: number, end: number): string {
		this.need(at, n, end);
		return [...this.bytes.subarray(at, at + n)].map((b) => b.toString(16).padStart(2, '0')).join('');
	}

	private int64At(at: number, end: number): number | bigint {
		this.need(at, 8, end);
		const n = this.view.getBigInt64(at, true);
		return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
	}

	/** The document starting at `at`, as an object or, for an array, as a list. */
	document(at: number, asArray: boolean): [Document | unknown[], number] {
		if (at < 0 || at + 5 > this.bytes.length) throw malformed('a document is shorter than its header');
		const size = this.view.getInt32(at, true);
		const end = at + size;
		if (size < 5 || end > this.bytes.length) throw malformed(`a document claims ${size} bytes`);
		if (this.bytes[end - 1] !== 0) throw malformed('a document does not end in NUL');

		const object: Document = {};
		const list: unknown[] = [];
		let p = at + 4;
		while (p < end - 1) {
			const type = this.bytes[p++]!;
			const [name, afterName] = this.cstringAt(p, end);
			p = afterName;
			let value: unknown;

			switch (type) {
				case DOUBLE:
					this.need(p, 8, end);
					value = this.view.getFloat64(p, true);
					p += 8;
					break;
				case STRING:
				case SYMBOL:
				case CODE: {
					const [s, after] = this.stringAt(p, end);
					value = type === CODE ? { $code: s } : s;
					p = after;
					break;
				}
				case DOCUMENT:
				case ARRAY: {
					const [inner, after] = this.document(p, type === ARRAY);
					if (after > end) throw malformed('a nested document runs past its parent');
					value = inner;
					p = after;
					break;
				}
				case BINARY: {
					this.need(p, 5, end);
					const length = this.view.getInt32(p, true);
					if (length < 0) throw malformed('binary data has a negative length');
					this.need(p + 5, length, end);
					// A copy, so the answer does not keep the whole read buffer alive. Not `slice`: on a
					// Node Buffer, which is what a socket delivers, `slice` is a view.
					value = new Uint8Array(this.bytes.subarray(p + 5, p + 5 + length));
					p += 5 + length;
					break;
				}
				case UNDEFINED:
					value = undefined;
					break;
				case OBJECT_ID:
					value = { $oid: this.hex(p, 12, end) };
					p += 12;
					break;
				case BOOLEAN:
					this.need(p, 1, end);
					value = this.bytes[p] === 1;
					p += 1;
					break;
				case DATETIME: {
					const ms = this.int64At(p, end);
					value = new Date(Number(ms));
					p += 8;
					break;
				}
				case NULL:
					value = null;
					break;
				case REGEX: {
					const [pattern, afterPattern] = this.cstringAt(p, end);
					const [options, afterOptions] = this.cstringAt(afterPattern, end);
					value = { $regex: pattern, $options: options };
					p = afterOptions;
					break;
				}
				case DB_POINTER: {
					const [ref, after] = this.stringAt(p, end);
					value = { $dbPointer: { $ref: ref, $id: { $oid: this.hex(after, 12, end) } } };
					p = after + 12;
					break;
				}
				case CODE_WITH_SCOPE: {
					this.need(p, 4, end);
					const total = this.view.getInt32(p, true);
					this.need(p, total, end);
					const [code, afterCode] = this.stringAt(p + 4, p + total);
					const [scope] = this.document(afterCode, false);
					value = { $code: code, $scope: scope };
					p += total;
					break;
				}
				case INT32:
					this.need(p, 4, end);
					value = this.view.getInt32(p, true);
					p += 4;
					break;
				case TIMESTAMP:
					// The low half is the increment, the high half the seconds.
					this.need(p, 8, end);
					value = { $timestamp: { t: this.view.getUint32(p + 4, true), i: this.view.getUint32(p, true) } };
					p += 8;
					break;
				case INT64:
					value = this.int64At(p, end);
					p += 8;
					break;
				case DECIMAL128:
					value = { $numberDecimal: this.hex(p, 16, end) };
					p += 16;
					break;
				case MIN_KEY:
					value = { $minKey: 1 };
					break;
				case MAX_KEY:
					value = { $maxKey: 1 };
					break;
				default:
					// No size to step over it by, so nothing after it can be read either.
					throw malformed(`unknown element type 0x${type.toString(16).padStart(2, '0')} at ${JSON.stringify(name)}`);
			}

			if (asArray) list.push(value);
			else put(object, name, value);
		}
		return [asArray ? list : object, end];
	}
}

/** The document at the start of `bytes`. */
export function decode(bytes: Uint8Array): Document {
	const [doc] = new Reader(bytes).document(0, false);
	return doc as Document;
}
