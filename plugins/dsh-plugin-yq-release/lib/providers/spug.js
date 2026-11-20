/**
 * Spug deployment client: log in, resolve an app + environment into a deploy
 * config, create a release request, trigger it, and poll it to completion.
 *
 * The request name is the identity we match on after triggering, because the
 * create call does not return the new request id. Names are therefore built
 * from the merged commit short id (`test#a1b2c3d`), never from a version
 * number — versions repeat, commit ids do not.
 */

/** A Spug API call failed. */
export class SpugError extends Error {
  /**
   * @param {string} message - human message.
   * @param {number} [status] - HTTP status.
   * @param {unknown} [payload] - decoded response body.
   */
  constructor(message, status, payload) {
    super(message);
    this.name = 'SpugError';
    this.status = status;
    this.payload = payload;
  }
}

/** Release request statuses that are still in flight. */
const PENDING = new Set(['1', '2']);

/** Release request status that counts as success. */
const SUCCESS = '3';

/**
 * @param {unknown} status - Spug status code.
 * @returns {boolean} whether the request is still running.
 */
export function isPendingStatus(status) {
  return PENDING.has(String(status));
}

/**
 * @param {unknown} status - Spug status code.
 * @returns {boolean} whether the request succeeded.
 */
export function isSuccessStatus(status) {
  return String(status) === SUCCESS;
}

/**
 * Spug REST client.
 */
export class SpugClient {
  /**
   * @param {object} options - client options.
   * @param {string} options.baseUrl - Spug base URL.
   * @param {typeof fetch} [options.fetchImpl] - injectable fetch.
   */
  constructor({ baseUrl, fetchImpl = globalThis.fetch }) {
    if (!baseUrl) throw new SpugError('Spug base URL is not configured');
    this.baseUrl = String(baseUrl).endsWith('/') ? String(baseUrl) : `${baseUrl}/`;
    this.fetchImpl = fetchImpl;
    this.token = '';
  }

  /**
   * Exchange username/password for an access token.
   * @param {string} username - Spug user name.
   * @param {string} password - Spug password.
   * @returns {Promise<{id: number, nickname: string, token: string}>} session info.
   */
  async login(username, password) {
    if (!username || !password) {
      throw new SpugError('Spug 用户名或密码未配置');
    }
    const data = await this.request('POST', 'api/account/login/', {
      username,
      password,
      type: 'default',
    });
    if (!data?.access_token) {
      throw new SpugError('Spug 登录失败：响应里没有 access_token', 200, data);
    }
    this.token = data.access_token;
    return { id: data.id, nickname: data.nickname, token: data.access_token };
  }

  /**
   * List environments.
   * @returns {Promise<Array<{id: number, name: string, key: string}>>} environments.
   */
  async listEnvironments() {
    const data = await this.request('GET', 'api/config/environment/');
    return Array.isArray(data) ? data : [];
  }

  /**
   * List applications.
   * @returns {Promise<Array<{id: number, name: string, key: string}>>} applications.
   */
  async listApps() {
    const data = await this.request('GET', 'api/app/');
    return Array.isArray(data) ? data : [];
  }

  /**
   * List deploy configs, optionally narrowed to one app.
   * @param {number} [appId] - application id.
   * @returns {Promise<Array<object>>} deploy configs.
   */
  async listDeployments(appId) {
    const query = appId === undefined ? '' : `?app_id=${encodeURIComponent(appId)}`;
    const data = await this.request('GET', `api/app/deploy/${query}`);
    return Array.isArray(data) ? data : [];
  }

  /**
   * Resolve `app` + `env` selectors into one deploy config. Selectors match id,
   * key, or exact name; the deploy config must already exist for that pair —
   * this client never creates one.
   * @param {object} options - selectors.
   * @param {string|number} options.app - app selector.
   * @param {string|number} options.env - environment selector.
   * @returns {Promise<{app: object, environment: object, deploy: object}>} resolved target.
   */
  async resolveDeployTarget({ app, env }) {
    const [apps, environments] = await Promise.all([this.listApps(), this.listEnvironments()]);
    const appRow = matchByIdentity(apps, app);
    if (!appRow) {
      throw new SpugError(`Spug 里没有应用 \`${app}\``, 404, {
        available: apps.map((item) => item.name),
      });
    }
    const envRow = matchByIdentity(environments, env);
    if (!envRow) {
      throw new SpugError(`Spug 里没有环境 \`${env}\``, 404, {
        available: environments.map((item) => item.name),
      });
    }
    const deployments = await this.listDeployments(appRow.id);
    const deploy = deployments.find(
      (item) => item.app_id === appRow.id && item.env_id === envRow.id,
    );
    if (!deploy) {
      throw new SpugError(
        `应用 \`${appRow.name}\` 在环境 \`${envRow.name}\` 下没有发布配置，请先在 Spug 里配置`,
        404,
        { appId: appRow.id, envId: envRow.id },
      );
    }
    return { app: appRow, environment: envRow, deploy };
  }

