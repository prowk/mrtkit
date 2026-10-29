# 从样本到真实路由回放

[文档首页](../README.md) · [入门教程](getting-started.md) · [命令行](../reference/cli.md)

MRT 是采集器保存的 BGP 二进制记录；RIB 是某时刻的路由快照，UPDATE 是后续观测到的宣告或撤回。本教程先使用离线样本，再处理固定来源的真实档案。结果只代表该采集器的观测。

## 1. 安装与构建

安装 [MoonBit 工具链](https://www.moonbitlang.com/download/)和 [Node.js 22 或更新版本](https://nodejs.org/)。需要 **moonc 0.10.16 或更新版本**；当前 `moonbit-toolchain.version` 固定 `0.10.18+6c83a7f62`，对应 Moon `0.1.20261028`，CI 和代理准备工作流都从该文件读取相同发布标签。已有工具链可运行 `moon upgrade` 更新，并用 `moonc -v` 确认实际版本。需要 bz2 时安装 Python 3，确认 `python --version` 可运行；也可设置 `MRTKIT_PYTHON` 指向解释器。

```sh
git clone https://github.com/prowk/mrtkit.git
cd mrtkit
moon version
node --version
npm run build
node cli/mrtkit.mjs --version
```

预期项目 CLI 版本为 `0.2.1`，它与 `moonc -v` 显示的编译器版本分别标注。没有 npm 依赖，无需 `npm install`；构建产物写入 `_build/`。`npm run build` 和 `npm test` 都先检查编译器最低版本。更新源码后重新构建。常规样本演示与测试无需联网。

## 2. 读取第一个文件

```sh
node cli/mrtkit.mjs parse fixtures/demo.mrt
node cli/mrtkit.mjs stats --threshold 3 fixtures/demo.mrt
```

`parse` 每行输出一个路由 JSON 对象。样本共有 8 条 MRT 记录、6 条路由事件：1 条 RIB、3 条宣告和 2 条撤回，涵盖 `203.0.113.0/24` 与 `2001:db8::/32`，另一个未知 MRT 类型会被跳过并计数。`stats` 输出一个统计对象，64 位计数使用十进制字符串，例如 `announcements: "3"`。

`attributes.path` 是有效路径；`wire_path/as4_path` 保留兼容编码，`raw_attributes` 保留全部属性的标志与值字节。`source` 指明文件、记录号和解压后记录起点。详见[输出契约](../reference/output.md)。

运行 `node scripts/fixtures.mjs` 可重新生成样本；`npm run demo` 会自动构建、生成并统计。

## 3. 筛选和导出

```sh
node cli/mrtkit.mjs parse --prefix 203.0.113.5/24 fixtures/demo.mrt
node cli/mrtkit.mjs parse --asn 65537 fixtures/demo.mrt
node cli/mrtkit.mjs parse --prefix 203.0.113.0/24 --format csv fixtures/demo.mrt > routes.csv
node cli/mrtkit.mjs parse fixtures/demo.mrt > routes.jsonl
```

前缀会清除主机位，第一条匹配 `203.0.113.0/24`。默认 `exact` 为精确匹配；`--prefix-mode more-specific` 只匹配更长子网；`covering` 查找覆盖指定地址或整个 CIDR 的路由。

`--asn` 在 `parse` 中匹配 peer 或有效路径，撤回没有路径，因此只能按 peer 匹配。分析命令使用 `--peer-asn`，保证宣告与撤回的筛选范围相同。ADD-PATH 可用 `--path-id 0` 筛选，无标识与 ID 0 不同。

标准输出只含结果，诊断写入标准错误。检查退出码：PowerShell 用 `$LASTEXITCODE`，POSIX shell 用 `$?`。只有退出码为 0 才将文件当作完整结果，失败前已写出的行可能只是部分数据。CSV 按列名读取。

## 4. 变化、时间线与快照

```sh
node cli/mrtkit.mjs changes --threshold 3 fixtures/demo.mrt
node cli/mrtkit.mjs aggregate --threshold 3 --top 10 fixtures/demo.mrt
node cli/mrtkit.mjs timeline --prefix 203.0.113.0/24 fixtures/demo.mrt
node cli/mrtkit.mjs snapshot-diff --collector demo initial.mrt later.mrt
```

前三条可直接运行；最后一条需准备同采集器、同视图的两个快照。`changes` 输出路径、起源、属性和波动提醒；`aggregate` 对相同来源事件去重排名；`timeline` 还记录宣告、撤回、恢复及未知区间。快照缺失不等于实际收到撤回。

没有确认输入连续时，保留默认 `continuity_unverified`。已知缺档可添加 `--observation-gap 开始秒:结束秒`，跨缺档区间不计算确定时长。确认档案连续完整后才使用 `--continuous-observation`；路由观测不可见不能解释为业务中断。

## 5. 初始 RIB、预热与窗口

```sh
node cli/mrtkit.mjs stats --initial-rib initial.mrt.gz --from 1735690800 --to 1735692000 updates-0000.mrt.gz updates-0005.mrt.gz updates-0010.mrt.gz
```

这是文件命名示意：从同一采集器获得不晚于窗口开始的完整 RIB，按时间顺序传入后续连续 UPDATE。窗口前更新用于预热；基线与预热不计窗口统计，不输出窗口内变化。时间为 Unix 秒，包含端点，可指定 `--from-micros/--to-micros`。窗口后输入仍检查格式，但不改变结束状态。

`baseline_status` 的 `explicit_rib` 表示显式 RIB，`updates_only` 表示局部前史，`missing` 表示没有窗口前状态。不同采集器分别运行。详见[回放指南](../guides/replay.md)。

## 6. 固定真实数据案例

联网下载约 126 MB 的公开档案，来源与 SHA-256 固定在[来源清单](../validation/archive-manifest.json)。验证依赖不是 CLI 运行依赖。

```sh
python -m pip install --target .validation/deps -r requirements-validation.txt
python scripts/fetch_archives.py
python scripts/replay_acceptance.py
```

验收完整读取 RIS rrc23 的一个 RIB 和十二个连续 UPDATE，窗口为 2025-01-01 00:20:00–00:40:00 UTC，筛选真实前缀 `183.90.160.0/24`、peer AS58952。脚本校验所有输入哈希，以独立解析器复算窗口前后状态、变化来源与计数，再比较正式 CLI 的 JSON/CSV 导出。输入与中间结果保存在被忽略的 `.validation/`；公开结果见[回放验收](../validation/replay-acceptance.json)。此例筛选了分析状态，不代表全表驻留内存的基准。

## 7. 使用 MoonBit 核心库

在自己的 MoonBit 项目目录执行 `moon add prowk/mrtkit@0.2.1`，在使用它的包的 `moon.pkg` 中加入：

```moonbit
import {
  "prowk/mrtkit" @mrt,
}
```

新建 `prefix_test.mbt`：

```moonbit
///|
test "规范化前缀" {
  let prefix = @mrt.parse_prefix_text("203.0.113.5/24")
  assert_eq(prefix.text(), "203.0.113.0/24")
}
```

运行 `moon test`。实际记录可用 `Decoder::decode_at` 保留来源，或用 `StreamDecoder::feed/finish` 处理分块。核心无 JS FFI，可在 JS、Wasm、Wasm GC 运行；Node CLI 负责系统文件与解压。更多入口见[库 API](../reference/api.md)。

## 8. 排错与继续学习

“请先构建”：运行 `npm run build`；bz2 解压器不可用：安装 Python 或设置 `MRTKIT_PYTHON`；容量超限：缩小前缀/peer 范围，或在内存允许时调整 `--capacity`。单记录限制 16 MiB，缓存包含已撤回路由；时间线还限制条目数量。

文件偏移指解压后记录起点，局部偏移指解析组件内部位置，二者不能直接相加。输入损坏、容量及输出失败均非零退出。完整边界见[错误契约](../reference/errors.md)，全部选项见[命令行参考](../reference/cli.md)，测试及真实数据证据见[验证记录](../validation/README.md)。
