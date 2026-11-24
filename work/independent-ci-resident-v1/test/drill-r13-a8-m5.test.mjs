// Task 87d330d0, drill r13 (FABLE-drill-r13-a8-m5-20261125.md sections 1 and 2):
// A8 is "the same package again through both entries, the node not moved": the generic upgrade answers FLEET_NODE_ALREADY_AT_THIS_PACKAGE
// (exit 0) and install.mjs prepare answers FLEET_NODE_INSTALL_REFUSED with code NEW_SOURCE_IS_THE_INSTALLED_ONE; nothing after them runs.
// The skip option and its own conclusion value are gone.
// M5: when the drill cuts the renewal gateway's host off in the guest (the kit's server.blackholeHosts, written by the host as
// m5/network.json), the probe must be exactly RENEW_GATEWAY_UNAVAILABLE and the gateway is recorded 'NOT_VERIFIED_GATEWAY_CUT_OFF'; a 403
// or any other code then fails. Not cut off: the 403 is still required. No new conclusion value.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { opts, ps, q, tmp, script, evidence, verdictOf, pass } from './drill-vm-fixtures.mjs';
import { DRILL_PASS_CONCLUSIONS } from '../rollout/fleet/publish.mjs';

const resident = fileURLToPath(new URL('../', import.meta.url));
const drillDir = path.join(resident, 'drill');
const GONE = ['SkipReinstall', 'PASS_A_REINSTALL_NOT_DRILLED', 'GuestPrepareAgain', 'Test-DrillReinstallLauncher', 'read-after-reinstall'];

// ---------------------------------------------------------------- A8

const A8_REFUSED = { upgradeStatus: 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE', upgradeExit: 0,
  prepareStatus: 'FLEET_NODE_INSTALL_REFUSED', prepareCode: 'NEW_SOURCE_IS_THE_INSTALLED_ONE', prepareExit: 1 };
const a8Of = reinstall => { const r = verdictOf(evidence({ reinstall })); return { ...r.items.find(i => i.id === 'A8'), conclusion: r.conclusion }; };

test('A8: the same package refused by both entries passes, and the detail says the reinstall from an older package is not drilled', opts, () => {
  const r = a8Of(A8_REFUSED);
  assert.equal(r.pass, true, r.detail);
  assert.match(r.detail, /upgrade=FLEET_NODE_ALREADY_AT_THIS_PACKAGE/);
  assert.match(r.detail, /prepare=FLEET_NODE_INSTALL_REFUSED/);
  assert.match(r.detail, /NEW_SOURCE_IS_THE_INSTALLED_ONE/);
  assert.match(r.detail, /reinstall from an older package is not drilled here（旧包到新包的重装不在本演练内）$/);
  // nothing fails; A9 waits for -Finalize's production read-back
  assert.equal(r.conclusion, 'PENDING_PRODUCTION_READBACK');
});

