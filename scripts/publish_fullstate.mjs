import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {jsonLines} from '../cli/bundle.mjs';

// 先核验实际输出与固定构建，再发布脱去工作区绝对路径的测量元数据。
const root=resolve('.'),base=join(root,'.validation/fullstate'),output=join(root,'docs/validation/fullstate');
const read=async path=>JSON.parse(await readFile(path,'utf8'));
const hash=async path=>{const digest=createHash('sha256');for await(const chunk of createReadStream(path))digest.update(chunk);return digest.digest('hex');};
const median=values=>{const sorted=[...values].sort((a,b)=>a-b);assert.equal(sorted.length,3);return sorted[1];};
const sum=(values,key)=>values.reduce((total,row)=>total+row[key],0);
const names=['trace-before','trace-after','stream-before','stream-after','repro-before','repro-after'];
const reports=Object.fromEntries(await Promise.all(names.map(async name=>[name,await read(join(base,name,'report.json'))])));
const original=join(base,'before-bridge.mjs'),probe=join(base,'before-probe.mjs'),optimized=join(base,'current-bridge.mjs');
const originalBytes=await readFile(original),probeBytes=await readFile(probe);
assert.ok(probeBytes.subarray(0,originalBytes.length).equals(originalBytes),'旧版探针必须只追加内容');
const builds={before_original:await hash(original),before_probe:await hash(probe),after:await hash(optimized)};
assert.equal(builds.before_original,await hash(join(base,'baseline-source/_build/js/release/build/bridge/bridge.js')));
assert.equal(builds.after,await hash(join(base,'current-source/_build/js/release/build/bridge/bridge.js')));
const instrumentation=await read(join(base,'instrumentation.json'));
assert.equal(builds.before_original,instrumentation.original_sha256);
assert.equal(builds.before_probe,instrumentation.instrumented_sha256);
const inputs=(await read(join(root,'docs/validation/archive-manifest.json'))).filter(item=>item.collector==='ris-rrc23');
assert.equal(inputs.length,13);assert.equal(inputs.filter(item=>item.kind==='rib').length,1);
for(const input of inputs)assert.equal(await hash(join(root,'.validation/archives',input.file)),input.sha256);
const compared=(await read(join(root,'docs/validation/archive-comparison.json'))).samples.filter(row=>row.collector==='ris-rrc23');
for(const row of compared){assert.equal(row.complete_file_compared,true);assert.equal(row.matched,true);assert.equal(row.sha256,inputs.find(input=>input.file===row.sample)?.sha256);}
const rib=compared.filter(row=>row.kind==='rib'),updates=compared.filter(row=>row.kind==='update');
const capacityUpperBound=sum(compared,'events');
for(const [name,report]of Object.entries(reports)){
  assert.equal(report.repeats,3);assert.equal(report.runs.length,3);
  assert.equal(report.bridge_sha256,name.endsWith('before')?builds.before_probe:builds.after);
  assert.equal(report.bridge_source_revision,name.endsWith('before')?'2ea9935':'f63abe6');
  assert.equal(report.configuration.prefix_filter,null);assert.equal(report.configuration.peer_filter,null);
  assert.ok(report.configuration.capacity>=capacityUpperBound);
  assert.deepEqual(report.inputs,inputs.filter(input=>!name.startsWith('stream')||input.kind==='update'));
  for(const run of report.runs){
    assert.equal(run.complete,name.startsWith('stream'));assert.equal(run.exit_code,run.complete?0:2);
    if(!run.complete){assert.equal(run.failure.kind,'benchmark_memory_budget');assert.equal(run.phase,'rib');assert.equal(run.state_sha256,null);}
  }
}
const successful=[...reports['stream-before'].runs,...reports['stream-after'].runs],reference=successful[0];
const equalityFields=['records','route_events','state_events','active_routes','cached_routes','withdrawn_routes','summary','notices','output_bytes','output_sha256','state_sha256','state_bytes'];
for(const run of successful)for(const key of equalityFields)assert.deepEqual(run[key],reference[key],key);
assert.equal(reference.records,sum(updates,'records'));assert.equal(reference.route_events,sum(updates,'events'));
assert.equal(reference.state_events,sum(updates,'state_events'));
const verifiedOutputs=[];
for(const name of ['stream-before','stream-after'])for(const run of reports[name].runs){
  const path=join(base,name,`output-${run.iteration}.jsonl`),metadata=await stat(path);
  assert.equal(metadata.size,run.output_bytes);assert.equal(await hash(path),run.output_sha256);
  const statePath=path+'.state.jsonl';assert.equal((await stat(statePath)).size,run.state_bytes);
  let rows=0,total=0n,xor=0n;const mask=(1n<<256n)-1n;
  const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
  for await(const row of jsonLines(statePath)){
    const digest=BigInt('0x'+createHash('sha256').update(JSON.stringify(canonical(row))).digest('hex'));
    total=(total+digest)&mask;xor^=digest;rows++;
  }
  const fingerprint={rows,sha256_sum:total.toString(16).padStart(64,'0'),sha256_xor:xor.toString(16).padStart(64,'0')};
  assert.deepEqual(fingerprint,run.state_sha256);
  verifiedOutputs.push({scenario:name,iteration:run.iteration,output_bytes:metadata.size,output_sha256:run.output_sha256,state:fingerprint});
  console.log(JSON.stringify({verified:name,iteration:run.iteration}));
}
const checkpoint=report=>{const rows=report.runs.map(run=>run.checkpoints.find(row=>row.records===25000));assert.ok(rows.every(row=>row?.route_events===228292));return {records:25000,route_events:228292,peak_rss_bytes:median(rows.map(row=>row.peak_rss_bytes)),seconds:median(rows.map(row=>row.seconds))};};
const measure=report=>Object.fromEntries(['seconds','peak_rss_bytes','records','route_events','active_routes','cached_routes','withdrawn_routes','serialization_seconds','writing_seconds','route_events_per_second'].map(key=>[key,median(report.runs.map(run=>run[key]))]));
const before=checkpoint(reports['trace-before']),after=checkpoint(reports['trace-after']);
const streamBefore=measure(reports['stream-before']),streamAfter=measure(reports['stream-after']);
const comparison={schema_version:'2.0',type:'full_state_benchmark',complete_rib_replay_succeeded:false,
  scope:'Fixed RIS rrc23 full RIB plus 12 consecutive updates; no prefix or peer filter. Three fresh serial processes per configuration.',
  input:{files:inputs.length,rib_records:sum(rib,'records'),rib_events:sum(rib,'events'),update_records:sum(updates,'records'),update_events:sum(updates,'events'),conservative_route_capacity_upper_bound:capacityUpperBound,configured_capacity:12000000},
  builds,instrumentation,checkpoint:{before,after,rss_ratio:after.peak_rss_bytes/before.peak_rss_bytes},
  full_attempt:{before:measure(reports['trace-before']),after:measure(reports['trace-after']),
    full_replay_throughput:null,complete_output_serialization_seconds:null,complete_output_writing_seconds:null,
    contract:'Both stop during RIB on explicit 1400 MiB RSS budget; different progress cannot be compared as complete-RIB peak memory or throughput. Zero partial output costs are not complete-export measurements.'},
  updates_only:{before:streamBefore,after:streamAfter,elapsed_speedup:streamBefore.seconds/streamAfter.seconds,rss_ratio:streamAfter.peak_rss_bytes/streamBefore.peak_rss_bytes,
    equality_fields:equalityFields,equal:true,expected:{...Object.fromEntries(equalityFields.map(key=>[key,reference[key]]))},
    contract:'All 12 full UPDATE files, no RIB and updates_only baseline. Includes decompression, parsing, state analysis, bridge serialization, buffered notice writes and final-state export; not a full-table RIB benchmark.'},
  verification:{compiled_builds_reproduced:true,baseline_probe_append_only:true,input_hashes_checked:inputs.length,actual_completed_outputs:verifiedOutputs},
  source_revision_contract:'Raw report source_revision is the harness workspace HEAD; bridge_source_revision and bridge_sha256 bind the measured protocol build. It is not a measurement of later commits.'};
