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
  // Static mode: the version is pinned to a commit in the internal Git host.
  const entry = releases[name].find((item) => item.version === version);
  if (entry?.commit === undefined) {
    throw new Error(
      `releases.json ${name}@${version}: static mode needs a 40-hex "commit" for that version`,
    );
  }
  return { type: 'git', url: config.git.url, commit: entry.commit };
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

  const versions = entries.map((entry) => {
    if (manifest !== undefined && manifest.version !== entry.version) {
      problems.push(
        `${name}@${entry.version}: releases.json disagrees with plugins/${name}/package.json (${manifest.version})`,
      );
    }
    return {
      version: entry.version,
      publishTimestamp: entry.publishTimestamp,
      source: sourceFor(name, entry.version),
      ...(manifest?.engines?.dsh === undefined ? {} : { engines: { dsh: manifest.engines.dsh } }),
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

if (verify) {
  const { parseMarketIndex } = await import('@deepseek-ai/dsh-plugin-market-index');
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
