"""Fable ruling 11-21 "r5 preflight gaps" section 2.4 (N9): a node on which no batch ever ran (a first install whose verify did not pass is
exactly that node) can be reinstalled. select_terminal returns an explicit empty-ledger evidence when no ledger holds any entry at all, and
refuses as before when an entry is there without a terminal record; the generator pins which of the two the launcher was generated over.
Offline: disposable trees, the generator's own pin expressions."""
import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('ledger_evidence', ROOT / 'tools/ledger-evidence.py')
EVIDENCE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EVIDENCE)
GENERATE = ROOT / 'launcher' / 'generate.py'
KEY = 'a' * 64


class EmptyLedger(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'state/ledger').mkdir(parents=True)
        (self.root / 'install').mkdir()

    def backfill(self, terminal):
        entry = self.root / 'state/backfill/3/ledger' / KEY
        entry.mkdir(parents=True)
        files = []
        if terminal:
            data = b'{"outcome":"COMPLETED"}'
            (entry / '90-terminal.json').write_bytes(data)
            files.append({'path': 'ledger\\' + KEY + '\\90-terminal.json', 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
        manifest = self.root / 'install/backfill-manifest.json'
        manifest.write_text(json.dumps({'contract': 'clued.independent-ci.resident-backfill-manifest/1', 'sources': [{'dir': '3', 'files': files}]}), encoding='utf-8')
        receipt = self.root / 'install/install-receipt.json'
        receipt.write_text(json.dumps({'backfillManifestSha256': hashlib.sha256(manifest.read_bytes()).hexdigest()}), encoding='utf-8')
        return hashlib.sha256(receipt.read_bytes()).hexdigest()

    def test_no_entry_in_any_ledger_is_the_explicit_empty_evidence(self):
        result = EVIDENCE.select_terminal(self.root, None, None)
        self.assertEqual(result, {'relativeDirectory': 'state/ledger', 'key': None, 'terminalSha256': None, 'backfillManifestSha256': None, 'empty': True})

    def test_an_entry_without_a_terminal_record_is_still_refused(self):
        receipt_sha = self.backfill(terminal=False)   # a historical entry that never ended: not "no batch ever ran"
        with self.assertRaisesRegex(ValueError, 'NO_TERMINAL_LEDGER_ENTRY'):
            EVIDENCE.select_terminal(self.root, None, receipt_sha)
        (self.root / 'state/ledger' / ('b' * 64)).mkdir()
        with self.assertRaisesRegex(ValueError, 'LIVE_LEDGER_NOT_TERMINAL'):
            EVIDENCE.select_terminal(self.root, None, receipt_sha)

    def test_a_halted_batch_is_never_satisfied_by_an_empty_ledger(self):
        with self.assertRaisesRegex(ValueError, 'NO_TERMINAL_LEDGER_ENTRY'):
            EVIDENCE.select_terminal(self.root, KEY, None)

    def test_a_terminal_entry_is_selected_as_before_and_says_it_is_not_empty(self):
        receipt_sha = self.backfill(terminal=True)
        result = EVIDENCE.select_terminal(self.root, None, receipt_sha)
        self.assertEqual((result['key'], result['relativeDirectory'], result['empty']), (KEY, 'state/backfill/3/ledger', False))


class GeneratorPins(unittest.TestCase):
    """The launcher lines generate.py writes, evaluated with the generator's own q and _fq."""
    def setUp(self):
        self.text = GENERATE.read_text(encoding='utf-8')
        defs = [n for n in ast.parse(self.text).body if (isinstance(n, ast.FunctionDef) and n.name in ('q', '_fq'))
                or (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == '_qn' for t in n.targets))]
        self.assertEqual(len(defs), 3)
        self.defs = defs

    def env(self, **names):
        env = dict({'re': re, 'sys': sys, 'os': os}, **names)
        exec(compile(ast.Module(body=self.defs, type_ignores=[]), 'generate.py', 'exec'), env)
        return env

    def line(self, name):
        found = re.findall(r"^    '\$" + name + r" = ' \+ (.+?)(?: \+ '   #.*)?,$", self.text, re.M)
        self.assertEqual(len(found), 1, name)
        return found[0]

    def test_the_empty_ledger_is_pinned_from_select_terminal(self):
        empty = {'relativeDirectory': 'state/ledger', 'key': None, 'terminalSha256': None, 'backfillManifestSha256': None, 'empty': True}
        entry = {'relativeDirectory': 'state/ledger', 'key': KEY, 'terminalSha256': 'f' * 64, 'backfillManifestSha256': None, 'empty': False}
        first = {'key': None, 'relativeDirectory': '', 'terminalSha256': None, 'backfillManifestSha256': None}   # a first install's (generate.py)
        pin = self.line('LedgerEmptyAtGeneration')
        for evidence, want in ((empty, '$true'), (entry, '$false'), (first, '$false')):
            self.assertEqual(eval(pin, self.env(terminal_evidence=evidence)), want, evidence)
        self.assertEqual(eval(self.line('HaltedBatchKey'), self.env(newest_key=None)), '$null')
        # the generator takes the reinstall's evidence from select_terminal and nothing else
        self.assertEqual(len(re.findall(r'terminal_evidence = _ledger_evidence\.select_terminal\(', self.text)), 1)

    def test_a_first_install_pins_the_registration_script_the_identity_keys_are_read_with(self):
        # section 2.2 (N7), the launcher's line: the node identity keys are read with registration/export-node-registration.ps1's own names
        # and finder, from the unpacked package (the universal tree carries it), its bytes pinned here
        script, digest = self.line('FirstInstallRegistrationScript'), self.line('FirstInstallRegistrationScriptSha256')
        reg = ('C:\\u\\work\\independent-ci-resident-v1\\registration\\export-node-registration.ps1', 'ab' * 32)
        first = {'factsSha256': 'c' * 64}
        self.assertEqual([eval(x, self.env(FLEET={'planSha256': 'x'}, FIRST=first, FIRST_REGISTRATION=reg)) for x in (script, digest)], ["'" + reg[0] + "'", "'" + reg[1] + "'"])
        self.assertEqual([eval(x, self.env(FLEET={'planSha256': 'x'}, FIRST=None)) for x in (script, digest)], ['$null', '$null'])
        self.assertIn("os.path.join(HERE, '..', '..', 'registration', 'export-node-registration.ps1')", self.text)


if __name__ == '__main__':
    unittest.main()
