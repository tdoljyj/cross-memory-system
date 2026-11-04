"""Offline tests of reinstall/tools/set-aside-leftovers.py and of how build.ps1 / rollout/build-upgrade.ps1 use it (gen 8 tooling).

A first packaging attempt that dies half way must not block the next one (every output is create-only), and a COMPLETED attempt's
package must never be set aside. Also pins the day's other packaging lesson: the git archive is unpacked with Python's tarfile, never
Windows tar.exe (it cannot extract non-ASCII, e.g. Chinese, path names). Temp directories only; no host, no network, no secret.
  python -I -B -m unittest discover -s test -p "test_*.py"     (from work/independent-ci-resident-v1)
"""
import json, os, re, shutil, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.dirname(HERE)
TOOL = os.path.join(RES, 'reinstall', 'tools', 'set-aside-leftovers.py')
BUILD = os.path.join(RES, 'reinstall', 'build.ps1')
BUILD_UPGRADE = os.path.join(RES, 'rollout', 'build-upgrade.ps1')


def read(path):
    with open(path, 'rb') as f:
        return f.read()


def run(*args):
    p = subprocess.run([sys.executable, '-I', '-B', TOOL, *args], capture_output=True, text=True, encoding='utf-8')
    lines = [ln for ln in p.stdout.splitlines() if ln.strip()]
    return p.returncode, (json.loads(lines[-1]) if lines else None), p.stderr


class SetAside(unittest.TestCase):
    def setUp(self):
        self.w = tempfile.mkdtemp(prefix='setaside-')
        self.addCleanup(shutil.rmtree, self.w, True)

    def put(self, rel, data=b'x'):
        path = os.path.join(self.w, *rel.split('/'))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb') as f:
            f.write(data)
        return path

    def test_a_failed_attempts_outputs_are_renamed_and_nothing_is_deleted(self):
        a = self.put('record/inputs.n.DRAFT.abcd1234.json', b'one')
        self.put('package-n-DRAFT-abcd1234/package-manifest.json', b'two')
        shared = self.put('tree-abcd1234/keep.txt', b'shared')
        other = self.put('record/inputs.n.DRAFT.ffff0000.json', b'other commit')
        code, out, _ = run(self.w, '--pattern', 'record/*.n.DRAFT.abcd1234*', '--pattern', 'package-n-DRAFT-abcd1234', '--done', 'build-complete.n.DRAFT.abcd1234.json')
        self.assertEqual(code, 0); self.assertEqual(out['count'], 2)
        self.assertFalse(os.path.exists(a))
        self.assertTrue(os.path.exists(shared) and os.path.exists(other))
        for m in out['moved']:
            self.assertTrue(m['to'].startswith('failed-attempts/'), m)
        moved_input = [m['to'] for m in out['moved'] if m['from'].startswith('record/')][0]
        self.assertEqual(read(os.path.join(self.w, *moved_input.split('/'))), b'one')
        moved_pkg = [m['to'] for m in out['moved'] if m['from'].startswith('package-')][0]
        self.assertEqual(read(os.path.join(self.w, *moved_pkg.split('/'), 'package-manifest.json')), b'two')

    def test_the_next_attempt_is_no_longer_blocked(self):
        target = self.put('record/inputs.n.DRAFT.abcd1234.json')
        with self.assertRaises(FileExistsError):
            open(target, 'xb')   # what CreateNew did before
        code, out, _ = run(self.w, '--pattern', 'record/*.n.DRAFT.abcd1234*')
        self.assertEqual((code, out['count']), (0, 1))
        with open(target, 'xb'):
            pass                                                        # now it can be created again
        code, out, _ = run(self.w, '--pattern', 'record/*.n.DRAFT.abcd1234*')   # a second failure is set aside separately
        self.assertEqual((code, out['count']), (0, 1))
        stamps = os.listdir(os.path.join(self.w, 'failed-attempts'))
        self.assertEqual(len(stamps), 2)

    def test_a_completed_attempt_is_never_set_aside(self):
        pkg = self.put('package-n-final-abcd1234/package-manifest.json')
        self.put('build-complete.n.final.abcd1234.json', b'{}')
        code, out, _ = run(self.w, '--pattern', 'package-n-final-abcd1234', '--done', 'build-complete.n.final.abcd1234.json')
        self.assertEqual(code, 3); self.assertEqual(out['code'], 'ATTEMPT_ALREADY_COMPLETE'); self.assertEqual(out['count'], 0)
        self.assertTrue(os.path.exists(pkg))
        self.assertFalse(os.path.exists(os.path.join(self.w, 'failed-attempts')))

    def test_dry_run_moves_nothing(self):
        f = self.put('record/a.n.x.1.json')
        code, out, _ = run(self.w, '--pattern', 'record/*.n.x.1*', '--dry-run')
        self.assertEqual((code, out['count']), (0, 1)); self.assertTrue(os.path.exists(f))

    def test_nothing_to_do_is_fine(self):
        code, out, _ = run(self.w, '--pattern', 'record/*.n.x.1*')
        self.assertEqual((code, out), (0, {'moved': [], 'count': 0}))

    def test_patterns_cannot_leave_the_work_directory(self):
        for bad in ('../x', '/abs', 'C:/x', 'a/../b', '', 'a//b', 'a/./b', 'a b', 'a;b'):
            code, out, _ = run(self.w, '--pattern', bad)
            self.assertEqual((code, out['code']), (2, 'PATTERN_REFUSED'), bad)
        code, out, _ = run(os.path.join(self.w, 'missing'), '--pattern', 'x')
        self.assertEqual((code, out['code']), (2, 'WORK_DIR_OR_PATTERN_MISSING'))

    def test_failed_attempts_is_never_matched_again(self):
        self.put('failed-attempts/20260101T000000000000Z/record/a.n.x.1.json')
        code, out, _ = run(self.w, '--pattern', '*/*/*/a.n.x.1.json')
        self.assertEqual((code, out['count']), (0, 0))


