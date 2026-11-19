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
import { drillKitManifest, prepareFrom, makeDrillKit, releasePins, readSums } from '../drill/make-drill-kit.mjs';
import { DRILL_PASS_CONCLUSIONS, DRILL_RESERVED, REQUEST_CONTRACT, acceptanceOf, prepare, publish, readAcceptance, requestLineOf, seal } from '../rollout/fleet/publish.mjs';
import { FAKE_GH } from '../rollout/fleet/test/fleet-fixtures.mjs';
import { validateAcceptance } from '../rollout/fleet/install.mjs';
import { writeTar } from '../rollout/fleet/tar.mjs';
import { intakePauseRequest } from '../src/intake-pause.mjs';
import { POLICY_CONTRACT_V8, TRAIN_DEFAULTS } from '../src/policy.mjs';
import { StatusBoard } from '../src/status.mjs';
import { executorFixture, fakeEngine, rawPolicy, triggerBytes, WINDOWS_CLEAN } from './helpers.mjs';

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
    `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $ProgressPreference='SilentlyContinue'; . ${q(script)}; ConvertTo-Json -Depth 12 -Compress -InputObject $(${expr})`], { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout.trim());
}
// The drill code a call stops with (New-DrillError), or null.
function psCode(expr) {
  return ps(`try { ${expr} | Out-Null; $null } catch { (Get-DrillCode $_).code }`);
}
const opts = { skip: !windows };
const idleHostStatus = (writtenAt = new Date().toISOString()) =>
  JSON.stringify({ node: { mode: 'STANDBY' }, executor: { state: 'IDLE' }, current: null, writtenAt });
const activeHostStatus = (hold, { writtenAt = '2026-11-19T02:00:00Z', executor = 'IDLE', reason = null, current = null } = {}) =>
  JSON.stringify({ node: { mode: 'ACTIVE' }, executor: { state: executor, reason }, current, writtenAt,
    intakePause: hold && { until: '2026-11-19T04:00:00Z', holders: [hold] } });
const entryScript = fileURLToPath(new URL('../drill/first-install-entry.ps1', import.meta.url));
const entryPs = expr => ps(`. ${q(entryScript)}; ${expr}`);

test('entry converts only completed bootstrap with valid paths and exit zero into A1 success', opts, () => {
  const r = entryPs(`@(
    (ConvertTo-FirstInstallEntryResult @{ status = 'BOOTSTRAP_DONE' } 0 'C:\\tree' 'C:\\node.exe'),
    (ConvertTo-FirstInstallEntryResult @{ status = 'BOOTSTRAP_REFUSED'; code = 'ASSET_HASH_MISMATCH' } 1 '' ''),
    (ConvertTo-FirstInstallEntryResult @{ status = 'RESTART_THEN_RUN_THE_SAME_COMMAND' } 3 '' ''),
    (ConvertTo-FirstInstallEntryResult @{ status = 'BOOTSTRAP_FIRST_INSTALL_COMPANION_SWITCH_NOT_DONE' } 1 'C:\\tree' 'C:\\node.exe'),
    (ConvertTo-FirstInstallEntryResult $null 0 '' ''),
    (ConvertTo-FirstInstallEntryResult @{ status = 'BOOTSTRAP_DONE' } 1 'C:\\tree' 'C:\\node.exe'),
    (ConvertTo-FirstInstallEntryResult @{ status = 'BOOTSTRAP_DONE' } 0 '' ''),
    (ConvertTo-FirstInstallEntryResult @{ status = 'BOOTSTRAP_DONE'; code = 'FAILED' } 0 'C:\\tree' 'C:\\node.exe'))`);
  assert.deepEqual(r.map(x => x.stopCode), [null, 'ASSET_HASH_MISMATCH', 'RESTART_THEN_RUN_THE_SAME_COMMAND',
    'BOOTSTRAP_FIRST_INSTALL_COMPANION_SWITCH_NOT_DONE', 'DRILL_BOOTSTRAP_NO_VERDICT', 'DRILL_BOOTSTRAP_EXIT_NONZERO',
    'DRILL_BOOTSTRAP_TREE_OR_NODE_MISSING', 'FAILED']);
  assert.equal(r[0].status, 'FIRST_INSTALL_DONE');
  assert.ok(r.slice(1).every(x => x.status === 'FIRST_INSTALL_STOPPED'));
  assert.deepEqual(entryPs(`@((Read-FirstInstallTerminal 'noise'), (Read-FirstInstallTerminal ('noise' + [Environment]::NewLine + '{"status":"BOOTSTRAP_DONE"}')))`),
    [null, { status: 'BOOTSTRAP_DONE' }]);
});

test('A1 reads the actual last stdout line and rejects a zero-exit failure verdict', opts, () => {
  const good = '{"status":"FIRST_INSTALL_DONE","stopCode":null,"tree":"t","node":"n"}';
  assert.equal(ps(`(Read-DrillEntryResult @('noise', ${q(good)}, '') 0).parsed`), true);
  assert.equal(ps(`(Read-DrillEntryResult @(${q(good)}, 'trailing noise') 0).parsed`), false);
  const e = JSON.parse(evidence());
  assert.equal(pass(verdictOf(evidence({ entry: { ...e.entry, status: 'FIRST_INSTALL_STOPPED' } }))).A1, false);
});

test('a declared entry blocker stops the full drill before its host or VM gate', opts, () => {
  const code = psCode(`
    $Version = '1.2.3'; $From = 'unused'; $Kit = 'unused';
    function Read-DrillPrereq { @{ sha256 = 'pin' } }
    function Test-DrillPackageDir { @{ tar = 'unused' } }
    function Read-DrillKit { @{ prereqSha256 = 'pin'; executionBlocker = 'DRILL_BOOTSTRAP_REQUIRES_INTERACTIVE_UNELEVATED_SESSION' } }
    function Get-DrillReleaseFiles { @('unused') }
    function Assert-DrillHost { throw 'HOST_GATE_MUST_NOT_RUN' }
    function Invoke-DrillWithHostHold { throw 'HOST_HOLD_MUST_NOT_RUN' }
    function Get-DrillIntakeTool { throw 'HOST_HOLD_MUST_NOT_RUN' }
    Invoke-DrillMain`);
  assert.equal(code, 'DRILL_FIRST_INSTALL_ENTRY_NOT_READY');
});

test('kit manifest is deterministic, pins exact bytes and uses only guest placeholders', () => {
  const inputs = { payloads: { 'release-pins.json': Buffer.from('{}'), 'first-install-entry.ps1': Buffer.from('entry') },
    prereqBytes: Buffer.from('{"contract":"clued.drill.prereq/1"}\r\n') };
  const manifest = drillKitManifest(inputs);
  assert.deepEqual(drillKitManifest(inputs), manifest);
  assert.equal(manifest.prereqSha256, sha(inputs.prereqBytes));
  // the three bypassed shell points and the companion GitHub token stand-in (Fable renew-key ruling, supplement "token pending"
  // section 1C): what it replaces, why, what it leaves unverified, and that it is never removed. The Expand-Cached stand-in is gone
  // (#1154 fixed the package's function; supplement "companion account and evidence" section 3).
  assert.equal(manifest.perNodeSteps.length, 4);
  assert.match(manifest.perNodeSteps.join(" "), /非提权.*RunAs.*凭据窗口.*陪伴 GitHub 经典令牌替身/);
  assert.match(manifest.perNodeSteps[3], /凭据窗口.*真凭据.*GitHub 接受.*通道.*不可删.*真机首装/);
  assert.doesNotMatch(manifest.perNodeSteps.join(" "), /Expand-Cached|短路径/);
  assert.equal(manifest.prerequisiteMode, 'first-install-host');
  assert.equal(Object.hasOwn(manifest, 'executionBlocker'), false);
  assert.ok(manifest.entry.arguments.every(a => /^(-[A-Za-z]+|\{(from|kit|fake|work|version)\})$/.test(a)));
  for (const f of manifest.files) assert.equal(f.sha256, sha(inputs.payloads[f.path]));
  for (const timeoutMinutes of [4, 241, 5.5]) assert.throws(() => drillKitManifest({ ...inputs, timeoutMinutes }), /TIMEOUT_REFUSED/);
  assert.throws(() => drillKitManifest({ ...inputs, prereqBytes: Buffer.from('{}') }), /PREREQ_CONTRACT_REFUSED/);
  assert.throws(() => readSums(`${'a'.repeat(64)}  x\n${'b'.repeat(64)}  X\n`), /SUMS_REFUSED/);
  assert.throws(() => readSums(`${'a'.repeat(64)}  ../x\n`), /SUMS_REFUSED/);
});

function firstInstallAssets(label, { candidate = false } = {}) {
  const root = path.join(tmp, label); fs.mkdirSync(root);
  for (const d of ['build', 'final', 'images']) fs.mkdirSync(path.join(root, d));
  const version = '1.2.3', tag = `fleet-node-${version}`, id = 'b'.repeat(64);
  const image = `role-image-${id}.tar.gz`;
  const kit = Buffer.from(JSON.stringify({ contract: 'clued.independent-ci.fleet-node-first-install-kit/1', images: { local: [{ id, asset: image }] } }));
  const archive = writeTar([...['bootstrap.ps1', 'prereq-manifest.json'].map(n => ({
    path: `tree/work/independent-ci-resident-v1/rollout/fleet/${n}`,
    data: Buffer.from(n.endsWith('.ps1') ? '# accepted bootstrap\r\n' : JSON.stringify({ items: [
      { fileName: 'wsl.msi', sha256: sha('wsl'), bytes: 3 }, { fileName: 'ubuntu.wsl', sha256: sha('rootfs'), bytes: 6 }
    ], debs: [{ fileName: 'docker.deb', sha256: sha('deb'), bytes: 3 }] })) })),
    { path: 'universal-manifest.json', data: Buffer.from(JSON.stringify({ contract: 'clued.independent-ci.fleet-universal/1', version, commit: 'c'.repeat(40), files: [] })) }]);
  fs.writeFileSync(path.join(root, 'build', `${tag}.tar`), archive);
  fs.writeFileSync(path.join(root, 'build', `${tag}.release.json`), '{}');
  fs.writeFileSync(path.join(root, 'build', 'SHA256SUMS'), `${sha(archive)}  ${tag}.tar\n${sha('{}')}  ${tag}.release.json\n`);
  fs.writeFileSync(path.join(root, 'final', `${tag}.first-install-kit.json`), kit);
  if (!candidate) fs.writeFileSync(path.join(root, 'final', `${tag}.acceptance.json`), JSON.stringify({
    contract: 'clued.independent-ci.fleet-node-acceptance/1', version, archive_sha256: sha(archive), firstInstallKitSha256: sha(kit), ciSourceManifestSha256: 'a'.repeat(64) }));
  fs.writeFileSync(path.join(root, 'images', image), 'fake image fixture');
  const prereq = path.join(root, 'prereq.json');
  fs.writeFileSync(prereq, JSON.stringify({ contract: 'clued.drill.prereq/1',
    wsl: { path: 'wsl.msi', sha256: sha('wsl') }, rootfs: { path: 'ubuntu.wsl', sha256: sha('rootfs') },
    debs: [{ path: 'docker.deb', sha256: sha('deb') }] }));
  for (const [name, bytes] of [['wsl.msi', 'wsl'], ['ubuntu.wsl', 'rootfs'], ['docker.deb', 'deb']]) fs.writeFileSync(path.join(root, name), bytes);
  return { root, build: path.join(root, 'build'), final: path.join(root, 'final'), images: path.join(root, 'images'), version, prereq,
    from: path.join(root, 'from'), out: path.join(root, 'kit') };
}

test('local assembly mirrors publication, preserves originals, builds a kit accepted by drill', async () => {
  const f = firstInstallAssets('assembly-good');
  const before = fs.readFileSync(path.join(f.build, 'SHA256SUMS'));
  prepareFrom({ ...f, out: f.from });
  assert.deepEqual(fs.readFileSync(path.join(f.build, 'SHA256SUMS')), before);
  assert.equal(releasePins(f.from, f.version).files.length, 9);
  assert.equal(releasePins(f.from, f.version).candidate, false);
  assert.equal((await makeDrillKit(f)).candidate, null);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.out, 'kit.json')));
  for (const item of manifest.files) assert.equal(sha(fs.readFileSync(path.join(f.out, item.path))), item.sha256);
  if (windows) {
    assert.equal(ps(`(Read-DrillKit ${q(f.out)}).prerequisiteMode`), 'first-install-host');
    assert.equal(ps(`$p = Test-DrillPackageDir ${q(f.from)} ${q(f.version)}; @(Get-DrillReleaseFiles $p (Read-DrillKit ${q(f.out)})).Count`), 9);
  }
  assert.equal(Object.hasOwn(manifest, 'candidate'), false);
  // an accepted version takes no acceptance request (only a candidate is drilled on one)
  await assert.rejects(() => makeDrillKit({ ...f, out: path.join(f.root, 'kit-with-request'), request: path.join(f.root, 'x.json') }), /DRILL_REQUEST_FOR_AN_ACCEPTED_VERSION/);
  await assert.rejects(() => makeDrillKit(f), /EEXIST/);
  fs.writeFileSync(path.join(f.root, 'wsl.msi'), 'changed');
  await assert.rejects(() => makeDrillKit({ ...f, out: path.join(f.root, 'changed-prereq-kit') }), /PREREQ_CHANGED/);
  assert.ok(!fs.existsSync(path.join(f.root, 'changed-prereq-kit')), 'validate before writing kit');
  fs.appendFileSync(path.join(f.from, `fleet-node-${f.version}.bootstrap.ps1`), '# tampered');
  assert.throws(() => releasePins(f.from, f.version), /ASSET_HASH_MISMATCH/);
  if (windows) assert.equal(psCode(`$p = Test-DrillPackageDir ${q(f.from)} ${q(f.version)}; Get-DrillReleaseFiles $p (Read-DrillKit ${q(f.out)})`), 'DRILL_RELEASE_ASSET_CHANGED');
});

test('assembly rejects a different acceptance, extra assets and missing images', () => {
  const f = firstInstallAssets('assembly-bad'); prepareFrom({ ...f, out: f.from });
  const accPath = path.join(f.from, `fleet-node-${f.version}.acceptance.json`);
  const original = fs.readFileSync(accPath), acc = JSON.parse(original);
  fs.writeFileSync(accPath, JSON.stringify({ ...acc, firstInstallKitSha256: 'c'.repeat(64) }));
  assert.throws(() => releasePins(f.from, f.version), /KIT_NOT_ACCEPTED/);
  fs.writeFileSync(accPath, original);
  fs.writeFileSync(path.join(f.from, 'unlisted.log'), 'x');
  assert.throws(() => releasePins(f.from, f.version), /UNLISTED_ASSET/);
  fs.unlinkSync(path.join(f.from, 'unlisted.log'));
  const img = fs.readdirSync(f.from).find(n => n.startsWith('role-image-'));
  fs.unlinkSync(path.join(f.from, img));
  assert.throws(() => releasePins(f.from, f.version), /ASSET_MISSING/);
});

