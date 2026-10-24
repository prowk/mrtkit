# 验证记录

[文档首页](../README.md) · [入门教程](../tutorials/getting-started.md) · [命令行](../reference/cli.md)

验证日期：2026-10-24。工具链：moon 0.1.20260920、moonc v0.10.14+7d59c7ec9，Node.js 22.14.0，Python 3.13.2。CI 使用官方安装器的发布标签 `0.10.14+7d59c7ec9` 固定编译器和核心库。本次交付与待办状态见 [v0.2.0 验收](v0.2.0-acceptance.md)；较早测量继续绑定各自的固定源码。

## 自动测试

- 58 个 MoonBit 测试分别在 JS、Wasm、Wasm GC 后端通过。
- 111 个 Node 测试通过，包含协议与 CLI、gzip/bz2、ADD-PATH、微秒、属性与来源、多观测点隔离、共享校验、完整磁盘回放、外部关联、紧凑编码及索引报告。
- 独立对照工具的三个 Python 测试和 SQLite 状态模型的一个端到端测试通过；后者在完整和带预热的微秒窗口分别核对 1,200 个事件。
- 确定性畸形输入测试覆盖 2,000 组随机修改/随机字节数据，所有调用均返回解析结果或错误，没有宿主异常。
- 编译与测试启用 `--deny-warn`，当前没有编译警告。

## 真实数据对照

增量分析另外以不依赖 MoonBit 实现的 JavaScript 业务模型验证。手工状态序列覆盖宣告、重复宣告、撤回、重复撤回、重新宣告、路径/属性变化、会话重置、过期事件和窗口边界；1,200 个确定性生成事件分别在无 RIB 和有显式 ADD-PATH RIB 的模式运行，逐步比较每次输入后的全部路由状态，最终比较变化序列和统计。执行 `node --test tests/model.test.mjs`。