const parse={};
for(const side of ['before','after']){
  const report=await read(join(base,`parse-${side}.json`));assert.equal(report.repeats,3);
  assert.equal(report.bridge_sha256,side==='before'?builds.before_original:builds.after);
  assert.equal(report.bridge_source_revision,side==='before'?'2ea9935':'f63abe6');
  assert.equal(report.runs.length,6);assert.ok(report.runs.every(run=>run.exit_code===0));
  parse[side]=report.medians;
}
comparison.parse_only=parse;
const sanitize=value=>typeof value==='string'?value.replaceAll(root,'<workspace>').replaceAll(root.replaceAll('\\','/'),'<workspace>'):Array.isArray(value)?value.map(sanitize):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,child])=>[key,sanitize(child)])):value;
await mkdir(output,{recursive:true});
for(const name of names){const path=join(base,name,'report.json');await writeFile(join(output,name+'.json'),JSON.stringify({publication:{original_report_sha256:await hash(path),rewriting:'Only workspace absolute path prefix replaced with <workspace>; measurements retained.'},...sanitize(reports[name])},null,2)+'\n','utf8');}
for(const side of ['before','after'])await writeFile(join(output,`parse-${side}.json`),JSON.stringify(sanitize(await read(join(base,`parse-${side}.json`))),null,2)+'\n','utf8');
const failure=await read(join(base,'updates-before/report.json'));
assert.equal(failure.runs.length,1);assert.equal(failure.runs[0].complete,false);assert.equal(failure.runs[0].failure.kind,'process_failure');
await writeFile(join(output,'legacy-export-failure.json'),JSON.stringify({publication:{contract:'Earlier unsplit legacy state() export failed with native heap exhaustion; not included in the three successful chunked-export runs.'},...sanitize(failure)},null,2)+'\n','utf8');
await writeFile(join(output,'comparison.json'),JSON.stringify(comparison,null,2)+'\n','utf8');
console.log(JSON.stringify({published:output,checkpoint_rss_ratio:comparison.checkpoint.rss_ratio,updates_elapsed_speedup:comparison.updates_only.elapsed_speedup}));
