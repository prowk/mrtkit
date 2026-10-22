import {readFile,writeFile,mkdir,open,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {resolve,dirname,join} from 'node:path';
import {frames,inputChunks} from './input.mjs';

const uint=(value,name)=>{if(!Number.isInteger(value)||value<0||value>4294967295)throw new Error(`${name} 必须为无符号秒时间戳`);return value;};
const checked=text=>{const value=JSON.parse(text);if(value.error)throw new Error(value.error);return value;};
async function digest(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}

// 身份来自显式配置，不依据路径名称猜测采集器；每个身份拥有独立的 MoonBit 会话。
export async function readManifest(path){
  const absolute=resolve(path),data=JSON.parse(await readFile(absolute,'utf8'));
  if(data.schema_version!=='1.0'||!Array.isArray(data.collectors)||!data.collectors.length||data.collectors.length>128)throw new Error('manifest 需要 schema_version 1.0 及 1..128 个观测点');
  const from=uint(data.window?.from,'window.from'),to=uint(data.window?.to,'window.to');
  if(from>to)throw new Error('manifest 时间窗口倒置');
  const identities=new Set();
  for(const group of data.collectors){
    if(typeof group.collector!=='string'||!group.collector.trim()||typeof group.view!=='string'||!group.view.trim())throw new Error('每个观测点需要非空 collector/view');
    const key=JSON.stringify([group.collector,group.view]);
    if(identities.has(key))throw new Error('collector/view 重复，请在同一观测点中合并文件');
    identities.add(key);
    if(!Array.isArray(group.files)||!group.files.length)throw new Error('观测点需要 files');
    let previous=-1,ribs=0;
    for(const [index,file] of group.files.entries()){
      if(!['rib','update'].includes(file.kind)||typeof file.path!=='string'||!file.path)throw new Error('文件需要 path 和 rib/update 类型');
      uint(file.from,'file.from');uint(file.to,'file.to');
      if(file.from>file.to||file.from<previous)throw new Error('文件时间范围倒置或未按开始时间排序');
      previous=file.from;
      if(file.kind==='rib'&&(index!==0||++ribs>1||file.to>from))throw new Error('最多一个初始 RIB，须放在首位且不晚于窗口');
      if(file.sha256!==undefined&&!/^[0-9a-f]{64}$/i.test(file.sha256))throw new Error('非法 SHA-256');
      file.path=resolve(dirname(absolute),file.path);
    }
    if(group.continuous!==undefined&&typeof group.continuous!=='boolean')throw new Error('continuous 必须为布尔值');
    for(const gap of group.gaps??[]){uint(gap.from,'gap.from');uint(gap.to,'gap.to');if(gap.from>=gap.to)throw new Error('缺档区间须开始早于结束');}
  }
  return {...data,window:{from,to},manifest_path:absolute};
}

function coverageGaps(group,window){
  const ranges=group.files.filter(file=>file.kind==='update').map(file=>[file.from,file.to]);
  const gaps=[...(group.gaps??[])];
  let covered=window.from;
  for(const [start,end] of ranges){if(end<window.from||start>window.to)continue;if(start>covered)gaps.push({from:covered,to:start,reason:'declared_file_gap'});covered=Math.max(covered,end+1);}
  if(covered<=window.to)gaps.push({from:covered,to:window.to+1,reason:'declared_file_gap'});
  return gaps;
}

export async function replayManifest(manifestPath,outputPath){
  const manifest=await readManifest(manifestPath),directory=resolve(outputPath);
  // 输出必须是新目录，防止覆盖已有分析和用户文件。
  await mkdir(directory,{recursive:false});
  const index={schema_version:'2.0',type:'collector_replay_bundle',status:'running',
    interpretation:'independent_collector_route_observations_not_business_outage',
    window:manifest.window,analysis:manifest.analysis??{},collectors:[]};
  const indexPath=join(directory,'index.json');
  const save=()=>writeFile(indexPath,JSON.stringify(index,null,2)+'\n','utf8');
  await save();
  for(const [ordinal,group] of manifest.collectors.entries()){
    const name=`collector-${String(ordinal+1).padStart(4,'0')}`;
    const result={collector:group.collector,view:group.view,status:'running',continuous:group.continuous===true,
      gaps:coverageGaps(group,manifest.window),files:[],changes_file:name+'.changes.jsonl',state_file:name+'.state.jsonl'};
    index.collectors.push(result);await save();
    const url=new URL('../_build/js/release/build/bridge/bridge.js',import.meta.url);url.searchParams.set('session',randomUUID());
    let bridge,changes;
    try{
      bridge=await import(url);
      const prefix=manifest.analysis?.prefix;
      const config={...manifest.analysis,mode:prefix?'timeline':'changes',format:'json',
        from_time:manifest.window.from,to_time:manifest.window.to,window_seconds:manifest.analysis?.window_seconds??60,
        threshold:manifest.analysis?.threshold??10,capacity:manifest.analysis?.capacity??1000000,
        collector:group.collector,view:group.view,continuous_observation:group.continuous===true,
        correlation_keys:true,
        observation_gaps:result.gaps.map(gap=>({from_time:gap.from,to_time:gap.to,from_micros:0,to_micros:0}))};
      checked(bridge.configure(JSON.stringify(config)));
      changes=await open(join(directory,result.changes_file),'wx');
      let noticeCount=0;
      for(const file of group.files){
        const sha256=await digest(file.path),initial=await stat(file.path);
        const metadata={...file,expected_sha256:file.sha256??null,sha256,bytes:initial.size,records:0,first_timestamp:null,last_timestamp:null};result.files.push(metadata);
        if(file.sha256&&file.sha256.toLowerCase()!==sha256)throw new Error(`SHA-256 不一致: ${file.path}`);
        bridge.reset_file();if(file.kind==='rib')checked(bridge.begin_baseline());
        try{
          for await(const frame of frames(inputChunks(file.path))){
            metadata.records++;
            const time=frame.data.readUInt32BE(0);
            if(time<file.from||time>file.to)throw new Error('记录时间超出声明的文件范围');
            if(file.kind==='update'&&frame.data.readUInt16BE(4)===13)throw new Error('UPDATE 输入中包含 RIB/peer 表');
            metadata.first_timestamp=metadata.first_timestamp===null?time:Math.min(metadata.first_timestamp,time);
            metadata.last_timestamp=metadata.last_timestamp===null?time:Math.max(metadata.last_timestamp,time);
            const batch=checked(bridge.consume_at(frame.data,file.path,BigInt(metadata.records),BigInt(frame.offset)));
            if(batch.lines.length){await changes.writeFile(batch.lines.join('\n')+'\n','utf8');noticeCount+=batch.lines.length;}
          }
          if(file.kind==='rib')checked(bridge.end_baseline());
          const final=await stat(file.path);if(final.size!==initial.size||final.mtimeMs!==initial.mtimeMs)throw new Error('输入文件在回放中发生改变');
        }catch(error){throw new Error(`${file.path} 记录 ${metadata.records}: ${error.message}`);}
      }
      const report=checked(bridge.finish());
      result.summary=report.summary??report;
      result.baseline_status=result.summary.baseline_status;
      if(report.timeline){
        result.timeline_file=name+'.timeline.json';
        await writeFile(join(directory,result.timeline_file),JSON.stringify(report,null,2)+'\n','utf8');
        for(const entry of report.timeline.entries)for(const change of entry.changes){await changes.writeFile(JSON.stringify(change)+'\n','utf8');noticeCount++;}
      }
      result.change_notices=noticeCount;
      result.changes_sha256=await digest(join(directory,result.changes_file));
      checked(bridge.state_export_begin());
      const state=await open(join(directory,result.state_file),'wx');
      try{for(;;){const rows=checked(bridge.state_export_chunk(128));if(!rows.length)break;await state.writeFile(rows.map(row=>JSON.stringify(row)).join('\n')+'\n','utf8');}}finally{await state.close();}
      result.state_sha256=await digest(join(directory,result.state_file));
      result.status='complete';
    }catch(error){result.status='partial';result.error=error.message;}
    finally{
      if(changes)await changes.close();
      if(bridge)bridge.configure(JSON.stringify({mode:'parse',format:'json',from_time:0,to_time:4294967295,window_seconds:60,threshold:2,capacity:1}));
      await save();
    }
  }
  index.status=index.collectors.every(group=>group.status==='complete')?'complete':'partial';await save();
  if(index.status!=='complete')throw new Error(`联合回放有部分结果，请检查 ${indexPath}`);
  return {schema_version:'2.0',type:'collector_replay_bundle',status:'complete',index:indexPath,collectors:index.collectors.length};
}

export async function multiCommand(argv){
  const options={};
  for(let i=0;i<argv.length;i+=2){if(!['--manifest','--output'].includes(argv[i])||!argv[i+1]||options[argv[i]])throw new Error('multi 用法: --manifest 配置.json --output 新输出目录');options[argv[i]]=argv[i+1];}
  if(!options['--manifest']||!options['--output'])throw new Error('multi 需要 --manifest 和 --output');
  return replayManifest(options['--manifest'],options['--output']);
}
