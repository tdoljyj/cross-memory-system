// drill/drill-vm.ps1, offline: the decisions that do not need Hyper-V (answer file, answer ISO, memory gate, baseline action,
// ISO hash, package triple, first-install kit, the A1-A10 verdict, the production read-back, -Finalize) and the guest-side fake
// credentials, whose fingerprints are cross-checked against the package's own formulas (tools/secret-fingerprint.mjs).
// No VM is created or touched; only temp directories are written.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fingerprintAppKey, fingerprintCiToken } from '../tools/secret-fingerprint.mjs';

const windows = process.platform === 'win32';
const script = fileURLToPath(new URL('../drill/drill-vm.ps1', import.meta.url));
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-vm-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Dot-source the script (definitions only) and print the expression's value as JSON.
function ps(expr) {
  const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `$ProgressPreference='SilentlyContinue'; . ${q(script)}; ConvertTo-Json -Depth 12 -Compress -InputObject $(${expr})`], { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout.trim());
}
// The drill code a call stops with (New-DrillError), or null.
function psCode(expr) {
  return ps(`try { ${expr} | Out-Null; $null } catch { (Get-DrillCode $_).code }`);
}
const opts = { skip: !windows };

test('the answer file is well-formed and installs Windows 11 Pro, zh-CN, a local admin, no online account', opts, () => {
  const r = ps(`$x = [xml](New-DrillAutounattend 'p<&>w'); $ns = @{ u = 'urn:schemas-microsoft-com:unattend' };
    [ordered]@{ key = (Select-Xml -Xml $x -XPath '//u:ProductKey/u:Key' -Namespace $ns).Node.InnerText;
      ui = (Select-Xml -Xml $x -XPath '//u:SetupUILanguage/u:UILanguage' -Namespace $ns).Node.InnerText;
      host = (Select-Xml -Xml $x -XPath '//u:ComputerName' -Namespace $ns).Node.InnerText;
      user = (Select-Xml -Xml $x -XPath '//u:LocalAccount/u:Name' -Namespace $ns).Node.InnerText;
      group = (Select-Xml -Xml $x -XPath '//u:LocalAccount/u:Group' -Namespace $ns).Node.InnerText;
      pw = (Select-Xml -Xml $x -XPath '//u:LocalAccount/u:Password/u:Value' -Namespace $ns).Node.InnerText;
      hideOnline = (Select-Xml -Xml $x -XPath '//u:HideOnlineAccountScreens' -Namespace $ns).Node.InnerText;
      autoLogon = @(Select-Xml -Xml $x -XPath '//u:AutoLogon' -Namespace $ns).Count;
      parts = @(Select-Xml -Xml $x -XPath '//u:CreatePartition/u:Type' -Namespace $ns | ForEach-Object { $_.Node.InnerText }) }`);
  assert.deepEqual(r, { key: 'VK7JG-NPHTM-C97JM-9MPGT-3V66T', ui: 'zh-CN', host: 'CLUED-DRILL', user: 'drill', group: 'Administrators',
    pw: 'p<&>w', hideOnline: 'true', autoLogon: 0, parts: ['EFI', 'MSR', 'Primary'] });
  assert.equal(psCode(`New-DrillAutounattend ''`), 'DRILL_ANSWER_PASSWORD_EMPTY');
});

test('the answer ISO is built without elevation and carries autounattend.xml under its Joliet name', opts, () => {
  const src = path.join(tmp, 'answer'); fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'autounattend.xml'), '<unattend/>');
  const iso = path.join(tmp, 'answer.iso');
  ps(`New-DrillAnswerIso ${q(src)} ${q(iso)}`);
  const b = fs.readFileSync(iso);
  assert.equal(b.subarray(0x8001, 0x8006).toString('latin1'), 'CD001');
  assert.ok(b.includes(Buffer.from('autounattend.xml', 'utf16le').swap16()), 'Joliet (UTF-16BE) name');
  assert.equal(psCode(`New-DrillAnswerIso ${q(src)} ${q(iso)}`), 'DRILL_UNEXPECTED', 'never overwrites an existing ISO');
});

