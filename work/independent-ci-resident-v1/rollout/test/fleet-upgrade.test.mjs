// The generic in-place upgrade, end to end (ADR 0030), in today's shape: two nodes a universal reinstall left at generation 1 (each its
// own profile, identity, signer and non-Source references; the same fleet Source references), NO directory of the installed package
// anywhere and no server record. One universal archive of this checkout, ONE acceptance file, the same command on both nodes
// (rollout/fleet/upgrade.mjs) give each node its own /4 upgrade package with the SAME ciSourceManifestSha256 (the accepted one), which
// the installed upgrader's ACCEPT passes (the archive's precheck.mjs) and whose request the FROZEN upgrader (upgrader/src/machine.mjs,
// the real package, its real plan) runs to SUCCEEDED: generation 2 on the accepted Source. The command again answers
// FLEET_NODE_ALREADY_AT_THIS_PACKAGE and requests nothing. An open operation is not requested twice; the node on duty is not requested
// without the Owner's acceptance of the CI pause. A node the package cannot upgrade
// in place (upgrader changed, Linux tool changed, a Source-entering fleet reference changed, Linux live tree not its generation) is
// routed to reinstall with nothing requested; the same acceptance file's source-hash (what a reinstall
// installs) is the Source the upgrade installed.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { POLICY_CONTRACT_V8 } from '../../src/policy.mjs';
import { sourceHashOf } from '../fleet/install.mjs';
import { main, upgradeNode } from '../fleet/upgrade.mjs';
import { buildUniversal } from '../fleet/universal.mjs';
import { fixtureRepo, fleetFacts, nodeSite, sha, tempDir } from '../fleet/test/fleet-fixtures.mjs';
import { Journal } from '../../upgrader/src/journal.mjs';
import { parseInboxEntry } from '../../upgrader/src/request.mjs';
import { FakeDoor, FakeLinux, FakeResident, FakeWindows, fakeClock, testConfig, upgradeRequestBytes } from '../../upgrader/test/fixtures.mjs';
import { runOp } from '../../upgrader/test/harness.mjs';

import { buildStatus } from '../../upgrader/src/status.mjs';
import { readVersionState } from '../../src/status.mjs';

const VERSION = 'g000024';
const cleanups = [];
const keep = { after: f => cleanups.push(f) };
after(async () => { for (const f of cleanups.reverse()) await f(); });
const readJson = async f => JSON.parse(await fs.readFile(f, 'utf8'));

// The acceptance file as the coordinator writes it for a version every node can take in place: the Source-entering references are the
// installed ones (install.mjs fleet-refs), the decision and receipt are this version's; then source-hash's ciSourceManifestSha256.
async function acceptanceOf(w, over = {}) {
  const decision = randomUUID(), receipt = randomUUID();
  const draft = { contract: 'clued.independent-ci.fleet-node-acceptance/1', version: w.release.source.version, archive_sha256: w.release.source.archive_sha256,
    commit: w.commit, repository: 'tdoljyj/cross-memory-system', cluedDecision: decision.slice(0, 8), acceptedAt: '2026-11-13T00:00:00Z', firstInstallKitSha256: 'd'.repeat(64),
    fleetRefs: { sourceAcceptanceRef: w.fleet.sourceAcceptanceRef, hostQualificationRef: w.fleet.hostQualificationRef, ownerAuthorizationRef: decision,
      publisherQualificationRef: decision, ownerPackageAcceptanceRef: decision, installationReceiptRef: receipt, ownerDecisionRef: decision, ownerReceiptRef: receipt,
      formalRoles: w.fleet.formalRoles, ...over } };
  const sh = await sourceHashOf({ artifactPath: w.tar, artifactSha256: w.release.source.archive_sha256, acceptance: draft });
  return { ...draft, ciSourceManifestSha256: sh.ciSourceManifestSha256 };
}

let world = null;
async function getWorld() {
  if (world) return world;
  const fleet = fleetFacts();
  const { repo, commit } = await fixtureRepo(keep);
  const a = await nodeSite(keep, 'a', fleet), b = await nodeSite(keep, 'b', fleet);
  const d = await tempDir(keep, 'fleetupg');
  const built = await buildUniversal({ repo, commit, version: VERSION, out: path.join(d, 'out') });
  world = { fleet, commit, a, b, d, tar: built.tar, release: await readJson(built.release) };
  world.acceptance = await acceptanceOf(world);
  return world;
}

