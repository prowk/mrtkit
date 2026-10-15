# mrtkit

**用 MoonBit 解析 BGP MRT 档案，查询路由并分析变化。** 提供无第三方依赖的核心库和流式 CLI，适用于路由数据学习、离线统计与故障复盘。

## 快速开始

环境：MoonBit（已验证版本 `0.1.20260920`）、Node.js 22 或更新版本。`.bz2` 输入另外需要 Python 3。没有 npm 依赖，无需 `npm install`。

```powershell
npm run build
node cli/mrtkit.mjs parse fixtures/demo.mrt
node cli/mrtkit.mjs stats --threshold 3 fixtures/demo.mrt
node cli/mrtkit.mjs changes --threshold 3 fixtures/demo.mrt
```

`npm run demo` 会构建项目、生成小型样本并输出统计。样本包含快照、路径/起源变化、撤回、重新宣告、IPv6 更新和未知类型。

## 已实现

| 功能 | 当前范围 |
| --- | --- |
| MRT | 网络字节序、长度校验、扩展微秒时间戳、未知类型跳过统计 |
| 快照 | TABLE_DUMP_V2 的 PEER_INDEX_TABLE、IPv4/IPv6 单播 RIB，含 ADD-PATH |
| 更新 | BGP4MP/BGP4MP_ET 的 MESSAGE、MESSAGE_AS4、LOCAL、STATE_CHANGE 和 ADD-PATH |
| 属性 | ORIGIN、AS_PATH、AS4_PATH、NEXT_HOP、MED、LOCAL_PREF、COMMUNITY、LARGE_COMMUNITY；其他属性保留原始字节 |
| 多协议 | IPv4/IPv6 单播 MP_REACH/MP_UNREACH；RIB 精简/历史完整下一跳编码 |
| 查询 | 前缀精确、更具体、覆盖地址三种匹配、peer/路径 ASN、包含端点的秒/微秒范围 |
| 输出 | 路由 JSON Lines、CSV、统计 JSON、变化 JSON Lines |
| 快照差异 | 同采集器、同视图的 peer 与路由新增/缺失及结构化属性差异 |
| 变化聚合 | 按来源事件去重的前缀排名、受影响 peer 数及变化类型分布 |
| 前缀时间线 | 按时间展示观测、恢复、会话重置和缺档；区分路径与 peer 的可见性 |
| 分析 | 路径/起源/属性变化、重复宣告、固定窗口波动、会话重置、乱序计数 |
| 输入 | 文件、未压缩标准输入、gzip、bz2、多文件顺序处理 |

