// PR-3 of D:/w/tmp/FABLE-drill-role-probe-20261124.md ("the drill uses the test project"): the drill kit names the drill's server instead
// of production in the first-install kit's two public fields and nothing else; the guest is cut off from the production host; the CI
// token is the Owner's drill binding, read where the drill's guest credential is read, never made up; without it the drill refuses
// before any boot. Before this change the 17th candidate's drill ended FIRST_INSTALL_ROLE_UNAUTHORIZED: a made-up token against
// production can only be answered "unauthorized" (receipt 20261124T023108Z-2026.11.24-c015ec10-17c175cc, A1).
// Every case goes through the real functions: makeDrillKit, drill-vm.ps1 and first-install-entry.ps1 dot-sourced.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as kitModule from '../drill/make-drill-kit.mjs';
import { validateAcceptance } from '../rollout/fleet/install.mjs';
import { DRILL_RESERVED, namesDrillReserved } from '../rollout/fleet/publish.mjs';
import { BINDING_ID, BINDING_TOKEN, DRILL_SERVER, PRODUCTION_SERVER, bindingPs, candidateStubs, entryPs, evidence, firstInstallAssets, kitDir, ps, psCode, q, sha, tmp, verdictOf } from './drill-vm-fixtures.mjs';

const { makeDrillKit, prepareFrom } = kitModule;
const windows = process.platform === 'win32';
const hostOf = url => new URL(url).hostname;
const leaves = (v, at = '') => v !== null && typeof v === 'object'
  ? Object.entries(v).flatMap(([k, x]) => leaves(x, at ? `${at}.${k}` : k)) : [[at, JSON.stringify(v)]];
const differing = (a, b) => { const A = new Map(leaves(a)), B = new Map(leaves(b)); return [...new Set([...A.keys(), ...B.keys()])].filter(k => A.get(k) !== B.get(k)).sort(); };

async function built(label, over = {}) {
  const f = firstInstallAssets(label);
  prepareFrom({ ...f, out: f.from });
  const made = await makeDrillKit({ ...f, ...over });
  const tag = `fleet-node-${f.version}`;
  return { f, made, tag, kit: JSON.parse(fs.readFileSync(path.join(f.out, 'kit.json'))), names: { kit: `${tag}.first-install-kit.json`, sums: `${tag}.first-install.SHA256SUMS`, acceptance: `${tag}.acceptance.json` } };
}

