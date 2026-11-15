#!/usr/bin/env node
/**
 * Build `market/index.json` (format 1) from three sources of truth:
 *
 *   market/base.json      — the market itself: title, description, metadata declarations
 *   market/meta/<pkg>.json— per-plugin presentation: title, description, icon, category, labels
 *   market/releases.json  — per-plugin released versions: version + publishTimestamp
 *
 * Versions are NEVER hand-written here; they come from `releases.json`, which is
 * meant to be appended by CI. `package.json` of each plugin is read to cross-check
 * that the version being published actually exists in the source tree, and to
 * derive its `engines.dsh` range so the index states the same compatibility as
 * the package.
 *
 * Usage:
 *   node scripts/build-index.mjs           # write market/index.json
 *   node scripts/build-index.mjs --check   # validate, do not write
 *   node scripts/build-index.mjs --verify  # also re-parse the output with the
 *                                          # shipped @deepseek-ai/dsh-plugin-market-index
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marketDir = path.join(root, 'market');

const args = new Set(process.argv.slice(2));
const check = args.has('--check');
const verify = args.has('--verify');

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

/** Absolute URL every relative reference in the index resolves against. */
const config = await readJson(path.join(marketDir, 'config.json'));
const indexUrl = new URL('index.json', config.baseUrl).href;

const base = await readJson(path.join(marketDir, 'base.json'));
const releases = await readJson(path.join(marketDir, 'releases.json'));

/** How a released version is fetched. Mirrors the two `source` shapes of format 1. */
function sourceFor(name, version) {
  if (config.publish?.mode === 'npm') {
    const source = { type: 'npm' };
    if (config.npm?.registry !== undefined) source.registry = config.npm.registry;
    return source;
  }
  // Static mode: the version is pinned to a commit in the Git host that serves this repository.
  // `path` is the package directory inside that repository — the market and the
  // plugins live in one monorepo, so it is always needed.
  const entry = releases[name].find((item) => item.version === version);
  if (entry?.commit === undefined) {
    throw new Error(
      `releases.json ${name}@${version}: static mode needs a 40-hex "commit" for that version`,
    );
  }
  return {
    type: 'git',
    // Canonical upstream URL unless the config names a regional install mirror.
    // `git.url` is what a well-connected machine would use; `git.installUrl` is
    // the URL baked into the index, i.e. what every user's pnpm will actually
    // clone. Keep it a real Git endpoint: the parser only checks the shape, so a
    // CDN that serves files (jsDelivr) would pass validation and still fail to
    // clone.
    url: config.git.installUrl ?? config.git.url,
    commit: entry.commit,
    path: `${config.git.packageRoot ?? 'plugins'}/${name}`,
  };
}

const plugins = [];
const problems = [];

for (const [name, entries] of Object.entries(releases)) {
  const metaFile = path.join(marketDir, 'meta', `${name}.json`);
  if (!existsSync(metaFile)) {
    problems.push(`${name}: missing market/meta/${name}.json`);
    continue;
  }
  const meta = await readJson(metaFile);

  const manifestFile = path.join(root, 'plugins', name, 'package.json');
  let manifest;
  if (existsSync(manifestFile)) manifest = await readJson(manifestFile);
  else problems.push(`${name}: missing plugins/${name}/package.json`);

  // Only the newest release must match the working tree: older releases stay in
  // the index forever, but `plugins/<pkg>/package.json` only holds the version
  // currently checked out.
  const newest = entries[0]?.version;

  const versions = entries.map((entry) => {
    if (manifest !== undefined && entry.version === newest && manifest.version !== entry.version) {
      problems.push(
        `${name}@${entry.version}: releases.json disagrees with plugins/${name}/package.json (${manifest.version})`,
      );
    }
    return {
      version: entry.version,
      publishTimestamp: entry.publishTimestamp,
      source: sourceFor(name, entry.version),
      // Old releases must carry the `engines.dsh` they were published with (the
      // working tree no longer describes them); the newest falls back to the
      // manifest so a fresh publish never needs a hand-written range.
      ...((entry.version === newest ? (manifest?.engines?.dsh ?? entry.engines?.dsh) : entry.engines?.dsh) ===
      undefined
        ? {}
        : { engines: { dsh: entry.version === newest ? (manifest?.engines?.dsh ?? entry.engines.dsh) : entry.engines.dsh } }),
    };
  });

  plugins.push({
    name,
    ...(meta.title === undefined ? {} : { title: meta.title }),
    ...(meta.description === undefined ? {} : { description: meta.description }),
    ...(meta.icon === undefined ? {} : { icon: meta.icon }),
    ...(meta.author === undefined ? {} : { author: meta.author }),
    ...(meta.homepage === undefined ? {} : { homepage: meta.homepage }),
    ...(meta.repository === undefined ? {} : { repository: meta.repository }),
    metadata: {
      ...(meta.category === undefined ? {} : { category: meta.category }),
      ...(meta.labels === undefined ? {} : { labels: meta.labels }),
      ...(meta.keywords === undefined ? {} : { keywords: meta.keywords }),
    },
    versions,
  });
}

