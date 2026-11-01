"""Offline evidence selection against disposable trees; no installed state is read."""
import hashlib
import ast
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('ledger_evidence', ROOT / 'tools/ledger-evidence.py')
EVIDENCE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EVIDENCE)
KEY = 'a' * 64


class LedgerEvidence(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'state/ledger').mkdir(parents=True)
        (self.root / 'install').mkdir()

    def terminal(self, relative='state/ledger', key=KEY):
        directory = self.root / relative / key
        directory.mkdir(parents=True)
        path = directory / '90-terminal.json'
        path.write_bytes(b'{"outcome":"COMPLETED","at":"2026-11-01T00:00:00Z"}')
        return path

    def backfill(self):
        path = self.terminal('state/backfill/3/ledger')
        data = path.read_bytes()
        manifest = {'contract': 'clued.independent-ci.resident-backfill-manifest/1', 'sources': [
            {'dir': '3', 'files': [{'path': 'ledger\\' + KEY + '\\90-terminal.json',
                                  'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}]}]}
        (self.root / 'install/backfill-manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
        return path

    def test_live_terminal_remains_primary(self):
        self.backfill()
        path = self.terminal()
        result = EVIDENCE.select_terminal(self.root)
        self.assertEqual(result['relativeDirectory'], 'state/ledger')
        self.assertIsNone(result['backfillManifestSha256'])
        self.assertEqual(result['terminalSha256'], hashlib.sha256(path.read_bytes()).hexdigest())

    def test_empty_live_uses_only_existing_manifested_backfill_bytes(self):
        path = self.backfill()
        before = path.read_bytes()
        result = EVIDENCE.select_terminal(self.root)
        self.assertEqual(result['relativeDirectory'], 'state/backfill/3/ledger')
        self.assertEqual(result['key'], KEY)
        self.assertEqual(result['terminalSha256'], hashlib.sha256(before).hexdigest())
        self.assertEqual(result['backfillManifestSha256'], hashlib.sha256((self.root / 'install/backfill-manifest.json').read_bytes()).hexdigest())
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(list((self.root / 'state/ledger').iterdir()), [])

    def test_open_live_batch_cannot_fall_back(self):
        self.backfill()
        (self.root / 'state/ledger' / ('b' * 64)).mkdir()
        with self.assertRaisesRegex(ValueError, 'LIVE_LEDGER_NOT_TERMINAL'):
            EVIDENCE.select_terminal(self.root)

    def test_missing_history_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'NO_TERMINAL_LEDGER_ENTRY'):
            EVIDENCE.select_terminal(self.root)

    def test_changed_backfill_is_not_relabelled_as_valid_history(self):
        path = self.backfill()
        path.write_bytes(b'{"outcome":"FAILED_CLEAN"}')
        with self.assertRaisesRegex(ValueError, 'BACKFILL_TERMINAL_NOT_MANIFESTED'):
            EVIDENCE.select_terminal(self.root)

    def test_missing_or_duplicate_manifest_entry_is_refused(self):
        self.backfill()
        path = self.root / 'install/backfill-manifest.json'
        doc = json.loads(path.read_text())
        doc['sources'][0]['files'] *= 2
        path.write_text(json.dumps(doc))
        with self.assertRaisesRegex(ValueError, 'BACKFILL_MANIFEST_DUPLICATE'):
            EVIDENCE.select_terminal(self.root)
        doc['sources'][0]['files'] = []
        path.write_text(json.dumps(doc))
        with self.assertRaisesRegex(ValueError, 'BACKFILL_TERMINAL_NOT_MANIFESTED'):
            EVIDENCE.select_terminal(self.root)

    def test_exact_halted_key_must_exist(self):
        self.backfill()
        self.assertEqual(EVIDENCE.select_terminal(self.root, KEY)['key'], KEY)
        with self.assertRaisesRegex(ValueError, 'NO_TERMINAL_LEDGER_ENTRY'):
            EVIDENCE.select_terminal(self.root, 'b' * 64)

    def test_hard_linked_terminal_is_refused(self):
        path = self.terminal()
        os.link(path, self.root / 'other.json')
        with self.assertRaisesRegex(ValueError, 'LEDGER_EVIDENCE_NOT_PLAIN'):
            EVIDENCE.select_terminal(self.root)


class AdoptedRehearsal(unittest.TestCase):
    def report(self, package='a' * 64):
        return {'contract': 'clued.independent-ci.reinstall-rehearsal/1', 'status': 'REHEARSAL_PASS',
                'findings': [], 'packageManifestSha256': package, 'commit': 'c' * 40, 'configSha256': 'd' * 64}

    def test_current_package_stays_accepted_and_old_needs_explicit_proof(self):
        self.assertTrue(EVIDENCE.rehearsal_matches(self.report(), 'a' * 64, 'c' * 40, 'd' * 64))
        old = self.report('b' * 64)
        self.assertFalse(EVIDENCE.rehearsal_matches(old, 'a' * 64, 'c' * 40, 'd' * 64))
        self.assertTrue(EVIDENCE.rehearsal_matches(old, 'a' * 64, 'c' * 40, 'd' * 64, 'b' * 64))
        self.assertFalse(EVIDENCE.rehearsal_matches(self.report('e' * 64), 'a' * 64, 'c' * 40, 'd' * 64, 'b' * 64))

    def test_adopted_package_cannot_bypass_other_rehearsal_fields(self):
        for field, value in [('contract', 'other'), ('status', 'FAILED'), ('findings', ['bad']),
                             ('commit', 'e' * 40), ('configSha256', 'f' * 64)]:
            with self.subTest(field=field):
                report = self.report('b' * 64)
                report[field] = value
                self.assertFalse(EVIDENCE.rehearsal_matches(report, 'a' * 64, 'c' * 40, 'd' * 64, 'b' * 64))

    def test_generator_proves_existing_linux_and_acceptance_bytes_before_reuse(self):
        source = ast.parse((ROOT / 'launcher/generate.py').read_text(encoding='utf-8'))
        block = next(n for n in source.body if isinstance(n, ast.If)
                     and isinstance(n.test, ast.Name) and n.test.id == 'LINUX_EVIDENCE'
                     and any(isinstance(x, ast.Name) and x.id == 'ADOPTED_PKG' for x in ast.walk(n)))
        code = compile(ast.Module(body=[block], type_ignores=[]), 'actual-generate-adoption-block', 'exec')
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            roots = [base / 'current', base / 'adopted']
            acceptance = {'sourceAcceptanceRef': 'source-ref', 'hostQualificationRef': 'host-ref'}
            package = {'ciSourceManifestSha256': '1' * 64, 'linux': {'manifestSha256': '2' * 64}}
            for root in roots:
                (root / 'linux').mkdir(parents=True)
                (root / 'record').mkdir()
                (root / 'linux/public-manifest.json').write_text('{"fixed":true}')
                (root / 'record/source-manifest.json').write_text('{"source":"fixed"}')
                (root / 'record/acceptance.json').write_text(json.dumps(acceptance))
                (root / 'package-manifest.json').write_text(json.dumps(package))
            sha = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
            original = sha(roots[1] / 'package-manifest.json')
            def evaluate(evidence_sha=original):
                env = {'LINUX_EVIDENCE': True, 'ADOPTED_PKG': str(roots[1]), 'PKG': str(roots[0]), 'pkg': package,
                       'pkg_sha': '9' * 64, 'text': 'package: ' + evidence_sha, 'acceptance': acceptance,
                       'BS': '\\', 'sha': sha, 'json': json, 'os': os, 're': __import__('re'),
                       'adopted_proven': False, 'adopted_pkg_sha': None}
                exec(code, env)
                return env
            self.assertTrue(evaluate()['adopted_proven'])
            with self.assertRaises(AssertionError):
                evaluate('8' * 64)
            for relative in ['linux/public-manifest.json', 'record/source-manifest.json', 'record/acceptance.json']:
                path = roots[1] / relative
                before = path.read_bytes()
                path.write_text('{}')
                with self.subTest(relative=relative), self.assertRaises(AssertionError):
                    evaluate()
                path.write_bytes(before)


if __name__ == '__main__':
    unittest.main()
