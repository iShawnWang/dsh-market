/**
 * Host side of `dsh-plugin-yq-release`.
 *
 * Responsibilities:
 *  - own the release pipeline (`ReleaseService`) and hand the same instance to
 *    both callers: the agent tools and the browser panel;
 *  - expose three agent tools: run a release, preview a plan, read history;
 *  - serve a small authenticated bridge so the panel can read state and write
 *    credentials without a build step.
 *
 * Every registration happens inside `apply` and returns a disposer, so the
 * plugin unloads cleanly.
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { Config, missingEndpoints, readConfig } from './config.js';
import { listChains } from './chains.js';
import { ReleaseMemory, resolveMemoryFile } from './memory.js';
import { CREDENTIAL_REFS, ReleaseService, resolveProjectsSafe } from './release-service.js';

export { Config };

/** Bridge route prefix, deliberately distinct from the framework's `/api/*`. */
const BRIDGE_PREFIX = '/api/dsh-yq-release';

/** Largest JSON body the bridge accepts. */
const MAX_JSON_BODY_BYTES = 64 * 1024;

/**
 * Plugin entry point.
 * @param {object} ctx - plugin context.
 * @param {object} config - resolved plugin config.
 */
export function apply(ctx, config) {
  // A brand-new build memory, empty by design. This plugin has no history to inherit:
  // every record it shows was created by a release it ran itself.
  const memory = new ReleaseMemory({ file: resolveMemoryFile(config.memoryFile) });

  const service = new ReleaseService({
    getConfig: () => config,
    getCredentials: () => ctx.get('credentials'),
    memory,
  });

  registerTools(ctx, service, memory);
  registerBridge(ctx, service, memory, config);
}

/**
 * Register the agent tools.
 * @param {object} ctx - plugin context.
 * @param {ReleaseService} service - release pipeline.
 * @param {ReleaseMemory} memory - build memory.
 */
