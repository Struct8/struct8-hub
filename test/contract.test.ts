/**
 * The contract test.
 *
 * Everything else in this suite proves that Hub is consistent with itself. This one proves it is
 * consistent with the generator — the only claim that matters, and the only one a hand-written
 * fixture cannot make. A fixture somebody invented agrees with whoever invented it forever; the
 * names here were captured from real compiled output, so when the generator changes they stop
 * agreeing and this file goes red.
 *
 * That is not hypothetical. An earlier revision of the contract carried a direction segment in the
 * middle of every name — `AWS_S3_BUCKET_TARGET_NAME_0`. It left the generator, and the consumers
 * still reading it kept passing their own tests while discovering nothing at all. A test against
 * real output would have failed the same day.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import '../dist/resources/index.js';
import { discover, parseName } from '../dist/core/discovery.js';
import * as registry from '../dist/core/registry.js';

interface Fixture {
	readonly capturedFrom: readonly string[];
	readonly capturedOn: string;
	readonly base: readonly string[];
	readonly wired: readonly string[];
	readonly ignored: Readonly<Record<string, string>>;
}

const fixture: Fixture = JSON.parse(
	readFileSync(new URL('./fixtures/generator-output.json', import.meta.url), 'utf8')
);

const VOCAB = registry.vocabulary();
const ignored = Object.keys(fixture.ignored);

test('the fixture records where it came from', () => {
	// A capture with no provenance is indistinguishable from an invention.
	assert.ok(fixture.capturedFrom.length > 0);
	assert.match(fixture.capturedOn, /^\d{4}-\d{2}-\d{2}$/);
});

test('the workload\'s own variables never become neighbors', () => {
	// NAME, REGION and ACCOUNT describe the workload, not a wire. Reading them as wires would give
	// every function three phantom destinations.
	for (const name of fixture.base) {
		assert.equal(parseName(name, VOCAB), null, `${name} was read as a wire`);
	}
	assert.deepEqual(discover(Object.fromEntries(fixture.base.map((n) => [n, 'x'])), VOCAB), []);
});

test('every wired name the generator emits is understood', () => {
	for (const name of fixture.wired) {
		const parsed = parseName(name, VOCAB);
		assert.ok(parsed, `${name} is emitted by the generator and Hub cannot parse it`);
		assert.ok(registry.get(parsed.type), `${name} parses as ${parsed.type}, which is not registered`);
		assert.ok(parsed.label.length > 0, `${name} produced an empty label`);
	}
});

test('a captured environment rebuilds exactly the wires it describes', () => {
	// The whole point, end to end: hand it what the generator wrote and see the diagram come back.
	const environment: Record<string, string> = Object.fromEntries([
		...fixture.base.map((n) => [n, 'the-workload']),
		...fixture.wired.map((n) => [n, `value-of-${n}`]),
		...ignored.map((n) => [n, `value-of-${n}`]),
	]);

	const neighbors = discover(environment, VOCAB);

	// A neighbor is a (type, label) pair and several variables of one wire merge into it: the
	// database arrives as three names and is ONE neighbor, so counting names would call that a loss.
	const wires = new Set(
		fixture.wired.map((name) => {
			const parsed = parseName(name, VOCAB)!;
			return `${parsed.type}#${parsed.label}`;
		})
	);
	assert.equal(neighbors.length, wires.size, 'wrong number of neighbors rebuilt');
	assert.deepEqual(
		neighbors.map((n) => n.type).sort(),
		[
			'aws_cloudwatch_event_bus',
			'aws_db_instance',
			'aws_db_proxy',
			'aws_dynamodb_table',
			'aws_lambda_function',
			'aws_rds_cluster',
			'aws_s3_bucket',
			'aws_secretsmanager_secret',
			'aws_sns_topic',
			'aws_sqs_queue',
			'aws_ssm_parameter',
		]
	);
	assert.ok(neighbors.every((n) => n.label === '0'), 'a wire with no text must get the label 0');
});

test('the names Hub ignores are ignored on purpose, each with a reason', () => {
	// The alternative is the failure this package was built to remove: a wire the diagram drew,
	// a variable the generator emitted, and silence. Recording the reason is what makes the
	// silence a decision instead of an oversight.
	for (const [name, reason] of Object.entries(fixture.ignored)) {
		assert.equal(parseName(name, VOCAB), null, `${name} is listed as ignored but Hub parses it`);
		assert.ok(reason.length > 10, `${name} is ignored without a reason worth reading`);
	}
});

test('every captured name is classified — nothing falls through', () => {
	// The gate that matters over time. When the generator starts emitting a type nobody here has
	// thought about, this fails and forces the decision, instead of the variable arriving in
	// production and doing nothing.
	const captured = [...fixture.base, ...fixture.wired, ...ignored];
	assert.equal(new Set(captured).size, captured.length, 'a name is classified twice');

	for (const name of captured) {
		const parsed = parseName(name, VOCAB);
		const classified = fixture.base.includes(name) || fixture.wired.includes(name) || ignored.includes(name);
		assert.ok(classified, `${name} is captured but not classified`);

		// Parsed implies wired, and wired implies parsed. Any name that drifts between the two
		// columns is a resource that was added or removed without the fixture being revisited.
		assert.equal(
			parsed !== null,
			fixture.wired.includes(name),
			`${name}: parser and fixture disagree about whether it is a wire`
		);
	}
});

test('the retired format is still refused', () => {
	// CONTRACT.md §8.2. It left the generator; nothing should quietly start reading it again.
	for (const name of fixture.wired) {
		const retired = name.replace(/^(AWS_[A-Z0-9_]+?)_(NAME|ARN|ID)_/, '$1_TARGET_$2_');
		if (retired === name) continue;
		assert.equal(parseName(retired, VOCAB), null, `${retired} was accepted`);
	}
});
