// bf57ff10 P2 (2026-11-07): the admission round trip without its duplicate costs, every check kept. One section per item:
//   A' relay-public.ps1 / formal-spool-acl.ps1: one ACL helper process per transfer (3 -> 1 Receive, 5 -> 1 Send);
//   B  mailbox.mjs: one ACL helper call per Windows record read (2 -> 1);
//   C  relay-record.mjs: the relay context keeps the policy/manifest/qualification checks, not the Source re-hash;
//   D  linux-worker.mjs: each callback's authority reload overlaps the wait and still gates the response and the signing;
//      the start and the end no longer load the same role policy twice in a row;
//   E1 issuer: changed paths || admission, mode scopes ||, mode || PR read; E2 admission || refs; E3 SHA-fixed read cache;
//   the fetch timing log.
// Offline: temp directories, in-memory fakes, a copy of the ACL helper pointed at a temp spool; no production path.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { canonical, digest } from '../src/proof.mjs';
import { batchJobsV2, makeJobV2 } from '../src/job-v2.mjs';
import { createFullAdmissionPortV2, FULL_ADMISSION_CONTRACT_V2 } from '../src/full-admission-v2.mjs';
import { createGitHubChecksPort } from '../src/github.mjs';
import { controllerPorts, immutableReadCache, immutableGitHubRead, fetchUrlPattern, observationLog } from '../src/resident-v2/entry-runtime.mjs';
import { REQUIRED_SOURCE_PATHS, relayContextOf, loadLinuxRelayContext, takeAcceptedBridgeContext } from '../worker/protected-job-bridge-v4/boundary.mjs';
import { createAclProbeMailbox, takeActualMailbox, spoolAclArgs, WINDOWS_ROOT, LINUX_ROOT } from '../worker/protected-job-bridge-v4/mailbox.mjs';
import { issueBinding } from '../worker/protected-job-bridge-v4/relay-record.mjs';
import { issuerEvaluate } from '../worker/protected-job-bridge-v4/windows-issuer.mjs';
import { makeIssue, makeResponse, encode, decode } from '../worker/protected-job-bridge-v4/protocol.mjs';
import { requiredSourcePaths, reusableRolePolicy, sameRolePolicyFacts, takeFinishedRolePolicy } from '../worker/formal-fixed-role-policy-v3/policy.mjs';
import { LINUX_NODE_V2 } from '../worker/qualification-v2.mjs';
import { IMAGE as GITLEAKS_IMAGE, SCAN_ARGS } from '../worker/formal-gitleaks-v4/required-history/prepare.mjs';
import { HEAD, BASE, admittedFacts, hex } from './resident-v2-fixtures.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const iso = ms => new Date(ms).toISOString();
const sha = b => createHash('sha256').update(b).digest('hex');
const coded = code => Object.assign(new Error(code), { code });
const BRIDGE = new URL('../worker/protected-job-bridge-v4/', import.meta.url);
const tick = () => new Promise(r => setImmediate(r));
async function tmp(t, prefix) { const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix)); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

// ================================================================================================================
// A'. formal-spool-acl.ps1 with several targets, run for real against a temp spool. The test copy differs from the
// script only in four fixed install facts: no node profile (the controller and Owner SIDs come from the test), the spool
// root, and the test user counted among the administrators (so a user-owned temp chain can pass at all). Every other
// line, the whole per-path decision code included, is the script's own.
// ================================================================================================================
const WIN = process.platform === 'win32';
const ps = (args, env = {}) => { try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { env: { ...process.env, ...env }, stdio: 'pipe', windowsHide: true }); return 0; } catch (e) { return e.status ?? -1; } };
function aclTestCopy(text) {
  const swaps = [
    ["Add-Type -Path (Join-Path $PSScriptRoot '..\\..\\src\\resident-v2\\windows\\NodeProfileV2.cs') -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')", ''],
    ["$NodeLease=[NodeProfileV2]::LoadProtectedProfile('C:\\ProgramData\\CluedIndependentCI\\resident',$ExpectedNodeProfileSha256)",
      "$NodeLease=New-Object psobject -Property @{Profile=(New-Object psobject -Property @{ControllerSid=$env:ACL_T_CONTROLLER;OwnerSid=$env:ACL_T_OWNER})};Add-Member -InputObject $NodeLease -MemberType ScriptMethod -Name Dispose -Value {}"],
    ["$spool = 'C:\\ProgramData\\CluedIndependentCI\\formal-spool'", '$spool = $env:ACL_T_SPOOL'],
    ["$admins = @('S-1-5-18',", "$admins = @($env:ACL_T_ADMIN.Split(',')) + @('S-1-5-18',"],
  ];
  for (const [from, to] of swaps) { assert.equal(text.split(from).length, 2, `one ${from.slice(0, 40)}`); text = text.replace(from, () => to); }
  return text;
}
async function aclWorld(t) {
  const dir = await tmp(t, 'clued-acl-'), spool = path.join(dir, 'formal-spool'), script = path.join(dir, 'formal-spool-acl.ps1');
  const helper = path.join(dir, 'protected-job-bridge-v4');
  await fs.mkdir(helper);
  await fs.writeFile(script, aclTestCopy(await fs.readFile(new URL('formal-spool-acl.ps1', BRIDGE), 'utf8')));
  for (const d of ['outgoing', 'incoming']) await fs.mkdir(path.join(spool, d), { recursive: true });
  for (const f of ['outgoing/response-01.json', 'outgoing/response-01.ready.json', 'outgoing/issue.json', 'outgoing/notaleaf.json', 'incoming/result.json'])
    await fs.writeFile(path.join(spool, f), '{}');
  execFileSync('icacls', [path.join(spool, 'outgoing', 'issue.json'), '/grant', '*S-1-1-0:(W)'], { stdio: 'pipe' }); // anyone may write: refused
  execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', path.join(spool, 'outgoing', 'blocked.json'), path.join(spool, 'incoming')], { stdio: 'pipe' }); // a junction: refused
  const me = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8' }).trim();
  // The temp directory's own ancestors (the user profile) carry grants the production chain does not have (the user, app
  // container capabilities): their owners and every SID with a replace right there count as administrators in the test
  // copy. Nothing inside the spool is affected: a grant there to anyone else (Everyone below) is still refused.
  const ancestorWriters = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p=$env:T_DIR;$o=@();while($p){$a=Get-Acl -LiteralPath $p;$o+=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value
foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow' -and -not ($r.PropagationFlags -band 2) -and ([int]$r.FileSystemRights -band 0xD0040)){$o+=$r.IdentityReference.Value}}
$p=[IO.Path]::GetDirectoryName($p.TrimEnd([char]92))};($o|Sort-Object -Unique) -join ','`], { encoding: 'utf8', env: { ...process.env, T_DIR: dir } }).trim().split(',').filter(Boolean);
  assert.ok(!ancestorWriters.includes('S-1-1-0'), 'Everyone writes nowhere above the spool');
  const admins = [...new Set([me, ...ancestorWriters])].join(',');
  const run = (targets, { mode = '-RelayReadOutgoing', controller = 'S-1-5-21-1-2-3-1015', owner = me } = {}) => ps(['-File', script, '-LiteralTarget', targets.join('|'),
    '-ProtectedRoot', spool, mode, '-ExpectedNodeProfileSha256', '0'.repeat(64)], { ACL_T_SPOOL: spool, ACL_T_ADMIN: admins, ACL_T_CONTROLLER: controller, ACL_T_OWNER: owner });
  const p = rel => path.join(spool, ...rel.split('/').filter(Boolean));
  return { spool, run, p, me };
}

test("A': the ACL helper checks several targets with the per-path code: one refusal refuses all, all passing pass", { skip: !WIN && 'Windows PowerShell' }, async t => {
  const w = await aclWorld(t);
  const good = ['', 'outgoing', 'incoming', 'outgoing/response-01.json', 'outgoing/response-01.ready.json'].map(w.p);
  const bad = { leaf: w.p('outgoing/notaleaf.json'), relayIncomingFile: w.p('incoming/result.json'), missing: w.p('outgoing/challenge-01.json'),
    writable: w.p('outgoing/issue.json'), junction: w.p('outgoing/blocked.json'), outside: path.dirname(w.spool), relative: 'formal-spool\\outgoing' };
  // each path alone: the reference
  const single = Object.fromEntries([...good.map(g => [g, w.run([g])]), ...Object.entries(bad).map(([k, b]) => [k, w.run([b])])]);
  for (const g of good) assert.equal(single[g], 0, `alone passes: ${g}`);
  for (const k of Object.keys(bad)) assert.equal(single[k], 2, `alone refused: ${k}`);
  // a whole transfer in one call: exactly the conjunction of the singles
  assert.equal(w.run(good.slice(0, 3)), 0, 'a Receive: spool, outgoing, incoming');
  assert.equal(w.run(good), 0, 'a Send: the three directories, the record and its ready marker');
  for (const [k, b] of Object.entries(bad)) {
    assert.equal(w.run([...good, b]), 2, `refused last: ${k}`);
    assert.equal(w.run([b, ...good]), 2, `refused first: ${k}`);
  }
  assert.equal(w.run([good[0], '', good[1]]), 2, 'an empty element');
  assert.equal(w.run(Array(9).fill(good[0])), 2, 'more than 8 targets');
  // the principal rules are unchanged: controller mode needs the controller SID; then incoming files are allowed
  assert.equal(w.run([w.p('incoming/result.json')], { mode: '-AllowControllerWrite' }), 2);
  assert.equal(w.run([w.p('incoming/result.json'), good[0]], { mode: '-AllowControllerWrite', controller: w.me }), 0);
  assert.equal(w.run(good, { owner: 'S-1-5-21-1-2-3-1001' }), 2, 'relay mode needs the Owner SID');
});

// relay-public.ps1: its Check-Spool, run for real against a stand-in helper that records each start.
test("A': relay-public.ps1 starts ONE helper per transfer (was 3 for a Receive, 5 for a Send) and refuses on its refusal", { skip: !WIN && 'Windows PowerShell' }, async t => {
  const dir = await tmp(t, 'clued-relay-acl-'), log = path.join(dir, 'starts.log');
  await fs.writeFile(path.join(dir, 'formal-spool-acl.ps1'), "param([string]$LiteralTarget,[string]$ProtectedRoot,[switch]$RelayReadOutgoing,[string]$ExpectedNodeProfileSha256)\n"
    + "Add-Content -LiteralPath $env:ACL_FAKE_LOG -Value ($LiteralTarget+'#'+$ProtectedRoot+'#'+$RelayReadOutgoing.IsPresent+'#'+$ExpectedNodeProfileSha256)\nexit [int]$env:ACL_FAKE_EXIT\n");
  const script = fileURLToPath(new URL('relay-public.ps1', BRIDGE));
  const cases = [['C:\\s', 'C:\\s\\outgoing', 'C:\\s\\incoming'], ['C:\\s', 'C:\\s\\outgoing', 'C:\\s\\incoming', 'C:\\s\\outgoing\\response-01.json', 'C:\\s\\outgoing\\response-01.ready.json'],
    ['C:\\s', 'C:\\s\\a|b']];
  const body = `
$ErrorActionPreference='Stop'; $tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:RELAY_PS1,[ref]$tokens,[ref]$errors); if($errors.Count){throw 'PARSE'}
$f=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Check-Spool'},$true)
. ([scriptblock]::Create($f.Extent.Text))
$FixedSource=$env:FAKE_DIR;$Spool='C:\\s';$ExpectedNodeProfileSha256='${'e'.repeat(64)}'
$out=@(); foreach($c in (ConvertFrom-Json $env:CASES)){ try{ Check-Spool ([string[]]$c); $out+='ok' }catch{ $out+=$_.FullyQualifiedErrorId.Split(',')[0] } }
ConvertTo-Json -Compress -InputObject $out`;
  const runAll = exit => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', body], { encoding: 'utf8',
    env: { ...process.env, RELAY_PS1: script, FAKE_DIR: dir, CASES: JSON.stringify(cases), ACL_FAKE_LOG: log, ACL_FAKE_EXIT: String(exit) } }));
  assert.deepEqual(runAll(0), ['ok', 'ok', 'FORMAL_SPOOL_ACL_REFUSED']);
  const starts = (await fs.readFile(log, 'utf8')).trim().split(/\r?\n/);
  assert.deepEqual(starts, [`${cases[0].join('|')}#C:\\s#True#${'e'.repeat(64)}`, `${cases[1].join('|')}#C:\\s#True#${'e'.repeat(64)}`], 'one start per transfer; a path with | starts none');
  await fs.rm(log);
  assert.deepEqual(runAll(2), ['FORMAL_SPOOL_ACL_REFUSED', 'FORMAL_SPOOL_ACL_REFUSED', 'FORMAL_SPOOL_ACL_REFUSED']);
  // the transfer body: one Check-Spool, after the three parent locks and before the first record byte is read, over the
  // three directories always and the record and its ready marker for a Send
  const text = await fs.readFile(script, 'utf8'), main = text.slice(text.indexOf('\ntry{'));
  assert.equal(main.match(/Check-Spool /g).length, 1);
  const at = s => { const i = main.indexOf(s); assert.ok(i > 0, s); return i; };
  assert.ok(at("Hold-Parents (Join-Path $Spool 'incoming')") < at('Check-Spool $aclTargets') && at('Check-Spool $aclTargets') < at('$raw=Read-Public $file $Max'));
  assert.ok(main.includes("$aclTargets=@($Spool,(Join-Path $Spool 'outgoing'),(Join-Path $Spool 'incoming'))"));
  assert.match(main, /if\(\$send\)\{\$file=Join-Path \(Join-Path \$Spool 'outgoing'\) \(\$name\+'\.json'\);\$ready=Join-Path \(Join-Path \$Spool 'outgoing'\) \(\$name\+'\.ready\.json'\);\$aclTargets\+=@\(\$file,\$ready\)\}/);
});

