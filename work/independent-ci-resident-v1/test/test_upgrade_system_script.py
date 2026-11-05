"""Offline tests of windows/test-upgrade-system.ps1 (Task 695d31cc): the LocalSystem test of the upgrade's Compile chain.

Only the DRY-RUN, the refusals and the static properties are run here (real Windows PowerShell 5.1, temp directories, a fixture install
root). The -Apply path needs one UAC (a SYSTEM scheduled task) and is never run by this test; if the test process happens to be
elevated, the test that would call -Apply is skipped. Nothing here touches C:\\ProgramData.
"""
import ctypes
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

RES = Path(__file__).resolve().parents[1]
SCRIPT = RES / 'windows' / 'test-upgrade-system.ps1'
APPLY = RES / 'windows' / 'upgrade-apply.ps1'
INSTALL = RES / 'windows' / 'install-resident.ps1'
POWERSHELL = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
HEX64 = re.compile(r'^[0-9a-f]{64}$')
FORBIDDEN = ['Invoke-Expression', 'iex ', '-Command', 'Start-Process', 'Add-Type', 'DownloadString', 'Invoke-WebRequest', 'Invoke-RestMethod']


def elevated():
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def tree(path):
    return sorted(str(p.relative_to(path)) for p in Path(path).rglob('*')) if Path(path).exists() else None


def recipe_text(path):
    t = Path(path).read_text(encoding='utf-8').replace('\r\n', '\n')
    i = t.index('function Invoke-CompileRecipe')
    return t[i:t.index('\n}\n', i) + 2]


def here_string(name):
    t = SCRIPT.read_text(encoding='utf-8').replace('\r\n', '\n')
    m = re.search(r'^\$' + name + r" = @'\n(.*?)\n'@$", t, re.S | re.M)
    assert m, name
    return m.group(1)


