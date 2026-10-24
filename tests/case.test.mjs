import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';

const directory='cases/rrc23-path-change';
test('真实原始摘录具有固定哈希，窗口前历史建立局部基线并复现三个路径变化',async()=>{
  const spec=JSON.parse(await readFile(directory+'/case.json','utf8'));
  assert.equal(createHash('sha256').update(await readFile(directory+'/excerpt.mrt')).digest('hex'),spec.expected_excerpt_sha256);
  const common=['--prefix',spec.prefix,'--peer-asn',String(spec.peer_asn),'--from',String(spec.window.from),'--to',String(spec.window.to),directory+'/excerpt.mrt'];
  const run=mode=>{const result=spawnSync(process.execPath,['cli/mrtkit.mjs',mode,...common],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);return result.stdout;};
  const changes=run('changes').trim().split('\n').map(JSON.parse).filter(change=>change.kind==='path_change');
  assert.equal(changes.length,3);
  for(const [i,change]of changes.entries()){
    assert.equal(change.timestamp,spec.anchors[i].timestamp);assert.deepEqual(change.before.attributes.path,spec.anchors[i].before);assert.deepEqual(change.after.attributes.path,spec.anchors[i].after);
  }
  const stats=JSON.parse(run('stats'));assert.equal(stats.baseline_status,'updates_only');assert.equal(stats.warmup_records,'1');
  assert.equal(stats.announcements,'3');assert.equal(stats.path_changes,'3');assert.equal(stats.active_routes,1);
});

test('固定离线报告保留完整窗口统计、所有提醒与原始来源锚点，未包含机器路径',async()=>{
  const spec=JSON.parse(await readFile(directory+'/case.json','utf8'));
  const report=JSON.parse(await readFile(directory+'/report/report.json','utf8'));
  assert.deepEqual(report.collectors[0].summary,spec.expected_summary);assert.equal(report.rows,46);assert.equal(report.change_notices,93);
  const rows=[];
  const context=vm.createContext({MRTKitReceive:(_name,_type,_id,items)=>rows.push(...items)});
  for(const page of report.pages){const script=await readFile(directory+'/report/'+page.file,'utf8');assert.ok(!script.includes('C:\\\\Users\\\\'));vm.runInContext(script,context);}
  assert.equal(rows.length,report.rows);
  assert.equal(report.correlation.observations,93);assert.equal(report.correlation.groups,93);
  for(const dataset of Object.values(report.datasets))for(const page of [...dataset.pages,...dataset.indexes])assert.ok(!(await readFile(directory+'/report/'+page.file,'utf8')).includes('C:\\\\Users\\\\'));
  const changes=JSON.parse(JSON.stringify(rows.flatMap(row=>row.changes)));
  assert.equal(changes.length,93);
  for(const anchor of spec.anchors){
    const found=changes.find(change=>change.kind==='path_change'&&change.source.file===anchor.source.file&&change.source.record===anchor.source.record);
    assert.ok(found);assert.equal(found.source.offset,anchor.source.offset);assert.deepEqual(found.before.attributes.path,anchor.before);assert.deepEqual(found.after.attributes.path,anchor.after);
  }
});