test('the drill kit names the drill server in the two public fields and nothing else; the three files that pin the kit follow', async () => {
  const { f, kit, names } = await built('server-two-fields');
  const releaseBytes = fs.readFileSync(path.join(f.from, names.kit)), drillBytes = fs.readFileSync(path.join(f.out, names.kit));
  const release = JSON.parse(releaseBytes), drill = JSON.parse(drillBytes);
  assert.deepEqual(differing(release, drill), ['record.publishableKey', 'record.supabaseUrl']);
  assert.equal(drill.record.supabaseUrl, DRILL_SERVER.supabaseUrl); assert.equal(drill.record.publishableKey, DRILL_SERVER.publishableKey);
  assert.equal(release.record.supabaseUrl, PRODUCTION_SERVER.supabaseUrl, 'the Release directory is not touched');
  // the kit's record of the stand-in: both hashes, what was replaced, the production host to cut off
  const s = kit.server;
  assert.equal(s.contract, 'clued.drill.server-stand-in/1'); assert.equal(s.project, DRILL_SERVER.project); assert.equal(s.supabaseUrl, DRILL_SERVER.supabaseUrl);
  assert.deepEqual(s.replaced, ['record.publishableKey', 'record.supabaseUrl']);
  assert.equal(s.releaseFirstInstallKitSha256, sha(releaseBytes)); assert.equal(s.firstInstallKitSha256, sha(drillBytes));
  assert.deepEqual(s.blackholeHosts, [hostOf(PRODUCTION_SERVER.supabaseUrl)]);
  assert.deepEqual(s.files, { firstInstallKit: names.kit, firstInstallSums: names.sums, acceptance: names.acceptance });
  // the three files that pin the kit's bytes in the guest (bootstrap's first-install sums, the acceptance, the drill's release pins)
  const sums = fs.readFileSync(path.join(f.out, names.sums), 'utf8'), releaseSums = fs.readFileSync(path.join(f.from, names.sums), 'utf8');
  assert.equal(sums, releaseSums.replace(sha(releaseBytes), sha(drillBytes))); assert.notEqual(sums, releaseSums);
  const acc = JSON.parse(fs.readFileSync(path.join(f.out, names.acceptance))), owners = JSON.parse(fs.readFileSync(path.join(f.from, names.acceptance)));
  assert.equal(acc.firstInstallKitSha256, sha(drillBytes)); assert.equal(acc.archive_sha256, owners.archive_sha256); assert.equal(acc.ciSourceManifestSha256, owners.ciSourceManifestSha256);
  assert.equal(namesDrillReserved(acc), true, 'a stand-in acceptance never passes for the Owner\'s'); assert.equal(acc.cluedDecision, DRILL_RESERVED.decision);
  const pins = JSON.parse(fs.readFileSync(path.join(f.out, 'release-pins.json')));
  for (const n of Object.values(names)) {
    const bytes = fs.readFileSync(path.join(f.out, n));
    assert.deepEqual(pins.files.find(x => x.path === n), { path: n, sha256: sha(bytes) }, n);
    assert.ok(kit.files.some(x => x.path === n && x.sha256 === sha(bytes)), `${n} is one of the kit's pinned files`);
  }
  // registered as a stand-in: A10 never passes on a server that is not production's
  assert.ok(kit.perNodeSteps.some(x => /测试项目|演练绑定/.test(x)), JSON.stringify(kit.perNodeSteps));
});

test('no kit when the drill server is production, has no publishable key yet, or the Release kit names no server', async () => {
  const f = firstInstallAssets('server-refused');
  prepareFrom({ ...f, out: f.from });
  await assert.rejects(() => makeDrillKit({ ...f, server: { ...DRILL_SERVER, supabaseUrl: PRODUCTION_SERVER.supabaseUrl } }), /DRILL_SERVER_IS_PRODUCTION/);
  await assert.rejects(() => makeDrillKit({ ...f, server: { ...DRILL_SERVER, publishableKey: null } }), /DRILL_SERVER_PUBLISHABLE_KEY_NOT_SET/);
  await assert.rejects(() => makeDrillKit({ ...f, server: { ...DRILL_SERVER, supabaseUrl: 'http://drill.example' } }), /DRILL_SERVER_REFUSED/);
  assert.ok(!fs.existsSync(f.out), 'refused before the kit is written');
  // the committed drill-server.json is the one source of the drill's server: the test project, never a production address
  const committed = kitModule.readDrillServer({ allowUnset: true });
  assert.equal(committed.project, 'clued-auth-test'); assert.equal(committed.supabaseUrl, 'https://uscrdifznmlvczcekqpw.supabase.co');
});

test('a drill kit whose first-install kit differs from the Release\'s in one more field is refused, and so is a production address', async () => {
  const { f, names } = await built('server-diff');
  const release = fs.readFileSync(path.join(f.from, names.kit)), drill = fs.readFileSync(path.join(f.out, names.kit));
  assert.deepEqual(kitModule.assertServerStandIn(release, drill), ['record.publishableKey', 'record.supabaseUrl']);
  const more = JSON.parse(drill); more.record.node = 'another';
  assert.throws(() => kitModule.assertServerStandIn(release, Buffer.from(JSON.stringify(more))), /DRILL_SERVER_STAND_IN_DIFFERS:.*record\.node/);
  const added = JSON.parse(drill); added.images.local.push({ id: 'c'.repeat(64), asset: 'x' });
  assert.throws(() => kitModule.assertServerStandIn(release, Buffer.from(JSON.stringify(added))), /DRILL_SERVER_STAND_IN_DIFFERS/);
  assert.throws(() => kitModule.assertServerStandIn(release, release), /DRILL_SERVER_IS_PRODUCTION/);
  const keyOnly = JSON.parse(release); keyOnly.record.publishableKey = DRILL_SERVER.publishableKey;
  assert.throws(() => kitModule.assertServerStandIn(release, Buffer.from(JSON.stringify(keyOnly))), /DRILL_SERVER_IS_PRODUCTION/);
});

