/**
 * The release pipeline: one method that takes "把 feat/h5-活动弹屏 发到测试" and
 * either performs it end to end or stops with a specific reason.
 *
 * This class is the single source of truth for a release. The agent tool and
 * the panel both call {@link ReleaseService.run}; neither has its own copy of
 * the flow.
 *
 * Gates, in the order they fire:
 *  1. an unresolvable chain stops before any network call;
 *  2. a merge conflict stops the whole release — nothing is deployed, and there
 *     is no code path that resolves or forces the merge;
 *  3. the merged commit is the identity: the Spug request is named after its
 *     short id and matched back by exact name, and the mini program commit comes
 *     from the build log rather than from the trigger response;
 *  4. a build box that will not answer is reported as `blocked`, never retried
 *     indefinitely;
 *  5. production environments need one explicit confirmation before deploying.
 */

import { ChainResolutionError, defineChain, listChains, resolveChain } from './chains.js';
import { missingEndpoints, readConfig, resolveProjects, resolveSpugBaseUrl } from './config.js';
import { BuildBlockedError, QqcClient, QqcError } from './providers/qqc.js';
import { GitLabClient, GitLabError, MergeConflictError } from './providers/gitlab.js';
import { SpugClient, SpugError, isSuccessStatus } from './providers/spug.js';

/** Environments that require an explicit confirmation before deploying. */
const PRODUCTION_ENV_HINTS = ['prod', '线上'];

/** Credential refs consulted by this plugin. */
export const CREDENTIAL_REFS = {
  gitlabToken: 'GITLAB_ACCESS_TOKEN',
  spugUsername: 'SPUG_USERNAME',
  spugPassword: 'SPUG_PASSWORD',
};

