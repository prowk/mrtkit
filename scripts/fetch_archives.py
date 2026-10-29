"""通过统一 CLI 发现档案、校验缓存并生成可移植 manifest。"""
import argparse
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=ROOT / '.validation' / 'archives')
    parser.add_argument('--plan', type=Path)
    parser.add_argument('--offline', action='store_true')
    parser.add_argument('--timeout-ms', type=int, default=60000)
    parser.add_argument('--retries', type=int, default=3, help='最多尝试次数，包含第一次')
    parser.add_argument('--concurrency', type=int, default=2)
    parser.add_argument('--max-bytes', type=int, default=2147483648)
    args = parser.parse_args()
    args.directory.mkdir(parents=True, exist_ok=True)
    node = os.environ.get('MRTKIT_NODE', 'node')
    cli = str(ROOT / 'cli' / 'mrtkit.mjs')
    plan = args.plan or args.directory / 'plan.json'
    if not plan.exists():
        if args.offline:
            parser.error('离线模式需要已有 --plan 或缓存目录中的 plan.json')
        subprocess.run([node, cli, 'plan', '--collector', 'ris:rrc23', '--collector', 'rv:route-views.sfmix',
                        '--from', '2025-01-01T00:00:00Z', '--to', '2025-01-01T01:00:00Z', '--output', str(plan)], check=True)
    subprocess.run([node, cli, 'cache', '--plan', str(plan), '--directory', str(args.directory),
                    '--offline', str(args.offline).lower(), '--timeout-ms', str(args.timeout_ms), '--retries', str(args.retries),
                    '--concurrency', str(args.concurrency), '--max-bytes', str(args.max_bytes)], check=True)


if __name__ == '__main__':
    main()