test('before any boot: a kit without the server stand-in, a From that is not the kit\'s Release, or no drill binding refuses the drill', { skip: !windows }, async () => {
  const { f, kit, names } = await built('server-host-gate');
  const clixml = path.join(tmp, 'binding-host-gate.clixml');
  const run = (extra = '') => `$script:Drill.BindingCredential = ${q(clixml)}; ${extra}
    $k = Read-DrillKit ${q(f.out)}; $p = Test-DrillPackageDir ${q(f.from)} ${q(f.version)} $k; Assert-DrillServerReady $k $p`;
  // the binding is not there yet: refused with its own code, and nothing made up in its place
  assert.equal(psCode(run()), 'DRILL_BINDING_CREDENTIAL_MISSING');
  ps(`${bindingPs} | Export-Clixml -LiteralPath ${q(clixml)}; 'ok'`);
  const ok = ps(`${run()}; $b = Get-DrillCredential -Binding
    [ordered]@{ user = $b.UserName; server = $k.server.supabaseUrl; release = $p.firstInstallKitSha256; drill = $p.drillFirstInstallKitSha256; acceptance = [string]$p.acceptance
      files = @(Get-DrillReleaseFiles $p $k | ForEach-Object { [string]$_ }) }`);
  assert.equal(ok.user, BINDING_ID); assert.equal(ok.server, DRILL_SERVER.supabaseUrl);
  // the receipt's kit hash stays the Release's (what seal compares with the Owner's acceptance); the drill's is beside it
  assert.equal(ok.release, kit.server.releaseFirstInstallKitSha256); assert.equal(ok.drill, kit.server.firstInstallKitSha256);
  // the guest receives the kit's three files in place of From's, every other asset From's
  for (const n of Object.values(names)) assert.ok(ok.files.includes(path.join(f.out, n)) && !ok.files.includes(path.join(f.from, n)), n);
  assert.equal(ok.files.length, fs.readdirSync(f.from).length);
  // a binding of another shape (not a connection id, not a clued_bnd_ token) is refused as it is read
  for (const [user, token] of [['not-a-uuid', BINDING_TOKEN], [BINDING_ID, 'ghp_notabindingtoken00000000000000000000'], [BINDING_ID, 'clued_bnd_short']]) {
    const bad = path.join(tmp, `binding-bad-${sha(user + token).slice(0, 8)}.clixml`);
    ps(`(New-Object System.Management.Automation.PSCredential ${q(user)}, (ConvertTo-SecureString ${q(token)} -AsPlainText -Force)) | Export-Clixml -LiteralPath ${q(bad)}; 'ok'`);
    assert.equal(psCode(`$script:Drill.BindingCredential = ${q(bad)}; Get-DrillCredential -Binding`), 'DRILL_BINDING_CREDENTIAL_REFUSED');
  }
  fs.writeFileSync(path.join(tmp, 'binding-garbage.clixml'), 'not clixml');
  assert.equal(psCode(`$script:Drill.BindingCredential = ${q(path.join(tmp, 'binding-garbage.clixml'))}; Get-DrillCredential -Binding`), 'DRILL_BINDING_CREDENTIAL_REFUSED');
  // the guest credential keeps its own code and place
  assert.equal(psCode(`$script:Drill.Credential = ${q(path.join(tmp, 'no-guest.clixml'))}; Get-DrillCredential`), 'DRILL_GUEST_CREDENTIAL_MISSING');
  // a kit made before this change (no server stand-in) would install against production: refused
  const old = kitDir('server-old-kit');
  assert.equal(psCode(`$script:Drill.BindingCredential = ${q(clixml)}; Assert-DrillServerReady (Read-DrillKit ${q(old)}) @{ version = '1.2.3' }`), 'DRILL_KIT_SERVER_STAND_IN_MISSING');
  // the Release's kit changed after the drill kit was made: not this kit's Release
  const fromKit = path.join(f.from, names.kit), original = fs.readFileSync(fromKit);
  const moved = JSON.parse(original); moved.record.node = 'changed'; fs.writeFileSync(fromKit, JSON.stringify(moved));
  assert.equal(psCode(run()), 'DRILL_KIT_SERVER_NOT_THIS_RELEASE');
  fs.writeFileSync(fromKit, original);
  assert.equal(psCode(run()), null);
});

