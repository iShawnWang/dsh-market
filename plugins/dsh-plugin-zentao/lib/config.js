import z from '@deepseek-ai/schemastery';

/**
 * Configuration surface of the plugin.
 *
 * Both fields are `.volatile()`: the panel writes them through the settings
 * service, so the panel — not a hand-edited profile file — owns their value.
 * Empty means "not configured yet"; the plugin never falls back to a baked-in
 * host, so it cannot talk to a machine the user did not point it at.
 */
export const Config = z.object({
  baseUrl: z.string().default('').volatile(),
  username: z.string().default('').volatile(),
});

/** Credential ref holding the password. Never stored in configuration. */
export const CREDENTIAL_REFS = {
  password: 'ZENTAO_PASSWORD',
};

/**
 * Unwrap volatile config references.
 *
 * A `.volatile()` field arrives as `{ get() }` rather than a plain string, and
 * the wrapper must be unwrapped on every read — caching it would freeze the
 * value at load time.
 * @param {object} config - live plugin config.
 * @returns {{baseUrl: string, username: string}} plain values.
 */
export function readConfig(config) {
  const value = (key) => {
    const raw = config?.[key];
    if (raw === undefined || raw === null) return '';
    if (typeof raw === 'function') return String(raw() ?? '');
    if (typeof raw === 'object' && typeof raw.get === 'function') return String(raw.get() ?? '');
    return String(raw);
  };
  return { baseUrl: value('baseUrl'), username: value('username') };
}

/**
 * Normalize a user-typed ZenTao address into the installation root.
 *
 * Users copy whatever their browser shows — the dashboard, a login page, a
 * sub-path — so trailing slashes, `/my`, `/my-bug.html` and the like are
 * stripped until only `http(s)://host/zentao` remains.
 * @param {string} raw - address as typed.
 * @returns {string} install root without a trailing slash, or '' when empty.
 */
export function normalizeBaseUrl(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('禅道地址不是合法 URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('禅道地址必须是 http 或 https');
  }
  url.search = '';
  url.hash = '';
  const segments = url.pathname.split('/').filter(Boolean);
  const tail = segments[segments.length - 1];
  if (tail && /^(my|my-bug|my-task|my-story)\.html$/.test(tail)) segments.pop();
  else if (tail === 'my' || tail === 'user-login.html') segments.pop();
  else if (segments.length > 1) {
    // A pasted deep link (`/zentao/bug-view-1.html`) still names the root.
    if (/^(bug|task|story|test|product|project|execution|file)-/.test(tail)) segments.pop();
  }
  const path = segments.length ? `/${segments.join('/')}` : '';
  return `${url.origin}${path}`;
}

/**
 * Whether the saved configuration can talk to ZenTao at all.
 * @param {{baseUrl: string, username: string}} live - plain config values.
 * @param {boolean} hasPassword - the credential store holds a password.
 * @returns {boolean} true when both an address and a login are present.
 */
export function isConfigured(live, hasPassword) {
  return Boolean(live.baseUrl && live.username && hasPassword);
}
