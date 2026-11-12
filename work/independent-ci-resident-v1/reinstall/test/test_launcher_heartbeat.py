"""Offline tests of the launcher template's heartbeat token handling (DESIGN section 41.6a): the installer arguments and the elevated
with-token plan check (Test-TokenPlan), run in Windows PowerShell 5.1 on the template's own function texts with a fake child process.
Nothing is installed or elevated; no host state is read.
  python -I -m unittest discover -s test -p "test_*.py"     (from reinstall/)
"""
import copy, json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
RE = os.path.dirname(HERE)
TEMPLATE = os.path.join(RE, 'launcher', 'template.ps1')
POWERSHELL = os.path.join(os.environ.get('SystemRoot', 'C:\\Windows'), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
BS = chr(92)
UT = BS.join(['C:', 'ProgramData', 'CluedIndependentCI', 'resident', 'secrets', 'resident-upgrade.token'])
HD = BS.join(['C:', 'ProgramData', 'CluedIndependentCI', 'resident', 'secrets', 'heartbeat'])
HT = HD + BS + 'ci-node-heartbeat.token'
BID = '3b0c8a7e-1111-4222-8333-444455556666'

DRIVER = r"""
param([string]$Template, [string]$Case)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$null = [Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$Js = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$t = [IO.File]::ReadAllText($Template)
foreach ($n in @('Get-Key', 'Parse-Json', 'Tail', 'Get-InstallArgs', 'Get-PlanWithoutTokenFields', 'Test-HeartbeatPlan', 'Test-TokenPlan')) {
  $m = [regex]::Match($t, '(?ms)^function ' + [regex]::Escape($n) + '\b.*?^\}')
  if (-not $m.Success) { throw ('TEMPLATE_FUNCTION_MISSING:' + $n) }
  . ([scriptblock]::Create($m.Value))
}
$c = $Js.DeserializeObject([IO.File]::ReadAllText($Case))
$PackageRoot = 'C:\p'; $PackageManifestSha256 = ('1' * 64); $OwnerSid = 'S-1-5-21-1-2-3-1001'; $ControllerSid = 'S-1-5-21-1-2-3-1015'; $OperatorSid = $OwnerSid
$UpgradeTokenFile = 'C:\t\resident-upgrade.token'; $UpgradeTokenTarget = $c['upgradeTarget']; $SecretWorkParent = 'C:\w'; $SecretWorkSddl = 'O:BAG:BAD:P(A;;FA;;;SY)'
$HeartbeatTokenFile = $c['hbFile']; $HeartbeatTokenTarget = $c['hbTarget']; $HeartbeatBindingId = $c['hbBinding']
$Stage = 'C:\s'; $R5c = @{ applyPlanSha256 = $null; factsStaged = $null }; $FleetPlanSha256 = $null   # every launcher pins it (null: not a package run)
$script:ChildArgs = $null
function Stop-Launch($code, $detail) { throw $code }
function Write-Json($name, $obj) { }
function Invoke-Child($name, $file, $argList) { $script:ChildArgs = $argList; [pscustomobject]@{ exit = 0; stdout = $c['withToken']; stderr = '' } }
$r = Test-TokenPlan $c['noToken']
$apply = if ($R5c.applyPlanSha256) { @(Get-InstallArgs -Apply) } else { @() }
[ordered]@{ codes = @($r.codes); applyPlanSha256 = $R5c.applyPlanSha256; withTokenArgs = @($script:ChildArgs); applyArgs = $apply
  noTokenArgs = @(Get-InstallArgs -NoToken); carryArgs = @(Get-InstallArgs -NoHeartbeat) } | ConvertTo-Json -Compress -Depth 4
"""


def plans(hb_supplied, binding=None, hb_target=HT, with_hb=True):
    up = {'target': UT, 'supplied': False, 'targetExists': False, 'sddl': 'O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)', 'fingerprint': None, 'verified': False}
    hb = {'target': HT, 'supplied': False, 'targetExists': False, 'directory': HD, 'directorySddl': 'DS', 'sddl': 'FS', 'fingerprint': None, 'verified': False, 'bindingId': None}
    plan = {'contract': 'clued.independent-ci.resident-install-plan/8', 'secretsFingerprintDirectory': None, 'upgrader': {'service': 'CluedCIUpgrader', 'token': up}}
    if with_hb:
        plan['heartbeatToken'] = hb
    no = {'status': 'DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN', 'planSha256': 'a' * 64, 'plan': plan}
    w = copy.deepcopy(no)
    w['planSha256'] = 'b' * 64
    w['plan']['secretsFingerprintDirectory'] = {'parent': 'C:\\w', 'sddl': 'O:BAG:BAD:P(A;;FA;;;SY)', 'removedAfterwards': True}
    w['plan']['upgrader']['token'].update({'supplied': True, 'fingerprint': 'c' * 64, 'verified': True})
    if with_hb and hb_supplied:
        w['plan']['heartbeatToken'].update({'target': hb_target, 'supplied': True, 'fingerprint': 'd' * 64, 'verified': True, 'bindingId': binding})
    return json.dumps(no), json.dumps(w)


@unittest.skipUnless(os.path.isfile(POWERSHELL), 'Windows PowerShell 5.1 required')
class LauncherHeartbeat(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.d = self.tmp.name
        self.driver = os.path.join(self.d, 'driver.ps1')
        with open(self.driver, 'w', encoding='utf-8', newline='\n') as f:
            f.write(DRIVER)

    def tearDown(self):
        self.tmp.cleanup()

    def run_case(self, no, w, hb_file=None, hb_binding=None):
        case = os.path.join(self.d, 'case-%d.json' % len(os.listdir(self.d)))
        with open(case, 'w', encoding='utf-8', newline='\n') as f:
            json.dump({'upgradeTarget': UT, 'hbFile': hb_file, 'hbTarget': HT if hb_file else None, 'hbBinding': hb_binding, 'noToken': no, 'withToken': w}, f)
        p = subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', self.driver, TEMPLATE, case], capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        r = json.loads(p.stdout)
        r['codes'] = r['codes'] or []
        return r

    def test_no_heartbeat_configured_is_as_before(self):
        r = self.run_case(*plans(False))
        self.assertEqual((r['codes'], r['applyPlanSha256']), ([], 'b' * 64))
        self.assertNotIn('-HeartbeatTokenFile', r['withTokenArgs'] + r['applyArgs'])
        self.assertEqual(r['withTokenArgs'][-2:], ['-UpgradeTokenFile', 'C:\\t\\resident-upgrade.token'])
        r = self.run_case(*plans(False, with_hb=False))   # an older installer without the heartbeat entry
        self.assertEqual(r['codes'], [])
        # the plan gains a heartbeat token although none is configured: refused like any other difference
        self.assertEqual(self.run_case(*plans(True))['codes'], ['TOKEN_PLAN_DIFFERS_BEYOND_TOKEN_FIELDS'])

    def test_configured_token_and_binding_id_are_passed_and_expected(self):
        r = self.run_case(*plans(True, BID), hb_file='C:\\t\\ci-node-heartbeat.token', hb_binding=BID)
        self.assertEqual((r['codes'], r['applyPlanSha256']), ([], 'b' * 64))
        tail = ['-UpgradeTokenFile', 'C:\\t\\resident-upgrade.token', '-HeartbeatTokenFile', 'C:\\t\\ci-node-heartbeat.token', '-HeartbeatBindingId', BID]
        self.assertEqual(r['withTokenArgs'][-6:], tail)
        self.assertEqual(r['applyArgs'][-6:], tail)
        self.assertIn('-Apply', r['applyArgs'])
        for k in ('noTokenArgs', 'carryArgs'):   # the reviewed plan and the carry-forward preview before the uninstall: no heartbeat
            self.assertNotIn('-HeartbeatTokenFile', r[k], k)

    def test_after_uninstall_projection_is_only_used_by_readonly_carry_preview(self):
        r = self.run_case(*plans(True, BID), hb_file='C:\\t\\ci-node-heartbeat.token', hb_binding=BID)
        self.assertIn('-PreviewAfterUninstall', r['carryArgs'])
        for key in ('withTokenArgs', 'noTokenArgs', 'applyArgs'):
            self.assertNotIn('-PreviewAfterUninstall', r[key], key)
        with open(TEMPLATE, encoding='utf-8') as f:
            text = f.read()
        self.assertIn('(Get-InstallArgs -NoHeartbeat)', text)

    def test_configured_token_without_binding_id(self):
        r = self.run_case(*plans(True), hb_file='C:\\t\\ci-node-heartbeat.token')
        self.assertEqual(r['codes'], [])
        self.assertEqual(r['withTokenArgs'][-2:], ['-HeartbeatTokenFile', 'C:\\t\\ci-node-heartbeat.token'])
        self.assertNotIn('-HeartbeatBindingId', r['withTokenArgs'])

    def test_heartbeat_plan_not_exactly_what_is_configured(self):
        f = 'C:\\t\\ci-node-heartbeat.token'
        for w_plans, binding in ((plans(True, None), BID), (plans(True, BID), None), (plans(True, '0' * 8 + BID[8:]), BID), (plans(True, BID, hb_target=HT + 'x'), BID),
                                 (plans(False), BID)):
            r = self.run_case(*w_plans, hb_file=f, hb_binding=binding)
            self.assertEqual((r['codes'], r['applyPlanSha256']), (['HEARTBEAT_TOKEN_PLAN_FIELDS_NOT_AS_EXPECTED'], None))
        r = self.run_case(*plans(True, BID, with_hb=False), hb_file=f, hb_binding=BID)   # an installer without heartbeat support
        self.assertEqual(r['codes'], ['TOKEN_PLAN_CHECK_FAILED:PLAN_HAS_NO_HEARTBEAT_TOKEN'])
        self.assertIsNone(r['applyPlanSha256'])


INSTALLER = os.path.join(RE, '..', 'windows', 'install-resident.ps1')
PREVIEW_DRIVER = r"""
param([string]$Installer, [string]$Case)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$c = Get-Content -LiteralPath $Case -Raw | ConvertFrom-Json
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Installer,[ref]$tokens,[ref]$errors)
foreach($name in @('Get-HeartbeatDirectorySddl','Get-HeartbeatFileSddl','Get-HeartbeatTokenPlan')) {
  $f=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$true) | Where-Object { $_.Name -ceq $name })
  if($f.Count -ne 1) {throw 'INSTALLER_FUNCTION_REQUIRED'}
  . ([scriptblock]::Create($f[0].Extent.Text))
}
$OwnerSid='S-1-5-21-1-2-3-1008'; $oldOwner='S-1-5-21-1-2-3-1000'
$HeartbeatTokenDirectory='C:\fixture\resident\secrets\heartbeat'; $HeartbeatTokenTarget=$HeartbeatTokenDirectory+'\ci-node-heartbeat.token'
$HeartbeatTokenFile=''; $HeartbeatBindingId=''; $script:SecretBytes=@{}; $script:AclCalls=0
function Test-Path {param([string]$LiteralPath) @($HeartbeatTokenDirectory,$HeartbeatTokenTarget) -ccontains $LiteralPath}
function Test-HeartbeatDirectoryAcl {param([string]$path,[string]$sddl) $script:AclCalls++; $sddl -ceq (Get-HeartbeatDirectorySddl $oldOwner)}
function Clear-SecretBytes { $script:SecretBytes.Clear() }
$errorCode=$null; $plan=$null
try {
  if($c.preview) {$plan=Get-HeartbeatTokenPlan -PreviewAfterUninstall}
  else {$plan=Get-HeartbeatTokenPlan}
} catch {$errorCode=$_.Exception.Message}
[ordered]@{errorCode=$errorCode; plan=$plan; aclCalls=$script:AclCalls; secrets=$script:SecretBytes.Count} | ConvertTo-Json -Depth 5 -Compress
"""


@unittest.skipUnless(os.path.isfile(POWERSHELL), 'Windows PowerShell 5.1 required')
class InstallerHeartbeatPreview(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='m5b-heartbeat-')
        self.addCleanup(self.tmp.cleanup)
        self.driver = os.path.join(self.tmp.name, 'preview.ps1')
        with open(self.driver, 'w', encoding='utf-8', newline='\n') as f:
            f.write(PREVIEW_DRIVER)

    def run_preview(self, preview):
        case = os.path.join(self.tmp.name, 'case.json')
        with open(case, 'w', encoding='utf-8', newline='\n') as f:
            json.dump({'preview': preview}, f)
        p = subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', self.driver, INSTALLER, case], capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        return json.loads(p.stdout)

    def test_changed_owner_previews_recreated_heartbeat_without_reading_old_acl(self):
        r = self.run_preview(True)
        self.assertIsNone(r['errorCode'])
        self.assertFalse(r['plan']['targetExists'])
        self.assertFalse(r['plan']['supplied'])
        self.assertEqual(r['aclCalls'], 0)
        self.assertIn('1008', r['plan']['directorySddl'])
        self.assertEqual(r['secrets'], 0)

    def test_ordinary_install_still_refuses_existing_previous_owner_acl(self):
        r = self.run_preview(False)
        self.assertEqual(r['errorCode'], 'HEARTBEAT_TOKEN_DIRECTORY_ACL_MISMATCH')
        self.assertEqual(r['aclCalls'], 1)
        self.assertIsNone(r['plan'])

    def test_future_preview_rejects_apply_and_heartbeat_inputs_before_host_reads(self):
        for extra in (['-Apply'], ['-HeartbeatTokenFile', os.path.join(self.tmp.name, 'unused.token')], ['-HeartbeatBindingId', BID]):
            with self.subTest(extra=extra):
                before = sorted(os.listdir(self.tmp.name))
                p = subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', INSTALLER,
                    '-PackageRoot', self.tmp.name, '-ExpectedPackageManifestSha256', '1' * 64,
                    '-OwnerSid', 'S-1-5-21-1-2-3-1008', '-ControllerSid', 'S-1-5-21-1-2-3-1015',
                    '-PreviewAfterUninstall', *extra], capture_output=True, text=True)
                self.assertNotEqual(p.returncode, 0)
                self.assertIn('AFTER_UNINSTALL_PREVIEW_READ_ONLY_WITHOUT_HEARTBEAT_INPUT', p.stderr)
                self.assertEqual(sorted(os.listdir(self.tmp.name)), before)
                self.assertNotIn('clued_hbt_', p.stdout)


if __name__ == '__main__':
    unittest.main()