const index = {
  format: 1,
  title: base.title,
  ...(base.description === undefined ? {} : { description: base.description }),
  metadata: base.metadata,
  plugins,
};

// Check presentation metadata against the market's own declarations, because
// parseMarketIndex rejects the WHOLE index on one undeclared id.
for (const plugin of plugins) {
  const { category, labels = [], keywords = [] } = plugin.metadata;
  if (category !== undefined && !Object.hasOwn(base.metadata?.categories ?? {}, category)) {
    problems.push(`${plugin.name}: category ${category} is not declared in market/base.json`);
  }
  for (const label of labels) {
    if (!Object.hasOwn(base.metadata?.labels ?? {}, label)) {
      problems.push(`${plugin.name}: label ${label} is not declared in market/base.json`);
    }
  }
  if (new Set(labels).size !== labels.length) problems.push(`${plugin.name}: repeats a label`);
  void keywords;
}

if (problems.length > 0) {
  console.error(`market index is invalid (${problems.length} problem${problems.length === 1 ? '' : 's'}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

/**
 * Load the market index parser.
 *
 * `--verify` must check the index with the SAME parser DSH itself uses, or it
 * proves nothing. In CI the package comes from the registry (devDependency); on
 * a developer machine it can equally come from the installed DSH app, which is
 * the exact runtime the index will be read by. Both are tried.
 */
async function loadParser() {
  const candidates = [
    '@deepseek-ai/dsh-plugin-market-index',
    ...(process.env.DSH_PACKAGES_DIR === undefined
      ? []
      : [`file://${path.join(process.env.DSH_PACKAGES_DIR, 'dsh-plugin-market-index', 'lib', 'index.js')}`]),
  ];
  const failures = [];
  for (const candidate of candidates) {
    try {
      return await import(candidate);
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
  }
  console.error('cannot load @deepseek-ai/dsh-plugin-market-index for --verify:');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error('install devDependencies (pnpm install) or set DSH_PACKAGES_DIR');
  process.exit(1);
}

if (verify) {
  const { parseMarketIndex } = await loadParser();
  try {
    parseMarketIndex(index, indexUrl);
  } catch (error) {
    console.error(`parseMarketIndex rejected the index at ${indexUrl}:`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  console.log(`parseMarketIndex accepted ${plugins.length} plugin(s) at ${indexUrl}`);
}

const target = path.join(marketDir, 'index.json');
const text = `${JSON.stringify(index, null, 2)}\n`;

if (check) {
  const current = existsSync(target) ? await readFile(target, 'utf8') : undefined;
  if (current !== text) {
    console.error('market/index.json is out of date; run: node scripts/build-index.mjs');
    process.exit(1);
  }
  console.log(`market/index.json is up to date (${plugins.length} plugin(s))`);
} else {
  await writeFile(target, text);
  console.log(`wrote ${path.relative(root, target)} (${plugins.length} plugin(s), ${indexUrl})`);
}
