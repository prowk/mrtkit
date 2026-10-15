import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demo, mrt, u16, u32, cat, bgpUpdate, attributes } from '../scripts/fixtures.mjs';

export function records(data) {
  const result = [];
  for (let p = 0; p < data.length;) {
    const end = p + 12 + data.readUInt32BE(p + 8);
    result.push(data.subarray(p, end)); p = end;
  }
  return result;
}
function cli(args, input) {
  const result = spawnSync(process.execPath, ['cli/mrtkit.mjs', ...args], { input, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

test('显式基线与完整历史回放的窗口变化一致，基线和预热不统计', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mrtkit-window-'));
  try {
    const parts = records(demo());
    const initial = join(dir, 'initial.mrt');
    const warm = join(dir, 'before.mrt');
    const next = join(dir, 'next.mrt');
    writeFileSync(initial, cat(...parts.slice(0, 2)));
    writeFileSync(warm, parts[2]);
    writeFileSync(next, cat(...parts.slice(3)));
    const range = ['--from', '1700000001', '--to', '1700000001'];
    const full = cli(['changes', ...range, '-'], demo());
    const seeded = cli(['changes', ...range, '--initial-rib', initial, warm, next]);
    const semantic = text => text.trim().split('\n').map(line => JSON.parse(line, (key, value) => key === 'source' ? undefined : value));
    assert.deepEqual(semantic(seeded.stdout), semantic(full.stdout));
    const summary = JSON.parse(cli(['stats', ...range, '--initial-rib', initial, warm, next]).stdout);
    assert.equal(summary.baseline_status, 'explicit_rib');
    assert.equal(summary.rib_routes, '0');
    assert.equal(summary.announcements, '1');
    assert.equal(summary.withdrawals, '0');
    assert.equal(summary.records, '1');
    assert.equal(summary.active_routes, 1);
    const late = JSON.parse(cli(['stats', '--from', '1700000003', '--to', '1700000003', '--initial-rib', initial, warm, next]).stdout);
    assert.equal(late.announcements, '1');
    assert.equal(late.path_changes, '0');
    assert.equal(late.warmup_records, '2');
    assert.equal(late.active_routes, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('跨文件微秒端点和前后会话重置均按同一窗口处理', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mrtkit-micros-'));
  try {
    const prefix = Buffer.from([24, 203, 0, 113]);
    const update = micros => {
      const raw = bgpUpdate(prefix, undefined, attributes([64512, 1]), 100);
      return mrt(17, 4, cat(u32(micros), raw.subarray(12)), 100);
    };
    const reset = micros => mrt(17, 5, cat(u32(micros), u32(64512), u32(64513), u16(0), u16(1), Buffer.from([192, 0, 2, 1, 192, 0, 2, 2]), u16(6), u16(1)), 100);
    const before = join(dir, 'before.mrt'), inside = join(dir, 'inside.mrt'), after = join(dir, 'after.mrt');
    writeFileSync(before, cat(update(400), reset(450), update(430)));
    writeFileSync(inside, cat(update(500), update(700)));
    writeFileSync(after, reset(701));
    const result = JSON.parse(cli(['stats', '--from', '100', '--from-micros', '500', '--to', '100', '--to-micros', '700', before, inside, after]).stdout);
    assert.equal(result.announcements, '2');
    assert.equal(result.records, '2');
    assert.equal(result.warmup_records, '3');
    assert.equal(result.session_resets, '0');
    assert.equal(result.active_routes, 1);
    assert.equal(JSON.parse(cli(['stats', '--from', '101', '--to', '101', '-'], Buffer.alloc(0)).stdout).baseline_status, 'missing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('初始 RIB 拒绝空文件、未来 peer 表和不支持的记录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mrtkit-baseline-invalid-'));
  try {
    const initial = join(dir, 'initial.mrt');
    const peers = mrt(13, 1, cat(u32(0), u16(0), u16(0)), 100);
    const cases = [Buffer.alloc(0), mrt(13, 1, cat(u32(0), u16(0), u16(0)), 200), mrt(13, 3, Buffer.alloc(0), 100), cat(peers, peers)];
    for (const data of cases) {
      writeFileSync(initial, data);
      const result = spawnSync(process.execPath, ['cli/mrtkit.mjs', 'stats', '--from', '100', '--initial-rib', initial, '-'],
        {input: Buffer.alloc(0), encoding: 'utf8', windowsHide: true});
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /初始 RIB/);
    }
  } finally {rmSync(dir, {recursive: true, force: true});}
});
