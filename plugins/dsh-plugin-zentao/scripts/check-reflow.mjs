/**
 * Does the layout hold still while the screenshots stream in?
 *
 * Samples the geometry of the three detail cards on every frame and reports
 * each distinct combination. One entry means nothing moved.
 */
import { connect } from './cdp.mjs';

const zt = await connect();
await zt.boot();
await zt.images(true);
await zt.openList();

const result = await zt.ev(`(async () => {
  const rows = [...document.querySelectorAll('button')].filter((n) => /^\\s*\\d{4,}/.test(n.textContent));
  if (!rows.length) return JSON.stringify({ error: 'no rows' });

  const samples = [];
  let stop = false;
  const t0 = performance.now();
  const tick = () => {
    if (stop) return;
    const card = (title) => [...document.querySelectorAll('section')].find((s) => s.querySelector('h2')?.textContent.trim() === title);
    const article = card('重现步骤');
    const history = card('动态');
    const props = card('属性');
    samples.push({
      t: Math.round(performance.now() - t0),
      a: article ? Math.round(article.getBoundingClientRect().height) : 0,
      d: history ? Math.round(history.getBoundingClientRect().top) : 0,
      p: props ? Math.round(props.getBoundingClientRect().top) : 0,
      ph: document.querySelectorAll('[data-zt-pending]').length,
    });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  rows[0].click();
  /* One picture landing is the whole test: if the geometry survives that swap
     it survives the rest. Waiting for the megabytes of screenshots to finish
     would add ten seconds and no new signal. */
  let peak = 0;
  let swapped = false;
  while (performance.now() - t0 < 20000) {
    await new Promise((r) => setTimeout(r, 150));
    const pending = document.querySelectorAll('[data-zt-pending]').length;
    if (pending > peak) peak = pending;
    if (peak > 0 && pending < peak) { swapped = true; break; }
  }
  await new Promise((r) => setTimeout(r, 300));
  stop = true;
  return JSON.stringify({ samples, swapped, peak });
})()`);

if (!result) { console.log('page returned nothing'); await zt.close(); process.exit(1); }
const report = JSON.parse(result);
if (report.error) { console.log(report.error); await zt.close(); process.exit(1); }
const { samples, swapped } = report;

const distinct = [];
let previous = null;
for (const sample of samples) {
  const key = `${sample.a}|${sample.d}|${sample.p}`;
  if (key !== previous) { distinct.push(sample); previous = key; }
}

for (const s of distinct) console.log(`t=${s.t}ms article=${s.a} history=${s.d} props=${s.p} placeholders=${s.ph}`);
const steady = distinct.filter((s) => s.a > 0);
console.log(swapped ? 'watched a picture replace its placeholder' : 'no picture landed in time');
console.log(steady.length <= 1 ? 'layout never moved after the article appeared' : `layout changed ${steady.length - 1} time(s)`);
await zt.close();
process.exit(steady.length <= 1 ? 0 : 1);
