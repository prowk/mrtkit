import {mkdir,open,stat} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {frames,inputChunks} from './input.mjs';
import {bundlePath,jsonLines} from './bundle.mjs';
import {argumentsMap,positive,qualityCheck,validatePlan,jsonFile,saveJson,fileHash} from './archive.mjs';
import {hashText} from './archive-discovery.mjs';

export const checked=text=>{const value=JSON.parse(text);if(value.error)throw new Error(value.error);return value;};
export const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const stableHash=value=>hashText(JSON.stringify(canonical(value)));
export async function investigationBridge(){const url=new URL('../_build/js/release/build/bridge/bridge.js',import.meta.url);url.searchParams.set('session',randomUUID());return import(url);}

async function writeRows(directory,name,rows){const path=name+'.jsonl',stream=await open(join(directory,path),'wx');let count=0;try{for await(const row of rows){await stream.writeFile(JSON.stringify(row)+'\n','utf8');count++;}}finally{await stream.close();}return {path,sha256:await fileHash(join(directory,path)),bytes:(await stat(join(directory,path))).size,rows:count};}
async function writeObject(directory,name,value){const path=name+'.json';await saveJson(join(directory,path),value);return {path,sha256:await fileHash(join(directory,path)),bytes:(await stat(join(directory,path))).size};}

export async function investigate(manifestPath,rulesPath,outputPath,{allowPartial=false,full=false}={}){
  const plan=validatePlan(await jsonFile(manifestPath)),rules=await jsonFile(rulesPath),quality=await qualityCheck(manifestPath,{full}),directory=resolve(outputPath);
  if(rules.from_us!==plan.window.from_us||rules.to_us!==plan.window.to_us)throw new Error('规则与输入计划的半开窗口不一致');
  if(quality.status==='blocked'&&!allowPartial)throw new Error('输入检查存在阻断问题，先运行 check-input 查看诊断；可显式 --allow-partial true 排除有问题文件');
  const failures=new Set(quality.diagnostics.filter(d=>d.severity==='blocking'&&d.file).map(d=>JSON.stringify([d.collector,d.view,d.file])));
  const gaps=quality.diagnostics.filter(d=>d.code==='declared_gap').map(d=>({from_us:d.from_us,to_us:d.to_us,collector:d.collector,view:d.view}));
  for(const point of plan.collectors)for(const file of point.files)if(failures.has(JSON.stringify([point.collector,point.view,file.path]))&&file.kind==='update')gaps.push({from_us:file.from_us,to_us:file.to_us,collector:point.collector,view:point.view});
  rules.gaps=[...(rules.gaps??[]),...gaps].filter(gap=>BigInt(gap.from_us)<BigInt(plan.window.to_us)).map(gap=>({...gap,to_us:String(BigInt(gap.to_us)>BigInt(plan.window.to_us)?BigInt(plan.window.to_us):BigInt(gap.to_us))}));
  rules.continuous=rules.continuous===true&&plan.collectors.every(p=>p.continuous===true)&&quality.status!=='blocked';
  const bridge=await investigationBridge();checked(bridge.investigation_configure(JSON.stringify(rules)));
  await mkdir(directory,{recursive:false});
  const index={schema_version:'1.0',type:'investigation_bundle',status:'building',ordering:'event_order_v1',rules,window:plan.window,quality,inputs:[],files:{},interpretation:'collector_observations_not_hijack_verdict_or_business_outage'};
  await saveJson(join(directory,'index.json'),index);
  try{
    for(const point of plan.collectors)for(const file of point.files){
      const input={collector:point.collector,view:point.view,...file};index.inputs.push(input);if(failures.has(JSON.stringify([point.collector,point.view,file.path]))){input.status='excluded';continue;}
      const path=await bundlePath(dirname(resolve(manifestPath)),file.path),before=await stat(path);bridge.investigation_reset_file();let record=0;
      for await(const frame of frames(inputChunks(path))){record++;const mapping=file.source_map?.find(item=>item.excerpt_record===record);if(file.source_map&&!mapping)throw new Error('摘录来源侧表缺少记录');const origin=mapping?.original;checked(bridge.investigation_consume(frame.data,origin?.file??file.path,BigInt(origin?.record??record),BigInt(origin?.offset??frame.offset),point.collector,point.view,file.kind==='rib'));}
      const after=await stat(path);if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||await fileHash(path)!==file.sha256)throw new Error('输入在分析期间发生改变');input.status='read_to_eof';input.records=record;
    }
    const core=checked(bridge.investigation_finish());index.core_quality=core.quality;
    const expectedReminders=[...core.events.flatMap(row=>row.changes.map(change=>row.id+'|'+change.kind)),...core.findings.filter(row=>row.condition==='unexpected_origin').map(row=>row.id)].sort(),groupedReminders=core.incidents.flatMap(row=>row.reminder_ids).sort();
    if(JSON.stringify(expectedReminders)!==JSON.stringify(groupedReminders))throw new Error('调查归并前后提醒引用或计数不一致');
    index.reminder_counts={change_notices:core.summary.all.notices,unexpected_origin_clues:core.findings.filter(row=>row.condition==='unexpected_origin').length,grouped_reminders:groupedReminders.length};
    for(const name of ['events','selected','intervals','moas','findings','incidents','controls'])index.files[name]=await writeRows(directory,name,core[name]);
    for(const name of ['summary','comparison','initial'])index.files[name]=await writeObject(directory,name,core[name]);
    index.counts=Object.fromEntries(Object.entries(index.files).filter(([,file])=>file.rows!==undefined).map(([name,file])=>[name,file.rows]));
    index.status=quality.status==='ready'&&core.quality.baseline==='explicit_rib'&&!rules.gaps.length?'complete':'partial';
    index.data_version=stableHash({rules,inputs:index.inputs,files:index.files});await saveJson(join(directory,'index.json'),index);
    return {schema_version:'1.0',type:index.type,status:index.status,data_version:index.data_version,index:join(directory,'index.json'),counts:index.counts};
  }catch(error){index.status='failed';index.error=error.message;await saveJson(join(directory,'index.json'),index);throw error;}
}
export async function investigateCommand(argv){const args=argumentsMap(argv,['--manifest','--rules','--output','--allow-partial','--check']);if(!args['--manifest']||!args['--rules']||!args['--output'])throw new Error('investigate 需要 --manifest --rules --output');if(args['--check']&&!['quick','full'].includes(args['--check'])||args['--allow-partial']&&!['true','false'].includes(args['--allow-partial']))throw new Error('参数 --check quick/full，--allow-partial true/false');return investigate(args['--manifest'],args['--rules'],args['--output'],{allowPartial:args['--allow-partial']==='true',full:args['--check']==='full'});}