@unittest.skipUnless(POWERSHELL.is_file(), 'Windows PowerShell 5.1 required')
class UpgradeSystemScript(unittest.TestCase):
    def setUp(self):
        self.d = Path(tempfile.mkdtemp(prefix='ust-'))
        self.addCleanup(shutil.rmtree, self.d, True)
        self.root = self.d / 'res'
        (self.root / 'record').mkdir(parents=True)
        (self.root / 'install').mkdir()
        (self.root / 'record' / 'acceptance.json').write_text('{"fixture":true}', encoding='utf-8')
        self.node_sha = 'ab' * 32
        (self.root / 'install' / 'install-receipt.json').write_text(json.dumps({'nodeProfileSha256': self.node_sha}), encoding='utf-8')
        self.scratch = self.d / 's'
        if len(str(self.scratch)) > 60:
            self.skipTest('temp path too long for the script\'s short -Scratch rule')

    def run_script(self, *extra, scratch=None):
        args = [str(POWERSHELL), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', str(SCRIPT),
                '-Scratch', str(scratch or self.scratch), '-InstalledRoot', str(self.root), *extra]
        p = subprocess.run(args, capture_output=True, text=True, encoding='utf-8', timeout=120)
        lines = [ln for ln in p.stdout.splitlines() if ln.strip()]
        return p.returncode, (json.loads(lines[-1]) if lines else None), p.stderr

    # ---- dry run ----
    def test_dry_run_prints_the_plan_and_writes_nothing(self):
        before = (tree(self.d))
        code, out, err = self.run_script()
        self.assertEqual(code, 0, err)
        self.assertEqual(out['mode'], 'dry-run')
        plan = out['plan']
        self.assertEqual(plan['contract'], 'clued.independent-ci.upgrade-system-test-plan/1')
        self.assertEqual(plan['principal'], 'S-1-5-18')
        self.assertEqual(sorted(plan['environment']), ['PATHEXT', 'SystemRoot'])
        self.assertTrue(plan['recipeCopiesIdentical'])
        self.assertEqual(plan['nodeProfileSha256'], self.node_sha)
        for k in ('acceptanceSha256', 'recipeSha256', 'workerSha256', 'innerSha256'):
            self.assertRegex(plan[k], HEX64, k)
        self.assertRegex(out['planSha256'], HEX64)
        self.assertIsInstance(plan['cscPresent'], bool)
        names = [i['name'] for i in plan['inputs']]
        self.assertEqual(names[:3], ['ResidentServiceHost.cs', 'SwapBroker.cs', 'CompanionJobHost.cs'])
        self.assertEqual(sorted(n for n in names if n.startswith('v2/')),
                         sorted('v2/' + n for n in ('ResidentScmV2.cs', 'ScmPidHandshakeV2.cs', 'NodeProfileV2.cs', 'FormalPublicBoundaryV2.cs', 'FormalSession0V2.cs')))
        for i in plan['inputs']:
            self.assertRegex(i['sha256'], HEX64, i['name'])
        self.assertEqual(tree(self.d), before)          # nothing created: no Scratch, nothing in the root
        self.assertFalse(self.scratch.exists())

    def test_the_plan_hash_is_stable_and_follows_the_inputs(self):
        _, a, _ = self.run_script()
        _, b, _ = self.run_script()
        self.assertEqual(a['planSha256'], b['planSha256'])
        (self.root / 'record' / 'acceptance.json').write_text('{"fixture":false}', encoding='utf-8')
        _, c, _ = self.run_script()
        self.assertNotEqual(a['planSha256'], c['planSha256'])
        self.assertNotEqual(a['plan']['acceptanceSha256'], c['plan']['acceptanceSha256'])

    def test_a_scratch_that_is_not_empty_is_refused(self):
        self.scratch.mkdir()
        (self.scratch / 'old.txt').write_text('x', encoding='utf-8')
        code, out, _ = self.run_script()
        self.assertEqual((code, out['verdict'], out['code']), (2, 'REFUSED', 'SCRATCH_NOT_EMPTY'))
        self.assertEqual([p.name for p in self.scratch.iterdir()], ['old.txt'])
        empty = self.d / 'e'
        empty.mkdir()
        code, out, _ = self.run_script(scratch=empty)
        self.assertEqual(code, 0)                        # an existing EMPTY directory is accepted

    def test_missing_inputs_are_refused(self):
        (self.root / 'record' / 'acceptance.json').unlink()
        self.assertEqual(self.run_script()[1]['code'], 'ACCEPTANCE_MISSING')
        (self.root / 'record' / 'acceptance.json').write_text('{}', encoding='utf-8')
        (self.root / 'install' / 'install-receipt.json').write_text('{"x":1}', encoding='utf-8')
        self.assertEqual(self.run_script()[1]['code'], 'NODE_PROFILE_SHA_MISSING')
        (self.root / 'install' / 'install-receipt.json').write_text('not json', encoding='utf-8')
        self.assertEqual(self.run_script()[1]['code'], 'INSTALL_RECEIPT_UNREADABLE')
        shutil.rmtree(self.root / 'install')
        self.assertEqual(self.run_script()[1]['code'], 'INSTALL_RECEIPT_MISSING')

    def test_the_two_copies_of_the_compile_recipe_must_be_one_text(self):
        self.assertEqual(recipe_text(APPLY), recipe_text(INSTALL))   # the checkout's own copies
        tampered = self.d / 'install-resident.ps1'
        text = INSTALL.read_text(encoding='utf-8')
        self.assertIn('/optimize+', text)
        tampered.write_text(text.replace('/optimize+', '/optimize-', 1), encoding='utf-8')
        code, out, _ = self.run_script('-InstallScript', str(tampered))
        self.assertEqual((code, out['verdict'], out['code']), (2, 'REFUSED', 'RECIPE_COPIES_DIFFER'))
        self.assertFalse(self.scratch.exists())

    def test_apply_without_the_plan_hash_or_without_elevation_does_nothing(self):
        if elevated():
            self.skipTest('the test process is elevated: -Apply is never run by this test')
        code, out, _ = self.run_script('-Apply')
        self.assertEqual((code, out['code']), (2, 'ELEVATED_OWNER_TOKEN_REQUIRED'))
        code, out, _ = self.run_script('-Apply', '-PlanSha256', 'f' * 64)
        self.assertEqual((code, out['code']), (2, 'ELEVATED_OWNER_TOKEN_REQUIRED'))
        self.assertFalse(self.scratch.exists())

    # ---- static properties ----
    def test_it_parses_and_has_no_forbidden_words(self):
        target = str(SCRIPT).replace("'", "''")
        script = (f"$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('{target}',[ref]$null,[ref]$e); "
                  "if ($e) { $e | ForEach-Object { $_.Message }; exit 1 } else { 'PARSE_OK' }")
        p = subprocess.run([str(POWERSHELL), '-NoProfile', '-Command', script], capture_output=True, text=True)
        self.assertEqual((p.returncode, p.stdout.strip()), (0, 'PARSE_OK'), p.stdout + p.stderr)
        text = SCRIPT.read_text(encoding='utf-8')
        for bad in FORBIDDEN:
            self.assertNotIn(bad, text, bad)
        text.encode('ascii')                              # PowerShell 5.1 reads a BOM-less script as ANSI: keep it ASCII

    def test_the_generated_scripts_parse_and_contain_no_forbidden_words(self):
        worker = here_string('WorkerText')
        inner = here_string('InnerHead') + '\n' + recipe_text(APPLY) + '\n' + here_string('InnerBody')
        for name, text in (('worker', worker), ('inner', inner)):
            for bad in FORBIDDEN:
                self.assertNotIn(bad, text, (name, bad))
            f = self.d / (name + '.ps1')
            f.write_text(text, encoding='utf-8-sig')
            target = str(f).replace("'", "''")
            script = (f"$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('{target}',[ref]$null,[ref]$e); "
                      "if ($e) { $e | ForEach-Object { $_.Message }; exit 1 } else { 'PARSE_OK' }")
            p = subprocess.run([str(POWERSHELL), '-NoProfile', '-Command', script], capture_output=True, text=True)
            self.assertEqual((p.returncode, p.stdout.strip()), (0, 'PARSE_OK'), (name, p.stdout + p.stderr))

    def test_the_child_environment_is_cleared_to_exactly_what_the_upgrader_gives(self):
        worker = here_string('WorkerText')
        self.assertIn('$psi.UseShellExecute = $false', worker)
        self.assertIn('$psi.EnvironmentVariables.Clear()', worker)
        keys = re.findall(r"\$psi\.EnvironmentVariables\['([A-Za-z]+)'\]", worker)
        self.assertEqual(sorted(keys), ['PATHEXT', 'SystemRoot'])
        self.assertLess(worker.index('EnvironmentVariables.Clear()'), worker.index('Process]::Start'))
        # the same two names as upgrader/src/windows-port.mjs APPLY_ENV
        js = (RES / 'upgrader' / 'src' / 'windows-port.mjs').read_text(encoding='utf-8')
        m = re.search(r'APPLY_ENV = Object\.freeze\(\{(.*?)\}\)', js, re.S)
        self.assertEqual(sorted(set(re.findall(r'(SystemRoot|PATHEXT):', m.group(1)))), ['PATHEXT', 'SystemRoot'])
        self.assertEqual(len(re.findall(r'[A-Za-z]+: ', m.group(1))), 2)
        inner_body = here_string('InnerBody')
        self.assertIn("'SYSTEM_ENV_NOT_CLEARED'", inner_body)
        self.assertIn("'SYSTEM_NOT_RUNNING_AS_SYSTEM'", inner_body)
        self.assertIn('--stable-digest', inner_body)

    def test_the_task_runs_as_system_and_is_always_deleted(self):
        text = SCRIPT.read_text(encoding='utf-8')
        self.assertIn("$def.Principal.UserId = 'S-1-5-18'", text)
        self.assertIn('$def.Principal.LogonType = 5', text)
        self.assertIn('$def.Principal.RunLevel = 1', text)
        fin = text[text.index('} finally {\n    try { $folder.GetTask($name).Stop(0)'):] if '} finally {\n    try { $folder.GetTask($name).Stop(0)' in text else text[text.index('finally {', text.index('RegisterTaskDefinition')):]
        self.assertIn('DeleteTask($name, 0)', fin[:300])
        self.assertLess(text.index('RegisterTaskDefinition'), text.index('DeleteTask($name, 0)'))
        self.assertIn('IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)', text)
        self.assertIn("'D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'", text)   # Scratch: SYSTEM and Administrators only, protected
        self.assertLess(text.index('SetSecurityDescriptorSddlForm'), text.index('Copy-New (Join-Path $Here'))

    def test_the_verdict_codes_are_the_documented_fixed_shapes(self):
        text = SCRIPT.read_text(encoding='utf-8')
        for code in ('FIXED_INSTALL_OWNER_REQUIRED', 'SYSTEM_COMPILE_FAILED:', 'RUNNER_STABLE_DIGEST_UNCONFIRMED', 'SYSTEM_DIGEST_DIFFERS_FROM_OWNER',
                     'SYSTEM_TEST_TIMEOUT', 'SYSTEM_TEST_NO_RESULT', 'RECIPE_COPIES_DIFFER'):
            self.assertIn(code, text, code)
        # nothing outside Scratch is written: no write to the installed root in the apply path
        apply_body = text[text.index('function Invoke-Apply'):text.index('\ntry {\n  $view = Get-Plan')]
        self.assertNotIn('$plan.installedRoot)', apply_body.replace("'--stable-digest', ('\"' + $plan.installedRoot + '\"')", ''))
        self.assertNotRegex(apply_body, r'Write-New \(Join-Path \$plan\.installedRoot')


if __name__ == '__main__':
    unittest.main()
