/**
 * Mini program build client for the `qqc-miniprogram-server` box.
 *
 * That machine is a laptop that gets powered down, and its address has already
 * moved twice, so every build starts with a short probe. A probe failure is a
 * `blocked` outcome, not a retry loop: the release waits for a human to bring
 * the box up.
 *
 * Two facts about this API drive the shape of the code:
 *  - `trigger_build` reports the commit it saw *before* the build script pulled,
 *    so the authoritative commit is the one in the final build log.
 *  - a build is only finished when `isBuilding === false` AND
 *    `queuePosition === null`; either one alone can be a queued run.
 */

/** A build could not be started or observed. */
export class BuildBlockedError extends Error {
  /**
   * @param {string} message - human message.
   * @param {object} [details] - recovery hints.
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'BuildBlockedError';
    this.details = details;
  }
}

/** A qqc API call failed. */
export class QqcError extends Error {
  /**
   * @param {string} message - human message.
   * @param {number} [status] - HTTP status.
   * @param {unknown} [payload] - decoded response body.
   */
  constructor(message, status, payload) {
    super(message);
    this.name = 'QqcError';
    this.status = status;
    this.payload = payload;
  }
}

/** Default probe backoff in milliseconds. */
const PROBE_BACKOFF = [1000, 3000, 7000];

/**
 * HTTP client for the mini program build server.
 */
export class QqcClient {
  /**
   * @param {object} options - client options.
   * @param {string} options.baseUrl - build server base URL.
   * @param {typeof fetch} [options.fetchImpl] - injectable fetch.
   */
  constructor({ baseUrl, fetchImpl = globalThis.fetch }) {
    if (!baseUrl) throw new QqcError('qqc base URL is not configured');
    this.baseUrl = String(baseUrl).endsWith('/') ? String(baseUrl) : `${baseUrl}/`;
    this.fetchImpl = fetchImpl;
  }

  /**
   * Probe the server, retrying with backoff. Throws {@link BuildBlockedError}
   * with the address and attempt count so the user knows exactly what to start.
   * @param {object} [options] - probe options.
   * @param {number} [options.attempts] - number of attempts.
   * @param {(line: string) => void} [options.onProgress] - progress narration.
   * @returns {Promise<{status: string, uptime?: number}>} health payload.
   */
  async probe({ attempts = PROBE_BACKOFF.length, onProgress = () => {} } = {}) {
    const total = Math.max(1, attempts);
    let lastError;
    for (let attempt = 1; attempt <= total; attempt += 1) {
      try {
        const health = await this.get('health', { timeoutMs: 5000 });
        onProgress(`构建机 ${this.baseUrl} 在线（第 ${attempt} 次探活成功）`);
        return health;
      } catch (error) {
        lastError = error;
        onProgress(`构建机 ${this.baseUrl} 探活失败 (${attempt}/${total})：${error.message}`);
        if (attempt < total) await sleep(PROBE_BACKOFF[Math.min(attempt, PROBE_BACKOFF.length) - 1]);
      }
    }
    throw new BuildBlockedError(
      `构建机 ${this.baseUrl} 连不上（探活 ${total} 次均失败）：${lastError?.message ?? 'unknown'}。` +
        '请先确认构建机已开机，或检查配置里的地址是否又变了。',
      { baseUrl: this.baseUrl, attempts: total },
    );
  }

  /**
   * List the projects this server can build.
   * @returns {Promise<Array<{id: string, label: string, branch: string, appid: string}>>} projects.
   */
  async listProjects() {
    const data = await this.get('projects');
    return Array.isArray(data?.projects) ? data.projects : [];
  }

