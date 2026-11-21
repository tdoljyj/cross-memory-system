"""The last step of phase B (linux/prep.py, step (7)) judges verify-resident-linux.sh's output by the success word that script prints.
That word is written once, in verify-resident-linux.sh's `status=` verdict line; prep.py reads it from there (like first-install.py,
commit 4dc7b9f12) instead of carrying a hand-written copy. The generated B.sh's step (7) is cut out of the real generator's output
and run under native Git Bash against a fake verify whose verdict line has a DIFFERENT success word: a hand-written word cannot pass it.
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

import test_reinstall_kit as kit

PREP = Path(kit.PREP)
REAL_VERIFY = Path(kit.RE).parent / 'linux' / 'verify-resident-linux.sh'
MARK = '  bash --noprofile --norc "$STG/tools/verify-resident-linux.sh" > "$T/l7-verify.stdout.json" || true\n'


def real_word():
    m = re.search(rb'(?m)^status=\$\(\[ \$ok = 1 \] && echo ([A-Z_]+) \|\| echo [A-Z_]+\)$', REAL_VERIFY.read_bytes())
    return m.group(1).decode()


class PrepVerifyStatus(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bash = os.environ.get('CLUED_TEST_BASH') or (r'C:\Program Files\Git\bin\bash.exe' if os.name == 'nt' else shutil.which('bash'))
        if not cls.bash or not Path(cls.bash).is_file():
            raise RuntimeError('NON_WSL_BASH_REQUIRED_FOR_PREP_VERIFY_STATUS_TEST')

    def test_no_hand_written_copy_of_the_success_word_in_prep(self):
        text = PREP.read_text(encoding='utf-8')
        self.assertNotIn(real_word(), text)
        self.assertNotIn('RESIDENT_LINUX_VERIFIED', text)

    def step7(self, fake_word, ok=True):
        with tempfile.TemporaryDirectory(prefix='pv') as d:
            argv, w = kit.build_prep(d, fake_word)
            p = kit.run_prep(argv)
            self.assertEqual(p.returncode, 0, p.stderr[-1500:])
            out = json.loads(p.stdout)
            b = kit.rd(w, 'linux', next(n for n in out['scripts'] if n.startswith('reinstall-linux-B-switch'))).decode()
            i = b.index(MARK)
            seg = b[i:b.index('  # (8)', i)]
            root = Path(d, 'case'); (root / 'stg' / 'tools').mkdir(parents=True); (root / 'run').mkdir()
            line = next(l for l in kit.VERDICT_LINE.decode().splitlines()).replace(real_word(), fake_word)
            fake = ('#!/bin/bash\nok=%d\n' % int(ok) + line + '\necho "{\\"status\\":\\"$status\\",\\"upgrade-v1-pins\\":true,\\"generation-current\\":true}"\n')
            (root / 'stg' / 'tools' / 'verify-resident-linux.sh').write_text(fake, encoding='utf-8', newline='\n')
            driver = ('set -euo pipefail\nCASE_DIR=$(cd "$CASE_DIR" && pwd)\nSTG=$CASE_DIR/stg; T=$CASE_DIR/run\nPY=true\n'
                      'refuse() { printf \'REFUSED:%s\n\' "$1"; exit 3; }\n' + seg + 'printf "STEP7_PASSED\n"\n')
            (root / 'driver.sh').write_text(driver, encoding='utf-8', newline='\n')
            return subprocess.run([self.bash, '--noprofile', '--norc', (root / 'driver.sh').as_posix()], capture_output=True, text=True,
                                  encoding='utf-8', errors='replace', timeout=30, env={**os.environ, 'CASE_DIR': root.as_posix()})

    def test_step7_accepts_the_word_the_script_prints_whatever_it_is(self):
        r = self.step7('SOMETHING_ELSE_OK')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('STEP7_PASSED', r.stdout)

    def test_step7_refuses_a_failed_verification(self):
        r = self.step7('SOMETHING_ELSE_OK', ok=False)
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertIn('REFUSED:RESIDENT_LINUX_NOT_VERIFIED_SEE_RECOVERY', r.stdout)


if __name__ == '__main__':
    unittest.main()
