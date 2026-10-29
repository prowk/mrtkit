import {mkdir,readFile,writeFile,stat,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {readInvestigation,stableHash} from './investigation.mjs';
import {bundlePath,jsonLines} from './bundle.mjs';
import {reportDataset,safeJson} from './report-data.mjs';
import {fileHash,saveJson} from './archive.mjs';

export async function generateInvestigationReport(input,output,{pageSize=100,title='MRTKit 调查工作台',maxBytes=134217728,maxRows=200000}={}){
  const bundle=await readInvestigation(input),directory=resolve(output);await mkdir(directory,{recursive:false});let used=0;
  const datasets={},catalog=[],eventIds=new Set(),peers=new Set(),prefixes=new Set(),kinds=new Set(),points=new Set();
  for(const name of ['events','intervals','moas','findings','incidents','controls']){
    const dataset=await reportDataset(directory,name,{pageSize});datasets[name]=dataset.data;
    let ordinal=0;
    for await(const row of jsonLines(await bundlePath(bundle.directory,bundle.index.files[name].path))){used+=Buffer.byteLength(JSON.stringify(row));if(used>maxBytes||ordinal>=maxRows)throw new Error('报告生成超过行数或内存预算');
      if(name==='events'){if(eventIds.has(row.id))throw new Error('重复事件引用');eventIds.add(row.id);const collector=row.source?.collector??'',view=row.source?.view??'';
        const meta={ordinal,event_id:row.id,time_us:row.time_us,prefix:row.prefix,peer:row.peer,peer_asn:row.peer_asn,peer_ip:row.peer_ip,path_id:row.path_id??null,outbound:row.outbound,collector,view,kind:row.kind,kinds:[row.kind,...row.changes.map(change=>change.kind)],notices:row.changes.length,selected:row.selected,accepted:row.accepted};
        meta.notice_kinds=row.changes.map(change=>change.kind);catalog.push(meta);peers.add(row.peer);prefixes.add(row.prefix);points.add(JSON.stringify([collector,view]));for(const kind of meta.kinds)kinds.add(kind);
      }
      if(name==='findings'&&!eventIds.has(row.event_id)||name==='incidents'&&row.event_ids.some(id=>!eventIds.has(id)))throw new Error('调查引用不存在');
      await dataset.add(row);ordinal++;
    }await dataset.close();if(ordinal!==bundle.index.files[name].rows)throw new Error('报告与包计数不一致');
  }
  const indexes=[];await mkdir(join(directory,'catalog'));
  for(let start=0;start<catalog.length;start+=1024){const id=indexes.length,file=`catalog/index-${String(id).padStart(6,'0')}.js`,rows=catalog.slice(start,start+1024);await writeFile(join(directory,file),`globalThis.MRTKitReceive("catalog","index",${id},${safeJson(rows)});\n`,'utf8');indexes.push({id,file,start,rows:rows.length});}
  datasets.catalog={name:'catalog',rows:catalog.length,indexes,pages:[]};
  const objects={};for(const name of ['summary','comparison','initial'])objects[name]=JSON.parse(await readFile(await bundlePath(bundle.directory,bundle.index.files[name].path),'utf8'));
  // 初始状态独立分页，首屏只加载摘要和当前页。
  const initial=await reportDataset(directory,'initial',{pageSize});for(const row of objects.initial)await initial.add(row);await initial.close();datasets.initial=initial.data;delete objects.initial;
  const manifest={schema_version:'1.0',type:'investigation_report',title,status:bundle.index.status,data_version:bundle.index.data_version,window:bundle.index.window,
    rules:bundle.index.rules,quality:bundle.index.quality,core_quality:bundle.index.core_quality,inputs:bundle.index.inputs,datasets,...objects,
    filter_budget:{max_rows:maxRows,max_bytes:maxBytes,index_chunk_rows:1024,detail_cache_pages:2},options:{prefixes:[...prefixes].sort(),peers:[...peers].sort(),kinds:[...kinds].sort(),points:[...points].sort()},
    counting:'source_events_and_individual_change_notices',scope:'all',sequence_prefix:bundle.index.rules.sequence_prefix??null};
  await writeFile(join(directory,'manifest.js'),`globalThis.MRTKitInvestigation=JSON.parse(${safeJson(JSON.stringify(manifest))});\n`,'utf8');
  const compiled=await readFile(new URL('../_build/js/release/build/browser/browser.js',import.meta.url),'utf8'),match=/export \{([^}]+)\}\s*;?\s*$/.exec(compiled);if(!match||/^import /m.test(compiled))throw new Error('浏览器核心构建格式不支持，请重新构建');
  const exports=match[1].split(',').map(item=>{const [symbol,name]=item.trim().split(/\s+as\s+/);return `${JSON.stringify(name??symbol)}:${symbol}`;}).join(',');await writeFile(join(directory,'core.js'),`(()=>{\n${compiled.slice(0,match.index)}\nglobalThis.MRTKitCore={${exports}};\n})();\n`,'utf8');
  for(const [source,target]of [['investigation.html','index.html'],['investigation-app.js','app.js'],['investigation.css','style.css']])await writeFile(join(directory,target),await readFile(new URL(source,import.meta.url),'utf8'),'utf8');
  const resources=[];async function walk(path,prefix=''){for(const item of await readdir(path,{withFileTypes:true})){const name=prefix+item.name,target=join(path,item.name);if(item.isDirectory())await walk(target,name+'/');else resources.push({path:name,bytes:(await stat(target)).size,sha256:await fileHash(target)});}}await walk(directory);
  const receipt={schema_version:'1.0',type:'investigation_report',data_version:manifest.data_version,status:manifest.status,rows:catalog.length,resources,artifact_bytes:resources.reduce((sum,file)=>sum+file.bytes,0),artifact_hash:stableHash(resources)};await saveJson(join(directory,'report.json'),receipt);
  return {status:manifest.status,data_version:manifest.data_version,index:join(directory,'index.html'),rows:catalog.length,artifact_bytes:receipt.artifact_bytes};
}
