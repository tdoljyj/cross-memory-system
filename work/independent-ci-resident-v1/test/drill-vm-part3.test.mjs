// drill/drill-vm.ps1, offline, part 3 of 4. The tests of drill-vm.test.mjs, in their order and with their text, split by run time so no
// part holds a hosted shard past about 210 s (task 3435f8bf, block 2); the fixtures they share are drill-vm-fixtures.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fingerprintAppKey, fingerprintCiToken } from '../tools/secret-fingerprint.mjs';
import {
  script, powershell, tmp, sha, q, ps, psCode, opts, entryScript, entryPs, STEP_LOGS, m5DrillReceipt, RENEWAL_3BC571A6,
  notTheDrillsSource, S, L, PAUSE_REQUEST, evidence, verdictOf, pass, mockFleetTree, PROBE_FILES, bootBounds, secondsOf, probeNative,
  startedAt, readbackRow, readbackFor, finalize
} from './drill-vm-fixtures.mjs';

// Fable renew-key ruling, supplement "eight on the path", item 5: a successful launcher ends with its own pause confirmed, so A6 holds
// THAT pause (the request the launcher's terminal names, which state\PAUSED.json must name) with UNCERTAIN, no current batch, live 0 and
// no HALT. An idle executor is no longer a pass: the install did not keep its pause.
test('A6 holds the pause this install confirmed, read from the launcher result; idle is not a pass', opts, () => {
  const e = JSON.parse(evidence());
  const a6 = over => { const r = verdictOf(evidence(over)); return { pass: pass(r).A6, detail: r.items.find(i => i.id === 'A6').detail }; };
  const held = a6({});
  assert.equal(held.pass, true, held.detail);
  assert.match(held.detail, new RegExp(`pause=${PAUSE_REQUEST}`));
  for (const [reason, over] of [
    ['idle, as A6 used to want', { status: { ...e.status, executor: { state: 'IDLE' }, paused: false } }],
    ['the status view not paused', { status: { ...e.status, paused: false } }],
    ['the executor not resting paused', { status: { ...e.status, executor: { state: 'RUNNING' } } }],
    ['somebody else\'s pause', { pause: { ...e.pause, requestSha256: '8'.repeat(64) } }],
    ['no PAUSED.json', { pause: null }],
    ['the launcher did not confirm its pause', { launcher: { ...e.launcher, pause: { ...e.launcher.pause, confirmed: false } } }],
    ['no launcher result', { launcher: null }],
    ['neither side names a request', { launcher: { ...e.launcher, pause: { confirmed: true, requestSha256: null } }, pause: { requestSha256: null } }],
    ['a current batch', { status: { ...e.status, current: { batch: 'b1' } } }],
    ['a live queue', { status: { ...e.status, queue: { live: 1 } } }],
    ['a HALT', { status: { ...e.status, halt: { code: 'X' } } }],
    ['another mode', { status: { ...e.status, node: { mode: 'STANDBY' } } }],
  ]) assert.equal(a6(over).pass, false, reason);
});

// Supplement, risks taken in: A7 never passes on a self-check observed before this boot (a result of the boot before).
test('A7 needs the self-check observed after this boot, not only a status written after it', opts, () => {
  const e = JSON.parse(evidence());
  assert.equal(pass(verdictOf(evidence())).A7, true);
  const before = verdictOf(evidence({ reboot: { ...e.reboot, boot: '2026-11-16T02:55:00Z' } }));
  assert.equal(pass(before).A7, false);
  assert.match(before.items.find(i => i.id === 'A7').detail, /selfcheckAfterBoot=False/);
  const { boot, ...noBoot } = e.reboot;
  assert.equal(pass(verdictOf(evidence({ reboot: noBoot }))).A7, false, 'no boot time: not judged a pass');
});

// Codex review of 58136df61, high 1: the reboot read is restartable, so the guest can restart again between the first boot's self-check
// and the sample. Each sample carries the boot it was read in (the same guest call) and is judged against THAT boot, within the same
// window: a PASS the first boot left in a status the second boot rewrote is no pass; the second boot's own self-check is.
test('A7 judges each sample against the boot it was read in: a PASS left between two boots is no pass', opts, () => {
  const boot1 = '2026-11-16T02:40:00.0000000Z', boot2 = '2026-11-16T02:50:00.0000000Z';
  const status = (writtenAt, observedAt) => ({ writtenAt, node: { mode: 'UNCERTAIN' }, versions: { selfcheck: { result: 'PASS', observedAt } } });
  const between = { status: status('2026-11-16T02:51:00Z', '2026-11-16T02:45:00Z'), readAt: '2026-11-16T02:51:30Z', boot: boot2 };
  const fresh = { status: status('2026-11-16T02:56:00Z', '2026-11-16T02:55:00Z'), readAt: '2026-11-16T02:56:30Z', boot: boot2 };
  const wait = samples => ps(`
    $script:samples = New-Object Collections.Queue; foreach ($s in (${q(JSON.stringify(samples))} | ConvertFrom-Json)) { $script:samples.Enqueue($s) }
    function Invoke-DrillGuest { param($Credential, $Script, $ArgumentList, $TimeoutMinutes, $Code, $Step, [switch]$Restartable) if ($script:samples.Count -gt 1) { $script:samples.Dequeue() } else { $script:samples.Peek() } }
    function Start-Sleep { }
    Wait-DrillRebootRefresh $null ([DateTimeOffset]::Parse('${boot1}', [Globalization.CultureInfo]::InvariantCulture)) ([DateTimeOffset]::UtcNow.AddSeconds(2))`);
  const stuck = wait([between]);
  assert.equal(stuck.boot, boot2);
  assert.equal(stuck.bootChanged, true);
  assert.equal(pass(verdictOf(evidence({ reboot: stuck }))).A7, false, 'the first boot\'s PASS');
  const later = wait([between, fresh]);
  assert.equal(later.readAt, fresh.readAt);
  assert.equal(pass(verdictOf(evidence({ reboot: later }))).A7, true, 'the second boot\'s own self-check');
  // one boot, as before
  const once = wait([{ ...fresh, boot: boot1 }]);
  assert.equal(once.bootChanged, false);
  assert.equal(pass(verdictOf(evidence({ reboot: once }))).A7, true);
});

test('A8 fails with a missing launcher, a nonzero exit, or an unsuccessful terminal status despite passing reverify', opts, () => {
  const { reinstall } = JSON.parse(evidence());
  const { launcherExit, launcherStatus, launcherVerdict, ...withoutLauncher } = reinstall;
  for (const [reason, value] of [
    ['missing command', withoutLauncher],
    ['nonzero exit', { ...reinstall, launcherExit: 1 }],
    ['launcher refused', { ...reinstall, launcherStatus: 'PAUSE_NOT_CONFIRMED', launcherVerdict: 'BOOTSTRAP_LAUNCHER_ENDED' }],
    ['missing terminal status', { ...reinstall, launcherStatus: null, launcherVerdict: 'BOOTSTRAP_LAUNCHER_ENDED' }],
  ]) {
    const r = verdictOf(evidence({ reinstall: value }));
    assert.equal(pass(r).A8, false, reason);
    assert.equal(r.conclusion, 'FAIL', reason);
  }
});

