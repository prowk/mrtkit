import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const report=JSON.parse(await readFile('.validation/v020-profile/report.json','utf8'));
const rebuilt=await readFile('.validation/v020-profile/reproduced/_build/js/release/build/bridge/bridge.js'),probe=await readFile('.validation/v020-profile/bridge.mjs');
assert.equal(digest(rebuilt),report.original_bridge_sha256);assert.equal(digest(probe),report.probe_sha256);assert.ok(probe.subarray(0,rebuilt.length).equals(rebuilt));
const median=values=>[...values].sort((a,b)=>a-b)[1];
const summary=[];
for(const name of ['rib_checkpoint','updates_complete']){
  const runs=report.runs.filter(row=>row.scenario===name);assert.equal(runs.length,3);
  for(const run of runs)assert.deepEqual(run.counts,runs[0].counts);
  summary.push({scenario:name,records:runs[0].records,full_input_eof:name==='updates_complete',counts:runs[0].counts,
    baseline_heap_bytes:median(runs.map(row=>row.baseline.heapUsed)),
    components:runs[0].steps.map((step,i)=>({component:step.component,retained_heap_delta_bytes:median(runs.map(row=>row.steps[i].reclaimed_heap_bytes)),retained_array_buffer_delta_bytes:median(runs.map(row=>row.steps[i].reclaimed_array_buffer_bytes))})),
    export:{rows:128,json_bytes:runs[0].export.json_bytes,retained_heap_bytes:median(runs.map(row=>row.export.retained_heap_bytes))}});
}
const published={...report,publication:{fixed_commit_rebuild_matched:true,probe_append_only:true,
  resource_target_sha256:digest(await readFile('docs/validation/state-resource-target.json')),
  profile_driver_sha256:digest(await readFile('scripts/profile_state.mjs'))},medians:summary};
await writeFile('docs/validation/state-components.json',JSON.stringify(published,null,2)+'\n','utf8');
console.log(JSON.stringify({published:true,component_scenarios:summary.map(row=>({scenario:row.scenario,heap:row.baseline_heap_bytes}))}));
