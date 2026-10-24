# 标准兼容与交付验收清单

[文档首页](../README.md) · [入门教程](../tutorials/getting-started.md) · [命令行](cli.md)

v0.2.0 的范围为 IPv4/IPv6 单播 MRT 离线解码和观测分析，增加多观测点隔离、磁盘回放、外部关联及离线报告。下表的“完成”仅指明确列出的格式及行为，不能解释为完整实现某个 RFC。真实档案对照是补充证据，不能替代未出现规则的正反例。

## MRT 与 BGP 信封

| 适用条款与行为 | 实现 | 正例 / 反例证据 | 状态 |
| --- | --- | --- | --- |
| [RFC 6396 §2–3](https://www.rfc-editor.org/rfc/rfc6396.html#section-2)：12 字节公共头、网络字节序、长度、扩展时间戳；微秒 0–999999 | `frame.mbt`、`cursor.mbt` | `frame_test.mbt`、`cursor_wbtest.mbt`：无符号上界、正常/截断/尾随/超限；`tests/envelope_contract.test.mjs`：微秒端点与越界 | 完成 |
| [RFC 6396 §4.3.1](https://www.rfc-editor.org/rfc/rfc6396.html#section-4.3.1)：PEER_INDEX_TABLE，IPv4/IPv6、2/4 字节 Peer AS、原始视图名 | `rib.mbt` | `rib_wbtest.mbt` 混合 peer 正例；`tests/envelope_contract.test.mjs` 空表、条目截断与保留位错误 | 完成 |
| [RFC 6396 §4.3.2、§4.3.4](https://www.rfc-editor.org/rfc/rfc6396.html#section-4.3.2)：RIB 2/4、peer 索引、起源时间、固定四字节 AS_PATH | `rib.mbt`、`multiprotocol.mbt` | `rib_wbtest.mbt`、`tests/protocol.test.mjs`：关联 peer、IPv6、精简下一跳；`decoder_test.mbt`、`tests/failure_contract.test.mjs`：缺表、坏索引、截断 | 完成 |
| [RFC 6396 §4.4](https://www.rfc-editor.org/rfc/rfc6396.html#section-4.4)：BGP4MP 16 / BGP4MP_ET 17，子类型 0/1/4/5/6/7；IPv4/IPv6 会话端点、LOCAL 方向及状态 1–6 | `bgp.mbt` | `bgp_wbtest.mbt`、`tests/protocol.test.mjs`、`tests/addpath.test.mjs`：ASN/地址宽度、方向及微秒；非法状态、AFI 与长度反例 | 完成 |
| [RFC 8050 §3–4.1](https://www.rfc-editor.org/rfc/rfc8050.html#section-3)、[RFC 7911 §2–3](https://www.rfc-editor.org/rfc/rfc7911.html#section-2)：RIB 8/10、BGP4MP/ET 8/9/10/11 的 ADD-PATH | `rib.mbt`、`bgp.mbt` | `tests/addpath.test.mjs`：两种 NLRI 地址族、两种 ASN 宽度、LOCAL/ET，ID0/最大 ID、独立撤回、普通路径与 ID0 隔离；截断 NLRI 走有界游标失败 | 完成 |
| [RFC 4271 §4.1–4.3](https://www.rfc-editor.org/rfc/rfc4271.html#section-4.1)：marker、长度一致、类型、UPDATE 撤回/属性/宣告边界 | `bgp.mbt` | `bgp_wbtest.mbt`：混合宣告撤回、marker 与截断；`tests/envelope_contract.test.mjs`：长度上下界、类型及 AFI 错误 | 完成 |
| [RFC 4271 §4.2、4.4、4.5](https://www.rfc-editor.org/rfc/rfc4271.html#section-4.2)、[RFC 2918 §3](https://www.rfc-editor.org/rfc/rfc2918.html#section-3)：OPEN≥10、NOTIFICATION≥2、KEEPALIVE=0、ROUTE-REFRESH=4 字节体的基本结构 | `bgp.mbt` | `tests/envelope_contract.test.mjs`：四类正常长度、不生成路由、过短/额外字节失败 | 完成，限定基本结构 |

MRT 子类型决定 ASN 和 ADD-PATH 的解码环境，不从未记录的 OPEN 能力猜测。BGP 消息长度必须匹配其 MRT 载荷，允许两字节长度字段可表达的扩展长度；未据此证明 [RFC 8654](https://www.rfc-editor.org/rfc/rfc8654.html) 在线协商已发生。OPEN 不校验全部能力和可选参数，ROUTE-REFRESH 不执行在线刷新。

## 属性、上下文与兼容解释

| 适用条款与行为 | 实现 | 正例 / 反例证据 | 状态 |
| --- | --- | --- | --- |
| [RFC 4271 §4.3、§5.1.1–5.1.5](https://www.rfc-editor.org/rfc/rfc4271.html#section-4.3)：ORIGIN 0–2、AS_PATH、NEXT_HOP、MED、LOCAL_PREF 的值和边界 | `attributes.mbt` | `attributes_test.mbt`、`hardening_wbtest.mbt`：正常字段、集合起源、重复属性、非法段、非法长度和逐截断点 | 完成 |
| [RFC 4271 §5.1.6–5.1.7](https://www.rfc-editor.org/rfc/rfc4271.html#section-5.1.6)、[RFC 6793 §3、§6](https://www.rfc-editor.org/rfc/rfc6793.html#section-3)：ATOMIC_AGGREGATE=0 字节，AGGREGATOR=6/8，AS4_AGGREGATOR=8；存在信息、ASN/IPv4 地址与原始编码 | `aggregator.mbt`、`attributes.mbt` | `aggregator_wbtest.mbt`、`tests/attributes_contract.test.mjs`：缺失/存在、两种宽度、所有非法长度、逐截断点、原始值保留 | 完成 |
| [RFC 6793 §4.2.3、§6](https://www.rfc-editor.org/rfc/rfc6793.html#section-4.2.3)：AS4 有效路径、聚合器兼容组合、AS_TRANS、长度关系、AS_SET/联盟段 | `as4.mbt`、`aggregator.mbt` | `as4_wbtest.mbt`、`aggregator_wbtest.mbt`、`tests/attributes_contract.test.mjs`：存在组合与宽度矩阵、AS4 过长、非 AS_TRANS 聚合、联盟后缀丢弃；有效与原始字段分离 | 完成 |
| [RFC 4271 §4.3、§6.3](https://www.rfc-editor.org/rfc/rfc4271.html#section-6.3)：Optional/Transitive/Partial，普通/扩展长度，接收保留位忽略其意义 | `attribute_flags.mbt`、`attributes.mbt` | `aggregator_wbtest.mbt`、`tests/attributes_contract.test.mjs`：每种已知属性合法/非法标志、短值扩展长度、保留位、未知 well-known 失败与 optional 完整保留 | 完成 |
| [RFC 4271 §4.3、§6.3](https://www.rfc-editor.org/rfc/rfc4271.html#section-4.3)、[RFC 4760 §3–4](https://www.rfc-editor.org/rfc/rfc4760.html#section-3)：宣告必需属性与 MP 上下文 | `attribute_context.mbt`、`bgp.mbt` | `attribute_context_wbtest.mbt`、`tests/attributes_context.test.mjs`：普通宣告缺 1/2/3、MP 缺 1/2 失败；空 AS_PATH、纯撤回、MP_UNREACH、空 UPDATE、RIB 部分属性合法 | 完成，条件边界见下文 |
| [RFC 4760 §3–4](https://www.rfc-editor.org/rfc/rfc4760.html#section-3)、[RFC 6396 §4.3.4](https://www.rfc-editor.org/rfc/rfc6396.html#section-4.3.4)：MP_REACH/UNREACH 单播、IPv6 下一跳、快照精简与历史完整编码 | `multiprotocol.mbt` | `multiprotocol_wbtest.mbt`、`tests/protocol.test.mjs`、`tests/attributes_context.test.mjs`：IPv6、撤回、空 NLRI、精简下一跳；非法长度/截断失败、范围外地址族计数 | 完成 |
| [RFC 1997 Communities 属性](https://www.rfc-editor.org/rfc/rfc1997.html)、[RFC 7606 §7.8](https://www.rfc-editor.org/rfc/rfc7606.html#section-7.8)：非零四字节倍数社区 | `attributes.mbt`、`semantics.mbt` | `attributes_test.mbt`、`semantics_wbtest.mbt`、`tests/attributes_contract.test.mjs`：值、重排去重、零长/非整倍数失败 | 完成 |
| [RFC 8092 §3、§6](https://www.rfc-editor.org/rfc/rfc8092.html#section-3)：Large Communities，非零十二字节倍数，去重、排序不影响意义 | `large_communities.mbt`、`attributes.mbt` | `large_communities_wbtest.mbt`、`tests/output.test.mjs`：结构化三元组、原始顺序、重复、增删、坏长度 | 完成 |

RIB 是快照属性集，RFC 6396 没有要求套用 UPDATE 信封的必需属性组合；只校验已有字段。支持的 MP_REACH 即使没有 NLRI 也检查 ORIGIN/AS_PATH。iBGP LOCAL_PREF、首 AS、AS0、下一跳可达性、本机地址策略及完整能力协商不由本工具推断。RFC 7606 只用作格式规则参考，不执行其在线恢复行为。聚合器与 AS4 的详细决策表见[属性规则](attributes.md)。

## 查询、变化、失败与交付

| 承诺 | 实现与验收证据 | 状态 |
| --- | --- | --- |
| 新属性贯通比较、快照、变化、查询导出、时间线、聚合 | `semantics.mbt`、`diff.mbt`、`query.mbt`；`tests/attributes_context.test.mjs` 验证出现/消失/有效值差异及等价编码不误报，JSON/CSV 字段见[输出契约](output.md) | 完成 |
| 独立字段与真实档案复验 | `scripts/compare.py`、`reference_wire.py`、`test_compare.py`；逐记录保存重复次数，比较聚合器及全部原始标志和值；18 个完整档案、1,966 万路由事件[报告](../validation/archive-comparison.json)；失败原始复现及有界摘要测试 | 完成 |
| 完整 RIB + 连续更新 + 窗口 + 正式导出 | `scripts/replay_acceptance.py`、`replay_audit.mjs`；固定来源/哈希、独立复算前后状态和变化、正式 CLI JSON/CSV，[结果](../validation/replay-acceptance.json)；`tests/window.test.mjs`、`model.test.mjs`、`addpath.test.mjs`、`timeline.test.mjs` 补充 IPv6、ID0、重置/乱序、缺基线/缺档 | 完成 |
| 输入与资源失败不冒充完整结果 | `tests/failure_contract.test.mjs`、`cli.test.mjs`、`transport.test.mjs`：损坏 gzip/bz2、截断、坏 peer、容量/16 MiB、ENOSPC/EACCES/EPIPE；真实关闭 stdout 管道非零退出，错误位置及部分结果清晰；见[错误契约](errors.md) | 完成 |
| 最终接口、三后端及文档一致 | `moon info`、`moon fmt`、`npm test`、Wasm/Wasm GC；公开接口、入门、导航、[验证记录](../validation/README.md)与 CI 同步 | 完成 |

本次对已实现代码的规则审查补齐了属性标志、宣告上下文、AS4 聚合组合、AS4 联盟段处理、COMMUNITY/AS4_PATH 长度、范围外 MP_REACH 通用头截断和输出失败退出行为。每项均有上述反例，未以真实样本没有触发错误作为正确性证明。

## 明确范围外与原始保留

- **已结构化**：上述单播类型、消息基本信封、常用属性、AS4/ADD-PATH/社区/聚合属性、路由与会话观测。
- **原始保留**：所有已接收属性的 flags/code/value；未知 optional 属性不猜测语义；IPv6 双下一跳的链路本地部分、未展开字段仍可从原始属性追溯。
- **跳过并诊断**：旧 TABLE_DUMP、RIB_GENERIC、未实现 MRT 子类型，多播、VPN/EVPN 等范围外 MP NLRI。已识别格式损坏则失败，不尝试重同步。
- **不实现**：在线 BGP FSM、能力协商、路由选择、RFC 7606 路由器恢复、RPKI/劫持判定。多采集器状态仍按观测点独立，不合并为全网最佳路由。磁盘分区保留完整逻辑状态，但单个 peer 超过预算时仍明确失败。

分析按 peer ASN/IP、方向、前缀和可选 Path Identifier 隔离；不同采集器分别运行。单记录上限 16 MiB，库 feed 分块上限 1 MiB；默认缓存 1,000,000 键，包含已撤回条目；时间线还限制历史条目。基线和连续性证据不足时保留不确定性，不把缺档或不可见观测解释为业务中断。