export async function readInvestigation(path){const index=await jsonFile(path);if(index.schema_version!=='1.0'||index.type!=='investigation_bundle'||!['complete','partial'].includes(index.status)||index.ordering!=='event_order_v1'||!/^[a-f0-9]{64}$/.test(index.data_version))throw new Error('无效或不兼容的调查结果包');
  if(stableHash({rules:index.rules,inputs:index.inputs,files:index.files})!==index.data_version)throw new Error('调查结果数据版本不匹配');
  const directory=dirname(resolve(path));for(const [name,file] of Object.entries(index.files)){const target=await bundlePath(directory,file.path);if(await fileHash(target)!==file.sha256||(await stat(target)).size!==file.bytes)throw new Error(`调查文件哈希或大小不符: ${name}`);}return {index,directory};}

export async function* selectedEvents(bundle,query={}){const bridge=await investigationBridge();checked(bridge.investigation_configure(JSON.stringify({...bundle.index.rules,query})));for await(const row of jsonLines(await bundlePath(bundle.directory,bundle.index.files.events.path))){if(checked(bridge.investigation_match(JSON.stringify(query),JSON.stringify(row))).matches)yield row;}}
const queryHash=query=>stableHash(query);
export async function queryInvestigation(path,query,{limit=100,cursor=null}={}){
  const bundle=await readInvestigation(path);let offset=0;const binding={data_version:bundle.index.data_version,query_hash:queryHash(query),ordering:bundle.index.ordering};
  if(cursor){let value;try{value=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}catch{throw new Error('无效查询游标');}if(Object.entries(binding).some(([key,item])=>value[key]!==item)||!Number.isSafeInteger(value.offset)||value.offset<0)throw new Error('游标与数据版本、查询或排序规则不匹配');offset=value.offset;}
  const rows=[];let skipped=0,more=false;for await(const row of selectedEvents(bundle,query)){if(skipped++<offset)continue;if(rows.length===limit){more=true;break;}rows.push(row);}
  return {schema_version:'1.0',...binding,status:bundle.index.status,quality:bundle.index.core_quality,rows,next_cursor:more?Buffer.from(JSON.stringify({...binding,offset:offset+rows.length})).toString('base64url'):null};
}
export async function queryCommand(argv){const args=argumentsMap(argv,['--input','--query','--limit','--cursor']);if(!args['--input'])throw new Error('query 需要 --input 调查包/index.json');return queryInvestigation(args['--input'],args['--query']?await jsonFile(args['--query']):{},{limit:positive(args['--limit'],100,1000),cursor:args['--cursor']});}

