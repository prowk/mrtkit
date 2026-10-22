import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join,basename} from 'node:path';
import {replayManifest} from '../cli/multi.mjs';
import {generateReport} from '../cli/report.mjs';
import {jsonLines} from '../cli/bundle.mjs';
import {frames,inputChunks} from '../cli/input.mjs';

const args=process.argv.slice(2),at=args.indexOf('--output');
if(at<0||!args[at+1]||args.length!==2)throw new Error('用法: node scripts/reproduce_case.mjs --output 新结果包目录');
const root=resolve('.'),spec=JSON.parse(await readFile('cases/rrc23-path-change/case.json','utf8'));
await mkdir(join(root,'.validation'),{recursive:true});
const temporary=await mkdtemp(join(root,'.validation','real-case-input-'));
const manifest={schema_version:'1.0',window:spec.window,analysis:{prefix:spec.prefix,peer_asn:spec.peer_asn,threshold:3},
  collectors:[{collector:spec.collector,view:spec.view,continuous:false,
    files:spec.sources.map(source=>({path:join(root,'.validation/archives',source.file),kind:source.kind==='rib'?'rib':'update',
      from:source.from_time,to:source.to_time,sha256:source.sha256,url:source.url}))}]};
const manifestPath=join(temporary,'manifest.json');await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n','utf8');
await replayManifest(manifestPath,args[at+1]);
const output=resolve(args[at+1]),index=JSON.parse(await readFile(join(output,'index.json'),'utf8')),point=index.collectors[0];
assert.deepEqual(point.summary,spec.expected_summary);
const changes=[];for await(const change of jsonLines(join(output,point.changes_file)))changes.push(change);
assert.equal(changes.length,spec.expected_notice_count);
const normalized=source=>{const {collector,view,...rest}=source;return {...rest,file:basename(rest.file)};};
for(const expected of spec.anchors){
  const found=changes.find(change=>change.kind==='path_change'&&change.timestamp===expected.timestamp&&change.source.record===expected.source.record&&basename(change.source.file)===expected.source.file);
  assert.ok(found,'缺少固定路径变化锚点');
  assert.deepEqual(normalized(found.source),expected.source);
  assert.deepEqual(normalized(found.before.source),expected.before_source);
  assert.deepEqual(found.before.attributes.path,expected.before);assert.deepEqual(found.after.attributes.path,expected.after);
}
const states=[];for await(const state of jsonLines(join(output,point.state_file)))states.push(state);
assert.equal(states.length,1);assert.equal(states[0].timestamp,spec.expected_final_state.timestamp);
assert.equal(states[0].action,spec.expected_final_state.action);assert.deepEqual(states[0].attributes.path,spec.expected_final_state.path);
assert.deepEqual(normalized(states[0].source),spec.expected_final_state.source);

// 原样提取四个 BGP 记录；不改写属性、时间戳或原始字节，侧表保留原档案位置。
const wanted=new Map();
for(const anchor of spec.anchors)for(const source of [anchor.before_source,anchor.source])wanted.set(JSON.stringify([source.file,source.record]),source);
const records=[];
for(const source of spec.sources){
  const selected=[...wanted.values()].filter(item=>item.file===source.file);if(!selected.length)continue;
  let ordinal=0;
  for await(const frame of frames(inputChunks(join(root,'.validation/archives',source.file)))){
    ordinal++;const match=selected.find(item=>item.record===String(ordinal));if(!match)continue;
    assert.equal(String(frame.offset),match.offset);records.push({source:match,bytes:Buffer.from(frame.data)});
  }
}
assert.equal(records.length,wanted.size);
const excerpt=Buffer.concat(records.map(record=>record.bytes)),sha256=createHash('sha256').update(excerpt).digest('hex');
if(spec.expected_excerpt_sha256)assert.equal(sha256,spec.expected_excerpt_sha256);
await writeFile(join(output,'excerpt.mrt'),excerpt);
let offset=0;const mapping=records.map((record,index)=>{const entry={excerpt_record:index+1,excerpt_offset:offset,bytes:record.bytes.length,original:record.source};offset+=record.bytes.length;return entry;});
await writeFile(join(output,'excerpt-map.json'),JSON.stringify({sha256,scope:'four unchanged BGP records, not a complete baseline or continuous archive',records:mapping},null,2)+'\n','utf8');
const html=await generateReport(join(output,'index.json'),output+'-html',{title:'RIS rrc23 · 183.90.160.0/24 路径复盘',sourceLabels:Object.fromEntries(point.files.map(file=>[file.path,basename(file.path)]))});
const receipt={schema_version:'2.0',case:'ris-rrc23-183.90.160.0-24',matched:true,
  source_files:point.files.map(file=>({file:basename(file.path),sha256:file.sha256,records:file.records})),
  summary:point.summary,anchors_checked:spec.anchors.length,change_notices:changes.length,excerpt_sha256:sha256,
  html_rows:html.rows,html_change_notices:html.change_notices,interpretation:spec.interpretation};
await writeFile(join(output,'case-verification.json'),JSON.stringify(receipt,null,2)+'\n','utf8');
console.log(JSON.stringify(receipt));
