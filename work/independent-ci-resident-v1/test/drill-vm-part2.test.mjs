// drill/drill-vm.ps1, offline, part 2 of 4. The tests of drill-vm.test.mjs, in their order and with their text, split by run time so no
// part holds a hosted shard past about 210 s (task 3435f8bf, block 2); the fixtures they share are drill-vm-fixtures.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { drillKitManifest, prepareFrom, makeDrillKit } from '../drill/make-drill-kit.mjs';
import { DRILL_PASS_CONCLUSIONS, prepare, requestLineOf, seal } from '../rollout/fleet/publish.mjs';
import { FAKE_GH } from '../rollout/fleet/test/fleet-fixtures.mjs';
import {
  script, powershell, tmp, sha, q, PACKAGE_CREDENTIALS, ps, psCode, opts, idleHostStatus, activeHostStatus, entryScript,
  firstInstallAssets, at, m5DrillReceipt, RENEWAL_3BC571A6, notTheDrillsSource, sealWorld, wslWorld, gitSh, shOpts, shWorld,
  commandIn, preBootWorld, early, bootGate, gateMemory, WSL_MEMORY, bootWaitWorld, packageDir, kitDir, prereqDir, NOW, S, L,
  guestWorkDir, evidence, verdictOf, pass, finalize
} from './drill-vm-fixtures.mjs';

test('seal takes the candidate receipt drill-vm.ps1 finalized and refuses the one not read back', opts, async t => {
  const w = await sealWorld(t);
  const pkg = { tarSha256: w.request.archive_sha256, firstInstallKitSha256: w.request.firstInstallKitSha256 };
  assert.equal(w.request.ciSourceManifestSha256, S);
  const cand = m5DrillReceipt('seal-cand', RENEWAL_3BC571A6, { checker: 'PASS', missing: [], candidate: true, version: w.version, pkg });
  const pending = path.join(w.d, 'receipt-pending.json'); fs.writeFileSync(pending, JSON.stringify(cand));
  const before = fs.readFileSync(w.index);
  await assert.rejects(w.sealIt(pending), { code: 'SEAL_DRILL_RECEIPT_NOT_PASS' });
  assert.deepEqual(fs.readFileSync(w.index), before, 'refused before anything is written');
  // an accepted version's re-drill (not a candidate), read back and PASS, is not a candidate's receipt
  const reDrill = finalize('seal-redrill-finalize', m5DrillReceipt('seal-redrill', RENEWAL_3BC571A6, { checker: 'PASS', missing: [], version: w.version, pkg }));
  assert.equal(reDrill.output.conclusion, 'PASS_A_PER_NODE_STEPS_REMAIN');
  await assert.rejects(w.sealIt(reDrill.receiptFile), { code: 'SEAL_DRILL_RECEIPT_NOT_A_CANDIDATE' });
  const done = finalize('seal-cand-finalize', cand, notTheDrillsSource());
  assert.equal(done.output.conclusion, 'PASS_A_PER_NODE_STEPS_REMAIN');
  const r = await w.sealIt(done.receiptFile);
  assert.equal(r.status, 'FLEET_ACCEPTANCE_SEALED');
  assert.equal(r.drill, `PASS_A_PER_NODE_STEPS_REMAIN receipt ${sha(fs.readFileSync(done.receiptFile))}`);
});

// Integration of branch one (seal's main-ancestor gate) and branch two (three PASS conclusions): each PASS receipt is still stopped by the
// gate while the candidate's commit is not on main -- the index untouched -- and seals with its value as it is once the commit is on main.
test('each of the three PASS drill receipts is refused off main and seals on main (merged gate and conclusions)', opts, async t => {
  assert.deepEqual(DRILL_PASS_CONCLUSIONS, ['PASS_A_FULL', 'PASS_A_PER_NODE_STEPS_REMAIN', 'PASS_A_REINSTALL_NOT_DRILLED']);
  for (const conclusion of DRILL_PASS_CONCLUSIONS) {
    const w = await sealWorld(t);
    const setCompare = c => { const f = process.env.FAKE_GH_STATE; const st = JSON.parse(fs.readFileSync(f, 'utf8')); st.compare = c; fs.writeFileSync(f, JSON.stringify(st)); };
    const receiptFile = path.join(w.d, `receipt-${conclusion}.json`);
    const bytes = Buffer.from(JSON.stringify({ contract: 'clued.independent-ci.drill-receipt/1', version: w.version, candidate: true, conclusion,
      tarSha256: w.request.archive_sha256, ciSourceManifestSha256: w.request.ciSourceManifestSha256, firstInstallKitSha256: w.request.firstInstallKitSha256, kitSha256: 'd'.repeat(64) }));
    fs.writeFileSync(receiptFile, bytes);
    const before = fs.readFileSync(w.index);
    for (const compare of ['ahead', 'diverged']) {
      setCompare(compare);
      await assert.rejects(w.sealIt(receiptFile), { code: 'SEAL_COMMIT_NOT_ON_MAIN' }, `${conclusion} ${compare}`);
      assert.deepEqual(fs.readFileSync(w.index), before, `${conclusion} ${compare}: nothing written`);
    }
    setCompare('behind');
    const r = await w.sealIt(receiptFile);
    assert.equal(r.status, 'FLEET_ACCEPTANCE_SEALED', conclusion);
    assert.equal(r.drill, `${conclusion} receipt ${sha(bytes)}`);
    assert.ok(fs.readFileSync(w.index, 'utf8').includes(r.drill), conclusion);
  }
});

// T1 of FABLE-drill-release-step-20261121.md (the r4 and r9 refusal, PUBLISH_INDEX_LACKS_VERSION at prepare): a candidate from its build
// alone, with an index holding its header only and an empty gh state, and no release step: prepare -> -From (prepareFrom) -> the kit
// (makeDrillKit with --request) -> the receipt drill-vm.ps1's conclusion function wrote, finalized -> seal --drill-receipt.
test('a candidate from its build alone: prepare makes the Release and the index row, then -From, the kit, the drill\'s own receipt and seal', opts, async t => {
  const f = firstInstallAssets('candidate-from-build', { candidate: true });
  const { version } = f, tag = `fleet-node-${version}`, commit = 'c'.repeat(40), repo = 'tdoljyj/cross-memory-system';
  // the build as universal.mjs writes it: a release.json of the real contract naming this tar, the two-line SHA256SUMS
  const tar = fs.readFileSync(path.join(f.build, `${tag}.tar`));
  const source = { version, release_tag: tag, archive_sha256: sha(tar), commit, resident_manifest_sha256: '2'.repeat(64), source_manifest_sha256: '3'.repeat(64),
    upgrader_manifest_sha256: '4'.repeat(64), bundle_sha256: '5'.repeat(64), universal_files_sha256: '6'.repeat(64) };
  const release = Buffer.from(JSON.stringify({ contract: 'clued.independent-ci.fleet-node-release/1', source, archive: { name: `${tag}.tar`, bytes: tar.length, sha256: sha(tar) } }) + '\n');
  fs.writeFileSync(path.join(f.build, `${tag}.release.json`), release);
  fs.writeFileSync(path.join(f.build, 'SHA256SUMS'), `${sha(release)}  ${tag}.release.json\n${sha(tar)}  ${tag}.tar\n`);
  const index = path.join(f.root, 'index.md');
  fs.writeFileSync(index, '| 版本 | Release | tar sha256 | commit | 接受时间 | Decision | 首装演练 |\r\n|---|---|---|---|---|---|---|\r\n');
  const fake = path.join(f.root, 'fake-gh.mjs'); fs.writeFileSync(fake, FAKE_GH);
  const state = path.join(f.root, 'gh-state.json');
  const saved = { FAKE_GH_STATE: process.env.FAKE_GH_STATE, GH_TOKEN: process.env.GH_TOKEN };
  process.env.FAKE_GH_STATE = state; delete process.env.GH_TOKEN;
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const gh = [process.execPath, fake];
  const image = 'b'.repeat(64), imageFile = path.join(f.images, `role-image-${image}.tar.gz`);
  const U = n => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
  const deps = { readKit: () => ({}), sourceHash: async () => ({ ciSourceManifestSha256: S }),
    kitOf: async () => ({ contract: 'clued.independent-ci.fleet-node-first-install-kit/1', template: {}, config: { ciSourceManifestSha256: L }, images: { pull: [], local: [{ id: image, asset: `role-image-${image}.tar.gz` }] } }),
    fleetMaterial: async () => ({ formalRoles: { gitleaks: {}, trivy: {}, 'contract-placement': {} },
      installed: { sourceAcceptanceRef: U(5), hostQualificationRef: U(6), ownerAuthorizationRef: U(5), publisherQualificationRef: U(5), ownerPackageAcceptanceRef: U(5), ciSourceManifestSha256: L } }) };
  // 1. prepare, with nothing published before it
  const accept = path.join(f.root, 'accept');
  const p = await prepare({ version, dir: f.build, out: accept, images: [imageFile], index, repo, ghCommand: gh, deps });
  assert.equal(p.status, 'FLEET_ACCEPTANCE_REQUEST_WRITTEN');
  const request = JSON.parse(fs.readFileSync(p.request, 'utf8'));
  // 2. -From from the build and what prepare left; 3. the candidate's kit on that request
  const from = path.join(f.root, 'from-prepared');
  prepareFrom({ build: f.build, final: accept, images: accept, version, out: from });
  const made = await makeDrillKit({ from, version, prereq: f.prereq, out: path.join(f.root, 'kit-prepared'), request: p.request });
  assert.deepEqual(made.candidate, { acceptance: `${tag}.acceptance.json`, tarSha256: sha(tar), ciSourceManifestSha256: S, firstInstallKitSha256: request.firstInstallKitSha256 });
  // 4. the receipt drill-vm.ps1's conclusion function writes for this candidate, read back (-Finalize)
  const cand = m5DrillReceipt('candidate-from-build-run', RENEWAL_3BC571A6, { checker: 'PASS', missing: [], candidate: true, version,
    pkg: { tarSha256: request.archive_sha256, firstInstallKitSha256: request.firstInstallKitSha256 } });
  const done = finalize('candidate-from-build-finalize', cand, notTheDrillsSource());
  assert.equal(done.output.conclusion, 'PASS_A_PER_NODE_STEPS_REMAIN');
  // 5. the Owner accepts (the Decision record naming this request), seal --drill-receipt
  const record = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../rollout/fleet/test/fixtures/clued-decision-mutate-3bc571a6.json', import.meta.url)), 'utf8'));
  record.supplemental.record.content = `TEST TEXT: the Owner accepts.\n${requestLineOf(version, sha(fs.readFileSync(p.request)))}\n`;
  const decisionRecord = path.join(f.root, 'decision-record.json'); fs.writeFileSync(decisionRecord, JSON.stringify(record, null, 2));
  const sealed = await seal({ request: p.request, decisionRecord, drillReceipt: done.receiptFile, index, repo, ghCommand: gh, deps });
  assert.equal(sealed.status, 'FLEET_ACCEPTANCE_SEALED');
  // the Release: the five package assets, the kit, the image, the first-install sums and the acceptance, once each
  const names = JSON.parse(fs.readFileSync(state, 'utf8')).assets.map(a => a.name).sort();
  assert.deepEqual(names, [`${tag}.tar`, `${tag}.release.json`, 'SHA256SUMS', `${tag}.bootstrap.ps1`, `${tag}.prereq-manifest.json`, `${tag}.first-install-kit.json`,
    `role-image-${image}.tar.gz`, `${tag}.first-install.SHA256SUMS`, `${tag}.acceptance.json`].sort());
  // the index row whole: the Release, this tar and commit, the acceptance, and the drill column naming this receipt
  const drill = `PASS_A_PER_NODE_STEPS_REMAIN receipt ${sha(fs.readFileSync(done.receiptFile))}`;
  assert.equal(sealed.drill, drill);
  assert.deepEqual(fs.readFileSync(index, 'utf8').split('\r\n').slice(2),
    [`| ${version} | https://github.com/${repo}/releases/tag/${tag} | ${sha(tar)} | ${commit} | 2026-11-19T12:22:39Z | ${record.target_refs[0].id} | ${drill} |`, '']);
});

test('abort cleanup checks VM ownership, stops before restore and never acts on a different marker', opts, () => {
  const r = ps(`
    $script:events = @(); $script:vm = @{ State = 'Running' }
    $script:info = @{ vm = $script:vm; notes = $script:Drill.Marker; state = 'Running' }
    function Get-DrillVmInfo { $script:info }
    function Stop-VM { param($VM, [switch]$TurnOff, [switch]$Force, $ErrorAction) $script:events += 'stop'; $script:vm.State = 'Off' }
    function Restore-VMCheckpoint { param($VMName, $Name, $Confirm, $ErrorAction) $script:events += 'restore' }
    function Get-VM { param($Name, $ErrorAction) $script:vm }
    $off = Stop-DrillOwnedVm -RestoreCheckpoint
    $script:info.notes = 'someone-else'
    $code = try { Stop-DrillOwnedVm -RestoreCheckpoint; 'BAD' } catch { (Get-DrillCode $_).code }
    @{ off = $off; code = $code; events = $script:events }
  `);
  assert.deepEqual(r, { off: true, code: 'DRILL_VM_NAME_TAKEN_NOT_OURS', events: ['stop', 'restore'] });
});

test('the host memory gate refuses below guest 8 GB + reserve 6 GB + the boot margin free at boot, with no retry', opts, () => {
  const r = ps(`$t = 14GB + $script:Drill.BootMarginBytes; @((Test-DrillHostMemory ($t - 1)), (Test-DrillHostMemory $t))`);
  assert.equal(r[0].ok, false); assert.equal(r[0].code, 'DRILL_HOST_MEMORY_SHORT');
  assert.equal(r[1].ok, true);
});

// Fable renew-key ruling, supplement "drill host memory" item 2: the boot gate (guest + reserve) had no margin over the running gate,
// so a host just over it was bound to fall under the running gate once the guest started. The boot gate is guest + running gate +
// BootMarginBytes, the margin read from that one constant (its value is Fable's and provisional), and the samples on either side of
// both gates are derived from it: whatever the value, a boot during which other usage grows by at most the margin keeps running.
test('the boot gate is the guest plus the running gate plus the single boot margin constant', opts, () => {
  const r = ps(`
    function Test-DrillGates {
      $g = $script:Drill.MemoryBytes; $m = $script:Drill.BootMarginBytes
      $boot = (Test-DrillHostMemory 0).requiredFreeBytes
      $running = (Test-DrillHostMemory 0 -Running -MemoryAssigned $g).requiredFreeBytes
      @{ identity = ($boot -eq $g + $running + $m)
        actions = @((Test-DrillHostMemory ($boot - 1)).ok, (Test-DrillHostMemory $boot).ok,
          (Test-DrillHostMemory ($boot - $g - $m) -Running -MemoryAssigned $g).ok,
          (Test-DrillHostMemory ($boot - $g - $m - 1) -Running -MemoryAssigned $g).ok) }
    }
    $configured = Test-DrillGates
    $script:Drill.BootMarginBytes = $script:Drill.BootMarginBytes + 3GB
    @{ configured = $configured; changed = (Test-DrillGates) }`);
  for (const gates of [r.configured, r.changed]) {
    assert.equal(gates.identity, true);
    assert.deepEqual(gates.actions, [false, true, true, false]);
  }
});

