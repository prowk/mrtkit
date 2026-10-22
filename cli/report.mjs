import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,dirname,join} from 'node:path';
import {bundlePath,jsonLines} from './bundle.mjs';

const safeJson=value=>JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
async function verified(directory,name,expected){const path=await bundlePath(directory,name);if(expected){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);if(hash.digest('hex')!==expected)throw new Error('报告明细哈希不一致');}return path;}

// 页面数据独立分块；浏览器只缓存当前页，筛选索引只保留页号和行号。
export async function generateReport(input,output,{pageSize=200,title='MRTKit 路由观测复盘',sourceLabels=null}={}){
  if(!Number.isInteger(pageSize)||pageSize<1||pageSize>1000)throw new Error('报告页大小须为 1..1000');
  const inputPath=resolve(input),index=JSON.parse(await readFile(inputPath,'utf8'));
  if(index.schema_version!=='2.0'||index.type!=='collector_replay_bundle'||!['complete','partial'].includes(index.status)||!Array.isArray(index.collectors))throw new Error('报告需要明确完整/部分状态的回放结果包');
  if(!Number.isInteger(index.window?.from)||!Number.isInteger(index.window?.to)||index.window.from<0||index.window.from>index.window.to||index.window.to>4294967295)throw new Error('报告时间窗口无效');
  const identities=new Set();
  if(!index.collectors.length||index.collectors.length>128)throw new Error('报告需要 1..128 个明确观测点');
  for(const point of index.collectors){
    const identity=JSON.stringify([point.collector,point.view]);
    if(typeof point.collector!=='string'||!point.collector.trim()||typeof point.view!=='string'||!point.view.trim()||!['complete','partial'].includes(point.status)||identities.has(identity)||!Array.isArray(point.gaps??[]))throw new Error('报告观测点身份、状态或缺档无效');
    identities.add(identity);
  }
  const directory=resolve(output);await mkdir(directory,{recursive:false});await mkdir(join(directory,'data'));
  const manifest={schema_version:'2.0',type:'offline_route_report',title,status:'building',input_status:index.status,
    source_path_policy:sourceLabels?'explicit_archive_labels':'original_input_paths',
    ordering:'collector_manifest_order_then_collector_timeline_or_change_input_order',
    interpretation:index.interpretation,window:index.window,rows:0,change_notices:0,pages:[],
    collectors:index.collectors.map(point=>({collector:point.collector,view:point.view,status:point.status,
      baseline_status:point.baseline_status??'unknown',continuous:point.continuous??false,gaps:point.gaps??[],summary:point.summary??null,error:point.error??null}))};
  let pending=[],size=0;
  async function flush(){if(!pending.length)return;const id=manifest.pages.length;
    const facets={collectors:[...new Set(pending.map(row=>JSON.stringify([row.collector,row.view])))],
      prefixes:[...new Set(pending.map(row=>row.prefix??''))],peers:[...new Set(pending.flatMap(row=>[String(row.peer_asn??''),row.peer_ip??'']))],kinds:[...new Set(pending.flatMap(row=>[row.kind,...(row.changes??[]).map(change=>change.kind)]))]};
    const file=`data/page-${String(id).padStart(6,'0')}.js`;
    await writeFile(join(directory,file),`globalThis.MRTKitReceive(${id},JSON.parse(${safeJson(JSON.stringify(pending))}));\n`,'utf8');
    manifest.pages.push({id,file,rows:pending.length,facets});manifest.rows+=pending.length;pending=[];size=0;
  }
  const labeled=value=>Array.isArray(value)?value.map(labeled):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,child])=>[key,key==='file'&&value.record!==undefined&&value.offset!==undefined&&sourceLabels&&Object.hasOwn(sourceLabels,child)?sourceLabels[child]:labeled(child)])):value;
  async function add(row){if(!Number.isInteger(row.timestamp)||row.timestamp<0||row.timestamp>4294967295||typeof row.kind!=='string'||typeof row.prefix!=='string')throw new Error('报告明细缺少合法时间、前缀或类型');if(row.source&&(row.source.collector!==row.collector||row.source.view!==row.view))throw new Error('报告明细来源身份不一致');if(sourceLabels)row=labeled(row);const bytes=Buffer.byteLength(JSON.stringify(row));if(bytes>16777216)throw new Error('报告单条明细超过 16 MiB');if(pending.length&&(pending.length>=pageSize||size+bytes>1048576))await flush();pending.push(row);size+=bytes;}
  try{
    for(const point of index.collectors){
      const beforeCount=manifest.change_notices;
      if(point.timeline_file){
        const path=await verified(dirname(inputPath),point.timeline_file,point.timeline_sha256);
        if((await stat(path)).size>67108864)throw new Error('单个时间线报告超过 64 MiB；请缩小分析窗口，或使用不缓存观测历史的变化结果包');
        const report=JSON.parse(await readFile(path,'utf8'));
        if(report.timeline?.schema_version!=='2.0'||!Array.isArray(report.timeline.entries))throw new Error('时间线格式无效');
        for(const [key,value]of Object.entries(point.summary??{}))if(report.summary?.[key]!==value)throw new Error('时间线和索引统计不一致');
        for(const entry of report.timeline.entries){manifest.change_notices+=(entry.changes??[]).length;await add({...entry,row_type:'observation',collector:point.collector,view:point.view});}
      }else{
        let path;try{path=await verified(dirname(inputPath),point.changes_file,point.changes_sha256);}catch(error){if(point.status==='partial'&&error.code==='ENOENT')continue;throw error;}
        for await(const change of jsonLines(path)){manifest.change_notices++;await add({...change,row_type:'change_notice',collector:point.collector,view:point.view});}
      }
      if(typeof point.change_notices==='number'&&manifest.change_notices-beforeCount!==point.change_notices)throw new Error('报告提醒数量与 CLI 索引不一致');
    }
    await flush();manifest.status='complete';
    await writeFile(join(directory,'manifest.js'),`globalThis.MRTKitManifest=JSON.parse(${safeJson(JSON.stringify(manifest))});\n`,'utf8');
    await writeFile(join(directory,'index.html'),html,'utf8');
    await writeFile(join(directory,'app.js'),app,'utf8');
    await writeFile(join(directory,'report.json'),JSON.stringify(manifest,null,2)+'\n','utf8');
  }catch(error){manifest.status='partial';manifest.error=error.message;await writeFile(join(directory,'report.json'),JSON.stringify(manifest,null,2)+'\n','utf8');throw error;}
  return {schema_version:'2.0',type:'offline_route_report',status:manifest.status,input_status:index.status,
    index:join(directory,'index.html'),rows:manifest.rows,change_notices:manifest.change_notices,pages:manifest.pages.length};
}

