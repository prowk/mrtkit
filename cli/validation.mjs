import {readFile,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {isIP} from 'node:net';
import * as core from '../_build/js/release/build/bridge/bridge.js';
import {bundlePath,jsonLines} from './bundle.mjs';

export const MAX_SECOND=4294967295;
export const changeKinds=['path_change','origin_change','attribute_change','churn'];
export const observationKinds=[...changeKinds,'announce','withdraw','rib','reannounce','out_of_order','session_reset','observation_gap'];
export const pointId=point=>JSON.stringify([point.collector,point.view]);
export const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const nonnegative=value=>Number.isSafeInteger(value)&&value>=0;
const statuses=['complete','partial'];
const evidence=new WeakMap();
export const changeEvidence=change=>evidence.get(change);
export function validateWindow(window){
  if(!window||!nonnegative(window.from)||!nonnegative(window.to)||window.from>window.to||window.to>MAX_SECOND)throw new Error('结果包时间窗口无效');
  return window;
}
export function validateTimestamp(event,window=null){
  if(!nonnegative(event?.timestamp)||event.timestamp>MAX_SECOND||event.microseconds!==undefined&&(!nonnegative(event.microseconds)||event.microseconds>999999))throw new Error('明细秒或微秒时间无效');
  if(window&&(event.timestamp<window.from||event.timestamp>window.to))throw new Error('明细时间超出结果包时间窗口');
  return BigInt(event.timestamp)*1000000n+BigInt(event.microseconds??0);
}
export function validatePoints(points){
  if(!Array.isArray(points)||!points.length||points.length>128)throw new Error('结果包需要 1..128 个明确观测点');
  const seen=new Set();
  for(const point of points){
    if(typeof point?.collector!=='string'||!point.collector.trim()||typeof point.view!=='string'||!point.view.trim()||!statuses.includes(point.status))throw new Error('观测点身份或状态无效');
    if(seen.has(pointId(point)))throw new Error('观测点身份重复');seen.add(pointId(point));
    if(point.continuous!==undefined&&typeof point.continuous!=='boolean')throw new Error('观测连续性标志无效');
    if(!Array.isArray(point.gaps??[]))throw new Error('观测缺档必须为数组');
    for(const gap of point.gaps??[])if(!nonnegative(gap.from)||!nonnegative(gap.to)||gap.from>=gap.to||gap.to>MAX_SECOND+1)throw new Error('观测缺档时间无效');
    if(point.baseline_status!==undefined&&!['explicit_rib','updates_only','missing','unknown'].includes(point.baseline_status))throw new Error('观测基线状态无效');
    if(point.change_notices!==undefined&&!nonnegative(point.change_notices))throw new Error('提醒计数无效');
    if(point.status==='complete'&&point.change_notices===undefined&&point.changes_file!==undefined)throw new Error('完整观测点缺少提醒计数');
    if(point.summary!==undefined&&(!point.summary||typeof point.summary!=='object'||Array.isArray(point.summary)))throw new Error('统计对象无效');
    for(const [key,value]of Object.entries(point.summary??{})){
      if(['schema_version','baseline_status'].includes(key))continue;
      if(key==='mean_path_length'){if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new Error('平均路径长度无效');continue;}
      if(['warmup_records','records','skipped_records','ignored_families','rib_routes','announcements','withdrawals','path_changes','attribute_changes','origin_changes','duplicate_announcements','churn_alerts','out_of_order','session_resets','tracked_routes','active_routes','max_path_length'].includes(key)&&!(typeof value==='string'&&/^(0|[1-9]\d*)$/.test(value)||nonnegative(value)))throw new Error('统计计数无效');
    }
    if(point.summary?.schema_version!==undefined&&point.summary.schema_version!=='2.0')throw new Error('统计版本无效');
    if(point.summary?.active_routes>point.summary?.tracked_routes)throw new Error('活动状态超过缓存状态计数');
  }
}
export function validateIndex(index){
  if(index?.schema_version!=='2.0'||index.type!=='collector_replay_bundle'||!statuses.includes(index.status))throw new Error('结果包版本、类型或完整状态无效');
  validateWindow(index.window);validatePoints(index.collectors);
  if(index.status==='complete'&&index.collectors.some(point=>point.status!=='complete'))throw new Error('整体与观测点完整状态不一致');
  return index;
}
export function validateSource(source,point){
  if(!source||source.collector!==point.collector||source.view!==point.view)throw new Error('明细来源身份不一致');
  if(typeof source.file!=='string'||!source.file||typeof source.record!=='string'||typeof source.offset!=='string'||!/^[1-9]\d*$/.test(source.record)||!/^(0|[1-9]\d*)$/.test(source.offset)||BigInt(source.record)>9223372036854775807n||BigInt(source.offset)>9223372036854775807n||!nonnegative(source.event_index)||source.event_index>2147483647)throw new Error('明细来源位置无效');
}
function peer(event){
  if(!nonnegative(event.peer_asn)||event.peer_asn>MAX_SECOND||!isIP(event.peer_ip??'')||typeof event.outbound!=='boolean'||event.path_id!==undefined&&(!nonnegative(event.path_id)||event.path_id>MAX_SECOND))throw new Error('明细 peer 或路径身份无效');
}
function prefix(event){
  if(typeof event.prefix!=='string'||JSON.parse(core.canonical_prefix(event.prefix)).prefix!==event.prefix)throw new Error('明细前缀无效或未规范化');
}
function snapshot(value,point){
  if(!value||typeof value.active!=='boolean'||!value.attributes||typeof value.attributes!=='object')throw new Error('变化前后状态无效');
  validateTimestamp(value);if(value.source)validateSource(value.source,point);
}
export function validateChange(change,point,window=null){
  if(change?.schema_version!=='2.0'||!changeKinds.includes(change.kind))throw new Error('变化版本或类型无效');
  validateTimestamp(change,window);peer(change);prefix(change);validateSource(change.source,point);
  if(change.before!==undefined&&change.before!==null)snapshot(change.before,point);snapshot(change.after,point);
  if(validateTimestamp(change.after)!==validateTimestamp(change))throw new Error('变化时间与后状态时间不一致');
  if(change.after.source&&['file','record','offset','event_index','collector','view'].some(key=>change.after.source[key]!==change.source[key]))throw new Error('变化与后状态来源不一致');
  if(change.kind==='churn'&&(!nonnegative(change.churn_count)||change.churn_count<2))throw new Error('波动计数无效');
  const semantic=JSON.parse(core.correlation_semantics_from_json(JSON.stringify(change))),expected=semantic.key;
  if(semantic.error)throw new Error('关联键前后语义无效: '+semantic.error);
  if(change.correlation_key!==undefined){
    let actual;try{actual=JSON.parse(change.correlation_key);}catch{throw new Error('关联键不是有效 JSON');}
    if(JSON.stringify(canonical(actual))!==JSON.stringify(canonical(expected)))throw new Error('关联键与变化前后语义不一致');
  }
  const result=change.correlation_key===undefined?{...change,correlation_key:JSON.stringify(expected)}:change;
  evidence.set(result,semantic);return result;
}
export function validateObservation(entry,point,window){
  if(!observationKinds.includes(entry?.kind))throw new Error('观测类型无效');
  validateTimestamp(entry,window);prefix(entry);
  if(entry.source)validateSource(entry.source,point);
  if(entry.peer_asn!==undefined)peer(entry);
  if(!Array.isArray(entry.changes))throw new Error('观测缺少变化数组');
  for(const change of entry.changes){validateChange(change,point,window);
    if(validateTimestamp(change)!==validateTimestamp(entry)||['prefix','peer_asn','peer_ip','outbound','path_id'].some(key=>change[key]!==entry[key])||JSON.stringify(canonical(change.source))!==JSON.stringify(canonical(entry.source)))throw new Error('观测与嵌套变化来源或身份不一致');}
}
const addHash=(hash,value)=>hash.update(JSON.stringify(canonical(value))+'\n');
async function artifact(directory,point,kind,signal){
  const name=point[kind+'_file'],expected=point[kind+'_sha256'];
  if(name===undefined){if(expected!==undefined)throw new Error('哈希缺少对应明细');return null;}
  if(expected!==undefined&&(typeof expected!=='string'||!/^[0-9a-f]{64}$/i.test(expected)))throw new Error('非法明细 SHA-256');
  let path;try{path=await bundlePath(directory,name);}catch(error){if(point.status==='partial'&&error.code==='ENOENT')return null;throw error;}
  if(!(await stat(path)).isFile())throw new Error('明细路径不是文件');
  if(expected!==undefined){const hash=createHash('sha256');for await(const chunk of createReadStream(path)){signal?.throwIfAborted();hash.update(chunk);}if(hash.digest('hex')!==expected.toLowerCase())throw new Error('明细哈希不一致');}
  return path;
}

// 所有入口使用同一校验：旧 schema 2.0 可缺可选哈希和关联键，键由核心重算。
export async function validateBundle(input,options={}){
  const path=resolve(input);
  if((await stat(path)).size>16777216)throw new Error('结果包索引超过 16 MiB');
  return validateBundleData(JSON.parse(await readFile(path,'utf8')),dirname(path),options);
}

// 生产者在发布 complete 状态之前验证候选索引，消费者仍从磁盘读取相同规则。
export async function validateBundleData(index,directory,{onChange=()=>{},onTimeline=()=>{},onState,signal}={}){
  signal?.throwIfAborted();
  validateIndex(index);
  for(const point of index.collectors){
    const changes=await artifact(directory,point,'changes',signal),timeline=await artifact(directory,point,'timeline',signal),state=await artifact(directory,point,'state',signal);
    if(!changes&&point.status==='complete')throw new Error('完整观测点缺少变化明细');
    let count=0;const changeHash=createHash('sha256');
    if(changes)for await(const raw of jsonLines(changes)){signal?.throwIfAborted();const change=validateChange(raw,point,index.window);addHash(changeHash,change);count++;await onChange(change,point,{timeline:Boolean(timeline)});}
    const digest=changeHash.digest('hex');
    if(point.change_notices!==undefined&&changes&&count!==point.change_notices)throw new Error('提醒计数与明细不一致');
    if(timeline){
      if((await stat(timeline)).size>67108864)throw new Error('单个时间线报告超过 64 MiB');
      const report=JSON.parse(await readFile(timeline,'utf8'));
      if(report.timeline?.schema_version!=='2.0'||!Array.isArray(report.timeline.entries))throw new Error('时间线版本或明细无效');
      for(const [key,value]of Object.entries(point.summary??{}))if(report.summary?.[key]!==value)throw new Error('时间线和索引统计不一致');
      let notices=0;const timelineHash=createHash('sha256');
      for(const entry of report.timeline.entries){validateObservation(entry,point,index.window);for(const raw of entry.changes){addHash(timelineHash,validateChange(raw,point,index.window));notices++;}}
      if(changes&&(notices!==count||timelineHash.digest('hex')!==digest))throw new Error('时间线与变化明细不一致');
      if(point.change_notices!==undefined&&notices!==point.change_notices)throw new Error('时间线提醒计数不一致');
      for(const entry of report.timeline.entries)await onTimeline(entry,point,{changes:Boolean(changes)});
    }
    if(state){let rows=0,active=0;for await(const event of jsonLines(state)){signal?.throwIfAborted();if(event.schema_version!=='2.0'||!['active','withdrawn'].includes(event.action))throw new Error('最终状态版本或类型无效');validateTimestamp(event,{from:0,to:index.window.to});prefix(event);peer(event);validateSource(event.source,point);rows++;if(event.action==='active')active++;if(onState)await onState(event,point,rows);}
      if(point.status==='complete'&&(point.summary?.tracked_routes!==undefined&&rows!==point.summary.tracked_routes||point.summary?.active_routes!==undefined&&active!==point.summary.active_routes))throw new Error('最终状态数量不一致');}
  }
  return index;
}
