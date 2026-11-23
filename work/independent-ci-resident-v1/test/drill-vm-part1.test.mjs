// drill/drill-vm.ps1, offline, part 1 of 4. The tests of drill-vm.test.mjs, in their order and with their text, split by run time so no
// part holds a hosted shard past about 210 s (task 3435f8bf, block 2); the fixtures they share are drill-vm-fixtures.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drillKitManifest, prepareFrom, makeDrillKit, releasePins, readSums } from '../drill/make-drill-kit.mjs';
import { DRILL_PASS_CONCLUSIONS, DRILL_RESERVED, REQUEST_CONTRACT, acceptanceOf, readAcceptance } from '../rollout/fleet/publish.mjs';
import { validateAcceptance } from '../rollout/fleet/install.mjs';
import { intakePauseRequest } from '../src/intake-pause.mjs';
import { POLICY_CONTRACT_V8, TRAIN_DEFAULTS } from '../src/policy.mjs';
import { StatusBoard } from '../src/status.mjs';
import { executorFixture, fakeEngine, rawPolicy, triggerBytes, WINDOWS_CLEAN } from './helpers.mjs';
import {
  windows, script, powershell, tmp, sha, q, PACKAGE_CREDENTIALS, CREDENTIAL_FILES_CONTRACT, credentialFilesJson, ownMutexes, T0, ps,
  psCode, opts, idleHostStatus, activeHostStatus, entryScript, entryPs, firstInstallAssets, gateNow, gateHold, gateActions,
  intakeArgv, releaseLoop, at, releaseRow, memoryAbort, drillTestJob, m5DrillReceipt, RENEWAL_3BC571A6, notTheDrillsSource,
  decisionsOf, planOf, sealWorld, candidateStubs, S, L, evidence, verdictOf, pass, finalize
} from './drill-vm-fixtures.mjs';

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
  // the package requires the companion token (its credential groups): the stand-in is one of the per-node steps (integration)
  const manifest = drillKitManifest({ ...inputs, credentials: PACKAGE_CREDENTIALS });
  assert.deepEqual(drillKitManifest({ ...inputs, credentials: PACKAGE_CREDENTIALS }), manifest);
  assert.equal(manifest.prereqSha256, sha(inputs.prereqBytes));
  // the three bypassed shell points and the companion GitHub token stand-in (Fable renew-key ruling, supplement "token pending"
  // section 1C): what it replaces, why, what it leaves unverified, and that it is never removed. The Expand-Cached stand-in is gone
  // (#1154 fixed the package's function; supplement "companion account and evidence" section 3).
  assert.equal(manifest.perNodeSteps.length, 4);
  // a package that does not require it: no stand-in, no step for it
  const { companionToken, ...noCompanion } = PACKAGE_CREDENTIALS.required;
  assert.equal(drillKitManifest({ ...inputs, credentials: { ...PACKAGE_CREDENTIALS, required: noCompanion } }).perNodeSteps.length, 3);
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
  // the package's credential-files.json goes into the kit as it is, with the hash of its bytes; a package without one gets no kit
  assert.deepEqual(manifest.credentials, { contract: CREDENTIAL_FILES_CONTRACT, ...PACKAGE_CREDENTIALS });
  assert.equal(manifest.credentialFilesSha256, sha(credentialFilesJson()));
  const none = firstInstallAssets('assembly-no-list', { credentialFiles: null });
  prepareFrom({ ...none, out: none.from });
  await assert.rejects(() => makeDrillKit(none), /DRILL_PACKAGE_CREDENTIALS_UNREADABLE/);
  assert.ok(!fs.existsSync(none.out), 'refused before writing a kit');
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

