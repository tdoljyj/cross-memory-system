// drill/drill-vm.ps1, offline, part 4 of 4. The tests of drill-vm.test.mjs, in their order and with their text, split by run time so no
// part holds a hosted shard past about 210 s (task 3435f8bf, block 2); the fixtures they share are drill-vm-fixtures.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { drillKitManifest, prepareFrom, makeDrillKit } from '../drill/make-drill-kit.mjs';
import * as drillKit from '../drill/make-drill-kit.mjs';
import {
  windows, script, powershell, tmp, sha, q, PACKAGE_CREDENTIALS, CREDENTIAL_FILES_CONTRACT, credentialFilesJson, T0, ps, opts,
  idleHostStatus, entryScript, entryPs, firstInstallAssets, at, STEP_LOGS, DONE_ENTRY_OUT, m5DrillReceipt, decisionsOf, planOf, NOW,
  guestWorkDir, WSL_COLD_START, evidence, verdictOf, pass, EARLY_ENTRY_LOG, earlyHostLine, earlyStopRun, LADDER_VERSION, LADDER_KIT,
  ladderStubs, ladderReceipt, foregroundStop, ladderMain, entryAccepted, timelineOf, stoppedResult, rows, hostScript
} from './drill-vm-fixtures.mjs';

// Integration of branch one (evidence taken in the finally, the entry log) and this branch (the stage files read one by one, the step record
// parsed first, A1 and A6 judged on it): what the merged collection brings back is what A1 and A6 are judged on. Complete stage logs pass
// both; a stage log the guest no longer has leaves the record incomplete and A1 failed; the launcher result as collected binds A6's pause.
test('the merged collection feeds A1 and A6: complete logs pass, a missing stage log fails A1, the collected launcher result binds A6', opts, () => {
  const e = JSON.parse(evidence());
  const files = { 'first-install.stdout.log': STEP_LOGS['first-install.log'], 'host.stdout.log': STEP_LOGS['host.stdout.log'],
    'prepare.stdout.log': STEP_LOGS['prepare.stdout.log'], 'launcher.stdout.log': STEP_LOGS['launcher.stdout.log'],
    'host-result.json': JSON.stringify({ exit: 0, terminal: { status: 'FIRST_INSTALL_HOST_READY' } }),
    'launcher-result.json': JSON.stringify({ exit: 0, terminal: e.launcher }), 'wsl-cold-start.json': WSL_COLD_START, 'stage-timings.json': '{"host":1,"prepare":2,"launcher":3}' };
  const collect = (name, change = {}) => {
    const all = { ...files, ...change };
    const guest = guestWorkDir(`merged-${name}-guest`, Object.fromEntries(Object.entries(all).filter(([, t]) => t !== null)));
    const runDir = path.join(tmp, `merged-${name}`); fs.mkdirSync(runDir, { recursive: true });
    return ps(`
      function Invoke-DrillGuest { param($Credential, $Script, $ArgumentList, $TimeoutMinutes, $Code, $Step, [switch]$Restartable) & $Script ${q(guest)} $ArgumentList[1] }
      $c = Save-DrillGuestEvidence ${q(runDir)} $null ${DONE_ENTRY_OUT}
      @{ record = $c.record; launcher = $c.launcher; steps = (Read-DrillFirstInstallSteps ${q(runDir)}) }`);
  };
  const judged = c => { const r = verdictOf(evidence({ firstInstallSteps: c.steps, launcher: c.launcher })); return { ...pass(r), detail: Object.fromEntries(r.items.map(i => [i.id, i.detail])) }; };
  const full = collect('full');
  assert.equal(full.record.ok, true);
  assert.deepEqual(full.record.missing, []);
  assert.equal(full.steps.missing, false);
  assert.equal(full.steps.incomplete, false);
  assert.deepEqual(full.launcher, e.launcher);
  assert.equal(judged(full).A1, true, judged(full).detail.A1);
  assert.equal(judged(full).A6, true, judged(full).detail.A6);
  // the guest has no prepare log any more: named missing by the collection, the record incomplete, A1 failed
  const noPrepare = collect('no-prepare', { 'prepare.stdout.log': null });
  assert.ok(noPrepare.record.missing.includes('prepare.stdout.log'));
  assert.equal(noPrepare.record.ok, false);
  assert.equal(noPrepare.record.stageFiles['prepare.stdout.log'].state, 'absent');
  assert.deepEqual(noPrepare.steps.incompleteStages, ['prepare']);
  assert.equal(judged(noPrepare).A1, false);
  assert.match(judged(noPrepare).detail.A1, /steps=incomplete:prepare/);
  // the launcher result cut mid-write, or naming another pause: A6 does not pass on what was collected
  const cut = collect('cut-launcher', { 'launcher-result.json': '{"exit":0,"terminal":{"status":' });
  assert.equal(cut.record.stageFiles['launcher-result.json'].state, 'unreadable-json');
  assert.equal(cut.launcher, null);
  assert.equal(judged(cut).A6, false);
  const other = collect('other-pause', { 'launcher-result.json': JSON.stringify({ exit: 0, terminal: { ...e.launcher, pause: { ...e.launcher.pause, requestSha256: '8'.repeat(64) } } }) });
  assert.equal(judged(other).A6, false);
});

// Integration: the outer deadline (Invoke-DrillGuest's, or Invoke-DrillNative's own) can cut the first install off. The lines it printed are
// in the guest log as they came (branch one's streaming, kept in Invoke-DrillNative -Log), and the collection reads that log while the entry,
// never killed, still holds it open for writing (this branch's read-write sharing): the step record has what the entry got to.
test('a first install cut off by the deadline leaves its printed lines in the guest log, read back while the writer still holds it', opts, () => {
  const guest = path.join(tmp, 'merged-stream-guest'); fs.mkdirSync(guest, { recursive: true });
  const runDir = path.join(tmp, 'merged-stream'); fs.mkdirSync(runDir, { recursive: true });
  const log = path.join(guest, 'first-install.stdout.log');
  const child = path.join(tmp, 'merged-stream-child.ps1');
  fs.writeFileSync(child, `[Console]::Out.WriteLine('{"name":"prepare","result":"ok","rejectCode":null,"detail":null}'); [Console]::Out.Flush(); Start-Sleep -Seconds 6; [Console]::Out.WriteLine('late')`);
  const r = ps(`
    $started = [DateTime]::UtcNow
    $code = try { Invoke-DrillNative ${q(powershell)} @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ${q(child)}) 2 'utf-8' ${q(log)}; 'NO THROW' } catch { [string]$_.Exception.Message }
    $seconds = ([DateTime]::UtcNow - $started).TotalSeconds
    $w = [IO.File]::Open(${q(log)}, 'Append', 'Write', 'Read')
    try {
      function Invoke-DrillGuest { param($Credential, $Script, $ArgumentList, $TimeoutMinutes, $Code, $Step, [switch]$Restartable) & $Script ${q(guest)} $ArgumentList[1] }
      $c = Save-DrillGuestEvidence ${q(runDir)} $null $null
    } finally { $w.Dispose() }
    @{ code = $code; seconds = $seconds; record = $c.record; steps = (Read-DrillFirstInstallSteps ${q(runDir)}) }`);
  assert.equal(r.code, 'COMMAND_TIMEOUT_NOTHING_KILLED: powershell.exe');
  assert.ok(r.seconds < 5, `the deadline holds: ${r.seconds}`);
  assert.equal(r.record.entryLogError ?? null, null);
  assert.deepEqual(fs.readFileSync(path.join(runDir, 'first-install.log'), 'utf8').split(/\r?\n/).filter(Boolean),
    ['{"name":"prepare","result":"ok","rejectCode":null,"detail":null}']);
  assert.deepEqual(r.steps.steps.map(x => [x.stage, x.name]), [['entry', 'prepare']]);
  assert.equal(r.steps.noVerdict, true);
});

// Codex review of f33fc33e5, medium 2: guest-evidence.json's ok is judged after the per-file states are summed: anything absent, unreadable
// or not saved makes it false. A6 takes the launcher's verdict only from what was saved in the run directory and read back from there.
test('guest-evidence ok is false on any missing file, and A6 reads the launcher verdict only as saved and read back', opts, () => {
  const e = JSON.parse(evidence());
  const files = { 'first-install.stdout.log': STEP_LOGS['first-install.log'], 'host.stdout.log': STEP_LOGS['host.stdout.log'],
    'prepare.stdout.log': STEP_LOGS['prepare.stdout.log'], 'launcher.stdout.log': STEP_LOGS['launcher.stdout.log'],
    'host-result.json': JSON.stringify({ exit: 0, terminal: { status: 'FIRST_INSTALL_HOST_READY' } }),
    'launcher-result.json': JSON.stringify({ exit: 0, terminal: e.launcher }), 'wsl-cold-start.json': WSL_COLD_START, 'stage-timings.json': '{"host":1}' };
  const collect = (name, change = {}, failWrite = null) => {
    const guest = guestWorkDir(`r5-ok-${name}-guest`, Object.fromEntries(Object.entries({ ...files, ...change }).filter(([, t]) => t !== null)));
    const runDir = path.join(tmp, `r5-ok-${name}`); fs.mkdirSync(runDir, { recursive: true });
    const override = failWrite === null ? '' :
      `$orig = \${function:Write-DrillJson}; function Write-DrillJson([string]$Path, $Value) { if ($Path -like ${q('*' + failWrite)}) { throw 'disk full' }; & $orig $Path $Value }`;
    return ps(`
      ${override}
      function Invoke-DrillGuest { param($Credential, $Script, $ArgumentList, $TimeoutMinutes, $Code, $Step, [switch]$Restartable) & $Script ${q(guest)} $ArgumentList[1] }
      $c = Save-DrillGuestEvidence ${q(runDir)} $null ${DONE_ENTRY_OUT}
      @{ record = (Read-DrillJson (Join-Path ${q(runDir)} 'guest-evidence.json')); launcher = $c.launcher }`);
  };
  const full = collect('full');
  assert.equal(full.record.ok, true);
  assert.deepEqual(full.launcher, e.launcher);
  for (const [name, change, state] of [['absent', { 'prepare.stdout.log': null }, 'absent'], ['cut', { 'host-result.json': '{"exit":0,"term' }, 'unreadable-json']]) {
    const r = collect(name, change);
    assert.equal(r.record.ok, false, name);
    assert.ok(Object.values(r.record.stageFiles).some(f => f.state === state), name);
  }
  // the launcher result read, but stage-evidence.json never written: not saved, ok false, and no launcher verdict for A6
  const unsaved = collect('unsaved', {}, 'stage-evidence.json');
  assert.equal(unsaved.record.stageFiles['launcher-result.json'].state, 'not-saved');
  assert.equal(unsaved.record.ok, false);
  assert.equal(unsaved.launcher, null);
  assert.equal(pass(verdictOf(evidence({ launcher: unsaved.launcher }))).A6, false);
  // the run takes the launcher verdict from the collection's read-back, not from the collected object
  assert.match(fs.readFileSync(script, 'utf8'), /\$launcher = \$collected\.launcher/);
});

// Codex review of f33fc33e5, medium 3: gh and Git for Windows are prerequisites the package's bootstrap requires; the package's prerequisite
// manifest lacking either is refused by the builder and by the gate before boot -- a missing entry is never "nothing to check".
test('gh or Git for Windows missing from the package prerequisite manifest: no kit, no boot', opts, async () => {
  const f = firstInstallAssets('r5-tools-undeclared', { dropManifest: ['gh'] });
  const p = JSON.parse(fs.readFileSync(f.prereq, 'utf8'));
  fs.writeFileSync(f.prereq, JSON.stringify({ ...p, tools: p.tools.filter(t => t.path !== 'gh.msi') }));
  prepareFrom({ ...f, out: f.from });
  await assert.rejects(() => makeDrillKit(f), /DRILL_PREREQ_TOOL_NOT_DECLARED:gh/);
  assert.ok(!fs.existsSync(f.out));
  // the gate: a kit built on the full manifest, checked against a manifest without Git for Windows
  const g = firstInstallAssets('r5-tools-gate');
  prepareFrom({ ...g, out: g.from });
  await makeDrillKit(g);
  const fullFile = path.join(g.from, `fleet-node-${g.version}.prereq-manifest.json`);
  const full = JSON.parse(fs.readFileSync(fullFile, 'utf8'));
  const short = path.join(g.root, 'manifest-without-git.json');
  fs.writeFileSync(short, JSON.stringify({ ...full, items: full.items.filter(i => i.name !== 'git-for-windows') }));
  const gate = m => ps(`try { Assert-DrillKitToolsBound (Read-DrillKit ${q(g.out)}) ${q(m)}; 'bound' } catch { $c = Get-DrillCode $_; "$($c.code) $($c.detail)" }`);
  assert.equal(gate(fullFile), 'bound');
  assert.equal(gate(short), 'DRILL_PACKAGE_TOOL_NOT_DECLARED git-for-windows');
  // declared twice is no single declaration either
  const twice = path.join(g.root, 'manifest-gh-twice.json');
  fs.writeFileSync(twice, JSON.stringify({ ...full, items: [...full.items, full.items.find(i => i.name === 'gh')] }));
  assert.equal(gate(twice), 'DRILL_PACKAGE_TOOL_NOT_DECLARED gh');
});