// The installed request-upgrade.ps1 stands behind a fixed C:\ProgramData root and the Owner's SID: here its call is recorded and its
// answer given; the request it would write is what runUpgrader hands the frozen upgrader.
function requester() {
  const calls = [];
  return { calls, request: async a => { calls.push(a); return { status: 'UPGRADE_REQUESTED', requestId: randomUUID(), requestFile: 'inbox\\fixture.json' }; } };
}
test('即使 Source 相同，缺少本机监督器编译证明也须重装', async () => {
  const w = await getWorld(), n = await nodeSite(keep, 'x', w.fleet);
  const file = path.join(n.root, 'upgrade', 'current.json'), cur = await readJson(file);
  const receiptFile = path.join(n.root, 'install', 'install-receipt.json'), receipt = await readJson(receiptFile);
  delete receipt.companionSupervisorSourceSha256;
  await fs.writeFile(receiptFile, JSON.stringify(receipt));
  await fs.writeFile(file, JSON.stringify({ ...cur, installReceiptSha256: sha(JSON.stringify(receipt)),
    residentManifestSha256: w.release.source.resident_manifest_sha256, ciSourceManifestSha256: w.acceptance.ciSourceManifestSha256,
    linux: { ...cur.linux, ciSourceManifestSha256: w.acceptance.ciSourceManifestSha256 } }));
  const facts = path.join(n.root, 'upgrade', 'mailbox', 'responses', 'version-facts.json');
  await fs.writeFile(facts, JSON.stringify({ ...await readJson(facts), staged: null, ciSourceManifestSha256: w.acceptance.ciSourceManifestSha256 }));
  const q = requester();
  const checkReinstall = async (candidate, installed) => ({ candidate, ...installed, observedAt: '2026-11-27T00:00:00Z',
    evidenceSha256: 'a'.repeat(64), checks: {
      currentPointer: true, installReceipt: true, linuxFacts: true, ciConnection: true, host: true, roleAndPause: true,
      operations: true, launcher: true, acl: true, connectionCarry: true, processClearance: true, continuation: true,
    } });
  const result = await upgrade(w, n, { now: Date.parse('2026-11-27T00:01:00Z'), request: q.request, checkReinstall });
  assert.equal(result.status, 'FLEET_NODE_UPGRADE_NEEDS_REINSTALL');
  assert.equal(result.reinstallStatus, 'PASS');
  assert.ok(result.reinstall);
  assert.equal(q.calls.length, 0);
});

let workSeq = 0;
const upgrade = (w, n, over = {}) => upgradeNode({ artifactPath: w.tar, artifactSha256: w.release.source.archive_sha256, acceptance: w.acceptance, root: n.root,
  workDir: path.join(n.dir, `upgrade-${workSeq += 1}`), ...over });

// The frozen upgrader on the node's root, with the request the command made: the Grant approved at once (the Owner's automatic approval).
async function runUpgrader(n, call, m) {
  const clock = fakeClock(Date.now());
  const resident = new FakeResident(clock);
  const env = { root: n.root, clock, resident, windows: new FakeWindows(n.root, resident), linux: new FakeLinux(n.root, clock), door: new FakeDoor(clock, { approveAt: 0 }),
    config: testConfig(n.root, { node: n.profile.nodeName, nodeProfileSha256: m.nodeProfileSha256, ownerSid: n.profile.ownerSid }) };
  env.ports = { door: env.door, resident: env.resident, windows: env.windows, linux: env.linux };
  const opId = randomUUID();
  const bytes = upgradeRequestBytes({ sha: call.packageManifestSha256, dir: call.packageDir }, { requestId: opId, node: n.profile.nodeName, acceptanceDecisionRef: call.decisionRef, at: clock.now });
  assert.equal(parseInboxEntry(bytes).kind, 'upgrade', 'the intake of the upgrader takes this request (node, package directory, decision)');
  await Journal.create(path.join(n.root, 'upgrade', 'ops'), opId, bytes, { clock: clock.fn });
  return runOp(env, opId);
}

