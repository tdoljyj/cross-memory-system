// rollout.mjs: the plan's refusals and every row of `next` (DESIGN §42.3.3), for two and three nodes. No host, no network.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson, sha256 } from '../../src/canonical.mjs';
import { STATUS_CONTRACT } from '../../src/status.mjs';
import { GENERATION_CURRENT_CONTRACT, UPGRADE_STATUS_CONTRACT } from '../../src/upgrade-mailbox.mjs';
import { buildTestPackage, tempDir } from '../../upgrader/test/fixtures.mjs';
import { NEXT_CONTRACT, OBSERVATION_CONTRACT, buildRolloutPlan, main, nextStep, observe, validateRolloutPlan } from '../rollout.mjs';

const DECISION = '0d84ddbb-ec1f-49c3-bbd0-953f72d53584';
const NOW = Date.parse('2026-11-01T08:00:00.000Z');
const ago = min => new Date(NOW - min * 60_000).toISOString();
const hex = c => c.repeat(64);

// A plan for the given nodes without package files (nextStep only reads the plan).
function plan(nodes) {
  return validateRolloutPlan({ contract: 'clued.independent-ci.rollout-plan/1', decisionRef: DECISION, createdAt: ago(120), ciSourceManifestSha256: hex('c'), sourceManifestSha256: hex('d'),
    nodes: nodes.map((node, i) => ({ node, packageManifestSha256: hex(String(i + 1)), residentManifestSha256: hex('e'), grantResource: `ci-resident:${node}/${hex(String(i + 1))}` })) });
}
const target = (p, node) => p.nodes.find(n => n.node === node).packageManifestSha256;
function obs(p, node, { mode = 'STANDBY', atTarget = false, halt = null, paused = false, consistent = true, op = null, last = null, observed = 1, written = 1 } = {}) {
  return { contract: OBSERVATION_CONTRACT, observedAt: ago(observed), node, unreadable: [],
    resident: { writtenAt: ago(written), node, mode, halt, paused, consistent },
    generation: { generation: atTarget ? 2 : 1, packageManifestSha256: atTarget ? target(p, node) : hex('0') },
    upgrade: { op, last } };
}

test('next: two nodes, standby first, then handover, then the former holder, then done', () => {
  const p = plan(['desk-w-591', 'turing']);
  let r = nextStep(p, [obs(p, 'turing', { mode: 'ACTIVE' }), obs(p, 'desk-w-591')], NOW);
  assert.equal(r.contract, NEXT_CONTRACT);
  assert.deepEqual([r.action, r.node, r.ciPause, r.grantResource], ['UPGRADE', 'desk-w-591', false, `ci-resident:desk-w-591/${target(p, 'desk-w-591')}`]);
  r = nextStep(p, [obs(p, 'turing', { mode: 'ACTIVE' }), obs(p, 'desk-w-591', { op: { opId: '11111111-1111-4111-8111-111111111111', state: 'WAITING_GRANT', code: null } })], NOW);
  assert.deepEqual([r.action, r.code, r.node, r.state], ['WAIT', 'ROLLOUT_UPGRADE_IN_PROGRESS', 'desk-w-591', 'WAITING_GRANT']);
  r = nextStep(p, [obs(p, 'turing', { mode: 'ACTIVE' }), obs(p, 'desk-w-591', { atTarget: true, last: { opId: '11111111-1111-4111-8111-111111111111', outcome: 'SUCCEEDED', code: null } })], NOW);
  assert.deepEqual([r.action, r.from, r.to], ['HANDOVER', 'turing', 'desk-w-591']);
  // during the 5 minutes before the role takes effect a node may be UNCERTAIN: wait
  r = nextStep(p, [obs(p, 'turing', { mode: 'UNCERTAIN' }), obs(p, 'desk-w-591', { atTarget: true })], NOW);
  assert.deepEqual([r.action, r.code], ['WAIT', 'ROLLOUT_NODE_UNCERTAIN']);
  r = nextStep(p, [obs(p, 'turing'), obs(p, 'desk-w-591', { mode: 'ACTIVE', atTarget: true })], NOW);
  assert.deepEqual([r.action, r.node], ['UPGRADE', 'turing']);
  r = nextStep(p, [obs(p, 'turing', { atTarget: true }), obs(p, 'desk-w-591', { mode: 'ACTIVE', atTarget: true })], NOW);
  assert.equal(r.action, 'DONE');
  assert.equal(r.nodes.length, 2);
});

