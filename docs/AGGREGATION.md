# 变化聚合

```powershell
node cli/mrtkit.mjs aggregate --from 1735689600 --to 1735693199 --top 20 updates.20250101.0000.gz updates.20250101.0005.gz
node cli/mrtkit.mjs aggregate --from 1735689600 --initial-rib initial.mrt.gz --peer-asn 64512 updates.mrt.gz
```

`aggregate` 与 `changes` 使用相同的筛选、基线、预热、窗口及波动规则，输出一个含 `summary` 和 `aggregation` 的 JSON 对象。窗口外、基线及预热不会进入变化排名。没有变化的前缀不进入排名。

统计对象是 `changes` 的结构化提醒：`path_change`、`origin_change`、`attribute_change`、`churn`。普通首次宣告、撤回、重新宣告在未触发这些提醒时不单独纳入本排名；时间线命令负责展示完整观测过程。所有统计均为观测变化，不是故障判定。

- `change_notices` 和 `change_types` 统计提醒条数，每条提醒对应一个类型；同一事件可同时产生多个提醒，二者按条复算。
- 每个前缀的 `changed_events` 按 `source.file/record/offset/event_index` 去重。同一输入事件同时产生路径、起源和属性变化，只算一次事件。
- `affected_peers` 按 peer ASN、peer IP、方向去重；全局值跨前缀去重，各前缀值各自去重。ADD-PATH 的不同路径仍属于同一个 peer。
- 排名按 `changed_events` 降序，再按规范化前缀文本升序；`--top` 默认 20，只截断排名列表，全局合计不截断。

将相同文件以相同文件名重复传入时，来源事件去重仍会生效；提醒计数保留实际处理次数。为了保持业务解释清楚，应按时间顺序每个文件传入一次。聚合必须具有来源信息；库接口 `Aggregation::observe` 拒绝缺少来源的变化。

测试直接读取相同输入的 `changes` 输出，独立重算来源集合、peer 集合、类型分布及排序，并与聚合结果逐项比较。
