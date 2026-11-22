// bc982192 (C3 rework, plan 戊; FABLE-c3-batch-rule-channel-20261122 §3): the batch route is one fact, stamped on the queue row when
// the batch is born and read from the row (the subject, the batch) by everything after it. 'push' exactly when the train is on, stage
// 10's own reading of the effective landing route is push and that reading found no scan required from this App (R3 lean: appScans
// []); otherwise none, which is main's tip as the batch base, as on origin/main. Neither the installed train.landing nor a trigger can
// set it.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { RunQueue, validateQueue } from '../src/queue.mjs';
import { ResidentExecutor } from '../src/executor.mjs';
import { StatusBoard, parseStatus, pollerLandingOf } from '../src/status.mjs';
import { WindowsEngine } from '../src/engine-windows.mjs';
import { executorFixture, fakeEngine, triggerBytes, tempRoot, TEST_NODE, TEST_NODE_SHA } from './helpers.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const B = H(9), NOW = Date.parse('2026-11-22T09:00:00Z');
const opts = { depth: 20, cooldownMs: 60_000 };

// The executor's reading, over a policy's train.enabled and stage 10's summary as the executor keeps it (train.mjs#trainSummary).
const routeOf = (enabled, last) => ResidentExecutor.prototype.batchRoute.call({ policy: { train: { enabled, landing: 'push' } }, trainLast: last });

test('batchRoute(): push only with the train on, stage 10 read the route push and no scan is required from this App', () => {
  const last = (route, appScans) => Object.freeze({ ...(route === undefined ? {} : { landing: { route } }), ...(appScans === undefined ? {} : { appScans }) });
  assert.equal(routeOf('on', last('push', [])), 'push');
  // the installed landing is push in every case below; only stage 10's reading and the scans decide
  for (const [enabled, l, why] of [
    ['on', last('github-merge', []), 'route github-merge'], ['on', last('park', []), 'route park'], ['on', last(undefined, []), 'no route read'],
    ['on', null, 'no stage 10 yet (a restart)'], ['on', undefined, 'no summary'],
    ['on', last('push', ['gitleaks', 'trivy', 'contract-placement']), 'every scan from this App'], ['on', last('push', ['gitleaks']), 'gitleaks still from this App'],
    ['on', last('push', undefined), 'appScans not read'], ['shadow', last('push', []), 'train shadow'], ['off', last('push', []), 'train off'],
  ]) assert.equal(routeOf(enabled, l), null, why);
});

test('the status board: train.batchRoute is written only while batchRoute() is push, read back only as push, and is what the poller proposes by', async t => {
  const f = await executorFixture(t);
  const status = () => {
    const board = new StatusBoard({ clock: () => NOW });
    board.update({ train: f.exec.trainStatus() });
    return parseStatus(Buffer.from(JSON.stringify(board.snapshot())));
  };
  // train off (the fixture policy): none
  f.exec.trainLast = Object.freeze({ landing: { route: 'push' }, appScans: [] });
  assert.equal(Object.hasOwn(f.exec.trainStatus(), 'batchRoute'), false);
  assert.equal(pollerLandingOf(status()), 'github-merge');
  f.exec.policy = { ...f.exec.policy, train: { ...f.exec.policy.train, enabled: 'on', landing: 'push' } };
  assert.equal(f.exec.trainStatus().batchRoute, 'push');
  assert.equal(status().train.batchRoute, 'push');
  assert.equal(pollerLandingOf(status()), 'push');
  for (const last of [{ landing: { route: 'github-merge' }, appScans: [] }, { landing: { route: 'push' }, appScans: ['gitleaks'] }, { landing: { route: 'push' } }, null]) {
    f.exec.trainLast = last && Object.freeze(last);
    assert.equal(Object.hasOwn(f.exec.trainStatus(), 'batchRoute'), false, JSON.stringify(last));
    assert.equal(pollerLandingOf(status()), 'github-merge', JSON.stringify(last));
  }
  // the reader: only the exact value; a status it cannot read is github-merge
  for (const v of ['PUSH', 'github-merge', true, 1]) assert.equal(Object.hasOwn(parseStatus(Buffer.from(JSON.stringify({ ...JSON.parse(JSON.stringify(new StatusBoard({ clock: () => NOW }).snapshot())), train: { enabled: 'on', batchRoute: v } }))).train, 'batchRoute'), false, String(v));
  for (const s of [null, undefined, {}, { train: null }, { train: { enabled: 'on', landing: 'push' } }]) assert.equal(pollerLandingOf(s), 'github-merge', JSON.stringify(s));
});

