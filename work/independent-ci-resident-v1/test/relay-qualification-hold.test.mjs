// Offline fixtures only. Guards are never deleted/released by product code.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../src/canonical.mjs';
import { Ledger, batchKey, headKey } from '../src/ledger.mjs';
import { ResidentExecutor, PAUSE_CONTRACT } from '../src/executor.mjs';
import { RelayQualificationHolds, qualificationHeadKey, qualificationWindowSnapshot, RELAY_QUALIFICATION_HELD } from '../src/relay-qualification-hold.mjs';
import { resumeRequest, writeOwnerRequest } from '../tools/rearm-tool.mjs';
import { BASE, HEAD, SOURCE, CI_SOURCE, TEST_NODE_SHA, executorFixture, fakeEngine, fakeCompanion, hintFor, rawPolicy, tempRoot, triggerBytes } from './helpers.mjs';

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const subject = (extra = {}) => ({ repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE,
  sourceManifestSha256: SOURCE, attempt: 1, ...extra });
function window(extra = {}) {
  return { contract: 'clued.independent-ci.relay-qualification-window/1', qualificationRef: 'receipt:' + randomUUID(),
    sourceManifestSha256: CI_SOURCE, ownerReceiptRef: randomUUID(), authorityDecisionId: 'c32676f4-4528-408c-b5e6-88cb27fca13a',
    authorityDecisionSha256: 'a'.repeat(64), authorityReadReceiptRef: randomUUID(), subject: {
      repo: subject().repo, runId: 'a'.repeat(16) + '-' + 'b'.repeat(12), pr: 884, headSha: HEAD, baseSha: BASE, testSha: HEAD,
      sourceManifestSha256: CI_SOURCE, nodeProfileSha256: TEST_NODE_SHA, claimId: randomUUID(), fence: 9, executionEpoch: 2,
      stage1JobId: 'c'.repeat(64) }, validUntil: new Date(NOW + 3_600_000).toISOString(), allowedPhases: ['initial', 'after-ref-move'],
    executionPolicy: 'staged', guarded: false, changedPaths: ['src/fixture.mjs'], changedPathsSha256: digest(['src/fixture.mjs']), ...extra };
}
const stages = engine => engine.calls.filter(c => c[0] === 'stage').map(c => c[1]);
async function heldFixture(t, options = {}) {
  const engine = fakeEngine(options.engineScript), q = window(options.window);
  let current = q;
  engine.relayQualificationWindow = async () => current;
  const f = await executorFixture(t, { engine, policy: options.policy ?? rawPolicy() });
  await f.drop(triggerBytes());
  const first = await f.exec.tick();
  return { ...f, first, q, setWindow: value => { current = value; } };
}

test('guard key ignores Source/claim/PR/base but isolates the actual repository/head', () => {
  const key = qualificationHeadKey(subject());
  assert.equal(qualificationHeadKey(subject({ repo: subject().repo.toUpperCase(), pr: 885, baseSha: '3'.repeat(40),
    sourceManifestSha256: '4'.repeat(64), claimId: randomUUID() })), key);
  assert.notEqual(qualificationHeadKey(subject({ headSha: '3'.repeat(40) })), key);
});

test('guard directory is create-only; partial/corrupt records hold while another head remains free', async t => {
  const root = await tempRoot(t), book = new RelayQualificationHolds(root, () => NOW), q = window(), s = subject();
  const key = batchKey(s);
  assert.equal((await book.inspect(s)).held, false);
  assert.equal((await book.arm(q, s, { key })).created, true);
  const before = await fs.readFile(path.join(book.directory(s), '00-window.json'));
  assert.equal((await book.arm(window(), s, { key })).created, false);
  assert.deepEqual(await fs.readFile(path.join(book.directory(s), '00-window.json')), before);
  const other = subject({ headSha: '3'.repeat(40) });
  await fs.mkdir(book.directory(other)); // a new simulated torn guard, not old host data
  assert.equal((await book.inspect(other)).held, true);
  await fs.writeFile(path.join(book.directory(other), '00-window.json'), '{', { flag: 'wx' });
  assert.equal((await book.inspect(other)).unconfirmed, true);
  assert.equal((await book.inspect(subject({ headSha: '4'.repeat(40) }))).held, false);
});

