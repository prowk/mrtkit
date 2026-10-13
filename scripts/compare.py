"""用独立的 mrtparse 对照事件、peer、AS 路径和常用属性。"""
import hashlib
import ipaddress
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".validation" / "deps"))
import mrtparse


def code(mapping):
    return int(next(iter(mapping)))


def prefix(item):
    return str(ipaddress.ip_network(f"{item['prefix']}/{item['length']}", strict=False))


def ip_key(text):
    # 按地址字节比较，允许 IPv4 映射地址采用十六进制或点分显示。
    return ipaddress.ip_address(text).packed.hex() if text else None


def common(attrs):
    by_code = {code(a["type"]): a["value"] for a in attrs}
    path = tuple((code(s["type"]), tuple(map(int, s["value"]))) for s in by_code.get(2, []))
    as4 = tuple((code(s["type"]), tuple(map(int, s["value"]))) for s in by_code.get(17, []))
    hop = by_code.get(3)
    communities = tuple((int(c.split(':')[0]) << 16) | int(c.split(':')[1]) for c in by_code.get(8, []))
    return path, as4, ip_key(hop), code(by_code[1]) if 1 in by_code else None, by_code.get(4), by_code.get(5), communities


def signature(timestamp, action, network, asn, ip, attrs, originated=None, hop=None, outbound=False):
    values = common(attrs) if action != "withdraw" else ((), (), None, None, None, None, ())
    if hop and action != "withdraw":
        values = (values[0], values[1], ip_key(hop), *values[3:])
    return (timestamp, action, network, int(asn), ip_key(ip), outbound, originated, *values)


def reference(path):
    events = Counter()
    records = 0
    peers = []
    for record in mrtparse.Reader(str(path)):
        if record.err:
            raise ValueError(f"mrtparse 错误: {record.err_msg}")
        data = record.data
        records += 1
        timestamp = code(data['timestamp'])
        kind, subtype = code(data['type']), code(data['subtype'])
        if kind == 13 and subtype == 1:
            peers = data['peer_entries']
        elif kind == 13 and subtype in (2, 4):
            network = str(ipaddress.ip_network(f"{data['prefix']}/{data['length']}", strict=False))
            for rib in data['rib_entries']:
                peer = peers[rib['peer_index']]
                attrs = rib['path_attributes']
                hop = next((a['value']['next_hop'][0] for a in attrs if code(a['type']) == 14), None)
                events[signature(timestamp, 'rib', network, peer['peer_as'], peer['peer_ip'], attrs, code(rib['originated_time']), hop)] += 1
        elif kind in (16, 17) and subtype in (1, 4, 6, 7):
            message = data['bgp_message']
            if code(message['type']) != 2:
                continue
            attrs = message['path_attributes']
            def add(action, entries, hop=None):
                for item in entries:
                    events[signature(timestamp, action, prefix(item), data['peer_as'], data['peer_ip'], attrs, hop=hop, outbound=subtype in (6, 7))] += 1
            add('withdraw', message['withdrawn_routes'])
            add('announce', message['nlri'])
            for attribute in attrs:
                c = code(attribute['type'])
                if c not in (14, 15):
                    continue
                value = attribute['value']
                if code(value['afi']) not in (1, 2) or code(value['safi']) != 1:
                    continue
                if c == 14:
                    add('announce', value['nlri'], value['next_hop'][0])
                else:
                    add('withdraw', value['withdrawn_routes'])
    return records, events


def actual(path):
    result = subprocess.run(['node', 'cli/mrtkit.mjs', 'parse', str(path)], cwd=ROOT, capture_output=True, text=True, encoding='utf-8', check=True)
    events = Counter()
    for line in result.stdout.splitlines():
        event = json.loads(line)
        attrs = event['attributes']
        path = tuple((s['kind'], tuple(s['asns'])) for s in attrs['wire_path'])
        as4 = tuple((s['kind'], tuple(s['asns'])) for s in attrs['as4_path'])
        values = (path, as4, ip_key(attrs.get('next_hop')), attrs.get('origin'), attrs.get('med'), attrs.get('local_pref'), tuple(attrs['communities']))
        events[(event['timestamp'], event['action'], event['prefix'], event['peer_asn'], ip_key(event['peer_ip']), event['outbound'], event.get('originated'), *values)] += 1
    return events


def main():
    reports = []
    for name in ('ris-updates', 'ris-rib'):
        path = ROOT / '.validation' / (name + '.mrt')
        records, expected = reference(path)
        obtained = actual(path)
        if expected != obtained:
            missing = list((expected - obtained).items())[:3]
            extra = list((obtained - expected).items())[:3]
            raise AssertionError(f"{name} 不一致: missing={missing}, extra={extra}")
        item = {'sample': path.name, 'records': records, 'events': expected.total(), 'matched': True, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
        reports.append(item)
        print(json.dumps(item))
    report = {'reference': 'mrtparse 2.2.0', 'checked_fields': ['timestamp', 'action', 'prefix', 'peer_asn', 'peer_ip', 'outbound', 'originated', 'wire AS_PATH segments', 'AS4_PATH segments', 'next_hop', 'origin', 'MED', 'local_pref', 'communities'], 'samples': reports}
    (ROOT / '.validation' / 'comparison.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