test('queue: the stamp is written once when a commit becomes current (offer, offerFront, readmit), kept, carried to running and the candidate, and validated', async t => {
  const root = await tempRoot(t);
  const q = await RunQueue.open(path.join(root, 'q'), () => NOW);
  assert.equal(q.offer({ pr: 1, headSha: H(1), baseSha: B }, NOW, { ...opts, batchRoute: 'push' }).action, 'new');
  assert.equal(q.offer({ pr: 2, headSha: H(2), baseSha: B }, NOW, opts).action, 'new');
  assert.equal(q.offer({ pr: 3, headSha: H(3), baseSha: B }, NOW, { ...opts, batchRoute: 'github-merge' }).action, 'new', 'only push is ever stored');
  assert.deepEqual([1, 2, 3].map(n => q.row(n).current.batchRoute ?? null), ['push', null, null]);
  // the same head asked again with another route changes nothing: the stamp is the birth's
  q.offer({ pr: 1, headSha: H(1), baseSha: B }, NOW + 1, opts);
  q.offer({ pr: 2, headSha: H(2), baseSha: B }, NOW + 1, { ...opts, batchRoute: 'push' });
  assert.deepEqual([1, 2].map(n => q.row(n).current.batchRoute ?? null), ['push', null]);
  // a new commit of the PR is born with the route of now
  q.offer({ pr: 2, headSha: H(4), baseSha: B }, NOW + 2, { ...opts, batchRoute: 'push' });
  assert.equal(q.row(2).current.batchRoute, 'push');
  assert.equal(q.row(2).superseded[0].batchRoute, undefined, 'the superseded commit keeps its own (none)');
  // a front commit (stage 10's facts)
  assert.equal(q.offerFront({ pr: 5, headSha: H(5), baseSha: B, testSha: H(6), attempt: 1 }, NOW, { depth: 20, batchRoute: 'push' }).action, 'front');
  assert.equal(q.offerFront({ pr: 7, headSha: H(7), baseSha: B, testSha: H(8), attempt: 1 }, NOW, { depth: 20 }).action, 'front');
  assert.deepEqual([q.row(5).current.batchRoute, q.row(7).current.batchRoute ?? null], ['push', null]);
  const c = q.candidates(NOW + 10);
  assert.deepEqual(c.map(x => [x.pr, x.batchRoute ?? null]).sort((a, b) => a[0] - b[0]), [[1, 'push'], [2, 'push'], [3, null], [5, 'push'], [7, null]]);
  q.begin(1, H(1), 'a'.repeat(64), 'queued', NOW + 10);
  assert.equal(q.row(1).running.batchRoute, 'push');
  await q.save();
  const again = await RunQueue.open(path.join(root, 'q'), () => NOW);
  assert.deepEqual([1, 2, 5].map(n => again.row(n).current.batchRoute), ['push', 'push', 'push'], 'persisted');
  // readmission of a proven flow ending: the subject's own stamp from its birth
  const r = await RunQueue.open(path.join(root, 'r'), () => NOW);
  assert.equal(r.readmit({ pr: 9, headSha: H(9).replace(/^9/, 'a'), baseSha: B, batchRoute: 'push' }, NOW, opts), true);
  assert.equal(r.readmit({ pr: 10, headSha: H(1).replace(/^1/, 'b'), baseSha: B }, NOW, opts), true);
  assert.deepEqual([r.row(9).current.batchRoute, r.row(10).current.batchRoute ?? null], ['push', null]);
  // the stored shape takes push or nothing
  const data = structuredClone(again.data);
  validateQueue(data);
  for (const bad of ['github-merge', 'PUSH', null, true]) {
    const d = structuredClone(data);
    d.rows.find(x => x.pr === 2).current.batchRoute = bad;
    assert.throws(() => validateQueue(d), /QUEUE_FILE_INVALID/, String(bad));
  }
});

