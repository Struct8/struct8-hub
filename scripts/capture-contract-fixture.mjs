/**
 * Recaptures test/fixtures/generator-output.json from a CloudMan checkout.
 *
 *     node scripts/capture-contract-fixture.mjs ../CloudMan-Swelte/CloudMan
 *     node scripts/capture-contract-fixture.mjs ../CloudMan-Swelte/CloudMan --write
 *
 * Without --write it only reports the drift, which is the useful mode: run it after a generator
 * change and it tells you whether the contract moved. With --write it updates the fixture, and
 * `npm test` then tells you what that movement broke.
 *
 * A name that appears here and is not in the fixture is the important case. It means the generator
 * started emitting a type nobody has classified, and the default behaviour for an unclassified
 * type is silence: the wire is drawn, the variable is written, and nothing happens. That is the
 * exact failure this package exists to remove, so it is reported loudly and left for a person.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', 'test', 'fixtures', 'generator-output.json');

const checkout = process.argv[2];
const write = process.argv.includes('--write');

if (!checkout) {
	console.error('usage: node scripts/capture-contract-fixture.mjs <path-to-CloudMan-checkout> [--write]');
	process.exit(2);
}

/** Where compiled output actually lands. None of these are committed; all are real generator runs. */
const ROOTS = [
	'backend/HCLAWSV2-ts/test/.plan-scratch',
	'backend/HCLAWSV2-ts/local-dev/captures',
	'scripts/import-harness/.harness-scratch',
	'.dev-plan-scratch',
	'debug-imports',
	'build',
	'static',
];

// A Lambda writes `AWS_SQS_QUEUE_NAME_0 = "x"`. An ECS task definition writes the same name inside
// a container definition, as `{ name = "AWS_SQS_QUEUE_NAME_0", value = "x" }`. Both are the
// generator emitting this contract, and reading only the first shape misses every container.
//
// The value is not always a string. A value that is a single reference is written bare
// (`AWS_DB_PROXY_NAME_0 = aws_db_proxy.app.name`), and so is a function call (`tolist(...)[0]`), so
// anything but a second `=` counts.
const DIRECT = /^[ \t]*([A-Z][A-Z0-9_]{2,})[ \t]*=[ \t]*[^\s=]/gm;
const CONTAINER = /name[ \t]*=[ \t]*"([A-Z][A-Z0-9_]{2,})"/g;
const JSON_KEY = /"([A-Z][A-Z0-9_]{2,})"[ \t]*:/g;

const BASE = new Set(['NAME', 'REGION', 'ACCOUNT', 'CICD_STAGE', 'CICD_VERSION']);

function* walk(dir) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(full);
		else if (entry.name.endsWith('.tf') || entry.name.endsWith('.json')) yield full;
	}
}

const sources = [];
const names = new Set();

for (const root of ROOTS) {
	const base = join(checkout, root);
	try {
		statSync(base);
	} catch {
		continue;
	}

	for (const file of walk(base)) {
		const text = readFileSync(file, 'utf8');
		const hits = new Set();
		for (const re of file.endsWith('.json') ? [DIRECT, CONTAINER, JSON_KEY] : [DIRECT, CONTAINER]) {
			re.lastIndex = 0;
			for (const m of text.matchAll(re)) if (m[1].startsWith('AWS_') || BASE.has(m[1])) hits.add(m[1]);
		}
		if (hits.size) {
			sources.push(relative(checkout, file).replaceAll('\\', '/'));
			for (const h of hits) names.add(h);
		}
	}
}

if (!names.size) {
	console.error(`no generator output found under ${checkout}`);
	console.error('compile something from the app or run the import harness first');
	process.exit(1);
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const known = new Set([...fixture.base, ...fixture.wired, ...Object.keys(fixture.ignored)]);

const added = [...names].filter((n) => !known.has(n)).sort();
const gone = [...known].filter((n) => !names.has(n)).sort();

console.log(`${sources.length} file(s), ${names.size} distinct name(s)\n`);

if (added.length) {
	console.log('NEW — the generator emits these and nothing here classifies them:');
	for (const n of added) console.log(`  ${n}`);
	console.log('\nAdd each to "wired" (Hub reaches it) or to "ignored" with the reason it cannot.');
	console.log('Leaving one unclassified means the wire is drawn, the variable written, and nothing happens.\n');
}

if (gone.length) {
	console.log('ABSENT — classified here but not seen in this capture:');
	for (const n of gone) console.log(`  ${n}`);
	console.log('\nUsually this only means the diagrams compiled here do not use them. Check before');
	console.log('removing: a name that truly left the generator is a contract change.\n');
}

if (!added.length && !gone.length) console.log('no drift: the fixture matches what the generator emits.');

if (write) {
	fixture.capturedFrom = sources.sort();
	fixture.capturedOn = new Date().toISOString().slice(0, 10);
	writeFileSync(fixturePath, JSON.stringify(fixture, null, '\t') + '\n');
	console.log(`\nprovenance updated in ${relative(process.cwd(), fixturePath)}`);
	if (added.length) console.log('the new names were NOT added — classifying them is a decision, not a capture.');
}

process.exit(added.length ? 1 : 0);