test('the host memory gate refuses below 14 GB free, with no retry', opts, () => {
  const r = ps(`@((Test-DrillHostMemory (14GB - 1)), (Test-DrillHostMemory 14GB))`);
  assert.equal(r[0].ok, false); assert.equal(r[0].code, 'DRILL_HOST_MEMORY_SHORT');
  assert.equal(r[1].ok, true);
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

test('the ISO is used only when its sha256 equals the expected file', opts, () => {
  const h = 'b'.repeat(64);
  const r = ps(`@((Test-DrillIsoHash ${q(h)} (${q(h.toUpperCase())} + [Environment]::NewLine)).ok,(Test-DrillIsoHash ${q('c'.repeat(64))} ${q(h)}).code, (Test-DrillIsoHash ${q(h)} 'x').code)`);
  assert.deepEqual(r, [true, 'DRILL_ISO_HASH_MISMATCH', 'DRILL_ISO_EXPECTED_SHA_UNREADABLE']);
});

function packageDir(name, { tarBytes = 'tar', accSha, sumsSha } = {}) {
  const dir = path.join(tmp, name); fs.mkdirSync(dir);
  const v = '1.2.3'; const tag = `fleet-node-${v}`;
  fs.writeFileSync(path.join(dir, `${tag}.tar`), tarBytes);
  const s = sha(tarBytes);
  fs.writeFileSync(path.join(dir, `${tag}.acceptance.json`), JSON.stringify({ contract: 'clued.independent-ci.fleet-node-acceptance/1', version: v,
    archive_sha256: accSha ?? s, ciSourceManifestSha256: '5'.repeat(64) }));
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${sumsSha ?? s}  ${tag}.tar\n`);
  return { dir, v, s };
}

test('the package triple: the tar must equal the acceptance file and SHA256SUMS', opts, () => {
  const good = packageDir('pkg-good');
  const r = ps(`Test-DrillPackageDir ${q(good.dir)} ${q(good.v)}`);
  assert.equal(r.tarSha256, good.s); assert.equal(r.ciSourceManifestSha256, '5'.repeat(64));
  assert.equal(psCode(`Test-DrillPackageDir ${q(packageDir('pkg-acc', { accSha: 'a'.repeat(64) }).dir)} '1.2.3'`), 'DRILL_TAR_NOT_THE_ACCEPTED_ONE');
  assert.equal(psCode(`Test-DrillPackageDir ${q(packageDir('pkg-sums', { sumsSha: 'a'.repeat(64) }).dir)} '1.2.3'`), 'DRILL_TAR_NOT_IN_SHA256SUMS');
  assert.equal(psCode(`Test-DrillPackageDir ${q(good.dir)} '9.9.9'`), 'DRILL_PACKAGE_FILE_MISSING');
});

function kitDir(name, mutate = (k) => k) {
  const dir = path.join(tmp, name); fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'entry.ps1'), 'param() "{}"');
  fs.writeFileSync(path.join(dir, 'tools', 'a.bin'), 'a');
  const kit = mutate({ contract: 'clued.drill.first-install-kit/1',
    files: [{ path: 'entry.ps1', sha256: sha('param() "{}"') }, { path: 'tools\\a.bin', sha256: sha('a') }],
    entry: { file: 'entry.ps1', arguments: ['-From', '{from}', '-Fake', '{fake}', '-Version', '{version}'] },
    timeoutMinutes: 120, perNodeSteps: ['reinstall/README.md 8c step 2 (root, WSL)'], prereqSha256: 'e'.repeat(64) });
  fs.writeFileSync(path.join(dir, 'kit.json'), JSON.stringify(kit));
  return dir;
}

test('the first-install kit: every file pinned, only fixed placeholders, the per-node steps declared', opts, () => {
  const r = ps(`$k = Read-DrillKit ${q(kitDir('kit-good'))}; [ordered]@{ entry = $k.entryFile; per = $k.perNodeSteps; prereq = $k.prereqSha256;
    args = @(Resolve-DrillKitArguments $k.arguments @{ from = 'C:\\drill\\from'; fake = 'C:\\drill\\fake'; version = '1.2.3' }) }`);
  assert.deepEqual(r, { entry: 'entry.ps1', per: ['reinstall/README.md 8c step 2 (root, WSL)'], prereq: 'e'.repeat(64), args:['-From', 'C:\\drill\\from', '-Fake', 'C:\\drill\\fake', '-Version', '1.2.3'] });
  const changed = kitDir('kit-changed'); fs.writeFileSync(path.join(changed, 'tools', 'a.bin'), 'b');
  assert.equal(psCode(`Read-DrillKit ${q(changed)}`), 'DRILL_KIT_FILE_CHANGED');
  assert.equal(psCode(`Read-DrillKit ${q(kitDir('kit-nodearg', (k) => ({ ...k, entry: { ...k.entry, arguments: ['-Node', 'desk-w-591'] } })))}`), 'DRILL_KIT_ARGUMENT_REFUSED');
  assert.equal(psCode(`Read-DrillKit ${q(kitDir('kit-escape', (k) => ({ ...k, files: [...k.files, { path: '..\\x', sha256: 'a'.repeat(64) }] })))}`), 'DRILL_KIT_REFUSED');
  assert.equal(psCode(`Read-DrillKit ${q(kitDir('kit-noper', (k) => { const { perNodeSteps, ...rest } = k; return rest; }))}`), 'DRILL_KIT_REFUSED');
  assert.equal(psCode(`Read-DrillKit ${q(path.join(tmp, 'nowhere'))}`), 'DRILL_FIRST_INSTALL_KIT_MISSING');
  assert.equal(psCode(`Read-DrillKit ${q(kitDir('kit-noprereq', (k) => ({ ...k, prereqSha256: null })))}`), 'DRILL_KIT_REFUSED');
});

function prereqDir(name, mutate = (p) => p) {
  const dir = path.join(tmp, name); fs.mkdirSync(path.join(dir, 'debs'), { recursive: true });
  const put = (rel, body) => { fs.writeFileSync(path.join(dir, rel), body); return sha(body); };
  const p = mutate({ contract: 'clued.drill.prereq/1', distribution: 'CluedResident-Linux',
    wsl: { path: 'wsl.2.7.13.0.x64.msi', sha256: put('wsl.2.7.13.0.x64.msi', 'msi'), url: 'https://github.com/microsoft/WSL/releases/download/2.7.13/wsl.2.7.13.0.x64.msi', version: '2.7.13.0' },
    rootfs: { path: 'ubuntu-24.04.5-wsl-amd64.wsl', sha256: put('ubuntu-24.04.5-wsl-amd64.wsl', 'rootfs'), url: 'https://releases.ubuntu.com/24.04.5/ubuntu-24.04.5-wsl-amd64.wsl' },
    debs: [{ path: 'debs\\docker.io_29.1.3_amd64.deb', sha256: put('debs/docker.io_29.1.3_amd64.deb', 'deb'), url: 'http://archive.ubuntu.com/ubuntu/pool/universe/d/docker.io-app/docker.io_29.1.3_amd64.deb' }] }, dir, put);
  fs.writeFileSync(path.join(dir, 'prereq.json'), JSON.stringify(p));
  return dir;
}

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
});

const NOW = '2026-11-16T03:00:00Z';
const S = '5'.repeat(64), L = '7'.repeat(64);
function evidence(over = {}) {
  const status = { writtenAt: '2026-11-16T02:59:50Z', node: { mode: 'UNCERTAIN' }, executor: { state: 'IDLE' }, queue: { live: 0 }, halt: null,
    versions: { selfcheck: { result: 'PASS', observedAt: '2026-11-16T02:50:00Z' } } };
  const e = { now: NOW, entry: { exitCode: 0, status: 'FIRST_INSTALL_DONE', stopCode: null, tree: 'C:\\t', node: 'C:\\n.exe', parsed: true },
    verify: { status: 'RESIDENT_VERIFIED' }, status, current: { generation: 1, ciSourceManifestSha256: S, linux: { manifestSha256: L } },
    facts: { generation: 1, staged: null, pinsOk: true, ciSourceManifestSha256: S, manifestSha256: L }, acceptanceSource: S,
    reboot: { ok: true, status, readAt: NOW }, reinstall: { skipped: false, upgradeStatus: 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE', prepareStatus: 'FLEET_NODE_INSTALL_PREPARED',
      reverifyPassed: true, prepareAgainStatus: 'FLEET_NODE_INSTALL_PREPARED' }, kit: { perNodeSteps: ['8c step 2'] } };
  return JSON.stringify(Object.assign(e, over));
}
// Build the evidence hashtable in PowerShell from JSON (nested objects as PSCustomObject, as the guest reads give them).
const verdictOf = (json) => ps(`$j = ${q(json)} | ConvertFrom-Json; $h = @{}; foreach ($p in $j.PSObject.Properties) { $h[$p.Name] = $p.Value };
  $h.now = [DateTimeOffset]::Parse($j.now); $items = Get-DrillVerdict $h; [ordered]@{ items = @($items); conclusion = (Get-DrillConclusion $items) }`);
const pass = (r) => Object.fromEntries(r.items.map((i) => [i.id, i.pass]));

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
  const skipped = verdictOf(evidence({ reinstall: { skipped: true } }));
  assert.equal(pass(skipped).A8, null); assert.equal(skipped.conclusion, 'PENDING_PRODUCTION_READBACK');
});

test('-Finalize judges A5 and A9 from one read-only production read-back and rewrites the receipt', opts, () => {
  const startedAt = '2026-11-16T02:00:00Z';
  const sql = ps(`Get-DrillReadbackSql ${q(startedAt)}`);
  assert.match(sql, /ci_nodes_v1/); assert.match(sql, /binding_roles_v1/); assert.doesNotMatch(sql, /\b(insert|update|delete)\b\s/i);
  assert.equal(psCode(`Get-DrillReadbackSql ${q("x'; drop table t; --")}`), 'DRILL_STARTED_AT_REFUSED');
  const items = verdictOf(evidence()).items;
  const receiptFile = path.join(tmp, 'receipt.json');
  const receipt = { contract: 'clued.independent-ci.drill-receipt/1', startedAt, evidence: { localSource: S }, items, conclusion: 'PENDING_PRODUCTION_READBACK' };
  fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  const row = { nodes_changed: 0, failover_marked: 0, roles_changed: 0, bindings_created: 0, drill_liveness: 0, live_sources: [S] };
  const readback = path.join(tmp, 'readback.json');
  fs.writeFileSync(readback, JSON.stringify({ contract: 'clued.drill.production-readback/1', startedAt, row }));
  const run = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Finalize', receiptFile, '-ProductionReadback', readback], { encoding: 'utf8', timeout: 120000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim()), { status: 'DRILL_FINALIZED', conclusion: 'PASS_A_PER_NODE_STEPS_REMAIN', receipt: receiptFile });
  const done = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  assert.equal(done.items.find((i) => i.id === 'A9').pass, true);
  assert.equal(done.items.find((i) => i.id === 'A5').pass, true);
  // a touched production table or a Source that differs fails; a read-back of another drill is refused
  const v = (r, s = startedAt) => ps(`$rc = ${q(JSON.stringify(receipt))} | ConvertFrom-Json; $rb = ${q(JSON.stringify({ contract: 'clued.drill.production-readback/1', startedAt: s, row: r }))} | ConvertFrom-Json;
    @(Get-DrillProductionVerdict $rc $rb | ForEach-Object { $_.pass })`);
  assert.deepEqual(v({ ...row, roles_changed: 1 }), [true, false]);
  assert.deepEqual(v({ ...row, live_sources: [S, '6'.repeat(64)] }), [false, true]);
  assert.equal(psCode(`Get-DrillProductionVerdict (${q(JSON.stringify(receipt))} | ConvertFrom-Json) (${q(JSON.stringify({ contract: 'clued.drill.production-readback/1', startedAt: '2026-01-01T00:00:00Z', row }))} | ConvertFrom-Json)`), 'DRILL_READBACK_NOT_THIS_DRILL');
});

test('the drill without its inputs stops before touching anything', opts, () => {
  const run = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Version', '1.2.3'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 1);
  assert.equal(JSON.parse(run.stdout.trim()).code, 'DRILL_USAGE');
});

test('the guest-side fake credentials match the package fingerprint formulas and print no secret', opts, () => {
  const out = path.join(tmp, 'fake');
  const pub = ps(`New-DrillFakeCredentials ${q(out)}`);
  const ci = fs.readFileSync(path.join(out, 'ci-admission.token'), 'utf8');
  const up = fs.readFileSync(path.join(out, 'resident-upgrade.token'), 'utf8');
  const pem = fs.readFileSync(path.join(out, 'app-key.pem'), 'utf8');
  assert.match(ci, /^clued_bnd_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(ci, up);
  assert.equal(pub.ciTokenPinSha256, fingerprintCiToken(ci));
  assert.equal(pub.upgradeTokenFingerprint, fingerprintCiToken(up));
  assert.equal(pub.appPublicKeySha256Base64, fingerprintAppKey(pem));
  assert.match(pub.ciPrincipalBindingId, /^[0-9a-f-]{36}$/);
  const printed = JSON.stringify(pub);
  for (const secret of [ci, up, pem.split('\n')[1]]) assert.ok(!printed.includes(secret));
  assert.equal(psCode(`New-DrillFakeCredentials ${q(out)}`), 'DRILL_UNEXPECTED', 'never reuses a directory');
});