test('next: three nodes upgrade one at a time, standbys by name, then the handover goes to a healthy upgraded standby', () => {
  const p = plan(['a1', 'b2', 'c3']);
  let r = nextStep(p, [obs(p, 'c3', { mode: 'ACTIVE' }), obs(p, 'b2'), obs(p, 'a1')], NOW);
  assert.deepEqual([r.action, r.node], ['UPGRADE', 'a1']);
  r = nextStep(p, [obs(p, 'c3', { mode: 'ACTIVE' }), obs(p, 'b2'), obs(p, 'a1', { op: { opId: '11111111-1111-4111-8111-111111111111', state: 'RUNNING', code: null } })], NOW);
  assert.equal(r.action, 'WAIT');
  r = nextStep(p, [obs(p, 'c3', { mode: 'ACTIVE' }), obs(p, 'b2'), obs(p, 'a1', { atTarget: true })], NOW);
  assert.deepEqual([r.action, r.node], ['UPGRADE', 'b2']);
  // a1 is upgraded but not consistent: the handover goes to b2
  r = nextStep(p, [obs(p, 'c3', { mode: 'ACTIVE' }), obs(p, 'b2', { atTarget: true }), obs(p, 'a1', { atTarget: true, consistent: null })], NOW);
  assert.deepEqual([r.action, r.from, r.to], ['HANDOVER', 'c3', 'b2']);
  r = nextStep(p, [obs(p, 'c3', { mode: 'ACTIVE' }), obs(p, 'b2', { atTarget: true, paused: true }), obs(p, 'a1', { atTarget: true, consistent: false })], NOW);
  assert.deepEqual([r.action, r.code], ['BLOCKED', 'ROLLOUT_NO_HEALTHY_UPGRADED_STANDBY']);
  // every node on the target but one half not consistent yet
  r = nextStep(p, [obs(p, 'c3', { mode: 'ACTIVE', atTarget: true }), obs(p, 'b2', { atTarget: true }), obs(p, 'a1', { atTarget: true, consistent: null })], NOW);
  assert.deepEqual([r.action, r.code, r.node], ['WAIT', 'ROLLOUT_VERSIONS_NOT_CONSISTENT', 'a1']);
});

test('next: the holder is never upgraded unless the Owner chose to pause CI and no node can take the role', () => {
  const p = plan(['turing']);
  let r = nextStep(p, [obs(p, 'turing', { mode: 'ACTIVE' })], NOW);
  assert.deepEqual([r.action, r.code], ['BLOCKED', 'ROLLOUT_NO_STANDBY']);
  r = nextStep(p, [obs(p, 'turing', { mode: 'ACTIVE' })], NOW, { allowActiveUpgrade: true });
  assert.deepEqual([r.action, r.node, r.ciPause], ['UPGRADE', 'turing', true]);
  // with a standby present the switch changes nothing: the standby goes first
  const q = plan(['desk-w-591', 'turing']);
  r = nextStep(q, [obs(q, 'turing', { mode: 'ACTIVE' }), obs(q, 'desk-w-591')], NOW, { allowActiveUpgrade: true });
  assert.deepEqual([r.action, r.node, r.ciPause], ['UPGRADE', 'desk-w-591', false]);
});

