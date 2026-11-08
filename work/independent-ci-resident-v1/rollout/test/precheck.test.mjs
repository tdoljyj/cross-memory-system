// precheck.mjs (DESIGN §42.3.2): the installed upgrader's ACCEPT against a node root, read-only. The packages carry the REAL upgrader
// copy of this tree (tools/build-package.mjs upgraderCopy), as every built package does, so the code that decides is the code under test.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256 } from '../../src/canonical.mjs';
import { upgraderCopy } from '../../tools/build-package.mjs';
import { DECISION, NODE, buildTestPackage, installGeneration1, tempDir } from '../../upgrader/test/fixtures.mjs';
import { precheck } from '../precheck.mjs';
import { trainNodesView } from '../../src/train.mjs';
import { trainFacts } from '../../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-facts.mjs';

const RESIDENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const T = Date.parse('2026-11-01T08:00:00.000Z');
const TOOL = 'linux/upgrade-v1/bin/clued-ci-upgrade-linux';
const SIGNER = 'linux/upgrade-v1/bin/clued-ci-sign-qualification-v2.mjs';
const TOOL_MANIFEST = 'linux/upgrade-v1/manifest.json';
const FROZEN_LINUX = { [TOOL]: '#!/usr/bin/python3.12 -I\n# tool\n', [SIGNER]: '// signer\n', [TOOL_MANIFEST]: '{"files":[]}\n' };

// A package whose `upgrader` is this tree's copy (one copy file changed with `change`, or every copy file AND the manifest list
// rewritten with `forge`), carrying the three frozen Linux upgrade files (`linux` overrides some of them). trainMode: the policy's
// train.enabled (null: no train key at all).
async function pkgWithCopy(dir, tag, { change = null, forge = null, linux = {}, trainMode = 'off', ...options } = {}) {
  const copy = await upgraderCopy(RESIDENT);
  let { manifest, manifestSha256 } = copy;
  const bytes = new Map();
  for (const f of manifest.files) bytes.set(f.path, await fs.readFile(path.join(RESIDENT, ...f.path.split('/'))));
  for (const p of [change, forge].filter(Boolean)) {
    // a forged file would run on import: it marks that it did
    bytes.set(p, Buffer.concat([bytes.get(p), Buffer.from(p === forge ? '\nglobalThis.__cluedForgedImport = true;\n' : '\n// changed\n')]));
    manifest = { ...manifest, files: manifest.files.map(f => (f.path === p ? { ...f, sha256: sha256(bytes.get(p)), bytes: bytes.get(p).length } : f)) };
    // `change` is an honest new copy (its own hash); `forge` keeps claiming the installed hash
    if (p === change) manifestSha256 = sha256(Buffer.from(canonicalJson(manifest) + '\n'));
  }
  const frozen = { ...FROZEN_LINUX, ...linux };
  const pkg = await buildTestPackage(dir, { tag, upgrader: { manifestSha256, files: manifest.files }, ...options, mutate: (m, files, put) => {
    const policyFile = m.files.find(f => f.target === 'config\\policy.json');
    const policy = JSON.parse(files.get(policyFile.path).toString('utf8'));
    if (trainMode !== null) policy.train = { enabled: trainMode };
    put(policyFile.path, canonicalJson(policy) + '\n');
    policyFile.sha256 = sha256(files.get(policyFile.path));
    for (const [p, text] of Object.entries(frozen)) {
      put(p, text);
      m.linux.files.push({ path: p, sha256: sha256(files.get(p)), bytes: files.get(p).length });
    }
    options.mutate?.(m, files, put);
  } });
  for (const [p, b] of bytes) { await fs.mkdir(path.dirname(path.join(dir, 'upgrader', p)), { recursive: true }); await fs.writeFile(path.join(dir, 'upgrader', p), b); }
  return pkg;
}

