import {readFile,writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {resolve,join,relative,isAbsolute,sep,dirname} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {jsonLines} from '../cli/bundle.mjs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// 仅测真实页面脚本在隔离 DOM 中的索引与分页逻辑，不模拟浏览器渲染或视觉验收。
if(process.argv[2]==='--worker'){
  const directory=resolve(process.argv[3]),elements=new Map(),loaded=[];let context;
  class Element{
    constructor(tag){this.tagName=tag;this.children=[];this.value='';this.disabled=false;this._text='';}
    set textContent(value){this._text=String(value);this.children=[];}
    get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
    append(...nodes){this.children.push(...nodes);for(const child of nodes)if(child.tagName==='script')queueMicrotask(()=>{try{const file=resolve(directory,child.src),part=relative(directory,file);if(isAbsolute(part)||part==='..'||part.startsWith('..'+sep))throw new Error('分块路径越界');loaded.push(child.src);vm.runInContext(readFileSync(file,'utf8'),context);child.onload();}catch(error){child.onerror?.(error);}});}
    replaceChildren(...nodes){this.children=[];this._text='';this.append(...nodes);}
    remove(){}
  }
  const html=await readFile(join(directory,'index.html'),'utf8');for(const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g))elements.set(match[2],new Element(match[1]));
  const document={title:'',getElementById:id=>elements.get(id),createElement:tag=>new Element(tag),body:new Element('body')};
  context=vm.createContext({document,console,performance,setTimeout,clearTimeout,atob});
  vm.runInContext(await readFile(join(directory,'manifest.js'),'utf8'),context);const started=performance.now();vm.runInContext(await readFile(join(directory,'app.js'),'utf8'),context);
  while(elements.get('apply').disabled)await new Promise(accept=>setImmediate(accept));assert.equal(elements.get('details').children.length,50);
  const first_script_seconds=(performance.now()-started)/1000,model=context.MRTKitManifest;
  // 从实际首行选择存在的组合条件，计数由索引独立求得，另复核所有匹配项。
  let first;const scratch=vm.createContext({MRTKitReceive:(_name,_type,_id,rows)=>first=rows[0]});vm.runInContext(await readFile(join(directory,model.pages[0].file),'utf8'),scratch);
  for(const [id,value]of [['collector',JSON.stringify([first.collector,first.view])],['prefix',first.prefix],['peer',String(first.peer_asn)],['kind',first.kind]])elements.get(id).value=value;
  const before=context.MRTKitMetrics.detail_loads,filterStarted=performance.now();await elements.get('apply').onclick();const filter_seconds=(performance.now()-filterStarted)/1000;
  assert.ok(context.MRTKitMetrics.index_loads>0);const matched=context.MRTKitMetrics.queries.at(-1).total;assert.ok(matched>0);
  const filter_detail_pages=context.MRTKitMetrics.detail_loads-before;
  const cancel=elements.get('apply').onclick();elements.get('cancel').onclick();await elements.get('reset').onclick();await cancel;assert.match(elements.get('status').textContent,/100,000/);
  const nextStarted=performance.now();await elements.get('next').onclick();const next_seconds=(performance.now()-nextStarted)/1000;assert.equal(elements.get('position').textContent,'2 / 2000');assert.equal(elements.get('details').children.length,50);
  console.log(JSON.stringify({first_script_seconds,filter_seconds,next_seconds,next_page_mode:'unfiltered_after_reset',matched,filter_detail_pages,index_loads:context.MRTKitMetrics.index_loads,matching_bitset_bytes:Math.ceil(model.rows/8),peak_rss_bytes:process.resourceUsage().maxRSS*1024,rows:model.rows,pages:model.pages.length,first_filter:{collector:first.collector,view:first.view,prefix:first.prefix,peer:first.peer_asn,kind:first.kind}}));
}else{
  if(process.argv.length!==4||process.argv[2]!=='--report')throw new Error('用法: --report 已生成报告目录');const directory=resolve(process.argv[3]),runs=[];
  for(let iteration=1;iteration<=3;iteration++){const result=await new Promise((accept,reject)=>{const child=spawn(process.execPath,[resolve('scripts/report_logic_benchmark.mjs'),'--worker',directory],{windowsHide:true,stdio:['ignore','pipe','inherit']});let text='';child.stdout.on('data',part=>text+=part);child.on('error',reject);child.on('exit',code=>code===0?accept(JSON.parse(text)):reject(new Error('报告逻辑基准失败')));});runs.push({iteration,...result});console.log(JSON.stringify({iteration,...result}));}
  let expected=0;const filter=runs[0].first_filter;for await(const row of jsonLines(join(dirname(directory),'bundle/changes.jsonl')))if(row.source.collector===filter.collector&&row.source.view===filter.view&&row.prefix===filter.prefix&&row.peer_asn===filter.peer&&row.kind===filter.kind)expected++;for(const run of runs)assert.equal(run.matched,expected);
  const source_sha256={};for(const [label,file]of [['scripts/report_logic_benchmark.mjs','scripts/report_logic_benchmark.mjs'],['<report>/app.js',join(directory,'app.js')],['<report>/manifest.js',join(directory,'manifest.js')]])source_sha256[label]=createHash('sha256').update(await readFile(file)).digest('hex');
  assert.equal(source_sha256['<report>/app.js'],createHash('sha256').update(await readFile('cli/report-app.js')).digest('hex'));
  const evidence={scope:'isolated_DOM_script_logic_only_not_browser_rendering',target:'report-performance-target.json',node:process.version,report_manifest_sha256:createHash('sha256').update(await readFile(join(directory,'report.json'))).digest('hex'),source_sha256,matched_count_independently_recounted:expected,runs};await writeFile('docs/validation/report-logic-performance.json',JSON.stringify(evidence,null,2)+'\n','utf8');
}
