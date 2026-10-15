# 前缀时间线

```powershell
node cli/mrtkit.mjs timeline --prefix 203.0.113.0/24 fixtures/demo.mrt
node cli/mrtkit.mjs timeline --prefix 203.0.113.0/24 --from 1735689600 --to 1735693199 --initial-rib initial.mrt.gz --continuous-observation updates-0000.mrt.gz updates-0005.mrt.gz
node cli/mrtkit.mjs timeline --prefix 203.0.113.0/24 --continuous-observation --observation-gap 1735690200:1735690500 updates.mrt.gz
```

`timeline` 精确查询一个规范化前缀，支持 IPv4/IPv6、`--peer-asn`、`--path-id`、秒/微秒端点、初始 RIB 和窗口前预热。输出一个含 `summary` 与 `timeline` 的 JSON 对象。核心实现是 MoonBit 的 `Timeline`，与 `Analyzer` 共用状态及时间窗口规则。基线和预热不生成窗口内条目。

`entries` 按秒/微秒时间、来源文件、记录号、事件索引和类型排序。包括 `rib`、`announce`、`withdraw`、`reannounce`、`path_change`、`attribute_change`、`session_reset` 及显式标记的 `observation_gap`。重复宣告/撤回仍保留为观测记录。路径、起源和属性的全部提醒位于同一条目的 `changes`；`before/after`、`source` 追溯至实际输入。乱序路由条目标记为 `out_of_order`、`accepted: false`，不会回退状态。会话重置后，可见性为 `unobserved`，直到新的路由观测建立状态。

`paths` 展示 peer、方向、Path Identifier 各自的最后观测状态；`peers` 展示该 peer 所选路径的并集及活动、非活动、未知路径数。一个 ADD-PATH 路径被撤回，而另一条仍活动时，peer 仍为 `visible`。缺少完整基线且所有已知 ADD-PATH 都被撤回时，无法排除未观测到的其他路径，peer 状态为 `unobserved`。`--path-id` 的结果只描述所选路径。

`intervals` 的 `scope: "path"` 表示单条路径的观测不可见区间；`peer_intervals` 的 `scope: "peer_prefix"` 表示该 peer 的所选路径均不可见的区间。不能把一条 ADD-PATH 的不可见区间当作整个 peer 的前缀不可见区间。初始 RIB 中列出、但未含目标前缀的 peer 也保留在报告中。

区间时间全部是十进制字符串形式的 Unix 微秒：

- `started_at` 为观察到的起点或基线起点；`measured_from` 将统计起点裁剪到窗口开始。
- `observed_until` 最晚到输入实际覆盖的时间及窗口结束，取较早者。`--to 104` 默认包含 `104.999999`，精确到 `104.000000` 请同时设置 `--to-micros 0`。
- `recovery_time` 仅在实际观察到恢复时提供；未恢复、会话重置或观测中断均不伪造恢复事件。
- `left_censored` 表示真实起点未知或统计窗口截断了起点；`right_censored` 表示未观察到完整恢复。截尾区间的时长只能解释为已有观测的部分时长。

默认 `continuous_observation: false`，`quality: "continuity_unverified"`，不提供 `known_invisible_microseconds`。只有确认所选采集器输入连续完整后，才使用 `--continuous-observation` 作此声明；程序不能凭文件名或安静时段证明观测连续。

已知缺档、损坏区间或采集中断用可重复的 `--observation-gap 开始:结束` 标记，端点支持最多六位小数，范围为左闭右开。跨越中断的区间标记 `quality: "observation_gap"`，不提供确定时长；即使中断在窗口前，也不会凭中断前的状态推断窗口起点。中断后新的宣告/撤回可重新建立观测状态。报告保留原始中断列表；在窗口内开始的中断也出现在排序条目中。

`baseline_status` 明确区分 `missing`、`updates_only` 与 `explicit_rib`。`last_input_time` 和 `observed_window_end` 描述覆盖边界；无窗口内覆盖时省略后者。所有可见性均指单一采集器的所选路由观测，`interpretation` 为 `collector_route_visibility_not_business_outage`，不能据此推断实际业务中断时长。

时间线需要保存排序条目、区间和历史路径，适合聚焦单个前缀复盘。`--capacity` 同时限制分析器缓存、历史路径和时间线条目数，超过限制明确失败；调大容量会增加内存占用。公开库接口传入事件后，应保持其数组内容不变。发生错误后应重建分析会话。