test('Invoke-DrillMain reaches the host hold only after the server stand-in and the binding were checked', { skip: !windows }, () => {
  const missing = path.join(tmp, 'binding-main-missing.clixml');
  // the real Assert-DrillServerReady (candidateStubs stubs it for the other suites; here it is defined again from the script)
  const real = `$script:Drill.BindingCredential = ${q(missing)}
    function Read-DrillKit { @{ prereqSha256 = 'pin'; executionBlocker = $null; candidate = @{ acceptance = 'x' }; server = $null; credentials = $null } }
    Set-Item function:Assert-DrillServerReady $script:RealAssertDrillServerReady`;
  assert.equal(psCode(`$script:RealAssertDrillServerReady = \${function:Assert-DrillServerReady}; ${candidateStubs}; ${real}; Invoke-DrillMain`), 'DRILL_KIT_SERVER_STAND_IN_MISSING');
});

test('the guest\'s CI token is the drill binding handed in, never one made up; its id and pin are the binding\'s', { skip: !windows }, () => {
  const out = path.join(tmp, 'fake-binding');
  const pub = ps(`New-DrillFakeCredentials ${q(out)} @('ci-admission.token', 'resident-upgrade.token', 'public.json') ${bindingPs}`);
  assert.equal(fs.readFileSync(path.join(out, 'ci-admission.token'), 'utf8'), BINDING_TOKEN);
  assert.equal(pub.ciPrincipalBindingId, BINDING_ID);
  assert.equal(pub.ciTokenPinSha256, sha(Buffer.concat([Buffer.from('clued.independent-ci.ci-binding-pin/1\0'), Buffer.from(BINDING_TOKEN)])));
  assert.doesNotMatch(JSON.stringify(pub), new RegExp(BINDING_TOKEN), 'the public record never carries the token');
  assert.notEqual(fs.readFileSync(path.join(out, 'resident-upgrade.token'), 'utf8'), BINDING_TOKEN, 'the upgrade token stays a made-up one');
  // asked for the CI token without a binding: nothing is made up
  const none = path.join(tmp, 'fake-no-binding');
  const thrown = ps(`try { New-DrillFakeCredentials ${q(none)} @('ci-admission.token', 'public.json') | Out-Null; 'made' } catch { [string]$_.Exception.Message }`);
  assert.match(thrown, /FAKE_CREDENTIALS_BINDING_REQUIRED/);
  assert.equal(fs.existsSync(path.join(none, 'ci-admission.token')), false);
});

test('A6 passes on a confirmed role only: STANDBY with the launcher\'s not-held and its first train not applicable; UNCERTAIN is no pass', { skip: !windows }, () => {
  const e = JSON.parse(evidence());
  const item = ev => verdictOf(JSON.stringify(ev)).items.find(i => i.id === 'A6');
  assert.equal(e.status.node.mode, 'STANDBY'); assert.equal(e.launcher.role, 'not-held'); assert.ok(e.launcher.completed.includes('first-train-not-applicable'));
  assert.equal(item(e).pass, true, item(e).detail);
  // what the 17th candidate's drill read: the probe refused, the mode unknown
  const uncertain = structuredClone(e); uncertain.status.node.mode = 'UNCERTAIN';
  assert.equal(item(uncertain).pass, false); assert.match(item(uncertain).detail, /mode=UNCERTAIN/);
  const unauthorized = structuredClone(e); unauthorized.launcher.role = 'unauthorized';
  assert.equal(item(unauthorized).pass, false); assert.match(item(unauthorized).detail, /role=unauthorized/);
  const held = structuredClone(e); held.status.node.mode = 'ACTIVE'; held.launcher.role = 'held';
  assert.equal(item(held).pass, false, 'the drill binding has no role: holding the slot is not this drill');
  const trained = structuredClone(e); trained.launcher.completed = ['first-train'];
  assert.equal(item(trained).pass, false);
});

