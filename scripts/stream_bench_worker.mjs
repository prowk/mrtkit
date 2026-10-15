import { pathToFileURL } from 'node:url';
import { createReadStream, statSync } from 'node:fs';
const args = process.argv.slice(2);
let moduleUrl = new URL('../_build/js/release/build/bridge/bridge.js', import.meta.url);
if (args[0] === '--bridge') {moduleUrl = pathToFileURL(args[1]); args.splice(0, 2);}
const bridge = await import(moduleUrl);
const path = args[0];
bridge.stream_reset();
let records = 0, routeEvents = 0;
const start = process.hrtime.bigint();
for await (const chunk of createReadStream(path)) {
  for (let i = 0; i < chunk.length; i += 256) {
    const result = JSON.parse(bridge.stream_metrics(chunk.subarray(i, i + 256)));
    if (result.error) throw new Error(result.error);
    records += result.records; routeEvents += result.route_events;
  }
}
const result = JSON.parse(bridge.stream_end());
if (result.error) throw new Error(result.error);
const seconds = Number(process.hrtime.bigint() - start) / 1e9;
const bytes = statSync(path).size;
process.stdout.write(JSON.stringify({mode: 'library_stream', seconds, records, route_events: routeEvents, state_events: 0,
  decompressed_bytes: bytes, compressed_bytes: bytes, records_per_second: records / seconds,
  route_events_per_second: routeEvents / seconds, decompressed_mib_per_second: bytes / seconds / 1048576,
  peak_rss_bytes: process.resourceUsage().maxRSS * 1024, memory_method: 'OS process.resourceUsage().maxRSS',
  active_routes: 0, cached_routes: 0, failure: null}) + '\n');
