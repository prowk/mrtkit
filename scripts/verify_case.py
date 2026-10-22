"""独立核验真实案例的原始 MRT 摘录，不调用 MoonBit 解释路径。"""
import hashlib
import json
from pathlib import Path

import compare

ROOT = compare.ROOT


def main():
    directory = ROOT / 'cases' / 'rrc23-path-change'
    spec = json.loads((directory / 'case.json').read_text(encoding='utf-8'))
    mapping = json.loads((directory / 'excerpt-map.json').read_text(encoding='utf-8'))
    data = (directory / 'excerpt.mrt').read_bytes()
    assert hashlib.sha256(data).hexdigest() == mapping['sha256'] == spec['expected_excerpt_sha256']
    prefix = compare.prefix_key(spec['prefix'])
    events = []
    for record, source in zip(compare.reference_records(directory / 'excerpt.mrt'), mapping['records'], strict=True):
        assert record.offset == source['excerpt_offset']
        assert len(record.raw) == source['bytes']
        selected = [(event, count) for event, count in record['events'].items() if event[3] == prefix and event[4] == spec['peer_asn']]
        assert len(selected) == 1 and selected[0][1] == 1
        event = selected[0][0]
        assert event[2] == 'announce' and not event[10]
        events.append(event)
    expected = [spec['anchors'][0]['before'], *[anchor['after'] for anchor in spec['anchors']]]
    assert len(events) == len(expected) == 4
    for event, path in zip(events, expected, strict=True):
        assert event[9] == tuple((segment['kind'], tuple(segment['asns'])) for segment in path)
    assert [event[0] for event in events[1:]] == [anchor['timestamp'] for anchor in spec['anchors']]
    assert events[0][0] < spec['window']['from']
    print(json.dumps({'case': 'rrc23-path-change', 'independent_reference': 'mrtparse ' + compare.mrtparse.__version__,
                      'records': len(events), 'sha256': mapping['sha256'], 'matched': True}))


if __name__ == '__main__':
    main()
