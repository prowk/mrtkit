"""从全部原始档案独立重算状态；SQLite 仅作为参考模型存储，不调用 MoonBit。"""
import argparse
import ast
import hashlib
import json
import sqlite3
import time
from collections import Counter
from pathlib import Path

import compare
from replay_acceptance import canonical


def fingerprint():
    return {'rows': 0, 'sum': 0, 'xor': 0}


def add(acc, value):
    number = int.from_bytes(hashlib.sha256(repr(value).encode('utf-8')).digest(), 'big')
    acc['rows'] += 1
    acc['sum'] = (acc['sum'] + number) % (1 << 256)
    acc['xor'] ^= number


def portable(acc):
    return {'rows': acc['rows'], 'sha256_sum': f"{acc['sum']:064x}", 'sha256_xor': f"{acc['xor']:064x}"}


def effective(event, width):
    path, as4 = event[9:11]
    if width == 4 or event[19] and event[20] and event[19][0] != 23456:
        return path
    compatible = tuple(segment for segment in as4 if segment[0] < 3)
    length = lambda value: sum(len(values) if kind == 2 else 1 if kind == 1 else 0 for kind, values in value)
    keep = length(path) - length(compatible)
    if not compatible or keep < 0:
        return path
    result = []
    for kind, values in path:
        if kind >= 3:
            result.append((kind, values))
        elif not keep:
            break
        elif kind == 1:
            result.append((kind, values))
            keep -= 1
        else:
            count = min(keep, len(values))
            result.append((kind, values[:count]))
            keep -= count
            if count != len(values):
                break
    return tuple(result) + compatible


def semantic(event, width=4):
    unknown = tuple(sorted((code, flags & 224, value) for code, flags, value in event[22]
                           if code not in (1, 2, 3, 4, 5, 6, 7, 8, 14, 15, 17, 18, 32)))
    return (canonical(effective(event, width)), event[11], event[12], event[13], event[14],
            tuple(sorted(set(event[15]))), tuple(sorted(set(event[16]))), event[18], event[21], unknown)


def origin(path):
    for kind, values in reversed(path):
        if kind == 1:
            return None
        if kind == 2:
            return values[-1] if values else None
    return None


def event_key(event):
    return repr((event[3], event[4], event[5], event[6], event[7]))


def actual_event(row):
    batch = {'header': {'timestamp': row['timestamp'], 'kind': 16, 'subtype': 4},
             'events': [dict(row, source={'record': '1'})], 'states': [], 'diagnostics': [], 'skipped': False}
    return next(iter(compare.actual_record(batch, 1)['events']))