// The receipt of run 20261119T172257Z: 19.7 GB free before boot, then aborted at 5.8 GB while an Actions runner job on the host was
// growing the production WSL. The boot gate is memory only (Fable plan 0e418483 "drill boot gate: memory only"): 19.7 GB passes its
// 15 GB with the job's Runner.Worker in the process list, the job is recorded; the growth after the boot is the running gate's to stop.
test('the field sample of run 20261119T172257Z boots at the 15 GB gate: the runner job is recorded, not judged', opts, () => {
  const r = ps(`Test-DrillHostSafety ${q(idleHostStatus())} ([long](19.7 * 1GB)) -ProcessNames @('Runner.Listener', 'Runner.Worker')`);
  assert.equal(r.action, 'start');
  assert.equal(r.code, null);
  assert.equal(r.busyWith, 'ACTIONS_RUNNER_JOB');
  assert.equal(Math.round(r.requiredFreeBytes / 2 ** 30 * 10) / 10, 15);
});

// T1 (Fable plan 0e418483 "drill boot gate: memory only", 2026-11-23): r12 (run 20261122T142017Z) was refused at the boot gate with
// DRILL_HOST_MEMORY_SHORT -- mode STANDBY, a Runner.Worker on the host and a job in WSL, 19.2 GB free against the old 25.4 GB job tier. The
// boot gate looks at memory only: 15 GB (guest 8 + margin 1 + production reserve 6) whatever the jobs; the jobs are recorded, never judged.
test('T1: the r12 sample (a job on both sides, 19.2 GB free) boots: the boot gate is 15 GB, the job only recorded', opts, () => {
  const r = ps(`Test-DrillHostSafety ${q(idleHostStatus())} ([long](19.2 * 1GB)) -ProcessNames @('Runner.Listener', 'Runner.Worker') -WslJob $true`);
  assert.deepEqual([r.action, r.code, r.busyWith, r.runnerJob, Math.round(r.requiredFreeBytes / 2 ** 30 * 10) / 10],
    ['start', null, 'ACTIONS_RUNNER_JOB', 'yes', 15]);
});

// Fable renew-key ruling, supplement "drill hold and the Actions self-hosted runners on the same host" (Clued Task e71ceb33): the hold
// drains the resident but not the host's Actions runners. A job one of them is executing (a Runner.Worker process) no longer refuses the
// boot (supplement "drill boot gate and the train both want DESK"), nor raises its memory gate (Fable plan 0e418483): it is recorded. Judged from the process list, not from
// runner names; a job picked up after the boot is left to the running memory gate.
test('the boot gate boots at ample memory with an Actions runner job on the host, records it, and a running drill is not aborted by one', opts, () => {
  const r = ps(`
    function Read-DrillHostStatus { ${q(idleHostStatus())} }
    function Get-CimInstance { param($ClassName, $OperationTimeoutSec, $ErrorAction) @{ FreePhysicalMemory = 64GB / 1KB } }
    function Get-VM { param($ErrorAction) @{ Name = $script:Drill.VmName; Notes = $script:Drill.Marker; MemoryStartup = 8GB; MemoryAssigned = $script:assigned } }
    function Get-Process { param($ErrorAction) $script:names | ForEach-Object { [pscustomobject]@{ ProcessName = $_ } } }
    function Get-DrillRunnerDistributions { param($HostName) }
    $script:assigned = 0
    $script:names = @('System', 'Runner.Listener', 'Runner.Listener', 'svchost')
    $listening = Get-DrillHostSafety
    $script:names = @('System', 'Runner.Listener', 'Runner.Worker', 'svchost')
    $busy = Get-DrillHostSafety
    $script:assigned = 8GB
    $running = Get-DrillHostSafety -Running
    @{ listening = $listening; busy = $busy; running = $running }`);
  assert.deepEqual([r.listening.action, r.listening.runnerJob, r.listening.requiredFreeBytes], ['start', 'no', 15 * 2 ** 30]);
  assert.deepEqual([r.busy.action, r.busy.code, r.busy.busyWith, r.busy.runnerJob, Math.round(r.busy.requiredFreeBytes / 2 ** 30 * 10) / 10], ['start', null, 'ACTIONS_RUNNER_JOB', 'yes', 15]);
  assert.equal(r.running.action, 'continue');
});

// Fable renew-key ruling, supplements "WSL runner jobs" and "branch one, round four": this host's Linux Actions runners execute their jobs
// inside a WSL distribution, where the Windows process list does not see their Runner.Worker. The question asked there is a yes or no,
// answered by an exit code alone: pgrep -ix Runner.Worker. Its standard output is never read. Two small closed tables decide everything:
// the probe's (exit x stderr x time out) and the running list's (the one output still read).
test('a job on either side, or a WSL side that could not be read, is recorded only and boots at ample memory', opts, () => {
  const r = ps(`
    $s = ${q(idleHostStatus())}
    @{ wslJob = (Test-DrillHostSafety $s 64GB -ProcessNames @('Runner.Listener') -WslJob $true)
      quiet = (Test-DrillHostSafety $s 64GB -ProcessNames @('Runner.Listener') -WslJob $false)
      unreadable = (Test-DrillHostSafety $s 64GB -ProcessNames @('Runner.Listener') -WslJob $null)
      windowsJob = (Test-DrillHostSafety $s 64GB -ProcessNames @('Runner.Worker') -WslJob $false)
      running = (Test-DrillHostSafety $s 64GB -Running -WslJob $true) }`);
  assert.deepEqual([r.wslJob.action, r.wslJob.code, r.wslJob.busyWith, r.wslJob.runnerJob], ['start', null, 'WSL_ACTIONS_RUNNER_JOB', 'yes']);
  assert.deepEqual([r.quiet.action, r.quiet.busyWith, r.quiet.runnerJob], ['start', null, 'no']);
  assert.deepEqual([r.unreadable.action, r.unreadable.code, r.unreadable.busyWith, r.unreadable.runnerJob], ['start', null, 'WSL_UNREADABLE', 'unknown']);
  assert.deepEqual([r.windowsJob.action, r.windowsJob.code, r.windowsJob.busyWith], ['start', null, 'ACTIONS_RUNNER_JOB']);
  assert.equal(r.running.action, 'continue');
});

// Fable renew-key ruling, supplement "drill boot gate and the train both want DESK": a runner job no longer refuses the boot; and since
// Fable plan 0e418483 ("drill boot gate: memory only") it no longer raises the gate either. One gate before boot, 15 GB (reserve 6 +
// guest 8 + margin 1), with a job on either side, without, or with a job query that failed; the job is recorded only. The running gate
// (6 GB after the guest) is unchanged.
test('the boot gate is 15 GB with or without a runner job, or a failed job query; the job is recorded, not judged', opts, () => {
  const r = ps(`
    $s = ${q(idleHostStatus())}
    $gate = { param($free, $names, $wsl) $x = Test-DrillHostSafety $s $free -ProcessNames $names -WslJob $wsl
      [ordered]@{ action = $x.action; code = $x.code; busyWith = $x.busyWith; runnerJob = $x.runnerJob; requiredGB = [Math]::Round($x.requiredFreeBytes / 1GB, 1) } }
    [ordered]@{
      windowsBusy26 = (& $gate 26GB @('Runner.Listener', 'Runner.Worker') $false)
      wslBusy26 = (& $gate 26GB @('Runner.Listener') $true)
      busy18 = (& $gate 18GB @('Runner.Worker') $false)
      busy14 = (& $gate 14GB @('Runner.Worker') $false)
      unreadable26 = (& $gate 26GB @('Runner.Listener') $null)
      unreadable14 = (& $gate 14GB @('Runner.Listener') $null)
      busyAtTier = (& $gate ([long](Test-DrillHostMemory 0).requiredFreeBytes) @('Runner.Worker') $false)
      busyUnderTier = (& $gate ([long](Test-DrillHostMemory 0).requiredFreeBytes - 1) @('Runner.Worker') $false)
      quiet15 = (& $gate 15GB @('Runner.Listener') $false)
      quietUnder15 = (& $gate (15GB - 1) @('Runner.Listener') $false)
      runningBusy = (Test-DrillHostSafety $s 6GB -Running -MemoryAssigned 8GB -WslJob $true).action
      runningShort = (Test-DrillHostSafety $s (6GB - 1) -Running -MemoryAssigned 8GB).code }`);
  assert.deepEqual(r.windowsBusy26, { action: 'start', code: null, busyWith: 'ACTIONS_RUNNER_JOB', runnerJob: 'yes', requiredGB: 15 });
  assert.deepEqual(r.wslBusy26, { action: 'start', code: null, busyWith: 'WSL_ACTIONS_RUNNER_JOB', runnerJob: 'yes', requiredGB: 15 });
  assert.deepEqual(r.busy18, { action: 'start', code: null, busyWith: 'ACTIONS_RUNNER_JOB', runnerJob: 'yes', requiredGB: 15 });
  assert.deepEqual(r.busy14, { action: 'refuse', code: 'DRILL_HOST_MEMORY_SHORT', busyWith: 'ACTIONS_RUNNER_JOB', runnerJob: 'yes', requiredGB: 15 });
  assert.deepEqual(r.unreadable26, { action: 'start', code: null, busyWith: 'WSL_UNREADABLE', runnerJob: 'unknown', requiredGB: 15 });
  assert.equal(r.unreadable14.code, 'DRILL_HOST_MEMORY_SHORT');
  assert.equal(r.busyAtTier.action, 'start');
  assert.equal(r.busyUnderTier.code, 'DRILL_HOST_MEMORY_SHORT');
  assert.deepEqual(r.quiet15, { action: 'start', code: null, busyWith: null, runnerJob: 'no', requiredGB: 15 });
  assert.equal(r.quietUnder15.code, 'DRILL_HOST_MEMORY_SHORT');
  assert.equal(r.runningBusy, 'continue', 'the running gate is unchanged: 6 GB after the guest, a job is no abort');
  assert.equal(r.runningShort, 'DRILL_HOST_MEMORY_SHORT');
});

// The r6 receipt (run 20261121T010455Z-2026.11.21-b7d92a1a-4b3f5ee5, evidence.hostMemory; Fable ruling on r6 Linux phase A, section 5):
// a runner job at boot, 27.0 GB free before boot, 19.3 GB once the guest was up, 8.9 GB at the lowest while running -- the host's other
// usage grew 10.4 GB after the boot. The figures are written here, not read from the script. Since Fable plan 0e418483 ("drill boot
// gate: memory only") the boot gate does not try to foresee that growth (it came after the boot, with or without a job at boot): a boot
// that just passes the 15 GB gate, then loses the guest and that growth, is stopped by the running gate -- the production reserve holds.
test('the r6 receipt replayed: from the 15 GB boot gate, the measured growth after boot is stopped by the running gate', opts, () => {
  const r = ps(`
    $s = ${q(idleHostStatus())}
    $boot = (Test-DrillHostSafety $s 0 -ProcessNames @('Runner.Worker')).requiredFreeBytes
    $minRunning = $boot - 8GB - [long]((19.3 - 8.9) * 1GB)
    @{ bootGB = [Math]::Round($boot / 1GB, 1); minRunningGB = [Math]::Round($minRunning / 1GB, 1)
      atBoot = (Test-DrillHostSafety $s $boot -ProcessNames @('Runner.Worker')).action
      running = (Test-DrillHostSafety $s $minRunning -Running -MemoryAssigned 8GB).action }`);
  assert.equal(r.atBoot, 'start');
  assert.equal(r.bootGB, 15);
  assert.equal(r.running, 'abort', `boot gate ${r.bootGB} GB leaves ${r.minRunningGB} GB after the r6 growth: the running gate stops it`);
});

// Codex review of f9ab1bb26, medium 1: the Windows process list that could not be read is a job query that failed, like the WSL side's:
// recorded, the WSL side and memory still read, no refusal by itself. A memory reading that fails still refuses (a resource failure).
test('a Windows job query that fails is recorded and goes on to read memory; a memory read that fails still refuses', opts, () => {
  const r = ps(`
    function Read-DrillHostStatus { ${q(idleHostStatus())} }
    function Get-CimInstance { param($ClassName, $OperationTimeoutSec, $ErrorAction) if ($script:memoryFails) { throw 'WMI unavailable' }; @{ FreePhysicalMemory = $script:free / 1KB } }
    function Get-VM { param($ErrorAction) }
    function Get-Process { param($ErrorAction) throw 'Access is denied' }
    function Get-DrillRunnerDistributions { param($HostName) }
    $script:memoryFails = $false
    $script:free = 26GB; $at26 = Get-DrillHostSafety
    $early = Get-DrillHostSafety -JobsOnly
    $script:free = 14GB; $at14 = Get-DrillHostSafety
    $script:memoryFails = $true; $script:free = 64GB; $noMemory = Get-DrillHostSafety
    $pick = { param($x) $req = Get-Prop $x 'requiredFreeBytes'
      [ordered]@{ action = $x.action; code = $x.code; busyWith = (Get-Prop $x 'busyWith'); runnerJob = (Get-Prop $x 'runnerJob'); requiredGB = $(if ($req) { [Math]::Round($req / 1GB, 1) }) } }
    [ordered]@{ at26 = (& $pick $at26); early = (& $pick $early); at14 = (& $pick $at14); noMemory = (& $pick $noMemory) }`);
  assert.deepEqual(r.at26, { action: 'start', code: null, busyWith: 'WINDOWS_UNREADABLE', runnerJob: 'unknown', requiredGB: 15 });
  assert.deepEqual([r.early.action, r.early.busyWith, r.early.runnerJob], ['start', 'WINDOWS_UNREADABLE', 'unknown'], 'the early sample does not refuse either');
  assert.deepEqual([r.at14.action, r.at14.code, r.at14.requiredGB], ['refuse', 'DRILL_HOST_MEMORY_SHORT', 15]);
  assert.deepEqual([r.noMemory.action, r.noMemory.code], ['refuse', 'DRILL_HOST_RESOURCE_UNREADABLE']);
});

// Codex re-review of bde9aaa52, lows 1 and 2: a job confirmed in one runner distribution stays a confirmed job when another could not be
// read; a sample the duty check refused before any job was read says nothing about jobs (not "no").
test('a confirmed WSL job survives another distribution unread; a duty refusal carries no job reading', opts, () => {
  const r = ps(`
    function Read-DrillHostStatus { ${q(idleHostStatus())} }
    function Get-CimInstance { param($ClassName, $OperationTimeoutSec, $ErrorAction) @{ FreePhysicalMemory = 64GB / 1KB } }
    function Get-VM { param($ErrorAction) }
    function Get-Process { param($ErrorAction) [pscustomobject]@{ ProcessName = 'Runner.Listener' } }
    function Get-DrillWslRunnerState { param($HostName) @{ ok = $false; distributions = @('A', 'B'); running = @('A', 'B'); jobs = @('A'); reason = 'WSL_PROCESS_QUERY_FAILED' } }
    $partial = Get-DrillHostSafety
    function Read-DrillHostStatus { ${q(activeHostStatus(null))} }
    $duty = Get-DrillHostSafety -JobsOnly
    [ordered]@{ partial = [ordered]@{ action = $partial.action; busyWith = $partial.busyWith; runnerJob = $partial.runnerJob }
      duty = [ordered]@{ code = $duty.code; busyWith = (Get-Prop $duty 'busyWith'); runnerJob = (Get-Prop $duty 'runnerJob') } }`);
  assert.deepEqual(r.partial, { action: 'start', busyWith: 'WSL_ACTIONS_RUNNER_JOB', runnerJob: 'yes' });
  assert.deepEqual(r.duty, { code: 'DRILL_HOST_IS_ON_DUTY', busyWith: null, runnerJob: null });
});