test('fleet upgrade: generation 1 of a universal reinstall, no installed package directory: one archive, one acceptance, the same command; the frozen upgrader takes it to generation 2', { timeout: 900_000 }, async t => {
  const w = await getWorld();
  const results = [];
  for (const n of [w.a, w.b]) {
    // today's shape: nothing on the node names or holds the installed package
    await assert.rejects(fs.access(path.join(n.root, 'upgrade', 'staged')));
    const q = requester();
    const r = await upgrade(w, n, { request: q.request });
    assert.equal(r.status, 'FLEET_NODE_UPGRADE_REQUESTED', JSON.stringify(r).slice(0, 3000));
    assert.match(r.precheck.status, /^PRECHECK_PASS/);
    assert.deepEqual([r.node, r.fromGeneration, r.ciSourceManifestSha256, r.grantResource],
      [n.profile.nodeName, 1, w.acceptance.ciSourceManifestSha256, `ci-resident:${n.profile.nodeName}/${r.packageManifestSha256}`]);
    // one request, by the INSTALLED generation's tool, for exactly this package and the acceptance's decision
    assert.deepEqual(q.calls, [{ script: path.join(n.root, 'resident', n.pkg.residentSha, 'windows', 'request-upgrade.ps1'), packageDir: r.packageDir,
      packageManifestSha256: r.packageManifestSha256, decisionRef: w.acceptance.fleetRefs.ownerDecisionRef }]);
    const m = await readJson(path.join(r.packageDir, 'package-manifest.json'));
    assert.equal(sha(await fs.readFile(path.join(r.packageDir, 'package-manifest.json'))), r.packageManifestSha256);
    // the accepted Source, the archive's universal values; the node's own identity (every installed reference) and profile
    assert.equal(m.ciSourceManifestSha256, w.acceptance.ciSourceManifestSha256);
    assert.deepEqual([m.residentManifestSha256, m.upgrader.manifestSha256, m.linux.sourceV2.commit, m.linux.sourceV2.bundleSha256],
      [w.release.source.resident_manifest_sha256, w.release.source.upgrader_manifest_sha256, w.commit, w.release.source.bundle_sha256]);
    assert.deepEqual([m.nodeIdentitySha256, m.nodeProfileSha256], [n.pkg.manifest.nodeIdentitySha256, n.pkg.manifest.nodeProfileSha256]);
    assert.ok(!m.files.some(e => e.target.startsWith('upgrader\\') || e.target.startsWith('secrets\\')), 'not a fresh-install package');
    const policy = await readJson(path.join(r.packageDir, 'config', 'policy.json'));
    assert.deepEqual(policy.ownerAcceptance, { decisionRef: w.acceptance.fleetRefs.ownerDecisionRef,
      installReceiptRef: w.acceptance.fleetRefs.installationReceiptRef, installedPackage: { version: VERSION, packageGeneration: 24,
        releaseTag: 'fleet-node-' + VERSION, commit: w.commit, ciSourceManifestSha256: w.acceptance.ciSourceManifestSha256,
        archiveSha256: w.acceptance.archive_sha256 } });
    results.push({ n, r, m, call: q.calls[0] });
  }
  assert.notEqual(results[0].r.packageManifestSha256, results[1].r.packageManifestSha256, 'each node its own package');

  // the frozen upgrader: Grant, drain, pause, stage, both sides' switch, verify, resume. On Windows only: a request names a Windows
  // package directory (A3), and the upgrader's own tests (upgrader/test) have never run anywhere else.
  if (process.platform !== 'win32') return t.diagnostic('the frozen upgrader run is Windows-only; assembled, prechecked and requested here');
  for (const { n, r, m, call } of results) {
    const { terminal } = await runUpgrader(n, call, m);
    assert.equal(terminal.outcome, 'SUCCEEDED', JSON.stringify(terminal));
    const cur = await readJson(path.join(n.root, 'upgrade', 'current.json'));
    assert.deepEqual([cur.generation, cur.packageManifestSha256, cur.ciSourceManifestSha256, cur.linux.ciSourceManifestSha256, cur.residentManifestSha256],
      [2, r.packageManifestSha256, w.acceptance.ciSourceManifestSha256, w.acceptance.ciSourceManifestSha256, w.release.source.resident_manifest_sha256]);
    // the companion's facts after the switch (the fixture's Linux stand-in keeps them in fake-linux.json)
    const responses = path.join(n.root, 'upgrade', 'mailbox', 'responses');
    const facts = await readJson(path.join(responses, 'version-facts.json'));
    const clock = fakeClock(Date.parse(terminal.at));
    await fs.writeFile(path.join(responses, 'version-facts.json'), JSON.stringify({ ...facts, generation: 2, ciSourceManifestSha256: cur.linux.ciSourceManifestSha256,
      manifestSha256: cur.linux.manifestSha256, sourceCommit: w.commit, observedAt: terminal.at }));
    await fs.writeFile(path.join(n.root, 'upgrade', 'status.json'), JSON.stringify(buildStatus({ clock: clock.fn, pid: 1,
      current: cur, recent: [{ opId: terminal.opId, outcome: terminal.outcome, code: null, at: terminal.at }] })));
    const policy = await readJson(path.join(n.root, 'config', 'policy.json'));
    const { view } = await readVersionState({ root: n.root, policy, policySha256: cur.policySha256, clock: clock.fn });
    assert.equal(view.installedPackage.packageGeneration, 24);
    assert.equal((await fs.readFile(path.join(n.root, 'state', 'PACKAGE-VERSION.txt'), 'utf8')).split('\r\n')[0], '第 24 代');
    // the same command again: done, nothing requested, nothing written
    const q = requester();
    const again = await upgrade(w, n, { request: q.request, workDir: path.join(n.dir, 'again'), now: clock.now });
    assert.deepEqual([again.status, again.generation, again.packageManifestSha256, q.calls.length], ['FLEET_NODE_ALREADY_AT_THIS_PACKAGE', 2, r.packageManifestSha256, 0]);
    await assert.rejects(fs.access(path.join(n.dir, 'again')));
  }
});

