import {readFile,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import {resolve} from 'node:path';

const sources=JSON.parse(await readFile('cases/rrc23-path-change/case.json','utf8')).sources;
const comparison=JSON.parse(await readFile('docs/validation/archive-comparison.json','utf8'));
for(const source of sources){const hash=createHash('sha256');for await(const chunk of createReadStream(resolve('.validation/archives',source.file)))hash.update(chunk);if(hash.digest('hex')!==source.sha256)throw new Error('完整回放目标输入哈希错误');}
const counts=comparison.samples.filter(row=>row.collector==='ris-rrc23');
const result={schema_version:'2.0',type:'full_replay_resource_target',fixed_before_new_implementation:true,recorded_at:new Date().toISOString(),
  source_revision:spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).stdout.trim(),
  workload:{collector:'ris-rrc23',prefix_filter:null,peer_filter:null,window:{from:1735689600,to:1735693199},sources,
    expected_input_records:counts.reduce((sum,row)=>sum+row.records,0),expected_route_events:counts.reduce((sum,row)=>sum+row.events,0),expected_state_events:counts.reduce((sum,row)=>sum+row.state_events,0),capacity:12000000},
  hardware:{cpu:os.cpus()[0].model.trim(),logical_cpus:os.cpus().length,total_memory_bytes:os.totalmem(),free_memory_bytes:os.freemem(),platform:os.platform(),release:os.release(),node:process.version},
  budgets:{peak_rss_bytes:2147483648,new_temporary_and_output_disk_bytes:128849018880,seconds_per_round:7200,repeats:3},
  success:['All 13 original archives hashed and decoded to EOF; no prefix or peer reduction','Full explicit baseline, warmup and inclusive analysis window completed','All logical route state retained, with disk storage allowed and no silent eviction','Complete notice output and final-state export, byte counts and fingerprints recorded','Three successful rounds within declared RSS, disk and elapsed budgets','Independent small complete in-memory reference equality plus auditable full input, counters and state verification'],
  cost_domains:['original framing/decompression/protocol decoding','disk partition materialization','route-state analysis and residency','change serialization and writes','final-state serialization and writes'],
  failure_contract:'Keep failed-round evidence and leave the full-replay completion item unchecked. Earlier 1400 MiB RIB failures remain historical failures.'};
await writeFile('docs/validation/state-resource-target.json',JSON.stringify(result,null,2)+'\n','utf8');
console.log(JSON.stringify({fixed_target:true,records:result.workload.expected_input_records,events:result.workload.expected_route_events,budgets:result.budgets}));
