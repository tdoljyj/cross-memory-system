// Real maintenance/stores/publisher with explicit offline GitHub/Native ports.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { setup, jobOf, ledgered, sha, iso, T, H, S, CLAIM, SOURCE, REPO, NOW, RUN } from './train-strict-fixtures.mjs';
import { tempDir, admittedFacts } from './resident-v2-fixtures.mjs';
import { batchJobsV2, claimGeneration } from '../src/job-v2.mjs';
import { EffectJournal } from '../src/effect-journal.mjs';
import { digest } from '../src/proof.mjs';
import { createFixtureControlPublisherV2 } from '../src/independent-control-checks-v2/publisher.mjs';
import { validStrictFrontReadiness, strictIdentity } from '../src/independent-control-checks-v2/train-strict.mjs';

const healthy = { nodes: [{ node: { name: 'turing', sourceManifestSha256: SOURCE, state: 'ACTIVE', lastHeartbeatAt: iso(NOW) } }] };
async function cold(t) { return setup(t, { strict: true, fullDone: false, native: healthy, tick: 1 }); }
async function publish(t, e, { mode = 'normal', staleClaim = false, source = SOURCE, afterCreate = null } = {}) {
  for (const [i, name] of ['kooyumi-work-admission', 'gitleaks', 'trivy', 'contract-placement'].entries()) e.gh.green(10 + i, H, { name });
  const batch = { claimId: CLAIM, fence: 3, epoch: 1, expiresAt: iso(e.now + 3600_000) };
  const current = staleClaim ? { ...batch, fence: 4, epoch: 2 } : batch;
  const jobs = batchJobsV2({ repo: REPO, pr: 910, headSha: H, baseSha: T, testSha: S,
    sourceManifestSha256: source, createdAt: iso(e.now), attempt: 1 });
  if (afterCreate) e.gh.world.hooks.create = afterCreate;
  const publisher = createFixtureControlPublisherV2({ github: e.gh, journal: await EffectJournal.open(path.join(await tempDir(t), 'effects')),
    trainMode: 'on', batchClaim: claimGeneration(batch), slotNative: e.native.port, sweepStore: e.store, greenLedger: e.ledger,
    pullsUpdatedSince: cursor => e.gh.readPullsUpdatedSince(cursor),
    admission: { async evaluatePr(job, packet, options) { const { observationSha256, ...facts } = { ...admittedFacts(job, current, packet,
      { domain: 'fixture', mergeQueueHead: true, batchClaim: options?.batchClaim, observedAt: e.now, slotUntil: e.now + 600_000 }),
      mode: { state: typeof mode === 'function' ? mode() : mode, layer: 'code', policyVersion: 1 } };
      return { ...facts, observationSha256: digest(facts) }; } },
    assertLive() {}, record() {}, authority: {}, clock: e.clock, sleep: e.sleep });
  return publisher.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: e.now + 90_000 });
}

test('strict front: cold real maintenance opens S without history coverage; real publisher settles', async t => {
  const e = await cold(t); e.gh.world.hooks.pullsPage = sort => { assert.notEqual(sort, 'created', 'initial readiness does not enumerate history'); };
  const r = await e.run(), s = r.facts.sweep;
  assert.equal(s.strictFrontReadiness.state, 'ready', JSON.stringify(r.facts));
  assert.equal(validStrictFrontReadiness(s.strictFrontReadiness), true);
  assert.equal(s.strictFrontReadiness.historyCoverage, false); assert.equal(s.strictCoverage.state, 'none');
  assert.equal(s.fullSweep.sinceOn, false); assert.equal(s.proofWritten, true); assert.ok(r.facts.openFrontBatch);
  const legacy = await e.store.latestProof(); assert.equal(legacy.clean, false); assert.equal(legacy.unconfirmed, 0); assert.equal(legacy.fullSweepSinceOn, false);
  const published = await publish(t, e); assert.equal(published.status, 'SETTLED', JSON.stringify(published));
});