test('fleet upgrade: safe to run again, and the nodes it cannot take in place go to the reinstall with nothing requested', { timeout: 900_000 }, async t => {
  const w = await getWorld();
  const n = await nodeSite(t, 'c', w.fleet);
  const q = requester();
  const at = (...p) => path.join(n.root, ...p);
  const rewrite = async (file, change) => { const old = await fs.readFile(file); await fs.writeFile(file, JSON.stringify(change(JSON.parse(old.toString('utf8'))))); return () => fs.writeFile(file, old); };
  const refusedBeforeAnyWork = async (r, status, code) => {
    assert.deepEqual([r.status, r.code], [status, code], JSON.stringify(r).slice(0, 1500));
    assert.equal(q.calls.length, 0);
  };

  // --no-request: assembled and prechecked, not requested; the package is the one a real run requests (reproducible)
  const sameWork = path.join(n.dir, 'upgrade-same-work');
  const dry = await upgrade(w, n, { request: q.request, noRequest: true, workDir: sameWork });
  assert.deepEqual([dry.status, q.calls.length], ['FLEET_NODE_UPGRADE_PREPARED_NOT_REQUESTED', 0], JSON.stringify(dry).slice(0, 2000));
  const dryManifest = await fs.readFile(path.join(dry.packageDir, 'package-manifest.json'));

  // an operation the upgrader still owns: not requested twice (and nothing is read or written beyond the status)
  await fs.writeFile(at('upgrade', 'status.json'), JSON.stringify({ contract: 'clued.independent-ci.resident-upgrade-status/1', writtenAt: new Date().toISOString(),
    op: { opId: randomUUID(), state: 'WAITING_GRANT', phase: 'grant', code: null, grant: { confirmUrl: 'https://kooyumi.pixelgrav.com/confirm/x' } } }));
  const busy = await upgrade(w, n, { request: q.request });
  assert.deepEqual([busy.status, busy.op.state, busy.op.confirmUrl, q.calls.length], ['FLEET_NODE_UPGRADE_IN_PROGRESS', 'WAITING_GRANT', 'https://kooyumi.pixelgrav.com/confirm/x', 0]);
  await fs.rm(at('upgrade', 'status.json'));

  // through the command line (as on a node): the reinstall hint is part of the answer
  const viaMain = async (acceptance, deps = {}, work = path.join(n.dir, `upgrade-${workSeq += 1}`)) => {
    const file = path.join(n.dir, `acceptance-${workSeq += 1}.json`);
    await fs.writeFile(file, JSON.stringify(acceptance));
    return main(['--artifact', w.tar, '--artifact-sha', w.release.source.archive_sha256, '--acceptance', file, '--work', work],
      { root: n.root, request: q.request, ...deps });
  };

  // 1. a Source-entering fleet reference changed in the acceptance file: this version is a reinstall for every node
  const moved = await acceptanceOf(w, { sourceAcceptanceRef: randomUUID() });
  const r1 = await viaMain(moved);
  await refusedBeforeAnyWork(r1, 'FLEET_NODE_UPGRADE_NEEDS_REINSTALL', 'FLEET_SOURCE_REFS_CHANGED_NEEDS_REINSTALL');
  assert.deepEqual(r1.detail, { changed: ['sourceAcceptanceRef'] });
  assert.equal(r1.reinstallStatus, 'UNKNOWN');
  assert.equal(r1.reinstall, undefined);

  // 2. the Linux upgrade tool is not the installed one
  let undo = await rewrite(at('upgrade', 'mailbox', 'responses', 'version-facts.json'), f => ({ ...f, upgradeToolSha256: 'e'.repeat(64) }));
  const r2 = await viaMain(w.acceptance);
  await refusedBeforeAnyWork(r2, 'FLEET_NODE_UPGRADE_NEEDS_REINSTALL', 'UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL');
  assert.equal(r2.detail.what, 'linux-upgrade-tool');
  await undo();

  // 3. the upgrader is not the installed one (the receipt's; current.json pins the receipt)
  const receiptFile = at('install', 'install-receipt.json'), currentFile = at('upgrade', 'current.json');
  const [receiptOld, currentOld] = [await fs.readFile(receiptFile), await fs.readFile(currentFile)];
  const receipt = JSON.parse(receiptOld.toString('utf8'));
  receipt.upgrader.manifestSha256 = 'd'.repeat(64);
  await fs.writeFile(receiptFile, JSON.stringify(receipt));
  await fs.writeFile(currentFile, JSON.stringify({ ...JSON.parse(currentOld.toString('utf8')), installReceiptSha256: sha(await fs.readFile(receiptFile)) }));
  const r3 = await viaMain(w.acceptance);
  await refusedBeforeAnyWork(r3, 'FLEET_NODE_UPGRADE_NEEDS_REINSTALL', 'UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL');
  assert.equal(r3.detail.what, 'upgrader');
  await fs.writeFile(receiptFile, receiptOld); await fs.writeFile(currentFile, currentOld);

  // 4. the precheck's own refusal (the Linux live tree is not the generation on record): assembled, never requested
  undo = await rewrite(at('upgrade', 'mailbox', 'responses', 'version-facts.json'), f => ({ ...f, liveMatchesCurrent: false }));
  const r4 = await viaMain(w.acceptance);
  assert.deepEqual([r4.status, r4.code, r4.reinstallStatus, r4.precheck.status, q.calls.length],
    ['FLEET_NODE_UPGRADE_NEEDS_REINSTALL', 'LINUX_LIVE_NOT_THE_CURRENT_GENERATION', 'UNKNOWN', 'PRECHECK_REFUSED', 0], JSON.stringify(r4).slice(0, 2000));
  await undo();

  // 5. the two sides are not one package (a reinstall that stopped half way): the reinstall finishes it, never an upgrade
  undo = await rewrite(at('upgrade', 'mailbox', 'responses', 'version-facts.json'), f => ({ ...f, ciSourceManifestSha256: 'c'.repeat(64) }));
  await refusedBeforeAnyWork(await viaMain(w.acceptance), 'FLEET_NODE_UPGRADE_NEEDS_REINSTALL', 'NODE_SIDES_NOT_ONE_PACKAGE');
  await undo();

  // other refusals are not a reason to reinstall: an archive that is not the accepted one
  await refusedBeforeAnyWork(await viaMain({ ...w.acceptance, archive_sha256: 'f'.repeat(64) }), 'FLEET_NODE_UPGRADE_REFUSED', 'FLEET_ARTIFACT_SHA_NOT_THE_ACCEPTED');

  // the node on duty is not requested by default (the standby first, then the hand-over); with the Owner's acceptance of the CI pause it is
  await fs.mkdir(at('state'), { recursive: true });
  await fs.writeFile(at('state', 'status.json'), JSON.stringify({ node: { mode: 'ACTIVE', name: n.profile.nodeName } }));
  const duty = await viaMain(w.acceptance);
  assert.deepEqual([duty.status, q.calls.length], ['FLEET_NODE_UPGRADE_HAND_OVER_FIRST', 0], JSON.stringify(duty).slice(0, 2000));
  const accepted = await upgrade(w, n, { request: q.request, allowActiveUpgrade: true, noRequest: true });
  assert.deepEqual([accepted.status, accepted.ciPause, q.calls.length], ['FLEET_NODE_UPGRADE_PREPARED_NOT_REQUESTED', true, 0]);
  await fs.rm(at('state', 'status.json'));

  // the node is untouched by all of the above: the real request goes through, for the package the dry run assembled. The same command
  // again, with the same --work (field 2026-11-16: EEXIST): a run of its own under it, the earlier run's package untouched.
  const r = await viaMain(w.acceptance, {}, sameWork);
  assert.deepEqual([r.status, r.packageManifestSha256, q.calls.length], ['FLEET_NODE_UPGRADE_REQUESTED', dry.packageManifestSha256, 1], JSON.stringify(r).slice(0, 2000));
  assert.notEqual(r.packageDir, dry.packageDir);
  assert.equal(path.relative(sameWork, r.packageDir).split(path.sep).length, 2, 'under the same --work');
  assert.deepEqual(await fs.readFile(path.join(dry.packageDir, 'package-manifest.json')), dryManifest, "the earlier run's package is untouched");
});

