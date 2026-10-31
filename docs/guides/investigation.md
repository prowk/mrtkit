# 调查与案例发布

构建后可直接运行固定人工样本；所有输出目录必须不存在：

```sh
npm run build
node cli/mrtkit.mjs check-input --manifest fixtures/investigation-manifest.json --mode full
node cli/mrtkit.mjs investigate --manifest fixtures/investigation-manifest.json --rules fixtures/investigation-rules.json --output .validation/inquiry
node cli/mrtkit.mjs query --input .validation/inquiry/index.json --limit 50
node cli/mrtkit.mjs evidence --input .validation/inquiry/index.json --output .validation/evidence
node cli/mrtkit.mjs verify-evidence --input .validation/evidence/index.json
node cli/mrtkit.mjs report --input .validation/inquiry/index.json --output .validation/inquiry-html
```

调查规则和结果包使用独立版本 1.0，既有 MRT/回放输出仍为 2.0。规则示例覆盖前缀、预期起源、窗口、对比和路径序列。属性查询 JSON 可设 `origin_asns/path_asns/communities/side`，通过 `query --query 条件.json` 或 `export/evidence --query 条件.json` 查询结果包，无需重读 MRT。游标绑定数据版本、条件和顺序；编辑明细会使哈希校验失败。`reindex` 可重新生成绑定版本的紧凑行索引。完整字段与空值含义见[契约](../reference/investigation-contract.md)。

默认最多 20,000 个输入事件、64 MiB 输入体积预算；这是有界的调查窗口分析，不是完整互联网 RIB 常驻分析器。用 `scope_prefixes/scope_peer_asns` 缩小观测范围，属性查询在状态维护之后执行。输入先在预算内稳定排序，来源内迟到事件保持拒绝更新状态。派生结果也有容量/体积限制；超限明确失败。JSONL 逐行写出，独立查询与证据导出均校验结果包哈希。调查规则只产生可解释线索，不评分或直接认定劫持。

报告首屏使用核心摘要；筛选只读每 1,024 行一块的紧凑贡献索引，受 200,000 行和 128 MiB 报告预算约束，保留至多两页明细。时间使用半开 UTC 微秒窗口，缺档桶仅显示已观测贡献，完整数为未知。散点图最多 2,000 个点，界面证据导出最多 5,000 条；更大摘录使用 CLI。路径集合和观测邻接由核心提供。URL 保存版本、组合条件和关联组，不包含本机路径；证据文件是摘录，不是完整基线或档案。

公共档案先发现再下载：

```sh
node cli/mrtkit.mjs plan --collector ris:rrc23 --from 2025-01-01T00:20:00Z --to 2025-01-01T00:30:00Z --output .validation/plan.json
node cli/mrtkit.mjs cache --plan .validation/plan.json --directory .validation/cache --max-bytes 2147483648 --concurrency 2 --retries 3
node cli/mrtkit.mjs plan --collector ris:rrc23 --from 2025-01-01T00:20:00Z --to 2025-01-01T00:30:00Z --metadata .validation/plan.json --output .validation/rebuilt-plan.json
node cli/mrtkit.mjs cache --plan .validation/plan.json --directory .validation/cache --offline true
```

`--metadata` 完全使用已保存目录快照；缓存校验通过时 `--offline true` 无网络重建 manifest。`--retries` 表示包含首次在内的最大尝试次数，默认 3；下载超时默认 60 秒，临时文件完成后原子发布。来源提供的哈希与本地首次计算的哈希分别记录。目录快照和提供方归档周期只能说明名义档案槽，不证明采集连续性。`check-input --mode quick` 查文件、固定哈希和声明范围，`full` 另解压并解析至 EOF；安静期不判缺档。`blocking` 阻止调查，显式 `--allow-partial true` 排除被诊断的文件，并保留质量标记。

既有完整回放与大规模关联仍使用[磁盘回放](disk-replay.md)、[外部排序关联](external-correlation.md)和[紧凑编码](../reference/compact-changes.md)。从固定样本开始的关联与报告完整流程见[HTML 报告](html-report.md)，内存模式适合受容量约束的小结果，外排模式输出分离的 groups/observations JSONL，再用 `report --correlation` 接入。

GitHub Pages 首页直接显示真实路由摘录的概览、图表和路径演变。顶部的数据源选择切换真实摘录与人工多观测点数据，继续使用同一报告界面。页面视觉统一参考 Cloudflare Radar，路径前后网络图参考 BGPlay 的时间演变表达；演示局限放在页脚“演示说明”链接中。

```sh
node scripts/build_site.mjs --output .validation/pages
node scripts/build_site.mjs --input .validation/inquiry/index.json --title "我的路由数据" --output .validation/my-pages
```

`--input` 接收已经分析完成的调查结果包，直接以这份数据生成首页。未指定时使用内置数据源。`--performance true` 可额外构建 10,000 条记录的人工数据源用于性能验证，公共 Pages 默认不包含此测试数据。站点清单记录资源大小与哈希，默认大小预算 16 MiB。全部相对路径支持 `/mrtkit/`、深层链接和离线打开。首次发布在仓库 Settings → Pages 将 Source 设为 GitHub Actions。在线入口为 [路由观察](https://prowk.github.io/mrtkit/)。

图表包含趋势、类型分布、地址与相邻网络排名、路径前后网络图、跨点时间散点、路由状态时间带、多起源区间及窗口对比。单观测点不展示跨点比较，未配置窗口对比时不显示对比模块；已经执行但无结果的规则显示空结果。筛选保留 UTC 微秒精度，并提供可读日期输入。

真实浏览器的 `file://` 验收受工具策略限制，已按用户授权跳过；HTTP/HTTPS 检查不替代离线性能验收。

本轮固定规模测量、截图与跳过范围见[验收记录](../validation/investigation-acceptance.md)。
