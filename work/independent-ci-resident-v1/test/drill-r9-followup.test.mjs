// r9 follow-up (task 0e418483): drill-vm.ps1's side, the evidence layer only. FABLE-drill-r9-followup sections 1.3 B (5), 2.3 (topProcesses), 3.2 (2).
//   F1  the entry's failure snapshot comes home with the stage files, word for word, and A1's detail names what halted the resident
//   F2  a step line's own "at" is kept
//   F5  an abort for memory records the ten largest processes
// F3 and F4 (the suite slot, a baseline's limit) are not on this branch: main has no `local-suite-slots.mjs hold` yet.
// The script's real functions, dot-sourced (definitions only) in Windows PowerShell 5.1; no VM, no intake tool and no production directory is touched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const windows = process.platform === 'win32';
const opts = { skip: !windows, timeout: 240_000 };
const script = fileURLToPath(new URL('../drill/drill-vm.ps1', import.meta.url));
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-r9-followup-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const q = s => `'${String(s).replace(/'/g, "''")}'`;
const ownMutexes = `$script:Drill.HostMutex = ${q(`Local\\CluedDrillTest-${path.basename(tmp)}-host`)}; $script:Drill.BootMutex = ${q(`Local\\CluedDrillTest-${path.basename(tmp)}-boot`)}`;

