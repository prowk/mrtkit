"""对照工具的重复计数、记录内排序和旧小样本方法一致性测试。"""
import copy
import json
import subprocess
import struct
import tempfile
import unittest
from pathlib import Path

import compare


class CompareTests(unittest.TestCase):
    def test_raw_flags_values_and_failure_evidence(self):
        # 直接编码 AS4 UPDATE；mrtparse 保留非法 ORIGIN 标志，严格解析器应报错。
        def frame(flags=0x40):
            attrs = bytes([flags, 1, 1, 0, 0x40, 2, 6, 2, 1]) + struct.pack('!I', 64512) + bytes([0x40, 3, 4, 192, 0, 2, 1])
            body = struct.pack('!HH', 0, len(attrs)) + attrs + bytes([24, 203, 0, 113])
            message = b'\xff' * 16 + struct.pack('!HB', 19 + len(body), 2) + body
            payload = struct.pack('!IIHH', 64512, 64513, 0, 1) + bytes([192, 0, 2, 1, 192, 0, 2, 2]) + message
            return struct.pack('!IHHI', 1700000000, 16, 4, len(payload)) + payload
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'raw-contract.mrt'
            source.write_bytes(frame())
            expected = next(compare.reference_records(source))
            self.assertEqual(compare.raw_attributes(compare.attribute_blocks(expected.raw)[0])[0], (1, 0x40, '00'))
            batch = json.loads(subprocess.check_output(['node', 'scripts/decoded_records.mjs', str(source)], cwd=compare.ROOT, text=True, encoding='utf-8'))
            self.assertEqual(expected, compare.actual_record(batch, 1))
            batch['events'][0]['attributes']['raw_attributes'][0]['flags'] |= 1
            self.assertNotEqual(expected, compare.actual_record(batch, 1))
            source.write_bytes(frame(0xc0) * 11 + frame())
            report = compare.compare(source, keep_going=True)
            self.assertEqual(report['records'], 12)
            self.assertFalse(report['matched'])
            self.assertTrue(report['complete_file_compared'])
            self.assertEqual(report['mismatch_count'], 11)
            self.assertEqual(len(report['mismatches']), 10)
            evidence = Path(report['mismatches'][0]['reproduction'])
            self.assertEqual(evidence.read_bytes(), frame(0xc0))
            result = subprocess.run(['node', 'cli/mrtkit.mjs', 'parse', str(evidence)], cwd=compare.ROOT, capture_output=True)
            self.assertEqual(result.returncode, 1)
            metadata = json.loads(evidence.with_suffix('.json').read_text(encoding='utf-8'))
            self.assertEqual(metadata['record'], 1)
            self.assertEqual(metadata['decompressed_offset'], 0)
            self.assertIn('MoonBit', metadata['reason'])

    def test_record_order_and_duplicate_multiplicity(self):
        attrs = {'wire_path': [], 'as4_path': [], 'other': [], 'communities': [], 'large_communities': []}
        event = {'source': {'record': '1'}, 'timestamp': 1, 'action': 'announce', 'prefix': '192.0.2.0/24',
                 'peer_asn': 1, 'peer_ip': '192.0.2.1', 'outbound': False, 'attributes': attrs}
        other = dict(event, prefix='2001:db8::/32')
        batch = {'events': [event, other, event], 'states': [], 'header': {'timestamp': 1, 'kind': 16, 'subtype': 4},
                 'skipped': False, 'diagnostics': []}
        reversed_batch = copy.deepcopy(batch)
        reversed_batch['events'].reverse()
        expected = compare.actual_record(batch, 1)
        self.assertEqual(expected, compare.actual_record(reversed_batch, 1))
        self.assertEqual(expected['events'].total(), 3)
        reversed_batch['events'].pop()
        self.assertNotEqual(expected, compare.actual_record(reversed_batch, 1))

    def test_legacy_small_samples(self):
        # 只对两个固定小样本运行历史全量算法，禁止用于完整档案。
        legacy = subprocess.run(['git', 'show', '0267b4d:scripts/compare.py'], cwd=compare.ROOT,
                                capture_output=True, text=True, encoding='utf-8', check=True).stdout
        namespace = {'__file__': str(Path(compare.__file__)), '__name__': 'legacy_test_only'}
        exec(compile(legacy, '<legacy-small-sample>', 'exec'), namespace)
        for name in ('ris-updates', 'ris-rib'):
            path = compare.ROOT / '.validation' / (name + '.mrt')
            if not path.exists():
                self.skipTest('需要先获取文档中的两个 1000 记录小样本')
            self.assertLess(path.stat().st_size, 16 * 1024 * 1024)
            records, old_events = namespace['reference'](path)
            self.assertEqual(old_events, namespace['actual'](path))
            streamed = compare.compare(path)
            self.assertEqual(streamed['records'], records)
            self.assertEqual(streamed['events'], old_events.total())
            print(json.dumps({'legacy_equivalence': name, 'records': records, 'events': old_events.total()}), flush=True)


if __name__ == '__main__':
    unittest.main()