// A node root at generation 1 of `base`, whose installed upgrader is this tree's copy, and whose policy names the node.
async function node(t, base) {
  const root = await tempDir(t, 'clued-precheck-root-');
  await installGeneration1(root, base, { upgraderManifest: base.manifest.upgrader.manifestSha256 });
  const policy = JSON.parse(await fs.readFile(path.join(root, 'config', 'policy.json'), 'utf8'));
  await fs.writeFile(path.join(root, 'config', 'policy.json'), JSON.stringify({ ...policy, node: { nodeName: NODE } }));
  return root;
}

async function world(t, nextOptions = {}) {
  const dir = await tempDir(t, 'clued-precheck-');
  const base = await pkgWithCopy(path.join(dir, 'n1'), 'n1');
  const next = await pkgWithCopy(path.join(dir, 'n2'), 'n2', nextOptions);
  const root = await node(t, base);
  const run = (over = {}) => precheck({ root, pkgDir: next.dir, pkgSha: next.sha, acceptance: DECISION, installedPkgDir: base.dir, clock: () => T, ...over });
  return { dir, base, next, root, run };
}

async function writeFacts(root, over) {
  const facts = { contract: 'clued.independent-ci.linux-version-facts/1', generation: 1, ciSourceManifestSha256: 'a'.repeat(64), sourceCommit: null, manifestSha256: 'b'.repeat(64),
    roles: {}, pinsOk: true, staged: null, upgradeToolSha256: sha256(Buffer.from(FROZEN_LINUX[TOOL])), observedAt: new Date(T).toISOString(), ...over };
  await fs.mkdir(path.join(root, 'upgrade', 'mailbox', 'responses'), { recursive: true });
  await fs.writeFile(path.join(root, 'upgrade', 'mailbox', 'responses', 'version-facts.json'), JSON.stringify(facts));
}

test('precheck: PASS with the installed upgrader; the plan it reports is the one ACCEPT would make; nothing is written', async t => {
  const { next, root, run } = await world(t);
  const before = await listing(root);
  const r = await run();
  assert.equal(r.status, 'PRECHECK_PASS', JSON.stringify(r));
  assert.deepEqual([r.plan.fromGeneration, r.plan.toGeneration, r.plan.grantResource], [1, 2, `ci-resident:${NODE}/${next.sha}`]);
  assert.equal(r.plan.target.ciSourceManifestSha256, next.ciSource);
  assert.ok(r.plan.newDirs.some(d => d === `resident\\${next.residentSha}`));
  assert.ok(r.warnings.includes('LINUX_VERSION_FACTS_UNREADABLE'));
  assert.deepEqual(await listing(root), before);
  // the installed package is required: it is what the frozen files are compared with
  await assert.rejects(run({ installedPkgDir: undefined }), { code: 'USAGE' });
});

test('precheck: an admin-only slot is a stand-in, the rest is still decided', async t => {
  const { root, run } = await world(t);
  const denied = path.join(root, 'helpers', 'controller-formal-generic-v2.exe');
  const readSlot = file => (file === denied ? Promise.reject(Object.assign(new Error('EPERM'), { code: 'EPERM' })) : fs.readFile(file));
  const r = await run({ readSlot });
  assert.equal(r.status, 'PRECHECK_PASS_EXCEPT_UNREADABLE_SLOTS');
  assert.deepEqual(r.unreadableSlots, ['helpers\\controller-formal-generic-v2.exe']);
});

// Defect 15894c2a: the precheck before a train-on upgrade compares the OTHER nodes' Sources with the target, on the list stage 10 last
// read from Native (ci_nodes_status). The status snapshot's train.nodes is written exactly as the executor writes it: stage 10's facts
// (train-facts.mjs, as train-maintenance.mjs fills them) through train.mjs#trainNodesView.
const MIN = 60_000, HOUR = 60 * MIN;
const peer = (node, source, heardAgo) => ({ node, sourceManifestSha256: source, state: 'NORMAL', lastHeartbeatAt: heardAgo === null ? null : new Date(T - heardAgo).toISOString() });
async function writeNodes(root, { own, nodes, at = T }) {
  const facts = trainFacts({ mode: 'on', at: new Date(at).toISOString(), onDuty: true, holders: [], mainSha: null, rules: null, front: null, revoke: [], ledger: null,
    decision: 'NO_FRONT', nodes, nodesDropped: 0 });
  const view = trainNodesView(facts, own);
  assert.ok(view, 'stage 10 facts give a nodes view');
  await fs.mkdir(path.join(root, 'state'), { recursive: true });
  await fs.writeFile(path.join(root, 'state', 'status.json'), JSON.stringify({ node: { name: NODE, mode: 'ACTIVE' }, train: { enabled: 'on', last: null, nodes: view } }));
}

