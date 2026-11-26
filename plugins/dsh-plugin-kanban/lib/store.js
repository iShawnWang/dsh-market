/**
 * Board storage: one JSON document, read and rewritten as a whole.
 *
 * The file is the source of truth and the panel never holds state the host
 * does not have. Every mutation goes read → change → atomic replace, so a
 * crash mid-write leaves the previous document intact rather than half a
 * board. Writes are serialized through a single promise chain, because two
 * concurrent read-modify-write cycles on the same file lose one of them.
 *
 * The shape is deliberately shallow: a list of projects, each owning its own
 * columns and cards. There is no cross-project table to join and no schema
 * version to migrate — a new field is just a new field, and a missing one
 * reads as its default.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

/** Default board file location. */
export const DEFAULT_DATA_FILE = join(homedir(), '.dsh', 'kanban', 'kanban.json');

/**
 * Columns a brand-new board starts with.
 *
 * `isFinal` marks the column where work ends: cards there render as done. It is
 * a per-column setting the user can move, not a property of a special column,
 * so no column is privileged over the others.
 */
const DEFAULT_COLUMNS = [
  { name: '待办', isFinal: false },
  { name: '进行中', isFinal: false },
  { name: '已完成', isFinal: true },
];

/** Priorities a card may carry; null means none. */
export const PRIORITIES = ['urgent', 'high', 'medium', 'low'];

/**
 * Accent colours a column may carry.
 *
 * The point of an accent is to make one column findable at a glance, so the set
 * stays small and each entry maps to a token the host already defines — a free
 * colour picker would let a board drift into unreadable combinations.
 */
export const COLUMN_ACCENTS = ['blue', 'violet', 'green', 'amber', 'red'];

/** Accent as stored: a known id, or null for "no accent". */
export function normalizeAccent(value) {
  return typeof value === 'string' && COLUMN_ACCENTS.includes(value) ? value : null;
}

/**
 * How many change-log entries one card keeps. A card edited a hundred times is
 * still one card; the log is there to answer "what happened", not to be an
 * audit trail, and an unbounded list would grow the whole board file with it.
 */
export const MAX_HISTORY = 200;

/**
 * Append one entry to a card's change log, capped at MAX_HISTORY.
 *
 * The log starts at creation: a card with no entries is a card from before this
 * existed, and `normalize` backfills a "created" entry for it so the drawer
 * never shows an empty history.
 *
 * @param {object} card - card to log against.
 * @param {number} at - epoch milliseconds.
 * @param {string} field - field name, or 'created'.
 * @param {unknown} [from] - previous value.
 * @param {unknown} [to] - next value.
 */
export function logChange(card, at, field, from, to) {
  if (!Array.isArray(card.history)) card.history = [];
  card.history.push({
    at,
    field,
    ...(field === 'created' ? {} : { from: from ?? null, to: to ?? null }),
  });
  if (card.history.length > MAX_HISTORY) {
    card.history = card.history.slice(card.history.length - MAX_HISTORY);
  }
}

/**
 * Log a field change only when the value actually changed. Saving a form that
 * was not edited is not an event, and a log full of no-ops is a log nobody
 * reads.
 *
 * @param {object} card - card to log against.
 * @param {number} at - epoch milliseconds.
 * @param {string} field - field name.
 * @param {unknown} next - value about to be stored.
 * @returns {boolean} whether it differed.
 */
export function logIfChanged(card, at, field, next) {
  const previous = card[field] ?? null;
  const value = next ?? null;
  if (previous === value) return false;
  logChange(card, at, field, previous, value);
  return true;
}

/**
 * Expand a leading `~` and resolve the board path.
 * @param {string} [configured] - configured path, possibly empty.
 * @returns {string} absolute path.
 */
export function resolveDataFile(configured) {
  const raw = String(configured ?? '').trim();
  if (!raw) return DEFAULT_DATA_FILE;
  if (raw === '~') return homedir();
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2));
  return raw;
}