从 [RIPE RIS 公开数据](https://ris.ripe.net/docs/mrt/)的 rrc00 采集器 2025-01-01 文件中各提取前 1,000 条完整 MRT 记录。样本不是完整的全球路由表。

| 样本 | MRT 记录 | 路由事件 | 独立解析器对照 |
| --- | ---: | ---: | --- |
| updates.20250101.0000.gz 前缀 | 1,000 | 1,457 | 全部一致 |
| bview.20250101.0000.gz 前缀 | 1,000 | 44,888 | 全部一致 |

参考实现为 [mrtparse 2.2.0](https://github.com/t2mune/mrtparse)。逐项比较时间戳、事件类型、前缀、peer ASN/IP、收发方向、RIB 起源时间、原始 AS_PATH/AS4_PATH 分段、下一跳、ORIGIN、MED、LOCAL_PREF 和 COMMUNITY。保留事件重复次数，比较按多重集合进行，不要求同一 UPDATE 内输出顺序相同。

IP 按地址字节比较，IPv4 映射 IPv6 地址的点分与十六进制显示视为同一个地址。mrtparse 输出原始路径；mrtkit 的有效路径还会按照 RFC 6793 还原 AS4，因此对照使用 `wire_path` 和 `as4_path`。还原逻辑另有专门的单元测试与 CLI 测试。

小样本来源 URL、字节数和 SHA-256 见 [sample-manifest.json](sample-manifest.json)，原始对照结果见 [comparison.json](comparison.json)。新逐记录方法与历史提交 `0267b4d` 的全量多重集合算法在这两个固定小样本上给出相同结果；`scripts/test_compare.py` 还验证记录内调序不影响结果，删除一个重复事件会被发现。历史算法仅用于受大小限制的小样本回归。

## 完整档案对照

2025-01-01 00:00 UTC 的两个完整 RIB，加同日连续一小时 UPDATE，合计 18 个完整压缩文件、125,798,972 字节。逐记录对照结果为 **2,975,297 条 MRT 记录、19,663,881 条路由事件、749 条会话事件全部一致**。

| 采集器 | 输入 | 时间范围（UTC） | 路由事件 |
| --- | --- | --- | ---: |
| RIS rrc23 | 一个完整 `bview` | 00:00:00 | 11,088,254 |
| RIS rrc23 | 连续 12 个五分钟 UPDATE | 00:00:00–00:59:59 | 857,843 |
| RouteViews sfmix | 一个完整 RIB | 00:00:00–00:00:04 | 7,398,849 |
| RouteViews sfmix | 连续 4 个十五分钟 UPDATE | 00:00:00–01:00:00 | 318,935 |

来源为 [RIS rrc23 月度目录](https://data.ris.ripe.net/rrc23/2025.01/)与 [RouteViews sfmix 月度目录](https://archive.routeviews.org/route-views.sfmix/bgpdata/2025.01/)。每个文件的完整 URL、压缩大小、SHA-256 见 [archive-manifest.json](archive-manifest.json)；记录/事件数量、实测起止时间、工具版本及执行命令见 [archive-comparison.json](archive-comparison.json)。压缩文件均下载至 EOF 后验证 Content-Length，并通过压缩流解码到 EOF；没有截取记录前缀。

`scripts/compare.py` 同时逐条迭代 mrtparse 和 MoonBit 记录输出，只保留当前记录事件的多重集合与 peer 索引，不捕获整个 CLI 输出、不跨记录累计全部事件。额外比较微秒、Path Identifier、Large Communities（含原始顺序）、聚合属性、全部属性 flags/code/value、会话新旧状态和不支持类型/地址族统计。比较输入及解压均为流式，错误输出使用临时文件。`--keep-going` 会逐条保存差异记录的原始 MRT（RIB 附原 peer 表）和原因到 `.validation/mismatches/`，继续验证后仍非零退出；摘要最多保留十条，全部复现逐条落盘。参考解析器失败会把该文件明确标为未完整比较。内存随单条记录和 peer 表大小增长，不随档案总事件数增长；MoonBit 单记录上限为 16 MiB。

这批真实输入未遇到不支持记录或地址族，也不能代表所有采集器及扩展。ADD-PATH 和畸形属性的覆盖仍主要来自独立构造的协议测试。有效 AS4 路径还原由独立规则单元测试和 CLI 回归验证，真实数据对照比较独立解析器提供的原始 AS_PATH/AS4_PATH；本轮还逐项比较 ATOMIC_AGGREGATE 存在信息、wire/AS4/有效 AGGREGATOR，以及全部属性的标志、类型和值字节；完整 BGP 能力协商不在范围内。不据此声称全量 RFC 兼容或生产级性能。

## 复现

在项目根目录执行：

```powershell
moon build --target js --release --deny-warn
$env:PYTHONUTF8 = '1'
python -m pip install --target .validation/deps -r requirements-validation.txt
python scripts/fetch_samples.py
python scripts/compare.py
python scripts/test_compare.py

# 完整档案：2 个 RIB、16 个连续更新文件，按采集器分别验证。
python scripts/fetch_archives.py
$archives = Get-ChildItem .validation/archives -File | Where-Object { $_.Extension -in '.gz', '.bz2' } | Sort-Object Name | ForEach-Object { $_.FullName }
python scripts/compare.py --keep-going --report .validation/complete-comparison.json @archives
python scripts/publish_validation.py
```

样本与验证依赖只保存在被 Git 忽略的 `.validation/`，不会被提交。该流程需要网络，常规测试和演示不需要网络。

性能测量方法、固定场景及优化前后比较见[历史性能基准](performance.md)。早期 P0/P1 证据见[历史验收](acceptance.md)，此前公开版本见[v0.1.0 验收](release-acceptance.md)；当前交付见[v0.2.0 验收](v0.2.0-acceptance.md)与[标准清单](../reference/compatibility.md)。

早期 main 扩展见[历史深化验收](extended-acceptance.md)。整表驻留失败与共享优化见[历史全量状态基准](full-state-benchmark.md)，新分区方案使用预先固定的[完整回放目标](state-resource-target.md)。[独立全状态数据核对](full-state-independent.json)不等同于三轮资源验收。固定数据与原始位置锚点见[真实复盘案例](../../cases/rrc23-path-change/README.md)。

## 完整输入的窗口与导出验收

`python scripts/replay_acceptance.py` 校验 RIS rrc23 一个完整 RIB 与十二个连续 UPDATE 的来源和 SHA-256。全部记录解码至 EOF，分析状态筛选 `183.90.160.0/24`、peer AS58952；窗口为 2025-01-01 00:20:00–00:40:00 UTC。独立 mrtparse 事件和 Python 业务模型逐项复算窗口前后状态、路径/起源/属性变化、波动、记录/预热统计和每条变化的记录号及解压后偏移，正式 CLI 与桥接结果相同，JSON/CSV 导出一致。

本次 93 条变化提醒、46 行窗口内路由导出全部一致；输入、前后状态、统计和检查项见[回放原始报告](replay-acceptance.json)。基线与预热不计窗口统计。这是完整输入、限定状态的功能验收，不是全表状态内存基准。IPv6、ADD-PATH、会话重置、乱序、缺基线和缺档由窗口、独立状态模型、ADD-PATH 与时间线端到端矩阵补充；连续性未验证时不计算确定的不可见时长。
