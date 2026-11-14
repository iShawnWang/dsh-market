#!/usr/bin/env node
/**
 * Record a release of one plugin package, the way internal CI does it.
 *
 *   node scripts/release.mjs dsh-hello-world
 *   node scripts/release.mjs dsh-hello-world --registry
 *
 * It reads `plugins/<name>/package.json` for the version (so the tag, the
 * package, and the index can never disagree), appends that version to
 * `market/releases.json` with a publish timestamp and — for static mode — the
 * current commit, then rebuilds `market/index.json`.
 *
 * Order of operations in CI matters and is documented in README.md:
 *   1. the tarball must already be on the registry (or the commit pushed),
 *   2. only then is the index updated and published.
 * A version listed in the index but not fetchable is a broken install for
 * every user, so index publication is the LAST step.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marketDir = path.join(root, 'market');

const [name, ...flags] = process.argv.slice(2);
if (name === undefined) {
  console.error('usage: node scripts/release.mjs <package-name> [--registry] [--allow-dirty]');
  process.exit(1);
}

const manifestFile = path.join(root, 'plugins', name, 'package.json');
if (!existsSync(manifestFile)) {
  console.error(`no such plugin: plugins/${name}/package.json`);
  process.exit(1);
}
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
const version = manifest.version;

const config = JSON.parse(await readFile(path.join(marketDir, 'config.json'), 'utf8'));
const releasesFile = path.join(marketDir, 'releases.json');
const releases = JSON.parse(await readFile(releasesFile, 'utf8'));
const entries = releases[name] ?? [];

if (entries.some((entry) => entry.version === version)) {
  console.error(`${name}@${version} is already recorded in market/releases.json`);
  console.error('bump plugins/' + name + '/package.json "version" first');
  process.exit(1);
}

/** Newest recorded version, so a release cannot silently go backwards. */
const newest = entries
  .map((entry) => entry.version)
  .sort((left, right) => (left === right ? 0 : left < right ? 1 : -1))[0];
if (newest !== undefined) {
  const { stdout } = await run(process.execPath, ['-e', `
    const semver = { compare(a, b) {
      const pa = a.split('-')[0].split('.').map(Number);
      const pb = b.split('-')[0].split('.').map(Number);
      for (let index = 0; index < 3; index += 1) {
        if (pa[index] !== pb[index]) return pa[index] < pb[index] ? -1 : 1;
      }
      return 0;
    } };
    process.stdout.write(String(semver.compare(process.argv[1], process.argv[2])));
  `, version, newest]);
  if (Number(stdout.trim()) <= 0) {
    console.error(`${name}@${version} is not newer than the recorded ${newest}`);
    process.exit(1);
  }
}

const entry = { version, publishTimestamp: Math.floor(Date.now() / 1000) };

if (config.publish?.mode !== 'npm') {
  if (!flags.includes('--allow-dirty')) {
    const { stdout } = await run('git', ['status', '--porcelain'], { cwd: root });
    if (stdout.trim() !== '') {
      console.error('working tree is dirty; commit the plugin source first, or pass --allow-dirty');
      console.error(stdout.trim());
      process.exit(1);
    }
  }
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: root });
  const commit = stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    console.error(`git rev-parse HEAD returned something that is not a full commit: ${commit}`);
    process.exit(1);
  }
  entry.commit = commit;
}

// Newest first: the index parser sorts anyway, but a hand-read diff should
// show the release at the top.
releases[name] = [entry, ...entries];
await writeFile(releasesFile, `${JSON.stringify(releases, null, 2)}\n`);

console.log(`recorded ${name}@${version}${entry.commit === undefined ? '' : ` at ${entry.commit}`}`);
console.log('now run: node scripts/build-index.mjs --verify');
