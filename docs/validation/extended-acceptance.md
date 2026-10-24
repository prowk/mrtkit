# main 深化功能验收

[验证首页](README.md) · [版本记录](../../CHANGELOG.md) · [真实案例](../../cases/rrc23-path-change/README.md)

本记录对应 v0.1.0 之后的 main 源码扩展；没有重新发布或改写 v0.1.0 标签、GitHub 附件及 Mooncakes 包。协议核心仍使用输出模式 2.0，新增字段和报告保留明确版本。

| 交付项 | 实现与证据 | 结论及限制 |
| --- | --- | --- |
| 无筛选的完整 RIB 加连续更新基准 | `fullstate_benchmark.mjs` / `fullstate_worker.mjs`；[输入、三轮测量和失败证据](full-state-benchmark.md) | 已建立可重复基准。两版均受 1400 MiB RSS 预算限制，未完成全 RIB 驻留；后续阶段的完整成本明确未知 |
| 降低状态内存并保持语义 | `storage.mbt`、`analysis.mbt` 的属性共享及引用回收；`storage_wbtest.mbt`、`tests/storage.test.mjs`、独立状态模型；[六轮实际输出与状态核验](fullstate/comparison.json) | 相同检查点 RSS 约降低 60.8%；全部 UPDATE 的变化字节、统计、来源和最终状态一致。保留撤回水位、波动窗口，不引入过期假设 |
| 显式观测点和独立状态 | `Decoder::decode_scoped`、`scoped_peer_key`、`cli/multi.mjs`；`scope_wbtest.mbt`、`tests/scope.test.mjs`、`tests/multi.test.mjs` | 输入明确身份、类型、时间及哈希；同名 peer、前缀、Path ID 隔离；联合结果按观测点拆分后与单独回放一致 |
| 跨采集器关联 | `correlation.mbt`、`cli/correlate.mjs`；`correlation_wbtest.mbt`、`tests/correlate.test.mjs`；[规则与命令](../guides/correlation.md) | 核心语义键、固定半开窗口、微秒与数字记录号并列顺序、重复去重和冲突检测；保留未观测范围、缺档和基线差异，不推断传播或因果 |
| 固定真实复盘 | [RIS rrc23 案例](../../cases/rrc23-path-change/README.md)、`reproduce_case.mjs`、`verify_case.py`、`tests/case.test.mjs`；[完整复算收据](real-case-verification.json) | 完整输入读取至 EOF，固定窗口 46 条宣告、35 次路径变化、93 条提醒；三个原始位置锚点及最终状态全部复核；四条不改写原始记录另经 mrtparse 核查 |
| 离线 HTML 报告 | `cli/report.mjs`、`tests/report.test.mjs`；[使用与完整性契约](../guides/html-report.md)；[固定报告](../../cases/rrc23-path-change/report/index.html) | 统计与 CLI 一致，支持采集器、前缀、peer、变化类型组合筛选，显示基线/缺档/部分结果；JSON 安全嵌入、文本显示、分文件按需加载，无外部资源 |

## 最终回归

- `moon info`、`moon fmt` 和 `moon fmt --check`；公开 `.mbti` 无意外差异。
- `npm test`：57 个 MoonBit 测试和 90 个 Node 测试通过；包含来源隔离、联合/独立结果等价、关联边界、UTF-8 分块、非法输入、实际报告脚本筛选分页和真实案例。
- `moon test --target wasm --deny-warn`、`moon test --target wasm-gc --deny-warn`：分别 57 个测试通过。
- `python -m unittest discover -s scripts -p test_compare.py`：3 个独立对照工具测试通过；其中故意破坏标志的输入会产生预期差异文件，测试确认不静默丢弃。
- `python scripts/verify_case.py`：mrtparse 2.2.0 独立检查四条真实记录全部一致。
- `node scripts/reproduce_case.mjs --output 新目录`：完整重建真实窗口、来源锚点、摘录、最终状态及离线报告。
- `node scripts/publish_fullstate.mjs`：实际文件重新核验六份约 4.74 GB 的变化输出及六份最终状态指纹；核验两版固定提交的重建产物与所有输入哈希。

浏览器工具禁止打开 `file://`，本轮未做浏览器视觉验收。报告的实际 `app.js` 和数据文件已在隔离 DOM 中执行验证；这是页面逻辑证据，不替代真实浏览器的视觉检查。报告全部脚本使用同目录相对路径，无 fetch、CDN 或服务端依赖。

原有两个采集器 18 个完整档案、19,663,881 条路由事件的协议独立对照证据仍保存在[验证首页](README.md)；本轮分析优化不把历史对照重新计为新测量，也不把限定状态的真实案例当作全表内存结果。
