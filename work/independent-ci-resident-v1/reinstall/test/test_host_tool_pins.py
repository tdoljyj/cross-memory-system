"""Fable ruling 0e418483 (r7 phase B), 4.1 ruling 2: phase A holds every role's every hostTools.* entry of the source manifest to the
node's file. The fleet pins gitleaks' /usr/bin/python3.12 (the worker refuses every gitleaks job on ACTUAL_PYTHON_PIN_CHANGED otherwise),
but no step of a first install looked at it: a new node whose python is another build passed A, B and the drill, and failed at its first
gitleaks job. Here the actual A text of first-install.py, from the host_ready call to the continuation, runs under native Git Bash
against files in a temporary directory, with the host tool lines rendered by first-install.py's own function from a source manifest
fixture. Before the gate existed that segment was empty and A went on (red); after it, a file that is not the pin refuses
HOST_TOOL_NOT_THE_FLEET_PIN:<path> before anything is staged.
"""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import first_install_text


def gate():
    ns = first_install_text.names()
    a, common = ns['A'], ns['COMMON']
    start = a.index(common) + len(common)
    assert a.startswith('host_ready\n', start), a[start:start + 40]
    start += len('host_ready\n')
    return a[start:a.index('@@CONTINUE@@', start)]


def posix(p):   # Git Bash's form of a Windows path (C:/x -> /c/x), which the manifest's absolute-path rule accepts
    s = Path(p).as_posix()
    return '/' + s[0].lower() + s[2:] if len(s) > 1 and s[1] == ':' else s


class HostToolPins(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bash = os.environ.get('CLUED_TEST_BASH') or (r'C:\Program Files\Git\bin\bash.exe' if os.name == 'nt' else shutil.which('bash'))
        if not cls.bash or not Path(cls.bash).is_file():
            raise RuntimeError('NON_WSL_BASH_REQUIRED_FOR_HOST_TOOL_TEST')

    def manifest(self, tools):
        """A source manifest's roles as the record has them: formalRoles plus sourceFiles and controllerRelay; hostTools on any role."""
        roles = {'gitleaks': {'containerCommand': {}, 'timeoutMs': 1, 'maxOutputBytes': 1, 'sourceFiles': [], 'controllerRelay': {}},
                 'trivy': {'containerCommand': {}, 'formalTrivy': {}, 'sourceFiles': [], 'controllerRelay': {}},
                 'contract-placement': {'command': {}, 'sourceFiles': [], 'controllerRelay': {}}}
        for role, name, path, sha in tools:
            roles[role].setdefault('hostTools', {})[name] = {'path': path, 'sha256': sha}
        return {'roles': roles}

    def run_gate(self, files, tools):
        """files: {name: bytes} made in a temporary directory; tools: (role, tool name, file name, pinned sha256 or None = its own)."""
        with tempfile.TemporaryDirectory(prefix='host-tools-') as tmp:
            root = Path(tmp)
            for name, data in files.items():
                (root / name).write_bytes(data)
            rows = [(role, name, posix(root / f), sha or hashlib.sha256(files.get(f, b'')).hexdigest()) for role, name, f, sha in tools]
            text = gate()
            lines = first_install_text.function('host_tool_lines')
            if lines is not None:
                text = text.replace('@@HOST_TOOLS@@', lines(self.manifest(rows)))
            driver = ('set -euo pipefail\nrefuse() { printf \'REFUSED:%s\\n\' "$1"; exit 3; }\n' + text + 'printf "A_WENT_ON\\n"\n')
            (root / 'driver.sh').write_text(driver, encoding='utf-8', newline='\n')
            r = subprocess.run([self.bash, '--noprofile', '--norc', (root / 'driver.sh').as_posix()], capture_output=True, text=True,
                               encoding='utf-8', errors='replace', timeout=30)
            return r, rows

    def test_a_host_tool_that_is_not_the_fleet_pin_stops_phase_a(self):
        r, rows = self.run_gate({'python3.12': b'rootfs python 0.16'}, [('gitleaks', 'python', 'python3.12', hashlib.sha256(b'fleet 0.17').hexdigest())])
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertEqual(r.stdout.splitlines()[-1], 'REFUSED:HOST_TOOL_NOT_THE_FLEET_PIN:' + rows[0][2])
        self.assertNotIn('A_WENT_ON', r.stdout)

    def test_the_pinned_files_pass(self):
        r, _ = self.run_gate({'python3.12': b'fleet 0.17'}, [('gitleaks', 'python', 'python3.12', None)])
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('A_WENT_ON', r.stdout)

    def test_every_role_and_every_tool_is_checked_not_only_python(self):
        files = {'python3.12': b'fleet 0.17', 'jq': b'jq 1.7', 'tool': b'other'}
        good = [('gitleaks', 'python', 'python3.12', None), ('trivy', 'jq', 'jq', None), ('contract-placement', 'tool', 'tool', None)]
        r, _ = self.run_gate(files, good)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        for i in range(3):
            with self.subTest(changed=good[i][1]):
                bad = list(good); bad[i] = bad[i][:3] + ('0' * 64,)
                r, rows = self.run_gate(files, bad)
                self.assertEqual(r.stdout.splitlines()[-1], 'REFUSED:HOST_TOOL_NOT_THE_FLEET_PIN:' + rows[i][2], r.stdout + r.stderr)

    def test_a_missing_file_is_refused_by_its_path(self):
        r, rows = self.run_gate({}, [('gitleaks', 'python', 'python3.12', '1' * 64)])
        self.assertEqual(r.stdout.splitlines()[-1], 'REFUSED:HOST_TOOL_NOT_THE_FLEET_PIN:' + rows[0][2], r.stdout + r.stderr)

    def test_the_lines_come_from_the_manifest_and_bad_entries_are_refused_by_the_generator(self):
        lines = first_install_text.function('host_tool_lines')
        self.assertIsNotNone(lines)
        m = self.manifest([('gitleaks', 'python', '/usr/bin/python3.12', 'e' * 64), ('trivy', 'x', '/usr/bin/x', 'f' * 64)])
        self.assertEqual(lines(m), 'e' * 64 + ' /usr/bin/python3.12\n' + 'f' * 64 + ' /usr/bin/x\n')
        self.assertEqual(lines(self.manifest([])), '')
        for path, sha in (('usr/bin/x', 'e' * 64), ('/usr/bin/a b', 'e' * 64), ('/usr/../x', 'e' * 64), ('/usr/bin/x', 'E' * 64), ('/x\n/y', 'e' * 64)):
            with self.subTest(path=path, sha=sha[:2]):
                with self.assertRaises(AssertionError):
                    lines(self.manifest([('gitleaks', 'python', path, sha)]))


if __name__ == '__main__':
    unittest.main()
