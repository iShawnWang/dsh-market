# dsh-auto-proxy

网络失败时，让 agent 自己去本机找一个能用的代理端口，而不是对着超时干瞪眼。

这是一个**纯提示词插件**：没有工具、没有页面、没有浏览器端代码，也不改任何运行时设置。
它只往系统提示词里加一段说明——**默认直连**，只有请求真的失败以后才去排查本机代理。

## 为什么需要它

DSH 调 GitHub、Google 之类境外 API 时经常超时。多数人的机器上其实开着 Clash 或 Clash Verge，
但代理只配置在代理软件自己的设置里，DSH 进程不一定继承得到 `https_proxy`。
不懂情况的 agent 往往会：直接放弃、反复重试同一条死路、或者擅自 `export https_proxy=...`
塞进全局环境——最后一种最讨厌，会把本来正常的国内请求也一起带上代理。

这个插件给 agent 定了一条明确的纪律：先直连，失败了再按步骤找代理，找到后**只给这一条命令挂前缀**。

## 装上之后会发生什么

插件向系统提示词注入一节 `## 网络访问：先直连，失败后再找本地代理`（`order: 950`，
排在 bash 工具说明之前）。内容是一份排查顺序：

1. `env | grep -i proxy` —— 环境变量里已经有了就直接用。
2. `scutil --proxy`（macOS）—— 读系统代理里 `HTTPProxy` / `HTTPSProxy` / `SOCKSProxy` 的端口。
3. 探常用端口 —— `nc -z -G 1 127.0.0.1 <port>` 遍历 `7890 7897 7891 1080 1087 10808 10809 6152 8080 8888`，
   再 `lsof -nP -iTCP -sTCP:LISTEN | grep -iE 'clash|mihomo|verge|v2ray|xray|sing-box|surge|tun2socks'` 看谁在听。
4. 读代理软件自己的配置拿真实端口 —— 端口经常不是默认值，猜不如读：
   - Clash Verge / Clash Verge Rev：`~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/config.yaml` 里的 `mixed-port` / `port` / `socks-port`
   - Clash / ClashX：`~/.config/clash/config.yaml`
   - Mihomo：`~/.config/mihomo/config.yaml`
   - sing-box：`~/.config/sing-box/config.json`
   - Surge：`~/Library/Application Support/Surge/Profiles/*.conf` 的 `http-listen`
5. 用前缀只作用于单条命令重试：
   `https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 curl -sS -m 20 https://api.github.com/`
6. 通了就沿用这组前缀，不通就换下一个端口；全都试不通要如实说"本机没找到可用代理"，而不是无限重试。

提示词还写死了四条约束，避免 agent 帮倒忙：

- 代理 URL 只认 `http://` / `https://`。DSH 进程内的 fetch 不支持 SOCKS，`socks5://` 只对 `curl`、`git`
  这类子进程有效。
- DSH 自己的 `web_fetch` / `web_search` 在进程启动时读一次环境变量，运行期改了没用。这类请求超时就改用
  `bash` 里带代理前缀的 `curl` 自己去取。
- 想让代理对 DSH 全局长期生效，唯一正规做法是写 `$DSH_HOME/.env`（通常 `~/.dsh/.env`）再重启；
  这一步会改变整个进程的出网路线，**必须先问用户**。
- 端口来自实测，不要照抄示例里的 7897。

## 安装

```bash
plugin_manager install_bundle target="git+https://github.com/iShawnWang/dsh-market.git#<40 位 commit>&path:/plugins/dsh-auto-proxy"
```

装完重启 DSH 即可，不需要额外配置。若在「发现」里安装，直接点安装按钮。

## 不做什么

- 不注册任何工具，不占用工具名额。
- 不监听 session 或网络事件，不主动探测代理（探测只发生在 agent 读提示词并决定执行的时候）。
- 不改 `process.env`，不写任何配置文件——`~/.dsh/.env` 只会在提示词里被"建议"，由用户拍板。
- 没有浏览器端，侧边栏不会多出任何东西。

## 兼容性

`engines.dsh`: `>=0.2.2-rc.1 <0.3.0-0`。依赖 `systemPrompt` 服务的 `section()` 接口。

## 许可

MIT
