"""核查待发布源码包的运行资产和本地材料排除规则。"""
import hashlib
import json
import re
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
package = json.loads((root / 'package.json').read_text(encoding='utf-8'))
version = package['version']
assert re.search(r'^version\s*=\s*"' + re.escape(version) + r'"', (root / 'moon.mod').read_text(encoding='utf-8'), re.M)
path = root / '_build' / 'publish' / f'prowk-mrtkit-{version}.zip'
with zipfile.ZipFile(path) as archive:
    names = archive.namelist()
    forbidden = []
    for name in names:
        parts = Path(name).parts
        if name.startswith(('/', '\\')) or '..' in parts or any(part in ('.validation', '.git', '.agents', '.codex') for part in parts):
            forbidden.append(name)
        if any(word in name.lower() for word in ('申报', '参考.md', 'todo.md', 'plan.md', 'roadmap.md')):
            forbidden.append(name)
    assert not forbidden, forbidden
    assert len(names) == len(set(names)), 'ZIP 条目重复'
    required = [str(file.relative_to(root)).replace('\\', '/') for file in (root / 'cli').iterdir() if file.suffix in ('.mjs', '.js', '.html')]
    required += ['scripts/check_toolchain.mjs', 'moonbit-toolchain.version', 'package.json']
    for name in required:
        assert name in names, f'缺少运行文件 {name}'
        # 打包器可能规范化换行；源文件与打包文本必须逐字相同。
        assert archive.read(name).decode('utf-8').replace('\r\n', '\n') == (root / name).read_text(encoding='utf-8').replace('\r\n', '\n'), name
    metadata = json.loads(archive.read('moon.mod.json')) if 'moon.mod.json' in names else None
    if metadata:
        assert metadata['name'] == 'prowk/mrtkit' and metadata['version'] == version
receipt = {'version': version, 'zip': path.name, 'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'files': len(names), 'runtime_assets_checked': required, 'forbidden_files': forbidden, 'passed': True}
(root / '.validation' / f'package-audit-{version}.json').write_text(json.dumps(receipt, indent=2)+'\n', encoding='utf-8')
print(json.dumps(receipt))
