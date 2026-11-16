# 仓库约定

本文件面向在本仓库里干活的 Agent，也适用于人。面向使用者的介绍在 [README.md](README.md)。

## 文档语言

- 本仓库所有面向人的文档**只用中文**：`README.md`、`plugins/*/README.md`、以及后续新增的说明文件。
- 不再维护英文版 README，也不再新建 `README.en.md` / `README.zh.md` 之类的双语副本。
- 代码注释、日志与提交信息不受此限，保持当前的英文风格即可。
- `market/` 下的 `en` / `zh-cn` 是 DSH 索引格式要求的字段，不是文档，不要删除。

## 不要手工编辑的文件

- `market/index.json` 由 `base.json` + `meta/*.json` + `releases.json` 合成，改完要重新执行
  `node scripts/build-index.mjs`。

## 校验

改动 `market/` 相关内容后，提交前至少跑一次：

```bash
node scripts/build-index.mjs --check
```

## 项目结构

```
dsh-market/
├── market/
│   ├── config.json           # 索引地址、安装镜像、发布模式
│   ├── base.json             # 市场标题、描述、分类/标签/排序声明
│   ├── releases.json         # 已发布的版本及其对应 commit
│   ├── meta/<pkg>.json       # 单个插件的展示信息
│   └── index.json            # 生成产物，DSH 消费的文件（format 1）
├── plugins/
│   └── dsh-plugin-hello/     # 示例插件
└── scripts/
    ├── build-index.mjs       # 合成并校验 index.json（--check / --verify）
    ├── release.mjs           # 记录一次发布
    ├── mirror.sh             # 刷新供本地 git+file:// 安装使用的裸镜像
    └── serve.mjs             # 通过 HTTP 提供 market/，便于本地检查
```

DSH 通过 `git+https://…git#<commit>&path:/plugins/<pkg>` 安装插件，索引里每个版本都钉死一个 commit，
所以"发布"就是：升版本、记录 commit、重建索引、push。

## 新增一个插件

一件插件是本仓库里的一个子目录，市场索引和插件源码在同一个仓库，这是整个方案的前提。

1. **写目录** `plugins/<name>/`，至少包含：
   - `package.json`——`name` 与目录名一致，`dsh.bundle.patch` 指向宿主端补丁层，
     `dsh.client` 声明浏览器端（`platform`、`inject`），`engines.dsh` 写兼容范围。
   - `cordis.patch.yml`——补丁层，向 loader 插入一条同名条目。
   - `lib/index.js`（宿主端）和可选 `lib/client.js`（浏览器端）。
   - `README.md`——「发现」的详情页读的就是这份文件，写它等于写插件介绍。
2. **写展示信息** `market/meta/<name>.json`：`title`、`description`（都要 `en` / `zh-cn` 两份）、
   `icon`、`category`、`labels`、`keywords`、`repository`。`category` 和 `labels` 必须是
   `market/base.json` 里声明过的 id，出现未声明的值会让**整个索引**被拒绝；要新增分类或标签，
   先在 `base.json` 的 `metadata.categories` / `metadata.labels` 里加。
3. **发布**：按下面「发布一个版本」走一遍。

索引只按 `releases.json` 生成：只加了目录、没有版本记录，插件不会出现在「发现」里；反过来，
`releases.json` 里有记录却缺 `meta/<name>.json`，构建直接报错退出。

参考实现是 `plugins/dsh-plugin-hello`，它的 README 解释了宿主端与浏览器端如何拼出一个侧边栏标签。

## 发布一个版本

```bash
# 1. 升版本并提交插件源码
cd plugins/dsh-plugin-hello && pnpm version patch && cd ../..
git add -A && git commit -m "release dsh-plugin-hello"

# 2. 记录发布（把当前 HEAD commit 写入 releases.json）
node scripts/release.mjs dsh-plugin-hello

# 3. 重建并校验，然后提交并 push
node scripts/build-index.mjs --verify
git add market/ && git commit -m "publish index" && git push
```

顺序很重要：`release.mjs` 记录当前 HEAD，所以先提交插件源码，再记录版本，最后提交索引。版本已记录、
新版本不比已记录的最新版本更大、或工作区有未提交改动时（除非 `--allow-dirty`），它会拒绝执行。

`--verify` 用 DSH 自己的 `parseMarketIndex` 复检，本地通过即保证能被接受。解析器按顺序加载：
仓库 `node_modules` 里的 `@deepseek-ai/dsh-plugin-market-index`（`npm install`，不要用
`pnpm install`，它会卡住）→ `DSH_PACKAGES_DIR` 下的同一个包 → 都没有则报错退出。

macOS 上 DSH 的包在 `app.asar` 内，普通 `node` 无法 import。要复用已安装 DSH 自带的解析器：

```bash
DSH_PACKAGES_DIR="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai" \
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  scripts/build-index.mjs --verify
```

发布后用户侧在插件 → 发现看到新版本，或插件 → 已安装 → 检查更新。DSH 没有后台自动更新，
不发索引就不推送。

## 本地开发

```bash
node scripts/serve.mjs        # http://127.0.0.1:8899/index.json
```

把索引源指向该地址即可。直接从本地 clone 安装可完全绕过 HTTP——`git+file://` 会被
`parseInstallSpec` 识别为路径式来源：

```bash
./scripts/mirror.sh          # 重建 ../dsh-market.git
plugin_manager install_bundle  target="git+file://<绝对路径>/dsh-market.git#<40 位 commit>&path:/plugins/dsh-plugin-hello"
```

镜像里的 commit 必须保持可达，否则 profile 后续的 `pnpm install` 会失败。安装后重启 DSH，
侧边栏会出现 **Hello dsh-plugin**。

## 已知限制

- 索引里的 `commit` 必须是 40 位小写十六进制，短 SHA 和分支名会被拒绝。
- `url` 必须是 https、规范形式、至少两段路径，且不能带 query 或 fragment。
- 整个索引整体校验，一条规则不通过就全拒，错误会指向具体 JSON 路径。
- 「发现」的详情页会读取 `plugins/<pkg>/README.md`。
