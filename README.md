# dsh-market

一个完全托管在单个 Git 仓库里的 [DeepSeek Harness](https://github.com/deepseek-ai) 插件市场：
**没有 registry、没有服务器、没有构建后端**——索引就是本仓库中的一个 JSON 文件，每个插件都是
同一个仓库的子目录。

DSH 通过 `git+https://…git#<commit>&path:/plugins/<pkg>` 安装插件，索引里每个版本都钉死一个
确切的 commit——所以所谓的"发布"无非是：升版本、记录 commit、重建索引、push。

```
dsh-market/
├── market/
│   ├── config.json           # 索引地址、安装镜像、发布模式
│   ├── base.json             # 市场级信息：标题、描述、分类/标签/排序声明
│   ├── releases.json         # 已发布的版本，以及发布时对应的 commit
│   ├── meta/<pkg>.json       # 单个插件的展示信息：标题、描述、图标、仓库地址
│   └── index.json            # ← 生成产物；DSH 消费的就是这个文件（format 1）
├── plugins/
│   └── dsh-plugin-hello/     # 示例插件：一个显示居中 "Hello dsh-plugin" 的侧边栏标签
└── scripts/
    ├── build-index.mjs       # 合成并校验 index.json（--check / --verify）
    ├── release.mjs           # 记录一次发布：读取 package.json 版本 → releases.json + commit
    ├── mirror.sh             # 刷新供本地 git+file:// 安装使用的裸镜像
    └── serve.mjs             # 通过 HTTP 提供 market/ 目录，便于本地检查
```

`index.json` 由 `base.json` + `meta/*.json` + `releases.json` 合成——不要手工编辑它。

## 在 DSH 中添加本市场

从下列索引地址中**任选一个**，它们提供的都是同一份 `market/index.json`：

| 所在地区 | 索引地址 |
| --- | --- |
| 任意地区（官方地址） | `https://raw.githubusercontent.com/iShawnWang/dsh-market/main/market/index.json` |
| 中国大陆（最快） | `https://gcore.jsdelivr.net/gh/iShawnWang/dsh-market@main/market/index.json` |
| 中国大陆（备选） | `https://ghfast.top/https://raw.githubusercontent.com/iShawnWang/dsh-market/main/market/index.json` |
| 中国大陆（备选） | `https://gh-proxy.com/https://raw.githubusercontent.com/iShawnWang/dsh-market/main/market/index.json` |

`jsdelivr.net` 在中国大陆可以访问，但限流很严重——实测结果：`cdn.jsdelivr.net` 3 次全部超时，
`gcore.jsdelivr.net` 3 次全部成功，平均 **0.8 秒**，`ghfast.top` 3.7 秒，`gh-proxy.com` 1.6 秒。
`fastly.jsdelivr.net` 可用但需要约 10 秒。国内优先用 **gcore** 或 **gh-proxy**，其他地区用 raw 地址。

然后：

1. **打开实验开关**：插件 → 实验性插件 → 开启 **自定义插件索引**。这会挂载
   `@deepseek-ai/dsh-experimental-plugin-market-bundle`，并新增「发现」标签页。
2. **添加索引源**：插件 → 发现 → 管理索引源… → 粘贴上面的 URL。索引源只能由用户手动添加，
   agent 侧的 `plugin_market` 工具是只读的。
3. 如果要在整个团队内预置，把它写进 profile 的 `cordis.patch.yml`：

```yaml
- id: plugin-market
  config:
    indexes:
      - https://gcore.jsdelivr.net/gh/iShawnWang/dsh-market@main/market/index.json
```

## 为什么索引仍然需要 HTTP

DSH 只接受**绝对 http(s) URL** 作为索引源（`file://` 会被拒绝），所以即便是纯 Git 的市场，
`index.json` 也需要一个 HTTP 端点。任何托管方式都行——GitHub raw、jsDelivr、CDN、GitLab
（`/-/raw/main/market/index.json`）、Gitea（`/raw/branch/main/market/index.json`），或者普通静态托管。

`market/config.json` 里的 `baseUrl` 是官方地址；`mirrorBaseUrls` 列出的是备选地址，仅作为给用户的
文档说明——所有地址返回的索引内容完全一致。

## 插件安装同样走镜像

**安装地址与索引地址是两回事**，它被写进 `index.json` 里每个版本的 `source.url`：

```jsonc
"source": {
  "type": "git",
  "url": "https://ghfast.top/github.com/iShawnWang/dsh-market",
  "commit": "64b4e2631df2f4e907658eaf3cf7c88b2d14cf73",
  "path": "plugins/dsh-plugin-hello"
}
```

它由 `market/config.json` 控制：

- `git.url`——官方仓库地址（`https://github.com/iShawnWang/dsh-market`）。
- `git.installUrl`——可选；一旦设置，`build-index.mjs` 会把**这个**地址写进索引。留空则直接从
  GitHub 安装。

**它必须是一个真正的 Git 端点。** `ghfast.top`、`gh-proxy.com` 这类 GitHub 代理会转发 Git 协议
流量，可以正常工作：

```
https://ghfast.top/github.com/iShawnWang/dsh-market     # git clone 可用，本机 6 秒
https://gh-proxy.com/github.com/iShawnWang/dsh-market   # git clone 可用，本机 6 秒
```

同一个代理的 `/https://github.com/…` 形式只用于文件下载，**会被索引解析器拒绝**——
`source.url must name a repository with at least two path segments`。jsDelivr 同样只能提供文件：
`parseMarketIndex` 恰好能接受 `https://cdn.jsdelivr.net/gh/<owner>/<repo>@main`，`marketInstallTarget`
也会顺利生成安装 spec，但随后的 clone 会失败并报
`remote: Couldn't find the requested file /info/refs`。**永远不要把 `installUrl` 指向 CDN。**

发布一个镜像前，先验证它真能 clone：

```bash
git clone --no-checkout "https://ghfast.top/github.com/iShawnWang/dsh-market.git" /tmp/probe
git -C /tmp/probe cat-file -t <40 位 commit>
```

## 发布一个版本

```bash
# 1. 升版本并提交插件源码
cd plugins/dsh-plugin-hello && pnpm version patch && cd ../..
git add -A && git commit -m "release dsh-plugin-hello"

# 2. 记录发布（把当前 HEAD commit 写入 releases.json）
node scripts/release.mjs dsh-plugin-hello

# 3. 重建并用 DSH 自己的解析器校验，然后提交并 push
node scripts/build-index.mjs --verify
git add market/ && git commit -m "publish index" && git push
```

`--verify` 跑的是 DSH 在用户打开「发现」页时使用的同一个 `parseMarketIndex`，因此本地通过的索引
一定能被接受。它按下列顺序加载解析器：

1. 仓库 `node_modules` 里的 `@deepseek-ai/dsh-plugin-market-index`（先 `npm install`；
   **不要**用 `pnpm install`，它在本仓库会卡住）；
2. `DSH_PACKAGES_DIR` 下的同一个包；
3. 都没有则打印两次失败原因并以非零码退出。

> 在 macOS 上，DSH 的包位于 `app.asar` 内，普通 `node` 无法直接 import。若想复用已安装 DSH
> 自带的解析器而不引入依赖：
>
> ```bash
> DSH_PACKAGES_DIR="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai" \
> ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
>   scripts/build-index.mjs --verify
> ```

顺序很重要：`release.mjs` 记录的是**当前 HEAD**，所以先提交插件源码，再记录版本，最后提交索引。
以下情况它会拒绝执行：

- 该版本已被记录（请先升版本）；
- 新版本不比已记录的最新版本更大；
- 工作区有未提交改动（除非加 `--allow-dirty`，但那样记录的 commit 里不含你的改动）。

用户如何看到新版本：**插件 → 发现** 会展示新版本，或在 **插件 → 已安装 → 检查更新** 中升级。
DSH 没有后台自动更新，节奏完全由发布者掌控——发布索引即推送给所有用户，不动 `index.json`
就让所有人停留在当前版本。

## 不通过界面安装

```
plugin_manager install_bundle  target="git+https://ghfast.top/github.com/iShawnWang/dsh-market.git#<40 位 commit>&path:/plugins/dsh-plugin-hello"
```

显式传入 `registry`（`registry="https://registry.npmmirror.com/"` 在国内可用）。安装会重新解析整个
profile，而 DSH 启动 pnpm 时会清洗环境变量、丢掉代理配置，所以直连 `registry.npmjs.org` 可能超时。

## 本地开发

```bash
node scripts/serve.mjs        # http://127.0.0.1:8899/index.json
```

把索引源指向 `http://127.0.0.1:8899/index.json` 即可。

直接从本地 clone 安装可以完全绕过 HTTP——`git+file://` 会被 `parseInstallSpec` 识别为路径式来源：

```bash
./scripts/mirror.sh          # 重建 ../dsh-market.git
plugin_manager install_bundle  target="git+file://<绝对路径>/dsh-market.git#<40 位 commit>&path:/plugins/dsh-plugin-hello"
```

两点注意：

- 镜像里的 commit 必须保持可达，否则 profile 后续的 `pnpm install` 会失败——这也是镜像放在
  工作区旁边、并由 `mirror.sh` 负责刷新的原因；
- 同样要显式传入 `registry`（见上文）。

安装完成后重启 DSH：侧边栏会出现一行 **Hello dsh-plugin**，点击后主区域居中显示
`Hello dsh-plugin`。

## 已知限制

- **索引里的 `commit` 必须是 40 位小写十六进制**——短 SHA 和分支名都会被拒绝。
- **`url` 必须是 https、规范形式、至少包含两段路径**，且不能带 query 或 fragment。
- 「发现」的详情页能读取插件 README，因为 DSH 会对钉死的 commit 做 partial clone——所以
  `plugins/<pkg>/README.md` 值得认真写。
- 整个索引是作为一个整体校验的：任何一条规则不通过都会让全部内容被拒，错误信息会指向具体的
  JSON 路径。发布前务必先跑 `build-index.mjs --verify`。

## 许可

MIT
