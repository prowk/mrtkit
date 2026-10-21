import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {main, errorText} from '../cli/mrtkit.mjs';
import {demo, mrt, cat, u16, u32, attributes, bgpUpdate} from '../scripts/fixtures.mjs';

const route = bgpUpdate(Buffer.from([24, 203, 0, 113]), undefined, attributes([64512, 1]), 100);
function cli(args, input) {
  return spawnSync(process.execPath, ['cli/mrtkit.mjs', ...args], {input, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024});
}
function directory(run) {
  const dir = mkdtempSync(join(tmpdir(), 'mrtkit-failures-'));
  try {return run(dir);} finally {rmSync(dir, {recursive: true, force: true});}
}

test('记录错误明确区分文件、记录序号、解压后偏移和局部位置，已有 stdout 为部分结果', () => {
  const bad = mrt(16, 4, Buffer.alloc(0), 101);
  const result = cli(['parse', '-'], cat(route, bad));
  assert.equal(result.status, 1);
  assert.equal(result.stdout.trim().split('\n').map(JSON.parse).length, 1);
  assert.ok(result.stderr.includes(`记录 2，文件偏移 ${route.length}，解析器局部偏移 0`));
  assert.match(result.stderr, /部分结果/);
  assert.equal(result.stdout.includes('mrtkit:'), false);
  assert.equal(result.stderr.includes('已处理 '), false);
  const truncated = cli(['parse', '-'], cat(route, route.subarray(0, 14)));
  assert.equal(truncated.status, 1);
  assert.ok(truncated.stderr.includes(`记录偏移 ${route.length}`));
  assert.match(truncated.stderr, /截断/);
  assert.equal(truncated.stderr.includes('解析器局部偏移'), false);
});

test('无效 peer 索引与资源超限不输出完整摘要，CSV 头不冒充完整数据', () => {
  const peer = mrt(13, 1, cat(u32(1), u16(0), u16(1), Buffer.from([2]), u32(1), Buffer.from([192, 0, 2, 1]), u32(64512)), 100);
  const attrs = attributes([64512, 1]);
  const rib = mrt(13, 2, cat(u32(0), Buffer.from([24, 203, 0, 113]), u16(1), u16(1), u32(99), u16(attrs.length), attrs), 100);
  const invalid = cli(['parse', '-'], cat(peer, rib));
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
  assert.ok(invalid.stderr.includes(`文件偏移 ${peer.length}，解析器局部偏移 10`));
  assert.match(invalid.stderr, /peer 索引/);
  const capacity = cli(['stats', '--capacity', '1', '-'], demo());
  assert.equal(capacity.status, 1); assert.equal(capacity.stdout, ''); assert.match(capacity.stderr, /容量/);
  const header = Buffer.alloc(12); header.writeUInt32BE(16777217, 8);
  const excessive = cli(['parse', '--format', 'csv', '-'], header);
  assert.equal(excessive.status, 1);
  assert.equal(excessive.stdout.trim().split('\n').length, 1);
  assert.ok(excessive.stdout.startsWith('schema_version,'));
  assert.match(excessive.stderr, /16 MiB/); assert.match(excessive.stderr, /部分结果/);
});

test('gzip 尾部校验失败与快照解压失败明确报错，诊断不进入数据流', () => directory(dir => {
  const packed = gzipSync(cat(...Array(2000).fill(route)));
  packed[packed.length - 8] ^= 1;
  const broken = join(dir, 'bad-crc.mrt.gz'); writeFileSync(broken, packed);
  const result = cli(['parse', broken]);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(broken));
  assert.equal(result.stdout.includes('mrtkit:'), false);
  for (const line of result.stdout.trim().split('\n').filter(Boolean)) JSON.parse(line);
  if (result.stdout) assert.match(result.stderr, /部分结果/);
  const snapshot = cli(['snapshot-diff', '--collector', 'test', broken, broken]);
  assert.equal(snapshot.status, 1); assert.equal(snapshot.stdout, '');
  assert.ok(snapshot.stderr.includes(broken));
}));

test('磁盘满、输出权限错误和损坏管道的写回调失败均有明确错误状态', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mrtkit-output-'));
  try {
    const path = join(dir, 'input.mrt'); writeFileSync(path, route);
    for (const code of ['ENOSPC', 'EACCES', 'EPIPE']) {
      const failure = Object.assign(new Error('模拟输出写入失败'), {code});
      const stdout = {write: (_text, _encoding, callback) => callback(failure)};
      const stderr = {write: (_text, _encoding, callback) => callback()};
      await assert.rejects(main(['parse', path], {stdout, stderr}), error => {
        assert.equal(error.code, code);
        assert.equal(error.stage, 'output');
        assert.equal(error.partial_result, true);
        assert.match(errorText(error), /输出失败/); assert.match(errorText(error), /部分结果/);
        return true;
      });
    }
  } finally {rmSync(dir, {recursive: true, force: true});}
});

test('真实 stdout 管道接收端关闭时 CLI 非零退出，不把 EPIPE 静默当成功', {timeout: 15000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mrtkit-pipe-'));
  let child;
  try {
    const path = join(dir, 'input.mrt'); writeFileSync(path, cat(...Array(1000).fill(route)));
    child = spawn(process.execPath, ['cli/mrtkit.mjs', 'parse', path], {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    child.stdout.destroy();
    let error = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', text => {error += text;});
    const code = await new Promise((resolve, reject) => {child.once('error', reject); child.once('close', resolve);});
    assert.equal(code, 1, error);
    assert.match(error, /输出失败.*EPIPE/);
  } finally {child?.kill(); rmSync(dir, {recursive: true, force: true});}
});
