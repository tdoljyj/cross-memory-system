import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSweeper, fullSweepSegment } from '../src/independent-control-checks-v2/train-sweep.mjs';
import { TrainSweepStore, validateSweepProof } from '../src/independent-control-checks-v2/train-sweep-store.mjs';
import { trainHeadDecision, TRAIN_SINGLE_GREEN_NOT_PROVEN } from '../src/independent-control-checks-v2/train-rules.mjs';
import { runStrictLane, strictIdentity, validateStrictProof, strictReadiness, validStrictReadiness, validTrainProviderBudget } from '../src/independent-control-checks-v2/train-strict.mjs';
import { setup, jobOf, sha, iso, T, H, S, TREE, CLAIM, RUN, SOURCE, REPO, APP, NOW } from './train-strict-fixtures.mjs';
import { batchJobsV2 } from '../src/job-v2.mjs';
import { tempDir } from './resident-v2-fixtures.mjs';
import { canonical } from '../src/proof.mjs';

test('strict classification: T<=H only, unknown/inconsistent comparisons fail closed before deferring', async () => {
  for (const [reply, eligible] of [
    [{ status: 'ahead', aheadBy: 2, behindBy: 0 }, true], [{ status: 'identical', aheadBy: 0, behindBy: 0 }, true],
    [{ status: 'behind', aheadBy: 0, behindBy: 1 }, false], [{ status: 'diverged', aheadBy: 2, behindBy: 1 }, false],
  ]) {
    const port = { async readCompare(base, head) { assert.equal(base, T); assert.equal(head, H); return reply; } };
    assert.equal(await createSweeper({ github: port, appId: APP, mainSha: T, strictCoverage: true }).eligibleOf(H), eligible);
  }
  for (const reply of [null, {}, { status: 'behind', aheadBy: 0, behindBy: 0 }, { status: 'identical', aheadBy: 1, behindBy: 0 }]) {
    const s = createSweeper({ github: { async readCompare() { return reply; } }, appId: APP, mainSha: T, strictCoverage: true });
    await assert.rejects(s.eligibleOf(H), { code: 'TRAIN_STRICT_COMPARE_UNREADABLE' });
  }
  const gone = createSweeper({ github: { async readCompare() { throw Object.assign(new Error(), { code: 'github_http_404' }); } }, appId: APP, mainSha: T, strictCoverage: true });
  await assert.rejects(gone.eligibleOf(H), { code: 'TRAIN_STRICT_COMPARE_UNREADABLE' });
});

test('strict coverage uses the identical gen15 candidate universe, including closed current and force-push history', async t => {
  for (const scope of ['all', 'current']) {
    const e = await setup(t, { strict: true, fullDone: false });
    e.gh.pull(1, { head: sha(11), commits: [sha(11), sha(12)], forcePushes: [{ before: sha(13), after: sha(14) }] });
    e.gh.pull(2, { state: 'closed', merged: false, head: sha(21), commits: [sha(21), sha(22)] });
    e.gh.pull(3, { state: 'closed', merged: true, head: sha(31), commits: [sha(31), sha(32)], forcePushes: [{ before: sha(33), after: sha(34) }] });
    e.gh.pull(4, { state: 'closed', merged: true, base: 'other', head: sha(41), commits: [sha(41), sha(42)] });
    const universes = [];
    for (const strictCoverage of [false, true]) {
      const seen = []; const s = createSweeper({ github: e.gh, appId: APP, mainSha: T, strictCoverage });
      const judge = s.judge;
      const instrumented = { ...s, async judge(heads, options) { seen.push(...heads); return judge(heads, options); } };
      const r = await fullSweepSegment({ sweeper: instrumented, github: e.gh, nextPage: 1, nextIndex: 0, front: { headSha: H }, own: new Map(), scope });
      assert.equal(r.reachedEnd, true); universes.push([...new Set(seen)].sort());
    }
    assert.deepEqual(universes[0], universes[1]); assert.ok(universes[1].includes(sha(21)));
    assert.ok(universes[1].includes(sha(13)) && universes[1].includes(sha(33)) && universes[1].includes(sha(42)));
    assert.equal(universes[1].includes(sha(22)), scope === 'all');
  }
});