  /**
   * Queue or start a build.
   * @param {object} options - build options.
   * @param {string} options.project - project id, e.g. `YQ-QQC`.
   * @param {(line: string) => void} [options.onProgress] - progress narration.
   * @returns {Promise<{queued: boolean, position?: number, alreadyRunning?: boolean}>} enqueue outcome.
   */
  async triggerBuild({ project, onProgress = () => {} }) {
    if (!project) throw new QqcError('project 不能为空');
    const { status, data } = await this.request('build', { project });
    if (status === 409) {
      // Another run of the same project is already active. Adopt it instead of
      // failing: the user asked for "this project built", not for a new run.
      onProgress(`${project} 已经在构建中，直接跟踪当前这次构建`);
      return { queued: false, alreadyRunning: true };
    }
    if (status === 202 || data?.queued) {
      onProgress(`${project} 已排队，前面还有 ${data?.position ?? '?'} 个构建`);
      return { queued: true, position: data?.position };
    }
    onProgress(`${project} 构建已启动`);
    return { queued: false };
  }

  /**
   * Read build status.
   * @param {string} project - project id.
   * @returns {Promise<object>} status payload.
   */
  async getStatus(project) {
    return this.get('status', { project });
  }

  /**
   * Read the build log.
   * @param {string} project - project id.
   * @returns {Promise<string>} log text.
   */
  async getLog(project) {
    const { data } = await this.request('log', { project });
    if (typeof data === 'string') return data;
    return String(data?.log ?? data?.content ?? '');
  }

  /**
   * Poll until the project is idle and off the queue, then read the log.
   * @param {object} options - poll options.
   * @param {string} options.project - project id.
   * @param {number} options.pollSeconds - interval.
   * @param {number} options.timeoutSeconds - total budget.
   * @param {(line: string) => void} [options.onProgress] - progress narration.
   * @returns {Promise<{status: object, log: string, timedOut: boolean}>} final state.
   */
  async waitForBuild({ project, pollSeconds, timeoutSeconds, onProgress = () => {} }) {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let last = {};
    for (;;) {
      last = (await this.getStatus(project)) ?? {};
      const building = last.isBuilding === true;
      const queued = last.queuePosition !== null && last.queuePosition !== undefined;
      if (!building && !queued) break;
      if (Date.now() > deadline) {
        return { status: last, log: await this.getLog(project).catch(() => ''), timedOut: true };
      }
      onProgress(
        building
          ? `构建中（${last.progress ?? last.phase ?? 'running'}）`
          : `排队中（位置 ${last.queuePosition}）`,
      );
      await sleep(pollSeconds * 1000);
    }
    const log = await this.getLog(project).catch(() => '');
    return { status: last, log, timedOut: false };
  }

  /**
   * Extract the authoritative commit from a finished build log. The trigger
   * response carries a stale head, so this is the only trustworthy source.
   * @param {string} log - build log text.
   * @returns {{commit?: string, success: boolean}} parsed result.
   */
  parseBuildResult(log) {
    const text = String(log ?? '');
    const success = /Build successful/i.test(text);
    const commitMatch =
      /Commit hash:\s*([0-9a-f]{7,40})/i.exec(text) ?? /commit\s+([0-9a-f]{40})/i.exec(text);
    return { commit: commitMatch?.[1], success };
  }

  /**
   * GET one path without a `project` parameter.
   * @param {string} path - path below base URL.
   * @param {object} [options] - request options.
   * @param {number} [options.timeoutMs] - abort timeout.
   * @returns {Promise<any>} decoded body.
   */
  async get(path, { timeoutMs } = {}) {
    const { data } = await this.request(path, {}, { timeoutMs });
    return data;
  }

  /**
   * One request against the build server. `project` is a required query
   * parameter on every build endpoint and is omitted only for `health`.
   * @param {string} path - path below base URL.
   * @param {Record<string, string>} [params] - query parameters.
   * @param {object} [options] - request options.
   * @param {number} [options.timeoutMs] - abort timeout.
   * @returns {Promise<{status: number, data: any}>} status and decoded body.
   */
  async request(path, params = {}, { timeoutMs } = {}) {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    const controller = timeoutMs ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (error) {
      throw new QqcError(`构建机请求失败：${error?.message ?? error}`, 0, undefined);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (response.status >= 500) {
      throw new QqcError(`构建机返回 ${response.status}`, response.status, data);
    }
    return { status: response.status, data };
  }
}

/**
 * Sleep helper.
 * @param {number} ms - milliseconds.
 * @returns {Promise<void>} resolves after the delay.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
