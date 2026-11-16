"""Run the actual template function with a fake SC command; no host/service access."""
import json
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
POWERSHELL = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
DRIVER = r'''
param([string]$Template, [string]$Case)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$FleetFirstInstall = $null; $FleetFirstInstallDirectory = $null   # a reinstall launcher's pins (generate.py)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$c = Get-Content -LiteralPath $Case -Raw -Encoding UTF8 | ConvertFrom-Json
$t = [IO.File]::ReadAllText($Template)
$m = [regex]::Match($t, '(?ms)^function Get-ScState\b.*?^\}')
if (-not $m.Success) { throw 'TEMPLATE_FUNCTION_MISSING' }
. ([scriptblock]::Create($m.Value))
function FakeSc { $global:LASTEXITCODE = $c.exit; $c.text }
$Sc = 'FakeSc'
Get-ScState 'FixtureService' | ConvertTo-Json -Compress
'''
# Wait-RunnerState with the template's own Get-RunnerState: a fake sc.exe that answers as the node's did while the paused resident's
# maintenance swap was under way (the controller binary, RUNNING) for the first `swapped` readings and as reviewed afterwards.
RUNNER_DRIVER = r'''
param([string]$Template, [string]$Case)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$FleetFirstInstall = $null; $FleetFirstInstallDirectory = $null   # a reinstall launcher's pins (generate.py)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$c = Get-Content -LiteralPath $Case -Raw -Encoding UTF8 | ConvertFrom-Json
$errors = $null; $tokens = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Template, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'PARSE_FAILED' }
foreach ($name in @('Get-DaclPart', 'Get-RunnerState', 'Wait-RunnerState')) {
  $nodes = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name }, $false))
  if ($nodes.Count -ne 1) { throw 'FUNCTION_MISSING_OR_DUPLICATED' }
  . ([scriptblock]::Create($nodes[0].Extent.Text))
}
$RunnerService = 'actions.runner.fixture'; $RunnerBinary = '"C:\actions-runner\bin\RunnerService.exe"'; $NodeHostname = 'FIXTURE'
$RunnerSddl = 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)'
$script:readings = 0
function FakeSc([string]$verb) {
  if ($verb -ceq 'qc') { $script:readings++ }
  $swapped = $script:readings -le $c.swapped
  if ($verb -ceq 'sdshow') { return 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)S:(AU;FA;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;WD)' }
  $binary = $(if ($swapped) { '"C:\ProgramData\CluedIndependentCI\resident\helpers\controller-formal-generic-v2.exe" --acceptance-sha256 31ca' } else { $RunnerBinary })
  if ($verb -ceq 'qc') { return "SERVICE_NAME: x`r`n        START_TYPE         : 3   DEMAND_START`r`n        BINARY_PATH_NAME   : $binary`r`n        SERVICE_START_NAME : .\clued-control`r`n" }
  if ($swapped) { "        STATE              : 4  RUNNING `r`n        PID                : 36964`r`n" } else { "        STATE              : 1  STOPPED `r`n        PID                : 0`r`n" }
}
$Sc = 'FakeSc'
$RunnerSettleSeconds = $c.seconds
function Start-Sleep { }
$first = Get-RunnerState; $script:readings = 0
$s = Wait-RunnerState
[ordered]@{ first = $first.ok; firstFlags = $first.flags; ok = $s.ok; readings = $script:readings } | ConvertTo-Json -Compress -Depth 4
'''
EVIDENCE_DRIVER = r'''
param([string]$Template, [string]$Case)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$FleetFirstInstall = $null; $FleetFirstInstallDirectory = $null   # a reinstall launcher's pins (generate.py)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$c = Get-Content -LiteralPath $Case -Raw -Encoding UTF8 | ConvertFrom-Json
$errors = $null; $tokens = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Template, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'PARSE_FAILED' }
foreach ($name in @('Sha256Bytes', 'Get-FileSha', 'Test-TerminalEvidence')) {
  $nodes = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name }, $false))
  if ($nodes.Count -ne 1) { throw 'FUNCTION_MISSING_OR_DUPLICATED' }
  . ([scriptblock]::Create($nodes[0].Extent.Text))
}
$LedgerEvidenceRelativeDirectory = $c.relative
$HaltedBatchKey = $c.key
$TerminalEvidenceSha256 = $c.terminalSha
$BackfillEvidenceManifestSha256 = $c.manifestSha
$InstalledReceiptSha256 = $c.receiptSha
[ordered]@{ accepted = (Test-TerminalEvidence $c.root) } | ConvertTo-Json -Compress
'''


