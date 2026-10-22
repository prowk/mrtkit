# 生成离线 HTML 复盘报告

[文档首页](../README.md) · [入门教程](../tutorials/getting-started.md) · [命令行](../reference/cli.md)

```sh
node cli/mrtkit.mjs multi --manifest fixtures/multi/manifest.json --output .validation/report-input
node cli/mrtkit.mjs report --input .validation/report-input/index.json --output .validation/report-output
```

输出目录必须不存在。生成后用本地浏览器打开 `index.html`，无需网络、HTTP 服务或外部资源。报告包含输入质量、各采集器/视图的观测分布、时间线或变化流、结构化前后属性与来源位置。直接可查看的真实案例见[rrc23 固定报告](../../cases/rrc23-path-change/report/index.html)。

筛选支持采集器/视图、精确前缀、精确 peer ASN 或 IP、变化/观测类型。明细默认每次显示 50 条，点击“查看差异与来源”展开 JSON；采集器、视图、Path Identifier 及原始文件位置不会被合并。输入不完整、缺基线、未验证连续性及已知缺档都有独立标记，不将不可见观测解释为业务中断。

有前缀的结果包使用 MoonBit 已排序的单观测点时间线，包含宣告、撤回、恢复、重置和缺档；全前缀结果包展示原 CLI 变化流，不补造其他观测事件。多个观测点按清单顺序分组，选择一个观测点查看其时间线，不把表格行之间的时间差解释为跨采集器传播顺序。

## 大结果与输出完整性

- 明细按默认 200 行、约 1 MiB 分为本地 JavaScript 数据文件；单条大记录独立成页，最多 16 MiB。`--page-size` 可设为 1–1000。
- 浏览器按需加载当前页，筛选逐页检查，只保留匹配位置索引而不缓存全部属性对象。数据以 JSON 解析后用 `textContent` 显示，内容不作为 HTML 执行。
- 生成器对变化流逐行读取；有前缀模式的单个时间线 JSON 上限为 64 MiB。超过上限应缩小窗口，或用全前缀变化结果包查看大变化流。
- 提醒数量必须与 CLI 索引一致，时间线统计必须与索引一致；已有哈希会在生成前验证。结果包明细不允许越出包目录。
- 正常生成的 `report.json.status` 为 `complete`，表示报告生成完成；`input_status` 仍保留输入的 `complete/partial`，两者不能混淆。生成失败会写 `partial` 元数据并非零退出，已有用户输出目录不会覆盖。

报告带源字段时默认保留输入路径。固定公开案例使用显式档案标签避免包含机器路径，具体规则记在 `source_path_policy` 中。

`tests/report.test.mjs` 执行实际生成的页面脚本和分块脚本，验证分页、组合筛选、完整计数、部分输入、哈希失败及恶意文本转义。验证环境的浏览器工具禁止 `file://`，因此本轮未进行浏览器视觉验收，页面逻辑通过隔离 DOM 测试验证。