/** A release cannot proceed because a required input or credential is missing. */
export class ReleaseInputError extends Error {
  /**
   * @param {string} message - human message.
   * @param {string} [code] - stable machine code.
   * @param {object} [details] - extra context.
   */
  constructor(message, code = 'RELEASE_INPUT', details = {}) {
    super(message);
    this.name = 'ReleaseInputError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Resolve one credential from the DSH credential store. There is deliberately
 * no `.env` / process-env fallback: a release only runs with a secret the user
 * put there themselves, so a stale file left by another tool can never publish
 * on their behalf. Resolved per call, never cached across operations.
 * @param {object} deps - service dependencies.
 * @param {string} ref - credential ref.
 * @param {object} [options] - options.
 * @param {boolean} [options.required] - throw when missing.
 * @returns {Promise<string|undefined>} the secret.
 */
async function resolveSecret(deps, ref, { required = false } = {}) {
  const credentials = deps.getCredentials?.();
  let value;
  try {
    // `resolve` is async in the credentials seam: reading `.value` off the
    // promise silently yields undefined and makes every stored secret look
    // missing.
    const resolved = await credentials?.resolve?.(ref);
    value = resolved?.value;
  } catch {
    value = undefined;
  }
  if (!value && required) {
    throw new ReleaseInputError(
      `凭据 ${ref} 还没有初始化：请在「YQ-前端发布」面板的凭据卡片里填写后重试`,
      'MISSING_CREDENTIAL',
      { ref },
    );
  }
  return value || undefined;
}

/**
 * Run releases. One instance is created per plugin load.
 */
export class ReleaseService {
  /**
   * @param {object} options - construction options.
   * @param {() => object} options.getConfig - reads the live plugin config.
   * @param {() => object|undefined} options.getCredentials - reads the credentials service.
   * @param {import('./memory.js').ReleaseMemory} options.memory - release ledger.
   * @param {typeof fetch} [options.fetchImpl] - injectable fetch.
   * @param {() => number} [options.now] - clock.
   */
  constructor({ getConfig, getCredentials, memory, fetchImpl, now }) {
    this.getConfig = getConfig;
    this.getCredentials = getCredentials;
    this.memory = memory;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.now = now ?? Date.now;
  }

  /**
   * Plan a release without touching GitLab, Spug, or the build box. Used by the
   * panel and by the tool's dry-run mode so the user can see what would happen.
   * @param {object} input - release request.
   * @param {string} [input.branch] - source branch.
   * @param {string} [input.chain] - explicit chain id.
   * @param {string} [input.project] - explicit project id.
   * @param {string} [input.env] - environment override.
   * @param {boolean} [input.skipMerge] - deploy the target branch as it is.
   * @returns {Promise<object>} plan describing every step and its safety gate.
   */
  async plan(input) {
    const config = readConfig(this.getConfig());
    const projects = await resolveProjectsSafe(config, this.memory);
    const target = resolveTarget({ projects, input });
    const environment = resolveEnvironment({ config, chain: target.chain, env: input.env });
    return {
      project: target.projectId,
      projectLabel: target.project.label ?? target.projectId,
      chain: target.chainId,
      chainLabel: target.chain.label ?? target.chainId,
      reason: target.reason,
      // The resolved chain itself travels with the plan: `run` needs the
      // Spug app / qqc project, and the panel shows them verbatim.
      chainConfig: target.chain,
      gitlabProject: target.project.gitlabProject || target.projectId,
      // `null`, never `undefined`: a plan is returned from a tool, and tool
      // output must survive a JSON round trip — `undefined` does not.
      targetProjectId: target.project.gitlabProjectId || null,
      sourceBranch: input.branch ?? null,
      targetBranch: target.chain.targetBranch,
      provider: target.chain.provider,
      skipMerge: Boolean(input.skipMerge),
      environment,
      requiresConfirmation: isProduction(environment),
      // Which connection settings the user still has to fill in. Filled before
      // any network call, so a plan also works on a machine nobody configured.
      missingEndpoints: missingEndpoints(config),
      actions: describeActions({ chain: target.chain, skipMerge: Boolean(input.skipMerge) }),
    };
  }

  /**
   * Perform a release.
   * @param {object} input - release request.
   * @param {string} [input.branch] - source branch.
   * @param {string} [input.chain] - explicit chain id.
   * @param {string} [input.project] - explicit project id.
   * @param {string} [input.env] - environment override.
   * @param {boolean} [input.skipMerge] - deploy without merging.
   * @param {boolean} [input.confirmProd] - confirmation for production.
   * @param {(line: string) => void} [onProgress] - progress narration.
   * @returns {Promise<object>} release result, always with a `status` field.
   */
  async run(input, { onProgress = () => {} } = {}) {
    const startedAt = this.now();
    const steps = [];
    const record = (step, status, detail) => {
      steps.push({ step, status, detail, at: new Date(this.now()).toISOString() });
      if (detail) onProgress(detail);
    };

    let planned;
    try {
      planned = await this.plan(input);
    } catch (error) {
      if (error instanceof ChainResolutionError) {
        return this.#finish({
          status: 'failed',
          code: 'CHAIN_UNRESOLVED',
          message: error.message,
          details: error.details,
          steps,
          planned: null,
          startedAt,
          record: input,
        });
      }
      throw error;
    }

    if (planned.requiresConfirmation && !input.confirmProd) {
      return this.#finish({
        status: 'blocked',
        code: 'PROD_CONFIRMATION_REQUIRED',
        message: `${planned.environment} 是线上环境，需要再确认一次：加 confirmProd=true 重新执行`,
        details: { environment: planned.environment },
        steps,
        planned,
        startedAt,
        record: input,
      });
    }

    const config = readConfig(this.getConfig());

    // Refuse to reach out with an address nobody typed in. This runs before the
    // first request, so an unconfigured install fails loudly instead of hanging
    // on a host that only ever existed in a previous version's defaults.
    const missing = missingEndpoints(config);
    if (missing.length > 0) {
      return this.#finish({
        status: 'blocked',
        code: 'ENDPOINT_NOT_CONFIGURED',
        message:
          `还没填 ${missing.join(' / ')}：请在「YQ-前端发布」面板的「配置」展项里填好后重试`,
        details: { missing },
        steps,
        planned,
        startedAt,
        record: input,
      });
    }

    let mergeResult = null;
    let releaseResult = null;
    let commitId;

    try {
      if (planned.provider === 'spug') {
        const token = await resolveSecret(this, CREDENTIAL_REFS.gitlabToken, { required: true });
        const gitlab = new GitLabClient({
          endpoint: config.gitlabEndpoint,
          token,
          fetchImpl: this.fetchImpl,
        });
        const projectId =
          planned.targetProjectId ?? (await gitlab.resolveProjectId(planned.gitlabProject));

        if (!planned.skipMerge) {
          if (!input.branch) {
            throw new ReleaseInputError(
              '需要提供源分支名才能合并；如果只想发布目标分支当前代码，请设 skipMerge=true',
              'BRANCH_REQUIRED',
            );
          }
          const source = await gitlab.getBranch(projectId, input.branch);
          record('branch', 'ok', `源分支 ${input.branch} 最新提交 ${short(source.commit?.id)}`);
          mergeResult = await gitlab.merge({
            projectId,
            sourceBranch: input.branch,
            targetBranch: planned.targetBranch,
            title: `${input.branch} -> ${planned.targetBranch}`,
            onProgress: (line) => record('merge', 'running', line),
          });
          if (mergeResult.state === 'no-op') {
            record('merge', 'ok', mergeResult.message ?? '无需合并');
          } else {
            record(
              'merge',
              'ok',
              `已合并 !${mergeResult.mrIid}，${planned.targetBranch} 新提交 ${short(mergeResult.commitId)}`,
            );
          }
          commitId = mergeResult.commitId;
        }

        const targetBranch = await gitlab.getBranch(projectId, planned.targetBranch);
        commitId = commitId ?? targetBranch.commit?.id;
        if (!commitId) {
          throw new ReleaseInputError('读不到目标分支最新提交', 'COMMIT_UNKNOWN');
        }
        const shortCommit = short(commitId);
        record('commit', 'ok', `发布基准提交 ${shortCommit}（${planned.targetBranch}）`);

        const username = await resolveSecret(this, CREDENTIAL_REFS.spugUsername, { required: true });
        const password = await resolveSecret(this, CREDENTIAL_REFS.spugPassword, { required: true });
        const spug = new SpugClient({ baseUrl: resolveSpugBaseUrl(config), fetchImpl: this.fetchImpl });
        const session = await spug.login(username, password);
        record('spug-login', 'ok', `Spug 登录成功（${session.nickname ?? username}）`);

        const target = await spug.resolveDeployTarget({
          app: planned.chainConfig.spugApp,
          env: planned.chainConfig.spugEnv,
        });
        record(
          'spug-target',
          'ok',
          `发布配置 ${target.app.name} / ${target.environment.name}（主机 ${(target.deploy.host_ids ?? []).join(',') || '全部'}）`,
        );

        // Spug's ext1 create endpoint does not fall back to the deploy config's
        // own hosts: leaving host_ids out fails the request with 「请选择要部署
        // 的主机」. Pass the config's hosts through explicitly. A config with no
        // hosts at all cannot be deployed from here, so say that plainly instead
        // of letting Spug answer with its opaque validation error.
        const hostIds = [...(target.deploy.host_ids ?? [])];
        if (hostIds.length === 0) {
          throw new SpugError(
            `发布配置 ${target.app.name} / ${target.environment.name} 没有配置主机，请先在 Spug 里给它选主机`,
          );
        }

        const name = `${planned.targetBranch}#${shortCommit}`;
        const request = await spug.createReleaseRequest({
          deployId: target.deploy.id,
          name,
          hostIds,
          extra: ['branch', planned.targetBranch, shortCommit],
        });
        record('spug-request', 'ok', `已创建发布请求 #${request.id}（名称 ${name}）`);

        await spug.triggerDeploy(request.id);
        record('spug-trigger', 'ok', '已触发发布，等待完成');

        const status = await spug.waitForCompletion({
          requestId: request.id,
          pollSeconds: config.spugPollSeconds ?? 5,
          timeoutSeconds: config.spugTimeoutSeconds ?? 900,
          onProgress: (line) => record('spug-wait', 'running', line),
        });

        releaseResult = {
          provider: 'spug',
          application: target.app.name,
          environment: target.environment.name,
          requestId: request.id,
          requestName: name,
          status: status.status,
          statusAlias: status.status_alias,
          reason: status.reason,
          failHostIds: status.fail_host_ids,
          timedOut: Boolean(status.timedOut),
        };

        if (status.timedOut) {
          record('spug-wait', 'blocked', `等待超时（请求 #${request.id} 仍未结束）`);
          return this.#finish({
            status: 'blocked',
            code: 'SPUG_TIMEOUT',
            message: `Spug 发布请求 #${request.id} 在 ${config.spugTimeoutSeconds ?? 900}s 内没有结束，请到 Spug 查看`,
            details: releaseResult,
            steps,
            planned,
            mergeResult,
            releaseResult,
            commitId,
            startedAt,
            record: input,
          });
        }
        if (!isSuccessStatus(status.status)) {
          record('spug-wait', 'failed', `发布失败：${status.status_alias || status.reason || status.status}`);
          return this.#finish({
            status: 'failed',
            code: 'SPUG_FAILED',
            message: `Spug 发布失败：${status.reason || status.status_alias || `status=${status.status}`}`,
            details: releaseResult,
            steps,
            planned,
            mergeResult,
            releaseResult,
            commitId,
            startedAt,
            record: input,
          });
        }
        record('spug-wait', 'ok', `发布成功（${status.status_alias ?? '完成'}）`);
      } else if (planned.provider === 'qqc') {
        const qqc = new QqcClient({ baseUrl: config.qqcBaseUrl, fetchImpl: this.fetchImpl });
        await qqc.probe({
          attempts: config.qqcProbeAttempts ?? 3,
          onProgress: (line) => record('qqc-probe', 'running', line),
        });
        record('qqc-probe', 'ok', '构建机在线');

        const token = await resolveSecret(this, CREDENTIAL_REFS.gitlabToken, { required: true });
        const gitlab = new GitLabClient({
          endpoint: config.gitlabEndpoint,
          token,
          fetchImpl: this.fetchImpl,
        });
        const projectId =
          planned.targetProjectId ?? (await gitlab.resolveProjectId(planned.gitlabProject));

        if (!planned.skipMerge) {
          if (!input.branch) {
            throw new ReleaseInputError(
              '需要提供源分支名才能合并；如果只想构建目标分支当前代码，请设 skipMerge=true',
              'BRANCH_REQUIRED',
            );
          }
          await gitlab.getBranch(projectId, input.branch);
          mergeResult = await gitlab.merge({
            projectId,
            sourceBranch: input.branch,
            targetBranch: planned.targetBranch,
            title: `${input.branch} -> ${planned.targetBranch}`,
            onProgress: (line) => record('merge', 'running', line),
          });
          record(
            'merge',
            'ok',
            mergeResult.state === 'no-op'
              ? (mergeResult.message ?? '无需合并')
              : `已合并 !${mergeResult.mrIid}`,
          );
        }

        const enqueued = await qqc.triggerBuild({
          project: planned.chainConfig.qqcProject,
          onProgress: (line) => record('qqc-trigger', 'running', line),
        });
        record('qqc-trigger', 'ok', enqueued.alreadyRunning ? '跟踪已有构建' : '构建已排队');

        const finished = await qqc.waitForBuild({
          project: planned.chainConfig.qqcProject,
          pollSeconds: config.qqcPollSeconds ?? 10,
          timeoutSeconds: config.qqcTimeoutSeconds ?? 1800,
          onProgress: (line) => record('qqc-wait', 'running', line),
        });
        if (finished.timedOut) {
          record('qqc-wait', 'blocked', '等待构建超时');
          return this.#finish({
            status: 'blocked',
            code: 'QQC_TIMEOUT',
            message: `构建机上的 ${planned.chainConfig.qqcProject} 在 ${config.qqcTimeoutSeconds ?? 1800}s 内没有结束`,
            details: { project: planned.chainConfig.qqcProject },
            steps,
            planned,
            mergeResult,
            startedAt,
            record: input,
          });
        }

        const parsed = qqc.parseBuildResult(finished.log);
        releaseResult = {
          provider: 'qqc',
          application: planned.chainConfig.qqcProject,
          environment: planned.environment,
          commitId: parsed.commit,
          success: parsed.success,
        };
        if (!parsed.success) {
          record('qqc-wait', 'failed', '构建日志里没有 Build successful');
          return this.#finish({
            status: 'failed',
            code: 'QQC_BUILD_FAILED',
            message: '小程序构建没有成功，请查看构建日志',
            details: { logTail: tail(finished.log, 2000) },
            steps,
            planned,
            mergeResult,
            releaseResult,
            startedAt,
            record: input,
          });
        }
        // The trigger response reports the head it saw before pulling; the log
        // is the only authoritative source for what was actually built.
        commitId = parsed.commit ?? mergeResult?.commitId;
        record(
          'qqc-wait',
          'ok',
          `构建成功，commit ${short(commitId)}${parsed.commit ? '（取自构建日志）' : '（取自合并结果）'}`,
        );
      } else {
        throw new ReleaseInputError(
          `未知发布方 \`${planned.provider}\``,
          'UNKNOWN_PROVIDER',
          { provider: planned.provider },
        );
      }

      return this.#finish({
        status: 'success',
        code: 'OK',
        message: '发布完成',
        details: releaseResult,
        steps,
        planned,
        mergeResult,
        releaseResult,
        commitId,
        startedAt,
        record: input,
      });
    } catch (error) {
      return this.#handleError({
        error,
        steps,
        planned,
        mergeResult,
        releaseResult,
        commitId,
        startedAt,
        input,
      });
    }
  }

  /**
   * Map a thrown error onto a release result. Conflicts and unreachable build
   * boxes are not failures of the code — they are states the user must clear,
   * so they surface as `blocked` with instructions.
   * @param {object} options - error context.
   * @returns {Promise<object>} release result.
   */
  async #handleError({ error, steps, planned, mergeResult, releaseResult, commitId, startedAt, input }) {
    if (error instanceof MergeConflictError) {
      steps.push({
        step: 'merge',
        status: 'blocked',
        detail: error.message,
        at: new Date(this.now()).toISOString(),
      });
      return this.#finish({
        status: 'blocked',
        code: 'MERGE_CONFLICT',
        message: error.message,
        details: error.details,
        steps,
        planned,
        mergeResult,
        releaseResult,
        commitId,
        startedAt,
        record: input,
      });
    }
    if (error instanceof BuildBlockedError) {
      steps.push({
        step: 'qqc-probe',
        status: 'blocked',
        detail: error.message,
        at: new Date(this.now()).toISOString(),
      });
      return this.#finish({
        status: 'blocked',
        code: 'BUILD_HOST_OFFLINE',
        message: error.message,
        details: error.details,
        steps,
        planned,
        mergeResult,
        releaseResult,
        commitId,
        startedAt,
        record: input,
      });
    }

    const code =
      error instanceof ReleaseInputError
        ? error.code
        : error instanceof GitLabError
          ? 'GITLAB_ERROR'
          : error instanceof SpugError
            ? 'SPUG_ERROR'
            : error instanceof QqcError
              ? 'QQC_ERROR'
              : 'UNEXPECTED_ERROR';
    steps.push({
      step: 'error',
      status: 'failed',
      detail: error.message,
      at: new Date(this.now()).toISOString(),
    });
    return this.#finish({
      status: 'failed',
      code,
      message: error.message,
      details: error.details ?? { status: error.status },
      steps,
      planned,
      mergeResult,
      releaseResult,
      commitId,
      startedAt,
      record: input,
    });
  }

  /**
   * Assemble the result and append it to the ledger. Bookkeeping never changes
   * the reported status: a failed write is attached as a warning instead.
   * @param {object} options - result fields.
   * @returns {Promise<object>} the result handed to tool and panel callers.
   */
  async #finish(options) {
    const finishedAt = this.now();
    const result = {
      status: options.status,
      code: options.code,
      message: options.message ?? '',
      details: options.details ?? null,
      plan: options.planned,
      steps: options.steps,
      merge: options.mergeResult ?? null,
      release: options.releaseResult ?? null,
      commitId: options.commitId ?? null,
      commitShort: options.commitId ? short(options.commitId) : null,
      durationMs: finishedAt - options.startedAt,
      finishedAt: new Date(finishedAt).toISOString(),
    };

    if (this.memory && options.planned) {
      const written = await this.memory.append(buildRecord(result, options.record, options.planned));
      if (!written.ok) result.warning = `发布记录写入失败：${written.error}`;
    }
    return result;
  }
}