// Codex review of f33fc33e5, medium 4: the kit's per-node steps register the stand-ins the drill actually makes and hands over -- every
// name of the required group and every optional name decided "give" -- from the one decision table both read.
test('the kit registers a stand-in step for every name the drill makes, required or optional, from the one decision table', opts, () => {
  const inputs = { payloads: { 'release-pins.json': Buffer.from('{}'), 'first-install-entry.ps1': Buffer.from('entry') },
    prereqBytes: Buffer.from('{"contract":"clued.drill.prereq/1"}\r\n') };
  const { companionToken, ...noCompanion } = PACKAGE_CREDENTIALS.required;
  const optionalCompanion = { required: noCompanion, optional: { ...PACKAGE_CREDENTIALS.optional, companionToken: 'companion-github.token' } };
  const steps = c => drillKitManifest({ ...inputs, credentials: c }).perNodeSteps;
  assert.equal(steps(optionalCompanion).length, 4, 'made and handed over as an optional name: registered');
  assert.match(steps(optionalCompanion)[3], /^陪伴 GitHub 经典令牌替身/);
  assert.equal(steps({ required: noCompanion, optional: PACKAGE_CREDENTIALS.optional }).length, 3);
  // the run makes the same names (its plan) from the same table: the table the run holds is the file the builder reads
  assert.ok(planOf(optionalCompanion).fake.includes('companion-github.token'));
  const table = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../drill/credential-decisions.json', import.meta.url)), 'utf8'));
  const held = decisionsOf();
  assert.deepEqual(Object.keys(held), Object.keys(table.decisions));
  for (const [name, d] of Object.entries(table.decisions)) {
    assert.equal(held[name].give, d.give, name);
    if (d.give) assert.equal(held[name].fake, d.fake, name); else assert.equal(held[name].reason, d.reason, name);
  }
  // a stand-in step is registered for exactly the names the plan makes that carry one
  for (const c of [PACKAGE_CREDENTIALS, optionalCompanion, { required: noCompanion, optional: PACKAGE_CREDENTIALS.optional }]) {
    const made = planOf(c).given.filter(n => table.decisions[n].perNodeStep);
    assert.deepEqual(steps(c).slice(3), made.map(n => table.decisions[n].perNodeStep));
  }
});

// Codex review of f33fc33e5, medium 5: after a successful same-package reinstall the re-verify runs the whole verdict; its input carries the
// launcher verdict and the pause (the same sources as the first install's A6), so strict mode does not stop it and prepare-again runs.
test('a successful same-package reinstall goes through the re-verify to prepare-again', opts, () => {
  const e = JSON.parse(evidence());
  const runDir = path.join(tmp, 'r5-a8-run'); fs.mkdirSync(runDir, { recursive: true });
  const guest = guestWorkDir('r5-a8-guest', { 'first-install.stdout.log': STEP_LOGS['first-install.log'], 'host.stdout.log': STEP_LOGS['host.stdout.log'],
    'prepare.stdout.log': STEP_LOGS['prepare.stdout.log'], 'launcher.stdout.log': STEP_LOGS['launcher.stdout.log'],
    'host-result.json': JSON.stringify({ exit: 0, terminal: { status: 'FIRST_INSTALL_HOST_READY' } }),
    'launcher-result.json': JSON.stringify({ exit: 0, terminal: e.launcher }), 'stage-timings.json': '{"host":1}' });
  const read = { status: e.status, current: e.current, facts: e.facts, pause: e.pause, verify: e.verify, readAt: e.now };
  const r = ps(`
    $script:steps = [Collections.Generic.List[string]]::new()
    $script:Interactive = $false; $SkipReinstall = $false
    function New-PSSession { param($VMName, $Credential) 'session' }
    function Remove-PSSession { param($Session) }
    function Copy-Item { param($LiteralPath, $Path, $Destination, $ToSession, [switch]$Recurse) }
    function Invoke-Command { param($Session, $ScriptBlock, $ArgumentList, $VMName, $Credential, [switch]$AsJob, $ErrorAction) if ($ArgumentList -is [string]) { if ($ArgumentList -like '*.tar') { 'ab' } else { @{ contract = 'x' } } } }
    function Wait-DrillGuest { param($Credential, $Minutes, $After) [DateTimeOffset]::UtcNow }
    function Wait-DrillRebootRefresh { param($Cred, $Boot, $Deadline) (${q(JSON.stringify(e.reboot))} | ConvertFrom-Json) }
    function Copy-DrillM5 { param($RunDir, $Cred) @{} }
    $read = ${q(JSON.stringify(read))} | ConvertFrom-Json
    function Invoke-DrillGuest { param($Credential, $Script, $ArgumentList, $TimeoutMinutes, $Code, $Step, [switch]$Restartable)
      $script:steps.Add($Step)
      if ($Step -ceq 'first-install') { return [ordered]@{ lines = @(${q(STEP_LOGS['first-install.log'].trim())}); exit = 0; stderr = '' } }
      if ($Step -ceq 'stage-files' -or $Step -ceq 'guest-evidence') { return (& $Script ${q(guest)} $ArgumentList[1]) }
      if ($Step -ceq 'read-after-install' -or $Step -ceq 'read-after-reinstall') { return $read }
      if ($Step -ceq 'reinstall-upgrade') { return [ordered]@{ exit = 0; stdout = '{"status":"FLEET_NODE_ALREADY_AT_THIS_PACKAGE"}'; stderr = '' } }
      if ($Step -ceq 'reinstall') { return @{ skipped = $false; upgradeStatus = 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE'; prepareStatus = 'FLEET_NODE_INSTALL_PREPARED'; launcherExit = 0; launcherVerdict = 'BOOTSTRAP_DONE' } }
      if ($Step -ceq 'prepare-again') { return @{ status = 'FLEET_NODE_INSTALL_PREPARED'; exit = 0; stderr = '' } }
      throw "unexpected step $Step"
    }
    $package = @{ version = '1.2.3'; files = @(); tar = 'C:/x/p.tar'; tarSha256 = 'ab'; acceptance = 'C:/x/a.json'; ciSourceManifestSha256 = ${q(e.acceptanceSource)} }
    $testKit = [pscustomobject]@{ dir = 'C:/kit'; entryFile = 'first-install-entry.ps1'; arguments = @('-Work', '{work}'); timeoutMinutes = 5; perNodeSteps = @(); prerequisiteMode = 'first-install-host'; credentials = (${q(JSON.stringify(PACKAGE_CREDENTIALS))} | ConvertFrom-Json) }
    $code = try { $run = Invoke-DrillRun ${q(runDir)} $package $testKit $null $null; 'done' } catch { $c = Get-DrillCode $_; "$($c.code) $($c.detail)" }
    $re = Join-Path ${q(runDir)} 'reinstall.json'
    # the final verdict as Invoke-DrillPreparedRun forms it from this run (6th review round, low 3)
    $a8 = if ($run) { $items = Get-DrillVerdict @{ now = [DateTimeOffset]::Parse($run.first.readAt); entry = $run.entry; launcher = $run.launcher; pause = $run.first.pause; verify = $run.first.verify; status = $run.first.status; current = $run.first.current; facts = $run.first.facts; acceptanceSource = $package.ciSourceManifestSha256; reboot = $run.reboot; reinstall = (Get-Prop $run 'reinstall'); skipReinstall = $false; kit = $testKit; candidate = $false; firstInstallSteps = (Read-DrillFirstInstallSteps ${q(runDir)}) }; @($items | Where-Object { $_.id -eq 'A8' })[0] } else { $null }
    @{ code = $code; steps = @($script:steps); reinstall = $(if (Test-Path -LiteralPath $re) { Read-DrillJson $re } else { $null }); a8 = $a8 }`);
  assert.equal(r.code, 'done');
  assert.ok(r.steps.includes('prepare-again'), JSON.stringify(r.steps));
  assert.equal(r.reinstall.reverifyPassed, true);
  assert.equal(r.reinstall.prepareAgainStatus, 'FLEET_NODE_INSTALL_PREPARED');
  // and the final A8 passes on it (6th review round, low 3)
  assert.equal(r.a8.pass, true, r.a8.detail);
  assert.match(r.a8.detail, /upgrade=FLEET_NODE_ALREADY_AT_THIS_PACKAGE .*reverify=True prepareAgain=FLEET_NODE_INSTALL_PREPARED/);
  // the re-verify's input carries the same launcher verdict and the pause read after the reinstall
  assert.match(fs.readFileSync(script, 'utf8'), /\$reVerdict = Get-DrillVerdict @\{[^\n]*launcher = \$launcher; pause = \$again\.pause/);
});

// Codex narrow review of 4190b0f8e, medium: A8's upgrade fetch can answer FLEET_NODE_UPGRADE_REFUSED with its code, and the prepare that
// follows can then reach its own 3600 s limit: the step throws and reinstall.json is never written. The upgrade runs as its own guest step;
// the host keeps its raw result (exit, status, code, stdout, stderr) in reinstall-upgrade.json before the next command starts, and the
// receipt carries it (evidence.reinstallUpgrade) beside the later failure: both can be traced from the receipt.
test('A8: an upgrade refused and then a prepare that times out -- both are kept, the refusal before the prepare starts', opts, () => {
  const e = JSON.parse(evidence());
  const runDir = path.join(tmp, 'a8-refused-then-timeout'); fs.mkdirSync(runDir, { recursive: true });
  const guest = guestWorkDir('a8-refused-guest', { 'first-install.stdout.log': STEP_LOGS['first-install.log'], 'host.stdout.log': STEP_LOGS['host.stdout.log'],
    'prepare.stdout.log': STEP_LOGS['prepare.stdout.log'], 'launcher.stdout.log': STEP_LOGS['launcher.stdout.log'],
    'host-result.json': JSON.stringify({ exit: 0, terminal: { status: 'FIRST_INSTALL_HOST_READY' } }),
    'launcher-result.json': JSON.stringify({ exit: 0, terminal: e.launcher }), 'stage-timings.json': '{"host":1}' });
  const read = { status: e.status, current: e.current, facts: e.facts, pause: e.pause, verify: e.verify, readAt: e.now };
  const refused = JSON.stringify({ status: 'FLEET_NODE_UPGRADE_REFUSED', code: 'UPGRADE_SAME_PACKAGE_REFUSED_FIXTURE', detail: 'fixture' });
  const r = ps(`
    $script:steps = [Collections.Generic.List[string]]::new()
    $script:Interactive = $false; $SkipReinstall = $false
    function New-PSSession { param($VMName, $Credential) 'session' }
    function Remove-PSSession { param($Session) }
    function Copy-Item { param($LiteralPath, $Path, $Destination, $ToSession, [switch]$Recurse) }
    function Invoke-Command { param($Session, $ScriptBlock, $ArgumentList, $VMName, $Credential, [switch]$AsJob, $ErrorAction) if ($ArgumentList -is [string]) { if ($ArgumentList -like '*.tar') { 'ab' } else { @{ contract = 'x' } } } }
    function Wait-DrillGuest { param($Credential, $Minutes, $After) Get-DrillTime }
    function Wait-DrillRebootRefresh { param($Cred, $Boot, $Deadline) (${q(JSON.stringify(e.reboot))} | ConvertFrom-Json) }
    function Copy-DrillM5 { param($RunDir, $Cred) @{} }
    $read = ${q(JSON.stringify(read))} | ConvertFrom-Json
    $script:upgradeFileAtPrepare = $null
    function Invoke-DrillGuest { param($Credential, $Script, $ArgumentList, $TimeoutMinutes, $Code, $Step, [switch]$Restartable)
      $script:steps.Add($Step)
      if ($Step -ceq 'first-install') { return [ordered]@{ lines = @(${q(STEP_LOGS['first-install.log'].trim())}); exit = 0; stderr = '' } }
      if ($Step -ceq 'stage-files' -or $Step -ceq 'guest-evidence') { return (& $Script ${q(guest)} $ArgumentList[1]) }
      if ($Step -ceq 'read-after-install') { return $read }
      if ($Step -ceq 'reinstall-upgrade') { return [ordered]@{ exit = 1; stdout = "fetching\`r\`n" + ${q(refused)} + "\`r\`n"; stderr = 'upgrade: refused' } }
      if ($Step -ceq 'reinstall') {
        $script:upgradeFileAtPrepare = Test-Path -LiteralPath (Join-Path ${q(runDir)} 'reinstall-upgrade.json')
        throw (New-DrillError 'DRILL_GUEST_STEP_FAILED' @{ step = 'reinstall'; message = 'COMMAND_TIMEOUT_NOTHING_KILLED: node.exe' })
      }
      throw "unexpected step $Step"
    }
    $package = @{ version = '1.2.3'; files = @(); tar = 'C:/x/p.tar'; tarSha256 = 'ab'; acceptance = 'C:/x/a.json'; ciSourceManifestSha256 = ${q(e.acceptanceSource)} }
    $testKit = [pscustomobject]@{ dir = 'C:/kit'; entryFile = 'first-install-entry.ps1'; arguments = @('-Work', '{work}'); timeoutMinutes = 5; perNodeSteps = @(); prerequisiteMode = 'first-install-host'; credentials = (${q(JSON.stringify(PACKAGE_CREDENTIALS))} | ConvertFrom-Json) }
    $failure = try { $null = Invoke-DrillRun ${q(runDir)} $package $testKit $null $null; $null } catch { Get-DrillCode $_ }
    @{ failure = $failure; steps = @($script:steps); atPrepare = $script:upgradeFileAtPrepare
      reinstallJson = (Test-Path -LiteralPath (Join-Path ${q(runDir)} 'reinstall.json')); evidence = (Read-DrillReinstallUpgradeEvidence ${q(runDir)}) }`);
  assert.deepEqual(r.steps.slice(-2), ['reinstall-upgrade', 'reinstall'], JSON.stringify(r.steps));
  assert.equal(r.atPrepare, true, 'the upgrade result is on the host before the next command starts');
  // the later failure, raw, as the receipt's failure
  assert.deepEqual(r.failure, { code: 'DRILL_GUEST_STEP_FAILED', detail: { step: 'reinstall', message: 'COMMAND_TIMEOUT_NOTHING_KILLED: node.exe' } });
  assert.equal(r.reinstallJson, false, 'the step that failed wrote nothing');
  // and the refusal before it, raw, as the receipt's evidence.reinstallUpgrade
  assert.deepEqual([r.evidence.exit, r.evidence.status, r.evidence.code, r.evidence.stderr], [1, 'FLEET_NODE_UPGRADE_REFUSED', 'UPGRADE_SAME_PACKAGE_REFUSED_FIXTURE', 'upgrade: refused']);
  assert.match(r.evidence.stdout, /FLEET_NODE_UPGRADE_REFUSED/);
  assert.deepEqual(ps(`@{ v = (Read-DrillReinstallUpgradeEvidence ${q(path.join(tmp, 'a8-no-such-run'))}) }`), { v: null }, 'no upgrade ran: nothing');
  // the receipt takes it from the run directory whatever the run's end
  assert.match(fs.readFileSync(script, 'utf8'), /\$evidence\.reinstallUpgrade = Read-DrillReinstallUpgradeEvidence \$runDir/);
});

// Codex review of f33fc33e5, low 1: the stage timings saved on their own are evidence taken too (an emergency restore after them only is
// "partly taken", not "not taken").
test('the emergency restore counts stage-timings.json saved on its own as evidence taken', opts, () => {
  const dir = path.join(tmp, 'r5-guard-timings'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'stage-timings.json'), '{"host":1}');
  const r = ps(`Get-DrillAbortEvidence ${q(dir)}`);
  assert.equal(r.evidence, 'PARTIAL');
  assert.equal(r.stageTimings, true);
});