test('A8: either entry letting the same package through, or any other answer, fails', opts, () => {
  for (const [reason, value] of [
    // the old A8's whole success: prepare PREPARED, its launcher done, re-verified, prepared again
    ['prepare let it through', { ...A8_REFUSED, prepareStatus: 'FLEET_NODE_INSTALL_PREPARED', prepareCode: null, prepareExit: 0,
      launcherExit: 0, launcherStatus: 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED', launcherVerdict: 'BOOTSTRAP_DONE', reverifyPassed: true, prepareAgainStatus: 'FLEET_NODE_INSTALL_PREPARED' }],
    ['prepare refused for another reason', { ...A8_REFUSED, prepareCode: 'FIRST_INSTALL_RESIDUE_PRESENT' }],
    ['prepare refused without a code', { ...A8_REFUSED, prepareCode: null }],
    ['the upgrade went ahead', { ...A8_REFUSED, upgradeStatus: 'FLEET_NODE_UPGRADE_STAGED' }],
    ['the upgrade refused', { ...A8_REFUSED, upgradeStatus: 'FLEET_NODE_UPGRADE_REFUSED', upgradeExit: 1 }],
    ['the upgrade said already but exited 1', { ...A8_REFUSED, upgradeExit: 1 }],
    ['the upgrade exit unknown', { ...A8_REFUSED, upgradeExit: null }],
    ['blocked by A1', { upgradeStatus: 'DRILL_A8_BLOCKED_BY_A1', prepareStatus: null }],
    ['no A8 result', null],
  ]) {
    const r = a8Of(value);
    assert.equal(r.pass, false, `${reason}: ${r.detail}`);
    assert.equal(r.conclusion, 'FAIL', reason);
  }
});

// A tree whose two fleet entries are stand-ins run by the real node, with the package's own bootstrap.ps1 beside them (what the old A8
// dot-sourced to start the launcher). install.mjs answers what answer.json says, and its runCommand, when given, writes a marker file.
function a8Tree(name) {
  const tree = path.join(tmp, name);
  const fleet = path.join(tree, 'work', 'independent-ci-resident-v1', 'rollout', 'fleet');
  fs.mkdirSync(fleet, { recursive: true });
  fs.copyFileSync(path.join(resident, 'rollout', 'fleet', 'bootstrap.ps1'), path.join(fleet, 'bootstrap.ps1'));
  fs.writeFileSync(path.join(fleet, 'upgrade.mjs'), "console.log(JSON.stringify({ status: 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE', generation: 1 }));\n");
  fs.writeFileSync(path.join(fleet, 'install.mjs'), [
    "import fs from 'node:fs';",
    "const a = JSON.parse(fs.readFileSync(new URL('./answer.json', import.meta.url), 'utf8'));",
    "process.stderr.write('prepare: a note on stderr\\n');",
    "console.log(JSON.stringify(a));",
    "process.exitCode = a.status === 'FLEET_NODE_INSTALL_REFUSED' ? 1 : 0;", ''].join('\n'));
  return { tree, fleet };
}
const guestA8 = (tree, fleet, answer) => {
  fs.writeFileSync(path.join(fleet, 'answer.json'), JSON.stringify(answer));
  return ps(`$ErrorActionPreference = 'Stop'
    $up = & $script:GuestReinstallUpgrade ${q(process.execPath)} ${q(tree)} ${q(tmp)} ${q(tmp)} '1.2.3' $script:DrillNativeText
    $ri = & $script:GuestReinstall ${q(process.execPath)} ${q(tree)} ${q(tmp)} ${q(tmp)} '1.2.3' 'package.tar' 'acceptance.json' 'sha' $script:DrillNativeText $up
    [ordered]@{ record = $ri; keys = @($ri.Keys) }`);
};

test('A8 in the guest: the prepare\'s refusal code is recorded, and no launcher is started even when prepare hands over a runCommand', opts, () => {
  const { tree, fleet } = a8Tree('r13-a8-tree');
  const marker = path.join(tmp, 'r13-a8-launcher-ran.txt');
  const runCommand = `Set-Content -LiteralPath ${q(marker)} -Value 'launcher ran'`;
  // the r13 answer, with a runCommand beside it
  const refused = guestA8(tree, fleet, { status: 'FLEET_NODE_INSTALL_REFUSED', code: 'NEW_SOURCE_IS_THE_INSTALLED_ONE', detail: {}, runCommand });
  assert.equal(refused.record.upgradeStatus, 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE');
  assert.equal(refused.record.upgradeExit, 0);
  assert.equal(refused.record.prepareStatus, 'FLEET_NODE_INSTALL_REFUSED');
  assert.equal(refused.record.prepareCode, 'NEW_SOURCE_IS_THE_INSTALLED_ONE');
  assert.equal(refused.record.prepareExit, 1);
  assert.equal(String(refused.record.prepareStderr).trim(), 'prepare: a note on stderr');
  // a prepare that let it through: recorded as it answered, and still nothing after it
  const prepared = guestA8(tree, fleet, { status: 'FLEET_NODE_INSTALL_PREPARED', runCommand });
  assert.equal(prepared.record.prepareStatus, 'FLEET_NODE_INSTALL_PREPARED');
  assert.equal(prepared.record.prepareCode, null);
  assert.ok(!fs.existsSync(marker), 'a launcher was started');
  for (const r of [refused, prepared]) {
    assert.deepEqual(r.keys.filter(k => /^launcher|^reverify|^prepareAgain|^skipped$/.test(k)), [], JSON.stringify(r.keys));
  }
  // and the verdict on what the guest recorded
  assert.equal(a8Of(refused.record).pass, true);
  assert.equal(a8Of(prepared.record).pass, false);
});

test('A8 in the run: two guest steps of 10 minutes each, then nothing more before the late probe and M5', opts, () => {
  const text = fs.readFileSync(script, 'utf8');
  const a8 = text.slice(text.indexOf('# A8: same package again'), text.indexOf('[void](Save-DrillLateProbe $RunDir $Cred)'));
  assert.ok(a8.length > 0);
  assert.match(a8, /\$script:GuestReinstallUpgrade [^\n]*-TimeoutMinutes 10 [^\n]*-Step 'reinstall-upgrade'/);
  assert.match(a8, /\$script:GuestReinstall [^\n]*-TimeoutMinutes 10 [^\n]*-Step 'reinstall'/);
  assert.equal([...a8.matchAll(/Invoke-DrillGuest /g)].length, 2, a8);
  const guest = text.slice(text.indexOf('$script:GuestReinstall = {'), text.indexOf('# The public allowlist in docs/ci-connection.md'));
  for (const word of ['runCommand', 'bootstrap.ps1', 'Invoke-StageChild', 'Get-LauncherVerdict']) assert.ok(!guest.includes(word), word);
});

test('the skip option and its conclusion value are gone: from drill/, the parameters, the PASS set seal takes and the operator guides', opts, () => {
  for (const name of fs.readdirSync(drillDir)) {
    const file = path.join(drillDir, name);
    if (!fs.statSync(file).isFile()) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const word of GONE) assert.ok(!text.includes(word), `drill/${name} still names ${word}`);
  }
  const params = ps(`$ast = [Management.Automation.Language.Parser]::ParseFile(${q(script)}, [ref]$null, [ref]$null); @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })`);
  assert.ok(params.includes('Version') && params.includes('Kit'), JSON.stringify(params));
  assert.ok(!params.includes('SkipReinstall'), JSON.stringify(params));
  assert.deepEqual([...DRILL_PASS_CONCLUSIONS], ['PASS_A_FULL', 'PASS_A_PER_NODE_STEPS_REMAIN']);
  for (const doc of ['rollout/fleet/README.md', 'rollout/fleet/publish.mjs', 'drill/FIRST-INSTALL-KIT.md']) {
    assert.ok(!fs.readFileSync(path.join(resident, doc), 'utf8').includes('PASS_A_REINSTALL_NOT_DRILLED'), doc);
  }
  // a candidate's A8 must be true: there is no A8 "not judged" a candidate can end in PASS with
  const ids = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10'];
  const items = a8 => ids.map(i => i === 'A8' ? a8 : { id: i, pass: true, detail: 'x' });
  const conclude = list => ps(`Get-DrillConclusion (${q(JSON.stringify(list))} | ConvertFrom-Json) @{ result = 'PASS' } $true`);
  assert.equal(conclude(items({ id: 'A8', pass: null, detail: 'skipped (-SkipReinstall): same-package reinstall not drilled (同包重装未演练)' })), 'FAIL');
  assert.equal(conclude(items({ id: 'A8', pass: true, detail: 'x' })), 'PASS_A_FULL');
});

// ---------------------------------------------------------------- M5

const sidHash = createHash('sha1').update(Buffer.from('CLUEDCIRESIDENT', 'utf16le')).digest();
const serviceSid = 'S-1-5-80-' + Array.from({ length: 5 }, (_, i) => sidHash.readUInt32LE(4 * i)).join('-');
const PROFILE = { ownerSid: 'S-1-5-21-1-2-3-101', controllerSid: 'S-1-5-21-1-2-3-102' };
const routeHost = () => /const\s+string\s+Route\s*=\s*"https:\/\/([^/"]+)\//.exec(fs.readFileSync(path.join(resident, 'windows', 'SwapBroker.cs'), 'utf8'))[1];

