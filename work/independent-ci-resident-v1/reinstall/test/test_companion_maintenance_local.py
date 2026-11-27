"""Exercise actual local-state JSON/native reads using isolated fixtures only."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import shutil
import tempfile
import unittest

BASE = Path(__file__).resolve().parents[2]
PS = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
DRIVER = r'''
param([string]$Helper,[string]$Root,[string]$Paused)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$ErrorActionPreference='Stop';Set-StrictMode -Version 2
. $Helper
# Only transports beyond the fixture root are replaced. The actual local
# state reader, journal checks and Native read/final-path guards run unchanged.
function Assert-CompanionMaintenanceSource { return @{} }
function Get-CompanionMaintenanceService {return @{state='Stopped';pid=0;config=@{binary='fixture-binary';sc=@('D:P(A;;FA;;;SY)')}}}
function Get-CompanionMaintenanceProcesses {return ,@()}
function Get-CompanionMaintenanceFallback {return @{present=$false}}
try {
  $s=@{runnerService='FixtureRunner';runnerBinary='fixture-binary';runnerSddl='D:P(A;;FA;;;SY)'}
  $null=Get-CompanionMaintenanceLocal $Root $s $Paused
  @{accepted=$true}|ConvertTo-Json -Compress
} catch { @{accepted=$false;code=$_.Exception.Message}|ConvertTo-Json -Compress }
'''
LAUNCHER_DRIVER = r'''
param([string]$Template,[string]$Root,[string]$Case)
$ErrorActionPreference='Stop';Set-StrictMode -Version 2
$env:PSModulePath='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($Template,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'TEMPLATE_PARSE'}
$fn=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Step-CompanionHeadless'},$false))[0]
. ([scriptblock]::Create($fn.Extent.Text))
$ResidentRoot=$Root;$ResidentManifestSha256='a'*64;$RearmSha256='b'*64;$PackageManifestSha256='c'*64;$CiSourceManifestSha256='d'*64
$NodeName='Fixture';$OperatorSid='S-1-5-21-1-2-3-1001';$OwnerSid='S-1-5-21-1-2-3-1002';$RunnerService='Runner';$RunnerBinary='fixture';$RunnerSddl='D:P(A;;FA;;;SY)';$MaintenanceWslDistribution='CluedLinux';$StageParent=$Root
$CompanionWslVhdxDirectory='C:\Vhd';$MaintenanceHostDropPin='C:\PrivateDrop';$CompanionMaintenance=$Case -cne 'default'
$helper=Join-Path $Root ('resident\'+$ResidentManifestSha256+'\windows\companion-maintenance.ps1')
$MaintenanceHelperSha256=(Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant()
if($Case -ceq 'missing-pin'){$MaintenanceHostDropPin=$null}
if($Case -ceq 'tamper'){$MaintenanceHelperSha256='f'*64}
$Done=New-Object 'Collections.Generic.List[string]';$script:calls=@()
function Get-FileSha([string]$Path){if($Path.EndsWith('rearm-resident.ps1')){return ('b'*64)};if($Path.EndsWith('install-receipt.json')){return ('e'*64)};return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function Invoke-Child([string]$Name,[string]$File,[string[]]$argList){$script:calls+=,@{name=$Name;file=$File;arguments=$argList};return @{exit=0;stdout='{"status":"COMPANION_HEADLESS_QUALIFIED"}';stderr=''}}
function Tail($value){return $value}
function Write-Json {}
$result=Step-CompanionHeadless
@{result=$result;calls=$script:calls}|ConvertTo-Json -Depth 15 -Compress
'''
DEFER_DRIVER = r'''
param([string]$Template,[string]$Case)
$ErrorActionPreference='Stop';Set-StrictMode -Version 2
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($Template,[ref]$tokens,[ref]$errors)
$CompanionMaintenance=$Case -cne 'default';$verify=@{status='RESIDENT_VERIFIED'};$pause=@{confirmed=$Case -cne 'unpaused'};$FleetFirstInstall=$null
$script:starts=0;$script:switches=0
function Step-StartCompanion {$script:starts++;return @{started=$true}}
function Step-CompanionHeadless {$script:switches++;return @{ran=$true}}
. ([scriptblock]::Create(@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Get-Key'},$true))[0].Extent.Text))
foreach($name in @('maintenanceDeferred','companion','companionHeadless')){
  $nodes=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq ('$'+$name)},$true))
  if($nodes.Count -ne 1){throw 'ASSIGNMENT_NOT_UNIQUE'}
  . ([scriptblock]::Create($nodes[0].Extent.Text))
}
@{starts=$script:starts;switches=$script:switches;started=$companion.started;deferred=$maintenanceDeferred}|ConvertTo-Json -Compress
'''
TREE_EXE = r'''
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
class Fixture {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI {public int cb; public string r,d,t;public int x,y,xs,ys,xc,yc,f,flags;public short show,res;public IntPtr reserved,si,so,se;}
 [StructLayout(LayoutKind.Sequential)] struct PI {public IntPtr p,t;public int id,tid;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SI si,out PI pi);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 static List<Process> children=new List<Process>();
 static void Start(string exe,string cmd){SI si=new SI();si.cb=Marshal.SizeOf(si);PI pi;if(!CreateProcessW(exe,new StringBuilder(cmd),IntPtr.Zero,IntPtr.Zero,false,0x08000000,IntPtr.Zero,Path.GetDirectoryName(exe),ref si,out pi))throw new Exception("FIXTURE_START");CloseHandle(pi.t);CloseHandle(pi.p);children.Add(Process.GetProcessById(pi.id));}
 static int Main(){try{
  string root=Environment.GetEnvironmentVariable("CLUED_FIXTURE_ROOT"),baseDir=Environment.GetEnvironmentVariable("CLUED_FIXTURE_BASE"),mode=Environment.GetEnvironmentVariable("CLUED_FIXTURE_MODE");
  string client=Path.Combine(baseDir,@"machine binaries\wsl.exe"),host=Path.Combine(baseDir,@"machine binaries\wslhost.exe"),console=Path.Combine(baseDir,@"machine binaries\conhost.exe");
  string role=Path.GetFileNameWithoutExtension(Assembly.GetExecutingAssembly().Location).ToLowerInvariant();
  string consoleCmd=@"\??\C:\WINDOWS\system32\conhost.exe 0x4";
  if(mode=="console-command")consoleCmd+=" --anything";
  if(role=="cluedcompanionsupervisor"){
   string node=Path.Combine(root,@"runtime\node.exe");Start(node,"\""+node+"\"");if(mode=="console-parent")Start(console,consoleCmd);
  } else if(role=="node"){
   string cmd="\""+client+"\" --distribution CluedLinux --exec /bin/sleep infinity";
   if(mode=="keepalive-command")cmd="\""+client+"\" --distribution Other --exec /bin/sleep infinity";
   if(mode=="quoted-option")cmd="\""+client+"\" \"--distribution\" CluedLinux --exec /bin/sleep infinity";
   Start(client,cmd);if(mode!="console-parent")Start(console,consoleCmd);
   if(mode=="extra-gh") {string gh=Path.Combine(baseDir,@"machine binaries\gh.exe");Start(gh,"\""+gh+"\" --private-fixture-argument DO_NOT_LOG_THIS_FIXTURE_ARGUMENT");}
  } else if(role=="wsl"){
   string id=mode=="host-distro"?"{33333333-3333-3333-3333-333333333333}":"{11111111-1111-1111-1111-111111111111}";
   Start(host," --distro-id "+id+" --vm-id {22222222-2222-2222-2222-222222222222} --handle 760 --event 796 --parent 800");Start(console,consoleCmd);
  } else if(role=="wslhost") {Start(console,consoleCmd);if(mode=="extra-console")Start(console,consoleCmd);}
  DateTime end=DateTime.UtcNow.AddSeconds(25);while(!File.Exists(Path.Combine(baseDir,"release"))&&DateTime.UtcNow<end)Thread.Sleep(25);
  foreach(Process p in children){try{p.WaitForExit(3000);}catch{}}return 0;
 }catch{return 2;}}
}
'''
TREE_DRIVER = r'''
param([string]$Helper,[string]$Root,[string]$ClientDirectory,[string]$Mode)
$ErrorActionPreference='Stop';Set-StrictMode -Version 2
$env:PSModulePath='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
. $Helper
# Authentication is a declared fixture transport: these unsigned, harmless
# local receivers do not establish Microsoft signing or observed Session 0.
# Native file identities, actual Win32 process tree/start and raw command lines
# run unchanged. No actual WSL client, gh, account, SCM or task is invoked.
$script:fixtureClient=Join-Path $ClientDirectory 'wsl.exe';$script:fixtureHost=Join-Path $ClientDirectory 'wslhost.exe';$script:fixtureConsole=Join-Path $ClientDirectory 'conhost.exe'
$nativeRead=${function:Read-CompanionMaintenanceBytes}
function Read-CompanionMaintenanceBytes([string]$Path,[int]$Maximum=1048576,[switch]$Live,[string]$OwnerSid,[switch]$PrivateDrop,[switch]$AllowReadOnlyOthers,[switch]$MachineImage,[switch]$SystemConsoleImage){return ,(& $script:nativeRead $Path $Maximum -Live:$Live)}
function Assert-CompanionMaintenanceSource {return @{companionSupervisorSha256=(Get-CompanionMaintenanceHash (Read-CompanionMaintenanceBytes (Join-Path $Root 'bin\CluedCompanionSupervisor.exe')));upgrader=@{nodeSha256=(Get-CompanionMaintenanceHash (Read-CompanionMaintenanceBytes (Join-Path $Root 'runtime\node.exe')))}}}
function Get-CompanionMaintenanceWslClient {return @{path=$script:fixtureClient;sha256=(Get-CompanionMaintenanceHash (Read-CompanionMaintenanceBytes $script:fixtureClient));signerThumbprint=('A'*40);host=@{path=$script:fixtureHost;sha256=(Get-CompanionMaintenanceHash (Read-CompanionMaintenanceBytes $script:fixtureHost));signerThumbprint=('A'*40)};console=@{path=$script:fixtureConsole;sha256=(Get-CompanionMaintenanceHash (Read-CompanionMaintenanceBytes $script:fixtureConsole));signerThumbprint=('B'*40)}}}
function Get-CompanionMaintenanceTargetRegistration($Subject){return @{distroId='{11111111-1111-1111-1111-111111111111}';companionSid=$Subject.companionSid;distribution=$Subject.wslDistribution;vhdxPath=$Subject.targetVhdxPath}}
function Get-CompanionMaintenanceTokenFacts([string]$Root,[long]$ProcessId,$Receipt){$p=Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId='+$ProcessId);return @{code='TOKEN_FACTS';pid=$ProcessId;userSid='fixture-sid';sessionId=0;imagePath=[string]$p.ExecutablePath;elevationType=3;adminsPresent=$false;adminsDenyOnly=$false}}
$rawCommand=${function:Get-CompanionMaintenanceProcessCommand};$script:commandReads=@()
function Get-CompanionMaintenanceProcessCommand($Process){$script:commandReads+=,$Process.pid;return (& $script:rawCommand $Process)}
$script:elapsed=0
function Start-CompanionMaintenanceTreeClock {$clock=[pscustomobject]@{};$clock|Add-Member ScriptProperty Elapsed {[TimeSpan]::FromSeconds($script:elapsed)};return $clock}
function Wait-CompanionMaintenanceTreeSample {$script:elapsed+=31}
# Await only creation of this fixture tree; this is not a quiescence claim.
$timer=[Diagnostics.Stopwatch]::StartNew()
while($timer.Elapsed.TotalSeconds -lt 8){$rows=Get-CompanionMaintenanceProcesses $Root;if(@($rows|Where-Object{$_.image -ceq $script:fixtureHost}).Count -eq 1 -and @($rows|Where-Object{$_.image -ceq $script:fixtureConsole}).Count -ge 3){break};Start-Sleep -Milliseconds 50}
try{$verified=Get-CompanionMaintenanceVerifiedCompanionTree $Root @{companionSid='fixture-sid';wslDistribution='CluedLinux';targetVhdxPath='C:\Fixture\ext4.vhdx'} ([DateTimeOffset]::MinValue);@{accepted=$true;count=$verified.Count;roles=@($verified|ForEach-Object{$_.role});tokenAuthenticationFixture=$true;sessionZeroObserved=$false}|ConvertTo-Json -Depth 5 -Compress}
catch{@{accepted=$false;code=$_.Exception.Message;commandReads=$script:commandReads;tokenAuthenticationFixture=$true;sessionZeroObserved=$false}|ConvertTo-Json -Compress}
'''


@unittest.skipUnless(PS.is_file(), 'Windows PowerShell 5.1 required')
class CompanionMaintenanceLocal(unittest.TestCase):
    def run_case(self, mutate=lambda root: None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def put(path, value):
                target = root / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(json.dumps(value), encoding='utf-8')
            put('state/PAUSED.json', {'contract': 'pause', 'requestSha256': 'c' * 64})
            paused = hashlib.sha256((root / 'state/PAUSED.json').read_bytes()).hexdigest()
            put('state/status.json', {'contract': 'clued.independent-ci.resident-status/8',
                'writtenAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'current': None, 'halt': None, 'paused': True,
                'executor': {'state': 'PAUSED'}, 'train': {'enabled': 'on'}})
            put('upgrade/status.json', {'contract': 'clued.independent-ci.resident-upgrade-status/1', 'op': None})
            put(f'state/ledger/{"a" * 64}/90-terminal.json', {'key': 'a' * 64, 'outcome': 'COMPLETED'})
            op = '10000000-0000-0000-0000-000000000001'
            put(f'upgrade/ops/{op}/900-terminal.json', {'contract': 'clued.independent-ci.resident-upgrade-journal/1',
                'opId': op, 'seq': 900, 'step': 'terminal', 'kind': 'terminal', 'outcome': 'SUCCEEDED'})
            request = '20000000-0000-0000-0000-000000000002'
            put(f'broker/requests/{request}.json', {'requestId': request})
            put(f'broker/responses/{request}.json', {'contract': 'clued.independent-ci.swap-broker-response/2',
                'requestId': request, 'restored': True, 'accountUnchanged': True,
                'stableAfter': True, 'configurationConflict': False})
            mutate(root)
            driver = root / 'driver.ps1'
            driver.write_text(DRIVER, encoding='utf-8')
            result = subprocess.run([str(PS), '-NoProfile', '-NonInteractive', '-File', str(driver),
                str(BASE / 'windows/companion-maintenance.ps1'), str(root), paused],
                capture_output=True, text=True, encoding='utf-8', timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)

    def test_actual_native_reads_accept_terminal_journals_and_retained_answered_broker(self):
        self.assertTrue(self.run_case()['accepted'])

    def test_open_ledger_refuses(self):
        result = self.run_case(lambda r: (r / f'state/ledger/{"b" * 64}').mkdir())
        self.assertFalse(result['accepted'])

    def test_unknown_terminal_outcome_refuses(self):
        result = self.run_case(lambda r: (r / f'state/ledger/{"a" * 64}/90-terminal.json').write_text('{"key":"' + 'a'*64 + '","outcome":"UNKNOWN"}'))
        self.assertEqual(result['code'], 'MAINTENANCE_JOURNAL_NONTERMINAL_OR_UNKNOWN')

    def test_terminal_wrong_subject_refuses(self):
        result = self.run_case(lambda r: (r / f'state/ledger/{"a" * 64}/90-terminal.json').write_text('{"key":"other","outcome":"COMPLETED"}'))
        self.assertEqual(result['code'], 'MAINTENANCE_LEDGER_SUBJECT_UNKNOWN')

    def test_active_upgrade_journal_refuses(self):
        result = self.run_case(lambda r: (r / 'upgrade/ops/30000000-0000-0000-0000-000000000003').mkdir())
        self.assertFalse(result['accepted'])

    def test_unanswered_broker_refuses(self):
        result = self.run_case(lambda r: (r / 'broker/responses/20000000-0000-0000-0000-000000000002.json').unlink())
        self.assertFalse(result['accepted'])

    def test_stale_status_refuses_before_stop(self):
        def change(root):
            path = root / 'state/status.json'
            value = json.loads(path.read_text())
            value['writtenAt'] = '2020-01-01T00:00:00Z'
            path.write_text(json.dumps(value))
        self.assertEqual(self.run_case(change)['code'], 'MAINTENANCE_LOCAL_STATUS_STALE')

    def test_pause_hash_change_refuses(self):
        result = self.run_case(lambda r: (r / 'state/PAUSED.json').write_text('{"changed":true}'))
        self.assertEqual(result['code'], 'MAINTENANCE_PAUSED_CHANGED')

    def test_malformed_json_fails_closed(self):
        self.assertFalse(self.run_case(lambda r: (r / 'state/status.json').write_text('{'))['accepted'])

    def launcher_case(self, case, defer=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            helper = root / 'resident' / ('a'*64) / 'windows/companion-maintenance.ps1'
            helper.parent.mkdir(parents=True)
            helper.write_text(r'''
function Get-CompanionMaintenanceRegisteredVhd {return 'C:\Owned\ext4.vhdx'}
function Read-CompanionMaintenanceBytes {return ,([byte[]]@(1))}
function Get-CompanionMaintenanceHash {return ('e'*64)}
function Invoke-CompanionMaintenance([string]$Root,$ExpectedSubject,[string]$HostDrop,[string]$EvidenceDirectory,[scriptblock]$Action){return (& $Action 'C:\Protected\accepted.json' ('f'*64))}
''', encoding='utf-8')
            driver = root / 'driver.ps1'
            driver.write_text(DEFER_DRIVER if defer else LAUNCHER_DRIVER, encoding='utf-8')
            args = [str(PS), '-NoProfile', '-NonInteractive', '-File', str(driver), str(BASE / 'reinstall/launcher/template.ps1')]
            args += [case] if defer else [str(root), case]
            result = subprocess.run(args, capture_output=True, text=True, encoding='utf-8', timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)

    def test_launcher_default_keeps_old_child_without_maintenance(self):
        value = self.launcher_case('default')
        self.assertEqual(value['calls'][0]['arguments'], ['-CompanionAccount', '-WslVhdxDirectory', r'C:\Vhd'])

    def test_launcher_optin_passes_exact_context_to_same_child(self):
        value = self.launcher_case('enabled')
        self.assertTrue(value['result']['ran'])
        self.assertEqual(len(value['calls']), 1)
        self.assertEqual(value['calls'][0]['arguments'][-5:], ['-CompanionWslVmShutdown', '-CompanionMaintenanceContextFile',
            r'C:\Protected\accepted.json', '-ExpectedCompanionMaintenanceContextSha256', 'f'*64])

    def test_launcher_missing_pin_starts_no_child(self):
        value = self.launcher_case('missing-pin')
        self.assertFalse(value['result']['ran'])
        self.assertEqual(value['result']['error'], 'ONE_UAC_MAINTENANCE_NOT_PINNED')
        self.assertEqual(value['calls'], [])

    def test_launcher_helper_hash_drift_starts_no_child(self):
        value = self.launcher_case('tamper')
        self.assertEqual(value['result']['error'], 'ONE_UAC_MAINTENANCE_HELPER_CHANGED')
        self.assertEqual(value['calls'], [])

    def test_maintenance_defers_companion_start_until_account_qualification(self):
        value = self.launcher_case('enabled', defer=True)
        self.assertEqual(value, {'starts': 0, 'switches': 1, 'started': False, 'deferred': True})

    def test_default_still_starts_companion(self):
        value = self.launcher_case('default', defer=True)
        self.assertEqual(value['starts'], 1)
        self.assertTrue(value['started'])

    def test_maintenance_without_pause_never_switches(self):
        value = self.launcher_case('unpaused', defer=True)
        self.assertEqual(value['starts'], 0)
        self.assertEqual(value['switches'], 0)
        self.assertFalse(value['deferred'])


@unittest.skipUnless(PS.is_file(), 'Windows PowerShell 5.1 required')
class CompanionMaintenanceNativeTree(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='clued-native-tree-')
        cls.base = Path(cls.tmp.name)
        cls.root = cls.base / 'resident'
        cls.client_dir = cls.base / 'machine binaries'
        for path in (cls.root / 'bin', cls.root / 'runtime', cls.client_dir):
            path.mkdir(parents=True)
        source = cls.base / 'fixture.cs'
        source.write_text(TREE_EXE, encoding='utf-8')
        seed = cls.base / 'fixture.exe'
        compiler = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        compiled = subprocess.run([str(compiler), '/nologo', '/noconfig', '/target:winexe', '/platform:x64',
                                   '/reference:' + str(compiler.parent / 'System.dll'),
                                   '/reference:' + str(compiler.parent / 'System.Core.dll'),
                                   '/out:' + str(seed), str(source)], capture_output=True, text=True, timeout=30)
        if compiled.returncode != 0:
            raise RuntimeError(compiled.stdout + compiled.stderr)
        for path in (cls.root / 'bin/CluedCompanionSupervisor.exe', cls.root / 'runtime/node.exe',
                     cls.client_dir / 'wsl.exe', cls.client_dir / 'wslhost.exe', cls.client_dir / 'conhost.exe', cls.client_dir / 'gh.exe'):
            shutil.copyfile(seed, path)
        cls.driver = cls.base / 'driver.ps1'
        cls.driver.write_text(TREE_DRIVER, encoding='utf-8')

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def check_tree(self, mode):
        release = self.base / 'release'
        if release.exists():
            release.unlink()
        env = dict(os.environ, CLUED_FIXTURE_ROOT=str(self.root), CLUED_FIXTURE_BASE=str(self.base), CLUED_FIXTURE_MODE=mode)
        process = subprocess.Popen([str(self.root / 'bin/CluedCompanionSupervisor.exe')], env=env)
        try:
            result = subprocess.run([str(PS), '-NoProfile', '-NonInteractive', '-File', str(self.driver),
                                     str(BASE / 'windows/companion-maintenance.ps1'), str(self.root), str(self.client_dir), mode],
                                    capture_output=True, text=True, encoding='utf-8', timeout=25)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn('DO_NOT_LOG_THIS_FIXTURE_ARGUMENT', result.stdout + result.stderr)
            value = json.loads(result.stdout)
            self.assertTrue(value['tokenAuthenticationFixture'])
            self.assertFalse(value['sessionZeroObserved'])
            return value
        finally:
            release.write_text('release owned fixture processes', encoding='utf-8')
            process.wait(timeout=10)

    def test_native_fixed_seven_role_shape_accepted(self):
        value = self.check_tree('valid')
        self.assertTrue(value['accepted'], value)
        self.assertEqual(value['count'], 7)
        self.assertEqual(sorted(value['roles']), ['companion', 'console', 'console', 'console', 'host', 'keepalive', 'supervisor'])

    def test_native_wrong_keepalive_command_refused(self):
        self.assertEqual(self.check_tree('keepalive-command')['code'], 'MAINTENANCE_KEEPALIVE_COMMAND_UNKNOWN')

    def test_native_quoted_leading_option_refused(self):
        self.assertEqual(self.check_tree('quoted-option')['code'], 'MAINTENANCE_KEEPALIVE_COMMAND_UNKNOWN')

    def test_native_wrong_host_distribution_refused(self):
        self.assertEqual(self.check_tree('host-distro')['code'], 'MAINTENANCE_WSLHOST_DISTRO_MISMATCH')

    def test_native_wrong_console_parent_refused(self):
        self.assertEqual(self.check_tree('console-parent')['code'], 'MAINTENANCE_CONSOLE_PARENT_UNKNOWN')

    def test_native_console_extra_arguments_refused(self):
        self.assertEqual(self.check_tree('console-command')['code'], 'MAINTENANCE_CONSOLE_COMMAND_UNKNOWN')

    def test_native_extra_console_refused(self):
        self.assertEqual(self.check_tree('extra-console')['code'], 'MAINTENANCE_CONSOLE_PARENT_UNKNOWN')

    def test_native_unrelated_gh_descendant_never_admitted_or_logged(self):
        value = self.check_tree('extra-gh')
        self.assertEqual(value['code'], 'MAINTENANCE_QUALIFIED_PROCESSES_NOT_QUIET')
        self.assertEqual(value['commandReads'], [])


if __name__ == '__main__':
    unittest.main()
