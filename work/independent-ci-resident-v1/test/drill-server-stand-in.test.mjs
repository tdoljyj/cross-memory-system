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
const checkModule = await import('../drill/drill-server-check.mjs').catch(() => ({}));   // the host's requests to the drill's server
import { validateAcceptance } from '../rollout/fleet/install.mjs';
import { DRILL_RESERVED, namesDrillReserved } from '../rollout/fleet/publish.mjs';
import { BINDING_ID, BINDING_TOKEN, DRILL_SERVER, PRODUCTION_GATEWAY, PRODUCTION_SERVER, RECORD_NAMES, bindingPs, candidateStubs, entryPs, evidence, firstInstallAssets, kitDir, ps, psCode, q, sha, tmp, verdictOf } from './drill-vm-fixtures.mjs';

const { makeDrillKit, prepareFrom } = kitModule;
const windows = process.platform === 'win32';
const hostOf = url => new URL(url).hostname;
const leaves = (v, at = '') => v !== null && typeof v === 'object'
  ? Object.entries(v).flatMap(([k, x]) => leaves(x, at ? `${at}.${k}` : k)) : [[at, JSON.stringify(v)]];
const differing = (a, b) => { const A = new Map(leaves(a)), B = new Map(leaves(b)); return [...new Set([...A.keys(), ...B.keys()])].filter(k => A.get(k) !== B.get(k)).sort(); };

async function built(label, over = {}, assets = {}) {
  const f = firstInstallAssets(label, assets);
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
  // cut off in the guest: the Release record's database and the service hosts the package's own code names (review M1); the rest the
  // archive names are the registered ones that are not Clued's
  assert.deepEqual(s.blackholeHosts, [PRODUCTION_GATEWAY, hostOf(PRODUCTION_SERVER.supabaseUrl)].sort());
  assert.deepEqual(s.allowedHosts, ['api.github.com']);
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
  const committed = kitModule.readDrillServer({ allowUnset: true, keyFile: path.join(tmp, 'no-such-server-key.json') });
  assert.equal(committed.project, 'clued-auth-test'); assert.equal(committed.supabaseUrl, 'https://uscrdifznmlvczcekqpw.supabase.co');
  // the production gateway SwapBroker's renew probe is sent to (SwapBroker.cs Route, not read from the record) is cut off; no host is both
  assert.ok(committed.blackholeHosts.includes('kooyumi.pixelgrav.com'), JSON.stringify(committed.blackholeHosts));
  assert.deepEqual(committed.blackholeHosts.filter(h => committed.allowedHosts.includes(h)), []);
});

