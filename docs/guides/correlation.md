# 跨采集器变化关联

[文档首页](../README.md) · [入门教程](../tutorials/getting-started.md) · [命令行](../reference/cli.md)

先用[多采集器回放](multi-collector.md)生成结果包，再关联其中的结构化变化：

```sh
node cli/mrtkit.mjs multi --manifest fixtures/multi/manifest.json --output .validation/multi-correlation
node cli/mrtkit.mjs correlate --input .validation/multi-correlation/index.json --window 10 > correlation.json
```

这是采集观测的时间共现，不是传播时延、事件因果或路由劫持判定。不同采集器的采集时钟、基线和缺档可能不同。人工样本中的两个采集器仅用于规则演示。

## 明确规则

匹配要求前缀和变化类型相同，并使用 MoonBit `Change::correlation_key` 生成的语义键：

| 类型 | 匹配条件 |
| --- | --- |
| `path_change` | 规范化后的原有效 AS_PATH 与新有效 AS_PATH 均相同 |
| `origin_change` | 原、新唯一起源 AS 均相同 |
| `attribute_change` | 排除路径后的原、新完整语义属性均相同，包括 MED、LOCAL_PREF 和未知属性值；不只比较可选简写 diff |
| `churn` | 阈值及提醒后的活动/撤回状态相同，不声称变化序列完全相同 |

路径分段、AS_SET 顺序、社区重排、兼容编码等采用与变化分析相同的规范化。采集器、视图和 Path Identifier 不进入跨观测点的语义匹配键，因为 ID 只有本地意义；来源中仍完整保留它们。

观察记录按秒/微秒排序，同时间以身份及来源标识稳定排序。每组以第一次观察为锚点，窗口为 `[首次, 首次 + window)`，后续观察不能链式延长窗口。恰好落在结束端点的观察进入下一组。`--window` 支持最多六位小数秒，必须大于零。

## 重复、覆盖与未知范围

来源身份、文件、记录号、解压后偏移、记录内索引及类型组成去重标识。相同来源重复不增加观测数；同一来源标识对应不同内容时明确失败，避免静默覆盖。变化明细存在索引哈希时先验证哈希，语义键缺失时要求重新生成结果包，不猜测旧输出。

每组输出首次/末次观测微秒、实际窗口结束、覆盖采集器、观测点与受影响 peer 数、完整来源列表，以及所有配置但没有匹配提醒的观测点。`unobserved` 给出对应时间范围及 `partial_input`、基线缺失、连续性未验证、缺档等质量标记；“未观测到匹配提醒”不能解释为该采集器不受影响。

同一采集器的不同视图是不同观测点，但 `cross_collector` 只有覆盖不同采集器名称时才为 true。部分输入会传递 `input_status: "partial"`，不能当作完整观测覆盖。

读取明细时按行流式解析，只保留关联描述符，不累计全部原始属性。排序和分组仍需要与独立观测数量成比例的内存；默认上限 1,000,000，可用 `--capacity` 调整，超限非零退出。生成的 JSON 可能较大，完整一小时输入须按实际变化量与内存选择容量。结果包明细只允许位于包目录内，越界路径和被修改的哈希明确失败。
