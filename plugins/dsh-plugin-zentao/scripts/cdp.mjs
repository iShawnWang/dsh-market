/**
 * Shared CDP session for the panel checks.
 *
 * Two things used to dominate every verification run: a fresh headless Chrome
 * plus a full SPA boot (~15s), and fixed `sleep` calls that waited far longer
 * than the work took. This module keeps one Chrome and one loaded page alive
 * between runs, and every wait polls for the thing it actually needs.
 *
 * Chrome is left running on purpose. Stop it with `node scripts/chrome-stop.mjs`.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintSessionCookie } from './session-cookie.mjs';

const CHROME = process.env.ZT_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.ZT_CDP_PORT ?? 9601);
const PROFILE = process.env.ZT_PROFILE ?? join(tmpdir(), 'dsh-zentao-check-profile');
export const APP_URL = process.env.ZT_WEB_URL ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:50012/';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function cdpUp() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

async function launchChrome() {
  mkdirSync(PROFILE, { recursive: true });
  spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--window-size=1440,913',
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore', detached: true }).unref();
  for (let i = 0; i < 120; i++) {
    if (await cdpUp()) return;
    await sleep(100);
  }
  throw new Error(`chrome did not come up on port ${PORT}`);
}

class Session {
  constructor(socket) {
    this.ws = socket;
    this.id = 0;
    this.pending = new Map();
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        this.pending.get(message.id)(message.result);
        this.pending.delete(message.id);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  /** Evaluate in the page and return the value; `null` on a page exception. */
  async ev(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return result?.exceptionDetails ? null : result?.result?.value;
  }

  async shot(path) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path, Buffer.from(result.data, 'base64'));
  }

  /**
   * Poll until `expression` is truthy.
   * @param {string} expression - page expression returning a truthy value.
   * @param {{timeout?: number, interval?: number, label?: string}} [options]
   * @returns {Promise<any>} the truthy value.
   */
  async waitFor(expression, options = {}) {
    const timeout = options.timeout ?? 20000;
    const interval = options.interval ?? 150;
    const started = Date.now();
    for (;;) {
      const value = await this.ev(expression);
      if (value) return value;
      if (Date.now() - started > timeout) {
        throw new Error(`timed out after ${timeout}ms waiting for ${options.label ?? expression}`);
      }
      await sleep(interval);
    }
  }

  async viewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(250);
  }

  /**
   * Load the app if it is not already on screen, and wait for the sidebar.
   *
   * A previous check may have left an emulated viewport behind; start from the
   * same size every time so timings and geometry are comparable.
   */
  async boot({ force = false, width = 1440, height = 913 } = {}) {
    const here = await this.ev('location.href');
    if (force || !String(here ?? '').startsWith(APP_URL)) {
      await this.send('Page.navigate', { url: APP_URL });
    }
    await this.viewport(width, height);
    await this.waitFor(
      `(() => { const el = [...document.querySelectorAll('*')].find((n) => n.textContent.trim() === '禅道' && n.children.length === 0); return el ? true : false; })()`,
      { timeout: 30000, label: 'sidebar 禅道 entry' },
    );
  }

  /**
   * Let attachment downloads through, or stop them at the network layer.
   *
   * A page left with downloads in flight keeps Chrome's per-host connection
   * pool busy, which makes the next run's `/bug` request queue behind megabytes
   * of screenshots. Checks that measure text or geometry do not need them.
   * @param {boolean} allow - true to download pictures.
   */
  async images(allow) {
    await this.send('Network.setBlockedURLs', {
      urls: allow ? [] : ['*/api/dsh-plugin-zentao/image'],
    });
  }

  /** Reload after a plugin rebuild; the SPA has to refetch the client bundle. */
  async reload() {
    await this.send('Page.reload', { ignoreCache: true });
    await sleep(500);
    await this.boot();
  }

  /**
   * Make sure the panel is on screen.
   *
   * Clicking the sidebar row when the panel is already selected collapses it,
   * which matters now that the page survives between runs — so only click when
   * the panel is not already mounted.
   */
  async openPanel() {
    const visible = `(() => { if (document.querySelector('#zt-baseurl')) return 'setup'; if (document.body.innerText.includes('指派给我')) return 'list'; if (document.body.innerText.includes('读取配置失败')) return 'error'; if (document.body.innerText.includes('网络不可达')) return 'error'; if ([...document.querySelectorAll('section h2')].some((n) => n.textContent.includes('重现步骤'))) return 'detail'; return false; })()`;
    if (await this.ev(visible)) return;
    await this.ev(`(() => { const el = [...document.querySelectorAll('*')].find((n) => n.textContent.trim() === '禅道' && n.children.length === 0); el?.closest('button,[role="button"],li,a')?.click(); })()`);
    await this.waitFor(visible, { timeout: 30000, label: 'panel ready' });
  }

  /** Click the nth bug row and wait for the article card. */
  async openBug(index = 0) {
    /* A previous run may have left a detail open; go back so the list rows are
       the ones being clicked. */
    if (!(await this.ev(`document.body.innerText.includes('指派给我')`))) await this.back();
    await this.ev(`(() => { const rows = [...document.querySelectorAll('button')].filter((n) => /^\\s*\\d{4,}/.test(n.textContent)); rows[${index}]?.click(); })()`);
    await this.waitFor(
      `(() => { const h = [...document.querySelectorAll('section h2')].map((n) => n.textContent.trim()); return h.includes('重现步骤') ? h.length : false; })()`,
      { timeout: 30000, label: 'detail article' },
    );
  }

  /** Panel on screen and showing the bug list, whatever the last run left. */
  async openList() {
    await this.openPanel();
    if (!(await this.ev(`document.body.innerText.includes('指派给我')`))) await this.back();
    /* The list renders a frame after the heading; wait for an actual row. */
    await this.waitFor(
      `[...document.querySelectorAll('button')].filter((n) => /^\\s*\\d{4,}/.test(n.textContent)).length`,
      { timeout: 20000, label: 'bug rows' },
    );
    return this;
  }

  /** Wait until every attachment placeholder has been replaced. */
  async imagesSettled(timeout = 30000) {
    return this.waitFor(
      `document.querySelectorAll('[data-zt-pending]').length === 0`,
      { timeout, label: 'images settled' },
    );
  }

  async back() {
    await this.ev(`(() => { const b = [...document.querySelectorAll('button')].find((n) => n.textContent.includes('返回')); b?.click(); })()`);
    await this.waitFor(
      `document.body.innerText.includes('指派给我')`,
      { timeout: 15000, label: 'back to list' },
    );
  }

  async close() {
    try { this.ws.close(); } catch { /* already gone */ }
  }
}

