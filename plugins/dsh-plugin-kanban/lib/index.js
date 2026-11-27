/**
 * Host side of `dsh-plugin-kanban`.
 *
 * Four responsibilities, in the order they matter:
 *  - own the board document (`BoardStore`), so the panel is a view and never
 *    the source of truth;
 *  - serve the panel's REST bridge under `/api/dsh-kanban`;
 *  - expose the same operations as agent tools, because a board the model
 *    cannot read is a board the model cannot help with;
 *  - run a card: open a session in the card's workspace and settle the card
 *    when that session falls quiet.
 *
 * Every registration happens inside `apply` and returns a disposer, so the
 * plugin unloads cleanly.
 */

import { randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { BoardStore, PRIORITIES, logChange, logIfChanged, nextCardNumber, pickProject, requireCard, requireProject, resolveDataFile } from './store.js';

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
  const runtime = createRuntime(ctx);
  registerBridge(ctx, store, runtime);
  registerTools(ctx, store);
}

/**
 * The host services a run needs, resolved lazily.
 *
 * Both services come and go with the host: the panel can be loaded before the
 * workspace registry is up, and the registry can be replaced under a live
 * plugin. Holding direct references would either crash the load or leave the
 * bridge pointing at a dead registry, so every call resolves through this
 * object and reports "not ready" instead.
 * @param {object} ctx - plugin context.
 * @returns {object} runtime face.
 */
function createRuntime(ctx) {
  const runtime = {
    /** @type {object|undefined} narrow workspace face. */
    workspaces: undefined,
    /** @type {object|undefined} session factory face. */
    agents: undefined,
    /** Sessions this plugin started that have not settled yet. */
    runs: new Map(),

    /**
     * @returns {Array<{id: string, path: string, title: string}>} workspaces.
     */
    listWorkspaces() {
      return runtime.workspaces === undefined ? [] : runtime.workspaces.list();
    },

    /**
     * @param {string|null} id - workspace id.
     * @returns {{id: string, path: string, title: string}|undefined} workspace.
     */
    getWorkspace(id) {
      if (typeof id !== 'string' || id.length === 0) return undefined;
      return runtime.workspaces?.get(id);
    },
  };

  ctx.inject(['workspaceRegistry'], (wsCtx) => {
    runtime.workspaces = workspaceFace(wsCtx.workspaceRegistry);
    wsCtx.effect(() => () => {
      runtime.workspaces = undefined;
    });

    wsCtx.inject(['agents'], (agentCtx) => {
      runtime.agents = {
        create: (options) => agentCtx.agents.create(options),
        attach: async (workspaceId, sessionId) => {
          const workspace = wsCtx.workspaceRegistry.get(workspaceId);
          if (workspace !== undefined) await workspace.attachSession(sessionId);
        },
        rename: (sessionId, title) => {
          try {
            const session = agentCtx.get('sessions')?.get(sessionId);
            if (session !== undefined) agentCtx.get('sessionTitle')?.rename(session, title);
          } catch {
            // A missing title service is cosmetic: the session still runs.
          }
        },
        setPermission: (sessionId, permission) => {
          try {
            const session = agentCtx.get('sessions')?.get(sessionId);
            const presets = agentCtx.get('permissionPresets');
            if (session !== undefined && presets !== undefined) presets.set(session, permission);
          } catch {
            // Same: permission defaults are fine.
          }
        },
        /**
         * The deployment's default route. A fresh session has no recorded model
         * selection, so it must borrow this or its first step throws
         * "has no provider/model". Read lazily: the selection can change while
         * the plugin is loaded.
         * @returns {{provider: string, model: string, reasoningEffort?: string}|undefined}
         */
        defaultModel: () => {
          try {
            const service = agentCtx.get('agentDefaultModel');
            const read = service?.currentSelection;
            return read === undefined ? undefined : read.call(service);
          } catch {
            return undefined;
          }
        },
      };
      agentCtx.effect(() => () => {
        for (const run of runtime.runs.values()) void run.dispose?.();
        runtime.runs.clear();
        runtime.agents = undefined;
      });
    });
  });

  return runtime;
}

