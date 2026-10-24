import {readFile,writeFile,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join,basename} from 'node:path';
import assert from 'node:assert/strict';
import {bundlePath} from '../cli/bundle.mjs';
import {canonical,validateIndex} from '../cli/validation.mjs';

const args=process.argv.slice(2),options={},references=[];
for(let i=0;i<args.length;i+=2){if(!['--input','--reference','--source-proof'].includes(args[i])||!args[i+1])throw new Error('用法: --input 三轮目录 --reference 独立核对.json [可重复] [--source-proof 源码快照收据.json]');if(args[i]==='--reference')references.push(args[i+1]);else{if(options[args[i]])throw new Error('选项重复');options[args[i]]=args[i+1];}}
if(!options['--input']||!references.length)throw new Error('需要三轮目录及至少一份独立核对收据');
const root=resolve('.'),directory=resolve(options['--input']),reportBytes=await readFile(join(directory,'report.json')),report=JSON.parse(reportBytes),targetBytes=await readFile('docs/validation/state-resource-target.json'),target=JSON.parse(targetBytes);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),same=(left,right)=>assert.deepEqual(canonical(left),canonical(right));
async function inspect(file,{expectedHash,expectedBytes,expectedRows}={}){const before=await stat(file),digest=createHash('sha256');let bytes=0,rows=0;
  for await(const chunk of createReadStream(file)){digest.update(chunk);bytes+=chunk.length;if(expectedRows!==undefined)for(let at=chunk.indexOf(10);at>=0;at=chunk.indexOf(10,at+1))rows++;}
  const after=await stat(file),actualHash=digest.digest('hex');assert.equal(before.size,after.size);assert.equal(before.mtimeMs,after.mtimeMs);if(expectedHash!==undefined)assert.equal(actualHash,expectedHash);if(expectedBytes!==undefined)assert.equal(bytes,expectedBytes);if(expectedRows!==undefined)assert.equal(rows,expectedRows);return {sha256:actualHash,bytes,rows};
}

