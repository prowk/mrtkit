import test from 'node:test';
import assert from 'node:assert/strict';
import {checkCompilerVersion} from '../scripts/check_toolchain.mjs';

test('编译器门槛拒绝旧版及错误工具版本，接受最低版本和后续版本', () => {
  for (const output of ['v0.10.14+7d59c7ec9 (2026-09-18)', 'moonc v0.10.15', 'v0.9.99', 'moon 0.1.20260920', 'mrtkit 0.2.1', 'unknown']) {
    assert.throws(() => checkCompilerVersion(output), undefined, output);
  }
  for (const output of ['v0.10.16+abcdef (2026-10-01)', 'moonc v0.10.16', 'v0.10.17', 'v0.11.0', 'v1.0.0']) {
    assert.doesNotThrow(() => checkCompilerVersion(output), output);
  }
});
