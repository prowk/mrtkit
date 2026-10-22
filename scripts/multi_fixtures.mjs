import {writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {demo,bgpUpdate,attributes,cat} from './fixtures.mjs';

// 两个人工观测点故意使用相同 peer 和前缀，验证身份隔离及时间差的观测含义。
const directory=new URL('../fixtures/multi/',import.meta.url);await mkdir(directory,{recursive:true});
const data=demo();let cut=0;for(let i=0;i<2;i++)cut+=12+data.readUInt32BE(cut+8);
const prefix=Buffer.from([24,203,0,113]);
const files={'initial.mrt':data.subarray(0,cut),'collector-a.mrt':data.subarray(cut),
  'collector-b.mrt':cat(bgpUpdate(prefix,undefined,attributes([64512,65537]),1700000002),
    bgpUpdate(undefined,prefix,undefined,1700000003),bgpUpdate(prefix,undefined,attributes([64512,65537]),1700000004),
    bgpUpdate(prefix,undefined,attributes([64512,65538]),1700000005))};
const entry=(path,kind,from,to)=>({path,kind,from,to,sha256:createHash('sha256').update(files[path]).digest('hex')});
for(const [name,content]of Object.entries(files))await writeFile(new URL(name,directory),content);
const manifest={schema_version:'1.0',window:{from:1700000001,to:1700000006},analysis:{prefix:'203.0.113.0/24',threshold:3},
  collectors:['a','b'].map(name=>({collector:'synthetic-'+name,view:'default',continuous:false,
    files:[entry('initial.mrt','rib',1700000000,1700000000),entry('collector-'+name+'.mrt','update',1700000001,1700000006)]}))};
await writeFile(new URL('manifest.json',directory),JSON.stringify(manifest,null,2)+'\n','utf8');
console.log('已生成 fixtures/multi/manifest.json');
