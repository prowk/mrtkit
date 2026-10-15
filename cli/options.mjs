
export function integer(text, name, min = 0, max = 4294967295) {
  if (!/^\d+$/.test(text)) throw new Error(`${name} 必须为整数`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 超出范围 ${min}..${max}`);
  return value;
}

export function options(argv) {
  const mode = argv.shift();
  if (!['parse', 'stats', 'changes'].includes(mode)) throw new Error('命令必须为 parse、stats 或 changes');
  const config = { mode, format: 'json', output_version: '2.0', prefix: null, asn: null, peer_asn: null, from_time: 0, to_time: 4294967295,
    from_micros: 0, to_micros: 999999, window_seconds: 60, threshold: 10, capacity: 1000000 };
  let initialRib = null;
  const files = [];
  let endOptions = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--' && !endOptions) { endOptions = true; continue; }
    if (!endOptions && arg.startsWith('--')) {
      const name = arg.slice(2);
      if (!['format', 'output-version', 'prefix', 'prefix-mode', 'path-id', 'asn', 'peer-asn', 'from', 'to', 'from-micros', 'to-micros', 'initial-rib', 'window', 'threshold', 'capacity'].includes(name)) throw new Error(`未知选项: ${arg}`);
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} 缺少值`);
      if (name === 'initial-rib') { if (initialRib !== null) throw new Error('只允许一个初始 RIB'); initialRib = value; }
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
  return { config, files, initialRib };
}
