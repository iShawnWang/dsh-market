/**
 * Release memory: an append-only JSONL ledger of what was released, when, with
 * which commit, and how it ended.
 *
 * Two rules:
 *  - the ledger is history, not policy; it is only ever appended to, and failed
 *    or blocked attempts are recorded too. Nothing is rewritten or pruned.
 *  - it starts empty and only ever grows from releases this plugin ran itself.
 *    Nothing is imported from other tools, so a record here always means the
 *    plugin saw that release happen.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Default ledger location. */
export const DEFAULT_MEMORY_FILE = join(homedir(), '.dsh', 'yq-release', 'releases.jsonl');

/**
 * Expand a leading `~` and resolve the ledger path.
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
 * Append-only release ledger.
 */
export class ReleaseMemory {
  /**
   * @param {object} options - ledger options.
   * @param {string} options.file - ledger path.
   * @param {() => number} [options.now] - clock, injectable for tests.
   */
  constructor({ file, now = Date.now }) {
    this.file = file;
    this.now = now;
  }

  /**
   * Load every record, oldest first. Unparseable lines are skipped rather than
   * throwing: a hand-edited ledger must not take the whole panel down.
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
        // Ignore a damaged line; the rest of the ledger is still usable.
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