test('real maintenance: eligible green double-readback confirmed; deferred behind greens leave full pending and v1 false', async t => {
  const behind = Array.from({ length: 25 }, (_, i) => sha(100 + i)), eligible = sha(999);
  const e = await setup(t, { strict: true, fullDone: false, world: { behindHeads: new Set(behind) } });
  for (const [i, head] of behind.entries()) { e.gh.pull(i + 1, { state: 'closed', head }); e.gh.green(i + 1, head); }
  e.gh.pull(30, { state: 'closed', head: eligible }); e.gh.green(99, eligible);
  const r = await e.run();
  assert.equal(r.facts.sweep.strictCoverage.state, 'ready'); assert.equal(r.facts.sweep.complete, true);
  assert.equal(r.facts.decision, 'OPEN_FRONT_BATCH'); assert.equal(r.facts.openFrontBatch.testSha, S);
  assert.equal(r.facts.sweep.fullSweep.sinceOn, false); assert.equal(r.facts.sweep.fullSweep.state, 'running');
  assert.equal((await e.store.latestProof()).fullSweepSinceOn, false);
  const cert = await e.store.latestStrictProof(); validateStrictProof(cert);
  assert.equal(cert.scope, 'all'); assert.equal(cert.coverage.deferred, 25); assert.equal(e.gh.world.writes[0], 99);
  assert.equal(e.gh.world.reads.get(99), 3); assert.ok([...e.gh.world.checks.values()].some(c => c.conclusion === 'success' && behind.includes(c.head_sha)));
  assert.equal(cert.front.claimId, CLAIM); assert.equal(cert.front.headSha, H);
  assert.ok(Date.parse(cert.writtenAt) <= Date.parse(r.facts.openFrontBatch.since) + 120 * 60_000);
});

test('limited certificate: same-claim new generation rejects old batch and permits a fresh runtime exception binding', async () => {
  const since = iso(NOW - 100_000), writtenAt = iso(NOW - 1000), job = batchJobsV2({ repo: REPO, pr: 910, headSha: H, baseSha: T, testSha: S,
    sourceManifestSha256: SOURCE, createdAt: writtenAt, attempt: 1 })['control-merge-slot'];
  const identity = strictIdentity({ job: jobOf(), holder: { pr: 910, claimId: CLAIM, takenAt: since }, headSha: H, mainSha: T, scope: 'all' });
  const strictProof = { contract: 'clued.independent-ci.train-strict-coverage-proof/1', ...identity, writtenAt, runId: RUN, clean: true,
    enumerationComplete: true, eligibleRevocationsConfirmed: true, unconfirmed: 0, prUpdatedCursor: writtenAt, sweepFreshMs: 900_000, slotHardCapMinutes: 120,
    coverage: { prs: 1, commits: 1, heads: 1, eligible: 1, deferred: 0, revoked: 0 } };
  const proof = { contract: 'clued.independent-ci.train-sweep-proof/1', writtenAt, runId: RUN, mode: 'on', pr: 910, headSha: H, claimId: CLAIM, since,
    mainSha: T, clean: true, unconfirmed: 0, fullSweepSinceOn: false, sweepFreshMs: 900_000, slotHardCapMinutes: 120, prUpdatedCursor: writtenAt };
  validateSweepProof(proof);
  const generation = { claimId: CLAIM, fence: 4, epoch: 7 };
  const input = { job, claimId: CLAIM, holders: { onDuty: true, holders: [{ claimId: CLAIM, taskId: CLAIM,
    boundPrs: [`${REPO}#910`], pr: 910, boundPr: `${REPO}#910`, takenAt: since }] }, proof, strictProof,
    front: { pr: 910, headSha: H, baseSha: T, testSha: S, testTree: TREE, claimId: CLAIM, since }, ledger: { entries: [], refused: [] },
    pulls: { complete: true, pulls: [] }, now: NOW, liveRules: { strict: true }, observedClaim: generation, batchClaim: generation, testTree: TREE };
  assert.equal(trainHeadDecision(input), null);
  for (const holder of [{ ...input.holders.holders[0], taskId: undefined },
    { ...input.holders.holders[0], boundPrs: [] }, { ...input.holders.holders[0], boundPrs: [`${REPO}#911`] }])
    assert.equal(trainHeadDecision({ ...input, holders: { onDuty: true, holders: [holder] } }), TRAIN_SINGLE_GREEN_NOT_PROVEN,
      'legacy scalar PR data never substitutes for the actual Task and Native association');
  for (const patch of [{ liveRules: { strict: false } }, { liveRules: null }, { strictStoreRefused: 1 }, { strictProof: null },
    { batchClaim: { ...generation, fence: 3 } }, { batchClaim: { ...generation, epoch: 6 } }, { testTree: sha(1000) },
    { front: { ...input.front, since: iso(NOW - 90_000) } }, { strictProof: { ...strictProof, sourceManifestSha256: '0'.repeat(64) } },
    { pulls: { complete: true, pulls: [{ number: 1, updatedAt: iso(NOW) }] } }, { now: NOW + 900_001 }])
    assert.equal(trainHeadDecision({ ...input, ...patch }), TRAIN_SINGLE_GREEN_NOT_PROVEN, JSON.stringify(patch));
  assert.throws(() => validateSweepProof({ ...proof, strictProof }), { code: 'invalid_train_sweep_proof' }, 'v1 exact schema stays exact');
});

