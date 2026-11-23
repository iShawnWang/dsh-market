/**
 * Host half of `dsh-auto-proxy`.
 *
 * The plugin has no tools, no routes, and no browser module. It contributes one
 * system-prompt section: when a network call fails, the agent should look for a
 * local proxy (Clash, Clash Verge, Mihomo, V2Ray, sing-box, Surge…) and retry
 * through it instead of giving up. Direct access stays the default — the
 * section only tells the agent what to do *after* a timeout, so a machine
 * without a proxy never pays for the check.
 *
 * The guidance is platform-specific on purpose. dsh mounts `bash` on POSIX and
 * `pwsh` on Windows, and the two share no dialect: `scutil`, `nc -G`, and
 * `lsof` do not exist on Windows, while `Test-NetConnection` does not exist on
 * macOS. Handing the model the wrong dialect costs a retry round-trip and can
 * make it conclude "(no proxy here)" when it never looked.
 */

const SECTION_NAME = 'auto-proxy:local-fallback';

/**
 * Sits just before the shell tool guidance (SECTION_ORDERS.TOOL_BASH is 1000,
 * TOOL_PWSH is 1010) so the agent reads "how to retry" before "how to run a
 * command".
 */
const SECTION_ORDER = 950;

const INTRO = `## 网络访问：先直连，失败后再找本地代理

默认直连。只有当请求**确实失败**时（超时、\`ECONNRESET\`、\`ETIMEDOUT\`、\`ENOTFOUND\`、TLS 握手失败、\`fetch failed\`、\`git clone\` 卡死、GitHub / Google API 无响应）才做下面的排查。不要一上来就挂代理，也不要为了"保险"给每条命令加代理前缀。
`;

const POSIX_STEPS = `
排查顺序（bash）：

1. **先看环境变量**：\`env | grep -i proxy\`。已经有了（\`http_proxy\` / \`https_proxy\` / \`all_proxy\`）就直接按第 5 步用。
2. **看系统代理**：macOS 用 \`scutil --proxy\`，读 \`HTTPProxy\` / \`HTTPSProxy\` / \`SOCKSProxy\` 和对应的 \`*Port\`；Linux 用 \`gsettings get org.gnome.system.proxy.http port\`，或看 \`~/.config/environment.d/\`。用户开了代理软件的"系统代理"时这里一定有值。
3. **探常用端口**：
   - 逐个探测（macOS 的 \`nc\` 用 \`-G\` 当连接超时，Linux 上改成 \`-w\`）：
     \`for p in 7890 7897 7891 1080 1087 10808 10809 6152 8080 8888; do nc -z -G 1 127.0.0.1 $p 2>/dev/null && echo "open $p"; done\`
   - 再看谁在监听：
     \`lsof -nP -iTCP -sTCP:LISTEN | grep -iE 'clash|mihomo|verge|v2ray|xray|sing-box|surge|tun2socks'\`
     （没有 \`lsof\` 的 Linux 上用 \`ss -lntp\`）
   - \`ps\` 在部分沙箱里会返回 \`Operation not permitted\`，别依赖它。
4. **读代理软件自己的配置拿真实端口**（比猜端口可靠，端口经常不是默认值）：
   - Clash Verge / Clash Verge Rev：\`~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/config.yaml\`（\`mixed-port\` / \`port\` / \`socks-port\`），另有 \`clash-verge.yaml\`
   - Clash / ClashX：\`~/.config/clash/config.yaml\`
   - Mihomo：\`~/.config/mihomo/config.yaml\`
   - V2RayU / V2RayX：\`~/.config/v2rayU/\`、\`~/Library/Preferences/\`
   - sing-box：\`~/.config/sing-box/config.json\`
   - Surge：\`~/Library/Application Support/Surge/Profiles/*.conf\`（\`http-listen\`）
5. **用找到的端口重试，代理只作用于这一条命令**，不要 \`export\` 进全局环境：
   \`https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 curl -sS -m 20 https://api.github.com/\`
   子进程型工具同理：\`https_proxy=... http_proxy=... git clone …\`、\`... gh api …\`、\`... npm install\`。
6. 通了就把这组前缀带到后续同类命令上；不通就按顺序换下一个端口。全都试不通，就如实说"本机没找到可用代理"并说明试过哪些端口，不要对着同一个死端口反复重试。
`;

