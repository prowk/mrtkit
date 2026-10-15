# 基线与时间窗口回放

```powershell
node cli/mrtkit.mjs stats --initial-rib initial.mrt.gz --from 1735689900 --to 1735690200 updates.0000.gz updates.0005.gz updates.0010.gz
node cli/mrtkit.mjs changes --from 100 --from-micros 500 --to 100 --to-micros 700 updates.mrt
```

显式 RIB 必须不晚于窗口开始，加载的路由不计入统计或波动窗口。随后按文件顺序回放 UPDATE 和会话状态，窗口前只预热状态，窗口内统计和输出，窗口后不改变结束时状态。端点包含指定微秒；未指定时开始微秒为 0，结束微秒为 999999。

初始文件仅接受支持的 TABLE_DUMP_V2 单播记录及一个 peer 表；空文件、缺少或重复 peer 表、不支持记录、任何晚于窗口开始的记录均拒绝。只含 peer 表的快照可表示没有路由，加载成功后仍明确标记 `explicit_rib`。

`baseline_status` 为 `explicit_rib` 表示加载了显式快照；`updates_only` 表示只有窗口前事件构成的局部历史；`missing` 表示缺少窗口前基线。后两种情况不应解释为全量路由可见性。`warmup_records` 单独记录窗口前输入，其余输入与事件统计限于窗口内。

同一采集器的快照和连续更新应按时间顺序输入。解码器在每个文件边界重置 peer 索引，分析器保留路由和会话水位。已处理会话重置后的过期宣告不能重新激活旧状态。
