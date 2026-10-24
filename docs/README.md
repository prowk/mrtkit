# MRTKit 文档

首次使用从[入门教程](tutorials/getting-started.md)开始；已有 MRT 文件时，按任务选择操作指南。所有命令均在仓库根目录执行。

| 目的 | 文档 |
| --- | --- |
| 安装、样本、筛选、导出、真实回放 | [完整入门教程](tutorials/getting-started.md) |
| 加载初始 RIB，设置窗口与预热 | [基线回放](guides/replay.md) |
| 比较两个同源快照 | [快照差异](guides/snapshots.md) |
| 查看一个前缀的观测过程与缺档 | [前缀时间线](guides/timeline.md) |
| 对变化排名、去重与复算 | [变化聚合](guides/aggregation.md) |
| 按采集器与视图隔离回放 | [多采集器回放](guides/multi-collector.md) |
| 关联多观测点的同类语义变化 | [跨采集器关联](guides/correlation.md) |
| 在有界内存中关联大量观测并流式导出 | [外部关联](guides/external-correlation.md) |
| 生成本地可查看的分页复盘报告 | [离线 HTML 报告](guides/html-report.md) |
| 核查固定真实路径变化与原始记录 | [RIS rrc23 真实案例](../cases/rrc23-path-change/README.md) |
| 查命令、选项、筛选与分析语义 | [命令行参考](reference/cli.md) |
| 在 MoonBit 项目中使用核心库 | [库 API](reference/api.md) |
| 消费版本化 JSON / CSV | [输出契约](reference/output.md) |
| 核查结果包、来源、时间及关联键 | [共享结果包校验](reference/bundle-validation.md) |
| 理解 AS4、聚合属性与校验上下文 | [属性规则](reference/attributes.md) |
| 核查标准条款、测试和支持边界 | [兼容与验收清单](reference/compatibility.md) |
| 处理失败、部分输出和资源上限 | [错误契约](reference/errors.md) |
| 修改实现、运行测试 | [开发指南](development/contributing.md) |
| 查看完整数据对照、回放与验收证据 | [验证记录](validation/README.md) |
| 阅读限定提交的性能测量 | [历史性能基准](validation/performance.md) |
| 核查全量状态资源边界与共享优化 | [全量状态基准](validation/full-state-benchmark.md) |
| 核查 main 新增功能的交付证据 | [深化验收](validation/extended-acceptance.md) |

文档按“教程 → 操作指南 → 参考 → 开发与验证”组织。参考了 [BGPKIT Parser 的快速使用与 API 入口](https://github.com/bgpkit/bgpkit-parser)和 [BGPStream 按任务划分的教程](https://bgpstream.caida.org/docs/tutorials)，内容与实现由本项目独立编写。

[返回项目首页](../README.md) · [版本记录](../CHANGELOG.md)