test('next: halts, rollbacks, two holders, paused standbys, stale and missing observations', () => {
  const p = plan(['desk-w-591', 'turing']);
  const base = () => [obs(p, 'turing', { mode: 'ACTIVE' }), obs(p, 'desk-w-591')];
  const with_ = (i, over) => { const o = base(); o[i] = obs(p, o[i].node, { mode: o[i].resident.mode, ...over }); return o; };
  let r = nextStep(p, with_(0, { halt: 'SOME_HALT_CODE' }), NOW);
  assert.deepEqual([r.action, r.code, r.node], ['BLOCKED', 'ROLLOUT_NODE_HALTED', 'turing']);
  r = nextStep(p, with_(1, { last: { opId: '11111111-1111-4111-8111-111111111111', outcome: 'ROLLED_BACK_PAUSED', code: 'UPGRADE_VERIFY_FAILED' }, paused: true }), NOW);
  assert.deepEqual([r.action, r.code, r.upgradeCode], ['BLOCKED', 'ROLLOUT_NODE_ROLLED_BACK', 'UPGRADE_VERIFY_FAILED']);
  // an old rollback on a node that has since reached the target is history, not a stop
  r = nextStep(p, with_(1, { atTarget: true, last: { opId: '11111111-1111-4111-8111-111111111111', outcome: 'ROLLED_BACK_PAUSED', code: null } }), NOW);
  assert.equal(r.action, 'HANDOVER');
  r = nextStep(p, with_(1, { mode: 'ACTIVE' }), NOW);
  assert.deepEqual([r.action, r.code], ['BLOCKED', 'ROLLOUT_TWO_ACTIVE']);
  r = nextStep(p, with_(1, { paused: true }), NOW);
  assert.deepEqual([r.action, r.code], ['BLOCKED', 'ROLLOUT_STANDBY_PAUSED']);
  r = nextStep(p, with_(1, { observed: 16 }), NOW);
  assert.deepEqual([r.action, r.code], ['WAIT', 'ROLLOUT_OBSERVATION_STALE']);
  r = nextStep(p, with_(1, { written: 40, observed: 1 }), NOW);
  assert.deepEqual([r.action, r.code], ['BLOCKED', 'ROLLOUT_RESIDENT_NOT_WRITING_STATUS']);
  r = nextStep(p, [obs(p, 'turing', { mode: 'ACTIVE' })], NOW);
  assert.deepEqual([r.action, r.code, r.node], ['WAIT', 'ROLLOUT_OBSERVATION_MISSING', 'desk-w-591']);
  const extra = [...base(), { ...obs(p, 'desk-w-591'), node: 'other-node', resident: { ...obs(p, 'desk-w-591').resident, node: 'other-node' } }];
  r = nextStep(p, extra, NOW);
  assert.deepEqual([r.action, r.code], ['BLOCKED', 'ROLLOUT_NODE_NOT_IN_PLAN']);
  const incomplete = base(); incomplete[1] = { ...incomplete[1], generation: null, unreadable: ['upgrade/current.json'] };
  r = nextStep(p, incomplete, NOW);
  assert.deepEqual([r.action, r.code], ['WAIT', 'ROLLOUT_OBSERVATION_INCOMPLETE']);
  assert.throws(() => nextStep(p, [...base(), obs(p, 'turing')], NOW), { code: 'ROLLOUT_OBSERVATION_TWICE' });
});

