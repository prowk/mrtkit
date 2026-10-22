# MoonBit 库 API

[文档首页](../README.md) · [入门教程](../tutorials/getting-started.md) · [命令行](cli.md)

包为 `prowk/mrtkit`，公开接口见 [pkg.generated.mbti](../../pkg.generated.mbti)。

| API | 用途 |
| --- | --- |
| `read_frame` | 解码一条完整记录 |
| `Decoder::decode_at` | 解码并附加文件、记录号、解压后记录偏移及事件索引 |
| `Decoder::decode_scoped` | 额外附加采集器及视图；每个观测点使用独立 Decoder |
| `Decoder::new/decode/reset` | 有状态解析与 peer 表关联；新文件清除 peer 表 |
| `StreamDecoder::new/feed/finish` | 任意分块解析及 EOF 截断检查 |
| `parse_prefix/parse_attributes/parse_peers/parse_rib/parse_bgp4mp` | 单独使用协议组件 |
| `Query::new/matches` | 筛选路由事件 |
| `Analyzer::new/record_batch/observe/summary` | 累计元数据、状态变化和路由统计 |
| `Analyzer::seed/route_states` | 加载基线和导出可审计的最终路由状态 |
| `Analyzer::storage_stats` | 路由键、独立属性集和共享引用计数 |
| `Snapshot::new/ingest/diff` | 比较同源、同视图快照，区分 peer 与路由缺失 |
| `Timeline::new/seed_peers/seed/record_batch/observe/report` | 前缀观测过程与可见性区间 |
| `Aggregation::new/observe/report` | 对带来源的变化提醒排名和计数 |
| `event_json/event_csv/csv_header` | 导出路由 |

`record_batch` 处理元数据和会话，路由需逐条调用 `observe`，便于自行筛选。`StreamDecoder` 失败后需创建新实例。

核心库没有 JS FFI，可运行于 JS、Wasm、Wasm GC。Node 负责文件读取、解压、参数与输出，协议解析、筛选和分析由 MoonBit 完成。JS 桥接是单会话串行接口，不支持同一实例并发分析。

`Source.collector/view` 为可选身份。未设置时保持原有单观测点语义；显式设置后，`Analyzer` 的路由、会话水位与重置按采集器、视图、peer、方向、前缀和 Path Identifier 隔离。同名 peer 不相互覆盖。属性池可以跨独立路由共享相同的完整属性，但事件时间和来源各自保留。哈希之后仍做完整相等检查，替换及会话重置时按引用回收；撤回状态保留引用和水位，不引入过期淘汰。

一个 `Timeline` 只接受一个观测点的身份，混入其他采集器/视图明确报错；联合分析须使用各自独立的时间线和 Decoder。普通 CLI 命令仍描述单观测点输入，不能仅混合文件名就获得来源隔离。共享后的公开数组仍要求调用方保持不变。