/**
 * Adapt the workspace registry to the three fields the bridge needs.
 *
 * Explicit mapping, not spread: `path` and `title` are prototype getters on a
 * Workspace, so `JSON.stringify` — and therefore any route answer — drops them.
 * @param {object} registry - workspace registry service.
 * @returns {object} narrow face.
 */
function workspaceFace(registry) {
  const project = (workspace) =>
    workspace === undefined ? undefined : { id: workspace.id, path: workspace.path, title: workspace.title };
  return {
    get: (id) => project(registry.get(id)),
    list: () => registry.list().map(project),
  };
}

/**
 * Register the panel's data routes.
 * @param {object} ctx - plugin context.
 * @param {BoardStore} store - board document.
 * @param {object} runtime - host services; see `createRuntime`.
 */
function registerBridge(ctx, store, runtime) {
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

        // Where a card may be executed. The panel needs this to offer the
        // workspace picker; an empty list means the host has no projects yet
        // and the picker simply has nothing to show.
        makeRoute(ctx, '/workspaces', async () => ({
          ok: true,
          workspaces: runtime.listWorkspaces(),
        })),

        makeRoute(ctx, '/card/create', async (body) =>
          store.update((document) => {
            const project = requireProject(document, body.projectId);
            const column = project.columns.find((item) => item.id === body.columnId);
            if (!column) throw new Error('column not found');
            const now = Date.now();
            const card = {
              id: randomUUID(),
              number: nextCardNumber(project),
              title: String(body.title ?? '').slice(0, 500),
              description: String(body.description ?? ''),
              columnId: column.id,
              priority: PRIORITIES.includes(body.priority) ? body.priority : null,
              needsHuman: false,
              workspaceId: typeof body.workspaceId === 'string' && body.workspaceId ? body.workspaceId : null,
              sessionId: null,
              executing: false,
              executionStartedAt: null,
              executionNote: null,
              startDate: typeof body.startDate === 'string' ? body.startDate : null,
              dueDate: typeof body.dueDate === 'string' ? body.dueDate : null,
              createdAt: now,
              updatedAt: now,
              // The log starts here, not at the first edit: "when was this
              // made" is the first question anyone asks of a history.
              history: [],
            };
            logChange(card, now, 'created');
            project.cards.push(card);
          }).then((document) => ({ ok: true, board: document })),
        ),

        makeRoute(ctx, '/card/update', async (body) =>
          store.update((document) => {
            const project = requireProject(document, body.projectId);
            const card = requireCard(project, body.cardId);
            const now = Date.now();
            // Log before assigning: the comparison needs the old value, and
            // only real differences belong in the log.
            if (typeof body.title === 'string') {
              logIfChanged(card, now, 'title', body.title.slice(0, 500));
              card.title = body.title.slice(0, 500);
            }
            if (typeof body.description === 'string') {
              logIfChanged(card, now, 'description', body.description);
              card.description = body.description;
            }
            if ('priority' in body) {
              const priority = PRIORITIES.includes(body.priority) ? body.priority : null;
              logIfChanged(card, now, 'priority', priority);
              card.priority = priority;
            }
            // Waiting for a human is a flag, so it can be set on a card at any
            // stage and survives moving the card to another column.
            if ('needsHuman' in body) {
              const needsHuman = body.needsHuman === true;
              logIfChanged(card, now, 'needsHuman', needsHuman);
              card.needsHuman = needsHuman;
            }
            if ('workspaceId' in body) {
              const workspaceId = typeof body.workspaceId === 'string' && body.workspaceId ? body.workspaceId : null;
              logIfChanged(card, now, 'workspaceId', workspaceId);
              card.workspaceId = workspaceId;
            }
            if ('startDate' in body) {
              const startDate = typeof body.startDate === 'string' ? body.startDate : null;
              logIfChanged(card, now, 'startDate', startDate);
              card.startDate = startDate;
            }
            if ('dueDate' in body) {
              const dueDate = typeof body.dueDate === 'string' ? body.dueDate : null;
              logIfChanged(card, now, 'dueDate', dueDate);
              card.dueDate = dueDate;
            }
            card.updatedAt = now;
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
            const now = Date.now();
            logIfChanged(card, now, 'columnId', column.id);
            card.columnId = column.id;
            card.updatedAt = now;
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

        // Run a card: open a fresh session in the card's workspace, hand it the
        // card, and settle the card when that session goes quiet. The bridge
        // only starts it — the card's own state changes are written by the
        // settlement below, so a closed tab changes nothing.
        makeRoute(ctx, '/card/run', async (body) => {
          const board = await store.read();
          const project = requireProject(board, body.projectId);
          const card = requireCard(project, body.cardId);
          if (card.executing) throw new Error('this card is already running');
          const workspace = resolveRunWorkspace(runtime, card, body.workspaceId);
          await startRun({ store, runtime, project, card, workspace });
          return { ok: true, board: await store.read() };
        }),

        // There are no column routes. The board's five lanes are part of its
        // schema, not its data, so there is nothing here to create, rename,
        // recolour, reorder, or delete — a request to do any of that is not a
        // refused mutation but a route that does not exist.
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
 * Which workspace a run opens in: the one the caller named, else the one the
 * card remembers, and there is no third answer — a session needs a directory,
 * and guessing one would run the model in the wrong project.
 * @param {object} runtime - host services.
 * @param {object} card - card being run.
 * @param {unknown} [override] - workspace id from the request.
 * @returns {{id: string, path: string, title: string}} workspace.
 */
function resolveRunWorkspace(runtime, card, override) {
  const workspaceId = typeof override === 'string' && override ? override : card.workspaceId;
  if (!workspaceId) throw new Error('this card has no workspace yet');
  const workspace = runtime.getWorkspace(workspaceId);
  if (workspace === undefined) throw new Error('workspace not found');
  return workspace;
}

/**
 * Open a session for a card and settle the card when that session falls quiet.
 *
 * The card is claimed before the session is created, in one write: a second
 * click, or a second tab, must not start a second session for the same card.
 * Everything after that point can fail — the claim is reverted by `settleRun`
 * and the card returns to 待办 rather than staying stuck as "running".
 *
 * @param {object} options - run options.
 * @param {BoardStore} options.store - board document.
 * @param {object} options.runtime - host services.
 * @param {object} options.project - project the card belongs to.
 * @param {object} options.card - card to run.
 * @param {{id: string, path: string, title: string}} options.workspace - where to run.
 * @returns {Promise<void>} resolves once the session has the card.
 */
async function startRun({ store, runtime, project, card, workspace }) {
  if (runtime.agents === undefined) throw new Error('the host is not ready to start sessions yet');

  const claimed = await store.update((document) => {
    const live = requireProject(document, project.id);
    const target = requireCard(live, card.id);
    if (target.executing) throw new Error('this card is already running');
    const now = Date.now();
    target.executing = true;
    target.executionStartedAt = now;
    target.executionNote = null;
    target.workspaceId = workspace.id;
    // Running a card is what "进行中" means, so starting one puts it there. Any
    // column it was in is remembered as the change log's from-value.
    if (target.columnId !== 'doing') {
      logChange(target, now, 'columnId', target.columnId, 'doing');
      target.columnId = 'doing';
    }
    target.updatedAt = now;
    logChange(target, now, 'executing', false, true);
  });
  const liveCard = requireCard(requireProject(claimed, project.id), card.id);

  const sessionId = `session-kanban-${randomUUID()}`;
  let handle;
  try {
    // A fresh session records no model selection of its own; without these the
    // agent loop throws before its first step. Borrow the deployment default.
    const model = runtime.agents.defaultModel?.();
    if (model === undefined) {
      throw new Error('没有可用的默认模型：请在设置里选一个模型，或检查 agent-default-model 的配置');
    }
    handle = await runtime.agents.create({
      sessionId,
      // The session's cwd must be exactly the workspace root: the workspace
      // registry checks that when attaching, the sidebar groups sessions by it,
      // and the file sandbox takes it as the writable boundary.
      meta: { cwd: workspace.path },
      agentOptions: {
        provider: model.provider,
        model: model.model,
        ...(model.reasoningEffort !== undefined ? { reasoningEffort: model.reasoningEffort } : {}),
      },
    });
    const startedSession = handle.agent.id ?? sessionId;
    await runtime.agents.attach(workspace.id, startedSession).catch(() => {});
    runtime.agents.setPermission?.(startedSession, 'workspace-write');
    runtime.agents.rename?.(startedSession, `#${liveCard.number} ${liveCard.title || '未命名卡片'}`);
    runtime.runs.set(liveCard.id, { sessionId: startedSession, dispose: () => handle.dispose() });

    await store.update((document) => {
      const target = requireCard(requireProject(document, project.id), liveCard.id);
      target.sessionId = startedSession;
      target.updatedAt = Date.now();
    });

    // Two messages, one turn: the framing rides `inject` (queued context that
    // does not wake the driver) and the card body rides `followup` (the normal
    // user message that does). The transcript then shows the card as a user
    // bubble with the framing collapsed above it.
    handle.agent.inject({
      id: `msg-kanban-${randomUUID()}`,
      role: 'user',
      content: [{ type: 'text', text: runFraming(liveCard, workspace) }],
      source: { kind: 'plugin:dsh-kanban' },
    });
    handle.agent.followup({
      id: `msg-kanban-${randomUUID()}`,
      role: 'user',
      content: [{ type: 'text', text: cardBody(liveCard) }],
      source: { kind: 'user' },
    });

    void handle.agent.whenIdle().then(
      () => settleRun({ store, runtime, projectId: project.id, cardId: liveCard.id, sessionId: startedSession, outcome: 'succeeded' }),
      (error) =>
        settleRun({
          store,
          runtime,
          projectId: project.id,
          cardId: liveCard.id,
          sessionId: startedSession,
          outcome: 'failed',
          error: String(error?.message ?? error ?? 'the session did not reach an idle state'),
        }),
    );
  } catch (error) {
    await settleRun({
      store,
      runtime,
      projectId: project.id,
      cardId: card.id,
      sessionId: null,
      outcome: 'failed',
      error: String(error?.message ?? error),
    }).catch(() => {});
    throw error;
  }
}

/**
 * Close out a run: clear the flags and put the card where the outcome belongs.
 *
 * A finished session lands in 待验收 — that is the whole point of running a card
 * from the board — and a broken one goes back to 待办 marked for a human, since
 * whatever went wrong needs a person to look at it. A card the user moved by
 * hand in the meantime keeps its column: the run does not own the card, it only
 * reports what happened.
 *
 * @param {object} options - settlement options.
 * @param {BoardStore} options.store - board document.
 * @param {object} options.runtime - host services.
 * @param {string} options.projectId - project id.
 * @param {string} options.cardId - card id.
 * @param {string|null} options.sessionId - session that ran.
 * @param {'succeeded'|'failed'} options.outcome - how it ended.
 * @param {string} [options.error] - failure text.
 * @returns {Promise<void>} resolves once the board is written.
 */
async function settleRun({ store, runtime, projectId, cardId, sessionId, outcome, error }) {
  const run = runtime.runs.get(cardId);
  runtime.runs.delete(cardId);
  if (outcome === 'failed') void run?.dispose();
  const failed = outcome === 'failed';
  await store.update((document) => {
    const project = requireProject(document, projectId);
    const card = requireCard(project, cardId);
    const now = Date.now();
    if (sessionId) card.sessionId = sessionId;
    logChange(card, now, 'executing', true, false);
    card.executing = false;
    card.executionStartedAt = null;
    card.executionNote = failed ? String(error ?? '执行失败').slice(0, 500) : null;
    // A card the user moved by hand still belongs where the user put it. Only
    // the column the run parked it in gets rewritten at the end.
    const previousColumn = card.columnId;
    if (failed) {
      if (previousColumn === 'doing') {
        logChange(card, now, 'columnId', previousColumn, 'todo');
        card.columnId = 'todo';
      }
      if (!card.needsHuman) {
        logChange(card, now, 'needsHuman', false, true);
        card.needsHuman = true;
      }
    } else if (previousColumn !== 'review' && previousColumn !== 'done') {
      logChange(card, now, 'columnId', previousColumn, 'review');
      card.columnId = 'review';
      if (card.needsHuman) {
        logChange(card, now, 'needsHuman', true, false);
        card.needsHuman = false;
      }
    }
    card.updatedAt = now;
  });
}

/**
 * What the session is told about the card it is working on.
 * @param {object} card - card.
 * @param {{title: string}} workspace - workspace.
 * @returns {string} framing text.
 */
function runFraming(card, workspace) {
  return [
    `【看板卡片】#${card.number} ${card.title || '未命名卡片'}（ID: ${card.id}）`,
    `工作区：${workspace.title || workspace.path}`,
    '',
    '本会话由看板启动，卡片已置为「进行中」。完成任务后不需要移动卡片：',
    '会话结束时看板会自己把它送到「待验收」；如果执行出错，卡片会退回「待办」并标记为需要人工介入。',
    '需要调整卡片本身（改标题、描述、优先级、移动位置）时用看板工具，不要凭空假设卡片的状态。',
  ].join('\n');
}

/**
 * The card body, as the user message the session wakes on.
 * @param {object} card - card.
 * @returns {string} body text.
 */
function cardBody(card) {
  const description = String(card.description ?? '').trim();
  return description || String(card.title ?? '').trim() || '（这张卡片没有描述）';
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
            description: '读看板当前内容：列和卡片。',
            parameters: {},
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
              const projects = board.projects.slice(0, 1);
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
                        needsHuman: card.needsHuman === true,
                        startDate: card.startDate,
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
              columnId: { type: 'string', description: '列 id。', required: true },
              title: { type: 'string', description: '卡片标题。', required: true },
              description: { type: 'string', description: '卡片描述，支持 Markdown。' },
              priority: {
                type: 'string',
                description: '优先级：urgent / high / medium / low，省略表示不设。',
              },
              startDate: {
                type: 'string',
                description: '开始日期，YYYY-MM-DD。',
              },
              dueDate: {
                type: 'string',
                description: '截止日期，YYYY-MM-DD。',
              },
              needsHuman: {
                type: 'boolean',
                description: '是否标记为需要人工介入；省略表示不标记。',
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
                const project = pickProject(draft, args.projectId);
                const column = project.columns.find((item) => item.id === args.columnId);
                if (!column) throw new Error('column not found');
                const now = Date.now();
                const card = {
                  id: randomUUID(),
                  number: nextCardNumber(project),
                  title: String(args.title ?? '').slice(0, 500),
                  description: String(args.description ?? ''),
                  columnId: column.id,
                  priority: PRIORITIES.includes(args.priority) ? args.priority : null,
                  needsHuman: args.needsHuman === true,
                  workspaceId: null,
                  sessionId: null,
                  executing: false,
                  executionStartedAt: null,
                  executionNote: null,
                  startDate: typeof args.startDate === 'string' ? args.startDate : null,
                  dueDate: typeof args.dueDate === 'string' ? args.dueDate : null,
                  createdAt: now,
                  updatedAt: now,
                  history: [],
                };
                logChange(card, now, 'created');
                project.cards.push(card);
              });
              const project = pickProject(document, args.projectId);
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
                const project = pickProject(draft, args.projectId);
                const card = requireCard(project, args.cardId);
                const columnId = args.columnId ?? card.columnId;
                const column = project.columns.find((item) => item.id === columnId);
                if (!column) throw new Error('column not found');
                const now = Date.now();
                logIfChanged(card, now, 'columnId', column.id);
                card.columnId = column.id;
                card.updatedAt = now;
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
    for (const column of project.columns ?? []) {
      lines.push(`${column.name} [${column.id}]`);
      if (column.cards.length === 0) lines.push('  空');
      for (const card of column.cards) {
        const bits = [`#${card.number} ${card.title} [${card.id}]`];
        if (card.priority) bits.push(card.priority);
        if (card.needsHuman) bits.push('需要人工介入');
        if (card.startDate) bits.push(`${card.startDate} →${card.dueDate ? ` ${card.dueDate}` : ''}`);
        else if (card.dueDate) bits.push(card.dueDate);
        lines.push(`  ${bits.join(' · ')}`);
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