test('defect 15894c2a: target on, the other node heard within 24 hours already runs the target Source: PASS', async t => {
  const { base, next, root, run } = await world(t, { trainMode: 'on' });
  await writeNodes(root, { own: base.ciSource, nodes: [peer(NODE, base.ciSource, MIN), peer('turing', next.ciSource, 5 * MIN)] });
  const before = await listing(root);
  const r = await run();
  assert.equal(r.status, 'PRECHECK_PASS', JSON.stringify(r));
  assert.deepEqual([r.fleetSourceReadiness.status, r.fleetSourceReadiness.targetMode, r.fleetSourceReadiness.targetCiSourceManifestSha256, r.fleetSourceReadiness.staleNodesIgnored],
    ['PASS', 'on', next.ciSource, []]);
  assert.ok(!r.warnings.includes('FLEET_SOURCE_UNVERIFIED'));
  assert.deepEqual(await listing(root), before, 'nothing is written');
});

test('defect 15894c2a: target on, the other node heard within 24 hours runs another Source: refused, and it is named to go first', async t => {
  const { base, next, root, run } = await world(t, { trainMode: 'on' });
  // today's field case: this node goes to the next generation while the other one, heard 5 minutes ago, still runs the current Source
  // (this node's own entry, under any letter case, is the one being upgraded and is never compared)
  await writeNodes(root, { own: base.ciSource, nodes: [peer(NODE.toUpperCase(), base.ciSource, MIN), peer('turing', base.ciSource, 5 * MIN)] });
  const r = await run();
  assert.deepEqual([r.status, r.code, r.detail, r.localChecks], ['PRECHECK_REFUSED', 'FLEET_SOURCE_MISMATCH', { upgradeFirst: ['turing'] }, 'PRECHECK_PASS'], JSON.stringify(r));
  assert.equal(r.fleetSourceReadiness.status, 'MISMATCH');
  assert.deepEqual(r.fleetSourceReadiness.mismatchedNodes, [{ node: 'turing', sourceManifestSha256: base.ciSource, lastHeartbeatAt: new Date(T - 5 * MIN).toISOString() }]);
  assert.match(r.advice, /先给 turing 装目标 Source/);
  assert.match(r.advice, new RegExp(next.ciSource.slice(0, 12)));
  assert.equal(r.fleetSourceReadiness.ownerStatusUrl, 'https://kooyumi.pixelgrav.com/bindings/failover');
  // a node on a third Source is just as much a mismatch; one that reports no Source (§41.6 "no record") is not compared
  await writeNodes(root, { own: base.ciSource, nodes: [peer(NODE, base.ciSource, MIN), peer('turing', 'c'.repeat(64), 23 * HOUR), peer('fresh', null, MIN)] });
  const s = await run();
  assert.deepEqual([s.status, s.code, s.detail.upgradeFirst], ['PRECHECK_REFUSED', 'FLEET_SOURCE_MISMATCH', ['turing']]);
});

test('defect 15894c2a: target on, the other node on another Source was not heard for over 24 hours: not compared, PASS with a notice', async t => {
  const { base, root, run } = await world(t, { trainMode: 'on' });
  await writeNodes(root, { own: base.ciSource, nodes: [peer(NODE, base.ciSource, MIN), peer('turing', base.ciSource, 25 * HOUR), peer('never', base.ciSource, null)] });
  const r = await run();
  assert.equal(r.status, 'PRECHECK_PASS', JSON.stringify(r));
  assert.equal(r.fleetSourceReadiness.status, 'PASS');
  assert.deepEqual(r.fleetSourceReadiness.staleNodesIgnored.map(n => n.node), ['turing', 'never']);
  assert.ok(r.warnings.includes('FLEET_STALE_NODES_IGNORED'));
});