export async function reportCommand(argv){
  const options={};for(let i=0;i<argv.length;i+=2){if(!['--input','--output','--page-size','--title'].includes(argv[i])||!argv[i+1]||options[argv[i]])throw new Error('report 用法: --input index.json --output 新目录 [--page-size 行数] [--title 标题]');options[argv[i]]=argv[i+1];}
  if(!options['--input']||!options['--output'])throw new Error('report 需要 --input 和 --output');
  return generateReport(options['--input'],options['--output'],{pageSize:Number(options['--page-size']??200),title:options['--title']??'MRTKit 路由观测复盘'});
}

const html=`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MRTKit 路由观测复盘</title>
<style>
:root{font-family:system-ui,"Microsoft YaHei",sans-serif;color:#172b39;background:#f3f6f8;font-size:15px}body{margin:0}header{background:#163749;color:#fff;padding:30px max(24px,calc((100vw - 1220px)/2))}header small{color:#a6dfe6;letter-spacing:.14em}h1{font-size:28px;font-weight:650;margin:10px 0}header p{color:#c3d3dd;margin:8px 0}main{max-width:1220px;margin:24px auto;padding:0 24px}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:20px 0}.card,section{background:#fff;border:1px solid #dfe7ec;border-radius:10px;padding:20px}.card strong{display:block;font-size:26px;margin-top:8px;color:#126873}.muted{color:#627886}.warning{background:#fff3d5;color:#74500a;border:1px solid #edcf89;padding:13px 18px;border-radius:8px;line-height:1.7}section{margin:18px 0}h2{font-size:18px;margin:0 0 16px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:12px 10px;border-bottom:1px solid #e7edf1;vertical-align:top;font-size:13px}th{color:#58707e;font-weight:600;white-space:nowrap}td.code,code{font-family:Consolas,monospace}label{display:flex;flex-direction:column;gap:7px;font-size:13px;color:#425b69}.filters{display:grid;grid-template-columns:1.2fr 1fr 1fr 1fr auto;gap:12px;align-items:end}input,select,button{font:inherit;padding:9px 11px;border:1px solid #c7d5de;border-radius:6px;background:#fff;min-width:0}button{cursor:pointer;background:#166773;color:white;border-color:#166773}button:disabled{opacity:.45;cursor:default}.pager{display:flex;gap:12px;align-items:center;justify-content:flex-end;margin:16px 0 0}.pager button{background:#fff;color:#166773}.scroll{overflow-x:auto}details{margin-top:6px}summary{cursor:pointer;color:#166773}pre{font:12px/1.55 Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:350px;overflow:auto;background:#f4f7f9;padding:12px;min-width:240px}.pill{display:inline-block;background:#e6f3f2;color:#1f6866;border-radius:4px;padding:3px 7px;white-space:nowrap}.bad{background:#fff1d8;color:#875b06}.empty{text-align:center;color:#71838d;padding:36px}footer{text-align:center;color:#71838d;padding:20px;font-size:12px}@media(max-width:800px){.cards{grid-template-columns:1fr 1fr}.filters{grid-template-columns:1fr 1fr}header{padding:24px}main{padding:0 12px}section{padding:14px}h1{font-size:24px}}
</style></head><body><header><small>MRTKIT · OFFLINE OBSERVATIONS</small><h1 id="title">路由观测复盘</h1><p id="period"></p><p>采集器观测用于排查与研究，不代表实际业务中断或事件因果。</p></header><main>
<div id="quality" class="warning"></div><div class="cards"><div class="card">观测点<strong id="points">—</strong></div><div class="card">明细记录<strong id="rows">—</strong></div><div class="card">变化提醒<strong id="changes">—</strong></div><div class="card">按需加载的数据页<strong id="pages">—</strong></div></div>
<section><h2>观测点分布与输入质量</h2><div class="scroll"><table><thead><tr><th>采集器 / 视图</th><th>输入</th><th>基线</th><th>连续性 / 缺档</th><th>宣告 / 撤回</th><th>活动 / 缓存状态</th></tr></thead><tbody id="coverage"></tbody></table></div></section>
<section><h2>时间线与变化明细</h2><div class="filters"><label>采集器 / 视图<select id="collector"><option value="">全部观测点</option></select></label><label>前缀（精确）<input id="prefix" placeholder="203.0.113.0/24"></label><label>Peer ASN / IP（精确）<input id="peer" placeholder="58952"></label><label>变化 / 观测类型<select id="kind"><option value="">全部类型</option></select></label><button id="apply">应用筛选</button></div><p id="status" class="muted" role="status"></p><div class="scroll"><table><thead><tr><th>UTC 时间</th><th>观测点</th><th>前缀 / Path ID</th><th>Peer</th><th>类型</th><th>差异与来源</th></tr></thead><tbody id="details"></tbody></table></div><div class="pager"><button id="previous">上一页</button><span id="position"></span><button id="next">下一页</button></div></section></main><footer>结构化输出版本 2.0 · 全部资源在本地 · 来源偏移是解压后的记录起点</footer><script src="manifest.js"></script><script src="app.js" defer></script></body></html>`;