// Fable ruling 11-19 section 2.3: candidate -> drill PASS -> the Owner accepts once. A From directory with no acceptance is a candidate:
// the kit carries a drill-only acceptance, publish.mjs prepare's acceptance request made an acceptance with the drill's stand-ins
// (publish.mjs acceptanceOf and DRILL_RESERVED, defined there only); the run is held to its three hashes and the receipt names them.
test('a candidate drills on a kit-carried acceptance: the request with the drill stand-ins, held to the candidate\'s bytes', async () => {
  const f = firstInstallAssets('candidate', { candidate: true });
  prepareFrom({ ...f, out: f.from });
  const tag = `fleet-node-${f.version}`, accName = `${tag}.acceptance.json`;
  assert.equal(fs.existsSync(path.join(f.from, accName)), false);
  assert.equal(releasePins(f.from, f.version).candidate, true);
  const tarSha = sha(fs.readFileSync(path.join(f.from, `${tag}.tar`)));
  const kitSha = sha(fs.readFileSync(path.join(f.from, `${tag}.first-install-kit.json`)));
  const U = n => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
  const request = { contract: REQUEST_CONTRACT, version: f.version, archive_sha256: tarSha, commit: 'c'.repeat(40), repository: 'tdoljyj/cross-memory-system',
    ciSourceManifestSha256: S, firstInstallKitSha256: kitSha, fleetRefs: { sourceAcceptanceRef: U(5), hostQualificationRef: U(6), ownerAuthorizationRef: U(5),
      publisherQualificationRef: U(5), ownerPackageAcceptanceRef: U(5), formalRoles: { gitleaks: { image: 'g' }, trivy: { image: 't' }, 'contract-placement': { image: 'c' } } } };
  const requestFile = path.join(f.root, `${tag}.acceptance-request.json`);
  fs.writeFileSync(requestFile, JSON.stringify(request));
  // a candidate needs its request; a request for another package is refused before anything is written
  await assert.rejects(() => makeDrillKit(f), /DRILL_CANDIDATE_REQUEST_REQUIRED/);
  const other = path.join(f.root, 'other', `${tag}.acceptance-request.json`); fs.mkdirSync(path.dirname(other));
  fs.writeFileSync(other, JSON.stringify({ ...request, archive_sha256: '0'.repeat(64) }));
  await assert.rejects(() => makeDrillKit({ ...f, request: other }), /DRILL_CANDIDATE_REQUEST_NOT_THIS_PACKAGE/);
  assert.ok(!fs.existsSync(f.out), 'refused before the kit is written');
  const made = await makeDrillKit({ ...f, request: requestFile });
  assert.deepEqual(made.candidate, { acceptance: accName, tarSha256: tarSha, ciSourceManifestSha256: S, firstInstallKitSha256: kitSha });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.out, 'kit.json'))).candidate, made.candidate);
  const accBytes = fs.readFileSync(path.join(f.out, accName)), acc = JSON.parse(accBytes);
  assert.deepEqual(acc, acceptanceOf(request, DRILL_RESERVED));
  assert.equal(acc.cluedDecision, DRILL_RESERVED.decision); assert.equal(acc.fleetRefs.ownerReceiptRef, DRILL_RESERVED.receipt);
  validateAcceptance(acc);   // what the guest's install.mjs reads, unchanged: no drill mode in the package
  // and the real file the kit carries is never taken for an Owner's acceptance (cross test, ruling renew-key 4.1 row 3)
  await assert.rejects(readAcceptance(path.join(f.out, accName), f.version), { code: 'ACCEPTANCE_IS_THE_DRILLS_STAND_IN' });
  const pins =JSON.parse(fs.readFileSync(path.join(f.out, 'release-pins.json')));
  assert.deepEqual(pins.files.find(x => x.path === accName), { path: accName, sha256: sha(accBytes) });
  assert.ok(JSON.parse(fs.readFileSync(path.join(f.out, 'kit.json'))).files.some(x => x.path === accName && x.sha256 === sha(accBytes)));
  if (windows) {
    const r = ps(`$k = Read-DrillKit ${q(f.out)}; $p = Test-DrillPackageDir ${q(f.from)} ${q(f.version)} $k
      [ordered]@{ candidate = $p.candidate; acceptance = [string]$p.acceptance; kit = $p.firstInstallKitSha256; source = $p.ciSourceManifestSha256
        files = @(Get-DrillReleaseFiles $p $k | ForEach-Object { [string]$_ }) }`);
    assert.equal(r.candidate, true); assert.equal(r.acceptance, path.join(f.out, accName)); assert.equal(r.kit, kitSha); assert.equal(r.source, S);
    assert.equal(r.files.length, 9); assert.ok(r.files.includes(path.join(f.out, accName)));   // the same nine assets, the acceptance the kit's
    // the accepted (old) path is unchanged: without the kit, a From with no acceptance is refused as before
    assert.equal(psCode(`Test-DrillPackageDir ${q(f.from)} ${q(f.version)}`), 'DRILL_PACKAGE_FILE_MISSING');
    // a candidate kit with an acceptance in From too: which one would be meant is not guessed
    fs.copyFileSync(path.join(f.out, accName), path.join(f.from, accName));
    assert.equal(psCode(`Test-DrillPackageDir ${q(f.from)} ${q(f.version)} (Read-DrillKit ${q(f.out)})`), 'DRILL_CANDIDATE_KIT_BUT_FROM_HAS_AN_ACCEPTANCE');
  } else fs.copyFileSync(path.join(f.out, accName), path.join(f.from, accName));
  // an acceptance that names the drill's stand-ins is never taken for an Owner's
  assert.throws(() => releasePins(f.from, f.version), /DRILL_ACCEPTANCE_IS_A_CANDIDATES/);
  // the hashes the kit names are the run's: an acceptance changed after the kit was made is refused
  if (windows) {
    fs.unlinkSync(path.join(f.from, accName));
    fs.writeFileSync(path.join(f.out, accName), JSON.stringify({ ...acc, ciSourceManifestSha256: L }));
    assert.equal(psCode(`Read-DrillKit ${q(f.out)}`), 'DRILL_KIT_FILE_CHANGED');
  }
});

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
  assert.deepEqual(r, { key: ['VK7JG', 'NPHTM', 'C97JM', '9MPGT', '3V66T'].join('-'), ui: 'zh-CN', host: 'CLUED-DRILL', user: 'drill', group: 'Administrators',
    pw: 'p<&>w', hideOnline: 'true', autoLogon: 0, parts: ['EFI', 'MSR', 'Primary'] });
  assert.equal(psCode(`New-DrillAutounattend ''`), 'DRILL_ANSWER_PASSWORD_EMPTY');
  // specialize writes SetupComplete.cmd, which publishes the KVP setup signal once OOBE is over (nothing logs on before it)
  const sig = ps(`$x = [xml](New-DrillAutounattend 'pw'); $ns = @{ u = 'urn:schemas-microsoft-com:unattend' };
    @(Select-Xml -Xml $x -XPath "//u:settings[@pass='specialize']//u:RunSynchronousCommand/u:Path" -Namespace $ns | ForEach-Object { $_.Node.InnerText })`);
  assert.equal(sig, 'cmd.exe /c "if not exist %WINDIR%\\Setup\\Scripts mkdir %WINDIR%\\Setup\\Scripts & echo reg add "HKLM\\SOFTWARE\\Microsoft\\Virtual Machine\\Guest" /v CluedDrillSetup /t REG_SZ /d complete /f>%WINDIR%\\Setup\\Scripts\\SetupComplete.cmd"');
});

test('the setup signal is read from the guest KVP items without logging on', opts, () => {
  const item = (n, d) => `<INSTANCE CLASSNAME="Msvm_KvpExchangeDataItem"><PROPERTY NAME="Data" TYPE="string"><VALUE>${d}</VALUE></PROPERTY><PROPERTY NAME="Name" TYPE="string"><VALUE>${n}</VALUE></PROPERTY><PROPERTY NAME="Source" TYPE="uint16"><VALUE>2</VALUE></PROPERTY></INSTANCE>`;
  const items = [item('OSName', 'Windows 11 Pro'), item('CluedDrillSetup', 'complete')];
  const r = ps(`$i = ${q(JSON.stringify(items))} | ConvertFrom-Json; @((Get-DrillKvpValue $i 'CluedDrillSetup'), [string](Get-DrillKvpValue @($i[0]) 'CluedDrillSetup'), (Get-DrillKvpValue @('not xml', $i[1]) 'CluedDrillSetup'))`);
  assert.deepEqual(r, ['complete', '', 'complete']);
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

test('host duty gate fails closed for active, busy, missing and malformed resident status', opts, () => {
  const r = ps(`@(
    (Test-DrillHostSafety ${q(activeHostStatus(null, { writtenAt: new Date().toISOString() }))} 64GB),
    (Test-DrillHostSafety ${q(idleHostStatus().replace('"IDLE"', '"RUNNING"'))} 64GB),
    (Test-DrillHostSafety ${q(idleHostStatus().replace('"current":null', '"current":{"pr":1153}'))} 64GB),
    (Test-DrillHostSafety $null 64GB), (Test-DrillHostSafety '{broken' 64GB),
    (Test-DrillHostSafety '{}' 64GB),
    (Test-DrillHostSafety '{"node":{"mode":"STANDBY"},"executor":{"state":"IDLE"}}' 64GB),
    (Test-DrillHostSafety ${q(idleHostStatus())} 64GB))`);
  assert.deepEqual(r.map(x => x.code), ['DRILL_HOST_IS_ON_DUTY', 'DRILL_HOST_CI_BUSY', 'DRILL_HOST_CI_BUSY',
    'DRILL_HOST_STATUS_UNREADABLE', 'DRILL_HOST_STATUS_UNREADABLE', 'DRILL_HOST_STATUS_UNREADABLE',
    'DRILL_HOST_STATUS_UNREADABLE', null]);
  assert.ok(r.slice(0, -1).every(x => !x.ok && x.action === 'refuse'));
  assert.equal(r.at(-1).action, 'start');
});

test('an active host with fresh idle status must have its own hold through the required deadline', opts, () => {
  const now = '2026-11-19T02:00:00Z';
  const required = '2026-11-19T03:20:00Z';
  const hold = { holder: 'drill', since: now, until: required };
  const calls = [activeHostStatus(null), activeHostStatus(hold),
    activeHostStatus(hold, { executor: 'PARKED' }), activeHostStatus(hold, { current: { pr: 1170 } }),
    activeHostStatus(hold, { writtenAt: '2026-11-19T01:54:59Z' })];
  const r = ps(`$now = [DateTimeOffset]${q(now)}; $required = [DateTimeOffset]${q(required)}; @(
    ${calls.map(v => `(Test-DrillHostSafety ${q(v)} 64GB -Now $now -HoldUntil $required)`).join(',\n')}
  )`);
  assert.deepEqual(r.map(x => x.action), ['refuse', 'start', 'start', 'refuse', 'refuse']);
  assert.deepEqual(r.map(x => x.code), ['DRILL_HOST_IS_ON_DUTY', null, null, 'DRILL_HOST_CI_BUSY', 'DRILL_HOST_STATUS_STALE']);
});

test('the active runtime gate aborts for a short hold or a different holder', opts, () => {
  const now = '2026-11-19T02:00:00Z';
  const required = '2026-11-19T03:20:00Z';
  const calls = [
    { holder: 'drill', until: '2026-11-19T03:19:59Z' },
    { holder: 'owner', until: required },
    { holder: 'drill', until: required },
  ].map(hold => activeHostStatus({ since: now, ...hold }));
  const r = ps(`$now = [DateTimeOffset]${q(now)}; $required = [DateTimeOffset]${q(required)}; @(
    ${calls.map(v => `(Test-DrillHostSafety ${q(v)} 64GB -Running -Now $now -HoldUntil $required)`).join(',\n')}
  )`);
  assert.deepEqual(r.map(x => x.action), ['abort', 'abort', 'continue']);
});

const gateNow = '2026-11-19T02:00:00Z';
const gateUntil = '2026-11-19T03:20:00Z';
const gateHold = { holder: 'drill', since: gateNow, until: gateUntil };

function gateActions(statuses, { running = true, memory = '64GB' } = {}) {
  const verdicts = ps(`$now = [DateTimeOffset]${q(gateNow)}; $until = [DateTimeOffset]${q(gateUntil)}; @(
    ${statuses.map(status => `(Test-DrillHostSafety ${q(status)} ${memory} -Running:$${running} -Now $now -HoldUntil $until)`).join(',\n')}
  )`);
  return [verdicts].flat().map(x => x.action);
}

test('the active drill continues while the executor is idle with no current batch', opts, () => {
  assert.deepEqual(gateActions([activeHostStatus(gateHold)]), ['continue']);
});

test('the active drill continues while the executor is parked with no current batch', opts, () => {
  assert.deepEqual(gateActions([activeHostStatus(gateHold, { executor: 'PARKED' })]), ['continue']);
});

test('the active drill can start and continue during revoke-only train maintenance', opts, async t => {
  const now = Date.parse(gateNow);
  const board = new StatusBoard({ clock: () => now });
  const policy = rawPolicy({ contract: POLICY_CONTRACT_V8, train: { ...rawPolicy().train, ...TRAIN_DEFAULTS, enabled: 'on' } });
  board.setNode(policy.node.nodeName, policy.sourceManifestSha256, 'ACTIVE');
  let during;
  const engine = fakeEngine({ train: mode => {
    assert.equal(mode, 'revoke-only');
    during = board.snapshot();
    return fakeEngine().runTrainStage(mode);
  } });
  const f = await executorFixture(t, { now, status: board, engine, policy });
  await f.drop(JSON.stringify(intakePauseRequest({ holder: 'drill', minutes: 120, reason: 'drill' }, f.clock)), 'requests');
  await f.exec.tick();
  assert.deepEqual([during.executor.state, during.executor.reason, during.current], ['RUNNING', 'TRAIN_MAINTENANCE', null]);
  assert.deepEqual(gateActions([JSON.stringify(during)], { running: false }), ['start']);
  assert.deepEqual(gateActions([JSON.stringify(during)]), ['continue']);
});

test('the active drill continues from the parked stage-8 start checks through re-parking', opts, async t => {
  const now = Date.parse(gateNow);
  const tenMinutes = 600_000;
  const board = new StatusBoard({ clock: () => now });
  board.setNode(rawPolicy().node.nodeName, rawPolicy().sourceManifestSha256, 'ACTIVE');
  const blocked = { ok: false, code: 'RESIDENT_MERGE_QUEUE_NOT_JOINED', proof: WINDOWS_CLEAN,
    outcome: { status: 'BLOCKED', sideEffects: 0, mayHavePublished: false } };
  const engine = fakeEngine({ stages: { 8: blocked } });
  const f = await executorFixture(t, { now: now - tenMinutes, status: board, engine });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  await f.drop(JSON.stringify(intakePauseRequest({ holder: 'drill', minutes: 120, reason: 'drill' }, f.clock)), 'requests');
  await f.drop(triggerBytes({ pr: 900, headSha: '4'.repeat(40) }));
  assert.equal((await f.exec.tick()).reason, 'INTAKE_PAUSED');
  f.advance(tenMinutes);

  let checking, trying;
  const check = f.exec.batchStartChecks.bind(f.exec);
  f.exec.batchStartChecks = async subject => { checking = board.snapshot(); return check(subject); };
  const run = engine.runStage.bind(engine);
  engine.runStage = async (batch, stage, options) => { trying = board.snapshot(); return run(batch, stage, options); };
  assert.equal((await f.exec.tick()).state, 'PARKED');
  const parked = board.snapshot();
  assert.equal(checking.current, null, 'the start checks have yet to publish a current batch');
  assert.deepEqual([trying.current.stage, trying.current.phase], [8, 'stage']);
  assert.deepEqual([parked.executor.state, parked.current], ['PARKED', null]);

  const sequence = [checking, trying, parked];
  assert.deepEqual(gateActions(sequence.map(s => JSON.stringify(s))), ['continue', 'continue', 'continue']);
  assert.deepEqual(gateActions([JSON.stringify(trying)], { running: false }), ['refuse']);
  for (const intakePause of [null, { ...trying.intakePause, holders: [{ ...gateHold, holder: 'owner' }] }]) {
    assert.deepEqual(gateActions(sequence.map(s => JSON.stringify({ ...s, intakePause }))), ['abort', 'abort', 'abort']);
  }
});

test('the active drill aborts for stages 1–7, unrecognized shapes, stale status or low memory', opts, () => {
  const stage8 = { stage: 8, phase: 'stage' };
  const states = [
    ...Array.from({ length: 7 }, (_, i) => ({ current: { ...stage8, stage: i + 1 } })),
    { current: { pr: 1170 } }, { current: { ...stage8, stage: '8' } }, { current: { stage: 8 } },
    { executor: 'UNKNOWN', current: stage8 }, { executor: 'UNKNOWN' },
    { executor: 'RUNNING', reason: 'OTHER' }, { executor: 'RUNNING', reason: ['TRAIN_MAINTENANCE'] },
    { executor: 'RUNNING', reason: 'TRAIN_MAINTENANCE', current: { pr: 1170 } },
    { executor: 'PARKED', writtenAt: '2026-11-19T01:54:59Z' },
  ];
  assert.deepEqual(gateActions(states.map(s => activeHostStatus(gateHold, s))), states.map(() => 'abort'));
  assert.deepEqual(gateActions([activeHostStatus(gateHold, { current: stage8 })], { memory: '(6GB - 1)' }), ['abort']);
  const standby = [
    { executor: 'PARKED' }, { executor: 'RUNNING', reason: 'TRAIN_MAINTENANCE' }, { current: stage8 },
  ].map(s => activeHostStatus(gateHold, s).replace('"ACTIVE"', '"STANDBY"'));
  assert.deepEqual(gateActions(standby), ['abort', 'abort', 'abort']);
  assert.deepEqual(gateActions(standby, { running: false }), ['refuse', 'refuse', 'refuse']);
});

// What the injected sender is handed for one request, the executable first: forward slashes, so the JS template carries the paths intact.
const intakeArgv = (verb, minutes) => ['C:/clued-drill-test-nowhere/node.exe', 'C:/clued-drill-test-nowhere/rearm-tool.mjs', `request-intake-${verb}`,
  '--root', 'C:/clued-drill-test-nowhere', '--holder', 'drill', '--reason', 'first-install drill', ...(minutes === undefined ? [] : ['--minutes', String(minutes)])].join('|');
test('intake wait timeout releases only the drill hold without starting the VM', opts, () => {
  const r = ps(`
    $script:events = @()
    $script:Drill.IntakeWaitMinutes = 0
    function Read-DrillHostStatus { ${q(activeHostStatus(null))} }
    function Get-DrillTime { [DateTimeOffset]'2026-11-19T02:00:00Z' }
    function Get-DrillIntakeTool { @{ root = 'C:/clued-drill-test-nowhere'; node = 'C:/clued-drill-test-nowhere/node.exe'; tool = 'C:/clued-drill-test-nowhere/rearm-tool.mjs' } }
    function Invoke-DrillNode { throw 'PROCESS_MUST_NOT_START' }
    # the intake request goes through the stand-in the caller injects (the only way a test reaches the hold logic)
    $script:sent = @()
    $script:DrillIntakeSender = { param($Tool, $Verb, $Minutes, $Arguments) $script:events += ('{0}:{1}' -f $Verb, $Minutes); $script:sent += ((@($Tool.node) + @($Arguments)) -join '|')
      @{ exit = 0; stdout = $(if ($Verb -ceq 'pause') { '{"status":"INTAKE_PAUSE_REQUESTED_SERVICE_WILL_HOLD_NEW_BATCHES"}' } else { '{"status":"INTAKE_RESUME_REQUESTED"}' }) } }
    function Start-VM { $script:events += 'start' }
    $code = try { Invoke-DrillWithHostHold 70 { Start-VM }; $null } catch { (Get-DrillCode $_).code }
    @{ code = $code; events = $script:events; sent = @($script:sent) }
  `);
  assert.deepEqual(r, { code: 'DRILL_HOST_CI_BUSY', events: ['pause:80', 'resume:0'], sent: [intakeArgv('pause', 80), intakeArgv('resume')] });
});

test('the active hold covers the whole window and is resumed only after safe cleanup', opts, () => {
  const r = ps(`
    $script:events = @()
    function Read-DrillHostStatus { ${q(activeHostStatus(null, { executor: 'RUNNING' }))} }
    function Get-DrillTime { [DateTimeOffset]'2026-11-19T02:00:00Z' }
    function Get-DrillIntakeTool { @{ root = 'C:/clued-drill-test-nowhere'; node = 'C:/clued-drill-test-nowhere/node.exe'; tool = 'C:/clued-drill-test-nowhere/rearm-tool.mjs' } }
    function Invoke-DrillNode { throw 'PROCESS_MUST_NOT_START' }
    # the intake request goes through the stand-in the caller injects (the only way a test reaches the hold logic)
    $script:sent = @()
    $script:DrillIntakeSender = { param($Tool, $Verb, $Minutes, $Arguments) $script:events += ('{0}:{1}' -f $Verb, $Minutes); $script:sent += ((@($Tool.node) + @($Arguments)) -join '|')
      @{ exit = 0; stdout = $(if ($Verb -ceq 'pause') { '{"status":"INTAKE_PAUSE_REQUESTED_SERVICE_WILL_HOLD_NEW_BATCHES"}' } else { '{"status":"INTAKE_RESUME_REQUESTED"}' }) } }
    function Get-DrillHostSafety($HoldUntil) {
      $script:events += "wait-for:$($HoldUntil.ToString('HH:mm'))"
      @{ ok = $true; holdSince = Get-DrillTime; holdUntil = $HoldUntil }
    }
    $over = try { Invoke-DrillWithHostHold 71 { throw 'must not enter' }; $null } catch { (Get-DrillCode $_).code }
    $null = Invoke-DrillWithHostHold 70 { param($window)
      $script:events += "start:$($window.deadline.ToString('HH:mm'))"
      $window.safeToResume = $false
      $script:events += 'stop-and-restore'
      $window.safeToResume = $true
    }
    $null = Invoke-DrillWithHostHold 70 { param($window)
      $window.safeToResume = $false
      $script:events += 'restore-unconfirmed'
    }
    @{ over = $over; events = $script:events; sent = @($script:sent) }
  `);
  assert.deepEqual(r, { over: 'DRILL_HOST_INTAKE_BUDGET_EXCEEDED', events: [
    'pause:120', 'wait-for:03:20', 'start:03:10', 'stop-and-restore', 'resume:0',
    'pause:120', 'wait-for:03:20', 'restore-unconfirmed',
  ], sent: [intakeArgv('pause', 120), intakeArgv('resume'), intakeArgv('pause', 120)] });
});

test('running guard aborts on duty, batch, unreadable status or memory pressure after a safe start', opts, () => {
  const r = ps(`$idle = ${q(idleHostStatus())}; @(
    (Test-DrillHostSafety $idle 64GB), (Test-DrillHostSafety $idle 64GB -Running),
    (Test-DrillHostSafety ($idle.Replace('"STANDBY"', '"ACTIVE"')) 64GB -Running),
    (Test-DrillHostSafety ($idle.Replace('"IDLE"', '"RUNNING"')) 64GB -Running),
    (Test-DrillHostSafety ($idle.Replace('"IDLE"', '"WAITING"').Replace('"current":null', '"current":{"pr":1153}')) 64GB -Running),
    (Test-DrillHostSafety $null 64GB -Running), (Test-DrillHostSafety $idle (6GB - 1) -Running -MemoryAssigned 8GB),
    (Test-DrillHostSafety $idle 6GB -Running -MemoryAssigned 8GB))`);
  assert.deepEqual(r.map(x => x.action), ['start', 'continue', 'abort', 'abort', 'abort', 'abort', 'abort', 'continue']);
  assert.deepEqual(r.slice(2, 7).map(x => x.code), ['DRILL_HOST_IS_ON_DUTY', 'DRILL_HOST_CI_BUSY',
    'DRILL_HOST_CI_BUSY', 'DRILL_HOST_STATUS_UNREADABLE', 'DRILL_HOST_MEMORY_SHORT']);
});

test('memory threshold includes the whole VM and the boot margin at start and only its unassigned memory at runtime', opts, () => {
  const r = ps(`$idle = ${q(idleHostStatus())}; $m = $script:Drill.BootMarginBytes; @(
    (Test-DrillHostSafety $idle (20GB + $m - 1) -VmMemoryBytes 14GB),
    (Test-DrillHostSafety $idle (20GB + $m) -VmMemoryBytes 14GB -MemoryAssigned 14GB),
    (Test-DrillHostSafety $idle (10GB - 1) -VmMemoryBytes 14GB -Running -MemoryAssigned 10GB),
    (Test-DrillHostSafety $idle 10GB -VmMemoryBytes 14GB -Running -MemoryAssigned 10GB),
    (Test-DrillHostSafety $idle 6GB -VmMemoryBytes 14GB -Running -MemoryAssigned 15GB), $m)`);
  const margin = r.pop() / 1024 ** 3;
  assert.deepEqual(r.map(x => x.action), ['refuse', 'start', 'abort', 'continue', 'continue']);
  assert.deepEqual(r.map(x => x.requiredFreeBytes / 1024 ** 3), [20 + margin, 20 + margin, 10, 10, 6]);
});

test('the duty gate refuses stale, missing and invalid status timestamps', opts, () => {
  const now = Date.now();
  const stamp = (offset) => new Date(now + offset).toISOString();
  const statusAt = (writtenAt) => q(idleHostStatus(writtenAt));
  const r = ps(`$now = [DateTimeOffset]::Parse(${q(stamp(0))}); @(
    (Test-DrillHostSafety ${statusAt(stamp(-300_000))} 64GB -Now $now),
    (Test-DrillHostSafety ${statusAt(stamp(-300_001))} 64GB -Now $now),
    (Test-DrillHostSafety ${statusAt(null)} 64GB -Running -Now $now),
    (Test-DrillHostSafety ${statusAt('12:00')} 64GB -Running -Now $now),
    (Test-DrillHostSafety ${statusAt(stamp(60_001))} 64GB -Running -Now $now))`);
  assert.deepEqual(r.map(x => x.action), ['start', 'refuse', 'abort', 'abort', 'abort']);
  assert.deepEqual(r.map(x => x.code), [null, ...Array(4).fill('DRILL_HOST_STATUS_STALE')]);
});

test('host preflight refuses duty before any Hyper-V or memory query', opts, () => {
  assert.equal(psCode(`
    function Get-DrillHostSafety { Test-DrillHostSafety ${q(activeHostStatus(null, { writtenAt: new Date().toISOString() }))} 64GB }
    function Get-CimInstance { throw 'MUST_NOT_QUERY_HOST' }
    function Get-VMSwitch { throw 'MUST_NOT_QUERY_HYPERV' }
    Assert-DrillHost`), 'DRILL_HOST_IS_ON_DUTY');
});

test('guard latches the reason and shuts down/restores independently of guest waits', opts, () => {
  const r = ps(`
    $state = [hashtable]::Synchronized(@{ stop = $false; ready = $false; armed = $true; failure = $null; executorStates = [ordered]@{} })
    $script:events = @()
    function Get-DrillHostSafety { param([switch]$Running) Test-DrillHostSafety $null 64GB -Running:$Running }
    function Stop-DrillOwnedVm { param([switch]$RestoreCheckpoint) $script:events += "stop-and-restore:$RestoreCheckpoint"; return $true }
    function Write-DrillJson { param($Path, $Value) $script:events += 'receipt'; $script:lastReceipt = $Value }
    Invoke-DrillHostGuardLoop $state 'unused' -RestoreCheckpoint
    @{ failure = $state.failure; ready = $state.ready; events = $script:events; receipt = $script:lastReceipt }`);
  assert.equal(r.failure.code, 'DRILL_HOST_STATUS_UNREADABLE');
  assert.equal(r.ready, true);
  assert.deepEqual(r.events, ['receipt', 'stop-and-restore:True', 'receipt']);
  assert.equal(r.receipt.code, 'DRILL_HOST_STATUS_UNREADABLE');
  assert.equal(r.receipt.restoredToCheckpoint, true);
});

test('the real background guard aborts while the foreground is blocked, without any VM access', opts, () => {
  const fixture = path.join(tmp, 'guard-fixture.ps1');
  const marker = path.join(tmp, 'guard-stopped.txt');
  fs.writeFileSync(fixture, `. ${q(script)}
    $script:DrillScriptPath = $PSCommandPath
    $script:Drill.HostGuardSeconds = 0.1
    $script:guardReads = 0
    function Get-DrillHostSafety {
      param([switch]$Running)
      $script:guardReads++
      $mode = if ($script:guardReads -eq 1) { 'STANDBY' } else { 'ACTIVE' }
      $status = @{ node = @{ mode = $mode }; executor = @{ state = 'IDLE' }; current = $null; writtenAt = [DateTimeOffset]::UtcNow.ToString('o') }
      Test-DrillHostSafety (ConvertTo-DrillJson $status) 64GB -Running:$Running
    }
    function Stop-DrillOwnedVm { param([switch]$RestoreCheckpoint)
      [IO.File]::WriteAllText(${q(marker)}, [string]$RestoreCheckpoint); return $true
    }
  `);
  const r = ps(`. ${q(fixture)}; $guard = $null
    try {
      $guard = Start-DrillHostGuard ${q(tmp)} -RestoreCheckpoint
      $guard.state.armed = $true
      Start-Sleep -Seconds 2
      @{ ready = $guard.state.ready; failure = $guard.state.failure; cleanup = $guard.state.cleanup }
    } finally { Stop-DrillHostGuard $guard }`);
  assert.equal(r.ready, true);
  assert.equal(r.failure.code, 'DRILL_HOST_IS_ON_DUTY');
  assert.equal(r.cleanup.restoredToCheckpoint, true);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'True');
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'host-guard.json'), 'utf8')).code, 'DRILL_HOST_IS_ON_DUTY');
});

