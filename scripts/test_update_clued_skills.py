"""Offline migration checks. Every installation target is a disposable test directory."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('clued_skill_updater', Path(__file__).with_name('update_clued_skills.py'))
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class UnifiedSkillInstallationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='clued-skill-test-')
        self.root = Path(self.temporary.name)
        self.target = self.root / 'skills'
        self.wanted = updater.hashes(updater.SOURCE / updater.NAME)

    def tearDown(self):
        self.temporary.cleanup()

    def fixture(self, name, content='local customized Skill'):
        folder = self.target / name
        folder.mkdir(parents=True, exist_ok=True)
        (folder / 'SKILL.md').write_text(content, encoding='utf-8')
        (folder / 'local-note.txt').write_text('preserve this local content', encoding='utf-8')
        return folder

    def test_check_missing_target_does_not_create_files(self):
        result = updater.update(self.target, check=True)
        self.assertEqual(result['clued']['status'], 'DIFFERENT')
        self.assertFalse(self.target.exists())
        self.assertEqual(list(self.root.iterdir()), [])

    def test_install_is_complete_and_repeated_update_is_a_noop(self):
        result = updater.update(self.target)
        self.assertEqual(result['clued']['status'], 'UPDATED')
        self.assertEqual(updater.hashes(self.target / 'clued'), self.wanted)
        self.assertEqual([p.relative_to(self.target).as_posix() for p in self.target.rglob('SKILL.md')], ['clued/SKILL.md'])
        before = {p: p.stat().st_mtime_ns for p in self.root.rglob('*')}
        result = updater.update(self.target)
        self.assertEqual(result['clued']['status'], 'MATCH')
        self.assertEqual({p: p.stat().st_mtime_ns for p in self.root.rglob('*')}, before)

    def test_migration_preserves_all_originals_and_unrelated_skills(self):
        before = {}
        for name in (updater.NAME, *updater.RETIRED_NAMES):
            before[name] = updater.hashes(self.fixture(name, name))
        unrelated = self.fixture('unrelated')
        unrelated_before = updater.hashes(unrelated)
        result = updater.update(self.target)
        self.assertEqual(updater.hashes(self.target / 'clued'), self.wanted)
        for name, expected in before.items():
            backup = Path(result[name]['backup'])
            self.assertEqual(updater.hashes(backup), expected)
            self.assertFalse(backup.is_relative_to(self.target))
        for name in updater.RETIRED_NAMES:
            self.assertEqual(result[name]['status'], 'RETIRED')
            self.assertFalse((self.target / name).exists())
        self.assertEqual(updater.hashes(unrelated), unrelated_before)
        self.assertTrue(all(value['status'] == 'MATCH' for value in updater.update(self.target, check=True).values()))

    def test_check_detects_remaining_old_entry_without_retiring_it(self):
        updater.update(self.target)
        self.fixture('clued-user')
        before = updater.hashes(self.target)
        result = updater.update(self.target, check=True)
        self.assertEqual(result['clued']['status'], 'MATCH')
        self.assertEqual(result['clued-user']['status'], 'DIFFERENT')
        self.assertEqual(updater.hashes(self.target), before)

    def test_failed_activation_restores_original_and_retired_entries(self):
        for name in (updater.NAME, *updater.RETIRED_NAMES, 'unrelated'):
            self.fixture(name, name)
        before = updater.hashes(self.target)
        actual_rename = Path.rename

        def fail_activation(path, destination):
            if path.name == 'clued' and path.parent.name.startswith('stage-'):
                raise OSError('injected activation failure')
            return actual_rename(path, destination)

        with patch.object(Path, 'rename', fail_activation):
            with self.assertRaisesRegex(OSError, 'injected activation failure'):
                updater.update(self.target)
        self.assertEqual(updater.hashes(self.target), before)
        self.assertEqual(list((self.root / 'clued-skill-backups').iterdir()), [])

    def test_changed_source_during_copy_is_rejected_before_retirement(self):
        self.fixture('clued-user')
        before = updater.hashes(self.target)
        actual_copy = shutil.copytree

        def changed_copy(source, destination, *args, **kwargs):
            result = actual_copy(source, destination, *args, **kwargs)
            if Path(destination).name == 'clued':
                (Path(destination) / 'unexpected.txt').write_text('changed', encoding='utf-8')
            return result

        with patch.object(shutil, 'copytree', changed_copy):
            with self.assertRaisesRegex(ValueError, 'Source changed during copy'):
                updater.update(self.target)
        self.assertEqual(updater.hashes(self.target), before)
        self.assertFalse((self.target / 'clued').exists())

    def test_repository_source_cannot_be_an_installation_target(self):
        with self.assertRaisesRegex(ValueError, 'separate from repository sources'):
            updater.update(updater.SOURCE)


class ReleasedVersionTests(unittest.TestCase):
    """ComponentVersioning v0.4: versions are raised on purpose, never per pull request. A host without a checkout
    (claude.ai, Codex) compares only the number, so the installer refuses Skill files that differ from what their
    version meant when it was released: the same number with other content would look current everywhere."""

    MANIFEST = {"schema": "clued.components/1", "components": [{
        "id": "skill.clued", "kind": "skill", "version": "1.0.0", "root": "skills/clued", "files": ["**/*"],
        "version_marker": {"file": "SKILL.md", "pattern": '  version: "{version}"'}}]}

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='clued-skill-release-')
        self.addCleanup(self.temporary.cleanup)
        self.repository = Path(self.temporary.name) / 'repo'
        scripts = self.repository / 'scripts'
        scripts.mkdir(parents=True)
        shutil.copyfile(Path(__file__).with_name('clued_components.py'), scripts / 'clued_components.py')
        (self.repository / 'config').mkdir()
        (self.repository / 'config/clued-components.json').write_text(json.dumps(self.MANIFEST), encoding='utf-8')
        self.skill = self.repository / 'skills/clued'
        self.skill.mkdir(parents=True)
        (self.skill / 'SKILL.md').write_text('---\nname: clued\nmetadata:\n  version: "1.0.0"\n---\nbody\n', encoding='utf-8')
        self.git('init', '-q', '-b', 'main')
        self.commit('release 1.0.0')
        source = patch.object(updater, 'SOURCE', self.repository / 'skills')
        source.start()
        self.addCleanup(source.stop)

    def git(self, *args):
        done = subprocess.run(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false',
                               '-c', 'core.hooksPath=', *args], cwd=self.repository, capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)

    def commit(self, message):
        self.git('add', '-A')
        self.git('commit', '-qm', message)

    def test_same_version_with_other_files_is_not_installed(self):
        target = Path(self.temporary.name) / 'skills'
        self.assertEqual(updater.update(target)['clued']['status'], 'UPDATED')
        (self.skill / 'SKILL.md').write_text('---\nname: clued\nmetadata:\n  version: "1.0.0"\n---\nchanged\n', encoding='utf-8')
        self.commit('edit the Skill without a version')
        other = Path(self.temporary.name) / 'other'
        with self.assertRaisesRegex(ValueError, r'skill\.clued 1\.0\.0: its files differ from version 1\.0\.0 as released'):
            updater.update(other)
        self.assertFalse(other.exists())
        self.assertEqual(updater.update(target, check=True)['clued']['status'], 'DIFFERENT', '--check still reports')
        subprocess.run([sys.executable, 'scripts/clued_components.py', 'bump', 'skill.clued', '1.0.1'],
                       cwd=self.repository, check=True, capture_output=True)
        self.commit('release 1.0.1')
        self.assertEqual(updater.update(other)['clued']['status'], 'UPDATED')

    def test_an_uncommitted_version_is_not_installed(self):
        subprocess.run([sys.executable, 'scripts/clued_components.py', 'bump', 'skill.clued', '1.0.1'],
                       cwd=self.repository, check=True, capture_output=True)
        with self.assertRaisesRegex(ValueError, r'skill\.clued 1\.0\.1 is in no commit'):
            updater.update(Path(self.temporary.name) / 'skills')

if __name__ == '__main__':
    unittest.main()