/**
 * Build the ledger record for one attempt. The field names are stable on
 * purpose: older records in an existing ledger stay readable next to new ones.
 * @param {object} result - release result.
 * @param {object} input - original request.
 * @param {object} planned - resolved plan.
 * @returns {object} ledger record.
 */
function buildRecord(result, input, planned) {
  const application =
    result.release?.application ?? planned.chainConfig.spugApp ?? planned.chainConfig.qqcProject ?? null;
  return {
    project: planned.project,
    source_branch: input.branch ?? null,
    // The chain snapshot is what turns the ledger into the registry: a later
    // run with no built-in project table can rebuild this target from here.
    chain: {
      id: planned.chain,
      label: planned.chainLabel,
      targetBranch: planned.targetBranch,
      provider: planned.provider,
      application,
      spugApp: planned.chainConfig.spugApp ?? '',
      spugEnv: planned.provider === 'spug' ? planned.environment : '',
      qqcProject: planned.chainConfig.qqcProject ?? '',
      qqcEnvironment: planned.provider === 'qqc' ? planned.environment : '',
    },
    merge: {
      target: planned.targetBranch,
      result: result.merge ? (result.merge.state === 'merged' ? 'success' : 'no-op') : 'skipped',
    },
    release: {
      provider: planned.provider,
      application,
      environment: planned.environment,
      result: result.status === 'success' ? 'success' : result.status,
    },
    source: input.chain || input.project ? 'explicit' : 'branch_detected',
    result: result.status,
    code: result.code,
    commit_id: result.commitId ?? null,
    mr: result.merge?.mrIid ?? null,
    spug_request_id: result.release?.requestId ?? null,
    skip_merge: Boolean(input.skipMerge),
    ...(result.message ? { note: result.message } : {}),
  };
}

