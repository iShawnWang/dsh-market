// dsh-plugin-fe-homepage — browser half.
//
// One sidebar tab that answers "这个项目的测试地址是什么" without leaving DSH.
// The page is a directory, not an app: every URL, step and screenshot is baked
// into this file, so there is no host bridge, no network call, and nothing to
// configure. Screenshots ship inside the package and are served from
// /plugins/dsh-plugin-fe-homepage/assets/<file> (the package's `./assets/*`
// export); colours come from the host's --dsw-alias-* tokens so the page
// follows the theme instead of pinning one.
//
// No bundler: the factory body is plain CJS and `require('react')` resolves to
// the shell's own React.

window.__ModuleLoader__.load({
  id: 'dsh-plugin-fe-homepage',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Must match the `main` slot key and the sidebar row id. */
    const PANEL_ID = 'dsh-plugin-fe-homepage';
    const ASSET_BASE = '/plugins/dsh-plugin-fe-homepage/assets/';

    const asset = (file) => ASSET_BASE + file;

    // ---------------------------------------------------------------- data
    //
    // Mirrors the team's 前端地址 document. Passwords never enter this file:
    // where the source lists an account it keeps only the account name, and
    // where it lists a password that field is gone entirely.

    /** Environment columns, in the order the document lists them. */
    const ENVS = [
      { id: 'dev', label: '开发' },
      { id: 'test', label: '测试' },
      { id: 'pre', label: '预生产' },
      { id: 'prod', label: '生产' },
    ];

    const PROJECTS = [
      {
        id: 'new-h5',
        name: 'new_H5',
        subtitle: '最新混合 H5',
        platform: '乔乔车 / 新版H5 / 前端 new_h5',
        repo: 'http://172.17.188.125:9001/yeqiao/app/yeqiao-mobile/-/tree/prods',
        repoNote: '分支区分',
        envs: {
          dev: 'https://devapph5pro.yeqiao.cn',
          test: 'https://apph5prodev.yeqiao.cn/#/',
          pre: 'https://preapph5pro.yeqiao.cn/#/',
          prod: 'https://apph5pro.yeqiao.cn/#/',
        },
      },
      {
        id: 'im',
        name: 'IM 聊天',
        platform: '乔乔车 / H5_IM聊天 / 前端 im',
        repo: 'http://172.17.188.125:9001/yeqiao/app/yeqiao-mobile/-/tree/im',
        repoNote: 'im 分支',
        envs: {
          dev: 'https://devappim.yeqiao.cn',
          test: 'https://imqycdev.yeqiao.cn',
          pre: 'https://preappim.yeqiao.cn',
          prod: 'https://appim.yeqiao.cn',
        },
      },
      {
        id: 'tiger',
        name: '老虎机 tiger',
        platform: '乔乔车 / 老虎机H5 / 前端 slot_machine',
        repo: 'http://172.17.188.125:9001/yeqiao/app/tiger',
        note: '因性能原因，测试环境部署在生产服务器上；原功能已废弃，目前只承载大转盘抽奖活动。',
        envs: {
          dev: 'https://devapph5pro.yeqiao.cn/tiger/',
          test: 'https://apph5pro.yeqiao.cn/tiger/',
          pre: 'https://preapph5pro.yeqiao.cn/tiger/',
          prod: 'https://apph5.yeqiao.cn/tiger/',
        },
      },
      {
        id: 'assistant',
        name: '助手 H5',
        platform: '助手端H5 assistant_h5',
        repo: 'http://172.17.188.125:9001/yeqiaocarplatformteam/assistant-h5.git',
        envs: {
          dev: 'https://dev-assistant.yeqiao.cn',
          test: 'https://test-assistant.yeqiao.cn/#/',
          pre: 'https://preassistant.yeqiao.cn',
          prod: 'https://assistant.yeqiao.cn',
        },
      },
      {
        id: 'eas-h5',
        name: '商务通 H5',
        platform: '商务通PADH5 easwebmanage_h5',
        repo: 'http://172.17.188.125:9001/yeqiao/eas/easwebmanage-h5',
        envs: {
          dev: 'https://eash4dev.yeqiao.cn',
          test: 'https://eash5test.yeqiao.cn',
          pre: 'https://eash5pre.yeqiao.cn',
          prod: 'https://eash5pro.yeqiao.cn',
        },
      },
      {
        id: 'restaurant',
        name: '点餐 iPad H5',
        platform: '点餐系统 restaurant',
        repo: 'http://172.17.188.125:9001/yeqiaocarplatformteam/restaurant',
        envs: {
          test: 'foodmenu-test.yeqiao.cn',
          prod: 'foodmenu.yeqiao.cn',
        },
      },
      {
        id: 'map',
        name: 'map',
        platform: '前端地图MAP',
        repo: 'http://172.17.188.125:9001/yeqiao/app/yeiqao_map',
        note: '老的地图项目，重新复活。',
        envs: {
          test: 'test-appmaph5.yeqiao.cn',
          prod: 'appmaph5.yeqiao.cn',
        },
      },
      {
        id: 'mp',
        name: '新小程序',
        platform: 'yeqiao-mobile · master-mp',
        repo: 'http://172.17.188.125:9001/yeqiao/app/yeqiao-mobile/-/tree/master-mp',
        release: 'npm run build:mp:prod',
      },
      {
        id: 'mp-old',
        name: '老小程序',
        platform: 'CommunityWebManage',
        repo: 'http://172.17.188.125:9001/yeqiao/car-platform/communitywebmanage',
        note: '已废弃。发版手动切换 common/pocky-request/config.js 的 baseURL。',
        deprecated: true,
      },
      {
        id: 'store',
        name: '门店端',
        platform: '门店端前端 store_side',
        repo: 'http://172.17.188.125:9001/yeqiaocarplatformteam/yeqiaocarspringcloud-vue',
        envs: {
          test: 'http://10.10.100.44:6080/login?redirect=%2Findex',
          prod: 'app.yeqiao.cn',
        },
      },
      {
        id: 'manager',
        name: '平台端',
        platform: '乔乔车管理端 / 前端 yeqiaocarmanager',
        repo: 'http://172.17.188.125:9001/yeqiao/app/yeqiaocarmanager',
        envs: {
          test: 'http://apideve.yeqiao.cn:9098/vhtml/login',
          prod: 'shop.yeqiao.cn',
        },
      },
      {
        id: 'eas',
        name: '商务通',
        platform: '商务通后台',
        repo: 'http://172.17.188.125:9001/yeqiao/eas/easwebmanage',
        envs: {
          test: 'https://easdeve.yeqiao.cn',
          prod: 'https://store.yeqiao.cn/',
        },
      },
      {
        id: 'insurance',
        name: '乔保险中介管理系统',
        platform: 'ydwf-manage / ydywf-metacenter-manages',
        repos: [
          'http://172.17.188.125:9001/yeqiao/insbusicore/ydwf-manage.git',
          'http://172.17.188.125:9001/yeqiao/insproduct/ydwf-metacenter-manages.git',
        ],
        envs: {
          test: 'https://deve.xiaojuledao.com/#/',
          prod: 'https://insure.ruianbaoxian.com/#/',
        },
      },
      {
        id: 'lease',
        name: '融资租赁',
        platform: 'qymap',
        envs: {
          test: 'https://qymapdev.yeqiao.cn/',
        },
      },
    ];

    const ENTRIES = [
      { id: 'gitlab', name: 'GitLab', url: 'http://172.17.188.125:9001/', shot: 'gitlab.webp' },
      { id: 'mail', name: '邮箱', url: 'http://mail.yeqiao.cn/', shot: 'mail.webp' },
      { id: 'oa', name: 'OA', url: 'http://yqoa.yeqiao.cn/', shot: 'oa.webp' },
      {
        id: 'zentao',
        name: '禅道',
        url: 'http://10.10.254.52/zentao/my/',
        shot: 'zentao.webp',
      },
    ];

    const APIS = [
      { id: 'test', label: '测试', url: 'https://api-test.yeqiao.cn' },
      { id: 'pre', label: '预生产', url: '', note: '暂废弃' },
      { id: 'prod', label: '生产', url: 'https://api.yeqiao.cn' },
    ];

    const TEST_ACCOUNTS = [
      { phone: '13998828370', who: '通用' },
      { phone: '18640473428', who: '超' },
      { phone: '13072459498', who: '铭' },
      { phone: '13164720800', who: '铭' },
    ];

    const MP_STEPS = [
      'pnpm i',
      'pnpm run build:mp:prod',
      '导入 dist/build/mp-weixin',
      '登录 mp.weixin.qq.com，选对应版本提交审核',
    ];

    const NODE14_STEPS = [
      'arch -x86_64 /bin/zsh',
      'export NVM_DIR="$HOME/.nvm"',
      'source "$NVM_DIR/nvm.sh"',
    ];

    // -------------------------------------------------------------- helpers

    /** Document shorthand omits the scheme on a few hosts; links need one. */
    function href(url) {
      if (!url) return '';
      return /^https?:\/\//i.test(url) ? url : `https://${url}`;
    }

    /** What the chip's tooltip shows: the URL without the scheme noise. */
    function bare(url) {
      return href(url).replace(/^https?:\/\//i, '').replace(/\/$/, '');
    }

    const envCount = (project) =>
      project.envs ? ENVS.filter((env) => Boolean(project.envs[env.id])).length : 0;

    // ---------------------------------------------------------------- styles
    //
    // One stylesheet, injected once. Everything is scoped under .feh- so it
    // cannot reach the shell's DOM, and every colour is a token or a color-mix
    // of one: the page owns no palette.

    const CSS = `
.feh-root {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  height: 100%;
  min-height: 100%;
  overflow: hidden;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: 13px/18px system-ui, -apple-system, "Segoe UI", sans-serif;
}
.feh-scroll {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 22px 26px 56px;
  scrollbar-width: thin;
}
.feh-inner { max-width: 1180px; margin: 0 auto; }

/* ---- head ---- */
.feh-head { margin-bottom: 20px; }
.feh-title {
  margin: 0;
  font-size: 19px;
  line-height: 26px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
/* ---- sections ---- */
.feh-section { margin-top: 26px; }
.feh-section:first-of-type { margin-top: 0; }
.feh-sec-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;
}
.feh-sec-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-secondary);
}
.feh-sec-hint { color: var(--dsw-alias-label-tertiary); font-size: 12px; }

/* ---- project grid ---- */
.feh-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(318px, 1fr));
  align-items: start;
  gap: 10px;
}
.feh-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 13px 11px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  transition: border-color 120ms ease, background 120ms ease;
}
.feh-card:hover { border-color: var(--dsw-alias-border-l3); }
.feh-card.feh-deprecated { opacity: 0.62; }
.feh-card-top { display: flex; align-items: center; gap: 7px; min-width: 0; }
.feh-name {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
a.feh-name:hover { color: var(--dsw-alias-link); text-decoration: underline; }
.feh-tag {
  flex: 0 0 auto;
  padding: 0 5px;
  height: 16px;
  line-height: 15px;
  border-radius: 4px;
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-tertiary);
  font-size: 10.5px;
}
.feh-note-btn {
  margin-left: auto;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: help;
}
.feh-note-btn:hover { color: var(--dsw-alias-label-primary); }
.feh-sub {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
  line-height: 15px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.feh-envs { display: flex; flex-wrap: wrap; gap: 5px; }
.feh-env {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  text-decoration: none;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.feh-env:hover {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent);
  color: var(--dsw-alias-label-primary);
}
.feh-env.feh-env-prod {
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 34%, transparent);
}
.feh-env.feh-env-prod:hover {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, transparent);
}
.feh-release {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.feh-repos { display: flex; flex-direction: column; gap: 2px; }
.feh-repos a {
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.feh-repos a:hover { color: var(--dsw-alias-link); text-decoration: underline; }

/* ---- entry cards ---- */
.feh-entries {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(228px, 1fr));
  gap: 10px;
}
.feh-entry {
  display: flex;
  flex-direction: column;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  overflow: hidden;
  text-decoration: none;
  color: inherit;
  transition: border-color 120ms ease;
}
.feh-entry:hover { border-color: var(--dsw-alias-border-l3); }
.feh-entry-shot {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 10;
  object-fit: cover;
  object-position: top center;
  background: var(--dsw-alias-bg-layer-2);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.feh-entry-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 10px 9px;
  min-width: 0;
}
.feh-entry-name { font-size: 12.5px; font-weight: 600; }
.feh-entry-host {
  margin-left: auto;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- api rows ---- */
.feh-apis { display: flex; flex-direction: column; gap: 1px; }
.feh-api {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  text-decoration: none;
  color: inherit;
}
.feh-api + .feh-api { margin-top: 5px; }
.feh-api-label {
  flex: 0 0 46px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
}
.feh-api-url {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.feh-api-off { color: var(--dsw-alias-label-tertiary); }
a.feh-api:hover .feh-api-url { color: var(--dsw-alias-link); text-decoration: underline; }

/* ---- mini program ---- */
.feh-mp {
  display: grid;
  grid-template-columns: minmax(240px, 300px) minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}
.feh-mp-qr {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
}
.feh-mp-qr img {
  width: 100%;
  border-radius: 7px;
  display: block;
  border: 1px solid var(--dsw-alias-border-l1);
}
.feh-mp-steps {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
}
.feh-steps { display: flex; flex-direction: column; gap: 5px; margin: 0; padding: 0; list-style: none; }
.feh-step { display: flex; gap: 8px; align-items: baseline; font-size: 12px; line-height: 17px; }
.feh-step-n {
  flex: 0 0 16px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
}
.feh-step code, .feh-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
.feh-mp-shot {
  display: block;
  width: 100%;
  margin-top: 2px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
}
.feh-cap { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.feh-link {
  color: var(--dsw-alias-link);
  text-decoration: none;
  font-size: 12px;
}
.feh-link:hover { text-decoration: underline; }

/* ---- misc ---- */
.feh-cols {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 10px;
}
.feh-box {
  padding: 12px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
}
.feh-box-title {
  margin: 0 0 9px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
}
.feh-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.feh-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 3px 8px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.feh-chip-who { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.feh-lines { display: flex; flex-direction: column; gap: 4px; }
.feh-line {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  color: var(--dsw-alias-label-primary);
  white-space: pre;
  overflow-x: auto;
}
@media (max-width: 720px) {
  .feh-scroll { padding: 16px 14px 40px; }
  .feh-mp { grid-template-columns: 1fr; }
}
`;

    const STYLE_ID = 'dsh-plugin-fe-homepage-styles';

    function ensureStyles() {
      if (document.getElementById(STYLE_ID)) return () => {};
      const element = document.createElement('style');
      element.id = STYLE_ID;
      element.textContent = CSS;
      document.head.appendChild(element);
      return () => element.remove();
    }

    // ----------------------------------------------------------- components

    const NOTE_GLYPH = h(
      'svg',
      { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
      h('circle', { cx: 12, cy: 12, r: 8.5, stroke: 'currentColor', strokeWidth: 1.6 }),
      h('path', {
        d: 'M12 11v5.2',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
      }),
      h('circle', { cx: 12, cy: 7.9, r: 0.95, fill: 'currentColor' }),
    );

    function ProjectCard({ project }) {
      const repos = project.repos ?? (project.repo ? [project.repo] : []);
      const envs = ENVS.filter((env) => project.envs && project.envs[env.id]);

      return h(
        'div',
        { className: 'feh-card' + (project.deprecated ? ' feh-deprecated' : '') },
        h(
          'div',
          { className: 'feh-card-top' },
          repos.length === 1
            ? h(
                'a',
                {
                  className: 'feh-name',
                  href: repos[0],
                  target: '_blank',
                  rel: 'noreferrer noopener',
                  title: repos[0],
                },
                project.name,
              )
            : h('span', { className: 'feh-name', title: project.name }, project.name),
          project.deprecated ? h('span', { className: 'feh-tag' }, '已废弃') : null,
          project.repoNote ? h('span', { className: 'feh-tag' }, project.repoNote) : null,
          project.note
            ? h('button', { className: 'feh-note-btn', type: 'button', title: project.note }, NOTE_GLYPH)
            : null,
        ),

        h('div', { className: 'feh-sub', title: project.platform }, project.platform),

        envs.length
          ? h(
              'div',
              { className: 'feh-envs' },
              envs.map((env) =>
                h(
                  'a',
                  {
                    key: env.id,
                    className: 'feh-env' + (env.id === 'prod' ? ' feh-env-prod' : ''),
                    href: href(project.envs[env.id]),
                    target: '_blank',
                    rel: 'noreferrer noopener',
                    title: bare(project.envs[env.id]),
                  },
                  env.label,
                ),
              ),
            )
          : null,

        project.release ? h('div', { className: 'feh-release' }, project.release) : null,

        repos.length > 1
          ? h(
              'div',
              { className: 'feh-repos' },
              repos.map((repo) =>
                h(
                  'a',
                  { key: repo, href: repo, target: '_blank', rel: 'noreferrer noopener', title: repo },
                  repo.replace(/^https?:\/\//, ''),
                ),
              ),
            )
          : null,
      );
    }

    function EntryCard({ entry }) {
      return h(
        'a',
        {
          className: 'feh-entry',
          href: entry.url,
          target: '_blank',
          rel: 'noreferrer noopener',
        },
        h('img', { className: 'feh-entry-shot', src: asset(entry.shot), alt: '', loading: 'lazy' }),
        h(
          'div',
          { className: 'feh-entry-meta' },
          h('span', { className: 'feh-entry-name' }, entry.name),
          h('span', { className: 'feh-entry-host' }, bare(entry.url)),
        ),
      );
    }

    function Steps({ items, mono }) {
      return h(
        'ol',
        { className: 'feh-steps' },
        items.map((item, index) =>
          h(
            'li',
            { key: item, className: 'feh-step' },
            h('span', { className: 'feh-step-n' }, index + 1),
            mono ? h('code', null, item) : h('span', null, item),
          ),
        ),
      );
    }

    function Page() {
      return h(
        'div',
        { className: 'feh-root' },
        h(
          'div',
          { className: 'feh-scroll' },
          h(
            'div',
            { className: 'feh-inner' },

            h(
              'div',
              { className: 'feh-head' },
              h('h1', { className: 'feh-title' }, '前端主页'),
            ),

            h(
              'section',
              { className: 'feh-section' },
              h('div', { className: 'feh-sec-head' }, h('h2', { className: 'feh-sec-title' }, '常用入口')),
              h(
                'div',
                { className: 'feh-entries' },
                ENTRIES.map((entry) => h(EntryCard, { key: entry.id, entry })),
              ),
            ),

            h(
              'section',
              { className: 'feh-section' },
              h('div', { className: 'feh-sec-head' }, h('h2', { className: 'feh-sec-title' }, '项目地址')),
              h(
                'div',
                { className: 'feh-grid' },
                PROJECTS.map((project) => h(ProjectCard, { key: project.id, project })),
              ),
            ),

            h(
              'section',
              { className: 'feh-section' },
              h('div', { className: 'feh-sec-head' }, h('h2', { className: 'feh-sec-title' }, '接口环境')),
              h(
                'div',
                { className: 'feh-apis' },
                APIS.map((api) =>
                  api.url
                    ? h(
                        'a',
                        {
                          key: api.id,
                          className: 'feh-api',
                          href: href(api.url),
                          target: '_blank',
                          rel: 'noreferrer noopener',
                        },
                        h('span', { className: 'feh-api-label' }, api.label),
                        h('span', { className: 'feh-api-url' }, api.url),
                      )
                    : h(
                        'div',
                        { key: api.id, className: 'feh-api' },
                        h('span', { className: 'feh-api-label' }, api.label),
                        h('span', { className: 'feh-api-url feh-api-off' }, api.note),
                      ),
                ),
              ),
            ),

            h(
              'section',
              { className: 'feh-section' },
              h('div', { className: 'feh-sec-head' }, h('h2', { className: 'feh-sec-title' }, '小程序')),
              h(
                'div',
                { className: 'feh-mp' },

                h(
                  'a',
                  {
                    className: 'feh-mp-qr',
                    href: asset('miniapp-qr.webp'),
                    target: '_blank',
                    rel: 'noreferrer noopener',
                  },
                  h('img', { src: asset('miniapp-qr.webp'), alt: '小程序体验版二维码' }),
                  h('span', { className: 'feh-cap' }, '体验版二维码 · pages/index/index'),
                  h('img', {
                    className: 'feh-mp-shot',
                    src: asset('miniapp-mp.webp'),
                    alt: '微信公众平台版本管理',
                    loading: 'lazy',
                  }),
                ),

                h(
                  'div',
                  { className: 'feh-mp-steps' },
                  h(Steps, { items: MP_STEPS }),
                  h('a', {
                    className: 'feh-link',
                    href: 'http://192.168.91.130:3000/help',
                    target: '_blank',
                    rel: 'noreferrer noopener',
                  }, '测试环境 CI'),
                  h('img', {
                    className: 'feh-mp-shot',
                    src: asset('miniapp-build.webp'),
                    alt: '构建输出',
                    loading: 'lazy',
                  }),
                ),
              ),
            ),

            h(
              'section',
              { className: 'feh-section' },
              h(
                'div',
                { className: 'feh-cols' },
                h(
                  'div',
                  { className: 'feh-box' },
                  h('h3', { className: 'feh-box-title' }, '测试账号'),
                  h(
                    'div',
                    { className: 'feh-chips' },
                    TEST_ACCOUNTS.map((account) =>
                      h(
                        'span',
                        { key: account.phone, className: 'feh-chip' },
                        account.phone,
                        h('span', { className: 'feh-chip-who' }, account.who),
                      ),
                    ),
                  ),
                ),
                h(
                  'div',
                  { className: 'feh-box' },
                  h('h3', { className: 'feh-box-title' }, 'Mac 跑 Node 14 老项目'),
                  h(
                    'div',
                    { className: 'feh-lines' },
                    NODE14_STEPS.map((line) =>
                      h('span', { key: line, className: 'feh-line' }, line),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    }

    // ------------------------------------------------------- sidebar glyph

    function HomepageIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18;
      const active = props?.active === true;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', {
          d: 'M4.2 10.2 12 3.6l7.8 6.6V20a.8.8 0 0 1-.8.8h-4.4v-5.6H9.4V20.8H5a.8.8 0 0 1-.8-.8v-9.8Z',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
          opacity: active ? 1 : 0.85,
        }),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        if (typeof ctx.effect === 'function') ctx.effect(ensureStyles);
        else ensureStyles();

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, Page),
        );
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: '前端主页' },
            HomepageIcon,
          ),
        );
      },
    };
  },
});
