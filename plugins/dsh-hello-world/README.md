# dsh-hello-world

公司内部示例插件（Demo）：在 DSH 左侧栏新增一个独立标签 **Hello World**，点击后主区域居中显示 `hello world`。

它同时是「内部插件市场」的最小可发布单元，用来演示内部 CI 的打包与发版流程。

## 结构

| 文件 | 作用 |
| --- | --- |
| `package.json` | Bundle 清单。`dsh.bundle.patch` 指向 patch 层，`dsh.client` 声明浏览器半区 |
| `cordis.patch.yml` | patch 层：向 loader 插入一条 `dsh-hello-world` 条目 |
| `lib/index.js` | Host 半区。本插件没有 host 逻辑，只提供 `apply()` |
| `lib/client.js` | 浏览器半区。注册 `main`（keyed slot，页面）与 `sidebar.panellist`（list slot，左侧标签） |

## 两个 slot 如何拼成一个标签

- `sidebar.panellist` 的条目是**元数据驱动**的：`id` + `label` + `order` 决定左侧那一行，浏览器半区注册的组件只负责画 18px 图标。
- `main` 是 keyed slot，`key` 必须与 `sidebar.panellist` 的 `id` 相同。点左侧那一行时，布局执行 `ctx.layout.selectPanel(id)`，按同一个 `key` 去 `main` 里找组件渲染。
- 因此：**两处 id 必须一致**；只有 `main` 没有 `sidebar.panellist` 就没有入口，只有 `sidebar.panellist` 没有 `main` 点了会抛错。

## 本地开发

```bash
# 在仓库根目录
pnpm --filter dsh-hello-world pack     # 或 cd plugins/dsh-hello-world && pnpm pack
```

安装到 profile 后重启 DSH 即可看到左侧标签。

## 发版

不要手工改 `market/` 下的文件。改完 `package.json` 的 `version` 后，在仓库根目录执行：

```bash
node scripts/build-index.mjs
git commit -am "release dsh-hello-world@0.1.0"
```