test('window snapshot rejects caller booleans, extra fields and getters without evaluating them', () => {
  assert.throws(() => qualificationWindowSnapshot(true));
  assert.throws(() => qualificationWindowSnapshot({ ...window(), liveQualified: true }));
  let reads = 0; const q = window();
  Object.defineProperty(q.subject, 'claimId', { enumerable: true, get() { reads++; throw Error('secret'); } });
  assert.throws(() => qualificationWindowSnapshot(q));
  assert.equal(reads, 0);
});

test('valid exact window permits normal Stage1 once, then parks before relay and all local work', async t => {
  const f = await heldFixture(t);
  assert.equal(f.first.state, 'WAITING');
  assert.equal(f.first.reason, RELAY_QUALIFICATION_HELD);
  assert.deepEqual(stages(f.engine), [1]);
  assert.ok(!f.companion.calls.some(c => c[0] === 'wsprep'));
  const entry = await f.ledger.state(f.first.key);
  assert.equal(entry.state, 'STARTED');
  assert.ok(Ledger.waitingAt(entry));
  assert.equal(entry.planIntent, null);
  const dir = f.exec.qualificationHolds.directory(subject());
  const saved = JSON.parse(await fs.readFile(path.join(dir, '00-window.json'), 'utf8'));
  assert.deepEqual(saved.window.subject, f.q.subject);
  assert.equal(saved.windowSha256, digest(f.q));
  assert.ok((await fs.readdir(dir)).includes('10-stage1-locator.json'));
  assert.equal(await f.ledger.headBurned(headKey(subject())), true);
});

test('executor resumes a held head through the observer once; an unknown result stays held without leaking fields', async t => {
  const q = window(), calls = [], secret = 'fixture-untrusted.jwt.payload';
  const engine = fakeEngine({ stages: { 1: { ok: true, factsSha256: 'd'.repeat(64), stage1Locator: {
    nonce: 'e'.repeat(32), outcomeSha256: 'f'.repeat(64), nativeReceiptSha256: 'd'.repeat(64), jobId: q.subject.stage1JobId } } } });
  engine.relayQualificationWindow = async () => q;
  engine.runRelayQualification = async args => { calls.push(args); return { ok: true, unsafe: secret }; };
  const companion = fakeCompanion({ hint: () => hintFor({ gitleaks: { state: 'SUCCESS' }, trivy: { state: 'SUCCESS' } }) });
  const f = await executorFixture(t, { engine, companion });
  await f.drop(triggerBytes());
  const first = await f.exec.tick();
  assert.equal(first.reason, RELAY_QUALIFICATION_HELD); assert.equal(calls.length, 0);
  const next = await f.exec.tick();
  assert.equal(next.reason, RELAY_QUALIFICATION_HELD);
  assert.deepEqual(next.qualificationObservation, { state: 'HELD', code: 'RELAY_QUALIFICATION_OBSERVATION_UNCERTAIN', phase: null, liveQualified: false });
  assert.equal(calls.length, 1); assert.equal(calls[0].phase, 'initial');
  const restarted = new ResidentExecutor(f.ports);
  assert.equal((await restarted.tick()).reason, RELAY_QUALIFICATION_HELD);
  assert.equal(calls.length, 1); assert.deepEqual(stages(engine), [1]);
  assert.ok(!companion.calls.some(c => c[0] === 'wsprep'));
  const book = path.join(f.exec.qualificationHolds.directory(subject()), 'observations', 'initial', 'attempt-01');
  const terminal = await fs.readFile(path.join(book, '10-result.json'), 'utf8');
  assert.ok(!terminal.includes(secret)); assert.equal(JSON.parse(terminal).status, 'UNCERTAIN_HOLD');
});