test('A8 captures the current launcher exit and indented terminal JSON from the prepare command', opts, () => {
  const { tree, fleet } = mockFleetTree('a8-tree');
  const good = "ConvertTo-Json @{ status = 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED' }";
  const commands = [null, ' ', "ConvertTo-Json @{ status = 'PAUSE_NOT_CONFIRMED' }", `${good}; exit 4`, good];
  const r = ps(`
    $ErrorActionPreference = 'Stop'
    $cases = ConvertFrom-Json -InputObject ${q(JSON.stringify(commands.map(c => JSON.stringify(c))))}
    @($cases | ForEach-Object {
      [IO.File]::WriteAllText(${q(path.join(fleet, 'run-command.json'))}, $_)
      $up = & $script:GuestReinstallUpgrade ${q(process.execPath)} ${q(tree)} ${q(tmp)} ${q(tmp)} '1.2.3' $script:DrillNativeText
      $ri = & $script:GuestReinstall ${q(process.execPath)} ${q(tree)} ${q(tmp)} ${q(tmp)} '1.2.3' 'package.tar' 'acceptance.json' 'sha' $script:DrillNativeText $up
      @{ exit = $ri.launcherExit; status = $ri.launcherStatus; verdict = $ri.launcherVerdict; pass = (Test-DrillReinstallLauncher $ri);
        upgrade = $ri.upgradeStatus; prepare = $ri.prepareStatus; upgradeStderr = ([string]$ri.upgradeStderr).Trim(); prepareStderr = ([string]$ri.prepareStderr).Trim() }
    })`);
  const read = { upgrade: 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE', prepare: 'FLEET_NODE_INSTALL_PREPARED',
    upgradeStderr: 'upgrade: a note on stderr', prepareStderr: 'prepare: a note on stderr' };
  assert.deepEqual(r, [
    { exit: null, status: null, verdict: 'NOT_RUN_MISSING_RUN_COMMAND', pass: false, ...read },
    { exit: null, status: null, verdict: 'NOT_RUN_MISSING_RUN_COMMAND', pass: false, ...read },
    { exit: 0, status: 'PAUSE_NOT_CONFIRMED', verdict: 'BOOTSTRAP_LAUNCHER_ENDED', pass: false, ...read },
    { exit: 4, status: 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED', verdict: 'BOOTSTRAP_DONE', pass: false, ...read },
    { exit: 0, status: 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED', verdict: 'BOOTSTRAP_DONE', pass: true, ...read },
  ]);
  // the second prepare after the reinstall, the same way: its status, exit code and stderr all come back (Codex review of 58136df61, low 4)
  fs.writeFileSync(path.join(fleet, 'run-command.json'), 'null');
  const again = ps(`$ErrorActionPreference = 'Stop'; $p = & $script:GuestPrepareAgain ${q(process.execPath)} ${q(tree)} ${q(tmp)} ${q(tmp)} 'package.tar' 'acceptance.json' 'sha' $script:DrillNativeText
    [ordered]@{ status = $p.status; exit = $p.exit; stderr = ([string]$p.stderr).Trim() }`);
  assert.deepEqual(again, { status: 'FLEET_NODE_INSTALL_PREPARED', exit: 0, stderr: 'prepare: a note on stderr' });
  // and the run keeps them in reinstall.json beside the status
  assert.match(fs.readFileSync(script, 'utf8'), /\$reinstall\.prepareAgainExit = \$p2\.exit; \$reinstall\.prepareAgainStderr = \$p2\.stderr/);
});

// The drill's own children (the kit entry, verify, the A8 tools, root in the prerequisite distribution) are read like the package's
// Invoke-Native (windows/first-install-host.ps1): stdout and stderr apart; a stderr line is text, never a PowerShell error that ends the
// step under Stop. No merged stream is left in the drill.
// Codex review of 58136df61, medium 3: the prerequisite step's own children (the WSL MSI, wsl --version, wsl --install) are read the same
// way and kept in the facts, failure or not; wsl's own output is UTF-16LE (the package decodes wsl --version so: first-install-host.ps1).
// The children are a stand-in runner here: nothing is installed and wsl is never called.
test('the prerequisite step reads the MSI and wsl apart and keeps their output in the facts, on a refusal too', opts, () => {
  const text = fs.readFileSync(script, 'utf8');
  const block = text.slice(text.indexOf('$script:GuestPrereq = {'), text.indexOf('\n}', text.indexOf('$script:GuestPrereq = {')));
  assert.doesNotMatch(block, /Start-Process|& \$wslExe|\$LASTEXITCODE/);
  const dir = path.join(tmp, 'prereq-guest'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'wsl-msi.log'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('MSI (s) line 1\r\nProduct: Windows Subsystem for Linux -- Installation completed successfully.\r\n', 'utf16le')]));
  const fakeNative = `param([string]$Exe, [string[]]$Arguments, [int]$Seconds = 3600, [string]$Encoding = 'utf-8')
    $global:nativeCalls += ,([ordered]@{ exe = [IO.Path]::GetFileName($Exe); args = ($Arguments -join ' '); encoding = $Encoding })
    $a = $Arguments -join ' '
    if ($Exe -match 'msiexec') { return [ordered]@{ exit = $global:msiExit; stdout = ''; stderr = 'msi note' } }
    if ($a -ceq '--version') { return [ordered]@{ exit = 0; stdout = "WSL version: 2.7.13.0\`r\`nKernel version: 6.6\`r\`n"; stderr = '' } }
    if ($a -match '^--install') { return [ordered]@{ exit = 0; stdout = 'Installing'; stderr = 'install note' } }
    if ($a -match 'dpkg -i') { return [ordered]@{ exit = 0; stdout = "DPKG_EXIT=0\`nAUDIT=0\`n"; stderr = '' } }
    return [ordered]@{ exit = 0; stdout = "PRETTY_NAME=Ubuntu\`nsystemd\`nactive\`n"; stderr = '' }`;
  const run = msiExit => ps(`$global:nativeCalls = @(); $global:msiExit = ${msiExit}
    $f = & $script:GuestPrereq ${q(dir)} 'wsl.msi' 'rootfs.tar.gz' 'Ubuntu-Drill' '2.7.13.0' ${q(fakeNative)}
    [ordered]@{ facts = $f; calls = @($global:nativeCalls) }`);
  const ok = run(0);
  assert.equal(ok.facts.failure, null);
  assert.equal(ok.facts.wslVersion, 'WSL version: 2.7.13.0 Kernel version: 6.6');
  assert.deepEqual(ok.facts.msi.logTail.slice(-1), ['Product: Windows Subsystem for Linux -- Installation completed successfully.']);
  assert.equal(ok.facts.msi.stderr, 'msi note');
  assert.deepEqual({ exit: ok.facts.install.exit, stdout: ok.facts.install.stdout, stderr: ok.facts.install.stderr }, { exit: 0, stdout: 'Installing', stderr: 'install note' });
  assert.equal(ok.facts.dockerActive, true); assert.equal(ok.facts.systemdPid1, true);
  // wsl's own commands are decoded as UTF-16LE; root's Linux output as UTF-8
  assert.deepEqual(ok.calls.map(c => [c.exe, c.encoding]).slice(0, 3), [['msiexec.exe', 'utf-8'], ['wsl.exe', 'utf-16'], ['wsl.exe', 'utf-16']]);
  assert.ok(ok.calls.slice(3).every(c => c.exe === 'wsl.exe' && c.encoding === 'utf-8'));
  assert.match(ok.calls[0].args, /\/L\*v .*wsl-msi\.log$/);
  // a refused MSI: the facts still come back with its output and log, nothing after it runs, and the host stops by name after writing them
  const bad = run(1603);
  assert.equal(bad.facts.failure, 'PREREQ_WSL_MSI_EXIT_1603');
  assert.equal(bad.facts.msi.exit, 1603);
  assert.equal(bad.facts.msi.logTail.length, 2);
  assert.equal(bad.calls.length, 1);
  const runDir = path.join(tmp, 'prereq-run'); fs.mkdirSync(runDir, { recursive: true });
  const code = psCode(`function New-PSSession { 'session' }; function Invoke-Command { @() }; function Copy-Item { }; function Remove-PSSession { }
    function Get-Sha256Hex { 'x' }
    function Invoke-DrillGuest { [ordered]@{ failure = 'PREREQ_WSL_MSI_EXIT_1603'; msi = [ordered]@{ exit = 1603 } } }
    Invoke-DrillPrereqInGuest ${q(runDir)} @{ dir = 'unused'; wsl = 'wsl.msi'; rootfs = 'r'; debs = @(); distribution = 'd'; wslVersion = 'v' } $null`);
  assert.equal(code, 'DRILL_PREREQ_FAILED');
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'prereq-facts.json'), 'utf8')).msi.exit, 1603);
});

