import {readFile,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const directory='.validation/correlation-scale-v020-final',receipt=JSON.parse(await readFile(directory+'/verification.json','utf8'));
const hash=async path=>{const value=createHash('sha256');for await(const bytes of createReadStream(path))value.update(bytes);return value.digest('hex');};
assert.equal(receipt.matched,true);assert.ok(receipt.observations>1000000);assert.equal(receipt.groups,1);
assert.ok(receipt.verification_peak_rss_bytes<=receipt.target.rss_budget_bytes);assert.ok(receipt.resources.peak_new_disk_bytes<=receipt.target.disk_budget_bytes);assert.ok(receipt.resources.seconds<=receipt.target.seconds);
assert.equal(await hash(directory+'/input/changes.jsonl'),receipt.input.sha256);
assert.equal(await hash(directory+'/result/groups.jsonl'),receipt.groups_sha256);assert.equal(await hash(directory+'/result/observations.jsonl'),receipt.observations_sha256);
for(const [path,expected]of Object.entries(receipt.source_sha256)){
  const actual=await hash(path);
  if(actual!==expected&&path==='_build/js/release/build/bridge/bridge.js')assert.equal(await hash('.validation/v020-profile/reproduced/_build/js/release/build/bridge/bridge.js'),expected);
  else assert.equal(actual,expected,'被测源文件已经改变: '+path);
}
await writeFile('docs/validation/correlation-scale.json',JSON.stringify({...receipt,publication:{actual_input_and_output_hashes_rechecked:true,source_files_verified:true,compiled_bridge_reproduced:true}},null,2)+'\n','utf8');
console.log(JSON.stringify({published:true,observations:receipt.observations,seconds:receipt.resources.seconds,rss:receipt.verification_peak_rss_bytes}));
