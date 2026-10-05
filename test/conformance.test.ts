/**
 * The conformance suite.
 *
 * Nobody writes a test for a new resource. This file iterates the registry and applies the same
 * demands to every module in it, so resource number forty arrives with the guarantees resource
 * number one had. When these rules change, they change once.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../dist/resources/index.js';
import * as registry from '../dist/core/registry.js';
import { normalize } from '../dist/core/hub.js';
import { open } from '../dist/core/envelope.js';
import * as mongo from '../dist/providers/mongo.js';
import * as sql from '../dist/providers/sql.js';
import type { Capability, Ctx, Neighbor } from '../dist/core/types.js';
// Explicit .ts: Node's type stripping resolves the path as written and does not rewrite .js to
// .ts. Imports of built code keep pointing at dist, which is what ships.
import { EVENTS, FOREIGN } from './fixtures/events.ts';

const MODULES = registry.all();

const CAPABILITIES: readonly Capability[] = [
	'queue',
	'topic',
	'stream',
	'object-store',
	'table',
	'secret',
	'parameter',
	'filesystem',
	'function',
	'http',
];

/** A neighbor carrying every common value, so no sender fails for want of one. */
const complete = (type: string): Neighbor => ({
	type,
	label: '0',
	props: {
		NAME: 'the-resource',
		ARN: `arn:aws:service:us-east-1:111122223333:${type}/the-resource`,
		URL: 'https://example.invalid/endpoint',
		ENDPOINT: 'https://example.invalid/endpoint',
		BUCKET: 'the-resource',
		QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/111122223333/the-resource',
		SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:111122223333:secret:the-resource',
		DB_NAME: 'the-database',
		ENGINE: 'postgres',
		ENGINE_FAMILY: 'POSTGRESQL',
		PORT: '5432',
		REGION: 'us-east-1',
		ACCOUNT: '111122223333',
	},
});

const ctxWith = (fetchImpl: typeof fetch): Ctx => ({
	self: 'Fn',
	fetch: fetchImpl,
	region: (n) => n?.props['REGION'] ?? 'us-east-1',
	account: (n) => n?.props['ACCOUNT'] ?? '111122223333',
	now: () => new Date('2026-08-16T12:00:00Z'),
});

const okFetch: typeof fetch = async (input, init) => {
	const request = input instanceof Request ? input : new Request(input, init);
	// The one read a sender legitimately makes before it writes: the database module fetches the
	// credential it connects with, and an empty answer would be refused as not being one.
	const body =
		request.headers.get('x-amz-target') === 'secretsmanager.GetSecretValue'
			? JSON.stringify({ SecretString: JSON.stringify({ username: 'user', password: 'pass' }) })
			: '{}';
	return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
};

const ENVELOPE = open('payload', 'Fn', { trace: 'T', at: '2026-08-16T12:00:00.000Z' });

// Credentials so signing has something to work with. The fake fetch never leaves the process.
process.env['AWS_ACCESS_KEY_ID'] ??= 'AKIAIOSFODNN7EXAMPLE';
process.env['AWS_SECRET_ACCESS_KEY'] ??= 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

// A database is reached over TCP, not through `fetch`, so the fake `fetch` above cannot stand in
// for it. The suite hands the Postgres family a driver that accepts and does nothing, which keeps
// the rules below about the module's behavior and away from the network.
sql.useDriver('postgres', {
	connect: async () => ({ run: async () => {}, close: async () => {} }),
});
// The same for a DocumentDB cluster, whose protocol is not SQL: a connection whose every command
// is answered `ok: 1`.
mongo.useConnector(async () => ({ command: async () => ({ ok: 1 }), close: async () => {} }));

test('the registry is not empty', () => {
	assert.ok(MODULES.length >= 18, `expected the bundled resources, found ${MODULES.length}`);
});

for (const mod of MODULES) {
	test(`${mod.type}: declares a way to be reached`, () => {
		assert.ok(mod.send || mod.receive);
	});

	test(`${mod.type}: uses catalog naming`, () => {
		assert.match(mod.type, /^[a-z][a-z0-9_]*$/);
	});

	test(`${mod.type}: declares only known capabilities`, () => {
		for (const cap of mod.capabilities ?? []) {
			assert.ok(CAPABILITIES.includes(cap), `unknown capability ${cap}`);
		}
	});

	test(`${mod.type}: declares keys in the grammar's case`, () => {
		for (const key of mod.keys ?? []) assert.match(key, /^[A-Z][A-Z0-9_]*$/);
	});

	if (mod.send) {
		test(`${mod.type}: sends without throwing when the wire is complete`, async () => {
			await mod.send!(complete(mod.type), ENVELOPE, ctxWith(okFetch));
		});

		test(`${mod.type}: refuses an empty wire with a readable reason, not a crash`, async () => {
			const bare: Neighbor = { type: mod.type, label: '0', props: {} };
			await assert.rejects(
				() => mod.send!(bare, ENVELOPE, ctxWith(okFetch)),
				(err: unknown) => {
					// A TypeError here means the sender read a property off undefined instead of
					// checking for it — the report would show a stack trace where a diagnosis
					// belongs.
					assert.ok(err instanceof Error, 'threw a non-Error');
					assert.ok(!(err instanceof TypeError), `crashed instead of reporting: ${String(err)}`);
					assert.ok(err.message.length > 0, 'threw an Error with no message');
					return true;
				}
			);
		});

		test(`${mod.type}: surfaces a refusal from the service`, async () => {
			const denied: typeof fetch = async () =>
				new Response('{"__type":"com.amazon.coral#AccessDeniedException","message":"denied"}', {
					status: 403,
				});
			await assert.rejects(
				() => mod.send!(complete(mod.type), ENVELOPE, ctxWith(denied)),
				/AccessDenied|denied|HTTP 403/
			);
		});
	}
}

test('every source is claimed by exactly one receiver', async () => {
	// The property that makes "any combination" true. Several of these envelopes are nearly
	// identical — API Gateway v2 and a function URL differ only by domain, and six different
	// sources all arrive under `Records`. A detector that is too eager silently steals another
	// source's events, and the symptom is a report attributing traffic to the wrong wire.
	for (const [origin, event] of Object.entries(EVENTS)) {
		const claimants: string[] = [];
		for (const mod of MODULES) {
			if (!mod.receive) continue;
			if (await mod.receive(event)) claimants.push(mod.type);
		}
		assert.equal(claimants.length, 1, `${origin} claimed by [${claimants.join(', ')}]`);
	}
});

test('every source normalizes to its own origin, with at least one item', async () => {
	for (const [origin, event] of Object.entries(EVENTS)) {
		const arrival = await normalize(event);
		assert.equal(arrival.origin, origin, `${origin} normalized as ${arrival.origin}`);
		assert.ok(arrival.items.length >= 1, `${origin} produced no items`);
		assert.ok(arrival.describe.length > 0, `${origin} produced no description`);
	}
});

test('an unrecognized event is a direct invocation, not an error', async () => {
	for (const mod of MODULES) {
		if (!mod.receive) continue;
		assert.equal(await mod.receive(FOREIGN), null, `${mod.type} claimed a foreign event`);
	}
	assert.equal((await normalize(FOREIGN)).origin, 'direct');
});

test('no receiver crashes on a malformed event', async () => {
	for (const junk of [null, undefined, 'string', 42, [], {}, { Records: [] }, { Records: null }]) {
		for (const mod of MODULES) {
			if (!mod.receive) continue;
			await mod.receive(junk); // must not throw
		}
	}
});