@unittest.skipUnless(POWERSHELL.is_file(), 'Windows PowerShell 5.1 required')
class LauncherServiceState(unittest.TestCase):
    def check(self, exit_code, text):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'driver.ps1').write_text(DRIVER, encoding='utf-8')
            (root / 'case.json').write_text(json.dumps({'exit': exit_code, 'text': text}), encoding='utf-8')
            result = subprocess.run([str(POWERSHELL), '-NoProfile', '-NonInteractive', '-File', str(root / 'driver.ps1'),
                                     str(ROOT / 'launcher/template.ps1'), str(root / 'case.json')],
                                    capture_output=True, text=True, encoding='utf-8', timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)

    def runner(self, swapped, seconds):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'driver.ps1').write_text(RUNNER_DRIVER, encoding='utf-8')
            (root / 'case.json').write_text(json.dumps({'swapped': swapped, 'seconds': seconds}), encoding='utf-8')
            result = subprocess.run([str(POWERSHELL), '-NoProfile', '-NonInteractive', '-File', str(root / 'driver.ps1'),
                                     str(ROOT / 'launcher/template.ps1'), str(root / 'case.json')],
                                    capture_output=True, text=True, encoding='utf-8', timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)

    def test_a_runner_the_paused_resident_swapped_for_its_maintenance_is_waited_for_not_refused(self):
        # desk-w-591, 2026-11-13 (DESIGN section 73): the reading that stopped the launch after Linux B, originalBinary and stoppedPid0
        # false and nothing else; the swap ends by itself. The preflights judge the reading after it, within a bounded time.
        r = self.runner(swapped=3, seconds=600)
        self.assertEqual((r['first'], r['firstFlags']), (False, {'originalBinary': False, 'manual': True, 'controller': True, 'stoppedPid0': False, 'sddl': True}))
        self.assertEqual((r['ok'], r['readings']), (True, 4))
        self.assertEqual(self.runner(swapped=0, seconds=600), dict(r, first=True, firstFlags=dict(r['firstFlags'], originalBinary=True, stoppedPid0=True), readings=1))   # as reviewed: one reading, no wait
        self.assertEqual((self.runner(swapped=10 ** 6, seconds=0)['ok']), False)   # a runner that stays changed is still refused once the time is up
        template = (ROOT / 'launcher/template.ps1').read_text(encoding='utf-8')
        for step in ('Step-WindowsPreflightBeforeLinux', 'Step-UninstallPreflight'):
            body = template.split('function ' + step + ' {', 1)[1].split('\nfunction ', 1)[0]
            self.assertIn("$runner = Wait-RunnerState; $report['runner'] = $runner\n  if (-not $runner.ok) { $codes.Add('RUNNER_SERVICE_NOT_AS_REVIEWED') }", body, step)
            self.assertNotIn('$runner = Get-RunnerState', body, step)
        self.assertRegex(template, r'(?m)^\$RunnerSettleSeconds = [0-9]+ ')

    def test_missing_service_uses_numeric_exit_in_any_language(self):
        for text in ('[SC] OpenService FAILED 1060: service does not exist',
                     '[SC] OpenService 失败 1060：指定的服务未安装。', ''):
            with self.subTest(text=text):
                result = self.check(1060, text)
                self.assertTrue(result['gone'])
                self.assertEqual(result['nativeExit'], 1060)
                self.assertIsNone(result['state'])
                self.assertIsNone(result['pid'])

    def test_other_errors_cannot_be_confused_with_service_absence(self):
        for code in (5, 1, 9009):
            with self.subTest(code=code):
                result = self.check(code, 'FAILED 1060\nSTATE : 1\nPID : 0')
                self.assertFalse(result['gone'])
                self.assertIsNone(result['state'])
                self.assertIsNone(result['pid'])

    def test_successful_service_query_preserves_numeric_state(self):
        result = self.check(0, 'STATE : 4 RUNNING\nPID : 1234')
        self.assertFalse(result['gone'])
        self.assertEqual(result['state'], 4)
        self.assertEqual(result['pid'], 1234)

    def test_runtime_rechecks_exact_live_and_backfill_evidence(self):
        for relative in ('state/ledger', 'state/backfill/3/ledger'):
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                key = 'a' * 64
                terminal = root / relative / key / '90-terminal.json'
                terminal.parent.mkdir(parents=True)
                terminal.write_bytes(b'{"outcome":"COMPLETED"}')
                terminal_bytes = terminal.read_bytes()
                (root / 'state/ledger').mkdir(parents=True, exist_ok=True)
                manifest = root / 'install/backfill-manifest.json'
                manifest.parent.mkdir()
                manifest.write_bytes(b'{"pinned":"manifest"}')
                manifest_bytes = manifest.read_bytes()
                receipt = root / 'install/install-receipt.json'
                receipt.write_text(json.dumps({'backfillManifestSha256': hashlib.sha256(manifest_bytes).hexdigest()}))
                case = {'root': str(root), 'relative': relative.replace('/', '\\'), 'key': key,
                        'terminalSha': hashlib.sha256(terminal.read_bytes()).hexdigest(),
                        'manifestSha': hashlib.sha256(manifest.read_bytes()).hexdigest(),
                        'receiptSha': hashlib.sha256(receipt.read_bytes()).hexdigest()}
                driver = root / 'driver.ps1'
                driver.write_text(EVIDENCE_DRIVER, encoding='utf-8')
                def run():
                    path = root / 'case.json'
                    path.write_text(json.dumps(case), encoding='utf-8')
                    result = subprocess.run([str(POWERSHELL), '-NoProfile', '-NonInteractive', '-File', str(driver),
                                             str(ROOT / 'launcher/template.ps1'), str(path)],
                                            capture_output=True, text=True, encoding='utf-8', timeout=20)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    return json.loads(result.stdout)['accepted']
                self.assertTrue(run())
                manifest.write_bytes(b'changed')
                self.assertEqual(run(), relative == 'state/ledger')
                terminal.write_bytes(b'changed')
                self.assertFalse(run())
                case['relative'] = 'state\\..\\ledger'
                self.assertFalse(run())
                if 'backfill' in relative:
                    case['relative'] = relative.replace('/', '\\')
                    terminal.write_bytes(terminal_bytes)
                    manifest.write_bytes(manifest_bytes)
                    self.assertTrue(run())
                    completed = root / 'state/ledger' / ('b' * 64)
                    completed.mkdir()
                    (completed / '90-terminal.json').write_bytes(b'{"outcome":"COMPLETED"}')
                    self.assertFalse(run())
                    (completed / '90-terminal.json').unlink()
                    completed.rmdir()
                    (root / 'state/ledger/unexpected-file').write_bytes(b'not empty')
                    self.assertFalse(run())


if __name__ == '__main__':
    unittest.main()
