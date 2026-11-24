/**
 * Does the detail card's right edge line up with the header's last button?
 *
 * Rewritten on top of the shared session: the first run pays the SPA boot,
 * every later run attaches to the page that is already open.
 */
import { connect } from './cdp.mjs';

const zt = await connect();
const started = Date.now();

await zt.boot();
await zt.images(false);
await zt.openList();
if (await zt.ev(`document.querySelector('#zt-baseurl') ? true : false`)) {
  console.log('panel is showing setup, not the list');
  await zt.close();
  process.exit(1);
}

const GEO = `(() => {
  const pane = [...document.querySelectorAll('div')].filter((n) => n.style?.overflow === 'auto').pop();
  const cards = [...pane.querySelectorAll('section')];
  const open = [...pane.querySelectorAll('a')].find((a) => a.textContent.includes('在禅道打开'));
  return JSON.stringify({
    vw: innerWidth,
    pane: Math.round(pane.getBoundingClientRect().width),
    cards: cards.map((c) => ({
      t: c.querySelector('h2')?.textContent,
      x: Math.round(c.getBoundingClientRect().x),
      w: Math.round(c.getBoundingClientRect().width),
      r: Math.round(c.getBoundingClientRect().right),
    })),
    openRight: open ? Math.round(open.getBoundingClientRect().right) : null,
    hScroll: document.documentElement.scrollWidth > innerWidth,
  });
})()`;

await zt.openBug(0);
/* Card geometry comes from the article text and the placeholder boxes, which
   are laid out immediately; waiting for the megabytes of screenshots would add
   ten seconds for no extra signal. */

let bad = 0;
for (const [width, height] of [[1920, 1000], [1440, 913], [1100, 900], [900, 800], [520, 800]]) {
  await zt.viewport(width, height);
  await zt.ev(`(() => { const p = [...document.querySelectorAll('div')].filter((n) => n.style?.overflow === 'auto').pop(); p.scrollTop = 0; })()`);
  const geo = JSON.parse(await zt.ev(GEO));
  const rights = new Set(geo.cards.map((c) => c.r));
  const aligned = rights.size === 1 && [...rights][0] === geo.openRight;
  if (!aligned || geo.hScroll) bad += 1;
  console.log(width, aligned ? 'aligned' : 'MISALIGNED', geo.cards.map((c) => `${c.t}:${c.r}`).join(' '), 'button:', geo.openRight, geo.hScroll ? 'H-SCROLL' : '');
}

await zt.shot('/tmp/zt-align.png');
console.log(bad === 0 ? 'all viewports aligned' : `${bad} viewport(s) failed`, `(${Date.now() - started}ms)`);
await zt.close();
process.exit(bad === 0 ? 0 : 1);
