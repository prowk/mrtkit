import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// 先核对全部工作量和状态相同，再发布速度与内存的比较。
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const before = read('.validation/benchmark-before.json');
const after = read('.validation/benchmark-after.json');
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const original = digest('.validation/baseline-bridge.js');
const reproduced = digest('.validation/baseline-source/_build/js/release/build/bridge/bridge.js');
assert.equal(original, reproduced, '优化前构建必须可由基准提交精确重建');
before.bridge_sha256 = original;
before.source_revision = '94bd9d0';
assert.equal(after.bridge_sha256, digest('_build/js/release/build/bridge/bridge.js'), '优化后构建已变化，应重新测量');
for (const key of ['platform', 'release', 'arch', 'cpu', 'logical_cpus', 'node', 'moon', 'python']) assert.equal(before.environment[key], after.environment[key]);
assert.deepEqual(before.inputs, after.inputs);
assert.equal(before.repeats, 3); assert.equal(after.repeats, 3);
assert.equal(before.runs.length, 24); assert.equal(after.runs.length, 24);
assert.equal(before.medians.length, 8); assert.equal(after.medians.length, 8);
const median = values => [...values].sort((a, b) => a - b)[1];
const comparisons = [];
for (const old of before.medians) {
  const next = after.medians.find(row => row.name === old.name);
  assert.ok(next);
  const a = before.runs.filter(row => row.name === old.name);
  const b = after.runs.filter(row => row.name === old.name);
  assert.equal(a.length, 3); assert.equal(b.length, 3);
  for (let i = 0; i < 3; i++) {
    for (const key of ['mode', 'files', 'initial_rib', 'configuration', 'records', 'route_events', 'state_events',
      'decompressed_bytes', 'compressed_bytes', 'active_routes', 'cached_routes', 'summary', 'failure', 'exit_code'])
      assert.deepEqual(a[i][key], b[i][key], `${old.name} ${key}`);
    assert.equal(a[i].exit_code, old.name === 'complete_rib_capacity_failure' ? 2 : 0);
    assert.ok(Number.isFinite(a[i].seconds) && a[i].seconds > 0 && Number.isFinite(b[i].seconds) && b[i].seconds > 0);
  }
  for (const key of ['seconds', 'records_per_second', 'route_events_per_second', 'decompressed_mib_per_second', 'peak_rss_bytes']) {
    assert.equal(old[key], median(a.map(row => row[key])));
    assert.equal(next[key], median(b.map(row => row[key])));
  }
  comparisons.push({name: old.name, before: old, after: next, elapsed_speedup: old.seconds / next.seconds,
    peak_rss_ratio: next.peak_rss_bytes / old.peak_rss_bytes,
    selected_analysis_events: b[0].selected_analysis_events ?? 0});
}
const report = {scope: 'same fixed workloads, three fresh serial processes per version; medians; state and event counts verified identical',
  baseline_reproduced: true, comparisons};
for (const [file, value] of [['benchmark-before.json', before], ['benchmark-after.json', after], ['benchmark-comparison.json', report]])
  writeFileSync(`docs/${file}`, JSON.stringify(value, null, 2) + '\n', 'utf8');
process.stdout.write(JSON.stringify(comparisons.map(r => ({name: r.name, seconds_before: r.before.seconds, seconds_after: r.after.seconds,
  speedup: r.elapsed_speedup, memory_ratio: r.peak_rss_ratio, analyzed: r.selected_analysis_events})), null, 2) + '\n');
