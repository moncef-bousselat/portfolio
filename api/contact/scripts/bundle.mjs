/**
 * Builds the Lambda deployment package:
 *
 *   npm run build --workspace api/contact
 *     -> api/contact/dist/index.mjs        the contact handler
 *     -> api/contact/dist/killswitch.mjs   the cost kill switch
 *     -> api/contact/dist/contact.zip      both, what Terraform uploads
 *
 * Both functions ship in one zip, each with its own handler setting
 * (index.handler, killswitch.handler). Every CI path that plans, uploads and
 * hash-checks the zip then covers the kill switch too, at the cost of a
 * change to either function updating both.
 *
 * One ESM file with the AWS SDK clients bundled in, rather than relying on
 * the copy the runtime ships: the version is then the one the lockfile and
 * the tests pinned, and a runtime update cannot change it underneath us.
 *
 * The zip is byte-for-byte reproducible (see zip.mjs), so the CI plan and a
 * local build of the same commit agree, and an unchanged handler never shows
 * up as a Lambda change.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { zip } from './zip.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');

const result = await build({
  absWorkingDir: root,
  entryPoints: { index: 'src/index.ts', killswitch: 'src/killswitch-index.ts' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  // Prefer the SDK's ESM builds, which tree-shake.
  mainFields: ['module', 'main'],
  minify: true,
  legalComments: 'none',
  write: false,
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning',
});

const files = Object.fromEntries(
  result.outputFiles.map((file) => [basename(file.path), Buffer.from(file.contents)]),
);
const archive = zip(files);

await mkdir(dist, { recursive: true });
for (const [name, contents] of Object.entries(files)) {
  await writeFile(join(dist, name), contents);
}
await writeFile(join(dist, 'contact.zip'), archive);

// The value Terraform's filebase64sha256() will compute, for comparing builds.
const hash = createHash('sha256').update(archive).digest('base64');
console.log(`dist/contact.zip  ${(archive.length / 1024).toFixed(0)} KiB  sha256 (base64) ${hash}`);
