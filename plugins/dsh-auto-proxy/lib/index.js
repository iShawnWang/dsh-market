/**
 * Host half of `dsh-auto-proxy`.
 *
 * The plugin contributes one system-prompt section and one small text file. The
 * section says: direct access stays the default, and when a network call really
 * fails, a local proxy may be running. The file next to this plugin collects
 * whatever proxy addresses this machine has turned out to work in the past.
 *
 * The plugin does not parse, validate, expire, or curate that file. It is the
 * agent's notebook: a later session reads it, and a session that finds a working
 * proxy appends a line. Keeping the plugin out of the format means a malformed
 * line can never break prompt assembly.
 *
 * The file lives beside the plugin because that path is stable across sessions
 * and does not scatter DSH-home state. Installed plugins sit outside the
 * workspace, though, so the sandbox denies writes there by default — hence the
 * per-session writable-root grant in `apply`.
 */

import { mkdirSync, writeFileSync, accessSync, constants, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECTION_NAME = 'auto-proxy:local-fallback';

/**
 * Sits just before the shell tool guidance (SECTION_ORDERS.TOOL_BASH is 1000,
 * TOOL_PWSH is 1010) so the agent reads "what to try" before "how to run a
 * command".
 */
const SECTION_ORDER = 950;

/**
 * Plugin root, with symlinks resolved. Installed bundles live under
 * `node_modules/`, and the sandbox rejects a granted directory that is itself a
 * symlink, so the physical path is what gets registered.
 */
const PLUGIN_ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));

/** The agent's notebook: one proxy address per line, in whatever shape it likes. */
const MEMORY_FILE = join(PLUGIN_ROOT, 'dsh-auto-proxy.txt');

/**
 * Create the notebook on first mount so a later session always finds a real
 * file. Failure is not fatal: the prompt still names the path, and a read of a
 * missing file is a normal thing for the agent to report.
 */
function ensureMemoryFile() {
  try {
    accessSync(MEMORY_FILE, constants.F_OK);
  } catch {
    try {
      mkdirSync(dirname(MEMORY_FILE), { recursive: true });
      writeFileSync(
        MEMORY_FILE,
        '# 本机验证过可用的代理，一行一个。这个文件由 agent 自己维护，插件不解析内容。\n',
        { flag: 'wx' },
      );
    } catch {
      // Read-only mount or a racing writer: the prompt still works without it.
    }
  }
}

function buildPrompt() {
  return `## 网络访问：先直连，失败后再考虑本地代理

默认直连。只有请求**确实失败**时（超时、连接重置、DNS 解析失败、TLS 握手失败、\`fetch failed\`），才把"本机可能开着代理软件"列为一个可能原因。

之前的会话可能已经在这台机器上找到过可用的代理，记录在这个文件里：

\`${MEMORY_FILE}\`

失败时先读它。里面有地址就直接拿来试；这次如果又试出一个能用的，把地址追加进去（一行一个，无所谓格式，插件不解析内容）。

追加时用文件写工具（\`write\` / \`edit\`），不要用 shell 重定向：在 Windows 上，这类额外授权只对文件工具生效，沙箱子进程拿不到这个目录的写权限。没有记录或记录都试不通，就自己重新判断——端口和地址以当前机器的实际情况为准，不要假定默认值。

真要用代理，注意这几点：

- 代理只作用于需要它的那一条命令，不要写进全局环境，否则会牵连本来正常的请求。
- DSH 进程内的网络请求只在启动时读一次代理环境变量，运行期修改对它无效。
- 想让代理对 DSH 全局长期生效，需要改 \`$DSH_HOME/.env\` 并重启，这一步**必须先问用户**。
- 找不到就如实说明试过什么，不要对着同一个端口反复重试。
`;
}

/**
 * Plugin entry point.
 * @param {object} ctx - plugin context.
 */
export function apply(ctx) {
  ensureMemoryFile();

  // `systemPrompt` is a core service but is only touched inside the inject
  // callback; older Cordis builds refuse undeclared property access, so it is
  // declared here as well (same pattern as dsh-free-search).
  ctx.inject(['systemPrompt'], (sctx) => {
    sctx.effect(() => {
      const dispose = sctx.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text: buildPrompt(),
        // The text contains no `{{variable}}` placeholders; keep it literal so
        // a future edit cannot accidentally make prompt assembly throw.
        interpolate: false,
      });
      return () => dispose();
    }, 'auto-proxy: local proxy fallback guidance');
  });

  // The notebook lives inside the plugin package, which a normal install puts
  // under `node_modules/` — outside the session workspace, where the sandbox
  // denies writes. Grant exactly that one directory per session so the agent
  // can append what it found.
  //
  // Grants are runtime-only: they do not survive resume or fork, so they are
  // re-established for every agent that appears, not just the first. Agents
  // that already exist when this plugin mounts are covered by the loop, which
  // mirrors what dsh-permission-presets does for the same reason.
  ctx.inject(['sandboxPolicy', 'agents'], (sctx) => {
    const grant = (agent) => {
      try {
        sctx.sandboxPolicy.registerWritableRoot(agent.session, PLUGIN_ROOT);
      } catch {
        // No session, or a rejected path: the prompt still points at the file,
        // and a denied write is a normal result the agent can report.
      }
    };

    sctx.effect(() => {
      const dispose = sctx.on('agent/created', ({ agent }) => grant(agent));
      for (const agent of sctx.agents.list()) grant(agent);
      return () => dispose();
    }, 'auto-proxy: writable root for the memory file');
  });
}
