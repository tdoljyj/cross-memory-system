"""Isolated continuation generation and rename; never installed host state."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from test_resume_evidence import fixture

HERE = Path(__file__).resolve().parents[1] / 'launcher'
SPEC = importlib.util.spec_from_file_location('resume_launcher', HERE / 'resume.py')
RESUME = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RESUME)
PS = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
sha = lambda value: hashlib.sha256(value).hexdigest()


class LocalPaths(unittest.TestCase):
    """A local path names a drive letter, a root and plain parts. Any drive: the reinstall configuration takes every drive
    letter (rconfig.WIN_PATH), and a work or temporary directory on D: is local (RESUME_LOCAL_PATH_REQUIRED, 10 failures
    of reinstall-python with TEMP on D:)."""

    def test_any_drive_letter_is_a_local_path(self):
        for value in [r'C:\w\x', r'D:\agent-temp\run-slots\tmp\clued-resume-1', r'e:\data']:
            self.assertEqual(RESUME.windows_path(value), value)

    def test_relative_unc_device_and_dot_paths_stay_refused(self):
        unc = chr(92) * 2   # two backslashes: a UNC or device path prefix
        for value in [r'D:relative', unc + r'server\share\x', unc + r'?\C:\x', r'D:\a\..\b', r'D:\a' + unc + 'b', 'D:' + chr(92),
                      r'CD:\x', r'1:\x', r'D:\a\.', None]:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'RESUME_LOCAL_PATH_REQUIRED'):
                RESUME.windows_path(value)

    @unittest.skipUnless(os.name == 'nt', 'Windows paths are the source contract')
    def test_output_on_another_drive_is_outside_the_work_directory(self):
        with self.assertRaisesRegex(ValueError, 'RESUME_OUTPUT_OUTSIDE_WORKDIR'):
            RESUME.output_path(r'D:\elsewhere\out.ps1', r'C:\work')


@unittest.skipUnless(os.name == 'nt', 'Windows paths are the source contract')
class ResumeLauncher(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='clued-resume-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.prior = self.root / 'prior'; self.prior.mkdir()
        self.launch = self.root / 'continuation'
        # Pin declarations come from the authoritative renderer; the fixture
        # never runs a generated launch or uses an installed package.
        names = set(re.findall(r"'\$(\w+) = ", (HERE / 'generate.py').read_text(encoding='utf-8'))) - {'Staged', 'Leftovers', 'R5c'}
        values = {name: "'fixture'" for name in names}
        values.update(DraftOnly='$false', SourceSha="'" + 'a' * 40 + "'", PackageHead="'" + 'b' * 40 + "'",
                      W=RESUME.q(str(self.root)), LaunchOutPin=RESUME.q(str(self.prior)),
                      InstalledReceiptSha256="'" + 'd' * 64 + "'", InstalledUninstallSha256="'" + 'e' * 64 + "'")
        self.block = '\n'.join('$' + name + ' = ' + value for name, value in sorted(values.items()))
        self.block += '\n$Staged = [ordered]@{\n'
        self.block += ''.join("  '" + name + "' = @('fixture/" + name + "', '" + 'f' * 64 + "')\n"
                              for name in ['install-resident.ps1', 'verify-resident.ps1', 'migrate-acl.ps1', 'acl-model.json'])
        self.block += '}\n$Leftovers = [ordered]@{\n}\n$R5c = @{ applyPlanSha256 = $null; factsStaged = $null }   # r5c: set by Test-TokenPlan / Get-VerifyFactsArgs'
        self.raw = (HERE / 'template.ps1').read_text(encoding='utf-8').replace('#PINS#', self.block).encode()
        reports = {'terminal.json': fixture(), 'uninstall-preflight-report.json': {'codes': [], 'installedReceiptSha256': 'd' * 64,
                   'installedUninstallSha256': 'e' * 64}, 'migrate-acl.dry-run.before-uninstall.stdout.json':
                   {'status': 'SOURCE_V2_ACL_PLAN_ONLY_NOTHING_WRITTEN'}, 'parent-acl-report.json': {'now': 'fixture', 'error': None},
                   'quiesce-report.json': {'residentStopped': True, 'brokerStopped': True, 'noProcessUnderRoot': True}}
        for name, report in reports.items():
            (self.prior / name).write_text(json.dumps(report), encoding='utf-8')

    def build(self, raw=None):
        raw = self.raw if raw is None else raw
        return RESUME.build(raw, sha(raw), self.prior, self.launch)

    def test_only_entry_sequence_and_output_pins_change(self):
        data, evidence, pins = self.build()
        text = data.decode()
        self.assertIn(RESUME.NEW_STEPS, text)
        self.assertNotIn(RESUME.OLD_STEPS, text)
        self.assertEqual(set(pins), set(RESUME.FILES))
        for name, digest in pins.items():
            self.assertEqual(digest, sha((self.prior / name).read_bytes()))
        self.assertEqual(evidence['sourceSha'], 'a' * 40)
        self.assertEqual(evidence['packageHead'], 'b' * 40)
        # Every original generic function and the install/verify tail survives.
        generic = self.raw.decode().split('#region generic\n', 1)[1].split('#endregion generic', 1)[0]
        self.assertIn(generic, text)
        self.assertFalse(self.launch.exists(), 'generation performs no host action or launch')

    def test_body_change_cannot_be_accepted_by_supplying_its_new_digest(self):
        changed = self.raw.replace(b'Step-Verify $install.receiptSha256', b'Step-Verify 0')
        self.assertNotEqual(changed, self.raw)
        with self.assertRaisesRegex(ValueError, 'ORIGINAL_NOT_THIS_EXACT_TEMPLATE'):
            self.build(changed)

    def test_pins_cannot_contain_commands_duplicates_or_unknown_variables(self):
        for block in [self.block + '\n$W = (Get-Content secret)', self.block + "\n$SourceSha = 'x'",
                      self.block + "\n$Unknown = 'x'"]:
            changed = self.raw.decode().replace(self.block, block).encode()
            with self.subTest(block=block[-45:]), self.assertRaisesRegex(ValueError, 'ORIGINAL_PINS_NOT_LITERAL'):
                self.build(changed)

    def test_draft_or_other_original_launch_directory_refused(self):
        for old, new, code in [(b'$DraftOnly = $false', b'$DraftOnly = $true', 'DRAFT_CANNOT_RESUME'),
                              (RESUME.q(str(self.prior)).encode(), b"'C:\\other'", 'PRIOR_DIRECTORY_NOT_THE_ORIGINAL_LAUNCH')]:
            with self.subTest(code=code), self.assertRaisesRegex(ValueError, code):
                self.build(self.raw.replace(old, new))

    def test_bad_prior_preflight_or_existing_output_refused(self):
        path = self.prior / 'uninstall-preflight-report.json'
        before = path.read_bytes()
        report = json.loads(before); report['codes'] = ['OPEN_BATCH']
        path.write_text(json.dumps(report), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'PRIOR_PREFLIGHT_NOT_THE_ORIGINAL_PINS'):
            self.build()
        path.write_bytes(before); self.launch.mkdir()
        with self.assertRaisesRegex(ValueError, 'RESUME_OUTPUT_MUST_BE_NEW'):
            self.build()

    def test_output_must_stay_inside_original_work_directory(self):
        with self.assertRaisesRegex(ValueError, 'RESUME_OUTPUT_OUTSIDE_WORKDIR'):
            RESUME.output_path(self.root.parent / 'outside-resume.ps1', self.root)

    def test_cli_creates_pinned_review_files_without_launching_or_overwriting(self):
        original = self.root / 'original.ps1'; original.write_bytes(self.raw)
        output = self.root / 'resume.ps1'
        argv = [sys.executable, '-I', str(HERE / 'resume.py'), '--launcher', str(original),
                '--launcher-sha', sha(self.raw), '--prior-dir', str(self.prior), '--launch-dir', str(self.launch), '--out', str(output)]
        result = subprocess.run(argv, capture_output=True, text=True, encoding='utf-8', timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        metadata = json.loads(result.stdout)
        self.assertEqual(metadata['status'], 'CONTINUATION_FOR_REVIEW_NOT_EXECUTED')
        self.assertEqual(metadata['sha256'], sha(output.read_bytes()))
        self.assertEqual(metadata['originalLauncherSha256'], sha(self.raw))
        command = Path(metadata['elevatedCommand']).read_bytes()
        self.assertEqual(metadata['elevatedCommandSha256'], sha(command))
        self.assertIn(metadata['sha256'].encode(), command)
        self.assertEqual(original.read_bytes(), self.raw)
        self.assertFalse(self.launch.exists())
        parser = self.root / 'parse.ps1'
        parser.write_text('param([string]$File)\n$tokens=$null; $errors=$null; '
                          '$null=[System.Management.Automation.Language.Parser]::ParseFile($File,[ref]$tokens,[ref]$errors); '
                          'if ($errors.Count) { $errors | ForEach-Object {$_.Message}; exit 1 }', encoding='utf-8')
        parsed = subprocess.run([str(PS), '-NoProfile', '-NonInteractive', '-File', str(parser), str(output)],
                                capture_output=True, text=True, encoding='utf-8', timeout=10)
        self.assertEqual(parsed.returncode, 0, parsed.stdout + parsed.stderr)
        repeated = subprocess.run(argv, capture_output=True, text=True, encoding='utf-8', timeout=10)
        self.assertNotEqual(repeated.returncode, 0)
        self.assertEqual(metadata['sha256'], sha(output.read_bytes()))


@unittest.skipUnless(PS.is_file(), 'Windows PowerShell 5.1 required')
class RenameFixture(unittest.TestCase):
    def test_query_errors_and_changed_facts_stop_before_rename(self):
        with tempfile.TemporaryDirectory(prefix='clued-resume-guards-') as directory:
            script = Path(directory) / 'guards.ps1'
            script.write_text(r'''
param([string]$Library)
$ErrorActionPreference = 'Stop'
. $Library
function Get-FileSha([string]$Path) {
  if ($script:Mode -eq 'facts-read-error') { throw 'FIXTURE_READ_UNAVAILABLE' }
  if ($script:Mode -eq 'facts-changed') { return ('b' * 64) }
  'a' * 64
}
function Get-ScheduledTask {
  [CmdletBinding()]param()
  $script:Queries++
  if ($script:Mode -eq 'task-error') { Write-Error 'fixture provider denied'; return }
  if ($script:Mode -eq 'task-present') { [pscustomobject]@{TaskPath='\Clued\';TaskName='CluedCIResidentCompanion'}; return }
  [pscustomobject]@{TaskPath='\Other\';TaskName='Unrelated'}
}
function Get-NetFirewallRule {
  [CmdletBinding()]param()
  $script:Queries++
  if ($script:Mode -eq 'firewall-error') { Write-Error 'fixture provider unavailable'; return }
  if ($script:Mode -eq 'firewall-present') { [pscustomobject]@{Name='CluedCIResident-BlockOutbound'}; return }
  [pscustomobject]@{Name='Unrelated'}
}
function Complete-PartialUninstallRename { $script:Renames++ }
$LinuxVersionFactsSource='fixture-public-facts'; $LinuxVersionFactsSha256='a' * 64
$results=@()
foreach ($case in @('task-error','firewall-error','task-present','firewall-present','facts-changed','facts-read-error','clear')) {
  $script:Mode=$case; $script:Queries=0; $script:Renames=0; $code=$null
  try { Assert-ResumeCurrentFactsAndRemovedConfig; Complete-PartialUninstallRename } catch { $code=$_.Exception.Message }
  if ($case -eq 'clear') {
    if ($code -or $script:Renames -ne 1 -or $script:Queries -ne 2) { throw 'CLEAR_NOT_PROVEN' }
  } else {
    if (-not $code -or $script:Renames -ne 0) { throw 'REFUSAL_DID_NOT_PRECEDE_RENAME' }
    if ($case -like 'facts-*' -and $script:Queries -ne 0) { throw 'FACTS_NOT_CHECKED_FIRST' }
  }
  $results += [ordered]@{case=$case;code=$code;renames=$script:Renames;queries=$script:Queries}
}
$results | ConvertTo-Json -Compress
''', encoding='utf-8')
            result = subprocess.run([str(PS), '-NoProfile', '-NonInteractive', '-File', str(script),
                                     str(HERE / 'finish-uninstall.ps1')], capture_output=True,
                                    text=True, encoding='utf-8', timeout=15)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            cases = {row['case']: row for row in json.loads(result.stdout)}
            self.assertEqual(cases['task-error']['code'], 'RESUME_TASK_QUERY_UNAVAILABLE')
            self.assertEqual(cases['firewall-error']['code'], 'RESUME_FIREWALL_QUERY_UNAVAILABLE')
            self.assertEqual(cases['facts-changed']['code'], 'RESUME_LINUX_VERSION_FACTS_CHANGED_BEFORE_RENAME')
            body = (HERE / 'finish-uninstall.ps1').read_text(encoding='utf-8').split('function Step-FinishUninstall {', 1)[1]
            self.assertLess(body.index('Assert-ResumeCurrentFactsAndRemovedConfig'), body.index('$receipt = Complete-PartialUninstallRename'))

    def test_finish_only_renames_once_and_retains_all_existing_bytes(self):
        with tempfile.TemporaryDirectory(prefix='clued-finish-') as directory:
            parent = Path(directory); root = parent / 'resident'; (root / 'install').mkdir(parents=True)
            (root / 'state').mkdir(); evidence = b'original evidence stays byte-for-byte'
            (root / 'state' / 'retained.json').write_bytes(evidence)
            target = parent / 'resident-uninstalled-20261102T000000Z-0123456789ab'
            script = parent / 'probe.ps1'
            script.write_text(r'''
param([string]$Library, [string]$Root, [string]$Target)
$ErrorActionPreference = 'Stop'
. $Library
$receipt = Complete-PartialUninstallRename $Root $Target ('a' * 64) ('b' * 64)
$refused = $false
try { $null = Complete-PartialUninstallRename $Root $Target ('a' * 64) ('b' * 64) } catch { $refused = $true }
if (-not $refused) { throw 'REPEATED_RENAME_NOT_REFUSED' }
$receipt | ConvertTo-Json -Depth 6 -Compress
''', encoding='utf-8')
            result = subprocess.run([str(PS), '-NoProfile', '-NonInteractive', '-File', str(script),
                                     str(HERE / 'finish-uninstall.ps1'), str(root), str(target)], capture_output=True,
                                    text=True, encoding='utf-8', timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            receipt = json.loads(result.stdout)
            self.assertEqual(receipt['planSha256'], 'a' * 64)
            self.assertEqual(receipt['continuation']['priorTerminalSha256'], 'b' * 64)
            self.assertEqual(receipt['keptAt'], str(target))
            self.assertFalse(root.exists())
            self.assertEqual((target / 'state' / 'retained.json').read_bytes(), evidence)
            self.assertEqual(json.loads((target / 'install' / 'uninstall-receipt.json').read_bytes()), receipt)


    def test_a_cut_off_launch_receipt_names_the_dry_run_it_was_proven_by(self):
        with tempfile.TemporaryDirectory(prefix='clued-finish-cut-') as directory:
            parent = Path(directory); root = parent / 'resident'; (root / 'install').mkdir(parents=True)
            target = parent / 'resident-uninstalled-20261102T000000Z-0123456789ab'
            script = parent / 'probe.ps1'
            script.write_text(r'''
param([string]$Library, [string]$Root, [string]$Target)
$ErrorActionPreference = 'Stop'
. $Library
Complete-PartialUninstallRename $Root $Target ('a' * 64) ('d' * 64) 'priorDryRunSha256' | ConvertTo-Json -Depth 6 -Compress
''', encoding='utf-8')
            result = subprocess.run([str(PS), '-NoProfile', '-NonInteractive', '-File', str(script), str(HERE / 'finish-uninstall.ps1'), str(root), str(target)],
                                    capture_output=True, text=True, encoding='utf-8', timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)['continuation'], {'contract': 'clued.independent-ci.resume-uninstall-evidence/1', 'priorDryRunSha256': 'd' * 64})
        body = (HERE / 'finish-uninstall.ps1').read_text(encoding='utf-8')
        self.assertIn("if ($prior.Contains('terminal.json')) {", body)   # resume.py's own launches: the terminal, exactly as before

if __name__ == '__main__':
    unittest.main()
