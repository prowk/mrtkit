"""逐条 MRT 记录对照独立解析器；内存不随档案事件总数增长。"""
import argparse
import hashlib
import ipaddress
import json
import platform
import subprocess
import sys
import tempfile
import time
from collections import Counter
from itertools import zip_longest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.validation' / 'deps'))
import mrtparse


def code(mapping):
    return int(next(iter(mapping)))


def ip_key(text):
    return ipaddress.ip_address(text).packed.hex() if text else None


def prefix_key(text):
    network = ipaddress.ip_network(text, strict=False)
    return network.version, network.network_address.packed.hex(), network.prefixlen


def common(attrs):
    values = {code(a['type']): a['value'] for a in attrs}
    path = tuple((code(s['type']), tuple(map(int, s['value']))) for s in values.get(2, []))
    as4 = tuple((code(s['type']), tuple(map(int, s['value']))) for s in values.get(17, []))
    communities = tuple((int(c.split(':')[0]) << 16) | int(c.split(':')[1]) for c in values.get(8, []))
    large_wire = tuple(tuple(map(int, c.split(':'))) for c in values.get(32, []))
    return path, as4, ip_key(values.get(3)), code(values[1]) if 1 in values else None, values.get(4), values.get(5), communities, tuple(sorted(set(large_wire))), large_wire


def reference_records(path):
    peers = []
    reader = mrtparse.Reader(str(path))
    ordinal = 0
    try:
        while True:
            reader.err = 0
            try:
                record = next(reader)
            except StopIteration:
                break
            ordinal += 1
            data = record.data
            kind, subtype = code(data['type']), code(data['subtype'])
            supported = (kind == 13 and subtype in (1, 2, 4, 8, 10)) or (kind in (16, 17) and subtype in (0, 1, 4, 5, 6, 7, 8, 9, 10, 11))
            if record.err and supported:
                raise ValueError(f'{path} 记录 {ordinal}: mrtparse: {record.err_msg}')
            timestamp = code(data['timestamp'])
            micros = data.get('microsecond_timestamp')
            events, states = Counter(), Counter()
            ignored = Counter()
            if kind == 13 and subtype == 1:
                peers = data['peer_entries']
            elif kind == 13 and subtype in (2, 4, 8, 10):
                network = prefix_key(f"{data['prefix']}/{data['length']}")
                for rib in data['rib_entries']:
                    peer = peers[rib['peer_index']]
                    attrs = rib['path_attributes']
                    values = common(attrs)
                    hop = next((a['value']['next_hop'][0] for a in attrs if code(a['type']) == 14), None)
                    if hop:
                        values = (*values[:2], ip_key(hop), *values[3:])
                    events[(timestamp, micros, 'rib', network, int(peer['peer_as']), ip_key(peer['peer_ip']), False, rib.get('path_id'), code(rib['originated_time']), *values)] += 1
            elif kind in (16, 17) and supported:
                if subtype in (0, 5):
                    states[(timestamp, micros, int(data['peer_as']), ip_key(data['peer_ip']), code(data['old_state']), code(data['new_state']))] += 1
                else:
                    message = data['bgp_message']
                    if code(message['type']) == 2:
                        attrs = message['path_attributes']
                        values = common(attrs)
                        def add(action, entries, hop=None):
                            route_values = values if action != 'withdraw' else ((), (), None, None, None, None, (), (), ())
                            if hop and action != 'withdraw':
                                route_values = (*route_values[:2], ip_key(hop), *route_values[3:])
                            for item in entries:
                                network = prefix_key(f"{item['prefix']}/{item['length']}")
                                events[(timestamp, micros, action, network, int(data['peer_as']), ip_key(data['peer_ip']), subtype in (6, 7, 10, 11), item.get('path_id'), None, *route_values)] += 1
                        add('withdraw', message['withdrawn_routes'])
                        add('announce', message['nlri'])
                        for attribute in attrs:
                            c = code(attribute['type'])
                            if c not in (14, 15):
                                continue
                            value = attribute['value']
                            afi, safi = code(value['afi']), code(value['safi'])
                            if afi not in (1, 2) or safi != 1:
                                ignored[(kind, subtype, afi, safi)] += 1
                            elif c == 14:
                                add('announce', value['nlri'], value['next_hop'][0])
                            else:
                                add('withdraw', value['withdrawn_routes'])
            yield {'ordinal': ordinal, 'header': (timestamp, micros, kind, subtype), 'events': events, 'states': states, 'skipped': not supported, 'ignored': ignored}
    finally:
        reader.f.close()