// The list as the package ships it (five required with the companion token, the heartbeat token the only optional one): the kit records
// it, the drill makes and hands over the companion token, the heartbeat token is withheld by design.
test('the shipped credential list: the kit records companionToken as required, the drill makes and hands it over, the heartbeat stays withheld', opts, async () => {
  const f = firstInstallAssets('assembly-shipped-list');
  prepareFrom({ ...f, out: f.from });
  await makeDrillKit(f);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.out, 'kit.json')));
  assert.equal(manifest.credentials.required.companionToken, 'companion-github.token');
  assert.deepEqual(manifest.credentials.optional, { heartbeatToken: 'ci-node-heartbeat.token' });
  assert.equal(manifest.perNodeSteps.length, 4);
  assert.match(manifest.perNodeSteps[3], /^陪伴 GitHub 经典令牌替身/);
  // the run's plan from that kit: the companion token given and made; the heartbeat withheld by design, nothing made for it
  const plan = ps(`Get-DrillCredentialPlan (Read-DrillKit ${q(f.out)})`);
  assert.ok(plan.given.includes('companion-github.token') && plan.fake.includes('companion-github.token'), JSON.stringify(plan));
  assert.deepEqual(plan.withheld.map(w => w.name), ['ci-node-heartbeat.token']);
  assert.match(plan.withheld[0].reason, /production heartbeat endpoint/);
  assert.ok(!plan.fake.includes('ci-node-heartbeat.token'));
  // the gate that rebinds the kit to the drilled package's tar takes this kit
  const tar = path.join(f.from, `fleet-node-${f.version}.tar`);
  assert.equal(ps(`Assert-DrillKitCredentialsBound (Read-DrillKit ${q(f.out)}) ${q(tar)}; 'bound'`), 'bound');
  // made as the run makes it (the plan's fake list): the stand-in in the classic token's shape, named in public.json
  const out = path.join(tmp, 'fake-shipped-list');
  ps(`New-DrillFakeCredentials ${q(out)} @(${plan.fake.map(q).join(', ')}); 'ok'`);
  assert.deepEqual(fs.readdirSync(out).sort(), [...plan.fake].sort());
  assert.match(fs.readFileSync(path.join(out, 'companion-github.token'), 'utf8'), /^ghp_CLUEDDRILLFAKE[A-Za-z0-9]{22}$/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'public.json'), 'utf8')).files.companionGithubToken, 'companion-github.token');
  assert.equal(fs.existsSync(path.join(out, 'ci-node-heartbeat.token')), false);
  // and the entry hands it over to the package (its copy table, copied when the drill made it)
  assert.match(fs.readFileSync(entryScript, 'utf8'), /@\('companion-github\.token', 'companion-github\.token'\)/);
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
    (Test-DrillHostSafety ${q(activeHostStatus(null))} 64GB),
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
  const now = Date.parse(T0);
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
    function Get-DrillHostSafety { Test-DrillHostSafety ${q(activeHostStatus(null))} 64GB }
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

test('G1: 17 -> 9 -> 14 GB: one release at the 9 GB tick, no abort, cacheReleases keeps it with the next tick\'s 14 GB', opts, () => {
  const r = releaseLoop('one', [17, 9, 14]);
  assert.equal(r.failure, null, JSON.stringify(r.failure));
  assert.deepEqual(r.events, ['tick 17', 'tick 9', 'release 20 while-running', 'tick 14']);
  assert.deepEqual(r.guard.cacheReleases.map(releaseRow), [{ at: at(30), freeBeforeGB: 9, exit: 0, freeAfterGB: 14 }]);
  const c = ps('@{ below = $script:Drill.CacheReleaseBelowBytes; every = $script:Drill.CacheReleaseEverySeconds; within = $script:Drill.CacheReleaseSeconds; tick = $script:Drill.HostGuardSeconds; reserve = $script:Drill.ProductionReserveBytes }');
  assert.deepEqual([c.below / 2 ** 30, c.every, c.within, c.reserve / 2 ** 30], [10, 120, 20, 6]);
  assert.ok(c.within < c.tick, 'a release never holds up the next tick');
});

test('G1: 9 -> 5 GB: the release first, then the 5 GB tick aborts DRILL_HOST_MEMORY_SHORT and restores, as before', opts, () => {
  const r = releaseLoop('abort', [9, 5]);
  assert.deepEqual(r.events, ['tick 9', 'release 20 while-running', 'tick 5', 'stop']);
  assert.equal(r.failure.code, 'DRILL_HOST_MEMORY_SHORT');
  assert.deepEqual([r.guard.status, r.guard.code, r.guard.stopped, r.guard.restoredToCheckpoint, r.guard.cleanupDone], ['DRILL_ABORTED', 'DRILL_HOST_MEMORY_SHORT', true, true, true]);
  assert.deepEqual(r.guard.cacheReleases.map(releaseRow), [{ at: at(0), freeBeforeGB: 9, exit: 0, freeAfterGB: 5 }]);
});