// ================================================================================================================
// B. mailbox.mjs: a Windows record read checks its ready marker and data file with one helper call.
// ================================================================================================================
async function probeWorld(t, refuse = () => false) {
  const root = await tmp(t, 'clued-mbx-'), calls = [];
  for (const d of ['incoming', 'outgoing']) await fs.mkdir(path.join(root, d));
  const acl = async args => { const targets = args[args.indexOf('-LiteralTarget') + 1].split('|'); calls.push(targets.map(f => path.relative(root, f) || '.'));
    if (refuse(targets)) throw Object.assign(new Error('Command failed'), { code: 2 }); };
  const box = await createAclProbeMailbox(root, acl);
  const put = async (name, bytes, marker = canonical({ bytes: bytes.length, contract: 'clued.independent-ci.complete-public-file/1', sha256: sha(bytes) })) => {
    if (bytes !== null) await fs.writeFile(path.join(root, 'incoming', `${name}.json`), bytes);
    if (marker !== null) await fs.writeFile(path.join(root, 'incoming', `${name}.ready.json`), marker); };
  calls.length = 0; // the open's own root check
  return { root, box, calls, put };
}
const R = n => path.join('incoming', `${n}.ready.json`), D = n => path.join('incoming', `${n}.json`);

test('B: a complete record costs ONE helper call (was two), over the ready marker and the data file', async t => {
  const w = await probeWorld(t), bytes = Buffer.from('{"x":1}');
  await w.put('challenge-01', bytes);
  assert.deepEqual(await w.box.read('challenge-01'), bytes);
  assert.deepEqual(w.calls, [[R('challenge-01'), D('challenge-01')]]);
  assert.throws(() => takeActualMailbox(w.box), { code: 'ACTUAL_ACCEPTED_FORMAL_MAILBOX_REQUIRED' });
  assert.deepEqual(spoolAclArgs([WINDOWS_ROOT + '\\incoming\\result.ready.json', WINDOWS_ROOT + '\\incoming\\result.json'], WINDOWS_ROOT, 'e'.repeat(64)).slice(4),
    ['-LiteralTarget', `${WINDOWS_ROOT}\\incoming\\result.ready.json|${WINDOWS_ROOT}\\incoming\\result.json`, '-ProtectedRoot', WINDOWS_ROOT, '-AllowControllerWrite', '-ExpectedNodeProfileSha256', 'e'.repeat(64)]);
  for (const bad of [[], ['a|b'], [''], Array(9).fill('a')]) assert.throws(() => spoolAclArgs(bad, WINDOWS_ROOT, 'e'.repeat(64)), { code: 'FORMAL_MAILBOX_ACL_TARGETS_REQUIRED' });
});

