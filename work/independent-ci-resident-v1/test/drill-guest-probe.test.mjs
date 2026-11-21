// The drill's read-only guest probe (Fable ruling 0e418483, phase B image id, 4.3): after the launcher stage and before the checkpoint is
// restored, whether the first install passed or failed, one read-only pass over the guest's WSL: the docker storage, the image list, each
// kit image's .Id and RepoDigests, the sha256 and package version of the files the inventory names, systemctl --failed. The answers are
// kept raw in stage-evidence.json ('guest-probe') and never judged; a probe that cannot run is recorded and changes nothing else.
// No VM is touched: the guest side runs against a fake wsl.exe; no test here depends on the wall clock.
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
const filesList = fileURLToPath(new URL('../drill/guest-probe-files.json', import.meta.url));
const hostPrep = fileURLToPath(new URL('../windows/first-install-host.ps1', import.meta.url));
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-probe-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const ownMutexes = `$script:Drill.HostMutex = ${q(`Local\\CluedDrillProbeTest-${path.basename(tmp)}-host`)}; $script:Drill.BootMutex = ${q(`Local\\CluedDrillProbeTest-${path.basename(tmp)}-boot`)}`;
function ps(expr) {
  const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $ProgressPreference='SilentlyContinue'; . ${q(script)}; ${ownMutexes}; ConvertTo-Json -Depth 12 -Compress -InputObject $(${expr})`], { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout.trim());
}

const arr = (v) => (v == null ? [] : [].concat(v));
const HEX_A = 'a'.repeat(64), HEX_B = 'b'.repeat(64);
const PLAN_ARGS = `-ImageIds @('sha256:${HEX_A}', 'sha256:${HEX_B}') -Files @('/usr/bin/python3.12', '/usr/bin/gitleaks')`;
const commandsOf = () => ps(`Get-DrillProbeCommands ${PLAN_ARGS}`);

test('the probe list covers every reading 4.3 names, each one read-only', opts, () => {
  const c = commandsOf();
  const byId = Object.fromEntries(c.map(x => [x.id, x]));
  assert.equal(c.length, new Set(c.map(x => x.id)).size, 'ids are unique');
  assert.match(byId['docker-driver'].script, /docker info --format '\{\{json \.Driver\}\}'/);
  assert.match(byId['docker-driver-status'].script, /docker info --format '\{\{json \.DriverStatus\}\}'/);
  assert.match(byId['docker-image-ls'].script, /docker image ls --no-trunc --digests/);
  for (const hex of [HEX_A, HEX_B]) {
    const x = byId[`image:sha256:${hex}`];
    assert.ok(x, 'one inspect per kit image');
    assert.match(x.script, /docker image inspect --format '\{\{\.Id\}\} \{\{json \.RepoDigests\}\}' "\$1"/);
    assert.deepEqual(x.args, [`sha256:${hex}`], 'the reference is an argument, never spliced into the script');
  }
  for (const p of ['/usr/bin/python3.12', '/usr/bin/gitleaks']) {
    const x = byId[`file:${p}`];
    assert.ok(x, 'one reading per inventory file');
    assert.match(x.script, /sha256sum -- "\$p"/);
    assert.match(x.script, /dpkg-query -W -f=/);
    assert.deepEqual(x.args, [p]);
  }
  assert.match(byId['systemd-failed'].script, /systemctl --failed --no-pager --plain/);
  // read-only: nothing that writes, loads, pulls, removes, restarts or installs
  for (const x of c) assert.doesNotMatch(x.script, /\b(docker (pull|load|rm|rmi|run|save|exec|start|stop|restart|prune)|systemctl (start|stop|restart|enable|disable|reset-failed|mask)|dpkg -i|apt|rm |mv |cp |tee |>)/, x.id);
});

test('a reference or path that is not of the expected shape is refused before any command is built', opts, () => {
  for (const bad of [`'sha256:xyz'`, `'x; rm -rf /'`, `''`, `'sha256:${HEX_A} --all'`]) {
    assert.equal(ps(`try { Get-DrillProbeCommands -ImageIds @(${bad}) -Files @('/usr/bin/python3.12'); 'built' } catch { (Get-DrillCode $_).code }`), 'DRILL_PROBE_PLAN_REFUSED', bad);
  }
  for (const bad of [`'usr/bin/python3.12'`, `'/usr/bin/x; id'`, `'/usr/../etc/shadow'`, `'/usr/bin/a b'`]) {
    assert.equal(ps(`try { Get-DrillProbeCommands -ImageIds @() -Files @(${bad}); 'built' } catch { (Get-DrillCode $_).code }`), 'DRILL_PROBE_PLAN_REFUSED', bad);
  }
});

test('the file inventory is one file in drill/, read by the drill, and always names the pinned python', opts, () => {
  const doc = JSON.parse(fs.readFileSync(filesList, 'utf8'));
  assert.equal(doc.contract, 'clued.drill.guest-probe-files/1');
  assert.ok(Array.isArray(doc.paths) && doc.paths.includes('/usr/bin/python3.12'));
  assert.equal(arr(ps(`@(Read-DrillProbeFiles)`)).includes('/usr/bin/python3.12'), true);
  // the drill reads it from the one place, whatever the host's working directory
  assert.equal(ps(`$script:Drill.ProbeFiles -ceq (Join-Path (Split-Path -Parent $script:DrillScriptPath) 'guest-probe-files.json')`), true);
  // a damaged inventory is refused by name (the caller then records "not run"), never read as an empty one
  const bad = path.join(tmp, 'bad-files.json'); fs.writeFileSync(bad, '{"contract":"x","paths":["/usr/bin/python3.12"]}');
  assert.equal(ps(`try { Read-DrillProbeFiles ${q(bad)}; 'read' } catch { (Get-DrillCode $_).code }`), 'DRILL_PROBE_FILES_REFUSED');
  fs.writeFileSync(bad, '{"contract":"clued.drill.guest-probe-files/1","paths":[]}');
  assert.equal(ps(`try { Read-DrillProbeFiles ${q(bad)}; 'read' } catch { (Get-DrillCode $_).code }`), 'DRILL_PROBE_FILES_REFUSED');
});

test('the probe enters the distribution the first install makes', opts, () => {
  const m = /^\$Distribution = '([^']+)'/m.exec(fs.readFileSync(hostPrep, 'utf8'));
  assert.ok(m);
  assert.equal(ps(`$script:Drill.ProbeDistribution`), m[1]);
});

test('the kit image ids come from the release files the drill already holds', opts, () => {
  const dir = path.join(tmp, 'kit-ids'); fs.mkdirSync(dir, { recursive: true });
  const kit = path.join(dir, 'fleet-node-1.2.3.first-install-kit.json');
  fs.writeFileSync(kit, JSON.stringify({ contract: 'clued.independent-ci.fleet-node-first-install-kit/1',
    images: { local: [{ id: HEX_B, asset: `role-image-${HEX_B}.tar.gz` }, { id: HEX_A, asset: `role-image-${HEX_A}.tar.gz` }, { id: HEX_A, asset: `role-image-${HEX_A}.tar.gz` }] } }));
  const other = path.join(dir, 'fleet-node-1.2.3.tar'); fs.writeFileSync(other, 'x');
  assert.deepEqual(arr(ps(`@(Get-DrillKitImageIds @(${q(other)}, ${q(kit)}))`)), [`sha256:${HEX_A}`, `sha256:${HEX_B}`], 'sorted, once each');
  assert.deepEqual(arr(ps(`@(Get-DrillKitImageIds @(${q(other)}))`)), [], 'no kit among the files: nothing to inspect');
  fs.writeFileSync(kit, '{ not json');
  assert.deepEqual(arr(ps(`@(Get-DrillKitImageIds @(${q(kit)}))`)), [], 'an unreadable kit is no list (the probe still reads the rest)');
});

// A fake wsl.exe: node writes each call's arguments to calls.jsonl and answers by the script text; FAKE_FAIL names an id-less substring
// whose command exits 7, FAKE_MISSING makes every call exit 1 with a message on stderr.
function fakeWsl(name) {
  const dir = path.join(tmp, name); fs.mkdirSync(dir, { recursive: true });
  const js = path.join(dir, 'fake-wsl.mjs'), cmd = path.join(dir, 'wsl.cmd'), calls = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(js, `import fs from 'node:fs';
const a = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a) + '\\n');
const s = a[a.indexOf('-c') + 1] ?? '';
if (process.env.FAKE_FAIL && s.includes(process.env.FAKE_FAIL)) { process.stderr.write('boom\\n'); process.exit(7); }
process.stdout.write('ANSWER ' + s.split(' ').slice(0, 3).join('_') + ' ' + a.slice(a.indexOf('_') + 1).join(',') + '\\n');
`);
  fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`);
  return { dir, cmd, calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []) };
}
const runGuest = (wslCmd, env = '') => ps(`${env}
  $c = Get-DrillProbeCommands ${PLAN_ARGS}
  $plan = New-DrillProbePlan -Commands $c -WslExe ${q(wslCmd)}
  & $script:GuestProbe $plan $script:DrillNativeText`);

