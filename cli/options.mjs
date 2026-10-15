
export function integer(text, name, min = 0, max = 4294967295) {
  if (!/^\d+$/.test(text)) throw new Error(`${name} 必须为整数`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 超出范围 ${min}..${max}`);
  return value;
}

export function options(argv) {
  const mode = argv.shift();
  if (!['parse', 'stats', 'changes', 'snapshot-diff', 'aggregate', 'timeline'].includes(mode)) throw new Error('命令必须为 parse、stats、changes、snapshot-diff、aggregate 或 timeline');
  const config = { mode, format: 'json', output_version: '2.0', prefix: null, asn: null, peer_asn: null, from_time: 0, to_time: 4294967295,
    from_micros: 0, to_micros: 999999, window_seconds: 60, threshold: 10, capacity: 1000000 };
  let initialRib = null;
  let collector = null;
  const files = [];
  let endOptions = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--' && !endOptions) { endOptions = true; continue; }
    if (!endOptions && arg.startsWith('--')) {
      const name = arg.slice(2);
      if (name === 'continuous-observation') {
        if (mode !== 'timeline') throw new Error('--continuous-observation 仅用于 timeline');
        config.continuous_observation = true; continue;
      }
      if (!['format', 'output-version', 'prefix', 'prefix-mode', 'path-id', 'asn', 'peer-asn', 'from', 'to', 'from-micros', 'to-micros', 'initial-rib', 'window', 'threshold', 'capacity', 'collector', 'top', 'observation-gap'].includes(name)) throw new Error(`未知选项: ${arg}`);
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} 缺少值`);
      if (name === 'collector') collector = value;
      else if (name === 'observation-gap') {
        if (mode !== 'timeline') throw new Error('--observation-gap 仅用于 timeline');
        const match = /^(\d+)(?:\.(\d{1,6}))?:(\d+)(?:\.(\d{1,6}))?$/.exec(value);
        if (!match) throw new Error('--observation-gap 使用 开始秒.微秒:结束秒.微秒');
        const gap = {from_time: integer(match[1], arg), from_micros: Number((match[2] ?? '').padEnd(6, '0')),
          to_time: integer(match[3], arg), to_micros: Number((match[4] ?? '').padEnd(6, '0'))};
        if (gap.from_time * 1000000 + gap.from_micros >= gap.to_time * 1000000 + gap.to_micros) throw new Error('观测中断开始时间必须早于结束时间');
        (config.observation_gaps ??= []).push(gap);
      }
      else if (name === 'top') config.top = integer(value, arg, 1, 2147483647);
      else if (name === 'initial-rib') { if (initialRib !== null) throw new Error('只允许一个初始 RIB'); initialRib = value; }
      else if (name === 'from-micros' || name === 'to-micros') config[name.replace('-', '_')] = integer(value, arg, 0, 999999);
      else if (name === 'format') config.format = value;
      else if (name === 'output-version') config.output_version = value;
      else if (name === 'prefix') config.prefix = value;
      else if (name === 'prefix-mode') config.prefix_mode = value;
      else if (name === 'asn') config.asn = integer(value, arg);
      else if (name === 'path-id') config.path_id = integer(value, arg);
      else if (name === 'peer-asn') config.peer_asn = integer(value, arg);
      else if (name === 'from') config.from_time = integer(value, arg);
      else if (name === 'to') config.to_time = integer(value, arg);
      else config[{ window: 'window_seconds', threshold: 'threshold', capacity: 'capacity' }[name]] = integer(value, arg, name === 'threshold' ? 2 : 1, 2147483647);
    } else files.push(arg);
  }
  if (!files.length) throw new Error('请指定 MRT 文件，或使用 - 读取未压缩标准输入');
  if (files.filter(file => file === '-').length > 1) throw new Error('标准输入只能使用一次');
  if (!['json', 'csv'].includes(config.format)) throw new Error('--format 必须为 json 或 csv');
  if (mode !== 'parse' && config.format !== 'json') throw new Error('stats/changes 仅支持 JSON 输出');
  if (mode !== 'parse' && config.asn !== null) throw new Error('分析请使用 --peer-asn，--asn 路径筛选仅支持 parse');
  if (config.from_time > config.to_time || (config.from_time === config.to_time && config.from_micros > config.to_micros)) throw new Error('--from 晚于 --to');
  if (initialRib && mode === 'parse') throw new Error('--initial-rib 仅用于分析命令');
  if (config.output_version !== '2.0') throw new Error('仅支持 --output-version 2.0');
  if (config.top !== undefined && mode !== 'aggregate') throw new Error('--top 仅用于 aggregate');
  if (mode === 'timeline' && (config.prefix === null || (config.prefix_mode ?? 'exact') !== 'exact')) throw new Error('timeline 需要 --prefix 并仅支持 exact 模式');
  if (mode === 'snapshot-diff') {
    if (files.length !== 2 || !collector?.trim()) throw new Error('snapshot-diff 需要 --collector 名称和前后两个快照');
    if (initialRib || config.from_time !== 0 || config.to_time !== 4294967295 || config.from_micros !== 0 || config.to_micros !== 999999)
      throw new Error('快照差异不接受初始 RIB 或时间窗口；请直接指定两个完整快照');
  } else if (collector !== null) throw new Error('--collector 仅用于 snapshot-diff');
  return { config, files, initialRib, collector };
}