test('next: outcomes of this rollout stop it, older ones do not; ROLLBACK_FAILED always does', () => {
  const p = plan(['desk-w-591', 'turing']);
  const op = '11111111-1111-4111-8111-111111111111';
  const desk = last => [obs(p, 'turing', { mode: 'ACTIVE' }), obs(p, 'desk-w-591', { last })];
  for (const outcome of ['REFUSED', 'GRANT_REJECTED', 'GRANT_EXPIRED', 'STALE', 'CANCELLED']) {
    const r = nextStep(p, desk({ opId: op, outcome, code: 'UPGRADE_X', at: ago(30) }), NOW);
    assert.deepEqual([outcome, r.action, r.code], [outcome, 'BLOCKED', 'ROLLOUT_NODE_UPGRADE_REFUSED']);
  }
  let r = nextStep(p, desk({ opId: op, outcome: 'ROLLED_BACK_PAUSED', code: 'UPGRADE_VERIFY_FAILED', at: ago(30) }), NOW);
  assert.deepEqual([r.action, r.code], ['BLOCKED', 'ROLLOUT_NODE_ROLLED_BACK']);
  // before the plan was made: an earlier rollout's, not a stop for this one (the fixed package gets its own UPGRADE)
  r = nextStep(p, desk({ opId: op, outcome: 'ROLLED_BACK_PAUSED', code: 'UPGRADE_VERIFY_FAILED', at: ago(600) }), NOW);
  assert.deepEqual([r.action, r.node], ['UPGRADE', 'desk-w-591']);
  r = nextStep(p, desk({ opId: op, outcome: 'REFUSED', code: null, at: null }), NOW);   // no readable time: taken as this rollout's
  assert.deepEqual([r.action, r.code], ['BLOCKED', 'ROLLOUT_NODE_UPGRADE_REFUSED']);
  // a failed rollback blocks wherever current.json was left, and however old
  r = nextStep(p, [obs(p, 'turing', { mode: 'ACTIVE' }), obs(p, 'desk-w-591', { atTarget: true, last: { opId: op, outcome: 'ROLLBACK_FAILED', code: null, at: ago(900) } })], NOW);
  assert.deepEqual([r.action, r.code, r.opId], ['BLOCKED', 'ROLLOUT_NODE_ROLLED_BACK', op]);
  // the way past it: the Owner recovered and looked, the coordinator acknowledges that op (and only that op)
  r = nextStep(p, [obs(p, 'turing', { mode: 'ACTIVE' }), obs(p, 'desk-w-591', { atTarget: true, last: { opId: op, outcome: 'ROLLBACK_FAILED', code: null, at: ago(900) } })], NOW, { ackOps: [op] });
  assert.equal(r.action, 'HANDOVER');
  r = nextStep(p, desk({ opId: op, outcome: 'REFUSED', code: null, at: null }), NOW, { ackOps: [op] });
  assert.deepEqual([r.action, r.node], ['UPGRADE', 'desk-w-591']);
  r = nextStep(p, desk({ opId: op, outcome: 'REFUSED', code: null, at: null }), NOW, { ackOps: ['22222222-2222-4222-8222-222222222222'] });
  assert.equal(r.action, 'BLOCKED');
  assert.throws(() => nextStep(p, desk(null), NOW, { ackOps: ['not-a-uuid'] }), { code: 'USAGE' });
});

test('next: two ACTIVE nodes while a handover takes effect are a WAIT, otherwise two holders', () => {
  const p = plan(['desk-w-591', 'turing']);
  const both = [obs(p, 'turing', { mode: 'ACTIVE' }), obs(p, 'desk-w-591', { mode: 'ACTIVE', atTarget: true })];
  assert.deepEqual([nextStep(p, both, NOW, { handoverIssuedAt: ago(3) }).action, nextStep(p, both, NOW, { handoverIssuedAt: ago(3) }).code], ['WAIT', 'ROLLOUT_HANDOVER_PENDING']);
  assert.deepEqual(nextStep(p, both, NOW, { handoverIssuedAt: ago(30) }).code, 'ROLLOUT_TWO_ACTIVE');
  assert.deepEqual(nextStep(p, both, NOW).code, 'ROLLOUT_TWO_ACTIVE');
});

