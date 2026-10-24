"""独立 SQLite 模型的可重复小规模端到端验收。"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import compare


class FullStateReferenceTests(unittest.TestCase):
    def test_complete_state_sources_notices_and_microsecond_window(self):
        with tempfile.TemporaryDirectory(prefix='mrtkit-reference-') as temporary:
            script = r"""
import {modelSequence,encodeModelEvent} from './tests/helpers/model-fixtures.mjs';
import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {replayManifest} from './cli/multi.mjs';
const root=process.argv[1],data=Buffer.concat(modelSequence().map(encodeModelEvent)),file=join(root,'updates.mrt');
await writeFile(file,data);
for(const fraction of [false,true]){
 const manifest={schema_version:'1.0',window:{from:100,to:100},analysis:{threshold:3,...(fraction?{from_micros:500,to_micros:900}:{})},collectors:[{collector:'model',view:'v',files:[{path:file,kind:'update',from:100,to:100,sha256:createHash('sha256').update(data).digest('hex')}]}]};
 const config=join(root,'manifest-'+fraction+'.json');await writeFile(config,JSON.stringify(manifest),'utf8');await replayManifest(config,join(root,'bundle-'+fraction));
}
"""
            subprocess.run(['node', '--input-type=module', '-e', script, temporary], cwd=compare.ROOT, check=True, capture_output=True)
            for fraction in ('false', 'true'):
                root = Path(temporary)
                subprocess.run([sys.executable, 'scripts/full_state_reference.py', '--manifest', str(root / f'manifest-{fraction}.json'), '--output', str(root / f'reference-{fraction}'), '--bundle', str(root / f'bundle-{fraction}' / 'index.json')], cwd=compare.ROOT, check=True, capture_output=True)
                result = json.loads((root / f'reference-{fraction}' / 'verification.json').read_text(encoding='utf-8'))
                self.assertTrue(result['matched'])
                self.assertEqual(result['input_records'], 1200)
                self.assertGreater(result['counts']['out_of_order'], 0)
                self.assertGreater(result['counts']['session_resets'], 0)
                self.assertGreater(result['notice_fingerprint']['rows'], 0)


if __name__ == '__main__':
    unittest.main()