function registerTools(ctx, service, memory) {
  ctx.inject(['tools'], (sctx) => {
    const disposers = [];

    disposers.push(
      sctx.effect(
        () =>
          sctx.tools.register(
            defineTool({
              name: 'yq_release',
              description:
                '把一个分支发布到测试环境：按发布记录认出链路，必要时先合并到目标分支，' +
                '然后触发 Spug 发布或小程序构建并等到结束。' +
                '没有记录的项目第一次发布要同时给出 targetBranch 和 provider，这次跑完就记住了。' +
                '源分支与目标分支有冲突时立即停止：不自动解决冲突，也不部署。' +
                '目标为线上环境时需要 confirmProd=true 再调一次。' +
                '不需要事前确认，直接执行并返回结果。',
              parameters: {
                branch: {
                  type: 'string',
                  description:
                    '源分支名，例如 feat/h5-活动弹屏 或 fix/mp-活动弹屏。' +
                    '分支名里的 h5- / mp- 决定链路；不传则必须传 chain 或 project。' +
                    '传 skipMerge=true 表示只发布目标分支当前代码。',
                },
                chain: {
                  type: 'string',
                  description:
                    '显式链路，格式 chainId 或 projectId/chainId。' +
                    '从记录里学到的链路不会被分支名选中，只能这样点名。',
                },
                project: {
                  type: 'string',
                  description: '显式项目 id 或名称，例如 yeqiao-mobile。',
                },
                targetBranch: {
                  type: 'string',
                  description:
                    '目标分支，只在这次是全新项目（没有任何发布记录）时给，' +
                    '和 provider 一起构成这次的链路定义，跑完记进发布记录。',
                },
                provider: {
                  type: 'string',
                  description: '发布方式：spug（前端）或 qqc（小程序构建机）。全新项目才需要。',
                },
                app: {
                  type: 'string',
                  description:
                    'Spug 应用名或构建机项目 id，例如 new_h5、YQ-QQC。' +
                    '全新项目第一次发布必须给：插件不猜应用 id。',
                },
                skipMerge: {
                  type: 'boolean',
                  description: 'true 表示不合并，直接发布目标分支当前代码。默认 false。',
                },
                confirmProd: {
                  type: 'boolean',
                  description: '发布线上环境时必须显式传 true，其它环境不需要。',
                },
                env: {
                  type: 'string',
                  description: '覆盖目标环境，例如 prod。默认用链路里配置的环境。',
                },
              },
              output: {
                schema: releaseResultSchema(),
                render: (args, value) => [{ type: 'text', text: renderReleaseResult(value) }],
              },
              async execute(args) {
                return service.run({
                  branch: args.branch,
                  chain: args.chain,
                  project: args.project,
                  targetBranch: args.targetBranch,
                  provider: args.provider,
                  app: args.app,
                  skipMerge: args.skipMerge === true,
                  confirmProd: args.confirmProd === true,
                  env: args.env,
                });
              },
            }),
            { id: 'yq-release:run' },
          ),
        'yq-release: tool yq_release',
      ),
    );

    disposers.push(
      sctx.effect(
        () =>
          sctx.tools.register(
            defineTool({
              name: 'yq_release_plan',
              description:
                '查看一条发布请求会做什么，没有任何副作用：不合并、不触发、不写记录。' +
                '想先确认链路和环境时用它。',
              parameters: {
                branch: { type: 'string', description: '源分支名。' },
                chain: { type: 'string', description: '显式链路 id。' },
                project: { type: 'string', description: '显式项目 id 或名称。' },
                targetBranch: { type: 'string', description: '全新项目的目标分支。' },
                provider: { type: 'string', description: '全新项目的发布方式：spug 或 qqc。' },
                app: { type: 'string', description: 'Spug 应用 key 或构建机项目 id。' },
                skipMerge: { type: 'boolean', description: '是否跳过合并。默认 false。' },
                env: { type: 'string', description: '覆盖目标环境。' },
              },
              output: {
                schema: planSchema(),
                render: (args, value) => [{ type: 'text', text: renderPlan(value) }],
              },
              async execute(args) {
                return service.plan({
                  branch: args.branch,
                  chain: args.chain,
                  project: args.project,
                  targetBranch: args.targetBranch,
                  provider: args.provider,
                  app: args.app,
                  skipMerge: args.skipMerge === true,
                  env: args.env,
                });
              },
            }),
            { id: 'yq-release:plan' },
          ),
        'yq-release: tool yq_release_plan',
      ),
    );

    disposers.push(
      sctx.effect(
        () =>
          sctx.tools.register(
            defineTool({
              name: 'yq_release_history',
              description:
                '读取历史发布记录，最新在前。可按项目或源分支过滤。' +
                '记录是历史事实，不是规则：用它提示「这条分支上次发到哪」，不要替用户决定这次发哪。',
              parameters: {
                project: { type: 'string', description: '按项目 id 过滤。' },
                branch: { type: 'string', description: '按源分支名过滤。' },
                limit: { type: 'integer', description: '返回条数，默认 10，最大 50。' },
              },
              output: {
                schema: historySchema(),
                render: (args, value) => [{ type: 'text', text: renderHistory(value) }],
              },
              async execute(args) {
                const limit = clampNumber(args.limit, 10, 1, 50);
                const records = await memory.search({
                  project: args.project,
                  branch: args.branch,
                  limit,
                });
                return { records, file: memory.file };
              },
            }),
            { id: 'yq-release:history' },
          ),
        'yq-release: tool yq_release_history',
      ),
    );

    return () => {
      for (const dispose of disposers) dispose();
    };
  });
}

/**
 * Register the panel bridge. Every route is POST, so a stray navigation cannot
 * read or write anything.
 * @param {object} ctx - plugin context.
 * @param {ReleaseService} service - release pipeline.
 * @param {ReleaseMemory} memory - build memory.
 * @param {object} config - plugin config.
 */