// Task 0b1516c0 (field 2026-11-23, TURING): the node on duty, a target with the train on, a fresh nodes list (5 minutes old) in which the
// other node still runs an older Source. "The other node has been upgraded since, the list is behind" and "it really is older" are the same
// input here, so the precheck compares no Source across nodes: it passes on this node's own checks. The order (standby first) is step 8's
// hand-over gate; one Source across the fleet is stage 10's TRAIN_SOURCE_MISMATCH at run time (source v2 train-sweep.test.mjs).
test('fleet upgrade: the node on duty is not refused on a nodes list that shows the other node on an older Source; the hand-over gate still holds', { timeout: 900_000 }, async t => {
  const w = await getWorld();
  const n = await nodeSite(t, 'd', w.fleet, { policyContract: POLICY_CONTRACT_V8 });
  const q = requester();
  const current = await readJson(path.join(n.root, 'upgrade', 'current.json'));
  const older = 'c'.repeat(64), now = Date.now(), ago = ms => new Date(now - ms).toISOString();
  assert.notEqual(older, w.acceptance.ciSourceManifestSha256);
  await fs.mkdir(path.join(n.root, 'state'), { recursive: true });
  await fs.writeFile(path.join(n.root, 'state', 'status.json'), JSON.stringify({ node: { mode: 'ACTIVE', name: n.profile.nodeName }, train: { nodes: {
    at: ago(5 * 60_000), sourceManifestSha256: current.ciSourceManifestSha256, dropped: 0, nodes: [
      { node: n.profile.nodeName, sourceManifestSha256: current.ciSourceManifestSha256, state: 'ACTIVE', lastHeartbeatAt: ago(60_000) },
      { node: 'desk', sourceManifestSha256: older, state: 'STANDBY', lastHeartbeatAt: ago(60_000) }] } } }));
  const r = await upgrade(w, n, { request: q.request, allowActiveUpgrade: true, noRequest: true });
  assert.equal((await readJson(path.join(r.packageDir, 'config', 'policy.json'))).train.enabled, 'on', 'the target turns the train on');
  assert.deepEqual([r.status, r.code ?? null, r.ciPause, q.calls.length], ['FLEET_NODE_UPGRADE_PREPARED_NOT_REQUESTED', null, true, 0],
    JSON.stringify({ status: r.status, code: r.code, precheck: r.precheck }).slice(0, 3000));
  assert.match(r.precheck.status, /^PRECHECK_PASS/);
  assert.equal('fleetSourceReadiness' in r.precheck, false, 'no cross-node Source comparison in the precheck');
  // the same scene without the Owner's acceptance of the CI pause: the order gate answers, nothing requested
  const duty = await upgrade(w, n, { request: q.request });
  assert.deepEqual([duty.status, q.calls.length], ['FLEET_NODE_UPGRADE_HAND_OVER_FIRST', 0], JSON.stringify(duty).slice(0, 2000));
});