test('the drill receipt keeps each executor state first observed during the armed guard', opts, () => {
  const root = fs.mkdtempSync(path.join(tmp, 'guard-history-'));
  const fixture = path.join(root, 'guard-fixture.ps1');
  const hold = { holder: 'drill', since: '2026-11-19T01:59:00Z', until: '2026-11-19T03:59:00Z' };
  const parked = activeHostStatus(hold, { executor: 'PARKED' });
  const stage8 = activeHostStatus(hold, { executor: 'RUNNING', current: { stage: 8, phase: 'stage', batch: 'fixture' } });
  const train = activeHostStatus(hold, { executor: 'RUNNING', reason: 'TRAIN_MAINTENANCE' });
  const stage2 = activeHostStatus(hold, { executor: 'RUNNING', current: { stage: 2, phase: 'stage' } });
  fs.writeFileSync(fixture, `. ${q(script)}
    $script:DrillScriptPath = $PSCommandPath
    $script:Drill.HostGuardSeconds = 0
    $script:guardReads = 0
    $script:samples = @(${[parked, stage8, stage8, train, parked, stage2].map(q).join(', ')})
    function Get-DrillTime { ([DateTimeOffset]'2026-11-19T02:00:00Z').AddSeconds($script:guardReads) }
    function Get-DrillHostSafety {
      param([switch]$Running, [DateTimeOffset]$HoldUntil)
      $sample = if ($Running) {
        $script:samples[$script:guardReads]
        $script:guardReads++
      } else { ${q(activeHostStatus(hold))} }
      Test-DrillHostSafety $sample 64GB -Running:$Running -HoldUntil $HoldUntil -Now (Get-DrillTime)
    }
    function Stop-DrillOwnedVm { param([switch]$RestoreCheckpoint) $true }
  `);
  const receipt = ps(`. ${q(fixture)}
    $script:Drill.Runs = ${q(root)}
    function Assert-DrillHost { @{ freeGB = 64 } }
    function Invoke-DrillBaseline { @{ action = 'reuse' } }
    function Get-DrillVmInfo { @{ vm = @{ Id = [guid]::Empty }; notes = $script:Drill.Marker; state = 'Off'; checkpoints = @($script:Drill.Checkpoint) } }
    function Restore-VMCheckpoint { param($VMName, $Name, [switch]$Confirm) }
    function Start-DrillBootWatchdog { @{ signal = ${q(path.join(root, 'fake-watchdog'))}; process = $null } }
    function Start-DrillGuardedVm { $script:HostGuard.state.armed = $true }
    function Get-DrillCredential { }
    function Wait-DrillGuest { }
    function Invoke-DrillGuest { $true }
    function Invoke-DrillRun {
      $clock = [Diagnostics.Stopwatch]::StartNew()
      while (-not $script:HostGuard.state.failure -and $clock.Elapsed.TotalSeconds -lt 10) { Start-Sleep -Milliseconds 20 }
      Assert-DrillGuard
      throw 'guard did not stop on stage 2'
    }
    $window = @{ deadline = [DateTimeOffset]'2026-11-19T03:00:00Z'; holdUntil = [DateTimeOffset]'2026-11-19T03:10:00Z' }
    $package = @{ version = '1.2.3'; tarSha256 = 'fixture'; ciSourceManifestSha256 = 'fixture' }
    $out = Invoke-DrillPreparedRun $window $package @{ sha256 = 'fixture' } @{ sha256 = 'fixture' }
    Read-DrillJson $out.receipt`);
  assert.equal(receipt.failure.code, 'DRILL_HOST_CI_BUSY');
  assert.equal(receipt.restoredToCheckpoint, true);
  const at = seconds => `2026-11-19T02:00:0${seconds}.0000000+00:00`;
  assert.deepEqual(receipt.evidence.hostExecutorStates, [
    { state: 'PARKED', reason: null, current: null, firstSeenAt: at(1) },
    { state: 'RUNNING', reason: null, current: { stage: 8, phase: 'stage' }, firstSeenAt: at(2) },
    { state: 'RUNNING', reason: 'TRAIN_MAINTENANCE', current: null, firstSeenAt: at(4) },
    { state: 'RUNNING', reason: null, current: { stage: 2, phase: 'stage' }, firstSeenAt: at(6) },
  ]);
});

// A job of our own that refuses breakaway (KILL_ON_JOB_CLOSE only), like the agent session job a real drill runs in.
const drillTestJob = `Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class DrillTestJob {
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits {
    public BasicLimits Basic;
    public ulong Reads, Writes, Other, ReadBytes, WrittenBytes, OtherBytes;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr job);
  public static IntPtr Create() {
    var job = CreateJobObject(IntPtr.Zero, IntPtr.Zero);
    if (job == IntPtr.Zero) throw new Win32Exception();
    var limits = new ExtendedLimits();
    limits.Basic.Flags = 0x00002000;
    if (SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) return job;
    var error = new Win32Exception();
    CloseHandle(job);
    throw error;
  }
}
'@`;

test('the boot watchdog still runs checkpoint cleanup after its parent job is terminated', opts, () => {
  const root = fs.mkdtempSync(path.join(tmp, 'boot-watchdog-'));
  const fixture = path.join(root, 'boot-fixture.ps1');
  const host = path.join(root, 'host.ps1');
  const ready = path.join(root, 'host-ready');
  const start = path.join(root, 'start');
  const cleanup = path.join(root, 'restored');
  const vmId = '8f87dbcb-9fbc-4fd6-adc4-7c6345192c50';
  fs.writeFileSync(fixture, `. ${q(script)}
    $script:DrillScriptPath = $PSCommandPath
    $script:Drill.BootMutex = ${q(`Local\\DrillWatchdogTest-${path.basename(root)}`)}
    function Get-DrillVmInfo { @{ vm = @{ Id = [guid]'${vmId}' }; notes = $script:Drill.Marker; state = 'Running' } }
    function Stop-DrillOwnedVm {
      param([switch]$RestoreCheckpoint)
      [IO.File]::WriteAllText(${q(cleanup)}, [string]$RestoreCheckpoint)
      $true
    }
  `);
  fs.writeFileSync(host, `. ${q(fixture)}
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Path -LiteralPath ${q(start)})) {
      if ($clock.Elapsed.TotalSeconds -ge 15) { throw 'test job not ready' }
      Start-Sleep -Milliseconds 20
    }
    $watchdog = Start-DrillBootWatchdog ${q(root)} '${vmId}' ([DateTimeOffset]::UtcNow.AddSeconds(30))
    [IO.File]::WriteAllText("$($watchdog.signal).starting", '')
    [IO.File]::WriteAllText(${q(ready)}, '')
    Start-Sleep -Seconds 30
  `);
  const result = ps(`
    ${drillTestJob}
    $job = [DrillTestJob]::Create()
    $worker = $null
    try {
      $worker = Start-Process -FilePath ${q(powershell)} -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + ${q(host)} + '"'))
      if (-not [DrillTestJob]::AssignProcessToJobObject($job, $worker.Handle)) { throw [ComponentModel.Win32Exception]::new() }
      [IO.File]::WriteAllText(${q(start)}, '')
      $clock = [Diagnostics.Stopwatch]::StartNew()
      while (-not (Test-Path -LiteralPath ${q(ready)})) {
        if ($worker.HasExited -or $clock.Elapsed.TotalSeconds -ge 20) { throw 'watchdog did not become ready in the fixture' }
        Start-Sleep -Milliseconds 20
      }
      if (-not [DrillTestJob]::CloseHandle($job)) { throw [ComponentModel.Win32Exception]::new() }
      $job = [IntPtr]::Zero
      $terminated = $worker.WaitForExit(3000)
      $clock.Restart()
      while (-not (Test-Path -LiteralPath ${q(cleanup)}) -and $clock.Elapsed.TotalSeconds -lt 5) { Start-Sleep -Milliseconds 20 }
      @{ terminated = $terminated; cleanup = (Test-Path -LiteralPath ${q(cleanup)}) }
    } finally {
      if ($job -ne [IntPtr]::Zero) { [void][DrillTestJob]::CloseHandle($job) }
      if ($worker) { $worker.Dispose() }
    }`);
  assert.deepEqual(result, { terminated: true, cleanup: true });
  assert.equal(fs.readFileSync(cleanup, 'utf8'), 'True');
});

test('the boot watchdog is never started by job breakaway', () => {
  const source = fs.readFileSync(script, 'utf8');
  assert.doesNotMatch(source, /0x0*1000000\b|BREAKAWAY_FROM_JOB|BreakawayFromJob/i);
});

test('a watchdog that exits after signalling ready never lets the VM start', opts, () => {
  const root = fs.mkdtempSync(path.join(tmp, 'watchdog-exit-'));
  const fake = path.join(root, 'fake-watchdog.ps1');
  fs.writeFileSync(fake, `[IO.File]::WriteAllText($args[0], ''); Start-Sleep -Milliseconds 1500`);
  const r = ps(`
    $script:starts = 0; $script:fakeWatch = $null
    function Start-VM { param($Name, $ErrorAction) $script:starts++ }
    function Get-DrillHostSafety { @{ ok = $true } }
    function Get-DrillVmInfo { @{ vm = @{ Id = [guid]::Empty }; notes = $script:Drill.Marker; state = 'Off'; checkpoints = @($script:Drill.Checkpoint) } }
    function Restore-VMCheckpoint { param($VMName, $Name, $Confirm) }
    function Assert-DrillHost { }
    function Start-DrillHostGuard { param($RunDir, [switch]$RestoreCheckpoint, $Window)
      $state = [hashtable]::Synchronized(@{ ready = $true; armed = $false; failure = $null; executorStates = [ordered]@{} })
      $script:HostGuard = @{ state = $state; pending = @{ IsCompleted = $false } }
      return $script:HostGuard
    }
    function Stop-DrillHostGuard { param($Guard) $script:HostGuard = $null }
    function Start-DrillDetachedWatchdog {
      $p = Start-Process -FilePath ${q(powershell)} -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile', '-NonInteractive',
        '-ExecutionPolicy', 'Bypass', '-File', ('"' + ${q(fake)} + '"'), ('"' + ${q(path.join(root, 'guest-shutdown.ready'))} + '"'))
      $script:fakeWatch = [Diagnostics.Process]::GetProcessById($p.Id)
      return $p
    }
    # The watchdog exits after its ready signal was read and before the boot.
    function Get-DrillGuardSafety { param($State) [void]$script:fakeWatch.WaitForExit(15000); @{ ok = $true } }
    function Add-DrillExecutorObservation { }
    function Get-DrillCredential { }
    function Wait-DrillGuest { }
    function Invoke-DrillGuest { $true }
    function Stop-DrillOwnedVm { param([switch]$RestoreCheckpoint) $true }
    $outcome = Invoke-DrillOnCheckpoint { 'booted' } ${q(root)} @{ safeToResume = $true; deadline = [DateTimeOffset]::UtcNow.AddMinutes(10); holdUntil = [DateTimeOffset]::MinValue }
    @{ starts = $script:starts; result = $outcome.result; failure = $outcome.failure; exited = $script:fakeWatch.HasExited }`);
  assert.equal(r.exited, true);
  assert.equal(r.starts, 0);
  assert.equal(r.result, null);
  assert.equal(r.failure.code, 'DRILL_GUEST_SHUTDOWN_WATCHDOG_NOT_READY');
  assert.equal(r.failure.detail.code, 'DRILL_WATCHDOG_EXITED_BEFORE_BOOT');
});