// 6th round, low 1: the decision table is looked up the same way at both ends, the way the package's names are bound: by file name,
// ordinal and case-sensitive. A name the table spells otherwise is no decision at either end: the run refuses it, the kit registers nothing.
test('the decision table is looked up ordinally and case-sensitively at both ends', opts, () => {
  const inputs = { payloads: { 'release-pins.json': Buffer.from('{}'), 'first-install-entry.ps1': Buffer.from('entry') },
    prereqBytes: Buffer.from('{"contract":"clued.drill.prereq/1"}\r\n') };
  const respelt = { ...PACKAGE_CREDENTIALS, required: { ...PACKAGE_CREDENTIALS.required, companionToken: 'Companion-GitHub.token' } };
  assert.deepEqual(planOf(respelt), { code: 'DRILL_CREDENTIAL_REQUIRED_NOT_MADE', detail: 'Companion-GitHub.token' });
  assert.equal(drillKitManifest({ ...inputs, credentials: respelt }).perNodeSteps.length, 3);
  const optional = { ...PACKAGE_CREDENTIALS, optional: { heartbeatToken: 'CI-Node-Heartbeat.token' } };
  assert.deepEqual(planOf(optional), { code: 'DRILL_CREDENTIAL_OPTIONAL_UNDECIDED', detail: 'CI-Node-Heartbeat.token' });
  assert.equal(ps(`$script:DrillCredentialDecisions.Contains('Companion-GitHub.token')`), false);
  assert.equal(ps(`$script:DrillCredentialDecisions.Contains('companion-github.token')`), true);
});

// 6th round, low 2: the evidence summary decides ok after the launcher verdict is read back; a read-back that fails is recorded with its
// detail and makes ok false.
test('a launcher verdict saved but not read back is recorded and makes the evidence summary not ok', opts, () => {
  const e = JSON.parse(evidence());
  const guest = guestWorkDir('r6-readback-guest', { 'first-install.stdout.log': STEP_LOGS['first-install.log'], 'host.stdout.log': STEP_LOGS['host.stdout.log'],
    'prepare.stdout.log': STEP_LOGS['prepare.stdout.log'], 'launcher.stdout.log': STEP_LOGS['launcher.stdout.log'],
    'host-result.json': JSON.stringify({ exit: 0, terminal: { status: 'FIRST_INSTALL_HOST_READY' } }),
    'launcher-result.json': JSON.stringify({ exit: 0, terminal: e.launcher }), 'stage-timings.json': '{"host":1}' });
  const runDir = path.join(tmp, 'r6-readback'); fs.mkdirSync(runDir, { recursive: true });
  const r = ps(`
    $orig = \${function:Read-DrillJson}
    function Read-DrillJson([string]$Path) { if ($Path -like '*stage-evidence.json') { throw 'read back failed' }; & $orig $Path }
    function Invoke-DrillGuest { param($Credential, $Script, $ArgumentList, $TimeoutMinutes, $Code, $Step, [switch]$Restartable) & $Script ${q(guest)} $ArgumentList[1] }
    $c = Save-DrillGuestEvidence ${q(runDir)} $null $null
    @{ record = (Get-Content -Raw -LiteralPath (Join-Path ${q(runDir)} 'guest-evidence.json') | ConvertFrom-Json); launcher = $c.launcher }`);
  assert.equal(r.record.stageFiles['launcher-result.json'].state, 'saved');
  assert.equal(r.launcher, null);
  assert.equal(r.record.ok, false);
  assert.equal(r.record.launcherReadback.ok, false);
  assert.match(r.record.launcherReadback.error, /read back failed/);
});

// Fable renew-key ruling, supplement "where the credential list comes from" (7th review round): the list is data the package ships, read
// from the archive as it is. No list, another contract, not JSON, another shape, a name twice (in a group, across the two, or by case), a
// name that is no plain file name, an empty required group: no kit.
test('the shipped credential list is read as data: any list that is not exactly the two groups refuses the kit', async () => {
  const list = (c, contract = CREDENTIAL_FILES_CONTRACT) => JSON.stringify({ contract, ...c });
  for (const [reason, text] of [
    ['no list', null],
    ['another contract', list(PACKAGE_CREDENTIALS, 'clued.independent-ci.credential-files/2')],
    ['not JSON', '{"contract":'],
    ['a group missing', JSON.stringify({ contract: CREDENTIAL_FILES_CONTRACT, required: PACKAGE_CREDENTIALS.required })],
    ['a third key', JSON.stringify({ contract: CREDENTIAL_FILES_CONTRACT, ...PACKAGE_CREDENTIALS, extra: {} })],
    ['a group that is a list', JSON.stringify({ contract: CREDENTIAL_FILES_CONTRACT, required: ['a.token'], optional: {} })],
    ['a name twice in a group', list({ required: { a: 'a.token', b: 'a.token' }, optional: {} })],
    ['a name in both groups', list({ required: { a: 'a.token' }, optional: { b: 'a.token' } })],
    ['a name twice by case', list({ required: { a: 'a.token' }, optional: { b: 'A.TOKEN' } })],
    ['a key twice', `{"contract":"${CREDENTIAL_FILES_CONTRACT}","required":{"a":"a.token","a":"b.token"},"optional":{}}`],
    ['a name that is a path', list({ required: { a: '..\\a.token' }, optional: {} })],
    ['an empty required group', list({ required: {}, optional: {} })],
    // 8th review round, medium 2: keys of a group that differ by case only are the same key (as for file names)
    ['a key twice by case', list({ required: { a: 'a.token', A: 'b.token' }, optional: {} })],
    ['a top-level key twice by case', `{"contract":"${CREDENTIAL_FILES_CONTRACT}","required":{"a":"a.token"},"optional":{},"Optional":{}}`],
    // low 2: not UTF-8 (a bad byte in a key) is unreadable, never patched
    ['not UTF-8', Buffer.concat([Buffer.from(`{"contract":"${CREDENTIAL_FILES_CONTRACT}","required":{"a`), Buffer.from([0xff]), Buffer.from('":"a.token"},"optional":{}}')])],
    // low 3: Windows reserved device names and names a Win32 path would change
    ['a reserved device name', list({ required: { a: 'CON.txt' }, optional: {} })],
    ['a reserved device name, bare', list({ required: { a: 'nul' }, optional: {} })],
    ['a numbered device name', list({ required: { a: 'com1.token' }, optional: {} })],
    ['a name ending in a dot', list({ required: { a: 'a.token.' }, optional: {} })],
    // 9th review round, medium 1: allow-lists, not case rules -- a group's key ^[A-Za-z][A-Za-z0-9]*$, a file name
    // ^[A-Za-z0-9][A-Za-z0-9._-]*$ not ending in a dot; anything else, non-ASCII above all, is refused
    ['a key pair Windows PowerShell folds (Kelvin sign and k)', list({ required: { 'K': 'a.token', k: 'b.token' }, optional: {} })],
    ['a non-ASCII key', list({ required: { 'ı': 'a.token' }, optional: {} })],
    ['a key with a hyphen', list({ required: { 'app-key': 'a.token' }, optional: {} })],
    ['a key starting with a digit', list({ required: { '1a': 'a.token' }, optional: {} })],
    ['a key with a colon and a quote', list({ required: { a: 'a.token', ':"b': 'b.token' }, optional: {} })],
    ['a non-ASCII file name', list({ required: { a: 'ä.token' }, optional: {} })],
    ['a file name with a plus', list({ required: { a: 'a+b.token' }, optional: {} })],
    ['a file name with a tilde', list({ required: { a: 'a~b.token' }, optional: {} })],
    ['a file name starting with a dot', list({ required: { a: '.token' }, optional: {} })],
  ]) {
    const f = firstInstallAssets(`list-refused-${reason.replace(/\W+/g, '-')}`, { credentialFiles: text });
    prepareFrom({ ...f, out: f.from });
    await assert.rejects(() => makeDrillKit(f), /DRILL_PACKAGE_CREDENTIALS_UNREADABLE/, reason);
    assert.ok(!fs.existsSync(f.out), reason);
  }
  // inside the allow-lists every key and name reads; the package's own list is in them
  const plain = list({ required: { appKey: 'app-private-key.pem', a1: 'A-1_b.token' }, optional: { heartbeatToken: 'ci-node-heartbeat.token' } });
  const plainKit = firstInstallAssets('list-allowed', { credentialFiles: plain });
  prepareFrom({ ...plainKit, out: plainKit.from });
  await makeDrillKit(plainKit);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(plainKit.out, 'kit.json'), 'utf8')).credentials.required, { appKey: 'app-private-key.pem', a1: 'A-1_b.token' });
  // the one reader the gate calls prints the list and its bytes' hash
  const f = firstInstallAssets('list-cli');
  const tar = path.join(f.build, `fleet-node-${f.version}.tar`);
  assert.deepEqual(drillKit.credentialsOfTar(fs.readFileSync(tar)), { sha256: sha(credentialFilesJson()), credentials: { contract: CREDENTIAL_FILES_CONTRACT, ...PACKAGE_CREDENTIALS } });
  assert.equal(Object.hasOwn(drillKit, 'packageCredentials'), false, 'no PowerShell source is read any more');
});

// 7th review round, low 2: a launcher result read back without its terminal field is no successful read-back (the entry writes terminal:
// null itself when the stage gave no verdict, which is read back as it is).
test('a launcher result read back without its terminal field is recorded as a failed read-back', opts, () => {
  const e = JSON.parse(evidence());
  const files = { 'first-install.stdout.log': STEP_LOGS['first-install.log'], 'host.stdout.log': STEP_LOGS['host.stdout.log'],
    'prepare.stdout.log': STEP_LOGS['prepare.stdout.log'], 'launcher.stdout.log': STEP_LOGS['launcher.stdout.log'],
    'host-result.json': JSON.stringify({ exit: 0, terminal: { status: 'FIRST_INSTALL_HOST_READY' } }), 'wsl-cold-start.json': WSL_COLD_START, 'stage-timings.json': '{"host":1}' };
  const collect = (name, launcher) => {
    const guest = guestWorkDir(`r7-readback-${name}-guest`, { ...files, 'launcher-result.json': launcher });
    const runDir = path.join(tmp, `r7-readback-${name}`); fs.mkdirSync(runDir, { recursive: true });
    return ps(`
      function Invoke-DrillGuest { param($Credential, $Script, $ArgumentList, $TimeoutMinutes, $Code, $Step, [switch]$Restartable) & $Script ${q(guest)} $ArgumentList[1] }
      $c = Save-DrillGuestEvidence ${q(runDir)} $null ${DONE_ENTRY_OUT}
      @{ record = (Get-Content -Raw -LiteralPath (Join-Path ${q(runDir)} 'guest-evidence.json') | ConvertFrom-Json); launcher = $c.launcher }`);
  };
  const missing = collect('missing', JSON.stringify({ exit: 0 }));
  assert.equal(missing.record.launcherReadback.ok, false);
  assert.match(missing.record.launcherReadback.error, /terminal/);
  assert.equal(missing.record.ok, false);
  const none = collect('none', JSON.stringify({ exit: 1, terminal: null, stageGaveNoVerdict: true }));
  assert.equal(none.record.launcherReadback.ok, true);
  assert.equal(none.launcher, null);
  assert.equal(none.record.ok, true);
  const given = collect('given', JSON.stringify({ exit: 0, terminal: e.launcher }));
  assert.deepEqual(given.launcher, e.launcher);
  assert.equal(given.record.launcherReadback.ok, true);
});

