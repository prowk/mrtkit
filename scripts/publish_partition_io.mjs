import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const base='.validation/partition-io-profile',report=JSON.parse(await readFile(base+'/report.json','utf8'));
const checks=[];
for(const size of [8,64]){const values=[];for(const file of await readdir(base+'/handles-'+size)){const hash=createHash('sha256');for await(const bytes of createReadStream(base+'/handles-'+size+'/'+file))hash.update(bytes);values.push(hash.digest('hex'));}checks.push(values.sort());}
assert.deepEqual(checks[0],checks[1]);assert.equal(report.results[0].records,report.results[1].records);assert.equal(report.results[0].events,report.results[1].events);assert.equal(report.results[0].bytes,report.results[1].bytes);
await writeFile('docs/validation/partition-io-profile.json',JSON.stringify({...report,actual_partition_hash_multisets_equal:true,partition_file_hashes:checks[0]},null,2)+'\n','utf8');
const stopped='.validation/full-replay-v020',stop=JSON.parse((await readFile(stopped+'/controlled-stop.json','utf8')).replace(/^\uFEFF/,''));
const note={schema_version:'2.0',status:'partial',reason:'operator_cancelled_for_measured_handle_churn_tuning',completed_replay:false,
  last_observed_stderr_progress:{records:225000,route_events:2064825,partitions:32,rss:114102272},
  interpretation:'Progress is a lower bound before controlled termination; no EOF, full state residency or final export was completed. Budgets were not relaxed.',
  process_resources:stop.resources.map(({Id,...rest})=>rest)};
const index=JSON.parse(await readFile(stopped+'/run-1/index.json','utf8'));index.status='partial';index.collectors[0].status='partial';index.collectors[0].error=note.reason;index.controlled_stop=note;
await writeFile(stopped+'/run-1/index.json',JSON.stringify(index,null,2)+'\n','utf8');
const original=JSON.parse(await readFile(stopped+'/report.json','utf8'));original.complete=false;original.controlled_stop=note;await writeFile(stopped+'/report.json',JSON.stringify(original,null,2)+'\n','utf8');
await writeFile('docs/validation/full-replay-controlled-stop.json',JSON.stringify(note,null,2)+'\n','utf8');
console.log(JSON.stringify({tuning_verified:true,prior_attempt_completed:false,partition_hashes:checks[0].length}));