test('the watchdog launcher never terminates a process it cannot tie to this launch', opts, () => {
  const r = ps(`
    $decoy = Start-Process -FilePath ${q(powershell)} -WindowStyle Hidden -PassThru -ArgumentList '-NoProfile -NonInteractive -Command Start-Sleep -Seconds 20'
    try {
      # WMI hands back a PID that now belongs to someone else (the launched process exited and the PID was reused).
      function Invoke-CimMethod { param($ClassName, $MethodName, $Arguments, $OperationTimeoutSec, $ErrorAction) [pscustomobject]@{ ReturnValue = 0; ProcessId = $decoy.Id } }
      $c = try { [void](Start-DrillDetachedWatchdog 'AAAA' ([Diagnostics.Stopwatch]::StartNew())); $null } catch { Get-DrillCode $_ }
      @{ code = (Get-Prop $c 'code'); alive = (-not $decoy.HasExited) }
    } finally { if (-not $decoy.HasExited) { $decoy.Kill() }; $decoy.Dispose() }`);
  assert.deepEqual(r, { code: 'DRILL_WATCHDOG_IDENTITY_UNCONFIRMED', alive: true });
});

test('a launched watchdog found inside a job is terminated and confirmed gone before the refusal', opts, () => {
  const encoded = Buffer.from('Start-Sleep -Seconds 20', 'utf16le').toString('base64');
  const r = ps(`
    ${drillTestJob}
    $job = [DrillTestJob]::Create()
    $decoy = Start-Process -FilePath ${q(powershell)} -WindowStyle Hidden -PassThru -ArgumentList '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}'
    try {
      if (-not [DrillTestJob]::AssignProcessToJobObject($job, $decoy.Handle)) { throw [ComponentModel.Win32Exception]::new() }
      function Invoke-CimMethod { param($ClassName, $MethodName, $Arguments, $OperationTimeoutSec, $ErrorAction) [pscustomobject]@{ ReturnValue = 0; ProcessId = $decoy.Id } }
      $c = try { [void](Start-DrillDetachedWatchdog '${encoded}' ([Diagnostics.Stopwatch]::StartNew())); $null } catch { Get-DrillCode $_ }
      @{ code = (Get-Prop $c 'code'); inJob = (Get-Prop $c 'detail.inJob'); terminated = (Get-Prop $c 'detail.terminated'); exited = $decoy.HasExited }
    } finally {
      if (-not $decoy.HasExited) { $decoy.Kill() }
      $decoy.Dispose()
      [void][DrillTestJob]::CloseHandle($job)
    }`);
  assert.deepEqual(r, { code: 'DRILL_WATCHDOG_IN_JOB', inJob: true, terminated: true, exited: true });
});

test('asking WMI for the watchdog is bounded by the ready budget and fails by name', opts, () => {
  const root = fs.mkdtempSync(path.join(tmp, 'watchdog-wmi-'));
  const r = ps(`
    $script:timeout = $null
    function Invoke-CimMethod { param($ClassName, $MethodName, $Arguments, $OperationTimeoutSec, $ErrorAction) $script:timeout = $OperationTimeoutSec; throw 'WMI did not answer' }
    $c = try { [void](Start-DrillBootWatchdog ${q(root)} ([guid]::Empty) ([DateTimeOffset]::UtcNow.AddMinutes(1))); $null } catch { Get-DrillCode $_ }
    @{ code = (Get-Prop $c 'code'); inner = (Get-Prop $c 'detail.code'); timeout = $script:timeout }`);
  assert.deepEqual(r, { code: 'DRILL_GUEST_SHUTDOWN_WATCHDOG_NOT_READY', inner: 'DRILL_WATCHDOG_WMI_CREATE_FAILED', timeout: 15 });
});

test('host reader uses only the pinned status file and accounts for an existing larger VM', opts, () => {
  // the pinned file is the production one; under test the reader is pointed at a fixture (the production root refuses a test, below)
  const fixture = path.join(tmp, 'host-status-fixture.json');
  const r = ps(`
    $pinned = $script:Drill.HostStatus
    $script:Drill.HostStatus = ${q(fixture)}
    function Get-Content { param($LiteralPath, [switch]$Raw, $Encoding, $ErrorAction)
      $script:readPath = $LiteralPath
      return ${q(idleHostStatus())}
    }
    function Get-CimInstance { param($ClassName, $OperationTimeoutSec, $ErrorAction) @{ FreePhysicalMemory = $script:freeBytes / 1KB } }
    function Get-VM { param($ErrorAction) @{ Name = $script:Drill.VmName; Notes = $script:Drill.Marker; MemoryStartup = 14GB; MemoryAssigned = $script:assignedBytes } }
    function Get-Process { param($ErrorAction) [pscustomobject]@{ ProcessName = 'Runner.Listener' } }
    function Get-DrillRunnerDistributions { param($HostName) }
    $script:freeBytes = 20GB + $script:Drill.BootMarginBytes; $script:assignedBytes = 0
    $safety = Get-DrillHostSafety
    $script:freeBytes = 10GB; $script:assignedBytes = 10GB
    $running = Get-DrillHostSafety -Running
    @{ pinned = $pinned; path = $script:readPath; safety = $safety; running = $running; margin = $script:Drill.BootMarginBytes }
  `);
  assert.equal(r.pinned, 'C:\\ProgramData\\CluedIndependentCI\\resident\\state\\status.json');
  assert.equal(r.path, fixture);
  assert.equal(r.safety.requiredFreeBytes, 20 * 1024 ** 3 + r.margin);
  assert.equal(r.safety.ok, true);
  assert.equal(r.running.requiredFreeBytes, 10 * 1024 ** 3);
  assert.equal(r.running.action, 'continue');
});

// Clued Task fe8a2cbf (Fable renew-key ruling, supplements "test touching production" and "the test guard criterion"): the one dangerous
// act of the drill toward the host is executing the installed intake tool, which writes a request the service acts on. Under a test
// marker (NODE_TEST_CONTEXT, given by the node test runner to every test process and inherited by its children, or CLUED_UNDER_TEST)
// Request-DrillIntake never executes a tool, whatever the paths: no path is judged. A test that needs the hold logic injects the sender
// ($script:DrillIntakeSender). Reading the host status and locating the tool are read-only and not fenced. Red safely: the real
// Request-DrillIntake points at a fake tool in a temporary directory that only writes a mark file there.
test('under a test marker Request-DrillIntake never executes a tool: refused before any process, the fake tool never ran', opts, () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'the test runner marks this process');
  const dir = fs.mkdtempSync(path.join(tmp, 'fake-intake-'));
  const mark = path.join(dir, 'tool-ran.mark');
  const fakeTool = path.join(dir, 'fake-rearm-tool.mjs');
  fs.writeFileSync(fakeTool, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(mark)}, 'ran');
console.log(JSON.stringify({ status: process.argv[2] === 'request-intake-pause' ? 'INTAKE_PAUSE_REQUESTED_SERVICE_WILL_HOLD_NEW_BATCHES' : 'INTAKE_RESUME_REQUESTED' }));`);
  const tool = `@{ root = ${q(dir)}; node = ${q(process.execPath)}; tool = ${q(fakeTool)} }`;
  const r = ps(`
    $codeOf = { param($b) try { $null = & $b; 'NOT_REFUSED' } catch { (Get-DrillCode $_).code } }
    $out = [ordered]@{ pause = (& $codeOf { Request-DrillIntake ${tool} pause 80 }); resume = (& $codeOf { Request-DrillIntake ${tool} resume 0 }) }
    $env:NODE_TEST_CONTEXT = $null; $env:CLUED_UNDER_TEST = '1'
    $out.cluedMarker = (& $codeOf { Request-DrillIntake ${tool} resume 0 })
    $out`);
  assert.deepEqual({ ...r, toolRan: fs.existsSync(mark) },
    { pause: 'DRILL_HOST_ACCESS_UNDER_TEST', resume: 'DRILL_HOST_ACCESS_UNDER_TEST', cluedMarker: 'DRILL_HOST_ACCESS_UNDER_TEST', toolRan: false });
  // under a marker an injected sender is the way a test reaches the hold logic (without one it is refused, below); it is handed the argv the real tool would get
  const sent = ps(`$script:sent = @()
    $script:DrillIntakeSender = { param($Tool, $Verb, $Minutes, $Arguments) $script:sent += ,@($Verb, $Minutes, ($Arguments -join ' ')); @{ exit = 0; stdout = '{"status":"INTAKE_RESUME_REQUESTED"}' } }
    Request-DrillIntake ${tool} resume 0
    ,@($script:sent)`);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].slice(0, 2), ['resume', 0]);
  assert.equal(fs.existsSync(mark), false);
  // the guard comes before the tool could run, and no path of the host is judged any more (no list of root spellings to keep)
  const text = fs.readFileSync(script, 'utf8');
  const start = text.indexOf('function Request-DrillIntake'), body = text.slice(start, text.indexOf('\n}', start));
  const marker = body.indexOf('NODE_TEST_CONTEXT'), node = body.indexOf('Invoke-DrillNode');
  assert.ok(marker > 0 && node > marker, 'Request-DrillIntake refuses under a marker before Invoke-DrillNode');
  for (const gone of ['Test-DrillProductionPath', 'Get-DrillPathSegments', 'Assert-DrillNotProductionUnderTest', 'ProductionRoot']) assert.ok(!text.includes(gone), gone);
});

// Codex review r5: the stand-in is only a test's. Without a marker an injected sender is refused by name (neither it nor the real tool
// runs: production never takes a request from something injected); under a marker the refusal comes before the tool record is read, so
// an empty record gets the same code.
test('a sender is used only under a test marker; without one it is refused, and an empty tool record is refused first', opts, () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'fake-intake-nomark-'));
  const mark = path.join(dir, 'tool-ran.mark');
  const fakeTool = path.join(dir, 'fake-rearm-tool.mjs');
  fs.writeFileSync(fakeTool, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(mark)}, 'ran'); console.log(JSON.stringify({ status: 'INTAKE_RESUME_REQUESTED' }));`);
  const r = ps(`
    $codeOf = { param($b) try { $null = & $b; 'NOT_REFUSED' } catch { (Get-DrillCode $_).code } }
    $script:senderCalls = 0
    $script:DrillIntakeSender = { param($Tool, $Verb, $Minutes, $Arguments) $script:senderCalls++; @{ exit = 0; stdout = '{"status":"INTAKE_RESUME_REQUESTED"}' } }
    Remove-Item Env:NODE_TEST_CONTEXT, Env:CLUED_UNDER_TEST -ErrorAction SilentlyContinue
    $noMarker = & $codeOf { Request-DrillIntake @{ root = ${q(dir)}; node = ${q(process.execPath)}; tool = ${q(fakeTool)} } resume 0 }
    $env:CLUED_UNDER_TEST = '1'; $script:DrillIntakeSender = $null
    [ordered]@{ noMarker = $noMarker; senderCalls = $script:senderCalls
      emptyRecord = (& $codeOf { Request-DrillIntake $null resume 0 }); emptyHash = (& $codeOf { Request-DrillIntake @{} pause 80 }) }`);
  assert.deepEqual({ ...r, toolRan: fs.existsSync(mark) }, { noMarker: 'DRILL_INTAKE_SENDER_WITHOUT_TEST_MARKER', senderCalls: 0,
    emptyRecord: 'DRILL_HOST_ACCESS_UNDER_TEST', emptyHash: 'DRILL_HOST_ACCESS_UNDER_TEST', toolRan: false });
  // the marker check is the first thing Request-DrillIntake does
  const text = fs.readFileSync(script, 'utf8');
  const start = text.indexOf('function Request-DrillIntake'), body = text.slice(start, text.indexOf('\n}', start));
  assert.ok(body.indexOf('NODE_TEST_CONTEXT') < body.indexOf('Get-DrillIntakeArguments'), 'the marker is checked before the record is read');
});

// The argv of an intake request, apart from its execution (a pure function): node is the executable, the tool its first argument.
test('the intake request argv: the tool, the verb, the root, the drill holder; minutes only with a pause', opts, () => {
  const r = ps(`$t = @{ root = 'R:\\root'; node = 'N:\\node.exe'; tool = 'T:\\rearm-tool.mjs' }
    @{ pause = (Get-DrillIntakeArguments $t pause 80); resume = (Get-DrillIntakeArguments $t resume 0) }`);   // the function returns the array whole
  assert.deepEqual(r.pause, ['T:\\rearm-tool.mjs', 'request-intake-pause', '--root', 'R:\\root', '--holder', 'drill', '--reason', 'first-install drill', '--minutes', '80']);
  assert.deepEqual(r.resume, ['T:\\rearm-tool.mjs', 'request-intake-resume', '--root', 'R:\\root', '--holder', 'drill', '--reason', 'first-install drill']);
  assert.ok(!r.pause.includes('N:\\node.exe') && !r.resume.includes('N:\\node.exe'), 'node is the executable, not an argument');
});

test('the start gate never calls Start-VM when the guard failed or has not become ready', opts, () => {
  const r = ps(`
    $script:starts = 0
    function Start-VM { param($Name, $ErrorAction) $script:starts++ }
    function Get-DrillHostSafety { @{ ok = $true } }
    $state = [hashtable]::Synchronized(@{ ready = $true; armed = $false; failure = @{ code = 'DRILL_HOST_IS_ON_DUTY'; detail = 'test' } })
    $script:HostGuard = @{ state = $state; pending = @{ IsCompleted = $false } }
    $failed = try { Start-DrillGuardedVm; $null } catch { (Get-DrillCode $_).code }
    $state.ready = $false; $state.failure = $null
    $unready = try { Start-DrillGuardedVm; $null } catch { (Get-DrillCode $_).code }
    @{ failed = $failed; unready = $unready; starts = $script:starts; armed = $state.armed }`);
  assert.deepEqual(r, { failed: 'DRILL_HOST_IS_ON_DUTY', unready: 'DRILL_HOST_GUARD_FAILED', starts: 0, armed: false });
});

test('checkpoint caller discards a result after a guard failure and restores the checkpoint', opts, () => {
  const r = ps(`
    $script:restores = 0
    function Get-DrillRunnerDistributions { param($HostName) }
    function Get-DrillHostSafety { @{ ok = $true } }
    function Get-DrillVmInfo { @{ vm = @{ Id = [guid]::Empty }; notes = $script:Drill.Marker; state = 'Off'; checkpoints = @($script:Drill.Checkpoint) } }
    function Restore-VMCheckpoint { param($VMName, $Name, $Confirm) }
    function Assert-DrillHost { }
    function Start-DrillHostGuard { param($RunDir, [switch]$RestoreCheckpoint)
      $script:HostGuard = @{ state = @{ ready = $true; failure = $null; executorStates = [ordered]@{} }; pending = @{ IsCompleted = $false } }
      return $script:HostGuard
    }
    function Stop-DrillHostGuard { param($Guard) $script:HostGuard = $null }
    function Start-DrillGuardedVm { }
    function Start-DrillBootWatchdog { @{ signal = ${q(path.join(tmp, 'checkpoint-test'))}; process = $null } }
    function Get-DrillCredential { }
    function Wait-DrillGuest { }
    function Invoke-DrillGuest { $true }
    function Stop-DrillOwnedVm { param([switch]$RestoreCheckpoint) if ($RestoreCheckpoint) { $script:restores++ }; return $true }
    $outcome = Invoke-DrillOnCheckpoint {
      $script:HostGuard.state.failure = @{ code = 'DRILL_HOST_IS_ON_DUTY'; detail = 'test' }
      'discard this result'
    } 'unused' @{ safeToResume = $true; deadline = [DateTimeOffset]::UtcNow.AddMinutes(10); holdUntil = [DateTimeOffset]::MinValue }
    @{ outcome = $outcome; restores = $script:restores }`);
  assert.equal(r.outcome.preBoot.release.failed, null);
  delete r.outcome.preBoot;
  assert.deepEqual(r.outcome, { result: null, failure: { code: 'DRILL_HOST_IS_ON_DUTY', detail: 'test' }, restored: true, hostExecutorStates: [] });
  assert.equal(r.restores, 1);
});

test('an EndInvoke exception leaves a failed receipt after the owned VM is stopped and restored', opts, () => {
  const r = ps(`
    $script:events = @(); $script:vm = @{ State = 'Off'; Id = [guid]::Empty }
    $script:Drill.Runs = ${q(tmp)}
    $Version = '1.2.3'; $From = 'fixture'; $Kit = 'fixture'
    function Read-DrillPrereq { @{ sha256 = 'prereq' } }
    function Test-DrillPackageDir { @{ version = '1.2.3'; tarSha256 = 'tar'; ciSourceManifestSha256 = 'source' } }
    function Read-DrillKit { @{ sha256 = 'kit'; prereqSha256 = 'prereq'; executionBlocker = $null } }
    function Get-DrillReleaseFiles { }
    function Assert-DrillHost { @{ freeGB = 16 } }
    function Invoke-DrillBaseline { @{ action = 'ready' } }
    function Read-DrillHostStatus { ${q(idleHostStatus())} }
    function Get-DrillHostSafety { @{ ok = $true } }
    function Get-DrillVmInfo { @{ vm = $script:vm; notes = 'clued.drill-vm/1'; state = $script:vm.State; checkpoints = @($script:Drill.Checkpoint) } }
    function Get-VM { param($Name) $script:vm }
    function Restore-VMCheckpoint { param($VMName, $Name, [switch]$Confirm) $script:events += 'restore' }
    function Stop-VM { param($VM, [switch]$TurnOff, [switch]$Force) $VM.State = 'Off'; $script:events += 'stop' }
    function Start-DrillHostGuard { param($RunDir, [switch]$RestoreCheckpoint)
      $worker = [pscustomobject]@{}
      $worker | Add-Member ScriptMethod EndInvoke { $script:events += 'end'; throw 'mock EndInvoke failure' }
      $worker | Add-Member ScriptMethod Dispose { $script:events += 'dispose' }
      $script:HostGuard = @{ worker = $worker; state = [hashtable]::Synchronized(@{ ready = $true; armed = $true; failure = $null; executorStates = [ordered]@{} }); pending = @{ IsCompleted = $false } }
      return $script:HostGuard
    }
    function Start-DrillGuardedVm { $script:vm.State = 'Running' }
    function Start-DrillBootWatchdog { @{ signal = ${q(path.join(tmp, 'endinvoke-test'))}; process = $null } }
    function Get-DrillCredential { }
    function Wait-DrillGuest { }
    function Invoke-DrillGuest { $true }
    function Invoke-DrillRun { 'discard this result' }
    $outcome = try { Invoke-DrillMain } catch { Get-DrillCode $_ }
    $receipt = if (Get-Prop $outcome 'receipt') { Read-DrillJson $outcome.receipt }
    @{ conclusion = (Get-Prop $receipt 'conclusion'); failure = (Get-Prop $receipt 'failure'); restored = (Get-Prop $receipt 'restoredToCheckpoint');
       events = $script:events; guardCleared = ($null -eq $script:HostGuard) }`);
  assert.deepEqual(r.events, ['restore', 'stop', 'restore', 'end', 'dispose']);
  assert.equal(r.restored, true);
  assert.equal(r.conclusion, 'FAIL');
  assert.equal(r.failure.code, 'DRILL_HOST_GUARD_FAILED');
  assert.match(JSON.stringify(r.failure.detail), /mock EndInvoke failure/);
  assert.equal(r.guardCleared, true);
});

