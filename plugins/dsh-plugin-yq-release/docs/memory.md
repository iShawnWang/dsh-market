# 发版经验记录

按「踩过一次就记下来」维护。这里每一条都来自真实的发版，不是设想；插件的行为改动也应以这些结论为依据。

## 一、先合并，再探构建机

两条腿的耗时差了一个数量级，顺序错了就会白等：

- **合并**走 GitLab MR，正常几秒：建单 → 轮询 `merge_status`（`checking` → `can_be_merged`，最多 15 次 × 2s ≈ 30s）→ 合并 → 读目标分支新提交。
- **小程序构建**第一步是探活构建机：3 次尝试、单次 5s 超时、失败间隔 1s / 3s，最坏 ≈ 20s 就该下结论。构建机平时会关机、地址也可能变，连不上是常态而不是故障。

历史问题（已修）：早先 qqc 分支把 `qqc.probe()` 放在 `gitlab.merge()` **之前**，构建机一关机就整个请求以 `BUILD_HOST_OFFLINE` 结束，连合并都不会发生 —— 而合并本来几秒就能做完、也不依赖构建机。现在的顺序是 **合并 → 读基准提交 → 探活 → 触发构建**，构建机离线时合并照样落地，只有最后一步报 `blocked`。

同理，对外汇报也应该按这个顺序：**合并一成功就先说**（MR 号 + 目标分支新 commit），构建作为独立的第二步，连不上就单独报 `blocked`，不要让构建机把合并的结果一起吞掉。

重试是安全的：源分支已经没有新提交时，插件建出的空 MR 会被自己关掉（`state: no-op`，「源分支没有新提交，空合并请求已关闭」），不会留下一个待合并的空单。但每重试一次仍会多一条构建Memory记录。

## 二、改了 lib/*.js 必须重载插件

- DSH 进程在启动时把插件模块读进内存，之后改磁盘上的 `lib/*.js` **不会生效**。
- 判断方法：在怀疑没生效的函数里临时插一行写文件或打日志，跑一次看有没有输出。没有输出，说明跑的还是旧模块，**不是**新写的逻辑有错。
- 重载方式：把插件条目关掉再打开（`plugin_manager` 的 target 要写 profile 里的 entryId，也就是 `cordis.patch.yml` 里那条的 `id`；写裸包名会报 `unknown-plugin`）。只重载这个插件比重启整个 DSH 便宜得多。
- 只有源码文件需要重载。`gitlabEndpoint` / `spugBaseUrl` / `qqcBaseUrl` 是 `.volatile()` 配置项，改完即时生效。

## 三、链路解析的四个坑

1. **点名项目时只按项目选链路。** 项目下只有一条链路时直接选中它，即使同时给了 `targetBranch` / `provider` 也不会校验一致性。所以 `plan` 里显示的 provider 和你说的话对不上时（比如要发小程序、plan 里却是 spug），多半是选了构建Memory里学到的另一条链路 —— 用 `chain` 显式点名。
2. **从构建Memory学到的链路是 `explicitOnly`。** 只给分支名、不给 project/chain 时会报「认不出链路：现有的链路都只能点名」，这是设计而不是 bug：构建Memory记的是「发过什么」，不是「哪些分支前缀该选中它」。
3. **只有手写 `detect` 的链路能被分支名认出来。** 想用 `feat/h5-xxx` 自动选中链路，必须在 `projects.<id>.chains.<chain>.detect` 里写 `h5-`；否则永远要靠点名。
4. **学到的链路取「最新成功」那条，不是最近一条。** 同一 `project/chain` 有多次记录时，成功记录优先于任何失败记录，同一结果再比时间。失败的目标分支经常是打错的（第一次写错的名字往往最早写进去），只有跑通过的那次才证明这个目标是真的。一条从未成功过的链路会保留它最新的一条记录，不至于凭空消失。所以目标分支改名后，重新发成功一次，学到的链路就会跟着更新；这之前 `plan` 里显示的还是旧名字，别照着旧名字点。

以上三条都遵守同一条底线：**认不出就报错，认出多条也报错，绝不猜** —— 猜错就是发错环境。

## 四、构建机连不上怎么判断

探活失败会返回 `blocked` + `BUILD_HOST_OFFLINE`，带上地址和尝试次数。手工确认看三件事就够，不需要扫网段：

1. `curl` 构建机 `health` 超时；
2. `ping` 构建机丢包；
3. `traceroute` 的流量走到公网出口（说明根本不在同一网段，而不是机器没开机）。

三种情况都不需要继续找：开机的解决办法是把机器连回来或改 `qqcBaseUrl`，插件只能报 blocked，不会自己等。

构建机的项目别名（如 `qqc` / `mp` / `养车`）由构建机自己解析，插件原样透传。

## 五、构建Memory里的条目 ≠ 插件跑通过

构建Memory是追加写的历史事实，早期会混进「事后补记」的条目（`note` 里会写明那次其实是手工点的发布）。判断一次发布是否真走了插件，看这几个字段：

- `code` 是 `OK`；
- 有 `spug_request_id`（Spug 链路）或非空 `commit_id`；
- `merge.result` 是 `success` / `skipped`，而不是 `failed`。

## 六、失败码对照

| code | 含义 | 下一步 |
| --- | --- | --- |
| `CHAIN_UNRESOLVED` | 认不出链路 | 点名 `chain`，或补 `project` + `targetBranch` + `provider` + `app` |
| `BRANCH_REQUIRED` | 要合并却没给源分支（Spug 与 qqc 两条链路都会抛） | 补 `branch`；确实只想发目标分支现状，就显式设 `skipMerge=true` |
| `ENDPOINT_NOT_CONFIGURED` | 地址没填全 | 在面板「配置」里补，插件在任何网络请求之前就停 |
| `MISSING_CREDENTIAL` | 凭据缺失 | 在面板填 `GITLAB_ACCESS_TOKEN` / `SPUG_USERNAME` / `SPUG_PASSWORD` |
| `MERGE_CONFLICT` | 合并冲突 | **人工解决**，插件没有自动解决冲突的代码路径 |
| `BUILD_HOST_OFFLINE` | 构建机连不上 | 开机或改地址后重试，不要反复重试 |
| `SPUG_ERROR` | Spug 接口报错 | 看 `message`，例如发布配置没配主机 |
| `SPUG_TIMEOUT` / `QQC_TIMEOUT` | 等结果超时 | 到 Spug / 构建机看实际状态，插件不无限等 |
| `QQC_BUILD_FAILED` | 构建日志里没有 `Build successful` | 看返回的日志尾巴 |
| `PROD_CONFIRMATION_REQUIRED` | 发线上要再确认一次 | 带 `confirmProd=true` 重试 |

## 七、环境备忘

- **node 可能不在 PATH 里**（用 nvm / fnm 之类版本管理器装的常见）。跑脚本前先确认 `node -v` 能出来，出不来就先把对应版本的 bin 目录加进 `PATH`。
- 凭据统一走 DSH 凭据库（`GITLAB_ACCESS_TOKEN` / `SPUG_USERNAME` / `SPUG_PASSWORD`），插件不读任何别的工具留在磁盘上的 `.env`，所以别的工具留下的密钥不会替用户发版。
- 想直接调 provider 验证接口时，`lib/providers/*.js` 都可以单独 import（ESM）：`new GitLabClient({ endpoint, token }).merge({...})`、`new SpugClient({ baseUrl }).login(...)`、`new QqcClient({ baseUrl }).probe()`。这样验证的是插件自己的代码路径，而不是另写一个 curl。
