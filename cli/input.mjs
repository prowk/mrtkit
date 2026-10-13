import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

// 仅文件传输和解压使用 Node/Python，协议解析由 MoonBit 完成。
export async function* inputChunks(path) {
  if (path.endsWith('.bz2')) {
    const script = 'import bz2,sys,shutil\nwith bz2.open(sys.argv[1],"rb") as f: shutil.copyfileobj(f,sys.stdout.buffer,65536)';
    const child = spawn(process.env.MRTKIT_PYTHON || 'python', ['-c', script, path], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let diagnostic = '';
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(-4096); });
    // 捕获进程失败，待流读取结束再统一报告，避免未处理的拒绝。
    const completion = new Promise(resolve => {
      child.once('error', error => resolve(error));
      child.once('close', code => resolve(code === 0 ? null : new Error(`bz2 解压失败 (${code}): ${diagnostic}`)));
    });
    try {
      yield* child.stdout;
      const error = await completion;
      if (error) throw error;
    } finally { child.kill(); }
    return;
  }
  const source = path === '-' ? process.stdin : createReadStream(path, { highWaterMark: 65536 });
  if (!path.endsWith('.gz')) {
    try { yield* source; } finally { if (source !== process.stdin) source.destroy(); }
    return;
  }
  const unzip = createGunzip();
  const completion = pipeline(source, unzip).then(() => null, error => error);
  try {
    yield* unzip;
    const error = await completion;
    if (error) throw error;
  } finally { source.destroy(); unzip.destroy(); await completion; }
}

// 每次最多分配一条记录，防止整个 RIB 文件进入内存。
export async function* frames(chunks) {
  let record = Buffer.alloc(12);
  let filled = 0;
  let offset = 0;
  for await (const chunk of chunks) {
    let position = 0;
    while (position < chunk.length) {
      const count = Math.min(record.length - filled, chunk.length - position);
      chunk.copy(record, filled, position, position + count);
      filled += count;
      position += count;
      if (filled !== record.length) continue;
      if (record.length === 12) {
        const length = record.readUInt32BE(8);
        if (length > 16777216) throw new Error(`记录偏移 ${offset}: MRT 长度超过 16 MiB`);
        if (length > 0) {
          const body = Buffer.allocUnsafe(12 + length);
          record.copy(body);
          record = body;
          continue;
        }
      }
      yield { data: record, offset };
      offset += record.length;
      record = Buffer.alloc(12);
      filled = 0;
    }
  }
  if (filled) throw new Error(`记录偏移 ${offset}: 文件结束时记录截断 (${filled}/${record.length} 字节)`);
}
