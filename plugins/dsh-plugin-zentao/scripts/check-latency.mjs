/**
 * How fast the detail text becomes readable.
 *
 * This is the check that proves the progressive split works: the panel must
 * paint the article before the attachments, because the slowest screenshot
 * takes ten seconds on its own. Attachment requests are suppressed so the
 * measurement is about text alone, not about who wins the connection pool.
 */
import { connect } from './cdp.mjs';

const zt = await connect();
const started = Date.now();
const mark = (label) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${label}`);
mark('connected');
await zt.boot();
await zt.images(false);
mark('booted');
await zt.openList();
mark('list ready');

const result = await zt.ev(`(async () => {
  const t0 = performance.now();
  const rows = [...document.querySelectorAll('button')].filter((n) => /^\\s*\\d{4,}/.test(n.textContent));
  if (!rows.length) return JSON.stringify({ error: 'no rows' });

  const seen = [];
  const originalFetch = window.fetch;
  window.fetch = (...args) => {
    const url = String(args[0]);
    if (url.includes('/api/dsh-plugin-zentao/')) seen.push({ path: url.split('/').pop(), at: Math.round(performance.now() - t0) });
    return originalFetch(...args);
  };

  rows[0].click();

  /* Poll for the first readable text and for the last placeholder. The
     assertion is about the text; the screenshots are megabytes and take ten
     seconds, so this stops shortly after the text lands and reports how many
     pictures are still pending instead of waiting them out. */
  let textAt = null;
  let pendingAtText = null;
  const deadline = Math.min(3000, 30000);
  while (performance.now() - t0 < deadline) {
    await new Promise((r) => requestAnimationFrame(r));
    if (textAt === null && [...document.querySelectorAll('section h2')].some((n) => n.textContent.includes('重现步骤'))) {
      textAt = Math.round(performance.now() - t0);
      pendingAtText = document.querySelectorAll('[data-zt-pending]').length;
    }
    if (textAt !== null) break;
  }
  window.fetch = originalFetch;
  return JSON.stringify({ textAt, pendingAtText, requests: seen });
})()`);

mark('page measured');
if (!result) { console.log('page returned nothing'); await zt.close(); process.exit(1); }
const timing = JSON.parse(result);
if (!timing.requests) { console.log('unexpected:', result); await zt.close(); process.exit(1); }
console.log('text readable:', timing.textAt, 'ms');
/* `/bug` must come first; the attachment calls only start once its answer
   names them, which is exactly the progressive behaviour under test. */
console.log('bridge:', timing.requests.map((r) => `${r.path}@${r.at}ms`).join(' '));

const ok = timing.textAt !== null && timing.textAt < 2000;
console.log(ok ? 'text appears well before the images' : 'text is too slow');
await zt.close();
process.exit(ok ? 0 : 1);