// Task ce2e5c1a step 2 (FABLE-drill-vm-frozen-clock-20261121 §2): a fixture cannot reach the real time. A host status written
// without a time is written at T0, and every ps() snippet sees Get-DrillTime at T0 unless it defines its own, so a fixture built
// when this file loads reads the same, however long the tests before it ran.
test('fixtures cannot reach the real clock: a host status is written at T0', () => {
  assert.equal(JSON.parse(idleHostStatus()).writtenAt, T0);
});

test('fixtures cannot reach the real clock: ps() runs with Get-DrillTime fixed at T0, and a snippet may still set its own', opts, () => {
  assert.deepEqual(ps(`@((Get-DrillTime).ToString('o'), (& { function Get-DrillTime { [DateTimeOffset]'2026-11-20T00:00:00Z' }; (Get-DrillTime).ToString('o') }))`),
    ['2026-11-19T02:00:00.0000000+00:00', '2026-11-20T00:00:00.0000000+00:00']);
  // and the gate, judging by the seam, reads a status written without a time as fresh
  const r = ps(`$s = Test-DrillHostSafety ${q(idleHostStatus())} 64GB -Now (Get-DrillTime); @{ action = $s.action; code = $s.code }`);
  assert.deepEqual(r, { action: 'start', code: null });
});

// Fable 11-21 clock ruling §3: drill-vm.ps1 learns "now" only from Get-DrillTime, and these tests never read the real clock, so no
// assertion can depend on how much real time passed. The reads that predate the rule are pinned at exactly today's count: one more is
// red, and so is one fewer until the pin is lowered with it. Step 2 (task ce2e5c1a) took the JavaScript reads to 0 and the gate's
// default -Now to Get-DrillTime (wallClock 32 -> 31); what is left runs in PowerShell (a fixture that loads the script on its own, a
// real wait). The words are assembled so the scan does not count its own patterns.
test('the real clock is read only through Get-DrillTime; the reads that predate the rule are pinned at their count', () => {
  const word = (...parts) => parts.join('');
  const NOW = word('Utc', 'Now'), GET_DATE = word('Get-', 'Date'), SW = word('Stop', 'watch'), BARE_NOW = word('No', 'w');
  const count = (lines, re) => lines.flatMap((text, i) => [...text.matchAll(re)].map(() => lines.where?.[i] ?? i + 1));
  const over = (file, lines, kinds, pins, use) => {
    for (const [kind, re] of Object.entries(kinds)) {
      const at = count(lines, re);
      assert.ok(at.length <= pins[kind], `${file}: ${at.length} ${kind} reads, pinned at ${pins[kind]} (lines ${at.join(', ')}). ${use}`);
      assert.equal(at.length, pins[kind], `${file}: ${kind} reads went down to ${at.length}; lower the pin from ${pins[kind]} to ${at.length}.`);
    }
  };

  // Product side: the Get-DrillTime definition, and the two lines the guest runs on its own clock (no Get-DrillTime there); and the one
  // monotonic clock the running guard's release is spaced by (Decision f572ac5b's "at most every 2 minutes", which a wall clock step must
  // not shorten: independent review of a643c4b42, suggestion 2), defined once like Get-DrillTime and read only through it.
  const product = fs.readFileSync(script, 'utf8').split(/\r?\n/);
  const allowed = [`function Get-DrillTime { [DateTimeOffset]::${NOW} }`,
    `if ($when -le [DateTimeOffset]::${NOW}) { throw 'DRILL_RUN_TIMEOUT' }`,
    `$seconds = [Math]::Ceiling(($when - [DateTimeOffset]::${NOW}).TotalSeconds)`,
    `function Get-DrillMonotonicSeconds { [Diagnostics.${SW}]::GetTimestamp() / [double][Diagnostics.${SW}]::Frequency }`];
  const timerAt = product.indexOf('$script:GuestShutdownTimer = {');
  const timerEnd = product.indexOf('}', timerAt);
  assert.ok(timerAt >= 0 && timerEnd > timerAt, 'drill-vm.ps1 must hold $script:GuestShutdownTimer');
  for (const [i, line] of allowed.entries()) {
    const at = product.flatMap((text, n) => text.trim() === line ? [n] : []);
    assert.equal(at.length, 1, `drill-vm.ps1 must hold exactly one: ${line}`);
    if (i === 1 || i === 2) assert.ok(at[0] > timerAt && at[0] < timerEnd, `outside $script:GuestShutdownTimer: ${line}`);
  }
  over('drill-vm.ps1', product.map(text => allowed.includes(text.trim()) ? '' : text), {
    wallClock: new RegExp(String.raw`\[(?:System\.)?DateTime(?:Offset)?\]::(?:${NOW}|Now)\b`, 'gi'),
    [GET_DATE]: new RegExp(String.raw`\b${GET_DATE}\b`, 'gi'),
    [SW]: new RegExp(SW, 'gi'),
  }, { wallClock: 31, [GET_DATE]: 0, [SW]: 2 },
  'Read the time through Get-DrillTime; a budget becomes a deadline, (Get-DrillTime).AddSeconds(n), compared against Get-DrillTime.');

  // Test side: no read of the real clock at all. Fixture times are the constant 2026-11-19T02:00:00Z; a PowerShell snippet that needs
  // "now" calls Get-DrillTime (pinned with a stand-in where the value matters).
  // The test side is the four parts drill-vm.test.mjs was split into and the fixtures they share, pinned together (task 3435f8bf).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sides = fs.readdirSync(here).filter(n => /^drill-vm-(part\d+\.test|fixtures)\.mjs$/.test(n)).sort();
  assert.deepEqual(sides, ['drill-vm-fixtures.mjs', 'drill-vm-part1.test.mjs', 'drill-vm-part2.test.mjs', 'drill-vm-part3.test.mjs', 'drill-vm-part4.test.mjs']);
  const read = sides.map(n => fs.readFileSync(path.join(here, n), 'utf8').split(/\r?\n/));
  const tests = read.flat();
  tests.where = sides.flatMap((n, f) => read[f].map((_, i) => `${n}:${i + 1}`));
  over('drill-vm-*.mjs', tests, {
    newDate: new RegExp(String.raw`\bnew\s+Date\s*\(\s*\)`, 'g'),
    dateNow: new RegExp(String.raw`\bDate\.now\s*\(`, 'g'),
    [NOW]: new RegExp(String.raw`\b${NOW}\b`, 'gi'),
    dateTimeNow: new RegExp(String.raw`\]::${BARE_NOW}\b`, 'gi'),
    [GET_DATE]: new RegExp(String.raw`\b${GET_DATE}\b`, 'gi'),
    [SW]: new RegExp(SW, 'gi'),
  }, { newDate: 0, dateNow: 0, [NOW]: 10, dateTimeNow: 0, [GET_DATE]: 0, [SW]: 4 },
  'Use the constant 2026-11-19T02:00:00Z in fixtures and Get-DrillTime inside PowerShell snippets.');
  // The drill's machine-wide mutex names stay out of the tests (Fable clock-seam points ruling, point 5): fixtures use their own names.
  const mutexName = word('CluedFirst', 'InstallDrill');
  const named = tests.flatMap((text, i) => text.includes(mutexName) ? [tests.where[i]] : []);
  assert.deepEqual(named, [], `drill-vm-*.mjs names the drill's machine-wide mutex (lines ${named.join(', ')}); fixtures take their own names`);
});

// Fable clock-seam points ruling, point 5: the drill's named mutexes are machine-wide, so a test holding them refused a real drill on this
// host, and failed while one ran. Every fixture that loads drill-vm.ps1 swaps in names of this test run's own.
test('the fixtures never take the drill\'s machine-wide mutexes', opts, () => {
  const names = ps('@($script:Drill.HostMutex, $script:Drill.BootMutex)');
  assert.equal(names.length, 2);
  for (const name of names) assert.ok(/^Local\\/.test(name) && !/^Global\\/i.test(name), `a fixture holds the mutex ${name}`);
});

// Fable ruling 0e418483 (r6 Linux phase A) 4.2: the launcher stage always meets a cold WSL. Right before it, the entry shuts the guest's
// WSL down and lists what still runs; both answers, raw, are wsl-cold-start.json, which the drill takes into stage-evidence.json. A
// shutdown that fails stops the first install by name (the launcher would not run cold); the list is recorded as it came.
test('the entry shuts the guest WSL down right before the launcher stage and records what still runs', opts, () => {
  const text = fs.readFileSync(entryScript, 'utf8');
  const body = text.slice(text.indexOf('function Invoke-FirstInstallAccepted'), text.indexOf('function Invoke-FirstInstallEntry'));
  const prepared = body.indexOf("throw 'PREPARE_REFUSED'"), cold = body.indexOf('Invoke-EntryWslColdStart $Output'), launcher = body.indexOf("$launcherResult = Join-Path $Output 'launcher.stdout.log'");
  assert.ok(prepared > 0 && cold > prepared && launcher > cold, 'after prepare, before the launcher stage');
  assert.equal(body.split('Invoke-EntryWslColdStart').length, 2, 'once');
  assert.match(text, /function Invoke-EntryWslColdStart\(\[string\]\$Output, \[string\]\$LogDir, \[string\]\$WslExe = 'C:\\Program Files\\WSL\\wsl\.exe'\)/);
  const dir = path.join(tmp, 'wsl-cold'); fs.mkdirSync(dir, { recursive: true });
  const fake = path.join(dir, 'wsl.cmd'), calls = path.join(dir, 'calls.txt');
  fs.writeFileSync(fake, ['@echo off', '>>"%~dp0calls.txt" echo %*^|%WSL_UTF8%', 'if "%1"=="--shutdown" exit /b %FAKE_SHUTDOWN_EXIT%',
    'if "%1"=="--list" (', '  echo There are no running distributions.', '  exit /b 1', ')', 'exit /b 9', ''].join('\r\n'));
  const run = (name, shutdownExit) => {
    const out = path.join(dir, name); fs.mkdirSync(out, { recursive: true });
    if (fs.existsSync(calls)) fs.rmSync(calls);
    const thrown = entryPs(`$env:FAKE_SHUTDOWN_EXIT = '${shutdownExit}'; try { Invoke-EntryWslColdStart ${q(out)} ${q(dir)} ${q(fake)}; 'NO THROW' } catch { $_.Exception.Message }`);
    return { thrown, record: JSON.parse(fs.readFileSync(path.join(out, 'wsl-cold-start.json'), 'utf8')), calls: fs.readFileSync(calls, 'utf8').trim().split(/\r?\n/) };
  };
  const ok = run('ok', 0);
  assert.equal(ok.thrown, 'NO THROW');
  assert.deepEqual(ok.calls, ['--shutdown|1', '--list --running|1'], 'shutdown first, then the list; WSL_UTF8 set');
  assert.equal(ok.record.shutdown.exit, 0);
  assert.equal(ok.record.shutdown.timedOut, false);
  assert.equal(ok.record.runningAfter.stdout.trim(), 'There are no running distributions.');
  assert.equal(typeof ok.record.runningAfter.exit, 'number');
  assert.ok(!Number.isNaN(Date.parse(ok.record.at)));
  const failed = run('failed', 5);
  assert.equal(failed.thrown, 'DRILL_WSL_SHUTDOWN_FAILED:exit=5');
  assert.equal(failed.record.shutdown.exit, 5);
  assert.equal(failed.record.runningAfter.stdout.trim(), 'There are no running distributions.', 'recorded before the stop');
});

