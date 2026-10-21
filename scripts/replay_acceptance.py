"""以独立解析器和业务状态模型验收完整 RIB、连续 UPDATE、窗口和正式 CLI 导出。"""
import csv
import io
import ipaddress
import json
import subprocess
from collections import Counter
from pathlib import Path

import compare

ROOT = compare.ROOT
LOWER, UPPER = 1735690800, 1735692000  # 2025-01-01 00:20:00–00:40:00 UTC，包含端点。
PREFIX, PEER = '183.90.160.0/24', 58952


def canonical(path):
    result = []
    for kind, values in path:
        if kind in (1, 4):
            result.append((kind, tuple(sorted(set(values)))))
        elif result and result[-1][0] == kind:
            result[-1] = (kind, result[-1][1] + tuple(values))
        else:
            result.append((kind, tuple(values)))
    return tuple(result)


def semantics(event):
    # 选定档案使用四字节 AS_PATH；如出现 AS4 转换，必须显式扩展模型再验收。
    assert not event[10], '此独立业务案例不覆盖 AS4 还原；规则矩阵另行验收'
    unknown = tuple(sorted((code, flags & 224, value) for code, flags, value in event[22]
                           if code not in (1, 2, 3, 4, 5, 6, 7, 8, 14, 15, 17, 18, 32)))
    return (canonical(event[9]), event[11], event[12], event[13], event[14],
            tuple(sorted(set(event[15]))), tuple(sorted(set(event[16]))), event[18], event[21], unknown)


def route_key(event):
    return event[4], event[5], event[6], event[7]


def route_projection(event, active, attrs=None):
    return {'key': list(route_key(event)), 'time': [event[0], event[1]], 'active': active,
            'attributes': repr(attrs if attrs is not None else semantics(event))}


def actual_projection(event):
    attrs = event['attributes']
    common = compare.actual_record({'header': {'timestamp': event['timestamp'], 'kind': 16, 'subtype': 4},
                                   'events': [dict(event, source={'record': '1'})], 'states': [],
                                   'diagnostics': [], 'skipped': False}, 1)
    key = next(iter(common['events']))
    # 实际有效路径用于状态比较，独立模型从原始 AS_PATH 计算。
    key = (*key[:9], tuple((s['kind'], tuple(s['asns'])) for s in attrs['path']), *key[10:])
    return route_projection(key, event['action'] == 'active')