def source_key(source, names):
    return (names[source['file']], int(source['record']), int(source['offset']), source['event_index'])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--bundle')
    parser.add_argument('--verify-only', action='store_true')
    parser.add_argument('--allow-partial-data', action='store_true')
    args = parser.parse_args()
    directory = Path(args.output).resolve()
    if not args.verify_only:
        directory.mkdir()
    manifest = json.loads(Path(args.manifest).read_text(encoding='utf-8'))
    assert len(manifest['collectors']) == 1
    point = manifest['collectors'][0]
    files = point['files']
    names = {file['path']: index for index, file in enumerate(files)}
    if args.verify_only:
        assert args.bundle
        verify(Path(args.bundle), json.loads((directory / 'reference.json').read_text(encoding='utf-8')), names, directory, allow_partial=args.allow_partial_data)
        return
    source_sha256 = {name: compare.sha256(Path(__file__).parent / name) for name in ('full_state_reference.py', 'compare.py', 'reference_wire.py', 'replay_acceptance.py')}
    analysis = manifest.get('analysis', {})
    assert all(analysis.get(key) is None for key in ('prefix', 'peer_asn', 'path_id', 'asn')), '独立全状态模型不接受筛选'
    lower = manifest['window']['from'] * 1000000 + analysis.get('from_micros', 0)
    upper = manifest['window']['to'] * 1000000 + analysis.get('to_micros', 999999)
    duration = manifest.get('analysis', {}).get('window_seconds', 60) * 1000000
    threshold = manifest.get('analysis', {}).get('threshold', 10)
    db = sqlite3.connect(directory / 'reference.sqlite')
    db.execute('PRAGMA journal_mode=OFF')
    db.execute('PRAGMA synchronous=OFF')
    db.execute('PRAGMA cache_size=-131072')
    db.execute('CREATE TABLE routes (key TEXT PRIMARY KEY, peer TEXT, time INTEGER, micro INTEGER, active INTEGER, attrs TEXT, wire TEXT, src TEXT, originated INTEGER, start INTEGER, count INTEGER) WITHOUT ROWID')
    db.execute('CREATE INDEX peer_routes ON routes(peer)')
    insert = 'INSERT OR REPLACE INTO routes VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    counts, latest, resets = Counter(), {}, {}
    expected_notices = fingerprint()
    path_sum = path_samples = max_length = records = route_events = state_events = 0
    started = time.perf_counter()
    try:
        for file_index, file in enumerate(files):
            path = Path(file['path'])
            assert compare.sha256(path) == file['sha256']
            baseline = file['kind'] == 'rib'
            for record in compare.reference_records(path):
                records += 1
                at = record['header'][0] * 1000000 + (record['header'][1] or 0)
                if not baseline and at <= upper:
                    counts['warmup_records' if at < lower else 'records'] += 1
                    if at >= lower:
                        counts['skipped_records'] += record['skipped']
                        counts['ignored_families'] += sum(record['ignored'].values())
                for state, multiplicity in record['states'].items():
                    state_events += multiplicity
                    stamp, micros, asn, ip, old, new = state
                    time_us = stamp * 1000000 + (micros or 0)
                    if time_us > upper or old != 6 or new == 6:
                        continue
                    peer = repr((asn, ip))
                    stale = any(value > time_us for key, value in latest.items() if key[0] == peer)
                    if not baseline and time_us >= lower:
                        counts['out_of_order' if stale else 'session_resets'] += multiplicity
                    if not stale:
                        db.execute('DELETE FROM routes WHERE peer=?', (peer,))
                        for direction in (False, True):
                            latest[peer, direction] = resets[peer, direction] = time_us
                pending = []
                for event_index, event in enumerate(record.ordered_events):
                    route_events += 1
                    time_us = event[0] * 1000000 + (event[1] or 0)
                    if time_us > upper:
                        continue
                    measured = not baseline and time_us >= lower
                    key, peer = event_key(event), repr((event[4], event[5]))
                    direction = event[6]
                    # 固定基线全在开始时刻；同键同刻覆盖保持原始输入顺序。
                    if baseline:
                        assert time_us <= lower and event[2] == 'rib'
                        old = None
                    else:
                        old = db.execute('SELECT time,micro,active,attrs,wire,src,originated,start,count FROM routes WHERE key=?', (key,)).fetchone()
                    width = 4 if record['header'][2] == 13 or record['header'][3] in (4, 7, 9, 11) else 2
                    attrs = semantic(event, width)
                    if measured:
                        counts['withdrawals' if event[2] == 'withdraw' else 'announcements'] += 1
                        if event[2] != 'withdraw':
                            length = sum(len(values) if kind == 2 else 1 if kind == 1 else 0 for kind, values in effective(event, width))
                            path_sum += length
                            path_samples += 1
                            max_length = max(max_length, length)
                    if time_us < resets.get((peer, direction), -1) or old and time_us < old[0]:
                        if measured:
                            counts['out_of_order'] += 1
                        continue
                    latest[peer, direction] = max(time_us, latest.get((peer, direction), -1))
                    active = event[2] != 'withdraw'
                    old_attrs = ast.literal_eval(old[3]) if old else None
                    wire = hashlib.sha256(repr(event[9:]).encode('utf-8')).hexdigest()
                    if not active and old:
                        attrs, wire = old_attrs, old[4]
                    changed = event[2] == 'announce'
                    kinds = []
                    if event[2] == 'announce' and old and old[2]:
                        changed = attrs != old_attrs
                        if attrs[0] != old_attrs[0]:
                            kinds.append('path_change')
                            if origin(attrs[0]) is not None and origin(old_attrs[0]) is not None and origin(attrs[0]) != origin(old_attrs[0]):
                                kinds.append('origin_change')
                        if attrs[1:] != old_attrs[1:]:
                            kinds.append('attribute_change')
                        if measured and not changed:
                            counts['duplicate_announcements'] += 1
                    elif not active:
                        changed = bool(old and old[2])
                    start, count = time_us, 0
                    if old and 0 <= time_us - old[7] < duration:
                        start, count = old[7:9]
                    if not measured:
                        start, count = lower, 0
                    elif changed:
                        count += 1
                        if count == threshold:
                            kinds.append('churn')
                    src = (file_index, record['ordinal'], record.offset, event_index)
                    if measured:
                        for kind in kinds:
                            counts['churn_alerts' if kind == 'churn' else kind + 's'] += 1
                            before = (old[0], old[1], bool(old[2]), old_attrs, ast.literal_eval(old[5])) if old else None
                            add(expected_notices, (kind, key, time_us, event[1], src, before, (active, attrs), count if kind == 'churn' else None))
                    value = (key, peer, time_us, event[1], active, repr(attrs), wire, repr(src), event[8], start, count)
                    if baseline:
                        pending.append(value)
                    else:
                        db.execute(insert, value)
                if pending:
                    db.executemany(insert, pending)
                if records % 25000 == 0:
                    db.commit()
                    print(json.dumps({'phase': 'independent_model', 'records': records, 'route_events': route_events, 'seconds': time.perf_counter()-started}), flush=True)
            db.commit()
        expected_state = fingerprint()
        active_count = 0
        for key, time_us, micro, active, attrs, wire, src, originated in db.execute('SELECT key,time,micro,active,attrs,wire,src,originated FROM routes'):
            active_count += active
            add(expected_state, (key, time_us, micro, bool(active), attrs, wire, src, originated))
        receipt = {'complete': True, 'matched': False, 'method': 'mrtparse all original inputs plus independent SQLite route model; no MoonBit execution',
                   'input_records': records, 'route_events': route_events, 'state_events': state_events, 'counts': dict(counts),
                   'tracked_routes': expected_state['rows'], 'active_routes': active_count, 'path_sum': path_sum, 'path_samples': path_samples, 'max_path_length': max_length,
                   'state_fingerprint': portable(expected_state), 'notice_fingerprint': portable(expected_notices), 'seconds': time.perf_counter()-started,
                   'sources': [{'file': Path(file['path']).name, 'sha256': file['sha256']} for file in files], 'source_sha256': source_sha256}
        (directory / 'reference.json').write_text(json.dumps(receipt, indent=2)+'\n', encoding='utf-8')
        if args.bundle:
            verify(Path(args.bundle), receipt, names, directory)
    finally:
        db.close()