test('strict store never falls back across a newer round binding or torn strict record', async t => {
  const e = await setup(t, { strict: true, fullDone: false }); await e.run();
  const p = await e.store.latestStrictProof(); assert.ok(p);
  const round = await e.store.readStrictRound();
  await e.store.writeStrictRound({ ...round, writtenAt: iso(NOW + 1000), front: { ...round.front, since: iso(NOW) } });
  assert.equal(await e.store.latestStrictProof(), null);
  await fs.writeFile(path.join(e.store.directory, `strict-proof-${NOW + 2000}-${RUN}-abcdef01.json`), '{');
  await assert.rejects(e.store.latestStrictProof(), { code: 'TRAIN_STRICT_PROOF_UNREADABLE' }); assert.ok(e.store.strictRefused > 0);
});

test('summary and provider quota reject malformed or stale authority-shaped hints', () => {
  const id = strictIdentity({ job: jobOf(), holder: { pr: 910, claimId: CLAIM, takenAt: iso(NOW - 10_000) }, headSha: H, mainSha: T, scope: 'all' });
  const r = strictReadiness({ identity: id, state: 'ready', proofRef: `strict-proof-${NOW}-${RUN}-12345678.json`, writtenAt: iso(NOW), sweepFreshMs: 900_000 });
  assert.equal(validStrictReadiness(r), true); assert.equal(validStrictReadiness({ ...r, expiresAt: iso(NOW) }), false);
  const b = { contract: 'clued.independent-ci.train-provider-budget/1', state: 'ok', requests: 2, restRequests: 1, graphqlRequests: 1,
    rest: { limit: 5000, remaining: 4000, resetAt: iso(NOW + 100_000) }, graphql: { limit: 5000, remaining: 4000, resetAt: iso(NOW + 100_000) },
    retryAt: null, observedAt: iso(NOW), extraSlicesAllowed: true };
  assert.equal(validTrainProviderBudget(b, NOW), true);
  for (const patch of [{ observedAt: iso(NOW - 60_001) }, { observedAt: iso(NOW + 1) }, { rest: null }, { retryAt: iso(NOW + 1) }, { requests: 3 }])
    assert.equal(validTrainProviderBudget({ ...b, ...patch }, NOW), false);
});

test('strict refusal paths: unknown graph, incomplete history, commit cap and rewritten main never mint limited readiness', async t => {
  for (const failure of ['compare', 'history', 'cap', 'rewrite']) {
    const old = sha(501), e = await setup(t, { strict: true, fullDone: false });
    e.gh.pull(1, { head: old, ...(failure === 'history' ? { pushesIncomplete: true } : {}),
      ...(failure === 'cap' ? { commits: Array.from({ length: 251 }, (_, i) => sha(600 + i)) } : {}) });
    e.gh.green(1, old);
    if (failure === 'compare') e.gh.world.hooks.compare = (_base, head) => head === old ? Object.assign(new Error(), { code: 'github_http_502' }) : null;
    if (failure === 'rewrite') {
      await e.store.writeFullSweep({ writtenAt: iso(NOW - 1), runId: RUN, mode: 'on', incrementalCursor: null, inMain: [], mainSha: sha(502), allPending: null,
        full: { state: 'running', via: 'sweep', startedAt: iso(NOW - 10_000), completedAt: null, onSince: jobOf().onSince, mainSha: sha(502), nextPage: 1, nextIndex: 0,
          prs: 0, commits: 0, heads: 0, revoked: 0, unconfirmed: 0, wouldRevoke: 0, calls: 0, ms: 0, reason: null, scope: 'current', scopeReason: null } });
      e.gh.world.hooks.compare = (base, head) => base === sha(502) && head === T ? { status: 'diverged', aheadBy: 1, behindBy: 1 } : null;
    }
    const r = await e.run();
    assert.notEqual(r.facts.sweep.strictCoverage.state, 'ready', failure); assert.equal(await e.store.latestStrictProof(), null, failure);
  }
});