test('defect 15894c2a: no list the precheck can trust is never a fleet PASS (a standby has none); the target mode is the package\'s', async t => {
  const { base, next, root, run } = await world(t, { trainMode: 'on' });
  const unverified = async reason => {
    const r = await run();
    assert.deepEqual([r.status, r.localChecks, r.fleetSourceReadiness.status, r.fleetSourceReadiness.reason], ['PRECHECK_PASS_LOCAL_ONLY', 'PRECHECK_PASS', 'UNVERIFIED', reason], JSON.stringify(r));
    assert.ok(r.warnings.includes('FLEET_SOURCE_UNVERIFIED'));
    return r;
  };
  await unverified('NODES_VIEW_ABSENT'); // no status.json at all
  await writeNodes(root, { own: base.ciSource, at: T - 2 * HOUR, nodes: [peer(NODE, base.ciSource, 2 * HOUR), peer('turing', base.ciSource, 2 * HOUR)] });
  await unverified('NODES_VIEW_STALE');
  await writeNodes(root, { own: base.ciSource, nodes: [peer('someone-else', base.ciSource, MIN), peer('turing', next.ciSource, MIN)] });
  assert.deepEqual((await unverified('SELF_NOT_IN_NODES_VIEW')).fleetSourceReadiness.nodes.map(n => n.node), ['someone-else', 'turing']);
  // the target's mode, absent or not one of off | shadow | on, is never "not required"
  for (const trainMode of [null, 'ON']) {
    const w = await world(t, { trainMode });
    const r = await w.run();
    assert.deepEqual([r.status, r.fleetSourceReadiness.reason, r.fleetSourceReadiness.targetMode], ['PRECHECK_PASS_LOCAL_ONLY', 'TARGET_TRAIN_MODE_UNREADABLE', null]);
  }
});

test('defect 15894c2a: a target with the train shadow or off needs no fleet check, so a shadow rollback is never held by it', async t => {
  for (const trainMode of ['shadow', 'off']) {
    const { base, root, run } = await world(t, { trainMode });
    await writeNodes(root, { own: base.ciSource, nodes: [peer(NODE, base.ciSource, MIN), peer('turing', base.ciSource, MIN)] });
    const r = await run();
    assert.deepEqual([r.status, r.fleetSourceReadiness.status, r.fleetSourceReadiness.targetMode], ['PRECHECK_PASS', 'NOT_REQUIRED', trainMode]);
  }
});

test('precheck: a changed frozen module is a channel change, and the changed files are named', async t => {
  const { run } = await world(t, { change: 'src/store.mjs' });
  const r = await run();
  assert.deepEqual([r.status, r.code, r.detail], ['PRECHECK_REFUSED', 'UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL', 'upgrader']);
  assert.deepEqual(r.changedFrozenFiles.map(f => f.path), ['src/store.mjs']);
  assert.notEqual(r.upgrader.installed, r.upgrader.package);
});

test('precheck: a copy that claims the installed hash but is not its bytes is refused before anything of it runs', async t => {
  // a tampered file whose listed sha is not its bytes
  const a = await world(t);
  await fs.appendFile(path.join(a.next.dir, 'upgrader', 'upgrader', 'src', 'plan.mjs'), '\n// swapped\n');
  await assert.rejects(a.run(), { code: 'PRECHECK_UPGRADER_COPY_CHANGED' });
  // a consistently forged canonical.mjs AND its listed sha, still claiming the installed manifest hash: the hash computed here differs
  const b = await world(t, { forge: 'src/canonical.mjs' });
  await assert.rejects(b.run(), { code: 'PRECHECK_UPGRADER_COPY_CHANGED' });
  assert.equal(globalThis.__cluedForgedImport, undefined);
});