def actual_record(batch, ordinal):
    if 'error' in batch:
        raise ValueError(f"记录 {ordinal}: MoonBit: {batch}")
    events, states = Counter(), Counter()
    for event in batch['events']:
        if int(event['source']['record']) != ordinal:
            raise AssertionError('实际来源记录号不匹配')
        attrs = event['attributes']
        path = tuple((s['kind'], tuple(s['asns'])) for s in attrs['wire_path'])
        as4 = tuple((s['kind'], tuple(s['asns'])) for s in attrs['as4_path'])
        raw = next((a['value'] for a in attrs['other'] if a['code'] == 32), [])
        wire = tuple(tuple(int.from_bytes(bytes(raw[i + j:i + j + 4]), 'big') for j in (0, 4, 8)) for i in range(0, len(raw), 12))
        values = (path, as4, ip_key(attrs.get('next_hop')), attrs.get('origin'), attrs.get('med'), attrs.get('local_pref'), tuple(attrs['communities']), tuple(map(tuple, attrs['large_communities'])), wire)
        events[(event['timestamp'], event.get('microseconds'), event['action'], prefix_key(event['prefix']), event['peer_asn'], ip_key(event['peer_ip']), event['outbound'], event.get('path_id'), event.get('originated'), *values)] += 1
    for state in batch['states']:
        states[(state['timestamp'], state.get('microseconds'), state['peer_asn'], ip_key(state['peer_ip']), state['old_state'], state['new_state'])] += 1
    header = batch['header']
    ignored = Counter((d['mrt_type'], d['subtype'], d['afi'], d['safi']) for d in batch['diagnostics'] if d['kind'] == 'mp')
    return {'ordinal': ordinal, 'header': (header['timestamp'], batch.get('microseconds'), header['kind'], header['subtype']), 'events': events, 'states': states, 'skipped': batch['skipped'], 'ignored': ignored}


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1048576), b''):
            digest.update(chunk)
    return digest.hexdigest()


def compare(path):
    records = events = state_events = peak_record_events = skipped = ignored = 0
    first_time = last_time = None
    started = time.perf_counter()
    # 标准错误写入临时文件，不在进程管道中累计或阻塞。
    with tempfile.TemporaryFile(mode='w+b') as diagnostics:
        process = subprocess.Popen(['node', 'scripts/decoded_records.mjs', str(path)], cwd=ROOT, stdout=subprocess.PIPE, stderr=diagnostics, text=True, encoding='utf-8')
        try:
            for expected, line in zip_longest(reference_records(path), process.stdout):
                if expected is None or line is None:
                    raise AssertionError('两种解析器输出的 MRT 记录数不同')
                records += 1
                actual = actual_record(json.loads(line), records)
                if actual != expected:
                    difference = {key: {'expected': repr(expected[key])[:1500], 'actual': repr(actual[key])[:1500]} for key in expected if expected[key] != actual[key]}
                    raise AssertionError(f'{path} 记录 {records} 不一致: {difference}')
                count = expected['events'].total()
                events += count
                state_events += expected['states'].total()
                peak_record_events = max(peak_record_events, count)
                skipped += expected['skipped']
                ignored += expected['ignored'].total()
                stamp = expected['header'][0]
                first_time = stamp if first_time is None else min(first_time, stamp)
                last_time = stamp if last_time is None else max(last_time, stamp)
                if records % 100000 == 0:
                    print(json.dumps({'progress': str(path), 'records': records, 'events': events}), file=sys.stderr, flush=True)
            if process.wait() != 0:
                diagnostics.seek(max(0, diagnostics.tell() - 8192))
                raise RuntimeError(diagnostics.read().decode('utf-8', errors='replace'))
        finally:
            process.stdout.close()
            if process.poll() is None:
                process.kill()
            process.wait()
    return {'sample': path.name, 'records': records, 'events': events, 'state_events': state_events, 'matched': True, 'bytes': path.stat().st_size,
            'sha256': sha256(path), 'first_timestamp': first_time, 'last_timestamp': last_time, 'skipped_records': skipped,
            'ignored_families': ignored, 'peak_record_events': peak_record_events, 'seconds': round(time.perf_counter() - started, 3)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('files', nargs='*', type=Path)
    parser.add_argument('--report', type=Path, default=ROOT / '.validation' / 'comparison.json')
    args = parser.parse_args()
    paths = args.files or [ROOT / '.validation' / (name + '.mrt') for name in ('ris-updates', 'ris-rib')]
    reports = []
    for path in paths:
        report = compare(path.resolve())
        reports.append(report)
        print(json.dumps(report), flush=True)
    payload = {'reference': f'mrtparse {mrtparse.__version__}', 'python': platform.python_version(),
               'node': subprocess.check_output(['node', '--version'], text=True, encoding='utf-8').strip(),
               'moon': subprocess.check_output(['moon', '--version'], text=True, encoding='utf-8').strip(),
               'memory_contract': 'one MRT record per parser plus peer index table; event multiplicity retained per record',
               'command': 'python ' + ' '.join(sys.argv), 'checked_fields': ['timestamp', 'microseconds', 'action', 'prefix', 'peer ASN/IP', 'direction', 'path_id', 'originated', 'wire AS_PATH', 'AS4_PATH', 'next_hop', 'ORIGIN', 'MED', 'LOCAL_PREF', 'COMMUNITY', 'Large Communities including wire order', 'session states', 'unsupported type and AFI/SAFI'], 'samples': reports}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(payload, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
