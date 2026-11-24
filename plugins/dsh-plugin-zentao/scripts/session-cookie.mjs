/**
 * Mint a DSH browser-session cookie from the profile's stored signing secret.
 *
 * The checks drive the real web UI, which rejects requests without a session
 * cookie. Rather than script a login, this reads the same secret the host signs
 * cookies with and produces one the host accepts.
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CREDENTIALS = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml');

/** The `secret` field of the `client-connection/browser-session` record. */
function readSecret(text) {
  let secret = null;
  let inside = false;
  let indent = -1;
  for (const line of text.split('\n')) {
    const header = line.match(/^(\s*)client-connection\/browser-session:\s*$/);
    if (header) {
      inside = true;
      indent = header[1].length;
      continue;
    }
    if (inside && /^\s*\S/.test(line) && line.match(/^(\s*)/)[1].length <= indent) inside = false;
    if (!inside) continue;
    const found = line.match(/^\s*secret:\s*(\S+)\s*$/);
    if (found) secret = found[1];
  }
  return secret;
}

const base64Url = (bytes) => Buffer.from(bytes).toString('base64')
  .replaceAll('+', '-')
  .replaceAll('/', '_')
  .replace(/=+$/u, '');

/**
 * @param {string} authority - `host:port` the cookie is scoped to.
 * @returns {string|null} a `name=value` cookie pair, or null when there is no secret.
 */
export function mintSessionCookie(authority) {
  let secret;
  try {
    secret = readSecret(readFileSync(CREDENTIALS, 'utf8'));
  } catch {
    return null;
  }
  if (!secret) return null;

  const key = Buffer.from(secret.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  const now = Date.now();
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 24 * 3600 * 1000 };
  const body = base64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = base64Url(createHmac('sha256', key).update(body).digest());
  const name = `dsh-auth-${base64Url(createHash('sha256').update(authority).digest())}`;
  return `${name}=v1.${body}.${signature}`;
}