test('B: absence, refusals and their order are the per-file ones', async t => {
  // ready absent: ENOENT before any helper (a normal wait)
  let w = await probeWorld(t);
  await assert.rejects(w.box.read('result'), { code: 'ENOENT' }); assert.deepEqual(w.calls, []);
  // data absent: the ready marker alone is checked, then ENOENT, as before
  w = await probeWorld(t); await w.put('result', null, canonical({ bytes: 1, contract: 'clued.independent-ci.complete-public-file/1', sha256: 'a'.repeat(64) }));
  await assert.rejects(w.box.read('result'), { code: 'ENOENT' }); assert.deepEqual(w.calls, [[R('result')]]);
  // the helper refuses the ready marker: its refusal, the data file never checked alone
  w = await probeWorld(t, ts => ts.some(f => f.endsWith('result.ready.json'))); await w.put('result', Buffer.from('{}'));
  await assert.rejects(w.box.read('result'), { code: 2 }); assert.deepEqual(w.calls, [[R('result'), D('result')], [R('result')]]);
  // the helper refuses only the data file: ready read and valid, then the data file's own refusal
  w = await probeWorld(t, ts => ts.some(f => f.endsWith('result.json') && !f.endsWith('ready.json'))); await w.put('result', Buffer.from('{}'));
  await assert.rejects(w.box.read('result'), { code: 2 }); assert.deepEqual(w.calls, [[R('result'), D('result')], [R('result')], [D('result')]]);
  // the joint call refused while each file alone passes: the read still fails, with its fixed code (review MINOR 1)
  w = await probeWorld(t, ts => ts.length === 2); await w.put('result', Buffer.from('{}'));
  await assert.rejects(w.box.read('result'), { code: 'FORMAL_MAILBOX_ACL_JOINT_REFUSED' }); assert.deepEqual(w.calls, [[R('result'), D('result')], [R('result')], [D('result')]]);
  // an invalid ready marker wins over a refused data file, as when the marker was checked and read first
  w = await probeWorld(t, ts => ts.some(f => f.endsWith('result.json') && !f.endsWith('ready.json'))); await w.put('result', Buffer.from('{}'), '{"bytes":2}');
  await assert.rejects(w.box.read('result'), { code: 'FORMAL_MAILBOX_READY_REQUIRED' });
  w = await probeWorld(t); await w.put('result', Buffer.from('{}'), '{"bytes":2}');
  await assert.rejects(w.box.read('result'), { code: 'FORMAL_MAILBOX_READY_REQUIRED' }); assert.deepEqual(w.calls, [[R('result'), D('result')]]);
  // bytes that are not the ones the marker names
  w = await probeWorld(t); await w.put('result', Buffer.from('{"y":2}'), canonical({ bytes: 7, contract: 'clued.independent-ci.complete-public-file/1', sha256: 'a'.repeat(64) }));
  await assert.rejects(w.box.read('result'), { code: 'FORMAL_MAILBOX_PACKET_CHANGED' });
  // wait(): absence is waited out; a refusal is not
  w = await probeWorld(t); setTimeout(() => w.put('blocked', Buffer.from('{"b":1}')), 250);
  assert.deepEqual(await w.box.wait('blocked', { deadline: Date.now() + 5000 }), Buffer.from('{"b":1}'));
  assert.ok(w.calls.length >= 1 && w.calls.every(c => c.length === 2 || c.length === 1));
});

// ================================================================================================================
// C. The relay context keeps every role policy / Source manifest / qualification check of loadLinuxContext.
// ================================================================================================================
function relayWorld({ entryFile = fileURLToPath(new URL('linux-worker.mjs', BRIDGE)), dropPin = null, descriptorRef = null, qualifiedAt = Date.now() - 1000, expiresAt = null } = {}) {
  const refs = { runtimeIdentity: 'turing-linux', sourceAcceptanceRef: randomUUID(), hostAcceptanceRef: randomUUID() };
  const paths = [...new Set([...REQUIRED_SOURCE_PATHS, ...requiredSourcePaths('gitleaks')])].filter(p => p !== dropPin).sort();
  const controllerRelay = { contract: 'clued.independent-ci.protected-os-relay/2', mode: 'resident-companion-file-transfer', windowsRoot: WINDOWS_ROOT, linuxRoot: LINUX_ROOT,
    linuxWriterUid: 0, ownerBoundary: 'owner-wsl-administrator', sourceAcceptanceRef: descriptorRef ?? refs.sourceAcceptanceRef, hostQualificationRef: refs.hostAcceptanceRef };
  const manifestBytes = Buffer.from(canonical({ schema: 'independent-ci.sources.v2', repo: REPO, sourceSha: 'c'.repeat(40), roles: { gitleaks: {
    containerCommand: { image: GITLEAKS_IMAGE, scanner: 'gitleaks', executable: '/usr/bin/gitleaks', args: [...SCAN_ARGS], cwd: '/input' },
    hostTools: { python: { path: '/usr/bin/python3.12', sha256: hex(32) } }, controllerRelay, sourceFiles: paths.map(p => ({ path: p, sha256: hex(32) })) } } }));
  const job = batchJobsV2({ repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, testSha: HEAD, sourceManifestSha256: sha(manifestBytes), createdAt: iso(Date.now() - 1000), attempt: 1 }).gitleaks;
  const config = { schema: 'independent-ci.linux-policy.v3', role: 'gitleaks', formalEnabled: true, sourceManifestSha256: sha(manifestBytes), nodeExecutable: LINUX_NODE_V2, entryFile,
    dockerRootDirectory: '/var/lib/docker', containerUser: '65532:65532', memoryBytes: 2147483648, cpus: 2, pids: 128, executionMode: 'scanner', image: GITLEAKS_IMAGE, ...refs };
  const qualification = { payload: { schema: 'independent-ci.runtime-qualification.v2', fixture: false, image: GITLEAKS_IMAGE, sourceManifestSha256: sha(manifestBytes), ...refs,
    qualifiedAt: iso(qualifiedAt), expiresAt: expiresAt === null ? null : iso(expiresAt) } };
  return { job, loaded: { config, sourceManifestBytes: manifestBytes, qualification }, refs };
}

test('C: the relay context passes for the accepted policy and refuses whatever loadLinuxContext refused short of the Source re-hash', async () => {
  const w = relayWorld(), c = relayContextOf(w.job, w.loaded);
  assert.deepEqual([c.side, c.role, c.config.sourceManifestSha256, c.sourceAcceptanceRef, c.hostQualificationRef], ['linux-relay', 'gitleaks', w.job.sourceManifestSha256, w.refs.sourceAcceptanceRef, w.refs.hostAcceptanceRef]);
  assert.throws(() => takeAcceptedBridgeContext(c), { code: 'ACTUAL_ACCEPTED_BRIDGE_CONTEXT_REQUIRED' }, 'never an accepted bridge context: no mailbox, no signer');
  const other = relayWorld();
  assert.throws(() => relayContextOf(other.job, w.loaded), { code: 'FIXED_ROLE_SOURCE_CONTEXT_REQUIRED' }, 'another Source manifest');
  assert.throws(() => relayContextOf(w.job, { ...w.loaded, config: { ...w.loaded.config, formalEnabled: false } }), { code: 'FIXED_ROLE_SOURCE_CONTEXT_REQUIRED' });
  assert.throws(() => relayContextOf(w.job, { ...w.loaded, config: { ...w.loaded.config, nodeExecutable: '/usr/bin/node' } }), { code: 'FIXED_ROLE_POLICY_V3_REQUIRED' });
  const expired = relayWorld({ expiresAt: Date.now() - 1 });
  assert.throws(() => relayContextOf(expired.job, expired.loaded), { code: 'ACTUAL_ROLE_QUALIFICATION_REQUIRED' }, 'qualification window, at the current clock');
  const early = relayWorld({ qualifiedAt: Date.now() + 60_000 });
  assert.throws(() => relayContextOf(early.job, early.loaded), { code: 'ACTUAL_ROLE_QUALIFICATION_REQUIRED' });
  assert.throws(() => relayContextOf(w.job, { ...w.loaded, qualification: { payload: { ...w.loaded.qualification.payload, hostAcceptanceRef: randomUUID() } } }), { code: 'ACTUAL_ROLE_QUALIFICATION_REQUIRED' });
  const entry = relayWorld({ entryFile: '/opt/elsewhere/linux-worker.mjs' });
  assert.throws(() => relayContextOf(entry.job, entry.loaded), { code: 'FORMAL_LINUX_ENTRY_NOT_ACCEPTED' });
  const relay = relayWorld({ descriptorRef: randomUUID() });
  assert.throws(() => relayContextOf(relay.job, relay.loaded), { code: 'ACCEPTED_FORMAL_RELAY_MISSING' });
  const pin = relayWorld({ dropPin: 'scripts/ci/clued-work-admission.mjs' });
  assert.throws(() => relayContextOf(pin.job, pin.loaded), { code: 'BRIDGE_ACCEPTED_SOURCE_INCOMPLETE' }, 'the bridge closure pins stay complete');
  const rolePin = relayWorld({ dropPin: requiredSourcePaths('gitleaks')[0] });
  assert.throws(() => relayContextOf(rolePin.job, rolePin.loaded), { code: 'FIXED_SELECTOR_SOURCE_NOT_ACCEPTED' });
  if (process.platform !== 'linux') await assert.rejects(loadLinuxRelayContext(w.job), { code: 'FORMAL_LINUX_CONTROLLER_REQUIRED' });
});

