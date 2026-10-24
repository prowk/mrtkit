#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { frames, inputChunks } from './input.mjs';
import { options } from './options.mjs';
import { DiagnosticCollector } from './diagnostics.mjs';

const help = `mrtkit 0.2.0 — MoonBit BGP MRT 工具
用法: node cli/mrtkit.mjs <parse|stats|changes|snapshot-diff|aggregate|timeline|multi|replay-disk|correlate|report> [选项] <文件...|->
  parse     输出路由 JSON Lines；--format csv 导出 CSV
  stats     输出统计 JSON
  changes   输出路径变化、起源变化、固定窗口波动提醒
    --compact  共享相邻提醒的前后状态、差异与来源，输出自包含上下文引用行
  snapshot-diff --collector 名称 前快照 后快照  比较同源同视图快照
  aggregate 输出变化最多的前缀、受影响 peer 与类型分布；--top 默认 20
  timeline --prefix CIDR  输出前缀时间线与各 peer 的观测状态
  multi --manifest 配置.json --output 新目录  按采集器/视图独立回放并导出结果包
  replay-disk --manifest 单观测点清单 --output 新目录  按 peer 保存完整逻辑状态，限制驻留内存
  correlate --input 结果包/index.json --window 秒  关联多观测点的同类语义变化
    --external --output 新目录 --memory-mib 64 --disk-mib 8192  有界内存关联并分离导出
  report --input 结果包/index.json --output 新目录  生成离线 HTML 复盘报告
  --continuous-observation  声明输入覆盖连续，允许计算观测不可见时长
  --observation-gap 开始秒:结束秒  标记观测中断，可重复，支持六位小数
  --prefix CIDR       精确筛选前缀（自动清除主机位）
  --prefix-mode exact|more-specific|covering  前缀匹配模式
  --asn ASN           parse 中匹配 peer 或 AS 路径
  --peer-asn ASN      按 peer ASN 筛选，支持所有命令
  --path-id ID        精确筛选 ADD-PATH 标识（包括 0）
  --from / --to 秒    Unix 秒时间戳，包含端点
  --from-micros / --to-micros 微秒  时间端点的小数部分
  --initial-rib 文件  显式初始快照；窗口前 UPDATE 自动预热
  --window 秒        波动分析窗口，默认 60
  --threshold 次     波动提醒阈值，默认 10
  --capacity 条      最大缓存路由数，默认 1000000
  --output-version 2.0  指定机器可读输出版本
支持未压缩 MRT、.gz 和 .bz2（bz2 需要 Python 3）。
分析多个文件时须来自同一采集器，并按时间顺序传入。`;

async function write(stream, text) {
  try {await new Promise((resolve, reject) => stream.write(text, 'utf8', error => error ? reject(error) : resolve()));}
  catch (error) {error.stage = 'output'; throw error;}
}

export async function main(argv, {stdout = process.stdout, stderr = process.stderr} = {}) {
  let started = false;
  const output = async text => {started = true; await write(stdout, text);};
  try {await execute(argv, output, stderr);}
  catch (error) {error.partial_result = started; throw error;}
}

export function errorText(error) {
  const stage = error.stage === 'output' ? `输出失败${error.code ? ` (${error.code})` : ''}: ` : '';
  const partial = error.partial_result ? '；标准输出可能只包含部分结果，请勿当作完整结果' : '';
  return `mrtkit: ${stage}${error.message}${partial}\n`;
}

