/**
 * Host side of `dsh-plugin-kanban`.
 *
 * Three responsibilities, in the order they matter:
 *  - own the board document (`BoardStore`), so the panel is a view and never
 *    the source of truth;
 *  - serve the panel's REST bridge under `/api/dsh-kanban`;
 *  - expose the same operations as agent tools, because a board the model
 *    cannot read is a board the model cannot help with.
 *
 * Every registration happens inside `apply` and returns a disposer, so the
 * plugin unloads cleanly.
 */

import { randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { normalize } from './store.js';
import { BoardStore, PRIORITIES, nextCardNumber, requireCard, requireProject, resolveDataFile } from './store.js';

export { Config } from './config.js';

/** Bridge route prefix, deliberately distinct from the framework's `/api/*`. */
const BRIDGE_PREFIX = '/api/dsh-kanban';

/** Largest JSON body the bridge accepts. */
const MAX_JSON_BODY_BYTES = 256 * 1024;

/**
 * Plugin entry point.
 * @param {object} ctx - plugin context.
 * @param {object} config - resolved plugin config.
 */
export function apply(ctx, config) {
  const store = new BoardStore({ file: resolveDataFile(config.dataFile) });
  registerBridge(ctx, store);
  registerTools(ctx, store);
}

/**
 * Register the panel's data routes.
 * @param {object} ctx - plugin context.
 * @param {BoardStore} store - board document.
 */
function registerBridge(ctx, store) {
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => {
      const routes = [
        // The whole board in one call. A board is small by construction —
        // hundreds of cards, not millions — so the panel never paginates and
        // never has to reconcile two lists that disagree.
        makeRoute(ctx, '/board', async () => ({
          ok: true,
          board: await store.read(),
        })),

        makeRoute(ctx, '/card/create', async (body) =>
          store.update((document) => {
            const project = requireProject(document, body.projectId);
            const column = project.columns.find((item) => item.id === body.columnId);
            if (!column) throw new Error('column not found');
            const now = Date.now();
            project.cards.push({
              id: randomUUID(),
              number: nextCardNumber(project),
              title: String(body.title ?? '').slice(0, 500),
              description: String(body.description ?? ''),
              columnId: column.id,
              priority: PRIORITIES.includes(body.priority) ? body.priority : null,
              dueDate: typeof body.dueDate === 'string' ? body.dueDate : null,
              createdAt: now,
              updatedAt: now,
            });
          }).then((document) => ({ ok: true, board: document })),
        ),

        makeRoute(ctx, '/card/update', async (body) =>
          store.update((document) => {
            const project = requireProject(document, body.projectId);
            const card = requireCard(project, body.cardId);
            if (typeof body.title === 'string') card.title = body.title.slice(0, 500);
            if (typeof body.description === 'string') card.description = body.description;
            if ('priority' in body) {
              card.priority = PRIORITIES.includes(body.priority) ? body.priority : null;
            }
            if ('dueDate' in body) {
              card.dueDate = typeof body.dueDate === 'string' ? body.dueDate : null;
            }
            card.updatedAt = Date.now();
          }).then((document) => ({ ok: true, board: document })),
        ),

        // Moving a card is its own route rather than a field on `update`,
        // because a move also reorders: `index` is the position among the
        // cards already in the destination column.
        makeRoute(ctx, '/card/move', async (body) =>
          store.update((document) => {
            const project = requireProject(document, body.projectId);
            const card = requireCard(project, body.cardId);
            const column = project.columns.find((item) => item.id === body.columnId);
            if (!column) throw new Error('column not found');
            card.columnId = column.id;
            card.updatedAt = Date.now();
            const order = siblingOrder(project, column.id, card.id);
            const index = clampIndex(body.index, order.length);
            order.splice(index, 0, card.id);
            applyOrder(project, order);
          }).then((document) => ({ ok: true, board: document })),
        ),

        makeRoute(ctx, '/card/delete', async (body) =>
          store.update((document) => {
            const project = requireProject(document, body.projectId);
            requireCard(project, body.cardId);
            project.cards = project.cards.filter((card) => card.id !== body.cardId);
          }).then((document) => ({ ok: true, board: document })),
        ),

        makeRoute(ctx, '/column/create', async (body) =>
          store.update((document) => {
            const project = requireProject(document, body.projectId);
            project.columns.push({
              id: randomUUID(),
              name: String(body.name ?? '新列').slice(0, 60),
              isFinal: body.isFinal === true,
            });
          }).then((document) => ({ ok: true, board: document })),
        ),

        makeRoute(ctx, '/column/update', async (body) =>
          store.update((document) => {
            const project = requireProject(document, body.projectId);
            const column = project.columns.find((item) => item.id === body.columnId);
            if (!column) throw new Error('column not found');
            if (typeof body.name === 'string') column.name = body.name.slice(0, 60);
            if ('isFinal' in body) column.isFinal = body.isFinal === true;
          }).then((document) => ({ ok: true, board: document })),
        ),

        // Deleting a column deletes its cards. The panel asks first and says so;
        // silently reassigning them to a neighbour would look like data loss
        // that recovered itself, which is worse than data loss you were told about.
        makeRoute(ctx, '/column/delete', async (body) =>
          store.update((document) => {
            const project = requireProject(document, body.projectId);
            if (project.columns.length <= 1) throw new Error('the last column cannot be deleted');
            project.columns = project.columns.filter((item) => item.id !== body.columnId);
            project.cards = project.cards.filter((card) => card.columnId !== body.columnId);
          }).then((document) => ({ ok: true, board: document })),
        ),

        makeRoute(ctx, '/column/reorder', async (body) =>
          store.update((document) => {
            const project = requireProject(document, body.projectId);
            const byId = new Map(project.columns.map((column) => [column.id, column]));
            const ordered = [];
            for (const id of Array.isArray(body.columnIds) ? body.columnIds : []) {
              const column = byId.get(id);
              if (column && !ordered.includes(column)) {
                ordered.push(column);
                byId.delete(id);
              }
            }
            // Anything the caller forgot keeps its existing relative order and
            // stays on the board, rather than disappearing from the list.
            for (const column of project.columns) {
              if (byId.has(column.id)) ordered.push(column);
            }
            project.columns = ordered;
          }).then((document) => ({ ok: true, board: document })),
        ),

        makeRoute(ctx, '/project/create', async (body) =>
          store.update((document) => {
            const now = Date.now();
            document.projects.push({
              id: randomUUID(),
              name: String(body.name ?? '新项目').slice(0, 60),
              columns: [
                { id: randomUUID(), name: '待办', isFinal: false },
                { id: randomUUID(), name: '进行中', isFinal: false },
                { id: randomUUID(), name: '已完成', isFinal: true },
              ],
              cards: [],
              createdAt: now,
              updatedAt: now,
            });
          }).then((document) => ({ ok: true, board: document })),
        ),

        makeRoute(ctx, '/project/update', async (body) =>
          store.update((document) => {
            const project = requireProject(document, body.projectId);
            if (typeof body.name === 'string') project.name = body.name.slice(0, 60);
          }).then((document) => ({ ok: true, board: document })),
        ),

        makeRoute(ctx, '/project/delete', async (body) =>
          store.update((document) => {
            requireProject(document, body.projectId);
            if (document.projects.length <= 1) throw new Error('the last project cannot be deleted');
            document.projects = document.projects.filter((item) => item.id !== body.projectId);
          }).then((document) => ({ ok: true, board: document })),
        ),

        // Wholesale replace. Used by import/export and by the panel's own
        // "reset" affordance; it is the only route that trusts its input, so it
        // runs the document through the same normalizer a file read does.
        makeRoute(ctx, '/board/replace', async (body) =>
          store.write(normalize(body.board)).then((document) => ({ ok: true, board: document })),
        ),
      ];

      const disposers = routes.map((route) => registerRoute(sctx, route));
      return () => {
        for (const dispose of disposers) dispose();
      };
    });
  });
}

