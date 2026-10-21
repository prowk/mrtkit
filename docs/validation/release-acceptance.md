# v0.1.0 交付验收

[文档首页](../README.md) · [入门教程](../tutorials/getting-started.md) · [命令行](../reference/cli.md)

验证日期：2026-10-22。本记录覆盖十项申报承诺，内部任务清单与申报材料保留本地。深化拓展中的全表状态内存基准、多采集器关联及 HTML 报告不列为本次已完成能力。

| 承诺 | 验收证据 |
| --- | --- |
| 标准兼容清单与已有模块审查 | [逐条 RFC / 实现 / 正反例 / 状态](../reference/compatibility.md)，明确 MRT 单播范围、消息基本结构、离线与路由器恢复边界；规则缺口与修复列在清单中 |
| 三种聚合属性结构化 | `aggregator_wbtest.mbt`、`tests/attributes_contract.test.mjs`；缺失/存在、原始/有效值、2/4 字节环境、非法长度和截断矩阵 |
| AS4 聚合兼容解释 | `as4_wbtest.mbt`、`aggregator_wbtest.mbt`；存在组合、AS_TRANS、AS_SET/联盟段和长度关系，[决策说明](../reference/attributes.md) |
| 标志及未知属性规则 | Optional/Transitive/Partial 正反例、短值扩展长度、接收保留位、未知 well-known 失败与 optional 原始保留；独立对照检查全部原始 flags/code/value |
| 必需属性的消息上下文 | `attribute_context_wbtest.mbt`、`tests/attributes_context.test.mjs`；普通宣告、MP、纯撤回、空 UPDATE、空路径与 RIB 上下文，不猜测未记录的会话条件 |
| 属性贯通分析与版本化导出 | 同一属性语义供变化、快照、时间线、聚合使用；`tests/attributes_context.test.mjs` 验证出现/消失、有效值变化与编码等价；[JSON/CSV 契约](../reference/output.md) |
| 独立对照与规则反例 | `scripts/test_compare.py` 检出原始标志差异、保留失败复现且继续后仍失败；18 个完整档案共 2,975,297 条记录、19,663,881 条路由事件及 749 条会话事件[全部一致](archive-comparison.json) |
| 完整 RIB + 连续 UPDATE + 窗口 + 导出 | [真实回放报告](replay-acceptance.json)：固定 13 个完整输入与 SHA-256，独立复算前后状态、统计、93 条变化及 46 行正式 CLI JSON/CSV；窗口、模型、ADD-PATH、时间线测试补充 IPv6、重置、乱序、缺基线及缺档 |
| 端到端失败及资源边界 | `tests/failure_contract.test.mjs`、`cli.test.mjs`、`transport.test.mjs` 覆盖 gzip/bz2 损坏、记录截断、坏 peer、容量、16 MiB、输出 ENOSPC/EACCES/EPIPE，检查非零退出、诊断隔离、精确位置与部分结果 |
| 接口、教程与三后端回归 | `moon info`、`moon fmt` 已运行；模块身份调整的接口差异仅为 `prowk/mrtkit` 命名；JS/Wasm/Wasm GC 各 51 个测试、Node 73 个测试全部通过；README、统一导航、入门教程与 CI 同步 |

参考编译器、输入来源、完整对照命令与独立状态模型说明见[验证记录](README.md)。历史性能测量仅适用于其明确绑定的旧提交，不作为本版本性能复测结果。
