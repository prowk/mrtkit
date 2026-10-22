import {pathToFileURL} from 'node:url';
import {readFile, open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {frames, inputChunks} from '../cli/input.mjs';

// 不筛选前缀或 peer。独立进程设置显式 RSS 预算，防止大表挤占交互工作区内存。
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const bridge = await import(pathToFileURL(config.bridge));
const checked = text => {const value = JSON.parse(text); if (value.error) throw Object.assign(new Error(value.error), {details: value}); return value;};
checked(bridge.configure(JSON.stringify({mode: 'changes', format: 'json', from_time: config.from, to_time: config.to,
  window_seconds: 60, threshold: 3, capacity: config.capacity, metrics_changes: true})));
const start = process.hrtime.bigint();
let records = 0, events = 0, states = 0, bytes = 0, notices = 0, outputBytes = 0;
let serializationNs = 0n, writingNs = 0n, failure = null, failureSummary = null, phase = 'rib', last;
const outputHash = createHash('sha256');
let stateHash = null, stateBytes = 0;
const output = await open(config.output, 'w');
let buffered=[],bufferedBytes=0;
async function flushOutput(){if(!bufferedBytes)return;const text=buffered.join('');buffered=[];bufferedBytes=0;const before=process.hrtime.bigint();await output.writeFile(text,'utf8');writingNs+=process.hrtime.bigint()-before;}
async function appendOutput(text){buffered.push(text);bufferedBytes+=Buffer.byteLength(text);outputHash.update(text);outputBytes+=Buffer.byteLength(text);if(bufferedBytes>=65536)await flushOutput();}
try {
  for (const [index, file] of [...(config.rib?[config.rib]:[]), ...config.updates].entries()) {
    bridge.reset_file();
    const baseline = index === 0 && config.rib;
    phase = baseline ? 'rib' : 'updates';
    if (baseline) checked(bridge.begin_baseline());
    let ordinal = 0;
    for await (const frame of frames(inputChunks(file))) {
      ordinal++;
      last = {file, record: ordinal, decompressed_offset: frame.offset};
      if (records % 256 === 0 && process.memoryUsage().rss > config.rss_budget_bytes) {
        throw Object.assign(new Error('benchmark_rss_budget_exceeded'), {resource: true});
      }
      // 来源模式包含桥接层的逐条变化序列化；文件写出和最终状态导出另计。
      const before = process.hrtime.bigint();
      const result = checked(config.emit ? bridge.consume_at(frame.data,file,BigInt(ordinal),BigInt(frame.offset)) : bridge.consume_metrics(frame.data));
      const parsed = process.hrtime.bigint();
      records++; events += result.route_events; states += result.state_events; bytes += frame.data.length;
      if (config.emit) {
        const text = result.lines.join('\n');
        if (text) {await appendOutput(text+'\n');notices+=result.lines.length;}
      } else if (typeof bridge.drain_changes === 'function') {
        const lines = checked(bridge.drain_changes());
        const text = lines.map(line => JSON.stringify(line)).join('\n');
        const serialized = process.hrtime.bigint();
        serializationNs += serialized - parsed;
        if (text) {await appendOutput(text+'\n');notices += lines.length;}
      }
      if (records % 25000 === 0) process.stderr.write(JSON.stringify({phase, records, route_events: events,
        seconds: Number(process.hrtime.bigint()-start)/1e9, peak_rss_bytes: process.resourceUsage().maxRSS*1024,
        cached: result.cached_routes ?? null, parse_batch_ns: String(parsed-before)})+'\n');
    }
    if (baseline) checked(bridge.end_baseline());
  }
  if (config.save_state) {
    checked(bridge.state_export_begin());
    const file=await open(config.output+'.state.jsonl','w');
    let count=0,sum=0n,xor=0n;const mask=(1n<<256n)-1n;
    const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
    try{for(;;){
      const before=process.hrtime.bigint();const rows=checked(bridge.state_export_chunk(128));if(!rows.length)break;
      const lines=rows.map(row=>{const text=JSON.stringify(canonical(row));const hash=BigInt('0x'+createHash('sha256').update(text).digest('hex'));sum=(sum+hash)&mask;xor^=hash;count++;return text;});
      const text=lines.join('\n')+'\n';stateBytes+=Buffer.byteLength(text);
      const serialized=process.hrtime.bigint();serializationNs+=serialized-before;
      await file.writeFile(text,'utf8');writingNs+=process.hrtime.bigint()-serialized;
    }}finally{await file.close();}
    stateHash={rows:count,sha256_sum:sum.toString(16).padStart(64,'0'),sha256_xor:xor.toString(16).padStart(64,'0')};
  }
} catch (error) {
  failure = {kind: error.resource ? 'benchmark_memory_budget' : 'input_or_capacity', message: error.message, ...last};
  failureSummary = error.details?.summary;
} finally {await flushOutput();await output.close();}
const summary = failureSummary ?? checked(bridge.finish());
const seconds = Number(process.hrtime.bigint()-start)/1e9;
const result = {complete: failure === null, failure, phase, records, route_events: events, state_events: states,
  decompressed_bytes: bytes, seconds, route_events_per_second: events/seconds,
  peak_rss_bytes: process.resourceUsage().maxRSS*1024, active_routes: summary.active_routes,
  cached_routes: summary.tracked_routes, withdrawn_routes: summary.tracked_routes-summary.active_routes,
  summary, notices, output_bytes: outputBytes,output_sha256:outputHash.digest('hex'),state_sha256:stateHash,state_bytes:stateBytes,
  serialization_seconds: Number(serializationNs)/1e9, writing_seconds: Number(writingNs)/1e9,
  output_contract: 'Only completed window changes are written. An incomplete run cannot measure complete-replay output cost.',
  serialization_contract: config.emit ? 'Per-record analysis includes bridge serialization; separate serialization_seconds measures final state export only. writing_seconds includes file I/O and digest for state export.' : 'serialization_seconds includes benchmark change handoff and host reserialization; final state not exported in resource-limited full-RIB attempts.',
  storage: typeof bridge.storage_stats === 'function' && !failureSummary ? checked(bridge.storage_stats()) : null};
process.stdout.write(JSON.stringify(result)+'\n');
process.exitCode = failure ? 2 : 0;
