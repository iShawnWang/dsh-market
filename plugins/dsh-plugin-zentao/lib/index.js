/**
 * Host side of the ZenTao panel.
 *
 * Two jobs only: keep the connection settings (address, account, password) in
 * DSH's own stores, and answer the panel's read-only requests over a local
 * bridge. The browser never talks to ZenTao — the password and session cookie
 * stay here, and the panel only ever sees parsed data.
 */

import { Config, CREDENTIAL_REFS, isConfigured, normalizeBaseUrl, readConfig } from './config.js';
import { ZentaoClient } from './zentao.js';
import { imageDimensions, imageSources, pendingImages } from './html.js';

export { Config };

const BRIDGE_PREFIX = '/api/dsh-plugin-zentao';
const MAX_JSON_BODY_BYTES = 64 * 1024;
const IMAGE_LIMIT = 24;
const IMAGE_BYTES_LIMIT = 4 * 1024 * 1024;

/** One cached client and the settings it was built from. */
const sessions = new Map();

/**
 * Settings fields the panel may write.
 * @type {string[]}
 */
const SETTING_FIELDS = ['baseUrl', 'username'];

/**
 * Build a client for the current settings, reusing the cached session while the
 * connection inputs are unchanged.
 * @param {object} ctx - plugin context.
 * @returns {Promise<ZentaoClient>} ready client.
 */
async function getClient(ctx, config) {
  const live = readConfig(config);
  const baseUrl = normalizeBaseUrl(live.baseUrl);
  const username = live.username.trim();
  if (!baseUrl || !username) throw new Error('先填写禅道地址和账号');
  const credentials = ctx.get('credentials');
  const resolved = await credentials?.resolve?.(CREDENTIAL_REFS.password);
  const password = resolved?.value;
  if (!password) throw new Error('先填写禅道密码');
  const key = `${baseUrl}\u0000${username}\u0000${password}`;
  const cached = sessions.get('current');
  if (cached?.key === key) return cached.client;
  const client = new ZentaoClient({ baseUrl, account: username, password });
  sessions.set('current', { key, client });
  return client;
}

/**
 * Report the state the panel needs to decide between "set me up" and the list.
 * @param {object} ctx - plugin context.
 * @returns {Promise<object>} state payload.
 */
async function describeState(ctx, config) {
  const live = readConfig(config);
  const credentials = ctx.get('credentials');
  let hasPassword = false;
  let maskLength = null;
  try {
    const described = await credentials?.describe?.(CREDENTIAL_REFS.password);
    hasPassword = described?.configured === true;
    /* `describe` returns a same-length preview of a stored secret, so the
       preview's length is the secret's length. Only that length reaches the
       browser: the preview itself carries a readable prefix and suffix, and the
       field only has to show how long the value is. A secret inherited from the
       environment comes back without a preview, hence the null. */
    maskLength = typeof described?.masked === 'string'
      ? Array.from(described.masked).length
      : null;
  } catch {
    hasPassword = false;
    maskLength = null;
  }
  const baseUrl = live.baseUrl.trim();
  return {
    ok: true,
    settings: {
      baseUrl,
      username: live.username.trim(),
    },
    credential: { configured: hasPassword, maskLength },
    configured: isConfigured({ baseUrl, username: live.username }, hasPassword),
  };
}

/**
 * Persist one volatile setting through the settings service, falling back to the
 * config editor on older compositions.
 * @param {object} ctx - plugin context.
 * @param {string} field - setting name.
 * @param {string} value - new value.
 * @returns {Promise<void>} resolves when stored.
 */
async function setSetting(ctx, field, value) {
  const entry = ctx.fiber?.entry;
  const entryId = entry?.options?.id;
  const settings = ctx.get('settings');
  if (settings?.mutate && entryId) {
    try {
      await settings.mutate(entryId, [{ op: 'set', path: [field], value }]);
      return;
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!/configurable plugin entry|not volatile|no volatile fields/i.test(message)) throw error;
    }
  }
  const editor = ctx.get('configEditor');
  if (!editor?.edit || !entry) throw new Error('当前 DSH 版本不支持保存插件配置');
  await editor.edit(entry, (current) => ({ ...current, [field]: value }));
}