test('fleet upgrade fetch: one command takes the tar from the second source, checks its sha256, unpacks it and runs the UNPACKED upgrade.mjs; a wrong tar is never unpacked', { timeout: 900_000 }, async t => {
  const w = await getWorld();
  const version = w.release.source.version, tag = `fleet-node-${version}`, sha256 = w.release.source.archive_sha256;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-fetch-cmd-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const from = path.join(dir, 'from');
  await fs.mkdir(from);
  await fs.copyFile(w.tar, path.join(from, `${tag}.tar`));
  await fs.writeFile(path.join(from, `${tag}.acceptance.json`), JSON.stringify(w.acceptance));
  await fs.writeFile(path.join(from, 'SHA256SUMS'), `${sha256}  ${tag}.tar\n`);
  const noNetwork = { fetch: { apiBase: 'http://127.0.0.1:1', getToken: () => { throw new Error('no token'); } } };
  const ran = [];
  const runChild = (exe, args) => { ran.push(args); return { status: 0, stdout: '', last: JSON.stringify({ contract: 'clued.independent-ci.fleet-node-upgrade/1', status: 'FLEET_NODE_UPGRADE_REQUESTED' }), stderr: '' }; };
  const r = await main(['fetch', '--version', version, '--work', path.join(dir, 'w1'), '--from', from, '--no-request'], { ...noNetwork, runChild });
  assert.equal(r.status, 'FLEET_NODE_UPGRADE_REQUESTED', JSON.stringify(r).slice(0, 800));
  assert.equal(r.fetched.source, 'from');
  const [script, ...rest] = ran[0];
  assert.equal(script, path.join(dir, 'w1', 'unpacked', 'tree', 'work', 'independent-ci-resident-v1', 'rollout', 'fleet', 'upgrade.mjs'));
  assert.ok((await fs.readFile(script)).length > 0, 'the unpacked package has its own upgrade.mjs, and fetch.mjs beside it');
  await fs.access(path.join(path.dirname(script), 'fetch.mjs'));
  assert.deepEqual(rest.slice(0, 6), ['--artifact', path.join(dir, 'w1', 'dl', `${tag}.tar`), '--artifact-sha', sha256, '--acceptance', path.join(dir, 'w1', 'dl', `${tag}.acceptance.json`)]);
  assert.ok(rest.includes('--no-request'));
  // a tar that is not the accepted one: refused, nothing unpacked, nothing run
  const bad = Buffer.from(await fs.readFile(w.tar)); bad[600] ^= 1;
  await fs.writeFile(path.join(from, `${tag}.tar`), bad);
  const r2 = await main(['fetch', '--version', version, '--work', path.join(dir, 'w2'), '--from', from], { ...noNetwork, fetch: { ...noNetwork.fetch, deadlineMs: 100, backoffMs: () => 10 }, runChild });
  assert.equal(r2.status, 'FLEET_NODE_UPGRADE_REFUSED');
  await assert.rejects(fs.access(path.join(dir, 'w2', 'unpacked')));
  assert.equal(ran.length, 1);
});

test('fleet upgrade fetch: a rollback to a package whose acceptance has no kit field is not stopped by this (newer) copy; the unpacked package judges it, and a new package without a kit is still refused by its own rule', { timeout: 900_000 }, async t => {
  const w = await getWorld();
  const version = w.release.source.version, tag = `fleet-node-${version}`, sha256 = w.release.source.archive_sha256;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-fetch-old-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const from = path.join(dir, 'from');
  await fs.mkdir(from);
  await fs.copyFile(w.tar, path.join(from, `${tag}.tar`));
  const { firstInstallKitSha256, ...old } = w.acceptance;   // the shape of the acceptance of an older package (26401d59, 78ad314b)
  await fs.writeFile(path.join(from, `${tag}.acceptance.json`), JSON.stringify(old));
  await fs.writeFile(path.join(from, 'SHA256SUMS'), `${sha256}  ${tag}.tar\n`);
  const noNetwork = { fetch: { apiBase: 'http://127.0.0.1:1', getToken: () => { throw new Error('no token'); } } };
  const ran = [];
  const runChild = (exe, args) => { ran.push(args); return { status: 0, stdout: '', last: JSON.stringify({ contract: 'clued.independent-ci.fleet-node-upgrade/1', status: 'FLEET_NODE_UPGRADE_REQUESTED' }), stderr: '' }; };
  const r = await main(['fetch', '--version', version, '--work', path.join(dir, 'w1'), '--from', from, '--no-request'], { ...noNetwork, runChild });
  assert.equal(r.status, 'FLEET_NODE_UPGRADE_REQUESTED', JSON.stringify(r).slice(0, 800));
  assert.equal(ran.length, 1, 'the unpacked upgrade.mjs is run');
  // this package's own rule (what the unpacked upgrade.mjs does with the same file): no kit, no upgrade
  await assert.rejects(upgradeNode({ artifactPath: w.tar, artifactSha256: sha256, acceptance: old, root: w.a.root, workDir: path.join(dir, 'w2') }), { code: 'FLEET_ACCEPTANCE_HAS_NO_FIRST_INSTALL_KIT' });
});