class BuildScripts(unittest.TestCase):
    def text(self, path):
        with open(path, encoding='utf-8') as f:
            return f.read()

    def test_both_builders_set_leftovers_aside_before_their_first_output(self):
        for path, first_output in ((BUILD, "inputs."), (BUILD_UPGRADE, "upgrade-config.")):
            t = self.text(path)
            self.assertIn('set-aside-leftovers.py', t, path)
            self.assertIn('ATTEMPT_ALREADY_COMPLETE_USE_ANOTHER_TAG', t, path)
            self.assertLess(t.index('set-aside-leftovers.py'), t.index(first_output, t.index('$stem' if 'upgrade' in path else '$kind')), path)

    def test_build_marks_completion_only_at_the_end(self):
        t = self.text(BUILD)
        marks = [m.start() for m in re.finditer(r"Write-New \(Join-Path \$R \('build-complete\.'", t)]
        self.assertEqual(len(marks), 2)   # PackageOnly's end and the generator's end
        self.assertGreater(marks[1], t.index("& python -I @gen"))
        self.assertGreater(marks[0], t.index("PACKAGE_BUILT_NO_LAUNCHER"))

    def test_build_upgrade_completion_marker_is_its_precheck_file(self):
        t = self.text(BUILD_UPGRADE)
        self.assertIn("--done ('upgrade/precheck.' + $stem + '.*.json')", t)
        self.assertIn("('upgrade\\precheck.' + $stem + '.' + $pkgSha.Substring(0, 8) + '.json')", t)

    def test_the_archive_is_unpacked_with_python_not_windows_tar(self):
        for path in (BUILD, BUILD_UPGRADE):
            t = self.text(path)
            code_lines = [ln.split('#')[0] for ln in t.splitlines()]
            self.assertFalse([ln for ln in code_lines if re.search(r'(^|[\s&;(])tar(\.exe)?\s', ln)], path)
            self.assertIn('tarfile.open', t, path)
            self.assertIn("filter='data'", t, path)

    @unittest.skipUnless(shutil.which('powershell.exe'), 'Windows PowerShell 5.1 is required')
    def test_they_parse_in_windows_powershell(self):
        for path in (BUILD, BUILD_UPGRADE):
            target = path.replace("'", "''")
            script = (f"$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('{target}',[ref]$null,[ref]$e); "
                      "if ($e) { $e | ForEach-Object { $_.Message }; exit 1 } else { 'PARSE_OK' }")
            p = subprocess.run(['powershell.exe', '-NoProfile', '-Command', script], capture_output=True, text=True)
            self.assertEqual((p.returncode, p.stdout.strip()), (0, 'PARSE_OK'), path + p.stdout + p.stderr)


if __name__ == '__main__':
    unittest.main()