export async function exportInvestigation(path,query,outputPath,{evidence=false,maxBytes=67108864}={}){
  const bundle=await readInvestigation(path),rows=[];let bytes=0;for await(const row of selectedEvents(bundle,query)){bytes+=Buffer.byteLength(JSON.stringify(row));if(bytes>maxBytes||rows.length>=1000000)throw new Error('导出超过预算，请缩小查询范围');rows.push(row);}
  const bridge=await investigationBridge(),summary=checked(bridge.investigation_summary(JSON.stringify(bundle.index.rules),JSON.stringify(rows)));
  const output=resolve(outputPath);await mkdir(output,{recursive:false});const events=await writeRows(output,'events',rows);
  const metadata={schema_version:'1.0',type:evidence?'investigation_evidence':'investigation_export',status:bundle.index.status,data_version:bundle.index.data_version,query,rules:bundle.index.rules,quality:bundle.index.quality,core_quality:bundle.index.core_quality,inputs:bundle.index.inputs,summary,scope:'selected_excerpt_not_complete_archive_or_complete_baseline',counting:'unique_source_events_and_individual_change_notices',window:bundle.index.window,files:{events}};
  if(evidence){const ids=new Set(rows.map(row=>row.id)),prefixes=new Set(rows.map(row=>row.prefix)),peers=new Set(rows.map(row=>row.peer));for(const name of ['findings','incidents','moas','intervals','controls']){const selected=[];for await(const row of jsonLines(await bundlePath(bundle.directory,bundle.index.files[name].path))){if(name==='controls'||row.event_id&&ids.has(row.event_id)||row.event_ids?.some(id=>ids.has(id))||prefixes.has(row.prefix)&&(name==='moas'||peers.has(row.peer)))selected.push(row);}metadata.files[name]=await writeRows(output,name,selected);}}
  await saveJson(join(output,'index.json'),metadata);return {status:metadata.status,rows:rows.length,index:join(output,'index.json'),sha256:await fileHash(join(output,'index.json'))};
}
export async function exportCommand(argv,evidence=false){const args=argumentsMap(argv,['--input','--query','--output','--max-bytes']);if(!args['--input']||!args['--output'])throw new Error('export/evidence 需要 --input --output');return exportInvestigation(args['--input'],args['--query']?await jsonFile(args['--query']):{},args['--output'],{evidence,maxBytes:positive(args['--max-bytes'],67108864)});}

export async function verifyEvidence(path){const index=await jsonFile(path);if(index.type==='browser_investigation_evidence'&&index.schema_version==='1.0'){if(hashText(index.payload)!==index.sha256)throw new Error('浏览器证据哈希不符');const payload=JSON.parse(index.payload);if(payload.events.length!==payload.summary.events)throw new Error('浏览器证据计数不符');return {status:'verified',type:index.type,data_version:payload.data_version,rows:payload.events.length,scope:payload.scope};}if(index.schema_version!=='1.0'||!['investigation_evidence','investigation_export'].includes(index.type))throw new Error('不是证据摘录');for(const file of Object.values(index.files)){const target=await bundlePath(dirname(resolve(path)),file.path);if(await fileHash(target)!==file.sha256)throw new Error('证据摘录哈希不符');let count=0;for await(const row of jsonLines(target)){if(!row||typeof row!=='object')throw new Error('摘录行无效');count++;}if(count!==file.rows)throw new Error('证据摘录计数不符');}return {status:'verified',type:index.type,data_version:index.data_version,rows:index.files.events.rows,scope:index.scope};}
export async function verifyEvidenceCommand(argv){const args=argumentsMap(argv,['--input']);if(!args['--input'])throw new Error('verify-evidence 需要 --input');return verifyEvidence(args['--input']);}

export async function reindexCommand(argv){const args=argumentsMap(argv,['--input','--output']);if(!args['--input']||!args['--output'])throw new Error('reindex 需要 --input --output');const bundle=await readInvestigation(args['--input']),output=resolve(args['--output']);await mkdir(output,{recursive:false});let ordinal=0;async function* rows(){for await(const row of jsonLines(await bundlePath(bundle.directory,bundle.index.files.events.path)))yield {ordinal:ordinal++,id:row.id,time_us:row.time_us,prefix:row.prefix,peer:row.peer,path_id:row.path_id??null,kind:row.kind,notices:row.changes.length};}const file=await writeRows(output,'rows',rows()),index={schema_version:'1.0',type:'investigation_query_index',data_version:bundle.index.data_version,source_sha256:bundle.index.files.events.sha256,ordering:bundle.index.ordering,file};await saveJson(join(output,'index.json'),index);return {status:'rebuilt',data_version:index.data_version,rows:file.rows,index:join(output,'index.json')};}