function ps(expr, exe = powershell) {
  const command = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $ProgressPreference='SilentlyContinue'; . ${q(script)}; ${ownMutexes}; ConvertTo-Json -Depth 12 -Compress -InputObject $(${expr})`;
  const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 200_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1));
}

const HALT = '{"code":"ROLE_PROBE_CLEANUP_OR_FACT_UNCONFIRMED","facts":{"intentSeq":3,"failureCode":"ROLE_PROBE_OUTCOME_FAILED","engineError":"SOURCE_V2_REQUIRED","ok":null,"proof":null,"outcomeStatus":null,"outcomeReason":null,"roleProbeFact":false},"at":"2026-11-21T08:52:41.100Z","clearedOnlyBy":"owner-rearm"}\n';
const snapshotText = JSON.stringify({ contract: 'clued.drill.resident-failure-snapshot/1', at: '2026-11-21T08:53:00.0000000+00:00', since: '2026-11-21T08:40:00.0000000+00:00',
  entry: { status: 'FIRST_INSTALL_STOPPED', stopCode: 'LAUNCHER_STOPPED:X' }, list: { state: 'read', code: null },
  files: [{ root: 'ci', pattern: 'resident\\state\\HALT.json', path: 'C:\\ProgramData\\CluedIndependentCI\\resident\\state\\HALT.json', state: 'read', bytes: Buffer.byteLength(HALT), truncated: false, text: HALT },
    { root: 'ci', pattern: 'resident\\state\\PAUSED.json', state: 'absent' }], events: { state: 'read', error: null, items: [] } }) + '\n';

test('F1: the failure snapshot comes home with the stage files, word for word, and A1 names what halted the resident', opts, () => {
  const dir = path.join(tmp, 'f1'); fs.mkdirSync(dir);
  const textFile = path.join(tmp, 'f1-snapshot.txt'); fs.writeFileSync(textFile, snapshotText);
  const r = ps(`$script:asked = $null
    function Invoke-DrillGuest { param($Credential, $Script, $ArgumentList, $TimeoutMinutes, $Step) $script:asked = @($ArgumentList[1])
      @{ 'resident-failure-snapshot.json' = @{ present = $true; text = [IO.File]::ReadAllText(${q(textFile)}); error = $null }; 'host.stdout.log' = @{ present = $false; text = $null; error = $null } } }
    $saved = Save-DrillStageEvidence ${q(dir)} $null
    $entry = @{ parsed = $true; exitCode = 1; status = 'FIRST_INSTALL_STOPPED'; stopCode = 'LAUNCHER_STOPPED:X' }
    [ordered]@{ asked = $script:asked; record = $saved.record.files['resident-failure-snapshot.json']
      a1 = (Get-DrillA1Item $entry $null (Read-DrillFailureSnapshot ${q(dir)})); a1Without = (Get-DrillA1Item $entry $null $null)
      a1NoHalt = (Get-DrillA1Item $entry $null ([pscustomobject]@{ files = @([pscustomobject]@{ pattern = 'resident\\state\\HALT.json'; state = 'absent' }) })) }`);
  assert.ok(r.asked.includes('resident-failure-snapshot.json'), 'the snapshot is one of the stage files asked of the guest');
  assert.equal(r.record.state, 'saved');
  assert.equal(fs.readFileSync(path.join(dir, 'resident-failure-snapshot.json'), 'utf8'), snapshotText, 'kept as the guest wrote it');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'stage-files.json'), 'utf8')).files['resident-failure-snapshot.json'].state, 'saved');
  assert.equal(r.a1.pass, false);
  assert.match(r.a1.detail, / halt=ROLE_PROBE_CLEANUP_OR_FACT_UNCONFIRMED failureCode=ROLE_PROBE_OUTCOME_FAILED engineError=SOURCE_V2_REQUIRED$/);
  assert.doesNotMatch(r.a1Without.detail, /halt=/);
  assert.match(r.a1NoHalt.detail, / halt=none$/, 'a snapshot without HALT.json says so');

  // a snapshot cut short is named so, never saved as evidence
  const cut = path.join(tmp, 'f1-cut'); fs.mkdirSync(cut);
  const c = ps(`function Invoke-DrillGuest { @{ 'resident-failure-snapshot.json' = @{ present = $true; text = '{"contract":'; error = $null } } }
    (Save-DrillStageEvidence ${q(cut)} $null).record.files['resident-failure-snapshot.json']`);
  assert.equal(c.state, 'unreadable-json');
  assert.equal(fs.existsSync(path.join(cut, 'resident-failure-snapshot.json')), false);
});

// The drill itself runs under pwsh 7 (drill-vm.ps1's header), whose ConvertFrom-Json turns a time string into a DateTime: F2 is run
// under both hosts (review of 86297d72: under pwsh the "at" came out null, and only Windows PowerShell 5.1 was tested).
const pwsh = (() => { const r = windows ? spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major']) : { status: 1 }; return r.status === 0 ? 'pwsh' : null; })();
for (const [host5or7, exe] of [['Windows PowerShell', powershell], ['pwsh', pwsh]])
test(`F2 (${host5or7}): a step line that carries its own "at" keeps it; one without has null`, { ...opts, skip: opts.skip || (exe === null && 'pwsh is not on this machine') }, () => {
  const host = ['{"name":"wsl-install","result":"ok","at":"2026-11-21T08:40:12.000Z"}', '{"name":"docker","result":"ok","at":17}', '{"status":"HOST_READY"}'].join('\n');
  const launcher = ['{"step":"verify","result":"failed","rejectCode":"RESIDENT_VERIFICATION_FAILED"}', '{"status":"X"}'].join('\n');
  const r = ps(`(ConvertFrom-DrillFirstInstallSteps @{ host = ${q(host)}; launcher = ${q(launcher)} } $null).steps`, exe);
  assert.deepEqual(r.map(s => [s.stage, s.name, s.at]), [['host', 'wsl-install', '2026-11-21T08:40:12.000Z'], ['host', 'docker', null], ['launcher', 'verify', null]]);
  assert.ok(r.every(s => Object.keys(s).join() === 'stage,name,result,rejectCode,detail,at'));
});

test('F5: an abort for memory records the ten largest processes; any other abort, or a failed read, records none', opts, () => {
  const run = (name, code, extra = '') => {
    const dir = path.join(tmp, name); fs.mkdirSync(dir);
    ps(`function Get-DrillHostSafety { @{ ok = $false; code = ${q(code)}; freeGB = 3.1 } }
      function Stop-DrillOwnedVm { param([switch]$RestoreCheckpoint) $true }
      ${extra}
      $state = [hashtable]::Synchronized(@{ stop = $false; ready = $false; armed = $true; failure = $null; cleanup = $null; executorStates = [ordered]@{} })
      Invoke-DrillHostGuardLoop $state ${q(dir)} -RestoreCheckpoint
      $state.failure.code`);
    return JSON.parse(fs.readFileSync(path.join(dir, 'host-guard.json'), 'utf8'));
  };
  const short = run('f5-short', 'DRILL_HOST_MEMORY_SHORT');
  assert.deepEqual([short.code, short.stopped, short.restoredToCheckpoint, short.cleanupDone], ['DRILL_HOST_MEMORY_SHORT', true, true, true]);
  assert.ok(Array.isArray(short.topProcesses) && short.topProcesses.length >= 1 && short.topProcesses.length <= 10, JSON.stringify(short.topProcesses));
  for (const p of short.topProcesses) assert.deepEqual(Object.keys(p), ['name', 'pid', 'workingSetGB', 'startedAt']);
  const whole = short.topProcesses.filter(p => typeof p.name === 'string' && p.name && Number.isInteger(p.pid) && typeof p.workingSetGB === 'number' && typeof p.startedAt === 'string' && !Number.isNaN(Date.parse(p.startedAt)));
  assert.ok(whole.length >= 1, 'at least one row has all four');
  const sizes = short.topProcesses.map(p => p.workingSetGB);
  assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a), 'largest first');

  assert.equal('topProcesses' in run('f5-duty', 'DRILL_HOST_IS_ON_DUTY'), false);
  const unread = run('f5-unread', 'DRILL_HOST_MEMORY_SHORT', "function Get-Process { throw 'no process list' }");
  assert.deepEqual([unread.code, unread.stopped, unread.restoredToCheckpoint, 'topProcesses' in unread], ['DRILL_HOST_MEMORY_SHORT', true, true, false]);
});

// Planning ruling FABLE-r9-lineB-points R2: the failure snapshot is the evidence of a first install that did not end done. Its absence
// is nothing missing only when the entry itself said FIRST_INSTALL_DONE; stopped, timed out or no result at all, it is missing evidence
// (the entry swallows a snapshot it could not write: r9 lost the resident's HALT and nothing said so).
test('R2: a first install that did not end done and brought no failure snapshot is missing evidence; one that ended done is not', opts, () => {
  const run = (name, entryOut) => {
    const dir = path.join(tmp, name); fs.mkdirSync(dir);
    return ps(`function Save-DrillProbe { }
      function Invoke-DrillGuest { param($Credential, $Script, $ArgumentList, $TimeoutMinutes, $Step)
        $r = @{}
        foreach ($n in @($ArgumentList[1])) {
          if ($n -ceq 'resident-failure-snapshot.json') { $r[$n] = @{ present = $false; text = $null; error = $null } }
          elseif ($n -ceq 'launcher-result.json') { $r[$n] = @{ present = $true; text = '{"exit":1,"terminal":null}'; error = $null } }
          elseif ($n.EndsWith('.json')) { $r[$n] = @{ present = $true; text = '{}'; error = $null } }
          else { $r[$n] = @{ present = $true; text = 'a line'; error = $null } }
        }
        $r }
      $c = Save-DrillGuestEvidence ${q(dir)} $null ${entryOut}
      [ordered]@{ ok = $c.record.ok; missing = @($c.record.missing); state = $c.record.stageFiles['resident-failure-snapshot.json'].state }`);
  };
  const out = line => `([ordered]@{ lines = @('a line', ${q(line)}); stderr = ''; exit = 1 })`;
  assert.deepEqual(run('r2-done', out('{"status":"FIRST_INSTALL_DONE","stopCode":null}')), { ok: true, missing: [], state: 'absent' });
  assert.deepEqual(run('r2-stopped', out('{"status":"FIRST_INSTALL_STOPPED","stopCode":"LAUNCHER_STOPPED:X"}')), { ok: false, missing: ['resident-failure-snapshot.json'], state: 'absent' });
  assert.deepEqual(run('r2-unparsed', out('cut off in the middle')), { ok: false, missing: ['resident-failure-snapshot.json'], state: 'absent' });
  // a first install cut off by its time limit returns nothing at all
  assert.deepEqual(run('r2-none', '$null'), { ok: false, missing: ['resident-failure-snapshot.json'], state: 'absent' });
});