async function execute(argv, output, diagnostic) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { await output(`${help}\n`); return; }
  if (argv[0] === '--version') { await output('0.2.0\n'); return; }
  if (argv[0] === 'multi') {
    const {multiCommand} = await import('./multi.mjs');
    await output(`${JSON.stringify(await multiCommand(argv.slice(1)))}\n`);
    return;
  }
  if (argv[0] === 'replay-disk') {
    const {diskReplayCommand}=await import('./disk-replay.mjs');
    await output(`${JSON.stringify(await diskReplayCommand(argv.slice(1)))}\n`);
    return;
  }
  if (argv[0] === 'correlate') {
    const {correlateCommand} = await import('./correlate.mjs');
    await output(`${JSON.stringify(await correlateCommand(argv.slice(1)))}\n`);
    return;
  }
  if (argv[0] === 'report') {
    const {reportCommand} = await import('./report.mjs');
    await output(`${JSON.stringify(await reportCommand(argv.slice(1)))}\n`);
    return;
  }
  const delimiter=argv.indexOf('--'),compactPositions=argv.map((value,index)=>value==='--compact'&&(delimiter<0||index<delimiter)?index:-1).filter(index=>index>=0);
  if(compactPositions.length>1||compactPositions.length&&argv[0]!=='changes')throw new Error('--compact 仅支持 changes，且不能重复');
  const compact=compactPositions.length===1;
  const { config, files, initialRib, collector } = options(argv.filter((_,index)=>!compactPositions.includes(index)));
  let bridge;
  try { bridge = await import(new URL('../_build/js/release/build/bridge/bridge.js', import.meta.url)); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    throw new Error('请先运行 moon build --target js --release');
  }
  const wireConfig = Object.fromEntries(Object.entries(config).filter(([, value]) => value !== null));
  const configured = JSON.parse(bridge.configure(JSON.stringify(wireConfig)));
  if (configured.error) throw new Error(configured.error);
  if (config.mode === 'snapshot-diff') {
    const check = text => { const value = JSON.parse(text); if (value.error) throw Object.assign(new Error(value.error), {position: value.position}); return value; };
    check(bridge.snapshot_begin(collector, collector));
    for (const [index, file] of files.entries()) {
      let record = 0;
      try {
        for await (const frame of frames(inputChunks(file))) {
          record++;
          try { check(bridge.snapshot_consume(frame.data, index === 1, file, BigInt(record), BigInt(frame.offset))); }
          catch (error) { throw new Error(`记录 ${record}，文件偏移 ${frame.offset}，解析器局部偏移 ${error.position}: ${error.message}`); }
        }
      } catch (error) {throw new Error(`${file}: ${error.message}`);}
    }
    await output(`${JSON.stringify(check(bridge.snapshot_finish()))}\n`);
    return;
  }
  let records = 0, skipped = 0, ignored = 0;
  const diagnosticCollector = new DiagnosticCollector();
  if (config.mode === 'parse' && config.format === 'csv') await output(`${bridge.csv_header()}\n`);
  const inputs = [...(initialRib ? [{ file: initialRib, baseline: true }] : []), ...files.map(file => ({ file, baseline: false }))];
  const encoder=compact?new (await import('./compact-changes.mjs')).ChangeEncoder(output,{encoding:'event_refs_v1'}):null;
  try{
  for (const { file, baseline } of inputs) {
    bridge.reset_file();
    if (baseline) {
      const result = JSON.parse(bridge.begin_baseline());
      if (result.error) throw new Error(result.error);
    }
    let fileRecords = 0;
    try {
      for await (const frame of frames(inputChunks(file))) {
        fileRecords++; records++;
        const result = JSON.parse(bridge.consume_at(frame.data, file, BigInt(fileRecords), BigInt(frame.offset)));
        if (result.error) throw new Error(`记录 ${fileRecords}，文件偏移 ${frame.offset}，解析器局部偏移 ${result.position}: ${result.error}`);
        if (result.skipped) skipped++;
        ignored += result.ignored_families;
        diagnosticCollector.add(result.diagnostics);
        if (result.lines.length) {if(encoder)await encoder.pushLines(result.lines);else await output(`${result.lines.join('\n')}\n`);}
      }
      if (baseline) {
        const result = JSON.parse(bridge.end_baseline());
        if (result.error) throw new Error(result.error);
      }
    } catch (error) {
      if (error.stage === 'output') throw error;
      throw new Error(`${file}: ${error.message}`);
    }
  }
  }finally{await encoder?.close();}
  const summary = JSON.parse(bridge.finish());
  if (summary.error) throw new Error(summary.error);
  if (['stats', 'aggregate', 'timeline'].includes(config.mode)) await output(`${JSON.stringify(summary)}\n`);
  await write(diagnostic, `已处理 ${records} 条 MRT 记录，跳过 ${skipped} 条不支持的类型，忽略 ${ignored} 个不支持的 MP 地址族\n`);
  await write(diagnostic, `${JSON.stringify(diagnosticCollector.report())}\n`);
  if (config.mode === 'changes') await write(diagnostic, `${JSON.stringify(summary)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // 管道接收端提前退出时由写回调处理 EPIPE。
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {process.exitCode = 1;});
  main(process.argv.slice(2)).catch(error => {
    process.exitCode = 1;
    process.stderr.write(errorText(error), 'utf8');
  });
}
