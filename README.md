# dsh-market

一个完全托管在单个 Git 仓库里的 [DeepSeek Harness](https://github.com/deepseek-ai) 插件市场：
没有 registry、没有服务器、没有构建后端。索引就是本仓库中的一个 JSON 文件，每个插件都是同一个
仓库的子目录。

DSH 通过 `git+https://…git#<commit>&path:/plugins/<pkg>` 安装插件，索引里每个版本都钉死一个 commit，
所以"发布"就是：升版本、记录 commit、重建索引、push。

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

`index.json` 由 `base.json` + `meta/*.json` + `releases.json` 合成，不要手工编辑。

## 在 DSH 中添加本市场

任选一个索引地址，内容完全一致：

| 所在地区 | 索引地址 |
| --- | --- |
| 任意地区 | `https://raw.githubusercontent.com/iShawnWang/dsh-market/main/market/index.json` |
| 中国大陆 | `https://gcore.jsdelivr.net/gh/iShawnWang/dsh-market@main/market/index.json` |
| 中国大陆（备选） | `https://gh-proxy.com/https://raw.githubusercontent.com/iShawnWang/dsh-market/main/market/index.json` |
| 中国大陆（备选） | `https://ghfast.top/https://raw.githubusercontent.com/iShawnWang/dsh-market/main/market/index.json` |

1. 插件 → 实验性插件 → 开启 **自定义插件索引**。
2. 插件 → 发现 → 管理索引源… → 粘贴地址。索引源只能由用户添加。
3. 要在团队内预置，写进 profile 的 `cordis.patch.yml`：

```yaml
- id: plugin-market
  config:
    indexes:
      - https://gcore.jsdelivr.net/gh/iShawnWang/dsh-market@main/market/index.json
```

## 插件安装同样走镜像

安装地址与索引地址是两回事，它被写进 `index.json` 里每个版本的 `source.url`，由
`market/config.json` 控制：

- `git.url`——官方仓库地址。
- `git.installUrl`——可选；设置后 `build-index.mjs` 会把它写进索引，留空则直接从 GitHub 安装。

它必须是真正的 Git 端点。`ghfast.top`、`gh-proxy.com` 的 `/<host>/<owner>/<repo>` 形式可以 clone：

```
https://ghfast.top/github.com/iShawnWang/dsh-market
https://gh-proxy.com/github.com/iShawnWang/dsh-market
```

同一个代理的 `/https://github.com/…` 形式只用于文件下载，会被索引解析器拒绝。jsDelivr 同理，
它只能提供文件、不能 clone，**不要把 `installUrl` 指向 CDN**。

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

用户侧在插件 → 发现看到新版本，或插件 → 已安装 → 检查更新。DSH 没有后台自动更新，不发索引就不推送。

## 不通过界面安装

```
plugin_manager install_bundle  target="git+https://ghfast.top/github.com/iShawnWang/dsh-market.git#<40 位 commit>&path:/plugins/dsh-plugin-hello"
```

显式传入 `registry`，例如 `registry="https://registry.npmmirror.com/"`：DSH 启动 pnpm 时会清洗环境变量，
直连 `registry.npmjs.org` 可能超时。

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

镜像里的 commit 必须保持可达，否则 profile 后续的 `pnpm install` 会失败。安装后重启 DSH，侧边栏会出现
**Hello dsh-plugin**。

## 已知限制

- 索引里的 `commit` 必须是 40 位小写十六进制，短 SHA 和分支名会被拒绝。
- `url` 必须是 https、规范形式、至少两段路径，且不能带 query 或 fragment。
- 整个索引整体校验，一条规则不通过就全拒，错误会指向具体 JSON 路径。
- 「发现」的详情页会读取 `plugins/<pkg>/README.md`。

## 许可

MIT
