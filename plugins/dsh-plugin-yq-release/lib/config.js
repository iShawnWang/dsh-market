import z from '@deepseek-ai/schemastery';

const projectChainSchema = z.object({
  label: z.string().default(''),
  detect: z.string().default(''),
  explicitOnly: z.boolean().default(false),
  targetBranch: z.string().default('test'),
  provider: z.string().default('spug'),
  spugApp: z.string().default(''),
  spugEnv: z.string().default('test'),
  qqcProject: z.string().default(''),
  qqcEnvironment: z.string().default('test'),
});

const projectSchema = z.object({
  label: z.string().default(''),
  gitlabProject: z.string().default(''),
  gitlabProjectId: z.number().default(0),
  chains: z.dict(projectChainSchema).default({}),
});

export const Config = z.object({
  // Connection endpoints. Every one of them defaults to empty on purpose: the
  // plugin ships no address of its own, so it can only ever talk to an instance
  // the user typed in themselves. Empty is reported as "not configured" before
  // any network call, never silently replaced by a hard-coded host.
  gitlabEndpoint: z.string().default('').volatile(),
  spugBaseUrl: z.string().default('').volatile(),
  qqcBaseUrl: z.string().default('').volatile(),
  memoryFile: z.string().default(''),
  spugPollSeconds: z.number().default(5),
  spugTimeoutSeconds: z.number().default(900),
  qqcPollSeconds: z.number().default(10),
  qqcTimeoutSeconds: z.number().default(1800),
  qqcProbeAttempts: z.number().default(3),
  projects: z.dict(projectSchema).default({}),
});

/**
 * Effective project registry. The plugin ships no project of its own: entries
 * come from `config.projects`, plus every chain a previous release left in the
 * build memory. A fresh install therefore releases nothing until either the registry
 * is configured or one release has been run explicitly.
 * @param {object} config - resolved plugin config.
 * @param {Array<object>} [records] - build memory, newest last.
 * @returns {Record<string, object>} effective project registry.
 */
export function resolveProjects(config, records = []) {
  const merged = {};
  for (const [id, project] of Object.entries(config?.projects ?? {})) {
    const chains = {};
    for (const [chainId, chain] of Object.entries(project?.chains ?? {})) {
      chains[chainId] = stripDefaults(chain);
    }
    merged[id] = {
      label: project?.label || id,
      gitlabProject: project?.gitlabProject || id,
      gitlabProjectId: project?.gitlabProjectId || 0,
      chains,
    };
  }
  for (const learned of learnedChains(records)) {
    const project = merged[learned.projectId] ?? {
      label: learned.projectId,
      gitlabProject: learned.projectId,
      gitlabProjectId: 0,
      chains: {},
    };
    // Config wins: a chain the user wrote down is never overwritten by one the
    // build memory inferred, so an explicit definition always stays authoritative.
    if (project.chains[learned.chainId]) continue;
    project.chains = { ...project.chains, [learned.chainId]: learned.chain };
    merged[learned.projectId] = project;
  }
  return merged;
}

/**
 * Whether a candidate record outranks the current pick for the same chain.
 * A successful run beats any failed one; otherwise the newer record wins, and an
 * equal timestamp lets the later line win, matching `ReleaseMemory#latestByChain`.
 * @param {{succeeded: boolean, at: string}} candidate - record under consideration.
 * @param {{succeeded: boolean, at: string}} current - record picked so far.
 * @returns {boolean} true when the candidate should replace the current pick.
 */
function outranks(candidate, current) {
  if (candidate.succeeded !== current.succeeded) return candidate.succeeded;
  return candidate.at >= current.at;
}