// Review M1: a host the package's own code names is reached whatever the record says (SwapBroker posts its renew probe to a constant).
test('every https host the archive names is cut off or registered as not Clued\'s: one that is neither, and no kit', async () => {
  const entry = text => ({ tarExtra: [{ path: 'tree/work/independent-ci-resident-v1/upgrader/src/extra.mjs', data: Buffer.from(text) }] });
  const f = firstInstallAssets('server-host-unlisted', entry('export const door = "https://Unlisted.ProdFixture.example:8443/v1/door";\n'));
  prepareFrom({ ...f, out: f.from });
  await assert.rejects(() => makeDrillKit({ ...f }), e => e.message === 'DRILL_SERVER_PRODUCTION_HOST_NOT_CUT_OFF:unlisted.prodfixture.example');
  assert.ok(!fs.existsSync(path.join(f.out, 'kit.json')), 'no kit');
  // the gateway the fixture archive names, taken off the list: the same refusal; a host on both lists is no server at all
  const g = firstInstallAssets('server-host-gateway'); prepareFrom({ ...g, out: g.from });
  await assert.rejects(() => makeDrillKit({ ...g, server: { ...DRILL_SERVER, blackholeHosts: [] } }), e => e.message === `DRILL_SERVER_PRODUCTION_HOST_NOT_CUT_OFF:${PRODUCTION_GATEWAY}`);
  await assert.rejects(() => makeDrillKit({ ...g, server: { ...DRILL_SERVER, allowedHosts: [PRODUCTION_GATEWAY] } }), e => e.message === 'DRILL_SERVER_REFUSED');
  await assert.rejects(() => makeDrillKit({ ...g, server: { ...DRILL_SERVER, blackholeHosts: [hostOf(DRILL_SERVER.supabaseUrl)] } }), e => e.message === 'DRILL_SERVER_REFUSED');
  assert.ok(!fs.existsSync(path.join(g.out, 'kit.json')), 'no kit');
  // registered, either way: a kit, and its record says which
  const { kit } = await built('server-host-listed', { server: { ...DRILL_SERVER, blackholeHosts: [PRODUCTION_GATEWAY, 'unlisted.prodfixture.example'] } },
    entry('https://unlisted.prodfixture.example/v1/door'));
  assert.ok(kit.server.blackholeHosts.includes('unlisted.prodfixture.example'));
  // before any boot the same rule is held again (--server-of, Assert-DrillServerReady): a kit whose list lost a host is refused
  const h = await built('server-host-verify');
  assert.deepEqual(kitModule.verifyKitServer({ kit: h.f.out, from: h.f.from, version: h.f.version }).blackholeHosts, h.kit.server.blackholeHosts);
  const file = path.join(h.f.out, 'kit.json'), lost = structuredClone(h.kit);
  lost.server.blackholeHosts = lost.server.blackholeHosts.filter(x => x !== PRODUCTION_GATEWAY); fs.writeFileSync(file, JSON.stringify(lost));
  assert.throws(() => kitModule.verifyKitServer({ kit: h.f.out, from: h.f.from, version: h.f.version }), e => e.message === `DRILL_SERVER_PRODUCTION_HOST_NOT_CUT_OFF:${PRODUCTION_GATEWAY}`);
  const both = structuredClone(h.kit); both.server.allowedHosts = [...both.server.allowedHosts, PRODUCTION_GATEWAY]; fs.writeFileSync(file, JSON.stringify(both));
  assert.throws(() => kitModule.verifyKitServer({ kit: h.f.out, from: h.f.from, version: h.f.version }), e => e.message === 'DRILL_KIT_SERVER_STAND_IN_REFUSED');
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
  assert.equal(ps(`${run()}; 'ready'`), 'ready');
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
  assert.deepEqual(r.hosts, [PRODUCTION_GATEWAY, prod].sort()); assert.equal(r.server, hostOf(DRILL_SERVER.supabaseUrl));
  const text = fs.readFileSync(hosts, 'utf8');
  assert.match(text, new RegExp(`^0\\.0\\.0\\.0 ${prod.replaceAll('.', '\\.')}\\r?$`, 'm')); assert.match(text, new RegExp(`^:: ${prod.replaceAll('.', '\\.')}\\r?$`, 'm'));
  assert.match(text, new RegExp(`^0\\.0\\.0\\.0 ${PRODUCTION_GATEWAY.replaceAll('.', '\\.')}\\r?$`, 'm'), 'the gateway the package\'s code names is cut off too');
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

test('-BindingCredential stores the binding the dialog gave, read back through the one reader; another shape stores nothing', { skip: !windows }, () => {
  const file = path.join(tmp, 'binding-stored.clixml');
  const stored = ps(`$script:Drill.BindingCredential = ${q(file)}; $r = Save-DrillBindingCredential { ${bindingPs} }
    [ordered]@{ status = $r.status; connection = $r.connection; file = $r.file; user = (Get-DrillCredential -Binding).UserName; text = (ConvertTo-Json $r -Compress) }`);
  assert.equal(stored.status, 'DRILL_BINDING_STORED'); assert.equal(stored.connection, BINDING_ID); assert.equal(stored.user, BINDING_ID); assert.equal(stored.file, file);
  // what the command prints never carries the token, and neither does the file in the clear (DPAPI)
  assert.doesNotMatch(stored.text, new RegExp(BINDING_TOKEN)); assert.doesNotMatch(fs.readFileSync(file, 'latin1').replaceAll('\0', ''), new RegExp(BINDING_TOKEN));
  const none = path.join(tmp, 'binding-not-stored.clixml');
  assert.equal(psCode(`$script:Drill.BindingCredential = ${q(none)}
    Save-DrillBindingCredential { New-Object System.Management.Automation.PSCredential 'someone', (ConvertTo-SecureString 'not-a-binding-token' -AsPlainText -Force) }`), 'DRILL_BINDING_CREDENTIAL_REFUSED');
  assert.equal(fs.existsSync(none), false);
  // given alone: never beside a run's arguments
  assert.equal(psCode(`$BindingCredential = $true; $Version = '1.2.3'; function Save-DrillBindingCredential { throw 'reached the dialog' }; Invoke-DrillMain`), 'DRILL_USAGE');
});

// FABLE-drill-test-project-sync-20261124.md section 3: the drill server's public key is not in the repository. Its one source is the
// test project; the host keeps a copy that was checked against the project when it was stored (drill-vm.ps1 -ServerKey).
const reply = (status, body) => ({ status, ok: status === 200, json: async () => body, text: async () => JSON.stringify(body) });
const KEY = 'sb_publishable_fixture_hostcache';
test('the drill server\'s public key is the host\'s checked copy, never a field of the committed file', { skip: !windows }, async () => {
  const committedFile = new URL('../drill/drill-server.json', import.meta.url);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(committedFile, 'utf8')), 'publishableKey'), false, 'no key in the repository');
  const { publishableKey, ...named } = DRILL_SERVER;
  const file = path.join(tmp, 'server-key-source.json'), keyFile = path.join(tmp, 'server-key-cache.json');
  fs.writeFileSync(file, JSON.stringify(named));
  // a committed file that carries a key is no drill server (the key would be in the repository again)
  const withKey = path.join(tmp, 'server-key-in-file.json'); fs.writeFileSync(withKey, JSON.stringify(DRILL_SERVER));
  assert.throws(() => kitModule.readDrillServer({ file: withKey, keyFile }), e => e.message === 'DRILL_SERVER_REFUSED');
  // no copy on the host yet: no kit
  assert.throws(() => kitModule.readDrillServer({ file, keyFile }), e => e.message === 'DRILL_SERVER_PUBLISHABLE_KEY_NOT_SET');
  assert.equal(kitModule.readDrillServer({ file, keyFile, allowUnset: true }).publishableKey, null);
  // stored only when the project itself answers the key: one request to the sync receipt function, the key as the api key
  const calls = [];
  const answering = status => async (url, init) => { calls.push({ url, init }); return reply(status, { state: 'syncing' }); };
  await assert.rejects(() => checkModule.storeServerKey({ key: 'sb_secret_not_public', file, keyFile, fetch: answering(200) }), e => e.message === 'DRILL_SERVER_KEY_REFUSED');
  assert.equal(calls.length, 0, 'a key of another shape is sent nowhere');
  await assert.rejects(() => checkModule.storeServerKey({ key: KEY, file, keyFile, fetch: answering(401), pause: async () => {} }), e => e.message === 'DRILL_SERVER_KEY_REFUSED');
  await assert.rejects(() => checkModule.storeServerKey({ key: KEY, file, keyFile, fetch: answering(404), pause: async () => {} }), e => e.message === 'DRILL_SERVER_NOT_IN_SYNC:no-receipt');
  assert.equal(fs.existsSync(keyFile), false, 'nothing stored');
  calls.length = 0;
  await assert.rejects(() => checkModule.storeServerKey({ key: KEY, file, keyFile, fetch: async () => { calls.push(1); throw new Error('offline'); }, pause: async () => {} }), e => e.message === 'DRILL_SERVER_UNREACHABLE');
  assert.equal(calls.length, 3, 'three tries'); assert.equal(fs.existsSync(keyFile), false);
  calls.length = 0;
  const stored = await checkModule.storeServerKey({ key: KEY, file, keyFile, fetch: answering(200) });
  assert.equal(stored.status, 'DRILL_SERVER_KEY_STORED'); assert.equal(stored.file, keyFile);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, `${DRILL_SERVER.supabaseUrl}/rest/v1/rpc/clued_drill_sync_receipt_v1`);
  assert.equal(calls[0].init.method, 'POST'); assert.equal(calls[0].init.headers.apikey, KEY);
  assert.deepEqual(kitModule.readDrillServer({ file, keyFile }), { ...named, publishableKey: KEY });
  // a copy stored for another project is not this server's key
  const other = path.join(tmp, 'server-key-other.json'); fs.writeFileSync(other, JSON.stringify({ ...named, supabaseUrl: 'https://anotherfixture0000000.supabase.co' }));
  assert.throws(() => kitModule.readDrillServer({ file: other, keyFile }), e => e.message === 'DRILL_SERVER_KEY_REFUSED');
  fs.writeFileSync(keyFile, '{'); assert.throws(() => kitModule.readDrillServer({ file, keyFile }), e => e.message === 'DRILL_SERVER_KEY_REFUSED');
  // the entry: -ServerKey alone; a key of another shape is refused by the one checker before anything is sent or stored
  assert.equal(psCode(`$ServerKey = 'sb_secret_not_public'; Invoke-DrillMain`), 'DRILL_SERVER_KEY_REFUSED');
  assert.equal(psCode(`$ServerKey = ${q(KEY)}; $Version = '1.2.3'; function Save-DrillServerKey { throw 'reached the request' }; Invoke-DrillMain`), 'DRILL_USAGE');
  assert.equal(fs.existsSync(path.join(tmp, 'fixture-drill-server.local.json')), false);
});

