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
  assert.deepEqual(arr(ps(`[ordered]@{ v = @(Get-DrillKitImageIds @(${q(other)}, ${q(kit)})) }`).v), [`sha256:${HEX_A}`, `sha256:${HEX_B}`], 'sorted, once each');
  assert.deepEqual(arr(ps(`[ordered]@{ v = @(Get-DrillKitImageIds @(${q(other)})) }`).v), [], 'no kit among the files: nothing to inspect');
  fs.writeFileSync(kit, '{ not json');
  assert.deepEqual(arr(ps(`[ordered]@{ v = @(Get-DrillKitImageIds @(${q(kit)})) }`).v), [], 'an unreadable kit is no list (the probe still reads the rest)');
});

// A fake wsl.exe, a real console program (a .cmd would let cmd.exe read the | and && of a script argument): it appends each call's arguments
// (separated by U+001F, one call per line) to calls.txt beside it and answers by the script text; FAKE_FAIL is a substring of a script
// whose command exits 7 with "boom" on stderr.
const FAKE_WSL_CS = `using System; using System.IO;
public static class P { public static int Main(string[] a) {
  string dir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
  File.AppendAllText(Path.Combine(dir, "calls.txt"), string.Join("\\u001f", a) + "\\n");
  int c = Array.IndexOf(a, "-c"); string s = (c >= 0 && c + 1 < a.Length) ? a[c + 1] : "";
  int u = Array.IndexOf(a, "_"); string rest = (u >= 0) ? string.Join(",", a, u + 1, a.Length - u - 1) : "";
  string fail = Environment.GetEnvironmentVariable("FAKE_FAIL");
  if (!string.IsNullOrEmpty(fail) && s.Contains(fail)) { Console.Error.WriteLine("boom"); return 7; }
  Console.Out.WriteLine("ANSWER " + s.Split(' ')[0] + " " + rest); return 0; } }`;
function fakeWsl(name) {
  const dir = path.join(tmp, name); fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'fake.cs'), exe = path.join(dir, 'wsl.exe'), calls = path.join(dir, 'calls.txt');
  fs.writeFileSync(src, FAKE_WSL_CS);
  const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `Add-Type -TypeDefinition ([IO.File]::ReadAllText(${q(src)})) -OutputType ConsoleApplication -OutputAssembly ${q(exe)}`], { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const split = (text) => text.split('\n').filter(Boolean).map(l => l.split('\u001f'));
  return { dir, cmd: exe, calls: () => (fs.existsSync(calls) ? split(fs.readFileSync(calls, 'utf8')) : []) };
}
const runGuest = (wslCmd, env = '') => ps(`${env}
  $c = Get-DrillProbeCommands ${PLAN_ARGS}
  $plan = New-DrillProbePlan -Commands $c -WslExe ${q(wslCmd)}
  & $script:GuestInspect $plan $script:DrillNativeText`);

test('the guest side runs every command apart, as root, with a clean environment, and keeps each answer raw', opts, () => {
  const w = fakeWsl('guest-ok');
  const r = runGuest(w.cmd);
  assert.equal(r.schema, 'clued.drill.guest-probe/1');
  assert.equal(r.distribution, 'CluedResident-Linux');
  assert.equal(r.at, undefined, 'no clock read in the guest: the host stamps the record');
  const ids = r.commands.map(x => x.id);
  const FIXED_HEAD = ['docker-driver', 'docker-driver-status', 'docker-info-json', 'docker-image-ls', 'docker-image-inspect-all'];
  const FIXED_TAIL = ['systemd-failed', 'systemd-is-system-running', 'systemd-version', 'runner-service-enabled', 'guest-nproc', 'guest-meminfo', 'guest-uname',
    'systemd-verify:clued-ci-worker@.service', 'systemd-verify:clued-ci-wsprep@.service', 'systemd-verify:clued-ci-archive@.service'];
  assert.deepEqual(ids, [...FIXED_HEAD, `image:sha256:${HEX_A}`, `image:sha256:${HEX_B}`, 'file:/usr/bin/python3.12', 'file:/usr/bin/gitleaks', ...FIXED_TAIL]);
  assert.ok(r.commands.every(x => x.exit === 0 && x.error === null && typeof x.stdout === 'string' && x.stdout.startsWith('ANSWER')));
  const calls = w.calls();
  assert.equal(calls.length, ids.length);
  for (const a of calls) {
    assert.deepEqual(a.slice(0, 5), ['-d', 'CluedResident-Linux', '-u', 'root', '--exec']);
    assert.deepEqual(a.slice(5, 9), ['/usr/bin/env', '-i', 'PATH=/usr/sbin:/usr/bin:/sbin:/bin', 'LANG=C']);
  }
  assert.deepEqual(calls[5].slice(-2), ['_', `sha256:${HEX_A}`], 'a reference travels as an argument');
});

