# 仓库约定

## 文档语言

- 本仓库所有面向人的文档**只用中文**：`README.md`、`plugins/*/README.md`、以及后续新增的说明文件。
- 不再维护英文版 README，也不再新建 `README.en.md` / `README.zh.md` 之类的双语副本。
- 代码注释、日志与提交信息不受此限，保持当前的英文风格即可。
- `market/` 下的 `en` / `zh-cn` 是 DSH 索引格式要求的字段，不是文档，不要删除。

## 不要手工编辑的文件

- `market/index.json` 由 `base.json` + `meta/*.json` + `releases.json` 合成，改完要重新执行
  `node scripts/build-index.mjs`。
- 发布流程见 `README.md` 的「发布一个版本」。

## 校验

改动 `market/` 相关内容后，提交前至少跑一次：

```bash
node scripts/build-index.mjs --check
```
