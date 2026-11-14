#!/usr/bin/env node
/**
 * Serve `market/` over HTTP for local checks.
 *
 * DSH requires an index source to be an absolute http(s) URL — a `file://`
 * path is rejected — so even a purely Git-based market needs some HTTP surface
 * for the `index.json` file. In production that is the internal Git host's raw
 * file endpoint (GitLab: `/-/raw/main/market/index.json`, Gitea: `/raw/branch/main/market/index.json`).
 *
 *   node scripts/serve.mjs                 # http://127.0.0.1:8899/index.json
 *   node scripts/serve.mjs --port 9000
 *
 * This serves ONLY the index. Plugin packages are installed from the Git
 * repository itself, pinned to a commit — there is no package registry here.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marketDir = path.join(root, 'market');

const portArg = process.argv.indexOf('--port');
const port = Number(portArg === -1 ? (process.env.PORT ?? 8899) : process.argv[portArg + 1]);
const base = `http://127.0.0.1:${port}`;

const types = {
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const server = createServer((request, response) => {
  const url = new URL(request.url, base);
  const send = (status, body, type = 'application/json; charset=utf-8') => {
    response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    response.end(body);
  };

  const relative = url.pathname === '/' ? 'index.json' : decodeURIComponent(url.pathname.replace(/^\//u, ''));
  const file = path.resolve(marketDir, relative);

  // Path traversal guard: the resolved file must still live under market/.
  if (!file.startsWith(marketDir + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
    return send(404, JSON.stringify({ error: 'Not found' }));
  }

  response.writeHead(200, {
    'content-type': types[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(response);
});

server.listen(port, '127.0.0.1', async () => {
  const config = JSON.parse(await readFile(path.join(marketDir, 'config.json'), 'utf8'));
  console.log(`index source   ${base}/index.json`);
  console.log(`configured     ${new URL('index.json', config.baseUrl).href}`);
});
