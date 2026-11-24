/**
 * Release memory: an append-only JSONL build-memory file of what was released, when, with
 * which commit, and how it ended.
 *
 * Two rules:
 *  - the build memory is history, not policy; it is only ever appended to, and failed
 *    or blocked attempts are recorded too. Nothing is rewritten or pruned.
 *  - it starts empty and only ever grows from releases this plugin ran itself.
 *    Nothing is imported from other tools, so a record here always means the
 *    plugin saw that release happen.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Default build-memory location. */
export const DEFAULT_MEMORY_FILE = join(homedir(), '.dsh', 'yq-release', 'releases.jsonl');

/**
 * Expand a leading `~` and resolve the build-memory path.
 * @param {string} [configured] - configured path, possibly empty.
 * @returns {string} absolute path.
 */
export function resolveMemoryFile(configured) {
  const raw = String(configured ?? '').trim();
  if (!raw) return DEFAULT_MEMORY_FILE;
  if (raw === '~') return homedir();
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2));
  return raw;
}

/**
 * Append-only release build memory.
 */
export class ReleaseMemory {
  /**
   * @param {object} options - build-memory options.
   * @param {string} options.file - build-memory path.
   * @param {() => number} [options.now] - clock, injectable for tests.
   */
  constructor({ file, now = Date.now }) {
    this.file = file;
    this.now = now;
  }

  /**
   * Load every record, oldest first. Unparseable lines are skipped rather than
   * throwing: a hand-edited build memory must not take the whole panel down.
   * @returns {Promise<Array<object>>} records.
   */
  async readAll() {
    const text = await readFile(this.file, 'utf8').catch(() => '');
    const records = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        // Ignore a damaged line; the rest of the build memory is still usable.
      }
    }
    return records;
  }

  /**
   * The most recent records first.
   * @param {number} [limit] - how many records.
   * @returns {Promise<Array<object>>} records, newest first.
   */
  async recent(limit = 10) {
    const all = await this.readAll();
    return all.slice(-Math.max(1, limit)).reverse();
  }

  /**
   * Records whose project or branch matches, newest first.
   * @param {object} query - filter.
   * @param {string} [query.project] - project id.
   * @param {string} [query.branch] - source branch.
   * @param {number} [query.limit] - how many records.
   * @returns {Promise<Array<object>>} matching records.
   */
  async search({ project, branch, limit = 10 }) {
    const all = await this.readAll();
    const needleProject = project?.toLowerCase();
    const needleBranch = branch?.toLowerCase();
    const filtered = all.filter((record) => {
      if (needleProject && String(record.project ?? '').toLowerCase() !== needleProject) return false;
      if (needleBranch && String(record.source_branch ?? '').toLowerCase() !== needleBranch) {
        return false;
      }
      return true;
    });
    return filtered.slice(-Math.max(1, limit)).reverse();
  }

  /**
   * The newest record for each chain, keyed `projectId/chainId`.
   *
   * A chain row in the panel answers "what does this target look like right
   * now", which the build memory already knows: the last attempt on it. Records are
   * scanned in file order and compared by timestamp, so a hand-appended line
   * out of order still loses to a genuinely later one.
   * @param {Array<object>} [records] - already-read build memory, to avoid a second read.
   * @returns {Promise<Map<string, object>>} newest record per chain.
   */
  async latestByChain(records) {
    const all = records ?? (await this.readAll());
    const out = new Map();
    for (const record of all) {
      const projectId = record?.project;
      const chainId = record?.chain?.id;
      if (!projectId || !chainId) continue;
      const key = `${projectId}/${chainId}`;
      const seen = out.get(key);
      if (!seen || String(record.timestamp ?? '') >= String(seen.timestamp ?? '')) {
        out.set(key, record);
      }
    }
    return out;
  }

  /**
   * Append one record. Never throws into the release path: a failed bookkeeping
   * write must not turn a successful release into an error the user sees.
   * @param {object} record - fields to append.
   * @returns {Promise<{ok: boolean, error?: string}>} write outcome.
   */
  async append(record) {
    const entry = { timestamp: new Date(this.now()).toISOString(), ...record };
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await appendFile(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }
}
