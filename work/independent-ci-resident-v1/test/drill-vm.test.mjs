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
import * as drillKit from '../drill/make-drill-kit.mjs';
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
// A package's two credential constants (Fable renew-key ruling, supplement "heartbeat token and restart code"), as the host preparation
// script declares them; make-drill-kit.mjs packageCredentials reads them.
const PACKAGE_CREDENTIALS = { required: { appKey: 'app-private-key.pem', ciToken: 'ci-admission.token', upgradeToken: 'resident-upgrade.token', public: 'public.json' },
  optional: { heartbeatToken: 'ci-node-heartbeat.token' } };
const hostScriptText = (c = PACKAGE_CREDENTIALS) => {
  const lit = o => '[ordered]@{ ' + Object.entries(o).map(([k, v]) => `${k} = '${v}'`).join('; ') + ' }';
  return `# host preparation\r\n$RequiredCredentialFiles = ${lit(c.required)}\r\n$OptionalCredentialFiles = ${lit(c.optional)}\r\n`;
};

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
  assert.equal(manifest.perNodeSteps.length, 4);   // the three bypassed shell points and the Expand-Cached stand-in (#1154)
  assert.match(manifest.perNodeSteps.join(" "), /非提权.*RunAs.*凭据窗口.*短路径/);
  assert.equal(manifest.prerequisiteMode, 'first-install-host');
  assert.equal(Object.hasOwn(manifest, 'executionBlocker'), false);
  assert.ok(manifest.entry.arguments.every(a => /^(-[A-Za-z]+|\{(from|kit|fake|work|version)\})$/.test(a)));
  for (const f of manifest.files) assert.equal(f.sha256, sha(inputs.payloads[f.path]));
  for (const timeoutMinutes of [4, 241, 5.5]) assert.throws(() => drillKitManifest({ ...inputs, timeoutMinutes }), /TIMEOUT_REFUSED/);
  assert.throws(() => drillKitManifest({ ...inputs, prereqBytes: Buffer.from('{}') }), /PREREQ_CONTRACT_REFUSED/);
  assert.throws(() => readSums(`${'a'.repeat(64)}  x\n${'b'.repeat(64)}  X\n`), /SUMS_REFUSED/);
  assert.throws(() => readSums(`${'a'.repeat(64)}  ../x\n`), /SUMS_REFUSED/);
});

function firstInstallAssets(label, { candidate = false, hostText = hostScriptText() } = {}) {
  const root = path.join(tmp, label); fs.mkdirSync(root);
  for (const d of ['build', 'final', 'images']) fs.mkdirSync(path.join(root, d));
  const version = '1.2.3', tag = `fleet-node-${version}`, id = 'b'.repeat(64);
  const image = `role-image-${id}.tar.gz`;
  const kit = Buffer.from(JSON.stringify({ contract: 'clued.independent-ci.fleet-node-first-install-kit/1', images: { local: [{ id, asset: image }] } }));
  const archive = writeTar([...['bootstrap.ps1', 'prereq-manifest.json'].map(n => ({
    path: `tree/work/independent-ci-resident-v1/rollout/fleet/${n}`,
    data: Buffer.from(n.endsWith('.ps1') ? '# accepted bootstrap\r\n' : JSON.stringify({ items: [
      { fileName: 'wsl.msi', sha256: sha('wsl'), bytes: 3 }, { fileName: 'ubuntu.wsl', sha256: sha('rootfs'), bytes: 6 },
      { name: 'gh', fileName: 'gh.msi', sha256: sha('gh'), bytes: 2 }, { name: 'git-for-windows', fileName: 'git.exe', sha256: sha('git'), bytes: 3 }
    ], debs: [{ fileName: 'docker.deb', sha256: sha('deb'), bytes: 3 }] })) })),
    { path: 'tree/work/independent-ci-resident-v1/windows/first-install-host.ps1', data: Buffer.from(hostText) },
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
    debs: [{ path: 'docker.deb', sha256: sha('deb') }], tools: [{ path: 'gh.msi', sha256: sha('gh') }, { path: 'git.exe', sha256: sha('git') }] }));
  for (const [name, bytes] of [['wsl.msi', 'wsl'], ['ubuntu.wsl', 'rootfs'], ['docker.deb', 'deb'], ['gh.msi', 'gh'], ['git.exe', 'git']]) fs.writeFileSync(path.join(root, name), bytes);
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
  // the drilled package's two credential groups go into the kit; a package that does not declare them gets no kit
  assert.deepEqual(manifest.credentials, PACKAGE_CREDENTIALS);
  const oneConstant = firstInstallAssets('assembly-one-constant', { hostText: "$CredentialFiles = [ordered]@{ appKey = 'app-private-key.pem'; ciToken = 'ci-admission.token' }\r\n" });
  prepareFrom({ ...oneConstant, out: oneConstant.from });
  await assert.rejects(() => makeDrillKit(oneConstant), /DRILL_PACKAGE_CREDENTIALS_UNREADABLE/);
  assert.ok(!fs.existsSync(oneConstant.out), 'refused before writing a kit');
  // the host's pinned installers (gh, Git for Windows) go into the guest through the same injection as WSL and the rootfs (Fable,
  // supplement "after the package branch" 3, 1): never downloaded in the guest
  assert.ok(manifest.files.some(i => i.path === 'gh.msi'), JSON.stringify(manifest.files.map(i => i.path)));
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
    function Read-DrillKit { @{ sha256 = 'kit'; prereqSha256 = 'prereq'; executionBlocker = $null; credentials = (${q(JSON.stringify(PACKAGE_CREDENTIALS))} | ConvertFrom-Json) } }
    function Get-DrillReleaseFiles { }
    function Assert-DrillKitCredentialsBound { }
    function Assert-DrillKitToolsBound { }
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