function registerBridge(ctx, service, memory, config) {
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => {
      const routes = [
        makeRoute(ctx, '/state', async () => {
          const live = readConfig(config);
          // The registry is config plus whatever past releases taught it, so it
          // has to be read from the build memory rather than from a constant.
          const projects = await resolveProjectsSafe(live, memory);
          // A chain row answers "what does this target look like now", and the
          // build memory is the only place that knows: show each chain's last attempt
          // beside its configuration, not only in the history list below.
          const latest = await memory.latestByChain();
          return {
            chains: listChains(projects),
            projects: Object.entries(projects).map(([id, project]) => ({
              id,
              label: project.label ?? id,
              chains: Object.entries(project.chains ?? {}).map(([chainId, chain]) => {
                const last = latest.get(`${id}/${chainId}`);
                return {
                  id: chainId,
                  label: chain.label ?? chainId,
                  targetBranch: chain.targetBranch,
                  provider: chain.provider,
                  explicitOnly: Boolean(chain.explicitOnly),
                  last: last
                    ? {
                        timestamp: last.timestamp ?? null,
                        result: last.result ?? null,
                        code: last.code ?? null,
                        sourceBranch: last.source_branch ?? null,
                        commit: last.commit_id ? String(last.commit_id).slice(0, 7) : null,
                      }
                    : null,
                };
              }),
            })),
            credentials: await describeCredentials(ctx),
            settings: describeSettings(live),
            memoryFile: memory.file,
          };
        }),
        makeRoute(ctx, '/history', async (body) => ({
          records: await memory.search({
            project: body.project,
            branch: body.branch,
            limit: clampNumber(body.limit, 20, 1, 100),
          }),
          file: memory.file,
        })),
        makeRoute(ctx, '/credentials', async (body) => setCredential(ctx, body)),
        makeRoute(ctx, '/settings', async (body) => setSettings(ctx, body)),
        makeRoute(ctx, '/plan', async (body) =>
          service.plan({
            branch: body.branch,
            chain: body.chain,
            project: body.project,
            skipMerge: body.skipMerge === true,
            env: body.env,
          }),
        ),
      ];
      const disposers = routes.map((route) => registerRoute(sctx, route));
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'yq-release: panel bridge');
  });
}

/**
 * Credential state, without the secrets.
 * @param {object} ctx - plugin context.
 * @returns {Record<string, {configured: boolean, source?: string}>} per-ref state.
 */
async function describeCredentials(ctx) {
  const credentials = ctx.get('credentials');
  const out = {};
  for (const ref of Object.values(CREDENTIAL_REFS)) {
    let described;
    try {
      // Async seam: see resolveSecret. Awaiting is what makes `configured`
      // report a stored secret; reading the promise always reports false.
      described = await credentials?.describe?.(ref);
    } catch {
      described = undefined;
    }
    out[ref] = {
      configured: Boolean(described?.configured),
      source: described?.source,
      // `describe` returns a same-length preview of the stored secret, so its
      // length is the secret's length. Only the length crosses to the browser:
      // the preview itself contains a readable prefix and suffix, and the field
      // only needs to show how long the value is.
      maskLength: typeof described?.masked === 'string'
        ? Array.from(described.masked).length
        : null,
    };
  }
  return out;
}

/**
 * Connection settings the user must supply themselves. The plugin ships no
 * address of its own, so these start empty and stay empty until typed in.
 */
const SETTING_FIELDS = ['gitlabEndpoint', 'spugBaseUrl', 'qqcBaseUrl'];

/**
 * Current connection settings, plus what is still missing.
 * @param {object} live - unwrapped plugin config.
 * @returns {object} settings view for the panel.
 */
function describeSettings(live) {
  const values = {};
  for (const field of SETTING_FIELDS) values[field] = String(live?.[field] ?? '');
  return {
    values,
    missing: missingEndpoints(live),
  };
}