test('the drill takes wsl-cold-start.json into stage-evidence.json', opts, () => {
  const cold = { at: '2026-11-21T03:00:00Z', shutdown: { exit: 0, timedOut: false, stdout: '', stderr: '' }, runningAfter: { exit: 0, timedOut: false, stdout: '', stderr: '' } };
  const work = guestWorkDir('wsl-cold-guest', { 'wsl-cold-start.json': JSON.stringify(cold),
    'launcher-result.json': JSON.stringify({ exit: 0, terminal: { status: 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED' } }) });
  const runDir = path.join(tmp, 'wsl-cold-run'); fs.mkdirSync(runDir, { recursive: true });
  const files = ps(`function Invoke-DrillGuest { param($Credential, $Script, $ArgumentList, $TimeoutMinutes, $Code, $Step) & $Script ${q(work)} $ArgumentList[1] }
    (Save-DrillStageEvidence ${q(runDir)} $null).record.files`);
  assert.equal(files['wsl-cold-start.json'].state, 'saved');
  const evidence = JSON.parse(fs.readFileSync(path.join(runDir, 'stage-evidence.json'), 'utf8'));
  assert.deepEqual(evidence['wsl-cold-start.json'], cold);
  assert.equal(evidence['launcher-result.json'].terminal.status, 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED');
});

// Block A test 1: the entry never returns and its logs stop growing. Before: the run waited for the guard's deadline (70 minutes) and every
// stage file was not-collected. Now: the no-progress gate of the stage it is in (host: no growth for 10 minutes) stops it with
// DRILL_GUEST_NO_PROGRESS, the evidence is taken, and only then the checkpoint is restored.
test('block A 1: an entry that never returns with logs that stop growing ends at the stage gate, DRILL_GUEST_NO_PROGRESS, stage files taken', opts, () => {
  const host = [earlyHostLine(1), earlyHostLine(2)].join('\r\n') + '\r\n';
  const { r, runDir } = earlyStopRun('stall', { guest: { 'first-install.stdout.log': EARLY_ENTRY_LOG, 'host.stdout.log': host },
    fireAt: 4200 + 15, fireCode: 'DRILL_RUN_TIMEOUT', deadlineSeconds: 4200 });
  assert.equal(r.failure?.code, 'DRILL_GUEST_NO_PROGRESS', `stopped at ${r.now}s: ${JSON.stringify(r.failure)}; stage files ${JSON.stringify(r.stageFiles?.files)}`);
  assert.equal(r.failure.detail.stage, 'host');
  assert.equal(r.failure.detail.reason, 'stalled');
  const gate = ps('$script:Drill.ProgressGates.host.stallMinutes');
  assert.ok(r.now <= gate * 60 + 2 * 30, `stopped within one tick of the gate: ${r.now}s`);
  assert.equal(r.guard, null, 'no emergency restore');
  assert.ok(!r.events.includes('guard-restore'));
  assert.equal(r.stageFiles.files['host.stdout.log'].state, 'saved');
  assert.equal(fs.readFileSync(path.join(runDir, 'host.stdout.log'), 'utf8'), host);
  assert.equal(r.guestEvidence.code, null);
  assert.equal(r.events.at(-1), 'restore:True', 'restored after the evidence');
  const progress = JSON.parse(fs.readFileSync(path.join(runDir, 'guest-progress.json'), 'utf8'));
  assert.equal(progress.stop.reason, 'stalled');
  assert.equal(progress.stage, 'host');
});

// Block A test 2: the run reaches its deadline. Before: the guard restored first, then every evidence read stopped on Assert-DrillGuard
// (guardEmergencyRestore.evidence = NOT_TAKEN). Now: the foreground stops the evidence window before the guard's deadline, takes the
// evidence, and the run's own cleanup restores; the guard never fires.
test('block A 2: at the run deadline the foreground stops first, takes the evidence, then restores; no emergency restore', opts, () => {
  const lines = { 'first-install.stdout.log': EARLY_ENTRY_LOG, 'host.stdout.log': earlyHostLine(1) + '\r\n{"status":"FIRST_INSTALL_HOST_READY"}\r\n',
    'prepare.stdout.log': '{"status":"FLEET_NODE_INSTALL_PREPARED"}\r\n', 'launcher.stdout.log': '{"step":"launcher-start","result":"ok"}\r\n' };
  const grow = Array.from({ length: 20 }, (_, i) => [(i + 1) * 60, 'launcher.stdout.log', JSON.stringify({ step: `launcher-${i + 1}`, result: 'ok' })]);
  const { r } = earlyStopRun('deadline', { guest: lines, grow, fireAt: 1200 + 15, fireCode: 'DRILL_RUN_TIMEOUT', deadlineSeconds: 1200 });
  assert.equal(r.guard, null, 'emergency restore: ' + JSON.stringify(r.guard));
  assert.equal(r.failure.code, 'DRILL_RUN_TIMEOUT');
  assert.equal(r.failure.detail.by, 'foreground');
  assert.equal(ps('$script:Drill.EvidenceWindowMinutes'), 5);
  assert.equal(r.failure.detail.evidenceWindowMinutes, 5, 'a 20-minute run keeps the full window');
  assert.ok(r.now <= 1200 - 5 * 60, `the foreground stopped at ${r.now}s, the guard's deadline is 1200s`);
  assert.ok(!r.events.includes('guard-restore'));
  assert.equal(r.guestEvidence.code, null, JSON.stringify(r.guestEvidence));
  for (const n of ['host.stdout.log', 'prepare.stdout.log', 'launcher.stdout.log']) assert.equal(r.stageFiles.files[n].state, 'saved', n);
  const lastRead = r.events.findLastIndex(e => e.startsWith('read:'));
  const restore = r.events.indexOf('restore:True');
  assert.ok(lastRead >= 0 && restore > lastRead, 'evidence before the restore: ' + JSON.stringify(r.events.slice(-6)));
});

// Block A test 3: the guard aborts on short memory while the entry runs. Before: the run directory held no stage log at all. Now: the
// progress files pulled on the last tick before the abort are there, and the abort record says the evidence was partly taken.
test('block A 3: a memory abort while the entry runs leaves the logs pulled on the last tick before it', opts, () => {
  const grow = Array.from({ length: 40 }, (_, i) => [(i + 1) * 60, 'host.stdout.log', earlyHostLine(100 + (i + 1) * 60)]);
  const { r, runDir } = earlyStopRun('memory', { guest: { 'first-install.stdout.log': EARLY_ENTRY_LOG, 'host.stdout.log': earlyHostLine(1) + '\r\n' },
    grow, fireAt: 720, fireCode: 'DRILL_HOST_MEMORY_SHORT', deadlineSeconds: 4200 });
  assert.equal(r.failure.code, 'DRILL_HOST_MEMORY_SHORT');
  assert.ok(r.files.includes('host.stdout.log'), 'run directory: ' + JSON.stringify(r.files));
  const host = fs.readFileSync(path.join(runDir, 'host.stdout.log'), 'utf8');
  assert.ok(host.includes('host-step-760'), 'the line due at 660 s, pulled at the 690 s tick');
  assert.ok(!host.includes('host-step-820'), 'the line due at the abort itself is not claimed');
  assert.ok(r.files.includes('first-install.log'));
  assert.equal(r.guard.evidence, 'PARTIAL');
  assert.ok(r.guard.stageLogs.includes('host.stdout.log'));
});

// Block A test 4: the first install returns with a stop code. Before: the run still rebooted the guest (A7), ran the same-package reinstall
// (A8) and read M5. Now: those are not run and are recorded as blocked by A1; the evidence (read after the install) and the probes still run.
test('block A 4: a first install stopped with a code blocks A7, A8 and M5 (recorded, not run); evidence and probes still run', opts, () => {
  const runDir = fs.mkdtempSync(path.join(tmp, 'a1-blocked-'));
  const entryStop = JSON.stringify({ status: 'FIRST_INSTALL_STOPPED', stopCode: 'HOST_PREPARATION_NOT_DONE', tree: 'C:\\drill\\work\\tree', node: 'C:\\drill\\work\\node.exe' });
  const guest = guestWorkDir('a1-blocked-guest', { 'first-install.stdout.log': EARLY_ENTRY_LOG + entryStop + '\r\n', 'host.stdout.log': earlyHostLine(1) + '\r\n',
    'host-result.json': JSON.stringify({ exit: 1, terminal: { status: 'FIRST_INSTALL_HOST_STOPPED' } }), 'stage-timings.json': '{"host":1}' });
  const read = { status: { writtenAt: T0, node: { mode: 'UNCERTAIN' } }, current: null, facts: null, pause: null, verify: { status: 'NOT_RUN' }, readAt: T0 };
  const r = ps(`
    $script:steps = [Collections.Generic.List[string]]::new()
    $script:Interactive = $false; $SkipReinstall = $false
    function New-PSSession { param($VMName, $Credential) 'session' }
    function Remove-PSSession { param($Session) }
    function Copy-Item { param($LiteralPath, $Path, $Destination, $ToSession, [switch]$Recurse) }
    function Invoke-Command { param($Session, $ScriptBlock, $ArgumentList, $VMName, $Credential, [switch]$AsJob, $ErrorAction)
      if ($VMName) { $script:steps.Add('vm-command') }
      if ($ArgumentList -is [string]) { if ($ArgumentList -like '*.tar') { 'ab' } else { @{ contract = 'x' } } } }
    function Wait-DrillGuest { param($Credential, $Minutes, $After) $script:steps.Add('wait-guest'); Get-DrillTime }
    function Wait-DrillRebootRefresh { param($Cred, $Boot, $Deadline) $script:steps.Add('reboot-refresh'); [ordered]@{ ok = $false; status = $null; readAt = (Get-DrillTime).ToString('o'); boot = $Boot.ToString('o'); done = $false } }
    function Copy-DrillM5 { param($RunDir, $Cred) $script:steps.Add('m5'); @{ directory = 'm5'; missing = @(); collectionCode = 'FIXTURE_NOT_READ' } }
    $read = ${q(JSON.stringify(read))} | ConvertFrom-Json
    function Invoke-DrillGuest { param($Credential, $Script, $ArgumentList, $TimeoutMinutes, $Code, $Step, [switch]$Restartable, $Until, $Progress)
      $script:steps.Add($Step)
      if ($Step -ceq 'first-install') { return [ordered]@{ lines = @(${q(entryStop)}); exit = 1; stderr = '' } }
      if ($Step -ceq 'stage-files' -or $Step -ceq 'guest-evidence') { return (& $Script ${q(guest)} $ArgumentList[1]) }
      if ($Step -ceq 'read-after-install') { return $read }
      if ($Step -ceq 'reinstall-upgrade') { return [ordered]@{ exit = 0; stdout = '{"status":"FLEET_NODE_ALREADY_AT_THIS_PACKAGE"}'; stderr = '' } }
      if ($Step -ceq 'reinstall') { return @{ skipped = $false; upgradeStatus = 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE'; prepareStatus = 'FLEET_NODE_INSTALL_PREPARED'; launcherExit = 1; launcherVerdict = 'X' } }
      return $null
    }
    $package = @{ version = '1.2.3'; files = @(); tar = 'C:/x/p.tar'; tarSha256 = 'ab'; acceptance = 'C:/x/a.json'; ciSourceManifestSha256 = ('5' * 64) }
    $testKit = [pscustomobject]@{ dir = 'C:/kit'; entryFile = 'first-install-entry.ps1'; arguments = @('-Work', '{work}'); timeoutMinutes = 5; perNodeSteps = @(); prerequisiteMode = 'first-install-host'; credentials = (${q(JSON.stringify(PACKAGE_CREDENTIALS))} | ConvertFrom-Json) }
    $run = Invoke-DrillRun ${q(runDir)} $package $testKit $null $null
    $items = Get-DrillVerdict @{ now = [DateTimeOffset]::Parse($run.first.readAt); entry = $run.entry; launcher = $run.launcher; pause = $run.first.pause; verify = $run.first.verify; status = $run.first.status; current = $run.first.current; facts = $run.first.facts; acceptanceSource = $package.ciSourceManifestSha256; reboot = $run.reboot; reinstall = (Get-Prop $run 'reinstall'); skipReinstall = $false; kit = $testKit; candidate = $true; firstInstallSteps = (Read-DrillFirstInstallSteps ${q(runDir)}) }
    $m5 = Get-DrillM5Verdict ${q(runDir)} $run.m5
    @{ steps = @($script:steps); a1 = @($items | Where-Object { $_.id -eq 'A1' })[0]; a7 = @($items | Where-Object { $_.id -eq 'A7' })[0]; a8 = @($items | Where-Object { $_.id -eq 'A8' })[0]
       m5 = @{ result = $m5.result; detail = $m5.detail }; reboot = (Read-DrillJson (Join-Path ${q(runDir)} 'read-after-reboot.json')) }`);
  for (const s of ['vm-command', 'wait-guest', 'reboot-refresh', 'reinstall-upgrade', 'reinstall', 'm5']) assert.ok(!r.steps.includes(s), `${s} ran: ${JSON.stringify(r.steps)}`);
  for (const s of ['first-install', 'stage-files', 'guest-evidence', 'guest-probe', 'read-after-install', 'guest-probe-late']) assert.ok(r.steps.includes(s), `${s} did not run: ${JSON.stringify(r.steps)}`);
  assert.equal(r.a1.pass, false);
  assert.equal(r.a7.pass, false);
  assert.equal(r.a7.detail, 'DRILL_A7_BLOCKED_BY_A1');
  assert.deepEqual(r.reboot, { skipped: true, reason: 'DRILL_A7_BLOCKED_BY_A1' });
  assert.equal(r.a8.pass, false);
  assert.match(r.a8.detail, /upgrade=DRILL_A8_BLOCKED_BY_A1/);
  assert.deepEqual(r.m5, { result: 'FAIL', detail: 'DRILL_M5_BLOCKED_BY_A1' });
});

// Block A test 5 (the coordinator's 10-minute verification run, Owner 11-23): -RunTimeoutMinutes 10. The evidence window shrinks with the
// run (never zero or negative, never the whole run), the no-progress gates cannot stop the run before its own deadline does (a stalled
// host log: its 10-minute gate lies past the foreground's stop), and the deadline path takes the evidence first, then restores.
test('block A 5: a 10-minute run ends on the foreground deadline, evidence first, then restore; no gate fires before it', opts, () => {
  const host = earlyHostLine(1) + '\r\n';
  const { r, runDir } = earlyStopRun('ten', { guest: { 'first-install.stdout.log': EARLY_ENTRY_LOG, 'host.stdout.log': host },
    fireAt: 600 + 15, fireCode: 'DRILL_RUN_TIMEOUT', deadlineSeconds: 600 });
  assert.equal(r.guard, null, 'emergency restore: ' + JSON.stringify(r.guard));
  assert.equal(r.failure.code, 'DRILL_RUN_TIMEOUT', JSON.stringify(r.failure));
  assert.equal(r.failure.detail.by, 'foreground');
  const w = r.failure.detail.evidenceWindowMinutes;
  assert.ok(w > 0 && w < 10, `window ${w} min`);
  assert.equal(w, 3, '30% of 10 minutes');
  assert.ok(r.now <= 600 - w * 60 && r.now > 0, `stopped at ${r.now}s`);
  assert.ok(!r.events.includes('guard-restore'));
  assert.equal(r.guestEvidence.code, null);
  assert.equal(r.guestEvidence.entryLog, 'guest-log');
  assert.equal(r.stageFiles.files['host.stdout.log'].state, 'saved');
  assert.equal(fs.readFileSync(path.join(runDir, 'host.stdout.log'), 'utf8'), host);
  assert.equal(r.events.at(-1), 'restore:True');
  // the window over the whole -RunTimeoutMinutes range: 5..240
  const windows = ps('@(5, 6, 10, 16, 17, 70, 110, 240 | ForEach-Object { Get-DrillEvidenceWindowMinutes $_ })');
  assert.deepEqual(windows, [1.5, 1.8, 3, 4.8, 5, 5, 5, 5]);
});

// Block A test 6 (glass box, coordinator, Owner 11-23): a stage cut off half-way. The entry's own stage record -- written by the real
// first-install-entry.ps1 functions, one line as each stage starts and one as it ends -- holds four stages ended ok and the host stage
// started; the guard aborts on short memory while the host stage runs. The receipt's stage timeline (Get-DrillStageTimeline over the run
// directory, from the record pulled on the last tick before the abort) gives every finished stage its conclusion and marks the host stage
// as cut off in progress. A stage that ends on a stop keeps its code.
test('block A 6: a stage aborted half-way: the timeline has a conclusion for every finished stage and marks the current one cut off in progress', opts, () => {
  const entryOut = fs.mkdtempSync(path.join(tmp, 'stage-progress-entry-'));
  fs.writeFileSync(path.join(entryOut, 'host.stdout.log'), earlyHostLine(1) + '\r\n');
  entryPs(`$script:EntryStageOutput = ${q(entryOut)}
    foreach ($n in @('assets', 'prereq', 'unpack', 'check', 'host-inputs')) { Start-EntryStage $n }
    Start-EntryStage 'host' (Join-Path ${q(entryOut)} 'host.stdout.log'); $true`);
  const record = fs.readFileSync(path.join(entryOut, 'stage-progress.jsonl'), 'utf8');
  const lines = record.trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => `${l.stage}:${l.event}:${l.result}`), ['assets:start:running', 'assets:end:ok', 'prereq:start:running', 'prereq:end:ok',
    'unpack:start:running', 'unpack:end:ok', 'check:start:running', 'check:end:ok', 'host-inputs:start:running', 'host-inputs:end:ok', 'host:start:running']);
  for (const l of lines) for (const k of ['stage', 'startedAt', 'endedAt', 'result', 'code', 'tail']) assert.ok(k in l, `${k} in ${JSON.stringify(l)}`);

  const grow = Array.from({ length: 10 }, (_, i) => [(i + 1) * 60, 'host.stdout.log', earlyHostLine(100 + (i + 1) * 60)]);
  const { r } = earlyStopRun('cut', { guest: { 'first-install.stdout.log': EARLY_ENTRY_LOG, 'host.stdout.log': earlyHostLine(1) + '\r\n', 'stage-progress.jsonl': record },
    grow, fireAt: 300, fireCode: 'DRILL_HOST_MEMORY_SHORT', deadlineSeconds: 4200 });
  assert.equal(r.failure.code, 'DRILL_HOST_MEMORY_SHORT');
  assert.equal(r.timeline.source, 'stage-progress');
  assert.equal(r.timeline.abortedIn, 'host');
  // the host's own stage before the entry (copy-in) comes first; the entry's stages follow
  assert.deepEqual(r.timeline.stages.map(s => `${s.n}:${s.stage}:${s.result}`), ['1:copy-in:ok', '2:assets:ok', '3:prereq:ok', '4:unpack:ok', '5:check:ok', '6:host-inputs:ok', '7:host:aborted-in-progress']);
  assert.equal(r.timeline.stages[6].label, '进行中被中止');
  for (const s of r.timeline.stages.slice(0, 6)) assert.ok(s.startedAt && s.endedAt, JSON.stringify(s));

  // a stage that ended on a stop: its conclusion and code, then A1's own result
  entryPs(`$script:EntryStageOutput = ${q(entryOut)}; $script:EntryStageOpen = @{ stage = 'host'; startedAt = '2026-11-21T03:00:00Z'; log = (Join-Path ${q(entryOut)} 'host.stdout.log') }
    Stop-EntryStage 'failed' 'HOST_PREPARATION_NOT_DONE'; $true`);
  const runDir = fs.mkdtempSync(path.join(tmp, 'stage-timeline-stopped-'));
  fs.copyFileSync(path.join(entryOut, 'stage-progress.jsonl'), path.join(runDir, 'stage-progress.jsonl'));
  fs.writeFileSync(path.join(runDir, 'entry-result.json'), JSON.stringify({ exitCode: 1, status: 'FIRST_INSTALL_STOPPED', stopCode: 'HOST_PREPARATION_NOT_DONE', tree: '', node: '', parsed: true }));
  const t = ps(`Get-DrillStageTimeline ${q(runDir)}`);
  assert.equal(t.abortedIn, null);
  assert.deepEqual(t.stages.map(s => `${s.stage}:${s.result}:${s.code ?? ''}`), ['assets:ok:', 'prereq:ok:', 'unpack:ok:', 'check:ok:', 'host-inputs:ok:',
    'host:failed:HOST_PREPARATION_NOT_DONE', 'A1-entry-result:failed:HOST_PREPARATION_NOT_DONE']);
  assert.deepEqual(t.stages[5].tail, [earlyHostLine(1)]);
});

test('ladder 1: no earlier receipt of this version and kit: the first rung, 10 minutes; a given -RunTimeoutMinutes is not derived', opts, () => {
  // a receipt of another kit and one of another version, both of which would double: neither is this package's
  const other = ladderReceipt({ minutes: 20, failure: foregroundStop(20), stages: [['assets', 'ok'], ['prereq', 'aborted-in-progress']] });
  const { out } = ladderMain('first', [['20261123T010000Z-1.2.3-aaaaaaaa', { ...other, kitSha256: 'another-kit' }],
    ['20261123T020000Z-1.2.4-bbbbbbbb', { ...other, version: '1.2.4' }]]);
  assert.equal(out.holdMinutes, 10, JSON.stringify(out));
  assert.equal(out.runTimeoutMinutes, 10);
  assert.equal(out.ladder.rule, 'first');
  assert.equal(out.ladder.minutes, 10);
  assert.equal(out.ladder.basis, null);
  assert.equal(out.ladder.reached, null);
  const given = ladderMain('given', [], '$script:DrillRunTimeoutGiven = $true; $RunTimeoutMinutes = 30').out;
  assert.equal(given.holdMinutes, 30, JSON.stringify(given));
  assert.equal(given.ladder, null);
});

test('ladder 2: the earlier run has a failed stage: refused before the host hold, with the stage and its code', opts, () => {
  const failed = ladderReceipt({ minutes: 40, failure: { code: 'DRILL_FIRST_INSTALL_STOPPED', detail: null },
    stages: [['assets', 'ok'], ['prereq', 'ok'], ['unpack', 'ok'], ['check', 'ok'], ['host', 'failed', 'HOST_PREPARATION_NOT_DONE'], ['A1-entry-result', 'failed', 'HOST_PREPARATION_NOT_DONE']] });
  const { root, out } = ladderMain('failed', [['20261123T030000Z-1.2.3-cccccccc', failed]]);
  assert.equal(out.code, 'DRILL_LADDER_PREVIOUS_STAGE_FAILED', JSON.stringify(out));
  assert.equal(out.detail.stage, 'host');
  assert.equal(out.detail.code, 'HOST_PREPARATION_NOT_DONE');
  assert.equal(out.detail.receipt, path.join(root, '20261123T030000Z-1.2.3-cccccccc', 'receipt.json'));
});

test('ladder 3: stopped on the foreground deadline with the last stage cut off and every earlier one ok: twice the limit, at most the run ceiling; written into the receipt', opts, () => {
  const order = ['assets', 'prereq', 'unpack', 'check', 'host', 'prepare', 'launcher'];
  const cut = (minutes, upTo) => ladderReceipt({ minutes, failure: foregroundStop(minutes),
    stages: [...order.slice(0, upTo).map(s => [s, 'ok']), [order[upTo], 'aborted-in-progress']] });
  // the newest decides: an older failed run of the same package is behind it
  const older = ladderReceipt({ minutes: 10, failure: { code: 'X', detail: null }, stages: [['assets', 'failed', 'ASSET_HASH_MISMATCH']] });
  const { root, out } = ladderMain('double', [['20261123T010000Z-1.2.3-dddddddd', older], ['20261123T020000Z-1.2.3-eeeeeeee', cut(10, 1)]]);
  assert.equal(out.holdMinutes, 20, JSON.stringify(out));
  assert.equal(out.runTimeoutMinutes, 20);
  assert.equal(out.ladder.rule, 'doubled');
  assert.equal(out.ladder.previousMinutes, 10);
  assert.equal(out.ladder.basis, path.join(root, '20261123T020000Z-1.2.3-eeeeeeee', 'receipt.json'));
  assert.deepEqual(out.ladder.reached, { n: 2, stage: 'prereq', result: 'aborted-in-progress' });
  assert.equal(ladderMain('double-40', [['20261123T020000Z-1.2.3-ffffffff', cut(20, 4)]]).out.holdMinutes, 40);
  // 80 would be past the host hold's budget (Invoke-DrillWithHostHold refuses it): the ceiling
  const top = ladderMain('double-cap', [['20261123T020000Z-1.2.3-gggggggg', cut(40, 6)]]).out;
  assert.equal(top.holdMinutes, 70, JSON.stringify(top));
  assert.equal(top.ladder.rule, 'doubled-at-ceiling');
  assert.equal(top.ladder.ceiling, 70);
  // a stage in a state no timeline is written with ('running' is always closed as cut off): not lengthened
  const unclean = ladderReceipt({ minutes: 20, failure: foregroundStop(20), stages: [['assets', 'ok'], ['prereq', 'running'], ['unpack', 'aborted-in-progress']] });
  assert.equal(ladderMain('double-unclean', [['20261123T020000Z-1.2.3-hhhhhhhh', unclean]]).out.holdMinutes, 20);
  // this run's receipt carries its limit and the step it came from
  const receipt = m5DrillReceipt('ladder-receipt', [], { pre: `$script:DrillLadder = Get-DrillLadderStep ${q(root)} ${q(LADDER_VERSION)} ${q(LADDER_KIT)}; $RunTimeoutMinutes = $script:DrillLadder.minutes` });
  assert.equal(receipt.runTimeoutMinutes, 20);
  assert.equal(receipt.ladder.minutes, 20);
  assert.equal(receipt.ladder.basis, path.join(root, '20261123T020000Z-1.2.3-eeeeeeee', 'receipt.json'));
  assert.equal(receipt.ladder.reached.stage, 'prereq');
});

test('ladder 4: the earlier run passed: the same limit again, never longer', opts, () => {
  const passed = ladderReceipt({ minutes: 40, conclusion: 'PASS_A_FULL',
    stages: [['assets', 'ok'], ['prereq', 'ok'], ['unpack', 'ok'], ['check', 'ok'], ['host', 'ok'], ['prepare', 'ok'], ['wsl-cold-start', 'ok'], ['launcher', 'ok'], ['A1-entry-result', 'ok']] });
  const { out } = ladderMain('passed', [['20261123T040000Z-1.2.3-iiiiiiii', passed]]);
  assert.equal(out.holdMinutes, 40, JSON.stringify(out));
  assert.equal(out.ladder.rule, 'passed-not-longer');
  assert.deepEqual(out.ladder.reached, { n: 9, stage: 'A1-entry-result', result: 'ok' });
});

test('ladder 5: the earlier run stopped on a no-progress gate: refused, with the stage it was stuck in, not lengthened', opts, () => {
  const stuck = ladderReceipt({ minutes: 40, failure: { code: 'DRILL_GUEST_NO_PROGRESS', detail: { stage: 'host', reason: 'stalled', limitMinutes: 10, stageSeconds: 900, sinceGrowthSeconds: 610 } },
    stages: [['assets', 'ok'], ['prereq', 'ok'], ['unpack', 'ok'], ['check', 'ok'], ['host', 'aborted-in-progress']] });
  const { root, out } = ladderMain('stuck', [['20261123T050000Z-1.2.3-jjjjjjjj', stuck]]);
  assert.equal(out.code, 'DRILL_LADDER_PREVIOUS_NO_PROGRESS', JSON.stringify(out));
  assert.equal(out.detail.stage, 'host');
  assert.equal(out.detail.reason, 'stalled');
  assert.equal(out.detail.receipt, path.join(root, '20261123T050000Z-1.2.3-jjjjjjjj', 'receipt.json'));
});

// Review medium 2: the check stage was ended ok before its own verdict (and the second extraction before its own), and the time between
// check and host belonged to no stage, so a stop there (ELEVATED_INPUT_NOT_LOCAL, DRILL_CREDENTIAL_INPUT_ACL_REFUSED, ...) reached no
// stage at all. Now a stage ends after its verdict, the next stage's start is the only other end, and the inputs for the host stage are
// a stage of their own (host-inputs): the entry's stop code is on exactly the stage it stopped in.
test('fix1 medium 2: a check that fails ends the check stage failed with its code; a stop between check and host is on host-inputs', opts, () => {
  const check = entryAccepted('check-fails', { checkExit: 1 });
  assert.equal(check.thrown, 'FIRST_INSTALL_INPUTS_NOT_ACCEPTED');
  const t = timelineOf('check-fails', check.record, stoppedResult(check.thrown));
  const entryStages = t.stages.filter(s => s.stage !== 'A1-entry-result');
  assert.deepEqual(entryStages.filter(s => s.result === 'failed').map(s => `${s.stage}:${s.code}`), ['check:FIRST_INSTALL_INPUTS_NOT_ACCEPTED'], JSON.stringify(rows(t)));
  assert.ok(!rows(t).includes('check:ok'), 'check is not ok: ' + JSON.stringify(rows(t)));

  const gap = entryAccepted('gap-stop', { underDir: false });
  assert.equal(gap.thrown, 'ELEVATED_INPUT_NOT_LOCAL');
  const g = timelineOf('gap-stop', gap.record, stoppedResult(gap.thrown));
  assert.deepEqual(g.stages.filter(s => s.stage !== 'A1-entry-result' && s.result === 'failed').map(s => `${s.stage}:${s.code}`), ['host-inputs:ELEVATED_INPUT_NOT_LOCAL'], JSON.stringify(rows(g)));
  assert.ok(rows(g).includes('check:ok'), 'the check passed: ' + JSON.stringify(rows(g)));
  // every stage the entry entered was ended, in order, each start right after the end before it (no time between stages)
  const lines = gap.record.trim().split('\n').map(l => JSON.parse(l)).filter(l => l.event === 'start' || l.event === 'end');
  assert.deepEqual(lines.map(l => l.event), lines.map((_, i) => i % 2 ? 'end' : 'start'), 'start, end, start, end ...: ' + JSON.stringify(lines.map(l => `${l.stage}:${l.event}`)));
  for (let i = 1; i < lines.length; i += 2) assert.equal(lines[i].stage, lines[i - 1].stage);
});

// Review high 1 / coordinator's fourth case: the ladder stuck at one rung. Each case is a real run (Invoke-DrillPreparedRun, its
// receipt.json in a runs directory) and the next run's step comes from that receipt (Get-DrillLadderStep): the time ran out with no stage
// failed and no gate fired, so the limit doubles -- wherever the time ran out.
test('fix1 high 1 (coordinator): the two real ladder receipts of 2026.11.23-d5da6825 (the guard reported the timeout) double', opts, () => {
  const fixture = n => fileURLToPath(new URL(`./fixtures/drill-d5da6825-ladder-r${n}-receipt.json`, import.meta.url));
  const runs = fs.mkdtempSync(path.join(tmp, 'ladder-real-'));
  const put = (dir, n) => { fs.mkdirSync(path.join(runs, dir)); fs.copyFileSync(fixture(n), path.join(runs, dir, 'receipt.json')); };
  put('20261123T123642Z-2026.11.23-d5da6825-68345a7d', 1);
  const kit = '30a13f165c92cf6725e9ef006dd6e36c850aca9909998ce6fb2fd30280e096d4';
  const step = () => ps(`try { Get-DrillLadderStep ${q(runs)} '2026.11.23-d5da6825' ${q(kit)} } catch { $c = Get-DrillCode $_; [ordered]@{ code = $c.code; detail = $c.detail } }`);
  const first = step();
  assert.equal(first.rule, 'doubled', JSON.stringify(first));
  assert.equal(first.minutes, 20);
  assert.deepEqual(first.reached, { n: 2, stage: 'prereq', result: 'aborted-in-progress' });
  put('20261123T124737Z-2026.11.23-d5da6825-b48d6dab', 2);
  const second = step();
  assert.equal(second.rule, 'doubled', JSON.stringify(second));
  assert.equal(second.minutes, 20);
  assert.equal(second.basis, path.join(runs, '20261123T124737Z-2026.11.23-d5da6825-b48d6dab', 'receipt.json'));
});

test('fix1 high 1 (a): the time runs out between check and host (the entry preparing the host inputs): doubled', opts, () => {
  const e = entryAccepted('gap-snapshot', { snapAt: 'gap', snapStop: true });
  assert.equal(e.thrown, 'FIXTURE_STOPPED_AFTER_SNAPSHOT');
  const { r } = earlyStopRun('ladder-gap', { guest: { 'first-install.stdout.log': '', 'stage-progress.jsonl': e.snapshot },
    fireAt: 600 + 15, fireCode: 'DRILL_RUN_TIMEOUT', deadlineSeconds: 600, receipt: true });
  assert.equal(r.failure.code, 'DRILL_RUN_TIMEOUT', JSON.stringify(r.failure));
  assert.equal(r.ladder.rule, 'doubled', `timeline ${JSON.stringify(rows(r.timeline))}; step ${JSON.stringify(r.ladder)}`);
  assert.equal(r.ladder.minutes, 20);
  assert.equal(r.timeline.abortedIn, 'host-inputs', JSON.stringify(rows(r.timeline)));
});

test('fix1 high 1 (b): the first install ended done and the time runs out in A7 (the guest not back from its reboot): doubled', opts, () => {
  const record = fs.mkdtempSync(path.join(tmp, 'done-record-'));
  entryPs(`$script:EntryStageOutput = ${q(record)}
    foreach ($n in @('assets', 'prereq', 'unpack', 'check', 'host-inputs', 'host', 'prepare', 'wsl-cold-start', 'launcher')) { Start-EntryStage $n }
    Stop-EntryStage 'ok'; $true`);
  const read = { status: { writtenAt: T0, node: { mode: 'ACTIVE' } }, current: { version: '1.2.3' }, facts: null, pause: null, verify: { status: 'PASSED' }, readAt: T0 };
  const { r } = earlyStopRun('ladder-a7', { guest: { 'first-install.stdout.log': '', 'stage-progress.jsonl': fs.readFileSync(path.join(record, 'stage-progress.jsonl'), 'utf8') },
    entryDoneAt: 120, read, rebootNeverBack: 430, fireAt: 600 + 15, fireCode: 'DRILL_RUN_TIMEOUT', deadlineSeconds: 600, receipt: true });
  assert.equal(r.failure.code, 'DRILL_RUN_TIMEOUT', JSON.stringify(r.failure));
  assert.ok(r.events.includes('reboot-not-back'), JSON.stringify(r.events));
  assert.ok(rows(r.timeline).includes('A1-entry-result:ok:FIRST_INSTALL_DONE'), JSON.stringify(rows(r.timeline)));
  assert.equal(r.ladder.rule, 'doubled', `timeline ${JSON.stringify(rows(r.timeline))}; step ${JSON.stringify(r.ladder)}`);
  assert.equal(r.ladder.minutes, 20);
  assert.equal(r.timeline.abortedIn, 'A7-reboot', JSON.stringify(rows(r.timeline)));
});

test('fix1 high 1 (c): a kit whose entry writes no stage record (stage logs only), cut off in the host stage: doubled', opts, () => {
  const grow = Array.from({ length: 30 }, (_, i) => [(i + 1) * 60, 'host.stdout.log', earlyHostLine(100 + (i + 1) * 60)]);
  const { r } = earlyStopRun('ladder-old-kit', { guest: { 'first-install.stdout.log': EARLY_ENTRY_LOG, 'host.stdout.log': earlyHostLine(1) + '\r\n' },
    grow, fireAt: 1200 + 15, fireCode: 'DRILL_RUN_TIMEOUT', deadlineSeconds: 1200, receipt: true });
  assert.equal(r.failure.code, 'DRILL_RUN_TIMEOUT', JSON.stringify(r.failure));
  assert.equal(r.timeline.source, 'stage-logs');
  assert.equal(r.ladder.rule, 'doubled', `timeline ${JSON.stringify(rows(r.timeline))}; step ${JSON.stringify(r.ladder)}`);
  assert.equal(r.ladder.minutes, 40);
  assert.equal(r.timeline.abortedIn, 'host');
});

test('fix1 high 1 (d): the evidence reads outlast the window and the guard reports the timeout (the real rounds): doubled', opts, () => {
  const record = fs.mkdtempSync(path.join(tmp, 'prereq-record-'));
  entryPs(`$script:EntryStageOutput = ${q(record)}; Start-EntryStage 'assets'; Start-EntryStage 'prereq'; $true`);
  const { r } = earlyStopRun('ladder-guard', { guest: { 'first-install.stdout.log': '', 'stage-progress.jsonl': fs.readFileSync(path.join(record, 'stage-progress.jsonl'), 'utf8') },
    slowReadsAfter: 400, fireAt: 600 + 15, fireCode: 'DRILL_RUN_TIMEOUT', deadlineSeconds: 600, receipt: true });
  assert.equal(r.failure.code, 'DRILL_RUN_TIMEOUT', JSON.stringify(r.failure));
  assert.notEqual(r.failure.detail?.by, 'foreground', 'the guard reported it: ' + JSON.stringify(r.failure));
  assert.equal(r.ladder.rule, 'doubled', `timeline ${JSON.stringify(rows(r.timeline))}; step ${JSON.stringify(r.ladder)}`);
  assert.equal(r.ladder.minutes, 20);
});

// Review medium 3: a pull that did not answer counted as "no growth". Now the gate is judged only on a tick whose pull answered;
// pulls that fail are counted on their own (consecutiveFailedPulls, failedPulls) and never stop the run by themselves.
test('fix1 medium 3: pulls that never answer do not stop the run as no progress; it ends on its own deadline', opts, () => {
  const { r, runDir } = earlyStopRun('pull-fails', { guest: { 'first-install.stdout.log': EARLY_ENTRY_LOG, 'host.stdout.log': earlyHostLine(1) + '\r\n' },
    pullFail: '$true', fireAt: 4200 + 15, fireCode: 'DRILL_RUN_TIMEOUT', deadlineSeconds: 4200 });
  assert.equal(r.failure?.code, 'DRILL_RUN_TIMEOUT', JSON.stringify(r.failure));
  assert.equal(r.failure.detail.by, 'foreground');
  const p = JSON.parse(fs.readFileSync(path.join(runDir, 'guest-progress.json'), 'utf8'));
  assert.equal(p.stop, null);
  assert.ok(p.consecutiveFailedPulls > 10 && p.failedPulls === p.consecutiveFailedPulls, JSON.stringify(p));
  assert.ok(p.pullFailingSince, 'since when the pulls fail');
});

test('fix1 medium 3: pulls that stop answering in the host stage do not count as a stall; a pull that answers again judges it', opts, () => {
  const guest = { 'first-install.stdout.log': EARLY_ENTRY_LOG, 'host.stdout.log': earlyHostLine(1) + '\r\n' };
  const lost = earlyStopRun('pull-lost', { guest, pullFail: '$script:now -ge 120', fireAt: 4200 + 15, fireCode: 'DRILL_RUN_TIMEOUT', deadlineSeconds: 4200 });
  assert.equal(lost.r.failure?.code, 'DRILL_RUN_TIMEOUT', JSON.stringify(lost.r.failure));
  // the pulls come back at 900 s and the host log has not grown since the start: a real stall, judged on that tick
  const back = earlyStopRun('pull-back', { guest, pullFail: '$script:now -ge 120 -and $script:now -lt 900', fireAt: 4200 + 15, fireCode: 'DRILL_RUN_TIMEOUT', deadlineSeconds: 4200 });
  assert.equal(back.r.failure?.code, 'DRILL_GUEST_NO_PROGRESS', JSON.stringify(back.r.failure));
  assert.equal(back.r.failure.detail.reason, 'stalled');
  assert.ok(back.r.now >= 900, `judged only once a pull answered: ${back.r.now}s`);
  assert.ok(back.r.failure.detail.failedPulls > 0, JSON.stringify(back.r.failure.detail));
});

// Review medium 4: the newest receipt of this version could not be read and an older one was used (doubled instead of refused). Now the
// newest run directory of this version (its name carries the version) decides: a receipt.json there that cannot be read, or that has no
// version or kit, refuses with its path. A directory without receipt.json (a run that stopped before it had one) is passed over.
test('fix1 medium 4: the newest receipt of this version unreadable or without its kit: refused with its path, never an older one', opts, () => {
  const clean = ladderReceipt({ minutes: 10, failure: foregroundStop(10), stages: [['assets', 'ok'], ['prereq', 'aborted-in-progress']] });
  const root = fs.mkdtempSync(path.join(tmp, 'ladder-unreadable-'));
  const put = (dir, text) => { fs.mkdirSync(path.join(root, dir)); if (text !== null) fs.writeFileSync(path.join(root, dir, 'receipt.json'), text); };
  put('20261123T010000Z-1.2.3-aaaaaaaa', JSON.stringify(clean));
  put('20261123T020000Z-1.2.3-bbbbbbbb', '{"contract":"clued.independent-ci.drill-receipt/fixture","version":"1.2.3","kitSha256":"kit-la');
  put('20261123T030000Z-1.2.3-cccccccc', null);                     // no receipt: passed over
  put('20261123T040000Z-9.9.9-dddddddd', '{ broken');                // another version: not this package's
  const step = () => ps(`${ladderStubs}
    $script:Drill.Runs = ${q(root)}
    try { Invoke-DrillMain } catch { Get-DrillCode $_ }`);
  const out = step();
  assert.equal(out.code, 'DRILL_LADDER_PREVIOUS_RECEIPT_UNREADABLE', JSON.stringify(out));
  assert.equal(out.detail.receipt, path.join(root, '20261123T020000Z-1.2.3-bbbbbbbb', 'receipt.json'));
  fs.writeFileSync(path.join(root, '20261123T020000Z-1.2.3-bbbbbbbb', 'receipt.json'), JSON.stringify({ ...clean, kitSha256: undefined }));
  const noKit = step();
  assert.equal(noKit.code, 'DRILL_LADDER_PREVIOUS_RECEIPT_UNREADABLE', JSON.stringify(noKit));
  // readable and of another kit: passed over, the older one of this kit decides
  fs.writeFileSync(path.join(root, '20261123T020000Z-1.2.3-bbbbbbbb', 'receipt.json'), JSON.stringify({ ...clean, kitSha256: 'another-kit' }));
  assert.equal(step().holdMinutes, 20);
});

// Review low 7: a step that is not longer never goes past the ceiling (an earlier run given more by hand).
test('fix1 low 7: the same limit again is held to the ceiling', opts, () => {
  const passed = ladderReceipt({ minutes: 90, conclusion: 'PASS_A_FULL', stages: [['assets', 'ok'], ['A1-entry-result', 'ok']] });
  const { out } = ladderMain('ceiling', [['20261123T040000Z-1.2.3-eeeeeeee', passed]]);
  assert.equal(out.holdMinutes, 70, JSON.stringify(out));
});

// Review low 5: a pull that timed out was removed with Remove-Job -Force, a synchronous StopJob that a busy guest can hold for minutes
// (the main step's job, cut off by the deadline, the same). Now a job still running is stopped without waiting (StopJobAsync) and
// removed once it has ended; the foreground is never held by it.
test('fix1 low 5: a timed-out pull and the cut-off entry job are stopped without waiting; the foreground stops on time', opts, () => {
  const { r } = earlyStopRun('no-sync-remove', { guest: { 'first-install.stdout.log': EARLY_ENTRY_LOG, 'host.stdout.log': earlyHostLine(1) + '\r\n' },
    pullFail: '$script:now -ge 60', removeBlocks: true, fireAt: 1200 + 15, fireCode: 'DRILL_RUN_TIMEOUT', deadlineSeconds: 1200 });
  assert.deepEqual(r.events.filter(e => e.startsWith('remove-running-job')), [], JSON.stringify(r.events));
  assert.equal(r.failure.code, 'DRILL_RUN_TIMEOUT', JSON.stringify(r.failure));
  assert.equal(r.failure.detail.by, 'foreground');
  assert.ok(r.now <= 1200 - 5 * 60 + 60, `stopped at ${r.now}s`);
  assert.ok(r.events.includes('stop-async:pull') && r.events.includes('stop-async:entry'), JSON.stringify(r.events));
});

// Item 6 (coordinator, the first ladder round: prereq ran over 5 minutes with nothing finer): the prereq stage writes a line as each item
// step starts and ends -- item, step (sha, copy, get, expand; the tools found last), bytes, start, end -- and the timeline shows the step
// a cut-off prereq stage was in.
test('fix1 item 6: the prereq stage records each item and step; a cut-off prereq says which item and which step', opts, () => {
  const e = entryAccepted('prereq-steps', { checkExit: 1, snapAt: 'python' });
  assert.equal(e.thrown, 'FIRST_INSTALL_INPUTS_NOT_ACCEPTED');
  const full = timelineOf('prereq-full', e.record);
  const prereq = full.stages.find(s => s.stage === 'prereq');
  assert.equal(prereq.result, 'ok');
  assert.deepEqual(prereq.steps.map(s => `${s.item}:${s.step}:${s.result}`), ['wsl:sha:ok', 'wsl:copy:ok', 'node:sha:ok', 'node:copy:ok', 'node:expand:ok',
    'python:sha:ok', 'python:copy:ok', 'python:expand:ok', 'git:sha:ok', 'git:copy:ok', 'git:expand:ok', 'a.deb:sha:ok', 'a.deb:copy:ok', 'tools:find:ok']);
  const bytes = Object.fromEntries([...e.items, ...e.debs].map(i => [i.fileName === 'a.deb' ? 'a.deb' : i.name, i.bytes]));
  for (const s of prereq.steps) {
    assert.ok(s.startedAt && s.endedAt, JSON.stringify(s));
    if (s.item !== 'tools') assert.equal(s.bytes, bytes[s.item], JSON.stringify(s));
  }
  const cut = timelineOf('prereq-cut', e.snapshot);
  assert.equal(cut.abortedIn, 'prereq');
  const p = cut.stages.find(s => s.stage === 'prereq');
  assert.equal(p.result, 'aborted-in-progress');
  assert.deepEqual({ item: p.inProgressStep.item, step: p.inProgressStep.step, bytes: p.inProgressStep.bytes }, { item: 'python', step: 'expand', bytes: bytes.python });
  assert.ok(p.inProgressStep.startedAt);
  assert.deepEqual(p.steps.at(-1).result, 'aborted-in-progress');
});

// The entry stays plain ASCII and parses in Windows PowerShell 5.1 without errors.
test('fix1: first-install-entry.ps1 is ASCII and parses in Windows PowerShell 5.1', opts, () => {
  const bytes = fs.readFileSync(entryScript);
  assert.ok(bytes.every(b => b < 0x80), 'a non-ASCII byte in the entry');
  const errors = ps(`$e = $null; [void][Management.Automation.Language.Parser]::ParseFile(${q(entryScript)}, [ref]$null, [ref]$e); @($e).Count`);
  assert.equal(errors, 0);
});

// Review low 5, the real path: a PowerShell job (a PSRemotingJob, as Invoke-Command -AsJob gives) has no StopJobAsync; Stop-DrillJob stops
// it on a runspace of its own and returns at once, and a later call removes it once it has stopped.
test('fix1 low 5: a running PSRemotingJob is stopped without waiting and removed once it has stopped', opts, () => {
  // No wall-clock bound (a slow hosted machine broke a 2000 ms one): the job sits in an uninterruptible 30 s sleep, so a blocking Stop-Job
  // would hold until it ended (measured 17 s of 20 s); a Stop-DrillJob that does not wait returns with the job not yet in a final state.
  const out = ps(`$mark = Join-Path ([IO.Path]::GetTempPath()) ('lowfive-' + [guid]::NewGuid().ToString('N'))
    $j = Start-Job { param($m) Set-Content -LiteralPath $m 'in'; [Threading.Thread]::Sleep(30000) } -ArgumentList $mark
    $type = $j.GetType().Name
    $armed = [Environment]::TickCount + 120000; while (-not (Test-Path -LiteralPath $mark) -and [Environment]::TickCount -lt $armed) { Start-Sleep -Milliseconds 50 }
    Stop-DrillJob $j $false; $atReturn = [string]$j.State
    Remove-Item -LiteralPath $mark -Force -ErrorAction SilentlyContinue
    $until = [Environment]::TickCount + 60000; while ($j.State -notin @('Stopped', 'Completed', 'Failed') -and [Environment]::TickCount -lt $until) { Start-Sleep -Milliseconds 100 }
    $state = [string]$j.State
    Start-Sleep -Milliseconds 300
    $k = Start-Job { 1 }; [void](Wait-Job -Job $k -Timeout 60); Stop-DrillJob $k $true   # an ended job: removed, and the sweep runs
    $left = $script:DrillStoppingJobs.Count
    $gone = $null -eq (Get-Job -Id $j.Id -ErrorAction SilentlyContinue)
    [ordered]@{ type = $type; atReturn = $atReturn; state = $state; left = $left; gone = $gone }`);
  assert.equal(out.type, 'PSRemotingJob');
  assert.ok(['Running', 'Stopping'].includes(out.atReturn), `Stop-DrillJob waited: the job was ${out.atReturn} when it returned`);
  assert.equal(out.state, 'Stopped');
  assert.equal(out.gone, true, JSON.stringify(out));
  assert.equal(out.left, 0, JSON.stringify(out));
});

// Review medium 2, the rest: a stop with no stage open (before the first one, or after the last) is written on its own as between-stages,
// never lost; the timeline lists it failed with its code.
test('fix1 medium 2: a stop with no stage open is recorded as between-stages with its code', opts, () => {
  const record = fs.mkdtempSync(path.join(tmp, 'between-stages-'));
  entryPs(`$script:EntryStageOutput = ${q(record)}; $script:EntryStageOpen = $null
    Start-EntryStage 'assets'; Stop-EntryStage 'ok'
    Stop-EntryStage 'failed' 'DRILL_CREDENTIAL_CLEANUP_FAILED'; Stop-EntryStage 'ok'; $true`);
  const t = timelineOf('between-stages', fs.readFileSync(path.join(record, 'stage-progress.jsonl'), 'utf8'));
  assert.deepEqual(rows(t), ['assets:ok', 'between-stages:failed:DRILL_CREDENTIAL_CLEANUP_FAILED']);
});
test('fix1 item 7: the host preparation writes each step as it starts into the stage record; a cut-off host stage says which step', opts, () => {
  const out = fs.mkdtempSync(path.join(tmp, 'host-steps-'));
  const record = path.join(out, 'stage-progress.jsonl');
  entryPs(`$script:EntryStageOutput = ${q(out)}; foreach ($n in @('assets', 'prereq', 'unpack', 'check', 'host-inputs')) { Start-EntryStage $n }
    Start-EntryStage 'host' (Join-Path ${q(out)} 'host.stdout.log'); $true`);
  const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `$ErrorActionPreference = 'Stop'; . ${q(hostScript)}; $StepProgress = ${q(record)}
     Enter-Step 'v1-base'; Step 'v1-base' 'present'; Enter-Step 'node-key-check'; Step 'node-key-check' 'none'; Enter-Step 'wsl'`], { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // stdout: the two step lines as before, nothing for a step that started
  assert.deepEqual(r.stdout.split(/\r?\n/).filter(l => l.trim()).map(l => { const o = JSON.parse(l); return `${o.name}:${o.result}`; }), ['v1-base:ok', 'node-key-check:ok']);
  const t = timelineOf('host-steps', fs.readFileSync(record, 'utf8'));
  const h = t.stages.find(s => s.stage === 'host');
  assert.equal(h.result, 'aborted-in-progress');
  assert.deepEqual(h.steps.map(s => `${s.step}:${s.result}`), ['v1-base:ok', 'node-key-check:ok', 'wsl:aborted-in-progress']);
  assert.equal(h.inProgressStep.step, 'wsl');
  assert.ok(h.inProgressStep.startedAt, JSON.stringify(h.inProgressStep));
  // a refusal: the step ends failed with its code in the record as well
  const r2 = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `. ${q(hostScript)}; $StepProgress = ${q(record)}; Get-FailedStepLine 'WSL_MSI_FAILED' | Out-Null`], { encoding: 'utf8', timeout: 120000 });
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  const last = JSON.parse(fs.readFileSync(record, 'utf8').trim().split('\n').at(-1));
  assert.deepEqual([last.stage, last.event, last.result, last.code], ['host', 'step-end', 'failed', 'WSL_MSI_FAILED']);
  // without -StepProgress (bootstrap.ps1's call): nothing written anywhere
  const r3 = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `. ${q(hostScript)}; Enter-Step 'wsl'; Step 'wsl' 'x' | Out-Null; 'done'`], { encoding: 'utf8', timeout: 120000 });
  assert.equal(r3.stdout.trim(), 'done', r3.stdout + r3.stderr);
  // the entry gives it to a host preparation that takes it (this package's), and the record is the entry's own
  assert.equal(entryPs(`Test-EntryHostTakesStepProgress ${q(hostScript)}`), true);
  assert.match(fs.readFileSync(entryScript, 'utf8'), /if \(Test-EntryHostTakesStepProgress \$hostScript\) \{ \$kitArgs \+= @\('-StepProgress', \(Join-Path \$Output 'stage-progress\.jsonl'\)\) \}/);
});

