// Fable ruling 11-20 "first install r4" sections 2-5 and 6 (drill 70e8be94): the four defects of the drill tool and of the first install's
// result chain that run showed, each held by a test that failed before its fix.
//   E2  wsl.exe gets its arguments unquoted (one quoting rule for every child the drill starts)
//   E3  an M5 observation the guest does not have is "missing", never an empty file
//   E4  nothing installed: no reboot, no wait; A7 says why
//   E5  (a) the launcher's own code reaches the bootstrap's verdict and the entry's stop code; (b) a FAIL summary line names its reason
// Offline: no VM, no wsl.exe; only temp directories are written.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const windows = process.platform === 'win32';
const opts = { skip: !windows };
const script = fileURLToPath(new URL('../drill/drill-vm.ps1', import.meta.url));
const entryScript = fileURLToPath(new URL('../drill/first-install-entry.ps1', import.meta.url));
const bootstrap = fileURLToPath(new URL('../rollout/fleet/bootstrap.ps1', import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-r4-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Dot-source the drill (definitions only) and print the expression's value as JSON.
function ps(expr, file = script) {
  const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $ProgressPreference='SilentlyContinue'; . ${q(file)}; ConvertTo-Json -Depth 12 -Compress -InputObject $(${expr})`],
  { encoding: 'utf8', timeout: 180000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout.trim());
}

// ---------------------------------------------------------------- E2
// The real Invoke-DrillProcess (no injected runner) starts a real child that prints its own raw command line: what wsl.exe would read.
// Before the fix every argument was quoted ("--list" "--running" "--quiet"), which wsl.exe takes for a command to run in the default
// distribution (/bin/sh: --list: not found, exit 127).
test('E2: the drill passes wsl.exe its options as they are, quoting only an argument that needs it', opts, () => {
  const spaced = 'C:\\a b\\c';
  const r = ps(`$r = Invoke-DrillProcess ${q(powershell)} @('-NoProfile', '-NonInteractive', '-Command', '[Console]::Out.Write([Environment]::CommandLine);#', '--list', '--running', '--quiet', ${q(spaced)}) 60
    [ordered]@{ exit = $r.exit; stdout = $r.stdout; stderr = $r.stderr }`);
  assert.equal(r.exit, 0, r.stderr);
  assert.ok(r.stdout.endsWith(` -NoProfile -NonInteractive -Command [Console]::Out.Write([Environment]::CommandLine);# --list --running --quiet "${spaced}"`), r.stdout);
  // the WSL query goes through that function, with those three literals
  const text = fs.readFileSync(script, 'utf8');
  const wsl = text.slice(text.indexOf('function Invoke-DrillWsl('), text.indexOf('function Get-DrillWslRegisteredNames'));
  assert.match(wsl, /return Invoke-DrillProcess \(Join-Path \$env:SystemRoot 'System32\\wsl\.exe'\) \$Arguments /);
  assert.match(text, /Invoke-DrillWsl @\('--list', '--running', '--quiet'\)/);
});

// One rule in the whole file: the one Invoke-DrillNative carries to the guest as text, which Invoke-DrillProcess takes from it.
test('E2: one quoting rule for every child the drill starts, the same answers on one table', opts, () => {
  const text = fs.readFileSync(script, 'utf8');
  assert.equal(text.split(`-notmatch '[\\s"]'`).length - 1, 1, 'the rule is written once');
  assert.ok(!/'"' \+ \$_ \+ '"'/.test(text), 'no argument quoted unconditionally');
  const table = ['--list', '--quiet', 'C:\\a b\\c', 'C:\\a b\\', 'say "hi"', '', 'plain', 'tab\there'];
  const r = ps(`$t = ${q(JSON.stringify(table))} | ConvertFrom-Json
    $native = @($t | ForEach-Object { & $script:DrillArgumentQuote $_ })
    [ordered]@{ line = (Get-DrillArgumentLine $t); native = $native; inNative = ${'$'}{function:Invoke-DrillNative}.ToString().Contains($script:DrillArgumentQuote.ToString()) }`);
  assert.equal(r.inNative, true, 'the rule is the one Invoke-DrillNative carries');
  assert.equal(r.line, r.native.join(' '));
  assert.deepEqual(r.native, ['--list', '--quiet', '"C:\\a b\\c"', '"C:\\a b\\\\"', '"say \\"hi\\""', '""', 'plain', '"tab\there"']);
  const process = text.slice(text.indexOf('function Invoke-DrillProcess('), text.indexOf('# Clued Task fe8a2cbf'));
  assert.match(process, /\.Arguments = Get-DrillArgumentLine \$Arguments/);
});

// The list call's raw answer is kept where the receipt keeps the stage (Fable section 2: calibrate the exit of "nothing running" when it
// happens): its exit and the bytes of its stdout.
test('E2: the receipt keeps the WSL list call\'s raw exit and stdout byte count', opts, () => {
  const r = ps(`$env:CLUED_UNDER_TEST = '1'
    function Get-DrillRunnerDistributions { param($HostName) @('Fixture-CI') }
    function Get-DrillWslRegisteredNames { @('Fixture-CI') }
    $script:DrillWslRunner = { param($a) if ($a[0] -ceq '--list') { return @{ exit = 1; stdout = 'abc'; stderr = '' } }; @{ exit = 1; stdout = ''; stderr = '' } }
    $s = Get-DrillWslRunnerState 'x'
    $t = ConvertTo-DrillGateTrace @{ ok = $true; wslUnreadable = $s.reason; wslListCall = $s.listCall }
    [ordered]@{ reason = $s.reason; call = $s.listCall; trace = $t.wslListCall }`);
  assert.equal(r.reason, 'WSL_RUNNING_LIST_FAILED');
  assert.deepEqual(r.call, { exit: 1, stdoutBytes: 3 });
  assert.deepEqual(r.trace, { exit: 1, stdoutBytes: 3 });
  const text = fs.readFileSync(script, 'utf8');
  assert.match(text, /\$safety\.wslListCall = Get-Prop \$wsl 'listCall'/);
});

// ---------------------------------------------------------------- E3
// The real guest script on an empty root, its answer through the real remoting serializer (PSSerializer), into the real Copy-DrillM5.
// Before the fix: the four files the guest reads by path came back as empty objects and were written as 0-byte files; missing named two.
test('E3: an M5 observation the guest does not have is missing, never an empty file', opts, () => {
  const root = path.join(tmp, 'e3', 'guest', 'root'); fs.mkdirSync(root, { recursive: true });
  // a file the guest has but empty: no observation either
  fs.mkdirSync(path.join(root, 'broker')); fs.writeFileSync(path.join(root, 'broker', 'renew-key.json'), '');
  const runDir = path.join(tmp, 'e3', 'run'); fs.mkdirSync(runDir, { recursive: true });
  const r = ps(`$guest = & $script:GuestM5Files ${q(root)}
    $script:fromGuest = [Management.Automation.PSSerializer]::Deserialize([Management.Automation.PSSerializer]::Serialize($guest, 4))
    function Invoke-DrillGuest { param($Credential, $Script, $ArgumentList, $TimeoutMinutes, $Code, $Step, [switch]$Restartable) $script:fromGuest }
    $m5 = Copy-DrillM5 ${q(runDir)} $null
    $v = Get-DrillM5Verdict ${q(runDir)} $m5
    [ordered]@{ missing = @($m5.missing); files = @(Get-ChildItem -LiteralPath (Join-Path ${q(runDir)} 'm5') -File | ForEach-Object { $_.Name }); detail = $v.detail }`);
  // the host's own network.json (FABLE-drill-r13-a8-m5 2.3) beside the only observation the guest made
  assert.deepEqual(r.files, ['network.json', 'record.json'], 'only the observation the guest made, and the host\'s network.json');
  assert.deepEqual(r.missing, ['profile.json', 'system.json', 'resident.json', 'controller.json', 'companion.json', 'probe.json']);
  assert.equal(r.detail, 'DRILL_M5_OBSERVATIONS_MISSING');
});

// ---------------------------------------------------------------- E4
const STEP_LOGS = {
  'host.stdout.log': [JSON.stringify({ name: 'stage', result: 'ok' }), JSON.stringify({ status: 'FIRST_INSTALL_HOST_READY' })].join('\r\n') + '\r\n',
  'prepare.stdout.log': JSON.stringify({ status: 'FLEET_NODE_FIRST_INSTALL_PREPARED' }) + '\r\n',
  'launcher.stdout.log': [JSON.stringify({ name: 'launcher', result: 'failed', rejectCode: 'SECRET_CHECK_FAILED:VERIFY_SCRIPT_PARSE_ERRORS', detail: null }),
    JSON.stringify({ status: 'STOPPED', code: 'SECRET_CHECK_FAILED:VERIFY_SCRIPT_PARSE_ERRORS' })].join('\r\n') + '\r\n',
};
const entryLine = JSON.stringify({ status: 'FIRST_INSTALL_STOPPED', stopCode: 'SECRET_CHECK_FAILED:VERIFY_SCRIPT_PARSE_ERRORS', tree: 'C:\\t', node: 'C:\\n.exe' });

// Invoke-DrillRun offline as far as A7, the guest's read after the install given; returns what was sent and the A7 item.
function runToA7(name, read, entry = { line: entryLine, exit: 1 }) {
  const runDir = path.join(tmp, name, 'run'); fs.mkdirSync(runDir, { recursive: true });
  const guest = path.join(tmp, name, 'guest'); fs.mkdirSync(guest, { recursive: true });
  const files = { ...STEP_LOGS, 'first-install.stdout.log': entry.line + '\r\n', 'host-result.json': JSON.stringify({ exit: 0, terminal: { status: 'FIRST_INSTALL_HOST_READY' } }),
    'launcher-result.json': JSON.stringify({ exit: 1, terminal: { status: 'STOPPED', code: 'SECRET_CHECK_FAILED:VERIFY_SCRIPT_PARSE_ERRORS' } }), 'stage-timings.json': '{"host":1}' };
  for (const [n, text] of Object.entries(files)) fs.writeFileSync(path.join(guest, n), text);
  return ps(`
    $script:sent = [Collections.Generic.List[string]]::new()
    $script:Interactive = $false
    function New-PSSession { param($VMName, $Credential) 'session' }
    function Remove-PSSession { param($Session) }
    function Copy-Item { param($LiteralPath, $Path, $Destination, $ToSession, [switch]$Recurse) }
    function Invoke-Command { param($Session, $ScriptBlock, $ArgumentList, $VMName, $Credential, [switch]$AsJob, $ErrorAction)
      if ($VMName) { $script:sent.Add('vm-command:' + $ScriptBlock.ToString().Trim()) }
      if ($ArgumentList -is [string]) { if ($ArgumentList -like '*.tar') { 'ab' } else { @{ contract = 'x' } } } }
    function Wait-DrillGuest { param($Credential, $Minutes, $After) $script:sent.Add('Wait-DrillGuest'); [DateTimeOffset]::UtcNow }
    function Wait-DrillRebootRefresh { param($Cred, $Boot, $Deadline) $script:sent.Add('Wait-DrillRebootRefresh'); [ordered]@{ ok = $false; status = $null; readAt = [DateTimeOffset]::UtcNow.ToString('o'); boot = $Boot.ToString('o'); done = $false } }
    function Copy-DrillM5 { param($RunDir, $Cred) @{} }
    $read = ${q(JSON.stringify(read))} | ConvertFrom-Json
    function Invoke-DrillGuest { param($Credential, $Script, $ArgumentList, $TimeoutMinutes, $Code, $Step, [switch]$Restartable)
      $script:sent.Add('guest:' + $Step)
      if ($Step -ceq 'first-install') { return [ordered]@{ lines = @(${q(entry.line)}); exit = ${entry.exit}; stderr = '' } }
      if ($Step -ceq 'stage-files' -or $Step -ceq 'guest-evidence') { return (& $Script ${q(guest)} $ArgumentList[1]) }
      if ($Step -ceq 'read-after-install') { return $read }
      # A8 after an entry that ended done (no skip any more: FABLE-drill-r13-a8-m5 1.3): the two refusals
      if ($Step -ceq 'reinstall-upgrade') { return [ordered]@{ exit = 0; stdout = '{"status":"FLEET_NODE_ALREADY_AT_THIS_PACKAGE"}'; stderr = '' } }
      if ($Step -ceq 'reinstall') { return [ordered]@{ upgradeStatus = 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE'; prepareStatus = 'FLEET_NODE_INSTALL_REFUSED'; prepareCode = 'NEW_SOURCE_IS_THE_INSTALLED_ONE'; upgradeExit = 0; prepareExit = 1 } }
      throw "unexpected step $Step"
    }
    $package = @{ version = '1.2.3'; files = @(); tar = 'C:/x/p.tar'; tarSha256 = 'ab'; acceptance = 'C:/x/a.json'; ciSourceManifestSha256 = ('5' * 64) }
    $testKit = [pscustomobject]@{ dir = 'C:/kit'; entryFile = 'first-install-entry.ps1'; arguments = @('-Work', '{work}'); timeoutMinutes = 5; perNodeSteps = @(); prerequisiteMode = 'first-install-host'
      credentials = [pscustomobject]@{ required = [pscustomobject]@{ appKey = 'app-private-key.pem' }; optional = [pscustomobject]@{} } }
    $code = try { $run = Invoke-DrillRun ${q(runDir)} $package $testKit $null $null; 'done' } catch { $c = Get-DrillCode $_; "$($c.code) $($c.detail)" }
    $a7 = if ($run) { $items = Get-DrillVerdict @{ now = [DateTimeOffset]::Parse($run.first.readAt); entry = $run.entry; launcher = $run.launcher; pause = $run.first.pause; verify = $run.first.verify; status = $run.first.status; current = $run.first.current; facts = $run.first.facts; acceptanceSource = $package.ciSourceManifestSha256; reboot = $run.reboot; reinstall = (Get-Prop $run 'reinstall'); kit = $testKit; candidate = $true; firstInstallSteps = (Read-DrillFirstInstallSteps ${q(runDir)}) }; @($items | Where-Object { $_.id -eq 'A7' })[0] } else { $null }
    $file = Join-Path ${q(runDir)} 'read-after-reboot.json'
    @{ code = $code; sent = @($script:sent); a7 = $a7; rebootFile = $(if (Test-Path -LiteralPath $file) { Read-DrillJson $file } else { $null }) }`);
}
const nothing = { status: null, current: null, facts: null, pause: null, verify: { status: 'NOT_RUN', exit: null, tail: [], stderr: null }, readAt: '2026-11-20T11:49:28Z' };

test('E4: nothing installed -- no reboot, no wait; A7 fails with why, and read-after-reboot.json says skipped', opts, () => {
  const r = runToA7('e4-nothing', nothing);
  assert.equal(r.code, 'done');
  assert.ok(!r.sent.some(s => s.startsWith('vm-command:') && s.includes('Restart-Computer')), 'no reboot sent: ' + JSON.stringify(r.sent));
  assert.ok(!r.sent.includes('Wait-DrillGuest') && !r.sent.includes('Wait-DrillRebootRefresh'), 'no wait: ' + JSON.stringify(r.sent));
  assert.equal(r.a7.pass, false);
  assert.equal(r.a7.detail, 'DRILL_A7_BLOCKED_NOTHING_INSTALLED');
  assert.deepEqual(r.rebootFile, { skipped: true, reason: 'DRILL_A7_BLOCKED_NOTHING_INSTALLED' });
});

// Fable plan 87d330d0 2.2 (A4): a first install that did not end done now blocks A7 (drill-vm-part4.test.mjs "block A 4"), so the reboot is
// drilled here after an entry that ended done; nothing installed still comes first (the test above, a stopped entry).
const entryDone = { line: JSON.stringify({ status: 'FIRST_INSTALL_DONE', stopCode: null, tree: 'C:\\t', node: 'C:\\n.exe' }), exit: 0 };
test('E4: something installed (even half) -- the reboot and its wait run as before', opts, () => {
  for (const [name, read] of [['e4-status', { ...nothing, status: { writtenAt: '2026-11-20T11:49:00Z' } }], ['e4-current', { ...nothing, current: { generation: 1 } }]]) {
    const r = runToA7(name, read, entryDone);
    assert.equal(r.code, 'done');
    assert.ok(r.sent.some(s => s.startsWith('vm-command:') && s.includes('Restart-Computer')), name + ': reboot sent: ' + JSON.stringify(r.sent));
    assert.ok(r.sent.includes('Wait-DrillGuest') && r.sent.includes('Wait-DrillRebootRefresh'), name + ': waited: ' + JSON.stringify(r.sent));
    assert.match(r.a7.detail, /^refreshedAfterBoot=/);
  }
  // the judgement is one pure function of the guest's raw read
  assert.deepEqual(ps(`@((Test-DrillInstallProduced @{ status = $null; current = $null }), (Test-DrillInstallProduced @{ status = @{ a = 1 }; current = $null }),
    (Test-DrillInstallProduced @{ status = $null; current = @{ a = 1 } }), (Test-DrillInstallProduced $null))`), [false, true, true, false]);
});

// ---------------------------------------------------------------- E5 (a)
// This run's real launcher terminal (stage-evidence.json of 20261120T112254Z, launcher-result.json's terminal), printed and read back by
// the package's own parser (Get-LastJsonLine): the bootstrap's verdict, the entry's stop code and the bootstrap's last line all carry the
// launcher's code. Before the fix all three said BOOTSTRAP_LAUNCHER_ENDED.
test('E5(a): the launcher\'s own code reaches the bootstrap verdict, the entry\'s stop code and the bootstrap\'s last line', opts, () => {
  const terminal = fs.readFileSync(fixture('drill-70e8be94-launcher-terminal.json'), 'utf8');
  const code = 'SECRET_CHECK_FAILED:VERIFY_SCRIPT_PARSE_ERRORS';
  const done = JSON.stringify({ status: 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED', role: 'not-held', companionHeadless: { ran: true, status: 'COMPANION_HEADLESS_QUALIFIED' } });
  const fellBack = JSON.stringify({ status: 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED', role: 'not-held', companionHeadless: { ran: true, status: 'COMPANION_HEADLESS_FELL_BACK' } });
  const r = ps(`. ${q(bootstrap)} -From ${q(tmp)}
    $script:Work = 'C:\\w'
    $out = { param($t)
      $v = Get-LauncherVerdict $true $t
      $lines = @(try { Out-LauncherVerdict $v ([ordered]@{ firstInstall = $true; prepare = 'FLEET_NODE_FIRST_INSTALL_PREPARED'; launcher = (Get-Key $t 'status'); companionSwitch = $v.companionSwitch; next = $v.next; exit = 1; output = 'o.txt' }) } catch { 'MISSING:' + $_.Exception.Message })
      $last = $lines[-1]; $step = $lines[0]
      [ordered]@{ verdict = $v; hasCode = $v.Contains('code'); entry = (ConvertTo-FirstInstallEntryResult $v $(if ($v.status -ceq 'BOOTSTRAP_DONE') { 0 } else { 1 }) 'C:\\t' 'C:\\n.exe')
        step = $(try { $step | ConvertFrom-Json } catch { $step }); last = $(try { $last | ConvertFrom-Json } catch { $last }) } }
    [ordered]@{ stopped = (& $out (Get-LastJsonLine ${q(terminal)})); done = (& $out (Get-LastJsonLine ${q(done)})); fellBack = (& $out (Get-LastJsonLine ${q(fellBack)})); none = (& $out $null) }`, entryScript);
  // the run's own terminal
  assert.equal(r.stopped.verdict.status, 'BOOTSTRAP_LAUNCHER_ENDED', 'the status vocabulary is unchanged');
  assert.equal(r.stopped.verdict.code, code);
  assert.equal(r.stopped.entry.stopCode, code);
  assert.equal(r.stopped.entry.status, 'FIRST_INSTALL_STOPPED');
  assert.deepEqual([r.stopped.step.name, r.stopped.step.result, r.stopped.step.rejectCode], ['launcher', 'failed', code], JSON.stringify(r.stopped.step));
  assert.equal(r.stopped.last.status, 'BOOTSTRAP_LAUNCHER_ENDED', JSON.stringify(r.stopped.last));
  assert.equal(r.stopped.last.code, code);
  // done: no code anywhere, and the entry calls it done
  assert.equal(r.done.verdict.status, 'BOOTSTRAP_DONE');
  assert.equal(r.done.hasCode, false);
  assert.equal(r.done.entry.status, 'FIRST_INSTALL_DONE');
  assert.equal(r.done.entry.stopCode, null);
  assert.equal(r.done.step.rejectCode, null);
  assert.equal('code' in r.done.last, false, JSON.stringify(r.done.last));
  // the companion switch not done: the switch's own status is the code
  assert.equal(r.fellBack.verdict.status, 'BOOTSTRAP_FIRST_INSTALL_COMPANION_SWITCH_NOT_DONE');
  assert.equal(r.fellBack.verdict.code, 'COMPANION_HEADLESS_FELL_BACK');
  assert.equal(r.fellBack.entry.stopCode, 'COMPANION_HEADLESS_FELL_BACK');
  assert.equal(r.fellBack.last.code, 'COMPANION_HEADLESS_FELL_BACK');
  // no terminal: an empty code, and the step and the entry fall back on the status
  assert.equal(r.none.hasCode, true);
  assert.equal(r.none.verdict.code, null);
  assert.equal(r.none.entry.stopCode, 'BOOTSTRAP_LAUNCHER_ENDED');
  assert.equal(r.none.step.rejectCode, 'BOOTSTRAP_LAUNCHER_ENDED');
  // the bootstrap prints its launcher verdict through that one function; the entry reads the verdict, not the terminal
  const text = fs.readFileSync(bootstrap, 'utf8');
  assert.match(text, /\$v = Get-LauncherVerdict \$firstInstall \$l\.last\r?\n\s*Out-LauncherVerdict \$v /);
  assert.match(fs.readFileSync(entryScript, 'utf8'), /return \(ConvertTo-FirstInstallEntryResult \$verdict /);
});

// Audit item 6 (D:/w/tmp/claude-drill-r4-audit.result.md, Fable section 7.1 "same-kind gaps"): the entry loads the release's bootstrap by
// dot-sourcing it; the other tests give it an 'entry' stand-in. Here the repository's real bootstrap.ps1, copied under the release name,
// is loaded the way Invoke-FirstInstallAccepted loads it (the one loader, dot-sourced into the caller): it parses, runs no main, and its
// helpers -- and the entry's own Stop-Bootstrap over the package's -- are callable afterwards.
test('the entry loads the real bootstrap.ps1 and its helpers are callable', opts, () => {
  const assets = path.join(tmp, 'entry-assets'); fs.mkdirSync(assets, { recursive: true });
  fs.copyFileSync(bootstrap, path.join(assets, 'fleet-node-1.2.3.bootstrap.ps1'));
  const r = ps(`. Import-EntryBootstrap ${q(assets)} '1.2.3'
    $names = @('Get-ReleaseVersion', 'Read-Sha256Sums', 'Get-LauncherVerdict', 'Get-LastJsonLine', 'Invoke-StageChild', 'Expand-Cached', 'Test-FirstInstallCheck')
    [ordered]@{ missing = @($names | Where-Object { -not (Get-Command $_ -CommandType Function -ErrorAction SilentlyContinue) })
      version = (Get-ReleaseVersion @('fleet-node-1.2.3.tar', 'SHA256SUMS')); from = $From; receipt = $ReceiptFile
      stop = $(try { Stop-Bootstrap 'host' 'SOME_CODE' 'why'; 'returned' } catch { $_.Exception.Message })
      verdict = (Get-LauncherVerdict $true (Get-LastJsonLine '{"status":"STOPPED","code":"X"}')).status }`, entryScript);
  assert.deepEqual(r.missing, []);
  assert.equal(r.version, '1.2.3');
  assert.equal(r.from, assets);
  assert.match(r.receipt, /install-receipt\.json$/, 'the bootstrap\'s own constants are loaded');
  assert.equal(r.stop, 'SOME_CODE:why', 'the entry owns the stop: it throws, the process is not ended');
  assert.equal(r.verdict, 'BOOTSTRAP_LAUNCHER_ENDED');
  const text = fs.readFileSync(entryScript, 'utf8');
  assert.match(text, /function Invoke-FirstInstallAccepted\([^\n]*\{\r?\n\s*\. Import-EntryBootstrap \$Assets \$ReleaseVersion\r?\n/);
  assert.equal(text.split('. $bootstrap -From').length - 1, 1, 'one place loads the bootstrap');
});

// ---------------------------------------------------------------- E5 (b)
// This run's real receipt (items, m5, candidate, as written): the summary line names the failed items and the first one's code; a passing
// receipt names none; a FAIL always carries a code or a reason.
test('E5(b): a FAIL summary line names its failed items and the first one\'s reason, from the receipt', opts, () => {
  const receipt = fs.readFileSync(fixture('drill-70e8be94-receipt-verdict.json'), 'utf8');
  const r = ps(`$receipt = ${q(receipt)} | ConvertFrom-Json
    $pass = [ordered]@{ candidate = $false; conclusion = 'PASS_A_PER_NODE_STEPS_REMAIN'; restoredToCheckpoint = $true; m5 = @{ result = 'PASS' }
      items = @(@('A1','A2','A3','A4','A6','A7','A8') | ForEach-Object { [ordered]@{ id = $_; pass = $true; detail = 'ok' } }) + @([ordered]@{ id = 'A5'; pass = $null; detail = 'x' }, [ordered]@{ id = 'A9'; pass = $null; detail = 'x' }, [ordered]@{ id = 'A10'; pass = $false; detail = 'per-node steps: x' }) }
    $m5Only = [ordered]@{ candidate = $false; conclusion = 'FAIL'; restoredToCheckpoint = $true; m5 = @{ result = 'FAIL'; detail = 'DRILL_M5_OBSERVATIONS_MISSING' }; items = $pass.items }
    $noRestore = [ordered]@{ candidate = $false; conclusion = 'FAIL'; restoredToCheckpoint = $false; m5 = @{ result = 'PASS' }; items = $pass.items }
    $noA1Steps = [ordered]@{ candidate = $true; conclusion = 'FAIL'; restoredToCheckpoint = $true; m5 = @{ result = 'PASS' }; items = @([ordered]@{ id = 'A1'; pass = $false; detail = 'no entry result steps=missing'; firstInstallSteps = $null }) }
    [ordered]@{ run = (Get-DrillRunSummary $receipt); pass = (Get-DrillRunSummary $pass); m5Only = (Get-DrillRunSummary $m5Only); noRestore = (Get-DrillRunSummary $noRestore); noA1Steps = (Get-DrillRunSummary $noA1Steps)
      conclusionAgrees = ((Get-DrillConclusion $receipt.items $receipt.m5 $true) -ceq 'FAIL') }`);
  assert.equal(r.run.reason, 'A1:launcher:SECRET_CHECK_FAILED:VERIFY_SCRIPT_PARSE_ERRORS');
  // that run skipped A8 (pass null, "skipped (-SkipReinstall)"); A8 has no skip any more (FABLE-drill-r13-a8-m5 1.3), so for this
  // candidate's receipt a not-true A8 is a failed item like the others
  assert.deepEqual(r.run.failedItems, ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'M5']);
  assert.equal(r.conclusionAgrees, true);
  assert.deepEqual(r.pass, { failedItems: [], reason: null });
  assert.deepEqual(r.m5Only, { failedItems: ['M5'], reason: 'M5:DRILL_M5_OBSERVATIONS_MISSING' });
  // a restore not confirmed is not a product item: no failed item, no reason (the run's code says it; the test below)
  assert.deepEqual(r.noRestore, { failedItems: [], reason: null });
  assert.equal(r.noA1Steps.reason, 'A1:no entry result steps=missing');
  // every FAIL summary with a failed item has a reason (the run's code is the other half, set only by a machine failure or the restore)
  for (const k of ['run', 'm5Only', 'noA1Steps']) assert.ok(r[k].reason, k);
  // the summary line is the receipt's: the line the run returns carries both fields, taken from the receipt just written
  const text = fs.readFileSync(script, 'utf8');
  assert.match(text, /\$summary = Get-DrillRunSummary \$receipt\r?\n\s*return \[ordered\]@\{ status = 'DRILL_DONE'; conclusion = \$receipt\.conclusion; code = \$\(if \(\$failure\) \{ \$failure\.code \} elseif \(-not \$restored\) \{ 'DRILL_RESTORE_NOT_CONFIRMED' \} else \{ \$null \}\); failedItems = \$summary\.failedItems; reason = \$summary\.reason;/);
});

// ---------------------------------------------------------------- E5 (b): the restore
// Fable ruling 11-20 "r4 E2-E5 ambiguities" item 3 (review blocking B1): the real Invoke-DrillOnCheckpoint and Invoke-DrillPreparedRun, only
// the VM and host boundary stubbed, and the checkpoint restore at the end throws. That is the drill machine's own failure, so it is the
// summary line's code; the reason names product items only (section 7.3: read code first, then reason). Before the fix the line said
// code=null, reason=DRILL_RESTORE_NOT_CONFIRMED, which section 7.3 reads as a product FAIL; and with failed items it said nothing of it.
test('E5(b): a checkpoint restore not confirmed is the summary line\'s code, never its reason', opts, () => {
  const root = path.join(tmp, 'e5b-restore'); fs.mkdirSync(root, { recursive: true });
  const r = ps(`$script:Drill.Runs = ${q(root)}
    function Assert-DrillHost { @{ freeGB = 64 } }
    function Invoke-DrillBaseline { @{ action = 'reuse' } }
    function Invoke-DrillPreBootRelease { param($HoldUntil) }
    function Get-DrillVmInfo { @{ vm = @{ Id = [guid]::Empty }; state = 'Off'; checkpoints = @($script:Drill.Checkpoint) } }
    function Get-DrillBaselineAction { param($Vm) @{ action = 'ready' } }
    function Restore-VMCheckpoint { param($VMName, $Name, [switch]$Confirm) }
    function Get-DrillCredential { }
    function Start-DrillHostGuard { param($RunDir, [switch]$RestoreCheckpoint, $Window) @{ state = @{ failure = $null; executorStates = [ordered]@{} } } }
    function Stop-DrillHostGuard { param($Guard) }
    function Start-DrillBootWatchdog { @{ signal = (Join-Path ${q(root)} 'watchdog'); process = $null } }
    function Start-DrillGuardedVm { param($Watchdog) }
    function Wait-DrillGuest { }
    function Invoke-DrillGuest { $true }
    function Assert-DrillGuard { }
    function Stop-DrillGuardedVm { param($Guard, [switch]$RestoreCheckpoint) if ($script:restoreThrows) { throw 'Restore-VMCheckpoint failed' } $true }
    function Invoke-DrillRun { if ($script:runThrows) { throw (New-DrillError 'DRILL_GUEST_STEP_FAILED') }
      @{ first = @{ readAt = '2026-11-20T12:00:00Z'; pause = $null; verify = $null; status = $null; current = $null; facts = $null }; entry = $null; launcher = $null; reboot = $null; timings = @{}; m5 = $null } }
    function Get-DrillVerdict { param($Facts)
      @(@('A1','A2','A3','A4','A6','A7','A8') | ForEach-Object { [ordered]@{ id = $_; pass = ($_ -cne $script:failId); detail = $(if ($_ -ceq $script:failId) { 'broke' } else { 'ok' }) } }) +
      @([ordered]@{ id = 'A5'; pass = $null; detail = 'x' }, [ordered]@{ id = 'A9'; pass = $null; detail = 'x' }, [ordered]@{ id = 'A10'; pass = $false; detail = 'per-node steps: x' }) }
    function Get-DrillM5Verdict { param($RunDir, $M5) @{ result = 'PASS' } }
    $case = { param($restoreThrows, $failId, $runThrows)
      $script:restoreThrows = $restoreThrows; $script:failId = $failId; $script:runThrows = $runThrows
      $out = Invoke-DrillPreparedRun @{ safeToResume = $true; holdUntil = [DateTimeOffset]::MinValue; deadline = [DateTimeOffset]::UtcNow.AddMinutes(10) } @{ version = '1.2.3'; tarSha256 = 'ab'; ciSourceManifestSha256 = 'cd'; candidate = $false } @{ sha256 = 'kit' } @{ sha256 = 'prereq' }
      $rc = Read-DrillJson $out.receipt
      [ordered]@{ conclusion = $out.conclusion; code = $out.code; reason = $out.reason; failedItems = @($out.failedItems); restored = $out.restored; receiptFailure = $rc.failure; receiptRestored = $rc.restoredToCheckpoint } }
    [ordered]@{ clean = (& $case $true $null $false); failed = (& $case $true 'A2' $false); machine = (& $case $true $null $true); restored = (& $case $false $null $false) }`);
  // every item passed, only the restore threw: the drill machine's code, no product reason, no failure invented in the receipt
  assert.deepEqual(r.clean, { conclusion: 'FAIL', code: 'DRILL_RESTORE_NOT_CONFIRMED', reason: null, failedItems: [], restored: false, receiptFailure: null, receiptRestored: false });
  // a product item failed and the restore threw: both show -- the code says the restore, the reason the item (section 7.3, row two)
  assert.deepEqual([r.failed.conclusion, r.failed.code, r.failed.reason, r.failed.failedItems, r.failed.restored], ['FAIL', 'DRILL_RESTORE_NOT_CONFIRMED', 'A2:broke', ['A2'], false]);
  // a drill failure of its own keeps its code even when the restore threw too
  assert.equal(r.machine.code, 'DRILL_GUEST_STEP_FAILED');
  // restored and every item passed: no code, no reason
  assert.deepEqual([r.restored.conclusion === 'FAIL', r.restored.code, r.restored.reason, r.restored.restored], [false, null, null, true]);
  // invariant: a FAIL line always has a code or a reason
  for (const k of ['clean', 'failed', 'machine']) assert.ok(r[k].code || r[k].reason, k);
});
