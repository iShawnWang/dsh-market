/**
 * Chain resolution: turn a free-form request ("把 feat/h5-活动弹屏 发到测试") into
 * one release plan entry. Detection is deliberately conservative — a branch
 * name never implies a chain that is not matchable, and explicit-only chains
 * (老虎机 / 车辆交易市场) are never inferred from a branch name.
 */

export class ChainResolutionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ChainResolutionError';
    this.details = details;
  }
}

/**
 * Match a branch name against one detect marker. A marker matches when it
 * appears as a path segment infix or right after a namespace slash, so both
 * `feat/h5-活动弹屏` and `fix/mp-xxx` match, while `test/h5x` does not.
 * @param {string} branch - branch name.
 * @param {string} detect - marker such as `h5-` or `mp-`.
 * @returns {boolean} whether the marker matches.
 */
export function matchesDetect(branch, detect) {
  if (!branch || !detect) return false;
  const segments = String(branch).split('/');
  return segments.some((segment) => segment.includes(detect));
}

/**
 * All chains whose detect marker matches the branch name.
 * @param {Record<string, object>} projects - effective registry.
 * @param {string} branch - source branch name.
 * @returns {Array<{projectId: string, chainId: string, project: object, chain: object}>} matches.
 */
export function detectChains(projects, branch) {
  const matches = [];
  for (const [projectId, project] of Object.entries(projects)) {
    for (const [chainId, chain] of Object.entries(project.chains ?? {})) {
      if (chain.explicitOnly) continue;
      if (matchesDetect(branch, chain.detect)) matches.push({ projectId, chainId, project, chain });
    }
  }
  return matches;
}

/**
 * Build a chain from what the caller spelled out, for the first release of a
 * project the registry has never seen. Nothing is inferred: target branch and
 * provider both have to be given.
 * @param {object} options - explicit definition.
 * @param {string} [options.project] - project id.
 * @param {string} [options.targetBranch] - branch to merge into and deploy.
 * @param {string} [options.provider] - `spug` or `qqc`.
 * @param {string} [options.app] - Spug app key or build-box project id.
 * @param {string} [options.env] - environment name.
 * @param {string} [options.chain] - chain id to record it under.
 * @returns {{projectId: string, chainId: string, project: object, chain: object, reason: string}} target.
 */
export function defineChain({ project, targetBranch, provider, app, env, chain }) {
  const projectId = String(project ?? '').trim();
  const target = String(targetBranch ?? '').trim();
  const kind = String(provider ?? '').trim();
  if (!projectId || !target || !kind) {
    throw new ChainResolutionError(
      '还没有这个项目的发布链路：第一次发布请同时给出 project、targetBranch 和 provider（spug 或 qqc），' +
        '这次跑完它会记进发布记录，之后就不用再写了',
      { available: [] },
    );
  }
  if (kind !== 'spug' && kind !== 'qqc') {
    throw new ChainResolutionError(`未知的发布方式 \`${kind}\`：只支持 spug 或 qqc`, { available: [] });
  }
  const environment = String(env ?? 'test');
  const application = String(app ?? '').trim();
  if (!application) {
    throw new ChainResolutionError(
      kind === 'spug'
        ? `发布到 Spug 还要给出 Spug 应用名，例如 new_h5：插件不猜应用 id`
        : `发布到小程序构建机还要给出构建项目 id，例如 YQ-QQC：插件不猜构建项目`,
      { available: [] },
    );
  }
  const chainId = String(chain ?? '').trim() || `${kind}-${application || target}`;
  return {
    projectId,
    chainId,
    project: { id: projectId, label: projectId, gitlabProject: projectId, gitlabProjectId: 0, chains: {} },
    chain: {
      label: application || chainId,
      explicitOnly: true,
      targetBranch: target,
      provider: kind,
      spugApp: kind === 'spug' ? application : '',
      spugEnv: kind === 'spug' ? environment : '',
      qqcProject: kind === 'qqc' ? application : '',
      qqcEnvironment: kind === 'qqc' ? environment : '',
    },
    reason: 'explicit-definition',
  };
}

/**
 * Pick the chain for one request.
 *
 * Precedence: explicit chain/project from the caller, then branch-name
 * detection. An explicit chain always wins, which is what makes explicit-only
 * chains reachable. Ambiguous detection (two non-explicit chains match) is an
 * error rather than a guess.
 * @param {object} options - resolution inputs.
 * @param {Record<string, object>} options.projects - effective registry.
 * @param {string} [options.chain] - explicit chain id.
 * @param {string} [options.project] - explicit project id or label.
 * @param {string} [options.branch] - source branch name.
 * @returns {{projectId: string, chainId: string, project: object, chain: object, reason: string}} the plan target.
 */
