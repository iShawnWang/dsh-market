// dsh-plugin-yq-release — browser half.
//
// One sidebar tab that mirrors what the agent tools already did: the release
// chains this machine knows about, the recent runs, the ledger, and the three
// credentials the pipeline needs. The panel never performs a release itself —
// releasing stays a conversation action, because a release is a decision with a
// branch name attached, not a button.
//
// Data comes from the host bridge at /api/dsh-yq-release/*, which authenticates
// with the same browser cookie the rest of the UI uses. No bundler: the factory
// body is plain CJS and `require('react')` resolves to the shell's React.

window.__ModuleLoader__.load({
  id: 'dsh-plugin-yq-release',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // Must match the `main` slot key and the sidebar row id.
    const PANEL_ID = 'dsh-plugin-yq-release';

    const BRIDGE_PREFIX = '/api/dsh-yq-release';

    // One config list: connection addresses and credentials live in the same
    // card, because they are all "things this machine has to be told once".
    // `secret: true` rows never echo their stored value back.
    const CONFIG_FIELDS = [
      { kind: 'setting', key: 'gitlabEndpoint', label: 'GitLab 地址', placeholder: 'http://gitlab.example.com:9001/' },
      { kind: 'setting', key: 'spugBaseUrl', label: 'Spug 地址', placeholder: 'http://spug.example.com:6060/' },
      { kind: 'setting', key: 'qqcBaseUrl', label: '小程序构建机地址', placeholder: 'http://10.0.0.2:3000/' },
      { kind: 'credential', key: 'GITLAB_ACCESS_TOKEN', label: 'GitLab Token', secret: true },
      // Also masked: a credential value never travels back from the host, so
      // showing what was typed is the only state the field could hold anyway.
      { kind: 'credential', key: 'SPUG_USERNAME', label: 'Spug 用户名', secret: true },
      { kind: 'credential', key: 'SPUG_PASSWORD', label: 'Spug 密码', secret: true },
    ];

    // The host reports how many characters a stored secret has (its preview is
    // same-length), so the mask can be exactly that long. When the length is
    // unknown — an inherited env var, say — fall back to this, which claims
    // nothing about the real length either way.
    const SECRET_MASK_FALLBACK = '••••••••';

    /**
     * Build the mask shown for a stored secret.
     * @param {number|null|undefined} length - stored secret length in code points.
     * @returns {string} a run of dots.
     */
    function secretMask(length) {
      return typeof length === 'number' && length > 0
        ? '•'.repeat(length)
        : SECRET_MASK_FALLBACK;
    }

    // Whether the config block was left open. Switching tabs unmounts the page,
    // so the answer has to outlive the component. localStorage is per-origin and
    // this is a UI preference, not release state: it belongs here, next to the
    // shell's own keys, not in the host.
    const CONFIG_OPEN_KEY = 'dsh-plugin-yq-release.configOpen';

    /**
     * Read a stored boolean preference.
     * @param {string} key - localStorage key.
     * @returns {boolean|undefined} the stored value, or undefined if unset.
     */
    function readStoredFlag(key) {
      try {
        const raw = window.localStorage?.getItem(key);
        return raw === null || raw === undefined ? undefined : raw === 'true';
      } catch {
        // A denied localStorage (privacy mode, sandboxed frame) is not an error
        // worth showing: folding the block is a fine fallback.
        return undefined;
      }
    }

    /**
     * Persist a boolean preference.
     * @param {string} key - localStorage key.
     * @param {boolean} value - value to store.
     */
    function writeStoredFlag(key, value) {
      try {
        window.localStorage?.setItem(key, String(value));
      } catch {
        // Ignored on purpose; see readStoredFlag.
      }
    }

    /**
     * POST one bridge endpoint. Errors are surfaced as data, not thrown, so the
     * panel can keep rendering whatever it already had.
     * @param {string} path - endpoint suffix.
     * @param {object} [body] - JSON body.
     * @returns {Promise<object>} decoded response.
     */
    async function callBridge(path, body) {
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
        payload = { ok: false, error: text };
      }
      if (!response.ok) {
        return { ok: false, error: payload?.error ?? `HTTP ${response.status}` };
      }
      return payload;
    }

    /**
     * Shared styles. Only design tokens, never literal colours.
     *
     * The geometry follows the built-in "Automation" page: one 960px column
     * centred in the pane, a 20px/500 page title 28px from the top, and flat
     * rows on hover surfaces instead of nested cards.
     */
    const styles = {
      // The scroll pane itself: owns the scrollbar, not the insets.
      page: {
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        flex: '1 1 auto',
        // The slot host may not be a flex parent; own the height both ways so
        // the column still fills the pane and scrolls inside it.
        height: '100%',
        minHeight: '100%',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        font: '14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif',
        overflow: 'auto',
        scrollbarGutter: 'stable',
      },
      // The one readable column. Inline and bottom insets only; the top inset
      // belongs to the heading so the title sits where the built-in page's does.
      column: {
        boxSizing: 'border-box',
        width: '100%',
        maxWidth: '960px',
        margin: '0 auto',
        padding: '0 clamp(24px, 4vw, 48px) 48px',
        display: 'flex',
        flexDirection: 'column',
        gap: '28px',
      },
      heading: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '16px',
        paddingTop: '28px',
      },
      pageTitle: {
        margin: '0',
        font: '500 20px/28px system-ui, -apple-system, "Segoe UI", sans-serif',
      },
      // Each section is a raised block on the page surface: the layer-1 fill
      // plus the l1 outline is what makes the page read as grouped regions
      // instead of one flat run of text.
      section: {
        display: 'flex',
        flexDirection: 'column',
        minWidth: '0',
        padding: '16px',
        borderRadius: '12px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      sectionTitle: {
        margin: '0 0 4px',
        font: '500 15px/22px system-ui, -apple-system, "Segoe UI", sans-serif',
      },
      hint: {
        margin: '0',
        color: 'var(--dsw-alias-label-tertiary)',
        font: '13px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif',
      },
      // Flat row on the column, as the built-in list rows are. The hairline
      // between rows is drawn by `separated`, so a single row never opens with
      // a rule under its own heading.
      row: {
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '8px',
        borderRadius: '12px',
      },
      // Hairline between two rows of the same block. It is its own element, not
      // a border on the row: rows carry a 12px radius, so a border-top would
      // curve down at both ends and read as a hook rather than a separator.
      // The inset matches the row's own 8px padding, so the line stops where the
      // text starts. l3 rather than l2 so it stays visible on the layer-1 fill.
      separator: {
        height: '1px',
        margin: '0 8px',
        background: 'var(--dsw-alias-border-l3)',
      },
      // The rows of one section: a 2px rhythm, matching the built-in lists. The
      // separator contributes none of it: it is 1px tall and the gap is set
      // here, so the visual rhythm stays 2px between row edges.
      list: {
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
      },
      fieldRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '6px 8px',
        borderRadius: '12px',
      },
      fieldLabel: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '6px',
        flex: '0 0 150px',
        minWidth: '0',
      },
      // The status sits beside the label on its baseline, not under it: a
      // second line made every row taller and pushed the whole form down the
      // page for a word that is usually absent. It keeps its box either way, so
      // a save flips a word in place instead of reflowing the row.
      fieldStatus: {
        flex: 'none',
        font: '12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      rowTitle: {
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontWeight: '500',
        lineHeight: '22px',
      },
      mono: {
        font: '12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
        color: 'var(--dsw-alias-label-tertiary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      // The trailing status of a row. It must never wrap or shrink: `阻塞` is
      // two characters, and squeezed to a few pixels it breaks onto two lines
      // and reads like a column of its own.
      rowStatus: {
        flex: 'none',
        whiteSpace: 'nowrap',
        font: '600 12px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
      },
      // The text block of a row: takes the width left over by the status.
      rowBody: {
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 auto',
        minWidth: '0',
      },
      input: {
        flex: '1 1 auto',
        minWidth: '0',
        height: '32px',
        boxSizing: 'border-box',
        padding: '0 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        font: '13px/20px system-ui, -apple-system, "Segoe UI", sans-serif',
      },
      // The disclosure for the config block: a full-width row, not a card head.
      disclosure: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        padding: '8px',
        border: '0',
        borderRadius: '12px',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      },
      disclosureTitle: {
        font: '500 15px/22px system-ui, -apple-system, "Segoe UI", sans-serif',
      },
      disclosureMeta: {
        marginLeft: 'auto',
        color: 'var(--dsw-alias-label-tertiary)',
        font: '12px/20px system-ui, -apple-system, "Segoe UI", sans-serif',
      },
      chevron: {
        flex: 'none',
        width: '14px',
        height: '14px',
        color: 'var(--dsw-alias-label-tertiary)',
        transition: 'transform 120ms ease',
      },
      empty: {
        margin: '0',
        padding: '32px 8px',
        color: 'var(--dsw-alias-label-tertiary)',
        font: '14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif',
      },
      error: {
        margin: '0',
        padding: '12px 8px',
        color: 'var(--dsw-alias-state-error-primary)',
        font: '13px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif',
        overflowWrap: 'anywhere',
      },
    };

    /**
     * An ISO instant rendered as local wall-clock time.
     * The ledger stores UTC (`...Z`); slicing that string would print `07:26`
     * for a 15:26 release, so the instant is converted into the viewer's own
     * time zone before formatting.
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

    const STATUS_LABEL = {
      success: '成功',
      failed: '失败',
      blocked: '阻塞',
    };

    const STATUS_COLOR = {
      success: 'var(--dsw-alias-state-success-primary)',
      failed: 'var(--dsw-alias-state-error-primary)',
      blocked: 'var(--dsw-alias-state-warn-label)',
    };

    /**
     * One titled block of the column: a heading line and its rows.
     * @param {object} props - component props.
     * @returns {object} element.
     */
    function Section(props) {
      return h(
        'section',
        { style: styles.section },
        h('h2', { style: styles.sectionTitle }, props.title),
        h('div', { style: styles.list }, props.children),
      );
    }

    /**
     * Collapsible block header, used for the config panel so six fields do not
     * push the release history off the first screen.
     * @param {object} props - component props.
     * @returns {object} element.
     */
    function Disclosure(props) {
      // Inline styles cannot express :hover, so the hover surface is tracked in
      // state; it matches the built-in rows' `interactive-bg-hover` fill.
      const [hovered, setHovered] = React.useState(false);
      return h(
        'button',
        {
          type: 'button',
          style: hovered
            ? { ...styles.disclosure, background: 'var(--dsw-alias-interactive-bg-hover)' }
            : styles.disclosure,
          onMouseEnter: () => setHovered(true),
          onMouseLeave: () => setHovered(false),
          onFocus: () => setHovered(true),
          onBlur: () => setHovered(false),
          'aria-expanded': props.open,
          onClick: props.onToggle,
        },
        h(
          'svg',
          {
            viewBox: '0 0 16 16',
            fill: 'none',
            'aria-hidden': true,
            style: {
              ...styles.chevron,
              transform: props.open ? 'rotate(90deg)' : 'none',
            },
          },
          h('path', {
            d: 'M6 4l4 4-4 4',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        ),
        h('span', { style: styles.disclosureTitle }, props.title),
        h('span', { style: styles.disclosureMeta }, props.meta),
      );
    }

    /**
     * Interleave a hairline between consecutive rows.
     *
     * The separator has to be its own element: rows carry a 12px radius, so a
     * `border-top` on a row would curve down at both ends and read as a hook
     * instead of a rule.
     * @param {Array<object>} rows - keyed row elements.
     * @returns {Array<object>} rows with separators between them.
     */
    function separated(rows) {
      if (rows.length < 2) return rows;
      const nodes = [];
      rows.forEach((row, index) => {
        if (index > 0) nodes.push(h('div', { key: `sep-${index}`, style: styles.separator }));
        nodes.push(row);
      });
      return nodes;
    }

    /**
     * One release chain row.
     * @param {object} props - component props.
     * @returns {object} element.
     */
    function ChainRow(props) {
      const chain = props.chain;
      return h(
        'div',
        { style: styles.row },
        h(
          'div',
          { style: styles.rowBody },
          h('span', { style: styles.rowTitle }, `${props.projectLabel} · ${chain.label}`),
          h(
            'span',
            { style: styles.mono },
            `${chain.provider} · → ${chain.targetBranch}` +
              (chain.explicitOnly ? ' · 需点名项目，不从分支名推断' : ''),
          ),
        ),
      );
    }

    /**
     * One recent run row.
     * @param {object} props - component props.
     * @returns {object} element.
     */
    function RunRow(props) {
      const run = props.run;
      return h(
        'div',
        { style: styles.row },
        h(
          'div',
          { style: styles.rowBody },
          h(
            'span',
            { style: styles.rowTitle },
            `${run.project ?? '?'} · ${run.chain ?? '?'} ` +
              `${run.sourceBranch ?? ''} → ${run.targetBranch ?? ''}`,
          ),
          h(
            'span',
            { style: styles.mono },
            `${formatTime(run.finishedAt)}` +
              `${run.commitShort ? ` · ${run.commitShort}` : ''}` +
              `${run.message ? ` · ${run.message}` : ''}`,
          ),
        ),
        h(
          'span',
          {
            style: {
              ...styles.rowStatus,
              color: STATUS_COLOR[run.status] ?? 'var(--dsw-alias-label-secondary)',
            },
          },
          STATUS_LABEL[run.status] ?? run.status ?? '',
        ),
      );
    }

    /**
     * Flatten the project registry into one row per chain.
     * @param {Array<object>} projects - resolved projects.
     * @returns {Array<object>} `{ project, chain }` pairs.
     */
    function flattenChains(projects) {
      const rows = [];
      for (const project of projects) {
        for (const chain of project.chains ?? []) rows.push({ project, chain });
      }
      return rows;
    }

    /**
     * The page itself.
     * @returns {object} element.
     */
    function ReleasePanelPage() {
      const [state, setState] = React.useState(null);
      const [history, setHistory] = React.useState([]);
      const [error, setError] = React.useState('');
      const [saving, setSaving] = React.useState('');
      // Config starts folded — six fields on top of three lists buries the part
      // of the page that gets looked at daily — but once the user opens it, it
      // stays open across tab switches.
      const [configOpen, setConfigOpen] = React.useState(
        () => readStoredFlag(CONFIG_OPEN_KEY) ?? false,
      );
      const [drafts, setDrafts] = React.useState({});

      const refresh = React.useCallback(async () => {
        try {
          const [statePayload, historyPayload] = await Promise.all([
            callBridge('/state'),
            callBridge('/history', { limit: 20 }),
          ]);
          if (statePayload?.error) {
            setError(statePayload.error);
            return;
          }
          setState(statePayload);
          setHistory(historyPayload?.records ?? []);
          setError('');
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        }
      }, []);

      React.useEffect(() => {
        void refresh();
      }, [refresh]);

      /**
       * Persist one config row. Called on blur, on Enter, and right before the
       * page is left, so no row ever needs its own save button.
       * @param {object} definition - one CONFIG_FIELDS entry.
       */
      const saveField = async (definition) => {
        const { kind, key } = definition;
        const value = drafts[key];
        if (value === undefined) return;
        const trimmed = value.trim();
        // An emptied address is meaningful ("forget this"), an emptied secret is
        // not: it would look like "clear the credential", which this panel has no
        // way to express. Dropping the draft puts the mask back, so a focus that
        // ends without typing leaves the row looking configured.
        if (kind === 'credential' && !trimmed) {
          setDrafts((current) => ({ ...current, [key]: undefined }));
          return;
        }
        setSaving(key);
        try {
          const path = kind === 'credential' ? '/credentials' : '/settings';
          const payload = kind === 'credential' ? { ref: key, value: trimmed } : { field: key, value: trimmed };
          const result = await callBridge(path, payload);
          if (result?.ok) {
            // Refresh first, so the mask is already in place when the draft is
            // dropped. Clearing it earlier would blank the field for one frame on
            // the very first save of a secret.
            await refresh();
            // Another field's refresh ran concurrently and dropped a draft typed
            // outside the blur path; never resurrect a stale one.
            setDrafts((current) => (current[key] === value ? { ...current, [key]: undefined } : current));
          } else {
            setError(result?.error ?? result?.message ?? '保存失败');
          }
        } finally {
          setSaving('');
        }
      };

      const projects = state?.projects ?? [];
      const credentials = state?.credentials ?? {};
      const settingValues = state?.settings?.values ?? {};

      // The header states the size of the list. Whether a row is filled is the
      // row's own business (see the row sub-line), so the header never has to
      // change as fields are filled in.
      const configMeta = `${CONFIG_FIELDS.length} 个配置项`;

      return h(
        'div',
        { style: styles.page },
        h(
          'div',
          { style: styles.column },
          h('header', { style: styles.heading }, h('h1', { style: styles.pageTitle }, 'YQ-前端发布')),

          error ? h('p', { style: styles.error }, error) : null,

          h(
            'section',
            { style: styles.section },
            h(Disclosure, {
              title: '配置',
              meta: configMeta,
              open: configOpen,
              onToggle: () =>
                setConfigOpen((open) => {
                  writeStoredFlag(CONFIG_OPEN_KEY, !open);
                  return !open;
                }),
            }),
            configOpen
              ? h(
                  'div',
                  { style: { ...styles.list, marginTop: '4px' } },
                  separated(
                    CONFIG_FIELDS.map((definition) => {
                      const { kind, key } = definition;
                      const filled =
                        kind === 'credential'
                          ? Boolean(credentials[key]?.configured)
                          : (settingValues[key] ?? '') !== '';
                      const draft = drafts[key];
                      return h(
                        'div',
                        { key, style: styles.fieldRow },
                        h(
                          'div',
                          { style: styles.fieldLabel },
                          h('span', { style: styles.rowTitle }, definition.label),
                          // Only a missing value earns a line: `未配置` while the
                          // field is empty, and nothing at all once it is set. The
                          // slot keeps its height either way, so a save never shifts
                          // the row under the pointer.
                          saving === key
                            ? h('span', { style: { ...styles.fieldStatus, color: 'var(--dsw-alias-label-tertiary)' } }, '保存中')
                            : !filled
                              ? h(
                                  'span',
                                  { style: { ...styles.fieldStatus, color: 'var(--dsw-alias-state-warn-label)' } },
                                  '未配置',
                                )
                              : h('span', { style: styles.fieldStatus }),
                        ),
                        h('input', {
                          type: definition.secret ? 'password' : 'text',
                          // A stored secret shows as a fixed mask, not as a hint
                          // telling the user to overwrite it: the field already
                          // holds something, and `••••••••` is the conventional way
                          // to say so. Focusing clears it so typing starts from an
                          // empty field rather than appending to the mask.
                          placeholder: definition.secret
                            ? '粘贴值'
                            : (definition.placeholder ?? '粘贴值'),
                          value:
                            draft !== undefined
                              ? draft
                              : definition.secret
                                ? filled
                                  ? secretMask(credentials[key]?.maskLength)
                                  : ''
                                : (settingValues[key] ?? ''),
                          onChange: (event) =>
                            setDrafts((current) => ({ ...current, [key]: event.target.value })),
                          onFocus: () => {
                            if (definition.secret && draft === undefined && filled) {
                              setDrafts((current) => ({ ...current, [key]: '' }));
                            }
                          },
                          onBlur: () => void saveField(definition),
                          onKeyDown: (event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              event.currentTarget.blur();
                            }
                          },
                          style: styles.input,
                          'aria-label': definition.label,
                        }),
                      );
                    }),
                  ),
                )
              : null,
          ),

          h(
            Section,
            { title: '发布链路' },
            projects.length === 0
              ? h(
                  'p',
                  { style: styles.empty },
                  '还没有链路：从对话里发一次就会长出来。' +
                    '第一次发布要说清项目、目标分支、发布方式和应用名。',
                )
              : separated(
                  flattenChains(projects).map((entry) =>
                    h(ChainRow, {
                      key: `${entry.project.id}/${entry.chain.id}`,
                      chain: entry.chain,
                      projectLabel: entry.project.label,
                    }),
                  ),
                ),
          ),

          h(
            Section,
            { title: '最近发布' },
            (state?.recentRuns ?? []).length === 0
              ? h('p', { style: styles.empty }, '本次会话还没有执行过发布')
              : separated(
                  (state.recentRuns ?? []).map((run, index) =>
                    h(RunRow, { key: run.id ?? index, run }),
                  ),
                ),
          ),

          h(
            Section,
            { title: '历史记录' },
            history.length === 0
              ? h('p', { style: styles.empty }, '还没有历史记录')
              : separated(
                  history.map((record, index) =>
                    h(
                      'div',
                      {
                        key: `${record.timestamp ?? index}-${index}`,
                        style: styles.row,
                      },
                      h(
                        'div',
                        { style: styles.rowBody },
                        h(
                          'span',
                          { style: styles.rowTitle },
                          `${record.project ?? '?'} · ${record.source_branch ?? '?'} → ` +
                            `${record.merge?.target ?? '?'}`,
                        ),
                        h(
                          'span',
                          { style: styles.mono },
                          `${formatTime(record.timestamp) || '时间未知'} · ` +
                            `${record.release?.provider ?? '?'} ${record.release?.application ?? ''} ` +
                            `${record.release?.environment ?? ''}` +
                            `${record.commit_id ? ` · ${String(record.commit_id).slice(0, 7)}` : ''}`,
                        ),
                      ),
                      h(
                        'span',
                        {
                          style: {
                            flex: 'none',
                            color: STATUS_COLOR[record.result] ?? 'var(--dsw-alias-label-secondary)',
                            font: '500 13px/22px system-ui, -apple-system, "Segoe UI", sans-serif',
                          },
                        },
                        STATUS_LABEL[record.result] ?? record.result ?? '',
                      ),
                    ),
                  ),
                ),
          ),
        ),
      );
    }

    /**
     * Sidebar glyph: a box with an arrow leaving it.
     * @param {object} props - `{ size, active }`.
     * @returns {object} element.
     */
    function ReleasePanelIcon(props) {
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
          style: { display: 'block', opacity: active ? 1 : 0.85 },
        },
        h('path', {
          d: 'M4 9v9a1 1 0 0 0 1 1h9',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M12 4h8v8',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M20 4l-8 8',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, ReleasePanelPage),
        );
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 40,
              label: 'YQ-前端发布',
            },
            ReleasePanelIcon,
          ),
        );
      },
    };
  },
});