// Fable renew-key ruling, supplement "package branch, two points" (to the drill): firstInstallSteps come from complete stdout logs only
// (the entry's, the host preparation's, the launcher stage's); a stage result file keeps only the tail of the output (host-result.json: its
// last 6000 characters) and gives its verdict line, never steps. A stage that ran without its complete log is "incomplete", not "not run".
test('firstInstallSteps come from the complete stdout logs only; a stage result file gives its verdict line, never steps', opts, () => {
  const dir = path.join(tmp, 'steps-run'); fs.mkdirSync(dir, { recursive: true });
  const hostLines = Array.from({ length: 300 }, (_, i) => JSON.stringify({ name: `step-${String(i).padStart(3, '0')}`, result: 'ok' }));
  hostLines.push(JSON.stringify({ name: 'credentials', result: 'refused', rejectCode: 'CREDENTIAL_MISSING' }));
  hostLines.push(JSON.stringify({ status: 'HOST_PREPARATION_STOPPED', code: 'CREDENTIAL_MISSING', detail: 'one place only' }));
  const hostLog = hostLines.join('\r\n') + '\r\n';
  assert.ok(hostLog.length > 6000);
  fs.writeFileSync(path.join(dir, 'first-install.log'), JSON.stringify({ status: 'FIRST_INSTALL_STOPPED', stopCode: 'HOST_PREPARATION_NOT_DONE', tree: '', node: '' }) + '\r\n');
  fs.writeFileSync(path.join(dir, 'host.stdout.log'), hostLog);
  fs.writeFileSync(path.join(dir, 'stage-evidence.json'), JSON.stringify({ 'host-result.json': { exit: 1, terminal: { status: 'HOST_PREPARATION_STOPPED' }, stdoutTail: hostLog.slice(-6000) }, 'launcher-result.json': null }));
  const whole = ps(`Read-DrillFirstInstallSteps ${q(dir)}`);
  assert.equal(whole.steps.length, 301);
  assert.equal(whole.steps[0].name, 'step-000');
  assert.equal(whole.lastCompletedStep, 'step-299');
  assert.equal(whole.firstRejected, 'credentials');
  assert.deepEqual(whole.stageVerdicts, { host: 'HOST_PREPARATION_STOPPED', launcher: null });
  assert.equal(whole.verdict.status, 'FIRST_INSTALL_STOPPED');
  assert.deepEqual({ missing: whole.missing, incomplete: whole.incomplete }, { missing: false, incomplete: false });
  // the complete log gone: the tail in host-result.json is not read for steps; the record says incomplete
  fs.rmSync(path.join(dir, 'host.stdout.log'));
  const cut = ps(`Read-DrillFirstInstallSteps ${q(dir)}`);
  assert.equal(cut.steps.length, 0);
  assert.equal(cut.incomplete, true);
  assert.deepEqual(cut.incompleteStages, ['host']);
  assert.equal(cut.stageVerdicts.host, 'HOST_PREPARATION_STOPPED');
  // the entry writes the complete logs line by line beside the stage result files, and the drill takes them back into the run directory
  const entryText = fs.readFileSync(entryScript, 'utf8');
  assert.match(entryText, /\$hostRun = Invoke-EntryStreamedChild [\s\S]*?\(Join-Path \$Output 'host\.stdout\.log'\)/);
  assert.match(entryText, /\$prepared = Invoke-EntryStreamedChild [^\n]*\(Join-Path \$Output 'prepare\.stdout\.log'\)/);
  assert.match(entryText, /\$launcherResult = Join-Path \$Output 'launcher\.stdout\.log'/);
  assert.doesNotMatch(entryText, /WriteAllText\(\(Join-Path \$Output 'host\.stdout\.log'\)/);
  const drillText = fs.readFileSync(script, 'utf8');
  for (const n of ['host.stdout.log', 'prepare.stdout.log', 'launcher.stdout.log']) assert.ok(drillText.includes(`'${n}'`), n);
  // the receipt carries it under A1, and -Finalize keeps it (it rewrites A5 and A9 only)
  const receipt = m5DrillReceipt('steps-chain', RENEWAL_3BC571A6, { checker: 'PASS', missing: [] });
  const a1 = receipt.items.find(i => i.id === 'A1');
  assert.equal(a1.pass, true);
  assert.equal(a1.firstInstallSteps.missing, false);
  const fin = JSON.parse(finalize('steps-chain-finalize', receipt).bytes);
  assert.equal(fin.items.find(i => i.id === 'A1').firstInstallSteps.missing, false);
});

// Fable renew-key ruling, supplement "branch two, two points" 1 (the drill's side): the entry writes each stage child's stdout (the host
// preparation, prepare) to its log line by line as it comes, so a stage cut off at its limit leaves what it printed; the launcher stage's
// output file is launcher.stdout.log itself, read for whatever it holds.
test('the entry writes a stage child\'s stdout to its log line by line: a stage cut off at its limit leaves what it printed', opts, () => {
  const child = path.join(tmp, 'stage-child.ps1');
  fs.writeFileSync(child, "Write-Output '{\"name\":\"a\",\"result\":\"ok\"}'\nWrite-Output '{\"name\":\"b\",\"result\":\"ok\"}'\n" +
    "if ($args[0] -eq 'hang') { Start-Sleep -Seconds 15 }\n[Console]::Error.WriteLine('a note')\nWrite-Output '{\"status\":\"DONE\"}'\nexit 3\n");
  const log = path.join(tmp, 'stage-child.log');
  const cut = entryPs(`$r = Invoke-EntryStreamedChild ${q(powershell)} @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ${q(child)}, 'hang') 6 ${q(log)} @{} -NoWindow
    [ordered]@{ timedOut = $r.timedOut; status = $r.last.status }`);
  assert.deepEqual(cut, { timedOut: true, status: 'STAGE_CHILD_STILL_RUNNING' });
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split(/\r?\n/), ['{"name":"a","result":"ok"}', '{"name":"b","result":"ok"}']);
  const done = entryPs(`$r = Invoke-EntryStreamedChild ${q(powershell)} @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ${q(child)}, 'run') 60 ${q(log)} @{ CLUED_STREAM_TEST = '1' } -NoWindow
    [ordered]@{ timedOut = $r.timedOut; exit = $r.exit; stderr = ([string]$r.stderr).Trim(); lines = @($r.stdout.Trim() -split "\`r?\`n").Count }`);
  assert.deepEqual(done, { timedOut: false, exit: 3, stderr: 'a note', lines: 3 });
  assert.equal(fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).length, 3);
  // one deadline for every wait (Codex review of c1497e0a1, medium 1): a child that keeps printing past it is still a timeout, at once
  const flood = path.join(tmp, 'stage-flood.ps1');
  fs.writeFileSync(flood, "for ($i = 0; $i -lt 3000000; $i++) { [Console]::Out.WriteLine('{\"name\":\"x\",\"result\":\"ok\"}') }\n");
  const floodLog = path.join(tmp, 'stage-flood.log');
  const flooded = entryPs(`$clock = [Diagnostics.Stopwatch]::StartNew(); $r = Invoke-EntryStreamedChild ${q(powershell)} @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ${q(flood)}) 3 ${q(floodLog)} @{} -NoWindow
    [ordered]@{ timedOut = $r.timedOut; seconds = $clock.Elapsed.TotalSeconds }`);
  assert.equal(flooded.timedOut, true);
  assert.ok(flooded.seconds < 20, String(flooded.seconds));
  assert.match(fs.readFileSync(entryScript, 'utf8'), /if \(-not \$proc\.WaitForExit\(\(& \$left\)\)\) \{ return \(& \$timeout\) \}/);
  // the launcher stage's output file is this run's alone (Codex review of c1497e0a1, medium 2): an earlier one is cleared before the
  // stage, and one that cannot be cleared stops the entry by name
  const stale = path.join(tmp, 'launcher-stale.stdout.log');
  fs.writeFileSync(stale, JSON.stringify({ status: 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED' }) + '\r\n');
  entryPs(`Clear-EntryStageOutput ${q(stale)}; $true`);
  assert.equal(fs.existsSync(stale), false);
  fs.writeFileSync(stale, 'held');
  assert.equal(entryPs(`$h = New-Object IO.FileStream -ArgumentList ${q(stale)}, ([IO.FileMode]::Open), ([IO.FileAccess]::Read), ([IO.FileShare]::None)
    try { Clear-EntryStageOutput ${q(stale)}; 'cleared' } catch { $_.Exception.Message } finally { $h.Dispose() }`), 'DRILL_STAGE_OUTPUT_NOT_CLEARED:launcher-stale.stdout.log');
  assert.match(fs.readFileSync(entryScript, 'utf8'), /Clear-EntryStageOutput \$launcherResult\s+\$watch\.Restart\(\)\s+try \{ \$launch = Invoke-StageChild/);
  // the prepare log is one of the complete logs the step record is read from
  const dir = path.join(tmp, 'steps-prepare'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'prepare.stdout.log'), JSON.stringify({ name: 'rehearse', result: 'ok' }) + '\r\n');
  assert.deepEqual(ps(`$s = Read-DrillFirstInstallSteps ${q(dir)}; [ordered]@{ names = @($s.steps | ForEach-Object { $_.stage + ':' + $_.name }) }`).names, ['prepare:rehearse']);
});

// Codex review of 1cedea9ef, medium 2: "incomplete" is not only a missing file. A stage that ran (its result file or its log is there) is
// incomplete when its log is missing or empty, holds no step line (only its verdict), or ends without its verdict line ("the stage gave
// no verdict": cut off). Whatever the log holds is still read.
test('a stage that ran is incomplete when its log is missing, empty, holds only its verdict or ends without one', opts, () => {
  const dir = path.join(tmp, 'steps-incomplete'); fs.mkdirSync(dir, { recursive: true });
  const step = n => JSON.stringify({ name: n, result: 'ok' });
  const put = (name, text) => text === null ? fs.rmSync(path.join(dir, name), { force: true }) : fs.writeFileSync(path.join(dir, name), text);
  put('first-install.log', JSON.stringify({ status: 'FIRST_INSTALL_STOPPED', stopCode: 'X', tree: '', node: '' }) + '\r\n');
  const hostRan = JSON.stringify({ 'host-result.json': { exit: 1, terminal: { status: 'FIRST_INSTALL_HOST_REFUSED' } }, 'launcher-result.json': null });
  put('stage-evidence.json', hostRan);
  const read = () => ps(`Read-DrillFirstInstallSteps ${q(dir)}`);
  for (const [reason, hostLog, why] of [
    ['empty log', '', ['log-empty']],
    ['only the verdict line', JSON.stringify({ status: 'FIRST_INSTALL_HOST_REFUSED' }) + '\r\n', ['no-step-lines']],
    ['cut off: steps without a verdict line', [step('residue'), step('stage')].join('\r\n') + '\r\n', ['no-verdict']],
  ]) {
    put('host.stdout.log', hostLog);
    const r = read();
    assert.equal(r.incomplete, true, reason);
    assert.deepEqual(r.incompleteStages, ['host'], reason);
    assert.deepEqual(r.incompleteReasons.host, why, reason);
  }
  // what a cut-off log holds is read all the same, and the stage is named as one that gave no verdict
  const cut = read();
  assert.deepEqual(cut.steps.map(s => s.name), ['residue', 'stage']);
  assert.deepEqual(cut.noStageVerdict, ['host']);
  // the launcher stage timed out: no launcher-result.json, but its output file holds what it printed: read, and incomplete
  put('host.stdout.log', [step('stage'), JSON.stringify({ status: 'FIRST_INSTALL_HOST_READY' })].join('\r\n') + '\r\n');
  put('prepare.stdout.log', JSON.stringify({ status: 'FLEET_NODE_FIRST_INSTALL_PREPARED' }) + '\r\n');
  put('launcher.stdout.log', step('install') + '\r\n');
  const timedOut = read();
  assert.deepEqual(timedOut.incompleteStages, ['launcher']);
  assert.deepEqual(timedOut.noStageVerdict, ['launcher']);
  assert.ok(timedOut.steps.some(s => s.stage === 'launcher' && s.name === 'install'));
  // a stage that did not run at all is not incomplete
  put('launcher.stdout.log', null);
  assert.equal(read().incomplete, false);
});

// Codex review of c1497e0a1, high 2: the stage files are read with read-write sharing (a stage still writing holds its log open), file by
// file: one that cannot be read is named and the others are kept. The collection runs on every end of the first install (try/finally).
test('the stage files are read with read-write sharing, file by file, also while a writer holds one open', opts, () => {
  const work = path.join(tmp, 'stage-files-guest'); fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'prepare.stdout.log'), JSON.stringify({ status: 'FLEET_NODE_FIRST_INSTALL_PREPARED' }) + '\r\n');
  fs.writeFileSync(path.join(work, 'launcher-result.json'), JSON.stringify({ exit: 0, terminal: { status: 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED' } }));
  const hostLog = path.join(work, 'host.stdout.log'), launcherLog = path.join(work, 'launcher.stdout.log');
  const g = ps(`
    $w = New-Object IO.StreamWriter -ArgumentList ${q(hostLog)}, $false, (New-Object Text.UTF8Encoding($false)); $w.AutoFlush = $true; $w.WriteLine('{"name":"a","result":"ok"}')
    $lock = New-Object IO.FileStream -ArgumentList ${q(launcherLog)}, ([IO.FileMode]::Create), ([IO.FileAccess]::ReadWrite), ([IO.FileShare]::None)
    try { $r = & $script:GuestStageFiles ${q(work)} $script:DrillStageFiles } finally { $w.Dispose(); $lock.Dispose() }
    [ordered]@{ host = $r['host.stdout.log']; launcher = $r['launcher.stdout.log']; prepare = $r['prepare.stdout.log'].present; timings = $r['stage-timings.json'].present }`);
  assert.equal(g.host.text.trim(), '{"name":"a","result":"ok"}', 'read while its writer is still open');
  assert.equal(g.launcher.text, null);
  assert.ok(g.launcher.error, 'the locked one is named with its error');
  assert.deepEqual({ prepare: g.prepare, timings: g.timings }, { prepare: true, timings: false });
  // taken back into the run directory file by file: what could be read is saved, the rest is recorded
  const runDir = path.join(tmp, 'stage-files-run'); fs.mkdirSync(runDir, { recursive: true });
  const files = ps(`function Invoke-DrillGuest { param($Credential, $Script, $ArgumentList, $TimeoutMinutes, $Code, $Step) & $Script ${q(work)} $ArgumentList[1] }
    $lock = New-Object IO.FileStream -ArgumentList ${q(launcherLog)}, ([IO.FileMode]::Open), ([IO.FileAccess]::ReadWrite), ([IO.FileShare]::None)
    try { $c = Save-DrillStageEvidence ${q(runDir)} $null } finally { $lock.Dispose() }
    $c.record.files`);
  assert.deepEqual(['host.stdout.log', 'launcher.stdout.log', 'stage-timings.json', 'prepare.stdout.log'].map(n => files[n].state), ['saved', 'unreadable', 'absent', 'saved']);
  assert.ok(fs.existsSync(path.join(runDir, 'host.stdout.log')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'stage-evidence.json'), 'utf8'))['launcher-result.json'].terminal.status, 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED');
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'stage-files.json'), 'utf8')).files['launcher.stdout.log'].state, 'unreadable');
  // a collection that fails is recorded and throws nothing; it writes no stage-evidence.json or stage-timings.json from nothing, so an
  // emergency restore after it reads "not taken" (Codex review of e0a3cded5, medium 2)
  const failDir = path.join(tmp, 'stage-files-fail'); fs.mkdirSync(failDir, { recursive: true });
  assert.equal(ps(`function Invoke-DrillGuest { throw (New-DrillError 'DRILL_GUEST_STEP_FAILED') }; (Save-DrillStageEvidence ${q(failDir)} $null).record.collection.code`), 'DRILL_GUEST_STEP_FAILED');
  assert.deepEqual(fs.readdirSync(failDir), ['stage-files.json']);
  fs.writeFileSync(path.join(failDir, 'host-guard.json'), JSON.stringify({ status: 'DRILL_ABORTED', code: 'X', restoredToCheckpoint: true, cleanupDone: true }));
  assert.equal(ps(`(Get-DrillGuardOutcome ${q(failDir)}).evidence`), 'NOT_TAKEN');
  // a stage JSON cut short is named so, never "saved", and is not written as evidence
  const cutWork = path.join(tmp, 'stage-files-cut'), cutRun = path.join(tmp, 'stage-files-cut-run');
  fs.mkdirSync(cutWork, { recursive: true }); fs.mkdirSync(cutRun, { recursive: true });
  fs.writeFileSync(path.join(cutWork, 'host-result.json'), '{"exit":0,"term');
  const cut = ps(`function Invoke-DrillGuest { param($Credential, $Script, $ArgumentList, $TimeoutMinutes, $Code, $Step) & $Script ${q(cutWork)} $ArgumentList[1] }
    (Save-DrillStageEvidence ${q(cutRun)} $null).record.files`);
  assert.equal(cut['host-result.json'].state, 'unreadable-json');
  assert.equal(fs.existsSync(path.join(cutRun, 'stage-evidence.json')), false);
  // the first install's call collects them in its finally, so a timeout of that call still takes them back: after the merge of branch one,
  // through its evidence entry (Save-DrillGuestEvidence), which reads the stage files by Save-DrillStageEvidence
  const vmText = fs.readFileSync(script, 'utf8');
  assert.match(vmText, /\} finally \{\s*(#[^\n]*\s*)*\$collected = Save-DrillGuestEvidence \$RunDir \$Cred \$entryOut\s*\}/);
  assert.match(vmText, /function Save-DrillGuestEvidence\([^)]*\) \{[^]*?\$stage = Save-DrillStageEvidence \$RunDir \$Cred/);
  // the entry reads the launcher stage's file the same way
  assert.match(fs.readFileSync(entryScript, 'utf8'), /Get-LastJsonLine \(Read-EntrySharedText \$launcherResult\)/);
});

// Codex review of e0a3cded5, medium 1: the first install's result is kept on its own (entry-result.json) and A1 is formed from it even when
// a later step stops the run, so the receipt keeps the verdict the first install gave (here a restart with its installers' codes).
test('A1 is kept from the first install\'s own result when a later step stops the run', opts, () => {
  const root = path.join(tmp, 'a1-alone'); fs.mkdirSync(root, { recursive: true });
  const stop = 'RESTART_THEN_RUN_THE_SAME_COMMAND:{"status":"RESTART_THEN_RUN_THE_SAME_COMMAND","step":"tools","installers":[{"name":"gh","exit":3010}]}';
  const r = ps(`
    $script:Drill.Runs = ${q(root)}
    function Assert-DrillHost { @{ freeGB = 20 } }
    function Invoke-DrillWithHostHold { throw 'HOST_HOLD_MUST_NOT_RUN' }
    function Get-DrillIntakeTool { throw 'HOST_HOLD_MUST_NOT_RUN' }
    function Invoke-DrillBaseline { @{ action = 'reuse' } }
    $script:logs = ${q(JSON.stringify(STEP_LOGS))} | ConvertFrom-Json
    function Invoke-DrillOnCheckpoint { param($Body, $RunDir, $Window)
      foreach ($p in $script:logs.PSObject.Properties) { [IO.File]::WriteAllText((Join-Path $RunDir $p.Name), [string]$p.Value) }
      Write-DrillJson (Join-Path $RunDir 'entry-result.json') ([ordered]@{ exitCode = 1; status = 'FIRST_INSTALL_STOPPED'; stopCode = ${q(stop)}; tree = ''; node = ''; parsed = $true })
      @{ restored = $true; failure = @{ code = 'DRILL_GUEST_STEP_FAILED' }; result = $null; hostExecutorStates = @() } }
    $package = @{ version = '1.2.3'; tar = 'unused'; tarSha256 = ${q(S)}; ciSourceManifestSha256 = ${q(S)}; firstInstallKitSha256 = ${q(L)}; candidate = $false }
    $out = Invoke-DrillPreparedRun @{ holdUntil = [DateTimeOffset]::MinValue; deadline = [DateTimeOffset]::MaxValue } $package ([pscustomobject]@{ sha256 = 'fixture'; perNodeSteps = @() }) @{ sha256 = 'fixture' }
    $rc = Read-DrillJson $out.receipt
    [ordered]@{ conclusion = $rc.conclusion; ids = @($rc.items | ForEach-Object { $_.id }); a1 = @($rc.items)[0] }`);
  assert.equal(r.conclusion, 'FAIL');
  assert.deepEqual(r.ids, ['A1']);
  assert.equal(r.a1.pass, false);
  assert.ok(r.a1.detail.includes('"exit":3010'), r.a1.detail);
  assert.equal(r.a1.firstInstallSteps.missing, false);
  assert.match(fs.readFileSync(script, 'utf8'), /Write-DrillJson \(Join-Path \$RunDir 'entry-result\.json'\) \$entry/);
});

// Codex review of e0a3cded5, high 1: the entry reads the objects the package's own parser gives (bootstrap.ps1 Get-LastJsonLine: a
// JavaScriptSerializer Dictionary), not only hand-made ones: a ready host, a restart verdict with its step and installers' exit codes, a
// launcher terminal; the restart verdict reaches A1's detail as it is.
test('the entry reads the package parser\'s own objects: a ready host, a restart with its installers\' exit codes, a launcher terminal', opts, () => {
  const bootstrap = fileURLToPath(new URL('../rollout/fleet/bootstrap.ps1', import.meta.url));
  const restartLine = { status: 'RESTART_THEN_RUN_THE_SAME_COMMAND', why: 'gh installed', step: 'tools', installers: [{ name: 'gh', exit: 3010 }, { name: 'git-for-windows', exit: 8 }] };
  const r = entryPs(`. ${q(bootstrap)} -From ${q(tmp)}
    $ready = Get-LastJsonLine ${q(JSON.stringify({ name: 'stage', result: 'ok' }) + '\r\n' + JSON.stringify({ status: 'FIRST_INSTALL_HOST_READY' }))}
    $restart = Get-LastJsonLine ${q(JSON.stringify(restartLine))}
    # not $launcher: the dot-sourced bootstrap declares a [string] $Launcher parameter
    $terminal = Get-LastJsonLine ${q(JSON.stringify({ status: 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED', pause: { confirmed: true } }))}
    [ordered]@{ type = $ready.GetType().FullName; readyIsNull = ($null -eq (Get-EntryHostStopCode ([ordered]@{ exit = 0; last = $ready })));
      restart = (Get-EntryHostStopCode ([ordered]@{ exit = 3; last = $restart })); launcher = (Test-EntryStageVerdict $terminal); host = (Test-EntryStageVerdict $ready) }`);
  assert.match(r.type, /Dictionary/);
  assert.equal(r.readyIsNull, true);
  assert.match(r.restart, /^RESTART_THEN_RUN_THE_SAME_COMMAND:/);
  for (const piece of ['"step":"tools"', '"exit":3010', '"exit":8', '"why":"gh installed"']) assert.ok(r.restart.includes(piece), piece);
  assert.deepEqual({ launcher: r.launcher, host: r.host }, { launcher: true, host: true });
  // the entry's result line with that stop code, read by the drill, gives A1 its detail as it is
  const entry = ps(`Read-DrillEntryResult @(([ordered]@{ status = 'FIRST_INSTALL_STOPPED'; stopCode = ${q(r.restart)}; tree = ''; node = '' } | ConvertTo-Json -Compress)) 1`);
  const a1 = verdictOf(evidence({ entry })).items.find(i => i.id === 'A1');
  assert.equal(a1.pass, false);
  assert.ok(a1.detail.includes('"exit":3010'), a1.detail);
});

// Codex review of c1497e0a1, high 3 (package 0a4abc6f2): a host preparation that takes -Kit gets the Release's first-install kit, copied and
// held to its pinned hash; an older one (no -Kit) is called as before. Fable, supplement "after the package branch" 3: the host
// preparation's own verdict -- a restart Windows asks for (gh 3010, Git 8), or a refusal -- reaches the entry's stop code as it is.
test('the entry gives -Kit to a host preparation that takes it, and carries the host\'s own verdict into its stop code', opts, () => {
  const takes = path.join(tmp, 'host-takes-kit.ps1'), older = path.join(tmp, 'host-older.ps1');
  fs.writeFileSync(takes, 'param([string]$Tree, [string]$CredentialDirectory, [string]$Kit, [switch]$Reset)\n');
  fs.writeFileSync(older, 'param([string]$Tree, [string]$CredentialDirectory, [switch]$Reset)\n');
  assert.deepEqual(entryPs(`@((Test-EntryHostTakesKit ${q(takes)}), (Test-EntryHostTakesKit ${q(older)}))`), [true, false]);
  const entryText = fs.readFileSync(entryScript, 'utf8');
  assert.match(entryText, /if \(Test-EntryHostTakesKit \$hostScript\) \{[\s\S]*?Copy-ToWork \(Join-Path \$Assets "\$prefix\.first-install-kit\.json"\) \$hostDir \$firstSums\["\$prefix\.first-install-kit\.json"\][\s\S]*?\$kitArgs = @\('-Kit', \$localKit\)/);
  assert.match(entryText, /'-CredentialDirectory', \$inputCredentials\) \+ \$kitArgs\)/);
  const stop = run => entryPs(`Get-EntryHostStopCode (${q(JSON.stringify(run))} | ConvertFrom-Json)`);
  const restart = stop({ exit: 3, last: { status: 'RESTART_THEN_RUN_THE_SAME_COMMAND', why: 'gh installed' } });
  assert.match(restart, /^RESTART_THEN_RUN_THE_SAME_COMMAND:/);
  assert.match(restart, /"why":"gh installed"/);
  const refused = stop({ exit: 1, last: { status: 'FIRST_INSTALL_HOST_REFUSED', code: 'GH_INSTALL_FAILED' } });
  assert.match(refused, /^HOST_PREPARATION_NOT_DONE:.*GH_INSTALL_FAILED/);
  assert.equal(entryPs(`$null -eq (Get-EntryHostStopCode (${q(JSON.stringify({ exit: 0, last: { status: 'FIRST_INSTALL_HOST_READY' } }))} | ConvertFrom-Json))`), true);
  assert.match(entryText, /\$hostStop = Get-EntryHostStopCode \$hostRun\s+if \(\$hostStop\) \{ throw \$hostStop \}/);
});

