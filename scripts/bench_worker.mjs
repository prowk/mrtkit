import { pathToFileURL } from 'node:url';
import { statSync } from 'node:fs';
import { options } from '../cli/options.mjs';
import { frames, inputChunks } from '../cli/input.mjs';

// 单独进程测量解析和状态分析，省略路由 JSON 序列化及终端输出。
const argv = process.argv.slice(2);
let moduleUrl = new URL('../_build/js/release/build/bridge/bridge.js', import.meta.url);
if (argv[0] === '--bridge') { moduleUrl = pathToFileURL(argv[1]); argv.splice(0, 2); }
const bridge = await import(moduleUrl);
const { config, files, initialRib } = options(argv);
const wire = Object.fromEntries(Object.entries(config).filter(([, value]) => value !== null));
const configured = JSON.parse(bridge.configure(JSON.stringify(wire)));
if (configured.error) throw new Error(configured.error);
const start = process.hrtime.bigint();
let records = 0, routeEvents = 0, stateEvents = 0, decompressedBytes = 0;
let lastProgress = start;
let failed = null;
let failureSummary = null;
try {
  for (const [file, baseline] of [...(initialRib ? [[initialRib, true]] : []), ...files.map(file => [file, false])]) {
    bridge.reset_file();
    if (baseline) bridge.begin_baseline();
    for await (const frame of frames(inputChunks(file))) {
      const result = JSON.parse(bridge.consume_metrics(frame.data));
      if (result.error) { failed = result.error; failureSummary = result.summary; break; }
      records++; routeEvents += result.route_events; stateEvents += result.state_events; decompressedBytes += frame.data.length;
      const now = process.hrtime.bigint();
      if (now - lastProgress > 5_000_000_000n) {
        process.stderr.write(JSON.stringify({ progress: config.mode, records, routeEvents, elapsedSeconds: Number(now - start) / 1e9 }) + '\n');
        lastProgress = now;
      }
    }
    if (failed) break;
    if (baseline) {
      const result = JSON.parse(bridge.end_baseline());
      if (result.error) throw new Error(result.error);
    }
  }
} catch (error) { failed = error.message; }
const seconds = Number(process.hrtime.bigint() - start) / 1e9;
const summary = failed ? failureSummary : JSON.parse(bridge.finish());
const analyzedEvents = config.mode === 'parse' ? 0 : ['rib_routes', 'announcements', 'withdrawals'].reduce((n, key) => n + Number(summary?.[key] ?? 0), 0);
const result = { mode: config.mode, configuration: config, files, initial_rib: initialRib,
  seconds, records, route_events: routeEvents, state_events: stateEvents, decompressed_bytes: decompressedBytes,
  compressed_bytes: [...files, ...(initialRib ? [initialRib] : [])].reduce((n, file) => n + statSync(file).size, 0),
  records_per_second: records / seconds, route_events_per_second: routeEvents / seconds,
  selected_analysis_events: analyzedEvents, selected_analysis_events_per_second: analyzedEvents / seconds,
  decompressed_mib_per_second: decompressedBytes / seconds / 1048576,
  peak_rss_bytes: process.resourceUsage().maxRSS * 1024, memory_method: 'OS process.resourceUsage().maxRSS',
  active_routes: config.mode === 'parse' ? 0 : summary?.active_routes ?? null,
  cached_routes: config.mode === 'parse' ? 0 : summary?.tracked_routes ?? null,
  summary, failure: failed };
process.stdout.write(JSON.stringify(result) + '\n');
process.exitCode = failed ? 2 : 0;
