# 全量状态与输出成本基准

[验证首页](README.md) · [机器可读汇总](fullstate/comparison.json) · [库 API](../reference/api.md)

本次建立了无前缀、无 peer 筛选的完整 RIB 加连续 UPDATE 基准。**两版均在 1400 MiB RSS 预算下停止于 RIB 阶段，未完成全部路由状态驻留**。不能将下面的检查点内存或 UPDATE 单独回放解释为全表 RIB 成功回放。

## 输入、版本与测量方法

- 输入为 RIS rrc23 的 2025-01-01 00:00 完整 RIB，以及连续十二个五分钟 UPDATE，窗口为 00:00:00–00:59:59 UTC。来源 URL、压缩字节数、SHA-256 保存在每份原始报告的 `inputs` 和[档案清单](archive-manifest.json)中。运行前逐文件重新验证哈希。
- RIB 含 1,228,318 条记录、11,088,254 条路由事件；UPDATE 含 369,608 条记录、857,843 条路由事件和 749 条会话事件。以所有路由事件均可能新增状态计算保守容量上界 11,946,097，实际配置 12,000,000；这不是预言实际唯一键数量。
- Windows 11 10.0.26200，AMD Ryzen 9 7940HX，物理内存 16,340,418,560 字节。Node 22.14.0、moonc v0.10.14+7d59c7ec9、Python 3.13.2。运行开始时可用内存及工具链完整输出随报告保存。
- 每种配置使用三个新进程串行运行，统计取中位数。1400 MiB 是本交互工作区的显式预算，并非机器全部内存或程序固有上限；每 256 条记录检查一次，因此可能略超预算后才退出。峰值取进程 `maxRSS`，包括宿主、解压、解析器、状态和导出临时对象。
- 优化前协议构建固定为 `2ea9935`，优化后固定为 `f63abe6`。两份从 Git 提交独立重建的桥接产物与被测文件 SHA-256 完全相同。原始报告的 `source_revision` 是基准驱动所在工作区 HEAD，**被测代码以 `bridge_source_revision` 和 `bridge_sha256` 为准**，不能声称测量了后续提交。
- 旧版 `state()` 整批 JSON 导出曾触发原生堆耗尽，保留[失败报告](fullstate/legacy-export-failure.json)。为进行最终状态等价比较，只向原始编译结果末尾追加只读分块导出探针，原始代码逐字节未改；探针仍构造旧版排序数组，但逐事件序列化。优化版使用原生惰性状态迭代器，不构造全量排序数组。具体原始、探针、优化构建哈希和契约见汇总。

## 完整 RIB 驻留尝试

主场景使用 `consume_at` 保留来源。两版均未读完 RIB，因此没有进入后续 UPDATE 和完整状态导出阶段；完整回放吞吐、完整结果序列化及写出成本均为未知，在汇总中记为 `null`，不能将部分运行的零输出成本当作测量结果。

| 指标，三轮中位数 | 优化前 | 优化后 |
| --- | ---: | ---: |
| 相同检查点 MRT 记录 / 路由事件 | 25,000 / 228,292 | 25,000 / 228,292 |
| 此检查点峰值 RSS | 833.3 MiB | 326.4 MiB |
| 此检查点累计耗时 | 1.65 秒 | 1.44 秒 |
| 预算停止前驻留活动状态 | 401,180 | 1,324,473 |
| 预算停止前撤回缓存 | 0 | 0 |

同一检查点 RSS 约降低 60.8%。预算停止时驻留进度约为原来的 3.30 倍；由于处理进度不同，不能把停止时峰值作为相同工作量的优化比较。每轮记录、偏移、峰值、计数及失败原因见 [trace-before](fullstate/trace-before.json) / [trace-after](fullstate/trace-after.json)。无来源的辅助实验见 [repro-before](fullstate/repro-before.json) / [repro-after](fullstate/repro-after.json)，不与主场景混用。

## 全部 UPDATE 的等价性与输出成本

此场景不含初始 RIB，基线为 `updates_only`；十二个完整档案均读至 EOF，没有缩减前缀、peer 或事件。它提供可完成的变化、来源及状态等价证据，不能替代上述全量 RIB 驻留尝试。

