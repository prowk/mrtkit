# MRTKit

[![CI](https://github.com/prowk/mrtkit/actions/workflows/ci.yml/badge.svg)](https://github.com/prowk/mrtkit/actions/workflows/ci.yml)
[![Mooncakes](https://img.shields.io/badge/Mooncakes-v0.1.0-blue)](https://mooncakes.io/docs/prowk/mrtkit)
[![License](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE)

用 MoonBit 解析 BGP MRT 档案，查询路由并分析变化。提供无第三方依赖的协议核心库和流式 CLI，适用于离线路由研究、故障复盘与教学。

## 快速开始

需要 [MoonBit](https://www.moonbitlang.com/download/) 和 Node.js 22+；读取 bz2 另需 Python 3。无需安装 npm 依赖。

```sh
git clone https://github.com/prowk/mrtkit.git
cd mrtkit
npm run build
node cli/mrtkit.mjs parse fixtures/demo.mrt
node cli/mrtkit.mjs stats --threshold 3 fixtures/demo.mrt
node cli/mrtkit.mjs timeline --prefix 203.0.113.0/24 fixtures/demo.mrt
```

MoonBit 项目可用 `moon add prowk/mrtkit@0.1.0` 引入核心库。完整安装、样本解读、筛选、导出和真实档案回放见[入门教程](docs/tutorials/getting-started.md)。

GitHub `main` 另含尚未发布的多采集器、关联分析及 HTML 报告扩展；使用这些能力请从源码构建。Mooncakes 与 GitHub v0.1.0 发布包保持原有稳定范围。

## 功能

- TABLE_DUMP_V2、BGP4MP/BGP4MP_ET 的 IPv4/IPv6 单播，含四字节 ASN、ADD-PATH 和会话状态。
- 常用路径、聚合与社区属性；保留原始编码并解释 AS4 有效值，检查长度、标志和宣告必需属性。
- 前缀、ASN、时间筛选，JSON Lines / CSV 导出，带文件、记录号和解压后偏移。
- 初始 RIB 与连续更新回放、结构化变化、快照差异、前缀时间线和变化聚合。
- 显式采集器/视图隔离回放、跨观测点语义变化关联，以及可筛选、分页的离线 HTML 报告。

从[多采集器示例](docs/guides/multi-collector.md)开始，或查看[固定真实案例](cases/rrc23-path-change/README.md)。

这是离线分析工具。旧 TABLE_DUMP、RIB_GENERIC、多播、VPN/EVPN 和在线 BGP 会话不在范围内；时间线描述采集器观测，不推断业务中断。规则、资源限制和边界见[兼容清单](docs/reference/compatibility.md)。

## 文档与验证

[文档首页](docs/README.md) · [命令行](docs/reference/cli.md) · [库 API](docs/reference/api.md) · [输出契约](docs/reference/output.md) · [开发指南](docs/development/contributing.md)

两个采集器的 18 个完整档案、约 1,966 万条路由事件已通过独立解析器对照。字段、来源、哈希与复现方法见[验证记录](docs/validation/README.md)。

属性共享降低了固定检查点内存成本；全 RIB 驻留仍超出本轮 1400 MiB 预算。三轮重复测量、完整 UPDATE 的输出/状态等价及限制见[全量状态基准](docs/validation/full-state-benchmark.md)。

```sh
npm test
moon test --target wasm --deny-warn
moon test --target wasm-gc --deny-warn
moon info
moon fmt --check
```

发布记录见 [CHANGELOG](CHANGELOG.md)。许可证为 [Apache-2.0](LICENSE)。
