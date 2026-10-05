/**
 * An OpenSearch domain, on the wire.
 *
 * The message becomes a document of `hub_messages` -- the fields a database row carries -- written
 * with a SigV4 signature for `es`, through the same `fetch` every other destination uses. What is
 * locked here is each decision that reads as arbitrary and is not:
 *
 *   * `_create` with the record's id, so a redelivery (409) is not a second document.
 *   * The index is created with its mapping once per container, and a domain that has it, or a
 *     role that may not create it, still gets the write.
 *   * A failure says where to look: the subnet and the security group, fine-grained access
 *     control, or the role's policy.
 *
 * None of this proves a signature AWS accepts; that is the first apply.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../dist/resources/aws_opensearch_domain/index.js';
import * as registry from '../dist/core/registry.js';
import * as aws from '../dist/providers/aws.js';
import { discover } from '../dist/core/discovery.js';
import { open } from '../dist/core/envelope.js';
import type { Ctx, Envelope, Neighbor } from '../dist/core/types.js';

aws.credentials({
	accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
	secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
});

interface Call {
	readonly method: string;
	readonly url: string;
	readonly authorization: string;
	readonly body: Record<string, unknown>;
}

/** A domain that answers from a script: undefined is a 200, a Response is that response. */
function fakeDomain(answer: (call: Call, n: number) => Response | undefined = () => undefined) {
	const calls: Call[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		const text = await request.text();
		const call: Call = {
			method: request.method,
			url: request.url,
			authorization: request.headers.get('authorization') ?? '',
			body: text ? JSON.parse(text) : {},
		};
		calls.push(call);
		return answer(call, calls.length - 1) ?? new Response('{"result":"created"}', { status: 201 });
	};
	return { calls, fetchImpl };
}

/** OpenSearch's error shape. */
const failure = (status: number, type: string, reason: string): Response =>
	new Response(JSON.stringify({ error: { root_cause: [{ type, reason }], type, reason }, status }), {
		status,
		headers: { 'content-type': 'application/json' },
	});

const ctxWith = (fetchImpl: typeof fetch): Ctx => ({
	self: 'Fn',
	fetch: fetchImpl,
	region: (n) => n?.props['REGION'] ?? 'us-west-2',
	account: () => '111122223333',
	now: () => new Date('2026-10-05T18:00:00.000Z'),
});

// A host per test: which domains have their index made sure of is the module's, per process.
let seq = 0;
const wire = (props: Record<string, string> = {}): Neighbor => ({
	type: 'aws_opensearch_domain',
	label: '0',
	props: { NAME: 'search', ENDPOINT: `vpc-search-${++seq}.us-west-2.es.amazonaws.com`, ...props },
});

const envelope = (body = 'the message'): Envelope =>
	open(body, 'Worker', { trace: 'trace-1', at: '2026-10-04T12:00:00.000Z' });

const send = (n: Neighbor, e: Envelope, ctx: Ctx) => {
	const sender = registry.get('aws_opensearch_domain')?.send;
	assert.ok(sender, 'aws_opensearch_domain declares no sender');
	return sender(n, e, ctx);
};

const host = (n: Neighbor) => n.props['ENDPOINT']!;

test('the message is a document of hub_messages, created once, signed for es', async () => {
	const domain = fakeDomain();
	const n = wire();

	await send(n, envelope(), ctxWith(domain.fetchImpl));

	assert.equal(domain.calls.length, 2);
	const [index, document] = domain.calls;

	assert.equal(index!.method, 'PUT');
	assert.equal(index!.url, `https://${host(n)}/hub_messages`);
	assert.deepEqual((index!.body['mappings'] as { properties: Record<string, { type: string }> }).properties['trace'], {
		type: 'keyword',
	});

	assert.equal(document!.method, 'PUT');
	assert.match(document!.url, new RegExp(`^https://${host(n).replace(/\./g, '\\.')}/hub_messages/_create/[0-9a-f]{64}$`));
	for (const call of domain.calls) assert.match(call.authorization, /\/us-west-2\/es\/aws4_request/);

	assert.deepEqual(document!.body, {
		trace: 'trace-1',
		path: 'Worker',
		receiver: 'Fn',
		digest: document!.body['digest'],
		hops: 3,
		sent_at: '2026-10-04T12:00:00.000Z',
		body: 'the message',
		stored_at: '2026-10-05T18:00:00.000Z',
	});
	assert.match(String(document!.body['digest']), /^[0-9a-f]{64}$/);
});

test('the index is made sure of once per domain, not per message', async () => {
	const domain = fakeDomain();
	const n = wire();
	const ctx = ctxWith(domain.fetchImpl);

	await send(n, envelope('one'), ctx);
	await send(n, envelope('two'), ctx);

	assert.deepEqual(
		domain.calls.map((c) => new URL(c.url).pathname.replace(/[0-9a-f]{64}$/, '<id>')),
		['/hub_messages', '/hub_messages/_create/<id>', '/hub_messages/_create/<id>']
	);
});