| 指标，三轮中位数 | 优化前 | 优化后 |
| --- | ---: | ---: |
| 总耗时，含导出 | 331.23 秒 | 271.10 秒 |
| 路由事件 / 秒，含导出 | 2,590 | 3,164 |
| 峰值 RSS | 556.7 MiB | 493.6 MiB |
| 最终状态分块序列化 | 2.42 秒 | 2.13 秒 |
| 文件写出 | 8.10 秒 | 7.31 秒 |
| 最终活动 / 缓存 / 撤回状态 | 41,647 / 46,520 / 4,873 | 41,647 / 46,520 / 4,873 |

共 1,141,740 条提醒，逐轮输出 4,735,570,592 字节；六份实际文件重新流式核验 SHA-256 均为 `f93aa8792be1e3573f5fd79bb248789c5f4a7794a206a95f7212ed758fd61477`。最终状态每份 60,429,325 字节、46,520 行，逐行规范化后的 SHA-256 求和及异或指纹、统计和来源也完全相同。全部指纹与文件核验收据见[汇总](fullstate/comparison.json)，每轮实测见 [stream-before](fullstate/stream-before.json) / [stream-after](fullstate/stream-after.json)。大输出只留在被忽略的本地验证目录。

逐条变化序列化包含在桥接 `consume_at` 耗时中，没有虚构独立的纯分析时间。表中的单独序列化只计最终状态分块及宿主规范化/指纹；文件写出包含缓冲写及状态文件 I/O。总耗时还包括解压、MRT 分帧、解析、变化生成、逐条 JSON、哈希与最终导出。新接口与属性共享均影响结果，不能把全部吞吐改善归因于某一个缓存。

另以不驻留状态、不导出路由的纯解析模式补测相同完整输入，三轮结果如下；它包含解压、分帧和解码，与含分析导出的吞吐量不可直接相减来推算分析耗时。

| 纯解析路由事件 / 秒 | 优化前 | 优化后 |
| --- | ---: | ---: |
| 完整 RIB | 575,470 | 580,508 |
| 十二个完整 UPDATE | 395,047 | 386,445 |

原始重复测量见 [parse-before](fullstate/parse-before.json) / [parse-after](fullstate/parse-after.json)。UPDATE 纯解析略慢、状态回放含导出更快，属于本机固定场景观察，不作普遍性能保证。

## 实现取舍与复现

`SharedAttributes` 将完整原始属性、规范化属性和路径共同共享；哈希匹配后仍进行完整相等检查。引用归零即回收，替换及会话重置释放旧引用；撤回状态保留必要属性、来源、乱序水位和波动历史，不做隐式过期。保留原始编码意味着语义相同但原始排列不同的属性不强行合并，避免来源证据丢失。UPDATE 结束时 46,520 个路由键共享 14,892 个属性集。没有引入单独撤回压缩或按时间淘汰，避免改变重新宣告和迟到事件语义。

复现需要先运行 `python scripts/fetch_archives.py`，按固定提交分别构建并保存桥接文件。追加旧版探针后，以相同输入执行：

```sh
node scripts/instrument_baseline.mjs .validation/fullstate/before-bridge.mjs .validation/fullstate/before-probe.mjs
node scripts/fullstate_benchmark.mjs --bridge .validation/fullstate/before-probe.mjs --bridge-revision 2ea9935 --trace-source --rss-mib 1400 --report .validation/fullstate/trace-before/report.json
node scripts/fullstate_benchmark.mjs --bridge .validation/fullstate/current-bridge.mjs --bridge-revision f63abe6 --trace-source --rss-mib 1400 --report .validation/fullstate/trace-after/report.json
```

UPDATE 场景用 `--updates-only` 替换 `--trace-source` 并更换报告目录；纯解析使用 `scripts/benchmark.mjs --cases complete_rib_parse,one_hour_updates_parse`。辅助无来源场景省略这两个开关。报告驱动保留失败结果；需检查各轮 `complete/exit_code`，驱动进程结束不代表回放成功。

`scripts/publish_fullstate.mjs` 核查固定构建、输入、每份实际输出与最终状态指纹后才发布汇总。它需要原始测量目录、两份提交重建目录及原始失败记录；公开元数据只将工作区绝对路径前缀改为 `<workspace>`，测量值不改写。重跑使用新目录，避免覆盖待核验的历史输出。