test('the guest entry cuts the production host off (hosts) and refuses a From whose kit still names it', { skip: !windows }, async () => {
  const { f, names } = await built('server-entry');
  const hosts = path.join(tmp, 'entry-hosts'); fs.writeFileSync(hosts, '# hosts\r\n127.0.0.1 localhost\r\n');
  const prod = hostOf(PRODUCTION_SERVER.supabaseUrl);
  const guestFrom = path.join(tmp, 'entry-from'); fs.mkdirSync(guestFrom);
  fs.copyFileSync(path.join(f.out, names.kit), path.join(guestFrom, names.kit));
  const call = from => `$Kit = ${q(f.out)}; $From = ${q(from)}; $Version = ${q(f.version)}
    $r = Set-EntryServerBlackhole ${q(hosts)} { param($n) @('0.0.0.0', '::') }; [ordered]@{ hosts = @($r.hosts); server = $r.server }`;
  const r = entryPs(call(guestFrom));
  assert.deepEqual(r.hosts, [prod]); assert.equal(r.server, hostOf(DRILL_SERVER.supabaseUrl));
  const text = fs.readFileSync(hosts, 'utf8');
  assert.match(text, new RegExp(`^0\\.0\\.0\\.0 ${prod.replaceAll('.', '\\.')}\\r?$`, 'm')); assert.match(text, new RegExp(`^:: ${prod.replaceAll('.', '\\.')}\\r?$`, 'm'));
  assert.match(text, /127\.0\.0\.1 localhost/, 'the file\'s own lines are kept');
  entryPs(call(guestFrom));
  assert.equal(fs.readFileSync(hosts, 'utf8'), text, 'a second run adds nothing');
  const code = expr => entryPs(`try { ${expr} | Out-Null; $null } catch { [string]$_.Exception.Message }`);
  // the name still resolves to an address that is not the black hole: the guest is not cut off
  assert.equal(code(`$Kit = ${q(f.out)}; $From = ${q(guestFrom)}; $Version = ${q(f.version)}; Set-EntryServerBlackhole ${q(hosts)} { param($n) @('0.0.0.0', '203.0.113.7') }`), 'DRILL_ENTRY_PRODUCTION_NOT_CUT_OFF');
  // the Release's own kit in From (the production address): refused before the hosts file is touched
  const prodFrom = path.join(tmp, 'entry-from-prod'); fs.mkdirSync(prodFrom);
  fs.copyFileSync(path.join(f.from, names.kit), path.join(prodFrom, names.kit));
  const clean = path.join(tmp, 'entry-hosts-clean'); fs.writeFileSync(clean, '# hosts\r\n');
  assert.equal(code(`$Kit = ${q(f.out)}; $From = ${q(prodFrom)}; $Version = ${q(f.version)}; Set-EntryServerBlackhole ${q(clean)} { param($n) @('0.0.0.0') }`), 'DRILL_ENTRY_SERVER_IS_PRODUCTION');
  assert.equal(fs.readFileSync(clean, 'utf8'), '# hosts\r\n');
  // a kit without the stand-in
  const old = kitDir('server-entry-old-kit');
  assert.equal(code(`$Kit = ${q(old)}; $From = ${q(guestFrom)}; $Version = ${q(f.version)}; Set-EntryServerBlackhole ${q(clean)} { param($n) @('0.0.0.0') }`), 'DRILL_ENTRY_SERVER_STAND_IN_MISSING');
});

test('the acceptance the drill kit carries is one a node\'s install reads as it is', async () => {
  const { f, names } = await built('server-acceptance');
  validateAcceptance(JSON.parse(fs.readFileSync(path.join(f.out, names.acceptance))));
});
