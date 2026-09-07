"""Regression cases for occurrence loss and ambiguous truncated identities."""
import importlib.util
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
import base64

spec = importlib.util.spec_from_file_location('naming_inventory', Path(__file__).resolve().parents[1] / 'scripts/clued-naming-surface-inventory.py')
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)
consolidator_spec = importlib.util.spec_from_file_location('consolidator', Path(__file__).resolve().parents[1] / 'scripts/clued-naming-inventory-consolidate.py')
consolidator = importlib.util.module_from_spec(consolidator_spec)
consolidator_spec.loader.exec_module(consolidator)

class CompletenessTests(unittest.TestCase):
    def scan_single_fixture(self, payload, path='apps/fixture/name.png'):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / path
            target.parent.mkdir(parents=True)
            target.write_bytes(payload)
            entries = [{'path': path, 'mode': '100644', 'stage': '0', 'blob_sha': 'fixture'}]
            with patch.object(scanner, 'tracked_files', return_value=entries):
                return scanner.scan_repository(root, scanner.MAX_TEXT_BYTES_DEFAULT)

    def test_real_png_retains_path_without_unscanned_text_debt(self):
        # Valid 1x1 PNG under a machine path: image bytes are not a text surface.
        payload = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')
        result = self.scan_single_fixture(payload)
        self.assertEqual(result['file_count'], 1)
        self.assertEqual(result['files'][0]['path'], 'apps/fixture/name.png')
        self.assertEqual(result['files'][0]['content_sha256'], hashlib.sha256(payload).hexdigest())
        self.assertEqual(result['files'][0].get('binary_signature'), 'PNG')
        self.assertEqual(result['skipped_text_files'], [])

    def test_text_disguised_as_png_still_scanned_under_machine_path(self):
        result = self.scan_single_fixture(b'CLUED_PNG_FIXTURE\n')
        record = result['files'][0]
        self.assertEqual(record['text_scan_status'], 'scanned')
        self.assertNotIn('binary_signature', record)
        occurrences = [item for item in result['identifier_index'] if item['token'] == 'CLUED_PNG_FIXTURE']
        self.assertEqual(len(occurrences), 1)
        self.assertTrue(occurrences[0]['locations'][0]['machine_surface'])

    def test_all_occurrences_after_fiftieth_are_retained(self):
        index = {}
        for line in range(1, 137):
            scanner.add_index(index, 'CLUED_SAME_NAME', 'typed', 'fixture.json', line, machine_surface=True)
        record = index['CLUED_SAME_NAME']
        self.assertEqual(record['occurrence_count'], 136)
        self.assertEqual([x['line'] for x in record['locations']], list(range(1, 137)))
        self.assertFalse(record['locations_truncated'])

    def test_long_id_shared_prefix_cannot_hide_different_originals(self):
        fields = []
        scanner.walk_json_fields({'first': {'id': 'a'*1001+'x'}, 'second': {'id': 'a'*1001+'y'}}, 'fixture.json', fields)
        self.assertEqual(fields[0]['value'], fields[1]['value'])
        self.assertTrue(all(x['value_truncated'] for x in fields))
        self.assertNotEqual(fields[0]['original_value_sha256'], fields[1]['original_value_sha256'])
        self.assertEqual(fields[0]['original_value_length'], 1002)

    def test_retained_external_pages_are_complete(self):
        root=Path(__file__).resolve().parents[1]/'artifacts/clued-validation/structure-freeze-prep/naming/external-20260907'
        _,rows,_=consolidator.verify_sources(root)
        self.assertGreater(len(rows), 0)

    def test_external_digest_mismatch_is_rejected(self):
        source=Path(__file__).resolve().parents[1]/'artifacts/clued-validation/structure-freeze-prep/naming/external-20260907'
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'copy'
            shutil.copytree(source, root)
            with (root/'sources/supabase-catalog.json').open('ab') as f:
                f.write(b' ')
            with self.assertRaisesRegex(ValueError,'digest mismatch'):
                consolidator.verify_sources(root)

    def test_duplicate_page_rejected_even_with_matching_file_hash(self):
        source=Path(__file__).resolve().parents[1]/'artifacts/clued-validation/structure-freeze-prep/naming/external-20260907'
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'copy'
            shutil.copytree(source, root)
            path=root/'sources/supabase-catalog.json'
            doc=json.loads(path.read_text(encoding='utf-8'))
            doc['data']['pages'][1]['rows']=doc['data']['pages'][0]['rows']
            path.write_text(json.dumps(doc),encoding='utf-8')
            index_path=root/'SourceIndex.json'
            index=json.loads(index_path.read_text(encoding='utf-8'))
            for row in index['files']:
                if row['path']=='sources/supabase-catalog.json':
                    row.update(bytes=path.stat().st_size,sha256=hashlib.sha256(path.read_bytes()).hexdigest())
            index_path.write_text(json.dumps(index),encoding='utf-8')
            with self.assertRaisesRegex(ValueError,'duplicate'):
                consolidator.verify_sources(root)

if __name__ == '__main__':
    unittest.main()
