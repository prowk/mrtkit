# 验证记录

验证日期：2026-10-13。工具链：moon 0.1.20260920、moonc v0.10.14+7d59c7ec9，Node.js 22.14.0，Python 3.13.2。CI 使用官方安装器的发布标签 `0.10.14+7d59c7ec9` 固定编译器和核心库。

## 自动测试

- 35 个 MoonBit 测试分别在 JS、Wasm、Wasm GC 后端通过。
- 12 个 Node 测试通过，包含命令行端到端验证、gzip/bz2、IPv6 RIB/UPDATE、旧式 ASN、扩展时间戳和错误退出码。
- 确定性畸形输入测试覆盖 2,000 组随机修改/随机字节数据，所有调用均返回解析结果或错误，没有宿主异常。
- 编译与测试启用 `--deny-warn`，当前没有编译警告。

## 真实数据对照

从 [RIPE RIS 公开数据](https://ris.ripe.net/docs/mrt/)的 rrc00 采集器 2025-01-01 文件中各提取前 1,000 条完整 MRT 记录。样本不是完整的全球路由表。

| 样本 | MRT 记录 | 路由事件 | 独立解析器对照 |
| --- | ---: | ---: | --- |
| updates.20250101.0000.gz 前缀 | 1,000 | 1,457 | 全部一致 |
| bview.20250101.0000.gz 前缀 | 1,000 | 44,888 | 全部一致 |

参考实现为 [mrtparse 2.2.0](https://github.com/t2mune/mrtparse)。逐项比较时间戳、事件类型、前缀、peer ASN/IP、收发方向、RIB 起源时间、原始 AS_PATH/AS4_PATH 分段、下一跳、ORIGIN、MED、LOCAL_PREF 和 COMMUNITY。保留事件重复次数，比较按多重集合进行，不要求同一 UPDATE 内输出顺序相同。

IP 按地址字节比较，IPv4 映射 IPv6 地址的点分与十六进制显示视为同一个地址。mrtparse 输出原始路径；mrtkit 的有效路径还会按照 RFC 6793 还原 AS4，因此对照使用 `wire_path` 和 `as4_path`。还原逻辑另有专门的单元测试与 CLI 测试。

来源 URL、样本字节数和 SHA-256 见 [sample-manifest.json](sample-manifest.json)，对照字段及结果见 [comparison.json](comparison.json)。未对完整档案、所有采集器和不支持的协议扩展做验证，不据此声称全量 RFC 兼容或生产级性能。

## 复现

在项目根目录执行：

```powershell
moon build --target js --release --deny-warn
$env:PYTHONUTF8 = '1'
python -m pip install --target .validation/deps -r requirements-validation.txt
python scripts/fetch_samples.py
python scripts/compare.py
```

样本与验证依赖只保存在被 Git 忽略的 `.validation/`，不会被提交。该流程需要网络，常规测试和演示不需要网络。