test('one command failing, or wsl itself missing, stops nothing and throws nothing', opts, () => {
  const w = fakeWsl('guest-fail');
  const ids = commandsOf().map(x => x.id);
  const r = runGuest(w.cmd, `$env:FAKE_FAIL = 'docker image ls --no-trunc --digests';`);
  assert.equal(r.commands.length, ids.length, 'the others still ran');
  const failed = r.commands.find(x => x.id === 'docker-image-ls');
  assert.equal(failed.exit, 7);
  assert.match(failed.stderr, /boom/);
  assert.equal(r.commands.filter(x => x.exit === 0).length, ids.length - 1);
  const none = runGuest(path.join(tmp, 'no-such-wsl.exe'));
  const idsNone = commandsOf().map(x => x.id);
  assert.equal(none.schema, 'clued.drill.guest-probe/1');
  assert.equal(none.commands.length, idsNone.length);
  assert.ok(none.commands.every(x => x.exit === null && typeof x.error === 'string' && x.error.length > 0), 'each one says why it did not answer');
});

test('the guest side does nothing when it is not handed a plan', opts, () => {
  const w = fakeWsl('guest-noplan');
  const r = ps(`$r = & $script:GuestInspect ${q('C:\\some\\guest\\work')} $script:DrillNativeText; $null -eq $r`);
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
const PROBE = { schema: 'clued.drill.guest-probe/1', distribution: 'CluedResident-Linux',
  commands: [{ id: 'docker-driver', script: 's', args: [], exit: 0, error: null, stdout: '"overlayfs"\n', stderr: '' }] };
// A stub for Invoke-DrillGuest: the stage-file reader runs over the directory, the probe call is answered by $probeAnswer.
const stub = (work, probeAnswer) => `
  $script:probeCalls = New-Object Collections.Generic.List[string]
  function Invoke-DrillGuest { param($Credential, $Script, $ArgumentList, $TimeoutMinutes, $Code, $Step, [switch]$Restartable)
    if ($Step -ceq 'guest-probe') { $script:probeCalls.Add('probe'); $script:probeTimeout = $TimeoutMinutes; ${probeAnswer} }
    else { $script:probeCalls.Add('files'); & $Script ${q(work)} $ArgumentList[1] } }`;

test('the required stage files are taken first, then the probe (5 minutes at most), on a failed launcher too; it lands in stage-evidence.json', opts, () => {
  const work = guestWork('save-failed-guest', { 'launcher-result.json': LAUNCHER_FAILED });
  const runDir = path.join(tmp, 'save-failed-run'); fs.mkdirSync(runDir, { recursive: true });
  const r = ps(`${stub(work, `${q(JSON.stringify(PROBE))} | ConvertFrom-Json`)}
    $script:DrillProbeImageIds = @(); $c = Save-DrillStageEvidence ${q(runDir)} $null
    [ordered]@{ order = @($script:probeCalls); probeTimeout = $script:probeTimeout; probeState = $c.record.probe.state; collection = $c.record.collection; launcher = $c.record.files['launcher-result.json'].state }`);
  assert.deepEqual(r.order, ['files', 'probe'], 'the required evidence first: a guest that hangs must not eat its time');
  assert.equal(r.probeTimeout, 5, 'the probe is an extra: its outer bound is 5 minutes');
  assert.equal(r.probeState, 'saved');
  assert.equal(r.collection, null);
  assert.equal(r.launcher, 'saved');
  const ev = JSON.parse(fs.readFileSync(path.join(runDir, 'stage-evidence.json'), 'utf8'));
  assert.deepEqual(ev['guest-probe'], PROBE);
  assert.equal(ev['launcher-result.json'].terminal.code, 'LAUNCHER_STAGE_FAILED');
});

test('with no stage result read, the probe is kept apart and no stage-evidence.json is made from it', opts, () => {
  const work = guestWork('save-noresult-guest', { 'stage-timings.json': '{}' });
  const runDir = path.join(tmp, 'save-noresult-run'); fs.mkdirSync(runDir, { recursive: true });
  const r = ps(`${stub(work, `${q(JSON.stringify(PROBE))} | ConvertFrom-Json`)}
    $script:DrillProbeImageIds = @(); $c = Save-DrillStageEvidence ${q(runDir)} $null
    [ordered]@{ probe = $c.record.probe.state }`);
  assert.equal(r.probe, 'saved-apart');
  assert.ok(!fs.existsSync(path.join(runDir, 'stage-evidence.json')), 'the abort evidence reads its presence: the probe alone must not create it');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'guest-probe.json'), 'utf8')), PROBE);
});