test('restart, expired/lost window and changed claim cannot leave a persistent hold', async t => {
  const f = await heldFixture(t); f.advance(2 * 3_600_000);
  for (const q of [null, { ...f.q, subject: { ...f.q.subject, claimId: randomUUID(), fence: 10 } }]) {
    const engine = fakeEngine(); engine.relayQualificationWindow = async () => q;
    const restarted = new ResidentExecutor({ ...f.ports, engine });
    const result = await restarted.tick();
    assert.equal(result.state, 'WAITING');
    assert.equal(result.reason, RELAY_QUALIFICATION_HELD);
    assert.deepEqual(stages(engine), []);
    assert.equal(await f.ledger.halted(), null);
  }
});

test('ordinary Owner resume clears PAUSE but cannot clear a qualification head guard', async t => {
  const f = await heldFixture(t);
  await f.drop(Buffer.from(JSON.stringify({ contract: PAUSE_CONTRACT, reason: 'fixture pause' })), 'requests');
  assert.equal((await f.exec.tick()).state, 'PAUSED');
  await writeOwnerRequest(path.join(f.root, 'owner'), resumeRequest({ expectedPausedSha256: (await f.ledger.paused()).sha256,
    by: 'S-1-5-21-1-2-3-1001' }), f.clock);
  assert.equal((await f.exec.tick()).reason, RELAY_QUALIFICATION_HELD);
  assert.deepEqual(stages(f.engine), [1]);
  assert.equal((await f.exec.qualificationHolds.inspect(subject())).held, true);
});

test('expired first window and exact-head wrong Source/base stop before any Stage1/reservation', async t => {
  for (const kind of ['expired', 'source', 'base']) {
    const q = window();
    if (kind === 'expired') q.validUntil = new Date(NOW - 1).toISOString();
    if (kind === 'source') q.sourceManifestSha256 = q.subject.sourceManifestSha256 = 'f'.repeat(64);
    if (kind === 'base') q.subject.baseSha = '3'.repeat(40);
    const f = await heldFixture(t, { window: q });
    assert.equal(f.first.reason, RELAY_QUALIFICATION_HELD, kind);
    assert.deepEqual(stages(f.engine), [], kind);
    assert.deepEqual(await f.ledger.open(), []);
    assert.equal((await f.exec.qualificationHolds.inspect(subject())).held, true);
  }
});

test('lookup failure never becomes absence or a local execution', async t => {
  const engine = fakeEngine(); engine.relayQualificationWindow = async () => { throw Error('secret lookup error'); };
  const f = await executorFixture(t, { engine }); await f.drop(triggerBytes());
  const result = await f.exec.tick();
  assert.equal(result.state, 'DEFERRED');
  assert.equal(result.reason, 'RELAY_QUALIFICATION_WINDOW_UNCONFIRMED');
  assert.deepEqual(stages(engine), []);
  assert.deepEqual(await f.ledger.open(), []);
});

test('a missing metadata port never means verified absence', async t => {
  const engine = fakeEngine(); delete engine.relayQualificationWindow;
  const f = await executorFixture(t, { engine }); await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).reason, 'RELAY_QUALIFICATION_WINDOW_UNCONFIRMED');
  assert.deepEqual(stages(engine), []);
});

test('only fixed Stage1 locators are persisted, never the raw engine result or a qualification claim', async t => {
  const locator = { nonce: 'a'.repeat(32), outcomeSha256: 'b'.repeat(64), nativeReceiptSha256: 'c'.repeat(64), jobId: 'd'.repeat(64) };
  const f = await heldFixture(t, { engineScript: { stages: { 1: { ok: true, factsSha256: 'c'.repeat(64), stage1Locator: locator,
    rawSecret: 'SECRET_DO_NOT_PERSIST', liveQualified: true } } } });
  const raw = await fs.readFile(path.join(f.exec.qualificationHolds.directory(subject()), '10-stage1-locator.json'), 'utf8');
  assert.deepEqual(JSON.parse(raw).locator, locator);
  assert.equal(raw.includes('SECRET_DO_NOT_PERSIST'), false);
  assert.equal(raw.includes('liveQualified'), false);
  assert.equal(JSON.parse(raw).authority, 'LOCATOR_ONLY_NOT_STAGE13_PROOF');
});

