# P0 / P1 验收记录

本记录对应本地任务清单的全部 6 项 P0、11 项 P1。任务清单及两份申报材料不提交；P2 扩展保持后续范围。

| 项目 | 实现及验收证据 |
| --- | --- |
| P0 初始 RIB 与预热 | `Analyzer::seed`、桥接基线生命周期、`tests/window.test.mjs`；验证基线/预热不计窗口统计、不输出提醒，与完整历史回放窗口结果一致，缺基线明确标记，空/未来/不支持的初始记录拒绝 |
| P0 路由及会话统一窗口 | `window_wbtest.mbt`、`tests/window.test.mjs`；验证秒/微秒包含端点、跨文件、窗口前重置、窗口后不改变状态、重置后旧宣告不复活；`analysis_wbtest.mbt` 覆盖容量已满时的过期输入 |
| P0 完整真实数据验证 | [验证记录](VALIDATION.md)、[逐文件报告](archive-comparison.json)、[来源清单](archive-manifest.json)；两个采集器、两个完整 RIB、连续一小时共 16 个 UPDATE，19,663,881 个路由事件和 749 个会话事件一致；范围及未逐项覆盖字段明确列出 |
| P0 有界内存对照 | `scripts/compare.py`、`scripts/decoded_records.mjs` 逐记录迭代，仅保留当前记录的多重集合；`scripts/test_compare.py` 验证重复次数、记录内排序和历史两个 1000 记录小样本方法等价；完整档案均通过 |
| P0 性能基准 | [基准方法与结果](PERFORMANCE.md)和三份原始/比较 JSON；独立进程三次中位数，固定哈希、版本、环境、命令，覆盖完整 RIB、长回放、容量失败，记录吞吐、峰值内存、活动/缓存数 |
| P0 独立状态模型 | `tests/reference_model.mjs` 不依赖 MoonBit；`tests/model.test.mjs` 手工序列及 1200 个确定性状态事件，在有/无显式 ADD-PATH 基线模式逐步核对状态、变化和计数 |
| P1 结构化差异及版本 | `diff.mbt`、`tests/output.test.mjs`、[输出契约](OUTPUT.md)；路径/起源/下一跳/社区前后值与增删，保留微秒，同输入多类型提醒共用来源，版本不匹配失败 |
| P1 来源追溯 | `provenance.mbt`、`tests/output.test.mjs`；文件、记录号、解压后记录偏移、事件索引，变化前后各自保留来源，局部错误偏移另行描述 |
| P1 快照差异 | `snapshot.mbt`、`snapshot_wbtest.mbt`、`tests/snapshot.test.mjs`、[说明](SNAPSHOTS.md)；同源/视图检查、peer 缺失与路由缺失分开、路径/起源/属性并列输出，排序独立，缺失不冒充观测撤回 |
| P1 前缀时间线 | `timeline.mbt`、`timeline_wbtest.mbt`、`tests/timeline.test.mjs`、[说明](TIMELINE.md)；时间排序、宣告/撤回/恢复/路径变化/重置，peer 路径并集、ADD-PATH、缺基线/恢复/连续性/缺档与截尾状态，不推断业务中断 |
| P1 前缀查询 | `prefix_text.mbt`、`prefix_query_wbtest.mbt`、`tests/prefix_query.test.mjs`；共享规范化，IPv4/IPv6、默认路由、非整字节、主机位、exact/more-specific/covering，库与 CLI 结果一致 |
| P1 变化聚合 | `aggregate.mbt`、`tests/aggregate.test.mjs`、[说明](AGGREGATION.md)；来源事件去重、peer 去重、类型分布、固定排名，从同输入的结构化 `changes` 独立复算 |
| P1 Large Communities | `large_communities_wbtest.mbt`、`tests/output.test.mjs`；三元组及原始编码、重复/排序语义、增删、畸形长度错误、JSON/CSV |
| P1 ADD-PATH | `tests/addpath.test.mjs`；IPv4/IPv6、两种 ASN 宽度、LOCAL、BGP4MP 与 BGP4MP_ET 子类型 8/9/10/11、RIB 8/10，ID0 与普通路径隔离，撤回互不影响 |
| P1 诊断分组 | `diagnostics.mbt`、`cli/diagnostics.mjs`、`tests/diagnostics.test.mjs`；MRT 类型/子类型、MP AFI/SAFI 分组、代表性来源、分组和总量一致，诊断只写 stderr |
| P1 热点优化 | peer 路由索引、缓存规范化属性、线性分块组装；[性能证据](PERFORMANCE.md)明确提升与内存代价；撤回保留策略及语义回归均记录 |
| P1 接口、文档、回归 | `pkg.generated.mbti` 与桥接接口已核对；命令、支持范围、输出及复现文档更新；`moon info`、`moon fmt --check`、`npm test`、Wasm / Wasm GC 全部通过，GitHub Actions 执行同一检查 |

本次根库 47 个测试在 JS、Wasm、Wasm GC 分别验证；Node 端到端与协议矩阵共 55 个测试。完整数据对照和基准均为额外可复现验证，常规测试不依赖网络。原始基准的工作量与全部统计/状态一致检查由 `scripts/publish_benchmark.mjs` 强制执行。