test('the guest side runs every command apart, as root, with a clean environment, and keeps each answer raw', opts, () => {
  const w = fakeWsl('guest-ok');
  const r = runGuest(w.cmd);
  assert.equal(r.schema, 'clued.drill.guest-probe/1');
  assert.equal(r.distribution, 'CluedResident-Linux');
  assert.ok(!Number.isNaN(Date.parse(r.at)));
  const ids = r.commands.map(x => x.id);
  assert.deepEqual(ids, ['docker-driver', 'docker-driver-status', 'docker-image-ls', `image:sha256:${HEX_A}`, `image:sha256:${HEX_B}`, 'file:/usr/bin/python3.12', 'file:/usr/bin/gitleaks', 'systemd-failed']);
  assert.ok(r.commands.every(x => x.exit === 0 && x.error === null && typeof x.stdout === 'string' && x.stdout.startsWith('ANSWER')));
  const calls = w.calls();
  assert.equal(calls.length, ids.length);
  for (const a of calls) {
    assert.deepEqual(a.slice(0, 5), ['-d', 'CluedResident-Linux', '-u', 'root', '--exec']);
    assert.deepEqual(a.slice(5, 9), ['/usr/bin/env', '-i', 'PATH=/usr/sbin:/usr/bin:/sbin:/bin', 'LANG=C']);
  }
  assert.deepEqual(calls[3].slice(-2), ['_', `sha256:${HEX_A}`], 'a reference travels as an argument');
});