// The eight files of an M5 directory as a first install leaves them (no connection record), the probe's code given; network: the host's
// m5/network.json, or undefined for none.
function m5Dir(name, code, network) {
  const dir = path.join(tmp, name); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString(), row = sid => ({ at, sid, tpm: 'DENIED', software: 'ABSENT' });
  const put = (n, v) => fs.writeFileSync(path.join(dir, n), JSON.stringify(v));
  put('profile.json', PROFILE);
  put('system.json', { at, sid: 'S-1-5-18', provider: 'Microsoft Platform Crypto Provider', code: null });
  put('resident.json', row(serviceSid));
  put('controller.json', row(PROFILE.controllerSid));
  put('companion.json', { ...row(PROFILE.ownerSid), 'ci-admission.token': 'DENIED', 'ci-admission.connection.json': 'ABSENT' });
  put('probe.json', { at, code, bindingId: null, expiresAt: null });
  put('record.json', { 'ci-admission.connection.json': 'ABSENT' });
  if (network !== undefined) put('network.json', network);
  return dir;
}
const check = (dir, checker = path.join(resident, 'test', 'renewal-drill.mjs')) => {
  const r = spawnSync(process.execPath, [checker, dir], { encoding: 'utf8' });
  let out = null; try { out = JSON.parse(r.stdout); } catch { out = { unparsed: r.stdout, stderr: r.stderr }; }
  return { ...out, exit: r.status };
};

