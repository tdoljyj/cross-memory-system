"""N1 (r8 inventory): phase B's last step B11 runs linux/verify-resident-linux.sh and must accept the verdict that script really prints.

verify-resident-linux.sh prints {"status":"RESIDENT_LINUX_VERIFIED",...}; first-install.py waited for "LINUX_RESIDENT_VERIFIED" (the two
words swapped), so a new node whose every check passed still stopped in B11 on VERIFY_RESIDENT_LINUX_FAILED. Here the real verdict lines of
verify-resident-linux.sh (its `status=` and `echo` lines, cut out of the file) produce the output, and the actual B11 text of
first-install.py's phase B (from its '# B11:' line to the end of B) judges it under native Git Bash. Nothing else runs.
The word is read by rconfig.verified_status, the one reader both generators load (r8 fixup review F3/F6).
"""
import importlib.util
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

import first_install_text

RES = Path(__file__).resolve().parents[2]
VERIFY = RES / 'linux' / 'verify-resident-linux.sh'
RCONFIG = RES / 'reinstall' / 'tools' / 'rconfig.py'


def rconfig():
    spec = importlib.util.spec_from_file_location('rconfig_under_test', RCONFIG)
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    return mod


def verdict_lines():
    lines = VERIFY.read_text(encoding='utf-8').splitlines(keepends=True)
    picked = [l for l in lines if l.startswith('status=$(') or l.startswith('echo "{\\"status\\":')]
    assert len(picked) == 2, picked
    return ''.join(picked)


def b11():
    """The B11 segment of the actual B text, rendered the way the generator renders it."""
    ns = first_install_text.names()
    b = ns['B']
    start = b.index('# B11:'); end = b.index('@@B_DONE@@', start)
    text = b[start:end]
    return text.replace('@@VERIFIED@@', rconfig().verified_status(VERIFY.read_text(encoding='utf-8')))


class VerifyStatus(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bash = os.environ.get('CLUED_TEST_BASH') or (r'C:\Program Files\Git\bin\bash.exe' if os.name == 'nt' else shutil.which('bash'))
        if not cls.bash or not Path(cls.bash).is_file():
            raise RuntimeError('NON_WSL_BASH_REQUIRED_FOR_VERIFY_STATUS_TEST')

    def run_b11(self, ok):
        with tempfile.TemporaryDirectory(prefix='b11-') as tmp:
            root = Path(tmp); (root / 'stg' / 'tools').mkdir(parents=True); (root / 'run').mkdir()
            fake = ('#!/bin/bash\nok=%d\nout=(\'"root":true\' \'"generation-current":%s\')\n' % (int(ok), 'true' if ok else 'false')
                    + verdict_lines() + '[ $ok = 1 ]\n')
            (root / 'stg' / 'tools' / 'verify-resident-linux.sh').write_text(fake, encoding='utf-8', newline='\n')
            driver = ('set -euo pipefail\nset -C\nCASE_DIR=$(cd "$CASE_DIR" && pwd)\nSTG=$CASE_DIR/stg; T=$CASE_DIR/run\n'
                      'refuse() { printf \'REFUSED:%s\\n\' "$1"; exit 3; }\n' + b11() + 'printf "B11_PASSED\\n"\n')
            (root / 'driver.sh').write_text(driver, encoding='utf-8', newline='\n')
            return subprocess.run([self.bash, '--noprofile', '--norc', (root / 'driver.sh').as_posix()], capture_output=True, text=True,
                                  encoding='utf-8', errors='replace', timeout=30, env={**os.environ, 'CASE_DIR': root.as_posix()})

    def test_the_verdict_verify_resident_linux_prints_on_success_passes_b11(self):
        r = self.run_b11(True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('"status":"RESIDENT_LINUX_VERIFIED"', r.stdout)
        self.assertIn('B11_PASSED', r.stdout)

    def test_a_failed_verification_is_refused(self):
        r = self.run_b11(False)
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertIn('REFUSED:VERIFY_RESIDENT_LINUX_FAILED', r.stdout)

    def test_the_word_is_taken_from_verify_resident_linux_not_written_twice(self):
        text = first_install_text.FIRST_INSTALL.read_text(encoding='utf-8')
        self.assertNotIn('LINUX_RESIDENT_VERIFIED', text)
        self.assertNotIn('RESIDENT_LINUX_VERIFIED', text)
        self.assertIn("VERIFIED = rconfig.verified_status(", text)
        rc = rconfig()
        self.assertEqual(rc.verified_status(VERIFY.read_text(encoding='utf-8')), 'RESIDENT_LINUX_VERIFIED')
        for bad in ('', 'status=$(echo X)\n', VERIFY.read_text(encoding='utf-8') * 2):
            with self.subTest(bad=bad[:40]):
                with self.assertRaises(rc.ConfigError):
                    rc.verified_status(bad)


if __name__ == '__main__':
    unittest.main()