test('precheck: identity, compatibility, acceptance and the same package are the upgrader\'s own refusals', async t => {
  const { dir, base, root } = await world(t);
  const cases = [
    ['identity', { nodeIdentitySha256: 'e'.repeat(64) }, DECISION, 'UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL'],
    ['compat', { stateCompat: { schema: 2, readableBySchemas: [2] } }, DECISION, 'UPGRADE_STATE_COMPAT_REFUSED'],
    ['accept', {}, '1d84ddbb-ec1f-49c3-bbd0-953f72d53584', 'UPGRADE_REQUEST_REFUSED'],
  ];
  for (const [tag, options, acceptance, code] of cases) {
    const p = await pkgWithCopy(path.join(dir, tag), 'n2', options);
    const r = await precheck({ root, pkgDir: p.dir, pkgSha: p.sha, acceptance, installedPkgDir: base.dir, clock: () => T });
    assert.deepEqual([tag, r.status, r.code], [tag, 'PRECHECK_REFUSED', code], JSON.stringify(r));
  }
  const same = await precheck({ root, pkgDir: base.dir, pkgSha: base.sha, acceptance: DECISION, installedPkgDir: base.dir, clock: () => T });
  assert.deepEqual([same.status, same.code], ['PRECHECK_REFUSED', 'UPGRADE_SAME_AS_CURRENT']);
  await assert.rejects(precheck({ root, pkgDir: base.dir, pkgSha: 'a'.repeat(64), acceptance: DECISION, installedPkgDir: base.dir, clock: () => T }), { code: 'PRECHECK_PACKAGE_CHANGED' });
});

test('precheck: the frozen Linux upgrade tool, signer and tool manifest must be the installed package\'s and the node\'s', async t => {
  for (const changed of [TOOL, SIGNER, TOOL_MANIFEST]) {
    const { run } = await world(t, { linux: { [changed]: FROZEN_LINUX[changed] + '# changed\n' } });
    const r = await run();
    assert.deepEqual([changed, r.status, r.code, r.detail, r.changedFrozenFiles.map(f => f.path)],
      [changed, 'PRECHECK_REFUSED', 'UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL', 'linux-upgrade-tool', [changed]]);
  }
  const { root, run } = await world(t);
  await writeFacts(root, { upgradeToolSha256: 'a'.repeat(64) });
  const r = await run();
  assert.deepEqual([r.status, r.code, r.detail], ['PRECHECK_REFUSED', 'UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL', 'linux-upgrade-tool']);
  await writeFacts(root, { staged: { opId: '11111111-1111-4111-8111-111111111111', generation: 2 } });
  const s = await run();
  assert.equal(s.status, 'PRECHECK_PASS');
  assert.ok(s.warnings.includes('LINUX_HAS_A_STAGED_GENERATION'));
});

test('precheck: an installed package that is not the installed upgrader\'s is refused', async t => {
  const { next, run } = await world(t);
  await assert.rejects(run({ installedPkgDir: path.join(next.dir, 'nowhere') }), { code: 'ENOENT' });
  const other = await pkgWithCopy(path.join(path.dirname(next.dir), 'other'), 'n9', { change: 'src/inbox.mjs' });
  await assert.rejects(run({ installedPkgDir: other.dir }), { code: 'PRECHECK_INSTALLED_PACKAGE_IS_NOT_THE_CURRENT_GENERATION' });
  // an older package with the same upgrader (and so the same copy) is not the current generation either
  const older = await pkgWithCopy(path.join(path.dirname(next.dir), 'older'), 'n0');
  await assert.rejects(run({ installedPkgDir: older.dir }), { code: 'PRECHECK_INSTALLED_PACKAGE_IS_NOT_THE_CURRENT_GENERATION' });
});

async function listing(root) {
  const out = [];
  async function walk(d) {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p); else out.push([path.relative(root, p), sha256(await fs.readFile(p))]);
    }
  }
  await walk(root);
  return out.sort();
}
