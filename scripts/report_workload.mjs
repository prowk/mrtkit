import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve,join,basename} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {jsonLines} from '../cli/bundle.mjs';
import {jsonlWriter} from '../cli/external-sort.mjs';
import {generateReport} from '../cli/report.mjs';

const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--output')throw new Error('用法: --output 新目录');
const targetBytes=await readFile('docs/validation/report-performance-target.json'),target=JSON.parse(targetBytes),directory=resolve(args[1]);await mkdir(directory,{recursive:false});
const input=resolve('.validation/fullstate/stream-after/output-1.jsonl'),hash=createHash('sha256');let bytes=0;
for await(const chunk of createReadStream(input)){hash.update(chunk);bytes+=chunk.length;}assert.equal(hash.digest('hex'),target.workload.source_output_sha256);assert.equal(bytes,target.workload.source_output_bytes);
const bundle=join(directory,'bundle');await mkdir(bundle);const writer=await jsonlWriter(join(bundle,'changes.jsonl')),sampleHash=createHash('sha256'),point={collector:'ris-rrc23',view:'default'};
const scoped=value=>Array.isArray(value)?value.map(scoped):value&&typeof value==='object'?Object.fromEntries([...Object.entries(value).map(([key,child])=>[key,key==='file'&&value.record!==undefined&&value.offset!==undefined?basename(child):scoped(child)]),...(value.file!==undefined&&value.record!==undefined&&value.offset!==undefined?Object.entries(point):[])]):value;
try{for await(const row of jsonLines(input)){sampleHash.update(JSON.stringify(row)+'\n');await writer.write(scoped(row));if(writer.rows===target.workload.notice_count)break;}}finally{await writer.close();}
const info=await writer.close();assert.equal(info.rows,target.workload.notice_count);
const index={schema_version:'2.0',type:'collector_replay_bundle',status:'partial',window:target.workload.window,collectors:[{...point,status:'partial',baseline_status:'updates_only',continuous:false,gaps:[],change_notices:info.rows,changes_file:'changes.jsonl',changes_sha256:info.sha256,error:'Fixed first 100000 notices for report performance only; truncated workload, not a complete replay.'}]};
await writeFile(join(bundle,'index.json'),JSON.stringify(index,null,2)+'\n','utf8');
const started=performance.now(),result=await generateReport(join(bundle,'index.json'),join(directory,'report'),{pageSize:200,title:'MRTKit · 100,000 条真实变化提醒性能验收'});
await writeFile(join(directory,'workload.json'),JSON.stringify({target_sha256:createHash('sha256').update(targetBytes).digest('hex'),source_sample_sha256:sampleHash.digest('hex'),scoped_input:info,generation_seconds:(performance.now()-started)/1000,generation_peak_rss_bytes:process.resourceUsage().maxRSS*1024,result},null,2)+'\n','utf8');
console.log(JSON.stringify(result));
