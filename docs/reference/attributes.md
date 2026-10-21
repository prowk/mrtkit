# 属性解释与离线校验

[文档首页](../README.md) · [入门教程](../tutorials/getting-started.md) · [命令行](cli.md)

本页描述已实现规则，规范依据为 [RFC 4271 §4.3、§5](https://www.rfc-editor.org/rfc/rfc4271.html#section-4.3)、[RFC 4760 §3–4](https://www.rfc-editor.org/rfc/rfc4760.html#section-3)、[RFC 6793 §4、§6](https://www.rfc-editor.org/rfc/rfc6793.html#section-4.2.3)及 [RFC 7606 的格式判定](https://www.rfc-editor.org/rfc/rfc7606.html#section-7)。本工具进行离线检查，错误返回 `ParseError::Invalid` 并停止当前解析；不执行在线的 attribute-discard、treat-as-withdraw、AFI disable 或会话 NOTIFICATION，也不把坏记录变成实际撤回事件。

## 聚合属性

| 字段 | 表示 |
| --- | --- |
| `atomic_aggregate` | false 表示没有 code 6；true 表示存在零长度 ATOMIC_AGGREGATE |
| `wire_aggregator` | code 7 的原始结构化值 `{asn, address}`；缺失则省略 |
| `as4_aggregator` | code 18 的原始结构化值，即使不参与有效解释也保留 |
| `aggregator` | 根据编码宽度与兼容组合解释出的有效聚合器；缺失则省略 |
| `raw_attributes` | 全部属性，按输入顺序保留 `{flags, code, value}`；value 为原始字节数组 |

code 6 长度严格为 0；code 7 在两字节 ASN 编码环境为 6 字节，在四字节环境为 8 字节；code 18 为 8 字节。地址始终占四字节。MRT 子类型提供编码宽度，不能把 peer 索引表中的 Peer AS 字段宽度当作 RIB AS_PATH 宽度。RIB AS_PATH 按 RFC 6396 使用四字节 ASN；本工具按四字节属性环境解释该属性集。

原有 `other` 仍保留 code 6/7/18 的编码，供已有消费者追溯；完整编码来源以 `raw_attributes` 为准。Extended Length 位及 value 长度足以还原一字节/两字节属性长度头；接收端忽略的保留位也不丢失。

在两字节环境：有 AS4_AGGREGATOR 且旧聚合器为 AS_TRANS 时使用 AS4 值；两者均存在且旧 ASN 非 AS_TRANS 时使用旧值，并忽略 AS4_PATH 的有效解释；只有旧聚合器时不据此抑制 AS4_PATH。孤立 AS4_AGGREGATOR 按 RFC 6793 的 otherwise 兼容分支提供有效值，同时保留 `wire_aggregator` 缺失这一事实。四字节环境直接使用 wire AGGREGATOR 和 AS_PATH，不把 AS4 元数据覆盖到有效值。

AS4 还原使用路径长度关系：AS_SET 算一个位置，联盟段不计常规长度。AS4 比旧路径长则保留旧路径；其余情况保留必要的旧前缀，再连接 AS4 后缀，保留适用的前导/邻接联盟段。AS4_PATH 中的联盟段不参与有效后缀，原始分段仍保留。空 AS_PATH 可以合法存在；空 AS4_PATH 及不完整路径段明确失败。

## 标志与编码

| 属性 | Optional / Transitive | Partial |
| --- | --- | --- |
| ORIGIN、AS_PATH、NEXT_HOP、LOCAL_PREF、ATOMIC_AGGREGATE | 0 / 1 | 必须为 0 |
| MED、MP_REACH、MP_UNREACH | 1 / 0 | 必须为 0 |
| AGGREGATOR、COMMUNITY、AS4_PATH、AS4_AGGREGATOR、LARGE_COMMUNITY | 1 / 1 | 接受 0 或 1 |
| 未知 optional | 保留收到的 Transitive | 仅 transitive 可以带 Partial |
| 未知 well-known | 无法解释 | 明确失败，不冒充可忽略 optional |

接收时忽略低四个保留位的含义，但保留其编码。普通和扩展长度两种编码都允许表示短属性，实际长度必须与值边界一致；重复属性失败。COMMUNITY 为非零的四字节倍数，Large Communities 为非零的十二字节倍数。范围外 MP 地址族不解释其 NLRI，但通用 MP_REACH 的下一跳长度和头部仍不得截断。

语义比较忽略 Extended Length 与保留位差别。聚合属性比较 `atomic_aggregate` 和有效 `aggregator`，不把等价的两字节/AS4 兼容编码误报为变化；原始字段仍完整导出。未知属性没有已知值语义，以类型、Optional/Transitive/Partial 和值字节比较。

## 必需属性上下文

| 上下文 | 检查 |
| --- | --- |
| 普通 IPv4 NLRI 宣告 | 必须存在 ORIGIN、AS_PATH、NEXT_HOP；MP 下一跳不能替代经典 NEXT_HOP |
| 支持范围内 MP_REACH | 必须存在 ORIGIN、AS_PATH，包括 MP_REACH 中暂时没有 NLRI 的情形 |
| 纯 IPv4 撤回、MP_UNREACH、空 UPDATE | 不强求宣告属性；已提供属性仍检查格式 |
| 独立属性块 | 只检查已有属性，不臆造消息上下文 |
| TABLE_DUMP_V2 RIB 属性 | 按 RFC 6396 的快照属性格式处理，不套用 UPDATE 信封的必需属性判定；缺失保留为缺失 |

存在空 AS_PATH 与缺少 AS_PATH 不同，检查依据原始属性的存在信息。MP_REACH 的保留字节按接收规则忽略。档案没有完整能力协商和部署策略信息，不猜测 iBGP LOCAL_PREF 必需条件、首 AS 校验、下一跳可达性或本机地址策略。RIB 中 MP_REACH 的精简下一跳格式和历史完整格式由 RIB 解析上下文区分，不能直接当作 UPDATE MP_REACH 解码。

## 变化与导出

`diff.atomic_aggregate` 提供布尔前后值；`diff.aggregator` 提供可空的结构化前后值，null 表示缺失。变化前后状态及来源仍完整保存。快照、时间线与变化聚合复用相同语义比较，因此有效值的出现、消失和改变均一致地反映为属性变化。

输出模式继续使用 schema 2.0 的增量字段策略。CSV 在已有列后追加 `atomic_aggregate`、有效/wire/AS4 聚合器的 ASN 与地址列；缺失 ASN/地址为空，ATOMIC 缺失为 false。消费者应按列名读取，不能假定 Path Identifier 永远位于最后一列。

对应测试为 `aggregator_wbtest.mbt`、`attribute_context_wbtest.mbt`、`tests/attributes_contract.test.mjs`、`tests/attributes_context.test.mjs`。包含存在组合、ASN 宽度、AS_TRANS、AS_SET/联盟段、长度/截断、标志正反例、上下文及变化/快照/时间线/聚合/CSV 的贯通校验。