/**
 * Save the address and account from the setup form.
 * @param {object} ctx - plugin context.
 * @param {object} body - `{baseUrl, username}`.
 * @returns {Promise<object>} state after saving.
 */
async function saveSettings(ctx, config, body) {
  const baseUrl = String(body?.baseUrl ?? '').trim();
  const username = String(body?.username ?? '').trim();
  if (!baseUrl) throw new Error('请填写禅道地址');
  if (!username) throw new Error('请填写禅道账号');
  const normalized = normalizeBaseUrl(baseUrl);
  await setSetting(ctx, 'baseUrl', normalized);
  await setSetting(ctx, 'username', username);
  sessions.clear();
  return describeState(ctx, config);
}

/**
 * Save the password in the credential store.
 * @param {object} ctx - plugin context.
 * @param {object} body - `{password}`.
 * @returns {Promise<object>} state after saving.
 */
async function savePassword(ctx, config, body) {
  const password = String(body?.password ?? '');
  if (!password.trim()) throw new Error('请填写禅道密码');
  const credentials = ctx.get('credentials');
  if (!credentials?.set) throw new Error('当前 DSH 版本没有凭据存储');
  await credentials.set(CREDENTIAL_REFS.password, password);
  sessions.clear();
  return describeState(ctx, config);
}

/**
 * Bugs assigned to the configured account.
 * @param {object} ctx - plugin context.
 * @returns {Promise<object>} `{ok, bugs, total, fetchedAt}`.
 */
async function listBugs(ctx, config) {
  const client = await getClient(ctx, config);
  const { bugs, total } = await client.listAssignedBugs();
  return { ok: true, bugs, total, fetchedAt: new Date().toISOString() };
}

/**
 * One bug's detail, text only.
 *
 * Attachments used to be downloaded and inlined here, which made the panel wait
 * ~10s for the slowest screenshot before it could show a single word. The panel
 * now renders the article immediately and pulls each picture through
 * `bugImage`, so the reading starts in a fraction of a second and pictures fill
 * in as they arrive.
 * @param {object} ctx - plugin context.
 * @param {object} body - `{id}`.
 * @returns {Promise<object>} detail payload plus the image list to resolve.
 */
async function bugDetail(ctx, config, body) {
  const id = String(body?.id ?? '').trim();
  if (!/^\d+$/.test(id)) throw new Error('BUG 编号不合法');
  const client = await getClient(ctx, config);
  const detail = await client.getBug(id);
  const images = [...new Set([
    ...imageSources(detail.article.html),
    ...detail.history.flatMap((item) => imageSources(item.comment)),
  ])].slice(0, IMAGE_LIMIT);
  /* Probe every attachment's header first — a few hundred milliseconds for
     all of them, against ten seconds to download the slowest — so each
     placeholder reserves the exact box the picture will occupy. A probe that
     fails simply leaves the generic box. */
  const sizes = new Map(await Promise.all(images.map(async (src) => [
    src,
    await client.probeImageSize(src).catch(() => null),
  ])));
  /* Swap every <img> for a placeholder of the right size; the panel fills them
     in one by one as `/image` answers. Nothing is inlined here on purpose — the
     bytes would cost seconds and the article does not need them. */
  return {
    ok: true,
    bug: {
      ...detail,
      article: { ...detail.article, html: pendingImages(detail.article.html, sizes) },
      history: detail.history.map((item) => ({ ...item, comment: pendingImages(item.comment, sizes) })),
    },
    images,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * One attachment, as a data URL the panel can show without ever holding the
 * session cookie.
 * @param {object} ctx - plugin context.
 * @param {object} body - `{src}`.
 * @returns {Promise<object>} `{ok, src, dataUrl, width, height}`.
 */
async function bugImage(ctx, config, body) {
  const src = String(body?.src ?? '').trim();
  /* Only paths on the configured installation: no absolute URLs, no `..`. */
  if (!/^\/(?!\/)/.test(src) || src.includes('..')) throw new Error('图片地址不合法');
  const client = await getClient(ctx, config);
  const resource = await client.getResource(src);
  if (resource.body.length > IMAGE_BYTES_LIMIT) throw new Error('图片过大');
  const size = imageDimensions(resource.body) ?? {};
  return {
    ok: true,
    src,
    dataUrl: `data:${resource.contentType.split(';')[0]};base64,${resource.body.toString('base64')}`,
    width: size.width,
    height: size.height,
  };
}

/**
 * Register the panel bridge routes.
 * @param {object} ctx - plugin context.
 */
function registerBridge(ctx, config) {
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => {
      const routes = [
        makeRoute(ctx, '/state', async () => describeState(ctx, config)),
        makeRoute(ctx, '/settings', async (body) => saveSettings(ctx, config, body)),
        makeRoute(ctx, '/password', async (body) => savePassword(ctx, config, body)),
        makeRoute(ctx, '/bugs', async () => listBugs(ctx, config)),
        makeRoute(ctx, '/bug', async (body) => bugDetail(ctx, config, body)),
        makeRoute(ctx, '/image', async (body) => bugImage(ctx, config, body)),
      ];
      const disposers = routes.map((route) => registerRoute(sctx, route));
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'dsh-plugin-zentao: panel bridge');
  });
}

