# RIS rrc23 的真实路径变化复盘

[文档首页](../../docs/README.md) · [回放指南](../../docs/guides/replay.md) · [数据与检查结果](../../docs/validation/real-case-verification.json)

此例核查 2025-01-01 RIS rrc23 对 `183.90.160.0/24`、peer AS58952（`27.111.229.109`）的有效 AS_PATH 观测。分析窗口为 **00:20:00–00:40:00 UTC，包含结束秒**。使用一个完整 RIB 和连续十二个 UPDATE，共读取 1,597,926 条 MRT 记录；只有目标前缀与 peer 进入状态分析。这不是全表驻留内存基准。

## 可以直接核查的事实

| UTC | 原始档案记录 / 解压后偏移 | 观测到的路径 |
| --- | --- | --- |
| 00:20:00 | `updates.20250101.0020.gz` #1 / 0 | 从 `58952 18403 18403 18403 131126` 改为 `58952 45899 131126` |
| 00:21:31 | 同一档案 #11278 / 1914432 | 改为 `58952 58453 45899 131126` |
| 00:21:31 | 同一档案 #11279 / 1914597 | 改为 `58952 18403 18403 18403 131126` |

第一条的普通 AS_PATH 长度由 5 变为 3，唯一起源 AS 仍是 131126。后两条时间戳相同但记录号与偏移不同，不能按秒去重。窗口内共 46 条目标宣告、35 次路径变化、46 次属性变化、12 条波动提醒，合计 93 条提醒；没有目标撤回及起源 AS 变化。结束缓存为一条活动路由，最后宣告在 00:39:51，路径为 `58952 45899 131126`。

这些事实只表示一个采集器、一个 peer 的观测，不证明真实转发路径、传播因果、劫持或业务中断。没有独立证明观测连续性，因此报告保留 `continuity_unverified`。摘要中的 221 次 `session_resets` 是窗口内档案流的会话元数据计数，不代表目标 peer 或前缀重置了 221 次。

## 不联网核查摘录

[excerpt.mrt](excerpt.mrt) 是四条原始 BGP4MP 记录，包含一条窗口前路径与表中三条变化；没有改写时间戳、NLRI 或属性。它不是完整 RIB 或连续档案，不能用来推断未出现的事件。原档案位置、摘录偏移及 SHA-256 见 [excerpt-map.json](excerpt-map.json)。

```sh
npm run build
node cli/mrtkit.mjs changes --prefix 183.90.160.0/24 --peer-asn 58952 --from 1735690800 --to 1735692000 cases/rrc23-path-change/excerpt.mrt
python -m pip install --target .validation/deps -r requirements-validation.txt
python scripts/verify_case.py
```

独立验证使用 mrtparse 解码四条记录，逐项检查前缀、peer、原始四字节路径、时间和字节哈希。摘录的基线状态是 `updates_only`，不是完整快照。

## 重建完整回放与 HTML

```sh
python scripts/fetch_archives.py
node scripts/reproduce_case.mjs --output .validation/rrc23-rebuilt
```

输出目录必须是新目录。脚本核对 [case.json](case.json) 固定的全部来源 URL、SHA-256 和时间范围；完整回放 RIB 与十二个更新文件，复算统计，验证三个路径锚点的前后值与原始位置、结束状态，再原样提取摘录并生成 HTML。预期统计还对应[独立 Python 业务模型的完整窗口复算](../../docs/validation/replay-acceptance.json)。

生成的 `.validation/rrc23-rebuilt-html/index.html` 无需服务器即可在本地浏览器打开。仓库也附带[固定离线报告](report/index.html)，含 46 条时间线明细与 93 条提醒。公开报告把机器绝对路径替换为明确的档案文件标签，记录号和解压后偏移保持原值；全部文件均可按清单哈希重取。