test('M5 checker: the gateway host cut off and UNAVAILABLE passes as not verified; cut off and a 403 or another code fails', () => {
  const cut = { blackholeHosts: ['clued.pixelgrav.com', routeHost()] };
  const ok = check(m5Dir('m5-cut-unavailable', 'RENEW_GATEWAY_UNAVAILABLE', cut));
  assert.equal(ok.result, 'PASS', JSON.stringify(ok));
  assert.equal(ok.gateway, 'NOT_VERIFIED_GATEWAY_CUT_OFF');
  assert.equal(ok.exit, 0);
  assert.equal(ok.record.denial, 'NOT_VERIFIED_RECORD_ABSENT');
  for (const code of ['RENEW_IDENTITY_REFUSED', 'RENEW_RATE_LIMITED', 'RENEW_RESPONSE_UNAVAILABLE', null]) {
    const r = check(m5Dir('m5-cut-' + code, code, cut));
    assert.equal(r.result, 'FAIL', `${code}: ${JSON.stringify(r)}`);
    assert.equal(r.gateway, false, String(code));
    assert.equal(r.exit, 1);
  }
});

test('M5 checker: the gateway host not cut off still requires the 403', () => {
  for (const network of [{ blackholeHosts: ['clued.pixelgrav.com'] }, { blackholeHosts: [] }]) {
    const refused = check(m5Dir('m5-open-403', 'RENEW_IDENTITY_REFUSED', network));
    assert.equal(refused.result, 'PASS', JSON.stringify(refused));
    assert.equal(refused.gateway, true);
    const unavailable = check(m5Dir('m5-open-unavailable', 'RENEW_GATEWAY_UNAVAILABLE', network));
    assert.equal(unavailable.result, 'FAIL');
    assert.equal(unavailable.gateway, false);
  }
});

test('M5 checker: no network.json, or a gateway Route it cannot read, fails', () => {
  const none = check(m5Dir('m5-no-network', 'RENEW_GATEWAY_UNAVAILABLE', undefined));
  assert.deepEqual({ result: none.result, code: none.code, exit: none.exit }, { result: 'FAIL', code: 'DRILL_EVIDENCE_UNAVAILABLE', exit: 1 });
  for (const bad of [{}, { blackholeHosts: 'kooyumi.pixelgrav.com' }, { blackholeHosts: [1] }]) {
    const r = check(m5Dir('m5-bad-network', 'RENEW_GATEWAY_UNAVAILABLE', bad));
    assert.equal(r.result, 'FAIL', JSON.stringify(bad));
  }
  // a host tree whose windows/SwapBroker.cs is missing, then names no Route: the checker cannot know the gateway's host
  const tree = path.join(tmp, 'm5-route-tree');
  for (const f of ['test/renewal-drill.mjs', 'src/connection-renewal.mjs', 'src/store.mjs', 'src/canonical.mjs']) {
    fs.mkdirSync(path.dirname(path.join(tree, f)), { recursive: true });
    fs.copyFileSync(path.join(resident, f), path.join(tree, f));
  }
  const dir = m5Dir('m5-route', 'RENEW_GATEWAY_UNAVAILABLE', { blackholeHosts: [routeHost()] });
  const missing = check(dir, path.join(tree, 'test', 'renewal-drill.mjs'));
  assert.deepEqual({ result: missing.result, code: missing.code }, { result: 'FAIL', code: 'DRILL_GATEWAY_ROUTE_UNREADABLE' });
  fs.mkdirSync(path.join(tree, 'windows'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'windows', 'SwapBroker.cs'), 'class SwapBroker { }\n');
  assert.equal(check(dir, path.join(tree, 'test', 'renewal-drill.mjs')).code, 'DRILL_GATEWAY_ROUTE_UNREADABLE');
  // the host is the Route's, read from the file: another Route host is not cut off by the same list
  fs.writeFileSync(path.join(tree, 'windows', 'SwapBroker.cs'), 'const string Route="https://other-gateway.example/v1/ci/node/renew";\n');
  const other = check(dir, path.join(tree, 'test', 'renewal-drill.mjs'));
  assert.deepEqual({ result: other.result, gateway: other.gateway }, { result: 'FAIL', gateway: false });
});

