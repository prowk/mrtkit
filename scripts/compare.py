"""逐条 MRT 记录对照独立解析器；内存不随档案事件总数增长。"""
import argparse
import bz2
import gzip
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
from reference_wire import RecordingInput, ReferenceRecord, attribute_blocks, raw_attributes


def code(mapping):
    return int(next(iter(mapping)))


def ip_key(text):
    return ipaddress.ip_address(text).packed.hex() if text else None


def prefix_key(text):
    network = ipaddress.ip_network(text, strict=False)
    return network.version, network.network_address.packed.hex(), network.prefixlen


def common(attrs, raw=b'', width=4):
    values = {code(a['type']): a['value'] for a in attrs}
    path = tuple((code(s['type']), tuple(map(int, s['value']))) for s in values.get(2, []))
    as4 = tuple((code(s['type']), tuple(map(int, s['value']))) for s in values.get(17, []))
    communities = tuple((int(c.split(':')[0]) << 16) | int(c.split(':')[1]) for c in values.get(8, []))
    large_wire = tuple(tuple(map(int, c.split(':'))) for c in values.get(32, []))
    def aggregation(number):
        value = values.get(number)
        return (int(value['as']), ip_key(value['id'])) if value else None
    wire, as4_aggregate = aggregation(7), aggregation(18)
    effective = wire
    if width == 2 and as4_aggregate is not None and (wire is None or wire[0] == 23456):
        effective = as4_aggregate
    return (path, as4, ip_key(values.get(3)), code(values[1]) if 1 in values else None, values.get(4), values.get(5),
            communities, tuple(sorted(set(large_wire))), large_wire, 6 in values, wire, as4_aggregate, effective, raw_attributes(raw))


def reference_records(path):
    peers = []
    stream = gzip.open(path, 'rb') if path.suffix == '.gz' else bz2.open(path, 'rb') if path.suffix == '.bz2' else path.open('rb')
    recording = RecordingInput(stream)
    reader = mrtparse.Reader(recording)
    peer_frame = None
    ordinal = 0
    try:
        while True:
            reader.err = 0
            recording.parts = []
            record_offset = recording.offset
            try:
                record = next(reader)
            except StopIteration:
                break
            ordinal += 1
            raw = b''.join(recording.parts)
            data = record.data
            kind, subtype = code(data['type']), code(data['subtype'])
            supported = (kind == 13 and subtype in (1, 2, 4, 8, 10)) or (kind in (16, 17) and subtype in (0, 1, 4, 5, 6, 7, 8, 9, 10, 11))
            if record.err and supported:
                raise ValueError(f'{path} 记录 {ordinal}: mrtparse: {record.err_msg}')
            timestamp = code(data['timestamp'])
            micros = data.get('microsecond_timestamp')
            events, states = Counter(), Counter()
            ignored = Counter()
            blocks = attribute_blocks(raw)
            if kind == 13 and subtype == 1:
                peers = data['peer_entries']
                peer_frame = raw
            elif kind == 13 and subtype in (2, 4, 8, 10):
                network = prefix_key(f"{data['prefix']}/{data['length']}")
                for rib, block in zip(data['rib_entries'], blocks, strict=True):
                    peer = peers[rib['peer_index']]
                    attrs = rib['path_attributes']
                    values = common(attrs, block)
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
                        values = common(attrs, blocks[0], 4 if subtype in (4, 7, 9, 11) else 2)
                        def add(action, entries, hop=None):
                            route_values = values if action != 'withdraw' else common([])
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
            yield ReferenceRecord({'ordinal': ordinal, 'header': (timestamp, micros, kind, subtype), 'events': events, 'states': states,
                                   'skipped': not supported, 'ignored': ignored}, raw, record_offset, peer_frame)
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
        def aggregation(name):
            value = attrs.get(name)
            return (value['asn'], ip_key(value['address'])) if value else None
        raw_values = tuple((a['code'], a['flags'], bytes(a['value']).hex()) for a in attrs.get('raw_attributes', []))
        values = (*values, attrs.get('atomic_aggregate', False), aggregation('wire_aggregator'), aggregation('as4_aggregator'), aggregation('aggregator'), raw_values)
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


def save_mismatch(path, expected, actual, error):
    directory = ROOT / '.validation' / 'mismatches'
    directory.mkdir(parents=True, exist_ok=True)
    name = f"{path.name}.record-{expected['ordinal']}"
    raw = expected.raw
    # RIB 的原始 peer 表是解码此条记录所需的最小上下文，不改写原始索引。
    context = expected.peer_frame if expected['header'][2] == 13 and expected['header'][3] != 1 else None
    reproduction = directory / (name + '.mrt')
    reproduction.write_bytes((context or b'') + raw)
    metadata = {'source': str(path), 'record': expected['ordinal'], 'decompressed_offset': expected.offset,
                'reason': str(error), 'actual': actual, 'reproduction': str(reproduction),
                'command': ['node', 'cli/mrtkit.mjs', 'parse', str(reproduction)]}
    (directory / (name + '.json')).write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return {'record': expected['ordinal'], 'offset': expected.offset, 'reason': str(error), 'reproduction': str(reproduction)}


