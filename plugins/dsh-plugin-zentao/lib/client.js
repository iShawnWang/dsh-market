/* global window */
/**
 * Browser side of the ZenTao panel.
 *
 * The page has two jobs: set up the connection once, then read the "assigned to
 * me" list. Everything that touches ZenTao happens on the host — this file only
 * talks to the local bridge, so no cookie and no password ever reach the page.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-zentao',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const PANEL_ID = 'dsh-plugin-zentao';
    const BRIDGE_PREFIX = '/api/dsh-plugin-zentao';

    /** Call one bridge route; bridge errors come back as data, never as throws. */
    async function callBridge(path, body) {
      try {
        const response = await fetch(BRIDGE_PREFIX + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        });
        const text = await response.text();
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          return { ok: false, error: text || `HTTP ${response.status}` };
        }
        if (!response.ok) return { ok: false, error: payload?.error ?? `HTTP ${response.status}` };
        return payload;
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    }

    /** Headline fields shown as chips; the table below lists everything else. */
    const CHIP_LABELS = ['Bug类型', '严重程度', '优先级', 'Bug状态', '所属产品', '当前指派'];

    /** ZenTao writes these placeholders for fields it never set. */
    const EMPTY_VALUES = new Set(['', '0000-00-00', '0000-00-00 00:00:00']);
    const isPresent = (value) => !EMPTY_VALUES.has(String(value ?? '').trim());

    /* A stored password is shown as a run of dots as long as the secret itself,
       the way a password field says "something is already here". The host sends
       only the length, never a preview. An inherited secret reports no length,
       so the mask falls back to a fixed run that claims nothing about it. */
    const PASSWORD_MASK_FALLBACK = '••••••••';
    function passwordMask(length) {
      return typeof length === 'number' && length > 0
        ? '•'.repeat(length)
        : PASSWORD_MASK_FALLBACK;
    }

    /* Content width is a user choice, not a side effect of padding maths: the
       page sets one custom property and every column reads it. */
    const WIDTH_STORAGE_KEY = 'dsh-plugin-zentao.width';
    /* Two tiers, both a max-width: a third "full" tier would render exactly
       like the second one on any window narrower than ~1300px. */
    const WIDTH_PRESETS = [
      { id: 'standard', label: '标准', max: '960px' },
      { id: 'wide', label: '宽', max: '1200px' },
    ];
    const WIDTH_DEFAULT = 'wide';
    const WIDTH_FALLBACK_PRESET = WIDTH_PRESETS[WIDTH_PRESETS.length - 1];
    const WIDTH_FALLBACK_MAX = '1200px';

    function readStoredWidth() {
      try {
        const stored = window.localStorage.getItem(WIDTH_STORAGE_KEY);
        return WIDTH_PRESETS.some((preset) => preset.id === stored) ? stored : WIDTH_DEFAULT;
      } catch {
        return WIDTH_DEFAULT;
      }
    }

    function storeWidth(id) {
      try {
        window.localStorage.setItem(WIDTH_STORAGE_KEY, id);
      } catch {
        /* A blocked localStorage must not break the panel. */
      }
    }

    const SEVERITY_LABEL = { 1: '致命', 2: '严重', 3: '一般', 4: '建议' };
    const SEVERITY_COLOR = {
      1: 'var(--dsw-alias-state-error-primary)',
      2: 'var(--dsw-alias-state-error-primary)',
      3: 'var(--dsw-alias-state-warn-label)',
      4: 'var(--dsw-alias-label-tertiary)',
    };

    const styles = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 auto',
        height: '100%',
        minHeight: '100%',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        font: '14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif',
        overflow: 'auto',
        scrollbarGutter: 'stable',
      },
      column: {
        boxSizing: 'border-box',
        width: '100%',
        maxWidth: `var(--zt-content-max, ${WIDTH_FALLBACK_MAX})`,
        margin: '0 auto',
        padding: '0 clamp(20px, 4vw, 40px) 48px',
        display: 'flex',
        flexDirection: 'column',
        gap: '20px',
      },
      /* Long-form text keeps a reading measure even when the column goes wide.
         Left-aligned on purpose: centred, the narrower text blocks would not
         line up with the sections above and below them. */
      /* Cards span the same width as the header's action row, so their right
         edge lines up with the last button instead of stopping short. */
      prose: {
        boxSizing: 'border-box',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: '20px',
      },
      heading: {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '12px',
        rowGap: '8px',
        paddingTop: '28px',
      },
      pageTitle: {
        margin: 0,
        flexShrink: 0,
        whiteSpace: 'nowrap',
        fontWeight: 500,
        fontSize: '20px',
        lineHeight: '28px',
      },
      count: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '13px' },
      spacer: { flex: '1 1 auto' },
      iconButton: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
        width: '32px',
        height: '32px',
        padding: 0,
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '8px',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
      },
      list: { display: 'flex', flexDirection: 'column', gap: '2px' },
      widthMenu: {
        position: 'absolute',
        top: 'calc(100% + 6px)',
        right: 0,
        zIndex: 2,
        minWidth: '168px',
        padding: '6px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1)',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
      },
      widthOption: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        padding: '6px 8px',
        border: 0,
        borderRadius: '8px',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      },
      widthCheck: { flex: 'none', width: '16px', color: 'var(--dsw-alias-label-primary)' },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        width: '100%',
        padding: '8px',
        border: 0,
        borderRadius: '12px',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      },
      separator: { height: '1px', margin: '0 8px', background: 'var(--dsw-alias-border-l3)' },
      dot: { flex: 'none', width: '8px', height: '8px', borderRadius: '50%' },
      id: {
        flex: 'none',
        font: '12px/20px ui-monospace, SFMono-Regular, monospace',
        color: 'var(--dsw-alias-label-tertiary)',
        minWidth: '48px',
      },
      rowTitle: {
        flex: '1 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontWeight: 500,
      },
      tag: {
        flex: 'none',
        padding: '1px 8px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        whiteSpace: 'nowrap',
      },
      empty: { padding: '32px 8px', color: 'var(--dsw-alias-label-tertiary)' },
      /* Placeholder blocks hold the space the real content will occupy, so the
         panel does not jump from one screenful to three when the detail lands. */
      skeleton: {
        borderRadius: '12px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      },
      skeletonLine: {
        height: '13px',
        borderRadius: '6px',
        background: 'var(--dsw-alias-border-l3)',
        opacity: 0.55,
      },
      skeletonChips: { display: 'flex', flexWrap: 'wrap', gap: '6px 10px' },
      error: {
        padding: '12px 8px',
        color: 'var(--dsw-alias-state-error-primary)',
        overflowWrap: 'anywhere',
      },
      field: { display: 'flex', flexDirection: 'column', gap: '6px' },
      label: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' },
      input: {
        height: '34px',
        padding: '0 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: '13px',
      },
      primaryButton: {
        height: '34px',
        padding: '0 16px',
        borderRadius: '8px',
        border: '1px solid transparent',
        background: 'var(--dsw-alias-label-primary)',
        color: 'var(--dsw-alias-bg-base)',
        font: '500 13px/1 inherit',
        cursor: 'pointer',
      },
      quietButton: {
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        height: '34px',
        padding: '0 12px',
        whiteSpace: 'nowrap',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: '13px',
        cursor: 'pointer',
      },
      formWrap: {
        boxSizing: 'border-box',
        width: '100%',
        maxWidth: `var(--zt-content-max, ${WIDTH_FALLBACK_MAX})`,
        margin: '0 auto',
        padding: '0 clamp(20px, 4vw, 40px)',
      },
      form: {
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        maxWidth: '420px',
        margin: '28px auto 0',
        width: '100%',
      },
      formTitle: { margin: 0, fontWeight: 500, fontSize: '17px' },
      formActions: { display: 'flex', gap: '8px', marginTop: '4px' },
      detailHead: { display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '28px' },
      detailActions: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px', rowGap: '8px' },
      buttonLabel: { display: 'inline-flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' },
      detailTitleRow: { display: 'flex', alignItems: 'flex-start', gap: '10px' },
      detailTitle: { margin: 0, fontWeight: 500, fontSize: '18px', lineHeight: '26px', flex: '1 1 auto' },
      chips: { display: 'flex', flexWrap: 'wrap', gap: '6px 10px' },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '2px 10px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
      },
      section: {
        padding: '14px 16px',
        borderRadius: '12px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      sectionTitle: { margin: '0 0 8px', fontWeight: 500, fontSize: '14px', color: 'var(--dsw-alias-label-secondary)' },
      historyItem: { display: 'flex', flexDirection: 'column', gap: '4px', padding: '8px', borderRadius: '10px' },
      historyMeta: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
      historyChange: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' },
      kv: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', fontSize: '13px' },
      kvLabel: { color: 'var(--dsw-alias-label-tertiary)' },
      kvValue: { color: 'var(--dsw-alias-label-primary)', overflowWrap: 'anywhere' },
    };

    /* scoped rules for the sanitized ZenTao article: it is raw HTML, so it
       cannot carry inline styles of its own. */
    const ARTICLE_CSS = `
      /* vertical-align: bottom on both the picture and its placeholder: an
         inline image otherwise sits on the text baseline and adds a descender's
         worth of height, so swapping one for the other shifts the article. */
      .zt-article img { max-width: 100%; max-height: 420px; width: auto; height: auto; border-radius: 8px; cursor: zoom-in; vertical-align: bottom; }
      /* A picture still downloading keeps the box it will occupy: the host
         probed the header, so the placeholder carries the real aspect ratio and
         the article does not reflow when the bitmap lands. */
      .zt-article [data-zt-pending] { display: inline-block; vertical-align: bottom; max-width: 100%; max-height: 420px; border-radius: 8px; background: var(--dsw-alias-border-l3); opacity: 0.55; }
      .zt-article img.zt-zoom { max-height: none; cursor: zoom-out; }
      .zt-article p { margin: 0 0 8px; }
      .zt-article p:last-child { margin-bottom: 0; }
      .zt-article [data-zt-step] { color: var(--dsw-alias-label-secondary); font-weight: 500; margin: 12px 0 4px; }
      .zt-article [data-zt-step]:first-child { margin-top: 0; }
      .zt-article pre, .zt-article code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; }
      .zt-article pre { background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 10px; overflow: auto; }
      .zt-article blockquote { margin: 8px 0; padding: 4px 12px; border-left: 2px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
      .zt-article table { border-collapse: collapse; width: 100%; font-size: 13px; }
      .zt-article th, .zt-article td { border: 1px solid var(--dsw-alias-border-l2); padding: 4px 8px; text-align: left; }
      .zt-article a { color: var(--dsw-alias-link); text-decoration: underline; text-underline-offset: 2px; }
    `;

    function RefreshIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M20 12a8 8 0 1 1-2.34-5.66' }),
        h('path', { d: 'M20 4v5h-5' }),
      );
    }

    function SettingsIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('circle', { cx: 12, cy: 12, r: 3 }),
        h('path', { d: 'M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 15a2 2 0 1 1 0-4 1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9 4.6V4a2 2 0 1 1 4 0v.6a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.6a1.6 1.6 0 0 0-1 .7z' }),
      );
    }

    function BackIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M15 18l-6-6 6-6' }),
      );
    }

    /* A frame with the content column inside it: the inner bar grows with the
       tier, so the current width is visible without reading the tooltip. */
    const WIDTH_ICON_INNER = { standard: [6.5, 11], wide: [3.5, 17] };

    function WidthIcon({ preset }) {
      const [x, width] = WIDTH_ICON_INNER[preset] ?? WIDTH_ICON_INNER.wide;
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 2.5, y: 4.5, width: 19, height: 15, rx: 2.5, opacity: 0.55 }),
        h('rect', { x, y: 7.5, width, height: 9, rx: 1.5 }),
      );
    }

    function CheckIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M3 8.5l3.2 3.2L13 5' }),
      );
    }

    function IconButton({ label, onClick, disabled, expanded, children }) {
      const [hover, setHover] = useState(false);
      return h(
        'button',
        {
          type: 'button',
          title: label,
          'aria-label': label,
          ...(typeof expanded === 'boolean'
            ? { 'aria-expanded': expanded, 'aria-haspopup': 'menu' }
            : null),
          onClick,
          disabled,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            ...styles.iconButton,
            ...(hover && !disabled ? { background: 'var(--dsw-alias-interactive-bg-hover)' } : null),
            ...(disabled ? { opacity: 0.5, cursor: 'default' } : null),
          },
        },
        children,
      );
    }

    /** One row of the width menu; inline styles have no :hover, so it is state. */
    function WidthOption({ preset, selected, onSelect }) {
      const [hover, setHover] = useState(false);
      return h(
        'button',
        {
          type: 'button',
          role: 'menuitemradio',
          'aria-checked': selected,
          onClick: onSelect,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: { ...styles.widthOption, ...(hover ? { background: 'var(--dsw-alias-interactive-bg-hover)' } : null) },
        },
        h('span', { style: styles.widthCheck }, selected ? h(CheckIcon) : null),
        preset.label,
      );
    }

    /** Width is the one layout choice the panel exposes; it lives in the header. */
    function WidthMenu({ value, onChange }) {
      const [open, setOpen] = useState(false);
      const wrapRef = useRef(null);
      const active = WIDTH_PRESETS.find((preset) => preset.id === value) ?? WIDTH_FALLBACK_PRESET;
      /* Closing unmounts the item that had focus; without this the caret lands
         on <body> and the next Tab restarts from the top of the panel. */
      const close = useCallback((restoreFocus) => {
        setOpen(false);
        if (restoreFocus) wrapRef.current?.querySelector('button')?.focus();
      }, []);

      useEffect(() => {
        if (!open) return undefined;
        const menu = wrapRef.current?.querySelector('[role="menu"]');
        const target = menu?.querySelector('[aria-checked="true"]') ?? menu?.querySelector('[role="menuitemradio"]');
        target?.focus();
        const onPointerDown = (event) => {
          if (!wrapRef.current?.contains(event.target)) close(false);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            close(true);
            return;
          }
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          const items = [...(menu?.querySelectorAll('[role="menuitemradio"]') ?? [])];
          if (!items.length) return;
          event.preventDefault();
          const at = items.indexOf(window.document.activeElement);
          const step = event.key === 'ArrowDown' ? 1 : -1;
          items[(at + step + items.length) % items.length].focus();
        };
        window.document.addEventListener('mousedown', onPointerDown);
        window.document.addEventListener('keydown', onKeyDown);
        return () => {
          window.document.removeEventListener('mousedown', onPointerDown);
          window.document.removeEventListener('keydown', onKeyDown);
        };
      }, [open, close]);

      return h(
        'div',
        { ref: wrapRef, style: { position: 'relative', display: 'inline-flex' } },
        h(IconButton, {
          label: `宽度：${active.label}`,
          expanded: open,
          onClick: () => (open ? close(true) : setOpen(true)),
        }, h(WidthIcon, { preset: active.id })),
        open
          ? h('div', { style: styles.widthMenu, role: 'menu', 'aria-label': '内容宽度' },
            ...WIDTH_PRESETS.map((preset) => h(WidthOption, {
              key: preset.id,
              preset,
              selected: preset.id === value,
              onSelect: () => {
                onChange(preset.id);
                close(true);
              },
            })))
          : null,
      );
    }

    /** Severity arrives as "3"; the list spells it out, so the chips must too. */
    function chipValue(item) {
      if (item.label !== '严重程度') return item.value;
      const digits = String(item.value).match(/^\s*(\d)/);
      if (!digits) return item.value;
      const spelled = SEVERITY_LABEL[digits[1]];
      return spelled ? `${digits[1]} ${spelled}` : item.value;
    }

    function BugRow({ bug, onOpen }) {
      const [hover, setHover] = useState(false);
      return h(
        'button',
        {
          type: 'button',
          onClick: () => onOpen(bug.id),
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: { ...styles.row, ...(hover ? { background: 'var(--dsw-alias-interactive-bg-hover)' } : null) },
        },
        h('span', {
          style: { ...styles.dot, background: SEVERITY_COLOR[bug.severity] ?? 'var(--dsw-alias-label-tertiary)' },
          title: `严重程度 ${SEVERITY_LABEL[bug.severity] ?? bug.severity}`,
        }),
        h('span', { style: styles.id }, bug.id),
        h('span', { style: styles.rowTitle, title: bug.title || '' }, bug.title || '(无标题)'),
        bug.type ? h('span', { style: styles.tag }, bug.type) : null,
      );
    }

    function Section({ title, children }) {
      return h(
        'section',
        { style: styles.section },
        title ? h('h2', { style: styles.sectionTitle }, title) : null,
        children,
      );
    }

    function SetupForm({ open, settings, credential, onSaved, onCancel }) {
      const [baseUrl, setBaseUrl] = useState(settings.baseUrl ?? '');
      const [username, setUsername] = useState(settings.username ?? '');
      const [password, setPassword] = useState('');
      const [typingPassword, setTypingPassword] = useState(false);
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState('');
      const firstField = useRef(null);

      useEffect(() => {
        if (!open) return;
        setBaseUrl(settings.baseUrl ?? '');
        setUsername(settings.username ?? '');
        setPassword('');
        setTypingPassword(false);
        setError('');
        const timer = window.setTimeout(() => firstField.current?.focus(), 0);
        return () => window.clearTimeout(timer);
      }, [open, settings.baseUrl, settings.username]);

      const submit = async (event) => {
        event.preventDefault();
        if (saving) return;
        setSaving(true);
        setError('');
        /* The field holds a mask, not the secret, while the user has not typed
           anything: only a freshly typed value may be stored. */
        const typed = typingPassword ? password.trim() : '';
        const saved = await callBridge('/settings', { baseUrl, username });
        if (!saved.ok) {
          setSaving(false);
          setError(saved.error ?? '保存失败');
          return;
        }
        if (!typed && !credential.configured) {
          setSaving(false);
          setError('请填写密码');
          return;
        }
        /* The /settings reply predates the password write, so its `configured`
           is stale; the /password reply is the one that reflects both. */
        let current = saved;
        if (typed) {
          const stored = await callBridge('/password', { password: typed });
          if (!stored.ok) {
            setSaving(false);
            setError(stored.error ?? '保存密码失败');
            return;
          }
          current = stored;
        }
        setSaving(false);
        onSaved(current);
      };

      return h(
        'form',
        { style: styles.form, onSubmit: submit },
        h('h1', { style: styles.formTitle }, open ? '禅道连接' : '连接禅道'),
        h(
          'div',
          { style: styles.field },
          h('label', { style: styles.label, htmlFor: 'zt-baseurl' }, '地址'),
          h('input', {
            id: 'zt-baseurl',
            ref: firstField,
            style: styles.input,
            value: baseUrl,
            placeholder: 'http://10.10.254.52/zentao',
            autoComplete: 'off',
            spellCheck: false,
            onChange: (event) => setBaseUrl(event.target.value),
          }),
        ),
        h(
          'div',
          { style: styles.field },
          h('label', { style: styles.label, htmlFor: 'zt-username' }, '账号'),
          h('input', {
            id: 'zt-username',
            style: styles.input,
            value: username,
            autoComplete: 'username',
            spellCheck: false,
            onChange: (event) => setUsername(event.target.value),
          }),
        ),
        h(
          'div',
          { style: styles.field },
          h('label', { style: styles.label, htmlFor: 'zt-password' }, '密码'),
          h('input', {
            id: 'zt-password',
            style: styles.input,
            type: 'password',
            /* A stored password shows as a mask of its own length; the field
               only switches to a real value once the user starts typing, so an
               untouched form can never overwrite the stored secret. */
            value: typingPassword
              ? password
              : (credential.configured ? passwordMask(credential.maskLength) : ''),
            placeholder: '',
            autoComplete: 'current-password',
            spellCheck: false,
            onFocus: () => {
              if (typingPassword || !credential.configured) return;
              setTypingPassword(true);
              setPassword('');
            },
            onBlur: () => {
              /* Leaving an untouched field puts the mask back: an empty box
                 would read as "no password stored". */
              if (!typingPassword || password) return;
              setTypingPassword(false);
            },
            onChange: (event) => {
              if (!typingPassword) setTypingPassword(true);
              setPassword(event.target.value);
            },
          }),
        ),
        error ? h('p', { style: { ...styles.error, padding: '0', margin: 0 }, role: 'alert' }, error) : null,
        h(
          'div',
          { style: styles.formActions },
          h('button', { type: 'submit', style: styles.primaryButton, disabled: saving }, saving ? '连接中…' : '连接'),
          open ? h('button', { type: 'button', style: styles.quietButton, onClick: onCancel, disabled: saving }, '取消') : null,
        ),
      );
    }

    /**
     * The article is raw ZenTao HTML: screenshots expand on click, and links
     * open in a new tab instead of navigating the panel (and the whole app) away.
     */
    function handleArticleClick(event) {
      const link = event?.target?.closest?.('a[href]');
      if (link) {
        event.preventDefault();
        const href = link.getAttribute('href');
        if (href && !href.startsWith('#')) window.open(href, '_blank', 'noopener,noreferrer');
        return;
      }
      const node = event?.target;
      if (node?.tagName !== 'IMG') return;
      node.classList.toggle('zt-zoom');
    }

    /* The host sends the article before its screenshots: each picture is a
       sized placeholder that turns into the real bitmap the moment its bytes
       arrive. Rebuilding the fragment per render is cheap at these sizes and
       keeps the swap declarative. */
    const PENDING_IMAGE = /<span data-zt-src="([^"]+)"[^>]*><\/span>/g;
    function fillImages(html, images) {
      if (!images) return html;
      return String(html ?? '').replace(PENDING_IMAGE, (placeholder, src) => {
        const payload = images[src];
        if (!payload) return placeholder;
        /* A failed fetch removes the box instead of leaving a grey rectangle
           that will never fill. */
        if (!payload.ok) return '';
        const size = payload.width && payload.height
          ? ` width="${payload.width}" height="${payload.height}"`
          : '';
        return `<img src="${payload.dataUrl}" alt=""${size} />`;
      });
    }

    function ArticleBlock({ article, images }) {
      if (!article?.html) return null;
      return h(Section, { title: article.heading || '重现步骤' }, h('div', {
        className: 'zt-article',
        style: { fontSize: '13px', color: 'var(--dsw-alias-label-primary)', overflowWrap: 'anywhere' },
        onClick: handleArticleClick,
        dangerouslySetInnerHTML: { __html: fillImages(article.html, images) },
      }));
    }

    /* The action row of the detail header; the loading and failure states reuse
       it so the back button keeps the same size in every state. */
    function DetailActions({ onBack, children }) {
      return h('div', { style: styles.detailHead },
        h('div', { style: styles.detailActions },
          h('button', { type: 'button', style: styles.quietButton, onClick: onBack, 'aria-label': '返回列表' },
            h('span', { style: styles.buttonLabel }, h(BackIcon), '返回')),
          children));
    }

    /* A row of grey bars shaped like the content that is about to arrive. The
       header comes from the list row we already have, so only the body is
       guessed — a spinner here would collapse the page and snap it back. */
    function DetailSkeleton({ bug }) {
      const bar = (key, width, height = 13) => h('div', {
        key,
        'data-zt-skeleton': '1',
        style: { ...styles.skeletonLine, width, height },
      });
      return h(
        'div',
        { style: styles.column },
        h(
          'div',
          { style: styles.detailHead },
          h(DetailActions, { onBack: bug.onBack },
            h('span', { style: styles.id }, bug.id),
            h('span', { style: styles.spacer })),
          /* The list row already knows the id and the title, so show them for
             real; only what the list never carried is drawn as a placeholder. */
          h('div', { style: styles.detailTitleRow },
            bug.title
              ? h('h1', { style: styles.detailTitle }, bug.title)
              : bar('title', '70%', 26)),
          h('div', { style: styles.skeletonChips },
            ...[72, 84, 64, 96].map((width, index) => h('div', {
              key: `chip-${index}`,
              'data-zt-skeleton': '1',
              style: { ...styles.skeletonLine, width: `${width}px`, height: '22px', borderRadius: '999px' },
            }))),
        ),
        h(
          'div',
          { style: styles.prose },
          h('div', { style: styles.skeleton },
            bar('s1', '40%'),
            bar('s2', '100%'),
            bar('s3', '92%'),
            h('div', {
              'data-zt-skeleton': '1',
              style: { height: '420px', borderRadius: '8px', background: 'var(--dsw-alias-border-l3)', opacity: 0.55 },
            }),
            bar('s4', '60%')),
          h('div', { style: styles.skeleton },
            bar('h1', '30%', 15),
            bar('h2', '72%'),
            bar('h3', '58%')),
        ),
        h('style', null, ARTICLE_CSS),
      );
    }

    function DetailView({ detail, images, loading, error, onBack, fallback }) {
      if (loading) return h(DetailSkeleton, { bug: { ...fallback, onBack } });
      if (error || !detail) {
        return h(
          'div',
          { style: styles.column },
          h(DetailActions, { onBack }),
          h('p', { style: styles.error, role: 'alert' }, error || '没读到这个 Bug'),
        );
      }
      const basic = detail.fields ?? [];
      /* Chipped fields live in the header; everything else — including the
         create/resolve/close trail — belongs in the table below. */
      const rest = [...basic, ...(detail.life ?? [])]
        .filter((item) => !CHIP_LABELS.includes(item.label) && isPresent(item.value));
      return h(
        'div',
        { style: styles.column },
        h(
          'div',
          { style: styles.detailHead },
          h(DetailActions, { onBack },
            h('span', { style: styles.id }, detail.id),
            h('span', { style: styles.spacer }),
            detail.url
              ? h('a', {
                href: detail.url,
                target: '_blank',
                rel: 'noopener noreferrer',
                style: { ...styles.quietButton, display: 'inline-flex', alignItems: 'center', textDecoration: 'none', color: 'var(--dsw-alias-label-secondary)' },
              }, '在禅道打开')
              : null),
          h('div', { style: styles.detailTitleRow }, h('h1', { style: styles.detailTitle }, detail.title)),
          h('div', { style: styles.chips }, ...basic
            .filter((item) => CHIP_LABELS.includes(item.label) && isPresent(item.value))
            .map((item) => h('span', { key: item.label, style: styles.chip },
              h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, item.label),
              h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, chipValue(item))))),
        ),
        h('div', { style: styles.prose },
          h(ArticleBlock, { article: detail.article, images }),
          (detail.history ?? []).length
            ? h(Section, { title: '动态' }, ...detail.history.map((item, index) => h(
              React.Fragment,
              { key: `${item.time}-${index}` },
              index > 0 ? h('div', { style: styles.separator }) : null,
              h(
                'div',
                { style: styles.historyItem },
                h('div', { style: styles.historyMeta }, [item.time, item.actor, item.action].filter(Boolean).join(' · ')),
                ...item.changes.map((change, changeIndex) => h('div', { key: changeIndex, style: styles.historyChange }, change)),
                item.comment
                  ? h('div', {
                    className: 'zt-article',
                    style: { fontSize: '13px', overflowWrap: 'anywhere' },
                    onClick: handleArticleClick,
                    dangerouslySetInnerHTML: { __html: fillImages(item.comment, images) },
                  })
                  : null,
              ),
            )))
            : null,
          rest.length
            ? h(Section, { title: '属性' }, h('div', { style: styles.kv }, ...rest.flatMap((item) => [
              h('div', { key: `${item.label}-k`, style: styles.kvLabel }, item.label),
              h('div', { key: `${item.label}-v`, style: styles.kvValue }, item.value),
            ])))
            : null,
        ),
        h('style', null, ARTICLE_CSS),
      );
    }

    function ZentaoPanelPage() {
      const [state, setState] = useState(null);
      const [bugs, setBugs] = useState([]);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState('');
      const [editing, setEditing] = useState(false);
      const [detail, setDetail] = useState(null);
      /* Resolved attachments keyed by their ZenTao src; each one lands on its
         own, so the article is readable long before the pictures are. */
      const [images, setImages] = useState({});
      const [detailLoading, setDetailLoading] = useState(false);
      const [detailError, setDetailError] = useState('');
      const [openId, setOpenId] = useState('');
      const [fetchedAt, setFetchedAt] = useState('');
      const [width, setWidth] = useState(readStoredWidth);
      /* The list and the detail share one scrolling pane, so switching views has
         to move the scroll position explicitly. */
      const paneRef = useRef(null);
      const listScroll = useRef(0);

      const loadState = useCallback(async () => {
        const next = await callBridge('/state');
        if (!next.ok) {
          setError(next.error ?? '读取配置失败');
          setLoading(false);
          return null;
        }
        setState(next);
        setLoading(false);
        return next;
      }, []);

      const loadBugs = useCallback(async () => {
        setLoading(true);
        setError('');
        const next = await callBridge('/bugs');
        if (!next.ok) {
          setBugs([]);
          setFetchedAt('');
          setError(next.error ?? '读取列表失败');
          setLoading(false);
          return;
        }
        setBugs(Array.isArray(next.bugs) ? next.bugs : []);
        setFetchedAt(next.fetchedAt ?? '');
        setLoading(false);
      }, []);

      const bootstrap = useCallback(async () => {
        const next = await loadState();
        if (next?.configured) await loadBugs();
        else setLoading(false);
      }, [loadState, loadBugs]);

      useEffect(() => {
        void bootstrap();
      }, [bootstrap]);

      /* One counter for every open/close: a reply that belongs to an earlier
         bug must not overwrite the one now on screen. */
      const detailToken = useRef(0);

      const openBug = useCallback(async (id) => {
        const token = ++detailToken.current;
        listScroll.current = paneRef.current?.scrollTop ?? 0;
        if (paneRef.current) paneRef.current.scrollTop = 0;
        setOpenId(String(id));
        setDetail(null);
        setImages({});
        setDetailError('');
        setDetailLoading(true);
        const next = await callBridge('/bug', { id: String(id) });
        if (token !== detailToken.current) return;
        setDetailLoading(false);
        if (!next.ok) {
          setDetailError(next.error ?? '读取详情失败');
          return;
        }
        setDetail(next.bug ?? null);
        /* Pictures are independent: ask for them all at once and let each one
           paint as soon as it arrives instead of gating the text on the
           slowest screenshot. */
        const sources = Array.isArray(next.images) ? next.images : [];
        await Promise.all(sources.map(async (src) => {
          const payload = await callBridge('/image', { src });
          if (token !== detailToken.current) return;
          setImages((current) => ({ ...current, [src]: payload }));
        }));
      }, []);

      const closeBug = useCallback(() => {
        detailToken.current += 1;
        setOpenId('');
        setDetail(null);
        setImages({});
        setDetailError('');
        /* Runs after the list has painted, otherwise it scrolls the detail. */
        window.setTimeout(() => {
          if (paneRef.current) paneRef.current.scrollTop = listScroll.current;
        }, 0);
      }, []);

      const changeWidth = useCallback((id) => {
        setWidth(id);
        storeWidth(id);
      }, []);

      const activeWidth = WIDTH_PRESETS.find((preset) => preset.id === width) ?? WIDTH_FALLBACK_PRESET;
      /* One custom property feeds every column, so the choice has a single home. */
      const pageStyle = { ...styles.page, '--zt-content-max': activeWidth.max };

      /* The detail header can be filled from the row that opened it. */
      const openRow = useMemo(() => bugs.find((bug) => bug.id === openId) ?? null, [bugs, openId]);

      const rows = useMemo(() => {
        const nodes = [];
        bugs.forEach((bug, index) => {
          if (index > 0) nodes.push(h('div', { key: `sep-${bug.id}`, style: styles.separator }));
          nodes.push(h(BugRow, { key: bug.id, bug, onOpen: openBug }));
        });
        return nodes;
      }, [bugs, openBug]);

      if (loading && !state) {
        return h('div', { ref: paneRef, style: pageStyle }, h('div', { style: styles.column }, h('div', { style: styles.empty }, '读取中…')));
      }

      /* No state at all means the bridge never answered: an empty form would
         invite the user to retype settings that may already be fine. */
      if (!state) {
        return h(
          'div',
          { ref: paneRef, style: pageStyle },
          h(
            'div',
            { style: styles.column },
            h('div', { style: styles.heading }, h('h1', { style: styles.pageTitle }, '禅道')),
            h('p', { style: { ...styles.error, padding: 0, margin: 0 }, role: 'alert' }, error || '读取配置失败'),
            h('div', null, h('button', {
              type: 'button', style: styles.quietButton, onClick: () => { setLoading(true); void bootstrap(); },
            }, '重试')),
          ),
        );
      }

      if (!state.configured || editing) {
        return h(
          'div',
          { ref: paneRef, style: pageStyle },
          h('div', { style: styles.formWrap }, h(SetupForm, {
            open: editing && state.configured === true,
            settings: state.settings ?? { baseUrl: '', username: '' },
            credential: state.credential ?? { configured: false },
            onSaved: (next) => {
              setState(next);
              setEditing(false);
              void loadBugs();
            },
            onCancel: () => setEditing(false),
          })),
          error ? h('p', { style: styles.error, role: 'alert' }, error) : null,
        );
      }

      if (openId) {
        return h(
          'div',
          { ref: paneRef, style: pageStyle },
          h(DetailView, {
            detail,
            images,
            loading: detailLoading,
            error: detailError,
            onBack: closeBug,
            fallback: openRow ?? { id: openId, title: '' },
          }),
        );
      }

      const updated = fetchedAt ? new Date(fetchedAt) : null;
      return h(
        'div',
        { ref: paneRef, style: pageStyle },
        h(
          'div',
          { style: styles.column },
          h(
            'div',
            { style: styles.heading },
            h('h1', { style: styles.pageTitle }, '指派给我'),
            h('span', { style: styles.count }, loading ? '刷新中…' : `${bugs.length}`),
            h('span', { style: styles.spacer }),
            updated
              ? h('span', {
                style: styles.count,
                title: `更新于 ${updated.toLocaleString('zh-CN', { hour12: false })}`,
              }, `${String(updated.getHours()).padStart(2, '0')}:${String(updated.getMinutes()).padStart(2, '0')}`)
              : null,
            h(WidthMenu, { value: width, onChange: changeWidth }),
            h(IconButton, { label: '刷新', onClick: () => void loadBugs(), disabled: loading }, h(RefreshIcon)),
            h(IconButton, { label: '连接设置', onClick: () => setEditing(true) }, h(SettingsIcon)),
          ),
          error ? h('p', { style: { ...styles.error, padding: 0, margin: 0 }, role: 'alert' }, error) : null,
          !error && !loading && bugs.length === 0
            ? h('div', { style: styles.empty }, '没有指派给你的 Bug')
            : h('div', { style: styles.list }, ...rows),
        ),
      );
    }

    function ZentaoPanelIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18;
      const active = props?.active === true;
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', opacity: active ? 1 : 0.85 },
        },
        h('circle', { cx: 12, cy: 12, r: 8 }),
        h('path', { d: 'M12 8v4l3 2' }),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, ZentaoPanelPage));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 35, label: '禅道' },
          ZentaoPanelIcon,
        ));
      },
    };
  },
});
