# 快照差异

[文档首页](../README.md) · [入门教程](../tutorials/getting-started.md) · [命令行](../reference/cli.md)

```powershell
node cli/mrtkit.mjs snapshot-diff --collector ris-rrc23 --peer-asn 64512 before.mrt.gz after.mrt.gz
node cli/mrtkit.mjs snapshot-diff --collector ris-rrc23 --prefix 2001:db8::/32 --prefix-mode more-specific before.mrt.gz after.mrt.gz
```

必须提供两个完整的 TABLE_DUMP_V2 单播快照及 `--collector`。该名称是使用者对两份输入来自同一采集器的声明；命令还检查 peer 表内的 Collector BGP ID、View Name 一致，且前快照起始时间不晚于后快照。MRT 中常见 Collector ID 为零，不能据此自动识别真实采集器。不同采集器请分别分析。时间窗口、`--initial-rib` 和路径 ASN 筛选不适用于此命令。

核心为 MoonBit 的 `Snapshot::new/ingest/diff`，输出一个版本为 `2.0` 的 JSON 对象。`changes` 按 peer 键、路由键及固定变化类型顺序排列，条目输入顺序不影响比较结果。来源指向实际输入位置，重新排列后来源位置会相应变化。

比较键为 peer ASN、peer IP、方向、规范化前缀和可选 Path Identifier；普通路径与 ADD-PATH 标识零分别比较。目前支持的 RIB 均为入方向。可用 `--peer-asn`、`--prefix`、`--prefix-mode`、`--path-id` 缩小路由范围。peer 可见性来自完整 peer 索引表，不依据筛选后的路由是否为空推断。

| kind | 含义 |
| --- | --- |
| `peer_added` / `peer_missing` | 后快照新增 / 缺少整个 peer；不再为该 peer 生成逐条路由缺失变化 |
| `route_added` / `route_missing` | 两个快照均列出该 peer，但只有一侧含该路由键 |
| `path_change` | 有效 AS 路径不同 |
| `origin_change` | 起源 AS 值不同，包含可确定与不确定之间的变化；不确定侧为 null |
| `attribute_change` | 路径以外的语义属性不同 |

路径、起源和属性变化可同时输出。`before`、`after` 保留完整路由及来源，`diff` 复用结构化路径、起源、下一跳和社区差异。缺失路由的一侧省略；peer 级变化的 `before_source/after_source` 指向 peer 表，其 `event_index` 为零，只代表记录来源。

`interpretation` 固定为 `snapshot_presence_difference_not_observed_bgp_withdrawal`。快照缺失不能表述为实际收到 BGP 撤回消息，也不能据此计算实际业务中断时长。

每个快照最多保留 `--capacity` 个筛选后的路由键（默认 1,000,000）。超容量、重复路由键、重复 peer 表、不支持的记录、无 peer 表或空文件均明确失败。只含 peer 表的文件表示该快照未列出路由；文件自身不能证明采集方没有提前截断，完整性仍须结合来源和校验和确认。
