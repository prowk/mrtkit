import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative} from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {replayManifest} from '../cli/multi.mjs';
import {generateReport} from '../cli/report.mjs';
import {attributes} from './helpers/changes.mjs';
import {correlateExternal} from '../cli/correlate-external.mjs';

// 在无浏览器、无网络的隔离 DOM 中执行真实生成的 app.js 和分块脚本。
async function page(directory){
  const elements=new Map(),loaded=[];
  class Element{
    constructor(tag){this.tagName=tag;this.children=[];this.value='';this.disabled=false;this._text='';}
    set textContent(value){this._text=String(value);this.children=[];}
    get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
    append(...nodes){this.children.push(...nodes);for(const node of nodes)if(node.tagName==='script'){
      queueMicrotask(()=>{try{const path=resolve(directory,node.src);assert.ok(!relative(directory,path).startsWith('..'));loaded.push(node.src);vm.runInContext(readFileSync(path,'utf8'),context);node.onload();}catch(error){node.onerror?.(error);}});
    }}
    replaceChildren(...nodes){this.children=[];this._text='';this.append(...nodes);}
    remove(){}
  }
  const html=await readFile(join(directory,'index.html'),'utf8');
  for(const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g))elements.set(match[2],new Element(match[1]));
  const document={title:'',getElementById:id=>elements.get(id),createElement:tag=>new Element(tag),body:new Element('body')};
  const context=vm.createContext({document,console,performance,setTimeout,clearTimeout,atob});
  vm.runInContext(await readFile(join(directory,'manifest.js'),'utf8'),context);
  vm.runInContext(await readFile(join(directory,'app.js'),'utf8'),context);
  for(let i=0;i<100&&elements.get('apply').disabled;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(elements.get('apply').disabled,false);
  return {elements,loaded,context,document};
}
const temporary=async run=>{const root=await mkdtemp(join(tmpdir(),'mrtkit-report-'));try{await run(root);}finally{await rm(root,{recursive:true,force:true});}};

test('HTML 报告数量与 CLI 结果包一致，实际页面逻辑可跨数据块筛选',()=>temporary(async root=>{
  const bundle=join(root,'bundle');await replayManifest(resolve('fixtures/multi/manifest.json'),bundle);
  const output=join(root,'report');const result=await generateReport(join(bundle,'index.json'),output,{pageSize:3});
  const index=JSON.parse(await readFile(join(bundle,'index.json'),'utf8'));
  assert.equal(result.change_notices,index.collectors.reduce((sum,point)=>sum+point.change_notices,0));
  assert.equal(result.rows,7);assert.equal(result.pages,3);
  const ui=await page(output);
  assert.equal(ui.elements.get('details').children.length,7);
  assert.equal(ui.elements.get('changes').textContent,'8');
  assert.match(ui.elements.get('quality').textContent,/未验证/);
  ui.elements.get('collector').value=JSON.stringify(['synthetic-b','default']);
  await ui.elements.get('apply').onclick();
  assert.match(ui.elements.get('status').textContent,/匹配 4 条/);
  assert.equal(ui.elements.get('details').children.length,4);
  assert.ok(ui.elements.get('details').children.every(row=>row.children[1].textContent==='synthetic-b / default'));
  ui.elements.get('prefix').value='192.0.2.0/24';await ui.elements.get('apply').onclick();
  assert.match(ui.elements.get('status').textContent,/匹配 0 条/);
  assert.equal(ui.elements.get('details').children[0].textContent,'没有符合条件的记录');
  ui.elements.get('collector').value='';ui.elements.get('prefix').value='';ui.elements.get('kind').value='path_change';
  await ui.elements.get('apply').onclick();
  const timelines=await Promise.all(index.collectors.map(async point=>JSON.parse(await readFile(join(bundle,point.timeline_file),'utf8'))));
  const expected=timelines.flatMap(report=>report.timeline.entries).filter(row=>row.changes.some(change=>change.kind==='path_change')).length;
  assert.ok(expected>0);assert.match(ui.elements.get('status').textContent,new RegExp('匹配 '+expected+' 条'));
  assert.ok(ui.elements.get('kind').children.some(option=>option.value==='path_change'));
}));