// Item 7 for a package whose host preparation does not take -StepProgress (the candidate 2026.11.23-d5da6825): the cut-off host stage
// says the last step line its log printed, and when.
test('fix1 item 7: an older host preparation: the cut-off host stage says its last printed step and when', opts, () => {
  const runDir = fs.mkdtempSync(path.join(tmp, 'host-last-step-'));
  const out = fs.mkdtempSync(path.join(tmp, 'host-last-step-entry-'));
  entryPs(`$script:EntryStageOutput = ${q(out)}; foreach ($n in @('assets', 'prereq', 'unpack', 'check', 'host-inputs')) { Start-EntryStage $n }
    Start-EntryStage 'host' (Join-Path ${q(out)} 'host.stdout.log'); $true`);
  fs.copyFileSync(path.join(out, 'stage-progress.jsonl'), path.join(runDir, 'stage-progress.jsonl'));
  fs.writeFileSync(path.join(runDir, 'host.stdout.log'), [JSON.stringify({ name: 'v1-base', result: 'ok', rejectCode: null, detail: 'present', at: '2026-11-23T13:10:00.0000000+00:00' }),
    'free text a tool printed', JSON.stringify({ name: 'node-key-check', result: 'ok', rejectCode: null, detail: null, at: '2026-11-23T13:13:00.0000000+00:00' }), ''].join('\r\n'));
  const t = ps(`Get-DrillStageTimeline ${q(runDir)}`);
  const h = t.stages.find(s => s.stage === 'host');
  assert.equal(h.result, 'aborted-in-progress');
  assert.deepEqual(h.lastStepLine, { name: 'node-key-check', result: 'ok', at: '2026-11-23T13:13:00.0000000+00:00' });
});