test('queue stopBase (L1): on the old base, a front row and every row without the stamp stop; a row stamped push that tests its head does not', async t => {
  const q = await RunQueue.open(path.join(await tempRoot(t), 'q'), () => NOW);
  q.offer({ pr: 1, headSha: H(1), baseSha: B }, NOW, { ...opts, batchRoute: 'push' });
  q.offer({ pr: 2, headSha: H(2), baseSha: B }, NOW, opts);
  q.offerFront({ pr: 3, headSha: H(3), baseSha: B, testSha: H(4), attempt: 1 }, NOW, { depth: 20, batchRoute: 'push' });
  q.offerFront({ pr: 5, headSha: H(5), baseSha: B, testSha: H(6), attempt: 1 }, NOW, { depth: 20 });
  q.offer({ pr: 7, headSha: H(7), baseSha: H(8) }, NOW, opts);
  assert.equal(q.stopBase(B, 'RESIDENT_BASE_MOVED', NOW + 1), 3);
  assert.deepEqual([1, 2, 3, 5, 7].map(n => [n, q.row(n).state, q.row(n).stopClass ?? null]),
    [[1, 'QUEUED', null], [2, 'STOPPED', 'superseded'], [3, 'STOPPED', 'superseded'], [5, 'STOPPED', 'superseded'], [7, 'QUEUED', null]]);
});

// E7 (the stamp cannot be forged): with the effective route github-merge, an Agent's trigger (no prUpdatedAt) that names the merge base
// of its head and main gets no stamp, and its batch is described with main's tip as its base: the bundle refuses it as on origin/main.
test('E7: a trigger cannot choose the rule: an Agent\'s trigger on a merge base, route github-merge -> no stamp, no baseRule, the bundle\'s RESIDENT_BASE_MOVED', async t => {
  const engine = fakeEngine();
  const subjects = [];
  const derive = engine.derive;
  engine.derive = async (s, key, chain) => { subjects.push(s); return { ...(await derive(s, key, chain)), pr: s.pr }; };
  const comp = { calls: [], async heartbeat() { return { at: f.clock() }; }, async buildBundle() { return { ok: false, code: 'RESIDENT_BASE_MOVED' }; },
    async prepareWorkspaces() { return { ok: true }; }, async linuxQuiescence() { return { linuxUnitsInactive: true, containersZero: true }; },
    async archiveLinux(batch, reason) { return { verified: true, directory: `failed-x-${reason}-111111111111` }; }, async prHead() { return null; } };
  const f = await executorFixture(t, { engine, companion: comp });
  const installed = f.exec.policy;
  f.exec.policy = { ...installed, train: { ...installed.train, enabled: 'on', landing: 'push' } };
  f.exec.trainLast = Object.freeze({ landing: { route: 'github-merge' }, appScans: [] });
  assert.equal(f.exec.batchRoute(), null);
  await f.drop(triggerBytes({ pr: 31, headSha: H(3), baseSha: H(4) }));
  await f.exec.intake();
  assert.equal(Object.hasOwn(f.queue.row(31).current, 'batchRoute'), false);
  f.exec.policy = installed; // the run itself: the train's maintenance is not this test's (stage 10 has nothing to run here)
  // the descriptor the real engine writes for this subject: no baseRule
  const root = await tempRoot(t);
  const sourceRoot = path.join(root, 'source');
  const V2 = ['work', 'actions-hosted-migration', 'independent-ci-v1', 'src', 'resident-v2'];
  await fs.mkdir(path.join(sourceRoot, ...V2), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, ...V2, 'derive-batch.mjs'), '// fixture');
  const rows = [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ number: n, jobId: String(n).repeat(64).slice(0, 64), workManifestSha256: 'f'.repeat(64), directory: `stage-0${n}`, linuxWorker: [2, 4, 6].includes(n) }));
  const run = async argv => {
    const at = k => argv[argv.indexOf(k) + 1], s = JSON.parse(at('--subject-json'));
    return { code: 0, stdout: JSON.stringify({ status: 'RESIDENT_BATCH_DERIVED', batchKey: at('--batch-key'), batchId: at('--batch-id'), packageSha256: 'c'.repeat(64),
      ciSourceManifestSha256: 'e'.repeat(64), sourceCommit: 'd'.repeat(40), gitleaksTomlSha256: '9'.repeat(64), testSha: s.testSha ?? s.headSha, stages: rows }) };
  };
  const real = new WindowsEngine({ node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, run, busy: () => false, sleep: async () => {}, clock: () => NOW,
    trainMode: 'on', trainLanding: { landing: 'push', batchMax: 1 },
    paths: { sourceRoot, workRoot: path.join(root, 'work'), outboxRoot: path.join(root, 'outbox'), nodeExe: 'node.exe', powershellExe: 'powershell.exe', scExe: 'sc.exe' } });
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['NOT_EXECUTED', 'RESIDENT_BASE_MOVED'], JSON.stringify(r));
  assert.equal(subjects.length, 1);
  assert.equal(Object.hasOwn(subjects[0], 'batchRoute'), false);
  const batch = await real.derive(subjects[0], 'a'.repeat(64));
  const d = JSON.parse(await fs.readFile(path.join(root, 'outbox', batch.batchId, 'descriptor.json'), 'utf8'));
  assert.equal(Object.hasOwn(d, 'baseRule'), false, 'installed push, route github-merge: main must be the base');
  assert.equal(Object.hasOwn(batch, 'batchRoute'), false);
  for (const n of [1, 8]) assert.equal((await real.stageArgs(n, batch)).includes('--batch-route'), false);
});

