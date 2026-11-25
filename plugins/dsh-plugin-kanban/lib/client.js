// dsh-plugin-kanban — browser half.
//
// One sidebar tab that renders a board, and nothing else. The board is drawn
// from the host document at /api/dsh-kanban/*; the panel owns no storage, so a
// card created here and a card created by a conversation are the same card.
//
// Layout follows the reference board this was modelled on: a lane is a rounded
// tinted column, a card is a white (or near-black) block with a hairline
// border, 6px between cards, 16px between lanes. Colours come from the host's
// --dsw-alias-* tokens rather than fixed hexes, so the board follows the theme
// the user picked instead of pinning one.
//
// No bundler: the factory body is plain CJS and `require('react')` resolves to
// the shell's own React.

window.__ModuleLoader__.load({
  id: 'dsh-plugin-kanban',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useMemo, useCallback } = React;

    /** Must match the `main` slot key and the sidebar row id. */
    const PANEL_ID = 'dsh-plugin-kanban';
    const BRIDGE_PREFIX = '/api/dsh-kanban';

    /** Must match the drawer's exit animation in the stylesheet. */
    const DRAWER_EXIT_MS = 140;

    const PRIORITIES = [
      { id: 'urgent', label: '紧急' },
      { id: 'high', label: '高' },
      { id: 'medium', label: '中' },
      { id: 'low', label: '低' },
    ];

    const PRIORITY_COLOR = {
      urgent: 'var(--dsw-alias-state-error-primary)',
      high: 'var(--dsw-alias-state-warn-primary)',
      medium: 'var(--dsw-alias-static-amber-400, var(--dsw-alias-state-warn-primary))',
      low: 'var(--dsw-alias-static-blue-500, var(--dsw-alias-brand-primary))',
    };

    // ---------------------------------------------------------------- styles
    //
    // One stylesheet, injected once per page. Everything is scoped under .dsb-
    // so nothing here can reach the shell's own DOM, and every colour is a
    // token or a color-mix of one: the board has no palette of its own.

    const CSS = `
.dsb-root {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  height: 100%;
  min-height: 100%;
  position: relative;
  overflow: hidden;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: 13px/18px system-ui, -apple-system, "Segoe UI", sans-serif;
}

.dsb-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex: 0 0 auto;
  min-height: 52px;
  padding: 0 20px;
}

.dsb-project {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px 0 6px;
  margin-left: -6px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: 500 15px/22px system-ui, -apple-system, "Segoe UI", sans-serif;
  cursor: pointer;
}
.dsb-project:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsb-project:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }

.dsb-count {
  color: var(--dsw-alias-label-tertiary);
  font: 400 12px/18px system-ui, -apple-system, "Segoe UI", sans-serif;
  font-variant-numeric: tabular-nums;
}

.dsb-lanes {
  box-sizing: border-box;
  display: flex;
  align-items: stretch;
  gap: 16px;
  flex: 1 1 auto;
  min-height: 0;
  padding: 0 20px 16px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-gutter: stable;
}

.dsb-lane {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-width: 264px;
  max-width: 384px;
  min-height: 0;
  border-radius: 12px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent);
  transition: box-shadow 120ms ease;
}
.dsb-lane[data-over="true"] {
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent);
}

.dsb-lane-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  height: 32px;
  padding: 4px 6px 0 12px;
}
.dsb-lane-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 500 13px/18px system-ui, -apple-system, "Segoe UI", sans-serif;
}
.dsb-lane-count {
  color: var(--dsw-alias-label-tertiary);
  font: 400 12px/18px system-ui, -apple-system, "Segoe UI", sans-serif;
  font-variant-numeric: tabular-nums;
}

.dsb-cards {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1 1 auto;
  min-height: 0;
  padding: 6px;
  overflow-y: auto;
  overflow-x: hidden;
}
.dsb-cards::-webkit-scrollbar { width: 8px; }
.dsb-cards::-webkit-scrollbar-thumb {
  border-radius: 4px;
  background: var(--dsw-alias-scrollbar-bg-l2);
}
.dsb-cards::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l2); }

.dsb-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px 11px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent);
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: 0 1px 2px color-mix(in srgb, #000 4%, transparent);
  transition: border-color 120ms ease, box-shadow 120ms ease;
  cursor: grab;
}
.dsb-card:hover {
  border-color: color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent);
}
.dsb-card:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.dsb-card[data-dragging="true"] { opacity: 0.45; }
.dsb-card[data-done="true"] {
  border-color: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 60%, transparent);
  box-shadow: none;
}

.dsb-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 14px;
}
.dsb-card-id {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary);
  font: 400 11px/14px ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.01em;
}
.dsb-card-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 999px;
}
.dsb-card-title {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-primary);
  font: 500 13px/18px system-ui, -apple-system, "Segoe UI", sans-serif;
}
.dsb-card[data-done="true"] .dsb-card-title { color: var(--dsw-alias-label-secondary); }

.dsb-card-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.dsb-card-foot:empty { display: none; }

.dsb-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 6px;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent);
  color: var(--dsw-alias-label-secondary);
  font: 400 11px/18px system-ui, -apple-system, "Segoe UI", sans-serif;
  white-space: nowrap;
}
.dsb-chip[data-overdue="true"] { color: var(--dsw-alias-state-error-primary); }

.dsb-drop {
  height: 2px;
  margin: -4px 0;
  border-radius: 2px;
  background: var(--dsw-alias-brand-primary);
}

.dsb-ghost {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 30px;
  padding: 0 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: 400 12px/18px system-ui, -apple-system, "Segoe UI", sans-serif;
  cursor: pointer;
  text-align: left;
}
.dsb-ghost:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsb-ghost:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }

.dsb-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.dsb-icon-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsb-icon-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }

.dsb-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: 500 12px/18px system-ui, -apple-system, "Segoe UI", sans-serif;
  cursor: pointer;
}
.dsb-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsb-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsb-btn[data-tone="danger"] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);
  color: var(--dsw-alias-state-error-primary);
}
.dsb-btn[data-tone="danger"]:hover {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
}

.dsb-menu {
  position: absolute;
  z-index: 20;
  min-width: 200px;
  max-width: 280px;
  padding: 4px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3);
  box-shadow: 0 8px 24px -6px color-mix(in srgb, #000 22%, transparent);
  max-height: 320px;
  overflow-y: auto;
}
.dsb-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: 400 13px/18px system-ui, -apple-system, "Segoe UI", sans-serif;
  cursor: pointer;
  text-align: left;
}
.dsb-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsb-menu-item[data-active="true"] { font-weight: 500; }
.dsb-menu-item[data-tone="danger"] { color: var(--dsw-alias-state-error-primary); }
.dsb-menu-item:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: not-allowed;
  background: transparent;
}
.dsb-menu-item-meta {
  margin-left: auto;
  color: var(--dsw-alias-label-tertiary);
  font: 400 11px/18px system-ui, -apple-system, "Segoe UI", sans-serif;
  font-variant-numeric: tabular-nums;
}
.dsb-menu-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--dsw-alias-border-l2);
}
.dsb-menu-confirm {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
}
.dsb-menu-confirm-text {
  color: var(--dsw-alias-label-secondary);
  font: 400 12px/18px system-ui, -apple-system, "Segoe UI", sans-serif;
}
.dsb-menu-confirm-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.dsb-scrim {
  position: fixed;
  inset: 0;
  z-index: 15;
  border: 0;
  padding: 0;
  background: transparent;
  cursor: default;
}

.dsb-drawer {
  box-sizing: border-box;
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 16;
  display: flex;
  flex-direction: column;
  width: min(460px, 100%);
  border-left: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: -12px 0 32px -18px color-mix(in srgb, #000 30%, transparent);
  animation: dsb-drawer-in 180ms cubic-bezier(0.2, 0.7, 0.3, 1);
}
.dsb-drawer[data-closing="true"] {
  animation: dsb-drawer-out 140ms cubic-bezier(0.4, 0, 0.7, 0.3) forwards;
  pointer-events: none;
}
@keyframes dsb-drawer-in {
  from { transform: translateX(16px); opacity: 0; }
  to { transform: none; opacity: 1; }
}
@keyframes dsb-drawer-out {
  from { transform: none; opacity: 1; }
  to { transform: translateX(12px); opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .dsb-drawer,
  .dsb-drawer[data-closing="true"] { animation-duration: 1ms; }
}
.dsb-drawer-scrim {
  position: absolute;
  inset: 0;
  z-index: 15;
  border: 0;
  padding: 0;
  background: color-mix(in srgb, var(--dsw-alias-bg-base) 40%, transparent);
  -webkit-backdrop-filter: blur(3px) saturate(115%);
  backdrop-filter: blur(3px) saturate(115%);
  cursor: default;
  animation: dsb-scrim-in 180ms ease;
}
@keyframes dsb-scrim-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.dsb-drawer-scrim[data-closing="true"] {
  /* Stays clickable-through-free for its last frame: the board must not take a
     click that was aimed at the drawer that is still on screen. */
  animation: dsb-scrim-in 140ms ease reverse forwards;
}
@media (prefers-reduced-motion: reduce) {
  .dsb-drawer-scrim,
  .dsb-drawer-scrim[data-closing="true"] { animation-duration: 1ms; }
}
.dsb-drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex: 0 0 auto;
  padding: 12px 12px 4px 20px;
}
.dsb-drawer-body {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 16px;
  flex: 1 1 auto;
  min-height: 0;
  padding: 4px 20px 20px;
  overflow-y: auto;
}
.dsb-drawer-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex: 0 0 auto;
  padding: 12px 20px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}

.dsb-title-input {
  width: 100%;
  box-sizing: border-box;
  padding: 2px 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: 500 16px/24px system-ui, -apple-system, "Segoe UI", sans-serif;
  resize: none;
  outline: none;
}
.dsb-title-input::placeholder { color: var(--dsw-alias-label-tertiary); }

.dsb-fields {
  display: grid;
  grid-template-columns: 64px 1fr;
  gap: 6px 12px;
  align-items: center;
}
.dsb-field-label {
  color: var(--dsw-alias-label-tertiary);
  font: 400 12px/20px system-ui, -apple-system, "Segoe UI", sans-serif;
}
.dsb-control {
  box-sizing: border-box;
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: 400 13px/18px system-ui, -apple-system, "Segoe UI", sans-serif;
  outline: none;
}
.dsb-control:focus-visible { border-color: var(--dsw-alias-brand-primary); }
.dsb-date { cursor: pointer; }
.dsb-date::-webkit-calendar-picker-indicator { cursor: pointer; }

.dsb-text {
  box-sizing: border-box;
  width: 100%;
  min-height: 140px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: 400 13px/20px system-ui, -apple-system, "Segoe UI", sans-serif;
  resize: vertical;
  outline: none;
}
.dsb-text:focus-visible { border-color: var(--dsw-alias-brand-primary); }
.dsb-text::placeholder { color: var(--dsw-alias-label-tertiary); }

.dsb-warn {
  color: var(--dsw-alias-label-secondary);
  font: 400 12px/18px system-ui, -apple-system, "Segoe UI", sans-serif;
}

.dsb-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1 1 auto;
  color: var(--dsw-alias-label-tertiary);
  font: 400 13px/18px system-ui, -apple-system, "Segoe UI", sans-serif;
}
`;

    const STYLE_ID = 'dsh-plugin-kanban-styles';

    /**
     * Inject the board stylesheet once. A reload re-runs this module body, so the
     * id guard is what keeps a second copy out of the document.
     */
    function ensureStyles() {
      if (document.getElementById(STYLE_ID)) return () => {};
      const element = document.createElement('style');
      element.id = STYLE_ID;
      element.textContent = CSS;
      document.head.appendChild(element);
      return () => element.remove();
    }

    // ----------------------------------------------------------------- icons

    function Icon({ d, size = 14, stroke = 1.7 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: stroke,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', flex: '0 0 auto' },
        },
        h('path', { d }),
      );
    }

    const PlusIcon = (p) => h(Icon, { ...p, d: 'M12 5v14M5 12h14' });
    const MoreIcon = (p) => h(Icon, { ...p, d: 'M6 12h.01M12 12h.01M18 12h.01', stroke: 2.2 });
    const CloseIcon = (p) => h(Icon, { ...p, d: 'M6 6l12 12M18 6L6 18' });
    const ChevronIcon = (p) => h(Icon, { ...p, d: 'M6 9l6 6 6-6' });

    // --------------------------------------------------------------- utilities

    /**
     * Call the host bridge.
     * @param {string} path - path below the bridge prefix.
     * @param {object} [body] - JSON body.
     * @returns {Promise<object>} `{ ok, board }` or `{ ok: false, error }`.
     */
    async function call(path, body) {
      const response = await fetch(`${BRIDGE_PREFIX}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        return { ok: false, error: text || `HTTP ${response.status}` };
      }
      if (!response.ok) return { ok: false, error: payload?.error ?? `HTTP ${response.status}` };
      return payload;
    }

    /** Month and day for a due date, in the browser's own locale. */
    function formatDue(iso) {
      if (!iso) return null;
      const date = new Date(`${iso}T00:00:00`);
      if (Number.isNaN(date.getTime())) return null;
      return `${date.getMonth() + 1}月${date.getDate()}日`;
    }

    /** Whether a due date is in the past. `today` is a local calendar date. */
    function isOverdue(iso) {
      if (!iso) return false;
      const today = new Date();
      const pad = (value) => String(value).padStart(2, '0');
      const local = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
      return iso < local;
    }

    /**
     * Where a pointer at `clientY` falls among the cards of one lane.
     * @param {HTMLElement|null} list - the card container.
     * @param {number} clientY - pointer position.
     * @returns {number} insertion index.
     */
    function indexAt(list, clientY) {
      if (!list) return 0;
      const cards = [...list.querySelectorAll('[data-card-id]')];
      let index = 0;
      for (const card of cards) {
        const box = card.getBoundingClientRect();
        if (clientY > box.top + box.height / 2) index += 1;
      }
      return index;
    }

    // -------------------------------------------------------------- components

    /**
     * The whole board page.
     */
    function BoardPage() {
      const [board, setBoard] = useState(null);
      const [error, setError] = useState(null);
      const [activeProjectId, setActiveProjectId] = useState(null);
      const [openCardId, setOpenCardId] = useState(null);
      const [menu, setMenu] = useState(null);
      const [dragging, setDragging] = useState(null);
      const [dropTarget, setDropTarget] = useState(null);
      /** True while the drawer plays its exit animation. */
      const [closing, setClosing] = useState(false);

      const laneRefs = useRef({});
      const closingRef = useRef(false);
      const closeTimer = useRef(null);

      const load = useCallback(async () => {
        const payload = await call('/board');
        if (payload.ok) {
          setBoard(payload.board);
          setError(null);
        } else {
          setError(payload.error ?? '读取失败');
        }
      }, []);

      useEffect(() => {
        void load();
      }, [load]);

      // The same document can be changed from the conversation (board_add_card)
      // or by another window, so re-read it whenever this view regains focus.
      useEffect(() => {
        const refresh = () => {
          if (document.visibilityState === 'hidden') return;
          void load();
        };
        window.addEventListener('focus', refresh);
        document.addEventListener('visibilitychange', refresh);
        return () => {
          window.removeEventListener('focus', refresh);
          document.removeEventListener('visibilitychange', refresh);
        };
      }, [load]);

      /** Run a mutation and adopt whatever document the host returns. */
      const mutate = useCallback(async (path, body) => {
        const payload = await call(path, body);
        if (payload.ok) {
          setBoard(payload.board);
          setError(null);
          return payload;
        }
        setError(payload.error ?? '操作失败');
        return payload;
      }, []);

      const project = useMemo(() => {
        if (!board) return null;
        return (
          board.projects.find((item) => item.id === activeProjectId) ?? board.projects[0] ?? null
        );
      }, [board, activeProjectId]);

      const openCard = useMemo(() => {
        if (!project || !openCardId) return null;
        return project.cards.find((card) => card.id === openCardId) ?? null;
      }, [project, openCardId]);

      useEffect(() => {
        if (!board) return;
        if (!board.projects.some((item) => item.id === activeProjectId)) {
          setActiveProjectId(board.projects[0]?.id ?? null);
        }
      }, [board, activeProjectId]);

      /**
       * Close the drawer. Edits save on blur, and unmounting a focused field
       * never fires one, so blur first — closing must not drop keystrokes.
       *
       * The panel stays mounted for the length of the exit animation and only
       * then unmounts, so opening and closing feel like the same motion. While
       * it is leaving, further closes are ignored.
       */
      const closeDrawer = useCallback(() => {
        if (closingRef.current) return;
        const active = document.activeElement;
        if (active && typeof active.blur === 'function') active.blur();
        closingRef.current = true;
        setClosing(true);
        closeTimer.current = setTimeout(() => {
          closeTimer.current = null;
          closingRef.current = false;
          setClosing(false);
          setOpenCardId(null);
        }, DRAWER_EXIT_MS);
      }, []);

      useEffect(
        () => () => {
          if (closeTimer.current) clearTimeout(closeTimer.current);
        },
        [],
      );

      // Escape closes whatever is on top, one layer at a time. The listener is
      // on the capture phase so the drawer wins over the shell's own Escape
      // handling: while a card is open, Escape belongs to the drawer.
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          if (menu) {
            event.preventDefault();
            event.stopPropagation();
            setMenu(null);
            return;
          }
          if (!openCardId) return;
          event.preventDefault();
          event.stopPropagation();
          closeDrawer();
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
      }, [menu, openCardId, closeDrawer]);

      const cardsOf = (columnId) => project?.cards.filter((card) => card.columnId === columnId) ?? [];

      const createCard = async (columnId) => {
        if (!project) return;
        const payload = await mutate('/card/create', { projectId: project.id, columnId, title: '' });
        if (!payload.ok || !payload.board) return;
        const nextProject = payload.board.projects.find((item) => item.id === project.id);
        const created = nextProject?.cards[nextProject.cards.length - 1];
        if (created) setOpenCardId(created.id);
      };

      const moveCard = async (cardId, columnId, index) => {
        if (!project) return;
        // Optimistic: the card jumps under the pointer immediately, then the
        // host's document replaces the guess. A rejected move snaps back on its
        // own, because the eventual setBoard carries the server's order.
        setBoard((current) => {
          if (!current) return current;
          return {
            ...current,
            projects: current.projects.map((item) => {
              if (item.id !== project.id) return item;
              const card = item.cards.find((candidate) => candidate.id === cardId);
              if (!card) return item;
              const rest = item.cards.filter((candidate) => candidate.id !== cardId);
              const siblings = rest.filter((candidate) => candidate.columnId === columnId);
              const anchor = siblings[index] ?? null;
              const moved = { ...card, columnId };
              if (!anchor) return { ...item, cards: [...rest, moved] };
              const at = rest.indexOf(anchor);
              const cards = [...rest.slice(0, at), moved, ...rest.slice(at)];
              return { ...item, cards };
            }),
          };
        });
        await mutate('/card/move', { projectId: project.id, cardId, columnId, index });
      };

      const onDragStart = (event, card) => {
        setDragging(card.id);
        event.dataTransfer.effectAllowed = 'move';
        // Firefox refuses to start a drag without data on the transfer.
        event.dataTransfer.setData('text/plain', card.id);
      };

      const onDragEnd = () => {
        setDragging(null);
        setDropTarget(null);
      };

      const onLaneDragOver = (event, column) => {
        if (!dragging) return;
        event.preventDefault();
        const list = laneRefs.current[column.id] ?? null;
        setDropTarget({ columnId: column.id, index: indexAt(list, event.clientY) });
      };

      const onLaneDrop = (event, column) => {
        event.preventDefault();
        const cardId = dragging;
        const index = dropTarget?.columnId === column.id ? dropTarget.index : cardsOf(column.id).length;
        setDragging(null);
        setDropTarget(null);
        if (cardId) void moveCard(cardId, column.id, index);
      };

      if (error && !board) {
        return h('div', { className: 'dsb-root' }, h('div', { className: 'dsb-empty' }, error));
      }
      if (!board || !project) {
        return h('div', { className: 'dsb-root' }, h('div', { className: 'dsb-empty' }, '载入中'));
      }

      const totalCards = project.cards.length;

      return h(
        'div',
        { className: 'dsb-root' },

        // ---- head: project name opens the project menu; the + adds a card to
        // the first lane, which is the only place a new card can sensibly go
        // without asking a question first.
        h(
          'div',
          { className: 'dsb-head' },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 } },
            h(
              'button',
              {
                type: 'button',
                className: 'dsb-project',
                onClick: (event) => {
                  const box = event.currentTarget.getBoundingClientRect();
                  setMenu({
                    kind: 'projects',
                    x: box.left,
                    y: box.bottom + 4,
                  });
                },
                'aria-haspopup': 'menu',
                'aria-expanded': menu?.kind === 'projects',
              },
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                project.name),
              h(ChevronIcon, { size: 12 }),
            ),
            h(
              'span',
              { className: 'dsb-count', title: `${totalCards} 张卡片`, 'aria-label': `${totalCards} 张卡片` },
              String(totalCards),
            ),
          ),
        ),

        // ---- lanes
        h(
          'div',
          { className: 'dsb-lanes' },
          project.columns.map((column) =>
            h(Lane, {
              key: column.id,
              column,
              cards: cardsOf(column.id),
              draggingId: dragging,
              dropTarget: dropTarget?.columnId === column.id ? dropTarget.index : null,
              listRef: (element) => {
                laneRefs.current[column.id] = element;
              },
              onOpenCard: setOpenCardId,
              onAddCard: () => void createCard(column.id),
              onMenu: (event) => {
                const box = event.currentTarget.getBoundingClientRect();
                setMenu({
                  kind: 'column',
                  columnId: column.id,
                  x: box.right - 200,
                  y: box.bottom + 4,
                });
              },
              onDragStart,
              onDragEnd,
              onDragOverLane: onLaneDragOver,
              onDropLane: onLaneDrop,
            }),
          ),
          h(
            'div',
            { style: { flex: '0 0 auto', width: '264px' } },
            h(
              'button',
              {
                type: 'button',
                className: 'dsb-ghost',
                style: { height: '32px' },
                onClick: () => void mutate('/column/create', { projectId: project.id }),
              },
              h(PlusIcon, { size: 13 }),
              '新建列',
            ),
          ),
        ),

        // ---- menus. The key remounts the layer whenever a different menu opens,
        // so a half-finished rename or delete-confirm never carries over.
        menu && h(MenuLayer, {
          key: menu.kind === 'column' ? `column:${menu.columnId}` : 'projects',
          menu,
          project,
          board,
          onClose: () => setMenu(null),
          onSelectProject: (id) => {
            setActiveProjectId(id);
            setMenu(null);
          },
          onCreateProject: async () => {
            setMenu(null);
            const payload = await mutate('/project/create', {});
            const next = payload.board?.projects[payload.board.projects.length - 1];
            if (next) setActiveProjectId(next.id);
          },
          onDeleteProject: async () => {
            setMenu(null);
            const payload = await mutate('/project/delete', { projectId: project.id });
            if (payload.ok) setActiveProjectId(payload.board.projects[0]?.id ?? null);
          },
          onRenameColumn: async (name) => {
            setMenu(null);
            await mutate('/column/update', { projectId: project.id, columnId: menu.columnId, name });
          },
          onDeleteColumn: async () => {
            setMenu(null);
            await mutate('/column/delete', { projectId: project.id, columnId: menu.columnId });
          },
        }),

        // ---- drawer: a frosted scrim over the board, then the panel itself.
        // The scrim is a button so clicking the dimmed area closes the card,
        // which is what the shadow implies it does.
        openCard &&
          h(
            React.Fragment,
            null,
            h('button', {
              key: 'drawer-scrim',
              type: 'button',
              className: 'dsb-drawer-scrim',
              'aria-label': '关闭卡片详情',
              'data-closing': closing ? 'true' : undefined,
              onClick: closeDrawer,
            }),
            h(CardDrawer, {
              key: openCard.id,
              card: openCard,
              project,
              closing,
              onClose: closeDrawer,
              onChange: (patch) =>
                void mutate('/card/update', { projectId: project.id, cardId: openCard.id, ...patch }),
              onMove: (columnId) =>
                void mutate('/card/move', {
                  projectId: project.id,
                  cardId: openCard.id,
                  columnId,
                  index: 0,
                }),
              onDelete: async () => {
                await mutate('/card/delete', { projectId: project.id, cardId: openCard.id });
                setOpenCardId(null);
              },
            }),
          ),

        error &&
          h(
            'div',
            {
              role: 'status',
              style: {
                position: 'absolute',
                left: '20px',
                bottom: '16px',
                zIndex: 30,
                padding: '6px 10px',
                borderRadius: '8px',
                border: '1px solid var(--dsw-alias-border-l2)',
                background: 'var(--dsw-alias-bg-layer-3)',
                color: 'var(--dsw-alias-label-secondary)',
                font: '400 12px/18px system-ui, -apple-system, "Segoe UI", sans-serif',
              },
            },
            error,
          ),
      );
    }

    /**
     * One lane: header, card list, footer add button.
     */
    function Lane(props) {
      const {
        column,
        cards,
        draggingId,
        dropTarget,
        listRef,
        onOpenCard,
        onAddCard,
        onMenu,
        onDragStart,
        onDragEnd,
        onDragOverLane,
        onDropLane,
      } = props;

      const [over, setOver] = useState(false);

      const rows = [];
      cards.forEach((card, index) => {
        if (dropTarget === index) rows.push(h('div', { key: `drop-${index}`, className: 'dsb-drop' }));
        rows.push(
          h(Card, {
            key: card.id,
            card,
            done: column.isFinal,
            dragging: draggingId === card.id,
            onOpen: () => onOpenCard(card.id),
            onDragStart: (event) => onDragStart(event, card),
            onDragEnd,
          }),
        );
      });
      if (dropTarget === cards.length) {
        rows.push(h('div', { key: 'drop-end', className: 'dsb-drop' }));
      }

      return h(
        'section',
        {
          className: 'dsb-lane',
          'data-over': over && draggingId ? 'true' : 'false',
          'aria-label': column.name,
          onDragOver: (event) => {
            setOver(true);
            onDragOverLane(event, column);
          },
          onDragLeave: (event) => {
            if (event.currentTarget.contains(event.relatedTarget)) return;
            setOver(false);
          },
          onDrop: (event) => {
            setOver(false);
            onDropLane(event, column);
          },
        },
        h(
          'div',
          { className: 'dsb-lane-head' },
          h('span', { className: 'dsb-lane-name' }, column.name),
          h('span', { className: 'dsb-lane-count' }, String(cards.length)),
          h(
            'button',
            {
              type: 'button',
              className: 'dsb-icon-btn',
              onClick: onAddCard,
              title: '新建卡片',
              'aria-label': `在「${column.name}」新建卡片`,
            },
            h(PlusIcon, { size: 14 }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsb-icon-btn',
              onClick: onMenu,
              title: '列操作',
              'aria-label': `「${column.name}」的列操作`,
              'aria-haspopup': 'menu',
            },
            h(MoreIcon, { size: 14 }),
          ),
        ),
        h('div', { className: 'dsb-cards', ref: listRef }, rows),
      );
    }

    /**
     * One card. Draggable, clickable, keyboard-openable.
     */
    function Card({ card, done, dragging, onOpen, onDragStart, onDragEnd }) {
      const due = formatDue(card.dueDate);
      const overdue = isOverdue(card.dueDate);
      return h(
        'div',
        {
          className: 'dsb-card',
          'data-card-id': card.id,
          'data-dragging': dragging ? 'true' : 'false',
          'data-done': done ? 'true' : 'false',
          draggable: true,
          tabIndex: 0,
          role: 'button',
          onDragStart,
          onDragEnd,
          onClick: onOpen,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onOpen();
            }
          },
        },
        h(
          'div',
          { className: 'dsb-card-top' },
          h('span', { className: 'dsb-card-id' }, `#${card.number}`),
          card.priority
            ? h('span', {
                className: 'dsb-card-dot',
                style: { background: PRIORITY_COLOR[card.priority] ?? 'var(--dsw-alias-label-tertiary)' },
                title: PRIORITIES.find((item) => item.id === card.priority)?.label,
              })
            : null,
        ),
        h('div', { className: 'dsb-card-title' }, card.title || '未命名'),
        due &&
          h(
            'div',
            { className: 'dsb-card-foot' },
            h('span', { className: 'dsb-chip', 'data-overdue': overdue ? 'true' : 'false' }, due),
          ),
      );
    }

    /**
     * The menu layer: one popover, two shapes (project switcher, column actions).
     *
     * Deletes are confirmed in place rather than through `window.confirm`: the
     * native dialog cannot say "move the cards out first", and a destructive
     * action that can only be answered yes/no tends to be answered yes.
     */
    function MenuLayer(props) {
      const { menu, project, board, onClose, onSelectProject, onCreateProject, onDeleteProject } =
        props;
      const [renaming, setRenaming] = useState(false);
      /** Which delete is waiting for its second click. */
      const [confirming, setConfirming] = useState(null);

      useEffect(() => {
        if (!renaming) return;
        const input = document.querySelector('.dsb-menu .dsb-control');
        input?.focus();
        input?.select();
      }, [renaming]);

      const style = { position: 'fixed', left: `${Math.max(8, menu.x)}px`, top: `${menu.y}px` };

      const close = h('button', {
        key: 'scrim',
        type: 'button',
        className: 'dsb-scrim',
        'aria-label': '关闭菜单',
        onClick: onClose,
      });

      /** Two-step confirm block: the question, then the two buttons. */
      const confirmBlock = (question, onConfirm) =>
        h(ConfirmDelete, { question, onConfirm, onCancel: () => setConfirming(null) });

      if (menu.kind === 'projects') {
        const projectCards = project.cards.length;
        return [
          close,
          h(
            'div',
            { key: 'menu', className: 'dsb-menu', style, role: 'menu' },
            board.projects.map((item) =>
              h(
                'button',
                {
                  key: item.id,
                  type: 'button',
                  className: 'dsb-menu-item',
                  role: 'menuitem',
                  'data-active': item.id === project.id ? 'true' : 'false',
                  onClick: () => onSelectProject(item.id),
                },
                item.name,
              ),
            ),
            h('div', { className: 'dsb-menu-sep' }),
            h(
              'button',
              {
                type: 'button',
                className: 'dsb-menu-item',
                role: 'menuitem',
                onClick: () => void onCreateProject(),
              },
              h(PlusIcon, { size: 13 }),
              '新建项目',
            ),
            board.projects.length > 1
              ? confirming === 'project'
                ? confirmBlock(
                    `删除项目「${project.name}」${projectCards ? `和其中的 ${projectCards} 张卡片` : ''}？无法撤销。`,
                    () => void onDeleteProject(),
                  )
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsb-menu-item',
                      role: 'menuitem',
                      'data-tone': 'danger',
                      onClick: () => setConfirming('project'),
                    },
                    h(CloseIcon, { size: 13 }),
                    '删除项目',
                  )
              : null,
          ),
        ];
      }

      const column = project.columns.find((item) => item.id === menu.columnId);
      const columnCards = column ? project.cards.filter((card) => card.columnId === column.id).length : 0;
      const blocked = columnCards > 0;

      return [
        close,
        h(
          'div',
          { key: 'menu', className: 'dsb-menu', style: { ...style, minWidth: '200px' }, role: 'menu' },
          renaming
            ? h(
                'div',
                { style: { padding: '4px' } },
                h('input', {
                  className: 'dsb-control',
                  defaultValue: column?.name ?? '',
                  'aria-label': '列名称',
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                      const value = event.currentTarget.value.trim();
                      if (value) void props.onRenameColumn(value);
                    }
                  },
                  onBlur: (event) => {
                    const value = event.currentTarget.value.trim();
                    if (value && value !== column?.name) void props.onRenameColumn(value);
                    else onClose();
                  },
                }),
              )
            : h(
                'button',
                {
                  type: 'button',
                  className: 'dsb-menu-item',
                  role: 'menuitem',
                  onClick: () => setRenaming(true),
                },
                '重命名',
              ),
          confirming === 'column'
            ? confirmBlock(`删除列「${column?.name ?? ''}」？无法撤销。`, () => void props.onDeleteColumn())
            : h(
                'button',
                {
                  type: 'button',
                  className: 'dsb-menu-item',
                  role: 'menuitem',
                  'data-tone': 'danger',
                  disabled: blocked,
                  title: blocked ? `「${column?.name ?? ''}」里还有 ${columnCards} 张卡片，移走或删除后才能删除这一列` : undefined,
                  onClick: () => {
                    if (blocked) return;
                    setConfirming('column');
                  },
                },
                '删除列',
                blocked ? h('span', { className: 'dsb-menu-item-meta' }, `${columnCards} 张`) : null,
              ),
        ),
      ];
    }

    /**
     * The second half of a delete: the question, then the two answers.
     *
     * Cancel takes the initial focus rather than Delete, so a stray Enter after
     * opening the menu cancels instead of confirming.
     */
    function ConfirmDelete({ question, onConfirm, onCancel }) {
      const cancelRef = useRef(null);
      useEffect(() => {
        cancelRef.current?.focus();
      }, []);
      return h(
        'div',
        { className: 'dsb-menu-confirm', role: 'group', 'aria-label': question },
        h('span', { className: 'dsb-menu-confirm-text' }, question),
        h(
          'div',
          { className: 'dsb-menu-confirm-actions' },
          h(
            'button',
            { ref: cancelRef, type: 'button', className: 'dsb-btn', onClick: onCancel },
            '取消',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsb-btn',
              'data-tone': 'danger',
              onClick: onConfirm,
            },
            '删除',
          ),
        ),
      );
    }

    /**
     * The card drawer: every field the board stores, and a delete that says what
     * it does. Edits save on blur, not on a Save button — a board has no draft
     * state, and a Save button would only exist to be forgotten.
     */
    function CardDrawer({ card, project, closing, onClose, onChange, onMove, onDelete }) {
      const [title, setTitle] = useState(card.title);
      const [description, setDescription] = useState(card.description ?? '');
      const [confirmDelete, setConfirmDelete] = useState(false);
      const titleRef = useRef(null);

      useEffect(() => {
        if (!card.title) titleRef.current?.focus();
      }, [card.title]);

      const commitTitle = () => {
        const value = title.trim();
        if (value !== card.title) void onChange({ title: value });
      };
      const commitDescription = () => {
        if (description !== (card.description ?? '')) void onChange({ description });
      };

      return h(
        'aside',
        {
          className: 'dsb-drawer',
          role: 'dialog',
          'aria-label': '卡片详情',
          'data-closing': closing ? 'true' : undefined,
        },
        h(
          'div',
          { className: 'dsb-drawer-head' },
          h('span', { className: 'dsb-card-id' }, `#${card.number}`),
          h(
            'button',
            {
              type: 'button',
              className: 'dsb-icon-btn',
              onClick: onClose,
              title: '关闭',
              'aria-label': '关闭卡片详情',
            },
            h(CloseIcon, { size: 15 }),
          ),
        ),
        h(
          'div',
          { className: 'dsb-drawer-body' },
          h('textarea', {
            ref: titleRef,
            className: 'dsb-title-input',
            value: title,
            rows: 2,
            placeholder: '卡片标题',
            'aria-label': '卡片标题',
            onChange: (event) => setTitle(event.target.value),
            onBlur: commitTitle,
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                commitTitle();
                event.currentTarget.blur();
              }
            },
          }),
          h(
            'div',
            { className: 'dsb-fields' },
            h('label', { className: 'dsb-field-label', htmlFor: 'dsb-col' }, '状态'),
            h(
              'select',
              {
                id: 'dsb-col',
                className: 'dsb-control',
                value: card.columnId,
                onChange: (event) => void onMove(event.target.value),
              },
              project.columns.map((column) =>
                h('option', { key: column.id, value: column.id }, column.name),
              ),
            ),
            h('label', { className: 'dsb-field-label', htmlFor: 'dsb-pri' }, '优先级'),
            h(
              'select',
              {
                id: 'dsb-pri',
                className: 'dsb-control',
                value: card.priority ?? '',
                onChange: (event) => void onChange({ priority: event.target.value || null }),
              },
              h('option', { value: '' }, '无'),
              PRIORITIES.map((priority) =>
                h('option', { key: priority.id, value: priority.id }, priority.label),
              ),
            ),
            h('label', { className: 'dsb-field-label', htmlFor: 'dsb-due' }, '截止'),
            // A native date input only opens its calendar from the small glyph
            // at the right edge; anywhere else the click just focuses the field.
            // Opening the picker on the field's own click makes the whole
            // control behave like the button it looks like.
            h('input', {
              id: 'dsb-due',
              type: 'date',
              className: 'dsb-control dsb-date',
              value: card.dueDate ?? '',
              onClick: (event) => {
                const input = event.currentTarget;
                if (typeof input.showPicker !== 'function') return;
                try {
                  input.showPicker();
                } catch {
                  // Already open, or refused for lacking a user gesture: the
                  // field still works, it just needs the glyph clicked.
                }
              },
              onChange: (event) => void onChange({ dueDate: event.target.value || null }),
            }),
          ),
          h('textarea', {
            className: 'dsb-text',
            value: description,
            placeholder: '描述',
            'aria-label': '卡片描述',
            onChange: (event) => setDescription(event.target.value),
            onBlur: commitDescription,
          }),
        ),
        h(
          'div',
          { className: 'dsb-drawer-foot' },
          confirmDelete
            ? h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                h('span', { className: 'dsb-warn' }, '删除后无法恢复'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsb-btn',
                    'data-tone': 'danger',
                    onClick: () => void onDelete(),
                  },
                  '删除',
                ),
                h(
                  'button',
                  { type: 'button', className: 'dsb-btn', onClick: () => setConfirmDelete(false) },
                  '取消',
                ),
              )
            : h(
                'button',
                {
                  type: 'button',
                  className: 'dsb-btn',
                  'data-tone': 'danger',
                  onClick: () => setConfirmDelete(true),
                },
                '删除卡片',
              ),
        ),
      );
    }

    /** The 18px glyph the sidebar row draws. */
    function BoardIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18;
      const active = props?.active === true;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('rect', {
          x: 3.5,
          y: 4.5,
          width: 5,
          height: 15,
          rx: 1.4,
          stroke: 'currentColor',
          strokeWidth: 1.5,
          opacity: active ? 1 : 0.85,
        }),
        h('rect', {
          x: 10.5,
          y: 4.5,
          width: 5,
          height: 10,
          rx: 1.4,
          stroke: 'currentColor',
          strokeWidth: 1.5,
          opacity: active ? 1 : 0.85,
        }),
        h('rect', {
          x: 17.5,
          y: 4.5,
          width: 3,
          height: 6.5,
          rx: 1.2,
          stroke: 'currentColor',
          strokeWidth: 1.5,
          opacity: active ? 0.85 : 0.7,
        }),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The stylesheet lives as long as the plugin does.
        if (typeof ctx.effect === 'function') ctx.effect(ensureStyles);
        else ensureStyles();

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, BoardPage),
        );
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 50, label: '看板' },
            BoardIcon,
          ),
        );
      },
    };
  },
});
