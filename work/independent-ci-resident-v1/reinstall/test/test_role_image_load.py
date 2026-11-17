"""Execute Linux B's actual image-loading block under native Git Bash, never WSL.

Docker is a shell double; real gzip and sha256sum read disposable OCI/classic
archives. Backend-specific IDs must survive exactly, with no config fallback.
"""
import ast
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from test_export_role_image import oci_archive, tar_gz


class RoleImageLoad(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bash = os.environ.get('CLUED_TEST_BASH') or (r'C:\Program Files\Git\bin\bash.exe' if os.name == 'nt' else shutil.which('bash'))
        if not cls.bash or not Path(cls.bash).is_file():
            raise RuntimeError('NON_WSL_BASH_REQUIRED_FOR_ROLE_IMAGE_TEST')
        tree = ast.parse((Path(__file__).resolve().parents[1] / 'linux/first-install.py').read_text(encoding='utf-8'))
        cls.fragment = ast.literal_eval(next(n.value for n in tree.body if isinstance(n, ast.Assign)
                                            and any(isinstance(t, ast.Name) and t.id == 'LOCAL_IMAGE_LOAD' for t in n.targets)))

    def run_case(self, *, indexed=True, compressed=True, present=False, wrong=False, changed=False, load_fail=False, inspect_fail=False, classic=False):
        entries, iid, config = oci_archive(indexed=indexed)
        if classic:
            iid = config
        data = tar_gz(entries)
        if not compressed:
            import gzip
            data = gzip.decompress(data)
        with tempfile.TemporaryDirectory(prefix='image-load-') as tmp:
            root = Path(tmp); (root / 'images').mkdir()
            name = iid + ('.tar.gz' if compressed else '.tar')
            (root / 'images' / name).write_bytes(data + (b'changed' if changed else b''))
            pin = hashlib.sha256(data).hexdigest()
            text = r'''set -euo pipefail
W=$(cd "$CASE_DIR" && pwd)
refuse() { printf 'REFUSED:%s\n' "$1"; exit 3; }
docker() {
  printf '%s\n' "$*" >> "$W/calls"
  case "$1 $2" in
    'image inspect')
      if [ "$3" = --format ]; then
        [ "$INSPECT_FAIL" = 0 ] || return 9
        printf 'sha256:%s\n' "$LOADED_ID"
      else
        [ "$PRESENT" = 1 ] || [ -f "$W/loaded" ]
      fi ;;
    'load -q')
      [ "$LOAD_FAIL" = 0 ] || return 8
      if [ "$#" = 2 ]; then cat >/dev/null; else [ "$3" = -i ] && cat "$4" >/dev/null; fi
      touch "$W/loaded" ;;
    *) return 99 ;;
  esac
}
''' + self.fragment.replace('@@LOCAL_IMAGES@@', f'{iid} {name} {pin}\n') + '\nprintf "VERIFIED\\n"\n'
            driver = root / 'driver.sh'; driver.write_text(text, encoding='utf-8', newline='\n')
            env = {**os.environ, 'CASE_DIR': root.as_posix(), 'PRESENT': str(int(present)), 'LOAD_FAIL': str(int(load_fail)),
                   'INSPECT_FAIL': str(int(inspect_fail)), 'LOADED_ID': '0' * 64 if wrong else iid}
            result = subprocess.run([self.bash, '--noprofile', '--norc', driver.as_posix()], capture_output=True, text=True,
                                    encoding='utf-8', timeout=20, env=env)
            calls = (root / 'calls').read_text().splitlines()
            return result, calls

    def test_manifest_index_and_classic_ids_load_and_recheck_exact_identity(self):
        for indexed, classic in ((False, False), (True, False), (False, True)):
            for compressed in (False, True):
                with self.subTest(indexed=indexed, classic=classic, compressed=compressed):
                    r, calls = self.run_case(indexed=indexed, classic=classic, compressed=compressed)
                    self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                    self.assertIn('VERIFIED', r.stdout)
                    self.assertEqual(sum(c.startswith('load -q') for c in calls), 1)
                    self.assertTrue(calls[-1].startswith('image inspect --format {{.Id}} sha256:'))

    def test_present_image_is_rechecked_without_reloading(self):
        r, calls = self.run_case(present=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertFalse(any(c.startswith('load') for c in calls))

    def test_archive_tamper_load_failure_inspect_failure_and_wrong_id_refuse(self):
        for opts, code in (({'changed': True}, 'IMAGE_ARCHIVE_NOT_THE_PINNED_ONE'),
                           ({'load_fail': True}, 'IMAGE_LOAD_FAILED'),
                           ({'inspect_fail': True}, 'IMAGE_INSPECT_FAILED'),
                           ({'wrong': True}, 'IMAGE_NOT_PRESENT'),
                           ({'present': True, 'wrong': True}, 'IMAGE_NOT_PRESENT')):
            with self.subTest(opts=opts):
                r, calls = self.run_case(**opts)
                self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
                self.assertIn('REFUSED:' + code + ':', r.stdout)
                if opts.get('changed'):
                    self.assertFalse(any(c.startswith('load') for c in calls))


if __name__ == '__main__':
    unittest.main()
