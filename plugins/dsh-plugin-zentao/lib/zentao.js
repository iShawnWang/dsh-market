import { createHash } from 'node:crypto';
import { decodeEntities, imageDimensions, sanitizeArticle, stripTags } from './html.js';

/**
 * A tiny ZenTao client: form login, one cookie jar, and two page readers.
 *
 * Deliberately narrow — this plugin shows "bugs assigned to me" and one bug's
 * detail. Everything else (assign, resolve, comment) stays in ZenTao's own UI,
 * so nothing here can change data on the server.
 */

const LOGIN_PATH = '/user-login.html';
/* Enough of an image to hold a JPEG's frame header; PNG needs far less. */
const IMAGE_PROBE_BYTES = 256 * 1024;
const LIST_PATH = '/my-bug.html';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/**
 * ZenTao signals a stale session in two different ways, and both have to be
 * caught or a dead session reads as "you have no bugs assigned":
 *   - it serves the login form itself (marked by `verifyRand`);
 *   - or it serves a stub page whose only content is a script that jumps to
 *     `/user-login-<base64 of the original path>.html`.
 */
function looksLikeLoginPage(html) {
  const form = /name='account'|name="account"/.test(html) && /verifyRand/.test(html);
  const redirect = /self\.location\s*=\s*['"][^'"]*\/user-login-[A-Za-z0-9=_-]+\.html/.test(html);
  return form || redirect;
}

function md5(value) {
  return createHash('md5').update(value).digest('hex');
}

/**
 * The password ZenTao expects: md5(md5(plain) + verifyRand).
 * @param {string} plain - password as typed.
 * @param {string} rand - `verifyRand` from the login form.
 * @returns {string} hex digest.
 */
export function loginDigest(plain, rand) {
  return md5(md5(plain) + rand);
}

/** A client bound to one installation and one account. */
export class ZentaoClient {
  /**
   * @param {object} options - connection options.
   * @param {string} options.baseUrl - install root, e.g. http://host/zentao.
   * @param {string} options.account - login name.
   * @param {string} options.password - plain password, kept in memory only.
   */
  constructor({ baseUrl, account, password }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.account = account;
    this.password = password;
    this.cookies = new Map();
    this.loggedIn = false;
    this.loginPromise = null;
  }

  /** @returns {string} cookie header for this session. */
  cookieHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  /**
   * Remember every cookie a response set.
   * @param {Headers} headers - response headers.
   */
  storeCookies(headers) {
    const lines = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers.get('set-cookie')].filter(Boolean);
    for (const line of lines) {
      const first = String(line).split(';')[0];
      const index = first.indexOf('=');
      if (index > 0) this.cookies.set(first.slice(0, index).trim(), first.slice(index + 1).trim());
    }
  }

  /**
   * One request against the installation, following redirects by hand so the
   * cookie jar stays authoritative.
   * @param {string} path - absolute URL or path on the installation.
   * @param {object} [init] - fetch init.
   * @param {number} [hop] - redirect depth.
   * @returns {Promise<Response>} the final response.
   */
  async request(path, init = {}, hop = 0) {
    const url = /^https?:\/\//.test(path) ? path : `${this.baseUrl}${path}`;
    const headers = { 'user-agent': USER_AGENT, ...(init.headers ?? {}) };
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;
    const response = await fetch(url, { ...init, headers, redirect: 'manual' });
    this.storeCookies(response.headers);
    const location = response.headers.get('location');
    if (location && hop < 5 && response.status >= 300 && response.status < 400) {
      await response.arrayBuffer().catch(() => {});
      const next = new URL(location, url).toString();
      const method = response.status === 307 || response.status === 308 ? (init.method ?? 'GET') : 'GET';
      return this.request(next, method === 'GET' ? { method: 'GET' } : init, hop + 1);
    }
    return response;
  }

  /**
   * Log in, reusing an in-flight attempt so concurrent callers share one login.
   * @returns {Promise<void>} resolves once the session cookie is usable.
   */
  async ensureLogin() {
    if (this.loggedIn) return;
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = this.login().finally(() => {
      this.loginPromise = null;
    });
    return this.loginPromise;
  }

  /** @returns {Promise<void>} performs the form login. */
  async login() {
    if (!this.account || !this.password) {
      throw new Error('禅道账号或密码未配置');
    }
    const page = await this.request(LOGIN_PATH);
    if (!page.ok) throw new Error(`打开禅道登录页失败：HTTP ${page.status}`);
    const html = await page.text();
    const rand = /name='verifyRand'[^>]*value='(\d+)'/.exec(html)?.[1]
      ?? /name="verifyRand"[^>]*value="(\d+)"/.exec(html)?.[1];
    if (!rand) throw new Error('禅道登录页结构不符合预期（找不到 verifyRand）');
    const origin = new URL(this.baseUrl).origin;
    const body = new URLSearchParams({
      account: this.account,
      password: loginDigest(this.password, rand),
      'keepLogin[]': 'on',
      referer: '/zentao/',
      verifyRand: rand,
    });
    const response = await this.request(LOGIN_PATH, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/javascript, */*; q=0.01',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-requested-with': 'XMLHttpRequest',
        origin,
        referer: `${this.baseUrl}${LOGIN_PATH}`,
      },
      body: body.toString(),
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      if (looksLikeLoginPage(text)) throw new Error('禅道登录失败：账号或密码不正确');
      throw new Error(`禅道登录响应无法解析：HTTP ${response.status}`);
    }
    if (payload?.result !== 'success') {
      throw new Error(`禅道登录失败：${stripTags(String(payload?.message ?? payload?.result ?? '未返回原因'))}`);
    }
    this.loggedIn = true;
  }

  /**
   * Fetch a page, logging in again when the session expired.
   * @param {string} path - page path.
   * @returns {Promise<string>} page HTML.
   */
  async getPage(path) {
    await this.ensureLogin();
    let response = await this.request(path);
    let html = response.ok ? await response.text() : '';
    if (!response.ok || looksLikeLoginPage(html)) {
      this.loggedIn = false;
      this.cookies.clear();
      await this.ensureLogin();
      response = await this.request(path);
      if (!response.ok) throw new Error(`打开禅道页面失败：HTTP ${response.status}`);
      html = await response.text();
      if (looksLikeLoginPage(html)) throw new Error('禅道会话失效，重新登录后仍被要求登录');
    }
    return html;
  }

  /**
   * Turn an `src` from a page into the URL that serves it.
   *
   * ZenTao writes attachment URLs relative to the site root (`/zentao/...`)
   * while `baseUrl` already ends in `/zentao`, so the two must not be
   * concatenated — that would request `/zentao/zentao/...`. Root-relative
   * references resolve against the origin instead.
   * @param {string} path - reference as found in the page.
   * @returns {string} absolute URL.
   */
  /**
   * Just enough bytes of an attachment to know its pixel size.
   *
   * The screenshots on these bugs run to megabytes and the server is slow, so
   * downloading one to learn that it is 4308x2384 costs ten seconds. The header
   * carries the size, and the reader is cancelled as soon as it is parsed.
   * @param {string} path - resource reference, as it appears in a page.
   * @returns {Promise<{width: number, height: number}|null>} intrinsic size.
   */
  async probeImageSize(path) {
    await this.ensureLogin();
    const url = this.resolveResource(path);
    const controller = new AbortController();
    /* A header that has not arrived in two seconds is not worth blocking the
       article for; the placeholder falls back to a generic box. */
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, cookie: this.cookieHeader() },
        redirect: 'manual',
        signal: controller.signal,
      });
      this.storeCookies(response.headers);
      if (!response.body) return null;
      const reader = response.body.getReader();
      let buffer = Buffer.alloc(0);
      try {
        while (buffer.length < IMAGE_PROBE_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer = Buffer.concat([buffer, Buffer.from(value)]);
          const size = imageDimensions(buffer);
          if (size) return size;
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return imageDimensions(buffer);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  resolveResource(path) {
    const value = String(path ?? '').trim();
    if (/^https?:\/\//i.test(value)) return value;
    const site = new URL(this.baseUrl);
    if (value.startsWith('/')) return `${site.origin}${value}`;
    if (value.startsWith('./')) return `${this.baseUrl}/${value.slice(2)}`;
    return `${this.baseUrl}/${value}`;
  }

  /**
   * Raw fetch of an installation resource (attachment image, stylesheet).
   * @param {string} path - resource reference, as it appears in a page.
   * @returns {Promise<{status: number, contentType: string, body: Buffer}>} response.
   */
  async getResource(path) {
    await this.ensureLogin();
    const url = this.resolveResource(path);
    let response = await this.request(url);
    if (response.status === 401 || response.status === 403) {
      this.loggedIn = false;
      this.cookies.clear();
      await this.ensureLogin();
      response = await this.request(url);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      body: buffer,
    };
  }

  /**
   * Bugs currently assigned to the signed-in account.
   * @returns {Promise<{bugs: object[], total: number}>} parsed list.
   */
  async listAssignedBugs() {
    const html = await this.getPage(LIST_PATH);
    const bugs = [];
    const rows = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) ?? [];
    for (const row of rows) {
      if (!/bugIDList\[\]/.test(row)) continue;
      const id = /name='bugIDList\[\]'\s+value='(\d+)'/.exec(row)?.[1]
        ?? /name="bugIDList\[\]"\s+value="(\d+)"/.exec(row)?.[1];
      if (!id) continue;
      const link = /<a\s+href='([^']*bug-view-(\d+)\.html[^']*)'[^>]*>([\s\S]*?)<\/a>/.exec(row)
        ?? /<a\s+href="([^"]*bug-view-(\d+)\.html[^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(row);
      const severity = /data-severity='(\d+)'/.exec(row)?.[1] ?? /data-severity="(\d+)"/.exec(row)?.[1] ?? '';
      const priority = /label-pri-(\d+)'[^>]*>(\d+)</.exec(row)?.[2]
        ?? /label-pri-(\d+)"[^>]*>(\d+)</.exec(row)?.[2]
        ?? '';
      const typeCell = /<td\s+title="([^"]*)"\s*>/.exec(row)?.[1] ?? '';
      const assigned = /<span title='([^']*)' class='text-red'>/.exec(row)?.[1]
        ?? /<span title="([^"]*)" class="text-red">/.exec(row)?.[1]
        ?? '';
      const cells = row.match(/<td\b[^>]*>[\s\S]*?<\/td>/g) ?? [];
      const openerCell = cells[5] ?? '';
      const openedBy = stripTags(openerCell);
      const resolvedBy = stripTags(cells[7] ?? '');
      const resolution = stripTags(cells[8] ?? '');
      bugs.push({
        id,
        title: decodeEntities(stripTags(link?.[3] ?? '')).trim(),
        severity,
        priority,
        type: decodeEntities(typeCell).trim(),
        openedBy,
        assignedTo: decodeEntities(assigned).trim(),
        resolvedBy,
        resolution,
        url: `${this.baseUrl}/bug-view-${id}.html`,
      });
    }
    const total = Number(/data-rec-total='(\d+)'/.exec(html)?.[1] ?? bugs.length);
    return { bugs, total };
  }

  /**
   * One bug's detail, reduced to what a reader needs: header fields, the
   * reproduction article (sanitized HTML), and the comment/history thread.
   * @param {string} id - bug id.
   * @returns {Promise<object>} detail payload.
   */
  async getBug(id) {
    const html = await this.getPage(`/bug-view-${encodeURIComponent(id)}.html`);
    const pageTitle = /<div class="page-title">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
    const titleAttr = /<span class="text" title="([^"]*)"/.exec(pageTitle)?.[1];
    const title = titleAttr ? decodeEntities(titleAttr) : decodeEntities(stripTags(pageTitle)).replace(/^\d+\s*/, '').trim();
    const fields = readLegend(html, 'legendBasicInfo');
    const life = readLegend(html, 'legendLife');

    const articleMatch = /<div class="detail">\s*<div class="detail-title">([\s\S]*?)<\/div>\s*<div class="detail-content article-content">([\s\S]*?)<\/div>\s*<\/div>/.exec(html);
    const article = articleMatch
      ? { heading: decodeEntities(stripTags(articleMatch[1])).trim(), html: sanitizeArticle(articleMatch[2]) }
      : { heading: '重现步骤', html: '' };

    const historyBlock = /<ol class='histories-list'>([\s\S]*?)<\/ol>/.exec(html)?.[1] ?? '';
    const history = [];
    for (const item of historyBlock.match(/<li[^>]*>([\s\S]*?)<\/li>/g) ?? []) {
      const comment = /<div class='comment-content'>([\s\S]*?)<\/div>/.exec(item)?.[1];
      const changes = [...item.matchAll(/<div class='history-changes'[^>]*>([\s\S]*?)<\/div>/g)]
        .map((match) => decodeEntities(stripTags(match[1])).trim())
        .filter(Boolean);
      const head = decodeEntities(stripTags(item.replace(/<div class='article-content comment'>[\s\S]*?<\/div>\s*<\/div>/g, '')))
        .replace(/\s+/g, ' ')
        .trim();
      const time = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(head)?.[1] ?? '';
      const actor = /由\s*([^,，。]+?)\s*(创建|修改|编辑|添加|评论)/.exec(head)?.[1] ?? '';
      const action = /(创建|修改|编辑|添加了备注|评论|解决|关闭|激活)/.exec(head)?.[0] ?? '';
      history.push({
        time,
        actor: actor.trim(),
        action,
        changes,
        comment: comment ? sanitizeArticle(comment) : '',
      });
    }

    return {
      id: String(id),
      title,
      url: `${this.baseUrl}/bug-view-${encodeURIComponent(id)}.html`,
      fields,
      life,
      article,
      history,
    };
  }
}

