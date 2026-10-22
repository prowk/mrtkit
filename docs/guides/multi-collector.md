# 多采集器与视图回放

[文档首页](../README.md) · [入门教程](../tutorials/getting-started.md) · [命令行](../reference/cli.md)

开发分支的 `multi` 命令接受显式输入清单，按 `(collector, view)` 创建独立 MoonBit 会话。不同观测点即使具有相同的 peer、前缀和 Path Identifier，也不会共享路由状态、基线、会话水位或重置。它不把多个档案直接拼接为一个观测点。

## 可运行示例

```sh
npm run build
node scripts/multi_fixtures.mjs
node cli/mrtkit.mjs multi --manifest fixtures/multi/manifest.json --output .validation/multi-demo
```

输出目录必须不存在，避免覆盖已有分析。该例是两个独立命名的**人工**观测点，故意使用相同 peer、前缀及 RIB，但更新过程不同；它不是跨真实采集器的事件证据。生成器和清单中的 SHA-256 可重建数据。

## 输入清单

```json
{
  "schema_version": "1.0",
  "window": {"from": 1700000001, "to": 1700000006},
  "analysis": {"prefix": "203.0.113.0/24", "threshold": 3},
  "collectors": [{
    "collector": "synthetic-a", "view": "default", "continuous": false,
    "files": [
      {"path": "initial.mrt", "kind": "rib", "from": 1700000000, "to": 1700000000},
      {"path": "updates.mrt.gz", "kind": "update", "from": 1700000001, "to": 1700000006}
    ],
    "gaps": []
  }]
}
```

文件路径相对清单目录；文件可指定可选 `sha256`，实际哈希总会计算并记录。有哈希不匹配时该观测点失败。身份不从文件名猜测，`view` 是调用方明确声明的逻辑视图，不能冒充从档案获得的部署证明。同一身份须在一个条目内列出全部文件，重复身份拒绝，最多 128 个身份。

每个条目最多一个 RIB，位于文件列表首位，声明时间不晚于窗口；后续文件按声明开始时间非降序。每条实际记录都检查声明的时间范围，UPDATE 文件中不能夹入 RIB。记录内乱序由分析器按原有水位规则处理。输入处理前后检查文件大小及修改时间，发现变化即失败。

`analysis` 可设置共享的 `prefix`、`peer_asn`、`path_id`、`capacity`、`window_seconds` 和 `threshold`。有 `prefix` 时生成逐观测点时间线；未设置时生成全前缀变化流。基线与窗口前预热仍不计窗口统计。

`continuous` 默认 false。清单中声明的文件覆盖范围存在空洞时自动记录 `declared_file_gap`，也可通过 `gaps: [{"from": ..., "to": ...}]` 提供已知中断，端点为秒且左闭右开。文件范围和哈希不能证明部署持续可观测，连续性仍需数据来源证据。不同观测点的缺档、基线和连续性独立标记。

## 输出与失败

`index.json` 包含版本、窗口、各观测点的身份、完整/部分状态、来源文件、类型、哈希、字节数、实际时间范围、记录数、基线状态、缺档及统计。详细数据按编号写入 `collector-0001.changes.jsonl`、`collector-0001.state.jsonl`；前缀模式另有 `collector-0001.timeline.json`。

事件及前后状态的 `source.collector/view` 与外层身份一致；状态按块导出，避免构造全表 JSON 树。变化和状态文件中的位置仍是各输入文件的记录号、解压后起点与记录内事件索引。

某个观测点失败后，其他独立观测点继续完成。顶层及失败条目标为 `partial`，记录错误并非零退出；不得把已写出的文件当作完整联合结果。输出中的 `complete` 只表示配置的文件处理完整，不是全球路由或实际业务可见性的证明。

`tests/multi.test.mjs` 在有/无前缀时间线两种模式下比较联合输出与逐观测点单独运行的状态、变化和统计；核心测试另验证同名 peer/ID0、跨视图隔离、范围内会话重置及过期事件不会影响另一观测点。
