# MRTKit

[![CI](https://github.com/prowk/mrtkit/actions/workflows/ci.yml/badge.svg)](https://github.com/prowk/mrtkit/actions/workflows/ci.yml)
[![Mooncakes](https://img.shields.io/badge/Mooncakes-v0.2.1-blue)](https://mooncakes.io/docs/prowk/mrtkit)
[![License](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE)

用 MoonBit 解析 BGP MRT 档案，查询路由并分析变化。提供无第三方依赖的协议核心库和流式 CLI，适用于离线路由研究、故障复盘与教学。

## 快速开始

需要 [MoonBit](https://www.moonbitlang.com/download/)（**moonc ≥0.10.16**）和 Node.js 22+；读取 bz2 另需 Python 3。当前固定工具链为 `moonbit-toolchain.version` 中的 `0.10.18+6c83a7f62`，构建和测试前会检查真实编译器版本。无需安装 npm 依赖。

```sh
git clone https://github.com/prowk/mrtkit.git
cd mrtkit
npm run build
node cli/mrtkit.mjs parse fixtures/demo.mrt
node cli/mrtkit.mjs stats --threshold 3 fixtures/demo.mrt
node cli/mrtkit.mjs timeline --prefix 203.0.113.0/24 fixtures/demo.mrt
```

MoonBit 项目可用 `moon add prowk/mrtkit@0.2.1` 引入核心库。完整安装、样本解读、筛选、导出和真实档案回放见[入门教程](docs/tutorials/getting-started.md)。CLI 和离线报告从源码运行。

## 功能

- TABLE_DUMP_V2、BGP4MP/BGP4MP_ET 的 IPv4/IPv6 单播，含四字节 ASN、ADD-PATH 和会话状态。
- 常用路径、聚合与社区属性；保留原始编码并解释 AS4 有效值，检查长度、标志和宣告必需属性。
- 前缀、ASN、时间筛选，JSON Lines / CSV 导出，带文件、记录号和解压后偏移。
- 初始 RIB 与连续更新回放、结构化变化、快照差异、前缀时间线和变化聚合。
- 显式采集器/视图隔离回放，按 peer 磁盘分区保存完整逻辑状态。
- 有界内存的跨观测点语义关联、分离式摘要/观测导出，以及可选紧凑变化流。
- 离线 HTML 展示可读属性差异、关联组与来源跳转，提供倒排筛选、分页、取消和重置。

从[多采集器示例](docs/guides/multi-collector.md)开始，或查看[固定真实案例](cases/rrc23-path-change/README.md)。

这是离线分析工具。旧 TABLE_DUMP、RIB_GENERIC、多播、VPN/EVPN 和在线 BGP 会话不在范围内；时间线描述采集器观测，不推断业务中断。规则、资源限制和边界见[兼容清单](docs/reference/compatibility.md)。

## 文档与验证

[文档首页](docs/README.md) · [命令行](docs/reference/cli.md) · [库 API](docs/reference/api.md) · [输出契约](docs/reference/output.md) · [开发指南](docs/development/contributing.md)

两个采集器的 18 个完整档案、约 1,966 万条路由事件已通过独立解析器对照。字段、来源、哈希与复现方法见[验证记录](docs/validation/README.md)。

完整 RIB 加连续十二个 UPDATE 的无筛选状态回放已通过三轮固定预算验收，最高合计 RSS 保守上界约 1.79 GiB；11,093,122 条结束状态与 1,197,552 条提醒通过独立核对，见[完整回放结果](docs/validation/full-replay.md)。紧凑编码的体积、耗时和内存取舍见[实测说明](docs/reference/compact-changes.md)。早期整表内存驻留失败与共享优化保留在[历史基准](docs/validation/full-state-benchmark.md)。

浏览器工具禁止本地文件自动化，真实浏览器的离线布局与性能验收按用户要求保留待办；页面逻辑和分块加载已通过自动测试。

上面的长时资源测量属于 v0.2.0 原工具链；v0.2.1 的编译器升级、输出兼容和回归结果见[工具链整改复验](docs/validation/v0.2.1-acceptance.md)。

```sh
npm test
moon test --target wasm --deny-warn
moon test --target wasm-gc --deny-warn
moon info
moon fmt --check
```

发布记录见 [CHANGELOG](CHANGELOG.md)。许可证为 [Apache-2.0](LICENSE)。
