"""Holder edit admission: concrete paths, native CAS and no write on rejection."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
import os
import subprocess

MODULE = Path(__file__).resolve().parents[1] / 'scripts/hooks/clued_work_write_set.py'
spec = importlib.util.spec_from_file_location('clued_work_write_set', MODULE)
ws = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ws)


class HolderEdits(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='clued-holder-edit-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root / 'src').mkdir()
        self.path = self.root / 'src/a.py'
        self.path.write_text('old', encoding='utf-8')
        self.claim = dict(claim_id='10000000-0000-4000-8000-000000000001',
                          task_id='10000000-0000-4000-8000-000000000002',
                          context_key='global', fence=3, execution_epoch=2,
                          lease_version=4, status='ACTIVE', holder_session_ref='fixture-session',
                          execution_handover_pending=False, terminal_release_ready=False,
                          write_set=['src/a.py', 'other/pr.py', 'record:fixture'])
        self.current = copy.deepcopy(self.claim)
        self.calls = []

    def verify(self, args):
        self.assertEqual(args['action'], 'verify_edit')
        self.assertEqual(args['lease_key'], 'fixture-only-private-key')
        self.calls.append(('verify', {k: copy.deepcopy(v) for k, v in args.items() if k != 'lease_key'}))
        return dict(status='ok', verdict='ADMITTED', holder_edit_authorized=True, claim=copy.deepcopy(self.current))

    def renew(self, args):
        self.calls.append(('renew', {k: v for k, v in args.items() if k != 'lease_key'}))
        self.assertEqual(args['lease_key'], 'fixture-only-private-key')
        self.assertEqual(args['lease_version'], self.current['lease_version'])
        self.current.update(write_set=args['write_set'], lease_version=self.current['lease_version'] + 1,
                            terminal_release_ready=False)
        return dict(status='committed', claim=copy.deepcopy(self.current))

    def perform(self, payload, claim):
        self.calls.append(('write', claim['lease_version']))
        self.path.write_text('new', encoding='utf-8')
        return 'written'

    def execute(self, target='src/a.py', **overrides):
        args = dict(tool_name='Write', tool_input={'file_path': target, 'content': 'new'},
                    root=self.root, claim=self.claim, session_ref='fixture-session',
                    progress_ref='20000000-0000-4000-8000-000000000001',
                    lease_key='fixture-only-private-key', renew=self.renew,
                    verify=self.verify, perform=self.perform)
        args.update(overrides)
        return ws.execute_claimed_edit(**args)

    def test_patch_includes_move_source_destination_delete_and_new_file(self):
        patch = ('*** Begin Patch\n*** Update File: src/a.py\n*** Move to: src/renamed.py\n'
                 '@@\n-old\n+new\n*** Delete File: old.py\n'
                 '*** Add File: new.py\n+x\n*** End Patch\n')
        self.assertEqual(ws.derive_edit_targets('functions.apply_patch', patch, root=self.root),
                         ('new.py', 'old.py', 'src/a.py', 'src/renamed.py'))

    def test_structured_absolute_and_relative_paths_have_same_identity(self):
        for tool in ['Edit', 'Write', 'NotebookEdit']:
            with self.subTest(tool=tool):
                field = 'notebook_path' if tool == 'NotebookEdit' else 'file_path'
                for target in ['src/a.py', str(self.path)]:
                    self.assertEqual(ws.derive_edit_targets(tool, {field: target}, root=self.root), ('src/a.py',))

    def test_rejects_escaping_ambiguous_and_unrepresentable_paths(self):
        for target in ['../escape.py', 'src/../a.py', 'src/*.py', 'src/a?.py', 'src/file with spaces.py',
                       'src/a\n.py', 'https://example.invalid/a.py', str(self.root.parent / 'outside.py')]:
            with self.subTest(target=target), self.assertRaises(ws.WriteSetError):
                ws.derive_edit_targets('Write', {'file_path': target}, root=self.root)

    def test_unknown_shell_and_malformed_patch_do_not_guess_targets(self):
        for tool, payload in [('exec_command', {'cmd': 'python writer.py'}),
                              ('apply_patch', '*** Update File: src/a.py\n'),
                              ('apply_patch', '*** Begin Patch\n*** Move to: b.py\n*** End Patch')]:
            with self.subTest(tool=tool), self.assertRaises(ws.WriteSetError):
                ws.derive_edit_targets(tool, payload, root=self.root)

    def test_claim_union_preserves_other_pr_plan_and_execution_resources(self):
        current = ['src/**', 'other/pr.py', 'record:fixture', 'execution/active.py']
        self.assertEqual(ws.required_write_set(current, ['src/a.py', 'new.py']),
                         ('execution/active.py', 'new.py', 'other/pr.py', 'record:fixture', 'src/**'))

    def test_native_tail_glob_covers_directory_resource_without_expansion(self):
        for pattern, target in [('src/**', 'src'), ('src*/**', 'src1'), ('**/src*/**', 'a/src1')]:
            self.assertEqual(ws.required_write_set([pattern], [target]), (pattern,))

    def test_covered_edit_checks_live_authority_and_uses_no_renewal(self):
        out = self.execute()
        self.assertEqual([x[0] for x in self.calls], ['verify', 'write'])
        self.assertEqual(out['result'], 'written')
        self.assertNotIn('lease_key', repr(out))
        self.assertNotIn('fixture-only-private-key', repr(out))

    def test_new_path_renews_union_then_verifies_before_any_file_write(self):
        self.execute('new.py')
        self.assertEqual([x[0] for x in self.calls], ['verify', 'renew', 'verify', 'write'])
        args = self.calls[1][1]
        self.assertEqual(set(args['write_set']), set(self.claim['write_set']) | {'new.py'})
        self.assertNotIn('pr_ref', self.calls[2][1])
        self.assertNotIn('head_sha', self.calls[2][1])

    def test_existing_readiness_is_invalidated_even_for_already_covered_path(self):
        self.current['terminal_release_ready'] = True
        self.execute()
        self.assertEqual([x[0] for x in self.calls], ['verify', 'renew', 'verify', 'write'])
        self.assertFalse(self.current['terminal_release_ready'])

    def test_native_rejections_leave_file_unchanged(self):
        for code in ['work_claim_conflict', 'work_claim_version_conflict', 'work_claim_fence_mismatch',
                     'work_claim_lease_key_invalid', 'work_claim_renewals_exhausted', 'work_claim_no_progress']:
            self.calls.clear()
            def reject(args, code=code):
                self.calls.append(('renew-rejected', code))
                return dict(status='rejected', error_code=code)
            with self.subTest(code=code), self.assertRaises(ws.WriteSetError):
                self.execute('new.py', renew=reject)
            self.assertEqual(self.path.read_text(), 'old')
            self.assertNotIn('write', [x[0] for x in self.calls])

    def test_stale_generation_handover_wrong_session_or_missing_ready_proof_refuse(self):
        changes = [dict(fence=4), dict(execution_epoch=3), dict(lease_version=5),
                   dict(execution_handover_pending=True), dict(holder_session_ref='another-session'),
                   dict(status='RELEASED')]
        for fields in changes:
            self.current = {**copy.deepcopy(self.claim), **fields}
            with self.subTest(fields=fields), self.assertRaises(ws.WriteSetError):
                self.execute()
            self.assertEqual(self.path.read_text(), 'old')
        self.current = copy.deepcopy(self.claim)
        del self.current['terminal_release_ready']
        with self.assertRaises(ws.WriteSetError):
            self.execute()

    def test_fresh_verify_rejection_cannot_write_or_renew(self):
        def reject(args):
            return dict(status='ok', verdict='REJECTED', reasons=['claim_not_current'])
        with self.assertRaises(ws.WriteSetError):
            self.execute('new.py', verify=reject)
        self.assertEqual(self.path.read_text(), 'old')
        self.assertEqual(self.calls, [])

    def test_bad_committed_reply_or_readiness_not_cleared_cannot_write(self):
        def bad(args):
            return dict(status='committed', claim={**self.current, 'write_set': ['new.py'], 'lease_version': 5})
        with self.assertRaises(ws.WriteSetError):
            self.execute('new.py', renew=bad)
        self.assertEqual(self.path.read_text(), 'old')

    def test_no_private_key_or_fresh_progress_does_not_attempt_mutation(self):
        for fields in [dict(lease_key=None), dict(progress_ref=None)]:
            self.calls.clear()
            with self.subTest(fields=fields), self.assertRaises(ws.WriteSetError):
                self.execute('new.py', **fields)
            self.assertEqual([x[0] for x in self.calls], [] if fields.get('lease_key', True) is None else ['verify'])
            self.assertEqual(self.path.read_text(), 'old')

    def test_transport_exception_never_exposes_private_key(self):
        def fail(args):
            raise RuntimeError('fixture-only-private-key')
        with self.assertRaises(ws.WriteSetError) as cm:
            self.execute('new.py', renew=fail)
        self.assertNotIn('fixture-only-private-key', str(cm.exception))
        self.assertEqual(self.path.read_text(), 'old')

    def test_legacy_renew_projection_still_requires_fresh_readiness_false(self):
        def legacy(args):
            reply = self.renew(args)
            reply['claim'].pop('terminal_release_ready')
            return reply
        self.execute('new.py', renew=legacy)
        self.assertEqual([x[0] for x in self.calls], ['verify', 'renew', 'verify', 'write'])

    def test_post_renew_ready_true_still_refuses_file_write(self):
        self.current['terminal_release_ready'] = True
        def stale_ready(args):
            reply = self.renew(args)
            self.current['terminal_release_ready'] = True
            reply['claim'].pop('terminal_release_ready')
            return reply
        with self.assertRaises(ws.WriteSetError):
            self.execute(renew=stale_ready)
        self.assertEqual(self.path.read_text(), 'old')

    def test_readonly_admitted_claim_is_not_holder_edit_authority(self):
        def reader(args):
            return dict(status='ok', verdict='ADMITTED', claim=copy.deepcopy(self.current))
        with self.assertRaises(ws.WriteSetError):
            self.execute(verify=reader)
        self.assertEqual(self.path.read_text(), 'old')

    def test_existing_junction_or_symlink_is_not_a_structured_edit_target(self):
        outside = tempfile.TemporaryDirectory(prefix='clued-holder-outside-')
        self.addCleanup(outside.cleanup)
        external = Path(outside.name) / 'a.py'
        external.write_text('external', encoding='utf-8')
        link = self.root / 'alias'
        def make(target):
            if os.name == 'nt':
                result = subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(target)], capture_output=True)
                self.assertEqual(result.returncode, 0)
            else:
                link.symlink_to(target, target_is_directory=True)
        def remove():
            if os.name == 'nt':
                os.rmdir(link)
            else:
                link.unlink()
        make(self.root / 'src')
        self.addCleanup(lambda: remove() if link.exists() else None)
        def verify(args):
            reply = self.verify(args)
            remove(); make(Path(outside.name))
            return reply
        def perform(payload, claim):
            target = Path(payload['file_path'])
            (target if target.is_absolute() else self.root / target).write_text('escaped', encoding='utf-8')
        with self.assertRaises(ws.WriteSetError):
            self.execute('alias/a.py', verify=verify, perform=perform)
        self.assertEqual(external.read_text(), 'external')
        self.assertEqual(self.calls, [])

    def test_parent_retarget_after_authenticated_verify_cannot_escape(self):
        outside = tempfile.TemporaryDirectory(prefix='clued-holder-after-verify-')
        self.addCleanup(outside.cleanup)
        external = Path(outside.name) / 'a.py'
        external.write_text('external', encoding='utf-8')
        original = self.root / 'src'
        moved = self.root / 'saved-src'
        self.assertTrue(original.resolve().is_relative_to(self.root))
        self.assertTrue(moved.resolve().is_relative_to(self.root))
        def remove_link():
            if os.name == 'nt':
                if original.is_junction():
                    os.rmdir(original)
            elif original.is_symlink():
                original.unlink()
        self.addCleanup(remove_link)
        def verify(args):
            reply = self.verify(args)
            original.rename(moved)
            if os.name == 'nt':
                result = subprocess.run(['cmd', '/c', 'mklink', '/J', str(original), outside.name], capture_output=True)
                self.assertEqual(result.returncode, 0)
            else:
                original.symlink_to(outside.name, target_is_directory=True)
            return reply
        def perform(payload, claim):
            Path(payload['file_path']).write_text('escaped', encoding='utf-8')
        with self.assertRaises(ws.WriteSetError):
            self.execute(verify=verify, perform=perform)
        self.assertEqual([x[0] for x in self.calls], ['verify'])
        self.assertEqual(external.read_text(), 'external')

    def test_repository_root_spaces_are_not_claim_resource_whitespace(self):
        root = self.root / 'root with spaces'
        (root / 'src').mkdir(parents=True)
        file = root / 'src/a.py'
        file.write_text('value', encoding='utf-8')
        self.assertEqual(ws.derive_edit_targets('Write', {'file_path': str(file)}, root=root), ('src/a.py',))


if __name__ == '__main__':
    unittest.main()