/**
 * Wrap a handler in the bridge guard chain.
 * @param {object} ctx - plugin context.
 * @param {string} path - route path below the prefix.
 * @param {(body: object) => Promise<object>} handler - route body.
 * @returns {object} route description.
 */
function makeRoute(ctx, path, handler) {
  return {
    kind: 'exact',
    path: BRIDGE_PREFIX + path,
    handler: async (req, res) => {
      const rejection = bridgeAuthRejection(req, ctx.get('connection'));
      if (rejection !== undefined) {
        writeJson(res, rejection, { ok: false, error: 'host authentication required' });
        return;
      }
      if (!isBridgeRequestAllowed(req)) {
        writeJson(res, 403, { ok: false, error: 'requests must come from the local host' });
        return;
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method}` });
        return;
      }
      const body = (await readJsonBody(req)) ?? {};
      try {
        writeJson(res, 200, await handler(body));
      } catch (error) {
        writeJson(res, 200, { ok: false, error: String(error?.message ?? error) });
      }
    },
  };
}

/**
 * Register one route, tolerating a leftover registration from a previous load.
 * @param {object} sctx - context with `webServer`.
 * @param {object} route - route description.
 * @returns {() => void} disposer.
 */
function registerRoute(sctx, route) {
  try {
    return sctx.get('webServer').register(route);
  } catch (error) {
    if (error?.code === 'WEB_DUPLICATE_PROVIDER' || /already registered|duplicate/i.test(String(error?.message ?? ''))) {
      return () => {};
    }
    throw error;
  }
}

/**
 * Ask the connection service whether this request is authenticated. Missing
 * service means "cannot verify", which is a refusal, not a pass.
 * @param {object} request - HTTP request.
 * @param {object} connection - connection service.
 * @returns {number|undefined} HTTP status to answer with, if refused.
 */
function bridgeAuthRejection(request, connection) {
  if (!connection || typeof connection.requestRejection !== 'function') return 503;
  try {
    return connection.requestRejection(request) ?? undefined;
  } catch {
    return 503;
  }
}

/**
 * Loopback-only, same-origin check for the bridge.
 * @param {object} request - HTTP request.
 * @returns {boolean} true when the request may be served.
 */
function isBridgeRequestAllowed(request) {
  const host = request.headers?.host;
  if (!host) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== host) return false;
    } catch {
      return false;
    }
  }
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') return false;
  return isLoopbackAddress(request.socket?.remoteAddress);
}

/**
 * @param {string} [address] - socket remote address.
 * @returns {boolean} true for a loopback address.
 */
function isLoopbackAddress(address) {
  const value = String(address ?? '').toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

/**
 * Write a JSON response.
 * @param {object} res - HTTP response.
 * @param {number} status - status code.
 * @param {object} body - payload.
 */
function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  });
  res.end(JSON.stringify(body));
}

/**
 * Read a JSON body, refusing anything oversized.
 * @param {object} req - HTTP request.
 * @returns {Promise<object|undefined>} parsed body.
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) {
        resolve(undefined);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}

/**
 * Plugin entry.
 * @param {object} ctx - plugin context.
 */
export function apply(ctx, config) {
  registerBridge(ctx, config);
  ctx.effect(() => () => sessions.clear(), 'dsh-plugin-zentao: session cache');
}
