"""对照工具的重复计数、记录内排序和旧小样本方法一致性测试。"""
import copy
import json
import subprocess
import unittest
from pathlib import Path

import compare


class CompareTests(unittest.TestCase):
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