// Task 87d330d0 (FABLE-drill-memory-short-20261124.md section 3.3 item 4): the command's write set is its work directory, the inbox
// file (the installed request tool's; a stand-in here) and the Owner's .wslconfig with its backup (rollout/fleet/wsl-capacity.mjs).
// Any other file it adds, changes or removes in the node's root or the Owner's home is red: the set cannot widen unnoticed.
test('fleet upgrade: writes nothing but its work directory and the Owner\'s .wslconfig (memory= from the capacity profile, a backup first)', { timeout: 900_000 }, async t => {
  const w = await getWorld();
  const n = await nodeSite(t, 'w', w.fleet);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fleetupg-home-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const wslconfig = path.join(home, '.wslconfig');
  await fs.writeFile(wslconfig, '[wsl2]\r\nmemory=28GB\r\nprocessors=16\r\n\r\n[experimental]\r\nsparseVhd=true\r\n');
  await fs.writeFile(path.join(home, 'other.txt'), 'the Owner\'s own file\n');
  const snapshot = async dir => {
    const out = new Map();
    for (const e of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
      if (!e.isFile()) continue;
      const f = path.join(e.parentPath, e.name);
      out.set(f, sha(await fs.readFile(f)));
    }
    return out;
  };
  const before = new Map([...await snapshot(n.dir), ...await snapshot(home)]);
  const workDir = path.join(n.dir, 'scope-work');
  const q = requester();
  const r = await upgrade(w, n, { request: q.request, workDir, wslConfigPath: wslconfig, hostname: () => 'DESK-W-591' });
  assert.equal(r.status, 'FLEET_NODE_UPGRADE_REQUESTED', JSON.stringify(r).slice(0, 2000));
  assert.deepEqual([r.wslCapacity?.status, r.wslCapacity?.from, r.wslCapacity?.to], ['written', '28GB', '17GB'], JSON.stringify(r.wslCapacity));
  const after = new Map([...await snapshot(n.dir), ...await snapshot(home)]);
  const touched = [...new Set([...before.keys(), ...after.keys()])].filter(f => before.get(f) !== after.get(f));
  const allowed = f => f.startsWith(workDir + path.sep) || f === wslconfig || (path.dirname(f) === home && path.basename(f).startsWith('.wslconfig.clued-backup-'));
  assert.deepEqual(touched.filter(f => !allowed(f)), [], 'written outside the work directory and the .wslconfig');
  assert.ok(touched.includes(wslconfig) && touched.includes(r.wslCapacity.backup));
  assert.equal(await fs.readFile(wslconfig, 'utf8'), '[wsl2]\r\nmemory=17GB\r\nprocessors=16\r\n\r\n[experimental]\r\nsparseVhd=true\r\n');
});

