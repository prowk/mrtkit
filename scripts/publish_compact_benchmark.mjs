import {readFile,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const args=process.argv.slice(2);if(args.length&&!(args.length===2&&args[0]==='--input'))throw new Error('用法: [--input 已完成测量目录]');
const directory=args[1]??'.validation/compact-v020-verified',report=JSON.parse(await readFile(join(directory,'report.json'),'utf8'));
const digest=async file=>{const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');};
assert.equal(report.complete,true);assert.equal(report.runs.length,6);
for(const [file,hash]of Object.entries(report.source_sha256))assert.equal(await digest(file),hash);
for(const row of report.runs){assert.equal(await digest(join(directory,`${row.encoding}-${row.iteration}.jsonl`)),row.sha256);assert.equal(row.expanded_sha256,report.runs[0].expanded_sha256);assert.deepEqual(row.kinds,report.runs[0].kinds);}
const median=values=>values.sort((a,b)=>a-b)[1],summary={};
for(const encoding of ['full_jsonl_v1','event_refs_v1']){const runs=report.runs.filter(row=>row.encoding===encoding);summary[encoding]={bytes:runs[0].bytes,contexts:runs[0].contexts,median_seconds:median(runs.map(row=>row.seconds)),max_rss_bytes:Math.max(...runs.map(row=>row.peak_rss_bytes))};}
const evidence={...report,code_committed_as:'282b73b',source_byte_hashes_are_authoritative:true,concurrent_workloads:'Full disk replay and later independent reference-model processes shared the machine; results are measured elapsed times, not isolated throughput claims.',verified_output_hashes:true,summary,saved_fraction:1-summary.event_refs_v1.bytes/summary.full_jsonl_v1.bytes};
await writeFile('docs/validation/compact-output.json',JSON.stringify(evidence,null,2)+'\n','utf8');console.log(JSON.stringify(summary));
