# 验证记录

验证日期：2026-10-15。工具链：moon 0.1.20260920、moonc v0.10.14+7d59c7ec9，Node.js 22.14.0，Python 3.13.2。CI 使用官方安装器的发布标签 `0.10.14+7d59c7ec9` 固定编译器和核心库。

## 自动测试

- 46 个 MoonBit 测试分别在 JS、Wasm、Wasm GC 后端通过。
- 47 个 Node 测试通过，包含命令行端到端验证、gzip/bz2、IPv6、旧式 ASN、扩展时间戳、ADD-PATH、Large Communities、时间窗口、来源追溯、快照差异、聚合复算、前缀时间线和错误退出码。
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

`scripts/compare.py` 同时逐条迭代 mrtparse 和 MoonBit 记录输出，只保留当前记录事件的多重集合与 peer 索引，不捕获整个 CLI 输出、不跨记录累计全部事件。额外比较微秒、Path Identifier、Large Communities（含原始顺序）、会话新旧状态和不支持类型/地址族统计。比较输入及解压均为流式，错误输出使用临时文件。内存随单条记录和 peer 表大小增长，不随档案总事件数增长；MoonBit 单记录上限为 16 MiB。

这批真实输入未遇到不支持记录或地址族，也不能代表所有采集器及扩展。ADD-PATH 和畸形属性的覆盖仍主要来自独立构造的协议测试。有效 AS4 路径还原由独立规则单元测试和 CLI 回归验证，真实数据对照比较独立解析器提供的原始 AS_PATH/AS4_PATH；未知属性原始字节和全部 BGP 能力协商未在此脚本逐项对照。不据此声称全量 RFC 兼容或生产级性能。

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
python scripts/compare.py --report .validation/complete-comparison.json @archives
python scripts/publish_validation.py
```

样本与验证依赖只保存在被 Git 忽略的 `.validation/`，不会被提交。该流程需要网络，常规测试和演示不需要网络。
