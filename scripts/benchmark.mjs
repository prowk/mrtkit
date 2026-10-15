import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { resolve, join } from 'node:path';

// 各样本在独立子进程中串行运行，进程退出后再开始下一次测量。
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const directory = resolve(option('--archives', '.validation/archives'));
const reportPath = resolve(option('--report', '.validation/benchmark.json'));
const bridge = option('--bridge', null);
const repeats = Number(option('--repeats', '3'));
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('--repeats 必须为 1..20');
const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
const hotDirectory = option('--hotpaths', null);
if (hotDirectory) {
  const hot = JSON.parse(readFileSync(join(hotDirectory, 'manifest.json'), 'utf8'));
  for (const item of hot) manifest.push({...item, file: resolve(hotDirectory, item.file)});
}
const inputs = [];
for (const entry of manifest) {
  const hash = createHash('sha256');
  const path = entry.collector === 'synthetic' ? entry.file : join(directory, entry.file);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const obtained = hash.digest('hex');
  if (obtained !== entry.sha256) throw new Error(`输入校验和不一致：${entry.file}`);
  inputs.push({ ...entry, path });
}
const rib = inputs.find(i => i.collector === 'ris-rrc23' && i.kind === 'rib').path;
const updates = inputs.filter(i => i.collector === 'ris-rrc23' && i.kind === 'update').sort((a, b) => a.file.localeCompare(b.file)).map(i => i.path);
if (updates.length !== 12) throw new Error('基准需要连续十二个 RIS 五分钟更新文件');
const cases = [
  { name: 'complete_rib_parse', argv: ['parse', rib] },
  { name: 'complete_rib_analysis_filtered', argv: ['stats', '--peer-asn', '8075', '--prefix', '192.0.0.0/8', '--prefix-mode', 'more-specific', rib] },
  { name: 'one_hour_updates_parse', argv: ['parse', ...updates] },
  { name: 'one_hour_updates_analysis', argv: ['stats', ...updates] },
  { name: 'complete_rib_capacity_failure', argv: ['stats', '--capacity', '1000', rib], expectedExit: 2 },
];
if (hotDirectory) cases.push(
  {name: 'duplicate_semantic_normalization', argv: ['stats', resolve(hotDirectory, 'duplicates.mrt')]},
  {name: 'peer_session_resets', argv: ['stats', resolve(hotDirectory, 'session-resets.mrt')]},
  {name: 'fragmented_library_record', argv: [resolve(hotDirectory, 'fragmented-record.mrt')], worker: 'scripts/stream_bench_worker.mjs'},
);
const version = command => {
  const result = spawnSync(command, ['--version'], {encoding: 'utf8', windowsHide: true});
  if (result.status !== 0) throw new Error(`无法读取 ${command} 版本`);
  return result.stdout.trim();
};
const report = {
  method: 'fresh process per run; serial execution; import/configure/hash verification excluded; MRT framing/decompression/parse/query/analyze included; route output serialization omitted',
  environment: { date: new Date().toISOString(), platform: os.platform(), release: os.release(), arch: os.arch(),
    cpu: os.cpus()[0].model.trim(), logical_cpus: os.cpus().length, total_memory_bytes: os.totalmem(),
    node: process.version, moon: version('moon'), python: version('python') },
  bridge: bridge ? resolve(bridge) : '_build/js/release/build/bridge/bridge.js',
  bridge_sha256: createHash('sha256').update(readFileSync(bridge ? resolve(bridge) : '_build/js/release/build/bridge/bridge.js')).digest('hex'),
  source_revision: spawnSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8', windowsHide: true}).stdout.trim(),
  command: [process.execPath, ...process.argv.slice(1)], repeats, inputs, runs: [], medians: [],
};
async function run(argv, expectedExit = 0, worker = 'scripts/bench_worker.mjs') {
  const workerArgs = [worker, ...(bridge ? ['--bridge', resolve(bridge)] : []), ...argv];
  const child = spawn(process.execPath, workerArgs, {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let text = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => { text += data; if (text.length > 1048576) child.kill(); });
  child.stderr.on('data', data => process.stderr.write(data));
  const code = await new Promise((done, fail) => {child.on('error', fail); child.on('close', done);});
  if (code !== expectedExit) throw new Error(`基准退出码 ${code}，预期 ${expectedExit}: ${text.slice(-2000)}`);
  return { command: [process.execPath, ...workerArgs], ...JSON.parse(text), exit_code: code };
}
mkdirSync(resolve(reportPath, '..'), {recursive: true});
const median = values => { const sorted = [...values].sort((a, b) => a - b); const n = sorted.length; return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2; };
for (const item of cases) {
  for (let iteration = 1; iteration <= repeats; iteration++) {
    process.stderr.write(`${item.name} ${iteration}/${repeats}\n`);
    const result = await run(item.argv, item.expectedExit, item.worker);
    report.runs.push({name: item.name, iteration, ...result});
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  const runs = report.runs.filter(r => r.name === item.name);
  const row = {name: item.name, active_routes: runs[0].active_routes, cached_routes: runs[0].cached_routes};
  for (const key of ['seconds', 'records_per_second', 'route_events_per_second', 'decompressed_mib_per_second', 'peak_rss_bytes']) row[key] = median(runs.map(r => r[key]));
  report.medians.push(row);
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  process.stdout.write(JSON.stringify(row) + '\n');
}
