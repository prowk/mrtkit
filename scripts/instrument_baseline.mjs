import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

// 仅为旧构建追加只读分块导出探针；不修改协议、状态转换、缓存或原有导出。
const input=process.argv[2],output=process.argv[3];
if(!input||!output)throw new Error('用法: node scripts/instrument_baseline.mjs 输入桥接 输出桥接');
const source=await readFile(input,'utf8');
const stateName=source.match(/(\w+) as state[, }]/)?.[1];
if(!stateName)throw new Error('未找到旧版状态入口');
const stateBody=source.slice(source.indexOf(`function ${stateName}()`),source.indexOf('\n}',source.indexOf(`function ${stateName}()`))+2);
const session=stateBody.match(/const _bind = (\w+)\.val;/)?.[1];
const states=stateBody.match(/(\w*route__states)\(_analyzer\)/)?.[1];
const eventJson=source.match(/function (\w*RouteEvent\w*to__json)\(/)?.[1];
const stringify=source.match(/function (\w*stringify_2einner)\(/)?.[1];
if(![session,states,eventJson,stringify].every(Boolean))throw new Error('基线构建不符合固定编译器接口，拒绝猜测');
const probe=`
let __benchmark_rows=null,__benchmark_position=0;
export function state_export_begin(){const analyzer=${session}.val?.analyzer;if(!analyzer)return JSON.stringify({error:'基线没有分析器'});__benchmark_rows=${states}(analyzer);__benchmark_position=0;return '{}';}
export function state_export_chunk(limit){if(!Number.isInteger(limit)||limit<1||limit>1024||!__benchmark_rows)return JSON.stringify({error:'非法基线分块请求'});const rows=__benchmark_rows.slice(__benchmark_position,__benchmark_position+limit);__benchmark_position+=rows.length;if(!rows.length)__benchmark_rows=null;return '['+rows.map(row=>${stringify}(${eventJson}(row),false,0,undefined)).join(',')+']';}
`;
await writeFile(output,source+probe,'utf8');
console.log(JSON.stringify({original_sha256:createHash('sha256').update(source).digest('hex'),
  instrumented_sha256:createHash('sha256').update(source+probe).digest('hex'),
  contract:'Append-only read-only state export; original analyzer unchanged; old sorted state array retained, JSON trees limited to one event.'}));
