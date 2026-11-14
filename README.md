# dsh-internal-market

公司内部的 DSH 插件市场。**全部内容都在一个私有 Git 仓库里**：索引是仓库里的一个
JSON 文件，插件是仓库里的子目录。不需要 npm registry，不需要 Nexus，也不需要发到
GitHub。

DSH 用 `git+https://…git#<commit>&path:/plugins/<pkg>` 安装插件，索引里每个版本都
钉死一个 commit —— 也就是说「发布」= 打 tag + 改索引里的 commit。

```
dsh-internal-market/
├── market/
│   ├── config.json           # 索引 URL、内网 Git 地址、发布模式
│   ├── base.json             # 索引公共部分：标题、描述、分类 / 标签 / 排序键声明
│   ├── releases.json         # 每个插件发布过哪些版本 + 对应 commit（由 release.mjs 维护）
│   ├── meta/<pkg>.json       # 每个插件的展示信息：标题、描述、图标、仓库地址
│   └── index.json            # ← 生成物，DSH 消费的就是这个文件（format 1）
├── plugins/
│   └── dsh-hello-world/      # 示例插件：左侧新增一个标签，点开是居中的 hello world
└── scripts/
    ├── build-index.mjs       # 合成并校验 index.json（--check 只校验，--verify 用 DSH 自带解析器再验）
    ├── release.mjs           # 记录一次发布：读 package.json 的 version → 写 releases.json + commit
    └── serve.mjs             # 本地把 market/ 挂成 HTTP（只为让 DSH 能读到 index.json）
```

`index.json` 由 `base.json` + `meta/*.json` + `releases.json` 合成，**不要手改**。

## 为什么索引还要走 HTTP

DSH 只接受 **绝对 http(s) URL** 作为索引源（`file://` 会被拒），所以即使插件本体走
Git，索引文件也得有个 HTTP 地址。生产上用内网 Git 服务自带的 raw 文件地址即可：

| 服务 | 索引 URL |
| --- | --- |
| GitLab | `https://git.intra/dsh/dsh-internal-market/-/raw/main/market/index.json` |
| Gitea / Gogs | `https://git.intra/dsh/dsh-internal-market/raw/branch/main/market/index.json` |
| 任意静态服务 | `https://dsh-plugins.intra/index.json` |

`market/config.json` 里的 `baseUrl` 就是填这个地址前缀，`build-index.mjs` 用它来解析
索引内部的相对引用。

## 发布一次新版（CI 里就这三步）

```bash
# 1. 改版本号并提交
cd plugins/dsh-hello-world && pnpm version patch && cd ../..
git add -A && git commit -m "release dsh-hello-world"

# 2. 记录版本（自动写入当前 HEAD 的 40 位 commit）
node scripts/release.mjs dsh-hello-world

# 3. 重建索引 + 用 DSH 自带解析器校验 + 提交
node scripts/build-index.mjs --verify
git add market/ && git commit -m "publish index" && git push
```

顺序不能反：`release.mjs` 记录的是**当前 HEAD**，所以必须先提交插件改动，再记录版本，
最后提交索引。它会在以下情况拒绝执行：

- 版本号已经记录过（要发新版就得先 bump）；
- 新版本不高于已记录的最新版本；
- 工作区不干净（除非 `--allow-dirty`，但那样记录的 commit 里没有你的改动）。

用户那边看到新版的方式：打开 **插件 → 发现**，卡片上出现更新；或者 **插件 → 已安装**
里点检查更新。DSH 没有后台自动更新，所以节奏完全由你控制 —— 想让全员升级就发索引，
想按住就暂时不更新 `index.json`。

## 桌面端怎么接入

1. **打开实验开关**：插件页 → Experimental plugins → 打开「自定义插件索引」。
   这会挂上 `@deepseek-ai/dsh-experimental-plugin-market-bundle`，出现「发现」标签页。
2. **添加索引源**：插件 → 发现 → 管理索引源… → 填内网 Git 的 raw 地址。
   索引源只能由用户自己增删，agent 侧的 `plugin_market` 工具是只读的。
3. 企业批量下发可以在 profile 的 `cordis.patch.yml` 预置默认索引源：

```yaml
- id: plugin-market
  config:
    indexes:
      - https://git.intra/dsh/dsh-internal-market/-/raw/main/market/index.json
```

## Git 安装会用到哪些认证

- DSH 调 `pnpm add git+https://…`，git 使用用户自己的 credential helper
  （`~/.gitconfig` 的 `credential.helper`）和 `url.<base>.insteadOf` 配置。
- DSH 在安装前做 `git ls-remote` 探活时会禁用 credential helper 且不提示输入
  （`GIT_TERMINAL_PROMPT=0`），所以私有仓库如果必须登录，探活会报 `unknown`——
  这不阻塞安装，只是少一次提前校验。
- 结论：**用内网 Git 的部署 token（read-only）配在用户机器的 credential helper 里**，
  不要把 token 写进索引 URL（DSH 会拒绝带凭据的 URL）。

## 本地联调

```bash
node scripts/serve.mjs      # http://127.0.0.1:8899/index.json
```

把索引源填 `http://127.0.0.1:8899/index.json`；或者跳过界面直接装（用本仓库当远端）：

```bash
git clone --bare . /tmp/mirror/dsh-internal-market.git
```

```
plugin_manager install_bundle  target="git+file:///tmp/mirror/dsh-internal-market.git#<40位commit>&path:/plugins/dsh-hello-world"
```

装完重启 DSH，左侧栏出现 Hello World，点开是居中的 hello world。

## 已知边界

- **索引里的 `commit` 必须是 40 位小写 hex**，短 SHA 或分支名都会被拒。
- **`url` 必须是 https、canonical、路径至少两段**，且不能带 query / fragment。
- 私有 Git 仓库在「发现」详情页能读到 README（DSH 会对该 commit 做 partial clone），
  所以 `plugins/<pkg>/README.md` 值得写好。
- 一个索引被解析器整体校验：任何一条规则不满足，整个索引都会被拒，错误信息会指出
  JSON 路径。所以发索引前一定跑 `build-index.mjs --verify`。