// FABLE-drill-test-project-sync-20261124.md section 2.2: before any boot the host asks the drill's server what the guest is about to ask
// it. A project that was not brought to production's state, a token that expired, a binding the server would let through (no parking
// role in the account, or a role on the binding): each ends in seconds with its own code, not after forty minutes in the guest.
const IN_SYNC = { state: 'in-sync', productionLast: '20261113100000_binding_role_in_force_single_reader_v1', productionCount: 326, commit: 'c'.repeat(40), run: 77, at: '2026-11-24T05:00:00Z' };
const NOT_ON_DUTY = { status: 'ok', holders: [], reason: 'admission_binding_required' };
const server = answers => { const calls = []; return { calls, fetch: async (url, init) => { calls.push({ url, init }); const a = answers[url.split('/').pop()]; if (a instanceof Error) throw a; return reply(...a); } }; };
test('before any boot the host asks the drill server itself: the sync receipt, then the role probe the guest will send', async () => {
  const { f, kit } = await built('server-ready');
  const ready = answers => { const s = server(answers); return { s, run: () => checkModule.serverReady({ kit: f.out, from: f.from, version: f.version, token: BINDING_TOKEN, fetch: s.fetch, pause: async () => {} }) }; };
  const codeOf = async answers => { try { await ready(answers).run(); return null; } catch (e) { return e.message; } };
  const receipt = 'clued_drill_sync_receipt_v1', holders = 'clued_work_merge_slot_holders_v1';
  // in sync, and the binding holds no role: ready, with the receipt (which production state this drill stands in for)
  const ok = ready({ [receipt]: [200, IN_SYNC], [holders]: [200, NOT_ON_DUTY] });
  const r = await ok.run();
  assert.deepEqual(r.receipt, IN_SYNC); assert.equal(r.supabaseUrl, DRILL_SERVER.supabaseUrl); assert.equal(r.firstInstallKitSha256, kit.server.firstInstallKitSha256);
  assert.deepEqual(ok.s.calls.map(c => c.url), [receipt, holders].map(n => `${DRILL_SERVER.supabaseUrl}/rest/v1/rpc/${n}`), 'the drill server only');
  // the second request is the guest's: the token's hash, the kit's scope and repository, the drill's public key; the token itself goes nowhere
  const sent = ok.s.calls[1].init;
  assert.deepEqual(JSON.parse(sent.body), { p_token_hash: sha(BINDING_TOKEN), p_input: { scope: RECORD_NAMES.scope, repository: RECORD_NAMES.repository } });
  assert.equal(sent.headers.apikey, DRILL_SERVER.publishableKey);
  assert.doesNotMatch(JSON.stringify(ok.s.calls) + JSON.stringify(r), new RegExp(BINDING_TOKEN));
  // the receipt
  assert.equal(await codeOf({ [receipt]: [200, { ...IN_SYNC, state: 'syncing' }], [holders]: [200, NOT_ON_DUTY] }), 'DRILL_SERVER_NOT_IN_SYNC:syncing');
  assert.equal(await codeOf({ [receipt]: [200, { ...IN_SYNC, state: 'diverged' }], [holders]: [200, NOT_ON_DUTY] }), 'DRILL_SERVER_NOT_IN_SYNC:diverged');
  assert.equal(await codeOf({ [receipt]: [404, { code: 'PGRST202' }], [holders]: [200, NOT_ON_DUTY] }), 'DRILL_SERVER_NOT_IN_SYNC:no-receipt');
  assert.equal(await codeOf({ [receipt]: [401, { message: 'Invalid API key' }], [holders]: [200, NOT_ON_DUTY] }), 'DRILL_SERVER_KEY_REFUSED');
  const down = ready({ [receipt]: new Error('offline'), [holders]: [200, NOT_ON_DUTY] });
  await assert.rejects(down.run, e => e.message === 'DRILL_SERVER_UNREACHABLE'); assert.equal(down.s.calls.length, 3, 'three tries, and no probe after them');
  // the probe: let through (no parking role, or a role on the binding: the guest would turn ACTIVE), refused, or not there at all
  assert.equal(await codeOf({ [receipt]: [200, IN_SYNC], [holders]: [200, { status: 'ok', repository: RECORD_NAMES.repository, holders: [] }] }), 'DRILL_BINDING_ON_DUTY');
  assert.equal(await codeOf({ [receipt]: [200, IN_SYNC], [holders]: [401, { code: '42501', message: 'binding_not_authorized' }] }), 'DRILL_BINDING_REFUSED_BY_SERVER');
  assert.equal(await codeOf({ [receipt]: [200, IN_SYNC], [holders]: [403, { code: '42501', message: 'authorization_revoked_or_expired' }] }), 'DRILL_BINDING_REFUSED_BY_SERVER');
  assert.equal(await codeOf({ [receipt]: [200, IN_SYNC], [holders]: [404, { code: 'PGRST202' }] }), 'DRILL_SERVER_PROBE_FUNCTION_MISSING');
  assert.equal(await codeOf({ [receipt]: [200, IN_SYNC], [holders]: [503, null] }), 'DRILL_SERVER_UNREACHABLE');
  assert.equal(await codeOf({ [receipt]: [200, IN_SYNC], [holders]: [200, { status: 'what' }] }), 'DRILL_SERVER_UNREACHABLE:probe-unreadable');
  // not a binding token: nothing is sent
  const none = server({});
  await assert.rejects(() => checkModule.serverReady({ kit: f.out, from: f.from, version: f.version, token: 'not-a-token', fetch: none.fetch }), e => e.message === 'DRILL_BINDING_CREDENTIAL_REFUSED');
  assert.equal(none.calls.length, 0);
});

