import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const file='.validation/full-replay-v020-buffered/report.json',bytes=await readFile(file),report=JSON.parse(bytes),root=process.cwd();
assert.equal(report.complete,false);assert.equal(report.runs.length,1);assert.equal(report.runs[0].accepted,false);
assert.match(report.runs[0].partial_point.error,/RSS/);
const clean=value=>Array.isArray(value)?value.map(clean):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,child])=>[key,clean(child)])):typeof value==='string'?value.split(root).join('<workspace>'):value;
await writeFile('docs/validation/full-replay-rss-rejected.json',JSON.stringify({...clean(report),raw_report_sha256:createHash('sha256').update(bytes).digest('hex'),accepted:false,
  explanation:'Inputs reached EOF, all route states and change files were written and shared validation completed. Rejected by old conservative upper bound parent_all_phases_peak + max_peer_peak, which also sums nonconcurrent post-peer verification peaks. This failed acceptance remains failed; future attempts must use unchanged budgets and newly measured serial-phase bounds.',
  missing_measurement:'The old failure path did not emit an exact parent maxRSS receipt; it is unknown and must not be inferred as a measured value.'},null,2)+'\n','utf8');
