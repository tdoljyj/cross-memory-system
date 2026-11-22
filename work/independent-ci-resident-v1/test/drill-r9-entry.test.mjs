// r9 follow-up (task 0e418483, FABLE-drill-r9-followup sections 1.3 B and 3.2 (3)): the kit entry's side.
//   S1  an entry that ends STOPPED leaves resident-failure-snapshot.json in its output directory: the listed files as they are (HALT.json
//       word for word), the launcher's progress records, the Service Control Manager's events since it started; r9's HALT never left the guest
//   S2  bounded: 64 KiB of one file, 1 MiB for the whole snapshot, 50 events of 300 characters
//   S3  never a secret: a list naming a secrets or credentials directory (or a file that is not .json) is refused whole; a wildcard that
//       reaches such a directory reads nothing there; the committed list names none
//   S4  only on the drill guest: an entry refused before the guest is known reads nothing
//   S5  the list travels in the kit, beside the entry
//   T1  the phases before the host stage are timed by name into stage-timings.json (assets, prereq, unpack, check)
// The entry's real functions, dot-sourced (definitions only) in Windows PowerShell 5.1, on directories under TEMP.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as kit from '../drill/make-drill-kit.mjs';

const windows = process.platform === 'win32';
const opts = { skip: !windows, timeout: 240_000 };
const entryScript = fileURLToPath(new URL('../drill/first-install-entry.ps1', import.meta.url));
const listFile = fileURLToPath(new URL('../drill/guest-failure-files.json', import.meta.url));
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-r9-entry-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const q = s => `'${String(s).replace(/'/g, "''")}'`;