test('the only Start-VM command is inside Start-DrillGuardedVm', opts, () => {
  const r = ps(`
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile(${q(script)}, [ref]$tokens, [ref]$errors)
    @{ owners = @($ast.FindAll({
      param($node)
      $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Start-VM'
    }, $true) | ForEach-Object {
      $parent = $_.Parent
      while ($parent -and $parent -isnot [Management.Automation.Language.FunctionDefinitionAst]) { $parent = $parent.Parent }
      if ($parent) { $parent.Name } else { '<script>' }
    }) }`);
  assert.deepEqual(r.owners, ['Start-DrillGuardedVm']);
});

test('guest shutdown timer uses the same deadline after a reboot without touching live tasks', opts, () => {
  const r = ps(`
    function New-ScheduledTaskAction($Execute, $Argument) {
      $encoded = ($Argument -split ' ')[-1]
      $script:shutdown = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded))
      return 'action'
    }
    function New-ScheduledTaskTrigger([switch]$Once, [datetime]$At, [switch]$AtStartup) {
      if ($Once) { return 'once' }; if ($AtStartup) { return 'startup' }
    }
    function New-ScheduledTaskSettingsSet { return 'settings' }
    function Register-ScheduledTask($TaskName, $Action, $Trigger, $Settings, $User, $ErrorAction) {
      $script:task = @{ name = $TaskName; user = $User; triggers = $Trigger }
    }
    $deadline = [DateTimeOffset]::UtcNow.AddMinutes(30).ToString('o')
    $result = & $script:GuestShutdownTimer $deadline $env:COMPUTERNAME
    @{ armed = $result; task = $script:task; deadline = $deadline; shutdown = $script:shutdown }
  `);
  assert.equal(r.armed, true);
  assert.deepEqual(r.task, { name: 'CluedDrillGuestShutdown', user: 'SYSTEM', triggers: ['once', 'startup'] });
  assert.ok(r.shutdown.includes(r.deadline));
  assert.match(r.shutdown, /shutdown\.exe" \/s \/f \/t 0/);
});

test('M5 collects the six public observations and requires the host checker for an applicable package', opts, () => {
  const root = path.join(tmp, 'm5-guest');
  const resident = path.join(root, 'resident');
  const runDir = path.join(tmp, 'm5-run');
  const put = (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  };
  const profile = { ownerSid: 'S-1-5-21-1-2-3-4', controllerSid: 'S-1-5-21-1-2-3-5' };
  put(path.join(resident, 'record', 'acceptance.json'), { node: { ...profile, privateField: 'not exported' } });
  put(path.join(resident, 'broker', 'renew-key.json'), { source: 'system' });
  put(path.join(resident, 'state', 'renew-key-resident.json'), { source: 'resident' });
  put(path.join(root, 'state', 'v2', 'receipts', 'renew-key-controller.json'), { source: 'controller' });
  put(path.join(resident, 'mailbox', 'responses', 'renew-key.json'), { source: 'companion' });
  put(path.join(resident, 'broker', 'renew-ci.json'), { at: '2026-11-19T01:00:00Z', code: 'RENEW_GATEWAY_UNAVAILABLE' });
  const probe = { at: '2026-11-19T02:00:00Z', code: 'RENEW_IDENTITY_REFUSED' };
  put(path.join(resident, 'broker', 'renew-upgrade.json'), probe);
  fs.mkdirSync(runDir);

  const simulatedHost = path.join(tmp, 'm5-host');
  fs.mkdirSync(path.join(simulatedHost, 'test'), { recursive: true });
  const runM5 = () => ps(`
    $script:Drill.GuestRoot = ${q(resident)}
    $script:DrillScriptPath = ${q(path.join(simulatedHost, 'drill', 'drill-vm.ps1'))}
    function Invoke-DrillGuest { param($cred, $block, $ArgumentList, $TimeoutMinutes, $Step) & $block $ArgumentList }
    $runDir = ${q(runDir)}
    $m5 = if (Test-Path (Join-Path $runDir 'm5')) { @{ directory = 'm5'; missing = @(); collectionCode = $null } } else { Copy-DrillM5 $runDir $null }
    Get-DrillM5Verdict $runDir $m5
  `);
  const absent = runM5();
  assert.deepEqual(absent, { directory: 'm5', missing: [], collectionCode: null,
    result: 'FAIL', detail: 'DRILL_M5_HOST_CHECKER_MISSING' });
  assert.deepEqual(fs.readdirSync(path.join(runDir, 'm5')).sort(),
    ['companion.json', 'controller.json', 'probe.json', 'profile.json', 'resident.json', 'system.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'm5', 'profile.json'), 'utf8')), profile);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'm5', 'probe.json'), 'utf8')), probe);
  fs.writeFileSync(path.join(simulatedHost, 'test', 'renewal-drill.mjs'),
    'import fs from "node:fs"; if (fs.readdirSync(process.argv[2]).length !== 6) process.exit(1); console.log(\'{"result":"PASS"}\');');
  const present = runM5();
  assert.equal(present.result, 'PASS');
  assert.deepEqual(present.verdict, { result: 'PASS' });
});

// A receipt from Invoke-DrillPreparedRun over a package whose manifest lists `paths` (full archive paths), with A1-A8 passing, the
// M5 observations `missing` and a host checker that answers `checker`.
const ONE_STEP = { 'host-result.json': { exit: 0, stdout: JSON.stringify({ name: 'residue', result: 'none', rejectCode: null, detail: null }) }, 'launcher-result.json': null };
function m5DrillReceipt(name, paths, { checker = 'FAIL', missing = ['probe.json'], candidate = false, version = '1.2.3', pkg = {}, reinstall = null, stageEvidence = ONE_STEP } = {}) {
  const root = path.join(tmp, name);
  const checkerFile = path.join(root, 'test', 'renewal-drill.mjs');
  fs.mkdirSync(path.dirname(checkerFile), { recursive: true });
  fs.writeFileSync(checkerFile, checker === 'PASS' ? `console.log(JSON.stringify({ result: 'PASS' }));`
    : `console.log(JSON.stringify({ result: 'FAIL' })); process.exitCode = 1;`);
  const archive = path.join(root, 'package.tar');
  const files = ['tree/work/independent-ci-resident-v1/windows/install-resident.ps1', ...paths].map(p => ({ path: p, data: Buffer.from(p) }));
  const manifest = { contract: 'clued.independent-ci.fleet-universal/1', version,
    files: files.map(({ path, data }) => ({ path, sha256: sha(data), bytes: data.length })) };
  fs.writeFileSync(archive, writeTar([...files, { path: 'universal-manifest.json', data: Buffer.from(JSON.stringify(manifest)) }]));
  const e = JSON.parse(evidence());
  const run = { first: { ...e, readAt: e.now }, entry: e.entry, reboot: e.reboot, reinstall: reinstall ?? e.reinstall,
    timings: {}, m5: null };
  const receipt = ps(`
    $script:Drill.Runs = ${q(root)}
    $script:DrillScriptPath = ${q(path.join(root, 'drill', 'drill-vm.ps1'))}
    function Assert-DrillHost { @{ freeGB = 20 } }
    function Invoke-DrillWithHostHold { throw 'HOST_HOLD_MUST_NOT_RUN' }
    function Get-DrillIntakeTool { throw 'HOST_HOLD_MUST_NOT_RUN' }
    function Invoke-DrillBaseline { @{ action = 'reuse' } }
    $fixture = ${q(JSON.stringify(run))} | ConvertFrom-Json
    $fixture.m5 = @{ directory = 'm5'; missing = @(${missing.map(q).join(', ')}); collectionCode = $null }
    function Invoke-DrillOnCheckpoint { param($Body, $RunDir, $Window)
      ${stageEvidence ? `[IO.File]::WriteAllText((Join-Path $RunDir 'stage-evidence.json'), ${q(JSON.stringify(stageEvidence))})` : ''}
      @{ restored = $true; failure = $null; result = $fixture; hostExecutorStates = @() } }
    $package = @{ version = ${q(version)}; tar = ${q(archive)}; tarSha256 = ${q(pkg.tarSha256 ?? sha(fs.readFileSync(archive)))}; ciSourceManifestSha256 = ${q(S)}; firstInstallKitSha256 = ${q(pkg.firstInstallKitSha256 ?? L)}; candidate = ${candidate ? '$true' : '$false'} }
    $out = Invoke-DrillPreparedRun @{ holdUntil = [DateTimeOffset]::MinValue; deadline = [DateTimeOffset]::MaxValue } $package (${q(JSON.stringify({ ...e.kit, sha256: 'fixture' }))} | ConvertFrom-Json) @{ sha256 = 'fixture' }
    Read-DrillJson $out.receipt
  `);
  return receipt;
}

// Fable ruling 11-19 section 2.2: there is no "not evaluated counts" exit. The applicability test read a hard-coded archive path
// (windows/ci-connection-renew.contract.json) that 3bc571a6 does not have (its contract is under apps/clued-cloud/worker/), so the drill
// of a package WITH the renewal skipped M5 silently. M5 is now collected for every package and the conclusion requires M5 = PASS.
const RENEWAL_3BC571A6 = ['tree/apps/clued-cloud/worker/ci-connection-renew.contract.json', 'tree/work/independent-ci-resident-v1/src/connection-renewal.mjs',
  'tree/work/independent-ci-resident-v1/windows/SwapBroker.cs', 'tree/work/independent-ci-resident-v1/windows/BrokerPureTests.cs'];

test('M5 is collected and judged for every package: the 3bc571a6 layout and a package without the renewal alike', opts, () => {
  const current = m5DrillReceipt('m5-3bc571a6', RENEWAL_3BC571A6);
  assert.equal(current.m5.result, 'FAIL');
  assert.deepEqual(current.m5.missing, ['probe.json']);
  assert.equal(current.m5.detail, 'DRILL_M5_OBSERVATIONS_MISSING');
  assert.equal(current.conclusion, 'FAIL');
  // the accepted 78ad314b listed the runner swap broker but no renewal: its observations are missing, so M5 fails, never "not evaluated"
  const legacy = m5DrillReceipt('m5-legacy', ['tree/work/independent-ci-resident-v1/windows/SwapBroker.cs']);
  assert.equal(legacy.m5.result, 'FAIL');
  assert.equal(legacy.conclusion, 'FAIL');
  const done = finalize('m5-legacy-finalize', legacy);
  assert.equal(done.output.code, 'DRILL_RECEIPT_NOT_FINALIZABLE', JSON.stringify(done.output));
  assert.equal(done.bytes, done.original);
  // no second copy of the package layout in the drill: nothing to fall out of date
  const text = fs.readFileSync(script, 'utf8');
  assert.doesNotMatch(text, /ci-connection-renew\.contract\.json/);
  assert.doesNotMatch(text, /Test-DrillM5Applicable/);
  assert.doesNotMatch(text, /M5 未评估/);
});

test('A1-A10 passing with M5 not PASS is never a PASS; with M5 PASS the A tier goes on to -Finalize', opts, () => {
  const passed = m5DrillReceipt('m5-pass', RENEWAL_3BC571A6, { checker: 'PASS', missing: [], candidate: true });
  assert.equal(passed.m5.result, 'PASS');
  // a candidate's receipt says so and names the three hashes an acceptance of it must name (seal holds the acceptance to them)
  assert.equal(passed.candidate, true);
  assert.equal(passed.ciSourceManifestSha256, S); assert.equal(passed.firstInstallKitSha256, L); assert.match(passed.tarSha256, /^[0-9a-f]{64}$/);
  assert.equal(m5DrillReceipt('m5-accepted', RENEWAL_3BC571A6).candidate, false);
  assert.equal(passed.conclusion, 'PENDING_PRODUCTION_READBACK');
  const done = finalize('m5-pass-finalize', passed);
  assert.equal(done.status, 0, JSON.stringify(done.output));
  assert.equal(done.output.conclusion, 'PASS_A_PER_NODE_STEPS_REMAIN');
  const checkerFailed = m5DrillReceipt('m5-checker-fail', RENEWAL_3BC571A6, { checker: 'FAIL', missing: [] });
  assert.equal(checkerFailed.m5.result, 'FAIL');
  assert.equal(checkerFailed.conclusion, 'FAIL');
  // -Finalize judges M5 too: a receipt whose items all pass but whose M5 is not PASS (or absent: a receipt written before this rule)
  const items = verdictOf(evidence()).items;
  for (const [name, m5] of [['m5-fail', { result: 'FAIL' }], ['m5-not-evaluated', { result: 'NOT_EVALUATED' }], ['m5-absent', undefined]]) {
    const r = finalize(`finalize-${name}`, { items, m5 });
    assert.equal(r.status, 0, JSON.stringify(r.output));
    assert.equal(r.output.conclusion, 'FAIL', name);
    assert.equal(JSON.parse(r.bytes).conclusion, 'FAIL', name);
  }
  assert.deepEqual(ps(`@((Get-DrillConclusion @() @{ result = 'PASS' }), (Get-DrillConclusion (${q(JSON.stringify(items.map(i => ({ ...i, pass: true }))))} | ConvertFrom-Json) @{ result = 'NOT_EVALUATED' }))`), ['FAIL', 'FAIL']);
});

// Fable ruling 11-19 renew-key section 4.3: a candidate's receipt is final BEFORE the Owner accepts. Its A5 is judged in the guest at
// once (the local Source is the request's; that the fleet runs it is the nodes' own concern: they install only the accepted Release and
// recompute the Source), and -Finalize, run right after the drill, judges only A9 (the drill wrote nothing to production). Order:
// drill -> -Finalize -> the Owner accepts -> seal. A re-drill of an accepted version (not a candidate) keeps A5's production half.
const notTheDrillsSource = () => ({ ...readbackRow, live_sources: ['6'.repeat(64)] });   // a function: readbackRow is declared further down
test('a candidate receipt: A5 in the guest only, -Finalize judges A9 alone; an accepted re-drill keeps the production half', opts, () => {
  const cand = m5DrillReceipt('cand-a5', RENEWAL_3BC571A6, { checker: 'PASS', missing: [], candidate: true });
  assert.equal(cand.candidate, true);
  assert.equal(cand.items.find(i => i.id === 'A5').pass, true);
  assert.equal(cand.items.find(i => i.id === 'A9').pass, null);
  assert.equal(cand.conclusion, 'PENDING_PRODUCTION_READBACK', 'not read back yet: not a PASS');
  // the fleet runs another Source (the nodes are not on this generation yet): no matter for a candidate
  const done = finalize('cand-a5-finalize', cand, notTheDrillsSource());
  assert.equal(done.status, 0, JSON.stringify(done.output));
  assert.equal(done.output.conclusion, 'PASS_A_PER_NODE_STEPS_REMAIN');
  const final = JSON.parse(done.bytes);
  assert.equal(final.items.find(i => i.id === 'A5').pass, true);
  assert.equal(final.items.find(i => i.id === 'A9').pass, true);
  // A9 is still read: a production write during the drill fails the candidate
  assert.equal(finalize('cand-a9-finalize', cand, { ...notTheDrillsSource(), bindings_created: 1 }).output.conclusion, 'FAIL');
  // an accepted version's re-drill: A5 waits for the production half, which compares the live Sources as before
  const accepted = m5DrillReceipt('acc-a5', RENEWAL_3BC571A6, { checker: 'PASS', missing: [] });
  assert.equal(accepted.items.find(i => i.id === 'A5').pass, null);
  assert.equal(finalize('acc-a5-finalize', accepted, notTheDrillsSource()).output.conclusion, 'FAIL');
  assert.equal(finalize('acc-a5-finalize-same', accepted).output.conclusion, 'PASS_A_PER_NODE_STEPS_REMAIN');
});

// The two PASS conclusions a receipt can end in are the set seal takes (publish.mjs exports it; one definition there): held equal here so
// neither side can rename one alone.
test('the PASS conclusions of drill-vm.ps1 are exactly publish.mjs DRILL_PASS_CONCLUSIONS, the set seal takes', () => {
  const text = fs.readFileSync(script, 'utf8');
  const fn = text.slice(text.indexOf('function Get-DrillConclusion'), text.indexOf('\n}', text.indexOf('function Get-DrillConclusion')));
  const mine = [...new Set([...fn.matchAll(/'(PASS_[A-Z_]+)'/g)].map(m => m[1]))].sort();
  assert.deepEqual(mine, ['PASS_A_FULL', 'PASS_A_PER_NODE_STEPS_REMAIN']);
  assert.deepEqual([...DRILL_PASS_CONCLUSIONS].sort(), mine);
});

// The guest entry runs the package's own Expand-Cached (the stand-in that shadowed it is gone, #1154), and puts the companion token
// stand-in into the credential input with the other fake credentials.
test('the guest entry shadows no package function and hands over the companion token stand-in', () => {
  const text = fs.readFileSync(entryScript, 'utf8');
  assert.doesNotMatch(text, /function\s+Expand-Cached/i);
  assert.match(text, /@\('companion-github\.token', 'companion-github\.token'\)/);
});

// Codex review of ced480363, high 1: with the stand-in gone the entry calls the package's real Expand-Cached, whose fourth parameter (the
// pinned manifest's maxEntryPathLength) it refuses to go without. Every call in the entry passes every parameter the package's function
// declares, read from the package's bootstrap itself, the last one from the manifest item.
test('the guest entry calls the package\'s Expand-Cached with every parameter it declares, the path limit from the pinned manifest', opts, () => {
  const bootstrap = fileURLToPath(new URL('../rollout/fleet/bootstrap.ps1', import.meta.url));
  const r = ps(`
    $isFn = { param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -ceq 'Expand-Cached' }
    $isCall = { param($a) $a -is [Management.Automation.Language.CommandAst] -and $a.GetCommandName() -ceq 'Expand-Cached' }
    $package = [Management.Automation.Language.Parser]::ParseFile(${q(bootstrap)}, [ref]$null, [ref]$null)
    $fn = @($package.FindAll($isFn, $true))[0]
    $entry = [Management.Automation.Language.Parser]::ParseFile(${q(entryScript)}, [ref]$null, [ref]$null)
    @{ declared = @($fn.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
      shadowed = @($entry.FindAll($isFn, $true)).Count
      calls = @($entry.FindAll($isCall, $true) | ForEach-Object { , [string[]]@($_.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.Extent.Text }) }) }`);
  assert.deepEqual(r.declared, ['zip', 'name', 'sha256', 'maxEntryPathLength']);
  assert.equal(r.shadowed, 0);
  const calls = Array.isArray(r.calls[0]) ? r.calls : [r.calls];
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, r.declared.length, calls[0].join(' '));
  assert.match(calls[0][3], /Get-Key \$item 'maxEntryPathLength'/);
});

// No second copy of the drill's stand-ins anywhere under drill/: they live in publish.mjs only (ruling renew-key section 4.1 row 3).
test('drill/ holds no literal of the drill stand-ins', () => {
  const dir = fileURLToPath(new URL('../drill/', import.meta.url));
  const values = [DRILL_RESERVED.decision, DRILL_RESERVED.receipt, DRILL_RESERVED.decision.slice(0, 8)];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (!fs.statSync(file).isFile()) continue;
    const text = fs.readFileSync(file, 'latin1');
    for (const v of values) assert.ok(!text.includes(v), `${name} names ${v}`);
  }
});

// The candidate path end to end against the real seal (cross test, ruling renew-key 4.5 item 3): receipts that drill-vm.ps1's own
// conclusion function wrote, fed to publish.mjs seal --drill-receipt. Finalized: taken. Not read back yet: refused, nothing changes.
async function sealWorld(t) {
  const d = fs.mkdtempSync(path.join(tmp, 'seal-'));
  const version = '2026.11.12-1', tag = `fleet-node-${version}`, commit = 'a1'.repeat(20), fleet = 'tree/work/independent-ci-resident-v1/rollout/fleet/';
  const out = path.join(d, 'out'); fs.mkdirSync(out);
  const tar = writeTar([{ path: `${fleet}bootstrap.ps1`, data: Buffer.from('# bootstrap\r\n') },
    { path: `${fleet}prereq-manifest.json`, data: Buffer.from(JSON.stringify({ contract: 'clued.independent-ci.fleet-node-prereq-manifest/1', items: [] }) + '\n') },
    { path: 'universal-manifest.json', data: Buffer.from('{}') }]);
  const source = { version, release_tag: tag, archive_sha256: sha(tar), commit, resident_manifest_sha256: '2'.repeat(64), source_manifest_sha256: '3'.repeat(64),
    upgrader_manifest_sha256: '4'.repeat(64), bundle_sha256: '5'.repeat(64), universal_files_sha256: '6'.repeat(64) };
  const release = Buffer.from(JSON.stringify({ contract: 'clued.independent-ci.fleet-node-release/1', source, archive: { name: `${tag}.tar`, bytes: tar.length, sha256: sha(tar) } }) + '\n');
  fs.writeFileSync(path.join(out, `${tag}.tar`), tar);
  fs.writeFileSync(path.join(out, `${tag}.release.json`), release);
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), `${sha(release)}  ${tag}.release.json\n${sha(tar)}  ${tag}.tar\n`);
  const index = path.join(d, 'index.md');
  fs.writeFileSync(index, '| 版本 | Release | tar sha256 | commit | 接受时间 |\r\n|---|---|---|---|---|\r\n');
  const fake = path.join(d, 'fake-gh.mjs'); fs.writeFileSync(fake, FAKE_GH);
  const saved = { FAKE_GH_STATE: process.env.FAKE_GH_STATE, GH_TOKEN: process.env.GH_TOKEN };
  process.env.FAKE_GH_STATE = path.join(d, 'gh-state.json'); delete process.env.GH_TOKEN;
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const gh = [process.execPath, fake];
  await publish({ dir: out, repo: 'tdoljyj/cross-memory-system', index, ghCommand: gh });
  const image = 'e'.repeat(64), imageFile = path.join(d, `role-image-${image}.tar.gz`); fs.writeFileSync(imageFile, 'gzip of a docker save');
  const U = n => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
  const deps = { readKit: () => ({}), sourceHash: async () => ({ ciSourceManifestSha256: S }),
    kitOf: async () => ({ contract: 'clued.independent-ci.fleet-node-first-install-kit/1', template: {}, config: { ciSourceManifestSha256: L }, images: { pull: [], local: [{ id: image, asset: `role-image-${image}.tar.gz` }] } }),
    fleetMaterial: async () => ({ formalRoles: { gitleaks: {}, trivy: {}, 'contract-placement': {} },
      installed: { sourceAcceptanceRef: U(5), hostQualificationRef: U(6), ownerAuthorizationRef: U(5), publisherQualificationRef: U(5), ownerPackageAcceptanceRef: U(5), ciSourceManifestSha256: L } }) };
  const accept = path.join(d, 'accept');
  await prepare({ version, dir: out, out: accept, images: [imageFile], index, ghCommand: gh, deps });
  const requestFile = path.join(accept, `${tag}.acceptance-request.json`);
  const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
  // the Decision record as DESK exports it (the shape of the real clued_record_mutate return PR-乙's tests pin), naming this request
  const record = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../rollout/fleet/test/fixtures/clued-decision-mutate-3bc571a6.json', import.meta.url)), 'utf8'));
  record.supplemental.record.content = `TEST TEXT: the Owner accepts.\n${requestLineOf(version, sha(fs.readFileSync(requestFile)))}\n`;
  const decisionRecord = path.join(d, 'decision-record.json'); fs.writeFileSync(decisionRecord, JSON.stringify(record, null, 2));
  const sealIt = drillReceipt => seal({ request: requestFile, decisionRecord, index, ghCommand: gh, deps, drillReceipt });
  return { d, version, request, index, sealIt };
}

