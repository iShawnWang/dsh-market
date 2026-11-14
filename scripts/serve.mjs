#!/usr/bin/env node
/**
 * Local stand-in for the internal market host.
 *
 * In production this is nginx/Artifactory serving two paths:
 *
 *   GET /index.json          the format-1 market index
 *   GET /npm/<pkg>           an npm packument, whose dist.tarball points at
 *   GET /npm/<pkg>/-/<tgz>   the published tarball
 *
 * This script serves both from the working tree so the whole loop can be
 * exercised on one machine, with no network:
 *
 *   node scripts/serve.mjs                 # http://127.0.0.1:8899/
 *   node scripts/serve.mjs --port 9000
 *
 * Tarballs are packed on demand from `plugins/<pkg>` (they are not committed),
 * and the packument is derived from `market/releases.json` — the same file the
 * index generator reads, so the index and the registry cannot disagree.
 */
import { createReadStream, existsSync } from 'node:fs';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marketDir = path.join(root, 'market');

const portArg = process.argv.indexOf('--port');
const port = Number(portArg === -1 ? (process.env.PORT ?? 8899) : process.argv[portArg + 1]);

const config = JSON.parse(await readFile(path.join(marketDir, 'config.json'), 'utf8'));
const releases = JSON.parse(await readFile(path.join(marketDir, 'releases.json'), 'utf8'));

const base = `http://127.0.0.1:${port}`;
const registryPrefix = '/npm';

/**
 * Upstream used for packages this market does not host.
 *
 * This is the local stand-in for a Nexus/Artifactory "group" repository: the
 * one URL DSH hands to pnpm must answer for EVERY dependency of the profile,
 * not just the internal ones. A hosted-only registry makes `pnpm add` fail on
 * the profile's existing public dependencies with ERR_PNPM_FETCH_404 — which is
 * exactly what happens if an internal index points at a non-group registry.
 */
const upstream = process.env.MARKET_UPSTREAM ?? 'https://registry.npmjs.org';

/** Packed tarballs, keyed by `name@version`, packed once per process. */
const packed = new Map();

/** Upstream packuments, keyed by package name, cached for the process. */
const upstreamPackuments = new Map();

async function fetchUpstreamPackument(name) {
  const hit = upstreamPackuments.get(name);
  if (hit !== undefined) return hit;
  const encoded = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
  const response = await fetch(`${upstream}/${encoded}`, {
    headers: { accept: 'application/json' },
  });
  const body = response.ok ? await response.text() : undefined;
  upstreamPackuments.set(name, body);
  return body;
}

async function pack(name, version) {
  const key = `${name}@${version}`;
  const hit = packed.get(key);
  if (hit !== undefined) return hit;

  const dir = path.join(root, 'plugins', name);
  const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  if (manifest.version !== version) {
    throw new Error(`${name}: package.json says ${manifest.version}, releases.json says ${version}`);
  }

  const out = await mkdtemp(path.join(tmpdir(), 'dsh-market-'));
  try {
    // `npm pack` is used instead of `pnpm pack` because it honours `files`
    // identically and ships with Node. `--cache` is redirected into a scratch
    // directory: the user's own npm cache may be unusable, and packing a local
    // directory directory never needs it anyway.
    const { stdout } = await run(
      'npm',
      ['pack', '--json', '--ignore-scripts', '--cache', path.join(out, 'cache'), '--pack-destination', out],
      { cwd: dir },
    );
    const [{ filename }] = JSON.parse(stdout);
    const bytes = await readFile(path.join(out, filename));
    const entry = { filename, bytes };
    packed.set(key, entry);
    return entry;
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

async function packument(name) {
  const entries = releases[name];
  if (entries === undefined) return undefined;

  const versions = {};
  for (const entry of entries) {
    const filename = `${name.replace(/^@[^/]+\//, '').replace('/', '-')}-${entry.version}.tgz`;
    // Pack eagerly so the packument can carry a real integrity hash: pnpm
    // refuses a tarball whose hash does not match, and an empty `shasum` is
    // not something it can verify against.
    const file = await pack(name, entry.version);
    versions[entry.version] = {
      name,
      version: entry.version,
      dist: {
        tarball: `${base}${registryPrefix}/${name}/-/${filename}`,
        integrity: `sha512-${createHash('sha512').update(file.bytes).digest('base64')}`,
        shasum: createHash('sha1').update(file.bytes).digest('hex'),
      },
    };
  }
  const latest = entries
    .map((entry) => entry.version)
    .sort((left, right) => (left === right ? 0 : left < right ? 1 : -1))[0];

  return {
    name,
    'dist-tags': { latest },
    versions,
    time: Object.fromEntries(
      entries.map((entry) => [entry.version, new Date(entry.publishTimestamp * 1000).toISOString()]),
    ),
  };
}

const types = {
  '.json': 'application/json; charset=utf-8',
  '.tgz': 'application/octet-stream',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, base);
  const send = (status, body, type = 'application/json; charset=utf-8') => {
    response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    response.end(body);
  };

  try {
    // --- npm registry surface ------------------------------------------
    if (url.pathname.startsWith(`${registryPrefix}/`)) {
      const rest = url.pathname.slice(registryPrefix.length + 1);

      // /npm/<pkg>/-/<tarball>
      const tarball = /^(.+)\/-\/([^/]+\.tgz)$/u.exec(rest);
      if (tarball !== null) {
        const name = decodeURIComponent(tarball[1]);
        const entry = releases[name]?.find(
          (item) => `${name}-${item.version}.tgz` === tarball[2] || tarball[2].endsWith(`-${item.version}.tgz`),
        );
        if (entry === undefined) return send(404, JSON.stringify({ error: 'Not found' }));
        const file = await pack(name, entry.version);
        response.writeHead(200, { 'content-type': types['.tgz'], 'cache-control': 'no-store' });
        return response.end(file.bytes);
      }

      const packumentBody = await packument(decodeURIComponent(rest));
      if (packumentBody === undefined) {
        // Not hosted here: behave like the proxy half of a group repository.
        const forwarded = await fetchUpstreamPackument(decodeURIComponent(rest));
        if (forwarded === undefined) return send(404, JSON.stringify({ error: 'Not found' }));
        return send(200, forwarded);
      }
      return send(200, JSON.stringify(packumentBody, null, 2));
    }

    // --- static market surface ------------------------------------------
    const relative = url.pathname === '/' ? 'index.json' : url.pathname.replace(/^\//u, '');
    const file = path.resolve(marketDir, relative);
    if (!file.startsWith(marketDir + path.sep) || !existsSync(file)) {
      return send(404, JSON.stringify({ error: 'Not found' }));
    }
    const extension = path.extname(file);
    response.writeHead(200, {
      'content-type': types[extension] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(response);
  } catch (error) {
    send(500, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`market index   ${base}/index.json`);
  console.log(`npm registry   ${base}${registryPrefix}/`);
  console.log(`tarball        ${base}${registryPrefix}/dsh-hello-world/-/dsh-hello-world-0.1.0.tgz`);
});