def compare(path, keep_going=False):
    records = events = state_events = peak_record_events = skipped = ignored = 0
    first_time = last_time = None
    mismatches = []
    mismatch_count = 0
    started = time.perf_counter()
    # 标准错误写入临时文件，不在进程管道中累计或阻塞。
    with tempfile.TemporaryFile(mode='w+b') as diagnostics:
        process = subprocess.Popen(['node', 'scripts/decoded_records.mjs', str(path)], cwd=ROOT, stdout=subprocess.PIPE, stderr=diagnostics, text=True, encoding='utf-8')
        try:
            for expected, line in zip_longest(reference_records(path), process.stdout):
                if expected is None or line is None:
                    raise AssertionError('两种解析器输出的 MRT 记录数不同')
                records += 1
                decoded = json.loads(line)
                try:
                    actual = actual_record(decoded, records)
                    if actual != expected:
                        difference = {key: {'expected': repr(expected[key])[:1500], 'actual': repr(actual[key])[:1500]} for key in expected if expected[key] != actual[key]}
                        raise AssertionError(f'字段不一致: {difference}')
                except (AssertionError, ValueError) as error:
                    evidence = save_mismatch(path, expected, decoded, error)
                    mismatch_count += 1
                    # 摘要只保留前十条，全部复现和原因逐条落盘，不随失败总数驻留内存。
                    if len(mismatches) < 10:
                        mismatches.append(evidence)
                    print(json.dumps({'mismatch': str(path), **evidence}, ensure_ascii=False), file=sys.stderr, flush=True)
                    if not keep_going:
                        raise
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
    return {'sample': path.name, 'records': records, 'events': events, 'state_events': state_events, 'matched': mismatch_count == 0,
            'mismatch_count': mismatch_count, 'mismatches': mismatches, 'mismatch_directory': '.validation/mismatches' if mismatch_count else None,
            'complete_file_compared': True, 'bytes': path.stat().st_size,
            'sha256': sha256(path), 'first_timestamp': first_time, 'last_timestamp': last_time, 'skipped_records': skipped,
            'ignored_families': ignored, 'peak_record_events': peak_record_events, 'seconds': round(time.perf_counter() - started, 3)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('files', nargs='*', type=Path)
    parser.add_argument('--report', type=Path, default=ROOT / '.validation' / 'comparison.json')
    parser.add_argument('--keep-going', action='store_true', help='逐记录保留差异并继续核对；存在差异仍非零退出')
    args = parser.parse_args()
    paths = args.files or [ROOT / '.validation' / (name + '.mrt') for name in ('ris-updates', 'ris-rib')]
    reports = []
    for path in paths:
        try:
            report = compare(path.resolve(), keep_going=args.keep_going)
        except Exception as error:
            report = {'sample': path.name, 'matched': False, 'complete_file_compared': False, 'error': str(error),
                      'bytes': path.stat().st_size, 'sha256': sha256(path)}
        reports.append(report)
        print(json.dumps(report), flush=True)
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps({'status': 'running', 'samples': reports}, indent=2) + '\n', encoding='utf-8')
    payload = {'reference': f'mrtparse {mrtparse.__version__}', 'python': platform.python_version(),
               'node': subprocess.check_output(['node', '--version'], text=True, encoding='utf-8').strip(),
               'moon': subprocess.check_output(['moon', '--version'], text=True, encoding='utf-8').strip(),
               'memory_contract': 'one MRT record per parser plus peer index table; event multiplicity retained per record',
               'command': 'python ' + ' '.join(sys.argv), 'checked_fields': ['timestamp', 'microseconds', 'action', 'prefix', 'peer ASN/IP', 'direction', 'path_id', 'originated', 'wire AS_PATH', 'AS4_PATH', 'next_hop', 'ORIGIN', 'MED', 'LOCAL_PREF', 'COMMUNITY', 'Large Communities including wire order', 'ATOMIC_AGGREGATE presence', 'wire and effective AGGREGATOR', 'AS4_AGGREGATOR', 'all raw attribute flags and TLV value bytes', 'session states', 'unsupported type and AFI/SAFI'], 'samples': reports}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(payload, indent=2) + '\n', encoding='utf-8')
    if any(not report['matched'] for report in reports):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