/**
 * Persist one connection setting.
 *
 * These fields are declared `.volatile()`, so the settings service can commit
 * the change into the running plugin in place — no restart, no hand-editing the
 * profile patch file.
 * @param {object} ctx - plugin context.
 * @param {object} body - `{field, value}`.
 * @returns {Promise<{ok: boolean, message?: string}>} outcome.
 */
async function setSettings(ctx, body) {
  const field = String(body?.field ?? '');
  if (!SETTING_FIELDS.includes(field)) {
    return { ok: false, message: `不支持的配置项 ${field}` };
  }
  const value = String(body?.value ?? '').trim();
  const entry = ctx.fiber?.entry;
  // The settings service addresses entries by the id written in the profile
  // patch, which is `entry.options.id`. `entry.id` is the loader's *tree path*
  // (`include:yq-release`), so passing it would never match an entry.
  const entryId = entry?.options?.id;
  const settings = ctx.get('settings');
  if (settings?.mutate && entryId) {
    try {
      await settings.mutate(entryId, [{ op: 'set', path: [field], value }]);
      return { ok: true };
    } catch (error) {
      const message = String(error?.message ?? error);
      // A profile that cannot resolve the settings form (nested Includes, an
      // older host) still accepts the write through the config editor, which
      // takes the entry object instead of an id.
      if (!/configurable plugin entry|not volatile|no volatile fields/i.test(message)) {
        return { ok: false, message };
      }
    }
  }
  const editor = ctx.get('configEditor');
  if (!editor?.edit || !entry) return { ok: false, message: '当前环境没有设置服务，无法保存' };
  try {
    await editor.edit(entry, (current) => ({ ...current, [field]: value }));
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error) };
  }
}

/**
 * Store one credential supplied from the panel.
 * @param {object} ctx - plugin context.
 * @param {object} body - `{ref, value}`.
 * @returns {Promise<{ok: boolean, message?: string}>} outcome.
 */
async function setCredential(ctx, body) {
  const ref = String(body?.ref ?? '');
  // Trim here as well as in the panel: a pasted token routinely carries a
  // trailing newline, and a stored one is indistinguishable from a wrong one
  // until GitLab answers 401.
  const value = String(body?.value ?? '').trim();
  if (!Object.values(CREDENTIAL_REFS).includes(ref)) {
    return { ok: false, message: `不支持的凭据项 ${ref}` };
  }
  if (!value) return { ok: false, message: '值不能为空' };
  const credentials = ctx.get('credentials');
  if (!credentials?.set) return { ok: false, message: '当前环境没有凭据服务，无法保存' };
  try {
    await credentials.set(ref, value);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error) };
  }
}

/**
 * Build one bridge route with the shared guard.
 * @param {object} ctx - plugin context (for the auth fence).
 * @param {string} path - suffix below {@link BRIDGE_PREFIX}.
 * @param {(body: object) => Promise<object>|object} handler - route body.
 * @returns {object} web server route.
 */