test('next: DONE needs no paused node and the holder among the plan\'s; a pending handover is a WAIT', () => {
  const p = plan(['desk-w-591', 'turing']);
  let r = nextStep(p, [obs(p, 'turing', { atTarget: true }), obs(p, 'desk-w-591', { mode: 'ACTIVE', atTarget: true, paused: true })], NOW);
  assert.deepEqual([r.action, r.code, r.node], ['BLOCKED', 'ROLLOUT_NODE_PAUSED', 'desk-w-591']);
  r = nextStep(p, [obs(p, 'turing', { atTarget: true }), obs(p, 'desk-w-591', { atTarget: true })], NOW);
  assert.deepEqual([r.action, r.code], ['BLOCKED', 'ROLLOUT_NO_ACTIVE_NODE_IN_PLAN']);
  const before = [obs(p, 'turing', { mode: 'ACTIVE' }), obs(p, 'desk-w-591', { atTarget: true })];
  r = nextStep(p, before, NOW, { handoverIssuedAt: ago(4) });
  assert.deepEqual([r.action, r.code], ['WAIT', 'ROLLOUT_HANDOVER_PENDING']);
  r = nextStep(p, before, NOW, { handoverIssuedAt: ago(20) });
  assert.equal(r.action, 'HANDOVER');
});

test('plan and observation shapes: sorted nodes, the observation names its own resident', () => {
  const p = plan(['a1', 'b2']);
  assert.throws(() => validateRolloutPlan({ ...p, nodes: [...p.nodes].reverse() }), { code: 'ROLLOUT_PLAN_REFUSED' });
  assert.throws(() => validateRolloutPlan({ ...p, createdAt: undefined }), { code: 'ROLLOUT_PLAN_REFUSED' });
  const o = obs(p, 'a1');
  assert.throws(() => nextStep(p, [{ ...o, resident: { ...o.resident, node: 'b2' } }, obs(p, 'b2', { mode: 'ACTIVE' })], NOW), { code: 'ROLLOUT_OBSERVATION_REFUSED' });
});

async function nodePackage(t, dir, node, { tag = 'n2', decisionRef = DECISION, sourceTag = 'n2' } = {}) {
  return buildTestPackage(dir, { tag, sourceTag, decisionRef, mutate: (m, files, put) => {
    // the record names its node (what request-upgrade.ps1 and the plan check); re-pin that one file
    put('record/acceptance.json', JSON.stringify({ node: { nodeName: node } }) + '\n');
    m.files.find(f => f.path === 'record/acceptance.json').sha256 = sha256(files.get('record/acceptance.json'));
  } });
}

test('plan: one Source, one acceptance, each package its own node; written create-only and validated', async t => {
  const dir = await tempDir(t, 'clued-rollout-');
  const a = await nodePackage(t, path.join(dir, 'a'), 'desk-w-591');
  const b = await nodePackage(t, path.join(dir, 'b'), 'turing');
  const out = path.join(dir, 'rollout.json');
  const lines = [];
  assert.equal(await main(['plan', '--out', out, '--decision', DECISION, '--package', `turing=${b.dir}`, '--package', `desk-w-591=${a.dir}`], { log: s => lines.push(s) }), 0);
  const bytes = await fs.readFile(out);
  const plan_ = validateRolloutPlan(JSON.parse(bytes.toString('utf8')));
  assert.equal(bytes.toString('utf8'), canonicalJson(plan_) + '\n');
  assert.deepEqual(plan_.nodes.map(n => [n.node, n.packageManifestSha256]), [['desk-w-591', a.sha], ['turing', b.sha]]);
  assert.equal(JSON.parse(lines[0]).rolloutSha256, sha256(bytes));
  await assert.rejects(main(['plan', '--out', out, '--decision', DECISION, '--package', `turing=${b.dir}`], { log: () => {} }), { code: 'EEXIST' });

  const read = async (node, p) => ({ node, manifest: p.manifest, manifestBytes: await fs.readFile(path.join(p.dir, 'package-manifest.json')), bytesOf: x => p.files.get(x) });
  assert.throws(() => buildRolloutPlan({ decisionRef: DECISION, packages: [] }), { code: 'ROLLOUT_PACKAGES_REQUIRED' });
  const ra = await read('desk-w-591', a), rb = await read('turing', b);
  assert.throws(() => buildRolloutPlan({ decisionRef: DECISION, packages: [ra, { ...rb, node: 'desk-w-591' }] }), { code: 'ROLLOUT_NODE_TWICE_OR_INVALID' });
  assert.throws(() => buildRolloutPlan({ decisionRef: DECISION, packages: [{ ...ra, node: 'turing' }] }), { code: 'ROLLOUT_PACKAGE_IS_FOR_ANOTHER_NODE' });
  assert.throws(() => buildRolloutPlan({ decisionRef: '1d84ddbb-ec1f-49c3-bbd0-953f72d53584', packages: [ra] }), { code: 'ROLLOUT_PACKAGE_NOT_THIS_ACCEPTANCE' });
  const other = await read('turing', await nodePackage(t, path.join(dir, 'c'), 'turing', { sourceTag: 'n3' }));
  assert.throws(() => buildRolloutPlan({ decisionRef: DECISION, packages: [ra, other] }), { code: 'ROLLOUT_NODES_DO_NOT_SHARE_ONE_SOURCE' });
});

