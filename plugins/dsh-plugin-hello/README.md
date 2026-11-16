# dsh-plugin-hello

DSH 示例插件：在左侧边栏新增一个 **Hello dsh-plugin** 标签，点击后主区域居中显示
`Hello dsh-plugin`。

它同时也是 [dsh-market](../..) 里最小的可发布单元——可以作为你自己插件的起点，也是发布流程的参考。

## 目录结构

| 文件 | 作用 |
| --- | --- |
| `package.json` | Bundle 清单。`dsh.bundle.patch` 指向补丁层，`dsh.client` 声明浏览器端 |
| `cordis.patch.yml` | 补丁层：向 loader 插入一条 `dsh-plugin-hello` 条目 |
| `lib/index.js` | 宿主端。这里没有要做的事，只有一个 `apply()` |
| `lib/client.js` | 浏览器端。注册 `main`（keyed 插槽，页面本体）和 `sidebar.panellist`（list 插槽，侧边栏行） |

## 两个插槽如何组成一个侧边栏标签

- `sidebar.panellist` 条目是**元数据驱动**的：`id`、`label`、`order` 决定侧边栏这一行长什么样，
  注册的组件只负责画图标（展开 16px，折叠 18px）。
- `main` 是 keyed 插槽，它的 `key` 必须与 `sidebar.panellist` 的 `id` 相同。点击该行会执行
  `ctx.layout.selectPanel(id)`，在 `main` 中查找同名 `key` 并渲染对应组件。
- 所以两个 id 必须一致。只有 `main` 而没有 `sidebar.panellist`，就没有入口；只有
  `sidebar.panellist` 而没有 `main`，点击时会抛错。

侧边栏那一行是由条目元数据生成的，而不是组件本身——图标组件返回 `null` 只会得到一行空白，
但依然可以点击。

## 布局说明

`main` 提供的是一个 flex 列容器，页面用 `flex: 1 1 auto` 配 `minHeight: 100%`，再配合
`alignItems` / `justifyContent: center` 让内容居中。颜色取自 `--dsw-alias-*` 主题变量，
因此插件会自动跟随浅色与深色主题。

## 本地开发

```bash
pnpm --dir plugins/dsh-plugin-hello pack     # 在仓库根目录执行
```

安装打出来的 tarball，或使用 `git+https://…#<commit>&path:/plugins/dsh-plugin-hello` 形式的 spec，
然后重启 DSH。

## 发布

不要手工改动 `market/` 下的任何文件。先升 `package.json` 里的 `version`，然后在仓库根目录执行：

```bash
node scripts/release.mjs dsh-plugin-hello
node scripts/build-index.mjs --verify
```
