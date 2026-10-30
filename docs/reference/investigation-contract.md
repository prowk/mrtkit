# 调查结果契约 1.0

本契约新增 `investigation_bundle`，不改变既有 2.0 MRT 事件、关联包或回放接口。主版本不兼容时必须拒绝读取；次版本允许增加可忽略字段。所有文本 UTF-8，整数微秒为十进制字符串，ASN 为 uint32，Path Identifier 为可空 uint32（0 有效）。时间以 UTC 解释。

输入计划为 `archive_plan` 1.0：`window` 的 `from_us/to_us` 为半开窗口 `[from,to)`；`collectors[]` 每项明确 `collector/view`，`files[]` 明确 `kind`、相对 `path`、`url`、`from_us/to_us`、SHA-256、元数据依据。RIB 快照时点不得晚于起点，UPDATE 从基线时点预热到窗口终点。覆盖来自档案元数据声明，不根据安静期或首末路由记录推断。来源提供哈希与首次本地哈希分别记录。已有 1.0 multi manifest 的秒端点仍为闭区间，不混用。

路由键为 `(collector,view,peer_asn,peer_ip,outbound,prefix,path_id)`；来源键为上述观测点及 `(file,record,offset,event_index)`。file 是包内可移植标签，offset 是解压偏移。排序为 `(baseline优先,time_us,collector,view,file,record,event_index)`，相同时按输入顺序。稳定事件 ID 为此来源元组的 JSON 字符串；提醒 ID 为事件 ID 加规则名称。禁止用显示行号作为永久引用。

可选字段省略与 `null` 等价，解码均接受，不能视为已知空集合。`null` 表示不存在可确定值，须结合 `quality` 解读：`unknown` 是证据不足，`not_applicable` 是字段不适用，空数组是已知空集合。`baseline=missing` 不证明没有路由；`explicit_rib` 表示显式基线，不能覆盖缺档。`gap` 是声明的观测中断，`withdrawn` 是明确撤回，`session_reset` 是会话状态失效。部分结果 `partial` 保留有效证据和质量限制；`failed` 表示没有可用完成结果。容量超限必须失败或显式输出 partial，禁止静默截断。

规则配置 `investigation_rules` 1.0 包含 `version`、`from_us/to_us`、`bucket_us`、`incident_us`、`continuous`、`gaps[]`、`focus[]`、可选 `query`、可选 `comparison`。每条 focus 为 `prefix/expected_origins/allowed_more_specifics`。未配置 expected_origins 与空数组均表示未配置预期，输出 `expectation_unconfigured`；非空配置与已知实际值不符才输出 `unexpected_origin`。允许的更具体前缀只豁免对应精确子前缀。查询 origin_asns、path_asns、communities 各自为 OR 集合，字段之间 AND；side 为 before/after/either，选择完整一侧，撤回后值为已知非活动。origin_unknown 可明确匹配活动但起源不确定的路径。路径 ASN 包含 AS_SET/联盟成员；社区按集合匹配，不受重排影响。核心先维护完整状态再筛选输出。

输出 `index.json` 含 `schema_version/type/status/data_version/rules/inputs/quality/files`。文件清单含 bytes、sha256、rows。`events.jsonl` 保存筛选前事件，`selected.jsonl` 保存查询结果，`intervals.jsonl` 保存路径状态区间，`moas.jsonl` 保存同时有效的多起源区间，`more_specifics.jsonl` 保存含基线的活动更具体区间，`findings.jsonl` 保存事件规则线索，`incidents.jsonl` 保存归并事件；`summary.json`、`comparison.json`、`initial.json` 为独立 JSON。引用指向事件 ID 与提醒 ID，跨文件计数可对账。基线不计测量事件。

摘要同时提供 `all/selected`，明确 `scope`、事件数和提醒数；同一来源有多种提醒时事件计一次、提醒逐条计数。时间桶固定从 window.from_us 对齐，末桶截尾；类型、前缀、peer 排名按计数降序、键升序，Top N 以外归入其他项。仅凭变化明细不能反推 announcement/withdrawal 数，缺失输入的值为 null。图表与列表必须使用相同 scope，不能将 all 标作 selected。

状态区间为 `[from_us,to_us)`，保留 start/end source、left/right_censored。活动、撤回、会话重置、缺档、未知分别呈现；按 Path ID 展示，不能用单路径撤回推断整个 peer 不可见。无连续观测声明的 duration_us 为 null；跨缺档不能延续路由。MOAS 只聚合当前活动且有唯一起源的路径，AS_SET 不猜测起源，前后起源变化不等同同时多起源；保留每个来源、Path ID、`observed_at_us` 和 `time_precision`；关联图使用证据的原始观测时间，不能用区间开始时间替代。正常 MOAS 也输出，解释为观测事实。

调查事件按 `(prefix,collector,view,peer,direction,path_id)` 和首条提醒起固定窗口归并，不链式延长；保留全部原提醒、首次/末次时间，结束条件为固定窗口到期或窗口截尾。恢复引用只引用实际重新宣告且符合预期的证据，未知区间独立保留。窗口对比要求同一资源、共同 peer 范围，按可确认区间并集计算有效观测时长；分母不足则 frequency=null，不把覆盖变化解释为异常。

路径播放器只消费核心生成的 initial/events，保留重复 ASN、所有段类型及 Path ID；AS_SET 显示为集合，不画有序邻接，AS 邻接仅称观测邻接。每步都有来源引用。浏览器仅按需加载页和紧凑筛选索引，不解析 BGP。

固定示例：窗口 `[100000000,110000000)`，peer A 在 100 秒宣告起源 1，101 秒 peer B 宣告起源 2，103 秒 B 撤回：三个事件，MOAS `[101000000,103000000)`，起源集合 `[1,2]`；没有预期配置时是 observation，不是违规。若 102 秒开始缺档，则确定区间截至 102 秒，缺档后没有新宣告的 A 为 unknown。异常示例：to<=from、未知主版本、越界文件路径、无效 CIDR、负 Path ID、超容量均失败；缺少基线可以 partial 并显式 baseline=missing。
