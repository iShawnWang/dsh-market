/**
 * GitLab REST v4 client for the release chains: project/branch lookup, merge
 * request creation, conflict detection, and merge execution.
 *
 * The merge flow is deliberately narrow, with one rule enforced everywhere: a
 * conflict aborts the whole release with a typed error. This module never
 * resolves conflicts and never force-merges.
 */

/** A merge could not proceed because the source and target conflict. */
export class MergeConflictError extends Error {
  /**
   * @param {object} details - conflict evidence surfaced to the user.
   * @param {string} [details.targetBranch] - target branch name.
   * @param {string} [details.sourceBranch] - source branch name.
   * @param {string} [details.mergeStatus] - GitLab `merge_status`.
   * @param {boolean} [details.hasConflicts] - GitLab `has_conflicts`.
   * @param {string} [details.mrUrl] - merge request web URL.
   */
  constructor(details = {}) {
    const mr = details.mrUrl ? `（${details.mrUrl}）` : '';
    super(
      `合并 ${details.sourceBranch} → ${details.targetBranch} 冲突${mr}：` +
        `合并请求无法自动合并（merge_status=${details.mergeStatus ?? 'unknown'}）。` +
        '按规则不自动解决冲突，请手动处理后重试。',
    );
    this.name = 'MergeConflictError';
    this.details = details;
  }
}

/** A GitLab API call failed. */
export class GitLabError extends Error {
  /**
   * @param {string} message - human message.
   * @param {number} [status] - HTTP status.
   * @param {unknown} [payload] - decoded response body.
   */
  constructor(message, status, payload) {
    super(message);
    this.name = 'GitLabError';
    this.status = status;
    this.payload = payload;
  }
}

/**
 * Thin fetch wrapper around one GitLab endpoint.
 */