/**
 * A fresh, valid document: one project with the three default columns.
 * @returns {object} document.
 */
export function emptyDocument() {
  const now = Date.now();
  const columns = DEFAULT_COLUMNS.map((column) => ({
    id: randomUUID(),
    name: column.name,
    isFinal: column.isFinal,
    accent: null,
  }));
  return {
    version: 1,
    projects: [
      {
        id: randomUUID(),
        name: '我的看板',
        columns,
        cards: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

/**
 * Coerce whatever was on disk into a document the panel can render.
 * A hand-edited or truncated file must not take the whole tab down.
 * @param {unknown} value - parsed JSON.
 * @returns {object} document.
 */
export function normalize(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.projects)) {
    return emptyDocument();
  }
  const projects = value.projects
    .filter((project) => project && typeof project === 'object')
    .map((project) => {
      const columns = Array.isArray(project.columns) && project.columns.length > 0
        ? project.columns
            .filter((column) => column && typeof column === 'object')
            .map((column) => ({
              id: String(column.id ?? randomUUID()),
              name: String(column.name ?? '未命名'),
              isFinal: column.isFinal === true,
              // An unknown accent reads as no accent: a colour the stylesheet
              // has no rule for would otherwise paint nothing and look broken.
              accent: normalizeAccent(column.accent),
            }))
        : [{ id: randomUUID(), name: '待办', isFinal: false, accent: null }];
      // A project with no columns cannot hold a card, so the repair above is
      // what lets a damaged document still open instead of showing an empty lane
      // area with nowhere to drop anything.
      const columnIds = new Set(columns.map((column) => column.id));
      const fallbackColumn = columns[0]?.id ?? null;
      const cards = Array.isArray(project.cards)
        ? project.cards
            .filter((card) => card && typeof card === 'object')
            .map((card) => {
              const createdAt = Number(card.createdAt ?? Date.now());
              const startDate = typeof card.startDate === 'string' ? card.startDate : null;
              const dueDate = typeof card.dueDate === 'string' ? card.dueDate : null;
              // Cards written before the change log existed get one entry
              // saying when they were made, so every drawer shows a history
              // that starts at creation instead of an empty box.
              const history = Array.isArray(card.history)
                ? card.history
                    .filter((entry) => entry && typeof entry === 'object')
                    .map((entry) => ({
                      at: Number(entry.at ?? createdAt),
                      field: String(entry.field ?? 'created'),
                      ...(entry.field === 'created'
                        ? {}
                        : { from: entry.from ?? null, to: entry.to ?? null }),
                    }))
                    .slice(-MAX_HISTORY)
                : [];
              if (history.length === 0) history.push({ at: createdAt, field: 'created' });
              return {
                id: String(card.id ?? randomUUID()),
                number: Number.isFinite(card.number) ? card.number : 1,
                title: String(card.title ?? ''),
                description: String(card.description ?? ''),
                // A card pointing at a deleted column lands in the first one
                // rather than vanishing from the board.
                columnId: columnIds.has(card.columnId) ? card.columnId : fallbackColumn,
                priority: PRIORITIES.includes(card.priority) ? card.priority : null,
                startDate,
                dueDate,
                createdAt,
                updatedAt: Number(card.updatedAt ?? Date.now()),
                history,
              };
            })
        : [];
      return {
        id: String(project.id ?? randomUUID()),
        name: String(project.name ?? '未命名'),
        columns,
        cards,
        createdAt: Number(project.createdAt ?? Date.now()),
        updatedAt: Number(project.updatedAt ?? Date.now()),
      };
    });
  if (projects.length === 0) return emptyDocument();
  return { version: 1, projects };
}

/** A board document that lives in one JSON file. */
export class BoardStore {
  /**
   * @param {object} options - store options.
   * @param {string} options.file - absolute board file path.
   * @param {() => number} [options.now] - clock, injectable for tests.
   */
  constructor({ file, now = Date.now }) {
    this.file = file;
    this.now = now;
    /** Serializes read-modify-write cycles; see the module comment. */
    this.queue = Promise.resolve();
  }

  /**
   * Read the document, establishing one on disk if there is none yet.
   *
   * Ids are generated per document, so a read that invented a board *without*
   * writing it would hand out ids that the next read no longer knows: every
   * mutation would land on "project not found". First read therefore persists
   * the board it created, and that document becomes the one everything shares.
   *
   * @returns {Promise<object>} document.
   */
  async read() {
    const text = await readFile(this.file, 'utf8').catch(() => '');
    if (text.trim()) {
      try {
        return normalize(JSON.parse(text));
      } catch {
        // A damaged file is moved aside rather than overwritten: whatever the
        // user had is still on disk under a dated name, and the board continues
        // from a valid document instead of failing every write.
        await this.quarantine();
      }
    }
    const document = emptyDocument();
    await this.write(document);
    return document;
  }

  /**
   * Move an unreadable board file aside so a fresh one can take its place.
   * @returns {Promise<void>} resolves whether or not there was a file to move.
   */
  async quarantine() {
    const target = `${this.file}.corrupt-${this.now()}`;
    await rename(this.file, target).catch(() => {});
  }

  /**
   * Replace the document.
   * @param {object} document - next document.
   * @returns {Promise<object>} the document written.
   */
  async write(document) {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await rename(temporary, this.file);
    return document;
  }

  /**
   * Run one mutation against a fresh copy of the document.
   *
   * The callback may mutate the document in place and return anything; the
   * document is written whether or not it returned a value. Throwing aborts
   * the write and rejects, which is how a route reports "card not found".
   *
   * @param {(document: object) => unknown} mutate - change function.
   * @returns {Promise<object>} the document after the change.
   */
  update(mutate) {
    const run = this.queue.then(async () => {
      const document = await this.read();
      mutate(document);
      for (const project of document.projects) project.updatedAt = this.now();
      return this.write(document);
    });
    // Keep the chain alive even when this mutation rejected, or every later
    // mutation inherits the rejection and the board stops accepting writes.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/**
 * Find a project or throw the error a route turns into a 200 `{ ok: false }`.
 * @param {object} document - board document.
 * @param {string} projectId - project id.
 * @returns {object} project.
 */
export function requireProject(document, projectId) {
  const project = document.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new Error('project not found');
  return project;
}

/**
 * The project a tool call means: the one it names, or the only board there is.
 *
 * The panel shows one board and offers no way to make a second, so a model
 * calling a tool should not have to read the board first just to learn an id
 * it cannot affect. An explicit id still wins, which keeps an older
 * conversation working against a document that does hold several.
 * @param {object} document - board document.
 * @param {string} [projectId] - project id, if the caller has one.
 * @returns {object} project.
 */
export function pickProject(document, projectId) {
  if (projectId) return requireProject(document, projectId);
  const project = document.projects[0];
  if (!project) throw new Error('the board has no project');
  return project;
}

/**
 * Find a card inside a project.
 * @param {object} project - project.
 * @param {string} cardId - card id.
 * @returns {object} card.
 */
export function requireCard(project, cardId) {
  const card = project.cards.find((candidate) => candidate.id === cardId);
  if (!card) throw new Error('card not found');
  return card;
}

/**
 * The next card number for a project: one past the highest ever used.
 *
 * Numbers are never reused, so deleting `DSH-4` leaves a gap instead of
 * handing its identity to a new card.
 *
 * @param {object} project - project.
 * @returns {number} next number.
 */
export function nextCardNumber(project) {
  let highest = 0;
  for (const card of project.cards) {
    if (Number.isFinite(card.number) && card.number > highest) highest = card.number;
  }
  return highest + 1;
}
