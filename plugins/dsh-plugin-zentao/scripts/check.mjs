/**
 * Run the panel checks against the shared headless Chrome.
 *
 *   node scripts/check.mjs            # every check
 *   node scripts/check.mjs align      # one check
 *   node scripts/check.mjs align latency
 *
 * Chrome stays warm between runs, so only the first run pays for the boot.
 * Requires DSH to be running (the checks drive the real web UI) and Google
 * Chrome to be installed.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CHECKS = {
  align: 'check-align.mjs',
  latency: 'check-latency.mjs',
  reflow: 'check-reflow.mjs',
};

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(CHECKS);
const unknown = names.filter((name) => !CHECKS[name]);
if (unknown.length) {
  console.error(`unknown check(s): ${unknown.join(', ')} — available: ${Object.keys(CHECKS).join(', ')}`);
  process.exit(2);
}

let failed = 0;
for (const name of names) {
  const started = Date.now();
  const code = await new Promise((resolve) => {
    /* Children reuse this same runtime. Under DSH there is no `node` on PATH,
       so `process.execPath` plus ELECTRON_RUN_AS_NODE is the portable choice. */
    const child = spawn(process.execPath, [join(here, CHECKS[name])], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'inherit',
    });
    child.on('exit', resolve);
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (code !== 0) failed += 1;
  console.log(`--- ${name}: ${code === 0 ? 'pass' : 'FAIL'} (${seconds}s)\n`);
}

console.log(failed === 0 ? 'all checks passed' : `${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