// Fable renew-key ruling, supplement "eight on the path", item 8: the connection record is judged by what the guest administrator reads
// (record.json: PRESENT or ABSENT); the companion's own observation must match it (renewal-drill.mjs, test/self-renewal.test.mjs).
test('M5 collects the six public observations and the administrator\'s read of the connection record, and requires the host checker', opts, () => {
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
    ['companion.json', 'controller.json', 'probe.json', 'profile.json', 'record.json', 'resident.json', 'system.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'm5', 'profile.json'), 'utf8')), profile);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'm5', 'probe.json'), 'utf8')), probe);
  // a first install has no connection record: the guest administrator reads it as absent
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'm5', 'record.json'), 'utf8')), { 'ci-admission.connection.json': 'ABSENT' });
  fs.writeFileSync(path.join(simulatedHost, 'test', 'renewal-drill.mjs'),
    'import fs from "node:fs"; if (fs.readdirSync(process.argv[2]).length !== 7) process.exit(1); console.log(\'{"result":"PASS"}\');');
  const present = runM5();
  assert.equal(present.result, 'PASS');
  assert.deepEqual(present.verdict, { result: 'PASS' });
  // the record there: read as present (its content is neither read nor exported)
  put(path.join(root, 'secrets', 'ci-admission.connection.json'), { secret: 'not exported' });
  fs.rmSync(path.join(runDir, 'm5'), { recursive: true });
  runM5();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'm5', 'record.json'), 'utf8')), { 'ci-admission.connection.json': 'PRESENT' });
});

