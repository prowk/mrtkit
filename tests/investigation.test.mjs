import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,cp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {discoverArchives,hashText} from '../cli/archive-discovery.mjs';
import {qualityCheck,cachePlan,fileHash,saveJson} from '../cli/archive.mjs';
import {investigate,queryInvestigation,exportInvestigation,verifyEvidence} from '../cli/investigation.mjs';
import {buildSite} from '../scripts/build_site.mjs';
import {syntheticCase} from '../scripts/investigation_cases.mjs';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
await mkdir('.validation',{recursive:true});
const tmpdir=()=>resolve('.validation');

test('发现使用保存的目录快照选择最近 RIB 并报告缺失档案槽',async()=>{
  const url='https://data.ris.ripe.net/rrc23/2025.01/',body=['bview.20250101.0000.gz','updates.20250101.0000.gz','updates.20250101.0010.gz'].map(name=>`<a href="${name}">${name}</a>`).join('');
  const snapshots=[{url:'https://data.ris.ripe.net/rrc23/2024.12/',body:'',sha256:hashText('')},{url,body,sha256:hashText(body)}];
  const plan=await discoverArchives(['ris:rrc23'],'1735690200000000','1735690500000000',{snapshots});
  assert.equal(plan.collectors[0].files[0].kind,'rib');assert.equal(plan.collectors[0].files.length,3);assert.equal(plan.unsatisfied.length,1);assert.equal(plan.unsatisfied[0].from_us,'1735689900000000');assert.equal(plan.collectors[0].continuous,false);
  assert.deepEqual(await discoverArchives(['ris:rrc23'],'1735690200000000','1735690500000000',{snapshots}),plan);
});

test('固定样本调查、分页游标、证据移植与哈希失败',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mrt-investigation-')),source=JSON.parse(await readFile('fixtures/multi/manifest.json','utf8'));
  const plan={schema_version:'1.0',type:'archive_plan',window:{from_us:'1700000001000000',to_us:'1700000007000000'},collectors:[]};
  for(const [ordinal,point]of source.collectors.entries()){const files=[];for(const [index,file]of point.files.entries()){const name=`${ordinal}-${index}.mrt`;await cp(join('fixtures/multi',file.path),join(dir,name));files.push({path:name,kind:file.kind,from_us:String(BigInt(file.from)*1000000n),to_us:String(BigInt(file.to)*1000000n+(file.kind==='update'?1000000n:0n)),sha256:file.sha256});}plan.collectors.push({...point,files});}
  const manifest=join(dir,'manifest.json');await saveJson(manifest,plan);
  const quality=await qualityCheck(manifest,{full:true});assert.notEqual(quality.status,'blocked');assert.ok(quality.files.every(file=>file.eof));
  const result=await investigate(manifest,resolve('fixtures/investigation-rules.json'),join(dir,'analysis'));assert.equal(result.status,'partial');assert.ok(result.counts.events>0);
  const path=result.index,page=await queryInvestigation(path,{}, {limit:1});assert.equal(page.rows.length,1);assert.ok(page.next_cursor);
  const next=await queryInvestigation(path,{}, {limit:1,cursor:page.next_cursor});assert.notEqual(next.rows[0].id,page.rows[0].id);
  await assert.rejects(()=>queryInvestigation(path,{kind:'withdraw'},{cursor:page.next_cursor}),/游标/);
  const exported=await exportInvestigation(path,{},join(dir,'evidence'),{evidence:true});await cp(join(dir,'evidence'),join(dir,'moved'),{recursive:true});assert.equal((await verifyEvidence(join(dir,'moved','index.json'))).rows,exported.rows);
  await writeFile(join(dir,'moved','events.jsonl'),'{}\n','utf8');await assert.rejects(()=>verifyEvidence(join(dir,'moved','index.json')),/哈希/);
});