// Codex review of PR-甲 (blocking 1): -SkipReinstall leaves A8 null ("skipped"), which the conclusion leaves out of the pending items, so a
// candidate that never re-installed reached PASS after -Finalize and seal took it. A candidate's A1-A8 must each be true. Two cases: the
// entry refuses a candidate run with a skip option; and, apart from the entry, a candidate receipt with A8 skipped goes through the real
// conclusion, -Finalize and seal and is refused at each. An accepted version's re-drill keeps -SkipReinstall as the diagnosis it was.
test('a candidate run with -SkipReinstall is refused at the entry, before the host gate or hold', opts, () => {
  const code = psCode(`
    $Version = '1.2.3'; $From = 'unused'; $Kit = 'unused'; $SkipReinstall = $true
    function Read-DrillPrereq { @{ sha256 = 'pin' } }
    function Read-DrillKit { @{ prereqSha256 = 'pin'; executionBlocker = $null; candidate = @{ acceptance = 'x' } } }
    function Test-DrillPackageDir { @{ tar = 'unused'; candidate = $true } }
    function Get-DrillReleaseFiles { @('unused') }
    function Assert-DrillHost { throw 'HOST_GATE_MUST_NOT_RUN' }
    # never the real host hold, whatever the code does (Clued Task fe8a2cbf)
    function Invoke-DrillWithHostHold { throw 'HOST_HOLD_MUST_NOT_RUN' }
    function Get-DrillIntakeTool { throw 'HOST_HOLD_MUST_NOT_RUN' }
    Invoke-DrillMain`);
  assert.equal(code, 'DRILL_CANDIDATE_CANNOT_SKIP');
});

test('a candidate receipt with A8 skipped is refused through the real conclusion, -Finalize and seal', opts, async t => {
  const w = await sealWorld(t);
  const pkg = { tarSha256: w.request.archive_sha256, firstInstallKitSha256: w.request.firstInstallKitSha256 };
  // the receipt Invoke-DrillPreparedRun writes for a candidate whose A8 was skipped (no entry, no host hold: m5DrillReceipt stubs them)
  const skipped = m5DrillReceipt('cand-skip', RENEWAL_3BC571A6, { checker: 'PASS', missing: [], candidate: true, version: w.version, pkg, reinstall: { skipped: true } });
  // a receipt that says pending anyway (written before this rule) is judged again by -Finalize, and what it writes is fed to seal
  const done = finalize('cand-skip-finalize', { ...skipped, conclusion: 'PENDING_PRODUCTION_READBACK' }, notTheDrillsSource());
  let sealed;
  try { sealed = (await w.sealIt(done.receiptFile)).status; } catch (e) { sealed = e.code ?? String(e); }
  // each link of the chain, side by side (a red run shows every one that let it through)
  assert.deepEqual({ a8: skipped.items.find(i => i.id === 'A8').pass, run: skipped.conclusion, finalize: done.output.conclusion ?? done.output.code, seal: sealed },
    { a8: null, run: 'FAIL', finalize: 'FAIL', seal: 'SEAL_DRILL_RECEIPT_NOT_PASS' });
  // an accepted version's re-drill may still skip A8 (a diagnosis, never sealed)
  const reDrill = m5DrillReceipt('acc-skip', RENEWAL_3BC571A6, { checker: 'PASS', missing: [], reinstall: { skipped: true } });
  assert.equal(reDrill.conclusion, 'PENDING_PRODUCTION_READBACK');
  assert.equal(finalize('acc-skip-finalize', reDrill).output.conclusion, 'PASS_A_PER_NODE_STEPS_REMAIN');
});
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
// growing the production WSL. With the job's Runner.Worker in the process list the boot is refused before it starts.
test('the field sample of run 20261119T172257Z is refused before boot when an Actions runner job is executing', opts, () => {
  const r = ps(`Test-DrillHostSafety ${q(idleHostStatus())} ([long](19.7 * 1GB)) -ProcessNames @('Runner.Listener', 'Runner.Worker')`);
  assert.equal(r.action, 'refuse');
  assert.equal(r.code, 'DRILL_HOST_CI_BUSY');
  assert.equal(r.busyWith, 'ACTIONS_RUNNER_JOB');
});

// Fable renew-key ruling, supplement "drill hold and the Actions self-hosted runners on the same host" (Clued Task e71ceb33): the hold
// drains the resident but not the host's Actions runners, so a job one of them is executing (a Runner.Worker process) refuses the
// boot. Judged from the process list, not from runner names; a job picked up after the boot is left to the running memory gate.
test('the boot gate refuses while an Actions runner job is executing on the host, and a running drill is not aborted by one', opts, () => {
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
  assert.equal(r.listening.action, 'start');
  assert.equal(r.busy.action, 'refuse');
  assert.equal(r.busy.code, 'DRILL_HOST_CI_BUSY');
  assert.equal(r.busy.busyWith, 'ACTIONS_RUNNER_JOB');
  assert.equal(r.running.action, 'continue');
});

// Fable renew-key ruling, supplements "WSL runner jobs" and "branch one, round four": this host's Linux Actions runners execute their jobs
// inside a WSL distribution, where the Windows process list does not see their Runner.Worker. The question asked there is a yes or no,
// answered by an exit code alone: pgrep -ix Runner.Worker. Its standard output is never read. Two small closed tables decide everything:
// the probe's (exit x stderr x time out) and the running list's (the one output still read).
test('the boot gate refuses a job on either side and a WSL side that could not be read', opts, () => {
  const r = ps(`
    $s = ${q(idleHostStatus())}
    @{ wslJob = (Test-DrillHostSafety $s 64GB -ProcessNames @('Runner.Listener') -WslJob $true)
      quiet = (Test-DrillHostSafety $s 64GB -ProcessNames @('Runner.Listener') -WslJob $false)
      unreadable = (Test-DrillHostSafety $s 64GB -ProcessNames @('Runner.Listener') -WslJob $null)
      windowsJob = (Test-DrillHostSafety $s 64GB -ProcessNames @('Runner.Worker') -WslJob $false)
      running = (Test-DrillHostSafety $s 64GB -Running -WslJob $true) }`);
  assert.deepEqual([r.wslJob.action, r.wslJob.code, r.wslJob.busyWith], ['refuse', 'DRILL_HOST_CI_BUSY', 'WSL_ACTIONS_RUNNER_JOB']);
  assert.equal(r.quiet.action, 'start');
  assert.deepEqual([r.unreadable.action, r.unreadable.code], ['refuse', 'DRILL_HOST_WSL_UNREADABLE']);
  assert.deepEqual([r.windowsJob.code, r.windowsJob.busyWith], ['DRILL_HOST_CI_BUSY', 'ACTIONS_RUNNER_JOB']);
  assert.equal(r.running.action, 'continue');
});

// One world for the WSL side: this host's runner distribution Fixture-CI (registered, running), a probe answering `probe` (exit, stderr,
// or a throw as a time out does), a running list answering `list`.
const wslWorld = `
    function Read-DrillHostStatus { ${q(idleHostStatus())} }
    function Get-CimInstance { param($ClassName, $OperationTimeoutSec, $ErrorAction) @{ FreePhysicalMemory = 64GB / 1KB } }
    function Get-VM { param($ErrorAction) }
    function Get-Process { param($ErrorAction) [pscustomobject]@{ ProcessName = 'Runner.Listener' } }
    function Get-DrillRunnerDistributions { param($HostName) 'Fixture-CI' }
    function Get-DrillWslRegisteredNames { 'docker-desktop'; 'Fixture-CI' }
    $script:calls = [Collections.Generic.List[string]]::new()
    $script:list = @{ exit = 0; stdout = "Fixture-CI\`r\`n"; stderr = '' }
    $script:DrillWslRunner = { param($a)
      $script:calls.Add($a -join ' ')
      if ($a[0] -ceq '--list') { return $script:list }
      if ($script:probe -eq 'timeout') { throw 'wsl.exe timed out' }
      return $script:probe
    }`;

// The probe's closed table, cell by cell, end to end through the boot gate; and the reverse: across exits -2..9 and stderr empty, blank,
// text, and missing, the one cell that gives "no job" is exit 1 with nothing on stderr; the one that gives "a job" is exit 0 with nothing.
test('the probe: exit 0 a job, exit 1 none, anything else -- another exit, anything on stderr, a time out -- refuses; nothing else says none', opts, () => {
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
  assert.deepEqual(c.job, { action: 'refuse', code: 'DRILL_HOST_CI_BUSY', busyWith: 'WSL_ACTIONS_RUNNER_JOB' });
  assert.deepEqual(c.none, { action: 'start', code: null, busyWith: null });
  assert.deepEqual(c['none-whatever-stdout'], { action: 'start', code: null, busyWith: null }, 'stdout is never read');
  for (const cell of ['job-with-stderr', 'none-with-stderr', 'none-with-blank-stderr', 'syntax-error', 'fatal', 'no-exit', 'exit-as-text', 'timeout']) {
    assert.deepEqual(c[cell], { action: 'refuse', code: 'DRILL_HOST_WSL_UNREADABLE', busyWith: null }, cell);
  }
  const none = r.sweep.filter(x => x.verdict === 'NO_JOB'), job = r.sweep.filter(x => x.verdict === 'JOB');
  assert.deepEqual(none.map(x => [x.exit, x.stderr]), [[1, ''], [1, null]]);
  assert.deepEqual(job.map(x => [x.exit, x.stderr]), [[0, ''], [0, null]]);
  assert.equal(r.sweep.filter(x => !['NO_JOB', 'JOB', 'FAILED'].includes(x.verdict)).length, 0);
  assert.deepEqual(r.probeArgv, ['--distribution Fixture-CI --exec pgrep -ix Runner.Worker']);
});