function makeRoute(ctx, path, handler) {
  return {
    kind: 'exact',
    path: `${BRIDGE_PREFIX}${path}`,
    handler: async (req, res) => {
      const connection = ctx.get('connection');
      const rejection = bridgeAuthRejection(req, connection);
      if (rejection !== undefined) {
        writeJson(res, rejection, { error: 'host authentication required' });
        return;
      }
      if (!isBridgeRequestAllowed(req)) {
        writeJson(res, 403, {
          error: 'requests must come from the local host or a configured trusted host',
        });
        return;
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { error: `method not allowed: ${req.method}` });
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
 * Register one route, tolerating a duplicate registration on reload.
 * @param {object} sctx - injected context.
 * @param {object} route - route definition.
 * @returns {() => void} disposer.
 */
function registerRoute(sctx, route) {
  try {
    return sctx.get('webServer').register(route);
  } catch (error) {
    const message = String(error?.message ?? '');
    if (error?.code === 'WEB_DUPLICATE_PROVIDER' || /already registered|duplicate/i.test(message)) {
      return () => {};
    }
    throw error;
  }
}

/**
 * Ask the connection service whether this request is authenticated. Fails
 * closed: without a decision from the service, the request is refused.
 * @param {object} request - node request.
 * @param {object} [connection] - connection service.
 * @returns {number|undefined} status to refuse with, or undefined to allow.
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
 * Local host fence: only the UI served by this host may call the bridge.
 * @param {object} request - node request.
 * @returns {boolean} whether the request is acceptable.
 */
function isBridgeRequestAllowed(request) {
  const host = request.headers?.host;
  if (typeof host !== 'string' || host.length === 0) return false;
  if (request.headers?.['sec-fetch-site'] === 'cross-site') return false;

  const origin = request.headers?.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false;
    }
    if (originHost !== host) return false;
  }

  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return isLoopbackAddress(request.socket?.remoteAddress);
  }
  return false;
}

/**
 * @param {string} [address] - socket peer address.
 * @returns {boolean} whether the peer is loopback.
 */
function isLoopbackAddress(address) {
  const value = String(address ?? '');
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
 * Read and parse a bounded JSON body.
 * @param {object} req - HTTP request.
 * @returns {Promise<object|undefined>} parsed body, or undefined when invalid.
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
 * Clamp a numeric input.
 * @param {unknown} value - candidate.
 * @param {number} fallback - default.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @returns {number} clamped number.
 */
function clampNumber(value, fallback, min, max) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}

/**
 * JSON schema for a run result. Every object node states `additionalProperties`
 * explicitly: the tool layer rejects implicit ones.
 * @returns {object} schema.
 */
function releaseResultSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: ['success', 'failed', 'blocked'] },
      code: { type: 'string' },
      message: { type: 'string' },
      details: { type: 'json' },
      plan: { type: 'json' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            step: { type: 'string' },
            status: { type: 'string' },
            detail: { type: 'string' },
            at: { type: 'string' },
          },
        },
      },
      merge: { type: 'json' },
      release: { type: 'json' },
      commitId: { type: 'json' },
      commitShort: { type: 'json' },
      durationMs: { type: 'number' },
      finishedAt: { type: 'string' },
      warning: { type: 'string' },
    },
  };
}

/**
 * JSON schema for {@link ReleaseService.plan}.
 * @returns {object} schema.
 */
function planSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      project: { type: 'string' },
      projectLabel: { type: 'string' },
      chain: { type: 'string' },
      chainLabel: { type: 'string' },
      chainConfig: { type: 'json' },
      reason: { type: 'string' },
      gitlabProject: { type: 'string' },
      targetProjectId: { type: 'json' },
      sourceBranch: { type: 'json' },
      targetBranch: { type: 'string' },
      provider: { type: 'string' },
      skipMerge: { type: 'boolean' },
      environment: { type: 'string' },
      requiresConfirmation: { type: 'boolean' },
      missingEndpoints: { type: 'array', items: { type: 'string' } },
      actions: { type: 'array', items: { type: 'string' } },
    },
  };
}

/**
 * JSON schema for the history tool.
 * @returns {object} schema.
 */
function historySchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      records: { type: 'array', items: { type: 'json' } },
      file: { type: 'string' },
    },
  };
}

/**
 * Render a release result for the conversation.
 * @param {object} value - result.
 * @returns {string} rendered text.
 */
