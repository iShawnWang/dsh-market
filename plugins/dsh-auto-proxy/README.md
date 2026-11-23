# dsh-auto-proxy

网络失败时，提醒 agent「本机可能开着代理」——而不是对着超时反复重试或直接放弃。

这是一个**纯提示词插件**：没有工具、没有页面、没有浏览器端代码，也不改任何运行时设置。
它往系统提示词里加一段很短的说明，另外留一个文本文件，让不同会话之间能传递「这台机器上试通过哪些代理」。

## 为什么需要它

DSH 调 GitHub、Google 之类境外 API 时经常超时。多数人的机器上其实开着 Clash 或 Clash Verge，
但代理只配置在代理软件自己的设置里，DSH 进程不一定继承得到环境变量。
不懂情况的 agent 往往直接放弃，或者擅自 `export https_proxy=...` 塞进全局环境——后者更麻烦，
会把本来正常的国内请求也一起带上代理。

## 装上之后会发生什么

系统提示词里多出一节 `## 网络访问：先直连，失败后再考虑本地代理`（`order: 950`），
说的是：默认直连，只有请求确实失败时，才把「本机可能开着代理」当成一个可能原因。
具体怎么查、用哪个端口、怎么挂，交给 agent 当场判断——写死在提示词里只会固化成某一台机器的布局。

同时会在插件目录下放一个 `dsh-auto-proxy.txt`，并告诉 agent 路径：

```
## 网络访问：先直连，失败后再考虑本地代理
...
之前的会话可能已经在这台机器上找到过可用的代理，记录在这个文件里：
`<插件目录>/dsh-auto-proxy.txt`
失败时先读它。里面有地址就直接拿来试；这次如果又试出一个能用的，把地址追加进去
（一行一个，无所谓格式，插件不解析内容）。
```

这就是**跨会话记忆**的部分。插件**不解析、不校验、不清理过期**这个文件——它只是 agent 的记事本。
一个会话试通了 `http://127.0.0.1:7897` 就写一行，下一个会话读到就直接用。

## 那个 txt 到底装到哪去了

插件市场安装时，pnpm 用 hoisted 布局，包是**解到 profile 的 `node_modules` 下的真实目录**（不是软链），
所以记忆文件就在包里，跟着插件一起走：

```
<DSH_HOME>/profiles/<profile>/node_modules/dsh-auto-proxy/dsh-auto-proxy.txt
```

拿本机举例（`DSH_HOME=/Users/qckj/.dsh`，profile 叫 `desktop`）：

```
/Users/qckj/.dsh/profiles/desktop/node_modules/dsh-auto-proxy/dsh-auto-proxy.txt
```

Windows 上同一台机器换掉主目录前缀即可：

```
C:\Users\<用户名>\.dsh\profiles\desktop\node_modules\dsh-auto-proxy\dsh-auto-proxy.txt
```

不用猜——提示词里写的就是**当前这份安装解析出来的绝对路径**。插件启动时用
`import.meta.url` 反推出自己的包目录，再 `realpathSync` 解析符号链接（沙箱授权要求物理路径，
软链目录会被拒）。所以：

| 安装方式 | 包目录 | txt 文件位置 |
|---|---|---|
| 插件市场 / `git+https://` | `<DSH_HOME>/profiles/desktop/node_modules/dsh-auto-proxy/` | 该目录下 `dsh-auto-proxy.txt` |
| 本地 `link:` 开发 | 软链到你的仓库目录 | 仓库里的 `plugins/dsh-auto-proxy/dsh-auto-proxy.txt` |

两种方式下提示词里的路径都是对的，因为它们走的是同一个 `realpathSync`。

## 写权限是怎么解决的

插件装在 `node_modules/` 下，在会话工作区之外，沙箱默认**不允许 agent 写那里**。
所以插件在每个 agent 创建时调用 `ctx.sandboxPolicy.registerWritableRoot(session, 插件目录)`，
只把这一个目录授权出去。

这个授权是运行时状态，resume 或 fork 之后不保留，所以插件对每个新出现的 agent 都重新登记一次。

## 安装

```bash
plugin_manager install_bundle target="git+https://github.com/iShawnWang/dsh-market.git#<40 位 commit>&path:/plugins/dsh-auto-proxy"
```

装完重启 DSH 即可，不需要额外配置。若在「发现」里安装，直接点安装按钮。

## 不做什么

- 不注册任何工具，不占用工具名额。
- 不监听网络事件，不主动探测代理。
- 不解析、不校验记忆文件的内容，也不管里面的记录是否过期。
- 不改 `process.env`，不写任何配置文件——`~/.dsh/.env` 只会在提示词里被「建议」，由用户拍板。
- 没有浏览器端，侧边栏不会多出任何东西。

## 兼容性

`engines.dsh`: `>=0.2.2-rc.1 <0.3.0-0`。依赖 `systemPrompt` 和 `sandboxPolicy` 两个服务。

提示词不含任何平台专属命令，macOS、Linux、Windows 通用。记忆文件随插件目录走，
重装或升级插件时从头开始积累。

## 许可

MIT