const app=String.raw`'use strict';
const model=globalThis.MRTKitManifest,byId=id=>document.getElementById(id),node=(tag,text,className)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=String(text);if(className)e.className=className;return e;};
document.title=model.title;byId('title').textContent=model.title;
const date=seconds=>new Date(seconds*1000).toISOString().replace('T',' ').replace('.000Z',' UTC');
byId('period').textContent=date(model.window.from)+' 至 '+date(model.window.to)+' · 多观测点按清单分组，可筛选单个观测点查看。';
for(const [id,value]of [['points',model.collectors.length],['rows',model.rows],['changes',model.change_notices],['pages',model.pages.length]])byId(id).textContent=value.toLocaleString();
const uncertain=model.collectors.filter(p=>p.status!=='complete'||p.baseline_status!=='explicit_rib'||!p.continuous||p.gaps.length);
byId('quality').textContent=(model.input_status!=='complete'?'输入为部分结果。':'配置的输入已处理完成。')+(uncertain.length?' '+uncertain.length+' 个观测点存在缺基线、缺档或未验证的连续性；不据此计算确定的业务中断时长。':' 已声明连续观测；仍仅描述所选路由的采集可见性。');
for(const point of model.collectors){const tr=node('tr'),s=point.summary??{};for(const text of [point.collector+' / '+point.view,point.status,point.baseline_status,(point.continuous?'已声明连续':'未验证连续')+' / '+point.gaps.length+' 个缺档',(s.announcements??'?')+' / '+(s.withdrawals??'?'),(s.active_routes??'?')+' / '+(s.tracked_routes??'?')])tr.append(node('td',text));if(point.error){const detail=node('details'),summary=node('summary','输入错误');detail.append(summary,node('pre',point.error));tr.children[1].append(detail);}byId('coverage').append(tr);const option=node('option',point.collector+' / '+point.view);option.value=JSON.stringify([point.collector,point.view]);byId('collector').append(option);}
const kinds=[...new Set(model.pages.flatMap(p=>p.facets.kinds))].sort();for(const kind of kinds){const option=node('option',kind);option.value=kind;byId('kind').append(option);}
let requested=null,loading=Promise.resolve();globalThis.MRTKitReceive=(id,rows)=>{if(requested?.id===id)requested.rows=rows;};
function load(id){const job=loading.then(()=>new Promise((resolve,reject)=>{const script=node('script'),request={id,rows:null};requested=request;script.src=model.pages[id].file;script.onload=()=>{script.remove();if(requested===request)requested=null;if(Array.isArray(request.rows))resolve(request.rows);else reject(new Error('本地数据页格式无效'));};script.onerror=()=>{script.remove();if(requested===request)requested=null;reject(new Error('无法加载本地数据页 '+id));};document.body.append(script);}));loading=job.catch(()=>{});return job;}
let locations=null,current=0,locked=false;const displaySize=50;
function filters(){return {collector:byId('collector').value,prefix:byId('prefix').value.trim(),peer:byId('peer').value.trim(),kind:byId('kind').value};}
function matches(row,f){return (!f.collector||JSON.stringify([row.collector,row.view])===f.collector)&&(!f.prefix||row.prefix===f.prefix)&&(!f.peer||String(row.peer_asn)===f.peer||row.peer_ip===f.peer)&&(!f.kind||row.kind===f.kind||(row.changes??[]).some(change=>change.kind===f.kind));}
function candidates(page,f){const x=page.facets;return (!f.collector||x.collectors.includes(f.collector))&&(!f.prefix||x.prefixes.includes(f.prefix))&&(!f.peer||x.peers.includes(f.peer))&&(!f.kind||x.kinds.includes(f.kind));}
function unfilteredLocations(start,end){const found=[];let count=0;for(const page of model.pages){if(count+page.rows>start&&count<end)for(let i=Math.max(0,start-count);i<Math.min(page.rows,end-count);i++)found.push([page.id,i]);count+=page.rows;if(count>=end)break;}return found;}
async function render(){const total=locations?locations.length:model.rows,count=Math.max(1,Math.ceil(total/displaySize));current=Math.max(0,Math.min(current,count-1));const needed=locations?locations.slice(current*displaySize,(current+1)*displaySize):unfilteredLocations(current*displaySize,(current+1)*displaySize);const body=byId('details');body.replaceChildren();let previousPage=-1,data;for(const [page,index]of needed){if(page!==previousPage){data=await load(page);previousPage=page;}const row=data[index],tr=node('tr');const fraction=String(row.microseconds??0).padStart(6,'0');tr.append(node('td',date(row.timestamp).replace(' UTC','')+'.'+fraction+' UTC','code'),node('td',row.collector+' / '+row.view),node('td',(row.prefix??'—')+(row.path_id!==undefined?' · ID '+row.path_id:''),'code'),node('td',(row.peer_asn??'—')+' / '+(row.peer_ip??'—'),'code'));const type=node('td');type.append(node('span',row.kind,'pill'+(row.accepted===false?' bad':'')));tr.append(type);const detail=node('details'),summary=node('summary','查看差异与来源');detail.append(summary,node('pre',JSON.stringify({source:row.source??null,before:row.before??null,after:row.after??null,diff:row.diff??null,changes:row.changes??[]},null,2)));const td=node('td');td.append(detail);tr.append(td);body.append(tr);}if(!needed.length){const tr=node('tr'),td=node('td','没有符合条件的记录','empty');td.colSpan=6;tr.append(td);body.append(tr);}byId('status').textContent='匹配 '+total.toLocaleString()+' 条记录，当前仅加载所需数据页。';byId('position').textContent=(current+1)+' / '+count;byId('previous').disabled=current===0;byId('next').disabled=current>=count-1;}
async function action(work){if(locked)return;locked=true;byId('apply').disabled=true;byId('previous').disabled=true;byId('next').disabled=true;try{await work();await render();}catch(error){byId('status').textContent=error.message;}finally{locked=false;byId('apply').disabled=false;}}
byId('apply').onclick=()=>action(async()=>{const f=filters();if(!Object.values(f).some(Boolean)){locations=null;}else{const found=[];for(const page of model.pages){if(!candidates(page,f))continue;byId('status').textContent='正在筛选数据页 '+(page.id+1)+' / '+model.pages.length;const rows=await load(page.id);for(let i=0;i<rows.length;i++)if(matches(rows[i],f))found.push([page.id,i]);}locations=found;}current=0;});
byId('previous').onclick=()=>action(async()=>{current--;});byId('next').onclick=()=>action(async()=>{current++;});
action(async()=>{});
`;