// The host's half end to end: the real guest collection over a guest root, the host's network.json from the kit's list, the real checker
// in this tree (with the real SwapBroker.cs Route) through Get-DrillM5Verdict.
function guestRoot(name, code) {
  const root = path.join(tmp, name, 'guest'), res = path.join(root, 'resident');
  fs.rmSync(path.join(tmp, name), { recursive: true, force: true });
  const at = new Date().toISOString(), row = sid => ({ at, sid, tpm: 'DENIED', software: 'ABSENT' });
  const put = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); };
  put(path.join(res, 'record', 'acceptance.json'), { node: { ...PROFILE } });
  put(path.join(res, 'broker', 'renew-key.json'), { at, sid: 'S-1-5-18', provider: 'Microsoft Platform Crypto Provider', code: null });
  put(path.join(res, 'state', 'renew-key-resident.json'), row(serviceSid));
  put(path.join(root, 'state', 'v2', 'receipts', 'renew-key-controller.json'), row(PROFILE.controllerSid));
  put(path.join(res, 'mailbox', 'responses', 'renew-key.json'), { ...row(PROFILE.ownerSid), 'ci-admission.token': 'DENIED', 'ci-admission.connection.json': 'ABSENT' });
  put(path.join(res, 'broker', 'renew-ci.json'), { at, code, bindingId: null, expiresAt: null });
  const runDir = path.join(tmp, name, 'run'); fs.mkdirSync(runDir, { recursive: true });
  return { res, runDir };
}
const hostM5 = (name, code, hosts) => {
  const { res, runDir } = guestRoot(name, code);
  const r = ps(`$script:Drill.GuestRoot = ${q(res)}
    function Invoke-DrillGuest { param($Credential, $Script, $ArgumentList, $TimeoutMinutes, $Code, $Step, [switch]$Restartable) & $Script $ArgumentList }
    $m5 = Copy-DrillM5 ${q(runDir)} $null @(${hosts.map(q).join(', ')})
    $v = Get-DrillM5Verdict ${q(runDir)} $m5
    [ordered]@{ result = $v.result; gateway = (Get-Prop $v.verdict 'gateway'); missing = @($m5.missing); files = @(Get-ChildItem -LiteralPath (Join-Path ${q(runDir)} 'm5') -File | ForEach-Object { $_.Name }) }`);
  const network = path.join(runDir, 'm5', 'network.json');
  return { ...r, network: fs.existsSync(network) ? JSON.parse(fs.readFileSync(network, 'utf8')) : null };
};

test('M5 on the host: network.json is the kit\'s list as given, and the verdict follows it through the real checker', opts, () => {
  const hosts = ['clued.pixelgrav.com', routeHost(), 'prod0000000000000000.supabase.co'];
  const cut = hostM5('m5-host-cut', 'RENEW_GATEWAY_UNAVAILABLE', hosts);
  assert.deepEqual(cut.network, { blackholeHosts: hosts });
  assert.deepEqual(cut.missing, []);
  assert.ok(cut.files.includes('network.json') && cut.files.length === 8, JSON.stringify(cut.files));
  assert.deepEqual({ result: cut.result, gateway: cut.gateway }, { result: 'PASS', gateway: 'NOT_VERIFIED_GATEWAY_CUT_OFF' });
  const touched = hostM5('m5-host-cut-403', 'RENEW_IDENTITY_REFUSED', hosts);
  assert.deepEqual({ result: touched.result, gateway: touched.gateway }, { result: 'FAIL', gateway: false });
  const open = hostM5('m5-host-open', 'RENEW_GATEWAY_UNAVAILABLE', ['clued.pixelgrav.com']);
  assert.deepEqual(open.network, { blackholeHosts: ['clued.pixelgrav.com'] });
  assert.deepEqual({ result: open.result, gateway: open.gateway }, { result: 'FAIL', gateway: false });
  // the run hands Copy-DrillM5 the kit's list (the one it cut off in the guest), and this tree's own drill server cuts the gateway off,
  // so a real drill takes the cut-off path
  assert.match(fs.readFileSync(script, 'utf8'), /Copy-DrillM5 \$RunDir \$Cred @\(Get-Prop \$KitInfo 'server\.blackholeHosts'\)/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(drillDir, 'drill-server.json'), 'utf8')).blackholeHosts.includes(routeHost()));
});