// Codex review of c1497e0a1, medium 4: "the stage gave no verdict" means one thing everywhere. A verdict is an object whose status is a
// non-empty string other than the package's own "no verdict" codes (STAGE_CHILD_PRINTED_NO_VERDICT: the stage shell speaks, its child did
// not; STAGE_GAVE_NO_VERDICT); a missing or empty log gives none either; the entry's stageGaveNoVerdict is read; prepare, which prints only
// its verdict, is cut off when its log does not end with one.
test('no verdict is read the same way in the entry and the receipt, the package\'s no-verdict codes and prepare included', opts, () => {
  const dir = path.join(tmp, 'steps-verdict'); fs.mkdirSync(dir, { recursive: true });
  const put = (name, text) => text === null ? fs.rmSync(path.join(dir, name), { force: true }) : fs.writeFileSync(path.join(dir, name), text);
  const lines = (...l) => l.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join('\r\n') + '\r\n';
  const read = () => ps(`Read-DrillFirstInstallSteps ${q(dir)}`);
  put('first-install.log', lines({ status: 'FIRST_INSTALL_STOPPED', stopCode: 'X', tree: '', node: '' }));
  put('host.stdout.log', lines({ name: 'stage', result: 'ok' }, { status: 'FIRST_INSTALL_HOST_READY' }));
  put('prepare.stdout.log', lines({ status: 'FLEET_NODE_FIRST_INSTALL_PREPARED' }));
  const evidenceWith = launcher => JSON.stringify({ 'host-result.json': { exit: 0, terminal: { status: 'FIRST_INSTALL_HOST_READY' } }, 'launcher-result.json': launcher });
  // prepare's log holding only its verdict is complete (prepare prints no step lines)
  put('stage-evidence.json', evidenceWith(null));
  assert.equal(read().incomplete, false);
  for (const [reason, launcherLog, launcherResult, why] of [
    ['an empty status is no verdict', lines({ name: 'install', result: 'ok' }, { status: '' }), null, 'no-verdict'],
    ['the package says its child printed none', lines({ name: 'install', result: 'ok' }, { status: 'STAGE_CHILD_PRINTED_NO_VERDICT', child: 'launcher', exit: 1 }), null, 'stage-reported-no-verdict:STAGE_CHILD_PRINTED_NO_VERDICT'],
    ['the package says the stage gave none', lines({ name: 'install', result: 'ok' }, { status: 'STAGE_GAVE_NO_VERDICT' }), null, 'stage-reported-no-verdict:STAGE_GAVE_NO_VERDICT'],
    ['an empty log', '', { exit: null, terminal: null, stageGaveNoVerdict: true }, 'log-empty'],
    ['no log, the entry saw no verdict', null, { exit: null, terminal: null, stageGaveNoVerdict: true }, 'log-missing'],
  ]) {
    put('launcher.stdout.log', launcherLog);
    put('stage-evidence.json', evidenceWith(launcherResult));
    const r = read();
    assert.deepEqual(r.noStageVerdict, ['launcher'], reason);
    assert.ok(r.incompleteReasons.launcher.includes(why), `${reason}: ${JSON.stringify(r.incompleteReasons.launcher)}`);
  }
  // the entry's stageGaveNoVerdict alone (its log ends with a verdict the entry did not see) is still no verdict
  put('launcher.stdout.log', lines({ name: 'install', result: 'ok' }, { status: 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED' }));
  put('stage-evidence.json', evidenceWith({ exit: null, terminal: null, stageGaveNoVerdict: true }));
  assert.deepEqual(read().noStageVerdict, ['launcher']);
  // prepare cut off: its log does not end with its verdict
  put('stage-evidence.json', evidenceWith(null)); put('launcher.stdout.log', null);
  put('prepare.stdout.log', '{"status":"FLE');
  const cut = read();
  assert.deepEqual(cut.noStageVerdict, ['prepare']);
  assert.deepEqual(cut.incompleteReasons.prepare, ['no-verdict']);
  // the entry's own test of a launcher terminal is the same rule
  assert.deepEqual(entryPs(`@(@{ status = 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED' }, @{ status = '' }, @{ status = 'STAGE_CHILD_PRINTED_NO_VERDICT' }, @{ status = 'STAGE_GAVE_NO_VERDICT' }, @{ name = 'x'; result = 'ok' }, $null) | ForEach-Object { Test-EntryStageVerdict $_ }`),
    [true, false, false, false, false, false]);
  assert.match(fs.readFileSync(entryScript, 'utf8'), /stageGaveNoVerdict = -not \(Test-EntryStageVerdict \$terminal\)/);
});

// Codex review of c1497e0a1, high 1: a later stage reached, or an entry that says done, says the earlier stages ran. An earlier stage
// with neither its log nor its result is then incomplete too (no-evidence), never skipped; A1 does not pass on it.
test('a stage a later one or a done entry says ran is incomplete without any evidence of it', opts, () => {
  const dir = path.join(tmp, 'steps-order'); fs.mkdirSync(dir, { recursive: true });
  const put = (name, text) => text === null ? fs.rmSync(path.join(dir, name), { force: true }) : fs.writeFileSync(path.join(dir, name), text);
  for (const [name, text] of Object.entries(STEP_LOGS)) put(name, text);
  assert.equal(ps(`(Read-DrillFirstInstallSteps ${q(dir)}).incomplete`), false);
  // the host preparation's log and result both gone, the launcher's kept, the entry done
  put('host.stdout.log', null);
  put('stage-evidence.json', JSON.stringify({ 'host-result.json': null, 'launcher-result.json': JSON.parse(STEP_LOGS['stage-evidence.json'])['launcher-result.json'] }));
  const r = ps(`Read-DrillFirstInstallSteps ${q(dir)}`);
  assert.equal(r.missing, false);
  assert.equal(r.incomplete, true);
  assert.deepEqual(r.incompleteStages, ['host']);
  assert.deepEqual(r.incompleteReasons.host, ['no-evidence']);
  assert.ok(r.noStageVerdict.includes('host'), 'no evidence is no verdict either (Codex review of e0a3cded5, low 1)');
  // prepare's log gone as well: both earlier stages are named
  put('prepare.stdout.log', null);
  assert.deepEqual(ps(`(Read-DrillFirstInstallSteps ${q(dir)}).incompleteStages`), ['host', 'prepare']);
  // only the entry says done, no stage evidence at all: every stage is named
  put('launcher.stdout.log', null); put('stage-evidence.json', null);
  const bare = ps(`Read-DrillFirstInstallSteps ${q(dir)}`);
  assert.deepEqual(bare.incompleteStages, ['host', 'prepare', 'launcher']);
  // and A1 does not pass on such a record
  const a1 = verdictOf(evidence({ firstInstallSteps: r })).items.find(i => i.id === 'A1');
  assert.equal(a1.pass, false);
  assert.match(a1.detail, /steps=incomplete:host/);
});

// Codex review of 1cedea9ef, high 1: the step record is read first and A1 needs it: a first install whose steps cannot be shown (none
// parsed, or a stage that ran without its complete log) does not pass, and the receipt keeps why. Branch one (74e7a65e7) holds the same.
test('A1 needs a complete step record: missing, incomplete or absent is no pass, and the receipt says why', opts, () => {
  const a1 = over => { const r = verdictOf(evidence(over)); return { pass: pass(r).A1, detail: r.items.find(i => i.id === 'A1').detail }; };
  assert.equal(a1({}).pass, true);
  for (const [reason, steps, says] of [
    ['none parsed', { missing: true, incomplete: false, incompleteStages: [] }, /steps=missing/],
    ['a stage without its complete log', { missing: false, incomplete: true, incompleteStages: ['launcher'] }, /steps=incomplete:launcher/],
    ['no record at all', null, /steps=missing/],
  ]) {
    const r = a1({ firstInstallSteps: steps });
    assert.equal(r.pass, false, reason);
    assert.match(r.detail, says, reason);
  }
  // the real run: an entry that says done, every other item passing, but no logs in the run directory
  const noLogs = m5DrillReceipt('a1-no-logs', RENEWAL_3BC571A6, { checker: 'PASS', missing: [], candidate: true, steps: false });
  const item = noLogs.items.find(i => i.id === 'A1');
  assert.equal(item.pass, false);
  assert.match(item.detail, /steps=missing/);
  assert.equal(item.firstInstallSteps.missing, true);
  assert.equal(noLogs.conclusion, 'FAIL');
  assert.equal(finalize('a1-no-logs-finalize', noLogs, notTheDrillsSource()).output.code, 'DRILL_RECEIPT_NOT_FINALIZABLE');
});

// Fable renew-key ruling, supplement "interactive mode A1", second point, and Codex review of 1cedea9ef, medium 4: an emergency restore may
// come before the evidence was taken. Its outcome is written as it was: restored, restore failed or not recorded; evidence not taken,
// taken or partly taken (what the run directory holds). The host guard's outcome goes into the receipt; the boot watchdog, which acts
// only while the parent is gone (no receipt), leaves its own record beside the run (guest-shutdown.outcome.json).
test('an emergency restore is written as it ended: restored or not, evidence taken, partly taken or not', opts, () => {
  const outcome = (name, guard, files = []) => {
    const dir = path.join(tmp, `guard-${name}`); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'host-guard.json'), JSON.stringify({ status: 'DRILL_ABORTED', code: 'DRILL_HOST_CI_BUSY', ...guard }));
    for (const f of files) {
      if (f === 'm5' || f === 'm5-empty') fs.mkdirSync(path.join(dir, 'm5'), { recursive: true });
      if (f === 'steps') { for (const [n, t] of Object.entries(STEP_LOGS)) fs.writeFileSync(path.join(dir, n), t); continue; }
      if (f === 'm5') for (const n of ['profile.json', 'system.json', 'resident.json', 'controller.json', 'companion.json', 'probe.json', 'record.json']) fs.writeFileSync(path.join(dir, 'm5', n), '{}');
      else if (f !== 'm5-empty') fs.writeFileSync(path.join(dir, f), '{}');
    }
    return ps(`Get-DrillGuardOutcome ${q(dir)}`);
  };
  const all = ['first-install.log', 'stage-evidence.json', 'read-after-install.json', 'read-after-reboot.json', 'm5'];
  const none = outcome('none', { restoredToCheckpoint: true, stopped: true, cleanupDone: true });
  assert.deepEqual({ note: none.note, restore: none.restore, evidence: none.evidence, code: none.code }, { note: '由守护紧急还原，证据未取', restore: 'RESTORED', evidence: 'NOT_TAKEN', code: 'DRILL_HOST_CI_BUSY' });
  const failed = outcome('failed', { restoredToCheckpoint: false, stopped: false, cleanupDone: true, cleanupFailure: { code: 'X' } }, ['first-install.log', 'stage-evidence.json']);
  assert.deepEqual({ note: failed.note, restore: failed.restore, evidence: failed.evidence, taken: failed.taken, failure: failed.cleanupFailure },
    { note: '守护紧急还原失败，证据部分已取', restore: 'RESTORE_FAILED', evidence: 'PARTIAL', taken: ['first-install.log', 'stage-evidence.json'], failure: { code: 'X' } });
  // the guard's record written before its cleanup and never after: the outcome is not known, and is not called a restore
  const unknown = outcome('unknown', { restoredToCheckpoint: false, stopped: false, cleanupFailure: null });
  assert.equal(unknown.restore, 'UNKNOWN');
  assert.equal(unknown.note, '守护紧急还原，结局未记下，证据未取');
  // the guard tripped late (during A7, A8 or M5): the evidence was taken
  const late = outcome('late', { restoredToCheckpoint: true, stopped: true, cleanupDone: true }, [...all, 'steps']);
  assert.deepEqual({ note: late.note, evidence: late.evidence }, { note: '由守护紧急还原，证据已取', evidence: 'TAKEN' });
  // Codex review of e0a3cded5, medium 2: the five files without the stage logs this run needed are not "all of it"
  const noLogs = outcome('no-logs', { restoredToCheckpoint: true, stopped: true, cleanupDone: true }, all);
  assert.deepEqual({ evidence: noLogs.evidence, stepsComplete: noLogs.stepsComplete }, { evidence: 'PARTIAL', stepsComplete: false });
  // Codex review of c1497e0a1, medium 3: an empty M5 directory is no evidence; a stage log alone is part of it, and is listed
  const emptyM5 = outcome('empty-m5', { restoredToCheckpoint: true, stopped: true, cleanupDone: true }, [...all.filter(f => f !== 'm5'), 'm5-empty']);
  assert.deepEqual({ evidence: emptyM5.evidence, notTaken: emptyM5.notTaken }, { evidence: 'PARTIAL', notTaken: ['m5'] });
  const logOnly = outcome('log-only', { restoredToCheckpoint: true, stopped: true, cleanupDone: true }, ['host.stdout.log']);
  assert.deepEqual({ evidence: logOnly.evidence, stageLogs: logOnly.stageLogs, note: logOnly.note }, { evidence: 'PARTIAL', stageLogs: ['host.stdout.log'], note: '由守护紧急还原，证据部分已取' });
  // the guard writes whether its cleanup ran
  assert.match(fs.readFileSync(script, 'utf8'), /\$receipt\.cleanupDone = \$true/);

  // the boot watchdog's record, at both of its restores
  const signal = path.join(tmp, 'watchdog-run', 'guest-shutdown'); fs.mkdirSync(path.dirname(signal), { recursive: true });
  const w = ps(`Write-DrillWatchdogOutcome ${q(signal)} 'PARENT_GONE' $true; Read-DrillJson ${q(signal + '.outcome.json')}`);
  assert.deepEqual({ status: w.status, why: w.why, restore: w.restore, evidence: w.evidence, note: w.note },
    { status: 'DRILL_WATCHDOG_RESTORE', why: 'PARENT_GONE', restore: 'RESTORED', evidence: 'NOT_TAKEN', note: '由开机看门进程紧急还原，证据未取' });
  assert.equal(ps(`Write-DrillWatchdogOutcome ${q(signal)} 'TIMER_NOT_ARMED_BY_DEADLINE' $false; (Read-DrillJson ${q(signal + '.outcome.json')}).note`), '开机看门进程紧急还原失败，证据未取');
  const text = fs.readFileSync(script, 'utf8');
  const watchdog = text.slice(text.indexOf('function Invoke-DrillBootWatchdog'), text.indexOf('\n}', text.indexOf('function Invoke-DrillBootWatchdog')));
  assert.equal([...watchdog.matchAll(/Write-DrillWatchdogOutcome \$Signal '(PARENT_GONE|TIMER_NOT_ARMED_BY_DEADLINE)'/g)].length >= 2, true);

  // the receipt carries both, as they ended, beside its own restoredToCheckpoint
  const root = path.join(tmp, 'guard-receipt'); fs.mkdirSync(root, { recursive: true });
  const r = ps(`
    $script:Drill.Runs = ${q(root)}
    function Assert-DrillHost { @{ freeGB = 20 } }
    function Invoke-DrillWithHostHold { throw 'HOST_HOLD_MUST_NOT_RUN' }
    function Get-DrillIntakeTool { throw 'HOST_HOLD_MUST_NOT_RUN' }
    function Invoke-DrillBaseline { @{ action = 'reuse' } }
    function Invoke-DrillOnCheckpoint { param($Body, $RunDir, $Window)
      Write-DrillJson (Join-Path $RunDir 'host-guard.json') ([ordered]@{ status = 'DRILL_ABORTED'; code = 'DRILL_HOST_CI_BUSY'; restoredToCheckpoint = $false; stopped = $false; cleanupDone = $true; cleanupFailure = @{ code = 'X' } })
      Write-DrillWatchdogOutcome (Join-Path $RunDir 'guest-shutdown') 'TIMER_NOT_ARMED_BY_DEADLINE' $true
      @{ restored = $true; failure = @{ code = 'DRILL_HOST_CI_BUSY' }; result = $null; hostExecutorStates = @() } }
    $package = @{ version = '1.2.3'; tar = 'unused'; tarSha256 = ${q(S)}; ciSourceManifestSha256 = ${q(S)}; firstInstallKitSha256 = ${q(L)}; candidate = $false }
    $out = Invoke-DrillPreparedRun @{ holdUntil = [DateTimeOffset]::MinValue; deadline = [DateTimeOffset]::MaxValue } $package ([pscustomobject]@{ sha256 = 'fixture'; perNodeSteps = @() }) @{ sha256 = 'fixture' }
    $rc = Read-DrillJson $out.receipt
    [ordered]@{ conclusion = $rc.conclusion; restored = $rc.restoredToCheckpoint; guard = $rc.evidence.guardEmergencyRestore; watchdog = $rc.evidence.watchdogRestore }`);
  assert.equal(r.conclusion, 'FAIL');
  assert.equal(r.restored, true);
  assert.deepEqual({ note: r.guard.note, restore: r.guard.restore }, { note: '守护紧急还原失败，证据未取', restore: 'RESTORE_FAILED' });
  assert.equal(r.watchdog.note, '由开机看门进程紧急还原，证据未取');
  const normal = m5DrillReceipt('guard-normal', RENEWAL_3BC571A6);
  assert.equal(normal.evidence.guardEmergencyRestore, undefined);
  assert.equal(normal.evidence.watchdogRestore, undefined);
});

test('the drill reads its children with stdout and stderr apart: a stderr line never stops a step', opts, () => {
  assert.doesNotMatch(fs.readFileSync(script, 'utf8'), /2>&1\s*\|\s*ForEach-Object/);
  const n = ps(`$ErrorActionPreference = 'Stop'
    $r = Invoke-DrillNative ${q(powershell)} @('-NoProfile', '-NonInteractive', '-Command', "[Console]::Error.WriteLine('to stderr'); Write-Output 'line one'; exit 3") 120
    $a = Invoke-DrillNative ${q(process.execPath)} @('-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'a "b" c', 'd\\', '', 'plain') 60
    [ordered]@{ exit = $r.exit; stdout = $r.stdout.Trim(); stderr = $r.stderr.Trim(); argv = $a.stdout.Trim() }`);
  assert.deepEqual({ ...n, argv: JSON.parse(n.argv) }, { exit: 3, stdout: 'line one', stderr: 'to stderr', argv: ['a "b" c', 'd\\', '', 'plain'] });

  // the kit entry: its last stdout line is the result; its stderr is kept apart
  const entry = path.join(tmp, 'native-entry.ps1');
  fs.writeFileSync(entry, "param([string]$Work)\n[Console]::Error.WriteLine('entry: a note on stderr')\n" +
    "Write-Output ('{\"status\":\"FIRST_INSTALL_DONE\",\"stopCode\":null,\"tree\":' + (ConvertTo-Json $Work) + ',\"node\":\"n\"}')\nexit 0\n");
  const e = ps(`$ErrorActionPreference = 'Stop'
    $o = & $script:GuestEntry ${q(entry)} @('-Work', 'C:\\drill\\work dir') 5 $script:DrillNativeText
    $r = Read-DrillEntryResult @($o.lines) ([int]$o.exit)
    [ordered]@{ status = $r.status; tree = $r.tree; exit = $r.exitCode; stderr = ([string]$o.stderr).Trim() }`);
  assert.deepEqual(e, { status: 'FIRST_INSTALL_DONE', tree: 'C:\\drill\\work dir', exit: 0, stderr: 'entry: a note on stderr' });

  // verify after the install, with state\PAUSED.json read beside it (A6)
  const root = path.join(tmp, 'native-read');
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  put('upgrade/current.json', JSON.stringify({ residentManifestSha256: 'abc' }));
  put('install/install-receipt.json', '{}');
  put('state/status.json', JSON.stringify({ paused: true }));
  const pausedText = JSON.stringify({ source: { requestSha256: PAUSE_REQUEST, reason: 'any' } });
  put('state/PAUSED.json', pausedText);
  put('resident/abc/windows/verify-resident.ps1', "param($ExpectedInstallReceiptSha256, $LinuxVersionFactsFile)\n" +
    "[Console]::Error.WriteLine('verify: a note on stderr')\nWrite-Output 'RESIDENT_VERIFIED'\nexit 0\n");
  const g = ps(`$ErrorActionPreference = 'Stop'; $g = & $script:GuestRead ${q(root)} $script:DrillNativeText
    [ordered]@{ verify = $g.verify.status; exit = $g.verify.exit; stderr = ([string]$g.verify.stderr).Trim(); pause = $g.pause }`);
  assert.deepEqual(g, { verify: 'RESIDENT_VERIFIED', exit: 0, stderr: 'verify: a note on stderr',
    pause: { sha256: sha(pausedText), requestSha256: PAUSE_REQUEST } });
  fs.rmSync(path.join(root, 'state', 'PAUSED.json'));
  assert.equal(ps(`$g = & $script:GuestRead ${q(root)} $script:DrillNativeText; $null -eq $g.pause`), true);
});

// r8 drill: the guest receives the plan after a remote round trip, where commands is an ArrayList, not an Array. The guard used to
// return null for it, so no command ran (DRILL_PROBE_NO_ANSWER after 8 seconds).
test('GuestInspect runs the commands of a plan that crossed the remote serialization', opts, () => {
  const r = ps(`$native = { param($exe, $argv, $secs, $enc) [pscustomobject]@{ exit = 0; stdout = ('ran:' + $argv[-1]); stderr = '' } }
    $plan = New-DrillProbePlan @([ordered]@{ id = 'one'; script = 'echo 1'; args = @('a') }, [ordered]@{ id = 'two'; script = 'echo 2'; args = @() }) 'C:\nowhere\wsl.exe'
    $back = [Management.Automation.PSSerializer]::Deserialize([Management.Automation.PSSerializer]::Serialize($plan, 4))
    $kind = $back['commands'].GetType().FullName
    $got = & $script:GuestInspect $back $native.ToString()
    [ordered]@{ kind = $kind; ids = @($got.commands | ForEach-Object { $_.id }); exits = @($got.commands | ForEach-Object { $_.exit }) }`);
  assert.notEqual(r.kind, 'System.Object[]', 'the round trip must not hand back an Array, or the test proves nothing');
  assert.deepEqual(r.ids, ['one', 'two']);
  assert.deepEqual(r.exits, [0, 0]);
});
test('the probe plan opens with guest-boot, bounded at 120 seconds of its own', opts, () => {
  const r = ps(`$c = @(Get-DrillProbeCommands ${PROBE_FILES})
    $plan = New-DrillProbePlan $c
    [ordered]@{ first = $plan.commands[0].id; seconds = $plan.commands[0].seconds; others = @($plan.commands | Select-Object -Skip 1 | Where-Object { $null -ne $_['seconds'] } | ForEach-Object { $_.id }); each = $plan.commandSeconds }`);
  assert.equal(r.first, 'guest-boot');
  assert.equal(r.seconds, 120);
  assert.deepEqual(r.others, [], 'every other command keeps the plan-wide bound');
  assert.equal(r.each, 30);
});

test('guest-boot takes the journal by boot with monotonic stamps, never --since, and reads the scene without systemctl', opts, () => {
  const s = ps(`(Get-DrillProbeCommands)[0].script`);
  assert.doesNotMatch(s, /--since|--until/, 'a wall-clock time would jump across a suspend');
  assert.match(s, /journalctl -b -1 -o short-monotonic\b/);
  assert.match(s, /journalctl -b 0 -o short-monotonic\b/);
  assert.match(s, /journalctl --list-boots/);
  for (const k of ['uptime=', 'private=', 'pid1=', 'mem=', 'psi=']) assert.ok(s.includes(k), k);
  assert.doesNotMatch(s, /systemctl|docker/, 'nothing that waits on systemd or docker');
  // each journal reading bounded apart and its failure only noted, so the next still runs
  assert.equal((s.match(/\btimeout [-\w ]*journalctl/g) || []).length, 3);
  assert.doesNotMatch(s, /&&|set -e/);
});
test('every guest-boot reading kills what ignores its TERM (timeout -k)', opts, () => {
  const b = bootBounds();
  assert.equal(b.length, 3);
  for (const x of b) assert.match(x, /^-k \d+s \d+s$/, x);
});

test('guest-boot\'s own bounds, kill grace included, end by 90 s, well inside its 120-second wsl bound', opts, () => {
  const b = bootBounds();
  assert.equal(b.length, 3);
  const total = b.reduce((sum, x) => sum + x.split(/\s+/).filter(t => t !== '-k').map(secondsOf).reduce((a, n) => a + n, 0), 0);
  assert.ok(Number.isFinite(total) && total <= 90, `inner bounds add up to ${total} s`);
  assert.ok(ps(`(Get-DrillProbeCommands)[0].seconds`) - total >= 30, 'at least 30 s left for the cold start and the /proc readings');
});
test('GuestInspect hands each command its own bound: 120 for guest-boot, the plan-wide one for the rest', opts, () => {
  const secs = path.join(tmp, 'probe-secs.txt');
  const r = ps(`$env:PROBE_SECS = ${q(secs)}; ${probeNative}
    $plan = New-DrillProbePlan @(Get-DrillProbeCommands ${PROBE_FILES}) 'C:\\nowhere\\wsl.exe'
    $back = [Management.Automation.PSSerializer]::Deserialize([Management.Automation.PSSerializer]::Serialize($plan, 4))
    $got = & $script:GuestInspect $back $native.ToString()
    [ordered]@{ n = @($got.commands).Count; first = @($got.commands)[0].id; exits = @($got.commands | ForEach-Object { $_.exit } | Sort-Object -Unique) }`);
  const got = fs.readFileSync(secs, 'utf8').trim().split('\n').map(Number);
  assert.equal(got.length, r.n);
  assert.equal(r.first, 'guest-boot');
  assert.deepEqual(got, [120, ...Array(r.n - 1).fill(30)], 'after the remote round trip too');
  assert.deepEqual(r.exits, [0]);
});

test('a guest-boot that times out counts toward maxTimeouts; the next timeout stops the rest', opts, () => {
  const secs = path.join(tmp, 'probe-secs-hang.txt');
  const r = ps(`$env:PROBE_SECS = ${q(secs)}; $env:PROBE_HANG = 'uptime=|sha256sum'; ${probeNative}
    $plan = New-DrillProbePlan @(Get-DrillProbeCommands ${PROBE_FILES}) 'C:\\nowhere\\wsl.exe'
    $got = & $script:GuestInspect $plan $native.ToString()
    @($got.commands | ForEach-Object { if ($_.error -like 'COMMAND_TIMEOUT*') { 'timeout' } elseif ($_.error) { $_.error } else { 'ok' } })`);
  assert.deepEqual(r.slice(0, 2), ['timeout', 'timeout'], 'guest-boot, then the file reading, run into their bounds');
  assert.ok(r.length > 3 && r.slice(2).every(x => x === 'PROBE_STOPPED_AFTER_TIMEOUTS'), 'no command is started after the second');
  assert.equal(fs.readFileSync(secs, 'utf8').trim().split('\n').length, 2);
});

test('-Finalize judges A5 and A9 from one read-only production read-back and rewrites the receipt', opts, () => {
  const sql = ps(`Get-DrillReadbackSql ${q(startedAt)}`);
  assert.match(sql, /ci_nodes_v1/); assert.match(sql, /binding_roles_v1/); assert.doesNotMatch(sql, /\b(insert|update|delete)\b\s/i);
  assert.equal(psCode(`Get-DrillReadbackSql ${q("x'; drop table t; --")}`), 'DRILL_STARTED_AT_REFUSED');
  const items = verdictOf(evidence()).items;
  const { receipt, receiptFile, status, output, bytes } = finalize('receipt', { items });
  assert.equal(status, 0);
  // failedItems and reason: the summary line names why a FAIL failed (Fable ruling 11-20 "first install r4" 5(b)); none here
  assert.deepEqual(output, { status: 'DRILL_FINALIZED', conclusion: 'PASS_A_PER_NODE_STEPS_REMAIN', failedItems: [], reason: null, receipt: receiptFile });
  const done = JSON.parse(bytes);
  assert.equal(done.items.find((i) => i.id === 'A9').pass, true);
  assert.equal(done.items.find((i) => i.id === 'A5').pass, true);
  // a touched production table or a Source that differs fails; a read-back of another drill is refused
  const v = (r, s = startedAt) => ps(`$rc = ${q(JSON.stringify(receipt))} | ConvertFrom-Json; $rb = ${q(JSON.stringify(readbackFor(r, s)))} | ConvertFrom-Json;
    @(Get-DrillProductionVerdict $rc $rb | ForEach-Object { $_.pass })`);
  assert.deepEqual(v({ ...readbackRow, roles_changed: 1 }), [true, false]);
  assert.deepEqual(v({ ...readbackRow, live_sources: [S, '6'.repeat(64)] }), [false, true]);
  assert.equal(psCode(`Get-DrillProductionVerdict (${q(JSON.stringify(receipt))} | ConvertFrom-Json) (${q(JSON.stringify(readbackFor(readbackRow, '2026-01-01T00:00:00Z')))} | ConvertFrom-Json)`), 'DRILL_READBACK_NOT_THIS_DRILL');
});

test('-Finalize refuses an unrestored or failed drill without rewriting the receipt', opts, () => {
  const items = verdictOf(evidence()).items;
  const cases = [
    { name: 'unrestored', fields: { restoredToCheckpoint: false, conclusion: 'FAIL' } },
    { name: 'unrestored-pending', fields: { restoredToCheckpoint: false } },
    { name: 'restore-unknown', fields: { restoredToCheckpoint: undefined } },
    { name: 'failed-run', fields: { failure: { code: 'DRILL_HOST_GUARD_FAILED' } } },
    { name: 'failed-verdict', fields: { conclusion: 'FAIL' } },
  ];
  for (const { name, fields } of cases) {
    const r = finalize(name, { items, ...fields });
    assert.equal(r.output.code, 'DRILL_RECEIPT_NOT_FINALIZABLE', JSON.stringify(r.output));
    assert.equal(r.status, 1);
    assert.equal(r.bytes, r.original);
  }
});

test('empty items and a missing A10 produce FAIL without an unexpected error', opts, () => {
  const items = verdictOf(evidence()).items;
  for (const [name, incomplete] of [['empty-items', []], ['missing-a10', items.filter(i => i.id !== 'A10')]]) {
    const r = finalize(name, { items: incomplete });
    assert.equal(r.output.conclusion, 'FAIL', JSON.stringify(r.output));
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.bytes).conclusion, 'FAIL');
  }
});