// The receipt keeps raw facts only (Fable renew-key ruling, supplement "contention label stop-loss"): free before boot and the tier, the
// runner jobs at boot (yes / no / unknown) and what the gate saw, free once the guest is up (the running guard's first reading), the
// lowest while running and the lowest of the whole run. No contention class, and no failure or step record is read to make one.
test('the receipt memory record: raw facts -- before boot, the tier, the jobs at boot, after boot, the lowest -- and no class', opts, () => {
  const r = ps(`
    $state = [hashtable]::Synchronized(@{ afterBootFreeGB = $null; minRunningFreeGB = $null })
    foreach ($g in @(12.5, 9.1, 10.4)) { Add-DrillRunningMemory $state @{ freeGB = $g } }
    Add-DrillRunningMemory $state @{ freeGB = $null }
    $running = [ordered]@{ afterBootFreeGB = $state.afterBootFreeGB; minRunningFreeGB = $state.minRunningFreeGB }
    $yes = @{ bootGate = [ordered]@{ freeGB = 23.4; runnerJob = 'yes'; busyWith = 'WSL_ACTIONS_RUNNER_JOB'; requiredFreeGB = 21 } }
    $unknown = @{ bootGate = [ordered]@{ freeGB = 8.2; runnerJob = 'unknown'; busyWith = 'WSL_UNREADABLE'; requiredFreeGB = 21 } }
    [ordered]@{ yes = (Get-DrillHostMemoryEvidence $yes $running); unknown = (Get-DrillHostMemoryEvidence $unknown $running)
      none = (Get-DrillHostMemoryEvidence $null $null)
      params = @((Get-Command Get-DrillHostMemoryEvidence).Parameters.Keys | Where-Object { $_ -in @('PreBoot', 'RunningMemory', 'Failure', 'FirstInstallSteps', 'Entry') }) }`);
  assert.deepEqual(r.yes, { beforeBootFreeGB: 23.4, requiredFreeGB: 21, runnerJobAtBoot: 'yes', runnerJobBefore: 'WSL_ACTIONS_RUNNER_JOB',
    afterBootFreeGB: 12.5, minRunningFreeGB: 9.1, lowestFreeGB: 9.1 });
  assert.deepEqual([r.unknown.runnerJobAtBoot, r.unknown.lowestFreeGB], ['unknown', 8.2], 'the lowest of the whole run includes the boot gate');
  assert.deepEqual(r.none, { beforeBootFreeGB: null, requiredFreeGB: null, runnerJobAtBoot: null, runnerJobBefore: null,
    afterBootFreeGB: null, minRunningFreeGB: null, lowestFreeGB: null });
  assert.deepEqual(r.params, ['PreBoot', 'RunningMemory'], 'the record reads neither the failure nor the step record');
});

// Nothing in the drill classes a time-out (the stop-loss): no contention label, no code tables for it, no read-back of time-out text.
test('no automatic contention class is left in the drill', () => {
  const text = fs.readFileSync(script, 'utf8');
  for (const gone of ['SUSPECTED_HOST_CONTENTION', 'Get-DrillHostContention', 'DrillGuestTimedStepCodes', 'DrillPackageTimedStepCodes',
    'Get-DrillGuestCommandTimeout', 'DRILL_GUEST_COMMAND_TIMEOUT']) assert.ok(!text.includes(gone), gone);
});

// CI run 44746396297 (clued-ci-home-win-01): the WSL world's tests ran more than HostStatusStaleSeconds after this file loaded, and the
// gate read the world's host status as stale. The world's status must not age: it is written at T0 and the gate reads it at T0
// whenever the test runs; the gate still judges by the drill's clock, so the same status read HostStatusStaleSeconds + 1 later is stale.
test('the WSL world does not age: its host status is written at T0 and the gate reads it at T0, however long after this file loaded', opts, () => {
  const r = ps(`${wslWorld}
    $script:probe = @{ exit = 0; stdout = ''; stderr = '' }
    $fresh = Get-DrillHostSafety
    $later = (Get-DrillTime).AddSeconds($script:Drill.HostStatusStaleSeconds + 1)
    function Get-DrillTime { $later }
    $stale = Get-DrillHostSafety
    @(@{ action = $fresh.action; code = $fresh.code; busyWith = $fresh.busyWith }, @{ action = $stale.action; code = $stale.code })`);
  assert.deepEqual(r, [{ action: 'start', code: null, busyWith: 'WSL_ACTIONS_RUNNER_JOB' }, { action: 'refuse', code: 'DRILL_HOST_STATUS_STALE' }]);
});

// The probe's closed table, cell by cell, end to end through the boot gate; and the reverse: across exits -2..9 and stderr empty, blank,
// text, and missing, the one cell that gives "no job" is exit 1 with nothing on stderr; the one that gives "a job" is exit 0 with nothing.
test('the probe: exit 0 a job, exit 1 none, anything else -- another exit, anything on stderr, a time out -- reads as unreadable (recorded only); nothing else says none', opts, () => {
  const r = ps(`${wslWorld}
    function Gate($probe) { $script:probe = $probe; $s = Get-DrillHostSafety; @{ action = $s.action; code = $s.code; busyWith = $s.busyWith } }
    $cells = [ordered]@{
      job = (Gate @{ exit = 0; stdout = ''; stderr = '' }); none = (Gate @{ exit = 1; stdout = ''; stderr = '' })
      'job-with-stderr' = (Gate @{ exit = 0; stdout = ''; stderr = 'pgrep: warning' }); 'none-with-stderr' = (Gate @{ exit = 1; stdout = ''; stderr = 'pgrep: warning' })
      'none-with-blank-stderr' = (Gate @{ exit = 1; stdout = ''; stderr = ' ' }); 'syntax-error' = (Gate @{ exit = 2; stdout = ''; stderr = '' })
      fatal = (Gate @{ exit = 3; stdout = ''; stderr = '' }); 'no-exit' = (Gate @{ stdout = ''; stderr = '' }); 'exit-as-text' = (Gate @{ exit = '1'; stdout = ''; stderr = '' })
      timeout = (Gate 'timeout'); 'none-whatever-stdout' = (Gate @{ exit = 1; stdout = 'Runner.Worker 123'; stderr = '' }) }
    $sweep = @()
    foreach ($exit in -2..9) { foreach ($err in @('', ' ', 'x', $null)) {
      $v = try { Get-DrillWslJobVerdict @{ exit = $exit; stderr = $err } } catch { 'FAILED' }
      $sweep += [ordered]@{ exit = $exit; stderr = $err; verdict = $v } } }
    @{ cells = $cells; sweep = $sweep; probeArgv = @($script:calls | Where-Object { $_ -notlike '--list*' } | Select-Object -Unique) }`);
  const c = r.cells;
  assert.deepEqual(c.job, { action: 'start', code: null, busyWith: 'WSL_ACTIONS_RUNNER_JOB' });
  assert.deepEqual(c.none, { action: 'start', code: null, busyWith: null });
  assert.deepEqual(c['none-whatever-stdout'], { action: 'start', code: null, busyWith: null }, 'stdout is never read');
  for (const cell of ['job-with-stderr', 'none-with-stderr', 'none-with-blank-stderr', 'syntax-error', 'fatal', 'no-exit', 'exit-as-text', 'timeout']) {
    assert.deepEqual(c[cell], { action: 'start', code: null, busyWith: 'WSL_UNREADABLE' }, cell);
  }
  const none = r.sweep.filter(x => x.verdict === 'NO_JOB'), job = r.sweep.filter(x => x.verdict === 'JOB');
  assert.deepEqual(none.map(x => [x.exit, x.stderr]), [[1, ''], [1, null]]);
  assert.deepEqual(job.map(x => [x.exit, x.stderr]), [[0, ''], [0, null]]);
  assert.equal(r.sweep.filter(x => !['NO_JOB', 'JOB', 'FAILED'].includes(x.verdict)).length, 0);
  assert.deepEqual(r.probeArgv, ['--distribution Fixture-CI --exec pgrep -ix Runner[.]Worker']);
});

// The running list, the one output still read, by one fixed rule: cut at line ends, only lines of length zero dropped, every other line
// whole and untrimmed the name of a distribution this account has registered -- or the whole answer is refused. Its exit and stderr as
// every WSL call. Then, only a distribution in a list that read is asked anything; one that is not running is asked nothing.
test('the running list: whole registered names only, else unreadable (recorded only); a distribution not in it is asked nothing', opts, () => {
  const lists = {
    empty: ['', true, []], 'one-crlf': ['Fixture-CI\r\n', true, ['Fixture-CI']], 'one-lf': ['Fixture-CI\n', true, ['Fixture-CI']],
    'two-and-empty-lines': ['docker-desktop\r\n\r\nFixture-CI\r\n\r\n', true, ['docker-desktop', 'Fixture-CI']], 'only-line-ends': ['\r\n\n', true, []],
    'leading-space': [' Fixture-CI\r\n', false], 'trailing-space': ['Fixture-CI \r\n', false], 'blank-line': ['docker-desktop\n \n', false],
    'cut-short': ['Fixture-C\r\n', false], 'lone-cr': ['Fixture-CI\r', false], nul: ['Fixture-CI\u0000\r\n', false], 'other-case': ['fixture-ci\r\n', false],
    unregistered: ['Not-Registered\r\n', false], message: ['There are no running distributions.\r\n', false] };
  const r = ps(`${wslWorld}
    $lists = ${q(JSON.stringify(lists))} | ConvertFrom-Json
    $out = [ordered]@{}
    foreach ($p in $lists.PSObject.Properties) {
      $out[$p.Name] = try { ,@(ConvertFrom-DrillWslRunningList @{ exit = 0; stdout = [string]$p.Value[0]; stderr = '' } @('docker-desktop', 'Fixture-CI')) } catch { (Get-DrillCode $_).code }
    }
    foreach ($bad in @(@{ exit = 1; stdout = "Fixture-CI\`r\`n"; stderr = '' }, @{ exit = 0; stdout = "Fixture-CI\`r\`n"; stderr = 'wsl: x' }, @{ exit = 0; stdout = "Fixture-CI\`r\`n"; stderr = ' ' })) {
      $out["bad-$($out.Count)"] = try { ConvertFrom-DrillWslRunningList $bad @('Fixture-CI') } catch { (Get-DrillCode $_).code }
    }
    # end to end: a list that does not read is recorded as unreadable; a list without the runner distribution asks it nothing
    $script:probe = @{ exit = 0; stdout = ''; stderr = '' }
    $script:list = @{ exit = 0; stdout = "Fixture-CI \`r\`n"; stderr = '' }
    $refused = Get-DrillHostSafety
    $script:calls.Clear(); $script:list = @{ exit = 0; stdout = "docker-desktop\`r\`n"; stderr = '' }
    $stopped = Get-DrillHostSafety
    @{ out = $out; refused = @{ code = $refused.code; busyWith = $refused.busyWith; why = $refused.wslUnreadable }; stopped = @{ action = $stopped.action }; stoppedCalls = @($script:calls) }`);
  for (const [name, [, ok, names]] of Object.entries(lists)) {
    if (ok) assert.deepEqual(r.out[name], names, name);
    else assert.equal(r.out[name], 'WSL_RUNNING_LIST_UNREADABLE', name);
  }
  for (const k of Object.keys(r.out).filter(k => k.startsWith('bad-'))) assert.equal(r.out[k], 'WSL_RUNNING_LIST_FAILED', k);
  assert.deepEqual(r.refused, { code: null, busyWith: 'WSL_UNREADABLE', why: 'WSL_RUNNING_LIST_UNREADABLE' }, 'unreadable: recorded, no refusal');
  assert.deepEqual(r.stopped, { action: 'start' });
  assert.deepEqual(r.stoppedCalls, ['--list --running --quiet'], 'a distribution that is not running is asked nothing');
});

// Codex review of addf1ffa5, medium 1: only a host entry that has no Linux runner entry at all skips the probe. A runner entry whose
// distro is missing, null, not a name, or a name with anything after it (a NUL, a line end), refuses the boot like an unreadable registry;
// two names that differ only by such a character are never merged into one.
test('a Linux runner entry without a readable distro is unreadable (recorded only); only an entry with no Linux runner at all skips the probe', opts, () => {
  const profiles = path.join(tmp, 'node-profiles-broken.json');
  const hosts = {
    'NO-DISTRO': { linux_runner: { name: 'r' } }, 'NULL-DISTRO': { linux_runner: { distro: null } }, 'NULL-RUNNER': { linux_runner: null },
    'NUMBER-DISTRO': { linux_runner: { distro: 7 } }, 'EMPTY-DISTRO': { linux_runner: { distro: '' } },
    'ADDITIONAL-NULL': { linux_runner: { distro: 'Fixture-CI' }, additional_linux_runners: [null] },
    'ADDITIONAL-NO-DISTRO': { linux_runner: { distro: 'Fixture-CI' }, additional_linux_runners: [{ name: 'r2' }] },
    'ADDITIONAL-NOT-A-LIST': { linux_runner: { distro: 'Fixture-CI' }, additional_linux_runners: { distro: 'Fixture-CI' } },
    'NUL-TWIN': { linux_runner: { distro: 'Fixture-CI' }, additional_linux_runners: [{ distro: 'Fixture-CI\u0000' }] },
    'LINE-END': { linux_runner: { distro: 'Fixture-CI\n' } },
    'NO-LINUX': { windows_runner: { name: 'w' } }, 'NO-LINUX-EMPTY-LIST': { additional_linux_runners: [] },
    'TWO-SAME': { linux_runner: { distro: 'Fixture-CI' }, additional_linux_runners: [{ distro: 'Fixture-CI' }, { distro: 'Fixture-CI-2' }] } };
  fs.writeFileSync(profiles, JSON.stringify({ hosts: Object.entries(hosts).map(([hostname, h]) => ({ hostname, ...h })) }));
  const r = ps(`
    $script:Drill.NodeProfiles = ${q(profiles)}
    $out = [ordered]@{}
    foreach ($h in ${q(Object.keys(hosts).join(','))}.Split(',')) {
      $out[$h] = try { ,@(Get-DrillRunnerDistributions $h) } catch { (Get-DrillCode $_).code }
    }
    # end to end: such an entry reads as unreadable (recorded only), with no WSL call and no registry read
    $script:calls = 0
    function Get-DrillWslRegisteredNames { $script:calls++; 'Fixture-CI' }
    $script:DrillWslRunner = { param($a) $script:calls++; @{ exit = 1; stdout = ''; stderr = '' } }
    function Read-DrillHostStatus { ${q(idleHostStatus())} }
    function Get-Process { param($ErrorAction) [pscustomobject]@{ ProcessName = 'Runner.Listener' } }
    $env:COMPUTERNAME = 'NULL-DISTRO'
    $s = Get-DrillHostSafety -JobsOnly
    @{ out = $out; gate = @{ action = $s.action; code = $s.code; busyWith = $s.busyWith; why = $s.wslUnreadable }; calls = $script:calls }`);
  for (const h of ['NO-DISTRO', 'NULL-DISTRO', 'NULL-RUNNER', 'NUMBER-DISTRO', 'EMPTY-DISTRO', 'ADDITIONAL-NULL', 'ADDITIONAL-NO-DISTRO',
    'ADDITIONAL-NOT-A-LIST', 'NUL-TWIN', 'LINE-END']) {
    assert.equal(r.out[h], 'NODE_PROFILES_RUNNER_DISTRIBUTION_INVALID', h);
  }
  assert.deepEqual(r.out['NO-LINUX'], []);
  assert.deepEqual(r.out['NO-LINUX-EMPTY-LIST'], []);
  assert.deepEqual(r.out['TWO-SAME'], ['Fixture-CI', 'Fixture-CI-2']);
  assert.deepEqual(r.gate, { action: 'start', code: null, busyWith: 'WSL_UNREADABLE', why: 'NODE_PROFILES_RUNNER_DISTRIBUTION_INVALID' });
  assert.equal(r.calls, 0);
});

