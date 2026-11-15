# dsh-plugin-hello

Sample DSH plugin: adds a **Hello dsh-plugin** tab to the left sidebar. Clicking it shows a
centered `Hello dsh-plugin` in the main area.

It doubles as the smallest publishable unit of [dsh-market](../..) — useful as a starting
point for your own plugin and as a reference for the release flow.

## Layout

| File | Purpose |
| --- | --- |
| `package.json` | Bundle manifest. `dsh.bundle.patch` points at the patch layer, `dsh.client` declares the browser half |
| `cordis.patch.yml` | Patch layer: inserts one `dsh-plugin-hello` entry into the loader |
| `lib/index.js` | Host half. Nothing to do here, just an `apply()` |
| `lib/client.js` | Browser half. Registers `main` (keyed slot, the page) and `sidebar.panellist` (list slot, the sidebar row) |

## How two slots make one sidebar tab

- A `sidebar.panellist` entry is **metadata-driven**: `id`, `label` and `order` decide the
  sidebar row, and the registered component only draws the icon (16px expanded, 18px
  collapsed).
- `main` is a keyed slot, and its `key` must equal the `sidebar.panellist` `id`. Clicking
  the row runs `ctx.layout.selectPanel(id)`, which looks up the same `key` in `main` and
  renders that component.
- So the two ids must match. `main` without `sidebar.panellist` has no entry point, and
  `sidebar.panellist` without `main` throws when clicked.

The sidebar row is built from entry metadata, not from the component — returning `null`
from the icon component leaves a blank but clickable row.

## Layout notes

`main` provides a flex column container, so the page uses `flex: 1 1 auto` with
`minHeight: 100%` plus `alignItems` / `justifyContent: center` to center its content.
Colors come from `--dsw-alias-*` theme tokens, so the plugin follows light and dark themes.

## Local development

```bash
pnpm --dir plugins/dsh-plugin-hello pack     # from the repo root
```

Install the tarball or a `git+https://…#<commit>&path:/plugins/dsh-plugin-hello` spec, then
restart DSH.

## Release

Do not edit anything under `market/` by hand. Bump `version` in `package.json`, then from
the repo root:

```bash
node scripts/release.mjs dsh-plugin-hello
node scripts/build-index.mjs --verify
```
