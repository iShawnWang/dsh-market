# dsh-market

A [DeepSeek Harness](https://github.com/deepseek-ai) plugin market that lives entirely
inside one Git repository. **No registry, no server, no build backend**: the index is a
JSON file in this repo, and every plugin is a subdirectory of the same repo.

DSH installs a plugin with `git+https://…git#<commit>&path:/plugins/<pkg>`, and each
version in the index pins an exact commit — so "publishing" is just: bump the version,
record the commit, rebuild the index, push.

```
dsh-market/
├── market/
│   ├── config.json           # index URL + Git URL + publish mode
│   ├── base.json             # market-wide: title, description, category/label/sort declarations
│   ├── releases.json         # which versions were published, with the commit they were published at
│   ├── meta/<pkg>.json       # per-plugin presentation: title, description, icon, repository
│   └── index.json            # ← generated; this is the file DSH consumes (format 1)
├── plugins/
│   └── dsh-hello-world/      # sample plugin: a sidebar tab showing a centered "hello world"
└── scripts/
    ├── build-index.mjs       # compose + validate index.json (--check / --verify)
    ├── release.mjs           # record a release: read package.json version → releases.json + commit
    ├── mirror.sh             # refresh the bare mirror used by local git+file:// installs
    └── serve.mjs             # serve market/ over HTTP for local checks
```

`index.json` is composed from `base.json` + `meta/*.json` + `releases.json` — do not edit
it by hand.

## Why the index still needs HTTP

DSH only accepts an **absolute http(s) URL** as an index source (`file://` is rejected),
so even a purely Git-based market needs one HTTP endpoint for `index.json`. On GitHub the
raw file URL is enough:

```
https://raw.githubusercontent.com/iShawnWang/dsh-market/main/market/index.json
```

`baseUrl` in `market/config.json` is that directory, and `build-index.mjs` resolves every
relative reference in the index against it. Any other host works the same way — GitLab
(`/-/raw/main/market/index.json`), Gitea (`/raw/branch/main/market/index.json`), or plain
static hosting.

## Publishing a release

```bash
# 1. bump the version and commit the plugin source
cd plugins/dsh-hello-world && pnpm version patch && cd ../..
git add -A && git commit -m "release dsh-hello-world"

# 2. record it (writes the current HEAD commit into releases.json)
node scripts/release.mjs dsh-hello-world

# 3. rebuild + validate with DSH's own parser, then commit and push
node scripts/build-index.mjs --verify
git add market/ && git commit -m "publish index" && git push
```

`--verify` runs the same `parseMarketIndex` DSH runs when a user opens the Discover page,
so an index that passes locally is guaranteed to be accepted. It loads the parser in this
order:

1. `@deepseek-ai/dsh-plugin-market-index` from the repo's `node_modules`
   (`npm install`; **not** `pnpm install`, which hangs on this repo);
2. the same package under `DSH_PACKAGES_DIR`;
3. otherwise it prints both failures and exits non-zero.

> On macOS the DSH packages live inside `app.asar`, which plain `node` cannot import. To
> reuse the parser bundled with an installed DSH without adding dependencies:
>
> ```bash
> DSH_PACKAGES_DIR="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai" \
> ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
>   scripts/build-index.mjs --verify
> ```

The order matters: `release.mjs` records the **current HEAD**, so commit the plugin
source first, record the version second, and commit the index last. It refuses to run when

- the version is already recorded (bump it first);
- the new version is not newer than the newest recorded one;
- the working tree is dirty (unless `--allow-dirty`, in which case the recorded commit
  will not contain your changes).

How users see a release: **Plugins → Discover** shows the new version, or
**Plugins → Installed → check for updates**. DSH has no background auto-update, so the
pace is entirely up to the publisher — publish the index to roll out, leave `index.json`
alone to hold everyone where they are.

## Connecting DSH

1. **Enable the experimental switch**: Plugins → Experimental plugins → turn on
   **custom plugin indexes**. That mounts
   `@deepseek-ai/dsh-experimental-plugin-market-bundle` and adds the Discover tab.
2. **Add the index source**: Plugins → Discover → Manage index sources… → paste
   `https://raw.githubusercontent.com/iShawnWang/dsh-market/main/market/index.json`.
   Index sources can only be added by the user; the agent-side `plugin_market` tool is
   read-only.
3. To preset it fleet-wide, add it to the profile's `cordis.patch.yml`:

```yaml
- id: plugin-market
  config:
    indexes:
      - https://raw.githubusercontent.com/iShawnWang/dsh-market/main/market/index.json
```

## Installing without the UI

```
plugin_manager install_bundle  target="git+https://github.com/iShawnWang/dsh-market.git#<40-hex-commit>&path:/plugins/dsh-hello-world"
```

Pass `registry` explicitly (`registry="https://registry.npmmirror.com/"` works from
mainland China). Installing re-resolves the whole profile, and DSH starts pnpm with a
scrubbed environment that drops proxy variables, so a direct connection to
`registry.npmjs.org` may time out.

## Local development

```bash
node scripts/serve.mjs        # http://127.0.0.1:8899/index.json
```

Point the index source at `http://127.0.0.1:8899/index.json`.

Installing straight from a local clone skips HTTP entirely — `git+file://` is detected as
a path-style source by `parseInstallSpec`:

```bash
./scripts/mirror.sh          # rebuild ../dsh-market.git
plugin_manager install_bundle  target="git+file://<abs-path>/dsh-market.git#<40-hex-commit>&path:/plugins/dsh-hello-world"
```

Two caveats:

- the mirror's commit must stay reachable, or the profile's `pnpm install` breaks later —
  that is why the mirror lives beside the working tree and is refreshed by `mirror.sh`;
- pass `registry` explicitly (see above).

After installing, restart DSH: a **Hello World** row appears in the sidebar, and clicking
it shows a centered `hello world`.

## Known limits

- **`commit` in the index must be 40 lowercase hex** — short SHAs and branch names are
  rejected.
- **`url` must be https, canonical, and at least two path segments**, with no query or
  fragment.
- The Discover detail page can read a plugin's README, because DSH partial-clones the
  pinned commit — so `plugins/<pkg>/README.md` is worth writing.
- The whole index is validated as one unit: a single rule violation rejects everything,
  and the error points at the JSON path. Always run `build-index.mjs --verify` before
  publishing.

## License

MIT