// The distribution is the one this host's Linux runners are registered in (node-profiles.json by host name), never the resident's own; a
// host the registry does not know is refused; a registered host without a Linux runner asks WSL nothing; a runner distribution this account
// has not registered is refused.
test('the runner distribution by host name: an unknown host, an unregistered runner distribution refuse; no Linux runner asks nothing', opts, () => {
  const profiles = path.join(tmp, 'node-profiles-wsl.json');
  fs.writeFileSync(profiles, JSON.stringify({ hosts: [
    { hostname: 'FIXTURE-HOST', governance: { resident_distro: 'Fixture-Resident' }, linux_runner: { distro: 'Fixture-CI' },
      additional_linux_runners: [{ distro: 'Fixture-CI' }] },
    { hostname: 'WINDOWS-ONLY-HOST', windows_runner: { name: 'w' } }] }));
  const r = ps(`
    $real = @(Get-DrillRunnerDistributions 'desk-w-591')
    $script:Drill.NodeProfiles = ${q(profiles)}
    function Get-DrillWslRegisteredNames { $script:registered }
    $script:calls = [Collections.Generic.List[string]]::new()
    $script:DrillWslRunner = { param($a) $script:calls.Add($a -join ' '); if ($a[0] -ceq '--list') { return @{ exit = 0; stdout = "Fixture-CI\`r\`n"; stderr = '' } }; @{ exit = 1; stdout = ''; stderr = '' } }
    $script:registered = @('Fixture-CI')
    $known = Get-DrillWslRunnerState 'fixture-host'
    $knownCalls = @($script:calls); $script:calls.Clear()
    $windowsOnly = Get-DrillWslRunnerState 'WINDOWS-ONLY-HOST'
    $unknown = Get-DrillWslRunnerState 'NOT-A-RUNNER-HOST'
    $script:registered = @('Other-CI')
    $unregistered = Get-DrillWslRunnerState 'FIXTURE-HOST'
    @{ real = $real; known = $known; knownCalls = $knownCalls; windowsOnly = $windowsOnly; unknown = $unknown; unregistered = $unregistered; laterCalls = @($script:calls) }`);
  assert.deepEqual(r.real, ['CluedCI-Linux']);
  assert.equal(r.known.ok, true);
  assert.deepEqual(r.known.running, ['Fixture-CI']);
  assert.deepEqual(r.known.jobs, []);
  assert.deepEqual(r.knownCalls, ['--list --running --quiet', '--distribution Fixture-CI --exec pgrep -ix Runner[.]Worker']);
  assert.equal(r.windowsOnly.ok, true);
  assert.deepEqual(r.windowsOnly.distributions, []);
  assert.deepEqual([r.unknown.ok, r.unknown.reason], [false, 'HOST_NOT_IN_NODE_PROFILES']);
  assert.deepEqual([r.unregistered.ok, r.unregistered.reason], [false, 'WSL_RUNNER_DISTRIBUTION_NOT_REGISTERED']);
  assert.deepEqual(r.laterCalls, []);
});

// No wsl.exe and no registry read under a test marker (only injected stand-ins), and an injected runner never without one.
test('wsl.exe and the registry are never touched under a test marker, and an injected runner never runs without one', opts, () => {
  const r = ps(`
    function Get-Process { param($ErrorAction) [pscustomobject]@{ ProcessName = 'Runner.Listener' } }
    function Get-DrillRunnerDistributions { param($HostName) 'Fixture-CI' }
    $marked = try { Invoke-DrillWsl @('--list', '--running', '--quiet') | Out-Null; $null } catch { (Get-DrillCode $_).code }
    $registry = try { Get-DrillWslRegisteredNames | Out-Null; $null } catch { (Get-DrillCode $_).code }
    $release = Invoke-DrillWslCacheRelease
    $saved = $env:NODE_TEST_CONTEXT; $savedClued = $env:CLUED_UNDER_TEST
    $env:NODE_TEST_CONTEXT = $null; $env:CLUED_UNDER_TEST = $null
    $script:DrillWslRunner = { param($a) $script:ran = $true; @{ exit = 0; stdout = ''; stderr = '' } }
    $unmarked = try { Invoke-DrillWsl @('--list', '--running', '--quiet') | Out-Null; $null } catch { (Get-DrillCode $_).code }
    $env:NODE_TEST_CONTEXT = $saved; $env:CLUED_UNDER_TEST = $savedClued
    @{ marked = $marked; registry = $registry; release = $release; unmarked = $unmarked; ran = [bool](Get-Variable -Name ran -Scope Script -ValueOnly -ErrorAction SilentlyContinue) }`);
  assert.equal(r.marked, 'DRILL_HOST_ACCESS_UNDER_TEST');
  assert.equal(r.registry, 'DRILL_HOST_ACCESS_UNDER_TEST');
  assert.deepEqual(r.release.released, []);
  assert.equal(r.release.failed.code, 'DRILL_HOST_ACCESS_UNDER_TEST');
  assert.equal(r.unmarked, 'DRILL_WSL_RUNNER_WITHOUT_TEST_MARKER');
  assert.equal(r.ran, false);
});