/**
 * Rebuild chains from what previous releases actually did. A learned chain is
 * `explicitOnly`: it is never inferred from a branch name, because the build memory
 * records what was released, not which branch prefixes should select it. Name
 * the project or the chain and it resolves.
 *
 * One chain per project and chain id, taken from the newest run that succeeded:
 * a failed attempt may well have been aimed at a target branch that does not
 * exist (the wrongly typed value is usually the first one), so only a success
 * proves the learned target is real. A chain that never succeeded keeps its
 * newest record instead of disappearing, so naming it still works.
 * @param {Array<object>} [records] - build memory.
 * @returns {Array<{projectId: string, chainId: string, chain: object}>} learned chains.
 */
export function learnedChains(records = []) {
  const best = new Map();
  for (const record of records ?? []) {
    const projectId = record?.project;
    if (!projectId) continue;
    const snapshot = record.chain;
    const provider = snapshot?.provider ?? record?.release?.provider;
    const application = snapshot?.application ?? record?.release?.application;
    const chainId = snapshot?.id ?? (application ? `${provider}-${application}` : '');
    if (!provider || !chainId) continue;
    const key = `${projectId}/${chainId}`;
    const candidate = {
      projectId,
      chainId,
      provider,
      application,
      snapshot,
      record,
      succeeded: record?.result === 'success',
      at: String(record?.timestamp ?? ''),
    };
    const current = best.get(key);
    if (!current || outranks(candidate, current)) best.set(key, candidate);
  }

  const out = [];
  for (const { projectId, chainId, provider, application, snapshot, record } of best.values()) {
    const spugApp = snapshot?.spugApp ?? (provider === 'spug' ? application : '');
    const qqcProject = snapshot?.qqcProject ?? (provider === 'qqc' ? application : '');
    out.push({
      projectId,
      chainId,
      chain: stripDefaults({
        label: snapshot?.label ?? `${application ?? chainId}`,
        // Learned chains stay explicit: no branch-name inference.
        explicitOnly: true,
        targetBranch: snapshot?.targetBranch ?? record?.merge?.target ?? '',
        provider,
        spugApp,
        spugEnv: snapshot?.spugEnv ?? record?.release?.environment ?? '',
        qqcProject,
        qqcEnvironment: snapshot?.qqcEnvironment ?? record?.release?.environment ?? '',
      }),
    });
  }
  return out;
}

/**
 * Unwrap the live references the Loader hands over for `.volatile()` fields.
 * Volatile fields arrive as `{ get() }` references that change in place, so this
 * runs on every read instead of being cached at `apply` time.
 * @param {object} config - resolved plugin config, possibly containing references.
 * @returns {object} plain values.
 */
export function readConfig(config) {
  if (config === null || typeof config !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = value !== null && typeof value === 'object' && typeof value.get === 'function'
      ? value.get()
      : value;
  }
  return out;
}

/**
 * The Spug base URL the client dials. One setting, no split host/port form.
 * @param {object} config - plugin config, already unwrapped by {@link readConfig}.
 * @returns {string} base URL, or an empty string when unset.
 */
export function resolveSpugBaseUrl(config) {
  return String(config?.spugBaseUrl ?? '').trim();
}

/**
 * Report which connection endpoints still need the user to fill them in.
 * @param {object} config - plugin config, already unwrapped by {@link readConfig}.
 * @returns {string[]} names of the missing settings, empty when all are set.
 */
export function missingEndpoints(config) {
  const missing = [];
  if (!String(config?.gitlabEndpoint ?? '').trim()) missing.push('gitlabEndpoint');
  if (!resolveSpugBaseUrl(config)) missing.push('spugBaseUrl');
  if (!String(config?.qqcBaseUrl ?? '').trim()) missing.push('qqcBaseUrl');
  return missing;
}

/** Drop empty defaults so an override never erases a built-in field. */
function stripDefaults(chain) {
  const out = {};
  for (const [key, value] of Object.entries(chain ?? {})) {
    if (value === '' || value === undefined || value === null) continue;
    if (key === 'explicitOnly' && value === false) continue;
    out[key] = value;
  }
  return out;
}
