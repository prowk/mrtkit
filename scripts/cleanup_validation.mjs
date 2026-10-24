import {readFile,writeFile,stat,realpath,unlink} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve,relative,isAbsolute,sep,join} from 'node:path';
import {createHash} from 'node:crypto';

// 仅清理明确列出的重复验证输出；先核验保留副本和候选文件，再写收据和删除。
const apply=process.argv[2]==='--apply';if(process.argv.length>(apply?3:2))throw new Error('用法: [--apply]');
const workspace=await realpath('.'),root=await realpath('.validation'),guard=path=>{const part=relative(workspace,path);if(!part||isAbsolute(part)||part==='..'||part.startsWith('..'+sep))throw new Error('清理目标越出工作区');};guard(root);
const hash=async path=>{const digest=createHash('sha256');for await(const chunk of createReadStream(path))digest.update(chunk);return digest.digest('hex');};
const groups=[{keep:'fullstate/stream-after/output-1.jsonl',sha256:'f93aa8792be1e3573f5fd79bb248789c5f4a7794a206a95f7212ed758fd61477',remove:[
  ...[1,2,3].map(n=>`compact-v020-verified/full_jsonl_v1-${n}.jsonl`),...[1,2,3].map(n=>`fullstate/stream-before/output-${n}.jsonl`),...[2,3].map(n=>`fullstate/stream-after/output-${n}.jsonl`),'fullstate/updates-before/output-1.jsonl']},
  {keep:'compact-v020-verified/event_refs_v1-1.jsonl',sha256:'16bddcf1824c6693dd4314c2745a51b4c84db0a3023336f8fc8e4335127b8490',remove:[2,3].map(n=>`compact-v020-verified/event_refs_v1-${n}.jsonl`)}];
const compact=JSON.parse(await readFile(join(root,'compact-v020-verified/report.json'),'utf8'));if(!compact.complete||compact.runs.length!==6)throw new Error('紧凑基准尚未完整完成');
const receipt={date:new Date().toISOString(),applied:apply,reason:'User requested cleanup of redundant validation results. One verified payload per encoding retained; running full replay and independent model are excluded.',files:[],released_bytes:0};
const receiptPath=join(root,'duplicate-cleanup-'+Date.now()+'.json');
for(const group of groups){const keep=await realpath(join(root,group.keep));guard(keep);if(await hash(keep)!==group.sha256)throw new Error('保留副本哈希不一致');
  for(const name of group.remove){let target;try{target=await realpath(join(root,name));}catch(error){if(error.code==='ENOENT')continue;throw error;}guard(target);if(!relative(root,target)||relative(root,target).startsWith('..'))throw new Error('拒绝清理非验证目录目标');if(target===keep)throw new Error('保留与删除目标相同');
    const info=await stat(target);if(!info.isFile())throw new Error('清理目标不是普通文件');if(await hash(target)!==group.sha256)throw new Error('候选副本哈希不一致，保留文件');
    const row={file:name,bytes:info.size,sha256:group.sha256,retained:group.keep,deleted:false};receipt.files.push(row);await writeFile(receiptPath,JSON.stringify(receipt,null,2)+'\n','utf8');
    if(apply){await unlink(target);row.deleted=true;receipt.released_bytes+=info.size;await writeFile(receiptPath,JSON.stringify(receipt,null,2)+'\n','utf8');}
    console.log(JSON.stringify({file:name,bytes:info.size,deleted:row.deleted}));
  }
}
await writeFile(receiptPath,JSON.stringify(receipt,null,2)+'\n','utf8');console.log(JSON.stringify({receipt:relative(workspace,receiptPath),released_bytes:receipt.released_bytes}));