协议依据：[RFC 6396](https://datatracker.ietf.org/doc/html/rfc6396)、[RFC 4271](https://datatracker.ietf.org/doc/html/rfc4271)、[RFC 4760](https://datatracker.ietf.org/doc/html/rfc4760)、[RFC 6793](https://datatracker.ietf.org/doc/html/rfc6793)。

## 命令行使用

```powershell
node cli/mrtkit.mjs --help

# 前缀主机位自动清除，并导出 CSV
node cli/mrtkit.mjs parse --prefix 203.0.113.5/24 --format csv fixtures/demo.mrt

# 在 peer 或有效 AS 路径中匹配 ASN
node cli/mrtkit.mjs parse --asn 65537 fixtures/demo.mrt

# 同一采集器的一个初始快照和后续更新，按时间顺序传入
node cli/mrtkit.mjs stats --peer-asn 64512 initial.mrt.gz updates.mrt.gz

# 调整时间范围和波动规则
node cli/mrtkit.mjs changes --from 1700000000 --to 1700000060 --window 60 --threshold 3 fixtures/demo.mrt
```

`--asn` 仅用于 `parse`；撤回消息没有 AS_PATH，因此只能按自身的 peer ASN 匹配撤回。分析使用 `--peer-asn`，保证宣告与撤回属于同一筛选范围。

`--prefix-mode exact` 精确匹配规范化前缀；`more-specific` 严格匹配更长掩码的子网，不包含原前缀；`covering` 查找覆盖指定地址或整个指定 CIDR 的路由。裸地址视为 `/32` 或 `/128`。三种模式和 IPv4/IPv6 文本解析均由 MoonBit 库统一实现，例如 `parse --prefix 192.0.2.200 --prefix-mode covering 文件`。

`--from/--to` 使用 Unix 秒，包含端点，可用 `--from-micros/--to-micros` 指定端点微秒。分析会回放窗口前的 UPDATE 和会话状态作为预热；使用 `--initial-rib 文件` 显式加载初始快照。基线和预热不计入窗口统计，窗口后的事件不改变最终状态。缺少完整基线会通过 `baseline_status` 标识，详见[回放说明](docs/REPLAY.md)。

标准输出只有结果，计数和诊断写入标准错误。成功退出码为 `0`，错误为 `1`。错误前已经输出的 JSON Lines/CSV 是部分结果。文件名以 `--` 开头时，用 `--` 分隔选项。

`.gz` 根据扩展名解压；`.bz2` 使用 Python 标准库流式解压，可用 `MRTKIT_PYTHON` 指定解释器。`-` 只读取未压缩标准输入。

两个完整快照可用 `snapshot-diff --collector 名称 前快照 后快照` 比较，详见[快照差异](docs/SNAPSHOTS.md)。该命令区分整个 peer 缺失与路由条目缺失，不将快照缺失当作观测到的撤回。

`aggregate --top 20 文件...` 对相同分析窗口的变化提醒排名；去重和复算规则见[变化聚合](docs/AGGREGATION.md)。

`timeline --prefix CIDR 文件...` 展示一个前缀的观测过程、各 peer 状态与有证据支持的不可见区间，详见[时间线](docs/TIMELINE.md)。

## 数据与分析语义

路由事件包含采集时间、可选微秒、`rib/announce/withdraw`、规范化前缀、peer ASN/IP、`outbound`、可选快照起源时间和属性。`attributes.path` 是有效路径，`wire_path/as4_path` 是原始分段。未知属性的 `value` 是字节数组。

0.2.0 使用版本化输出 `schema_version: "2.0"`。变化的前后状态和路径、起源、下一跳、社区增删均为结构化对象，包含微秒及输入来源；同一更新的路径和属性变化可共享来源追溯。详见[输出契约](docs/OUTPUT.md)。

AS_SET 计为一个跳数，联盟段不计普通路径长度。末段为 AS_SET 时不推断唯一起源 AS。变化比较忽略集合成员顺序、连续序列分段、社区排列及同一 MP 属性携带的其他前缀。

分析按 **peer ASN＋peer IP＋收发方向＋前缀＋可选 Path Identifier** 隔离。不同采集器须分开运行。使用一个初始 RIB 再接后续 UPDATE；多个完整快照须分别分析，不通过后续快照中缺失的条目推断撤回。

波动采用从首次观察或窗口重启时开始的固定窗口。初次宣告、活动路由属性变化、有效撤回和重新宣告计为变化；重复宣告/重复撤回不计。每个窗口达到阈值时提醒一次。起源变化只比较两个均可确定唯一起源的活动路由。

乱序事件计入输入统计，但不回退缓存。会话离开 Established 时清除对应 peer 缓存；过期会话事件不会清除更新的缓存。输入仍应按时间顺序排列。

`records/skipped_records/ignored_families/session_resets` 描述时间窗口内的流，路由统计进一步受前缀和 peer 筛选。`warmup_records` 单独计数窗口前记录。路径均值按窗口内 RIB/宣告事件加权，包含重复宣告，撤回不参与。64 位计数以**十进制字符串**输出，避免 JSON 数字精度损失；ASN 为无符号数值。

## MoonBit 库

包为 `broti/mrtkit`，公开接口见 [pkg.generated.mbti](pkg.generated.mbti)。

| API | 用途 |
| --- | --- |
| `read_frame` | 解码一条完整记录 |
| `Decoder::decode_at` | 解码并附加文件、记录号、解压后记录偏移及事件索引 |
| `Decoder::new/decode/reset` | 有状态解析与 peer 表关联；新文件清除 peer 表 |
| `StreamDecoder::new/feed/finish` | 任意分块解析及 EOF 截断检查 |
| `parse_prefix/parse_attributes/parse_peers/parse_rib/parse_bgp4mp` | 单独使用协议组件 |
| `Query::new/matches` | 筛选路由事件 |
| `Analyzer::new/record_batch/observe/summary` | 累计元数据、状态变化和路由统计 |
| `Analyzer::seed/route_states` | 加载基线和导出可审计的最终路由状态 |
| `Snapshot::new/ingest/diff` | 比较同源、同视图快照，区分 peer 与路由缺失 |
| `Timeline::new/seed_peers/seed/record_batch/observe/report` | 前缀观测过程与可见性区间 |
| `Aggregation::new/observe/report` | 对带来源的变化提醒排名和计数 |
| `event_json/event_csv/csv_header` | 导出路由 |

`record_batch` 处理元数据和会话，路由需逐条调用 `observe`，便于自行筛选。`StreamDecoder` 失败后需创建新实例。

核心库没有 JS FFI，可运行于 JS、Wasm、Wasm GC。Node 负责文件读取、解压、参数与输出，协议解析、筛选和分析由 MoonBit 完成。JS 桥接是单会话串行接口，不支持同一实例并发分析。

## 资源与范围

- 单条 MRT payload 上限 16 MiB，库流式分块上限 1 MiB。
- CLI 按记录读取，`parse` 不缓存整个文件；分析默认最多缓存 1,000,000 个路由键，包含已撤回条目，可用 `--capacity` 调整。超限明确失败。
- 旧 TABLE_DUMP、RIB_GENERIC、多播、VPN/EVPN 尚未实现；未知 MRT 类型/子类型与 MP 地址族跳过并报告数量。
- OPEN/KEEPALIVE/NOTIFICATION/ROUTE-REFRESH 仅做基本结构检查，未完整解码能力协商。解析器检查结构和边界，不作为完整 BGP 合规验证器。
- 当前提供离线 CLI；没有实时 BGP 会话、RPKI 验证、路由劫持判定或 Web 界面。变化提醒用于排查线索。

## 验证与开发

```powershell
npm test
moon test --target wasm --deny-warn
moon test --target wasm-gc --deny-warn
moon info
moon fmt --check
```

47 个 MoonBit 测试分别通过 JS、Wasm、Wasm GC 验证；55 个 Node 测试通过。两个采集器的完整 RIB 与连续一小时 UPDATE（18 个文件、19,663,881 条路由事件及 749 条会话事件）通过独立解析器对照。字段范围和复现步骤见 [验证记录](docs/VALIDATION.md)，实现结构见 [开发说明](docs/DEVELOPMENT.md)。

完整 RIB、长回放、容量失败及热点输入的三次测量见[性能基准](docs/PERFORMANCE.md)，包含吞吐与内存代价；全部 P0/P1 的验收证据见[验收记录](docs/ACCEPTANCE.md)。

GitHub Actions 配置覆盖格式、接口、跨后端及 CLI 测试。CI 固定官方工具链标签 `0.10.14+7d59c7ec9`（与本地已验证的编译器一致），避免自动更新改变语法、格式或接口。

许可证：Apache-2.0。
