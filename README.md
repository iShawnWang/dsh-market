# dsh-internal-market

公司内部的 DSH 插件市场示例仓库。同一份 `market/index.json` 既可以被 DSH 桌面端的
**插件 → 发现 → 索引源** 消费，也可以被 `plugin_market` 工具读取。整个链路不经过
GitHub，也不经过 npmjs.com。

```
dsh-internal-market/
├── market/
│   ├── config.json           # 市场自己的配置：索引 URL、发布模式（npm / static）、registry 地址
│   ├── base.json             # 索引公共部分：标题、描述、分类 / 标签 / 排序键的声明
│   ├── releases.json         # 每个插件发布过哪些版本（由 scripts/release.mjs 维护，人工别手改）
│   ├── meta/<pkg>.json       # 每个插件的展示信息：标题、描述、图标、仓库地址
│   └── index.json            # ← 生成物，这就是 DSH 消费的插件索引（format 1）
├── plugins/
│   └── dsh-hello-world/      # 示例插件：左侧新增一个标签，点开是居中的 hello world
└── scripts/
    ├── build-index.mjs       # 合成并校验 index.json（--check 只校验，--verify 用 DSH 自带解析器再验一遍）
    ├── release.mjs           # 记录一次发布：读 package.json 的 version → 写 releases.json
    └── serve.mjs             # 本地联调：同时提供 index.json 和一个最小 npm registry
```

`index.json` 由 `market/base.json` + `market/meta/*.json` + `market/releases.json`
合成，**不要手改**；改上面三个来源之后重新 `node scripts/build-index.mjs --verify`。

## 两种发布模式

`market/config.json` 的 `publish.mode` 决定插件包放在哪里。两种都可以完全内网化。

### A. `"mode": "npm"` —— 走公司私有 registry（推荐）

插件包由 CI 用 `pnpm publish` 推到公司 Nexus / Artifactory，索引里每个版本带
`source: { "type": "npm", "registry": "<私有 registry URL>" }`。

- DSH 安装时用 `pnpm add <name>@<version> --registry=<该 URL>`，token 走用户本机
  `~/.npmrc`，不会写进索引。
- 索引里的 registry URL **不能带 token、query 或 fragment**（DSH 会拒绝），鉴权只能靠
  用户自己的 `.npmrc`。
- 私有 registry 的版本在「发现」详情页看不到包内文件（只有 npmjs / npmmirror 才走
  CDN 读取），会回退去读 `repository` 的 README——所以 `meta/<pkg>.json` 尽量写全
  `description`，并把 `repository` 指向内网 Git。

### B. `"mode": "static"` —— 索引直接指向内网 Git 的固定 commit

索引里写 `source: { "type": "git", "url": "https://git.intra/...", "commit": "<40 位>",
"path": "plugins/<pkg>" }`。DSH 用 `git+<url>.git#<commit>` 安装，走用户自己的 git
credential helper。

- 好处：不需要 registry，CI 只要打 tag + 更索引。
- 代价：`commit` 必须是完整 40 位小写 hex，且 URL 必须是 https、路径至少两段。
- 更新由「索引里换了 commit」驱动，所以要冻结某个版本，就别往索引里写新 commit。

## CI 里怎么跑（以 npm 模式为例）

顺序很重要：**包必须先在 registry 上可下载，索引最后发布**。索引里列了却下载不到的
版本，对所有人都是装不上的坏版本。

```bash
# 1. 改版本号（release.mjs 只认 package.json 里的 version）
cd plugins/dsh-hello-world && pnpm version patch && cd ../..

# 2. 打 tag 并推代码
git add -A && git commit -m "release dsh-hello-world" && git tag dsh-hello-world@0.2.0 && git push --tags

# 3. 发布 tarball 到私有 registry（CI 的 NPM_TOKEN 走环境变量，不落盘）
pnpm --filter ./plugins/dsh-hello-world publish --registry "$NEXUS_NPM_URL" --no-git-checks

# 4. 记录版本 + 重建索引 + 用 DSH 自带解析器校验
node scripts/release.mjs dsh-hello-world
node scripts/build-index.mjs --verify

# 5. 提交索引（把 index.json 推到内网 HTTP 服务 / 对象存储）
git add market/ && git commit -m "publish index" && git push
```

`scripts/release.mjs` 会拒绝重复版本、拒绝不比已记录版本更新的版本；静态模式还会
要求工作区是干净的（除非 `--allow-dirty`），并自动写入 `git rev-parse HEAD`。

## 桌面端怎么接入

1. **打开实验开关**：插件页 → Experimental plugins → 打开「自定义插件索引」。
   这会挂上 `@deepseek-ai/dsh-experimental-plugin-market-bundle`，出现「发现」标签页
   和只读的 `plugin_market` 工具。关掉时索引源仍留在 profile 里。
2. **添加索引源**：插件 → 发现 → 管理索引源… → 填
   `https://dsh-plugins.intra.example.com/index.json`
   （必须是绝对 http(s)、不能带凭据、不能带 `#`；索引 10 分钟缓存）。
3. 之后「发现」里就能看到内部插件。**索引源只能由用户自己增删**——agent 侧的
   `plugin_market` 工具是只读的，这是有意的权限边界。

企业批量下发时可以预置默认索引源：在 profile 的 `cordis.patch.yml` 里给
`plugin-market` 配 `indexes`（这是易失字段，profile 更新后可能需要重设）：

```yaml
- id: plugin-market
  config:
    indexes:
      - https://dsh-plugins.intra.example.com/index.json
```

## 本地联调

不用 registry、不用内网：

```bash
node scripts/serve.mjs          # 起在 8899，同时提供 /index.json 和 /npm/<pkg>
curl http://127.0.0.1:8899/index.json
```

之后把索引源填 `http://127.0.0.1:8899/index.json`（与索引同源的 http 是允许的），
或在会话里直接装：

```
plugin_manager install_bundle  target="dsh-hello-world@0.1.0"  registry="http://127.0.0.1:8899/npm/"
```

装完**重启 DSH**（或等 HMR），左侧栏会出现一条 Hello World，点开就是居中的 hello world。

## 一条经验

DSH 没有「自动更新」。装上的版本被 `--save-exact` 钉死，用户不去点「已安装」页的
检查更新就不会动。所以本仓库的更新节奏完全由 `index.json` 控制：想让全员升级，就
把新版本写进 `releases.json`；想压住某个版本，就在索引里 `deprecated` 掉或者干脆
不列它。
