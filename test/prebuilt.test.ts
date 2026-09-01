/**
 * Is the committed artifact still the code?
 *
 * `prebuilt/index.mjs` exists so that a template can take one file straight from the repository
 * without a Node toolchain. That convenience is also how build artifacts go bad: the source moves,
 * the artifact does not, and whoever fetched it runs last month's behaviour while reading this
 * month's documentation.
 *
 * The same drift already happened once here in prose — the status section described a repository
 * that no longer existed, and a reader concluded correctly from a document that lied. A file that
 * people *run* deserves at least the guard that the prose did not have.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('prebuilt/index.mjs matches a fresh build of the source', () => {
	const scratch = mkdtempSync(join(tmpdir(), 'hub-prebuilt-'));
	try {
		const fresh = join(scratch, 'index.mjs');

		// Through the real script rather than a second esbuild call here: a copy of the build
		// configuration would drift from the original and quietly compare the wrong thing.
		execFileSync(process.execPath, ['scripts/bundle.mjs', '--raw', '--out', fresh], {
			stdio: 'pipe',
		});

		assert.equal(
			readFileSync('prebuilt/index.mjs', 'utf8'),
			readFileSync(fresh, 'utf8'),
			'prebuilt/index.mjs is stale — run `npm run prebuilt` and commit the result'
		);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test('the prebuilt artifact exports a handler and carries no imports', () => {
	const code = readFileSync('prebuilt/index.mjs', 'utf8');

	assert.match(code, /export\s*\{[^}]*handler/, 'no handler exported');

	// Self-contained is the whole point: a Lambda built from this installs nothing. Node's own
	// built-ins are fine and are the only thing the runtime provides.
	const imports = [...code.matchAll(/^import\s.*?from\s*["']([^"']+)["']/gm)].map((m) => m[1]);
	const external = imports.filter((spec) => spec !== undefined && !spec.startsWith('node:'));
	assert.deepEqual(external, [], `bundle depends on ${external.join(', ')}`);
});