test('G1: a release that exits 5 or times out is only recorded: no abort, the drill goes on, no second try within 120 seconds', opts, () => {
  // a Runner.Worker on Windows too: the running guard's release does not ask (Decision f572ac5b), and is sent all the same
  const world = answer => `
    function Get-Process { param($ErrorAction) $script:events.Add('windows'); [pscustomobject]@{ ProcessName = 'Runner.Worker' } }
    function Get-DrillRunnerDistributions { param($HostName) 'Fixture-CI' }
    function Get-DrillWslRegisteredNames { 'Fixture-CI' }
    $script:DrillWslRunner = { param($a, $t)
      if ($a[0] -ceq '--list') { return @{ exit = 0; stdout = "Fixture-CI\`r\`n"; stderr = '' } }
      $script:events.Add("wsl $t $($a[-2])"); ${answer} }`;
  for (const [name, answer, exit] of [['exit5', "@{ exit = 5; stdout = ''; stderr = '' }", 5], ['timeout', "throw 'wsl.exe timed out'", null]]) {
    const r = releaseLoop(name, [9, 9, 9, 14], { release: world(answer) });
    assert.equal(r.failure, null, `${name}: ${JSON.stringify(r.failure)}`);
    assert.deepEqual(r.events.filter(e => e.startsWith('tick')), ['tick 9', 'tick 9', 'tick 9', 'tick 14'], `${name}: every tick ran`);
    const calls = r.events.filter(e => e.startsWith('wsl'));
    assert.equal(calls.length, 1, `${name}: ${r.events.join(',')}`);
    const t = Number(calls[0].split(' ')[1]);
    assert.ok(t >= 1 && t <= 20, `${name}: the release call is bounded by 20 seconds, given ${calls[0]}`);
    assert.equal(r.guard.cacheReleases.length, 1, name);
    assert.deepEqual(releaseRow(r.guard.cacheReleases[0]), { at: at(0), freeBeforeGB: 9, exit, freeAfterGB: 9 }, name);
    assert.ok(r.guard.cacheReleases[0].failed?.code, `${name}: the failure is recorded`);
    assert.equal(r.guard.status, undefined, `${name}: no abort record`);
    assert.ok(!r.events.includes('windows'), `${name}: the Windows side is not read while running`);
  }
});

test('G1: six ticks at 9 GB: two releases, 120 seconds apart', opts, () => {
  const r = releaseLoop('throttle', [9, 9, 9, 9, 9, 9]);
  assert.equal(r.failure, null);
  assert.deepEqual(r.events.filter(e => e.startsWith('release')), ['release 20 while-running', 'release 20 while-running']);
  assert.deepEqual(r.guard.cacheReleases.map(releaseRow), [{ at: at(0), freeBeforeGB: 9, exit: 0, freeAfterGB: 9 }, { at: at(120), freeBeforeGB: 9, exit: 0, freeAfterGB: 9 }]);
});

// Independent review of a643c4b42, suggestion 2: "at most once every 2 minutes" (Decision f572ac5b) is counted on a monotonic clock. The
// drill's clock jumping 120 seconds forward between two 30-second ticks gives no second release; the row's "at" still says the drill's time.
test('G1: the 120-second throttle is monotonic: a wall clock that jumps forward gives no second release', opts, () => {
  const r = releaseLoop('jump', [9, 9, 9], { wall: '$(if ($script:tick -ge 1) { 120 } else { 0 }) + 30 * [Math]::Max(0, $script:tick)' });
  assert.equal(r.failure, null);
  assert.deepEqual(r.events.filter(e => e.startsWith('release')), ['release 20 while-running'], r.events.join(','));
  assert.deepEqual(r.guard.cacheReleases.map(releaseRow), [{ at: at(0), freeBeforeGB: 9, exit: 0, freeAfterGB: 9 }]);
});