test('strict front: heartbeat read after the run begins is fresh, while a genuinely future heartbeat is not', async t => {
  const e = await cold(t);
  e.gh.readRateBudget = async () => { e.now += 500; };
  e.native.port.nodesStatus = async () => ({ deployed: true, onDuty: true, dropped: 0,
    nodes: [{ node: { ...healthy.nodes[0].node, lastHeartbeatAt: iso(e.now) } }] });
  const r = await e.run();
  assert.equal(r.facts.sweep.strictFrontReadiness.state, 'ready', 'a heartbeat newer than invocation start can be current at read-back');
  const future = await cold(t);
  future.gh.readRateBudget = async () => { future.now += 500; };
  future.native.port.nodesStatus = async () => ({ deployed: true, onDuty: true, dropped: 0,
    nodes: [{ node: { ...healthy.nodes[0].node, lastHeartbeatAt: iso(future.now + 60_000) } }] });
  assert.notEqual((await future.run()).facts.sweep.strictFrontReadiness.state, 'ready', 'a truly future timestamp still cannot authorize the fast observation');
});

test('strict front: expired certificates cannot renew the background skip', async t => {
  const e = await cold(t);
  for (let n = 1; n <= 240; n++) e.gh.pull(n, { state: 'closed', head: sha(0x9000 + n) });
  await e.run(); assert.equal((await e.store.readFullSweepStrict()).full.nextPage, 1);
  for (let n = 0; n < 3; n++) {
    e.now += 600_000;
    const result = await e.run(jobOf({ createdAt: iso(e.now), runId: `${(n + 1).toString(16).padStart(16, '0')}-0123456789ab` }));
    assert.ok(result.facts.sweep.calls > 0);
  }
  const state = await e.store.readFullSweepStrict();
  assert.ok(state.full.nextPage > 1 || state.full.state === 'complete', JSON.stringify(state));
});

test('strict front: persistent certificate write failure cannot starve background full work', async t => {
  const e = await cold(t);
  for (let n = 1; n <= 240; n++) e.gh.pull(n, { state: 'closed', head: sha(0x9000 + n) });
  e.store.appendStrictFrontProof = async () => { throw Error('disk-full-for-front-proof'); };
  const first = await e.run(); assert.notEqual(first.facts.sweep.strictFrontReadiness.state, 'ready');
  assert.equal((await e.store.readFullSweepStrict()).full.nextPage, 1);
  e.now += 600000;
  await e.run(jobOf({ createdAt: iso(e.now) }));
  const state = await e.store.readFullSweepStrict();
  assert.ok(state.full.nextPage > 1 || state.full.state === 'complete', JSON.stringify(state));
});

test('strict front: a real required-current round emits advanced current progress', async t => {
  const e = await cold(t);
  for (let n = 1; n <= 240; n++) e.gh.pull(n, { state: 'closed', head: sha(0x9000 + n) });
  await e.run();
  const old = await e.store.readFullSweepStrict();
  await e.store.writeFullSweep({ ...old, writtenAt: iso(++e.now), allPending: null,
    full: { ...old.full, state: 'complete', completedAt: iso(e.now), startedAt: iso(NOW - 7200000), reason: null } });
  await e.store.appendProof({ ...await e.store.latestProof(), writtenAt: iso(e.now) });
  e.now += 600000;
  const job = jobOf({ createdAt: iso(e.now), onSince: iso(NOW) });
  await e.run(job); e.now += 600000; e.tick = 1000;
  const result = await e.run({ ...job, createdAt: iso(e.now) });
  assert.equal(result.facts.sweep.progress?.scope, 'current', JSON.stringify(result.facts));
  assert.equal(result.facts.sweep.progress.advanced, true);
});