test('an uncertain strict revocation survives a call and must be double-readback confirmed before readiness', async t => {
  const behind = Array.from({ length: 50 }, (_, i) => sha(100 + i)), eligible = sha(999);
  const e = await setup(t, { strict: true, fullDone: false, world: { behindHeads: new Set(behind) } });
  for (const [i, head] of behind.entries()) { e.gh.pull(i + 1, { state: 'closed', head }); e.gh.green(i + 1, head); }
  e.gh.pull(80, { state: 'closed', head: eligible }); e.gh.green(99, eligible);
  e.gh.world.hooks.run = (id, count, actual) => id === 99 && count === 2 ? { ...actual, conclusion: 'success' } : actual;
  const a = await e.run(); assert.notEqual(a.facts.sweep.strictCoverage.state, 'ready');
  assert.deepEqual((await e.store.readStrictRound()).pending.map(t => t.checkRunId), [99]);
  const reads = e.gh.world.reads.get(99), b = await e.run();
  assert.equal(b.facts.sweep.strictCoverage.state, 'ready'); assert.equal((await e.store.readStrictRound()).pending.length, 0);
  assert.ok(e.gh.world.reads.get(99) >= reads + 2, 'failure from the prior write still needs two confirmations');
});

test('budget seeds only on duty; a 180-second advancing all slice refreshes before deadline and no margin stays unknown', async t => {
  for (const onDuty of [false, true]) {
    const e = await setup(t, { strict: false, fullDone: false, native: { onDuty } }); let reads = 0;
    e.gh.readRateBudget = async () => { reads++; };
    await e.run(); assert.equal(reads, onDuty ? 1 : 0);
  }
  for (const exhausted of [false, true]) {
    const e = await setup(t, { strict: true, fullDone: false }); let observed = null, reads = 0;
    const budget = () => { const fresh = observed !== null && e.now - observed <= 60_000; return { contract: 'clued.independent-ci.train-provider-budget/1',
      state: fresh ? 'ok' : 'unknown', requests: reads, restRequests: reads, graphqlRequests: 0,
      rest: { limit: 5000, remaining: 4000, resetAt: iso(NOW + 3_600_000) }, graphql: { limit: 5000, remaining: 4000, resetAt: iso(NOW + 3_600_000) },
      observedAt: observed === null ? null : iso(observed), retryAt: null, extraSlicesAllowed: fresh }; };
    e.gh.readRateBudget = async ({ until }) => { assert.ok(e.now < until); reads++; observed = e.now; return budget(); };
    e.gh.rateBudget = budget;
    for (let i = 1; i < 10; i++) e.gh.pull(i, { head: sha(100 + i) });
    const originalPage = e.gh.readPullsPage; let createdCalls = 0;
    e.gh.readPullsPage = async options => {
      const r = await originalPage(options);
      if (options.sort === 'created' && ++createdCalls === 1) {
        // Finish the first pull, then make the next cursor boundary see the elapsed protected time.
        const judgeTick = e.gh.readOwnChecksByName; let calls = 0;
        e.gh.readOwnChecksByName = async (...args) => { const out = await judgeTick(...args); if (++calls === 1) e.now = NOW + (exhausted ? 250_000 : 180_000); return out; };
      }
      return r;
    };
    const r = await e.run();
    assert.equal(r.facts.sweep.progress?.advanced, true);
    assert.equal(reads, exhausted ? 1 : 2);
    assert.equal(r.facts.sweep.providerBudget.state, exhausted ? 'unknown' : 'ok');
  }
});