test('Assert-DrillServerReady stops the drill on the server\'s answer, each with its code, and keeps the receipt for the drill\'s own', { skip: !windows }, async () => {
  const { f } = await built('server-ready-host');
  const answering = (exit, text) => `function Invoke-DrillServerReadyNode([string]$Node, [string]$KitDir, [string]$From, [string]$Version, $Binding) {
      $script:Asked = [ordered]@{ kit = $KitDir; from = $From; version = $Version; connection = $Binding.UserName }
      @{ exit = ${exit}; stdout = ${exit === 0 ? q(text) : "''"}; stderr = ${exit === 0 ? "''" : q(text + '\n')} } }`;
  const gate = `$k = Read-DrillKit ${q(f.out)}; $p = Test-DrillPackageDir ${q(f.from)} ${q(f.version)} $k; Assert-DrillServerReady $k $p`;
  for (const code of ['DRILL_SERVER_KEY_REFUSED', 'DRILL_SERVER_NOT_IN_SYNC:syncing', 'DRILL_SERVER_UNREACHABLE', 'DRILL_SERVER_PROBE_FUNCTION_MISSING',
    'DRILL_BINDING_REFUSED_BY_SERVER', 'DRILL_BINDING_ON_DUTY']) {
    assert.equal(psCode(`${answering(1, code)}; ${gate}`), code.split(':')[0], code);
  }
  const kit = JSON.parse(fs.readFileSync(path.join(f.out, 'kit.json'))).server;
  const answer = JSON.stringify({ supabaseUrl: kit.supabaseUrl, releaseFirstInstallKitSha256: kit.releaseFirstInstallKitSha256, firstInstallKitSha256: kit.firstInstallKitSha256, receipt: IN_SYNC });
  const ok = ps(`${answering(0, answer)}; ${gate}; [ordered]@{ asked = $script:Asked; sync = $k.server.sync }`);
  assert.deepEqual(ok.asked, { kit: f.out, from: f.from, version: f.version, connection: BINDING_ID });
  assert.equal(ok.sync.state, 'in-sync'); assert.equal(ok.sync.productionLast, IN_SYNC.productionLast);
  // the whole run: the answer is asked for before the host hold, and a refusal starts nothing
  const main = `$script:RealAssertDrillServerReady = \${function:Assert-DrillServerReady}; ${candidateStubs}
    function Read-DrillKit { @{ dir = 'unused'; prereqSha256 = 'pin'; executionBlocker = $null; candidate = @{ acceptance = 'x' }; server = @{ supabaseUrl = 'unused' }; credentials = $null } }
    function Test-DrillPackageDir { @{ tar = 'unused'; version = '1.2.3'; candidate = $true } }
    Set-Item function:Assert-DrillServerReady $script:RealAssertDrillServerReady`;
  assert.equal(psCode(`${main}; ${answering(1, 'DRILL_BINDING_ON_DUTY')}; Invoke-DrillMain`), 'DRILL_BINDING_ON_DUTY');
  assert.equal(psCode(`${main}; ${answering(1, 'DRILL_SERVER_NOT_IN_SYNC:diverged')}; Invoke-DrillMain`), 'DRILL_SERVER_NOT_IN_SYNC');
});

// Section 5 of the sync design: what the stand-in rests on is registered where the stand-in is (the kit's step, the decision table).
test('the registered stand-in says what it rests on: the parking role the sync job seeds, and the token\'s 90 days', () => {
  assert.match(kitModule.SERVER_STAND_IN_STEP, /parking/); assert.match(kitModule.SERVER_STAND_IN_STEP, /同步作业/); assert.match(kitModule.SERVER_STAND_IN_STEP, /90 天/);
  const source = JSON.parse(fs.readFileSync(new URL('../drill/credential-decisions.json', import.meta.url), 'utf8')).decisions?.['ci-admission.token']?.source
    ?? JSON.stringify(JSON.parse(fs.readFileSync(new URL('../drill/credential-decisions.json', import.meta.url), 'utf8')));
  assert.match(source, /parking/); assert.match(source, /90 days/);
});
