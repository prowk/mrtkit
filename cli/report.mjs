import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {validateIndex,validateBundle} from './validation.mjs';
import {correlation_semantics_from_json} from '../_build/js/release/build/bridge/bridge.js';
import {reportDataset,safeJson,sourceId} from './report-data.mjs';
import {reportCorrelation} from './report-correlation.mjs';

export async function generateReport(input,output,{pageSize=200,title='MRTKit 路由观测复盘',sourceLabels=null,correlation=null}={}){
  if(!Number.isInteger(pageSize)||pageSize<1||pageSize>1000)throw new Error('报告页大小须为 1..1000');
  const inputPath=resolve(input),index=JSON.parse(await readFile(inputPath,'utf8'));validateIndex(index);
  const directory=resolve(output);await mkdir(directory,{recursive:false});
  const events=await reportDataset(directory,'data',{pageSize});
  const manifest={schema_version:'2.0',type:'offline_route_report',title,status:'building',input_status:index.status,
    source_path_policy:sourceLabels?'explicit_archive_labels':'original_input_paths',
    ordering:'collector_manifest_order_then_collector_timeline_or_change_input_order',interpretation:index.interpretation,window:index.window,rows:0,change_notices:0,pages:[],datasets:{events:events.data},
    filter_index:{encoding:'delta_varint_base64_postings_v1',chunk_rows:8192,result_storage:'one_bit_per_row',detail_cache:'one_render_page'},
    collectors:index.collectors.map(point=>({collector:point.collector,view:point.view,status:point.status,baseline_status:point.baseline_status??'unknown',continuous:point.continuous??false,gaps:point.gaps??[],summary:point.summary??null,error:point.error??null}))};
  const labeled=value=>Array.isArray(value)?value.map(labeled):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,child])=>[key,key==='file'&&value.record!==undefined&&value.offset!==undefined&&sourceLabels&&Object.hasOwn(sourceLabels,child)?sourceLabels[child]:labeled(child)])):value;
  async function add(row){
    // 展示规范化结果由 MoonBit 核心提供，原始结构保留供来源追溯。
    const notices=row.row_type==='change_notice'?[row]:row.changes??[],first=notices[0];
    if(first){const semantic=JSON.parse(correlation_semantics_from_json(JSON.stringify(first)));if(semantic.error)throw new Error(semantic.error);row={...row,semantic};}
    row={...row,event_source_id:sourceId(row.source)};
    if(sourceLabels)row=labeled(row);await events.add(row);
  }
  try{
    await validateBundle(inputPath,{
      onChange:async(change,point,files)=>{manifest.change_notices++;if(!files.timeline)await add({...change,row_type:'change_notice',collector:point.collector,view:point.view});},
      onTimeline:async(entry,point,files)=>{if(!files.changes)manifest.change_notices+=entry.changes.length;await add({...entry,row_type:'observation',collector:point.collector,view:point.view});},
    });
    await events.close();manifest.rows=events.data.rows;manifest.pages=events.data.pages;
    if(correlation){const groups=await reportDataset(directory,'groups',{pageSize}),observations=await reportDataset(directory,'observations',{pageSize});
      const visibleObservations={add:row=>observations.add(sourceLabels?labeled(row):row)};
      manifest.correlation=await reportCorrelation(resolve(correlation),inputPath,index,directory,groups,visibleObservations);await groups.close();await observations.close();manifest.datasets.groups=groups.data;manifest.datasets.observations=observations.data;
    }
    manifest.status='complete';
    await writeFile(join(directory,'manifest.js'),`globalThis.MRTKitManifest=JSON.parse(${safeJson(JSON.stringify(manifest))});\n`,'utf8');
    for(const [source,target]of [['report.html','index.html'],['report-app.js','app.js']])await writeFile(join(directory,target),await readFile(new URL(source,import.meta.url),'utf8'),'utf8');
    await writeFile(join(directory,'report.json'),JSON.stringify(manifest,null,2)+'\n','utf8');
  }catch(error){manifest.status='partial';manifest.error=error.message;await writeFile(join(directory,'report.json'),JSON.stringify(manifest,null,2)+'\n','utf8');throw error;}
  return {schema_version:'2.0',type:'offline_route_report',status:manifest.status,input_status:index.status,index:join(directory,'index.html'),rows:manifest.rows,change_notices:manifest.change_notices,pages:manifest.pages.length};
}

export async function reportCommand(argv){
  const options={};for(let i=0;i<argv.length;i+=2){if(!['--input','--output','--page-size','--title','--correlation'].includes(argv[i])||!argv[i+1]||options[argv[i]])throw new Error('report 用法: --input index.json --output 新目录 [--correlation 关联包/index.json] [--page-size 行数] [--title 标题]');options[argv[i]]=argv[i+1];}
  if(!options['--input']||!options['--output'])throw new Error('report 需要 --input 和 --output');
  return generateReport(options['--input'],options['--output'],{pageSize:Number(options['--page-size']??200),title:options['--title']??'MRTKit 路由观测复盘',correlation:options['--correlation']});
}
