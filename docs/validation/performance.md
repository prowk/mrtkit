# 解析与分析基准

[文档首页](../README.md) · [入门教程](../tutorials/getting-started.md) · [命令行](../reference/cli.md)

测量日期：2026-10-15。Windows 10.0.26200 x64，AMD Ryzen 9 7940HX，32 个逻辑处理器，16,340,418,560 字节物理内存；Node.js 22.14.0、Moon 0.1.20260920 / moonc 0.10.14+7d59c7ec9、Python 3.13.2。

优化前固定提交为 `94bd9d0`，优化后为 `69e532a`。优化前构建从该提交独立重建，与实际测量文件的 SHA-256 完全相同。每个版本、每个场景均串行启动三个独立 Node 进程，以下为中位数。输入哈希在运行前校验；两版本每次运行的记录数、事件数、解压字节数、分析统计、活动/缓存路由数及失败结果均逐项一致。

原始三次测量、构建哈希、输入 SHA-256、环境与实际参数见 [优化前](benchmark-before.json)、[优化后](benchmark-after.json)；中位数与比率见[比较结果](benchmark-comparison.json)。首轮与独立解析器同时运行的数据已弃用，公开的优化前结果为对照结束后的重测。

## 方法与范围

`scripts/bench_worker.mjs` 调用与 CLI 共用的 MoonBit 解析、筛选和分析路径，只省略路由/变化结果的逐条序列化和终端写出。计时包含文件读取、解压、MRT 分帧、解析、查询和状态分析；不包含模块导入、配置、文件哈希与最终摘要序列化。峰值内存为操作系统提供的 `process.resourceUsage().maxRSS`，包含进程和模块开销。因此这些值不能当作完整 JSON/CSV 导出的端到端吞吐量。

解析吞吐以**解码出的全部路由输入事件**计数；筛选分析另外记录 `selected_analysis_events` 和每秒值。后者为筛选且在窗口内的 RIB/宣告/撤回输入数，包含仅计统计而不回退状态的乱序事件。`active_routes/cached_routes` 是结束时的活动和缓存路由数；`parse` 不建立路由缓存，两者为零。

完整 RIB 使用 RIS rrc23 的 2025-01-01 00:00 UTC 全文件，1,228,318 条记录、11,088,254 条路由事件。筛选分析仍完整解码该文件，仅分析 peer AS8075 在 `192.0.0.0/8` 内的更具体路由，最终为 29 条；此场景衡量筛选开销，不能代表全球全表同时驻留内存的分析吞吐。

长回放使用连续十二个五分钟 UPDATE 文件，覆盖一小时、369,608 条 MRT 记录、857,843 条路由事件；分析场景不做前缀或 peer 筛选，不加载 RIB，`baseline_status` 因而为 `missing`。输入来源、时间范围与下载步骤见[验证记录](README.md)。

## 结果

| 场景 | 优化前秒 | 优化后秒 | 优化后路由输入事件/秒 | 峰值 MiB（前→后） | 结束活动/缓存路由 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 完整 RIB 解析 | 19.526 | 19.086 | 580,958 | 102.1 → 107.1 | 0 / 0 |
| 完整 RIB 筛选分析 | 27.955 | 19.367 | 572,533（仅 29 条进入分析） | 102.2 → 99.4 | 29 / 29 |
| 一小时 UPDATE 解析 | 2.033 | 2.052 | 418,136 | 66.9 → 64.7 | 0 / 0 |
| 一小时 UPDATE 分析 | 7.021 | 4.605 | 186,293 | 267.8 → 322.9 | 41,647 / 46,520 |
| RIB 容量超限，capacity=1000 | 0.0252 | 0.0289 | 34,613（失败前完整记录） | 48.3 → 46.1 | 1,000 / 1,000 |
| 十万次重复宣告与社区比较 | 2.072 | 1.676 | 59,667 | 81.8 → 63.5 | 1 / 1 |
| 400 个 peer、八万条路由及重置 | 1.199 | 0.606 | 131,979 | 173.2 → 199.8 | 0 / 0 |
| 4 MiB 记录，256 字节碎片输入 | 40.251 | 0.05495 | 不适用；单条未知记录 | 82.7 → 54.3 | 0 / 0 |

容量超限是预期失败：基准子进程用退出码 2 区分此场景，正常 CLI 错误退出码仍为 1。`records/route_events` 只累计完整成功处理的记录，摘要可包含失败记录中已处理的路由，二者不能混作相同计数。失败前的活动和缓存状态仍被保留到测量结果中。

一小时分析用时降低约 34.4%，等价吞吐约为原来的 1.52 倍，但峰值内存增加约 20.6%。会话重置场景约快 1.98 倍，峰值内存增加约 15.4%。重复社区场景约快 1.24 倍。解析速度接近原来；不能把正常波动描述为解析器整体大幅加速。容量失败的短运行包含较大固定开销，不用于推断稳定吞吐。

碎片场景专门放大旧实现反复复制已有字节的成本，新实现改为验证长度后分配记录缓冲，仅追加新字节。该场景约 733 倍的结果只适用于这种大记录、极小碎片的输入，不能推广为普通 MRT 文件解析提升。

## 状态存储取舍

- **撤回保留**：一小时场景中 4,873 个缓存键已撤回，约占缓存键的 10.5%。继续保留其属性、时间水位和波动窗口，以保证乱序检测、重新宣告及窗口计数；没有引入依赖未声明乱序上限的回收策略。`--capacity` 包含这些键，超限明确失败。
- **会话重置**：增加 peer 到路由键的索引，只遍历受重置 peer 的缓存键，避免对其他 peer 全表扫描；索引带来额外内存成本。
- **语义规范化**：缓存规范化后的路径与属性，重复宣告不再反复排序前一状态的社区和 AS_SET；仍使用完整相等比较，不靠可能碰撞的哈希判定变化。已排序去重的社区可共享数组。额外语义缓存是长回放内存增加的取舍。
- **流式字节组装**：标准库缓冲区在头部校验后按记录容量分配，避免二次复杂度拼接；保留 16 MiB 记录、1 MiB feed 分块限制和 EOF 截断错误。大记录还以 1、13、256、65,536 字节分块回归验证。

三后端测试及独立状态模型确保这些优化没有改变状态、来源、重置、乱序、重新宣告和波动窗口语义。另有交叉边界测试保证缓存已满时，重置前的过期宣告仍被忽略，不误触发容量失败。

## 复现

先按验证文档下载完整档案。在根目录构建当前版本，生成固定热点文件，再准备优化前的独立构建：

```powershell
npm run build
node scripts/bench_fixtures.mjs
git archive --format=zip --output=.validation/baseline-source.zip 94bd9d0
Expand-Archive -LiteralPath .validation/baseline-source.zip -DestinationPath .validation/baseline-source -Force
Push-Location .validation/baseline-source
try {
  moon build --target js --release --deny-warn
  Copy-Item _build/js/release/build/bridge/bridge.js ../baseline-bridge.js
} finally { Pop-Location }

node scripts/benchmark.mjs --bridge .validation/baseline-bridge.js --hotpaths .validation/bench --report .validation/benchmark-before.json --repeats 3
node scripts/benchmark.mjs --hotpaths .validation/bench --report .validation/benchmark-after.json --repeats 3
node scripts/publish_benchmark.mjs
```

所有二进制输入、独立构建和临时报告均在忽略的 `.validation/`。发布脚本先检查工作量、状态、原始中位数、三次测量、环境及构建哈希一致，才将 JSON 元数据写入 `docs/`。基准不是常规离线测试的一部分，不在每次 CI 中下载完整档案或运行耗时的优化前碎片场景。