test('held head consumes no general parking capacity; unrelated PR/head still completes', async t => {
  const p = rawPolicy(); p.park.maxParked = 1;
  const f = await heldFixture(t, { policy: p });
  assert.deepEqual(await f.exec.parkedCounts(), { inside: 0, outside: 0 });
  await f.drop(triggerBytes({ pr: 885, headSha: '3'.repeat(40) }));
  const result = await f.exec.tick();
  assert.equal(result.state, 'COMPLETED');
  assert.deepEqual(stages(f.engine), [1, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal((await f.exec.qualificationHolds.inspect(subject())).held, true);
});

test('pre-Stage1 expiry gets explicit RESERVED hold, restarts without pretending Stage1 started', async t => {
  const engine = fakeEngine(), q = window(); engine.relayQualificationWindow = async () => q;
  const f = await executorFixture(t, { engine });
  const derive = engine.derive; engine.derive = async (...args) => { f.advance(4_000_000); return derive(...args); };
  await f.drop(triggerBytes()); const first = await f.exec.tick();
  assert.equal(first.reason, RELAY_QUALIFICATION_HELD);
  const entry = await f.ledger.state(first.key);
  assert.equal(entry.state, 'RESERVED');
  assert.equal(entry.started, null);
  assert.ok(Ledger.qualificationHeldAt(entry));
  assert.equal(await f.ledger.headBurned(headKey(subject())), false);
  assert.equal((await fs.readdir(f.exec.qualificationHolds.directory(subject()))).includes('05-stage1-intent.json'), false);
  const again = new ResidentExecutor({ ...f.ports, engine: fakeEngine() });
  assert.equal((await again.tick()).reason, RELAY_QUALIFICATION_HELD);
  assert.equal(await f.ledger.halted(), null);
  assert.deepEqual(stages(engine), []);
});

test('crash before Stage1 intent recovers to unstarted hold; an intent remains uncertain and never reruns', async t => {
  for (const intent of [false, true]) {
    const f = await executorFixture(t), s = subject(), key = batchKey(s);
    await f.ledger.reserve(key, s);
    const batchId = key.slice(0, 16) + '-' + 'b'.repeat(12);
    await f.exec.qualificationHolds.arm(window(), s, { key, batchId });
    if (intent) await f.exec.qualificationHolds.stage1Intent(s, { key, batchId });
    const again = new ResidentExecutor({ ...f.ports, engine: fakeEngine() });
    const result = await again.tick();
    assert.equal(result.state, intent ? 'HALTED' : 'WAITING');
    if (!intent) assert.ok(Ledger.qualificationHeldAt(await f.ledger.state(key)));
    assert.deepEqual(stages(again.engine), []);
  }
});

test('Source and base changes do not evade an existing repository/head guard', async t => {
  const f = await heldFixture(t);
  const s = subject({ pr: 999, baseSha: '3'.repeat(40), sourceManifestSha256: '4'.repeat(64) });
  const pre = await f.exec.precheck(batchKey(s), headKey(s), s, { usage: await f.ledger.usage(NOW - 86_400_000) });
  assert.equal(pre.defer, RELAY_QUALIFICATION_HELD);
  assert.equal(pre.perRow, true);
  assert.deepEqual(stages(f.engine), [1]);
});

test('an empty guard blocks the executor before Stage1 but does not block another head', async t => {
  const f = await executorFixture(t), book = f.exec.qualificationHolds;
  await fs.mkdir(book.root);
  await fs.mkdir(book.directory(subject()));
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).reason, RELAY_QUALIFICATION_HELD);
  assert.deepEqual(stages(f.engine), []);
  await f.drop(triggerBytes({ pr: 885, headSha: '3'.repeat(40) }));
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
});

