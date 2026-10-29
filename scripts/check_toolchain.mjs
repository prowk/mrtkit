import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

export function checkCompilerVersion(output) {
  const match = output.match(/^(?:moonc\s+)?v?(\d+)\.(\d+)\.(\d+)(?=[+\s]|$)/m);
  if (!match) throw new Error('无法识别 moonc 版本，请运行 moonc -v 检查工具链');
  const [major, minor, patch] = match.slice(1).map(Number);
  if (!(major > 0 || minor > 10 || (minor === 10 && patch >= 16))) {
    throw new Error(`需要 moonc >=0.10.16，当前为 ${major}.${minor}.${patch}`);
  }
  return `${major}.${minor}.${patch}`;
}

// 构建前检查真实编译器，避免将 moon 或项目版本当作验收依据。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = spawnSync('moonc', ['-v'], {encoding:'utf8',windowsHide:true});
  if (result.error || result.status !== 0) throw new Error('无法运行 moonc -v，请先安装 MoonBit 工具链');
  const output = result.stdout.trim();
  checkCompilerVersion(output);
  console.log(output);
}