/**
 * Resolve the environment name for a chain, preferring an explicit override.
 * @param {object} options - inputs.
 * @param {object} options.config - plugin config.
 * @param {object} options.chain - resolved chain.
 * @param {string} [options.env] - explicit override.
 * @returns {string} environment name.
 */
function resolveEnvironment({ config, chain, env }) {
  if (env) return String(env);
  if (chain.provider === 'spug') return String(chain.spugEnv ?? 'test');
  return String(chain.qqcEnvironment ?? 'test');
}

/**
 * Whether an environment counts as production.
 * @param {string} environment - environment name or key.
 * @returns {boolean} true when a confirmation is required.
 */
function isProduction(environment) {
  const needle = String(environment).toLowerCase();
  return PRODUCTION_ENV_HINTS.some((hint) => needle.includes(hint));
}

/**
 * Human description of what a run will do, shown in the plan card.
 * @param {object} options - inputs.
 * @returns {string[]} action lines.
 */
function describeActions({ chain, skipMerge }) {
  const actions = [];
  if (!skipMerge) actions.push(`合并源分支 → ${chain.targetBranch}（有冲突就停）`);
  else actions.push(`不合并，直接发布 ${chain.targetBranch} 当前代码`);
  if (chain.provider === 'spug') {
    actions.push(`Spug 应用 ${chain.spugApp}，环境 ${chain.spugEnv}，触发并等待完成`);
  } else {
    actions.push(`触发小程序构建 ${chain.qqcProject}，以构建日志里的 commit 为准`);
  }
  return actions;
}