test('a now-corrupt guard cannot release a Stage1-completed waiting batch', async t => {
  const f = await heldFixture(t);
  await fs.writeFile(path.join(f.exec.qualificationHolds.directory(subject()), '00-window.json'), '{'); // this new fixture only
  f.setWindow(null);
  const again = new ResidentExecutor({ ...f.ports, engine: fakeEngine() });
  assert.equal((await again.tick()).reason, RELAY_QUALIFICATION_HELD);
  assert.deepEqual(stages(again.engine), []);
  assert.equal(await f.ledger.halted(), null);
});

test('ledger14 rejects empty, wrong-key/batch, null, extra or conflicting content as UNREADABLE', async t => {
  for (const change of [() => ({}), () => null, h => ({ ...h, key: 'f'.repeat(64) }),
    h => ({ ...h, batch: { ...h.batch, batchId: 'f'.repeat(16) + '-' + 'a'.repeat(12) } }),
    h => ({ ...h, batch: { ...h.batch, batchId: h.key.slice(0, 16) + '-' + 'a'.repeat(12) } }),
    h => ({ ...h, extra: true }), h => ({ ...h, batch: { ...h.batch, extra: true } }), h => ({ ...h, t0: h.t0 + 1 })]) {
    const f = await executorFixture(t), s = subject(), key = batchKey(s), batchId = key.slice(0, 16) + '-' + 'b'.repeat(12);
    await f.ledger.reserve(key, s);
    await f.exec.qualificationHolds.arm(window(), s, { key, batchId });
    f.advance(17); // Real wall-clock gaps do not change the reservation anchor.
    await f.ledger.beginQualificationHold(key, { t0: f.clock(), batch: { key, batchId, ignoredRuntimeDetail: true } });
    const file = path.join(f.ledger.dir(key), '14-qualification-hold.json');
    const good = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(good.t0, NOW);
    assert.deepEqual(Object.keys(good.batch).sort(), ['batchId', 'key']);
    assert.ok(Ledger.qualificationHeldAt(await f.ledger.state(key)));
    await fs.writeFile(file, JSON.stringify(change(good))); // only the new corrupt fixture record
    const state = await f.ledger.state(key);
    assert.equal(state.state, 'UNREADABLE');
    assert.equal(Ledger.resumable(state), false);
    assert.ok((await f.ledger.crashed()).some(e => e.key === key));
  }
});

test('ledger14 cannot hide Stage1 intent or coexist with any started/wait/plan/park record', async t => {
  for (const conflict of ['05-stage1-intent.json', '10-started.json', '15-relay-wait.json', '20-plan-intent.json', '25-plan.json', '70-parked.json']) {
    const f = await executorFixture(t), s = subject(), key = batchKey(s), batchId = key.slice(0, 16) + '-' + 'b'.repeat(12);
    const batch = { key, batchId };
    await f.ledger.reserve(key, s);
    await f.exec.qualificationHolds.arm(window(), s, { key, batchId });
    await f.ledger.beginQualificationHold(key, { batch });
    assert.ok(Ledger.qualificationHeldAt(await f.ledger.state(key)));
    const dir = conflict.startsWith('05-') ? f.exec.qualificationHolds.directory(s) : f.ledger.dir(key);
    await fs.writeFile(path.join(dir, conflict), 'null', { flag: 'wx' }); // conflict presence, even falsy JSON, is uncertainty
    assert.equal((await f.ledger.state(key)).state, 'UNREADABLE', conflict);
    const again = new ResidentExecutor({ ...f.ports, engine: fakeEngine() });
    assert.equal((await again.tick()).state, 'HALTED', conflict);
    assert.deepEqual(stages(again.engine), [], conflict);
  }
  const f = await executorFixture(t), s = subject(), key = batchKey(s), batchId = key.slice(0, 16) + '-' + 'b'.repeat(12);
  await f.ledger.reserve(key, s);
  await f.exec.qualificationHolds.arm(window(), s, { key, batchId });
  await f.exec.qualificationHolds.stage1Intent(s, { key, batchId });
  await assert.rejects(f.ledger.beginQualificationHold(key, { batch: { key, batchId } }), /QUALIFICATION_HOLD_STAGE1_INTENT_CONFLICT/);
});