// Independent review of a643c4b42, suggestion 5: the two edges the release line leaves to one condition. Not armed (the guard before the
// boot, whose sample here passes the running gate at 9 GB): no release. Exactly 10.0 GB: no release (below the line only); 9.9 GB: one.
test('G1: no release while the guard is not armed, nor at exactly 10.0 GB; 9.9 GB releases', opts, () => {
  const unarmed = releaseLoop('unarmed', [9, 9, 9], { armed: false });
  assert.equal(unarmed.failure, null, JSON.stringify(unarmed.failure));
  assert.deepEqual(unarmed.events, ['tick 9', 'tick 9', 'tick 9'], 'every tick ran, none released');
  assert.equal(unarmed.guard, null, 'no cacheReleases written');
  const ten = releaseLoop('ten', [10, 10, 9.9, 14]);
  assert.equal(ten.failure, null);
  assert.deepEqual(ten.events, ['tick 10', 'tick 10', 'tick 9.9', 'release 20 while-running', 'tick 14']);
  assert.deepEqual(ten.guard.cacheReleases.map(releaseRow), [{ at: at(60), freeBeforeGB: 9.9, exit: 0, freeAfterGB: 14 }]);
});

test('G2: an abort for memory records the runner distribution\'s memory (wslMemory); the running sample carries no job reading', opts, () => {
  const r = memoryAbort('read', '');
  assert.deepEqual([r.guard.code, r.guard.stopped, r.guard.restoredToCheckpoint, r.guard.cleanupDone], ['DRILL_HOST_MEMORY_SHORT', true, true, true]);
  assert.deepEqual(r.guard.wslMemory, [{ distribution: 'Fixture-CI', memTotalGB: 28, memFreeGB: 6.5, cachedGB: 16, anonPagesGB: 5, runnerWorkers: 3 }]);
  // independent review of a643c4b42, suggestion 1: read after the shutdown (the guest's stop changes nothing in WSL's meminfo), so a slow
  // WSL never holds up the stop of a host already below 6 GB
  assert.deepEqual(r.calls, ['stop', '--list --running --quiet', '--distribution Fixture-CI --exec cat /proc/meminfo',
    '--distribution Fixture-CI --exec pgrep -cix Runner[.]Worker'], 'read-only, after the shutdown; no release below 6 GB');
  assert.equal(r.guard.detail.freeGB, 5);
  for (const k of ['runnerJob', 'busyWith', 'wslJobs', 'wslRunnerDistributions', 'wslUnreadable', 'wslListCall', 'windowsUnreadable']) {
    assert.equal(k in r.guard.detail, false, `the running sample has no ${k}: ${JSON.stringify(r.guard.detail)}`);
  }
  // no Runner.Worker: pgrep -c says 0 and exits 1
  assert.equal(memoryAbort('none', "$answer.workers = @{ exit = 1; stdout = \"0`n\"; stderr = '' }").guard.wslMemory[0].runnerWorkers, 0);
  // the count not read (evidence only; independent review of 29ed7255c, medium C): the sample is kept, runnerWorkers null
  assert.deepEqual(memoryAbort('workersGarbled', "$answer.workers = @{ exit = 0; stdout = 'three'; stderr = '' }").guard.wslMemory,
    [{ distribution: 'Fixture-CI', memTotalGB: 28, memFreeGB: 6.5, cachedGB: 16, anonPagesGB: 5, runnerWorkers: null }]);
  // not read whole: nothing recorded, the abort and the restore as before
  const unread = {
    list: "$answer.list = @{ exit = 1; stdout = ''; stderr = '' }",
    notRunning: "$answer.list = @{ exit = 0; stdout = ''; stderr = '' }",
    meminfoShort: "$answer.meminfo = @{ exit = 0; stdout = $meminfo.Replace('AnonPages:', 'Anon:'); stderr = '' }",
    meminfoStderr: "$answer.meminfo = @{ exit = 0; stdout = $meminfo; stderr = 'x' }",
    timeout: "if ($a[-1] -ceq '/proc/meminfo') { throw 'wsl.exe timed out' }",
  };
  for (const [name, answer] of Object.entries(unread)) {
    const u = memoryAbort(name, answer);
    assert.deepEqual([u.guard.code, u.guard.stopped, u.guard.restoredToCheckpoint, 'wslMemory' in u.guard], ['DRILL_HOST_MEMORY_SHORT', true, true, false], name);
    assert.equal(u.calls[0], 'stop', `${name}: the shutdown first`);
  }
  assert.ok(!memoryAbort('notRunning2', unread.notRunning).calls.some(c => c.includes('--distribution')), 'a distribution not running is asked nothing');
});