/**
 * Resolve the release target, falling back to an explicit definition.
 *
 * The registry is only built from config plus past releases, so the very first
 * release of a project has nothing to match against. When the caller spells out
 * the target branch and provider, that definition stands for this run and is
 * written to the ledger, which makes it available next time.
 * @param {object} options - inputs.
 * @param {Record<string, object>} options.projects - registry.
 * @param {object} options.input - release request.
 * @returns {object} resolved target.
 */
function resolveTarget({ projects, input }) {
  try {
    return resolveChain({
      projects,
      chain: input.chain,
      project: input.project,
      branch: input.branch,
    });
  } catch (error) {
    if (!(error instanceof ChainResolutionError)) throw error;
    if (!input.targetBranch || !input.provider) throw error;
    return defineChain({
      project: input.project,
      targetBranch: input.targetBranch,
      provider: input.provider,
      app: input.app,
      env: input.env,
      chain: input.chain,
    });
  }
}

/**
 * Effective project registry from the live config plus the release ledger.
 * @param {object} config - plugin config.
 * @param {object} [memory] - release ledger, read for learned chains.
 * @returns {Promise<Record<string, object>>} registry.
 */
export async function resolveProjectsSafe(config, memory) {
  let records = [];
  try {
    records = (await memory?.readAll?.()) ?? [];
  } catch {
    records = [];
  }
  try {
    return resolveProjects(config, records);
  } catch {
    return {};
  }
}

/**
 * First 7 characters of a commit id.
 * @param {string} [id] - commit id.
 * @returns {string} short id, or `unknown`.
 */
function short(id) {
  return id ? String(id).slice(0, 7) : 'unknown';
}

/**
 * Tail of a long log.
 * @param {string} text - log text.
 * @param {number} max - maximum characters.
 * @returns {string} tail.
 */
function tail(text, max) {
  const value = String(text ?? '');
  return value.length <= max ? value : value.slice(-max);
}

export { listChains };
