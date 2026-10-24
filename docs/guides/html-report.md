# 生成离线 HTML 复盘报告

[文档首页](../README.md) · [入门教程](../tutorials/getting-started.md) · [命令行](../reference/cli.md)

```sh
node cli/mrtkit.mjs multi --manifest fixtures/multi/manifest.json --output .validation/report-input
node cli/mrtkit.mjs correlate --input .validation/report-input/index.json --external --output .validation/report-correlation
node cli/mrtkit.mjs report --input .validation/report-input/index.json --correlation .validation/report-correlation/index.json --output .validation/report-output
```

输出目录必须不存在。生成后用本地浏览器打开 `index.html`，无需网络、HTTP 服务或外部资源。报告包含输入质量、各采集器/视图的观测分布、时间线或变化流、结构化前后属性与来源位置。直接可查看的真实案例见[rrc23 固定报告](../../cases/rrc23-path-change/report/index.html)。

筛选支持采集器/视图、精确前缀、精确 peer ASN 或 IP、变化/观测类型。明细每次显示 50 条，可取消、重置。点击“查看差异与来源”查看规范化路径、起源 AS、下一跳、社区和聚合属性的前后值，并可展开原始 JSON；同来源事件的多种提醒可集中查看。采集器、视图、Path Identifier 及原始文件位置保留。

`--correlation` 可省略。附加关联包时，组摘要展示观测时间、覆盖和未观测范围，组内明细分页展示观测点与来源，可跳转到对应事件。输入不完整、缺基线、未验证连续性及已知缺档保持独立标记，不将观测共现解释为传播时延或因果关系。

有前缀的结果包使用 MoonBit 已排序的单观测点时间线，包含宣告、撤回、恢复、重置和缺档；全前缀结果包展示原 CLI 变化流，不补造其他观测事件。多个观测点按清单顺序分组，选择一个观测点查看其时间线，不把表格行之间的时间差解释为跨采集器传播顺序。

## 大结果与输出完整性

- 明细按默认 200 行、约 1 MiB 分为本地 JavaScript 数据文件；单条大记录独立成页，最多 16 MiB。`--page-size` 可设为 1–1000。
- 筛选读取每 8,192 行一块的紧凑倒排索引，组合条件取交集；每行一位的位图保存结果，不扫描全部原始明细页或保存全部匹配对象。浏览器仅加载当前显示行所需的数据页。数据用 `textContent` 显示。
- 生成器对变化流逐行读取；有前缀模式的单个时间线 JSON 上限为 64 MiB。超过上限应缩小窗口，或用全前缀变化结果包查看大变化流。
- 提醒数量必须与 CLI 索引一致，时间线统计必须与索引一致；已有哈希会在生成前验证。结果包明细不允许越出包目录。
- 正常生成的 `report.json.status` 为 `complete`，表示报告生成完成；`input_status` 仍保留输入的 `complete/partial`，两者不能混淆。生成失败会写 `partial` 元数据并非零退出，已有用户输出目录不会覆盖。

报告带源字段时默认保留输入路径。固定公开案例使用显式档案标签避免包含机器路径，具体规则记在 `source_path_policy` 中。

索引、取消和导航规则见[报告索引参考](../reference/report-index.md)。`tests/report.test.mjs` 在隔离 DOM 执行实际页面与分块脚本，覆盖 17,000 行、组合筛选、取消竞态、关联计数、来源跳转及恶意文本。真实浏览器的本地文件验收和性能目标单独记录，不能用这些逻辑测试替代；当前浏览器工具拒绝 `file://` 且禁止绕过，已按用户要求保留浏览器验收待办。