test('a redelivery finds its document there, and is not a second one', async () => {
	const ids: string[] = [];
	const domain = fakeDomain((call) => {
		if (!call.url.includes('/_create/')) return undefined;
		const id = call.url.split('/').pop()!;
		const seen = ids.includes(id);
		ids.push(id);
		return seen ? failure(409, 'version_conflict_engine_exception', `[${id}]: version conflict, document already exists`) : undefined;
	});
	const n = wire();
	const ctx = ctxWith(domain.fetchImpl);

	await send(n, envelope('same'), ctx);
	await send(n, envelope('same'), ctx);
	await send(n, envelope('other'), ctx);

	assert.equal(ids[0], ids[1], 'the same message must carry the same id');
	assert.notEqual(ids[0], ids[2], 'two messages must not collapse into one document');
});

test('an index that exists, or one the role may not create, still gets the write', async () => {
	for (const refusal of [
		failure(400, 'resource_already_exists_exception', 'index [hub_messages/abc] already exists'),
		failure(403, 'security_exception', 'no permissions for [indices:admin/create]'),
	]) {
		const domain = fakeDomain((call) => (call.url.endsWith('/hub_messages') ? refusal.clone() : undefined));

		await send(wire(), envelope(), ctxWith(domain.fetchImpl));

		assert.equal(domain.calls.filter((c) => c.url.includes('/_create/')).length, 1);
	}
});

test('an index deleted after the container made sure of it is created again', async () => {
	let deleted = false;
	const domain = fakeDomain((call) => {
		if (call.url.includes('/_create/') && deleted) {
			deleted = false;
			return failure(404, 'index_not_found_exception', 'no such index [hub_messages]');
		}
		return undefined;
	});
	const n = wire();
	const ctx = ctxWith(domain.fetchImpl);

	await send(n, envelope('before'), ctx);
	deleted = true;
	await send(n, envelope('after'), ctx);

	assert.deepEqual(
		domain.calls.map((c) => new URL(c.url).pathname.replace(/[0-9a-f]{64}$/, '<id>')),
		['/hub_messages', '/hub_messages/_create/<id>', '/hub_messages/_create/<id>', '/hub_messages', '/hub_messages/_create/<id>']
	);
});

test('fine-grained access control says what the role needs', async () => {
	const domain = fakeDomain((call) =>
		call.url.includes('/_create/')
			? failure(403, 'security_exception', 'no permissions for [indices:data/write/index] and User [name=arn:aws:iam::111122223333:role/fn]')
			: undefined
	);

	await assert.rejects(
		() => send(wire(), envelope(), ctxWith(domain.fetchImpl)),
		/^Error: security_exception: no permissions .*\(the domain has fine-grained access control on: the function's role has to be its master user, or be mapped/
	);
});

test("a role without the domain's permission is told which one", async () => {
	const domain = fakeDomain(
		() =>
			new Response(
				JSON.stringify({
					Message:
						'User: arn:aws:sts::111122223333:assumed-role/fn-role/fn is not authorized to perform: es:ESHttpPut because no identity-based policy allows the es:ESHttpPut action',
				}),
				{ status: 403 }
			)
	);

	await assert.rejects(
		() => send(wire(), envelope(), ctxWith(domain.fetchImpl)),
		/not authorized to perform: es:ESHttpPut .*\(the function's role needs es:ESHttpPut on the domain/
	);
});

test('a domain that never answers points at the subnet and the security group', async () => {
	const unreachable: typeof fetch = async () => {
		throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
	};

	await assert.rejects(
		() => send(wire(), envelope(), ctxWith(unreachable)),
		/the domain did not answer \(UND_ERR_CONNECT_TIMEOUT\): the function has to be in a subnet of the domain's VPC, and the domain's security group has to admit it on port 443/
	);
});

test('an endpoint written as a URL is read for its host', async () => {
	const domain = fakeDomain();

	await send(wire({ ENDPOINT: 'https://vpc-search-url.us-west-2.es.amazonaws.com/' }), envelope(), ctxWith(domain.fetchImpl));

	assert.ok(domain.calls.every((c) => c.url.startsWith('https://vpc-search-url.us-west-2.es.amazonaws.com/hub_messages')));
});

test('a wire with no endpoint is refused before anything is sent, and says to compile again', async () => {
	const domain = fakeDomain();
	const bare: Neighbor = { type: 'aws_opensearch_domain', label: '0', props: { NAME: 'search' } };

	await assert.rejects(() => send(bare, envelope(), ctxWith(domain.fetchImpl)), /no endpoint on the wire: .*compile it again/);
	assert.equal(domain.calls.length, 0);
});

test("a domain's variables are read as one neighbor", () => {
	const neighbors = discover(
		{
			AWS_OPENSEARCH_DOMAIN_NAME_0: 'search',
			AWS_OPENSEARCH_DOMAIN_ENDPOINT_0: 'vpc-search-abc.us-west-2.es.amazonaws.com',
		},
		registry.vocabulary()
	);

	assert.deepEqual(
		neighbors.map((n) => [n.type, n.label, Object.keys(n.props).sort()]),
		[['aws_opensearch_domain', '0', ['ENDPOINT', 'NAME']]]
	);
});
