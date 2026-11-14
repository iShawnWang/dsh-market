// dsh-hello-world — browser half.
//
// Served by dsh-client-modules at /plugins/dsh-hello-world/client.js and
// executed through the vendored cordis Loader's lazy-CJS module table
// (window.__ModuleLoader__.load). The factory body is plain CJS with
// require() resolved against the shell's module table, so `require('react')`
// is the shell's own React instance — no bundler needed.
//
// Two seats make one sidebar tab:
//   1. `main` (keyed, root scope) with `key: PANEL_ID` renders the page body.
//   2. `sidebar.panellist` (list, root scope) with the SAME `id` renders the
//      nav glyph; its `label` is the row text and tooltip.
// Clicking the row runs ctx.layout.selectPanel(PANEL_ID), which is why the
// `main` registration must exist under exactly that key.

window.__ModuleLoader__.load({
  id: 'dsh-hello-world',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // Must match in both registrations below; it is the sidebar row's id and
    // the main slot's key.
    const PANEL_ID = 'dsh-hello-world';

    // --- the page (main keyed slot) -------------------------------------
    function HelloWorldPage() {
      return h(
        'div',
        {
          style: {
            boxSizing: 'border-box',
            display: 'flex',
            flex: '1 1 auto',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100%',
            padding: '48px 24px',
            background: 'var(--dsw-alias-bg-base)',
            color: 'var(--dsw-alias-label-primary)',
            font: '600 40px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif',
            letterSpacing: '-0.02em',
          },
        },
        'hello world',
      );
    }

    // --- the sidebar row glyph (panellist list slot) --------------------
    // The row itself is built from the registration's metadata (label + order);
    // this component only draws the 18px glyph inside it and receives
    // { size, active } from the sidebar.
    function HelloWorldIcon(props) {
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
        h('circle', {
          cx: 12,
          cy: 12,
          r: 8,
          stroke: 'currentColor',
          strokeWidth: 1.6,
          opacity: active ? 1 : 0.85,
        }),
        h('path', {
          d: 'M8.6 12h6.8M12 8.6v6.8',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 1. The page. `key` is what ctx.layout.selectPanel(PANEL_ID) looks up.
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
            },
            HelloWorldPage,
          ),
        );

        // 2. The sidebar row. `id` must equal the main slot's `key`; `label`
        //    is plain text (a string or a function returning one) and supplies
        //    the visible row text, accessible name, and collapsed tooltip.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 30,
              label: 'Hello World',
            },
            HelloWorldIcon,
          ),
        );
      },
    };
  },
});