test('大量明细分页、组合筛选及恶意文本不会执行脚本或丢失记录',()=>temporary(async root=>{
  const bundle=join(root,'bundle');await mkdir(bundle);
  const dangerous='</script><img src=x onerror="globalThis.pwned=true">';
  const rows=Array.from({length:175},(_,i)=>({schema_version:'2.0',timestamp:100+i,kind:i%2?'path_change':'attribute_change',
    prefix:i%3?'203.0.113.0/24':'198.51.100.0/24',peer_asn:64512+i%2,peer_ip:'192.0.2.1',outbound:false,
    source:{collector:dangerous,view:'v',file:'route.mrt',record:String(i+1),offset:String(i*100),event_index:0},
    before:{timestamp:99,active:true,attributes:{...attributes([1]),med:1,note:dangerous}},after:{timestamp:100+i,active:true,attributes:{...attributes([2]),med:2,note:'safe'}}}));
  await writeFile(join(bundle,'changes.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n')+'\n','utf8');
  const index={schema_version:'2.0',type:'collector_replay_bundle',status:'partial',window:{from:100,to:274},collectors:[
    {collector:dangerous,view:'v',status:'partial',baseline_status:'missing',continuous:false,gaps:[{from:110,to:120}],
      change_notices:175,changes_file:'changes.jsonl',error:dangerous,summary:{announcements:'175',withdrawals:'0',active_routes:1,tracked_routes:1}}]};
  await writeFile(join(bundle,'index.json'),JSON.stringify(index),'utf8');
  const output=join(root,'report');const result=await generateReport(join(bundle,'index.json'),output,{pageSize:20,title:dangerous});
  assert.equal(result.pages,9);assert.equal(result.input_status,'partial');
  const javascript=await readFile(join(output,'data/page-000000.js'),'utf8');assert.ok(!javascript.includes('</script>'));
  assert.ok(!/https?:\/\//.test(await readFile(join(output,'index.html'),'utf8')));
  const ui=await page(output);assert.equal(ui.document.title,dangerous);assert.equal(ui.context.pwned,undefined);
  assert.match(ui.elements.get('quality').textContent,/部分结果/);
  assert.equal(ui.elements.get('details').children.length,50);assert.equal(ui.elements.get('position').textContent,'1 / 4');
  await ui.elements.get('next').onclick();assert.equal(ui.elements.get('position').textContent,'2 / 4');
  assert.ok(ui.elements.get('details').children[0].textContent.includes('1970-01-01 00:02:30'));
  ui.elements.get('prefix').value='203.0.113.0/24';ui.elements.get('peer').value='64513';ui.elements.get('kind').value='path_change';
  await ui.elements.get('apply').onclick();const expected=rows.filter(row=>row.prefix==='203.0.113.0/24'&&row.peer_asn===64513&&row.kind==='path_change').length;
  assert.match(ui.elements.get('status').textContent,new RegExp('匹配 '+expected+' 条'));
  assert.equal(ui.context.pwned,undefined);
}));

test('输入明细被篡改时报告不冒充完整；输出目录不覆盖已有文件',()=>temporary(async root=>{
  const bundle=join(root,'bundle');await replayManifest(resolve('fixtures/multi/manifest.json'),bundle);
  const index=JSON.parse(await readFile(join(bundle,'index.json'),'utf8'));
  await writeFile(join(bundle,index.collectors[0].timeline_file),'{}','utf8');
  const output=join(root,'report');await assert.rejects(generateReport(join(bundle,'index.json'),output),/哈希/);
  assert.equal(JSON.parse(await readFile(join(output,'report.json'),'utf8')).status,'partial');
  await assert.rejects(generateReport(join(bundle,'index.json'),output),/EEXIST/);
}));

test('report 命令生成可携带的本地报告，参数与非法窗口明确失败',()=>temporary(async root=>{
  const bundle=join(root,'bundle');await replayManifest(resolve('fixtures/multi/manifest.json'),bundle);
  const output=join(root,'html'),input=join(bundle,'index.json');
  const run=args=>spawnSync(process.execPath,['cli/mrtkit.mjs','report',...args],{encoding:'utf8',windowsHide:true});
  const result=run(['--input',input,'--output',output,'--page-size','2']);
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).rows,7);
  assert.ok((await readFile(join(output,'index.html'),'utf8')).includes('manifest.js'));
  assert.notEqual(run(['--input',input,'--output',output]).status,0);
  assert.notEqual(run(['--input',input,'--output',join(root,'bad'),'--page-size','0']).status,0);
  const index=JSON.parse(await readFile(input,'utf8'));index.window.from=-1;
  await writeFile(input,JSON.stringify(index),'utf8');
  await assert.rejects(generateReport(input,join(root,'bad-window')),/窗口/);
}));