test('one command failing, or wsl itself missing, stops nothing and throws nothing', opts, () => {
  const w = fakeWsl('guest-fail');
  const r = runGuest(w.cmd, `$env:FAKE_FAIL = 'docker image ls';`);
  assert.equal(r.commands.length, 8, 'the others still ran');
  const failed = r.commands.find(x => x.id === 'docker-image-ls');
  assert.equal(failed.exit, 7);
  assert.match(failed.stderr, /boom/);
  assert.equal(r.commands.filter(x => x.exit === 0).length, 7);
  const none = runGuest(path.join(tmp, 'no-such-wsl.exe'));
  assert.equal(none.schema, 'clued.drill.guest-probe/1');
  assert.equal(none.commands.length, 8);
  assert.ok(none.commands.every(x => x.exit === null && typeof x.error === 'string' && x.error.length > 0), 'each one says why it did not answer');
});

test('the guest side does nothing when it is not handed a plan', opts, () => {
  const w = fakeWsl('guest-noplan');
  const r = ps(`$r = & $script:GuestProbe ${q('C:\\some\\guest\\work')} $script:DrillNativeText; $null -eq $r`);
  assert.equal(r, true);
  assert.deepEqual(w.calls(), []);
});

// Save-DrillStageEvidence with the guest stubbed: the stage files come from a directory, the probe from the stub.
function guestWork(name, files) {
  const dir = path.join(tmp, name); fs.mkdirSync(dir, { recursive: true });
  for (const [n, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), text);
  return dir;
}
const LAUNCHER_FAILED = JSON.stringify({ exit: 1, terminal: { status: 'BOOTSTRAP_REFUSED', code: 'LAUNCHER_STAGE_FAILED' } });
const PROBE = { schema: 'clued.drill.guest-probe/1', at: '2026-11-21T03:00:00Z', distribution: 'CluedResident-Linux',
  commands: [{ id: 'docker-driver', script: 's', args: [], exit: 0, error: null, stdout: '"overlayfs"\n', stderr: '' }] };
// A stub for Invoke-DrillGuest: the stage-file reader runs over the directory, the probe call is answered by $probeAnswer.
const stub = (work, probeAnswer) => `
  $script:probeCalls = New-Object Collections.Generic.List[string]
  function Invoke-DrillGuest { param($Credential, $Script, $ArgumentList, $TimeoutMinutes, $Code, $Step, [switch]$Restartable)
    if ($Step -ceq 'guest-probe') { $script:probeCalls.Add('probe'); ${probeAnswer} }
    else { $script:probeCalls.Add('files'); & $Script ${q(work)} $ArgumentList[1] } }`;

test('the probe runs before the stage files are taken, on a failed launcher too, and lands in stage-evidence.json', opts, () => {
  const work = guestWork('save-failed-guest', { 'launcher-result.json': LAUNCHER_FAILED });
  const runDir = path.join(tmp, 'save-failed-run'); fs.mkdirSync(runDir, { recursive: true });
  const r = ps(`${stub(work, `${q(JSON.stringify(PROBE))} | ConvertFrom-Json`)}
    $script:DrillProbeImageIds = @(); $c = Save-DrillStageEvidence ${q(runDir)} $null
    [ordered]@{ order = @($script:probeCalls); probeState = $c.record.probe.state; collection = $c.record.collection; launcher = $c.record.files['launcher-result.json'].state }`);
  assert.deepEqual(r.order, ['probe', 'files'], 'the probe first: nothing else touches the guest in between');
  assert.equal(r.probeState, 'saved');
  assert.equal(r.collection, null);
  assert.equal(r.launcher, 'saved');
  const ev = JSON.parse(fs.readFileSync(path.join(runDir, 'stage-evidence.json'), 'utf8'));
  assert.deepEqual(ev['guest-probe'], PROBE);
  assert.equal(ev['launcher-result.json'].terminal.code, 'LAUNCHER_STAGE_FAILED');
});