// The running list, the one output still read, by one fixed rule: cut at line ends, only lines of length zero dropped, every other line
// whole and untrimmed the name of a distribution this account has registered -- or the whole answer is refused. Its exit and stderr as
// every WSL call. Then, only a distribution in a list that read is asked anything; one that is not running is asked nothing.
test('the running list: whole registered names only, else refused; a distribution not in it is asked nothing', opts, () => {
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
    # end to end: a list that does not read refuses the boot; a list without the runner distribution asks it nothing
    $script:probe = @{ exit = 0; stdout = ''; stderr = '' }
    $script:list = @{ exit = 0; stdout = "Fixture-CI \`r\`n"; stderr = '' }
    $refused = Get-DrillHostSafety
    $script:calls.Clear(); $script:list = @{ exit = 0; stdout = "docker-desktop\`r\`n"; stderr = '' }
    $stopped = Get-DrillHostSafety
    @{ out = $out; refused = @{ code = $refused.code; why = $refused.wslUnreadable }; stopped = @{ action = $stopped.action }; stoppedCalls = @($script:calls) }`);
  for (const [name, [, ok, names]] of Object.entries(lists)) {
    if (ok) assert.deepEqual(r.out[name], names, name);
    else assert.equal(r.out[name], 'WSL_RUNNING_LIST_UNREADABLE', name);
  }
  for (const k of Object.keys(r.out).filter(k => k.startsWith('bad-'))) assert.equal(r.out[k], 'WSL_RUNNING_LIST_FAILED', k);
  assert.deepEqual(r.refused, { code: 'DRILL_HOST_WSL_UNREADABLE', why: 'WSL_RUNNING_LIST_UNREADABLE' });
  assert.deepEqual(r.stopped, { action: 'start' });
  assert.deepEqual(r.stoppedCalls, ['--list --running --quiet'], 'a distribution that is not running is asked nothing');
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
  assert.deepEqual(r.knownCalls, ['--list --running --quiet', '--distribution Fixture-CI --exec pgrep -ix Runner.Worker']);
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

// The release command is run for real in these tests by Git's POSIX sh (never the distribution's), with stand-ins for pgrep (its exit) and
// sync first on PATH, and its one write pointed into the stand-ins' directory.
const gitSh = ['C:\\Program Files\\Git\\bin\\sh.exe', 'C:\\Program Files\\Git\\usr\\bin\\sh.exe'].find(f => fs.existsSync(f));
const shOpts = { skip: !windows ? true : (gitSh ? false : 'Git sh not found') };
const msys = p => p.replace(/^([A-Za-z]):/, (m, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/');
function shWorld(name, { pgrep = 1, sync = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, `sh-${name}-`));
  fs.writeFileSync(path.join(dir, 'pgrep'), `#!/bin/sh\nexit ${pgrep}\n`);
  fs.writeFileSync(path.join(dir, 'sync'), `#!/bin/sh\necho synced > '${msys(dir)}/synced'\nexit ${sync}\n`);
  return { prefix: `PATH=${msys(dir)}:/usr/bin:/bin; `, drop: `${msys(dir)}/drop_caches`,
    synced: () => fs.existsSync(path.join(dir, 'synced')), dropped: () => fs.existsSync(path.join(dir, 'drop_caches')) };
}
const commandIn = (world, command) => world.prefix + command.split('/proc/sys/vm/drop_caches').join(world.drop);

// The release command's own closed table, run: pgrep found (0) -> exit 3, nothing synced or released; none (1) -> sync, release, exit 0;
// pgrep failed (2, 3) -> exit 4, nothing synced or released; the sync failing -> exit 5. The only way to the release is pgrep's exit 1.
test('the release command: only pgrep\'s "none" reaches the release; a job exits 3, a failed lookup 4, a failed release 5', shOpts, () => {
  const command = ps('$script:DrillWslReleaseCommand');
  const cases = { job: [{ pgrep: 0 }, 3, false], none: [{ pgrep: 1 }, 0, true], 'pgrep-syntax': [{ pgrep: 2 }, 4, false], 'pgrep-fatal': [{ pgrep: 3 }, 4, false],
    'pgrep-killed': [{ pgrep: 137 }, 4, false], 'sync-fails': [{ pgrep: 1, sync: 1 }, 5, false] };
  for (const [name, [world, exit, released]] of Object.entries(cases)) {
    const w = shWorld(name, world);
    const r = spawnSync(gitSh, ['-c', commandIn(w, command)], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, exit, `${name}: ${r.stdout}${r.stderr}`);
    assert.equal(w.dropped(), released, `${name}: released`);
    assert.equal(w.synced(), released || name === 'sync-fails', `${name}: synced`);
  }
});

// The host's side of the release, closed too: exit 0 released, exit 3 skipped (no failure: the boot gate decides), anything else a failed
// release (no failure of the drill either); nothing else is recorded as released. Before each distribution the running list, then the
// Windows side, are read again; a distribution not running, or a Windows job, gets no command.
test('the release on the host: exit 0 released, 3 skipped, anything else failed; read again before each distribution', opts, () => {
  const r = ps(`
    function Get-DrillWslRegisteredNames { 'Fixture-A'; 'Fixture-B'; 'Fixture-C' }
    function Get-DrillRunnerDistributions { param($HostName) 'Fixture-A' }
    function Get-Process { param($ErrorAction) $script:calls.Add('windows'); $n = @('Runner.Listener'); if ($script:windowsJob) { $n += 'Runner.Worker' }; $n | ForEach-Object { [pscustomobject]@{ ProcessName = $_ } } }
    $script:calls = [Collections.Generic.List[string]]::new(); $script:windowsJob = $false; $script:jobDuringList = $false
    $script:DrillWslRunner = { param($a)
      if ($a[0] -ceq '--list') { $script:calls.Add('list'); if ($script:jobDuringList) { $script:windowsJob = $true }; return @{ exit = 0; stdout = "Fixture-A\`r\`nFixture-C\`r\`n"; stderr = '' } }
      $script:calls.Add($a[1]); if ($a[1] -ceq 'Fixture-C' -and $script:jobAfterC) { $script:windowsJob = $true }
      return $script:answer
    }
    $table = [ordered]@{}
    foreach ($exit in @(0, 3, 1, 2, 4, 5, -1, 137, $null, '0')) {
      $script:answer = @{ exit = $exit; stdout = 'anything'; stderr = 'anything' }
      $o = Invoke-DrillWslCacheRelease
      $key = if ($null -eq $exit) { 'null|null' } else { "$exit|$($exit.GetType().Name)" }
      $table[$key] = @{ released = @($o.released); skipped = $o.skipped; failed = $(if ($o.failed) { $o.failed.code } else { $null }) }
    }
    $script:answer = @{ exit = 0; stdout = ''; stderr = '' }
    $script:calls.Clear(); $script:jobAfterC = $true
    function Get-DrillRunnerDistributions { param($HostName) 'Fixture-A'; 'Fixture-B'; 'Fixture-C' }
    $first = Invoke-DrillWslCacheRelease
    $firstCalls = @($script:calls); $script:calls.Clear(); $script:windowsJob = $false; $script:jobAfterC = $false
    $script:jobDuringList = $true
    $during = Invoke-DrillWslCacheRelease
    @{ table = $table; first = $first; firstCalls = $firstCalls; during = $during; duringCalls = @($script:calls) }`);
  const t = r.table;
  assert.deepEqual(t['0|Int32'], { released: ['Fixture-A'], skipped: null, failed: null });
  assert.deepEqual(t['3|Int32'], { released: [], skipped: { where: 'Fixture-A', reason: 'WSL_ACTIONS_RUNNER_JOB' }, failed: null });
  for (const k of Object.keys(t).filter(k => !['0|Int32', '3|Int32'].includes(k))) {
    assert.deepEqual(t[k], { released: [], skipped: null, failed: 'DRILL_WSL_CACHE_RELEASE_FAILED' }, k);
  }
  assert.deepEqual(r.firstCalls, ['list', 'windows', 'Fixture-A', 'list', 'list', 'windows', 'Fixture-C']);
  assert.deepEqual(r.first.released, ['Fixture-A', 'Fixture-C']);
  assert.deepEqual(r.first.results.map(x => [x.distribution, x.running]), [['Fixture-A', true], ['Fixture-B', false], ['Fixture-C', true]]);
  assert.deepEqual(r.duringCalls, ['list', 'windows'], 'a Windows job picked up while the list was asked for: no command');
  assert.deepEqual(r.during.skipped, { where: 'windows', reason: 'ACTIONS_RUNNER_JOB' });
});

test('the release command is one literal in single quotes, nothing put into it, and one that is not that literal is never sent', opts, () => {
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
    $firstSent = $script:sent[0]; $script:sent.Clear()
    $literal = $script:DrillWslReleaseCommand
    $script:DrillWslReleaseCommand = $literal + '; rm -rf /tmp/x'
    $tampered = Invoke-DrillWslCacheRelease
    @{ ok = $ok; sent = $firstSent; literal = $literal; tampered = $tampered; tamperedSent = $script:sent.Count }`);
  assert.deepEqual(r.sent, ['--distribution', 'Fixture-CI', '--user', 'root', '--exec', 'sh', '-c', r.literal]);
  assert.doesNotMatch(r.literal, /["\\\r\n]/, 'nothing the Windows command line could split or escape');
  assert.deepEqual(r.ok.released, ['Fixture-CI']);
  assert.equal(r.tampered.failed.code, 'DRILL_WSL_RELEASE_COMMAND_NOT_LITERAL');
  assert.equal(r.tamperedSent, 0);
  assert.match(fs.readFileSync(script, 'utf8'), /^\$script:DrillWslReleaseCommand = '[^']+'$/m, 'a single-quoted string: PowerShell puts nothing into it');
});

// Fable renew-key ruling, supplements "WSL runner jobs" item 3 and "WSL gate race" item 3 (the order unchanged by round four): early
// refusal (hold, resident idle, no job on either side; no memory) -> the release -> the boot gate (both sides again, then memory, judged
// once, then the boot), from the real entry on, with the real host guard; the release command run by Git's sh.
function preBootWorld({ freeBeforeRelease = 10, freeAfterRelease = 64 } = {}) {
  const quiet = shWorld('preboot-quiet', { pgrep: 1 });
  const job = shWorld('preboot-job', { pgrep: 0 });
  const status = path.join(fs.mkdtempSync(path.join(tmp, 'preboot-status-')), 'status.json');
  fs.writeFileSync(status, idleHostStatus());
  return `
    $script:events = [Collections.Generic.List[string]]::new()
    $script:released = $false
    $script:Drill.Runs = ${q(fs.mkdtempSync(path.join(tmp, 'preboot-')))}
    $script:Drill.HostStatus = ${q(status)}
    $script:Drill.HostGuardSeconds = 3600
    function Read-DrillHostStatus { $script:events.Add('status'); ${q(idleHostStatus())} }
    function Get-CimInstance { param($ClassName, $OperationTimeoutSec, $ErrorAction)
      $script:events.Add('memory'); @{ FreePhysicalMemory = $(if ($script:released) { ${freeAfterRelease}GB } else { ${freeBeforeRelease}GB }) / 1KB } }
    function Get-VM { param($ErrorAction) }
    function Get-Process { param($ErrorAction) $script:events.Add('windows-processes'); $n = @('Runner.Listener'); if ($script:windowsJobAfter -ge 0 -and @($script:events | Where-Object { $_ -ceq 'wsl-probe' }).Count -ge $script:windowsJobAfter) { $n += 'Runner.Worker' }; $n | ForEach-Object { [pscustomobject]@{ ProcessName = $_ } } }
    function Get-DrillRunnerDistributions { param($HostName) 'Fixture-CI' }
    function Get-DrillWslRegisteredNames { 'Fixture-CI' }
    $script:jobAfter = -1; $script:windowsJobAfter = -1
    $script:worlds = @{ quiet = ${q(quiet.prefix)} + '|' + ${q(quiet.drop)}; job = ${q(job.prefix)} + '|' + ${q(job.drop)} }
    $script:DrillWslRunner = { param($a)
      $j = $a -join ' '
      if ($a -contains '--terminate' -or $a -contains '-t' -or $a -contains '--shutdown' -or $a -contains '--unregister') { $script:events.Add('STOP ' + $j); return @{ exit = 0; stdout = ''; stderr = '' } }
      if ($j -ceq '--list --running --quiet') { $script:events.Add('wsl-running'); return @{ exit = 0; stdout = "Fixture-CI\`r\`n"; stderr = '' } }
      $job = $script:jobAfter -ge 0 -and @($script:events | Where-Object { $_ -ceq 'wsl-probe' }).Count -ge $script:jobAfter
      if ($j -ceq '--distribution Fixture-CI --exec pgrep -ix Runner.Worker') { $script:events.Add('wsl-probe'); return @{ exit = $(if ($job) { 0 } else { 1 }); stdout = ''; stderr = '' } }
      if ($j -ceq ('--distribution Fixture-CI --user root --exec sh -c ' + $script:DrillWslReleaseCommand)) {
        $prefix, $drop = $script:worlds[$(if ($job) { 'job' } else { 'quiet' })] -split '\\|'
        $r = Invoke-DrillProcess ${q(gitSh ?? 'sh.exe')} @('-c', ($prefix + $script:DrillWslReleaseCommand.Replace('/proc/sys/vm/drop_caches', $drop))) 60
        $script:events.Add('wsl-release exit ' + $r.exit)
        if ($r.exit -eq 0) { $script:released = $true }
        return $r
      }
      $script:events.Add('unexpected: ' + $j); return @{ exit = 1; stdout = ''; stderr = '' }
    }
    function Test-DrillHyperVAdministrator { $true }
    function Get-PSDrive { param($Name) @{ Free = 1TB } }
    function Get-VMSwitch { param($Name, $ErrorAction) 'switch' }
    function Invoke-DrillBaseline { param($RunDir, [switch]$ExistingOnly) [ordered]@{ action = 'ready' } }
    function Get-DrillVmInfo { @{ vm = @{ Id = [guid]::Empty }; notes = $script:Drill.Marker; state = 'Off'; checkpoints = @($script:Drill.Checkpoint) } }
    function Restore-VMCheckpoint { param($VMName, $Name, $Confirm) $script:events.Add('restore') }
    function Start-DrillBootWatchdog { @{ signal = ${q(path.join(tmp, 'preboot-signal'))}; process = $null } }
    function Assert-DrillWatchdogAlive { param($Watchdog) }
    function Start-VM { param($Name, $ErrorAction) $script:events.Add('boot') }
    function Get-DrillCredential { }
    function Wait-DrillGuest { }
    function Invoke-DrillGuest { $true }
    function Invoke-DrillPrereqInGuest { param($RunDir, $Prereq, $Cred) 'prereq ran' }
    function Stop-DrillGuardedVm { param($Guard, [switch]$RestoreCheckpoint) $script:events.Add('restore-end'); return $true }
    $script:PrereqOnly = $true
    function Invoke-Entry {
      $out = Invoke-DrillPreparedRun @{ safeToResume = $true; deadline = [DateTimeOffset]::UtcNow.AddMinutes(10); holdUntil = [DateTimeOffset]::MinValue } @{ version = 'x' } @{ sha256 = 'kit' } @{ sha256 = 'prereq' }
      @{ events = @($script:events); out = $out }
    }`;
}
const early = ['status', 'windows-processes', 'wsl-running', 'wsl-probe'];
const bootGate = ['status', 'windows-processes', 'wsl-running', 'wsl-probe', 'memory'];

test('from the real entry: early refusal without memory, the release, then the boot gate judges memory once; short before the release still boots', shOpts, () => {
  const r = ps(`${preBootWorld()}
    Invoke-Entry`);
  assert.deepEqual(r.events, ['status', ...early, 'wsl-running', 'windows-processes', 'wsl-release exit 0', 'restore', 'status', ...bootGate, 'boot', 'restore-end']);
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

test('a job that appears after the early sample skips the release (the command finds it itself), and the boot gate refuses', shOpts, () => {
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
  assert.deepEqual([r.wsl.out.code, r.wsl.out.hostPreBoot.bootGate.busyWith], ['DRILL_HOST_CI_BUSY', 'WSL_ACTIONS_RUNNER_JOB']);
  assert.ok(!r.wsl.events.includes('boot'));
  assert.deepEqual(r.windows.out.hostPreBoot.release.skipped, { where: 'windows', reason: 'ACTIONS_RUNNER_JOB' });
  assert.ok(!r.windows.events.some(e => e.startsWith('wsl-release')), 'no command into the distribution');
  assert.equal(r.windows.out.code, 'DRILL_HOST_CI_BUSY');
});

// Codex review of 74e7a65e7, medium 1: a refusal at the duty check carries no memory figure (nothing was read), and a built baseline
// keeps its three stages in baseline.json.
test('no memory figure where none was read, and baseline.json keeps the pre-boot stages', opts, () => {
  const r = ps(`
    function Read-DrillHostStatus { ${q(activeHostStatus(null, { writtenAt: new Date().toISOString() }))} }
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
  // Ubuntu package names carry + and ~ (containerd_2.2.1-0ubuntu1~24.04.4_amd64.deb): the kit reader accepts what the prereq reader accepts
  const debKit = kitDir('kit-deb', (k) => ({ ...k, files: [...k.files, { path: 'tools\\c_2.2.1-0ubuntu1~24.04.4+x.deb', sha256: sha('d') }] }));
  fs.writeFileSync(path.join(debKit, 'tools', 'c_2.2.1-0ubuntu1~24.04.4+x.deb'), 'd');
  assert.equal(ps(`(Read-DrillKit ${q(debKit)}).entryFile`), 'entry.ps1');
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
// Fable renew-key ruling, supplement "companion account and evidence" section 2: the first install's step record comes from what the guest
// printed (the entry's stdout) and the stage result files (the host preparation's stdout, the launcher's result text). Every step line has
// one shape (name, result, rejectCode, detail; the older {step, result} is read too). Nothing parsed is recorded as missing, never as a
// pass; no verdict line (a timeout) is said so, with the last step printed.
test('the first-install step record: every stage\'s step lines, the last completed step, the verdict or its absence; nothing parsed is missing', opts, () => {
  const hostOut = [
    'some text',
    JSON.stringify({ name: 'residue', result: 'none', rejectCode: null, detail: null }),
    JSON.stringify({ step: 'wsl', result: '2.7.13.0' }),
    JSON.stringify({ name: 'companion-account', result: 'refused', rejectCode: 'COMPANION_ACCOUNT_NOT_PREPARED', detail: { error: 'GH_EXE_MISSING' } }),
    JSON.stringify({ status: 'FIRST_INSTALL_HOST_REFUSED', code: 'COMPANION_ACCOUNT_NOT_PREPARED' })].join('\r\n');
  const launcherText = [JSON.stringify({ name: 'start-companion', result: 'ok', rejectCode: null, detail: null }), '{"status":"BOOTSTRAP_DONE"}'].join('\n');
  const r = ps(`
    $stage = [ordered]@{ 'host-result.json' = [pscustomobject]@{ exit = 1; stdout = ${q(hostOut)} }; 'launcher-result.json' = [pscustomobject]@{ exit = 0; resultText = ${q(launcherText)} } }
    @{ full = (ConvertFrom-DrillFirstInstallSteps @('{"status":"FIRST_INSTALL_STOPPED","stopCode":"HOST_PREPARATION_NOT_DONE","tree":"","node":""}') $stage)
      timeout = (ConvertFrom-DrillFirstInstallSteps @() ([ordered]@{ 'host-result.json' = [pscustomobject]@{ stdoutTail = ${q(hostOut)} }; 'launcher-result.json' = $null }))
      none = (ConvertFrom-DrillFirstInstallSteps @('not json') $null) }`);
  assert.equal(r.full.missing, false);
  // the package's own refusal verdict {status, code, detail} (first-install-host.ps1 Stop-Host) is a refused step as well
  assert.deepEqual(r.full.steps.map(x => [x.stage, x.name, x.rejectCode]), [['host', 'residue', null], ['host', 'wsl', null],
    ['host', 'companion-account', 'COMPANION_ACCOUNT_NOT_PREPARED'], ['host', 'FIRST_INSTALL_HOST_REFUSED', 'COMPANION_ACCOUNT_NOT_PREPARED'],
    ['launcher', 'start-companion', null]]);
  assert.deepEqual(r.full.steps[2].detail, { error: 'GH_EXE_MISSING' });
  assert.equal(r.full.firstRejected, 'companion-account');
  assert.equal(r.full.lastCompletedStep, 'start-companion');
  assert.deepEqual(r.full.verdict, { status: 'FIRST_INSTALL_STOPPED', stopCode: 'HOST_PREPARATION_NOT_DONE' });
  assert.deepEqual(r.full.stages, { entry: 0, host: 4, launcher: 1 });
  assert.equal(r.timeout.missing, false);
  assert.equal(r.timeout.verdict, null);
  assert.equal(r.timeout.noVerdict, true);
  assert.equal(r.timeout.lastStep, 'FIRST_INSTALL_HOST_REFUSED');
  assert.deepEqual(r.timeout.stages, { entry: 0, host: 4, launcher: null });
  assert.equal(r.none.missing, true);
  assert.deepEqual(r.none.steps, []);
  assert.equal(r.none.lastCompletedStep, null);
  // the package as it is today: {step, result} lines, then its refusal verdict
  const today = ps(`ConvertFrom-DrillFirstInstallSteps @() ([ordered]@{ 'host-result.json' = [pscustomobject]@{ stdout = ${q([
    JSON.stringify({ step: 'residue', result: 'none' }),
    JSON.stringify({ status: 'FIRST_INSTALL_HOST_REFUSED', code: 'COMPANION_ACCOUNT_NOT_PREPARED', detail: { exit: 1 } })].join('\n'))} } })`);
  assert.equal(today.firstRejected, 'FIRST_INSTALL_HOST_REFUSED');
  assert.equal(today.steps[1].rejectCode, 'COMPANION_ACCOUNT_NOT_PREPARED');
  assert.deepEqual(today.steps[1].detail, { exit: 1 });
  assert.equal(today.lastCompletedStep, 'residue');
});

// Codex review of ced480363, medium 7: A1 does not pass without its step record; the entry reads the launcher's result file only when it
// is there (a missing one stopped the entry before its own existence check).
test('A1 does not pass without a step record, and the entry reads the launcher result only when there is one', opts, () => {
  assert.equal(pass(verdictOf(evidence())).A1, true);
  assert.equal(pass(verdictOf(evidence({ firstInstallSteps: { missing: true, steps: [] } }))).A1, false);
  assert.equal(pass(verdictOf(evidence({ firstInstallSteps: null }))).A1, false);
  const text = fs.readFileSync(entryScript, 'utf8');
  assert.doesNotMatch(text, /ReadAllText\(\$launcherResult\)\)\s*$/m);
  assert.match(text, /\$launcherText = if \(\[IO\.File\]::Exists\(\$launcherResult\)\) \{ \[IO\.File\]::ReadAllText\(\$launcherResult\) \} else \{ \$null \}\r?\n\s*\$terminal = Get-LastJsonLine \$launcherText/);
});

// Section 2 of the same supplement: the guest evidence is taken whether the first install succeeded, failed or ran out of time, before the
// checkpoint is restored; a failed collection is only recorded. On a timeout the lines the entry printed so far come from its guest log.
test('the guest evidence is collected after a timed-out first install too, and a failed collection is only recorded', opts, () => {
  const runDir = path.join(tmp, 'evidence-run'); fs.mkdirSync(runDir, { recursive: true });
  const runDir2 = path.join(tmp, 'evidence-run-2'); fs.mkdirSync(runDir2, { recursive: true });
  const hostResult = JSON.stringify({ exit: 1, stdout: JSON.stringify({ name: 'residue', result: 'none', rejectCode: null, detail: null }) });
  const r = ps(`
    $script:steps = [Collections.Generic.List[string]]::new()
    $script:Interactive = $false; $script:SkipReinstall = $true
    function New-PSSession { param($VMName, $Credential) 'session' }
    function Remove-PSSession { param($Session) }
    function Copy-Item { param($LiteralPath, $Path, $Destination, $ToSession, [switch]$Recurse) }
    function Invoke-DrillGuest { param($Credential, $Script, $ArgumentList, $TimeoutMinutes, $Code, $Step, [switch]$Restartable)
      $script:steps.Add($Step)
      if ($Step -ceq 'first-install') { throw (New-DrillError 'DRILL_FIRST_INSTALL_TIMEOUT' @{ step = $Step }) }
      if ($Step -ceq 'guest-evidence') {
        if ($script:collectFails) { throw (New-DrillError 'DRILL_GUEST_STEP_FAILED' @{ step = $Step }) }
        return [ordered]@{ 'first-install.stdout.log' = "line one\`r\`n{""name"":""prepare"",""result"":""ok"",""rejectCode"":null,""detail"":null}\`r\`n";
          'stage-timings.json' = '{"host":12.5,"prepare":null,"launcher":null}'; 'host-result.json' = ${q(hostResult)}; 'launcher-result.json' = $null }
      }
      throw "unexpected step $Step"
    }
    $package = @{ version = '1.2.3'; files = @(); tar = 'C:/x/p.tar'; tarSha256 = 'ab' }
    $testKit = [pscustomobject]@{ dir = 'C:/kit'; entryFile = 'first-install-entry.ps1'; arguments = @('-Work', '{work}'); timeoutMinutes = 5; prerequisiteMode = 'first-install-host' }
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
  assert.deepEqual(r.firstSteps, ['first-install', 'guest-evidence']);
  assert.equal(r.record.ok, true);
  assert.deepEqual(r.record.missing, ['launcher-result.json']);
  assert.deepEqual(fs.readFileSync(path.join(runDir, 'first-install.log'), 'utf8').split(/\r?\n/).filter(Boolean),
    ['line one', '{"name":"prepare","result":"ok","rejectCode":null,"detail":null}']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'stage-timings.json'), 'utf8')).host, 12.5);
  assert.deepEqual(r.steps.steps.map(x => [x.stage, x.name]), [['entry', 'prepare'], ['host', 'residue']]);
  assert.equal(r.steps.noVerdict, true);
  assert.equal(r.second, 'DRILL_FIRST_INSTALL_TIMEOUT', 'a failed collection never replaces the run\'s own failure');
  assert.deepEqual(r.secondSteps, ['first-install', 'guest-evidence']);
  assert.equal(r.record2.ok, false);
  assert.equal(r.record2.code, 'DRILL_GUEST_STEP_FAILED');
  assert.equal(r.steps2.missing, true);
});

// Codex review of ced480363, medium 6: what the entry already returned is written before the stage files are asked for, so a failed
// collection loses the stage files only. Medium 8: an interactive run that times out has its evidence collected too.
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
      if ($Step -ceq 'first-install') { return [ordered]@{ lines = @('{"name":"prepare","result":"ok","rejectCode":null,"detail":null}', '{"status":"FIRST_INSTALL_STOPPED","stopCode":"X","tree":"","node":""}'); exit = 1 } }
      if ($Step -ceq 'guest-evidence') { throw (New-DrillError 'DRILL_GUEST_STEP_FAILED' @{ step = $Step }) }
      throw (New-DrillError 'TEST_STOP_AFTER_EVIDENCE')
    }
    function Wait-DrillInteractive { param($RunDir, $Paths, $Cred) $script:steps.Add('interactive'); throw (New-DrillError 'DRILL_INTERACTIVE_TIMEOUT') }
    $package = @{ version = '1.2.3'; files = @(); tar = 'C:/x/p.tar'; tarSha256 = 'ab' }
    $testKit = [pscustomobject]@{ dir = 'C:/kit'; entryFile = 'first-install-entry.ps1'; arguments = @('-Work', '{work}'); timeoutMinutes = 5; prerequisiteMode = 'first-install-host' }
    $script:Interactive = $false
    $kept = try { Invoke-DrillRun ${q(runDir)} $package $testKit $null $null; 'NO THROW' } catch { (Get-DrillCode $_).code }
    $keptSteps = @($script:steps); $script:steps.Clear()
    $script:Interactive = $true
    $interactiveCode = try { Invoke-DrillRun ${q(runDir2)} $package $testKit $null $null; 'NO THROW' } catch { (Get-DrillCode $_).code }
    @{ kept = $kept; keptSteps = $keptSteps; interactive = $interactiveCode; interactiveSteps = @($script:steps)
      record = (Read-DrillJson (Join-Path ${q(runDir)} 'guest-evidence.json')); record2 = (Read-DrillJson (Join-Path ${q(runDir2)} 'guest-evidence.json'))
      steps = (Read-DrillFirstInstallSteps ${q(runDir)}) }`);
  assert.deepEqual(r.keptSteps.slice(0, 2), ['first-install', 'guest-evidence']);
  assert.equal(r.record.ok, false);
  assert.deepEqual(fs.readFileSync(path.join(runDir, 'first-install.log'), 'utf8').split(/\r?\n/).filter(Boolean).length, 2);
  assert.deepEqual(r.steps.steps.map(x => x.name), ['prepare']);
  assert.deepEqual(r.steps.verdict, { status: 'FIRST_INSTALL_STOPPED', stopCode: 'X' });
  assert.equal(r.interactive, 'DRILL_INTERACTIVE_TIMEOUT');
  assert.deepEqual(r.interactiveSteps, ['interactive', 'guest-evidence']);
  assert.equal(r.record2.ok, false);
});

// Codex review of 74e7a65e7, medium 2: the returned entry log that cannot be written is not swallowed: the record says so and is not ok,
// and the guest's copy of the log, once fetched, is written in its place.
test('an entry log that cannot be written is recorded as not saved, the guest copy written instead, and the collection not ok', opts, () => {
  const runDir = path.join(tmp, 'evidence-unsaved'); fs.mkdirSync(runDir, { recursive: true });
  const r = ps(`
    $script:writes = 0
    function Write-DrillLines { param($Path, $Lines) $script:writes++; if ($script:writes -eq 1) { throw 'disk full' }; [IO.File]::WriteAllLines($Path, [string[]]$Lines) }
    function Invoke-DrillGuest { param($Credential, $Script, $ArgumentList, $TimeoutMinutes, $Code, $Step, [switch]$Restartable)
      [ordered]@{ 'first-install.stdout.log' = "guest line one\`r\`nguest line two\`r\`n"; 'stage-timings.json' = '{}'; 'host-result.json' = $null; 'launcher-result.json' = $null } }
    $c = Save-DrillGuestEvidence ${q(runDir)} $null ([ordered]@{ lines = @('returned line'); exit = 0 })
    @{ record = (Read-DrillJson (Join-Path ${q(runDir)} 'guest-evidence.json')); writes = $script:writes }`);
  assert.equal(r.record.ok, false);
  assert.equal(r.record.entryLog, 'guest-log');
  assert.match(r.record.entryLogError, /disk full/);
  assert.equal(r.writes, 2);
  assert.deepEqual(fs.readFileSync(path.join(runDir, 'first-install.log'), 'utf8').split(/\r?\n/).filter(Boolean), ['guest line one', 'guest line two']);
});

// Codex review of f734afe7e, low 1: with no returned output and no guest log there is no entry log: no empty file, no 'guest-log'.
test('with no entry output and no guest log, no entry log is written or claimed', opts, () => {
  const runDir = path.join(tmp, 'evidence-no-log'); fs.mkdirSync(runDir, { recursive: true });
  const r = ps(`
    function Invoke-DrillGuest { param($Credential, $Script, $ArgumentList, $TimeoutMinutes, $Code, $Step, [switch]$Restartable)
      [ordered]@{ 'first-install.stdout.log' = $null; 'stage-timings.json' = '{}'; 'host-result.json' = $null; 'launcher-result.json' = $null } }
    $c = Save-DrillGuestEvidence ${q(runDir)} $null $null
    Read-DrillJson (Join-Path ${q(runDir)} 'guest-evidence.json')`);
  assert.equal(r.entryLog, null);
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes('first-install.stdout.log'));
  assert.equal(fs.existsSync(path.join(runDir, 'first-install.log')), false);
});

// Medium 8: -Finalize rebuilds the items from the receipt; A1's step record stays on it.
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
  const receipt = m5DrillReceipt('steps-receipt', RENEWAL_3BC571A6, { stageEvidence: { 'host-result.json': { exit: 0, stdout:
    JSON.stringify({ name: 'residue', result: 'none', rejectCode: null, detail: null }) }, 'launcher-result.json': null } });
  const a1 = receipt.items.find(i => i.id === 'A1');
  assert.equal(a1.firstInstallSteps.missing, false);
  assert.deepEqual(a1.firstInstallSteps.steps.map(x => x.name), ['residue']);
  const bare = m5DrillReceipt('steps-receipt-missing', RENEWAL_3BC571A6, { checker: 'PASS', missing: [], stageEvidence: null });
  const bareA1 = bare.items.find(i => i.id === 'A1');
  assert.equal(bareA1.firstInstallSteps.missing, true);
  assert.equal(bareA1.pass, false, 'no step record: A1 does not pass');
  assert.equal(bare.conclusion, 'FAIL');
});

