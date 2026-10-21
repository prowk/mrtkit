import {readFile, writeFile} from 'node:fs/promises';
import {Writable} from 'node:stream';
import * as bridge from '../_build/js/release/build/bridge/bridge.js';
import {frames, inputChunks} from '../cli/input.mjs';
import {main} from '../cli/mrtkit.mjs';

// 完整文件逐条交给正式桥接，另外调用正式 CLI 核对相同输入的导出。
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const checked = text => {const result = JSON.parse(text); if (result.error) throw new Error(JSON.stringify(result)); return result;};
checked(bridge.configure(JSON.stringify({mode: 'changes', format: 'json', from_time: config.from, to_time: config.to,
  prefix: config.prefix, peer_asn: config.peer_asn, window_seconds: 60, threshold: 3, capacity: 1000})));
const notices = [];
let before;
for (const [index, file] of [config.rib, ...config.updates].entries()) {
  bridge.reset_file();
  if (index === 0) checked(bridge.begin_baseline());
  let ordinal = 0;
  for await (const frame of frames(inputChunks(file))) {
    if (index > 0 && before === undefined && frame.data.readUInt32BE(0) >= config.from) before = checked(bridge.state());
    notices.push(...checked(bridge.consume_at(frame.data, file, BigInt(++ordinal), BigInt(frame.offset))).lines.map(JSON.parse));
  }
  if (index === 0) checked(bridge.end_baseline());
}
const state = checked(bridge.state()), summary = checked(bridge.finish());
const capture = async args => {
  let output = '';
  const stdout = new Writable({write(chunk, encoding, done) {output += chunk.toString(); done();}});
  const stderr = new Writable({write(chunk, encoding, done) {done();}});
  await main(args, {stdout, stderr});
  return output;
};
const options = ['--prefix', config.prefix, '--peer-asn', String(config.peer_asn), '--from', String(config.from), '--to', String(config.to)];
const cliNotices = (await capture(['changes', ...options, '--threshold', '3', '--initial-rib', config.rib, ...config.updates])).trim().split('\n').filter(Boolean).map(JSON.parse);
if (JSON.stringify(cliNotices) !== JSON.stringify(notices)) throw new Error('正式 CLI 与逐条桥接的变化导出不同');
const jsonl = await capture(['parse', ...options, ...config.updates]);
const csv = await capture(['parse', ...options, '--format', 'csv', ...config.updates]);
await writeFile(process.argv[3], JSON.stringify({before, state, summary, notices, jsonl, csv}, null, 2) + '\n', 'utf8');