test('the real background guard aborts while the foreground is blocked, without any VM access', opts, () => {
  const fixture = path.join(tmp, 'guard-fixture.ps1');
  const marker = path.join(tmp, 'guard-stopped.txt');
  fs.writeFileSync(fixture, `. ${q(script)}
    ${ownMutexes}
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
    ${ownMutexes}
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

test('the boot watchdog still runs checkpoint cleanup after its parent job is terminated', opts, () => {
  const root = fs.mkdtempSync(path.join(tmp, 'boot-watchdog-'));
  const fixture = path.join(root, 'boot-fixture.ps1');
  const host = path.join(root, 'host.ps1');
  const ready = path.join(root, 'host-ready');
  const start = path.join(root, 'start');
  const cleanup = path.join(root, 'restored');
  const vmId = '8f87dbcb-9fbc-4fd6-adc4-7c6345192c50';
  fs.writeFileSync(fixture, `. ${q(script)}
    ${ownMutexes}
    $script:DrillScriptPath = $PSCommandPath
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
      $c = try { [void](Start-DrillDetachedWatchdog 'AAAA' ((Get-DrillTime).AddSeconds(15))); $null } catch { Get-DrillCode $_ }
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
      $c = try { [void](Start-DrillDetachedWatchdog '${encoded}' ((Get-DrillTime).AddSeconds(15))); $null } catch { Get-DrillCode $_ }
      @{ code = (Get-Prop $c 'code'); inJob = (Get-Prop $c 'detail.inJob'); terminated = (Get-Prop $c 'detail.terminated'); exited = $decoy.HasExited }
    } finally {
      if (-not $decoy.HasExited) { $decoy.Kill() }
      $decoy.Dispose()
      [void][DrillTestJob]::CloseHandle($job)
    }`);
  assert.deepEqual(r, { code: 'DRILL_WATCHDOG_IN_JOB', inJob: true, terminated: true, exited: true });
});

test('asking WMI for the watchdog is bounded by the ready budget and fails by name', opts, () => {
  // The clock is pinned (Fable 11-21 clock ruling §2): the first read sets the ready-by, every later read is $Later seconds on,
  // so the timeout handed to WMI is exact however slow the host is.
  const root = fs.mkdtempSync(path.join(tmp, 'watchdog-wmi-'));
  const r = ps(`
    $script:t0 = [DateTimeOffset]'2026-11-19T02:00:00Z'
    function Get-DrillTime { $script:reads++; if ($script:reads -eq 1) { $script:t0 } else { $script:t0.AddSeconds($script:later) } }
    function Invoke-CimMethod { param($ClassName, $MethodName, $Arguments, $OperationTimeoutSec, $ErrorAction) $script:asked = $true; $script:timeout = $OperationTimeoutSec; throw 'WMI did not answer' }
    function Test-WatchdogAt([double]$Later) {
      $script:reads = 0; $script:later = $Later; $script:asked = $false; $script:timeout = $null
      $c = try { [void](Start-DrillBootWatchdog ${q(root)} ([guid]::Empty) ($script:t0.AddMinutes(1))); $null } catch { Get-DrillCode $_ }
      @{ code = (Get-Prop $c 'code'); inner = (Get-Prop $c 'detail.code'); asked = $script:asked; timeout = $script:timeout }
    }
    @{ still = (Test-WatchdogAt 0); spent = (Test-WatchdogAt 4.2); gone = (Test-WatchdogAt 15) }`);
  const failed = (timeout) => ({ code: 'DRILL_GUEST_SHUTDOWN_WATCHDOG_NOT_READY', inner: 'DRILL_WATCHDOG_WMI_CREATE_FAILED', asked: true, timeout });
  assert.deepEqual(r, {
    still: failed(15),
    spent: failed(11),
    gone: { code: 'DRILL_GUEST_SHUTDOWN_WATCHDOG_NOT_READY', inner: 'DRILL_WATCHDOG_READY_TIMEOUT', asked: false, timeout: null },
  });
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
    # -WslMemory @(): no runner distribution runs, as Start-DrillGuardedVm would hand it (Fable plan 87d330d0)
    $safety = Get-DrillHostSafety -WslMemory @()
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
  assert.deepEqual(r.outcome, { result: null, failure: { code: 'DRILL_HOST_IS_ON_DUTY', detail: 'test' }, restored: true, hostExecutorStates: [],
    runningMemory: { afterBootFreeGB: null, minRunningFreeGB: null } });
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
    # the wait for memory before the hold reads the host's real memory: answered here, as the gates are
    function Read-DrillHostMemory { @{ free = 64GB; target = 8GB; assigned = 0L } }
    function Get-DrillWslMemory { param([switch]$IdleCap) }
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
test('the credential plan: every required name given, every optional name decided, the heartbeat token withheld with its reason', opts, () => {
  const plan = planOf(PACKAGE_CREDENTIALS);
  assert.deepEqual(plan.given, ['app-private-key.pem', 'ci-admission.token', 'resident-upgrade.token', 'public.json', 'companion-github.token']);
  assert.deepEqual(plan.fake, ['app-key.pem', 'ci-admission.token', 'resident-upgrade.token', 'public.json', 'companion-github.token']);
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
  // the companion GitHub token stand-in (branch one's generator) is made only when the package requires the name (integration): given and
  // made for this package, neither for one that does not require it -- New-DrillFakeCredentials makes exactly the plan's names
  const { companionToken, ...noCompanion } = PACKAGE_CREDENTIALS.required;
  const withoutCompanion = planOf({ ...PACKAGE_CREDENTIALS, required: noCompanion });
  assert.ok(!withoutCompanion.fake.includes('companion-github.token') && !withoutCompanion.given.includes('companion-github.token'));
  for (const [name, p] of [['plain', withoutCompanion], ['companion', plan]]) {
    const out = path.join(tmp, `fake-plan-${name}`);
    ps(`New-DrillFakeCredentials ${q(out)} @(${p.fake.map(q).join(', ')}); 'ok'`);
    assert.deepEqual(fs.readdirSync(out).sort(), [...p.fake].sort(), name);
    assert.equal(fs.existsSync(path.join(out, 'companion-github.token')), name === 'companion', name);
    assert.equal('companionGithubToken' in JSON.parse(fs.readFileSync(path.join(out, 'public.json'), 'utf8')).files, name === 'companion', name);
  }
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
  const bound = (t = tar) => ps(`try { Assert-DrillKitCredentialsBound (Read-DrillKit ${q(f.out)}) ${q(t)}; 'bound' } catch { (Get-DrillCode $_).code }`);
  assert.equal(bound(), 'bound');
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
  assert.equal(bound(), 'bound');
  // 8th review round, medium 1: the groups are compared member by member, never through a joined text -- one member whose value carries a
  // line break and a second "group.key=value" (the old encoding of two members) is not the package's two, the list's hash kept as it is
  const { ciToken, ...withoutCi } = kit.credentials.required;
  put({ ...kit.credentials, required: { ...withoutCi, appKey: `${kit.credentials.required.appKey}\nrequired.ciToken=${ciToken}` } });
  assert.equal(bound(), 'DRILL_KIT_CREDENTIALS_NOT_THE_PACKAGES', 'one member for two');
  put({ ...kit.credentials, required: { ...kit.credentials.required, extra: 'extra.token' } });
  assert.equal(bound(), 'DRILL_KIT_CREDENTIALS_NOT_THE_PACKAGES', 'a member more');
  const { appKey, ...noAppKey } = kit.credentials.required;
  put({ ...kit.credentials, required: { ...noAppKey, APPKEY: appKey } });
  assert.equal(bound(), 'DRILL_KIT_CREDENTIALS_NOT_THE_PACKAGES', 'a key in another case');
  put(kit.credentials);
  assert.equal(bound(), 'bound');
  // 9th review round, low 2: the recorded hash is a lowercase hex digest compared ordinally -- a character a culture-aware comparison
  // ignores (a soft hyphen), or the same digest in capitals, is not the package's
  const putSha = v => fs.writeFileSync(kitFile, JSON.stringify({ ...kit, credentialFilesSha256: v }, null, 2));
  for (const [reason, v] of [['a soft hyphen added', kit.credentialFilesSha256 + '­'], ['in capitals', kit.credentialFilesSha256.toUpperCase()]]) {
    putSha(v);
    assert.equal(bound(), 'DRILL_KIT_CREDENTIALS_NOT_THE_PACKAGES', reason);
  }
  putSha(kit.credentialFilesSha256);
  assert.equal(bound(), 'bound');
  // a tar without the list: unreadable; a tar whose list has other bytes (the same names): not the package's
  const old = firstInstallAssets('bound-credentials-old', { credentialFiles: null });
  assert.equal(bound(path.join(old.build, `fleet-node-${old.version}.tar`)), 'DRILL_PACKAGE_CREDENTIALS_UNREADABLE');
  const other = firstInstallAssets('bound-credentials-bytes', { credentialFiles: JSON.stringify({ contract: CREDENTIAL_FILES_CONTRACT, ...PACKAGE_CREDENTIALS }) });
  assert.equal(bound(path.join(other.build, `fleet-node-${other.version}.tar`)), 'DRILL_KIT_CREDENTIALS_NOT_THE_PACKAGES');
  // the run calls it before the host gate, on the package's verified tar
  assert.match(fs.readFileSync(script, 'utf8'), /Assert-DrillKitCredentialsBound \$kitInfo \(Get-Prop \$package 'tar'\)/);
});

// Codex review of e0a3cded5, high 3: the package's gh and Git for Windows installers are injected, both and with the package's hashes, or
// there is no kit and no boot; the entry never fetches them in the guest.
test('gh and Git for Windows: in the kit with the package\'s hashes or no kit, no boot; never downloaded in the guest', opts, async () => {
  const f = firstInstallAssets('tools-bound');
  prepareFrom({ ...f, out: f.from });
  await makeDrillKit(f);
  const manifest = path.join(f.from, `fleet-node-${f.version}.prereq-manifest.json`);
  const gate = () => ps(`try { Assert-DrillKitToolsBound (Read-DrillKit ${q(f.out)}) ${q(manifest)}; 'bound' } catch { (Get-DrillCode $_).code }`);
  assert.equal(gate(), 'bound');
  const kitFile = path.join(f.out, 'kit.json');
  const kit = JSON.parse(fs.readFileSync(kitFile, 'utf8'));
  fs.writeFileSync(kitFile, JSON.stringify({ ...kit, files: kit.files.filter(i => i.path !== 'gh.msi') }, null, 2));
  assert.equal(ps(`try { Assert-DrillKitToolsBound (Read-DrillKit ${q(f.out)}) ${q(manifest)}; 'bound' } catch { (Get-DrillCode $_).detail }`), 'gh');
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

test('the repository\'s package and the drill: required names the drill makes, optional names it decides; the hand-over agrees', opts, async () => {
  const read = rel => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const decisions = decisionsOf();
  const given = Object.keys(decisions).filter(n => decisions[n].give === true);
  const covers = c => ({ required: Object.values(c.required).filter(n => !given.includes(n)), optional: Object.values(c.optional).filter(n => !Object.hasOwn(decisions, n)) });
  // the repository's package (Fable renew-key ruling, supplement "where the credential list comes from"): with its credential-files.json,
  // every required name is one the drill makes and every optional one is decided; without it, a kit for such a package is refused
  const listFile = fileURLToPath(new URL('../windows/credential-files.json', import.meta.url));
  if (fs.existsSync(listFile)) {
    const list = JSON.parse(fs.readFileSync(listFile, 'utf8'));
    assert.equal(list.contract, CREDENTIAL_FILES_CONTRACT);
    assert.deepEqual(covers(list), { required: [], optional: [] }, JSON.stringify(list));
  } else {
    const f = firstInstallAssets('repository-without-list', { credentialFiles: null });
    prepareFrom({ ...f, out: f.from });
    await assert.rejects(() => makeDrillKit(f), /DRILL_PACKAGE_CREDENTIALS_UNREADABLE/);
  }
  // the check itself
  assert.deepEqual(covers(PACKAGE_CREDENTIALS), { required: [], optional: [] });
  assert.deepEqual(covers({ required: { ...PACKAGE_CREDENTIALS.required, x: 'x.token' }, optional: { y: 'y.token' } }), { required: ['x.token'], optional: ['y.token'] });
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
