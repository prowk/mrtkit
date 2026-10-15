import { once } from 'node:events';
import { frames, inputChunks } from '../cli/input.mjs';
import * as bridge from '../_build/js/release/build/bridge/bridge.js';

// 逐记录写出，背压限制未消费输出；不保存整份事件集合。
const config = { mode: 'parse', format: 'json', from_time: 0, to_time: 4294967295, window_seconds: 60, threshold: 10, capacity: 1 };
const reply = JSON.parse(bridge.configure(JSON.stringify(config)));
if (reply.error) throw new Error(reply.error);
process.stdout.on('error', error => { if (error.code === 'EPIPE') process.exit(0); else throw error; });
for (const file of process.argv.slice(2)) {
  bridge.reset_file();
  let record = 0;
  for await (const frame of frames(inputChunks(file))) {
    const line = bridge.decode_record(frame.data, file, BigInt(++record), BigInt(frame.offset));
    if (!process.stdout.write(line + '\n', 'utf8')) await once(process.stdout, 'drain');
  }
}
