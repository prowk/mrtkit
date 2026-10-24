# 输出契约 2.0

[文档首页](../README.md) · [入门教程](../tutorials/getting-started.md) · [命令行](cli.md)

0.1.0 版工具采用 `schema_version: "2.0"`。可用 `--output-version 2.0` 固定期望版本；不支持的主版本直接失败。开发期变化输出的字符串 `before/after` 已替换为对象，不以旧版格式静默输出。工具发布版本与输出模式版本独立。后续同一模式主版本仅增加字段或可选变化种类，消费者应忽略未知字段，按需要显式检查种类；删除、改名或改变字段类型需要新主版本。

路由与变化保留采集秒、可选微秒、peer、方向、前缀。变化包含 `before/after` 状态对象和 `diff`：路径为 AS 分段数组，起源 AS 和下一跳为可空前后值，社区包含规范化的 `before/after/added/removed` 数组。`before` 缺失表示没有已知旧状态，空的 `diff` 表示相应事件不改变属性。属性变化的完整证据保留在状态对象中，JSON 不嵌套于字符串。

一个输入更新同时改变路径和非路径属性时，分别输出 `path_change`、可确定的 `origin_change`、`attribute_change`；它们共享 `source`，聚合时可据此去重。`churn` 额外给出 `churn_count`。时间和基线规则见 [REPLAY.md](../guides/replay.md)。

`source` 包含输入文件名、从 1 开始的 `record`、解压后 MRT 记录起始 `offset`、从 0 开始的记录内 `event_index`。64 位记录号与偏移使用十进制字符串。快照基线和变化前后状态各自保留来源。压缩文件的偏移不是压缩字节偏移；错误报告中的“解析器局部偏移”不是记录起点。底层无来源的 `decode` 可省略来源，需审计时使用 `decode_at`。

CSV 同样以 `schema_version` 开头，包含来源文件、记录号、记录偏移及事件索引。使用库的 `csv_header` 读取列定义，按列名消费，不依赖固定列号。统计中的 64 位计数保持十进制字符串。

开发分支的显式观测点来源另含可选 `source.collector` 和 `source.view`，旧单观测点调用不设置时省略。CSV 在已有列之后追加 `source_collector/source_view`，缺失为空，文本按 CSV 规则转义。变化的前后状态各自保存身份；来源去重包含身份，名称中的分隔符不能产生路由键碰撞。已发布的 v0.1.0 不包含这些新增字段。

Large Communities 按 [RFC 8092](https://www.rfc-editor.org/rfc/rfc8092.html) 解码为 `[全局管理员, 本地值1, 本地值2]` 三元组数组，规范排序并去重，原始编码保留在 `attributes.other` 的 code 32 中。排列和重复不产生语义变化，`diff.large_communities` 给出前后值及增删成员；CSV 使用空格分隔的 `ASN:值1:值2`。长度为零或不是 12 的倍数时抛出 `ParseError::Invalid`，这是离线格式解析错误，不将坏数据冒充真实观测到的撤回消息。

ADD-PATH 按 [RFC 8050](https://datatracker.ietf.org/doc/html/rfc8050) 支持单播 RIB 子类型 8/10，以及 BGP4MP/BGP4MP_ET 子类型 8/9/10/11。事件、变化和状态键包含可选 `path_id`，无标识与标识 0 不同。仅撤回指定 ID，不影响其他路径。`--path-id` 可筛选路径；普通输入省略 JSON 字段，CSV 对应列为空。

标准错误额外输出 `type: "diagnostics"` JSON，按 MRT 类型/子类型以及 MP AFI/SAFI 分组，给出数量和首条代表记录的文件、记录号、解压后偏移。MRT 分组数之和等于 `skipped_records`，MP 分组数之和等于 `ignored_families`。该诊断覆盖所有实际读取的记录（包括预热），不同于统计 JSON 中按窗口计数的字段，不混入标准输出的路由和变化流。底层批次诊断的来源只用于定位记录，事件索引不用于指代路由。

新增报告同样使用版本 2.0：[快照差异](../guides/snapshots.md)输出一个含 `changes` 的对象；[变化聚合](../guides/aggregation.md)输出 `summary/aggregation`；[时间线](../guides/timeline.md)输出 `summary/timeline`。时间线区间使用十进制字符串的 Unix 微秒，可选字段未知时省略；其 `quality`、截尾标志及覆盖时间必须与时长一起消费。上述报告不改变 `parse`、`stats` 和 `changes` 的既有输出形状。

未发布的 main 另支持 [multi 结果包](../guides/multi-collector.md)、[跨采集器关联](../guides/correlation.md)和[离线报告](../guides/html-report.md)。结果包索引保留每个观测点及整体的 `complete/partial`，明细使用相对路径和 SHA-256；来源身份不会靠文件名推测。`correlation_key` 仅在显式请求时增加，普通命令不强制输出。HTML 的 `status` 表示报告生成状态，`input_status` 保留输入完整性，不能相互替代。

三个结果包入口共用[来源、时间、计数及语义校验规则](bundle-validation.md)。历史合法 2.0 包可以没有可选哈希与关联键；已提供的键必须匹配核心重算结果，不能仅凭前缀和变化类型相同就通过。