  /**
   * Create a release request. The new id is not returned by the create call, so
   * it is recovered from the request list by exact name match.
   * @param {object} options - request options.
   * @param {number} options.deployId - deploy config id.
   * @param {string} options.name - request name, matched back by equality.
   * @param {number[]} [options.hostIds] - host override.
   * @param {[string, string, string]|null} [options.extra] - version/branch tuple.
   * @returns {Promise<object>} the created request row.
   */
  async createReleaseRequest({ deployId, name, hostIds, extra = null }) {
    const payload = { name, deploy_id: deployId, host_ids: hostIds, extra };
    await this.request('POST', 'api/deploy/request/ext1/', payload);
    const requests = await this.listRequests();
    const matched = requests
      .filter((item) => item.deploy_id === deployId && item.name === name)
      .sort((a, b) => b.id - a.id)[0];
    if (!matched) {
      throw new SpugError(
        `发布请求已创建，但无法在请求列表里按名称 \`${name}\` 找回它的 id`,
        200,
        { deployId, name },
      );
    }
    return matched;
  }

  /**
   * List release requests.
   * @returns {Promise<Array<object>>} requests.
   */
  async listRequests() {
    const data = await this.request('GET', 'api/deploy/request/');
    return Array.isArray(data) ? data : [];
  }

  /**
   * Find one request by id.
   * @param {number} id - request id.
   * @returns {Promise<object|undefined>} the request row.
   */
  async findRequest(id) {
    const requests = await this.listRequests();
    return requests.find((item) => item.id === id);
  }

  /**
   * Trigger a release request.
   * @param {number} id - request id.
   * @param {string} [mode] - `all` runs every host.
   * @returns {Promise<unknown>} API payload.
   */
  async triggerDeploy(id, mode = 'all') {
    return this.request('POST', `api/deploy/request/${id}/`, { mode });
  }

  /**
   * Read one request's status.
   * @param {number} id - request id.
   * @returns {Promise<{status: string, reason?: string, status_alias?: string, fail_host_ids?: number[]}>} status.
   */
  async getReleaseStatus(id) {
    const data = await this.request('GET', `api/deploy/request/info/?id=${encodeURIComponent(id)}`);
    return data ?? {};
  }

  /**
   * Poll a request until it leaves the pending set or the budget runs out.
   * @param {object} options - poll options.
   * @param {number} options.requestId - request id.
   * @param {number} options.pollSeconds - interval.
   * @param {number} options.timeoutSeconds - total budget.
   * @param {(line: string) => void} [options.onProgress] - progress narration.
   * @returns {Promise<{status: string, reason?: string, status_alias?: string, fail_host_ids?: number[], timedOut?: boolean}>} final status.
   */
  async waitForCompletion({ requestId, pollSeconds, timeoutSeconds, onProgress = () => {} }) {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let last = {};
    for (;;) {
      last = await this.getReleaseStatus(requestId);
      if (!isPendingStatus(last.status)) return last;
      if (Date.now() > deadline) {
        return { ...last, timedOut: true };
      }
      onProgress(
        `Spug 请求 ${requestId} 进行中（status=${last.status}${last.status_alias ? ` ${last.status_alias}` : ''}），${pollSeconds}s 后重查`,
      );
      await sleep(pollSeconds * 1000);
    }
  }

  /**
   * One authenticated JSON request.
   * @param {string} method - HTTP method.
   * @param {string} path - path below base URL.
   * @param {unknown} [body] - JSON body.
   * @returns {Promise<any>} `payload.data`.
   */
  async request(method, path, body) {
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      method,
      headers: {
        accept: 'application/json, text/plain, */*',
        'x-token': this.token || randomToken(),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      payload = text;
    }
    if (!response.ok) {
      throw new SpugError(
        `Spug 请求失败 (${response.status}): ${describe(payload, text)}`,
        response.status,
        payload,
      );
    }
    if (!payload || typeof payload !== 'object') {
      throw new SpugError('Spug 返回了非对象响应', response.status, payload);
    }
    if (payload.error) {
      throw new SpugError(String(payload.error), response.status, payload);
    }
    return payload.data;
  }
}

/**
 * Match an app/environment selector against id, key, or exact name.
 * @param {Array<object>} rows - apps or environments.
 * @param {string|number} selector - id, key, or name.
 * @returns {object|undefined} the row.
 */
function matchByIdentity(rows, selector) {
  const raw = String(selector ?? '').trim();
  if (!raw) return undefined;
  const needle = raw.toLowerCase();
  return (
    rows.find((item) => String(item.id) === raw) ??
    rows.find((item) => String(item.name ?? '').toLowerCase() === needle) ??
    rows.find((item) => String(item.key ?? '').toLowerCase() === needle)
  );
}

/** Readable detail out of a Spug error payload. */
function describe(payload, text) {
  if (payload && typeof payload === 'object' && payload.error) return String(payload.error);
  return typeof payload === 'string' ? payload : String(text ?? '');
}

/** Random uuid without dashes, used as `x-token` before login. */
function randomToken() {
  return globalThis.crypto?.randomUUID?.().replace(/-/g, '') ?? String(Math.random()).slice(2);
}

/**
 * Sleep helper.
 * @param {number} ms - milliseconds.
 * @returns {Promise<void>} resolves after the delay.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