export function resolveChain({ projects, chain, project, branch }) {
  if (chain) {
    const found = findChainById(projects, chain, project);
    if (!found) {
      throw new ChainResolutionError(`未知链路 \`${chain}\``, {
        available: listChains(projects),
      });
    }
    return { ...found, reason: 'explicit-chain' };
  }

  if (project) {
    const entries = findProject(projects, project);
    if (!entries) {
      // The caller may have named a chain id where a project was expected
      // (`car`, `tiger`). Accept it when that chain id is unambiguous.
      const asChain = findChainById(projects, project);
      if (asChain) return { ...asChain, reason: 'explicit-chain' };
      throw new ChainResolutionError(`未知项目 \`${project}\``, {
        available: Object.keys(projects),
      });
    }
    // Naming the project is itself explicit, so a project with a single chain
    // resolves even when that chain is `explicitOnly` — 老虎机 and 车辆交易市场
    // each have exactly one. `explicitOnly` only bars branch-name inference.
    const all = Object.entries(entries.chains ?? {});
    if (all.length === 1) {
      const [chainId, c] = all[0];
      return { projectId: entries.id, chainId, project: entries, chain: c, reason: 'explicit-project' };
    }
    const nonExplicit = all.filter(([, c]) => !c.explicitOnly);
    if (branch) {
      const byBranch = nonExplicit.filter(([, c]) => matchesDetect(branch, c.detect));
      if (byBranch.length === 1) {
        const [chainId, c] = byBranch[0];
        return { projectId: entries.id, chainId, project: entries, chain: c, reason: 'project+branch' };
      }
    }
    throw new ChainResolutionError(
      `项目 \`${entries.label || entries.id}\` 有多条链路（${nonExplicit.map(([id]) => id).join('、')}），请指明其中一条`,
      { available: nonExplicit.map(([id, c]) => ({ id, label: c.label })) },
    );
  }

  if (!branch) {
    throw new ChainResolutionError('需要源分支名或显式链路才能确定发布目标', {
      available: listChains(projects),
    });
  }

  const matches = detectChains(projects, branch);
  if (matches.length === 1) {
    return { ...matches[0], reason: 'branch-detect' };
  }
  if (matches.length === 0) {
    const known = listChains(projects);
    // Nothing is detectable on a fresh install: the registry grows from config
    // and from past releases, so say how to start rather than which marker to
    // look for in a name.
    if (known.length === 0) {
      throw new ChainResolutionError(
        `分支 \`${branch}\` 认不出链路，而且现在还没有任何发布记录：` +
          '第一次发布请同时给出 project、targetBranch、provider 和 app，跑完就记住了',
        { available: [] },
      );
    }
    if (describeDetectable(projects) === '（无）') {
      throw new ChainResolutionError(
        `分支 \`${branch}\` 认不出链路：现有的链路都只能点名，不会从分支名推断。` +
          `点名其中一条：${known.map((c) => c.id).join('、')}`,
        { available: known },
      );
    }
    throw new ChainResolutionError(
      `分支 \`${branch}\` 认不出链路：分支名需要包含 ${describeDetectable(projects)} 之一，或显式指定链路`,
      { available: known },
    );
  }
  throw new ChainResolutionError(
    `分支 \`${branch}\` 同时匹配多条链路：${matches.map((m) => `${m.projectId}/${m.chainId}`).join('、')}，请用 chain 参数指明`,
    { available: matches.map((m) => ({ id: `${m.projectId}/${m.chainId}`, label: m.chain.label })) },
  );
}

/**
 * Look one chain up by `chainId` or `projectId/chainId`.
 * @param {Record<string, object>} projects - effective registry.
 * @param {string} chain - chain selector.
 * @param {string} [project] - optional project qualifier.
 * @returns {{projectId: string, chainId: string, project: object, chain: object}|undefined} match.
 */
function findChainById(projects, chain, project) {
  const selector = String(chain);
  const qualified = selector.includes('/');
  const [head, tail] = qualified ? selector.split('/', 2) : [project, selector];

  const entries = findProject(projects, head);
  if (entries) {
    // `head` qualified a project, so the chain id is exactly `tail`. Without a
    // qualifier `head` is the project the caller named separately.
    const found = entries.chains?.[tail];
    if (found) return { projectId: entries.id, chainId: tail, project: entries, chain: found };
  }

  // A bare chain id is accepted when it is unambiguous across projects.
  if (!qualified) {
    const hits = [];
    for (const [projectId, p] of Object.entries(projects)) {
      for (const [chainId, c] of Object.entries(p.chains ?? {})) {
        if (chainId === selector) hits.push({ projectId, chainId, project: p, chain: c });
      }
    }
    if (hits.length === 1) return hits[0];
  }
  return undefined;
}

/**
 * Find a project by id or label (case-insensitive).
 * @param {Record<string, object>} projects - effective registry.
 * @param {string} selector - project id or label.
 * @returns {(object & {id: string})|undefined} project entry carrying its id.
 */
function findProject(projects, selector) {
  if (!selector) return undefined;
  const needle = String(selector).trim().toLowerCase();
  for (const [id, project] of Object.entries(projects)) {
    if (id.toLowerCase() === needle) return { ...project, id };
    if ((project.label ?? '').toLowerCase() === needle) return { ...project, id };
    if ((project.gitlabProject ?? '').toLowerCase() === needle) return { ...project, id };
  }
  return undefined;
}

/**
 * Flat list of every registered chain, for model-facing error messages.
 * @param {Record<string, object>} projects - effective registry.
 * @returns {Array<{id: string, label: string, targetBranch: string, provider: string}>} chains.
 */
export function listChains(projects) {
  const out = [];
  for (const [projectId, project] of Object.entries(projects)) {
    for (const [chainId, chain] of Object.entries(project.chains ?? {})) {
      out.push({
        id: `${projectId}/${chainId}`,
        label: `${project.label || projectId} · ${chain.label || chainId}`,
        targetBranch: chain.targetBranch,
        provider: chain.provider,
        explicitOnly: Boolean(chain.explicitOnly),
      });
    }
  }
  return out;
}

/** Human list of the detect markers, for "认不出链路" errors. */
function describeDetectable(projects) {
  const markers = [];
  for (const project of Object.values(projects)) {
    for (const chain of Object.values(project.chains ?? {})) {
      if (!chain.explicitOnly && chain.detect) markers.push(`\`${chain.detect}\``);
    }
  }
  return markers.join(' / ') || '（无）';
}