const SEVERITY_TEXT = { 1: '1 致命', 2: '2 严重', 3: '3 一般', 4: '4 建议' };

/**
 * Read a `#legend*` table into ordered label/value pairs.
 * @param {string} html - page HTML.
 * @param {string} id - table element id.
 * @returns {Array<{label: string, value: string}>} pairs in page order.
 */
function readLegend(html, id) {
  const start = html.indexOf(`id='${id}'`) >= 0 ? html.indexOf(`id='${id}'`) : html.indexOf(`id="${id}"`);
  if (start < 0) return [];
  const table = /<table[\s\S]*?<\/table>/.exec(html.slice(start));
  if (!table) return [];
  const pairs = [];
  for (const row of table[0].match(/<tr>[\s\S]*?<\/tr>/g) ?? []) {
    const cell = /<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/.exec(row);
    if (!cell) continue;
    const label = decodeEntities(stripTags(cell[1])).trim();
    let value = decodeEntities(stripTags(cell[2])).replace(/\s+/g, ' ').trim();
    if (!value) {
      // Severity renders as a bare colour swatch; the number only lives in the
      // attribute, so read it back to keep the field useful.
      const severity = /data-severity='(\d+)'/.exec(cell[2])?.[1] ?? /data-severity="(\d+)"/.exec(cell[2])?.[1];
      if (severity) value = SEVERITY_TEXT[severity] ?? severity;
    }
    if (label) pairs.push({ label, value });
  }
  return pairs;
}