const WINDOWS_STEPS = `
排查顺序（PowerShell，也就是 \`pwsh\` 工具）：

1. **先看环境变量**：\`Get-ChildItem env: | Where-Object Name -match 'proxy'\`，或直接读 \`$env:HTTPS_PROXY\` / \`$env:HTTP_PROXY\` / \`$env:ALL_PROXY\`。已经有值就直接按第 5 步用。
2. **看系统代理**：
   \`Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' | Select-Object ProxyEnable, ProxyServer\`
   \`ProxyServer\` 通常是 \`127.0.0.1:7897\`，也可能是 \`http=127.0.0.1:7897;https=127.0.0.1:7897\` 这种分段写法。再看一眼 WinHTTP：\`netsh winhttp show proxy\`。
3. **探常用端口**（\`Test-NetConnection\` 是 cmdlet，受限沙箱里也能跑；不要用 \`New-Object Net.Sockets.TcpClient\`，ConstrainedLanguage 下 .NET 类型会被拒）：
   \`foreach ($p in 7890,7897,7891,1080,1087,10808,10809,6152,8080,8888) { if (Test-NetConnection 127.0.0.1 -Port $p -InformationLevel Quiet -WarningAction SilentlyContinue) { "open $p" } }\`
   看谁在跑：
   \`Get-Process | Where-Object { $_.ProcessName -match 'clash|mihomo|verge|v2ray|xray|sing-box|surge' } | Select-Object ProcessName, Id\`
   端口归属：\`Get-NetTCPConnection -State Listen | Where-Object LocalPort -in 7890,7897,7891,1080 | Select-Object LocalPort, OwningProcess\`
4. **读代理软件自己的配置拿真实端口**（端口经常不是默认值）：
   - Clash Verge / Clash Verge Rev：\`$env:APPDATA\\io.github.clash-verge-rev.clash-verge-rev\\config.yaml\`（\`mixed-port\` / \`port\` / \`socks-port\`）
   - Clash for Windows：\`$env:USERPROFILE\\.config\\clash\\config.yaml\`
   - Mihomo Party：\`$env:APPDATA\\mihomo-party\\\`，或 \`$env:USERPROFILE\\.config\\mihomo\\config.yaml\`
   - V2RayN：\`$env:APPDATA\\v2rayN\\guiNConfig.json\`、\`config.json\`（看 \`inbounds[].port\`）
   - sing-box：\`$env:USERPROFILE\\.config\\sing-box\\config.json\`
5. **用找到的端口重试**。每次 \`pwsh\` 调用都是新进程，\`$env:\` 只影响本次调用，不会污染全局：
   \`$env:HTTPS_PROXY='http://127.0.0.1:7897'; $env:HTTP_PROXY=$env:HTTPS_PROXY; curl.exe -sS -m 20 https://api.github.com/\`
   子进程型工具同理，跟在同一个调用里：\`...; git clone ...\`、\`...; gh api ...\`、\`...; npm install\`。
   **必须写 \`curl.exe\`**：Windows PowerShell 里 \`curl\` 是 \`Invoke-WebRequest\` 的别名，参数完全不同，直接写 \`curl\` 会报参数错。
6. 通了就把这两行带到后续同类命令上；不通就按顺序换下一个端口。全都试不通，就如实说"本机没找到可用代理"并说明试过哪些端口。

如果这个环境给的是 \`bash\` 工具而不是 \`pwsh\`（Git Bash、WSL），把上面的 cmdlet 换成 bash 写法：\`env | grep -i proxy\`、\`nc -z -w 1 127.0.0.1 <port>\`，第 4 步的配置路径照样能用（Git Bash 里 \`$env:APPDATA\` 对应 \`$APPDATA\`）。
`;

const RULES = `
几个必须记住的约束：

- **代理 URL 只认 \`http://\` 和 \`https://\`**。\`socks5://\` 只对 \`curl\` / \`git\` 这类子进程有效；DSH 进程内的 fetch 不支持 SOCKS，别把它写进环境指望能生效。
- **DSH 自己的 \`web_fetch\` / \`web_search\` 等请求只在进程启动时读一次环境变量**，运行期再改也不会改它们的路线。这类请求超时时，改用 shell 里带代理前缀的 curl 自己去把内容取回来。
- 想让它对 DSH 全局长期生效，唯一正规做法是往 \`$DSH_HOME/.env\`（Windows 上是 \`%USERPROFILE%\\.dsh\\.env\`）写一行 \`HTTPS_PROXY=http://127.0.0.1:7897\` 并重启 DSH。这一步会改变整个进程的出网路线，**必须先问用户**，不要自己改。
- 用户的代理地址不是固定值：端口来自实测，不要照抄示例里的 7897。
`;

/**
 * The shell tool follows the platform: `bash` on POSIX, `pwsh` on Windows.
 * Keeping the two dialects in separate branches means the model never sees a
 * command it cannot run.
 */
const PROMPT = `${
  INTRO + (process.platform === 'win32' ? WINDOWS_STEPS : POSIX_STEPS) + RULES
}`;

/**
 * Plugin entry point.
 * @param {object} ctx - plugin context.
 */
export function apply(ctx) {
  // `systemPrompt` is a core service but is only touched inside the inject
  // callback; older Cordis builds refuse undeclared property access, so it is
  // declared here as well (same pattern as dsh-free-search).
  ctx.inject(['systemPrompt'], (sctx) => {
    sctx.effect(() => {
      const dispose = sctx.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text: PROMPT,
        // The text contains no `{{variable}}` placeholders; keep it literal so
        // a future edit cannot accidentally make prompt assembly throw.
        interpolate: false,
      });
      return () => dispose();
    }, 'auto-proxy: local proxy fallback guidance');
  });
}