assert.equal(report.complete,true);assert.equal(report.runs.length,target.budgets.repeats);assert.equal(report.target_sha256,hash(targetBytes));same(report.budgets,target.budgets);
for(const [file,expectedHash]of Object.entries(report.snapshot_sha256))await inspect(await bundlePath(join(directory,'snapshot'),file),{expectedHash});
assert.equal(hash(await readFile('scripts/full_replay_benchmark.mjs')),report.driver_sha256);
// 报告界面的修订可晚于测量；所有实际回放依赖和编译核心必须仍是被测字节。
for(const file of ['cli/disk-replay.mjs','cli/disk-replay-worker.mjs','cli/replay-resources.mjs','cli/multi.mjs','cli/validation.mjs','cli/compact-changes.mjs','cli/disk-storage.mjs','cli/input.mjs','cli/bundle.mjs','cli/external-sort.mjs','cli/diagnostics.mjs','scripts/full_replay_worker.mjs','_build/js/release/build/bridge/bridge.js'])await inspect(file,{expectedHash:report.snapshot_sha256[file]});
const independent=[];
for(const file of references){const value=JSON.parse(await readFile(file,'utf8'));assert.equal(value.matched,true);assert.equal(value.complete,true);assert.ok(['complete','partial'].includes(value.bundle_status));independent.push(value);}
const first=independent[0];
assert.equal(first.input_records,target.workload.expected_input_records);assert.equal(first.route_events,target.workload.expected_route_events);assert.equal(first.state_events,target.workload.expected_state_events);
same(first.sources,target.workload.sources.map(source=>({file:source.file,sha256:source.sha256})));
for(const value of independent){same(value.sources,first.sources);same(value.counts,first.counts);same(value.state_fingerprint,first.state_fingerprint);same(value.notice_fingerprint,first.notice_fingerprint);}
const bindings=[];
for(const [ordinal,run]of report.runs.entries()){
  assert.equal(run.iteration,ordinal+1);assert.equal(run.complete,true);assert.equal(run.accepted,true);assert.equal(run.exit_code,0);
  assert.ok(run.global_rss_upper_bound_bytes<=target.budgets.peak_rss_bytes);assert.ok(run.global_new_disk_peak_bytes<=target.budgets.new_temporary_and_output_disk_bytes);assert.ok(run.elapsed_seconds<=target.budgets.seconds_per_round);
  const runDirectory=join(directory,'run-'+run.iteration),index=validateIndex(JSON.parse(await readFile(join(runDirectory,'index.json'),'utf8'))),point=index.collectors[0];assert.equal(index.status,'complete');assert.equal(index.collectors.length,1);same(index.window,target.workload.window);same(point,run.point);
  assert.equal(index.analysis.capacity,target.workload.capacity);assert.equal(index.analysis.threshold,3);assert.equal(index.analysis.window_seconds,60);for(const key of ['prefix','peer_asn','path_id','asn'])assert.equal(index.analysis[key],undefined);
  assert.equal(point.collector,target.workload.collector);assert.equal(point.view,'default');assert.equal(point.files.length,target.workload.sources.length);
  assert.ok(point.files.every(file=>file.complete));assert.equal(point.files.reduce((count,file)=>count+file.records,0),target.workload.expected_input_records);
  for(const [i,source]of target.workload.sources.entries()){const file=point.files[i];assert.equal(file.sha256,source.sha256);assert.equal(file.bytes,source.bytes);assert.equal(file.kind,source.kind);assert.equal(basename(file.path),source.file);if(ordinal===0)await inspect(file.path,{expectedHash:source.sha256,expectedBytes:source.bytes});}
  same(point.summary,report.runs[0].point.summary);same(point.storage.state_fingerprint,report.runs[0].point.storage.state_fingerprint);assert.equal(point.storage.portable_changes_sha256,report.runs[0].point.storage.portable_changes_sha256);
  for(const key of ['records','warmup_records','skipped_records','ignored_families','announcements','withdrawals','path_changes','attribute_changes','origin_changes','duplicate_announcements','churn_alerts','out_of_order','session_resets'])assert.equal(BigInt(point.summary[key]),BigInt(first.counts[key]??0));
  assert.equal(BigInt(point.summary.rib_routes),0n);assert.equal(point.summary.baseline_status,'explicit_rib');assert.equal(point.summary.tracked_routes,first.tracked_routes);assert.equal(point.summary.active_routes,first.active_routes);assert.equal(point.summary.max_path_length,first.max_path_length);assert.ok(Math.abs(point.summary.mean_path_length-(first.path_samples?first.path_sum/first.path_samples:0))<1e-12);
  const reference=independent.find(value=>value.bundle_state_sha256===point.state_sha256&&value.bundle_changes_sha256===point.changes_sha256);
  assert.ok(reference,'该轮实际输出未绑定到独立核对；若顺序改变，请另行核对该轮后再发布');
  await inspect(await bundlePath(runDirectory,point.state_file),{expectedHash:point.state_sha256,expectedBytes:point.storage.output.state_bytes,expectedRows:reference.tracked_routes});
  await inspect(await bundlePath(runDirectory,point.changes_file),{expectedHash:point.changes_sha256,expectedBytes:point.storage.output.changes_bytes,expectedRows:reference.notice_fingerprint.rows});
  bindings.push({iteration:run.iteration,current_bundle_status:'complete',resource_accepted:true,state_sha256:point.state_sha256,changes_sha256:point.changes_sha256,independent_reference_matched:true,reference_original_bundle_status:reference.bundle_status});console.log(JSON.stringify({verified_iteration:run.iteration}));
}
const clean=value=>Array.isArray(value)?value.map(clean):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,child])=>[key,clean(child)])):typeof value==='string'?value.split(root).join('<workspace>'):value;
let provenance={};if(options['--source-proof']){const proof=JSON.parse(await readFile(options['--source-proof'],'utf8'));same(proof.model_source_sha256,first.source_sha256);provenance={model_source_sha256:proof.model_source_sha256,verification_source_sha256:proof.verification_source_sha256,source_snapshot_asset:proof.source_snapshot_asset,source_snapshot_sha256:proof.source_snapshot_sha256};}
// 已独立逐行核对的数据可按实际文件 SHA 绑定新轮次；不篡改旧参考尝试的资源失败状态。
const verified={schema_version:'2.0',type:'independent_full_replay_verification',matched:true,...provenance,scope:'All original inputs independently modeled; every accepted run bound by actual state/change file hashes and row counts to fully verified reference data. Historical reference resource status is preserved; current resource acceptance is checked separately.',independent_reference:first,accepted_runs:bindings};
const acceptance={...clean(report),raw_report_sha256:hash(reportBytes),verification:{original_input_hashes_rechecked:true,frozen_snapshot_hashes_verified:true,current_replay_dependency_hashes_verified:true,actual_output_hashes_and_rows_rechecked:true,independent_bindings:bindings},measurement_scope:'Replay controller, parent and serial peer children; unrelated validation tasks shared the machine and are not part of the replay process tree.'};
await writeFile('docs/validation/full-state-verified.json',JSON.stringify(verified,null,2)+'\n','utf8');await writeFile('docs/validation/full-replay-acceptance.json',JSON.stringify(acceptance,null,2)+'\n','utf8');console.log(JSON.stringify({accepted:true,repeats:report.runs.length,states:first.tracked_routes,notices:first.notice_fingerprint.rows}));