test('关联组覆盖、观测明细与来源跳转一致；错误绑定和篡改明确失败',()=>temporary(async root=>{
  const bundle=join(root,'bundle');await replayManifest(resolve('fixtures/multi/manifest.json'),bundle);
  const input=join(bundle,'index.json'),correlation=join(root,'correlation');await correlateExternal(input,correlation,{memoryBytes:65536});
  const sourceLabels=Object.fromEntries(JSON.parse(await readFile(input,'utf8')).collectors.flatMap(point=>point.files.map(file=>[file.path,'archive-label.mrt'])));
  const output=join(root,'report');await generateReport(input,output,{correlation:join(correlation,'index.json'),pageSize:3,sourceLabels});
  const manifest=JSON.parse(await readFile(join(output,'report.json'),'utf8')),index=JSON.parse(await readFile(join(correlation,'index.json'),'utf8'));
  assert.equal(manifest.datasets.groups.rows,index.groups);assert.equal(manifest.datasets.observations.rows,index.unique_observations);
  const ui=await page(output);
  for(let i=0;i<100&&!ui.elements.get('groups').children.length;i++)await new Promise(accept=>setImmediate(accept));
  assert.ok(ui.elements.get('groups').children.length>0);
  const group=ui.elements.get('groups').children[0],button=group.children.find(child=>child.tagName==='button');
  await button.onclick();assert.ok(ui.elements.get('observations').children.length>0);
  assert.match(ui.elements.get('observations').textContent,/archive-label\.mrt/);
  assert.ok(!ui.elements.get('observations').textContent.includes(resolve('fixtures/multi')));
  const jump=ui.elements.get('observations').children[0].children.find(child=>child.tagName==='button');await jump.onclick();
  assert.ok(ui.elements.get('details').children[0].textContent.includes('原始来源位置'));
  const before=ui.context.MRTKitMetrics.detail_loads;await ui.elements.get('apply').onclick();
  assert.ok(ui.context.MRTKitMetrics.detail_loads>=before);
  const bad=JSON.parse(await readFile(join(correlation,'index.json'),'utf8'));bad.input_bundle_sha256='0'.repeat(64);await writeFile(join(correlation,'index.json'),JSON.stringify(bad),'utf8');
  await assert.rejects(generateReport(input,join(root,'bad'),{correlation:join(correlation,'index.json')}),/输入不一致/);
  bad.input_bundle_sha256=index.input_bundle_sha256;await writeFile(join(correlation,'index.json'),JSON.stringify(bad),'utf8');await writeFile(join(correlation,'groups.jsonl'),'{}\n','utf8');
  await assert.rejects(generateReport(input,join(root,'tamper'),{correlation:join(correlation,'index.json')}),/哈希/);
}));

test('多索引块筛选只加载匹配页，取消后重置不会被旧请求覆盖',()=>temporary(async root=>{
  const bundle=join(root,'bundle');await mkdir(bundle);const notices=17000;
  const rows=Array.from({length:notices},(_,i)=>({schema_version:'2.0',timestamp:100,kind:'path_change',prefix:i%2?'203.0.113.0/24':'198.51.100.0/24',peer_asn:64512,peer_ip:'2001:db8::1',outbound:false,
    source:{collector:'c',view:'v',file:'长路径/'.repeat(20)+'route.mrt',record:String(i+1),offset:String(i*100),event_index:0},before:{timestamp:99,active:true,attributes:attributes([1])},after:{timestamp:100,active:true,attributes:attributes([2])}}));
  await writeFile(join(bundle,'changes.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n')+'\n','utf8');
  await writeFile(join(bundle,'index.json'),JSON.stringify({schema_version:'2.0',type:'collector_replay_bundle',status:'partial',window:{from:100,to:100},collectors:[{collector:'c',view:'v',status:'partial',change_notices:notices,changes_file:'changes.jsonl'}]}),'utf8');
  const output=join(root,'report');await generateReport(join(bundle,'index.json'),output,{pageSize:200});const ui=await page(output),metrics=ui.context.MRTKitMetrics;
  const before=metrics.detail_loads;ui.elements.get('prefix').value='203.0.113.0/24';await ui.elements.get('apply').onclick();
  assert.match(ui.elements.get('status').textContent,/匹配 8,500 条/);assert.equal(metrics.index_loads,3);assert.equal(metrics.detail_loads-before,1);
  assert.equal(metrics.queries[0].bitset_bytes,Math.ceil(notices/8));
  const stale=ui.elements.get('apply').onclick();ui.elements.get('cancel').onclick();await ui.elements.get('reset').onclick();await stale;
  assert.match(ui.elements.get('status').textContent,/匹配 17,000 条/);assert.equal(metrics.cancelled,1);assert.equal(ui.elements.get('position').textContent,'1 / 340');
  await ui.elements.get('next').onclick();assert.equal(ui.elements.get('position').textContent,'2 / 340');
}));

test('关联摘要和组内观测的时间必须一致，重算文件哈希不能掩盖越界或过期摘要',()=>temporary(async root=>{
  const bundle=join(root,'bundle');await replayManifest(resolve('fixtures/multi/manifest.json'),bundle);const input=join(bundle,'index.json'),correlation=join(root,'correlation');await correlateExternal(input,correlation,{memoryBytes:65536});
  const original=JSON.parse(await readFile(join(correlation,'index.json'),'utf8')),rows=(await readFile(join(correlation,'groups.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  const mutations=[row=>row.first_observed_at='-1',row=>row.first_observed_at='999000000',row=>row.window_end_exclusive=row.last_observed_at,row=>{row.last_observed_at=String(BigInt(row.last_observed_at)+1n);}];
  for(const [i,mutate]of mutations.entries()){
    const changed=structuredClone(rows);mutate(changed[0]);const data=changed.map(row=>JSON.stringify(row)).join('\n')+'\n';
    await writeFile(join(correlation,'groups.jsonl'),data,'utf8');await writeFile(join(correlation,'index.json'),JSON.stringify({...original,groups_sha256:createHash('sha256').update(data).digest('hex'),groups_bytes:Buffer.byteLength(data)}),'utf8');
    const output=join(root,'bad-time-'+i);await assert.rejects(generateReport(input,output,{correlation:join(correlation,'index.json')}),/关联.*时间|窗口/);
    assert.equal(JSON.parse(await readFile(join(output,'report.json'),'utf8')).status,'partial');
  }
}));
