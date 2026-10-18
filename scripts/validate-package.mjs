import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const live = process.argv.includes('--live');
const temp = await mkdtemp(join(tmpdir(), 'openai-oauth-package-'));
const packDirectory = join(temp, 'pack');
const fixture = join(temp, 'consumer');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const runPnpm = (args, options) => execFileSync(pnpm, args, { ...options, shell: process.platform === 'win32' });

try {
  runPnpm(['pack', '--pack-destination', packDirectory], { cwd: root, stdio: 'inherit' });
  const packed = (await readdir(packDirectory)).find(file => file.endsWith('.tgz'));
  if (!packed) throw new Error('pnpm pack did not produce a tarball.');
  const tarball = join(packDirectory, packed);
  const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  const expected = new Set(['package/dist/index.js', 'package/dist/index.d.ts', 'package/LICENSE', 'package/package.json', 'package/README.md']);
  if (listing.length !== expected.size || listing.some(file => !expected.has(file))) {
    throw new Error(`Unexpected package contents: ${listing.join(', ')}`);
  }

  await cp(resolve(root, 'fixtures/consumer'), fixture, { recursive: true });
  const manifestPath = join(fixture, 'package.json');
  const manifest = await readFile(manifestPath, 'utf8');
  await writeFile(manifestPath, manifest.replace('PACKAGE_TARBALL', tarball.replaceAll('\\', '/')));
  runPnpm(['install', '--ignore-workspace'], { cwd: fixture, stdio: 'inherit' });
  runPnpm(['run', 'typecheck'], { cwd: fixture, stdio: 'inherit' });
  runPnpm(['run', 'build'], { cwd: fixture, stdio: 'inherit' });
  runPnpm(['run', 'start'], { cwd: fixture, stdio: 'inherit' });
  if (live) runPnpm(['run', 'live'], { cwd: fixture, stdio: 'inherit' });
  console.log(`Validated packed ${basename(tarball)} with the independent consumer fixture.`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
