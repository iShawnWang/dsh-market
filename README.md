# dsh-market

自建私有 [DeepSeek Harness](https://github.com/deepseek-ai) 插件市场

## 在 DSH 中添加本市场插件源

| 所在地区 | 索引地址 |
| --- | --- |
| 任意地区 | `https://raw.githubusercontent.com/iShawnWang/dsh-market/main/market/index.json` |
| 中国大陆 | `https://gcore.jsdelivr.net/gh/iShawnWang/dsh-market@main/market/index.json` |
| 中国大陆（备选） | `https://gh-proxy.com/https://raw.githubusercontent.com/iShawnWang/dsh-market/main/market/index.json` |
| 中国大陆（备选） | `https://ghfast.top/https://raw.githubusercontent.com/iShawnWang/dsh-market/main/market/index.json` |

1. 插件 → 实验性插件 → 开启 **自定义插件索引**。
2. 插件 → 发现 → 管理索引源… → 粘贴地址。索引源只能由用户添加。

## 插件列表

| 插件 | 说明 | 分类 | 标签 | 版本 |
| --- | --- | --- | --- | --- |
| [dsh-plugin-hello](plugins/dsh-plugin-hello/README.md) | 示例插件：左侧边栏新增一个标签，点击后主区域居中显示 `Hello dsh-plugin` | 平台 | 示例 | 0.2.0 |
| [dsh-plugin-yq-release](plugins/dsh-plugin-yq-release/README.md) | 一句话把分支发到测试环境：自动合并 GitLab、发布 Spug 前端或触发小程序构建，并记录每次发布 | 发布部署 | 发版、内网 | 0.2.0 |

## 新增修改插件

新增插件、本地调试、发布版本的做法写在 [AGENTS.md](AGENTS.md)，改动 `market/` 后提交前至少要跑一次：

```bash
node scripts/build-index.mjs --check
```

## 许可

MIT