test('observe: reads the three files, read-only; missing and malformed files are listed, never guessed', async t => {
  const root = await tempDir(t, 'clued-rollout-root-');
  const clock = () => NOW;
  let o = await observe(root, clock);
  assert.equal(o.node, null);
  assert.deepEqual(o.unreadable, ['state/status.json', 'upgrade/current.json']);
  assert.deepEqual(o.upgrade, { op: null, last: null });
  await fs.mkdir(path.join(root, 'state'), { recursive: true });
  await fs.mkdir(path.join(root, 'upgrade'), { recursive: true });
  const status = { contract: STATUS_CONTRACT, writtenAt: ago(1), changedAt: ago(5), pid: 1, executor: { state: 'IDLE', since: ago(5), reason: null }, halt: null, paused: false,
    intakePause: null, node: { name: 'turing', source: null, mode: 'ACTIVE', probe: null }, backfill: { complete: true, published: null, unreadable: null }, current: null, pending: [],
    recent: [], limits: null, queue: null, breaker: null, notices: [], train: { enabled: 'off', last: null }, versions: null, timing: null };
  await fs.writeFile(path.join(root, 'state', 'status.json'), JSON.stringify(status));
  await fs.writeFile(path.join(root, 'upgrade', 'current.json'), JSON.stringify({ contract: GENERATION_CURRENT_CONTRACT, generation: 2, packageManifestSha256: hex('1'),
    residentManifestSha256: hex('2'), ciSourceManifestSha256: hex('3'), policySha256: hex('4'), installReceiptSha256: hex('5'), stateCompat: { schema: 1, readableBySchemas: [1] },
    linux: { generation: 2, manifestSha256: hex('6'), ciSourceManifestSha256: hex('3') }, opId: null, at: ago(60) }));
  await fs.writeFile(path.join(root, 'upgrade', 'status.json'), JSON.stringify({ contract: UPGRADE_STATUS_CONTRACT, writtenAt: ago(1), upgraderPid: 2, current: null, op: null,
    recent: [{ opId: '11111111-1111-4111-8111-111111111111', outcome: 'SUCCEEDED', code: null, generation: 2, at: ago(30) }], generations: [] }));
  o = await observe(root, clock);
  assert.deepEqual([o.node, o.resident.mode, o.resident.consistent, o.generation.generation, o.upgrade.last.outcome, o.unreadable], ['turing', 'ACTIVE', null, 2, 'SUCCEEDED', []]);
  await fs.writeFile(path.join(root, 'upgrade', 'current.json'), '{"half":');
  o = await observe(root, clock);
  assert.deepEqual([o.generation, o.unreadable], [null, ['upgrade/current.json']]);
});