// Review of Task 87d330d0 (REVIEW-drill-memgate-b-20261124.md, medium 1 and 2): the .wslconfig is written only by a run that requests this
// package's upgrade (or finds the node already at it), so a write is always in the answer. --no-request (the drill: assemble and
// precheck only), an open operation, a refusal and a reinstall answer write nothing; the answers that are not refusals say why.
test('fleet upgrade: --no-request, an open operation, a refusal and a reinstall answer leave the Owner\'s .wslconfig as it was', { timeout: 900_000 }, async t => {
  const w = await getWorld();
  const n = await nodeSite(t, 'v', w.fleet);
  const q = requester();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fleetupg-home-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const wslconfig = path.join(home, '.wslconfig');
  const OLD = '[wsl2]\r\nmemory=28GB\r\n';
  await fs.writeFile(wslconfig, OLD);
  const desk = { wslConfigPath: wslconfig, hostname: () => 'DESK-W-591' };
  const untouched = async what => {
    assert.equal(await fs.readFile(wslconfig, 'utf8'), OLD, `${what}: .wslconfig written`);
    assert.deepEqual(await fs.readdir(home), ['.wslconfig'], `${what}: a backup or temporary file`);
  };

  const dry = await upgrade(w, n, { request: q.request, noRequest: true, ...desk });
  assert.equal(dry.status, 'FLEET_NODE_UPGRADE_PREPARED_NOT_REQUESTED', JSON.stringify(dry).slice(0, 1500));
  assert.deepEqual([dry.wslCapacity?.status, dry.wslCapacity?.reason, dry.wslCapacity?.to, dry.wslCapacity?.backup], ['skipped', 'NOT_REQUESTED', '17GB', null], JSON.stringify(dry.wslCapacity));
  await untouched('--no-request');

  const statusFile = path.join(n.root, 'upgrade', 'status.json');
  await fs.writeFile(statusFile, JSON.stringify({ contract: 'clued.independent-ci.resident-upgrade-status/1', writtenAt: new Date().toISOString(),
    op: { opId: randomUUID(), state: 'WAITING_GRANT', phase: 'grant', code: null, grant: { confirmUrl: null } } }));
  const busy = await upgrade(w, n, { request: q.request, ...desk });
  assert.deepEqual([busy.status, busy.wslCapacity?.status, busy.wslCapacity?.reason], ['FLEET_NODE_UPGRADE_IN_PROGRESS', 'skipped', 'NOT_REQUESTED']);
  await untouched('an open operation');
  await fs.rm(statusFile);

  const file = path.join(n.dir, 'acceptance-moved.json');
  await fs.writeFile(file, JSON.stringify(await acceptanceOf(w, { sourceAcceptanceRef: randomUUID() })));
  const moved = await main(['--artifact', w.tar, '--artifact-sha', w.release.source.archive_sha256, '--acceptance', file, '--work', path.join(n.dir, 'upgrade-moved')],
    { root: n.root, request: q.request, ...desk });
  assert.deepEqual([moved.status, moved.code], ['FLEET_NODE_UPGRADE_NEEDS_REINSTALL', 'FLEET_SOURCE_REFS_CHANGED_NEEDS_REINSTALL'], JSON.stringify(moved).slice(0, 1500));
  await untouched('a reinstall answer');

  await fs.rm(path.join(n.root, 'upgrade', 'current.json'));
  await assert.rejects(upgrade(w, n, { request: q.request, ...desk }), { code: 'NODE_HAS_NO_INSTALL_FIRST_INSTALL_PATH' });
  await untouched('a refusal');
  assert.equal(q.calls.length, 0);
});
test('缺少监督器证明且重装不可用时，冻结通道仍可升级但不能证明本代完整交付', async t => {
  const clock = fakeClock(Date.parse('2026-11-27T00:01:00Z'));
  const w = await getWorld(), n = await nodeSite(t, 'a', w.fleet, { now: clock.now });
  const file = path.join(n.root, 'install', 'install-receipt.json');
  const receipt = await readJson(file);
  delete receipt.companionSupervisorSourceSha256;
  const bytes = JSON.stringify(receipt);
  await fs.writeFile(file, bytes);
  const curFile = path.join(n.root, 'upgrade', 'current.json');
  await fs.writeFile(curFile, JSON.stringify({ ...await readJson(curFile), installReceiptSha256: sha(bytes) }));
  const q = requester();
  const r = await upgrade(w, n, { now: clock.now, request: q.request, checkReinstall: async () => ({ status: 'UNKNOWN' }) });
  assert.equal(r.status, 'FLEET_NODE_UPGRADE_REQUESTED', JSON.stringify(r).slice(0, 1500));
  assert.equal(r.capabilities.companionSupervisor, 'UNPROVEN');
  assert.equal(r.capabilities.complete, false);
  assert.equal(q.calls.length, 1);
});

test('已钉监督器 EXE 摘要不符时拒绝升级，零投递', async t => {
  const w = await getWorld(), n = await nodeSite(t, 'a', w.fleet);
  await fs.writeFile(path.join(n.root, 'bin', 'CluedCompanionSupervisor.exe'), 'fixture changed');
  const q = requester();
  const r = await upgrade(w, n, { request: q.request });
  assert.deepEqual([r.status, r.code, r.reinstallStatus, q.calls.length],
    ['FLEET_NODE_UPGRADE_NEEDS_REINSTALL', 'COMPANION_SUPERVISOR_EXE_CHANGED', 'UNKNOWN', 0]);
});

test('安装回执与当前代次不符时结束升级，零投递', async t => {
  const w = await getWorld(), n = await nodeSite(t, 'a', w.fleet);
  const receipt = path.join(n.root, 'install', 'install-receipt.json');
  await fs.appendFile(receipt, '\n');
  const q = requester();
  const r = await upgrade(w, n, { request: q.request });
  assert.deepEqual([r.status, r.code, r.reinstallStatus, r.reinstall, q.calls.length],
    ['FLEET_NODE_UPGRADE_NEEDS_REINSTALL', 'NODE_RECEIPT_NOT_THE_CURRENT_GENERATION', 'UNKNOWN', undefined, 0]);
});