/**
 * Card ids of one column in their stored order, optionally excluding one.
 * @param {object} project - project.
 * @param {string} columnId - column id.
 * @param {string} [exclude] - card id to leave out.
 * @returns {string[]} card ids.
 */
function siblingOrder(project, columnId, exclude) {
  return project.cards
    .filter((card) => card.columnId === columnId && card.id !== exclude)
    .map((card) => card.id);
}

/**
 * Rewrite the cards of one column into the given order, leaving other columns
 * untouched. Card order is the document's array order, so this rewrites the
 * array once rather than keeping a separate `order` field that can drift.
 * @param {object} project - project.
 * @param {string[]} orderedIds - card ids, in the wanted order.
 */
function applyOrder(project, orderedIds) {
  const byId = new Map(project.cards.map((card) => [card.id, card]));
  const moved = orderedIds.map((id) => byId.get(id)).filter(Boolean);
  const movedIds = new Set(moved.map((card) => card.id));
  let cursor = 0;
  project.cards = project.cards.map((card) => {
    if (!movedIds.has(card.id)) return card;
    const next = moved[cursor];
    cursor += 1;
    return next;
  });
}

/**
 * Clamp a requested index into a list of known length.
 * @param {unknown} value - requested index.
 * @param {number} length - list length.
 * @returns {number} index in [0, length].
 */
function clampIndex(value, length) {
  const number = Number(value);
  if (!Number.isFinite(number)) return length;
  return Math.min(Math.max(Math.trunc(number), 0), length);
}

/**
 * Register the agent tools.
 *
 * The tools read and write the same document the panel does, so a card created
 * in a conversation appears on the board without a refresh, and a card moved by
 * hand is what the model sees next turn.
 * @param {object} ctx - plugin context.
 * @param {BoardStore} store - board document.
 */