test('the late probe has the same 5-minute outer bound', opts, () => {
  const text = fs.readFileSync(script, 'utf8');
  const fn = text.slice(text.indexOf('function Invoke-DrillGuestProbe'), text.indexOf('function Save-DrillLateProbe'));
  assert.match(fn, /-TimeoutMinutes 5 -Step/);
  assert.doesNotMatch(fn, /-TimeoutMinutes 20/);
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

// ---- the two offline inventories' "needs a guest reading" sections, and the late worker-instance start (Fable ruling addenda) ----

test('every reading the two inventories name is in the probe, and the main probe only reads', opts, () => {
  const c = commandsOf();
  const text = Object.fromEntries(c.map(x => [x.id, x.script]));
  assert.match(text['docker-info-json'], /docker info --format '\{\{json \.\}\}'/);
  assert.match(text['docker-image-inspect-all'], /docker image ls -aq --no-trunc/);
  for (const field of ['\\.Id', 'json \\.RepoDigests', '\\.Os', 'json \\.Config\\.Env', 'json \\.Config\\.Volumes']) assert.match(text['docker-image-inspect-all'], new RegExp(field));
  assert.match(text['runner-service-enabled'], /systemctl is-enabled --quiet actions\.runner\.tdoljyj-cross-memory-system\.clued-ci-home-linux-01\.service; echo "is-enabled-exit=\$\?"/);
  assert.match(text['systemd-is-system-running'], /systemctl is-system-running/);
  assert.match(text['systemd-version'], /systemctl --version/);
  assert.equal(text['guest-nproc'], 'nproc');
  assert.match(text['guest-meminfo'], /MemTotal\|SwapTotal.*\/proc\/meminfo/);
  assert.equal(text['guest-uname'], 'uname -r');
  for (const u of ['worker', 'wsprep', 'archive']) {
    const x = c.find(y => y.id === `systemd-verify:clued-ci-${u}@.service`);
    assert.ok(x); assert.match(x.script, /systemd-analyze verify "\$1"; echo "verify-exit=\$\?"/);
    assert.deepEqual(x.args, [`/etc/systemd/system/clued-ci-${u}@.service`]);
  }
  for (const x of c.filter(y => y.id.startsWith('file:'))) assert.match(x.script, /stat -c '%U:%G:%a:%F' -- "\$p"/, 'owner, group, mode and type of every inventory path');
  for (const x of c) assert.doesNotMatch(x.script, /systemctl (start|restart|stop|reset-failed)/, `${x.id} does not change anything`);
});

test('the inventory holds the 23 paths of the first offline inventory and the 8 of the second', opts, () => {
  const paths = arr(ps(`@(Read-DrillProbeFiles)`));
  for (const p of ['/usr/bin/python3.12', '/usr/bin/git', '/usr/bin/docker', '/run/docker.sock', '/etc/docker/daemon.json', '/var/lib/clued-independent-ci-trivy-cache',
    '/etc/systemd/system/clued-ci-worker@.service', '/var/lib/clued-independent-ci/resident/upgrade/g1.json',
    '/usr/bin/systemd-run', '/usr/bin/systemd-analyze', '/usr/bin/systemctl', '/etc/wsl.conf', '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux',
    '/opt/clued-independent-ci/resident-v1/manifest.json', '/var/lib/clued-independent-ci/formal-spool/incoming', '/var/lib/clued-independent-ci/formal-spool/outgoing']) {
    assert.ok(paths.includes(p), p);
  }
  assert.equal(paths.length, 31);
});

test('the Windows side of the drill machine is read after the distribution, each reading on its own', opts, () => {
  const w = fakeWsl('guest-windows');
  const r = ps(`$plan = New-DrillProbePlan (Get-DrillProbeCommands -Files @('/usr/bin/python3.12')) -WslExe ${q(w.cmd)} -Windows
    & $script:GuestInspect $plan $script:DrillNativeText`);
  assert.ok(r.windows.computerSystem.NumberOfLogicalProcessors > 0);
  assert.ok(r.windows.computerSystem.TotalPhysicalMemory > 0);
  assert.equal(typeof r.windows.wslVersion.exit, 'number');
  assert.ok(Array.isArray(arr(r.windows.wslconfig)));
  assert.deepEqual(arr(r.windows.errors), []);
  const calls = w.calls();
  assert.deepEqual(calls[calls.length - 1], ['--version'], 'wsl --version, after the distribution commands');
  const plain = ps(`$plan = New-DrillProbePlan (Get-DrillProbeCommands -Files @('/usr/bin/python3.12')) -WslExe ${q(w.cmd)}
    $x = & $script:GuestInspect $plan $script:DrillNativeText; -not $x.Contains('windows')`);
  assert.equal(plain, true, 'only when the plan asks');
});

test('the late probe is the one command that starts a unit: a rejected worker instance, the trivy cache read before and after, then reset-failed', opts, () => {
  const c = arr(ps(`@(Get-DrillLateProbeCommands)`));
  assert.equal(c.length, 1);
  assert.equal(c[0].id, 'trivy-cache-by-rejected-worker');
  const s = c[0].script;
  const marks = ['stat -c', 'systemctl start "clued-ci-worker@${n}.service"', 'systemctl reset-failed "clued-ci-worker@${n}.service"'].map(x => s.indexOf(x));
  const lastStat = s.lastIndexOf('stat -c');
  assert.ok(marks[0] >= 0 && marks[0] < marks[1] && marks[1] < lastStat && lastStat < marks[2], 'before, start, after, reset');
  assert.match(s, /d=\/var\/lib\/clued-independent-ci-trivy-cache/);
  assert.match(s, /timeout 60 systemctl start/);
  assert.deepEqual(c[0].args, ['r8-probe-rejected']);
  assert.ok(!commandsOf().some(x => x.id === c[0].id), 'not among the main probe commands');
});

test('the late probe is merged into stage-evidence.json when it exists, kept apart when it does not, and never throws', opts, () => {
  const LATE = { schema: 'clued.drill.guest-probe/1', distribution: 'CluedResident-Linux', commands: [{ id: 'trivy-cache-by-rejected-worker', exit: 0, stdout: 'root:root:700:directory\n' }] };
  const stubLate = (answer) => `function Invoke-DrillGuest { param($Credential, $Script, $ArgumentList, $TimeoutMinutes, $Code, $Step, [switch]$Restartable)
    if ($Step -ceq 'guest-probe-late') { ${answer} } else { throw 'unexpected step' } }`;
  const withEvidence = path.join(tmp, 'late-with'); fs.mkdirSync(withEvidence, { recursive: true });
  fs.writeFileSync(path.join(withEvidence, 'stage-evidence.json'), JSON.stringify({ 'launcher-result.json': { exit: 0 }, 'guest-probe': PROBE }));
  fs.writeFileSync(path.join(withEvidence, 'stage-files.json'), JSON.stringify({ files: {}, probe: { state: 'saved' } }));
  const a = ps(`${stubLate(`${q(JSON.stringify(LATE))} | ConvertFrom-Json`)}
    (Save-DrillLateProbe ${q(withEvidence)} $null).state`);
  assert.equal(a, 'saved');
  const ev = JSON.parse(fs.readFileSync(path.join(withEvidence, 'stage-evidence.json'), 'utf8'));
  assert.deepEqual(ev['guest-probe-late'], LATE);
  assert.deepEqual(ev['guest-probe'], PROBE, 'what was there stays');
  assert.equal(ev['launcher-result.json'].exit, 0);
  const rec = JSON.parse(fs.readFileSync(path.join(withEvidence, 'stage-files.json'), 'utf8'));
  assert.equal(rec.probeLate.state, 'saved');
  assert.equal(rec.probe.state, 'saved');

  const without = path.join(tmp, 'late-without'); fs.mkdirSync(without, { recursive: true });
  const b = ps(`${stubLate(`${q(JSON.stringify(LATE))} | ConvertFrom-Json`)}
    (Save-DrillLateProbe ${q(without)} $null).state`);
  assert.equal(b, 'saved-apart');
  assert.ok(!fs.existsSync(path.join(without, 'stage-evidence.json')), 'no stage-evidence.json from nothing: the abort evidence reads its presence');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(without, 'guest-probe-late.json'), 'utf8')), LATE);

  for (const [name, answer] of [['thrown', `throw (New-DrillError 'DRILL_GUEST_STEP_FAILED')`], ['nonsense', `[ordered]@{ schema = 'x' }`], ['nothing', `$null`]]) {
    const dir = path.join(tmp, `late-${name}`); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'stage-evidence.json'), JSON.stringify({ 'launcher-result.json': { exit: 0 } }));
    const s = ps(`${stubLate(answer)}
      $x = Save-DrillLateProbe ${q(dir)} $null; $x.state`);
    assert.equal(s, 'not-run', name);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'stage-evidence.json'), 'utf8')), { 'launcher-result.json': { exit: 0 } }, 'evidence untouched');
  }
});

test('the late probe is called once, at the end of the run: after the reinstall, before the M5 copy, outside every verdict', opts, () => {
  const text = fs.readFileSync(script, 'utf8');
  const run = text.slice(text.indexOf('function Invoke-DrillRun'), text.indexOf('function Save-DrillGuestEvidence'));
  assert.equal(run.split('Save-DrillLateProbe').length, 2);
  assert.ok(run.indexOf('Save-DrillLateProbe') > run.indexOf('prepareAgainStatus') && run.indexOf('Save-DrillLateProbe') < run.indexOf('$m5 = try { Copy-DrillM5'));
  assert.doesNotMatch(text.slice(text.indexOf('function Get-DrillVerdict'), text.indexOf('function Test-DrillAfterBoot')), /guest-probe|probeLate|GuestInspect/);
  // the readiness probe the drill already had keeps its own name and body
  assert.match(text, /\$script:GuestProbe = \{\r?\n\s+\$setup = Get-ItemProperty -Path 'HKLM:\\SYSTEM\\Setup'/);
  assert.equal(text.split('$script:GuestProbe =').length, 2, 'one definition: the read-only probe uses GuestInspect');
});