function renderReleaseResult(value) {
  const badge =
    value.status === 'success'
      ? '✅ 发布成功'
      : value.status === 'blocked'
        ? '⏸ 已阻塞'
        : '❌ 发布失败';
  const lines = [`${badge}${value.message ? ` — ${value.message}` : ''}`];

  if (value.plan) {
    lines.push('');
    lines.push(`链路：${value.plan.projectLabel} · ${value.plan.chainLabel}（${value.plan.provider}）`);
    lines.push(`分支：${value.plan.sourceBranch ?? '（用目标分支当前代码）'} → ${value.plan.targetBranch}`);
    lines.push(`环境：${value.plan.environment}${value.plan.skipMerge ? ' · 跳过合并' : ''}`);
  }
  if (value.commitShort) lines.push(`提交：${value.commitShort}`);
  if (value.merge?.mrUrl) lines.push(`合并请求：${value.merge.mrUrl}`);
  if (value.release?.requestId) {
    lines.push(
      `Spug 请求：#${value.release.requestId}（${value.release.requestName ?? ''}）` +
        `${value.release.statusAlias ?? ''}`,
    );
  }
  if (value.release?.provider === 'qqc') {
    lines.push(
      `小程序构建：${value.release.application ?? ''}${value.release.success ? ' 成功' : ''}`,
    );
  }
  if (value.steps?.length) {
    lines.push('');
    lines.push('步骤：');
    for (const step of value.steps) {
      const mark =
        step.status === 'ok'
          ? '✓'
          : step.status === 'blocked'
            ? '⏸'
            : step.status === 'failed'
              ? '✗'
              : '·';
      lines.push(`  ${mark} ${step.step}${step.detail ? ` — ${step.detail}` : ''}`);
    }
  }
  if (value.details?.logTail) {
    lines.push('');
    lines.push('日志末尾：');
    lines.push('```');
    lines.push(String(value.details.logTail));
    lines.push('```');
  }
  return lines.join('\n');
}

/**
 * Render a plan for the conversation.
 * @param {object} value - plan.
 * @returns {string} rendered text.
 */
function renderPlan(value) {
  const actions = Array.isArray(value?.actions) ? value.actions : [];
  const missing = Array.isArray(value?.missingEndpoints) ? value.missingEndpoints : [];
  const lines = [
    `链路：${value.projectLabel} · ${value.chainLabel}（${value.provider}）`,
    `分支：${value.sourceBranch ?? '（用目标分支当前代码）'} → ${value.targetBranch}`,
    `环境：${value.environment}${value.requiresConfirmation ? '（线上，需要 confirmProd=true）' : ''}`,
  ];
  if (missing.length > 0) {
    lines.push(`⚠ 还缺连接地址：${missing.join(' / ')}（去面板「配置」展项里填）`);
  }
  if (value.reason === 'explicit-definition') {
    lines.push('· 这是新项目：这次给出的目标分支和发布方式会被记进发布记录，下次不用再写');
  }
  lines.push('', '将执行：', ...actions.map((action) => `  · ${action}`));
  return lines.join('\n');
}

/**
 * An ISO instant rendered as local wall-clock time.
 * The build memory stores UTC (`...Z`); slicing that string would print `07:26` for
 * a 15:26 release, so the instant is converted to the host's time zone first.
 * @param {string} [iso] - ISO 8601 timestamp.
 * @returns {string} `YYYY-MM-DD HH:MM:SS`, or '' when unusable.
 */
function formatTime(iso) {
  const date = new Date(String(iso ?? ''));
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * Render history for the conversation.
 * @param {object} value - history payload.
 * @returns {string} rendered text.
 */
function renderHistory(value) {
  if (!value.records?.length) return `没有历史记录（${value.file}）`;
  const lines = [`最近 ${value.records.length} 条发布记录：`];
  for (const record of value.records) {
    const when = formatTime(record.timestamp) || '时间未知';
    lines.push(
      `· ${when} ${record.project ?? '?'} ${record.source_branch ?? '?'} → ` +
        `${record.merge?.target ?? '?'} / ${record.release?.provider ?? '?'} ` +
        `${record.release?.application ?? ''} ${record.release?.environment ?? ''} ` +
        `[${record.result ?? '?'}] ${record.commit_id ? String(record.commit_id).slice(0, 7) : ''}`,
    );
  }
  return lines.join('\n');
}
