# 开发说明

## 模块职责

```text
Node 文件流 / gzip / bz2
        ↓ 完整 MRT 记录
bridge/bridge.mbt
        ↓
Decoder → MRT frame → peer/RIB 或 BGP4MP
                       ↓
               属性、AS4、MP、前缀
                       ↓
              Query → Analyzer → JSON/CSV
```

`cursor.mbt` 提供有界网络字节序读取，子游标不越过父边界。`frame.mbt` 负责记录头与扩展时间戳。`prefix.mbt` 清除主机位并规范化 IPv6 显示。

`attributes.mbt/as4.mbt` 负责属性与有效路径还原。`multiprotocol.mbt` 处理更新/快照中的不同 MP 编码。`rib.mbt` 关联 peer 索引，`bgp.mbt` 处理消息与会话状态。

`decoder.mbt` 管理 peer 表并提供增量 API。`query.mbt` 筛选与导出，`analysis.mbt` 跟踪状态，`semantics.mbt` 比较路径和属性语义。`bridge/` 提供单会话 JS 接口，`cli/` 承担系统 I/O。

`snapshot.mbt` 按采集器声明和 peer 表比较快照；`aggregate.mbt` 依据来源去重变化提醒；`timeline.mbt` 复用分析器状态，记录路径及 peer 可见性、会话重置与观测中断。`prefix_text.mbt` 为库与 CLI 提供同一份 IPv4/IPv6 文本解析和查询规范化。

分析器以 peer 路由索引代替会话重置的全表扫描，缓存规范化属性以减少重复比较。撤回条目继续保留，维持乱序、重新宣告和波动窗口语义。`StreamDecoder` 验证头部后按记录容量分配缓冲区，避免碎片输入反复拼接已有全部字节。公开事件的数组由调用方保持不变，发生错误后重建会话。

## 错误契约

畸形输入抛出 `ParseError::Invalid(position, message)`。位置是当前组件输入的局部字节位置，嵌套属性未统一映射为文件绝对位置。CLI 同时报告文件名、记录序号和记录起始的绝对偏移。

已识别类型内容损坏时停止解析；未知类型/子类型计入 `skipped_records`，不支持的 MP 地址族计入 `ignored_families`。当前没有错误后自动重同步。

## 测试与提交

公开 API 使用黑盒测试，协议细节使用白盒测试。Node 编码器独立生成样本，验证完整 CLI。对照依赖 `mrtparse` 仅放在 `.validation/`。功能提交包含对应测试，失败时不提交该功能。

开发历程包含项目建立、安全读取、分帧、前缀、属性、快照、更新、IPv6、AS4、增量处理、查询导出、变化分析、CLI、两轮语义修复、真实数据验证和交付工具配置。用 `git log --oneline --reverse` 查看各阶段。

ADD-PATH、Large Communities、结构化差异和来源追溯已实现。后续可扩展 RIB_GENERIC、多采集器关联和索引查询，扩展时同步更新支持范围、真实样本与公共接口。