def main():
    directory = ROOT / '.validation'
    manifest = json.loads((ROOT / 'docs/validation/archive-manifest.json').read_text(encoding='utf-8'))
    sources = [source for source in manifest if source['collector'] == 'ris-rrc23']
    rib = next(source for source in sources if source['kind'] == 'rib')
    updates = sorted((source for source in sources if source['kind'] == 'update'), key=lambda s: s['file'])
    assert len(updates) == 12
    for source in sources:
        path = directory / 'archives' / source['file']
        assert path.stat().st_size == source['bytes'] and compare.sha256(path) == source['sha256']
    config = {'prefix': PREFIX, 'peer_asn': PEER, 'from': LOWER, 'to': UPPER,
              'rib': str(directory / 'archives' / rib['file']),
              'updates': [str(directory / 'archives' / s['file']) for s in updates]}
    config_path = directory / 'replay-config.json'
    config_path.write_text(json.dumps(config), encoding='utf-8')
    actual_path = directory / 'replay-actual.json'
    process = subprocess.Popen(['node', 'scripts/replay_audit.mjs', str(config_path), str(actual_path)], cwd=ROOT)
    states, resets, latest = {}, {}, {}
    counts = Counter()
    expected_notices, expected_exports = [], []
    before = None
    prefix = compare.prefix_key(PREFIX)
    selected_rib = selected_warmup = 0
    path_sum = path_samples = max_length = 0

    def state_projection():
        return sorted((route_projection(s['event'], s['active'], s['attrs']) for s in states.values()), key=repr)

    def origin(path):
        for kind, values in reversed(path):
            if kind == 1:
                return None
            if kind == 2:
                return values[-1]
        return None

    try:
        for source in [rib, *updates]:
            baseline = source['kind'] == 'rib'
            for record in compare.reference_records(directory / 'archives' / source['file']):
                stamp = record['header'][0]
                if not baseline and before is None and stamp >= LOWER:
                    before = state_projection()
                if not baseline and stamp <= UPPER:
                    counts['warmup_records' if stamp < LOWER else 'records'] += 1
                for state, multiplicity in record['states'].items():
                    time, micros, asn, ip, old, new = state
                    if time > UPPER or old != 6 or new == 6:
                        continue
                    peer = (asn, ip)
                    stale = any(t > time for key, t in latest.items() if key[:2] == peer)
                    if time >= LOWER:
                        counts['out_of_order' if stale else 'session_resets'] += multiplicity
                    if stale:
                        continue
                    states = {key: value for key, value in states.items() if key[:2] != peer}
                    resets[peer] = time
                for event, multiplicity in record['events'].items():
                    if event[3] != prefix or event[4] != PEER or event[0] > UPPER:
                        continue
                    measured = not baseline and event[0] >= LOWER
                    if baseline:
                        selected_rib += multiplicity
                    elif not measured:
                        selected_warmup += multiplicity
                    for _ in range(multiplicity):
                        time, action, key = event[0], event[2], route_key(event)
                        old = states.get(key)
                        if measured:
                            counts['withdrawals' if action == 'withdraw' else 'announcements'] += 1
                            expected_exports.append((time, action, repr(event[9]), event[11]))
                            if action != 'withdraw':
                                length = sum(len(v) if k == 2 else 1 if k == 1 else 0 for k, v in event[9])
                                path_sum += length
                                path_samples += 1
                                max_length = max(max_length, length)
                        if time < resets.get(key[:2], -1) or (old and time < old['event'][0]):
                            if measured:
                                counts['out_of_order'] += 1
                            continue
                        latest[key[:3]] = max(time, latest.get(key[:3], -1))
                        active = action != 'withdraw'
                        attrs = old['attrs'] if not active and old else semantics(event)
                        changed = active and not baseline
                        kinds = []
                        if active and old and old['active']:
                            changed = attrs != old['attrs']
                            if attrs[0] != old['attrs'][0]:
                                kinds.append('path_change')
                                if origin(attrs[0]) is not None and origin(old['attrs'][0]) is not None and origin(attrs[0]) != origin(old['attrs'][0]):
                                    kinds.append('origin_change')
                            if attrs[1:] != old['attrs'][1:]:
                                kinds.append('attribute_change')
                            if measured and not changed:
                                counts['duplicate_announcements'] += 1
                        elif not active:
                            changed = bool(old and old['active'])
                        start, count = time, 0
                        if old and 0 <= time - old['start'] < 60:
                            start, count = old['start'], old['count']
                        if not measured:
                            start, count = LOWER, 0
                        elif changed:
                            count += 1
                            if count == 3:
                                kinds.append('churn')
                        if measured:
                            for kind in kinds:
                                counts[{'churn': 'churn_alerts'}.get(kind, kind + 's')] += 1
                                expected_notices.append((kind, time, str(record['ordinal']), str(record.offset), key))
                        states[key] = {'event': event, 'active': active, 'attrs': attrs, 'start': start, 'count': count}
                if record['ordinal'] % 200000 == 0:
                    print(json.dumps({'reference_replay': source['file'], 'records': record['ordinal']}), flush=True)
        assert process.wait() == 0
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
    actual = json.loads(actual_path.read_text(encoding='utf-8'))
    assert before == sorted(map(actual_projection, actual['before']), key=repr), '窗口起始状态不同'
    assert state_projection() == sorted(map(actual_projection, actual['state']), key=repr), '窗口结束状态不同'
    summary = actual['summary']
    for key in ('announcements', 'withdrawals', 'path_changes', 'origin_changes', 'attribute_changes',
                'duplicate_announcements', 'out_of_order', 'churn_alerts', 'session_resets', 'records', 'warmup_records'):
        assert int(summary[key]) == counts[key], (key, summary[key], counts[key])
    assert summary['rib_routes'] == '0' and summary['baseline_status'] == 'explicit_rib'
    assert summary['tracked_routes'] == len(states)
    assert summary['active_routes'] == sum(state['active'] for state in states.values())
    assert summary['max_path_length'] == max_length
    assert abs(summary['mean_path_length'] - path_sum / path_samples) < 1e-12
    notices = [(n['kind'], n['timestamp'], n['source']['record'], n['source']['offset'],
                (n['peer_asn'], compare.ip_key(n['peer_ip']), n['outbound'], n.get('path_id'))) for n in actual['notices']]
    assert notices == expected_notices, '正式 CLI 变化及来源不同'
    exported = [json.loads(line) for line in actual['jsonl'].splitlines()]
    exports = [(e['timestamp'], e['action'], repr(tuple((s['kind'], tuple(s['asns'])) for s in e['attributes']['wire_path'])), compare.ip_key(e['attributes'].get('next_hop'))) for e in exported]
    assert Counter(exports) == Counter(expected_exports), 'JSON 导出和独立事件不同'
    rows = list(csv.DictReader(io.StringIO(actual['csv'])))
    assert Counter((int(row['timestamp']), row['action'], row['prefix']) for row in rows) == Counter((e['timestamp'], e['action'], e['prefix']) for e in exported)
    assert len(rows) > 0 and len(notices) > 0 and selected_rib > 0 and selected_warmup > 0
    report = {'collector': 'RIS rrc23', 'window_utc': ['2025-01-01T00:20:00Z', '2025-01-01T00:40:00Z'],
              'prefix': PREFIX, 'peer_asn': PEER, 'sources': sources, 'summary': summary,
              'selected_rib_events': selected_rib, 'selected_warmup_events': selected_warmup,
              'before': before, 'after': state_projection(), 'notice_count': len(notices), 'exported_rows': len(rows),
              'checks': ['all 13 complete input hashes', 'window start and end state independently recomputed',
                         'statistics independently recomputed', 'CLI and library notices identical',
                         'every notice type, time, record and offset independently recomputed',
                         'JSON rows independently recomputed', 'CSV and JSON rows equal', 'baseline and warmup excluded'],
              'scope': 'All complete input records decoded; analysis retains one prefix and one peer. This is not a full-state memory benchmark or a business outage diagnosis.',
              'command': 'python scripts/replay_acceptance.py', 'matched': True}
    (ROOT / 'docs/validation/replay-acceptance.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'matched': True, 'notices': len(notices), 'exported_rows': len(rows)}), flush=True)


if __name__ == '__main__':
    main()