test('C: an imported issue must name the relay context\'s role, manifest and refs; the relay never loads the full context any more', async () => {
  const w = relayWorld(), c = relayContextOf(w.job, w.loaded);
  const claim = { claimId: randomUUID(), fence: 3, epoch: 1, expiresAt: iso(Date.now() + 3600_000) };
  const issue = refs => makeIssue(w.job, admittedFacts(w.job, claim, { complete: true, paths: ['a.txt'] }, { batchClaim: claim }),
    { contract: 'clued.independent-ci.remote-heads-tags/1', repository: REPO, complete: true, observedAt: iso(Date.now()), refs: [{ name: 'refs/heads/main', objectSha: BASE }] },
    { sourceAcceptanceRef: refs.source, hostQualificationRef: refs.host, expiresAt: iso(Date.now() + 600_000) });
  assert.ok(issueBinding(decode(encode(issue({ source: w.refs.sourceAcceptanceRef, host: w.refs.hostAcceptanceRef }))), c));
  assert.throws(() => issueBinding(decode(encode(issue({ source: randomUUID(), host: w.refs.hostAcceptanceRef }))), c), { code: 'FORMAL_RELAY_ISSUER_CONTEXT_CHANGED' });
  assert.throws(() => issueBinding(decode(encode(issue({ source: w.refs.sourceAcceptanceRef, host: randomUUID() }))), c), { code: 'FORMAL_RELAY_ISSUER_CONTEXT_CHANGED' });
  assert.throws(() => issueBinding(decode(encode(issue({ source: w.refs.sourceAcceptanceRef, host: w.refs.hostAcceptanceRef }))), { ...c, role: 'trivy' }), { code: 'FORMAL_RELAY_ISSUER_CONTEXT_CHANGED' });
  const text = await fs.readFile(new URL('relay-record.mjs', BRIDGE), 'utf8');
  assert.equal(text.match(/loadLinuxRelayContext\(/g).length, 2, 'both the import and the export paths');
  assert.doesNotMatch(text.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n'), /loadLinuxContext\b/);
});

// ================================================================================================================
// D. The Linux worker: the real executeProtectedIssuedJob with in-memory stand-ins for its host-bound collaborators (as
// linux-worker-final-admission.test.mjs), here with a controllable authority reload.
// ================================================================================================================
const workerUrl = new URL('linux-worker.mjs', BRIDGE);
const stub = lines => 'data:text/javascript;base64,' + Buffer.from(lines.join('\n')).toString('base64');
const H = 'globalThis.__roundTripHarness';
const stubs = {
  './boundary.mjs': stub([`export async function loadLinuxContext(job){return ${H}.load(job);}`, `export async function loadLinuxRelayContext(job){return ${H}.relay(job);}`, 'export function takeAcceptedBridgeContext(c){return c;}']),
  './mailbox.mjs': stub([`export async function openAcceptedMailbox(){return ${H}.box;}`, 'export function takeActualMailbox(b){return b;}']),
  './signed-result.mjs': stub([`export async function signActualBridgeResult(context,issue,observation,options){${H}.signed.push(options);return {signed:true};}`]),
  '../formal-gitleaks-v4/adapter.mjs': stub([`export function createFormalGitleaksAdapter(ports){return ${H}.adapter(ports);}`]),
  '../formal-trivy-v4/adapter.mjs': stub([`export function createFormalTrivyAdapter(ports){return ${H}.adapter(ports);}`]),
  '../formal-contract-placement-v2/adapter.mjs': stub([`export function createFormalContractPlacementAdapter(ports){return ${H}.adapter(ports);}`]),
  '../formal-fixed-role-policy-v3/policy.mjs': stub([`export async function openFixedRoleSession(job,options){${H}.opened.push(options);return ${H}.session;}`, 'export function takeActualRoleSession(s){return s;}']),
  './issue-job.mjs': stub([`export async function readFixedIssueJob(){return ${H}.job;}`]),
};
// nativeScanStart: the same worker with the Source requiring a Native scan start (grant.mjs NATIVE_SCAN_START_REQUIRED).
async function loadWorker({ nativeScanStart = false } = {}) {
  let source = await fs.readFile(workerUrl, 'utf8');
  const all = { ...stubs };
  if (nativeScanStart) { const grant = new URL('../../src/scan-start-v1/grant.mjs', workerUrl).href;
    all['../../src/scan-start-v1/grant.mjs'] = stub([`export * from ${JSON.stringify(grant)};`, 'export const NATIVE_SCAN_START_REQUIRED=true;']); }
  for (const [relative, url] of Object.entries(all)) { const quoted = `'${relative}'`; assert.equal(source.split(quoted).length, 2, 'one import of ' + relative); source = source.replace(quoted, JSON.stringify(url)); }
  source = source.replace(/from (['"])(\.[^'"]+)\1/g, (_all, _q, relative) => `from ${JSON.stringify(new URL(relative, workerUrl).href)}`);
  return (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).executeProtectedIssuedJob;
}
const executeProtectedIssuedJob = await loadWorker();

const PACKET = { complete: true, paths: ['a.txt'] };
// relay(n): the n-th callback's pre-challenge check (policy/manifest/qualification/refs); load(n): the n-th full
// authority reload (0 = the start); answer(n): when the response to challenge n appears.
function harness({ relay = () => ({}), load = () => ({}), answer = async () => {}, adapterCalls = 1, scanStart = false } = {}) {
  const job = batchJobsV2({ repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, testSha: HEAD, sourceManifestSha256: 'e'.repeat(64), createdAt: iso(Date.now() - 60_000), attempt: 1 }).trivy;
  const claim = { claimId: randomUUID(), fence: 3, epoch: 1, expiresAt: iso(Date.now() + 3600_000) };
  const context = { role: 'trivy', config: { sourceManifestSha256: job.sourceManifestSha256 }, sourceAcceptanceRef: randomUUID(), hostQualificationRef: randomUUID(), policy: { marker: 'start-policy' } };
  const issue = makeIssue(job, admittedFacts(job, claim, PACKET, { batchClaim: claim }), null, { sourceAcceptanceRef: context.sourceAcceptanceRef, hostQualificationRef: context.hostQualificationRef, expiresAt: iso(Date.now() + 600_000) });
  const files = new Map([['issue', Buffer.from(encode(issue))]]), events = [];
  let loads = 0, relays = 0;
  const h = { job, context, events, signed: [], opened: [], adapterValues: [], adapterErrors: [],
    relay: async () => { const n = relays++; events.push(`relay-start:${n}`); const v = await relay(n); events.push(`relay-end:${n}`); return { ...context, ...v }; },
    load: async () => { const n = loads++; events.push(`load-start:${n}`); const v = await load(n); events.push(`load-end:${n}`); return { ...context, ...v }; },
    box: { async lock() {}, async read(name) { return files.get(name); },
      async write(name, bytes) { files.set(name, Buffer.from(bytes)); events.push(`write:${name}`); },
      async wait(name, { deadline, signal } = {}) {
        const n = Number(name.slice('response-'.length)), challenge = decode(files.get('challenge-' + name.slice('response-'.length)));
        const gate = answer(n);
        for (;;) {
          if (signal?.aborted || Date.now() >= deadline) { events.push(`wait-cut:${n}`); throw coded('FORMAL_MAILBOX_WAIT_UNCONFIRMED'); }
          const done = await Promise.race([gate.then(() => true), new Promise(r => setTimeout(() => r(false), 20))]);
          if (done) { events.push(`response:${n}`); return Buffer.from(encode(makeResponse(issue, challenge, admittedFacts(job, claim, PACKET, { batchClaim: claim }), null))); }
        } } },
    session: { async finish() { events.push('finish'); }, async releaseClean() { events.push('release'); } },
    adapter: ports => ({ async execute(subject) {
      if (scanStart) { try { await ports.scanStartPort(subject); } catch (e) { h.adapterErrors.push(e.code); throw e; } }
      let last;
      for (let i = 0; i < adapterCalls; i++) {
        try { last = await ports.admissionPort(subject); h.adapterValues.push(last); events.push('adapter-got-value'); } catch (e) { h.adapterErrors.push(e.code); throw e; }
      }
      return { status: 'OBSERVED', observation: { preAdmissionSha256: last.observationSha256, postAdmissionSha256: last.observationSha256 } };
    } }) };
  globalThis.__roundTripHarness = h; return h;
}
const at = (h, e) => h.events.indexOf(e);
const olderPost = h => { const adapter = h.adapter; h.adapter = ports => { const a = adapter(ports); return { async execute(s) { const o = await a.execute(s); return { ...o, observation: { ...o.observation, postAdmissionSha256: 'f'.repeat(64) } }; } }; }; };

test('D: policy, manifest, qualification and refs pass before the challenge; only the Source re-hash overlaps the wait', async () => {
  const slow = deferred();
  const h = harness({ load: n => n === 1 ? slow.promise.then(() => ({})) : {}, answer: async () => {} });
  const run = executeProtectedIssuedJob();
  for (let i = 0; i < 50 && !h.events.includes('response:1'); i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(at(h, 'relay-end:0') < at(h, 'write:challenge-01'), 'the pre-challenge check completed before the challenge');
  assert.ok(at(h, 'load-start:1') < at(h, 'write:challenge-01') && at(h, 'write:challenge-01') < at(h, 'response:1'));
  assert.ok(!h.events.includes('load-end:1') && !h.events.includes('adapter-got-value'), 'the response waits for the re-hash; the adapter has nothing yet');
  slow.resolve();
  const r = await run;
  assert.equal(r.status, 'ACTUAL_SIGNED_ROLE_RESULT_EMITTED');
  assert.ok(at(h, 'load-end:1') < at(h, 'adapter-got-value') && at(h, 'adapter-got-value') < at(h, 'finish'));
  // memoized start and end: the session reuses the start context's policy, the signer the session's post-execution load
  assert.deepEqual(h.opened, [{ preloaded: { marker: 'start-policy' } }]);
  assert.deepEqual(h.signed, [{ session: h.session }]);
});

test('D: a refusal of the pre-challenge check writes NO challenge; a Source drift found meanwhile is never used, nothing signed', async () => {
  for (const [what, relay, code] of [['changed refs', n => n === 0 ? { sourceAcceptanceRef: randomUUID() } : {}, 'FORMAL_CALLBACK_AUTHORITY_CHANGED'],
    ['changed manifest', n => n === 0 ? { config: { sourceManifestSha256: 'f'.repeat(64) } } : {}, 'FORMAL_CALLBACK_AUTHORITY_CHANGED'],
    ['expired qualification', n => { if (n === 0) throw coded('ACTUAL_ROLE_QUALIFICATION_REQUIRED'); return {}; }, 'ACTUAL_ROLE_QUALIFICATION_REQUIRED']]) {
    const h = harness({ relay });
    const r = await executeProtectedIssuedJob();
    assert.deepEqual([r.status, r.reason, h.adapterErrors, h.signed.length, h.events.some(e => e.startsWith('write:challenge'))], ['UNCERTAIN', code, [code], 0, false], what);
    assert.ok(!h.events.includes('load-start:1'), `${what}: the re-hash never starts`);
  }
  for (const [what, load, code] of [['changed refs in the full reload', n => n === 1 ? { sourceAcceptanceRef: randomUUID() } : {}, 'FORMAL_CALLBACK_AUTHORITY_CHANGED'],
    ['a Source drift', n => { if (n === 1) throw coded('ACTUAL_TRACKED_SOURCE_BYTES_CHANGED'); return {}; }, 'ACTUAL_TRACKED_SOURCE_BYTES_CHANGED']]) {
    const h = harness({ load });
    const r = await executeProtectedIssuedJob();
    assert.deepEqual([r.status, r.reason, h.adapterErrors, h.adapterValues.length, h.signed.length, h.events.includes('finish')], ['UNCERTAIN', code, [code], 0, 0, false], what);
  }
});

test('D: a scan-start still completes the whole reload before its challenge; its refusal writes none', async () => {
  const native = await loadWorker({ nativeScanStart: true });
  const slow = deferred();
  let h = harness({ scanStart: true, load: n => n === 1 ? slow.promise.then(() => ({})) : {} });
  const run = native();
  for (let i = 0; i < 30 && !h.events.includes('load-start:1'); i++) await new Promise(r => setTimeout(r, 10));
  await new Promise(r => setTimeout(r, 30));
  assert.ok(h.events.includes('load-start:1') && !h.events.some(e => e.startsWith('write:challenge')), 'no challenge while the reload runs');
  slow.resolve(); await run;
  assert.ok(at(h, 'load-end:1') < at(h, 'write:challenge-01'));
  assert.ok(!h.events.includes('relay-start:0'), 'the scan-start round takes the full reload, not the split one');
  h = harness({ scanStart: true, load: n => { if (n === 1) throw coded('ACTUAL_TRACKED_SOURCE_BYTES_CHANGED'); return {}; } });
  const r = await native();
  assert.deepEqual([r.reason, h.adapterErrors, h.events.some(e => e.startsWith('write:challenge'))], ['ACTUAL_TRACKED_SOURCE_BYTES_CHANGED', ['ACTUAL_TRACKED_SOURCE_BYTES_CHANGED'], false]);
});

test('D: a re-hash refusal cuts the wait short and wins over the write\'s or the wait\'s own failure; a final-admission refusal stops the signing', async () => {
  // Windows never answers: the refusal ends the wait at once instead of at the deadline, and its code is reported
  let h = harness({ load: n => { if (n === 1) return new Promise((_, no) => setTimeout(() => no(coded('ROLE_SOURCE_GIT_UNCONFIRMED')), 50)); return {}; }, answer: () => new Promise(() => {}) });
  const started = Date.now(); let r = await executeProtectedIssuedJob();
  assert.deepEqual([r.reason, h.adapterErrors, h.signed.length], ['ROLE_SOURCE_GIT_UNCONFIRMED', ['ROLE_SOURCE_GIT_UNCONFIRMED'], 0]);
  assert.ok(h.events.includes('wait-cut:1') && Date.now() - started < 5000);
  // the wait fails first (deadline-like), the re-hash refuses later: the re-hash's code, as when it ran first
  h = harness({ load: n => n === 1 ? new Promise((_, no) => setTimeout(() => no(coded('FORMAL_CALLBACK_AUTHORITY_CHANGED')), 150)) : {} });
  h.box.wait = async () => { h.events.push('wait-failed'); throw coded('FORMAL_MAILBOX_WAIT_UNCONFIRMED'); };
  r = await executeProtectedIssuedJob();
  assert.deepEqual([r.reason, h.adapterErrors], ['FORMAL_CALLBACK_AUTHORITY_CHANGED', ['FORMAL_CALLBACK_AUTHORITY_CHANGED']]);
  // the challenge write fails, the re-hash refuses later: the re-hash's code
  h = harness({ load: n => n === 1 ? new Promise((_, no) => setTimeout(() => no(coded('ACTUAL_SOURCE_COMMIT_CHANGED')), 100)) : {} });
  const write = h.box.write;
  h.box.write = async (name, bytes) => { if (name.startsWith('challenge-')) throw coded('ENOSPC'); return write(name, bytes); };
  r = await executeProtectedIssuedJob();
  assert.deepEqual([r.reason, h.adapterErrors], ['ACTUAL_SOURCE_COMMIT_CHANGED', ['ACTUAL_SOURCE_COMMIT_CHANGED']]);
  // the write fails and the re-hash passes: the write's own code
  h = harness();
  const write2 = h.box.write;
  h.box.write = async (name, bytes) => { if (name.startsWith('challenge-')) throw coded('ENOSPC'); return write2(name, bytes); };
  r = await executeProtectedIssuedJob();
  assert.deepEqual([r.reason, h.adapterErrors], ['ENOSPC', ['ENOSPC']]);
  // the wait fails and the re-hash passes: the wait's own code
  h = harness();
  h.box.wait = async () => { throw coded('FORMAL_MAILBOX_WAIT_UNCONFIRMED'); };
  r = await executeProtectedIssuedJob();
  assert.deepEqual([r.reason, h.adapterErrors], ['FORMAL_MAILBOX_WAIT_UNCONFIRMED', ['FORMAL_MAILBOX_WAIT_UNCONFIRMED']]);
  // the observation names an older admission, so one more admission round runs before signing; its check refuses: no
  // challenge for it and no signature
  h = harness({ adapterCalls: 2, relay: n => n === 2 ? { sourceAcceptanceRef: randomUUID() } : {} }); olderPost(h);
  r = await executeProtectedIssuedJob();
  assert.deepEqual([r.status, r.reason, h.signed.length, h.events.includes('finish'), h.events.includes('write:challenge-03')], ['UNCERTAIN', 'FORMAL_CALLBACK_AUTHORITY_CHANGED', 0, false, false]);
  // and its re-hash refuses: the challenge went out, but nothing is signed
  h = harness({ adapterCalls: 2, load: n => n === 3 ? { sourceAcceptanceRef: randomUUID() } : {} }); olderPost(h);
  r = await executeProtectedIssuedJob();
  assert.deepEqual([r.status, r.reason, h.signed.length, h.events.includes('finish')], ['UNCERTAIN', 'FORMAL_CALLBACK_AUTHORITY_CHANGED', 0, false]);
  assert.ok(h.events.includes('write:challenge-03'));
});

test('D: the start and finish policies are reused only for the same actual job at the current clock', () => {
  const w = relayWorld(), loaded = { ...w.loaded, job: structuredClone(w.job) };
  assert.equal(sameRolePolicyFacts(w.job, loaded), true);
  assert.equal(reusableRolePolicy(w.job, loaded), null, 'not an actual brand: load anew');
  assert.equal(sameRolePolicyFacts(w.job, null), false);
  assert.equal(sameRolePolicyFacts({ ...w.job, attempt: 2 }, loaded), false, 'another job');
  const expired = relayWorld({ expiresAt: Date.now() + 1000 }), old = { ...expired.loaded, job: expired.job };
  assert.equal(sameRolePolicyFacts(expired.job, old, Date.now() + 2000), false, 'the qualification ran out since: load anew (which refuses)');
  assert.equal(sameRolePolicyFacts(w.job, { ...loaded, config: { ...loaded.config, sourceManifestSha256: 'f'.repeat(64) } }), false);
  assert.equal(reusableRolePolicy.length, 2, 'no injectable brand check in the production API');
  assert.equal(takeFinishedRolePolicy({}, w.job), null, 'only a real finished session hands its policy to the signer');
});

// ================================================================================================================
// E1. The issuer's admission: the changed paths beside the admission, the mode beside the PR read.
// ================================================================================================================
const SCOPE = `project:${randomUUID()}`;
const NATIVE_RPC = 'https://fixture.supabase.co/rest/v1/rpc/clued_work_verify_v1';
function admissionWorld({ modeDelay = 0, modeThrows = null, modeValue = null, tokenThrows = null, credentials = null, prStatus = 200, nativeLog = [], githubReads = 0 } = {}) {
  const job = makeJobV2({ repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, testSha: HEAD, sourceManifestSha256: 'd'.repeat(64), createdAt: iso(Date.now() - 60_000), attempt: 1, role: 'control-merge-slot' });
  const claimId = randomUUID(), taskId = randomUUID(), prRef = `${REPO}#888`, events = [], counts = {};
  const pr = { number: 888, state: 'open', body: `Fix\n\nClued-Work-Claim: ${claimId}\nClued-Work-Scope: ${SCOPE}\n`, head: { sha: HEAD, repo: { full_name: REPO } }, base: { sha: BASE, ref: 'main', repo: { full_name: REPO } } };
  const native = () => ({ status: 'ok', verdict: 'ADMITTED', execution_authorized: true, execution_policy: 'staged', current_fence: 3, execution_epoch: 1, bound_pr: prRef, pr_ref: prRef, head_sha: HEAD, base_sha: BASE,
    verified_at: iso(Date.now()), paths_outside_write_set: [], claim: { claim_id: claimId, task_id: taskId, fence: 3, execution_epoch: 1, context_key: SCOPE, status: 'ACTIVE', bound_pr: prRef, expires_at: iso(Date.now() + 3600_000),
      lease_key_required: false, execution_handover_pending: false, merge_slot_until: iso(Date.now() + 600_000), merge_queue: [] } });
  const fetchImpl = async (url, opts) => {
    const u = String(url), k = u.startsWith('https://fixture') ? 'native' : new URL(u).pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
    counts[k] = (counts[k] ?? 0) + 1; events.push(`fetch:${k}`);
    if (k === 'native') { nativeLog.push(opts); return { ok: true, status: 200, json: async () => native() }; }
    if (k === '/pulls/888') return { ok: prStatus === 200, status: prStatus, json: async () => structuredClone(pr) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const policyText = '{"policy":"fixture"}';
  const config = { domain: 'fixture', repository: REPO, scope: SCOPE, workspace: os.tmpdir(), sourceManifestSha256: 'd'.repeat(64), evaluatorSha256: digest('EVALUATOR'),
    policyText, policySha256: digest(policyText), ciPrincipalBindingId: randomUUID(), ciPrincipalQualificationRef: 'qualification-ref', publishableKey: 'sb_publishable_fixture', supabaseUrl: 'https://fixture.supabase.co' };
  const hooks = { evaluatorReader: () => 'EVALUATOR',
    // the evaluator's shape: GitHub reads, then the Native verify RPC through the fetch it is given, then its outcome
    evaluateImpl: async ({ fetchImpl: f, observation_recorder }) => {
      events.push('evaluate-start');
      for (let i = 0; i < githubReads; i++) { await f(`https://api.github.com/repos/${REPO}/pulls/888/files?page=${i + 1}`, {}); await new Promise(r => setTimeout(r, 15)); }
      const reply = await (await f(NATIVE_RPC, { method: 'POST', body: '{}' })).json();
      observation_recorder.record('claim_verification', { result: { payload: reply } });
      return { admitted: true, verdict: 'ADMITTED', head_sha: HEAD, base_sha: BASE, pr_ref: prRef, claim_id: claimId, task_id: taskId, scope: SCOPE,
        claim_binding: { status: 'ok', binding_status: 'bound', reason: null, repository: REPO, pr_number: 888, pr_ref: prRef,
          head_sha: HEAD, base_sha: BASE, target_branch: 'main', scope: SCOPE, task_id: taskId,
          claim: { claim_id: claimId, task_id: taskId, context_key: SCOPE, fence: 3, execution_epoch: 1, lease_version: 1,
            expires_at: iso(Date.now() + 3600_000), status: 'ACTIVE', execution_handover_pending: false },
          head_authorization_id: null, auto_bound: false, receipt_id: null }, changed_paths: ['a.txt'],
        admission_mode: { state: 'normal', layer: 'code', policy_version: 1 }, merge_slot: { state: 'held', ref: `merge:${REPO}:main`, tip: BASE, until: iso(Date.now() + 600_000) }, owner_review: null, workflow_gate_findings: [] };
    } };
  const port = createFullAdmissionPortV2({ protectedConfig: config,
    tokenProvider: async () => { events.push('token'); if (tokenThrows) throw tokenThrows; return credentials ?? { githubToken: 'gh-fixture', ciAdmissionToken: ['clued', 'bnd', 'fixture123'].join('_'), ciPrincipalBindingId: config.ciPrincipalBindingId, ciPrincipalQualificationRef: config.ciPrincipalQualificationRef }; },
    modeProvider: async () => { events.push('mode-start'); if (modeDelay) await new Promise(r => setTimeout(r, modeDelay)); events.push('mode-end'); if (modeThrows) throw modeThrows;
      return modeValue ?? { complete: true, repository: REPO, variable: 'CLUED_MERGE_ADMISSION_STATE', source: 'github-repository-variables', exists: false, observedAt: iso(Date.now()), proofRef: 'mode-proof' }; },
    recorderProvider: async () => ({ kind: 'independent-controller', domain: 'fixture', observedAt: iso(Date.now()), observationRef: 'obs', recorder: { newId: randomUUID, record() {} } }),
    fetchImpl, fixtureHooks: hooks });
  return { job, port, events, counts, packet: { complete: true, pr: 888, headSha: HEAD, baseSha: BASE, paths: ['a.txt'] } };
}

test('E1: a deferred packet gives the same admission as a given one; nothing is assembled and no Native RPC is sent before it arrives', async () => {
  const w = admissionWorld(), d = deferred();
  const given = await w.port.evaluatePr(w.job, w.packet);
  w.events.length = 0; delete w.counts.native;
  let done = false; const run = w.port.evaluatePr(w.job, () => d.promise).then(v => { done = true; return v; });
  for (let i = 0; i < 20; i++) await tick();
  await new Promise(r => setTimeout(r, 30));
  assert.ok(w.events.includes('evaluate-start'), 'the evaluation runs meanwhile');
  assert.equal(w.counts.native, undefined, 'no Native RPC before the packet');
  assert.equal(done, false, 'no facts before the packet');
  d.resolve(w.packet);
  const facts = await run;
  assert.deepEqual([facts.status, facts.contract, facts.packetSha256, w.counts.native], ['ADMITTED', FULL_ADMISSION_CONTRACT_V2, given.packetSha256, 1]);
  for (const k of ['status', 'claimId', 'fence', 'epoch', 'headSha', 'baseSha', 'packetSha256', 'modeProofRef', 'scope', 'executionPolicy']) assert.deepEqual(facts[k], given[k], k);
});

test('E1: a deferred packet that fails or is invalid is the old subject refusal, and no Native RPC is ever sent', async () => {
  for (const [what, packet] of [['failed read', () => Promise.reject(coded('github_http_502'))], ['other head', async () => ({ complete: true, pr: 888, headSha: 'c'.repeat(40), baseSha: BASE, paths: ['a.txt'] })],
    ['incomplete', async () => ({ complete: false, pr: 888, headSha: HEAD, baseSha: BASE, paths: ['a.txt'] })], ['bad path', async () => ({ complete: true, pr: 888, headSha: HEAD, baseSha: BASE, paths: ['../x'] })]]) {
    const w = admissionWorld();
    const r = await w.port.evaluatePr(w.job, packet);
    assert.deepEqual([r.status, r.reason, w.counts.native ?? 0], ['BLOCKED', 'full_admission_subject_invalid', 0], what);
  }
  // an invalid packet wins over any later refusal, as when it was checked first; a job refusal before it stays first
  const w = admissionWorld({ modeValue: { complete: false } });
  assert.equal((await w.port.evaluatePr(w.job, async () => ({ ...w.packet, pr: 9 }))).reason, 'full_admission_subject_invalid');
  assert.equal((await w.port.evaluatePr(w.job, async () => w.packet)).reason, 'full_admission_mode_unknown');
  for (const job of [{ ...w.job, repo: 'x/y' }, { ...w.job, id: 'nope' }, { ...w.job, sourceManifestSha256: 'e'.repeat(64) }]) {
    const given = await w.port.evaluatePr(job, w.packet), late = await w.port.evaluatePr(job, async () => ({ ...w.packet, pr: 9 }));
    assert.deepEqual(late, given, 'a refusal of the job itself is the given-packet one');
  }
  assert.deepEqual(await w.port.evaluatePr(w.job, async () => w.packet, { extra: 1 }), await w.port.evaluatePr(w.job, w.packet, { extra: 1 }));
});

test('E1: once the deferred packet has failed, every further GitHub read of the evaluation stops at once; Native is never contacted', async () => {
  const w = admissionWorld({ githubReads: 20 });
  const r = await w.port.evaluatePr(w.job, () => new Promise((_, no) => setTimeout(() => no(coded('github_http_502')), 60)));
  const files = w.events.filter(e => e === 'fetch:/pulls/888/files').length;
  assert.deepEqual([r.reason, w.counts.native ?? 0], ['full_admission_subject_invalid', 0]);
  assert.ok(files >= 1 && files < 10, `the evaluation stopped early: ${files} of 20 reads sent`);
  // through the issuer: the read's own reason, and the evaluation it waits for ends early too
  const w2 = admissionWorld({ githubReads: 20 }), started = Date.now();
  const answer = await issuerEvaluate({ github: { readChangedPaths: () => new Promise((_, no) => setTimeout(() => no(coded('github_http_403')), 60)) }, admission: w2.port, job: w2.job, batchClaim: null })();
  assert.deepEqual(answer, { status: 'BLOCKED', reason: 'full_admission_github_forbidden', diagnostic: { phase: 'changed_paths' } });
  assert.ok(Date.now() - started < 20 * 15, 'not after all 20 reads');
  assert.equal(w2.counts.native ?? 0, 0);
  // a valid packet: every read goes out
  const w3 = admissionWorld({ githubReads: 5 });
  assert.equal((await w3.port.evaluatePr(w3.job, async () => w3.packet)).status, 'ADMITTED');
  assert.equal(w3.events.filter(e => e === 'fetch:/pulls/888/files').length, 5);
});

test('E1: the mode read and the PR read run side by side; their results are judged in the old order with the old phases', async () => {
  let w = admissionWorld({ modeDelay: 60 });
  assert.equal((await w.port.evaluatePr(w.job, w.packet)).status, 'ADMITTED');
  assert.ok(w.events.indexOf('fetch:/pulls/888') < w.events.indexOf('mode-end'), 'the PR read started before the mode read ended');
  const cases = [
    [{ modeThrows: coded('github_http_502'), tokenThrows: coded('x') }, 'full_admission_unavailable', { phase: 'mode', transport: true }],
    [{ modeValue: { complete: false }, tokenThrows: coded('x') }, 'full_admission_mode_unknown', undefined],
    [{ modeValue: { complete: false }, prStatus: 404 }, 'full_admission_mode_unknown', undefined],
    [{ tokenThrows: coded('github_credential_unavailable'), prStatus: 404 }, 'full_admission_unavailable', { phase: 'principal', transport: false }],
    [{ credentials: { githubToken: 'gh', ciAdmissionToken: 'bad' } }, 'full_admission_principal_unknown', undefined],
    [{ prStatus: 404 }, 'full_admission_unavailable', { phase: 'pull_request', transport: false }],
    [{ prStatus: 502 }, 'full_admission_unavailable', { phase: 'pull_request', transport: true }],
  ];
  for (const [o, reason, diagnostic] of cases) {
    w = admissionWorld(o);
    const r = await w.port.evaluatePr(w.job, w.packet);
    assert.deepEqual([r.reason, r.diagnostic], [reason, diagnostic], JSON.stringify(o));
    if (o.credentials) assert.equal(w.counts['/pulls/888'], undefined, 'never a PR read with credentials that fail the principal check');
  }
});

test('E1: issuerEvaluate answers only when both reads are complete; a failed read keeps its own reason', async () => {
  const job = { id: 'job' }, slow = deferred(); let answered = false;
  const admission = { evaluatePr: async (_j, packet) => { await packet(); return { status: 'ADMITTED', marker: 1 }; } };
  const run = issuerEvaluate({ github: { readChangedPaths: () => slow.promise }, admission, job, batchClaim: null })().then(v => { answered = true; return v; });
  await new Promise(r => setTimeout(r, 20)); assert.equal(answered, false);
  slow.resolve(PACKET); assert.deepEqual(await run, { status: 'ADMITTED', marker: 1 });
  // the admission ends first with ADMITTED, the read then fails: the read's reason, never the admission's answer
  const fast = { evaluatePr: async () => ({ status: 'ADMITTED' }) };
  assert.deepEqual(await issuerEvaluate({ github: { readChangedPaths: async () => { await new Promise(r => setTimeout(r, 20)); throw coded('pr_files_changed'); } }, admission: fast, job, batchClaim: null })(),
    { status: 'BLOCKED', reason: 'full_admission_paths_refused', diagnostic: { phase: 'changed_paths' } });
  // the two run side by side: the admission starts before the read ends
  const order = [];
  await issuerEvaluate({ github: { readChangedPaths: async () => { order.push('paths-start'); await new Promise(r => setTimeout(r, 20)); order.push('paths-end'); return PACKET; } },
    admission: { evaluatePr: async (_j, p) => { order.push('admission-start'); await p(); order.push('admission-end'); return { status: 'ADMITTED' }; } }, job, batchClaim: null })();
  assert.deepEqual(order, ['paths-start', 'admission-start', 'paths-end', 'admission-end']);
});

// The GitHub port: the two mode scopes side by side, one token exchange for concurrent reads.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
function fakeGitHub({ failRepo = null, failEnv = null, delay = 20 } = {}) {
  const calls = {}; let inFlight = 0, maxInFlight = 0;
  const reply = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
  const fetchImpl = async (url, options) => {
    const { pathname } = new URL(url), key = `${options.method} ${pathname}`; calls[key] = (calls[key] ?? 0) + 1;
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise(r => setTimeout(r, delay));
      if (key === 'GET /app') return reply({ id: 77 });
      if (key === 'POST /app/installations/99/access_tokens') return reply({ token: 't', expires_at: iso(Date.now() + 3_600_000), permissions: { checks: 'write', contents: 'read', pull_requests: 'read', actions_variables: 'read', environments: 'read', metadata: 'read' } });
      if (key === 'GET /installation/repositories') return reply({ total_count: 1, repositories: [{ id: 41, full_name: 'owner/repo' }] });
      if (key === 'GET /repos/owner/repo/actions/variables') return failRepo ? reply({}, failRepo) : reply({ total_count: 1, variables: [{ name: 'CLUED_MERGE_ADMISSION_STATE', value: 'normal', updated_at: 'x' }] });
      if (key === 'GET /repos/owner/repo/environments/clued-admission/variables') return failEnv ? reply({}, failEnv) : reply({ total_count: 0, variables: [] });
      if (key === 'GET /repos/owner/repo/pulls/7') return reply({ number: 7 });
      throw new Error(`unexpected ${key}`);
    } finally { inFlight--; }
  };
  const port = createGitHubChecksPort({ repository: 'owner/repo', repositoryId: 41, appId: 77, installationId: 99, includeModeRead: true, privateKeyProvider: async () => privateKey, fetchImpl, retryWindowMs: 0 });
  return { port, calls, max: () => maxInFlight };
}

test('E1: the two admission-mode scopes are read side by side, judged together, failures in the old order; one token for concurrent reads', async () => {
  let g = fakeGitHub();
  const mode = await g.port.readAdmissionMode();
  assert.deepEqual([mode.complete, mode.exists, mode.value, mode.scopeObservations.environment.exists], [true, true, 'normal', false]);
  assert.equal(g.max(), 2, 'both scopes in flight at once');
  g = fakeGitHub({ failRepo: 403, failEnv: 500 });
  await assert.rejects(g.port.readAdmissionMode(), { code: 'github_http_403' }, 'the repository scope\'s failure first');
  g = fakeGitHub({ failEnv: 404 });
  await assert.rejects(g.port.readAdmissionMode(), { code: 'github_http_404' });
  // concurrent first reads share one token exchange (GET /app, POST access_tokens, GET installation/repositories once)
  g = fakeGitHub();
  await Promise.all([g.port.readPullRequest(7), g.port.readPullRequest(7), g.port.readAdmissionMode()]);
  assert.deepEqual([g.calls['GET /app'], g.calls['POST /app/installations/99/access_tokens'], g.calls['GET /installation/repositories']], [1, 1, 1]);
});

// ================================================================================================================
// E3. The SHA-fixed read cache, and the fetch timing log.
// ================================================================================================================
const A40 = 'a'.repeat(40), B40 = 'b'.repeat(40), GH = `https://api.github.com/repos/${REPO}`;
function countingFetch(status = 200) {
  const calls = [];
  const f = async (url, opts = {}) => { calls.push([String(url), opts.method ?? 'GET']); return new Response(JSON.stringify({ url: String(url), n: calls.length }), { status, headers: { 'content-type': 'application/json' } }); };
  return { f, calls };
}
const json = async r => JSON.parse(await r.text());
const settle = () => new Promise(r => setTimeout(r, 10));

const GJ = { headers: { accept: 'application/vnd.github+json' } };
test('E3: only SHA-fixed reads are cached, per process; a hit still asserts the lease and returns the same bytes', async () => {
  const immutable = [`${GH}/compare/${A40}...${B40}`, `${GH}/compare/${A40}...${B40}?per_page=1`, `${GH}/commits/${A40}`, `${GH}/contents/.github/workflows/ci.yml?ref=${A40}`];
  const mutable = [`${GH}/pulls/888`, `${GH}/pulls/888/files?per_page=100&page=1`, `${GH}/branches/main`, `${GH}/commits/${A40}/check-runs?filter=all`, `${GH}/compare/main...${B40}`,
    `${GH}/contents/a.txt?ref=main`, `${GH}/commits/main`, `${GH}/commits/${A40}?x=1`, `${GH}/actions/variables?per_page=100&page=1`, `https://api.github.com/app`,
    `https://fixture.supabase.co/rest/v1/rpc/clued_work_verify_v1`, `https://evil.example/repos/${REPO}/commits/${A40}`];
  for (const u of immutable) assert.equal(immutableGitHubRead(u, GJ), true, u);
  for (const u of mutable) assert.equal(immutableGitHubRead(u, GJ), false, u);
  assert.equal(immutableGitHubRead(immutable[2], { ...GJ, method: 'POST' }), false);
  // review MINOR 3: only the canonical form, no dot segments; only the GitHub JSON media type, however it is given
  for (const u of [`${GH}/contents/../../../repos/x/y/commits/${A40}?ref=${A40}`, `${GH}/contents/a/./b?ref=${A40}`, `${GH}/contents/a/%2e%2e/b?ref=${A40}`,
    `${GH}/contents/a/%2E/b?ref=${A40}`, `${GH}/contents/a//b?ref=${A40}`, `https://API.github.com/repos/${REPO}/commits/${A40}`])
    assert.equal(immutableGitHubRead(u, GJ), false, u);
  assert.equal(immutableGitHubRead(immutable[2], {}), false, 'no Accept');
  for (const accept of ['application/vnd.github.raw', 'application/vnd.github+json, */*', '*/*', 'application/json'])
    assert.equal(immutableGitHubRead(immutable[2], { headers: { accept } }), false, accept);
  assert.equal(immutableGitHubRead(immutable[2], { headers: { Accept: 'application/vnd.github+json' } }), true, 'any case of the name');
  assert.equal(immutableGitHubRead(immutable[2], { headers: new Headers({ Accept: 'application/vnd.github+json' }) }), true, 'a Headers instance');
  assert.equal(immutableGitHubRead(immutable[2], { headers: new Headers({ Accept: 'application/vnd.github.raw' }) }), false);
  assert.equal(immutableGitHubRead(immutable[2], { headers: { accept: 'application/vnd.github+json', ACCEPT: 'application/vnd.github.raw' } }), false, 'named twice');
  // a hit keeps only three response headers
  { const f = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json', etag: '"x"', 'x-ratelimit-remaining': '1', 'last-modified': 'Sat' } });
    const x = immutableReadCache(f); await x(immutable[2], GJ); await settle(); const hit = await x(immutable[2], GJ);
    assert.deepEqual([...hit.headers.keys()].sort(), ['content-type', 'etag', 'last-modified']); }
  let lives = 0; const c = countingFetch(), cached = immutableReadCache(c.f, { live: () => { lives++; } });
  const first = await json(await cached(immutable[2], { headers: { accept: 'application/vnd.github+json' } })); await settle();
  const second = await json(await cached(immutable[2], { headers: { accept: 'application/vnd.github+json' } }));
  assert.deepEqual([first, second, c.calls.length, lives], [first, first, 1, 1]);
  for (const u of mutable) { await cached(u, { headers: { accept: 'application/vnd.github+json' } }); await settle(); await cached(u, { headers: { accept: 'application/vnd.github+json' } }); }
  assert.equal(c.calls.length, 1 + 2 * mutable.length, 'every mutable read goes out every time');
  assert.equal(cached.size(), 1);
  // only a complete 200 is kept
  for (const status of [404, 500, 201]) { const e = countingFetch(status), x = immutableReadCache(e.f); await x(immutable[0], GJ); await settle(); await x(immutable[0], GJ); assert.equal(e.calls.length, 2, String(status)); }
  // another process (another cache) starts empty
  const again = immutableReadCache(c.f); await again(immutable[2], GJ); assert.equal(c.calls.length, 2 + 2 * mutable.length);
});

test('E3 + timing: controllerPorts serves a repeated SHA-fixed read from its cache and logs each fetch as a pattern only', async t => {
  const dir = await tmp(t, 'clued-timing-'), lines = [];
  const record = { config: { repository: REPO, scope: SCOPE, supabaseUrl: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_test' }, accepted: {}, ciTokenPinSha256: 'a'.repeat(64) };
  const c = countingFetch(), log = observationLog(dir, 'f'.repeat(64));
  const ports = controllerPorts({ record, appKey: null, nativeToken: 'clued_bnd_testtoken', policyText: '{}', sourceRoot: process.cwd(), live() {}, log, baseFetch: c.f });
  for (let i = 0; i < 3; i++) { await ports.fetchImpl(`${GH}/commits/${A40}`, { headers: { accept: 'application/vnd.github+json', authorization: 'Bearer ghs_SECRET' } }); await settle(); }
  await ports.fetchImpl(`${GH}/pulls/888`, { headers: { authorization: 'Bearer ghs_SECRET' } });
  assert.equal(c.calls.length, 2, 'commits/<sha> once, the PR read every time');
  const text = await fs.readFile(path.join(dir, 'fetch-timings.jsonl'), 'utf8');
  for (const l of text.trim().split('\n')) lines.push(JSON.parse(l));
  assert.deepEqual(lines.map(l => [l.url, l.method, l.status, l.cache]), [['github/repos/{repo}/commits/{sha}', 'GET', 200, false], ['github/repos/{repo}/commits/{sha}', 'GET', 200, true],
    ['github/repos/{repo}/commits/{sha}', 'GET', 200, true], ['github/repos/{repo}/pulls/{n}', 'GET', 200, false]]);
  assert.ok(lines.every(l => Number.isSafeInteger(l.ms) && l.jobId === 'f'.repeat(64)));
  assert.doesNotMatch(text, /SECRET|tdoljyj|aaaaaaaaaa|888/);
  assert.equal(fetchUrlPattern(`${GH}/contents/secret/dir/file.txt?ref=${A40}`), 'github/repos/{repo}/contents/{path}?ref');
  assert.equal(fetchUrlPattern(`${GH}/compare/${A40}...${B40}?per_page=1`), 'github/repos/{repo}/compare/{range}?per_page');
  assert.equal(fetchUrlPattern('https://abc.supabase.co/rest/v1/rpc/clued_work_verify_v1'), 'native/rpc/clued_work_verify_v1');
  assert.equal(fetchUrlPattern('https://abc.supabase.co/rest/v1/table?select=*&token=x'), 'native/rest/v1/{seg}?select&{key}');
  // a fixed vocabulary only (review MINOR 4): unknown path words and query keys become placeholders
  assert.equal(fetchUrlPattern('https://abc.supabase.co/rest/v1/rpc/secret_function_name'), 'native/rpc/{rpc}');
  assert.equal(fetchUrlPattern(`https://api.github.com/user/ghs_SECRETTOKEN/whatever?access_token=x&page=2`), 'github/{seg}/{seg}/{seg}?page&{key}');
  assert.equal(fetchUrlPattern(`${GH}/branches/feature-secret-name`), 'github/repos/{repo}/branches/{seg}');
  assert.equal(fetchUrlPattern(`${GH}/environments/clued-admission/variables?per_page=100&page=1`), 'github/repos/{repo}/environments/clued-admission/variables?page&per_page');
  assert.equal(fetchUrlPattern('not a url'), 'unparsed');
});