test('缓存有界重试、固定哈希及完全离线重建',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mrt-cache-')),body=await readFile('fixtures/demo.mrt'),plan={schema_version:'1.0',type:'archive_plan',window:{from_us:'1000000',to_us:'2000000'},collectors:[{collector:'synthetic',view:'v',files:[{path:'test.mrt',kind:'update',from_us:'1000000',to_us:'2000000',url:'https://example.invalid/archive'}]}]},path=join(dir,'plan.json');await saveJson(path,plan);
  let calls=0;const first=await cachePlan(path,join(dir,'cache'),{fetcher:async()=>{calls++;return new Response(body,{headers:{'content-length':String(body.length)}});}});assert.equal(first.status,'cached');assert.equal(calls,1);
  const second=await cachePlan(path,join(dir,'cache'),{offline:true,fetcher:()=>{throw new Error('不能联网');}});assert.equal(second.status,'cached');assert.equal((await qualityCheck(second.manifest)).files[0].sha256,await fileHash('fixtures/demo.mrt'));
});

test('精选站点不含本机路径，实际脚本可首屏展示、联动筛选、取消重置和路径步进',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mrt-site-')),output=join(root,'site'),receipt=await buildSite(output);assert.ok(receipt.bytes<16777216);assert.equal(receipt.cases.length,2);
  const directory=join(output,'cases/synthetic'),elements=new Map(),datasetButtons=[];let context;
  class Element{constructor(tag){this.tagName=tag;this.children=[];this.value='';this.checked=false;this.style={};this.dataset={};this._text='';}set textContent(value){this._text=String(value);this.children=[];}get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}append(...nodes){for(const node of nodes){if(node.tagName==='fragment')this.children.push(...node.children);else this.children.push(node);if(node.tagName==='script')queueMicrotask(()=>{try{vm.runInContext(readFileSync(join(directory,node.src),'utf8'),context);node.onload();}catch(error){node.onerror?.(error);}});}}replaceChildren(...nodes){this.children=[];this._text='';this.append(...nodes);}setAttribute(key,value){this[key]=value;}remove(){}scrollIntoView(){}}
  const html=await readFile(join(directory,'index.html'),'utf8');for(const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g))elements.set(match[2],new Element(match[1]));for(const name of ['findings','moas','incidents']){const button=new Element('button');button.dataset.dataset=name;datasetButtons.push(button);}
  for(const [id,value]of [['prefix-mode','exact'],['count-mode','events'],['top','10']])elements.get(id).value=value;
  const document={title:'',body:new Element('body'),getElementById:id=>elements.get(id),createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag),createDocumentFragment:()=>new Element('fragment'),querySelectorAll:query=>query==='[data-dataset]'?datasetButtons:[]};
  context=vm.createContext({document,window:{addEventListener(){}},console,performance,setTimeout,clearTimeout,setInterval,clearInterval,URLSearchParams,location:{hash:'',href:'https://example.invalid/mrtkit/cases/synthetic/'},history:{pushState(){},replaceState(){}},TextEncoder,crypto:globalThis.crypto});
  for(const file of ['sources.js','manifest.js','core.js','app.js'])vm.runInContext(await readFile(join(directory,file),'utf8'),context);for(let i=0;i<100&&!elements.get('status').textContent.includes('条事件');i++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(elements.get('count-events').textContent,'15');assert.equal(elements.get('source-select').children.length,2);assert.equal(elements.get('scatter-section').hidden,false);assert.equal(elements.get('comparison-section').hidden,false);assert.ok(elements.get('details').children.length>0);assert.ok(elements.get('trend').children.length>0);
  // 同 ASN、同地址在不同采集器上仍是独立轨道。
  for(let i=0;i<100&&elements.get('apply').disabled;i++)await new Promise(resolve=>setTimeout(resolve,2));
  const lanes=elements.get('states').children;
  assert.equal(lanes.length,6);
  const captions=lanes.map(lane=>lane.children[0].textContent);
  assert.ok(captions.includes('203.0.113.0/24 · synthetic-a · AS64512 · 192.0.2.1'));
  assert.ok(captions.includes('203.0.113.0/24 · synthetic-b · AS64512 · 192.0.2.1'));
  // 清除全局筛选也须清除播放器继承的相邻网络条件。
  elements.get('player-prefix').value='203.0.113.0/24';
  elements.get('peer').value=elements.get('peer').children.find(option=>option.value.includes('synthetic-b')).value;
  elements.get('filters').onsubmit({preventDefault(){}});
  for(let i=0;i<100&&elements.get('apply').disabled;i++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(elements.get('count-events').textContent,'4');
  assert.equal(Number(elements.get('step').max),5);
  elements.get('reset').onclick();
  for(let i=0;i<100&&elements.get('apply').disabled;i++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(elements.get('count-events').textContent,'15');
  assert.equal(elements.get('player-peer').value,'');
  assert.equal(Number(elements.get('step').max),14);
  elements.get('prefix').value='203.0.113.0/25';elements.get('filters').onsubmit({preventDefault(){}});for(let i=0;i<100&&elements.get('apply').disabled;i++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(elements.get('count-events').textContent,'1',elements.get('status').textContent);assert.match(elements.get('scope').textContent,/当前组合/);
  elements.get('cancel').onclick();elements.get('reset').onclick();for(let i=0;i<100&&elements.get('apply').disabled;i++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(elements.get('count-events').textContent,'15');
  await elements.get('player-load').onclick();assert.match(elements.get('step-caption').textContent,/步骤 0/);await elements.get('step-next').onclick();assert.ok(elements.get('player').children.length>0);
  const descendants=node=>[node,...node.children.flatMap(descendants)];
  assert.ok(descendants(elements.get('player')).some(node=>node['aria-label']==='路径前后网络图'));
  elements.get('prefix').value='192.0.2.0/24';elements.get('filters').onsubmit({preventDefault(){}});for(let i=0;i<100&&elements.get('apply').disabled;i++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(elements.get('count-events').textContent,'0');assert.match(elements.get('player').textContent,/没有路径记录/);assert.match(elements.get('details').textContent,/没有匹配/);
  elements.get('source-select').value='../real/index.html';elements.get('source-select').onchange();assert.equal(context.location.href,'../real/index.html');
  const homepage=await readFile(join(output,'index.html'),'utf8');assert.match(homepage,/id="trend"/);assert.match(homepage,/id="source-select"/);assert.doesNotMatch(homepage,/不代表|不表示|不直接认定|案例入口/);
  const rootModel=vm.createContext({});vm.runInContext(await readFile(join(output,'manifest.js'),'utf8'),rootModel);assert.equal(rootModel.MRTKitInvestigation.options.points.length,1);
  const about=await readFile(join(output,'about.html'),'utf8');assert.match(about,/解读边界/);
  const receiptJson=JSON.parse(await readFile(join(output,'report.json'),'utf8'));for(const resource of receiptJson.resources)assert.equal(await fileHash(join(output,resource.path)),resource.sha256);

});


test('导入结果包直接成为首页数据，不混入固定样本',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mrt-imported-site-')),source=await syntheticCase(join(root,'source')),analysis=await investigate(source.manifest,source.rules,join(root,'analysis')),output=join(root,'site');
  const receipt=await buildSite(output,{input:analysis.index,title:'自选数据 <测试>'});assert.equal(receipt.cases.length,1);assert.equal(receipt.cases[0].name,'imported');
  const context=vm.createContext({});for(const file of ['sources.js','manifest.js'])vm.runInContext(await readFile(join(output,file),'utf8'),context);
  assert.equal(context.MRTKitInvestigation.title,'自选数据 <测试>');assert.equal(context.MRTKitInvestigation.datasets.events.rows,15);assert.equal(context.MRTKitSources.length,1);assert.equal(context.MRTKitInvestigation.data_version,analysis.data_version);
});
