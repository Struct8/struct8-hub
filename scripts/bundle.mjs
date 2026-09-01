/**
 * Builds a deployable Lambda zip.
 *
 * The package is not on npm, so a function cannot install it. This produces the artifact the
 * generator will eventually emit on its own: one self-contained file with the core, the chosen
 * resources and the signer inlined.
 *
 *     node scripts/bundle.mjs                                    # everything
 *     node scripts/bundle.mjs --resources aws_sqs_queue,aws_s3_bucket
 *     node scripts/bundle.mjs --out build/hub.zip
 *
 * Naming the resources is the point rather than a convenience. A deployment carries only what its
 * diagram uses, so the catalog can grow without any function getting heavier — which stops being
 * tidiness and becomes a requirement on a platform with a bundle size cap.
 *
 * The zip is written by hand, stored rather than deflated. It avoids depending on `zip` or
 * `Compress-Archive` being present, which is not true of every machine this has to run on.
 */

import { build } from 'esbuild';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const arg = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};

const available = readdirSync(join(root, 'src', 'resources'), { withFileTypes: true })
	.filter((e) => e.isDirectory())
	.map((e) => e.name);

const chosen = (arg('resources', available.join(','))).split(',').map((s) => s.trim()).filter(Boolean);
const runtime = arg('runtime', 'lambda');
const raw = process.argv.includes('--raw');
const out = arg('out', raw ? join('build', 'index.mjs') : join('build', 'hub.zip'));

const unknown = chosen.filter((t) => !available.includes(t));
if (unknown.length) {
	console.error(`unknown resource(s): ${unknown.join(', ')}`);
	console.error(`available: ${available.join(', ')}`);
	process.exit(1);
}

// The shim. This is exactly what the generator will emit into a function, and it is deliberately
// short enough to read: two imports and a handler.
const shim = `import { ${runtime} } from './dist/runtimes/${runtime}.js';
${chosen.map((t) => `import './dist/resources/${t}/index.js';`).join('\n')}

export const handler = ${runtime}();
`;

const entry = join(root, '.bundle-entry.mjs');
writeFileSync(entry, shim);

try {
	const result = await build({
		entryPoints: [entry],
		bundle: true,
		platform: 'node',
		target: 'node20',
		format: 'esm',
		write: false,
		// Left readable on purpose. Someone opening the function in the console to understand what
		// the diagram put there is a use case, not an accident.
		minify: false,
		legalComments: 'none',
	});

	const code = result.outputFiles[0].text;

	// Absolute paths are left alone. Joining one onto the repository root produces a path like
	// C:/repo/C:/tmp/x, which Windows accepts and writes somewhere nobody was looking for.
	const target = isAbsolute(out) ? out : join(root, out);
	mkdirSync(dirname(target), { recursive: true });

	// --raw writes the module itself instead of a zip. That is what goes into a
	// CloudMan-Templates folder, where Terraform's archive_file zips the directory at apply time
	// and a zip inside it would just be a zip inside a zip.
	if (raw) {
		writeFileSync(target, code);
	} else {
		writeFileSync(target, storedZip('index.mjs', Buffer.from(code, 'utf8')));
	}

	console.log(`${out}`);
	console.log(`  resources  ${chosen.length}/${available.length}: ${chosen.join(', ')}`);
	console.log(`  runtime    ${runtime}`);
	console.log(`  code       ${(code.length / 1024).toFixed(1)} KiB`);
	console.log(`  handler    index.handler`);
} finally {
	rmSync(entry, { force: true });
}

function u16(n) {
	const b = Buffer.alloc(2);
	b.writeUInt16LE(n);
	return b;
}

function u32(n) {
	const b = Buffer.alloc(4);
	b.writeUInt32LE(n >>> 0);
	return b;
}

/** A one-entry zip, stored. Lambda accepts stored entries; the saving is not worth a dependency. */
function storedZip(name, data) {
	const filename = Buffer.from(name, 'utf8');
	const sum = crc32(data);

	// Fixed timestamp so the same input produces the same artifact. A zip whose bytes change on
	// every build defeats every "did this actually change?" check downstream.
	const time = 0x6000; // 12:00:00
	const date = 0x5910; // 2024-08-16

	const header = (signature, extra) =>
		Buffer.concat([
			u32(signature),
			...extra,
		]);

	const common = [
		u16(20), // version needed
		u16(0), // flags
		u16(0), // method: stored
		u16(time),
		u16(date),
		u32(sum),
		u32(data.length),
		u32(data.length),
		u16(filename.length),
		u16(0), // extra field length
	];

	const local = Buffer.concat([header(0x04034b50, common), filename, data]);

	const central = Buffer.concat([
		u32(0x02014b50),
		u16(20), // version made by
		...common,
		u16(0), // comment length
		u16(0), // disk number
		u16(0), // internal attributes
		u32(0o100644 << 16), // external attributes: regular file, rw-r--r--
		u32(0), // offset of local header
		filename,
	]);

	const end = Buffer.concat([
		u32(0x06054b50),
		u16(0),
		u16(0),
		u16(1),
		u16(1),
		u32(central.length),
		u32(local.length),
		u16(0),
	]);

	return Buffer.concat([local, central, end]);
}

