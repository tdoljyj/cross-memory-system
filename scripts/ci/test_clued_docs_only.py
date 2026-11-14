import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest

MODULE = Path(__file__).with_name('clued-docs-only.py')
spec = importlib.util.spec_from_file_location('clued_docs_only', MODULE)
scope = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scope)


class DocumentationQualification(unittest.TestCase):
    def setUp(self):
        self.parent = Path(tempfile.gettempdir()).resolve()
        self.root = Path(tempfile.mkdtemp(prefix='clued-docs-test-', dir=self.parent)).resolve()
        self.old = Path.cwd()
        os.chdir(self.root)
        self.command('init', '-q')
        self.command('config', 'user.name', 'Codex@DESK-W-591')
        self.command('config', 'user.email', 'codex@DESK-W-591')
        self.command('config', 'core.autocrlf', 'false')
        self.put('README.md', 'initial\n')
        self.put('apps/clued-cloud/package.json', '{}\n')
        self.commit()
        self.base = self.command('rev-parse', 'HEAD').strip()
        self.merge_sha = None
        self.pr_head = None

    def tearDown(self):
        os.chdir(self.old)
        # Delete only the exact temporary child created by this test.
        if self.root.resolve().parent != self.parent or not self.root.name.startswith('clued-docs-test-'):
            raise AssertionError('temporary cleanup escaped its parent')
        def writable_retry(function, name, _error):
            target = Path(name).resolve()
            if not target.is_relative_to(self.root):
                raise AssertionError('cleanup retry escaped the test repository')
            os.chmod(target, stat.S_IWRITE | stat.S_IREAD)
            function(name)
        shutil.rmtree(self.root, onerror=writable_retry)

    def command(self, *args):
        return subprocess.check_output(['git', *args], text=True, stderr=subprocess.PIPE)

    def put(self, name, value):
        target = self.root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(value, encoding='utf-8')

    def commit(self):
        self.command('add', '--all')
        self.command('commit', '-qm', '[Codex@DESK-W-591] isolated qualification fixture')

    def inputs(self, event_name='pull_request'):
        head = self.command('rev-parse', 'HEAD').strip()
        if event_name == 'pull_request' and head != self.merge_sha:
            self.pr_head = head
            self.command('checkout', '-q', '--detach', self.base)
            self.command('merge', '-q', '--no-ff', '--no-edit', self.pr_head)
            head = self.command('rev-parse', 'HEAD').strip()
            self.merge_sha = head
        env = {'GITHUB_SHA': head, 'GITHUB_REPOSITORY': 'owner/repo',
               'GITHUB_EVENT_NAME': event_name, 'GITHUB_BASE_REF': 'main',
               'GITHUB_REF': 'refs/pull/12/merge' if event_name == 'pull_request' else 'refs/heads/main'}
        event = {'pull_request': {'number': 12, 'head': {'sha': self.pr_head},
                 'base': {'sha': self.base, 'ref': 'main', 'repo': {'full_name': 'owner/repo'}}},
                 'before': self.base, 'after': head}
        return env, event

    def test_regular_docs_on_pr_and_main_qualify_without_claiming_app_tests(self):
        self.put('docs/maintenance/README.md', 'ordinary runbook\n')
        self.put('scripts/ci/self-hosted/README.md', 'ordinary runner instructions\n')
        self.commit()
        for event_name in ['pull_request', 'push']:
            result = scope.classify(*self.inputs(event_name))
            self.assertFalse(result['run_full'])
            self.assertEqual(result['qualification'], 'DOCUMENTATION_ONLY')
            self.assertFalse(result['full_app_tests'])

    def test_code_dependencies_config_and_governance_always_require_full(self):
        for name in ['apps/clued-cloud/README.md', 'scripts/check.mjs', 'config/trust.json',
                     '.github/workflows/test.yml', 'development/contracts/spec.md',
                     'skills/clued/SKILL.md', 'docs/execution-plans/plan.md',
                     'docs/maintenance/database-security.md', 'docs/evidence.json']:
            self.assertFalse(scope.paper_path(name), name)
        self.put('docs/maintenance/README.md', 'docs\n')
        self.put('apps/clued-cloud/package.json', '{"changed":true}\n')
        self.commit()
        self.assertTrue(scope.classify(*self.inputs('push'))['run_full'])

    def test_empty_missing_foreign_or_changed_checkout_require_full(self):
        self.assertTrue(scope.classify(*self.inputs())['run_full'])
        self.put('README.md', 'changed\n')
        self.commit()
        env, event = self.inputs()
        for bad_base in ['0' * 40, 'f' * 40]:
            altered = json.loads(json.dumps(event))
            altered['pull_request']['base']['sha'] = bad_base
            self.assertTrue(scope.classify(env, altered)['run_full'])
        event['pull_request']['base']['repo']['full_name'] = 'another/repo'
        self.assertTrue(scope.classify(env, event)['run_full'])
        self.assertTrue(scope.classify({**env, 'GITHUB_SHA': self.base}, self.inputs()[1])['run_full'])
        self.put('README.md', 'dirty\n')
        self.assertTrue(scope.classify(*self.inputs())['run_full'])

    def test_renamed_code_deleted_docs_and_nonregular_modes(self):
        (self.root / 'docs').mkdir()
        self.command('mv', 'apps/clued-cloud/package.json', 'docs/moved.md')
        self.commit()
        self.assertTrue(scope.classify(*self.inputs())['run_full'])
        self.base = self.command('rev-parse', 'HEAD').strip()
        self.command('rm', 'README.md')
        self.commit()
        self.assertFalse(scope.classify(*self.inputs())['run_full'])
        self.base = self.command('rev-parse', 'HEAD').strip()
        self.put('docs/mode.md', 'text\n')
        os.chmod(self.root / 'docs/mode.md', 0o755)
        self.command('add', 'docs/mode.md')
        self.command('update-index', '--chmod=+x', 'docs/mode.md')
        self.command('commit', '-qm', '[Codex@DESK-W-591] executable documentation fixture')
        self.assertTrue(scope.classify(*self.inputs())['run_full'])

    def test_malformed_events_and_unknown_events_require_full(self):
        env, event = self.inputs()
        for value in [None, [], {'pull_request': None}, {'pull_request': {'base': []}}]:
            self.assertTrue(scope.classify(env, value)['run_full'])
        self.assertTrue(scope.classify({**env, 'GITHUB_EVENT_NAME': 'workflow_dispatch'}, event)['run_full'])

    def test_symlink_and_nonancestor_comparisons_never_qualify(self):
        self.command('config', 'core.symlinks', 'false')
        self.put('docs/link.md', 'README.md')
        blob = subprocess.check_output(['git', 'hash-object', '-w', '--stdin'], input='README.md', text=True).strip()
        self.command('update-index', '--add', '--cacheinfo', '120000', blob, 'docs/link.md')
        self.command('commit', '-qm', '[Codex@DESK-W-591] symlink object fixture')
        self.assertTrue(scope.classify(*self.inputs())['run_full'])
        first = self.base
        self.base = self.command('rev-parse', 'HEAD').strip()
        self.command('checkout', '-q', first)
        self.put('README.md', 'another branch\n')
        self.commit()
        self.assertTrue(scope.classify(*self.inputs('push'))['run_full'])

    def test_partial_false_output_followed_by_failure_exits_nonzero(self):
        self.put('README.md', 'ordinary docs\n')
        self.commit()
        env, event = self.inputs()
        event_path = self.root / 'event.json'
        output = self.root / 'outputs.txt'
        event_path.write_text(json.dumps(event), encoding='utf-8')
        variables = {**os.environ, **env, 'GITHUB_EVENT_PATH': str(event_path),
                     'GITHUB_OUTPUT': str(output), 'GITHUB_STEP_SUMMARY': str(self.root)}
        done = subprocess.run([os.sys.executable, str(MODULE)], env=variables, capture_output=True)
        self.assertNotEqual(done.returncode, 0)
        self.assertEqual(output.read_text(encoding='utf-8'), 'run_full=false\n')

    def test_pr_number_ref_target_head_and_merge_shape_are_required(self):
        self.put('README.md', 'ordinary docs\n')
        self.commit()
        env, event = self.inputs()
        for delta in [{'GITHUB_REF': 'refs/heads/main'}, {'GITHUB_BASE_REF': 'other'}]:
            self.assertTrue(scope.classify({**env, **delta}, event)['run_full'])
        for key, value in [('number', None), ('head', {'sha': 'b' * 40}), ('base', {'sha': self.base, 'ref': 'other'})]:
            altered = json.loads(json.dumps(event))
            altered['pull_request'][key] = value
            self.assertTrue(scope.classify(env, altered)['run_full'])
        self.command('checkout', '-q', '--detach', self.pr_head)
        self.assertTrue(scope.classify({**env, 'GITHUB_SHA': self.pr_head}, event)['run_full'])


if __name__ == '__main__':
    unittest.main()