export class GitLabClient {
  /**
   * @param {object} options - client options.
   * @param {string} options.endpoint - GitLab base URL, e.g. `http://gitlab/`.
   * @param {string} options.token - personal access token.
   * @param {typeof fetch} [options.fetchImpl] - injectable fetch.
   */
  constructor({ endpoint, token, fetchImpl = globalThis.fetch }) {
    if (!endpoint) throw new GitLabError('GitLab endpoint is not configured');
    if (!token) throw new GitLabError('GitLab access token is not configured');
    this.apiUrl = `${String(endpoint).replace(/\/+$/, '')}/api/v4`;
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  /**
   * GET one path.
   * @param {string} path - API path beginning with `/`.
   * @param {Record<string, string|number|undefined>} [params] - query parameters.
   * @returns {Promise<any>} decoded JSON body.
   */
  async get(path, params) {
    const url = new URL(this.apiUrl + path);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return this.request(url, { method: 'GET' });
  }

  /**
   * POST one path.
   * @param {string} path - API path beginning with `/`.
   * @param {unknown} [body] - JSON body.
   * @returns {Promise<any>} decoded JSON body.
   */
  async post(path, body) {
    return this.request(new URL(this.apiUrl + path), {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    });
  }

  /**
   * PUT one path.
   * @param {string} path - API path beginning with `/`.
   * @param {unknown} [body] - JSON body.
   * @returns {Promise<any>} decoded JSON body.
   */
  async put(path, body) {
    return this.request(new URL(this.apiUrl + path), {
      method: 'PUT',
      body: JSON.stringify(body ?? {}),
    });
  }

  /**
   * Execute one request and decode the response.
   * @param {URL} url - absolute API URL.
   * @param {RequestInit} init - fetch options.
   * @returns {Promise<any>} decoded JSON body.
   */
  async request(url, init) {
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        'PRIVATE-TOKEN': this.token,
        'content-type': 'application/json',
        accept: 'application/json',
      },
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      payload = text;
    }
    if (!response.ok) {
      const detail =
        (payload && typeof payload === 'object' && (payload.message || payload.error)) || text;
      throw new GitLabError(
        `GitLab 请求失败 (${response.status}): ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`,
        response.status,
        payload,
      );
    }
    return payload;
  }

  /**
   * Resolve a project selector to an id. A numeric selector is used as-is;
   * otherwise the first exact `path_with_namespace`/`path`/`name` match wins.
   * @param {string|number} project - project selector.
   * @returns {Promise<number>} project id.
   */
  async resolveProjectId(project) {
    if (typeof project === 'number' && Number.isFinite(project)) return project;
    if (/^\d+$/.test(String(project))) return Number(project);
    const projects = await this.get('/projects', {
      search: String(project),
      membership: 'true',
      simple: 'true',
      per_page: 100,
    });
    const exact = (projects ?? []).find(
      (p) => p.path_with_namespace === project || p.path === project || p.name === project,
    );
    const picked = exact ?? (projects ?? [])[0];
    if (!picked) {
      throw new GitLabError(`找不到 GitLab 项目 \`${project}\``, 404, projects);
    }
    return picked.id;
  }

  /**
   * Read one branch. Exact name only — a typo must fail loudly rather than
   * resolve to some fuzzy neighbour and release the wrong code.
   * @param {number} projectId - project id.
   * @param {string} branch - branch name.
   * @returns {Promise<object|undefined>} branch payload, undefined when absent.
   */
  async getBranch(projectId, branch) {
    try {
      return await this.get(
        `/projects/${projectId}/repository/branches/${encodeURIComponent(branch)}`,
      );
    } catch (error) {
      if (error instanceof GitLabError && error.status === 404) {
        const names = await this.listBranchNames(projectId, branch);
        throw new GitLabError(
          `GitLab 仓库里没有分支 \`${branch}\`` +
            (names.length > 0 ? `（相近分支：${names.join('、')}）` : '') +
            '。请确认是否已 push。',
          404,
          { branch, similar: names },
        );
      }
      throw error;
    }
  }

  /**
   * Search branch names, used only to enrich a not-found message.
   * @param {number} projectId - project id.
   * @param {string} needle - search text.
   * @returns {Promise<string[]>} similar branch names.
   */
  async listBranchNames(projectId, needle) {
    try {
      const branches = await this.get(`/projects/${projectId}/repository/branches`, {
        search: needle,
        per_page: 20,
      });
      return (branches ?? []).map((b) => b.name).slice(0, 5);
    } catch {
      return [];
    }
  }

  /**
   * Merge source into target through a merge request and return the resulting
   * target commit. A conflict raises {@link MergeConflictError} and the caller
   * must stop — there is no fallback that resolves or forces the merge.
   * @param {object} options - merge options.
   * @param {number} options.projectId - project id.
   * @param {string} options.sourceBranch - source branch.
   * @param {string} options.targetBranch - target branch.
   * @param {string} [options.title] - merge request title.
   * @param {(line: string) => void} [options.onProgress] - progress narration.
   * @returns {Promise<{state: string, commitId?: string, commitShort?: string, commitTitle?: string, mrIid?: number, mrUrl?: string, message?: string, alreadyMerged: boolean}>} merge outcome.
   */
  async merge({ projectId, sourceBranch, targetBranch, title, onProgress = () => {} }) {
    const mrTitle = title || `${sourceBranch} -> ${targetBranch}`;
    let mr;
    try {
      mr = await this.post(`/projects/${projectId}/merge_requests`, {
        source_branch: sourceBranch,
        target_branch: targetBranch,
        title: mrTitle,
        remove_source_branch: 'false',
      });
    } catch (error) {
      if (!(error instanceof GitLabError)) throw error;
      const text = String(error.message ?? '');
      if (/another open merge request already exists/i.test(text)) {
        const open = await this.get(`/projects/${projectId}/merge_requests`, {
          source_branch: sourceBranch,
          target_branch: targetBranch,
          state: 'opened',
        });
        mr = (open ?? [])[0];
        if (!mr) throw error;
        onProgress(`复用已存在的合并请求 !${mr.iid}`);
      } else if (/no commits|source branch is the same|empty/i.test(text)) {
        return {
          state: 'no-op',
          alreadyMerged: true,
          message: '源分支与目标分支已经是最新，无需合并',
        };
      } else {
        throw error;
      }
    }

    const empty = await this.isMergeRequestEmpty(projectId, mr.iid);
    if (empty) {
      await this.put(`/projects/${projectId}/merge_requests/${mr.iid}`, { state_event: 'close' });
      return {
        state: 'no-op',
        alreadyMerged: true,
        mrIid: mr.iid,
        mrUrl: mr.web_url,
        message: '源分支没有新提交，空合并请求已关闭',
      };
    }

    const ready = await this.waitMergeable(projectId, mr.iid, sourceBranch, targetBranch, onProgress);
    if (!ready.mergeable) {
      throw new MergeConflictError({
        sourceBranch,
        targetBranch,
        mergeStatus: ready.mergeStatus,
        hasConflicts: ready.hasConflicts,
        mrUrl: ready.mrUrl,
      });
    }

    onProgress(`合并请求 !${mr.iid} 可合并，执行合并`);
    const merged = await this.put(`/projects/${projectId}/merge_requests/${mr.iid}/merge`, {
      should_remove_source_branch: false,
    });
    if (merged?.state && merged.state !== 'merged' && merged.state !== 'locked') {
      throw new GitLabError(`合并请求 !${mr.iid} 未进入 merged 状态（${merged.state}）`, 200, merged);
    }

    const target = await this.readTargetCommit(projectId, targetBranch, onProgress);
    // `null` rather than `undefined` for the fields that may be missing: this
    // object travels out through tool output, which must survive a JSON round
    // trip, and `undefined` does not.
    return {
      state: 'merged',
      alreadyMerged: false,
      mrIid: mr.iid,
      mrUrl: ready.mrUrl ?? mr.web_url ?? null,
      commitId: target?.id ?? null,
      commitShort: target?.short_id ?? null,
      commitTitle: target?.title ?? null,
    };
  }

  /**
   * Whether the merge request carries no changes.
   * @param {number} projectId - project id.
   * @param {number} iid - merge request iid.
   * @returns {Promise<boolean>} true when it has no changes.
   */
  async isMergeRequestEmpty(projectId, iid) {
    try {
      const changes = await this.get(`/projects/${projectId}/merge_requests/${iid}/changes`);
      return Array.isArray(changes?.changes) && changes.changes.length === 0;
    } catch {
      return false;
    }
  }

  /**
   * Poll until GitLab reports the merge request as mergeable, conflicting, or
   * the poll budget is spent.
   * @param {number} projectId - project id.
   * @param {number} iid - merge request iid.
   * @param {string} sourceBranch - source branch (for the error detail).
   * @param {string} targetBranch - target branch (for the error detail).
   * @param {(line: string) => void} onProgress - progress narration.
   * @returns {Promise<{mergeable: boolean, mergeStatus?: string, hasConflicts?: boolean, mrUrl?: string}>} verdict.
   */
  async waitMergeable(projectId, iid, sourceBranch, targetBranch, onProgress) {
    const attempts = 15;
    let last;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      last = await this.get(`/projects/${projectId}/merge_requests/${iid}`);
      if (last?.has_conflicts || last?.merge_status === 'cannot_be_merged') {
        return {
          mergeable: false,
          mergeStatus: last.merge_status,
          hasConflicts: last.has_conflicts,
          mrUrl: last.web_url,
        };
      }
      if (last?.merge_status === 'can_be_merged' || last?.detailed_merge_status === 'mergeable') {
        return { mergeable: true, mergeStatus: last.merge_status, mrUrl: last.web_url };
      }
      onProgress(
        `等待 GitLab 计算可合并性 (${attempt}/${attempts}, merge_status=${last?.merge_status ?? 'unknown'})`,
      );
      await sleep(2000);
    }
    return {
      mergeable: false,
      mergeStatus: last?.merge_status ?? 'timeout',
      hasConflicts: last?.has_conflicts,
      mrUrl: last?.web_url,
      sourceBranch,
      targetBranch,
    };
  }

  /**
   * Read the target branch head after a merge. GitLab can lag a beat behind the
   * merge, so this retries briefly instead of reporting a stale commit.
   * @param {number} projectId - project id.
   * @param {string} branch - target branch.
   * @param {(line: string) => void} onProgress - progress narration.
   * @returns {Promise<{id: string, short_id: string, title: string}|undefined>} target head commit.
   */
  async readTargetCommit(projectId, branch, onProgress) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const info = await this.get(
          `/projects/${projectId}/repository/branches/${encodeURIComponent(branch)}`,
        );
        if (info?.commit?.id) return info.commit;
      } catch (error) {
        if (attempt === 3) throw error;
      }
      onProgress(`读取 ${branch} 最新提交 (${attempt}/3)`);
      await sleep(1000);
    }
    return undefined;
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