test('engine: the descriptor\'s baseRule and the invoker\'s --batch-route come from the subject\'s stamp only (S = H for baseRule; stages 1 and 8 for the argument)', async t => {
  const root = await tempRoot(t);
  const sourceRoot = path.join(root, 'source');
  const V2 = ['work', 'actions-hosted-migration', 'independent-ci-v1', 'src', 'resident-v2'];
  await fs.mkdir(path.join(sourceRoot, ...V2), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, ...V2, 'derive-batch.mjs'), '// fixture');
  const rows = [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ number: n, jobId: String(n).repeat(64).slice(0, 64), workManifestSha256: 'f'.repeat(64), directory: `stage-0${n}`, linuxWorker: [2, 4, 6].includes(n) }));
  const run = async argv => {
    const at = k => argv[argv.indexOf(k) + 1], s = JSON.parse(at('--subject-json'));
    assert.equal(Object.hasOwn(s, 'batchRoute'), false, 'the derivation never sees the stamp: the job contract is unchanged');
    return { code: 0, stdout: JSON.stringify({ status: 'RESIDENT_BATCH_DERIVED', batchKey: at('--batch-key'), batchId: at('--batch-id'), packageSha256: 'c'.repeat(64),
      ciSourceManifestSha256: 'e'.repeat(64), sourceCommit: 'd'.repeat(40), gitleaksTomlSha256: '9'.repeat(64), testSha: s.testSha ?? s.headSha, stages: rows }) };
  };
  const engineWith = o => new WindowsEngine({ node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, run, busy: () => false, sleep: async () => {}, clock: () => NOW, ...o,
    paths: { sourceRoot, workRoot: path.join(root, 'work'), outboxRoot: path.join(root, 'outbox'), nodeExe: 'node.exe', powershellExe: 'powershell.exe', scExe: 'sc.exe' } });
  let n = 0;
  const describe = async (engine, subject) => {
    const batch = await engine.derive(subject, String(++n).padStart(64, 'a'));
    return { batch, d: JSON.parse(await fs.readFile(path.join(root, 'outbox', batch.batchId, 'descriptor.json'), 'utf8')) };
  };
  const sh = { repo: 'tdoljyj/cross-memory-system', pr: 40, headSha: H(1), baseSha: H(2), sourceManifestSha256: 'b'.repeat(64), attempt: 1 };
  // whatever is installed, only the stamp decides
  for (const o of [{}, { trainMode: 'on', trainLanding: { landing: 'push', batchMax: 1 } }, { trainMode: 'off', trainLanding: { landing: 'github-merge', batchMax: 1 } }]) {
    const engine = engineWith(o);
    const stamped = await describe(engine, { ...sh, batchRoute: 'push' });
    assert.equal(stamped.d.baseRule, 'on-main', JSON.stringify(o));
    assert.equal(stamped.batch.batchRoute, 'push');
    const plain = await describe(engine, sh);
    assert.equal(Object.hasOwn(plain.d, 'baseRule'), false, JSON.stringify(o));
    const front = await describe(engine, { ...sh, testSha: H(3), batchRoute: 'push' });
    assert.equal(Object.hasOwn(front.d, 'baseRule'), false, 'a front batch runs on main\'s tip');
    assert.equal(front.batch.batchRoute, 'push', 'its stages 1 and 8 still learn the route');
    for (const s of [1, 8]) {
      const a = await engine.stageArgs(s, stamped.batch);
      assert.deepEqual(a.slice(a.indexOf('--batch-route'), a.indexOf('--batch-route') + 2), ['--batch-route', 'push'], `stage ${s}`);
      assert.equal((await engine.stageArgs(s, plain.batch)).includes('--batch-route'), false);
      assert.equal((await engine.stageArgs(s)).includes('--batch-route'), false);
    }
    for (const s of [2, 3, 4, 5, 6, 7]) assert.equal((await engine.stageArgs(s, stamped.batch)).includes('--batch-route'), false, `stage ${s}`);
  }
});
