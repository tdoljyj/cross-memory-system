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
import { HEAVY_ROLES } from '../src/policy.mjs';
import { batchKey } from '../src/ledger.mjs';
import { BASE, HEAD, SOURCE, WINDOWS_CLEAN, executorFixture, fakeEngine, triggerBytes, tempRoot, TEST_NODE, TEST_NODE_SHA } from './helpers.mjs';

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
test('E7: a trigger cannot choose the rule: an Agent\'s trigger on a merge base, route github-merge -> no stamp, no baseRule; lean, so no bundle (main moving is stage 8\'s to find)', async t => {
  const engine = fakeEngine();
  const subjects = [];
  const derive = engine.derive;
  engine.derive = async (s, key, chain) => { subjects.push(s); return { ...(await derive(s, key, chain)), pr: s.pr }; };
  let bundles = 0;
  const comp = { calls: [], async heartbeat() { return { at: f.clock() }; }, async buildBundle() { bundles += 1; return { ok: false, code: 'RESIDENT_BASE_MOVED' }; },
    async prepareWorkspaces() { return { ok: true }; }, async linuxQuiescence() { return { linuxUnitsInactive: true, containersZero: true }; },
    async archiveLinux(batch, reason) { return { verified: true, directory: `failed-x-${reason}-111111111111` }; },
    async prHead(pr) { return { number: pr, state: 'open', headSha: H(3) }; } };
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
  // Task f79929d9 (PLAN-native-admission-latency-20261124 section 8.2 item 1): this batch was born on a reading "no scan from this App"
  // and has no S, so it builds no bundle; before, the bundle's RESIDENT_BASE_MOVED ended it here. On this route main moving is found
  // at stage 8 (park.test.mjs), as for every batch that rests at B.
  assert.equal(r.state, 'COMPLETED', JSON.stringify(r));
  assert.equal(bundles, 0);
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

// E9u (B1, FABLE-c3-b1b2 §2): a batch stamped push plans its scans from the stamp (the stamp was given only while stage 10 found no scan
// required from this App), never from what the newest stage 10 read: no summary (a restart), a summary without appScans (a failed read),
// or one naming every scan (the Owner pinned them back). A batch without the stamp plans exactly as before.
test('E9u (B1): localPlan of a batch stamped push runs no scan whatever stage 10 read last; a batch without the stamp plans as before', async () => {
  const plan = async (subject, trainLast) => {
    const receipts = [];
    const self = { trainLast, clock: () => NOW, frontScansReused: () => [], ledger: { async writePlanIntent() {}, async writePlan() {} },
      async receipt(type, body) { receipts.push([type, body]); } };
    const p = await ResidentExecutor.prototype.localPlan.call(self, 'a'.repeat(64), subject, NOW);
    return { local: p.local.map(l => l.role), receipts: receipts.map(([type]) => type) };
  };
  const sh = { pr: 50, headSha: H(1), baseSha: B };
  const front = { ...sh, testSha: H(2) };
  const lasts = [['no summary (a restart)', null], ['a summary without appScans (a failed read)', Object.freeze({ landing: { route: 'park' } })],
    ['every scan from this App', Object.freeze({ landing: { route: 'push' }, appScans: [...HEAVY_ROLES] })], ['gitleaks from this App', Object.freeze({ landing: { route: 'push' }, appScans: ['gitleaks'] })]];
  for (const [why, last] of lasts) {
    for (const s of [sh, front]) {
      const stamped = await plan({ ...s, batchRoute: 'push' }, last);
      assert.deepEqual(stamped.local, [], `stamped ${s.testSha ? 'front' : 'S = H'}: ${why}`);
      assert.ok(stamped.receipts.includes('scans-not-app-required'), why);
    }
    // without the stamp: as on origin/main (not read: every scan; read: the scans still required from this App)
    const expected = last?.appScans ? HEAVY_ROLES.filter(r => last.appScans.includes(r)) : [...HEAVY_ROLES];
    assert.deepEqual((await plan(sh, last)).local, expected, `no stamp: ${why}`);
    assert.deepEqual((await plan(front, last)).local, expected, `no stamp, front: ${why}`);
  }
  assert.deepEqual((await plan(sh, Object.freeze({ landing: { route: 'push' }, appScans: [] }))).local, [], 'no stamp, nothing required: as before');
});

// E12 (B2, FABLE-c3-b1b2 §3): restampStopped gives the stamp to exactly the rows that stopped with zero side effects on a moved base before
// the push route could stamp them: STOPPED for RESIDENT_BASE_MOVED, stopped as superseded (the bundle's ignored ending, executor#fail, or
// stopBase; a head that started ends on the failure table's class, queue or unknown), S = H, not stamped. Each goes to the tail QUEUED,
// stamped push, its stop cleared. Never a stamped row (no loop: at most once per head), a front row, a started head, a running row or
// another stop; never past the queue's depth (a later call takes it once there is room).
test('E12 queue restampStopped: only an unstamped S = H row stopped as superseded on a moved base; once; within the depth', async t => {
  const RBM = 'RESIDENT_BASE_MOVED', key = n => String(n).repeat(64).slice(0, 64);
  const q = await RunQueue.open(path.join(await tempRoot(t), 'q'), () => NOW);
  const ran = (pr, outcome, stamp = null) => {
    q.offer({ pr, headSha: H(pr), baseSha: B }, NOW, { ...opts, batchRoute: stamp });
    q.begin(pr, H(pr), key(pr), 'queued', NOW);
    q.settle(pr, H(pr), outcome, NOW);
  };
  // restamped: its own bundle stopped it (executor.mjs#fail: ignored, superseded), and one stopBase stopped with it
  ran(1, { kind: 'ignored', code: RBM, klass: 'superseded' });
  q.offer({ pr: 2, headSha: H(2), baseSha: B }, NOW, opts);
  // ③ a front row stopBase stopped
  q.offerFront({ pr: 3, headSha: H(3), baseSha: B, testSha: H(4), attempt: 1 }, NOW, { depth: 20 });
  assert.equal(q.stopBase(B, RBM, NOW), 2);
  // ② a stamped row that stopped on RESIDENT_BASE_MOVED all the same (its bundle found the base off main)
  ran(5, { kind: 'ignored', code: RBM, klass: 'superseded' }, 'push');
  // ④ a head that started: stage 8's RESIDENT_BASE_MOVED burns it on the failure table's class (queue), or unknown
  ran(6, { kind: 'burned', code: RBM, klass: 'queue' });
  ran(7, { kind: 'burned', code: RBM, klass: 'unknown' });
  // other stops: a superseded release cap, another code
  ran(8, { kind: 'ignored', code: 'TRAIN_BATCH_MEMBER_MOVED', klass: 'superseded' });
  q.offer({ pr: 9, headSha: H(9).replace(/^9/, 'c'), baseSha: B }, NOW, opts);
  q.stopAtCap(9, H(9).replace(/^9/, 'c'), RBM, NOW, 'superseded');
  const before = JSON.stringify(q.data.rows.filter(r => ![1, 2].includes(r.pr)));
  const maxOrder = Math.max(...q.data.rows.map(r => r.order));
  assert.deepEqual([1, 2, 3, 5, 6, 7, 8].map(n => q.row(n).state), Array(7).fill('STOPPED'));
  const out = q.restampStopped(RBM, NOW + 5, { depth: 20 });
  assert.deepEqual(out.map(x => [x.pr, x.headSha, x.baseSha]), [[1, H(1), B], [2, H(2), B]]);
  for (const n of [1, 2]) {
    const r = q.row(n);
    assert.deepEqual([r.state, r.reason, r.stopKind, r.stopClass, r.current.batchRoute, r.current.headSha, r.current.baseSha, r.running],
      ['QUEUED', null, null, null, 'push', H(n), B, null], String(n));
    assert.ok(r.order > maxOrder, 'to the tail');
  }
  assert.equal(JSON.stringify(q.data.rows.filter(r => ![1, 2].includes(r.pr))), before, 'no other row changed');
  validateQueue(structuredClone(q.data));
  // once: a restamped row that stops again on RESIDENT_BASE_MOVED is not given back
  q.begin(1, H(1), key(1), 'queued', NOW + 6);
  q.settle(1, H(1), { kind: 'ignored', code: RBM, klass: 'superseded' }, NOW + 6);
  assert.deepEqual(q.restampStopped(RBM, NOW + 7, { depth: 20 }), []);
  assert.equal(q.row(1).state, 'STOPPED');
  // ⑤ the queue full: none this time; once there is room, the next call takes it
  const full = await RunQueue.open(path.join(await tempRoot(t), 'full'), () => NOW);
  full.offer({ pr: 11, headSha: H(1), baseSha: B }, NOW, opts);
  full.stopBase(B, RBM, NOW);
  full.offer({ pr: 12, headSha: H(2), baseSha: H(3) }, NOW, opts);
  full.offer({ pr: 13, headSha: H(4), baseSha: H(3) }, NOW, opts);
  assert.deepEqual(full.restampStopped(RBM, NOW + 1, { depth: 2 }), []);
  assert.equal(full.row(11).state, 'STOPPED');
  full.closePr(13, NOW + 2);
  assert.deepEqual(full.restampStopped(RBM, NOW + 3, { depth: 2 }).map(x => x.pr), [11]);
  assert.deepEqual([full.row(11).state, full.row(11).current.batchRoute], ['QUEUED', 'push']);
});

// E12 at the executor: the tick calls it only while batchRoute() is push, after the intake; each restamped row is on disk and receipted once.
test('E12 executor: the tick restamps only while the route is push, saves the queue and writes one batch-route-restamped per row', async t => {
  const f = await executorFixture(t);
  f.queue.offer({ pr: 21, headSha: H(2), baseSha: B }, f.clock(), opts);
  f.queue.stopBase(B, 'RESIDENT_BASE_MOVED', f.clock());
  await f.queue.save();
  const restamped = async () => (await f.receipts.latest(['batch-route-restamped'], 10)).map(x => x.value.body);
  // route not push (the fixture's train is off): nothing
  f.exec.trainLast = Object.freeze({ landing: { route: 'push' }, appScans: [] });
  assert.equal(f.exec.batchRoute(), null);
  await f.exec.restampStopped();
  assert.equal(f.queue.row(21).state, 'STOPPED');
  assert.deepEqual(await restamped(), []);
  f.exec.policy = { ...f.exec.policy, train: { ...f.exec.policy.train, enabled: 'on', landing: 'push' } };
  assert.equal(f.exec.batchRoute(), 'push');
  await f.exec.restampStopped();
  assert.deepEqual([f.queue.row(21).state, f.queue.row(21).current.batchRoute], ['QUEUED', 'push']);
  assert.deepEqual((await restamped()).map(x => [x.pr, x.headSha, x.baseSha]), [[21, H(2), B]]);
  const disk = await RunQueue.open(path.join(f.root, 'state', 'queue'), f.clock);
  assert.equal(disk.row(21).current.batchRoute, 'push', 'on disk');
  await f.exec.restampStopped();
  assert.equal((await restamped()).length, 1, 'once');
});

// Board 266 (FABLE-backlog-batch-design-20261124 §3): under the push route the poller's trigger carries each PR's merge base
// (poller.mjs batchBase), not main's tip, so another PR's base is no sign that main moved; and main moving sends no trigger at all
// (deduplicated by PR:head:batchBase). There "main moved" is stage 10's own reading (hintParkedHead); the trigger keeps only the
// PR-edited and parkEvent nudges. Under github-merge (batchBase = main's tip) the moved nudge is unchanged (the guard, green before too).
test('266: under the push route the merge bases of other PRs nudge no parked batch; under github-merge a new tip still does', async t => {
  const KEY = batchKey({ repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1 });
  const notReady = { ok: false, code: 'RESIDENT_MERGE_QUEUE_NOT_JOINED', proof: WINDOWS_CLEAN, brokerNoLaunch: false,
    outcome: { status: 'BLOCKED', reason: 'RESIDENT_MERGE_QUEUE_NOT_JOINED', sideEffects: 0, mayHavePublished: false, diagnostic: null,
      scheduling: { ciRetryAfter: null, mergeQueue: { entered: false, state: null, position: null } }, safeToRerun: false } };
  const poller = (pr, base) => ({ t: { contract: 'clued.independent-ci.resident-trigger/2', repo: 'tdoljyj/cross-memory-system', pr, headSha: H(pr % 10),
    baseSha: base, prUpdatedAt: '2026-11-22T09:30:00.000Z' }, seen: false });
  for (const route of ['push', null]) {
    const engine = fakeEngine(), run = engine.runStage;
    let parked = false;
    engine.runStage = async (batch, stage, o) => (stage.number === 8 && !parked ? (parked = true, engine.calls.push(['stage', 8]), notReady) : run(batch, stage, o));
    const f = await executorFixture(t, { engine });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'PARKED', String(route));
    if (route === 'push') {
      f.exec.policy = { ...f.exec.policy, train: { ...f.exec.policy.train, enabled: 'on', landing: 'push' } };
      f.exec.trainLast = Object.freeze({ landing: { route: 'push' }, appScans: [] });
    }
    assert.equal(f.exec.batchRoute(), route);
    await f.exec.nudgeParked([poller(901, H(5)), poller(902, H(6)), poller(903, H(7))], f.clock());
    if (route === 'push') {
      assert.equal(f.exec.parkNudges.has(KEY), false, 'push: the parked batch is not brought forward by the merge bases of other PRs');
      assert.equal(f.exec.parkNudgeBase.get(KEY), undefined, 'push: no merge base is taken for a main tip');
    } else {
      assert.equal(f.exec.parkNudges.has(KEY), true, 'github-merge: a new main tip still nudges');
      assert.deepEqual(f.exec.parkNudgeBase.get(KEY), [H(5)]);
    }
  }
});