test('the drill without its inputs stops before touching anything', opts, () => {
  const run = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Version', '1.2.3'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 1);
  assert.equal(JSON.parse(run.stdout.trim()).code, 'DRILL_USAGE');
});

test('the guest-side fake credentials match the package fingerprint formulas and print no secret', opts, () => {
  const out = path.join(tmp, 'fake');
  const pub = ps(`New-DrillFakeCredentials ${q(out)} @('app-key.pem', 'ci-admission.token', 'resident-upgrade.token', 'public.json', 'companion-github.token')`);
  const ci = fs.readFileSync(path.join(out, 'ci-admission.token'), 'utf8');
  const up = fs.readFileSync(path.join(out, 'resident-upgrade.token'), 'utf8');
  const pem = fs.readFileSync(path.join(out, 'app-key.pem'), 'utf8');
  assert.match(ci, /^clued_bnd_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(ci, up);
  assert.equal(pub.ciTokenPinSha256, fingerprintCiToken(ci));
  assert.equal(pub.upgradeTokenFingerprint, fingerprintCiToken(up));
  assert.equal(pub.appPublicKeySha256Base64, fingerprintAppKey(pem));
  assert.match(pub.ciPrincipalBindingId, /^[0-9a-f-]{36}$/);
  const hostPublic = entryPs(`ConvertTo-FirstInstallPublic (${q(JSON.stringify(pub))} | ConvertFrom-Json)`);
  assert.equal(hostPublic.ciPrincipalBindingId, pub.ciPrincipalBindingId);
  assert.equal(hostPublic.ciPrincipalRoleRef, pub.ciPrincipalRoleRef);
  assert.equal(hostPublic.ciPrincipalQualificationRef, pub.ciPrincipalQualificationRef);
  assert.equal(hostPublic.heartbeatBindingId, '');
  // the companion GitHub classic token stand-in: the shape of a classic token, fake at a glance, generated and read in the guest only
  const gh = fs.readFileSync(path.join(out, 'companion-github.token'), 'utf8');
  assert.match(gh, /^ghp_[A-Za-z0-9]{36}$/);
  assert.match(gh, /^ghp_CLUEDDRILLFAKE/);
  assert.equal(pub.files.companionGithubToken, 'companion-github.token');
  const printed = JSON.stringify(pub);
  for (const secret of [ci, up, pem.split('\n')[1], gh]) assert.ok(!printed.includes(secret));
  assert.equal(psCode(`New-DrillFakeCredentials ${q(out)} @('public.json')`), 'DRILL_UNEXPECTED', 'never reuses a directory');
  // only the files asked for (the names the package declares and the drill gives); no list, nothing made; no companion token unless asked
  const some = path.join(tmp, 'fake-some');
  ps(`New-DrillFakeCredentials ${q(some)} @('ci-admission.token', 'public.json')`);
  assert.deepEqual(fs.readdirSync(some).sort(), ['ci-admission.token', 'public.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(some, 'public.json'), 'utf8')).files, { ciToken: 'ci-admission.token' });
  assert.equal(psCode(`New-DrillFakeCredentials ${q(path.join(tmp, 'fake-none'))}`), 'DRILL_UNEXPECTED');
  assert.equal(fs.existsSync(path.join(tmp, 'fake-none')), false);
});