test('strict shares the original 150-second sweep budget: a 250-head PR at 250ms per read advances whole', async t => {
  const heads = Array.from({ length: 250 }, (_, i) => sha(10000 + i));
  const e = await setup(t, { strict: true, fullDone: false, tick: 250, world: { behindHeads: new Set(heads) } });
  e.gh.pull(1, { head: heads[0], commits: heads });
  const job = jobOf(), started = e.now;
  const identity = strictIdentity({ job, holder: e.native.holder, headSha: H, mainSha: T, scope: 'all' });
  const r = await runStrictLane({ identity, job, sweepStore: e.store, github: e.gh, native: e.native.port, entries: [], stream: { complete: true, heads: [] },
    own: new Map(), appId: APP, clock: e.clock, sleep: e.sleep, started, until: { write: started + 200_000, read: started + 250_000 }, ledger: e.ledger,
    revokeHead: false, fx: { n: 0 } });
  assert.equal(r.ready, true); assert.equal(r.round.state, 'complete'); assert.equal(r.round.nextIndex, 2);
  assert.ok(e.now - started > 45_000 && e.now - started < 150_000);
});

test('newer torn strict-round refuses reuse and cannot be hidden by minting a fresh proof', async t => {
  const heads = Array.from({ length: 80 }, (_, i) => sha(10000 + i));
  const e = await setup(t, { strict: true, fullDone: false, world: { behindHeads: new Set(heads) } });
  for (const [i, head] of heads.entries()) { e.gh.pull(i + 1, { state: 'closed', head }); e.gh.green(i + 1, head); }
  const first = await e.run(); assert.equal(first.facts.sweep.strictCoverage.state, 'ready'); assert.equal(first.facts.sweep.fullSweep.state, 'running');
  const originalProof = await e.store.latestStrictProof();
  e.now += 2000;
  await fs.writeFile(path.join(e.store.directory, `strict-round-${e.now}-${RUN}-abcdef01.json`), '{');
  await assert.rejects(e.store.readStrictRound(), { code: 'TRAIN_STRICT_STATE_UNREADABLE' });
  const second = await e.run(); assert.notEqual(second.facts.sweep.strictCoverage.state, 'ready');
  assert.equal((await e.store.read('strict-proof', 1))[0].writtenAt, originalProof.writtenAt, 'no newer certificate erases unreadable pending evidence');
  await assert.rejects(e.store.latestStrictProof(), { code: 'TRAIN_STRICT_STATE_UNREADABLE' });
});

test('same-ms low-nonce torn strict records are refused regardless of valid filename order', async t => {
  for (const kind of ['strict-round', 'strict-proof']) {
    const e = await setup(t, { strict: true, fullDone: false }); await e.run();
    const record = (await e.store.read(kind, 1))[0], stamp = Date.parse(record.writtenAt);
    await fs.writeFile(path.join(e.store.directory, `${kind}-${stamp}-${RUN}-ffffffff.json`), canonical(record));
    await fs.writeFile(path.join(e.store.directory, `${kind}-${stamp}-${RUN}-00000000.json`), '{');
    const freshStore = new TrainSweepStore(e.store.directory);
    await assert.rejects(kind === 'strict-round' ? freshStore.readStrictRound() : freshStore.latestStrictProof(),
      { code: kind === 'strict-round' ? 'TRAIN_STRICT_STATE_UNREADABLE' : 'TRAIN_STRICT_PROOF_UNREADABLE' });
    assert.ok(freshStore.strictRefused > 0);
  }
});

test('same-ms contradictory valid strict records cannot use nonce ordering to hide pending state', async t => {
  const e = await setup(t, { strict: true, fullDone: false }); await e.run();
  const record = await e.store.readStrictRound(), stamp = Date.parse(record.writtenAt);
  await fs.writeFile(path.join(e.store.directory, `strict-round-${stamp}-${RUN}-ffffffff.json`), canonical(record));
  const changed = { ...record, state: 'running', pending: [{ checkRunId: 99, headSha: sha(99), reason: 'NOT_FRONT_HEAD', own: false }] };
  await fs.writeFile(path.join(e.store.directory, `strict-round-${stamp}-${RUN}-00000000.json`), canonical(changed));
  await assert.rejects(new TrainSweepStore(e.store.directory).readStrictRound(), { code: 'TRAIN_STRICT_STATE_UNREADABLE' });
});
