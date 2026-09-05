/**
 * Are the committed artifacts still the code?
 *
 * `prebuilt/index.mjs` and `image/index.mjs` exist so that a template can take one file straight
 * from the repository without a Node toolchain. That convenience is also how build artifacts go bad: the source moves,
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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

test('image/index.mjs matches a fresh build of the source', () => {
	const scratch = mkdtempSync(join(tmpdir(), 'hub-image-'));
	try {
		const fresh = join(scratch, 'index.mjs');

		execFileSync(
			process.execPath,
			['scripts/bundle.mjs', '--runtime', 'container', '--raw', '--out', fresh],
			{ stdio: 'pipe' }
		);

		assert.equal(
			readFileSync('image/index.mjs', 'utf8'),
			readFileSync(fresh, 'utf8'),
			'image/index.mjs is stale — run `npm run prebuilt:image` and commit the result'
		);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test('the image artifact starts itself instead of exporting a handler', () => {
	const code = readFileSync('image/index.mjs', 'utf8');

	// The one line that differs between the two artifacts, and the one that decides whether the
	// task runs. A handler in a container starts, exits immediately, and ECS restarts it forever
	// with nothing in the log to explain it — which reads as a crash loop in the application.
	assert.match(code, /^container\(\);$/m, 'the container entry point is not called');
	assert.doesNotMatch(code, /export\s*\{[^}]*handler/, 'this is the function artifact');
});

test('the Dockerfile copies what the repository actually carries', () => {
	const dockerfile = readFileSync('image/Dockerfile', 'utf8');

	// Every path the build reads has to be in the tree, or the image builds only on a machine
	// that has just run the bundler. That was true of the Dockerfile this replaced, and a clean
	// clone — every CI runner, every CloudMan apply — is where it stopped being true.
	const copied = [...dockerfile.matchAll(/^COPY\s+(?:--\S+\s+)*(\S+)/gm)].map((m) => m[1]);
	assert.ok(copied.length > 0, 'the Dockerfile copies nothing');
	for (const path of copied) {
		assert.ok(existsSync(join('image', String(path))), `Dockerfile copies ${path}, which is not in image/`);
	}
});