test('the probe is kept even when no stage result could be read', opts, () => {
  const work = guestWork('save-noresult-guest', { 'stage-timings.json': '{}' });
  const runDir = path.join(tmp, 'save-noresult-run'); fs.mkdirSync(runDir, { recursive: true });
  ps(`${stub(work, `${q(JSON.stringify(PROBE))} | ConvertFrom-Json`)}
    $script:DrillProbeImageIds = @(); Save-DrillStageEvidence ${q(runDir)} $null | Out-Null; 0`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'stage-evidence.json'), 'utf8'))['guest-probe'], PROBE);
});

test('a probe that fails, throws or answers nonsense changes nothing else', opts, () => {
  const base = (name, answer) => {
    const work = guestWork(`save-${name}-guest`, { 'launcher-result.json': LAUNCHER_FAILED, 'stage-timings.json': '{"host":1}' });
    const runDir = path.join(tmp, `save-${name}-run`); fs.mkdirSync(runDir, { recursive: true });
    const r = ps(`${stub(work, answer)}
      $script:DrillProbeImageIds = @(); $c = Save-DrillStageEvidence ${q(runDir)} $null
      [ordered]@{ probe = $c.record.probe; collection = $c.record.collection; files = $c.record.files; keys = @($c.stageEvidence.Keys) }`);
    const ev = JSON.parse(fs.readFileSync(path.join(runDir, 'stage-evidence.json'), 'utf8'));
    return { r, ev };
  };
  const thrown = base('thrown', `throw (New-DrillError 'DRILL_GUEST_STEP_FAILED')`);
  const nonsense = base('nonsense', `[ordered]@{ schema = 'something-else' }`);
  const nothing = base('nothing', `$null`);
  const clean = base('clean', `$null`);
  assert.equal(thrown.r.probe.state, 'not-run');
  assert.equal(thrown.r.probe.code, 'DRILL_GUEST_STEP_FAILED');
  assert.equal(nonsense.r.probe.state, 'not-run');
  assert.equal(nothing.r.probe.state, 'not-run');
  for (const x of [thrown, nonsense, nothing]) {
    assert.equal(x.r.collection, null, 'the stage-file collection is not marked failed by a probe');
    assert.deepEqual(x.r.files, clean.r.files, 'every stage file keeps its own state');
    assert.equal(x.ev['guest-probe'], undefined, 'nothing is written from nothing');
    assert.equal(x.ev['launcher-result.json'].terminal.code, 'LAUNCHER_STAGE_FAILED');
  }
});

test('a plan the drill cannot build is recorded as not run and the guest is not asked', opts, () => {
  const work = guestWork('save-noplan-guest', { 'launcher-result.json': LAUNCHER_FAILED });
  const runDir = path.join(tmp, 'save-noplan-run'); fs.mkdirSync(runDir, { recursive: true });
  const r = ps(`${stub(work, `${q(JSON.stringify(PROBE))} | ConvertFrom-Json`)}
    function Read-DrillProbeFiles { throw (New-DrillError 'DRILL_PROBE_FILES_REFUSED') }
    $script:DrillProbeImageIds = @(); $c = Save-DrillStageEvidence ${q(runDir)} $null
    [ordered]@{ order = @($script:probeCalls); probe = $c.record.probe; launcher = $c.record.files['launcher-result.json'].state }`);
  assert.deepEqual(r.order, ['files']);
  assert.equal(r.probe.state, 'not-run');
  assert.equal(r.probe.code, 'DRILL_PROBE_FILES_REFUSED');
  assert.equal(r.launcher, 'saved');
});

test('the run hands the probe the kit images it carries, before the guest evidence is taken', opts, () => {
  const text = fs.readFileSync(script, 'utf8');
  const run = text.slice(text.indexOf('function Invoke-DrillRun'), text.indexOf('function Save-DrillGuestEvidence'));
  const ids = run.indexOf('$script:DrillProbeImageIds = '), entry = run.indexOf('$entryOut = $null');
  assert.ok(ids > 0 && entry > ids, 'set before the first install starts, so every end of it finds it');
  assert.match(run.slice(ids, entry), /Get-DrillKitImageIds/);
  // the probe lives only in the stage evidence collection, which Save-DrillGuestEvidence runs on every end, before the checkpoint restore
  assert.match(text.slice(text.indexOf('function Save-DrillGuestEvidence')), /\$stage = Save-DrillStageEvidence/);
});
