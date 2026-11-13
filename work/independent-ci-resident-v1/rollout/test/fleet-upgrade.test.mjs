// The generic in-place upgrade, end to end (ADR 0030), in today's shape: two nodes a universal reinstall left at generation 1 (each its
// own profile, identity, signer and non-Source references; the same fleet Source references), NO directory of the installed package
// anywhere and no server record. One universal archive of this checkout, ONE acceptance file, the same command on both nodes
// (rollout/fleet/upgrade.mjs) give each node its own /4 upgrade package with the SAME ciSourceManifestSha256 (the accepted one), which
// the installed upgrader's ACCEPT passes (the archive's precheck.mjs) and whose request the FROZEN upgrader (upgrader/src/machine.mjs,
// the real package, its real plan) runs to SUCCEEDED: generation 2 on the accepted Source. The command again answers
// FLEET_NODE_ALREADY_AT_THIS_PACKAGE and requests nothing. An open operation is not requested twice. A node the package cannot upgrade
// in place (upgrader changed, Linux tool changed, a Source-entering fleet reference changed, Linux live tree not its generation) is
// answered FLEET_NODE_UPGRADE_NEEDS_REINSTALL with nothing requested; the same acceptance file's source-hash (what a reinstall
// installs) is the Source the upgrade installed.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { after } from 'node:test';
import { sourceHashOf } from '../fleet/install.mjs';
import { main, upgradeNode } from '../fleet/upgrade.mjs';
import { buildUniversal } from '../fleet/universal.mjs';
import { fixtureRepo, fleetFacts, nodeSite, sha, tempDir } from '../fleet/test/fleet-fixtures.mjs';
import { Journal } from '../../upgrader/src/journal.mjs';
import { parseInboxEntry } from '../../upgrader/src/request.mjs';
import { FakeDoor, FakeLinux, FakeResident, FakeWindows, fakeClock, testConfig, upgradeRequestBytes } from '../../upgrader/test/fixtures.mjs';
import { runOp } from '../../upgrader/test/harness.mjs';

const VERSION = '2026.11.13-1';
const cleanups = [];
const keep = { after: f => cleanups.push(f) };
after(async () => { for (const f of cleanups.reverse()) await f(); });
const readJson = async f => JSON.parse(await fs.readFile(f, 'utf8'));

// The acceptance file as the coordinator writes it for a version every node can take in place: the Source-entering references are the
// installed ones (install.mjs fleet-refs), the decision and receipt are this version's; then source-hash's ciSourceManifestSha256.
async function acceptanceOf(w, over = {}) {
  const decision = randomUUID(), receipt = randomUUID();
  const draft = { contract: 'clued.independent-ci.fleet-node-acceptance/1', version: w.release.source.version, archive_sha256: w.release.source.archive_sha256,
    commit: w.commit, repository: 'tdoljyj/cross-memory-system', cluedDecision: decision.slice(0, 8), acceptedAt: '2026-11-13T00:00:00Z',
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
    assert.deepEqual(policy.ownerAcceptance, { decisionRef: w.acceptance.fleetRefs.ownerDecisionRef, installReceiptRef: w.acceptance.fleetRefs.installationReceiptRef });
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
    await fs.writeFile(path.join(responses, 'version-facts.json'), JSON.stringify({ ...facts, generation: 2, ciSourceManifestSha256: cur.linux.ciSourceManifestSha256,
      manifestSha256: cur.linux.manifestSha256, observedAt: new Date().toISOString() }));
    // the same command again: done, nothing requested, nothing written
    const q = requester();
    const again = await upgrade(w, n, { request: q.request, workDir: path.join(n.dir, 'again') });
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
  const dry = await upgrade(w, n, { request: q.request, noRequest: true });
  assert.deepEqual([dry.status, q.calls.length], ['FLEET_NODE_UPGRADE_PREPARED_NOT_REQUESTED', 0], JSON.stringify(dry).slice(0, 2000));

  // an operation the upgrader still owns: not requested twice (and nothing is read or written beyond the status)
  await fs.writeFile(at('upgrade', 'status.json'), JSON.stringify({ contract: 'clued.independent-ci.resident-upgrade-status/1', writtenAt: new Date().toISOString(),
    op: { opId: randomUUID(), state: 'WAITING_GRANT', phase: 'grant', code: null, grant: { confirmUrl: 'https://kooyumi.pixelgrav.com/confirm/x' } } }));
  const busy = await upgrade(w, n, { request: q.request });
  assert.deepEqual([busy.status, busy.op.state, busy.op.confirmUrl, q.calls.length], ['FLEET_NODE_UPGRADE_IN_PROGRESS', 'WAITING_GRANT', 'https://kooyumi.pixelgrav.com/confirm/x', 0]);
  await fs.rm(at('upgrade', 'status.json'));

  // through the command line (as on a node): the reinstall hint is part of the answer
  const viaMain = async (acceptance, deps = {}) => {
    const file = path.join(n.dir, `acceptance-${workSeq += 1}.json`);
    await fs.writeFile(file, JSON.stringify(acceptance));
    return main(['--artifact', w.tar, '--artifact-sha', w.release.source.archive_sha256, '--acceptance', file, '--work', path.join(n.dir, `upgrade-${workSeq += 1}`)],
      { root: n.root, request: q.request, ...deps });
  };

  // 1. a Source-entering fleet reference changed in the acceptance file: this version is a reinstall for every node
  const moved = await acceptanceOf(w, { sourceAcceptanceRef: randomUUID() });
  const r1 = await viaMain(moved);
  await refusedBeforeAnyWork(r1, 'FLEET_NODE_UPGRADE_NEEDS_REINSTALL', 'FLEET_SOURCE_REFS_CHANGED_NEEDS_REINSTALL');
  assert.deepEqual(r1.detail, { changed: ['sourceAcceptanceRef'] });
  assert.match(r1.reinstall, /install\.mjs prepare/);

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
  assert.deepEqual([r4.status, r4.code, r4.precheck.status, q.calls.length], ['FLEET_NODE_UPGRADE_NEEDS_REINSTALL', 'LINUX_LIVE_NOT_THE_CURRENT_GENERATION', 'PRECHECK_REFUSED', 0],
    JSON.stringify(r4).slice(0, 2000));
  await undo();

  // 5. the two sides are not one package (a reinstall that stopped half way): the reinstall finishes it, never an upgrade
  undo = await rewrite(at('upgrade', 'mailbox', 'responses', 'version-facts.json'), f => ({ ...f, ciSourceManifestSha256: 'c'.repeat(64) }));
  await refusedBeforeAnyWork(await viaMain(w.acceptance), 'FLEET_NODE_UPGRADE_NEEDS_REINSTALL', 'NODE_SIDES_NOT_ONE_PACKAGE');
  await undo();

  // other refusals are not a reason to reinstall: an archive that is not the accepted one, a work directory that exists
  await refusedBeforeAnyWork(await viaMain({ ...w.acceptance, archive_sha256: 'f'.repeat(64) }), 'FLEET_NODE_UPGRADE_REFUSED', 'FLEET_ARTIFACT_SHA_NOT_THE_ACCEPTED');

  // the node is untouched by all of the above: the real request goes through, for the package the dry run assembled
  const r = await viaMain(w.acceptance);
  assert.deepEqual([r.status, r.packageManifestSha256, q.calls.length], ['FLEET_NODE_UPGRADE_REQUESTED', dry.packageManifestSha256, 1], JSON.stringify(r).slice(0, 2000));
});