def verify(bundle, receipt, names, directory, allow_partial=False):
    index = json.loads(bundle.read_text(encoding='utf-8'))
    assert index['status'] == 'complete' or allow_partial and index['status'] == 'partial'
    point = index['collectors'][0]
    summary = point['summary']
    for key in ('records', 'warmup_records', 'skipped_records', 'ignored_families', 'announcements', 'withdrawals', 'path_changes', 'attribute_changes', 'origin_changes', 'duplicate_announcements', 'churn_alerts', 'out_of_order', 'session_resets'):
        value = receipt['counts'].get(key, 0)
        assert int(summary[key]) == value, (key, summary[key], value)
    assert int(summary['rib_routes']) == 0
    assert summary['tracked_routes'] == receipt['tracked_routes'] and summary['active_routes'] == receipt['active_routes']
    assert summary['max_path_length'] == receipt['max_path_length']
    assert abs(summary['mean_path_length'] - (receipt['path_sum']/receipt['path_samples'] if receipt['path_samples'] else 0)) < 1e-12
    states, notices = fingerprint(), fingerprint()
    for kind in ('state', 'changes'):
        path = bundle.parent / point[kind+'_file']
        assert compare.sha256(path) == point[kind+'_sha256']
        with path.open(encoding='utf-8') as stream:
            for line in stream:
                row = json.loads(line)
                if kind == 'state':
                    event = actual_event(row)
                    attrs = semantic(event)
                    # 输出有效路径独立比较，原始 wire_path 同时由完整属性指纹检查。
                    attrs = (canonical(tuple((segment['kind'], tuple(segment['asns'])) for segment in row['attributes']['path'])), *attrs[1:])
                    add(states, (event_key(event), row['timestamp']*1000000+(row.get('microseconds') or 0), row.get('microseconds'), row['action']=='active', repr(attrs), hashlib.sha256(repr(event[9:]).encode('utf-8')).hexdigest(), repr(source_key(row['source'], names)), row.get('originated')))
                else:
                    def snap(value):
                        if value is None:
                            return None
                        event = actual_event(dict(row, **value, action='active' if value['active'] else 'withdrawn'))
                        attrs = semantic(event)
                        attrs = (canonical(tuple((segment['kind'], tuple(segment['asns'])) for segment in value['attributes']['path'])), *attrs[1:])
                        return attrs
                    after = actual_event(dict(row, **row['after'], action='active' if row['after']['active'] else 'withdrawn'))
                    before = row.get('before')
                    previous = None if before is None else (before['timestamp']*1000000+(before.get('microseconds') or 0), before.get('microseconds'), before['active'], snap(before), source_key(before['source'], names))
                    add(notices, (row['kind'], event_key(after), row['timestamp']*1000000+(row.get('microseconds') or 0), row.get('microseconds'), source_key(row['source'], names), previous, (row['after']['active'], snap(row['after'])), row.get('churn_count')))
    assert portable(states) == receipt['state_fingerprint'], '完整结束状态或来源与独立模型不同'
    assert portable(notices) == receipt['notice_fingerprint'], '全部变化或来源与独立模型不同'
    result = {**receipt, 'matched': True, 'bundle_status': index['status'], 'resource_acceptance': index['status'] == 'complete', 'bundle_state_sha256': point['state_sha256'], 'bundle_changes_sha256': point['changes_sha256']}
    name = 'verification.json' if index['status'] == 'complete' else 'partial-data-verification.json'
    (directory / name).write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'independent_matched': True, 'bundle_status': index['status'], 'states': states['rows'], 'notices': notices['rows']}), flush=True)


if __name__ == '__main__':
    main()