function registerTools(ctx, store) {
  ctx.inject(['tools'], (sctx) => {
    sctx.effect(() => {
      const disposers = [];

      disposers.push(
        sctx.tools.register(
          defineTool({
            name: 'board_view',
            description:
              '读看板当前内容：每个项目的列和卡片。默认返回所有项目；给 projectId 只返回那一个。',
            parameters: {
              projectId: { type: 'string', description: '只读这个项目；省略则读全部。' },
            },
            output: {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  projects: { type: 'json' },
                },
              },
              render: (args, value) => [{ type: 'text', text: renderBoard(value) }],
            },
            async execute(args) {
              const board = await store.read();
              const projects = args.projectId
                ? board.projects.filter((project) => project.id === args.projectId)
                : board.projects;
              return {
                projects: projects.map((project) => ({
                  id: project.id,
                  name: project.name,
                  columns: project.columns.map((column) => ({
                    id: column.id,
                    name: column.name,
                    cards: project.cards
                      .filter((card) => card.columnId === column.id)
                      .map((card) => ({
                        id: card.id,
                        number: card.number,
                        title: card.title,
                        priority: card.priority,
                        dueDate: card.dueDate,
                      })),
                  })),
                })),
              };
            },
          }),
          { id: 'dsh-board:view' },
        ),
      );

      disposers.push(
        sctx.tools.register(
          defineTool({
            name: 'board_add_card',
            description:
              '在看板上新建一张卡片。不知道 columnId 时先用 board_view 读一次。' +
              '新卡片编号由看板分配，不要自己指定。',
            parameters: {
              projectId: { type: 'string', description: '项目 id。', required: true },
              columnId: { type: 'string', description: '列 id。', required: true },
              title: { type: 'string', description: '卡片标题。', required: true },
              description: { type: 'string', description: '卡片描述，支持 Markdown。' },
              priority: {
                type: 'string',
                description: '优先级：urgent / high / medium / low，省略表示不设。',
              },
            },
            output: {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  number: { type: 'number' },
                  title: { type: 'string' },
                },
              },
              render: (args, value) => [
                { type: 'text', text: `已创建 #${value.number} ${value.title}` },
              ],
            },
            async execute(args) {
              const document = await store.update((draft) => {
                const project = requireProject(draft, args.projectId);
                const column = project.columns.find((item) => item.id === args.columnId);
                if (!column) throw new Error('column not found');
                const now = Date.now();
                project.cards.push({
                  id: randomUUID(),
                  number: nextCardNumber(project),
                  title: String(args.title ?? '').slice(0, 500),
                  description: String(args.description ?? ''),
                  columnId: column.id,
                  priority: PRIORITIES.includes(args.priority) ? args.priority : null,
                  dueDate: null,
                  createdAt: now,
                  updatedAt: now,
                });
              });
              const project = document.projects.find((item) => item.id === args.projectId);
              const card = project.cards[project.cards.length - 1];
              return { id: card.id, number: card.number, title: card.title };
            },
          }),
          { id: 'dsh-board:add-card' },
        ),
      );

      disposers.push(
        sctx.tools.register(
          defineTool({
            name: 'board_move_card',
            description: '把卡片移到另一列，或调整它在同列内的位置。',
            parameters: {
              projectId: { type: 'string', description: '项目 id。', required: true },
              cardId: { type: 'string', description: '卡片 id。', required: true },
              columnId: { type: 'string', description: '目标列 id；省略表示留在原列。' },
              index: { type: 'number', description: '目标列内的位置，0 表示最上面。' },
            },
            output: {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: { ok: { type: 'boolean' } },
              },
              render: () => [{ type: 'text', text: '已移动' }],
            },
            async execute(args) {
              await store.update((draft) => {
                const project = requireProject(draft, args.projectId);
                const card = requireCard(project, args.cardId);
                const columnId = args.columnId ?? card.columnId;
                const column = project.columns.find((item) => item.id === columnId);
                if (!column) throw new Error('column not found');
                card.columnId = column.id;
                card.updatedAt = Date.now();
                const order = siblingOrder(project, column.id, card.id);
                order.splice(clampIndex(args.index, order.length), 0, card.id);
                applyOrder(project, order);
              });
              return { ok: true };
            },
          }),
          { id: 'dsh-board:move-card' },
        ),
      );

      return () => {
        for (const dispose of disposers) dispose();
      };
    });
  });
}

/**
 * Render a board read as plain text for the model.
 * @param {object} value - `{ projects }`.
 * @returns {string} text.
 */
function renderBoard(value) {
  const lines = [];
  for (const project of value.projects ?? []) {
    lines.push(`${project.name} (${project.id})`);
    for (const column of project.columns ?? []) {
      lines.push(`  ${column.name} [${column.id}]`);
      if (column.cards.length === 0) lines.push('    空');
      for (const card of column.cards) {
        const bits = [`#${card.number} ${card.title} [${card.id}]`];
        if (card.priority) bits.push(card.priority);
        if (card.dueDate) bits.push(card.dueDate);
        lines.push(`    ${bits.join(' · ')}`);
      }
    }
  }
  return lines.join('\n') || '看板是空的';
}

/**
 * Build one bridge route. Every route takes a JSON body and answers JSON,
 * including for expected failures: the panel distinguishes them by `ok`, not by
 * status, so a rejected mutation never looks like a broken transport.
 * @param {object} ctx - plugin context.
 * @param {string} path - path below the bridge prefix.
 * @param {(body: object) => Promise<object>} handler - route body.
 * @returns {object} route definition.
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