// Codex review of addf1ffa5, low 1: the probe, the idle release and the memory abort's Runner.Worker count look for the same pattern, one
// constant, its dot a literal dot: as an extended regular expression matched whole (pgrep -x) and in any case (-i) it takes Runner.Worker
// and runner.worker, never RunnerXWorker. Run here through Git's grep -ixE, the same regular-expression form pgrep compiles. The idle
// release command (before the boot: Decision f572ac5b keeps 21db5a9c's "while idle") carries the constant verbatim; the running guard's
// command asks no pgrep, and is the idle one's release, word for word (independent review of a643c4b42, block 1).
test('one job pattern, its dot literal, in the probe and the idle release command alike; none in the running release command', shOpts, () => {
  const r = ps(`@{ pattern = $script:Drill.WslJobPattern; idle = $script:DrillWslIdleReleaseCommand; command = $script:DrillWslReleaseCommand }`);
  assert.equal(r.pattern, 'Runner[.]Worker');
  assert.ok(typeof r.idle === 'string' && r.idle.startsWith(`pgrep -ix '${r.pattern}' >/dev/null;`), String(r.idle));
  assert.doesNotMatch(r.command, /pgrep/, r.command);
  assert.ok(r.idle.endsWith(`; ${r.command}`), 'one release text in both');
  const grep = path.join(path.dirname(path.dirname(gitSh)), 'usr', 'bin', 'grep.exe');
  const names = ['Runner.Worker', 'runner.worker', 'RunnerXWorker', 'Runner.Workers', 'xRunner.Worker', 'Runner.Listener'];
  const hit = spawnSync(grep, ['-ixE', r.pattern], { input: names.join('\n') + '\n', encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  assert.deepEqual(hit, ['Runner.Worker', 'runner.worker']);
  // the idle release command hands pgrep exactly these arguments
  const w = shWorld('pgrep-args', { pgrep: 1 });
  const winDir = w.drop.replace(/\/drop_caches$/, '').replace(/^\/([a-z])\//, (m, d) => `${d.toUpperCase()}:/`);
  fs.writeFileSync(path.join(winDir, 'pgrep'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${w.drop.replace(/drop_caches$/, 'pgrep.args')}'\nexit 1\n`);
  const run = spawnSync(gitSh, ['-c', commandIn(w, r.idle)], { encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(fs.readFileSync(path.join(winDir, 'pgrep.args'), 'utf8').split('\n').filter(Boolean), ['-ix', 'Runner[.]Worker']);
});

// The idle release command's own closed table, run: pgrep found (0) -> exit 3, nothing synced or released; none (1) -> sync, release,
// exit 0; pgrep failed (2, 3, 137) -> exit 4, nothing synced or released; the sync failing -> exit 5. The only way to the release is
// pgrep's exit 1.
test('the idle release command: only pgrep\'s "none" reaches the release; a job exits 3, a failed lookup 4, a failed release 5', shOpts, () => {
  const command = ps('$script:DrillWslIdleReleaseCommand');
  assert.equal(typeof command, 'string', 'an idle release command');
  const cases = { job: [{ pgrep: 0 }, 3, false], none: [{ pgrep: 1 }, 0, true], 'pgrep-syntax': [{ pgrep: 2 }, 4, false], 'pgrep-fatal': [{ pgrep: 3 }, 4, false],
    'pgrep-killed': [{ pgrep: 137 }, 4, false], 'sync-fails': [{ pgrep: 1, sync: 1 }, 5, false] };
  for (const [name, [world, exit, released]] of Object.entries(cases)) {
    const w = shWorld(`idle-${name}`, world);
    const r = spawnSync(gitSh, ['-c', commandIn(w, command)], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, exit, `${name}: ${r.stdout}${r.stderr}`);
    assert.equal(w.dropped(), released, `${name}: released`);
    assert.equal(w.synced(), released || name === 'sync-fails', `${name}: synced`);
  }
});

// The running guard's release command, its own closed table, run (Decision f572ac5b: no job question in it): sync, release, exit 0 -- a
// pgrep stand-in on PATH that would say "a job" changes nothing; the sync failing, or the write failing, -> exit 5. Nothing else is released.
test('the running release command: sync then the release, exit 0; a failed sync or a failed write exits 5; a job changes nothing', shOpts, () => {
  const command = ps('$script:DrillWslReleaseCommand');
  const cases = { none: [{ pgrep: 1 }, 0, true, true], job: [{ pgrep: 0 }, 0, true, true], 'sync-fails': [{ sync: 1 }, 5, false, true],
    'write-fails': [{}, 5, false, true] };
  for (const [name, [world, exit, released, synced]] of Object.entries(cases)) {
    const w = shWorld(name, world);
    const winDrop = w.drop.replace(/^\/([a-z])\//, (m, d) => `${d.toUpperCase()}:/`);
    if (name === 'write-fails') fs.mkdirSync(winDrop);   // a directory where the write goes: the redirection fails
    const r = spawnSync(gitSh, ['-c', commandIn(w, command)], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, exit, `${name}: ${r.stdout}${r.stderr}`);
    assert.equal(fs.existsSync(winDrop) && fs.statSync(winDrop).isFile(), released, `${name}: released`);
    assert.equal(w.synced(), synced, `${name}: synced`);
  }
});

// The host's side of the release, closed too, in both uses of the one function. Before the boot (idle, the default): exit 0 released,
// exit 3 skipped (no failure: the boot gate decides), anything else a failed release (no failure of the drill either); before each
// distribution the running list, then the Windows side, are read again; a distribution not running, or a Windows job, gets no command.
// The running guard's (-WhileRunning, Decision f572ac5b): exit 0 released, anything else -- 3 included -- failed; the Windows side is not
// read, and a job there stops nothing.
test('the release on the host: idle, 3 skipped and a Windows job stops it; while running, 3 failed and the Windows side not read', opts, () => {
  const run = mode => ps(`
    function Get-DrillWslRegisteredNames { 'Fixture-A'; 'Fixture-B'; 'Fixture-C' }
    function Get-DrillRunnerDistributions { param($HostName) 'Fixture-A' }
    function Get-Process { param($ErrorAction) $script:calls.Add('windows'); $n = @('Runner.Listener'); if ($script:windowsJob) { $n += 'Runner.Worker' }; $n | ForEach-Object { [pscustomobject]@{ ProcessName = $_ } } }
    $script:calls = [Collections.Generic.List[string]]::new(); $script:windowsJob = $false; $script:jobDuringList = $false
    $script:DrillWslRunner = { param($a)
      if ($a[0] -ceq '--list') { $script:calls.Add('list'); if ($script:jobDuringList) { $script:windowsJob = $true }; return @{ exit = 0; stdout = "Fixture-A\`r\`nFixture-C\`r\`n"; stderr = '' } }
      $script:calls.Add($a[1]); if ($a[1] -ceq 'Fixture-C' -and $script:jobAfterC) { $script:windowsJob = $true }
      return $script:answer
    }
    $how = @{}; if (${q(mode)} -ceq 'running') { $how.WhileRunning = $true }
    $table = [ordered]@{}
    foreach ($exit in @(0, 3, 1, 2, 4, 5, -1, 137, $null, '0')) {
      $script:answer = @{ exit = $exit; stdout = 'anything'; stderr = 'anything' }
      $o = Invoke-DrillWslCacheRelease @how
      $key = if ($null -eq $exit) { 'null|null' } else { "$exit|$($exit.GetType().Name)" }
      $table[$key] = @{ released = @($o.released); skipped = (Get-Prop $o 'skipped'); failed = $(if ($o.failed) { $o.failed.code } else { $null }) }
    }
    $script:answer = @{ exit = 0; stdout = ''; stderr = '' }
    $script:calls.Clear(); $script:jobAfterC = $true
    function Get-DrillRunnerDistributions { param($HostName) 'Fixture-A'; 'Fixture-B'; 'Fixture-C' }
    $first = Invoke-DrillWslCacheRelease @how
    $firstCalls = @($script:calls); $script:calls.Clear(); $script:windowsJob = $false; $script:jobAfterC = $false
    $script:jobDuringList = $true
    $during = Invoke-DrillWslCacheRelease @how
    @{ table = $table; first = $first; firstCalls = $firstCalls; during = $during; duringCalls = @($script:calls) }`);
  const idle = run('idle');
  const t = idle.table;
  assert.deepEqual(t['0|Int32'], { released: ['Fixture-A'], skipped: null, failed: null });
  assert.deepEqual(t['3|Int32'], { released: [], skipped: { where: 'Fixture-A', reason: 'WSL_ACTIONS_RUNNER_JOB' }, failed: null });
  for (const k of Object.keys(t).filter(k => !['0|Int32', '3|Int32'].includes(k))) {
    assert.deepEqual(t[k], { released: [], skipped: null, failed: 'DRILL_WSL_CACHE_RELEASE_FAILED' }, `idle ${k}`);
  }
  assert.deepEqual(idle.firstCalls, ['list', 'windows', 'Fixture-A', 'list', 'list', 'windows', 'Fixture-C']);
  assert.deepEqual(idle.first.released, ['Fixture-A', 'Fixture-C']);
  assert.deepEqual(idle.first.results.map(x => [x.distribution, x.running]), [['Fixture-A', true], ['Fixture-B', false], ['Fixture-C', true]]);
  assert.deepEqual(idle.duringCalls, ['list', 'windows'], 'a Windows job picked up while the list was asked for: no command');
  assert.deepEqual(idle.during.skipped, { where: 'windows', reason: 'ACTIONS_RUNNER_JOB' });
  const running = run('running');
  const u = running.table;
  assert.deepEqual(u['0|Int32'], { released: ['Fixture-A'], skipped: null, failed: null });
  for (const k of Object.keys(u).filter(k => k !== '0|Int32')) {
    assert.deepEqual(u[k], { released: [], skipped: null, failed: 'DRILL_WSL_CACHE_RELEASE_FAILED' }, `running ${k}`);
  }
  assert.deepEqual(running.firstCalls, ['list', 'Fixture-A', 'list', 'list', 'Fixture-C'], 'the Windows side is not read');
  assert.deepEqual(running.first.released, ['Fixture-A', 'Fixture-C']);
  assert.deepEqual(running.duringCalls, ['list', 'Fixture-A', 'list', 'list', 'Fixture-C'], 'a Windows job stops nothing');
  assert.deepEqual(running.during.released, ['Fixture-A', 'Fixture-C']);
});

test('the release commands are two literals in single quotes, nothing put into them, and one that is not its literal is never sent', opts, () => {
  const r = ps(`
    function Get-Process { param($ErrorAction) [pscustomobject]@{ ProcessName = 'Runner.Listener' } }
    function Get-DrillRunnerDistributions { param($HostName) 'Fixture-CI' }
    function Get-DrillWslRegisteredNames { 'Fixture-CI' }
    $script:sent = [Collections.ArrayList]::new()
    $script:DrillWslRunner = { param($a)
      if ($a[0] -ceq '--list') { return @{ exit = 0; stdout = "Fixture-CI\`r\`n"; stderr = '' } }
      [void]$script:sent.Add(@($a)); @{ exit = 0; stdout = ''; stderr = '' }
    }
    $ok = Invoke-DrillWslCacheRelease
    $okRunning = Invoke-DrillWslCacheRelease -WhileRunning
    $idleSent = $script:sent[0]; $runningSent = $script:sent[1]; $script:sent.Clear()
    $tampered = [ordered]@{}
    foreach ($name in @('DrillWslReleaseCommand', 'DrillWslIdleReleaseCommand')) {
      $was = Get-Variable -Name $name -Scope Script -ValueOnly
      # one character more that a linguistic comparison passes over (Codex review of addf1ffa5, low 2)
      foreach ($t in @(@('more', '; rm -rf /tmp/x'), @('nul', [string][char]0))) {
        Set-Variable -Name $name -Scope Script -Value ($was + $t[1])
        $tampered["$name|$($t[0])|idle"] = $(try { (Invoke-DrillWslCacheRelease).failed.code } catch { 'THREW' })
        $tampered["$name|$($t[0])|running"] = $(try { (Invoke-DrillWslCacheRelease -WhileRunning).failed.code } catch { 'THREW' })
      }
      Set-Variable -Name $name -Scope Script -Value $was
    }
    @{ ok = $ok; okRunning = $okRunning; idleSent = $idleSent; runningSent = $runningSent; literal = $script:DrillWslReleaseCommand
      idle = $script:DrillWslIdleReleaseCommand; tampered = $tampered; tamperedSent = $script:sent.Count }`);
  assert.deepEqual(r.idleSent, ['--distribution', 'Fixture-CI', '--user', 'root', '--exec', 'sh', '-c', r.idle]);
  assert.deepEqual(r.runningSent, ['--distribution', 'Fixture-CI', '--user', 'root', '--exec', 'sh', '-c', r.literal]);
  for (const l of [r.literal, r.idle]) assert.doesNotMatch(String(l), /["\\\r\n]/, 'nothing the Windows command line could split or escape');
  assert.deepEqual([r.ok.released, r.okRunning.released], [['Fixture-CI'], ['Fixture-CI']]);
  assert.equal(Object.keys(r.tampered).length, 8);
  for (const [k, v] of Object.entries(r.tampered)) assert.equal(v, 'DRILL_WSL_RELEASE_COMMAND_NOT_LITERAL', k);
  assert.equal(r.tamperedSent, 0);
  const text = fs.readFileSync(script, 'utf8');
  for (const v of ['DrillWslReleaseCommand', 'DrillWslIdleReleaseCommand']) {
    assert.match(text, new RegExp(`^\\$script:${v} = '(?:[^']|'')+'$`, 'm'), `${v}: a single-quoted string, PowerShell puts nothing into it`);
  }
});

test('from the real entry: early refusal without memory, the release, then the boot gate judges memory once; short before the release still boots', shOpts, () => {
  const r = ps(`${preBootWorld()}
    Invoke-Entry`);
  assert.deepEqual(r.events, ['status', ...early, 'wsl-running', 'windows-processes', 'wsl-release exit 0', 'restore', 'status', ...gateMemory, ...bootGate, 'boot', 'restore-end']);
  assert.deepEqual(r.releases, ['idle'], 'before the boot: the idle release command');
  assert.ok(!r.events.some(e => e.startsWith('STOP')));
  assert.equal(r.out.status, 'DRILL_PREREQ_READY', JSON.stringify(r.out));
  const pre = r.out.hostPreBoot;
  assert.deepEqual([pre.early.ok, pre.early.freeGB], [true, null]);
  assert.deepEqual([pre.release.released, pre.release.skipped, pre.release.failed], [['Fixture-CI'], null, null]);
  assert.deepEqual([pre.bootGate.ok, pre.bootGate.freeGB], [true, 64]);
  for (const s of [pre.early, pre.release, pre.bootGate]) assert.match(s.at, /^\d{4}-\d\d-\d\dT/);
  for (const s of [pre.early, pre.bootGate]) assert.equal(Object.hasOwn(s, 'wslStartedByProbe'), false, 'no run-time record any more');
  const short = ps(`${preBootWorld({ freeAfterRelease: 10 })}
    Invoke-Entry`);
  assert.equal(short.out.code, 'DRILL_HOST_MEMORY_SHORT', JSON.stringify(short.out));
  assert.equal(short.out.hostPreBoot.bootGate.code, 'DRILL_HOST_MEMORY_SHORT', 'refused by the boot gate itself');
  assert.deepEqual(short.events.filter(e => e === 'memory'), ['memory']);
  assert.ok(short.events.indexOf('wsl-release exit 0') < short.events.indexOf('memory'));
  assert.ok(!short.events.includes('boot'));
});

test('a job that appears after the early sample skips the release (the command finds it itself), and the boot gate judges memory alone', shOpts, () => {
  const r = ps(`${preBootWorld()}
    $script:jobAfter = 1
    $wsl = Invoke-Entry
    $script:events.Clear(); $script:released = $false; $script:jobAfter = -1; $script:windowsJobAfter = 1
    $windows = Invoke-Entry
    @{ wsl = $wsl; windows = $windows }`);
  assert.ok(r.wsl.events.includes('wsl-release exit 3'), r.wsl.events.join(','));
  assert.ok(!r.wsl.events.includes('wsl-release exit 0'), 'nothing released');
  assert.deepEqual(r.wsl.out.hostPreBoot.release.skipped, { where: 'Fixture-CI', reason: 'WSL_ACTIONS_RUNNER_JOB' });
  assert.equal(r.wsl.out.hostPreBoot.release.failed, null, 'a skip is not a failure');
  assert.deepEqual([r.wsl.out.code, r.wsl.out.hostPreBoot.bootGate.busyWith, r.wsl.out.hostPreBoot.bootGate.requiredFreeGB],
    ['DRILL_HOST_MEMORY_SHORT', 'WSL_ACTIONS_RUNNER_JOB', 15], 'nothing released: 10 GB is short of the 15 GB gate');
  assert.ok(!r.wsl.events.includes('boot'));
  assert.deepEqual(r.windows.out.hostPreBoot.release.skipped, { where: 'windows', reason: 'ACTIONS_RUNNER_JOB' });
  assert.ok(!r.windows.events.some(e => e.startsWith('wsl-release')), 'no command into the distribution');
  assert.deepEqual([r.windows.out.code, r.windows.out.hostPreBoot.bootGate.busyWith], ['DRILL_HOST_MEMORY_SHORT', 'ACTIONS_RUNNER_JOB']);
});

// Fable renew-key ruling, supplement "drill boot gate and the train both want DESK", from the real entry: a runner busy from the start is
// no refusal. The release is not attempted (only when neither side has a job: Decision f572ac5b keeps 21db5a9c's "while idle"), and the
// boot gate -- memory only, 15 GB (Fable plan 0e418483) -- boots at 26 GB, refuses at 14 GB; the receipt's pre-boot record says a job was
// there and what was required.
test('from the real entry: a runner busy from the start skips the release and boots at 26 GB, refuses at 14 GB', shOpts, () => {
  const run = (free) => ps(`${preBootWorld({ freeBeforeRelease: free, freeAfterRelease: free })}
    $script:jobAfter = 0
    Invoke-Entry`);
  const ok = run(26);
  assert.equal(ok.out.status, 'DRILL_PREREQ_READY', JSON.stringify(ok.out));
  assert.ok(ok.events.includes('boot'), ok.events.join(','));
  assert.ok(!ok.events.some(e => e.startsWith('wsl-release')), 'no release with a job running');
  const pre = ok.out.hostPreBoot;
  assert.deepEqual([pre.early.ok, pre.early.busyWith, pre.early.runnerJob], [true, 'WSL_ACTIONS_RUNNER_JOB', 'yes']);
  assert.deepEqual(pre.release.skipped, { where: 'early', reason: 'WSL_ACTIONS_RUNNER_JOB' });
  assert.deepEqual(pre.bootGate.wslMemory, [{ ...WSL_MEMORY, runnerWorkers: 1 }], 'the boot gate sample counts the job in the distribution');
  assert.deepEqual([pre.bootGate.ok, pre.bootGate.runnerJob, pre.bootGate.freeGB, pre.bootGate.requiredFreeGB], [true, 'yes', 26, 15]);
  const short = run(14);
  assert.equal(short.out.code, 'DRILL_HOST_MEMORY_SHORT', JSON.stringify(short.out));
  assert.deepEqual([short.out.hostPreBoot.bootGate.runnerJob, short.out.hostPreBoot.bootGate.requiredFreeGB], ['yes', 15]);
  assert.ok(!short.events.includes('boot'));
});

test('T2: a job on one side, 14, 14, then 16 GB free: the drill waits two rounds before the hold, then boots; the receipt counts 3 readings', shOpts, () => {
  const r = ps(`${bootWaitWorld([14, 14, 16])}
    $out = Invoke-DrillMain
    @{ out = $out; events = @($script:events); slept = @($script:slept); intake = @($script:intake) }`);
  assert.equal(r.out.status, 'DRILL_PREREQ_READY', JSON.stringify(r.out));
  assert.ok(r.events.includes('boot'), r.events.join(','));
  assert.deepEqual(r.events.slice(0, 4), ['memory', 'memory', 'memory', 'status'], 'the wait comes before the hold and the host checks');
  assert.deepEqual(r.slept, [120, 120]);
  assert.deepEqual(r.intake, []);
  const pre = r.out.hostPreBoot;
  assert.deepEqual([pre.wait.samples, pre.wait.firstFreeGB, pre.wait.lastFreeGB, pre.wait.requiredFreeGB, pre.wait.ok], [3, 14, 16, 15, true]);
  for (const at of [pre.wait.firstAt, pre.wait.lastAt]) assert.match(at, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual([pre.bootGate.ok, pre.bootGate.runnerJob, pre.bootGate.busyWith, pre.bootGate.freeGB, pre.bootGate.requiredFreeGB],
    [true, 'yes', 'WSL_ACTIONS_RUNNER_JOB', 16, 15]);
});

test('T3: 14 GB free throughout: DRILL_HOST_MEMORY_SHORT after BootWaitMinutes, no intake requested, no VM touched, no boot', shOpts, () => {
  const r = ps(`${bootWaitWorld([14])}
    function Read-DrillHostStatus { $script:events.Add('status'); ${q(activeHostStatus(null))} }
    $failed = try { Invoke-DrillMain | Out-Null; $null } catch { Get-DrillCode $_ }
    @{ failed = $failed; events = @($script:events); slept = @($script:slept); intake = @($script:intake); limit = $script:Drill['BootWaitMinutes'] }`);
  assert.equal(r.failed?.code, 'DRILL_HOST_MEMORY_SHORT', JSON.stringify(r.failed));
  assert.equal(r.limit, 60);
  assert.deepEqual(r.intake, [], 'no intake pause requested');
  for (const e of ['boot', 'restore', 'restore-end', 'status']) assert.ok(!r.events.includes(e), `${e}: ${r.events.join(',')}`);
  assert.equal(r.slept.reduce((a, b) => a + b, 0), 60 * 60, 'waited BootWaitMinutes, no longer');
  const wait = r.failed.detail.wait;
  assert.deepEqual([wait.samples, wait.firstFreeGB, wait.lastFreeGB, wait.requiredFreeGB, wait.ok], [31, 14, 14, 15, false]);
});

// Fable ruling 0e418483 supplement "three questions after the implementation" 1 (independent review of a643c4b42, block 2): the boot gate's
// sample carries wslMemory, of the abort's shape and from the abort's reader (Get-DrillWslMemory), read right before the gate. Evidence
// only: one not read leaves the key out, and the gate's verdict -- a boot, a refusal -- is what it was without it. No wslWorkingSetGB.
test('the boot gate sample carries wslMemory like the abort; one not read leaves the key out and the verdict unchanged', shOpts, () => {
  const run = (fails, world = {}) => ps(`${preBootWorld(world)}
    $script:wslMemoryFails = $${fails}
    Invoke-Entry`);
  const verdict = x => { const g = x.out.hostPreBoot.bootGate; return [x.out.status, x.out.code ?? null, g.ok, g.code, g.freeGB, g.requiredFreeGB, x.events.includes('boot')]; };
  const read = run(false);
  assert.deepEqual(read.out.hostPreBoot.bootGate.wslMemory, [{ ...WSL_MEMORY, runnerWorkers: 0 }], JSON.stringify(read.out.hostPreBoot.bootGate));
  assert.equal(Object.hasOwn(read.out.hostPreBoot.bootGate, 'wslWorkingSetGB'), false);
  const unread = run(true);
  assert.ok(unread.events.includes('wsl-meminfo'), unread.events.join(','));
  assert.equal(Object.hasOwn(unread.out.hostPreBoot.bootGate, 'wslMemory'), false, 'not read: no key');
  assert.deepEqual(verdict(unread), verdict(read));
  assert.deepEqual(verdict(read), ['DRILL_PREREQ_READY', null, true, null, 64, 15, true]);
  const refused = run(false, { freeAfterRelease: 10 }), refusedUnread = run(true, { freeAfterRelease: 10 });
  assert.deepEqual(refused.out.hostPreBoot.bootGate.wslMemory, [{ ...WSL_MEMORY, runnerWorkers: 0 }], 'a refusal carries it too');
  assert.equal(Object.hasOwn(refusedUnread.out.hostPreBoot.bootGate, 'wslMemory'), false);
  assert.deepEqual(verdict(refusedUnread), verdict(refused));
  assert.deepEqual(verdict(refused), ['DRILL_PREREQ_FAILED', 'DRILL_HOST_MEMORY_SHORT', false, 'DRILL_HOST_MEMORY_SHORT', 10, 15, false]);
});

// r6 conditions from the real entry (a runner job at boot, 24 GB free): the boot gate is memory only (Fable plan 0e418483), so it boots,
// and its record carries the figure the script computed and what it is made of -- the guest, the boot margin, the production reserve;
// no runner job growth any more. No figure from outside.
test('from the real entry: r6 conditions at 24 GB boot, with the computed 15 GB figure and its basis', shOpts, () => {
  const r = ps(`${preBootWorld({ freeBeforeRelease: 24, freeAfterRelease: 24 })}
    $script:jobAfter = 0
    Invoke-Entry`);
  assert.equal(r.out.status, 'DRILL_PREREQ_READY', JSON.stringify(r.out));
  assert.ok(r.events.includes('boot'), r.events.join(','));
  const gate = r.out.hostPreBoot.bootGate;
  assert.deepEqual([gate.runnerJob, gate.freeGB, gate.requiredFreeGB], ['yes', 24, 15]);
  const b = gate.requiredBasis;
  assert.deepEqual(b, { guestGB: 8, bootMarginGB: 1, productionReserveGB: 6 }, JSON.stringify(b));
  assert.equal(Math.round((b.guestGB + b.bootMarginGB + b.productionReserveGB) * 10) / 10, gate.requiredFreeGB);
});

// Decision f572ac5b as DESK read its text (independent review of a643c4b42, block 1): with the drill VM on and the host under 10 GB free,
// the release may run with a production job there -- from the running guard only, at most every 2 minutes; "the earlier permission while
// idle stands". So before the boot the release is still only while idle: a Runner.Worker on both sides gets none (the boot gate boots
// at 26 GB on memory alone); the running guard's release (-WhileRunning) is sent with one all the same, and its command asks no pgrep.
test('a Runner.Worker on both sides: no release before the boot; the running guard\'s release is sent all the same, with no pgrep in it', shOpts, () => {
  const r = ps(`${preBootWorld({ freeBeforeRelease: 26, freeAfterRelease: 26 })}
    $script:jobAfter = 0; $script:windowsJobAfter = 0
    Invoke-Entry`);
  assert.ok(!r.events.some(e => e.startsWith('wsl-release')), r.events.join(','));
  const pre = r.out.hostPreBoot;
  assert.deepEqual([pre.early.busyWith, pre.release.released, pre.release.failed, pre.release.skipped],
    ['ACTIONS_RUNNER_JOB', [], null, { where: 'early', reason: 'ACTIONS_RUNNER_JOB' }]);
  assert.deepEqual([r.out.status, pre.bootGate.requiredFreeGB], ['DRILL_PREREQ_READY', 15], JSON.stringify(r.out));
  const both = ps(`
    function Get-Process { param($ErrorAction) $script:sent.Add('windows'); [pscustomobject]@{ ProcessName = 'Runner.Worker' } }
    function Get-DrillRunnerDistributions { param($HostName) 'Fixture-CI' }
    function Get-DrillWslRegisteredNames { 'Fixture-CI' }
    $script:sent = [Collections.Generic.List[string]]::new()
    $script:DrillWslRunner = { param($a, $t) if ($a[0] -ceq '--list') { return @{ exit = 0; stdout = "Fixture-CI\`r\`n"; stderr = '' } }; $script:sent.Add($a -join ' '); @{ exit = 0; stdout = ''; stderr = '' } }
    $o = Invoke-DrillWslCacheRelease -WhileRunning -WithinSeconds 20
    $running = @{ released = @($o.released); sent = @($script:sent) }; $script:sent.Clear()
    $o = Invoke-DrillWslCacheRelease
    @{ running = $running; idle = @{ released = @($o.released); skipped = $o.skipped; sent = @($script:sent) }; command = $script:DrillWslReleaseCommand }`);
  assert.deepEqual(both.running.released, ['Fixture-CI']);
  assert.deepEqual(both.running.sent, [`--distribution Fixture-CI --user root --exec sh -c ${both.command}`], 'no Windows read, the command sent');
  assert.equal(both.command, 'sync || exit 5; echo 1 > /proc/sys/vm/drop_caches || exit 5; exit 0');
  assert.deepEqual(both.idle, { released: [], skipped: { where: 'windows', reason: 'ACTIONS_RUNNER_JOB' }, sent: ['windows'] }, 'the same function before the boot: nothing sent');
});

// Codex review of 74e7a65e7, medium 1: a refusal at the duty check carries no memory figure (nothing was read), and a built baseline
// keeps its three stages in baseline.json.
test('no memory figure where none was read, and baseline.json keeps the pre-boot stages', opts, () => {
  const r = ps(`
    function Read-DrillHostStatus { ${q(activeHostStatus(null, { writtenAt: '2026-11-19T02:00:00Z' }))} }
    function Get-DrillTime { [DateTimeOffset]'2026-11-19T02:00:00Z' }
    $onDuty = Get-DrillHostSafety
    function Assert-DrillHost { @{ ok = $true } }
    function Invoke-DrillBaseline { param($RunDir, [switch]$ExistingOnly)
      $script:DrillPreBoot = [ordered]@{ early = 'e'; release = 'r'; bootGate = [ordered]@{ freeGB = 20 } }
      [ordered]@{ action = 'build'; checkpoint = 'S0-clean-os' } }
    $script:Drill.Runs = ${q(fs.mkdtempSync(path.join(tmp, 'baseline-')))}
    $script:BaselineOnly = $true
    $out = Invoke-DrillPreparedRun @{ safeToResume = $true; deadline = [DateTimeOffset]::MinValue; holdUntil = [DateTimeOffset]::MinValue } $null $null $null
    @{ onDuty = $onDuty; out = $out; baseline = (Read-DrillJson $out.evidence) }`);
  assert.equal(r.onDuty.code, 'DRILL_HOST_IS_ON_DUTY');
  assert.equal(r.onDuty.freeGB, null);
  assert.equal(r.out.hostFreeGB, 20);
  assert.deepEqual(r.baseline.hostPreBoot, { early: 'e', release: 'r', bootGate: { freeGB: 20 } });
});

// Codex review of f734afe7e, medium 3: a baseline that fails keeps what was sampled before its boot in baseline.json, and the failure
// still stops the run, saying whether that record was saved (round four, low 1).
test('a failed baseline keeps its pre-boot stages in baseline.json, and says whether it could', opts, () => {
  const runs = fs.mkdtempSync(path.join(tmp, 'baseline-failed-'));
  const r = ps(`
    function Assert-DrillHost { @{ ok = $true } }
    function Invoke-DrillBaseline { param($RunDir, [switch]$ExistingOnly)
      $script:DrillPreBoot = [ordered]@{ early = 'e'; release = 'r'; bootGate = [ordered]@{ code = 'DRILL_HOST_MEMORY_SHORT' } }
      throw (New-DrillError 'DRILL_HOST_MEMORY_SHORT' @{ freeGB = 9 }) }
    $script:Drill.Runs = ${q(runs)}
    $script:BaselineOnly = $true
    $saved = try { Invoke-DrillPreparedRun @{ safeToResume = $true; deadline = [DateTimeOffset]::MinValue; holdUntil = [DateTimeOffset]::MinValue } $null $null $null; 'NO THROW' } catch { Get-DrillCode $_ }
    $file = Join-Path (Get-ChildItem -LiteralPath ${q(runs)} -Directory)[0].FullName 'baseline.json'
    $baseline = Read-DrillJson $file
    function Write-DrillJson { param($Path, $Value) throw 'disk full' }
    $unsaved = try { Invoke-DrillPreparedRun @{ safeToResume = $true; deadline = [DateTimeOffset]::MinValue; holdUntil = [DateTimeOffset]::MinValue } $null $null $null; 'NO THROW' } catch { Get-DrillCode $_ }
    @{ saved = $saved; baseline = $baseline; unsaved = $unsaved }`);
  assert.equal(r.saved.code, 'DRILL_HOST_MEMORY_SHORT');
  assert.equal(r.saved.detail.baselineSaved, true);
  assert.deepEqual(r.saved.detail.failure, { freeGB: 9 });
  assert.deepEqual([r.baseline.action, r.baseline.failure.code], ['failed', 'DRILL_HOST_MEMORY_SHORT']);
  assert.deepEqual(r.baseline.hostPreBoot, { early: 'e', release: 'r', bootGate: { code: 'DRILL_HOST_MEMORY_SHORT' } });
  assert.equal(r.unsaved.code, 'DRILL_HOST_MEMORY_SHORT');
  assert.equal(r.unsaved.detail.baselineSaved, false);
  assert.match(r.unsaved.detail.baselineSaveError, /disk full/);
});

test('the baseline action comes from the scene: only the VM whose name and notes are ours is ever touched', opts, () => {
  const r = ps(`@(
    (Get-DrillBaselineAction $null).action,
    (Get-DrillBaselineAction @{ notes = 'clued.production-vm/1'; state = 'Off'; checkpoints = @('S0-clean-os') }).code,
    (Get-DrillBaselineAction @{ notes = 'clued.drill-vm/1'; state = 'Running'; checkpoints = @('S0-clean-os') }).code,
    (Get-DrillBaselineAction @{ notes = 'clued.drill-vm/1'; state = 'Off'; checkpoints = @('S0-clean-os') }).action,
    (Get-DrillBaselineAction @{ notes = 'clued.drill-vm/1'; state = 'Off'; checkpoints = @() }).action)`);
  assert.deepEqual(r, ['build', 'DRILL_VM_NAME_TAKEN_NOT_OURS', 'DRILL_VM_NOT_OFF', 'ready', 'rebuild']);
});

test('the guest is ready only after setup and OOBE finish, on the same boot twice (PowerShell Direct answers mid-OOBE)', opts, () => {
  // The first real baseline (2026-11-16): the account answered PowerShell Direct while OOBEInProgress was still 1; the settle
  // step started mid-OOBE and died when OOBE restarted the machine ("the system is shutting down").
  const r = ps(`$a = [DateTimeOffset]::Parse('2026-11-16T02:00:00Z');
    $mid = @{ boot = '2026-11-16T02:12:00.5+00:00'; imageState = 'IMAGE_STATE_UNDEPLOYABLE'; oobe = 1 };
    $done = @{ boot = '2026-11-16T02:31:26.5+00:00'; imageState = 'IMAGE_STATE_COMPLETE'; oobe = 0 };
    $other = @{ boot = '2026-11-16T02:40:00Z'; imageState = 'IMAGE_STATE_COMPLETE'; oobe = 0 };
    $s1 = Step-DrillReadiness $null $null $a; $s2 = Step-DrillReadiness $null $mid $a; $s3 = Step-DrillReadiness $null $done $a;
    $s4 = Step-DrillReadiness $s3.candidate $done $a; $s5 = Step-DrillReadiness $s3.candidate $other $a;
    $s6 = Step-DrillReadiness $s3.candidate $done ([DateTimeOffset]::Parse('2026-11-16T02:35:00Z'));
    @($s1.ready, $s2.ready, $s3.ready, $s4.ready, $s5.ready, $s6.ready, ($s5.candidate -ne $s3.candidate))`);
  assert.deepEqual(r, [false, false, false, true, false, false, true]);
});

test('a failed guest step is classified by the boot time, not by the localized message', opts, () => {
  const r = ps(`@((Get-DrillStepFailureKind '2026-11-16T02:31:26.5000000+00:00' '2026-11-16T10:31:26.5+08:00'),
    (Get-DrillStepFailureKind '2026-11-16T02:31:26.5+00:00' '2026-11-16T02:40:00+00:00'),
    (Get-DrillStepFailureKind '2026-11-16T02:31:26.5+00:00' ''), (Get-DrillStepFailureKind '' '2026-11-16T02:40:00+00:00'))`);
  assert.deepEqual(r, ['failed', 'restarted', 'unreachable', 'restarted']);
});

test('the one output line is UTF-8 even on a GBK console (localized details stay readable)', opts, () => {
  const missing = path.join(tmp, '不存在的回执', '收据.json');
  const run = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Finalize', missing, '-ProductionReadback', missing]);
  assert.equal(run.status, 1);
  const out = JSON.parse(run.stdout.toString('utf8').trim());
  assert.equal(out.status, 'DRILL_STOPPED');
  assert.match(out.detail, /收据\.json/);
});

test('the ISO is used only when its sha256 equals the expected file', opts, () => {
  const h = 'b'.repeat(64);
  const r = ps(`@((Test-DrillIsoHash ${q(h)} (${q(h.toUpperCase())} + [Environment]::NewLine)).ok,(Test-DrillIsoHash ${q('c'.repeat(64))} ${q(h)}).code, (Test-DrillIsoHash ${q(h)} 'x').code)`);
  assert.deepEqual(r, [true, 'DRILL_ISO_HASH_MISMATCH', 'DRILL_ISO_EXPECTED_SHA_UNREADABLE']);
});

test('the package triple: the tar must equal the acceptance file and SHA256SUMS', opts, () => {
  const good = packageDir('pkg-good');
  const r = ps(`Test-DrillPackageDir ${q(good.dir)} ${q(good.v)}`);
  assert.equal(r.tarSha256, good.s); assert.equal(r.ciSourceManifestSha256, '5'.repeat(64));
  assert.equal(psCode(`Test-DrillPackageDir ${q(packageDir('pkg-acc', { accSha: 'a'.repeat(64) }).dir)} '1.2.3'`), 'DRILL_TAR_NOT_THE_ACCEPTED_ONE');
  assert.equal(psCode(`Test-DrillPackageDir ${q(packageDir('pkg-sums', { sumsSha: 'a'.repeat(64) }).dir)} '1.2.3'`), 'DRILL_TAR_NOT_IN_SHA256SUMS');
  assert.equal(psCode(`Test-DrillPackageDir ${q(good.dir)} '9.9.9'`), 'DRILL_PACKAGE_FILE_MISSING');
});

test('the first-install kit: every file pinned, only fixed placeholders, the per-node steps declared', opts, () => {
  const r = ps(`$k = Read-DrillKit ${q(kitDir('kit-good'))}; [ordered]@{ entry = $k.entryFile; per = $k.perNodeSteps; prereq = $k.prereqSha256;
    args = @(Resolve-DrillKitArguments $k.arguments @{ from = 'C:\\drill\\from'; fake = 'C:\\drill\\fake'; version = '1.2.3' }) }`);
  assert.deepEqual(r, { entry: 'entry.ps1', per: ['reinstall/README.md 8c step 2 (root, WSL)'], prereq: 'e'.repeat(64), args:['-From', 'C:\\drill\\from', '-Fake', 'C:\\drill\\fake', '-Version', '1.2.3'] });
  const changed = kitDir('kit-changed'); fs.writeFileSync(path.join(changed, 'tools', 'a.bin'), 'b');
  assert.equal(psCode(`Read-DrillKit ${q(changed)}`), 'DRILL_KIT_FILE_CHANGED');
  assert.equal(psCode(`Read-DrillKit ${q(kitDir('kit-nodearg', (k) => ({ ...k, entry: { ...k.entry, arguments: ['-Node', 'desk-w-591'] } })))}`), 'DRILL_KIT_ARGUMENT_REFUSED');
  // Ubuntu package names carry + and ~ (containerd_2.2.1-0ubuntu1~24.04.4_amd64.deb): the kit reader accepts what the prereq reader accepts
  const debKit = kitDir('kit-deb', (k) => ({ ...k, files: [...k.files, { path: 'tools\\c_2.2.1-0ubuntu1~24.04.4+x.deb', sha256: sha('d') }] }));
  fs.writeFileSync(path.join(debKit, 'tools', 'c_2.2.1-0ubuntu1~24.04.4+x.deb'), 'd');
  assert.equal(ps(`(Read-DrillKit ${q(debKit)}).entryFile`), 'entry.ps1');
  assert.equal(psCode(`Read-DrillKit ${q(kitDir('kit-escape', (k) => ({ ...k, files: [...k.files, { path: '..\\x', sha256: 'a'.repeat(64) }] })))}`), 'DRILL_KIT_REFUSED');
  assert.equal(psCode(`Read-DrillKit ${q(kitDir('kit-noper', (k) => { const { perNodeSteps, ...rest } = k; return rest; }))}`), 'DRILL_KIT_REFUSED');
  assert.equal(psCode(`Read-DrillKit ${q(path.join(tmp, 'nowhere'))}`), 'DRILL_FIRST_INSTALL_KIT_MISSING');
  assert.equal(psCode(`Read-DrillKit ${q(kitDir('kit-noprereq', (k) => ({ ...k, prereqSha256: null })))}`), 'DRILL_KIT_REFUSED');
});

test('the prerequisites: official sources only, every byte pinned, injected from the host (nothing downloaded in the VM)', opts, () => {
  const good = prereqDir('pre-good');
  const r = ps(`$p = Read-DrillPrereq ${q(good)}; [ordered]@{ d = $p.distribution; wsl = $p.wsl; rootfs = $p.rootfs; debs = @($p.debs); v = $p.wslVersion; sha = $p.sha256 }`);
  assert.deepEqual({ ...r, sha: undefined }, { d: 'CluedResident-Linux', wsl: 'wsl.2.7.13.0.x64.msi', rootfs: 'ubuntu-24.04.5-wsl-amd64.wsl', debs: ['debs\\docker.io_29.1.3_amd64.deb'], v: '2.7.13.0', sha: undefined });
  assert.equal(r.sha, sha(fs.readFileSync(path.join(good, 'prereq.json'))));
  const changed = prereqDir('pre-changed'); fs.writeFileSync(path.join(changed, 'debs', 'docker.io_29.1.3_amd64.deb'), 'other');
  assert.equal(psCode(`Read-DrillPrereq ${q(changed)}`), 'DRILL_PREREQ_FILE_CHANGED');
  assert.equal(psCode(`Read-DrillPrereq ${q(prereqDir('pre-mirror', (p) => ({ ...p, rootfs: { ...p.rootfs, url: 'https://example.net/ubuntu.wsl' } })))}`), 'DRILL_PREREQ_REFUSED');
  assert.equal(psCode(`Read-DrillPrereq ${q(prereqDir('pre-distro', (p) => ({ ...p, distribution: 'a b; rm' })))}`), 'DRILL_PREREQ_REFUSED');
  assert.equal(psCode(`Read-DrillPrereq ${q(prereqDir('pre-nodebs', (p) => ({ ...p, debs: [] })))}`), 'DRILL_PREREQ_REFUSED');
  assert.equal(psCode(`Read-DrillPrereq ${q(prereqDir('pre-outside', (p, dir, put) => { put('x.deb', 'x'); return { ...p, debs: [{ path: 'x.deb', sha256: sha('x'), url: p.debs[0].url }] }; }))}`), 'DRILL_PREREQ_REFUSED');
  assert.equal(psCode(`Read-DrillPrereq ${q(path.join(tmp, 'nowhere'))}`), 'DRILL_PREREQ_MISSING');
  // the host's pinned gh and Git for Windows installers, from their official releases only
  const gh = { path: 'gh_2.103.3_windows_amd64.msi', url: 'https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_windows_amd64.msi' };
  const git = { path: 'Git-2.55.0.3-64-bit.exe', url: 'https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.3/Git-2.55.0.3-64-bit.exe' };
  const withTools = prereqDir('pre-tools', (p, dir, put) => ({ ...p, tools: [{ ...gh, sha256: put(gh.path, 'gh') }, { ...git, sha256: put(git.path, 'git') }] }));
  assert.deepEqual(ps(`[ordered]@{ tools = @((Read-DrillPrereq ${q(withTools)}).tools) }`).tools, [gh.path, git.path]);
  assert.equal(psCode(`Read-DrillPrereq ${q(prereqDir('pre-tools-mirror', (p, dir, put) => ({ ...p, tools: [{ ...gh, url: 'https://example.net/gh.msi', sha256: put(gh.path, 'gh') }] })))}`), 'DRILL_PREREQ_REFUSED');
});
// Fable renew-key ruling, supplement "companion account and evidence" section 2 (branch one), read by this branch's parser (the merge rule):
// the step record comes from the complete stdout logs (the entry's, the host preparation's, prepare's, the launcher stage's); the stage
// result files give their verdict lines. Every step line has one shape (name, result, rejectCode, detail; the older {step, result} is read
// too). Nothing parsed is missing, never a pass; no verdict line (a timeout) is said so. A refusal verdict stays a stage verdict, not a step.
test('the first-install step record: every stage\'s step lines, the last completed step, the verdict or its absence; nothing parsed is missing', opts, () => {
  const hostOut = [
    'some text',
    JSON.stringify({ name: 'residue', result: 'none', rejectCode: null, detail: null }),
    JSON.stringify({ step: 'wsl', result: '2.7.13.0' }),
    JSON.stringify({ name: 'companion-account', result: 'refused', rejectCode: 'COMPANION_ACCOUNT_NOT_PREPARED', detail: { error: 'GH_EXE_MISSING' } }),
    JSON.stringify({ status: 'FIRST_INSTALL_HOST_REFUSED', code: 'COMPANION_ACCOUNT_NOT_PREPARED' })].join('\r\n');
  const launcherText = [JSON.stringify({ name: 'start-companion', result: 'ok', rejectCode: null, detail: null }), '{"status":"BOOTSTRAP_DONE"}'].join('\n');
  const r = ps(`
    $stage = [ordered]@{ 'host-result.json' = [pscustomobject]@{ exit = 1; terminal = [pscustomobject]@{ status = 'FIRST_INSTALL_HOST_REFUSED'; code = 'COMPANION_ACCOUNT_NOT_PREPARED' } }; 'launcher-result.json' = [pscustomobject]@{ exit = 0; terminal = [pscustomobject]@{ status = 'BOOTSTRAP_DONE' } } }
    @{ full = (ConvertFrom-DrillFirstInstallSteps ([ordered]@{ entry = '{"status":"FIRST_INSTALL_STOPPED","stopCode":"HOST_PREPARATION_NOT_DONE","tree":"","node":""}'; host = ${q(hostOut)}; prepare = '{"status":"FLEET_NODE_FIRST_INSTALL_PREPARED"}'; launcher = ${q(launcherText)} }) $stage)
      timeout = (ConvertFrom-DrillFirstInstallSteps ([ordered]@{ entry = $null; host = ${q(hostOut.split('\r\n').slice(0, 4).join('\r\n'))} }) ([ordered]@{ 'host-result.json' = $null; 'launcher-result.json' = $null }))
      none = (ConvertFrom-DrillFirstInstallSteps ([ordered]@{ entry = 'not json' }) $null) }`);
  assert.equal(r.full.missing, false);
  assert.deepEqual(r.full.steps.map(x => [x.stage, x.name, x.rejectCode]), [['host', 'residue', null], ['host', 'wsl', null],
    ['host', 'companion-account', 'COMPANION_ACCOUNT_NOT_PREPARED'], ['launcher', 'start-companion', null]]);
  assert.deepEqual(r.full.steps[2].detail, { error: 'GH_EXE_MISSING' });
  assert.equal(r.full.firstRejected, 'companion-account');
  assert.equal(r.full.lastCompletedStep, 'start-companion');
  assert.deepEqual(r.full.verdict, { status: 'FIRST_INSTALL_STOPPED', stopCode: 'HOST_PREPARATION_NOT_DONE' });
  assert.equal(r.full.stageVerdicts.host, 'FIRST_INSTALL_HOST_REFUSED', 'the refusal is the stage\'s verdict');
  assert.equal(r.full.incomplete, false);
  assert.equal(r.timeout.missing, false);
  assert.equal(r.timeout.noVerdict, true);
  assert.equal(r.timeout.lastStep, 'companion-account');
  assert.deepEqual(r.timeout.noStageVerdict, ['host'], 'a host log cut before its verdict');
  assert.equal(r.none.missing, true);
  assert.deepEqual(r.none.steps, []);
  assert.equal(r.none.lastCompletedStep, null);
});

// Codex review of ced480363, medium 7 (branch one): A1 does not pass without its step record; the entry reads the launcher's result file
// only when it is there, read with read-write sharing (this branch).
test('A1 does not pass without a step record, and the entry reads the launcher result only when there is one', opts, () => {
  assert.equal(pass(verdictOf(evidence())).A1, true);
  assert.equal(pass(verdictOf(evidence({ firstInstallSteps: { missing: true, steps: [] } }))).A1, false);
  assert.equal(pass(verdictOf(evidence({ firstInstallSteps: null }))).A1, false);
  const text = fs.readFileSync(entryScript, 'utf8');
  assert.doesNotMatch(text, /ReadAllText\(\$launcherResult\)\)\s*$/m);
  assert.match(text, /\$terminal = if \(\[IO\.File\]::Exists\(\$launcherResult\)\) \{ Get-LastJsonLine \(Read-EntrySharedText \$launcherResult\) \} else \{ \$null \}/);
});

// Section 2 of the same supplement (branch one), with this branch's collection: the guest evidence -- the entry's guest log and the stage
// files, each read with read-write sharing -- is taken whether the first install succeeded, failed or ran out of time, before the
// checkpoint is restored; a failed collection is only recorded. On a timeout the lines the entry printed so far come from its guest log.
test('the guest evidence is collected after a timed-out first install too, and a failed collection is only recorded', opts, () => {
  const runDir = path.join(tmp, 'evidence-run'); fs.mkdirSync(runDir, { recursive: true });
  const runDir2 = path.join(tmp, 'evidence-run-2'); fs.mkdirSync(runDir2, { recursive: true });
  const guest = guestWorkDir('evidence-guest', {
    'first-install.stdout.log': 'line one\r\n{"name":"prepare","result":"ok","rejectCode":null,"detail":null}\r\n',
    'stage-timings.json': '{"host":12.5,"prepare":null,"launcher":null}',
    'host.stdout.log': JSON.stringify({ name: 'residue', result: 'none', rejectCode: null, detail: null }) + '\r\n',
    'host-result.json': JSON.stringify({ exit: 1, terminal: null }) });
  const r = ps(`
    $script:steps = [Collections.Generic.List[string]]::new()
    $script:Interactive = $false; $script:SkipReinstall = $true
    function New-PSSession { param($VMName, $Credential) 'session' }
    function Remove-PSSession { param($Session) }
    function Copy-Item { param($LiteralPath, $Path, $Destination, $ToSession, [switch]$Recurse) }
    function Invoke-DrillGuest { param($Credential, $Script, $ArgumentList, $TimeoutMinutes, $Code, $Step, [switch]$Restartable)
      $script:steps.Add($Step)
      if ($Step -ceq 'first-install') { throw (New-DrillError 'DRILL_FIRST_INSTALL_TIMEOUT' @{ step = $Step }) }
      if ($Step -ceq 'guest-evidence' -or $Step -ceq 'stage-files') {
        if ($script:collectFails) { throw (New-DrillError 'DRILL_GUEST_STEP_FAILED' @{ step = $Step }) }
        return (& $Script ${q(guest)} $ArgumentList[1])
      }
      throw "unexpected step $Step"
    }
    $package = @{ version = '1.2.3'; files = @(); tar = 'C:/x/p.tar'; tarSha256 = 'ab' }
    $testKit = [pscustomobject]@{ dir = 'C:/kit'; entryFile = 'first-install-entry.ps1'; arguments = @('-Work', '{work}'); timeoutMinutes = 5; prerequisiteMode = 'first-install-host'; credentials = (${q(JSON.stringify(PACKAGE_CREDENTIALS))} | ConvertFrom-Json) }
    function Invoke-Command { param($Session, $ScriptBlock, $ArgumentList, $VMName, $Credential, [switch]$AsJob, $ErrorAction) if ($ArgumentList -is [string]) { if ($ArgumentList -like '*.tar') { 'ab' } else { @{ contract = 'x' } } } }
    $script:collectFails = $false
    $first = try { Invoke-DrillRun ${q(runDir)} $package $testKit $null $null; 'NO THROW' } catch { (Get-DrillCode $_).code }
    $firstSteps = @($script:steps); $script:steps.Clear()
    $script:collectFails = $true
    $second = try { Invoke-DrillRun ${q(runDir2)} $package $testKit $null $null; 'NO THROW' } catch { (Get-DrillCode $_).code }
    @{ first = $first; firstSteps = $firstSteps; second = $second; secondSteps = @($script:steps)
      record = (Read-DrillJson (Join-Path ${q(runDir)} 'guest-evidence.json')); record2 = (Read-DrillJson (Join-Path ${q(runDir2)} 'guest-evidence.json'))
      steps = (Read-DrillFirstInstallSteps ${q(runDir)}); steps2 = (Read-DrillFirstInstallSteps ${q(runDir2)}) }`);
  assert.equal(r.first, 'DRILL_FIRST_INSTALL_TIMEOUT');
  // the read-only guest probe is an extra: only after every required piece (the stage files, the guest's first-install.log) is taken
  assert.deepEqual(r.firstSteps, ['first-install', 'stage-files', 'guest-evidence', 'guest-probe']);
  // collected, but not all of it: ok only with nothing missing (Codex review of f33fc33e5, medium 2)
  assert.equal(r.record.ok, false);
  assert.equal(r.record.code, null);
  // a first install cut off by its time limit returned no result: the failure snapshot it did not bring is missing too (ruling R2)
  assert.deepEqual(r.record.missing, ['prepare.stdout.log', 'launcher.stdout.log', 'launcher-result.json', 'wsl-cold-start.json', 'resident-failure-snapshot.json']);
  assert.deepEqual(fs.readFileSync(path.join(runDir, 'first-install.log'), 'utf8').split(/\r?\n/).filter(Boolean),
    ['line one', '{"name":"prepare","result":"ok","rejectCode":null,"detail":null}']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'stage-timings.json'), 'utf8')).host, 12.5);
  assert.deepEqual(r.steps.steps.map(x => [x.stage, x.name]), [['entry', 'prepare'], ['host', 'residue']]);
  assert.equal(r.steps.noVerdict, true);
  assert.equal(r.second, 'DRILL_FIRST_INSTALL_TIMEOUT', 'a failed collection never replaces the run\'s own failure');
  // a guest that could not be reached for the required evidence is not asked for the probe (no second readiness wait)
  assert.deepEqual(r.secondSteps, ['first-install', 'stage-files', 'guest-evidence']);
  assert.equal(r.record2.ok, false);
  assert.equal(r.record2.code, 'DRILL_GUEST_STEP_FAILED');
  assert.equal(r.steps2.missing, true);
});

// Codex review of ced480363, medium 6 (branch one): what the entry already returned is written before the stage files are asked for, so a
// failed collection loses the stage files only. Medium 8: an interactive run that times out has its evidence collected too.
test('the returned entry output is kept when the stage files cannot be collected; an interactive timeout is collected as well', opts, () => {
  const runDir = path.join(tmp, 'evidence-kept'); fs.mkdirSync(runDir, { recursive: true });
  const runDir2 = path.join(tmp, 'evidence-interactive'); fs.mkdirSync(runDir2, { recursive: true });
  const r = ps(`
    $script:steps = [Collections.Generic.List[string]]::new()
    $script:SkipReinstall = $true
    function New-PSSession { param($VMName, $Credential) 'session' }
    function Remove-PSSession { param($Session) }
    function Copy-Item { param($LiteralPath, $Path, $Destination, $ToSession, [switch]$Recurse) }
    function Invoke-Command { param($Session, $ScriptBlock, $ArgumentList, $VMName, $Credential, [switch]$AsJob, $ErrorAction) if ($ArgumentList -is [string]) { if ($ArgumentList -like '*.tar') { 'ab' } else { @{ contract = 'x' } } } }
    function Invoke-DrillGuest { param($Credential, $Script, $ArgumentList, $TimeoutMinutes, $Code, $Step, [switch]$Restartable)
      $script:steps.Add($Step)
      if ($Step -ceq 'first-install') { return [ordered]@{ lines = @('{"name":"prepare","result":"ok","rejectCode":null,"detail":null}', '{"status":"FIRST_INSTALL_STOPPED","stopCode":"X","tree":"","node":""}'); exit = 1; stderr = '' } }
      if ($Step -ceq 'guest-evidence' -or $Step -ceq 'stage-files') { throw (New-DrillError 'DRILL_GUEST_STEP_FAILED' @{ step = $Step }) }
      throw (New-DrillError 'TEST_STOP_AFTER_EVIDENCE')
    }
    function Wait-DrillInteractive { param($RunDir, $Paths, $Cred) $script:steps.Add('interactive'); throw (New-DrillError 'DRILL_INTERACTIVE_TIMEOUT') }
    $package = @{ version = '1.2.3'; files = @(); tar = 'C:/x/p.tar'; tarSha256 = 'ab' }
    $testKit = [pscustomobject]@{ dir = 'C:/kit'; entryFile = 'first-install-entry.ps1'; arguments = @('-Work', '{work}'); timeoutMinutes = 5; prerequisiteMode = 'first-install-host'; credentials = (${q(JSON.stringify(PACKAGE_CREDENTIALS))} | ConvertFrom-Json) }
    $script:Interactive = $false
    $kept = try { Invoke-DrillRun ${q(runDir)} $package $testKit $null $null; 'NO THROW' } catch { (Get-DrillCode $_).code }
    $keptSteps = @($script:steps); $script:steps.Clear()
    $script:Interactive = $true
    $interactiveCode = try { Invoke-DrillRun ${q(runDir2)} $package $testKit $null $null; 'NO THROW' } catch { (Get-DrillCode $_).code }
    @{ kept = $kept; keptSteps = $keptSteps; interactive = $interactiveCode; interactiveSteps = @($script:steps)
      record = (Read-DrillJson (Join-Path ${q(runDir)} 'guest-evidence.json')); record2 = (Read-DrillJson (Join-Path ${q(runDir2)} 'guest-evidence.json'))
      steps = (Read-DrillFirstInstallSteps ${q(runDir)}) }`);
  assert.deepEqual(r.keptSteps.slice(0, 3), ['first-install', 'stage-files', 'guest-evidence']);
  assert.ok(!r.keptSteps.includes('guest-probe'), 'the collection failed: no probe');
  assert.equal(r.record.ok, false);
  assert.deepEqual(fs.readFileSync(path.join(runDir, 'first-install.log'), 'utf8').split(/\r?\n/).filter(Boolean).length, 2);
  assert.deepEqual(r.steps.steps.map(x => x.name), ['prepare']);
  assert.deepEqual(r.steps.verdict, { status: 'FIRST_INSTALL_STOPPED', stopCode: 'X' });
  assert.equal(r.interactive, 'DRILL_INTERACTIVE_TIMEOUT');
  assert.deepEqual(r.interactiveSteps, ['interactive', 'stage-files', 'guest-evidence']);
  assert.equal(r.record2.ok, false);
});

// Codex review of 74e7a65e7, medium 2 (branch one): the returned entry log that cannot be written is not swallowed: the record says so and is
// not ok, and the guest's copy of the log, once fetched, is written in its place.
test('an entry log that cannot be written is recorded as not saved, the guest copy written instead, and the collection not ok', opts, () => {
  const runDir = path.join(tmp, 'evidence-unsaved'); fs.mkdirSync(runDir, { recursive: true });
  const guest = guestWorkDir('evidence-unsaved-guest', { 'first-install.stdout.log': 'guest line one\r\nguest line two\r\n', 'stage-timings.json': '{}' });
  const r = ps(`
    $script:writes = 0
    function Write-DrillLines { param($Path, $Lines) $script:writes++; if ($script:writes -eq 1) { throw 'disk full' }; [IO.File]::WriteAllLines($Path, [string[]]$Lines) }
    function Invoke-DrillGuest { param($Credential, $Script, $ArgumentList, $TimeoutMinutes, $Code, $Step, [switch]$Restartable) & $Script ${q(guest)} $ArgumentList[1] }
    $c = Save-DrillGuestEvidence ${q(runDir)} $null ([ordered]@{ lines = @('returned line'); exit = 0 })
    @{ record = (Read-DrillJson (Join-Path ${q(runDir)} 'guest-evidence.json')); writes = $script:writes }`);
  assert.equal(r.record.ok, false);
  assert.equal(r.record.entryLog, 'guest-log');
  assert.match(r.record.entryLogError, /disk full/);
  assert.equal(r.writes, 2);
  assert.deepEqual(fs.readFileSync(path.join(runDir, 'first-install.log'), 'utf8').split(/\r?\n/).filter(Boolean), ['guest line one', 'guest line two']);
});

// Codex review of f734afe7e, low 1 (branch one): with no returned output and no guest log there is no entry log: no empty file, no 'guest-log'.
test('with no entry output and no guest log, no entry log is written or claimed', opts, () => {
  const runDir = path.join(tmp, 'evidence-no-log'); fs.mkdirSync(runDir, { recursive: true });
  const guest = guestWorkDir('evidence-no-log-guest', { 'stage-timings.json': '{}' });
  const r = ps(`
    function Invoke-DrillGuest { param($Credential, $Script, $ArgumentList, $TimeoutMinutes, $Code, $Step, [switch]$Restartable) & $Script ${q(guest)} $ArgumentList[1] }
    $c = Save-DrillGuestEvidence ${q(runDir)} $null $null
    Read-DrillJson (Join-Path ${q(runDir)} 'guest-evidence.json')`);
  assert.equal(r.entryLog, null);
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes('first-install.stdout.log'));
  assert.equal(fs.existsSync(path.join(runDir, 'first-install.log')), false);
});

// Medium 8 (branch one): -Finalize rebuilds the items from the receipt; A1's step record stays on it.
test('-Finalize keeps the first-install step record on A1', opts, () => {
  const steps = { missing: false, steps: [{ stage: 'host', name: 'residue', result: 'none', rejectCode: null, detail: null }], lastCompletedStep: 'residue' };
  const items = verdictOf(evidence()).items.map(i => i.id === 'A1' ? { ...i, firstInstallSteps: steps } : i);
  const done = finalize('finalize-keeps-steps', { items });
  assert.equal(done.status, 0, JSON.stringify(done.output));
  const a1 = JSON.parse(done.bytes).items.find(i => i.id === 'A1');
  assert.deepEqual(a1.firstInstallSteps, steps);
});

// The receipt carries the step record under A1 (and, when the run ended before any verdict, in its evidence).
test('the receipt keeps the first-install step record under A1, read from the run directory', opts, () => {
  const receipt = m5DrillReceipt('steps-receipt', RENEWAL_3BC571A6);
  const a1 = receipt.items.find(i => i.id === 'A1');
  assert.equal(a1.firstInstallSteps.missing, false);
  assert.deepEqual(a1.firstInstallSteps.steps.map(x => x.name), ['stage', 'install']);
  const bare = m5DrillReceipt('steps-receipt-missing', RENEWAL_3BC571A6, { checker: 'PASS', missing: [], steps: false });
  const bareA1 = bare.items.find(i => i.id === 'A1');
  assert.equal(bareA1.firstInstallSteps.missing, true);
  assert.equal(bareA1.pass, false, 'no step record: A1 does not pass');
  assert.equal(bare.conclusion, 'FAIL');
});

test('adapted kits can never become PASS_A_FULL, including after production finalization or erased per-node steps', opts, () => {
  const generated = drillKitManifest({ payloads: { 'first-install-entry.ps1': Buffer.from('entry') },
    prereqBytes: Buffer.from('{"contract":"clued.drill.prereq/1"}') });
  for (const kit of [generated, { ...generated, perNodeSteps: [] }]) {
    const r = verdictOf(evidence({ kit }));
    assert.equal(pass(r).A10, false);
    const items = r.items.map(i => ['A5', 'A9'].includes(i.id) ? { ...i, pass: true } : i);
    assert.equal(ps(`Get-DrillConclusion (${q(JSON.stringify(items))} | ConvertFrom-Json) @{ result = 'PASS' }`), 'PASS_A_PER_NODE_STEPS_REMAIN');
  }
});

test('interactive A1 requires one genuine qualified launcher result, PNG evidence and A8 paths', opts, () => {
  const good = { fileCount: 1, qualified: true, screenshot: true, tree: 't', node: 'n' };
  const values = [good, { ...good, fileCount: 0 }, { ...good, fileCount: 2 }, { ...good, qualified: false },
    { ...good, screenshot: false }, { ...good, tree: '' }, { ...good, node: '' }];
  const r = ps(`$cases = ${q(JSON.stringify(values))} | ConvertFrom-Json; @($cases | ForEach-Object { ConvertFrom-DrillInteractiveEvidence $_ })`);
  assert.equal(r[0].status, 'FIRST_INSTALL_DONE');
  assert.ok(r.slice(1).every(x => x.exitCode === 1 && x.stopCode === 'DRILL_INTERACTIVE_EVIDENCE_NOT_COMPLETE'));
  assert.equal(psCode('$Interactive = $true; $BaselineOnly = $true; Invoke-DrillMain'), 'DRILL_USAGE');
});

test('guest scripts parse under Windows PowerShell before any VM work', opts, () => {
  for (const file of [script, entryScript]) {
    assert.deepEqual(ps(`$tokens = $null; $errors = $null; $null = [Management.Automation.Language.Parser]::ParseFile(${q(file)}, [ref]$tokens, [ref]$errors); [ordered]@{ count = @($errors).Count; messages = @($errors | ForEach-Object { $_.Message }) }`), { count: 0, messages: [] });
  }
});

test('the verdict: a clean drill passes A1-A8 and A10 reports the per-node steps; A5 production half and A9 wait for -Finalize', opts, () => {
  const r = verdictOf(evidence());
  assert.deepEqual(pass(r), { A1: true, A2: true, A3: true, A4: true, A5: null, A6: true, A7: true, A8: true, A9: null, A10: false });
  assert.equal(r.conclusion, 'PENDING_PRODUCTION_READBACK');
  assert.match(r.items.find((i) => i.id === 'A10').detail, /8c step 2/);
});

test('the verdict fails what the plan says fails', opts, () => {
  const e = JSON.parse(evidence());
  const halted = { ...e.status, halt: { code: 'ROLE_PROBE_CLEANUP_OR_FACT_UNCONFIRMED' }, executor: { state: 'HALTED' } };
  assert.equal(pass(verdictOf(evidence({ status: halted }))).A6, false);
  const stale = { ...e.status, versions: { selfcheck: { result: 'PASS', observedAt: '2026-11-16T02:00:00Z' } } };
  assert.equal(pass(verdictOf(evidence({ status: stale }))).A3, false);
  assert.equal(pass(verdictOf(evidence({ verify: { status: 'RESIDENT_VERIFICATION_FAILED' } }))).A2, false);
  assert.equal(pass(verdictOf(evidence({ facts: { ...e.facts, staged: { generation: 2 } } }))).A4, false);
  assert.equal(pass(verdictOf(evidence({ acceptanceSource: '6'.repeat(64) }))).A5, false);
  assert.equal(pass(verdictOf(evidence({ entry: { ...e.entry, stopCode: 'LINUX_PHASE_B_NOT_COMPLETED' } }))).A1, false);
  assert.equal(pass(verdictOf(evidence({ reboot: { ok: false, status: e.status, readAt: NOW } }))).A7, false);
  assert.equal(pass(verdictOf(evidence({ reinstall: { ...e.reinstall, upgradeStatus: 'FLEET_NODE_UPGRADE_NEEDS_REINSTALL' } }))).A8, false);
  assert.equal(verdictOf(evidence({ verify: { status: 'X' } })).conclusion, 'FAIL');
  const skipped = verdictOf(evidence({ reinstall: { skipped: true }, skipReinstall: true }));
  assert.equal(pass(skipped).A8, null); assert.equal(skipped.conclusion, 'PENDING_PRODUCTION_READBACK');
});

// Codex review of 58136df61, medium 2: the operator's choice (-SkipReinstall) and the run's A8 result reach the verdict apart. Only the
// choice makes A8 "skipped"; an A8 result that is missing, or says skipped without the choice, is FAIL and never named -SkipReinstall.
test('A8 is skipped only by the explicit option; a missing or unchosen skip is FAIL, through the real receipt', opts, () => {
  const e = JSON.parse(evidence());
  const a8 = over => { const r = verdictOf(evidence(over)); return { pass: pass(r).A8, detail: r.items.find(i => i.id === 'A8').detail, conclusion: r.conclusion }; };
  for (const [reason, over] of [
    ['no A8 result', { reinstall: null }],
    ['skipped without the option', { reinstall: { skipped: true } }],
    ['the option, but A8 ran', { reinstall: e.reinstall, skipReinstall: true }],
  ]) {
    const r = a8(over);
    assert.equal(r.pass, false, reason);
    assert.doesNotMatch(r.detail, /^skipped/, reason);
    assert.equal(r.conclusion, 'FAIL', reason);
  }
  assert.doesNotMatch(a8({ reinstall: null }).detail, /SkipReinstall/);
  // the real conversion: Invoke-DrillPreparedRun over a run that handed over no A8 result, a candidate whose other items all pass
  const absent = m5DrillReceipt('cand-a8-absent', RENEWAL_3BC571A6, { checker: 'PASS', missing: [], candidate: true, reinstall: 'absent' });
  const item = absent.items.find(i => i.id === 'A8');
  assert.equal(item.pass, false);
  assert.doesNotMatch(item.detail, /SkipReinstall/);
  assert.equal(absent.conclusion, 'FAIL');
  assert.equal(finalize('cand-a8-absent-finalize', absent, notTheDrillsSource()).output.code, 'DRILL_RECEIPT_NOT_FINALIZABLE');
  // a run whose A8 says skipped without the option: the same
  const unchosen = m5DrillReceipt('cand-a8-unchosen', RENEWAL_3BC571A6, { checker: 'PASS', missing: [], candidate: true, reinstall: { skipped: true } });
  assert.equal(unchosen.items.find(i => i.id === 'A8').pass, false);
  assert.equal(unchosen.conclusion, 'FAIL');
});