/**
 * Attach to the shared Chrome, launching it only if it is not already up.
 * @param {{fresh?: boolean}} [options] - `fresh` restarts Chrome.
 * @returns {Promise<Session>} a connected session.
 */
export async function connect(options = {}) {
  if (options.fresh) {
    spawn('pkill', ['-f', `remote-debugging-port=${PORT}`], { stdio: 'ignore' });
    for (let i = 0; i < 60; i++) {
      if (!(await cdpUp())) break;
      await sleep(100);
    }
  }
  if (!(await cdpUp())) await launchChrome();

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  let page = targets.find((target) => target.type === 'page');
  if (!page) {
    page = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  }

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const session = new Session(socket);
  await session.send('Page.enable');
  await session.send('Network.enable');
  await session.send('Runtime.enable');

  /* The DSH web UI only answers an authenticated browser session. Minting the
     cookie from the stored signing secret keeps the checks free of a manual
     login step; without it the panel would just show its setup form. */
  const cookie = mintSessionCookie(new URL(APP_URL).host);
  if (cookie) {
    const separator = cookie.indexOf('=');
    await session.send('Network.setCookie', {
      name: cookie.slice(0, separator),
      value: cookie.slice(separator + 1),
      domain: new URL(APP_URL).hostname,
      path: '/',
    });
  }

  return session;
}

export { PORT };