function evidence(over = {}) {
  const status = { writtenAt: '2026-11-16T02:59:50Z', node: { mode: 'UNCERTAIN' }, executor: { state: 'IDLE' }, queue: { live: 0 }, halt: null,
    versions: { selfcheck: { result: 'PASS', observedAt: '2026-11-16T02:50:00Z' } } };
  const e = { now: NOW, entry: { exitCode: 0, status: 'FIRST_INSTALL_DONE', stopCode: null, tree: 'C:\\t', node: 'C:\\n.exe', parsed: true },
    verify: { status: 'RESIDENT_VERIFIED' }, status, current: { generation: 1, ciSourceManifestSha256: S, linux: { manifestSha256: L } },
    facts: { generation: 1, staged: null, pinsOk: true, ciSourceManifestSha256: S, manifestSha256: L }, acceptanceSource: S,
    reboot: { ok: true, status, readAt: NOW }, reinstall: { skipped: false, upgradeStatus: 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE', prepareStatus: 'FLEET_NODE_INSTALL_PREPARED',
      launcherExit: 0, launcherStatus: 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED', launcherVerdict: 'BOOTSTRAP_DONE',
      reverifyPassed: true, prepareAgainStatus: 'FLEET_NODE_INSTALL_PREPARED' }, kit: { perNodeSteps: ['8c step 2'] },
    firstInstallSteps: { missing: false, steps: [{ stage: 'host', name: 'residue', result: 'none', rejectCode: null, detail: null }] } };
  return JSON.stringify(Object.assign(e, over));
}
// Build the evidence hashtable in PowerShell from JSON (nested objects as PSCustomObject, as the guest reads give them).
const verdictOf = (json) => ps(`$j = ${q(json)} | ConvertFrom-Json; $h = @{}; foreach ($p in $j.PSObject.Properties) { $h[$p.Name] = $p.Value };
  $h.now = [DateTimeOffset]::Parse($j.now); $items = Get-DrillVerdict $h; [ordered]@{ items = @($items); conclusion = (Get-DrillConclusion $items @{ result = 'PASS' }) }`);
const pass = (r) => Object.fromEntries(r.items.map((i) => [i.id, i.pass]));

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
  const skipped = verdictOf(evidence({ reinstall: { skipped: true } }));
  assert.equal(pass(skipped).A8, null); assert.equal(skipped.conclusion, 'PENDING_PRODUCTION_READBACK');
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
  const tree = fileURLToPath(new URL('../../../', import.meta.url));
  const good = "ConvertTo-Json @{ status = 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED' }";
  const commands = [null, ' ', "ConvertTo-Json @{ status = 'PAUSE_NOT_CONFIRMED' }", `${good}; exit 4`, good];
  const r = ps(`
    function Invoke-MockNode($File) {
      if ((Split-Path -Leaf $File) -eq 'upgrade.mjs') { '{"status":"FLEET_NODE_ALREADY_AT_THIS_PACKAGE"}'; return }
      $prepare = @{ status = 'FLEET_NODE_INSTALL_PREPARED' }
      if ($null -ne $script:runCommand) { $prepare.runCommand = $script:runCommand }
      $prepare | ConvertTo-Json -Compress
    }
    $cases = ConvertFrom-Json -InputObject ${q(JSON.stringify(commands))}
    @($cases | ForEach-Object {
      $script:runCommand = $_
      $ri = & $script:GuestReinstall 'Invoke-MockNode' ${q(tree)} ${q(tmp)} ${q(tmp)} '1.2.3' 'package.tar' 'acceptance.json' 'sha'
      @{ exit = $ri.launcherExit; status = $ri.launcherStatus; verdict = $ri.launcherVerdict; pass = (Test-DrillReinstallLauncher $ri) }
    })`);
  assert.deepEqual(r, [
    { exit: null, status: null, verdict: 'NOT_RUN_MISSING_RUN_COMMAND', pass: false },
    { exit: null, status: null, verdict: 'NOT_RUN_MISSING_RUN_COMMAND', pass: false },
    { exit: 0, status: 'PAUSE_NOT_CONFIRMED', verdict: 'BOOTSTRAP_LAUNCHER_ENDED', pass: false },
    { exit: 4, status: 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED', verdict: 'BOOTSTRAP_DONE', pass: false },
    { exit: 0, status: 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED', verdict: 'BOOTSTRAP_DONE', pass: true },
  ]);
});

const startedAt = '2026-11-16T02:00:00Z';
const readbackRow = { nodes_changed: 0, failover_marked: 0, roles_changed: 0, bindings_created: 0, drill_liveness: 0, live_sources: [S] };
const readbackFor = (row = readbackRow, start = startedAt) => ({ contract: 'clued.drill.production-readback/1', startedAt: start, row });
function finalize(name, fields, row = readbackRow) {
  const receipt = { contract: 'clued.independent-ci.drill-receipt/1', startedAt, evidence: { localSource: S },
    failure: null, restoredToCheckpoint: true, conclusion: 'PENDING_PRODUCTION_READBACK', m5: { result: 'PASS' }, ...fields };
  const receiptFile = path.join(tmp, `${name}.json`);
  const readback = path.join(tmp, 'readback.json');
  const original = JSON.stringify(receipt);
  fs.writeFileSync(receiptFile, original);
  fs.writeFileSync(readback, JSON.stringify(readbackFor(row, receipt.startedAt)));
  const run = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Finalize', receiptFile, '-ProductionReadback', readback], { encoding: 'utf8', timeout: 120000 });
  const bytes = fs.readFileSync(receiptFile, 'utf8');
  return { receipt, receiptFile, original, bytes, status: run.status, output: JSON.parse(run.stdout.trim()) };
}

test('-Finalize judges A5 and A9 from one read-only production read-back and rewrites the receipt', opts, () => {
  const sql = ps(`Get-DrillReadbackSql ${q(startedAt)}`);
  assert.match(sql, /ci_nodes_v1/); assert.match(sql, /binding_roles_v1/); assert.doesNotMatch(sql, /\b(insert|update|delete)\b\s/i);
  assert.equal(psCode(`Get-DrillReadbackSql ${q("x'; drop table t; --")}`), 'DRILL_STARTED_AT_REFUSED');
  const items = verdictOf(evidence()).items;
  const { receipt, receiptFile, status, output, bytes } = finalize('receipt', { items });
  assert.equal(status, 0);
  assert.deepEqual(output, { status: 'DRILL_FINALIZED', conclusion: 'PASS_A_PER_NODE_STEPS_REMAIN', receipt: receiptFile });
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
  assert.equal(psCode(`New-DrillFakeCredentials ${q(out)}`), 'DRILL_UNEXPECTED', 'never reuses a directory');
});
