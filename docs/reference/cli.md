# 命令行参考

[文档首页](../README.md) · [入门教程](../tutorials/getting-started.md) · [命令行](cli.md)

## 命令与选项

基本用法：`node cli/mrtkit.mjs 命令 [选项] 文件...`；`--help` 查看帮助，`--version` 查看工具版本。文件 `-` 代表未压缩标准输入，每次最多使用一次；`--` 分隔后续以选项形式开头的文件名。

| 命令 | 输出 |
| --- | --- |
| `parse` | 路由 JSON Lines 或 CSV |
| `stats` | 窗口统计 JSON |
| `changes` | 结构化变化 JSON Lines，统计写 stderr；`--compact` 共享事件上下文 |
| `snapshot-diff` | 两个同源快照的差异 JSON，需要 `--collector` |
| `aggregate` | `summary/aggregation` JSON |
| `timeline` | `summary/timeline` JSON，需要精确 `--prefix` |
| `multi` | 显式清单回放结果包；用 `--manifest` 与 `--output` 指定 |
| `replay-disk` | 完整逻辑状态按 peer 磁盘分区回放；`--manifest`、`--output`、RSS/磁盘/排序预算 |
| `correlate` | 内存关联 JSON；`--external --output 新目录` 切换有界内存分离输出 |
| `report` | 本地 HTML、明细和倒排索引；`--correlation` 可附加分离式关联结果 |

| 选项 | 默认 / 约束 |
| --- | --- |
| `--prefix CIDR`、`--prefix-mode 模式` | 无筛选；模式为 `exact` / `more-specific` / `covering`，默认 exact |
| `--asn ASN`、`--peer-asn ASN` | 无筛选；前者仅 parse 匹配路径或 peer，后者匹配 peer |
| `--path-id ID` | 无筛选；0–4294967295，包含 0 |
| `--from 秒`、`--to 秒` | 0–4294967295，包含端点 |
| `--from-micros 微秒`、`--to-micros 微秒` | 0 / 999999，范围 0–999999 |
| `--initial-rib 文件` | 可选一个初始 RIB；用于分析，快照差异另接两个完整快照 |
| `--window 秒`、`--threshold 次` | 60 / 10；窗口为正，阈值至少 2 |
| `--capacity 条` | 1000000，正整数；包括撤回状态，时间线还约束条目 |
| `--format json或csv` | json；只有 parse 支持 CSV |
| `--output-version 版本` | 2.0，其他版本明确失败 |
| `--collector 名称` | 仅 snapshot-diff，必须非空；不接受时间窗口 |
| `--top 条` | 仅 aggregate，默认 20，正整数 |
| `--continuous-observation` | 仅 timeline；默认不声明连续性 |
| `--observation-gap 开始:结束` | 仅 timeline，可重复，支持六位小数秒，左闭右开 |

## 示例

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

`--from/--to` 使用 Unix 秒，包含端点，可用 `--from-micros/--to-micros` 指定端点微秒。分析会回放窗口前的 UPDATE 和会话状态作为预热；使用 `--initial-rib 文件` 显式加载初始快照。基线和预热不计入窗口统计，窗口后的事件不改变最终状态。缺少完整基线会通过 `baseline_status` 标识，详见[回放说明](../guides/replay.md)。

标准输出只有结果，计数和诊断写入标准错误。成功退出码为 `0`，错误为 `1`。错误前已经输出的 JSON Lines/CSV 是部分结果。文件名以 `--` 开头时，用 `--` 分隔选项。

`.gz` 根据扩展名解压；`.bz2` 使用 Python 标准库流式解压，可用 `MRTKIT_PYTHON` 指定解释器。`-` 只读取未压缩标准输入。

两个完整快照可用 `snapshot-diff --collector 名称 前快照 后快照` 比较，详见[快照差异](../guides/snapshots.md)。该命令区分整个 peer 缺失与路由条目缺失，不将快照缺失当作观测到的撤回。

`aggregate --top 20 文件...` 对相同分析窗口的变化提醒排名；去重和复算规则见[变化聚合](../guides/aggregation.md)。

`timeline --prefix CIDR 文件...` 展示一个前缀的观测过程、各 peer 状态与有证据支持的不可见区间，详见[时间线](../guides/timeline.md)。

## 数据与分析语义

路由事件包含采集时间、可选微秒、`rib/announce/withdraw`、规范化前缀、peer ASN/IP、`outbound`、可选快照起源时间和属性。`attributes.path` 是有效路径，`wire_path/as4_path` 是原始分段。未知属性的 `value` 是字节数组。

0.2.0 继续使用版本化输出 `schema_version: "2.0"`。变化的前后状态和路径、起源、下一跳、社区增删均为结构化对象，包含微秒及输入来源；完整与[紧凑编码](compact-changes.md)由显式编码字段区分。详见[输出契约](output.md)。

AS_SET 计为一个跳数，联盟段不计普通路径长度。末段为 AS_SET 时不推断唯一起源 AS。变化比较忽略集合成员顺序、连续序列分段、社区排列及同一 MP 属性携带的其他前缀。

分析按 **peer ASN＋peer IP＋收发方向＋前缀＋可选 Path Identifier** 隔离。不同采集器须分开运行。使用一个初始 RIB 再接后续 UPDATE；多个完整快照须分别分析，不通过后续快照中缺失的条目推断撤回。

波动采用从首次观察或窗口重启时开始的固定窗口。初次宣告、活动路由属性变化、有效撤回和重新宣告计为变化；重复宣告/重复撤回不计。每个窗口达到阈值时提醒一次。起源变化只比较两个均可确定唯一起源的活动路由。

乱序事件计入输入统计，但不回退缓存。会话离开 Established 时清除对应 peer 缓存；过期会话事件不会清除更新的缓存。输入仍应按时间顺序排列。

`records/skipped_records/ignored_families/session_resets` 描述时间窗口内的流，路由统计进一步受前缀和 peer 筛选。`warmup_records` 单独计数窗口前记录。路径均值按窗口内 RIB/宣告事件加权，包含重复宣告，撤回不参与。64 位计数以**十进制字符串**输出，避免 JSON 数字精度损失；ASN 为无符号数值。