function ps(expr) {
  const command = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $ProgressPreference='SilentlyContinue'; . ${q(entryScript)}; ConvertTo-Json -Depth 8 -Compress -InputObject $(${expr})`;
  const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 200_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1));
}
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

// A guest as a failed first install leaves it: the CI root, the bootstrap's work directory, the kit (with the committed list) and the
// entry's output directory.
const HALT = '{"code":"ROLE_PROBE_CLEANUP_OR_FACT_UNCONFIRMED","facts":{"intentSeq":3,"failureCode":null,"engineError":"SOURCE_V2_REQUIRED","ok":null,"proof":null,"outcomeStatus":null,"outcomeReason":null,"roleProbeFact":false},"at":"2026-11-21T08:52:41.100Z","clearedOnlyBy":"owner-rearm"}\n';
function guest(name, { list = fs.readFileSync(listFile, 'utf8'), extra = () => {} } = {}) {
  const root = path.join(tmp, name), ci = path.join(root, 'ci'), work = path.join(root, 'bootstrap'), kitDir = path.join(root, 'kit'), out = path.join(root, 'out');
  for (const d of [ci, work, kitDir, out]) fs.mkdirSync(d, { recursive: true });
  write(path.join(ci, 'resident', 'state', 'HALT.json'), HALT);
  write(path.join(ci, 'resident', 'state', 'status.json'), '{"executor":{"state":"HALTED"}}');
  write(path.join(ci, 'resident', 'secrets', 'ci-admission.token'), 'NEVER-READ-TOKEN');
  write(path.join(ci, 'reinstall-progress-' + 'a'.repeat(32), '001-output.json'), '{"index":1,"step":"output"}');
  write(path.join(ci, 'reinstall-progress-' + 'a'.repeat(32), '002-verify.json'), '{"index":2,"step":"verify"}');
  write(path.join(work, 'prepare', 'launch-20261121T084432Z', 'progress', '001-output.json'), '{"index":1,"step":"output","at":"2026-11-21T08:44:33Z"}');
  write(path.join(work, 'prepare', 'launch-20261121T084432Z', 'verify.stdout.json'), '{"status":"RESIDENT_VERIFICATION_FAILED","checks":{"not-halted":{"ok":false}}}');
  write(path.join(kitDir, 'guest-failure-files.json'), list);
  extra({ ci, work, kitDir, out });
  return { ci, work, kitDir, out };
}
// The entry's own Get-FirstInstallEntryResult with the guest check, the release check and the first install stood in: the first install
// makes its work directory known (as the real one does) and stops.
const stoppedEntry = (g, { guestCheck = '', stop = "throw 'LAUNCHER_STOPPED:R4_WINDOWS_REINSTALLED_VERIFY_NOT_PASSED_RESIDENT_STOPPED'" } = {}) => `$Work = ${q(g.out)}; $Kit = ${q(g.kitDir)}
  $script:EntryFailureRoots = @{ ci = ${q(g.ci)}; work = $null }
  $script:eventAsk = $null
  $script:EntryFailureEventReader = { param($Since, $Max) $script:eventAsk = @($Since.ToString('o'), $Max)
    1..60 | ForEach-Object { [pscustomobject]@{ TimeCreated = [datetime]'2026-11-21T08:52:35Z'; Id = 7000 + $_; LevelDisplayName = 'Error'; Message = ("service CluedCIResident line $_ " + ('x' * 500)) } } }
  ${guestCheck || 'function Assert-FirstInstallGuest { }'}
  function Assert-FirstInstallRelease { }
  function Invoke-FirstInstallAccepted { $script:EntryFailureRoots.work = ${q(g.work)}; ${stop} }
  $r = Get-FirstInstallEntryResult
  [ordered]@{ result = $r; eventAsk = $script:eventAsk }`;
const snapshotOf = g => JSON.parse(fs.readFileSync(path.join(g.out, 'resident-failure-snapshot.json'), 'utf8'));

test('S1: an entry that ends STOPPED leaves the failure snapshot: HALT.json word for word, the progress records, verify, the SCM events', opts, () => {
  const g = guest('s1');
  const got = ps(stoppedEntry(g));
  assert.deepEqual([got.result.status, got.result.stopCode], ['FIRST_INSTALL_STOPPED', 'LAUNCHER_STOPPED:R4_WINDOWS_REINSTALLED_VERIFY_NOT_PASSED_RESIDENT_STOPPED']);
  const file = path.join(g.out, 'resident-failure-snapshot.json');
  assert.ok(fs.existsSync(file), 'no snapshot in the entry\'s output directory');
  const s = snapshotOf(g);
  assert.equal(s.contract, 'clued.drill.resident-failure-snapshot/1');
  assert.deepEqual(s.entry, { status: 'FIRST_INSTALL_STOPPED', stopCode: 'LAUNCHER_STOPPED:R4_WINDOWS_REINSTALLED_VERIFY_NOT_PASSED_RESIDENT_STOPPED' });
  assert.deepEqual(s.list, { state: 'read', code: null });
  const byLeaf = leaf => s.files.filter(f => f.path && f.path.endsWith(leaf));
  const halt = byLeaf('resident\\state\\HALT.json');
  assert.equal(halt.length, 1);
  assert.equal(halt[0].text, HALT, 'HALT.json is in the snapshot word for word');
  assert.deepEqual([halt[0].state, halt[0].bytes, halt[0].truncated], ['read', Buffer.byteLength(HALT), false]);
  assert.equal(JSON.parse(halt[0].text).facts.engineError, 'SOURCE_V2_REQUIRED');
  // a listed file that is not there is named absent, never left out
  assert.deepEqual(s.files.filter(f => f.pattern === 'resident\\state\\PAUSED.json').map(f => f.state), ['absent']);
  assert.deepEqual(s.files.filter(f => f.pattern === 'reinstall-progress-*\\*.json').map(f => path.win32.basename(f.path)), ['001-output.json', '002-verify.json']);
  assert.deepEqual(s.files.filter(f => f.root === 'work').map(f => [f.pattern, f.state, path.win32.basename(f.path)]),
    [['prepare\\launch-*\\progress\\*.json', 'read', '001-output.json'], ['prepare\\launch-*\\verify.stdout.json', 'read', 'verify.stdout.json']]);
  assert.match(byLeaf('verify.stdout.json')[0].text, /"not-halted":\{"ok":false\}/);
  // the events since the entry started: asked for once, with the entry's own start and the limit
  assert.equal(got.eventAsk[1], 50);
  assert.equal(got.eventAsk[0], s.since);
  assert.equal(s.events.state, 'read');
  assert.deepEqual(s.events.items[0], { at: s.events.items[0].at, id: 7001, level: 'Error', message: s.events.items[0].message });
  // nothing of the secrets directory, by any route
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /NEVER-READ-TOKEN|ci-admission/);
});

test('S1: a first install that ends done leaves no snapshot', opts, () => {
  const g = guest('s1-done');
  const got = ps(stoppedEntry(g, { stop: "[ordered]@{ status = 'FIRST_INSTALL_DONE'; stopCode = $null; tree = 'C:\\tree'; node = 'C:\\node.exe' }" }));
  assert.equal(got.result.status, 'FIRST_INSTALL_DONE');
  assert.equal(fs.existsSync(path.join(g.out, 'resident-failure-snapshot.json')), false);
});

test('S2: 64 KiB of one file, 1 MiB for the whole snapshot, 50 events of 300 characters', opts, () => {
  const big = 'A'.repeat(100_000);
  const g = guest('s2', { extra: ({ ci }) => {
    write(path.join(ci, 'resident', 'state', 'status.json'), big);
    // sixty progress records of 60 KiB each: far more than the whole snapshot may hold
    for (let i = 1; i <= 60; i++) write(path.join(ci, 'reinstall-progress-' + 'b'.repeat(32), String(i).padStart(3, '0') + '-step.json'), 'B'.repeat(60_000));
  } });
  ps(stoppedEntry(g));
  const file = path.join(g.out, 'resident-failure-snapshot.json'), s = snapshotOf(g);
  assert.deepEqual(s.limits, { fileBytes: 65536, totalBytes: 1048576, events: 50, eventChars: 300 });
  const status = s.files.find(f => f.pattern === 'resident\\state\\status.json');
  assert.deepEqual([status.state, status.bytes, status.truncated, status.text.length], ['read', 100_000, true, 65536]);
  assert.ok(s.files.every(f => f.text == null || Buffer.byteLength(f.text) <= 65536));
  assert.ok(fs.statSync(file).size <= 1048576, `the snapshot is ${fs.statSync(file).size} bytes`);
  const over = s.files.filter(f => f.state === 'over-total-limit');
  assert.ok(over.length > 0 && over.every(f => f.text === null && f.bytes === 60_000 && f.path), 'what did not fit is named with its size, without its text');
  assert.ok(s.files.filter(f => f.state === 'read' && f.root === 'ci' && f.pattern.startsWith('reinstall-progress')).length >= 10);
  // the first listed file is never the one squeezed out
  assert.equal(s.files.find(f => f.pattern === 'resident\\state\\HALT.json').text, HALT);
  assert.equal(s.events.items.length, 50);
  assert.ok(s.events.items.every(e => e.message.length === 300));
});

test('S3: a list that names a secrets or credentials directory, leaves its root or names another kind of file is refused whole', opts, () => {
  const list = files => JSON.stringify({ contract: 'clued.drill.guest-failure-files/1', files });
  const cases = {
    'resident\\secrets\\ci-admission.connection.json': 'secret-path', 'secrets\\x.json': 'secret-path', 'resident\\Credentials\\public.json': 'secret-path',
    'resident\\SECRETS\\*.json': 'secret-path', 'credentials\\*.json': 'secret-path',
    '..\\x.json': 'path', 'resident\\..\\secrets\\x.json': 'path', 'C:\\ProgramData\\x.json': 'path', 'resident/state/HALT.json': 'path', '\\\\host\\share\\x.json': 'path',
    'resident\\state\\app-private-key.pem': 'not-json', 'resident\\state\\*': 'not-json', 'resident\\state\\ci-admission.token': 'not-json',
  };
  const dir = path.join(tmp, 's3-lists'); fs.mkdirSync(dir, { recursive: true });
  const names = Object.keys(cases).map((p, i) => { const f = path.join(dir, `list-${i}.json`); fs.writeFileSync(f, list([{ root: 'ci', path: 'resident\\state\\HALT.json' }, { root: 'ci', path: p }])); return f; });
  const other = { root: path.join(dir, 'root.json'), contract: path.join(dir, 'contract.json'), empty: path.join(dir, 'empty.json'), torn: path.join(dir, 'torn.json') };
  fs.writeFileSync(other.root, list([{ root: 'C:\\', path: 'x.json' }]));
  fs.writeFileSync(other.contract, JSON.stringify({ contract: 'clued.drill.guest-probe-files/1', files: [{ root: 'ci', path: 'x.json' }] }));
  fs.writeFileSync(other.empty, list([]));
  fs.writeFileSync(other.torn, '{"contract":');
  const codes = ps(`@(${[...names, other.root, other.contract, other.empty, other.torn].map(f => `$(try { [void](Read-EntryFailureFiles ${q(f)}); 'accepted' } catch { [string]$_.Exception.Message })`).join(', ')})`);
  assert.deepEqual(codes, [...Object.values(cases), 'root', 'contract', 'count', 'unreadable'].map(c => 'DRILL_FAILURE_FILES_REFUSED:' + c));

  // refused whole: the snapshot says so and holds no file, not even the harmless one beside the refused path
  const g = guest('s3-refused', { list: list([{ root: 'ci', path: 'resident\\state\\HALT.json' }, { root: 'ci', path: 'resident\\secrets\\ci-admission.token.json' }]),
    extra: ({ ci }) => write(path.join(ci, 'resident', 'secrets', 'ci-admission.token.json'), '{"token":"NEVER-READ-TOKEN"}') });
  ps(stoppedEntry(g));
  const s = snapshotOf(g);
  assert.deepEqual(s.list, { state: 'refused', code: 'DRILL_FAILURE_FILES_REFUSED:secret-path' });
  assert.deepEqual(s.files, []);
  assert.doesNotMatch(fs.readFileSync(path.join(g.out, 'resident-failure-snapshot.json'), 'utf8'), /NEVER-READ-TOKEN/);
});

test('S3: a wildcard that reaches a secrets or credentials directory reads nothing there', opts, () => {
  const root = path.join(tmp, 's3-wild');
  for (const d of ['state', 'secrets', 'Credentials', 'credentials-old']) write(path.join(root, d, 'a.json'), `{"from":"${d}"}`);
  write(path.join(root, 'state', 'b.token'), 'x');
  const found = ps(`@(Resolve-EntryFailurePath ${q(root)} '*\\*.json')`);
  assert.deepEqual(found.map(f => path.relative(root, f)), ['credentials-old\\a.json', 'state\\a.json']);
  assert.deepEqual(ps(`@(Resolve-EntryFailurePath ${q(root)} 'state\\*')`), [path.join(root, 'state', 'a.json')], 'only .json is ever read');
  assert.deepEqual(ps(`@(Resolve-EntryFailurePath ${q(path.join(root, 'none'))} '*\\*.json')`), []);
});

test('S3: the committed list is accepted by the entry and names no secret, credential, token or key', opts, () => {
  const doc = JSON.parse(fs.readFileSync(listFile, 'utf8'));
  assert.equal(doc.contract, 'clued.drill.guest-failure-files/1');
  assert.deepEqual(Object.keys(doc).sort(), ['contract', 'files']);
  for (const f of doc.files) {
    assert.deepEqual(Object.keys(f).sort(), ['path', 'root']);
    assert.ok(['ci', 'work'].includes(f.root));
    assert.doesNotMatch(f.path, /secret|credential|token|\.pem|key|password|carry/i, f.path);
    assert.match(f.path, /\.json$/);
  }
  assert.doesNotMatch(fs.readFileSync(listFile, 'utf8'), /secrets|credentials/i);
  // what the report names: the resident's three state records, the launcher's progress records, verify's full answer
  assert.deepEqual(doc.files.map(f => `${f.root}:${f.path}`), ['ci:resident\\state\\HALT.json', 'ci:resident\\state\\PAUSED.json', 'ci:resident\\state\\status.json',
    'ci:reinstall-progress-*\\*.json', 'work:prepare\\launch-*\\progress\\*.json', 'work:prepare\\launch-*\\verify.stdout.json']);
  assert.deepEqual(ps(`@((Read-EntryFailureFiles ${q(listFile)}) | ForEach-Object { $_.root + ':' + $_.path })`), doc.files.map(f => `${f.root}:${f.path}`));
});

test('S4: an entry refused before the drill guest is known reads nothing and writes no snapshot', opts, () => {
  const g = guest('s4');
  // the real Assert-FirstInstallGuest: this machine is not CLUED-DRILL
  const got = ps(stoppedEntry(g, { guestCheck: '# the real guest check' }));
  assert.deepEqual([got.result.status, got.result.stopCode], ['FIRST_INSTALL_STOPPED', 'DRILL_ENTRY_NOT_THE_ELEVATED_GUEST']);
  assert.equal(fs.existsSync(path.join(g.out, 'resident-failure-snapshot.json')), false);
  assert.equal(got.eventAsk, null);
});

test('S5: the list travels in the kit beside the entry, and the entry reads it from the kit directory', opts, () => {
  assert.deepEqual(kit.KIT_DRILL_FILES, ['first-install-entry.ps1', 'guest-failure-files.json']);
  const text = fs.readFileSync(entryScript, 'utf8');
  assert.match(text, /Write-EntryFailureSnapshot \$output \(Join-Path \$kitDirectory 'guest-failure-files\.json'\)/);
});

test('T1: the phases before the host stage are timed by name into stage-timings.json', opts, () => {
  const out = path.join(tmp, 't1'); fs.mkdirSync(out, { recursive: true });
  const got = ps(`$m = New-EntryMeasurements; $c = New-EntryPhaseClock
    Enter-EntryPhase $m $c 'assets'; Start-Sleep -Milliseconds 30
    Enter-EntryPhase $m $c 'prereq'; Start-Sleep -Milliseconds 30
    Enter-EntryPhase $m $c 'unpack'; Start-Sleep -Milliseconds 30
    Enter-EntryPhase $m $c 'check'; Start-Sleep -Milliseconds 30
    Enter-EntryPhase $m $c ''; Start-Sleep -Milliseconds 200
    $once = $m.unpack
    Enter-EntryPhase $m $c 'unpack'; Start-Sleep -Milliseconds 30
    Enter-EntryPhase $m $c ''
    Write-EntryStageTimings ${q(out)} $m
    [ordered]@{ once = $once; twice = $m.unpack }`);
  const timings = JSON.parse(fs.readFileSync(path.join(out, 'stage-timings.json'), 'utf8'));
  assert.deepEqual(Object.keys(timings), ['assets', 'prereq', 'unpack', 'check', 'host', 'prepare', 'launcher']);
  for (const k of ['assets', 'prereq', 'unpack', 'check']) assert.ok(typeof timings[k] === 'number' && timings[k] > 0, `${k}: ${timings[k]}`);
  assert.deepEqual([timings.host, timings.prepare, timings.launcher], [null, null, null], 'a stage not reached stays null');
  assert.ok(got.twice > got.once, 'the two extractions add up');
  assert.ok(timings.unpack < 0.2, 'the time between two phases belongs to neither');

  // the entry itself: one measurements object, the phases in this order, each around the work it names, and the open one closed on any end
  const text = fs.readFileSync(entryScript, 'utf8');
  const body = text.slice(text.indexOf('function Invoke-FirstInstallAccepted('), text.indexOf('function Get-FirstInstallEntryResult'));
  assert.match(body, /\$measurements = New-EntryMeasurements; \$phase = New-EntryPhaseClock/);
  const marks = [...body.matchAll(/Enter-EntryPhase \$measurements \$phase '([a-z]*)'/g)].map(m => m[1]);
  assert.deepEqual(marks, ['assets', 'prereq', 'unpack', 'check', '', 'unpack', '', '']);
  const at = s => { const i = body.indexOf(s); assert.ok(i >= 0, s); return i; };
  const order = ["Enter-EntryPhase $measurements $phase 'assets'", 'Test-AssetSet $present', "Enter-EntryPhase $measurements $phase 'prereq'", 'Expand-Cached $file',
    "Enter-EntryPhase $measurements $phase 'unpack'", "& $TarExe -x -f $archive", "Enter-EntryPhase $measurements $phase 'check'", "'first-install-check'",
    "Enter-EntryPhase $measurements $phase ''", '& $TarExe -x -f $hostArchive', '$watch = [Diagnostics.Stopwatch]::StartNew()', 'Write-EntryStageTimings $Output $measurements'].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(body.lastIndexOf("Enter-EntryPhase $measurements $phase ''") > body.lastIndexOf('} finally {'), 'the open phase is closed in the finally block');
});

// Planning ruling FABLE-r9-lineB-points R3: the two launch-directory entries of the list are inferred, never seen in a guest. An entry
// that is absent says where the walk stopped and what is there instead, so one run is enough to put the list right.
const absentOf = (name, arrange) => {
  const g = guest(name, { extra: ({ work, ci }) => { fs.rmSync(path.join(work, 'prepare'), { recursive: true, force: true }); arrange({ work, ci }); } });
  ps(stoppedEntry(g));
  return snapshotOf(g);
};

test('R3: an absent entry names the segment the walk stopped at and what the directory holds instead, never a secrets directory', opts, () => {
  const s = absentOf('r3-siblings', ({ work }) => {
    write(path.join(work, 'prepare', 'run-20261121', 'progress', '001-output.json'), '{}');
    write(path.join(work, 'prepare', 'install-plan.json'), '{}');
    write(path.join(work, 'prepare', 'secrets', 'x.json'), '{"token":"NEVER-READ-TOKEN"}');
    write(path.join(work, 'prepare', 'Credentials', 'y.json'), '{}');
  });
  const progress = s.files.filter(f => f.pattern === 'prepare\\launch-*\\progress\\*.json');
  assert.equal(progress.length, 1);
  assert.deepEqual(progress[0], { root: 'work', pattern: 'prepare\\launch-*\\progress\\*.json', state: 'absent', stoppedAt: 'launch-*', siblings: ['install-plan.json', 'run-20261121'] });
  // a file that is simply not there: the directory is right, and its other files say so
  const paused = s.files.find(f => f.pattern === 'resident\\state\\PAUSED.json');
  assert.deepEqual([paused.state, paused.stoppedAt, paused.siblings], ['absent', 'PAUSED.json', ['HALT.json', 'status.json']]);
  assert.doesNotMatch(JSON.stringify(s), /NEVER-READ-TOKEN/);
});

test('R3: at most 50 names of 120 characters; a root that is not there has none', opts, () => {
  const long = 'n'.repeat(150);
  const s = absentOf('r3-many', ({ work }) => {
    for (let i = 0; i < 60; i++) fs.mkdirSync(path.join(work, 'prepare', 'd-' + String(i).padStart(2, '0')), { recursive: true });
    fs.mkdirSync(path.join(work, 'prepare', 'a-' + long), { recursive: true });
  });
  const progress = s.files.find(f => f.pattern === 'prepare\\launch-*\\progress\\*.json');
  assert.equal(progress.siblings.length, 50);
  assert.equal(progress.siblings[0], ('a-' + long).slice(0, 120));
  assert.deepEqual(progress.siblings.slice(1, 3), ['d-00', 'd-01']);
  assert.ok(fs.statSync(path.join(tmp, 'r3-many', 'out', 'resident-failure-snapshot.json')).size <= 1048576);

  const none = absentOf('r3-no-root', ({ work }) => fs.rmSync(work, { recursive: true, force: true }));
  const gone = none.files.find(f => f.pattern === 'prepare\\launch-*\\verify.stdout.json');
  assert.deepEqual([gone.state, gone.stoppedAt, gone.siblings], ['absent', 'prepare', []]);
});