test('strict front: live gates reject stale Native generation, frozen, Source, strict, tip and front changes', async t => {
  for (const change of ['generation', 'frozen', 'source', 'fleet', 'duty', 'strict', 'unreadable', 'tip', 'holder', 'merge']) await t.test(change, async t => {
    const e = await cold(t); await e.run(); const options = {};
    if (change === 'generation') options.staleClaim = true;
    if (change === 'frozen') options.mode = 'frozen';
    if (change === 'source') options.source = 'd'.repeat(64);
    if (change === 'fleet') e.native.status = { deployed: true, onDuty: true, dropped: 0,
      nodes: [{ node: { ...healthy.nodes[0].node, sourceManifestSha256: 'd'.repeat(64) } }] };
    if (change === 'duty') e.native.onDuty = false;
    if (change === 'strict') e.gh.world.strict = false;
    if (change === 'unreadable') e.gh.readBranchRules = async () => { throw Error('offline'); };
    if (change === 'tip') e.gh.world.main = sha(0xffff);
    if (change === 'holder') e.native.holder = { ...e.native.holder, claimId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
    if (change === 'merge') e.gh.world.commits.set(S, { sha: S, tree: sha(0xabcd), parents: [T, H] });
    const r = await publish(t, e, options); assert.notEqual(r.status, 'SETTLED', JSON.stringify(r));
  });
});

test('strict front: after-write boundary rechecks frozen and compensates publication', async t => {
  const e = await cold(t); await e.run(); let mode = 'normal';
  const r = await publish(t, e, { mode: () => mode, afterCreate: () => { mode = 'frozen'; } });
  assert.notEqual(r.status, 'SETTLED', JSON.stringify(r));
  assert.equal([...e.gh.world.checks.values()].some(c => c.name === 'kooyumi-merge-slot' && c.conclusion === 'success'), false);
});

test('strict front: pending legacy effects, torn state and unknown ancestry never become ready', async t => {
  for (const change of ['pending', 'torn-full', 'torn-round', 'unknown-ancestry', 'rewrite']) await t.test(change, async t => {
    const e = await cold(t);
    if (change === 'pending') await e.store.appendProof({ writtenAt: iso(NOW - 1), runId: RUN, mode: 'on', pr: null, headSha: null, claimId: null, since: null,
      mainSha: T, clean: false, unconfirmed: 1, fullSweepSinceOn: false, slotHardCapMinutes: 90, sweepFreshMs: 900000, prUpdatedCursor: iso(NOW - 1000) });
    if (change.startsWith('torn')) await fs.writeFile(path.join(e.store.directory, `${change === 'torn-full' ? 'full-on' : 'strict-round'}-${NOW}-ffffffffffffffff-ffffffffffff-ffffffff.json`), '{');
    if (change === 'unknown-ancestry') e.gh.world.hooks.compare = () => Error('unknown');
    if (change === 'rewrite') { await e.run(); e.now += 1000; e.gh.world.main = sha(0xffff); e.gh.world.hooks.compare = () => ({ status: 'diverged', aheadBy: 1, behindBy: 1 }); }
    let r; try { r = await e.run(); } catch { return; }
    assert.notEqual(r.facts.sweep?.strictFrontReadiness?.state, 'ready', JSON.stringify(r.facts));
    if (change.startsWith('torn')) {
      e.now += 600000;
      const again = await e.run(jobOf({ createdAt: iso(e.now) }));
      assert.notEqual(again.facts.sweep?.strictFrontReadiness?.state, 'ready', 'a partial record cannot wash unreadable state');
    }
  });
});

test('strict front: same-ms legacy contradictions and state loss fail closed at Stage8', async t => {
  for (const change of ['legacy-conflict', 'lost-anchor', 'torn-full', 'torn-round', 'anchor-tip', 'pending-round', 'ledger']) await t.test(change, async t => {
    const e = await cold(t); await e.run();
    if (change === 'legacy-conflict') { const p = await e.store.latestProof(); await e.store.appendProof({ ...p, clean: false, unconfirmed: 1 }); }
    if (change === 'lost-anchor') for (const n of await fs.readdir(e.store.directory)) if (n.startsWith('full-on-')) await fs.unlink(path.join(e.store.directory, n));
    if (change === 'torn-full' || change === 'torn-round') await fs.writeFile(path.join(e.store.directory,
      `${change === 'torn-full' ? 'full-on' : 'strict-round'}-${e.now}-ffffffffffffffff-ffffffffffff-ffffffff.json`), '{');
    if (change === 'anchor-tip') { const f = await e.store.readFullSweepStrict(); await e.store.writeFullSweep({ ...f, writtenAt: iso(++e.now), mainSha: sha(0xffff) }); }
    if (change === 'pending-round') await e.store.writeStrictRound({ ...strictIdentity({ job: jobOf(), holder: e.native.holder, headSha: H, mainSha: T, scope: 'all' }),
      writtenAt: iso(++e.now), runId: RUN, startedAt: iso(NOW), state: 'running', nextPage: 1, nextIndex: 0, incrementalCursor: null,
      coverage: { prs: 0, commits: 0, heads: 0, eligible: 0, deferred: 0, revoked: 0 },
      pending: [{ checkRunId: 777, headSha: sha(0x777), reason: 'TRAIN_OTHER_HEAD', own: true }] });
    if (change === 'ledger') e.ledger.list = async () => ({ entries: [], refused: ['broken'] });
    const r = await publish(t, e); assert.equal(r.status, 'BLOCKED', JSON.stringify(r));
  });
});

test('strict front: fresh gen16 coverage cannot bypass known bad state; healthy optional fallback remains', async t => {
  for (const change of ['healthy-legacy', 'torn-full', 'legacy-conflict', 'pending-round']) await t.test(change, async t => {
    // No deployed nodes-status/front-only certificate: this exercises the real
    // gen16 limited route, including its legitimate optional-health fallback.
    const e = await setup(t, { strict: true, fullDone: false, tick: 1 });
    const behind = Array.from({ length: 25 }, (_, i) => sha(0x9000 + i)); e.gh.world.behindHeads = new Set(behind);
    for (const [i, head] of behind.entries()) { e.gh.pull(i + 1, { state: 'closed', head }); e.gh.green(100 + i, head); }
    const eligible = sha(0xa001); e.gh.pull(100, { state: 'closed', head: eligible }); e.gh.green(200, eligible);
    const result = await e.run(); assert.equal(result.facts.sweep.strictCoverage.state, 'ready');
    assert.equal((await e.store.latestProof()).fullSweepSinceOn, false);
    assert.equal(await e.store.latestStrictFrontProof(), null);
    if (change === 'torn-full') await fs.writeFile(path.join(e.store.directory, `full-on-${++e.now}-${RUN}-ffffffff.json`), '{');
    if (change === 'legacy-conflict') { const p = await e.store.latestProof(); await e.store.appendProof({ ...p, clean: false, unconfirmed: 1 }); }
    if (change === 'pending-round') { const r = await e.store.readStrictRound(); await e.store.writeStrictRound({ ...r, writtenAt: iso(++e.now), state: 'running',
      pending: [{ checkRunId: 777, headSha: sha(0x777), reason: 'TRAIN_OTHER_HEAD', own: true }] }); }
    const published = await publish(t, e);
    assert.equal(published.status, change === 'healthy-legacy' ? 'SETTLED' : 'BLOCKED', JSON.stringify(published));
  });
});

test('strict front: a healthy real complete-full proof retains the original Owner-frozen route', async t => {
  const e = await cold(t); await e.run(); e.now += 1000; await e.run();
  assert.equal((await e.store.latestProof()).fullSweepSinceOn, true);
  const result = await publish(t, e, { mode: 'frozen' });
  assert.equal(result.status, 'SETTLED', JSON.stringify(result));
});

test('strict front: durable normal pending survives a failed v1 append and later zero projections', async t => {
  const e = await cold(t); await e.run(); const old = await e.store.latestProof();
  const head = sha(0x777); e.gh.pull(77, { state: 'closed', head }); e.gh.green(777, head);
  let refuse = true;
  e.gh.world.hooks.run = (id, _n, actual) => id === 777 && refuse && actual.conclusion === 'failure' ? { ...actual, conclusion: 'success' } : actual;
  const append = e.store.appendProof.bind(e.store); e.store.appendProof = async () => { throw Error('selective-proof-failure'); };
  e.now += 1000; await e.run();
  assert.ok(Date.parse((await e.store.readFullSweepStrict()).writtenAt) > Date.parse(old.writtenAt));
  assert.equal((await e.store.latestProof()).writtenAt, old.writtenAt);
  assert.deepEqual((await e.store.readPendingRevocations()).targets.map(t => t.checkRunId), [777]);
  assert.equal((await publish(t, e)).status, 'BLOCKED');
  e.store.appendProof = append; e.now += 1000; await e.run();
  assert.deepEqual((await e.store.readPendingRevocations()).targets.map(t => t.checkRunId), [777]);
  assert.equal((await publish(t, e)).status, 'BLOCKED');
  refuse = false; e.now += 1000; const reads = e.gh.world.reads.get(777); await e.run();
  assert.ok(e.gh.world.reads.get(777) >= reads + 2, 'already-failure is confirmed twice by exact ID');
  assert.equal((await e.store.readPendingRevocations()).targets.length, 0);
  e.now += 1000; await e.run();
  assert.equal((await publish(t, e)).status, 'SETTLED');
});

test('strict front: intent failure sends no negative, and clear failure preserves pending', async t => {
  for (const failure of ['intent', 'clear']) await t.test(failure, async t => {
    const e = await cold(t); await e.run(); const head = sha(0x778); e.gh.pull(77, { state: 'closed', head }); e.gh.green(778, head);
    const write = e.store.writePendingRevocations.bind(e.store);
    e.store.writePendingRevocations = async p => { if (failure === 'intent' || p.targets.length === 0) throw Error('selective-pending-failure'); return write(p); };
    e.now += 1000; const result = await e.run(); assert.notEqual(result.facts.sweep.strictFrontReadiness.state, 'ready');
    if (failure === 'intent') assert.equal(e.gh.world.writes.length, 0);
    else {
      assert.deepEqual((await e.store.readPendingRevocations()).targets.map(t => t.checkRunId), [778]);
      assert.equal((await publish(t, e)).status, 'BLOCKED');
    }
  });
});

test('strict front: newer full without its v1, and cross-run equal stamps, cannot borrow old authority', async t => {
  for (const sameStamp of [false, true]) await t.test(String(sameStamp), async t => {
    const e = await cold(t); await e.run(); const f = await e.store.readFullSweepStrict();
    // A well-formed new anchor is enough to require its own v1, independent of
    // the cumulative full.unconfirmed statistic or any successful GitHub PATCH.
    await e.store.writeFullSweep({ ...f, writtenAt: sameStamp ? f.writtenAt : iso(++e.now),
      runId: sameStamp ? 'aaaaaaaaaaaaaaaa-bbbbbbbbbbbb' : f.runId });
    const result = await publish(t, e); assert.equal(result.status, 'BLOCKED', JSON.stringify(result));
  });
});

test('strict front: migrated unknown legacy count remains latched across partial zero proofs', async t => {
  for (const emptyJournal of [false, true]) await t.test(String(emptyJournal), async t => {
  const e = await cold(t);
  for (let n = 1; n <= 240; n++) e.gh.pull(n, { state: 'closed', head: sha(0xa000 + n) });
  await e.store.appendProof({ writtenAt: iso(NOW - 2), runId: RUN, mode: 'on', pr: null, headSha: null, claimId: null, since: null,
    mainSha: T, clean: false, unconfirmed: 1, fullSweepSinceOn: false, slotHardCapMinutes: 90, sweepFreshMs: 900000, prUpdatedCursor: iso(NOW - 1000) });
  if (emptyJournal) await e.store.writePendingRevocations({ repo: REPO, writtenAt: iso(NOW - 1), runId: 'ffffffffffffffff-ffffffffffff', targets: [] });
  e.tick = 500;
  for (let n = 0; n < 2; n++) {
    const result = await e.run(jobOf({ createdAt: iso(e.now) }));
    assert.notEqual(result.facts.sweep.strictFrontReadiness.state, 'ready');
    assert.equal((await e.store.readPendingRevocations()).legacyUnconfirmed, 1);
    e.now += 600000;
  }
  });
});

test('strict front: a genuinely completed all round releases the legacy unknown latch', async t => {
  const e = await cold(t);
  await e.store.appendProof({ writtenAt: iso(NOW - 1), runId: RUN, mode: 'on', pr: null, headSha: null, claimId: null, since: null,
    mainSha: T, clean: false, unconfirmed: 1, fullSweepSinceOn: false, slotHardCapMinutes: 90, sweepFreshMs: 900000, prUpdatedCursor: iso(NOW - 1000) });
  const result = await e.run();
  assert.equal(result.facts.sweep.fullSweep.scope, 'all'); assert.equal(result.facts.sweep.fullSweep.sinceOn, true);
  assert.equal((await e.store.readPendingRevocations()).legacyUnconfirmed, 0);
  assert.equal((await publish(t, e)).status, 'SETTLED');
});

test('strict front: pending readers reject torn/conflicting records across calls and at publication', async t => {
  for (const kind of ['torn', 'conflict']) await t.test(kind, async t => {
    const e = await cold(t); await e.run(); e.now += 1000;
    await e.store.writePendingRevocations({ repo: REPO, writtenAt: iso(e.now), runId: RUN, targets: [] });
    if (kind === 'torn') await fs.writeFile(path.join(e.store.directory, `pending-revocations-${e.now}-${RUN}-00000000.json`), '{');
    else await e.store.writePendingRevocations({ repo: REPO, writtenAt: iso(e.now), runId: RUN,
      targets: [{ checkRunId: 779, headSha: sha(779), reason: 'NOT_FRONT_HEAD', own: false }] });
    assert.equal((await publish(t, e)).status, 'BLOCKED');
    for (let n = 0; n < 2; n++) {
      const result = await e.run(jobOf({ createdAt: iso(e.now) }));
      assert.notEqual(result.facts.sweep.strictFrontReadiness.state, 'ready'); e.now += 1000;
      await assert.rejects(e.store.readPendingRevocations(), { code: 'TRAIN_PENDING_REVOCATIONS_UNREADABLE' });
    }
  });
});

test('strict front: exact pending confirmation survives claim/Source changes and off-duty own recovery', async t => {
  for (const offDuty of [false, true]) await t.test(String(offDuty), async t => {
    const e = await cold(t), head = sha(0x880); e.gh.green(880, head, { conclusion: 'failure' });
    if (offDuty) await ledgered(e.ledger, { pr: 88, headSha: head, checkRunId: 880 });
    await e.store.writePendingRevocations({ repo: REPO, writtenAt: iso(NOW - 1), runId: RUN,
      targets: [{ checkRunId: 880, headSha: head, reason: 'NOT_FRONT_HEAD', own: offDuty }] });
    const source = 'd'.repeat(64);
    e.native.onDuty = !offDuty;
    e.native.holder = { ...e.native.holder, claimId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
    e.native.status = { deployed: true, onDuty: !offDuty, dropped: 0,
      nodes: [{ node: { ...healthy.nodes[0].node, sourceManifestSha256: source } }] };
    const before = e.now; await e.run(jobOf({ sourceManifestSha256: source }));
    assert.equal((await e.store.readPendingRevocations()).targets.length, 0);
    assert.ok(e.now - before >= 30000); assert.ok(e.gh.world.reads.get(880) >= 2);
    assert.equal(e.gh.world.writes.length, 0, 'already negative needs confirmation, no second PATCH');
  });
});

test('strict front: restored pending and new negatives share the 20-attempt cap', async t => {
  const e = await cold(t), targets = [];
  for (let n = 1; n <= 20; n++) { const head = sha(0xb000 + n); e.gh.green(900 + n, head, { conclusion: 'failure' });
    targets.push({ checkRunId: 900 + n, headSha: head, reason: 'NOT_FRONT_HEAD', own: false }); }
  await e.store.writePendingRevocations({ repo: REPO, writtenAt: iso(NOW - 1), runId: RUN, targets });
  const head = sha(0xc001); e.gh.pull(77, { state: 'closed', head }); e.gh.green(999, head);
  await e.run();
  assert.equal((await e.store.readPendingRevocations()).targets.length, 0);
  assert.equal(e.gh.world.checks.get(999).conclusion, 'success', 'the 21st attempt waits');
  e.now += 1000; await e.run(); assert.equal(e.gh.world.checks.get(999).conclusion, 'failure');
});

test('strict front: off-duty B from another run cannot discharge unknown legacy A at takeover', async t => {
  const e = await cold(t), head = sha(0xd001), oldRun = 'aaaaaaaaaaaaaaaa-aaaaaaaaaaaa', newRun = 'bbbbbbbbbbbbbbbb-bbbbbbbbbbbb';
  await e.store.appendProof({ writtenAt: iso(NOW - 1), runId: oldRun, mode: 'on', pr: null, headSha: null, claimId: null, since: null,
    mainSha: T, clean: false, unconfirmed: 1, fullSweepSinceOn: false, slotHardCapMinutes: 90, sweepFreshMs: 900000, prUpdatedCursor: iso(NOW - 1000) });
  e.gh.pull(88, { state: 'closed', head }); e.gh.green(888, head);
  await ledgered(e.ledger, { pr: 88, headSha: head, checkRunId: 888 });
  e.native.onDuty = false;
  e.gh.world.hooks.run = (id, _n, actual) => id === 888 && actual.conclusion === 'failure' ? { ...actual, conclusion: 'success' } : actual;
  await e.run(jobOf());
  const pending = await e.store.readPendingRevocations();
  assert.deepEqual(pending.targets.map(t => t.checkRunId), [888]); assert.equal(pending.legacyUnconfirmed, 0);
  assert.notEqual(pending.runId, oldRun); assert.equal((await e.store.latestProof()).runId, oldRun);
  e.native.onDuty = true; e.gh.world.hooks.run = undefined;
  for (let n = 1; n <= 240; n++) e.gh.pull(1000 + n, { state: 'closed', head: sha(0xe000 + n) });
  e.now += 1000; e.tick = 500;
  const result = await e.run(jobOf({ runId: newRun, createdAt: iso(e.now) }));
  const restored = await e.store.readPendingRevocations();
  assert.equal(restored.targets.length, 0, 'B completed its own two readbacks');
  assert.equal(restored.legacyUnconfirmed, 1, 'unknown A remains a distinct obligation');
  assert.notEqual(result.facts.sweep.strictFrontReadiness.state, 'ready');
  assert.equal(result.facts.sweep.fullSweep.sinceOn, false);
});

test('strict front: legacy foreign strict pending survives a lost-duty filter without a new journal', async t => {
  const e = await setup(t, { strict: true, fullDone: false, native: { ...healthy, reread: false }, tick: 1 });
  const head = sha(0xf001); e.gh.pull(88, { state: 'closed', head }); e.gh.green(889, head, { conclusion: 'failure' });
  await e.store.appendProof({ writtenAt: iso(NOW - 2), runId: RUN, mode: 'on', pr: null, headSha: null, claimId: null, since: null,
    mainSha: T, clean: false, unconfirmed: 0, fullSweepSinceOn: false, slotHardCapMinutes: 90, sweepFreshMs: 900000, prUpdatedCursor: iso(NOW - 1000) });
  await e.store.writeStrictRound({ ...strictIdentity({ job: jobOf(), holder: e.native.holder, headSha: H, mainSha: T, scope: 'all' }),
    writtenAt: iso(NOW - 1), runId: RUN, startedAt: iso(NOW - 10000), state: 'running', nextPage: 1, nextIndex: 0, incrementalCursor: null,
    coverage: { prs: 0, commits: 0, heads: 0, eligible: 0, deferred: 0, revoked: 0 },
    pending: [{ checkRunId: 889, headSha: head, reason: 'NOT_FRONT_HEAD', own: false }] });
  assert.equal(await e.store.readPendingRevocations(), null);
  const result = await e.run();
  assert.deepEqual((await e.store.readStrictRound()).pending.map(p => p.checkRunId), [889]);
  assert.equal(await e.store.readPendingRevocations(), null, 'no negative attempt or false empty handoff');
  assert.equal((await e.store.latestProof()).unconfirmed, 0, 'a legacy count latch is not hiding loss of the exact ID');
  assert.equal(e.gh.world.writes.length, 0); assert.equal(result.facts.sweep.strictCoverage.state, 'running');
  assert.notEqual(result.facts.sweep.strictFrontReadiness.state, 'ready');
  // A later identity is allowed to finish A, but cannot forget it while foreign
  // writes remain unauthorized. It is no longer discoverable as a success.
  e.native.holder = { ...e.native.holder, takenAt: iso(NOW - 1000) }; e.now += 1000;
  await e.run(jobOf({ createdAt: iso(e.now) }));
  assert.deepEqual((await e.store.readStrictRound()).pending.map(p => p.checkRunId), [889]);
});
