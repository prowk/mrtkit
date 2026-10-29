import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {realpath,stat} from 'node:fs/promises';
import {resolve,relative,sep,join} from 'node:path';
import {argumentsMap,positive} from '../cli/archive.mjs';
const args=argumentsMap(process.argv.slice(2),['--directory','--port']),root=await realpath(resolve(args['--directory']??'.validation/site')),port=positive(args['--port'],4173,65535);
// 只服务显式目录并检查真实路径，避免预览访问其他本地文件。
createServer(async(request,response)=>{try{const url=new URL(request.url,'http://localhost'),name=decodeURIComponent(url.pathname).replace(/^\/mrtkit\//,'/'),path=await realpath(resolve(root,'.'+(name.endsWith('/')?name+'index.html':name))),part=relative(root,path);if(part==='..'||part.startsWith('..'+sep))throw new Error('越界');if(!(await stat(path)).isFile())throw new Error('不是文件');response.writeHead(200,{'content-type':path.endsWith('.js')?'text/javascript; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':path.endsWith('.json')?'application/json; charset=utf-8':'text/html; charset=utf-8','cache-control':'no-store'});createReadStream(path).pipe(response);}catch{response.writeHead(404,{'content-type':'text/plain; charset=utf-8'});response.end('预览文件不存在');}}).listen(port,'127.0.0.1',()=>console.log(`http://127.0.0.1:${port}/mrtkit/`));
