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

## 错误契约

畸形输入抛出 `ParseError::Invalid(position, message)`。位置是当前组件输入的局部字节位置，嵌套属性未统一映射为文件绝对位置。CLI 同时报告文件名、记录序号和记录起始的绝对偏移。

已识别类型内容损坏时停止解析；未知类型/子类型计入 `skipped_records`，不支持的 MP 地址族计入 `ignored_families`。当前没有错误后自动重同步。

## 测试与提交

公开 API 使用黑盒测试，协议细节使用白盒测试。Node 编码器独立生成样本，验证完整 CLI。对照依赖 `mrtparse` 仅放在 `.validation/`。功能提交包含对应测试，失败时不提交该功能。

开发历程包含项目建立、安全读取、分帧、前缀、属性、快照、更新、IPv6、AS4、增量处理、查询导出、变化分析、CLI、两轮语义修复、真实数据验证和交付工具配置。用 `git log --oneline --reverse` 查看各阶段。

后续可扩展 ADD-PATH、RIB_GENERIC、完整属性模型和索引查询，扩展时同步更新支持范围、真实样本与公共接口。
