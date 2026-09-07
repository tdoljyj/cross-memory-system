"""Independent adversarial checks for narrowly scoped naming supplements.

Semantic mutations refresh both digest layers, so a digest failure cannot hide
an incorrect subject, response, or retirement decision.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest


REPO = Path(__file__).resolve().parents[1]
NAMING = REPO / 'artifacts/clued-validation/structure-freeze-prep/naming'
SPEC = importlib.util.spec_from_file_location(
    'supplement_consolidator', REPO / 'scripts/clued-naming-inventory-consolidate.py')
consolidator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(consolidator)


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def digest_row(path, relative):
    return {'path': relative, 'bytes': path.stat().st_size,
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


class SupplementTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='clued-supplement-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / 'supplement'
        shutil.copytree(NAMING / 'supplement-20260907', self.root)
        self.scope_sha = hashlib.sha256(
            (NAMING / 'NamingSurfaceInventoryScope.json').read_bytes()).hexdigest()

    def verify(self):
        return consolidator.verify_supplement(self.root, self.scope_sha)

    def refresh_index(self):
        path = self.root / 'SourceIndex.json'
        index = read_json(path)
        for row in index['files']:
            candidate = self.root / row['path']
            if candidate.is_file():
                row.update(digest_row(candidate, row['path']))
        write_json(path, index)

    def mutate_sites(self, mutation):
        path = self.root / 'sites/sources/site-retirement.json'
        doc = read_json(path)
        mutation(doc)
        write_json(path, doc)
        self.refresh_index()

    def mutate_evidence(self, filename, mutation):
        path = self.root / 'sites/evidence' / filename
        doc = read_json(path)
        mutation(doc)
        write_json(path, doc)
        relative = 'evidence/' + filename
        def refresh_ref(sites):
            for row in sites['evidence_refs']:
                if row['path'] == relative:
                    row.update(digest_row(path, relative))
        self.mutate_sites(refresh_ref)

    def mutate_restore(self, mutation):
        path = self.root / 'supabase/restore-catalog.json'
        doc = read_json(path)
        mutation(doc['data'])
        write_json(path, doc)
        self.refresh_index()

    def mutate_retained_tool(self, filename, mutation):
        path = self.root / 'supabase' / filename
        doc = read_json(path)
        response = doc['tool_response']
        if response.get('status') == 'fulfilled':
            response = response['value']
        block = next(b for b in response['content'] if b['type'] == 'text')
        payload = json.loads(block['text'])
        mutation(payload)
        block['text'] = json.dumps(payload)
        write_json(path, doc)
        self.refresh_index()

    def test_real_supplement_resolves_only_sites_and_restore(self):
        resolved, records, index_sha = self.verify()
        self.assertEqual(set(resolved), {'NSI-GAP-SITES', 'NSI-GAP-RESTORE'})
        self.assertEqual(resolved['NSI-GAP-SITES']['status'], 'REMOVED')
        subject = resolved['NSI-GAP-SITES']['subject']
        self.assertEqual(subject['project_id'], 'appgprj_6a8a7bff59548191b5250e5c28b8c80c')
        self.assertEqual(subject['hostname'], 'clued-cloud.tdoljyj.chatgpt.site')
        sites = [r for r in records if r['object_type'].startswith('historical_sites_')]
        self.assertEqual(len(sites), 2)
        self.assertTrue(all(r['still_writable'] is False and r['read_only_history'] is True
                            and r['observed_lifecycle'] == 'REMOVED' for r in sites))
        self.assertEqual(index_sha, hashlib.sha256((self.root / 'SourceIndex.json').read_bytes()).hexdigest())

    def test_seven_library_references_do_not_resolve_library_gap(self):
        resolved, records, _ = self.verify()
        library = [r for r in records if r['object_type'] == 'historical_library_reference']
        self.assertEqual(len(library), 7)
        self.assertTrue(all(r['live_rechecked'] is False for r in library))
        self.assertNotIn('NSI-GAP-LIBRARY', resolved)
        self.assertNotIn('NSI-GAP-AUTH', resolved)

    def test_restore_complete_catalog_and_restored_paused_state(self):
        resolved, records, _ = self.verify()
        restore = resolved['NSI-GAP-RESTORE']
        self.assertEqual(restore['subject'], {'project_id': 'gfnfxbphsdtayoaxitly'})
        self.assertEqual(restore['status'], 'SCANNED')
        self.assertEqual(restore['records'], 1156)
        self.assertEqual(restore['final_project_status'], 'INACTIVE')
        rows = [r for r in records if r['object_type'].startswith('supabase_')]
        self.assertEqual(len(rows), 1156)
        self.assertTrue(all(r['observed_project_status'] == 'INACTIVE' for r in rows))

    def test_restore_wrong_catalog_project_rejected_after_rehash(self):
        self.mutate_restore(lambda d: d.update(project_id='wrongproject'))
        with self.assertRaises(ValueError):
            self.verify()

    def test_restore_wrong_page_project_rejected_after_rehash(self):
        self.mutate_restore(lambda d: d['pages'][3].update(project_id='wrongproject'))
        with self.assertRaises(ValueError):
            self.verify()

    def test_restore_wrong_final_project_rejected_after_rehash(self):
        self.mutate_retained_tool('project-final.json', lambda d: d.update(id='wrongproject'))
        with self.assertRaises(ValueError):
            self.verify()

    def test_restore_not_repaused_rejected_after_rehash(self):
        self.mutate_retained_tool('project-final.json', lambda d: d.update(status='ACTIVE_HEALTHY'))
        with self.assertRaises(ValueError):
            self.verify()

    def test_restore_missing_active_observation_rejected_after_rehash(self):
        self.mutate_retained_tool('restore-active-before.json', lambda d: d.update(status='INACTIVE'))
        with self.assertRaises(ValueError):
            self.verify()

    def test_restore_failed_pause_rejected_after_rehash(self):
        self.mutate_retained_tool('pause-response.json', lambda d: d.update(success=False))
        with self.assertRaises(ValueError):
            self.verify()

    def test_restore_missing_page_rejected_after_rehash(self):
        self.mutate_restore(lambda d: d['pages'].pop())
        with self.assertRaises(ValueError):
            self.verify()

    def test_restore_duplicate_page_rejected_after_rehash(self):
        self.mutate_restore(lambda d: d['pages'].__setitem__(3, d['pages'][2]))
        with self.assertRaises(ValueError):
            self.verify()

    def test_restore_wrong_page_window_rejected_after_rehash(self):
        self.mutate_restore(lambda d: d['pages'][0].update(
            query=d['pages'][0]['query'].replace('OFFSET 0;', 'OFFSET 150;')))
        with self.assertRaises(ValueError):
            self.verify()

    def test_restore_final_md5_mismatch_rejected_after_rehash(self):
        self.mutate_restore(lambda d: d['final_catalog_digest'][0].update(naming_identity_md5='0' * 32))
        with self.assertRaises(ValueError):
            self.verify()

    def test_restore_identity_change_caught_by_final_server_digest(self):
        self.mutate_restore(lambda d: d['pages'][0]['rows'][0].update(name='unobserved-object'))
        with self.assertRaises(ValueError):
            self.verify()

    def test_restore_raw_final_digest_tamper_caught_by_index(self):
        path = self.root / 'supabase/restore-final-catalog-digest.json'
        path.write_bytes(path.read_bytes() + b' ')
        with self.assertRaises(ValueError):
            self.verify()

    def test_restore_wrong_raw_final_digest_rejected_after_rehash(self):
        path = self.root / 'supabase/restore-final-catalog-digest.json'
        catalog = read_json(self.root / 'supabase/restore-catalog.json')['data']
        digest = catalog['final_catalog_digest'][0]['naming_identity_md5']
        path.write_text(path.read_text(encoding='utf-8-sig').replace(digest, '0' * 32), encoding='utf-8')
        self.refresh_index()
        with self.assertRaises(ValueError):
            self.verify()

    def test_restore_digest_in_metadata_cannot_replace_actual_query_result(self):
        path = self.root / 'supabase/restore-final-catalog-digest.json'
        catalog = read_json(self.root / 'supabase/restore-catalog.json')['data']
        digest = catalog['final_catalog_digest'][0]['naming_identity_md5']
        doc = json.loads(path.read_text(encoding='utf-8-sig').replace(digest, '0' * 32))
        doc['expected_digest_for_comparison'] = digest
        write_json(path, doc)
        self.refresh_index()
        with self.assertRaises(ValueError):
            self.verify()

    def test_restore_failed_raw_final_tool_response_must_not_confirm_digest(self):
        path = self.root / 'supabase/restore-final-catalog-digest.json'
        doc = read_json(path)
        doc['tool_response']['isError'] = True
        write_json(path, doc)
        self.refresh_index()
        with self.assertRaises(ValueError):
            self.verify()

    def test_no_supplement_never_resolves_gaps(self):
        self.assertEqual(consolidator.verify_supplement(None, self.scope_sha), ({}, [], None))

    def test_wrong_scope_digest_is_rejected(self):
        with self.assertRaises(ValueError):
            consolidator.verify_supplement(self.root, '0' * 64)

    def test_byte_tampering_without_rehash_is_rejected(self):
        path = self.root / 'sites/evidence/sites-get-site-response.json'
        path.write_bytes(path.read_bytes() + b' ')
        with self.assertRaises(ValueError):
            self.verify()

    def test_inner_digest_still_checked_after_outer_index_is_refreshed(self):
        path = self.root / 'sites/evidence/sites-get-site-response.json'
        path.write_bytes(path.read_bytes() + b' ')
        self.refresh_index()
        with self.assertRaises(ValueError):
            self.verify()

    def test_evidence_length_mismatch_rejected_after_outer_rehash(self):
        self.mutate_sites(lambda d: d['evidence_refs'][0].update(
            bytes=d['evidence_refs'][0]['bytes'] + 1))
        with self.assertRaises(ValueError):
            self.verify()

    def test_missing_evidence_is_rejected(self):
        (self.root / 'sites/evidence/sites-retirement-log-section.md').unlink()
        with self.assertRaises(ValueError):
            self.verify()

    def test_missing_retirement_contract_cannot_resolve_gap(self):
        (self.root / 'sites/sources/site-retirement.json').unlink()
        with self.assertRaises(ValueError):
            self.verify()

    def test_unindexed_file_is_rejected(self):
        (self.root / 'unexpected.json').write_text('{}', encoding='utf-8')
        with self.assertRaises(ValueError):
            self.verify()

    def test_duplicate_index_path_is_rejected(self):
        path = self.root / 'SourceIndex.json'
        index = read_json(path)
        index['files'].append(dict(index['files'][0]))
        write_json(path, index)
        with self.assertRaises(ValueError):
            self.verify()

    def test_wrong_project_subject_rejected_after_rehash(self):
        self.mutate_sites(lambda d: d['covered_resource'].update(project_id='appgprj_other'))
        with self.assertRaises(ValueError):
            self.verify()

    def test_wrong_hostname_subject_rejected_after_rehash(self):
        self.mutate_sites(lambda d: d['covered_resource'].update(hostname='another.chatgpt.site'))
        with self.assertRaises(ValueError):
            self.verify()

    def test_wrong_preserved_source_subject_rejected_after_rehash(self):
        self.mutate_evidence('sites-hosting-at-source-preservation.json',
                             lambda d: d.update(project_id='appgprj_other'))
        with self.assertRaises(ValueError):
            self.verify()

    def test_global_absence_claim_rejected_after_rehash(self):
        self.mutate_sites(lambda d: d['scope_disposition'].update(claims_all_sites_absent=True))
        with self.assertRaises(ValueError):
            self.verify()

    def test_new_deletion_claim_rejected_after_rehash(self):
        self.mutate_sites(lambda d: d['scope_disposition'].update(new_deletion_or_deployment_performed=True))
        with self.assertRaises(ValueError):
            self.verify()

    def test_false_authorization_rejected_after_rehash(self):
        self.mutate_sites(lambda d: d['historical_deletion'].update(user_authorization_recorded=False))
        with self.assertRaises(ValueError):
            self.verify()

    def test_string_false_authorization_must_not_count_as_confirmation(self):
        self.mutate_sites(lambda d: d['historical_deletion'].update(user_authorization_recorded='false'))
        with self.assertRaises(ValueError):
            self.verify()

    def test_string_false_confirmation_must_not_count_as_confirmation(self):
        self.mutate_sites(lambda d: d['historical_deletion'].update(permanent_deletion_confirmation_recorded='false'))
        with self.assertRaises(ValueError):
            self.verify()

    def test_wrong_http_code_rejected_after_both_hash_layers_refreshed(self):
        self.mutate_evidence('sites-get-site-response.json',
                             lambda d: d['structuredContent']['error_data'].update(code=403))
        with self.assertRaises(ValueError):
            self.verify()

    def test_wrong_error_code_rejected_after_both_hash_layers_refreshed(self):
        self.mutate_evidence('sites-get-site-response.json',
                             lambda d: d['structuredContent'].update(error_code='FORBIDDEN'))
        with self.assertRaises(ValueError):
            self.verify()

    def test_wrong_versions_response_rejected_after_both_hash_layers_refreshed(self):
        self.mutate_evidence('sites-list-versions-response.json',
                             lambda d: d['structuredContent']['error_data'].update(code=200))
        with self.assertRaises(ValueError):
            self.verify()

    def test_relative_evidence_escape_rejected_even_with_valid_external_hash(self):
        outside = self.root.parent / 'outside-proof.json'
        outside.write_text('{}', encoding='utf-8')
        self.mutate_sites(lambda d: d['evidence_refs'].append(
            digest_row(outside, '../../outside-proof.json')))
        with self.assertRaises(ValueError):
            self.verify()

    def test_absolute_evidence_escape_rejected_even_with_valid_external_hash(self):
        outside = self.root.parent / 'outside-proof.json'
        outside.write_text('{}', encoding='utf-8')
        self.mutate_sites(lambda d: d['evidence_refs'].append(
            digest_row(outside, outside.as_posix())))
        with self.assertRaises(ValueError):
            self.verify()

    def test_outer_index_escape_cannot_authorize_an_external_file(self):
        outside = self.root.parent / 'outside-proof.json'
        outside.write_text('{}', encoding='utf-8')
        path = self.root / 'SourceIndex.json'
        index = read_json(path)
        index['files'].append(digest_row(outside, '../outside-proof.json'))
        write_json(path, index)
        with self.assertRaises(ValueError):
            self.verify()


if __name__ == '__main__':
    unittest.main()
