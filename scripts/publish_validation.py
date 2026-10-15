"""校验完整档案验证结果，发布不含档案本体的复现元数据。"""
import json
import platform
import subprocess
from datetime import datetime, timezone
from pathlib import Path

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / '.validation/archives/manifest.json').read_text(encoding='utf-8'))
report = json.loads((root / '.validation/complete-comparison.json').read_text(encoding='utf-8'))
sources = {item['file']: item for item in manifest}
assert len(sources) == len(manifest) == len(report['samples']) == 18
assert {sample['sample'] for sample in report['samples']} == set(sources)
for sample in report['samples']:
    source = sources[sample['sample']]
    assert sample['matched'] is True
    assert sample['bytes'] == source['bytes']
    assert sample['sha256'] == source['sha256']
    sample['collector'] = source['collector']
    sample['kind'] = source['kind']
    sample['url'] = source['url']
    sample['complete_archive'] = True
report['environment_recorded_at'] = datetime.now(timezone.utc).isoformat()
report['platform'] = platform.platform()
for tool in ('node', 'moon'):
    report[tool] = subprocess.check_output([tool, '--version'], text=True, encoding='utf-8').strip()
report['totals'] = {key: sum(s[key] for s in report['samples']) for key in ('records', 'events', 'state_events', 'bytes', 'skipped_records', 'ignored_families')}
for name, value in [('archive-manifest.json', manifest), ('archive-comparison.json', report)]:
    (root / 'docs' / name).write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report['totals']))