// A receipt from Invoke-DrillPreparedRun over a package whose manifest lists `paths` (full archive paths), with A1-A8 passing, the
// M5 observations `missing` and a host checker that answers `checker`.
// The complete stdout logs of a first install that went through (Read-DrillFirstInstallSteps reads them from the run directory).
const STEP_LOGS = {
  'first-install.log': JSON.stringify({ status: 'FIRST_INSTALL_DONE', stopCode: null, tree: 'C:\\t', node: 'C:\\n.exe' }) + '\r\n',
  'host.stdout.log': [JSON.stringify({ name: 'stage', result: 'ok' }), JSON.stringify({ status: 'FIRST_INSTALL_HOST_READY' })].join('\r\n') + '\r\n',
  'prepare.stdout.log': JSON.stringify({ status: 'FLEET_NODE_FIRST_INSTALL_PREPARED' }) + '\r\n',
  'launcher.stdout.log': [JSON.stringify({ name: 'install', result: 'ok' }), JSON.stringify({ status: 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED' })].join('\r\n') + '\r\n',
  'stage-evidence.json': JSON.stringify({ 'host-result.json': { exit: 0, terminal: { status: 'FIRST_INSTALL_HOST_READY' } },
    'launcher-result.json': { exit: 0, terminal: { status: 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED' } } }),
};
// skip: the run was started with -SkipReinstall; reinstall: 'absent' leaves the run without an A8 result at all; steps: false leaves the
// run directory without the first install's logs.
function m5DrillReceipt(name, paths, { checker = 'FAIL', missing = ['probe.json'], candidate = false, version = '1.2.3', pkg = {}, reinstall = null, skip = false, steps = true } = {}) {
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
  const run = { first: { ...e, readAt: e.now }, entry: e.entry, launcher: e.launcher, reboot: e.reboot, reinstall: reinstall ?? e.reinstall,
    timings: {}, m5: null };
  if (reinstall === 'absent') delete run.reinstall;
  const receipt = ps(`
    ${skip ? '$SkipReinstall = $true' : ''}
    $script:Drill.Runs = ${q(root)}
    $script:DrillScriptPath = ${q(path.join(root, 'drill', 'drill-vm.ps1'))}
    function Assert-DrillHost { @{ freeGB = 20 } }
    function Invoke-DrillWithHostHold { throw 'HOST_HOLD_MUST_NOT_RUN' }
    function Get-DrillIntakeTool { throw 'HOST_HOLD_MUST_NOT_RUN' }
    function Invoke-DrillBaseline { @{ action = 'reuse' } }
    $fixture = ${q(JSON.stringify(run))} | ConvertFrom-Json
    $fixture.m5 = @{ directory = 'm5'; missing = @(${missing.map(q).join(', ')}); collectionCode = $null }
    $script:stepLogs = ${q(JSON.stringify(steps ? STEP_LOGS : {}))} | ConvertFrom-Json
    function Invoke-DrillOnCheckpoint { param($Body, $RunDir, $Window)
      foreach ($p in $script:stepLogs.PSObject.Properties) { [IO.File]::WriteAllText((Join-Path $RunDir $p.Name), [string]$p.Value) }
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

// The three PASS conclusions a receipt can end in are the set seal takes (publish.mjs exports it; one definition there): held equal here so
// neither side can rename one alone. PASS_A_REINSTALL_NOT_DRILLED: a candidate that skipped A8 (Fable ruling, supplement "candidate skips A8").
test('the PASS conclusions of drill-vm.ps1 are exactly publish.mjs DRILL_PASS_CONCLUSIONS, the set seal takes', () => {
  const text = fs.readFileSync(script, 'utf8');
  const fn = text.slice(text.indexOf('function Get-DrillConclusion'), text.indexOf('\n}', text.indexOf('function Get-DrillConclusion')));
  const mine = [...new Set([...fn.matchAll(/'(PASS_[A-Z_]+)'/g)].map(m => m[1]))].sort();
  assert.deepEqual(mine, ['PASS_A_FULL', 'PASS_A_PER_NODE_STEPS_REMAIN', 'PASS_A_REINSTALL_NOT_DRILLED']);
  assert.deepEqual([...DRILL_PASS_CONCLUSIONS].sort(), mine);
  // the operator's guide to seal names the same set (Codex review of 58136df61, low 5)
  const guide = fs.readFileSync(fileURLToPath(new URL('../rollout/fleet/README.md', import.meta.url)), 'utf8');
  const sealLine = guide.split('\n').find(l => l.includes('seal --drill-receipt'));
  for (const c of DRILL_PASS_CONCLUSIONS) assert.ok(sealLine.includes(c), c);
});

// Fable renew-key ruling, supplements "merge order" and "heartbeat token and restart code": the drill is held to the package it drills.
// The package declares required and optional credential names; the drill gives every required one, and has an explicit decision for every
// optional one (give, or withhold by design with the reason); otherwise no boot. The heartbeat token is withheld: no fake one is made.
const decisionsOf = () => ps(`$script:DrillCredentialDecisions`);
const planOf = credentials => ps(`try { Get-DrillCredentialPlan (${q(JSON.stringify({ credentials }))} | ConvertFrom-Json) } catch { $c = Get-DrillCode $_; [ordered]@{ code = $c.code; detail = $c.detail } }`);
test('the credential plan: every required name given, every optional name decided, the heartbeat token withheld with its reason', opts, () => {
  const plan = planOf(PACKAGE_CREDENTIALS);
  assert.deepEqual(plan.given, ['app-private-key.pem', 'ci-admission.token', 'resident-upgrade.token', 'public.json']);
  assert.deepEqual(plan.fake, ['app-key.pem', 'ci-admission.token', 'resident-upgrade.token', 'public.json']);
  assert.equal(plan.withheld.length, 1);
  assert.equal(plan.withheld[0].name, 'ci-node-heartbeat.token');
  assert.match(plan.withheld[0].reason, /production heartbeat endpoint/);
  // a required name the drill cannot give, an optional name it has not decided, a kit without the two groups: refused by name
  assert.deepEqual(planOf({ ...PACKAGE_CREDENTIALS, required: { ...PACKAGE_CREDENTIALS.required, other: 'other-required.token' } }), { code: 'DRILL_CREDENTIAL_REQUIRED_NOT_MADE', detail: 'other-required.token' });
  assert.deepEqual(planOf({ ...PACKAGE_CREDENTIALS, optional: { ...PACKAGE_CREDENTIALS.optional, other: 'other-optional.token' } }), { code: 'DRILL_CREDENTIAL_OPTIONAL_UNDECIDED', detail: 'other-optional.token' });
  assert.deepEqual(planOf({ ...PACKAGE_CREDENTIALS, required: { ...PACKAGE_CREDENTIALS.required, heartbeatToken: 'ci-node-heartbeat.token' }, optional: {} }), { code: 'DRILL_CREDENTIAL_REQUIRED_NOT_MADE', detail: 'ci-node-heartbeat.token' });
  assert.equal(planOf(undefined).code, 'DRILL_KIT_REFUSED');
  // a package without an optional heartbeat: nothing withheld, nothing made for it
  assert.deepEqual(planOf({ ...PACKAGE_CREDENTIALS, optional: {} }).withheld, []);
  // refused before the host gate, the hold or any boot
  const undecided = { ...PACKAGE_CREDENTIALS, optional: { other: 'other-optional.token' } };
  assert.equal(psCode(`${candidateStubs}
    function Read-DrillKit { @{ prereqSha256 = 'pin'; executionBlocker = $null; candidate = @{ acceptance = 'x' }; credentials = (${q(JSON.stringify(undecided))} | ConvertFrom-Json) } }
    Invoke-DrillMain`), 'DRILL_CREDENTIAL_OPTIONAL_UNDECIDED');
  // the receipt lists what was given and the optional ones withheld this run
  const receipt = m5DrillReceipt('credentials-receipt', RENEWAL_3BC571A6, { checker: 'PASS', missing: [] });
  assert.deepEqual(receipt.credentials.withheld.map(w => w.name), ['ci-node-heartbeat.token']);
  assert.ok(receipt.credentials.given.includes('ci-admission.token'));
  // registered with its reason in the guide
  const guide = fs.readFileSync(fileURLToPath(new URL('../drill/FIRST-INSTALL-KIT.md', import.meta.url)), 'utf8');
  assert.match(guide, /`ci-node-heartbeat\.token` \| 按设计不给/);
});

// Codex review of e0a3cded5, high 2: the run binds the kit's credential names again to the package it drills -- derived from the verified
// tar by the one reader (make-drill-kit.mjs --credentials-of) and compared; a kit edited to drop a required name, or emptied, is refused.
test('the run binds the kit\'s credential names again to the package it drills: any difference refuses before boot', opts, async () => {
  const f = firstInstallAssets('bound-credentials');
  prepareFrom({ ...f, out: f.from });
  await makeDrillKit(f);
  const tar = path.join(f.from, `fleet-node-${f.version}.tar`);
  const bound = (t = tar) => psCode(`Assert-DrillKitCredentialsBound (Read-DrillKit ${q(f.out)}) ${q(t)}`);
  assert.equal(bound(), null);
  const kitFile = path.join(f.out, 'kit.json');
  const kit = JSON.parse(fs.readFileSync(kitFile, 'utf8'));
  const put = credentials => fs.writeFileSync(kitFile, JSON.stringify({ ...kit, credentials }, null, 2));
  const { upgradeToken, ...withoutOne } = PACKAGE_CREDENTIALS.required;
  put({ ...PACKAGE_CREDENTIALS, required: withoutOne });
  assert.equal(bound(), 'DRILL_KIT_CREDENTIALS_NOT_THE_PACKAGES', 'a required name dropped from the kit');
  put({ required: {}, optional: {} });
  assert.equal(bound(), 'DRILL_KIT_CREDENTIALS_NOT_THE_PACKAGES', 'emptied');
  assert.equal(planOf({ required: {}, optional: {} }).code, 'DRILL_KIT_REFUSED', 'an empty required group is no plan either');
  put(PACKAGE_CREDENTIALS);
  assert.equal(bound(), null);
  // a tar whose host preparation does not declare the two: unreadable
  const old = firstInstallAssets('bound-credentials-old', { hostText: "$CredentialFiles = [ordered]@{ appKey = 'app-private-key.pem' }\r\n" });
  assert.equal(bound(path.join(old.build, `fleet-node-${old.version}.tar`)), 'DRILL_PACKAGE_CREDENTIALS_UNREADABLE');
  // the run calls it before the host gate, on the package's verified tar
  assert.match(fs.readFileSync(script, 'utf8'), /Assert-DrillKitCredentialsBound \$kitInfo \$package\.tar/);
});

// Codex review of e0a3cded5, high 3: the package's gh and Git for Windows installers are injected, both and with the package's hashes, or
// there is no kit and no boot; the entry never fetches them in the guest.
test('gh and Git for Windows: in the kit with the package\'s hashes or no kit, no boot; never downloaded in the guest', opts, async () => {
  const f = firstInstallAssets('tools-bound');
  prepareFrom({ ...f, out: f.from });
  await makeDrillKit(f);
  const manifest = path.join(f.from, `fleet-node-${f.version}.prereq-manifest.json`);
  const gate = () => psCode(`Assert-DrillKitToolsBound (Read-DrillKit ${q(f.out)}) ${q(manifest)}`);
  assert.equal(gate(), null);
  const kitFile = path.join(f.out, 'kit.json');
  const kit = JSON.parse(fs.readFileSync(kitFile, 'utf8'));
  fs.writeFileSync(kitFile, JSON.stringify({ ...kit, files: kit.files.filter(i => i.path !== 'gh.msi') }, null, 2));
  assert.equal(psCode(`try { Assert-DrillKitToolsBound (Read-DrillKit ${q(f.out)}) ${q(manifest)}; $null } catch { (Get-DrillCode $_).detail }`), 'gh');
  assert.equal(gate(), 'DRILL_KIT_TOOL_NOT_INJECTED');
  // a prerequisite list without one of them: no kit
  const short = firstInstallAssets('tools-short');
  const p = JSON.parse(fs.readFileSync(short.prereq, 'utf8'));
  fs.writeFileSync(short.prereq, JSON.stringify({ ...p, tools: p.tools.filter(t => t.path !== 'git.exe') }));
  prepareFrom({ ...short, out: short.from });
  await assert.rejects(() => makeDrillKit(short), /DRILL_PREREQ_TOOLS_INCOMPLETE:git-for-windows/);
  // the run calls the gate; the entry stops on a missing injected one instead of downloading it
  assert.match(fs.readFileSync(script, 'utf8'), /Assert-DrillKitToolsBound \$kitInfo \(Join-Path \$From "fleet-node-\$Version\.prereq-manifest\.json"\)/);
  assert.match(fs.readFileSync(entryScript, 'utf8'), /\} elseif \(@\('gh', 'git-for-windows'\) -ccontains \[string\]\$item\['name'\]\) \{ throw \('DRILL_PREREQ_NOT_INJECTED:' \+ \$item\['name'\]\) \}\s*else \{ \$file = Get-Prereq \$item \$pre \}/);
});

test('the repository\'s package and the drill: required names the drill makes, optional names it decides; the hand-over agrees', opts, () => {
  const read = rel => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const decisions = decisionsOf();
  const given = Object.keys(decisions).filter(n => decisions[n].give === true);
  const covers = c => ({ required: Object.values(c.required).filter(n => !given.includes(n)), optional: Object.values(c.optional).filter(n => !Object.hasOwn(decisions, n)) });
  // the repository's package: with the two groups, every required name is one the drill makes and every optional one is decided; a package
  // still on the one-constant form gets no kit (refused by name, never read as "nothing required")
  const hostText = read('../windows/first-install-host.ps1');
  let repo = null;
  try { repo = drillKit.packageCredentials(hostText); } catch (e) { assert.equal(e.message, 'DRILL_PACKAGE_CREDENTIALS_UNREADABLE'); }
  if (repo) assert.deepEqual(covers(repo), { required: [], optional: [] }, JSON.stringify(repo));
  else assert.doesNotMatch(hostText, /^\$RequiredCredentialFiles/m);
  // the check itself: the two-group form as the package branch declares it
  assert.deepEqual(covers(drillKit.packageCredentials(hostScriptText())), { required: [], optional: [] });
  assert.deepEqual(covers(drillKit.packageCredentials(hostScriptText({ required: { ...PACKAGE_CREDENTIALS.required, x: 'x.token' }, optional: { y: 'y.token' } }))),
    { required: ['x.token'], optional: ['y.token'] });
  assert.throws(() => drillKit.packageCredentials(hostScriptText({ required: { a: 'a.token' }, optional: { b: 'a.token' } })), /DRILL_PACKAGE_CREDENTIALS_UNREADABLE/);
  // the two lines as the package branch holds them (claude/first-install-fixes 913be48ca), read as they are. Its required
  // companion-github.token is made by branch one's generator: until that is merged here (with a decision for the name), a drill of this
  // package is refused before boot, by name -- never drilled without the token
  const branchLines = [
    "$RequiredCredentialFiles = [ordered]@{ appKey = 'app-private-key.pem'; ciToken = 'ci-admission.token'; upgradeToken = 'resident-upgrade.token'; public = 'public.json'; companionToken = 'companion-github.token' }",
    "$OptionalCredentialFiles = [ordered]@{ heartbeatToken = 'ci-node-heartbeat.token' }",
    "$CredentialFiles = & { $o = [ordered]@{}; foreach ($m in @($RequiredCredentialFiles, $OptionalCredentialFiles)) { foreach ($k in @($m.Keys)) { $o[$k] = $m[$k] } }; $o }",
  ].join('\r\n') + '\r\n';
  const branch = drillKit.packageCredentials(branchLines);
  assert.deepEqual(branch.optional, { heartbeatToken: 'ci-node-heartbeat.token' });
  assert.equal(branch.required.companionToken, 'companion-github.token');
  assert.deepEqual(covers(branch), { required: given.includes('companion-github.token') ? [] : ['companion-github.token'], optional: [] });
  // every name given is made by the generator and handed over by the entry under the package's name; one rename only, nothing twice
  const drillText = fs.readFileSync(script, 'utf8');
  const generator = drillText.slice(drillText.indexOf('function New-DrillFakeCredentials'), drillText.indexOf('\n}', drillText.indexOf('function New-DrillFakeCredentials')));
  const made = [...new Set([...generator.matchAll(/Join-Path \$OutDir '([^']+)'/g)].map(m => m[1]))];
  const entryText = read('../drill/first-install-entry.ps1');
  const table = entryText.slice(entryText.indexOf('foreach ($pair in @('), entryText.indexOf('$source = Join-Path $FakeInputs $pair[0]'));
  const pairs = [...table.matchAll(/@\('([^']+)', '([^']+)'\)/g)].map(m => [m[1], m[2]]);
  const handOver = new Map([...pairs.map(([from, to]) => [to, from]), ['public.json', 'public.json']]);
  for (const name of given) {
    assert.ok(made.includes(decisions[name].fake), `the generator makes ${decisions[name].fake}`);
    assert.equal(handOver.get(name), decisions[name].fake, `the entry hands ${decisions[name].fake} over as ${name}`);
  }
  const targets = pairs.map(([, to]) => to);
  assert.equal(new Set(targets).size, targets.length, 'no target twice');
  assert.deepEqual(pairs.filter(([from, to]) => from !== to), [['app-key.pem', 'app-private-key.pem']], 'the one rename there is');
  assert.ok(targets.every(t => given.includes(t)), 'the entry hands over nothing the drill does not give');
  assert.ok(!made.includes('ci-node-heartbeat.token'), 'no fake heartbeat token is ever made');
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

// Fable renew-key ruling, supplement "candidate skips A8" (replaces the two tests that locked Codex review of PR-甲, blocking 1): the
// blocking guarded against a skipped candidate earning a PASS that looks like a full one. Now the skip is an explicit option (never the
// default: a candidate without -SkipReinstall runs A8 and needs it true), and a candidate that skipped A8 can end in one value only,
// PASS_A_REINSTALL_NOT_DRILLED, which seal takes and writes into the index as it is: "not the same value" is what tells the two apart.
const candidateStubs = `
    $Version = '1.2.3'; $From = 'unused'; $Kit = 'unused'
    function Read-DrillPrereq { @{ sha256 = 'pin' } }
    function Read-DrillKit { @{ prereqSha256 = 'pin'; executionBlocker = $null; candidate = @{ acceptance = 'x' }; credentials = (${q(JSON.stringify(PACKAGE_CREDENTIALS))} | ConvertFrom-Json) } }
    function Test-DrillPackageDir { @{ tar = 'unused'; candidate = $true } }
    function Get-DrillReleaseFiles { @('unused') }
    function Assert-DrillHost { throw (New-DrillError 'TEST_REACHED_HOST_GATE') }
    # never the real host hold, whatever the code does (Clued Task fe8a2cbf)
    function Invoke-DrillWithHostHold { throw (New-DrillError 'TEST_REACHED_HOST_HOLD') }
    function Get-DrillIntakeTool { throw (New-DrillError 'TEST_REACHED_HOST_HOLD') }
    function Assert-DrillKitCredentialsBound { }
    function Assert-DrillKitToolsBound { }`;
test('a candidate run with -SkipReinstall is no longer refused before the host gate; without it, as before', opts, () => {
  assert.equal(psCode(`${candidateStubs}; $SkipReinstall = $true; Invoke-DrillMain`), 'TEST_REACHED_HOST_HOLD');
  assert.equal(psCode(`${candidateStubs}; Invoke-DrillMain`), 'TEST_REACHED_HOST_HOLD');
  assert.doesNotMatch(fs.readFileSync(script, 'utf8'), /DRILL_CANDIDATE_CANNOT_SKIP/);
});

// Fable renew-key ruling, supplement "interactive mode A1": the step record must come from the same complete stdout log by the same parser,
// and keeping a copy of the operator's window is not enough here: the elevated stages run in their own window and their output (the host
// preparation's step lines) goes to their result files, never back to that window. Until the source is connected, interactive mode is
// refused before anything is read, booted or held.
test('interactive mode is refused before the host gate while its step record has no source', opts, () => {
  assert.equal(psCode(`${candidateStubs}; $Interactive = $true; Invoke-DrillMain`), 'DRILL_INTERACTIVE_STEP_RECORD_NOT_CONNECTED');
  assert.equal(psCode('$Interactive = $true; $BaselineOnly = $true; Invoke-DrillMain'), 'DRILL_USAGE');
  assert.equal(psCode(`${candidateStubs}; Invoke-DrillMain`), 'TEST_REACHED_HOST_HOLD');
  // the guide says it as the ruling does: one parser, the source by mode, the interactive wiring in drill branch three (Codex review of
  // 1cedea9ef, low 5)
  const guide = fs.readFileSync(fileURLToPath(new URL('../drill/FIRST-INSTALL-KIT.md', import.meta.url)), 'utf8');
  for (const words of ['解析器只有一个', '来源随模式不同', 'elevated-host-*.txt', '演练分支三']) assert.ok(guide.includes(words), words);
  assert.ok(!guide.includes('同一来源、同一解析器'));
});

test('a candidate that skipped A8 ends PASS_A_REINSTALL_NOT_DRILLED through the real conclusion, -Finalize and seal', opts, async t => {
  const w = await sealWorld(t);
  const pkg = { tarSha256: w.request.archive_sha256, firstInstallKitSha256: w.request.firstInstallKitSha256 };
  // the receipt Invoke-DrillPreparedRun writes for a candidate whose A8 was skipped (no entry, no host hold: m5DrillReceipt stubs them)
  const skipped = m5DrillReceipt('cand-skip', RENEWAL_3BC571A6, { checker: 'PASS', missing: [], candidate: true, version: w.version, pkg, reinstall: { skipped: true }, skip: true });
  const a8 = skipped.items.find(i => i.id === 'A8');
  assert.equal(a8.pass, null);
  assert.match(a8.detail, /^skipped \(-SkipReinstall\)/);
  assert.match(a8.detail, /同包重装未演练/);
  const done = finalize('cand-skip-finalize', skipped, notTheDrillsSource());
  const r = await w.sealIt(done.receiptFile);
  // each link of the chain, side by side
  assert.deepEqual({ run: skipped.conclusion, finalize: done.output.conclusion ?? done.output.code, seal: r.status },
    { run: 'PENDING_PRODUCTION_READBACK', finalize: 'PASS_A_REINSTALL_NOT_DRILLED', seal: 'FLEET_ACCEPTANCE_SEALED' });
  // the index's drill cell carries the value as it is, with the receipt's hash
  const cell = `PASS_A_REINSTALL_NOT_DRILLED receipt ${sha(fs.readFileSync(done.receiptFile))}`;
  assert.equal(r.drill, cell);
  assert.ok(fs.readFileSync(w.index, 'utf8').includes(cell));
  // a production write during the drill still fails the candidate
  assert.equal(finalize('cand-skip-a9', skipped, { ...notTheDrillsSource(), bindings_created: 1 }).output.conclusion, 'FAIL');
  // an accepted version's re-drill skipping A8: unchanged
  const reDrill = m5DrillReceipt('acc-skip', RENEWAL_3BC571A6, { checker: 'PASS', missing: [], reinstall: { skipped: true }, skip: true });
  assert.equal(reDrill.conclusion, 'PENDING_PRODUCTION_READBACK');
  assert.equal(finalize('acc-skip-finalize', reDrill).output.conclusion, 'PASS_A_PER_NODE_STEPS_REMAIN');
});

test('a candidate that skipped A8 can never be PASS_A_FULL or PASS_A_PER_NODE_STEPS_REMAIN; one without the option needs A8 true', opts, () => {
  const ids = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10'];
  const skippedA8 = { id: 'A8', pass: null, detail: 'skipped (-SkipReinstall): same-package reinstall not drilled (同包重装未演练)' };
  const cases = [];
  // every item but A8 true / false / not judged, A10 true or false, M5 PASS or FAIL
  for (const id of ids.filter(i => i !== 'A8')) for (const value of [true, false, null]) for (const a10 of [true, false]) for (const m5 of ['PASS', 'FAIL']) {
    const items = ids.map(i => i === 'A8' ? skippedA8 : { id: i, pass: i === 'A10' ? a10 : true, detail: 'x' });
    items.find(i => i.id === id).pass = value;
    if (id === 'A10') items.find(i => i.id === 'A10').pass = value === null ? false : value;
    cases.push({ items, m5, candidate: true });
  }
  const casesFile = path.join(tmp, 'skip-a8-cases.json'); fs.writeFileSync(casesFile, JSON.stringify(cases));   // too long for a command line
  const r = ps(`$cases = Get-Content -LiteralPath ${q(casesFile)} -Raw -Encoding UTF8 | ConvertFrom-Json
    @($cases | ForEach-Object { Get-DrillConclusion $_.items @{ result = $_.m5 } $true })`);
  assert.equal(r.length, cases.length);
  assert.ok(r.every(c => !['PASS_A_FULL', 'PASS_A_PER_NODE_STEPS_REMAIN'].includes(c)), JSON.stringify([...new Set(r)]));
  // all the others pass: exactly the one value, whether or not per-node steps remain (the larger gap is the one reported)
  const allPass = a10 => ids.map(i => i === 'A8' ? skippedA8 : { id: i, pass: i === 'A10' ? a10 : true, detail: 'x' });
  const conclude = (items, candidate = true, m5 = 'PASS') => ps(`Get-DrillConclusion (${q(JSON.stringify(items))} | ConvertFrom-Json) @{ result = '${m5}' } $${candidate}`);
  assert.equal(conclude(allPass(true)), 'PASS_A_REINSTALL_NOT_DRILLED');
  assert.equal(conclude(allPass(false)), 'PASS_A_REINSTALL_NOT_DRILLED');
  assert.equal(conclude(allPass(false), true, 'FAIL'), 'FAIL');
  // a candidate without the option: A8 not run or false is FAIL, as before; A8 true keeps the two values
  const withA8 = (pass, detail) => allPass(false).map(i => i.id === 'A8' ? { id: 'A8', pass, detail } : i);
  assert.equal(conclude(withA8(false, 'upgrade=NOT_RUN_ENTRY_GAVE_NO_TREE_OR_NODE')), 'FAIL');
  assert.equal(conclude(withA8(null, 'not run')), 'FAIL');
  assert.equal(conclude(withA8(true, 'x')), 'PASS_A_PER_NODE_STEPS_REMAIN');
  // not a candidate: unchanged (a skipped A8 is a diagnosis)
  assert.equal(conclude(allPass(false), false), 'PASS_A_PER_NODE_STEPS_REMAIN');
  assert.equal(conclude(allPass(true), false), 'PASS_A_FULL');
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
  // the host's pinned gh and Git for Windows installers, from their official releases only
  const gh = { path: 'gh_2.103.3_windows_amd64.msi', url: 'https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_windows_amd64.msi' };
  const git = { path: 'Git-2.55.0.3-64-bit.exe', url: 'https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.3/Git-2.55.0.3-64-bit.exe' };
  const withTools = prereqDir('pre-tools', (p, dir, put) => ({ ...p, tools: [{ ...gh, sha256: put(gh.path, 'gh') }, { ...git, sha256: put(git.path, 'git') }] }));
  assert.deepEqual(ps(`[ordered]@{ tools = @((Read-DrillPrereq ${q(withTools)}).tools) }`).tools, [gh.path, git.path]);
  assert.equal(psCode(`Read-DrillPrereq ${q(prereqDir('pre-tools-mirror', (p, dir, put) => ({ ...p, tools: [{ ...gh, url: 'https://example.net/gh.msi', sha256: put(gh.path, 'gh') }] })))}`), 'DRILL_PREREQ_REFUSED');
});

const NOW = '2026-11-16T03:00:00Z';
const S = '5'.repeat(64), L = '7'.repeat(64);
// The pause the launcher confirmed (its terminal's pause.requestSha256) and state\PAUSED.json naming that request: a first install that
// succeeded ends paused by its own request (Fable renew-key ruling, supplement "eight on the path", item 5).
const PAUSE_REQUEST = '9'.repeat(64);
function evidence(over = {}) {
  const status = { writtenAt: '2026-11-16T02:59:50Z', node: { mode: 'UNCERTAIN' }, executor: { state: 'PAUSED' }, paused: true, current: null, queue: { live: 0 }, halt: null,
    versions: { selfcheck: { result: 'PASS', observedAt: '2026-11-16T02:50:00Z' } } };
  const e = { now: NOW, entry: { exitCode: 0, status: 'FIRST_INSTALL_DONE', stopCode: null, tree: 'C:\\t', node: 'C:\\n.exe', parsed: true },
    verify: { status: 'RESIDENT_VERIFIED' }, status, current: { generation: 1, ciSourceManifestSha256: S, linux: { manifestSha256: L } },
    facts: { generation: 1, staged: null, pinsOk: true, ciSourceManifestSha256: S, manifestSha256: L }, acceptanceSource: S,
    launcher: { status: 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED', pause: { confirmed: true, requestSha256: PAUSE_REQUEST, paused: { sha256: '4'.repeat(64) } } },
    firstInstallSteps: { missing: false, incomplete: false, incompleteStages: [] },
    pause: { sha256: '4'.repeat(64), requestSha256: PAUSE_REQUEST },
    reboot: { ok: true, status, readAt: NOW, boot: '2026-11-16T02:45:00Z' }, reinstall: { skipped: false, upgradeStatus: 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE', prepareStatus: 'FLEET_NODE_INSTALL_PREPARED',
      launcherExit: 0, launcherStatus: 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED', launcherVerdict: 'BOOTSTRAP_DONE',
      reverifyPassed: true, prepareAgainStatus: 'FLEET_NODE_INSTALL_PREPARED' }, kit: { perNodeSteps: ['8c step 2'], credentials: PACKAGE_CREDENTIALS } };
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

// A tree whose fleet tools are stand-ins run by the real node: each writes a line on stderr (the A8 children are read with stdout and
// stderr apart: Fable renew-key ruling, supplement "eight on the path", the drill's own six merged calls). install.mjs answers with the
// runCommand the test puts in run-command.json; bootstrap.ps1 is the package's own (its launcher parser and verdict).
function mockFleetTree(name) {
  const tree = path.join(tmp, name);
  const fleet = path.join(tree, 'work', 'independent-ci-resident-v1', 'rollout', 'fleet');
  fs.mkdirSync(fleet, { recursive: true });
  fs.copyFileSync(fileURLToPath(new URL('../rollout/fleet/bootstrap.ps1', import.meta.url)), path.join(fleet, 'bootstrap.ps1'));
  fs.writeFileSync(path.join(fleet, 'upgrade.mjs'),
    "process.stderr.write('upgrade: a note on stderr\\n'); console.log(JSON.stringify({ status: 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE' }));\n");
  fs.writeFileSync(path.join(fleet, 'install.mjs'), [
    "import fs from 'node:fs';",
    "process.stderr.write('prepare: a note on stderr\\n');",
    "const runCommand = JSON.parse(fs.readFileSync(new URL('./run-command.json', import.meta.url), 'utf8'));",
    "console.log(JSON.stringify({ status: 'FLEET_NODE_INSTALL_PREPARED', ...(runCommand === null ? {} : { runCommand }) }));", ''].join('\n'));
  return { tree, fleet };
}

test('A8 captures the current launcher exit and indented terminal JSON from the prepare command', opts, () => {
  const { tree, fleet } = mockFleetTree('a8-tree');
  const good = "ConvertTo-Json @{ status = 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED' }";
  const commands = [null, ' ', "ConvertTo-Json @{ status = 'PAUSE_NOT_CONFIRMED' }", `${good}; exit 4`, good];
  const r = ps(`
    $ErrorActionPreference = 'Stop'
    $cases = ConvertFrom-Json -InputObject ${q(JSON.stringify(commands.map(c => JSON.stringify(c))))}
    @($cases | ForEach-Object {
      [IO.File]::WriteAllText(${q(path.join(fleet, 'run-command.json'))}, $_)
      $ri = & $script:GuestReinstall ${q(process.execPath)} ${q(tree)} ${q(tmp)} ${q(tmp)} '1.2.3' 'package.tar' 'acceptance.json' 'sha' $script:DrillNativeText
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
  // a collection that fails is recorded and throws nothing
  const failDir = path.join(tmp, 'stage-files-fail'); fs.mkdirSync(failDir, { recursive: true });
  assert.equal(ps(`function Invoke-DrillGuest { throw (New-DrillError 'DRILL_GUEST_STEP_FAILED') }; (Save-DrillStageEvidence ${q(failDir)} $null).record.collection.code`), 'DRILL_GUEST_STEP_FAILED');
  // the first install's call collects them in its finally, so a timeout of that call still takes them back
  assert.match(fs.readFileSync(script, 'utf8'), /\} finally \{\s*\$collected = Save-DrillStageEvidence \$RunDir \$Cred\s*\}/);
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
    $launcher = Get-LastJsonLine ${q(JSON.stringify({ status: 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED', pause: { confirmed: true } }))}
    [ordered]@{ type = $ready.GetType().FullName; readyIsNull = ($null -eq (Get-EntryHostStopCode ([ordered]@{ exit = 0; last = $ready })));
      restart = (Get-EntryHostStopCode ([ordered]@{ exit = 3; last = $restart })); launcher = (Test-EntryStageVerdict $launcher); host = (Test-EntryStageVerdict $ready) }`);
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
  const late = outcome('late', { restoredToCheckpoint: true, stopped: true, cleanupDone: true }, all);
  assert.deepEqual({ note: late.note, evidence: late.evidence }, { note: '由守护紧急还原，证据已取', evidence: 'TAKEN' });
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
  const pub = ps(`New-DrillFakeCredentials ${q(out)} @('app-key.pem', 'ci-admission.token', 'resident-upgrade.token', 'public.json')`);
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
  const printed = JSON.stringify(pub);
  for (const secret of [ci, up, pem.split('\n')[1]]) assert.ok(!printed.includes(secret));
  assert.equal(psCode(`New-DrillFakeCredentials ${q(out)} @('public.json')`), 'DRILL_UNEXPECTED', 'never reuses a directory');
  // only the files asked for (the names the package declares and the drill gives); no list, nothing made
  const some = path.join(tmp, 'fake-some');
  ps(`New-DrillFakeCredentials ${q(some)} @('ci-admission.token', 'public.json')`);
  assert.deepEqual(fs.readdirSync(some).sort(), ['ci-admission.token', 'public.json']);
  assert.equal(psCode(`New-DrillFakeCredentials ${q(path.join(tmp, 'fake-none'))}`), 'DRILL_UNEXPECTED');
  assert.equal(fs.existsSync(path.join(tmp, 'fake-none')), false);
});
