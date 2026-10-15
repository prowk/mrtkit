"""完整下载两个采集器的 RIB 与连续一小时 UPDATE，保留原始压缩档案。"""
import argparse
import concurrent.futures
import hashlib
import json
import os
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def sources():
    result = []
    for collector, base, suffix in [
        ('ris-rrc23', 'https://data.ris.ripe.net/rrc23/2025.01/', '.gz'),
        ('rv-sfmix', 'https://archive.routeviews.org/route-views.sfmix/bgpdata/2025.01/', '.bz2'),
    ]:
        is_ris = collector.startswith('ris')
        rib = 'bview.20250101.0000.gz' if is_ris else 'RIBS/rib.20250101.0000.bz2'
        result.append({'collector': collector, 'kind': 'rib', 'url': base + rib})
        for minute in range(0, 60, 5 if is_ris else 15):
            update = f'updates.20250101.00{minute:02d}{suffix}'
            result.append({'collector': collector, 'kind': 'update', 'url': base + ('' if is_ris else 'UPDATES/') + update})
    return result


def digest(path):
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1048576), b''):
            hasher.update(chunk)
    return hasher.hexdigest()


def download(item, directory):
    name = item['collector'] + '-' + item['url'].rsplit('/', 1)[1]
    path = directory / name
    if not path.exists():
        temporary = path.with_name(path.name + '.partial')
        size = 0
        with urllib.request.urlopen(item['url'], timeout=60) as response, temporary.open('wb') as output:
            for chunk in iter(lambda: response.read(1048576), b''):
                size += len(chunk)
                if size > 1073741824:
                    raise ValueError('压缩档案超过 1 GiB 安全上限')
                output.write(chunk)
            expected = response.headers.get('Content-Length')
            if expected and size != int(expected):
                raise ValueError('档案下载长度不匹配')
        os.replace(temporary, path)
    report = {**item, 'file': name, 'complete_archive': True, 'bytes': path.stat().st_size, 'sha256': digest(path)}
    print(json.dumps(report), flush=True)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=ROOT / '.validation' / 'archives')
    args = parser.parse_args()
    args.directory.mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        reports = list(executor.map(lambda item: download(item, args.directory), sources()))
    (args.directory / 'manifest.json').write_text(json.dumps(reports, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
