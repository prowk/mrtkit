# 调查流程验收（2026-10-30）

已发布 [静态案例](https://prowk.github.io/mrtkit/)，分别标注真实单观测点摘录、人工多采集器和固定 10,000 事件规模案例。[Pages](https://github.com/prowk/mrtkit/actions/runs/41038340894) 与 [CI](https://github.com/prowk/mrtkit/actions/runs/41038340802) 已成功；原申报书的小标题与信息栏保持不变。

| 固定规模报告指标 | 实测 | 预定目标 |
| --- | ---: | ---: |
| 首屏 | 1.40 秒 | ≤3 秒 |
| 前缀与类型组合筛选 | 1.32 秒 | ≤3 秒 |
| 翻页 | 0.62 秒 | ≤1 秒 |
| 当次 JS 堆 | 31.1 MiB | ≤256 MiB |

首屏仅加载 1 个明细页，未读筛选索引；组合筛选读取 10 个紧凑索引块，命中 6,000 个事件和 12,167 条提醒。采用 Chrome 156、默认不节流 HTTPS、一次测量，未强制清空共享浏览器缓存；堆值不是进程 RSS 或峰值。首次串行索引测得 3.17 秒筛选，保留在[优化前记录](investigation-online-before.json)，目标未降低。

后续检查确认：MOAS 关联图分别保留 22:30:01 和 22:30:02 的原始证据时间，未用区间开始时间代替；链接刷新恢复提醒口径、Top 5 和选中组；下载的 SVG 通过 XML 解析，含当前半开微秒范围、计数口径和三类排名。

真实浏览器检查包括子路径与深层链接、刷新和前进后退、组合筛选、时间桶联动、分页、取消/重置、明确缺页错误、IPv6、长路径、ADD-PATH 0、散点、状态区间、路径步进、恶意文本和证据下载。界面下载的 2 行证据通过 CLI 哈希与计数核验。核心固定用例覆盖仅有基线的更具体路由及路径时长分布，避免仅检查更新事件。

[原始测量](investigation-online-after.json) · [预定目标](investigation-online-target.json) · [完整收据、来源哈希与检查范围](investigation-acceptance.json) · [桌面截图](screenshots/investigation-desktop.jpg) · [窄屏截图](screenshots/investigation-narrow.jpg)
