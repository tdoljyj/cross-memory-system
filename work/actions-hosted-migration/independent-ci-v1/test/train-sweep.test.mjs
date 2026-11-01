// Stage 10 on, revoke-only and shadow sweeps (step 3c-2b; DESIGN §41.3, §41.4, §41.6, §41.7, §41.9 item 2): who is revoked,
// revoke one with two read-backs, the incremental and the segmented full sweep, the take-over sweep and watermark, the
// Source check, the role for other nodes' greens, keepalive, adopt / return / touch failed, the hard-cap budget and the
// front batch, the sweep proof store and the green ledger cleanup. GitHub and Native are fakes; the ledger and the sweep
// store are the real create-only stores in a temporary directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runTrain, settleTrain } from '../src/independent-control-checks-v2/train-maintenance.mjs';
import { MAX_REVOKES_PER_RUN, REVOKE_READBACK_DELAY_MS, createSweeper, revokeGreens, revokeTargets, publicationHeads } from '../src/independent-control-checks-v2/train-sweep.mjs';
import { trainHeadDecision, TRAIN_SINGLE_GREEN_NOT_PROVEN } from '../src/independent-control-checks-v2/train-rules.mjs';
import { TrainSweepStore, validateSweepProof } from '../src/independent-control-checks-v2/train-sweep-store.mjs';
import { GreenLedger } from '../src/independent-control-checks-v2/green-ledger.mjs';
import { closeGreenLedgerGroups, CLOSE_AFTER_MS } from '../src/independent-control-checks-v2/green-ledger-closed.mjs';
import { validateTrainFacts } from '../src/independent-control-checks-v2/train-facts.mjs';
import { TRAIN_RUN_SHADOW_DEFAULTS, makeTrainRun } from '../src/resident-v2/train-run.mjs';
import { tempDir } from './resident-v2-fixtures.mjs';

const REPO = 'tdoljyj/cross-memory-system', APP = 5368905, SLOT = 'kooyumi-merge-slot';
const sha = n => n.toString(16).padStart(40, '0');
const T = sha(0x7001), H = sha(0x7002), S = sha(0x7003), TREE = sha(0x7004), OLD_T = sha(0x7005);
const CLAIM = '11111111-2222-4333-8444-555555555555', RUN = '0123456789abcdef-0123456789ab', SOURCE = 'e'.repeat(64);
const NOW = Date.parse('2026-10-31T06:00:00.000Z');
const iso = ms => new Date(ms).toISOString();
const ON_SINCE = iso(NOW - 3_600_000), CURSOR = iso(NOW - 600_000);
const jobOf = (o = {}) => makeTrainRun({ repo: REPO, runId: RUN, mode: 'on', sourceManifestSha256: SOURCE, createdAt: iso(NOW), ...TRAIN_RUN_SHADOW_DEFAULTS,
  onSince: ON_SINCE, frontBatchBudgetMs: 1_800_000, ...o });
const summaryOf = base => `front PR #910, head ${H}, main@${base}, tested ${S} (tree ${TREE})`;

// ---- fakes ----
function fakeGithub(e, w) {
  const world = { main: T, inMain: new Set(), checks: new Map(), pulls: new Map(), commits: new Map([[S, { sha: S, tree: TREE, parents: [T, H] }]]), hooks: {}, ...w };
  const call = name => { e.now += e.tick; world.calls.push(name); };
  world.calls = []; world.writes = []; world.reads = new Map();
  const norm = c => ({ id: c.id, appId: c.app.id, name: c.name, headSha: c.head_sha, status: c.status, conclusion: c.conclusion, title: c.output?.title ?? null, summary: c.output?.summary ?? null });
  const row = p => ({ number: p.number, state: p.state, updatedAt: p.updated, headSha: p.head, baseRef: p.base ?? 'main', merged: !!p.merged });
  const gh = {
    world,
    async readBranchHead(name) { call('branch'); return { name, sha: world.main }; },
    async readBranchRules() { call('rules'); return { complete: true, branch: 'main', rules: [{ type: 'pull_request', parameters: { allowed_merge_methods: ['merge'] } },
      { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: ['kooyumi-work-admission', 'gitleaks', 'trivy',
        'contract-placement', 'kooyumi-admission-verified', SLOT].map(context => ({ context, integration_id: APP })) } }] }; },
    async readPullRequest(n) { call('pull'); const p = world.pulls.get(n); return { number: n, state: p.state, draft: false, merged: !!p.merged, mergeable: true,
      merge_commit_sha: p.mergeCommitSha ?? null, head: { sha: p.head }, base: { ref: p.base ?? 'main', sha: world.main } }; },
    async readCompare(base, head) { call('compare'); if (world.behindHeads?.has(head)) return { status: 'diverged', aheadBy: 1, behindBy: 1 }; return world.inMain.has(head) ? { status: 'behind', aheadBy: 0, behindBy: 1 } : { status: 'ahead', aheadBy: 1, behindBy: 0 }; },
    async readGitCommit(s) { call('commit'); return structuredClone(world.commits.get(s)); },
    async readChecks(head) { call('checks'); return { complete: true, checks: [...world.checks.values()].filter(c => c.head_sha === head).map(c => structuredClone(c)) }; },
    async readOwnChecksByName(head, name) {
      call('own'); world.hooks.own?.(head);
      return { complete: true, checks: [...world.checks.values()].filter(c => c.head_sha === head && c.name === name && c.app.id === APP).map(c => structuredClone(c)) };
    },
    async readCheckRun(id) {
      call('run'); const n = (world.reads.get(id) ?? 0) + 1; world.reads.set(id, n);
      const c = world.checks.get(id); if (!c) throw Object.assign(new Error('github_http_404'), { code: 'github_http_404' });
      return world.hooks.run?.(id, n, norm(c)) ?? norm(c);
    },
    async revokeCheck(id, body) {
      call('revoke'); world.writes.push(id); world.hooks.revoke?.(id);
      const c = world.checks.get(id); c.conclusion = body.conclusion; c.output = structuredClone(body.output); return { id };
    },
    async readPullsPage({ state = 'all', sort = 'updated', page = 1, perPage = 100 }) {
      call(`pulls-${sort}`); world.hooks.pullsPage?.(sort, page);
      let list = [...world.pulls.values()].filter(p => state === 'all' || p.state === state);
      list = sort === 'created' ? list.sort((a, b) => a.number - b.number) : list.sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
      const slice = list.slice((page - 1) * perPage, page * perPage);
      return { complete: true, page, pulls: slice.map(row), last: slice.length < perPage };
    },
    async readPullsUpdatedSince(since) {
      call('updated');
      const pulls = [...world.pulls.values()].filter(p => Date.parse(p.updated) >= Date.parse(since)).sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated)).map(row);
      return { complete: world.hooks.updatedIncomplete ? false : true, pulls, newest: pulls[0]?.updatedAt ?? null };
    },
    async readPullCommitsBounded(n) {
      call('commits'); const p = world.pulls.get(n), commits = p.commits ?? [p.head];
      if (commits.length > 250) return { complete: false, tooMany: true, count: commits.length, headSha: p.head, commits: [] };
      return { complete: true, tooMany: false, count: commits.length, headSha: p.head, commits: [...commits] };
    },
    async readForcePushes(n) { call('pushes'); world.hooks.pushes?.(n); return { complete: true, events: structuredClone(world.pulls.get(n).forcePushes ?? []) }; },
  };
  gh.green = (id, head, o = {}) => world.checks.set(id, { id, app: { id: o.app ?? APP }, name: o.name ?? SLOT, head_sha: head, status: 'completed', conclusion: o.conclusion ?? 'success',
    output: { title: 'Complete Native control', summary: o.summary ?? summaryOf(world.main) } });
  gh.pull = (number, o = {}) => world.pulls.set(number, { number, state: 'open', updated: iso(NOW - 3_600_000), head: sha(0x8000 + number), ...o });
  return gh;
}
const holderOf = (o = {}) => ({ claimId: CLAIM, boundPr: `${REPO}#910`, pr: 910, mergeSlotUntil: iso(NOW + 600_000), takenAt: iso(NOW - 300_000), ciState: null, ciHeadSha: null, hardCapUntil: null, ...o });
function fakeNative(e, o = {}) {
  const n = { ...o, calls: [], holder: holderOf(o.holder), onDuty: o.onDuty ?? true, reread: o.reread ?? null, moveUntil: o.moveUntil ?? true };
  n.port = {
    async holders() {
      n.calls.push(['holders']);
      const count = n.calls.filter(c => c[0] === 'holders').length;
      const duty = count > 1 && n.reread !== null ? n.reread : n.onDuty;
      if (!duty) return { onDuty: false, holders: [] };
      return { onDuty: true, holders: n.holders ?? [n.holder] };
    },
    // ci_nodes_status (Source A): not deployed unless the test names nodes; `status` overrides the whole answer
    async nodesStatus() {
      n.calls.push(['nodes']);
      if (n.status instanceof Error) throw n.status;
      if (n.status) return n.status;
      return n.nodes === undefined ? { onDuty: null, deployed: false, nodes: null, dropped: 0, sweepWatermark: null }
        : { onDuty: true, deployed: true, nodes: n.nodes, dropped: n.dropped ?? 0, sweepWatermark: n.watermark ?? null };
    },
    async touch(i) {
      n.calls.push(['touch', i]);
      if (i.ciState === 'running' && n.moveUntil) n.holder = { ...n.holder, mergeSlotUntil: iso(e.now + 90 * 60_000), ciState: 'running', ciHeadSha: i.headSha };
      return { onDuty: true, touched: true, until: n.holder.mergeSlotUntil, claims: [CLAIM], returned: i.ciState === 'failed' ? true : null };
    },
    async adopt(i) { n.calls.push(['adopt', i]); return { onDuty: true, adopted: true, returned: [] }; },
    async returnSlot(i) { n.calls.push(['return', i]); return { onDuty: true, returned: true, claims: [CLAIM] }; },
    async keepalive(i) { n.calls.push(['keepalive', i]); return { onDuty: true, keptAlive: [{ claimId: CLAIM, boundPr: `${REPO}#910`, expiresAt: n.expiresAt ?? iso(e.now + 7_200_000) }] }; },
    async reportSweepWatermark(i) { n.calls.push(['watermark', i]); return { onDuty: true, recorded: n.recorded ?? false, reason: n.recorded ? null : 'SWEEP_WATERMARK_NOT_DEPLOYED' }; },
  };
  n.kinds = () => n.calls.map(c => c[0]);
  return n;
}

async function setup(t, o = {}) {
  const e = { now: NOW, tick: o.tick ?? 0, stream: o.stream ?? [] };
  e.clock = () => e.now;
  e.sleep = async ms => { e.now += ms; };
  e.gh = fakeGithub(e, o.world);
  e.gh.pull(910, { head: H, mergeCommitSha: S, updated: iso(NOW - 7_200_000), ...(o.front ?? {}) });
  e.native = fakeNative(e, o.native);
  const root = await tempDir(t, 'clued-sweep-');
  e.ledger = new GreenLedger((await GreenLedger.open(path.join(root, 'ledger'))).directory, () => e.now);
  e.store = await TrainSweepStore.open(path.join(root, 'sweep'));
  e.publications = { async heads() { if (e.streamDown) throw new Error('down'); return { complete: true, heads: e.stream }; } };
  if (o.fullDone !== false) await e.store.writeFullSweep({ writtenAt: iso(NOW - 1000), runId: RUN, mode: 'on', incrementalCursor: CURSOR, inMain: [],
    full: { ...FULL0, state: 'complete', via: 'sweep', startedAt: iso(NOW - 1_800_000), completedAt: iso(NOW - 1_200_000), onSince: ON_SINCE, mainSha: T } });
  e.run = (job = jobOf(o.job)) => runTrain({ job, github: e.gh, native: e.native.port, ledger: e.ledger, sweepStore: e.store, publications: e.publications, clock: e.clock, sleep: e.sleep });
  return e;
}
const FULL0 = { state: 'none', via: null, startedAt: null, completedAt: null, onSince: null, mainSha: null, nextPage: 1, nextIndex: 0, prs: 0, commits: 0, heads: 0,
  revoked: 0, unconfirmed: 0, wouldRevoke: 0, calls: 0, ms: 0, reason: null };
let keyN = 0;
async function ledgered(ledger, { pr = 900, headSha, baseSha = T, checkRunId, phase = 'settled', detail = null }) {
  const job = { repo: REPO, pr, headSha, baseSha }, effectKey = createHash('sha256').update(`k${checkRunId}:${keyN++}`).digest('hex'), externalId = `independent-ci:control:${checkRunId}`;
  await ledger.append({ phase: 'intent', job, testTree: TREE, effectKey, externalId });
  await ledger.append({ phase, job, testTree: TREE, effectKey, externalId, checkRunId, detail });
  return effectKey;
}

// ---- who is revoked ----
test('who is revoked: not in main and not the front head; the front green when main moved or by request', () => {
  const A = sha(1), M = sha(2);
  const greens = [{ checkRunId: 1, headSha: A }, { checkRunId: 2, headSha: M }, { checkRunId: 3, headSha: H, summary: summaryOf(T) }, { checkRunId: 4, headSha: H, summary: 'no base' }];
  const inMain = new Map([[A, false], [M, true], [H, false]]);
  const own = new Map([[3, { baseSha: T }]]);
  assert.deepEqual(revokeTargets({ greens, inMain, front: { headSha: H }, mainSha: T, own }).targets.map(t => [t.checkRunId, t.reason]),
    [[1, 'NOT_FRONT_HEAD'], [4, 'MAIN_MOVED_OUTSIDE_TRAIN']], 'a green without main@T counts as moved');
  assert.deepEqual(revokeTargets({ greens, inMain, front: { headSha: H }, mainSha: OLD_T, own }).targets.map(t => t.checkRunId), [1, 3, 4], 'main moved outside the train');
  assert.deepEqual(revokeTargets({ greens, inMain, front: { headSha: H }, mainSha: T, own, revokeHead: true }).targets.map(t => [t.checkRunId, t.reason]),
    [[1, 'NOT_FRONT_HEAD'], [3, 'REVOKE_HEAD_REQUEST'], [4, 'REVOKE_HEAD_REQUEST']]);
  assert.deepEqual(revokeTargets({ greens, inMain: new Map([[A, null], [M, true]]), front: null, mainSha: T, own }).unknown, [A, H], 'unknown containment is never guessed');
});

// ---- revoke one ----
test('revoke one: GET, PATCH with the reason, read back, read back 30 s later; the ledger records both read-back times', async t => {
  const e = await setup(t);
  const A = sha(0xa1);
  e.gh.green(11, A);
  const key = await ledgered(e.ledger, { headSha: A, checkRunId: 11 });
  const own = new Map([[11, (await e.ledger.list()).entries.at(-1).entry]]);
  const r = await revokeGreens({ github: e.gh, targets: [{ checkRunId: 11, headSha: A, reason: 'NOT_FRONT_HEAD', own: true }], appId: APP, mainSha: T, ledger: e.ledger, own, clock: e.clock, sleep: e.sleep });
  assert.deepEqual([r.revoked.length, r.unconfirmed, r.sideEffects, e.gh.world.writes], [1, [], 1, [11]]);
  assert.equal(Date.parse(r.revoked[0].secondAt) - Date.parse(r.revoked[0].firstAt), REVOKE_READBACK_DELAY_MS);
  assert.deepEqual(e.gh.world.calls, ['run', 'revoke', 'run', 'run']);
  const last = (await e.ledger.list()).entries.at(-1).entry;
  assert.deepEqual([last.phase, last.effectKey, last.checkRunId, last.detail], ['revoked', key, 11, `revoked2:${r.revoked[0].firstAt},${r.revoked[0].secondAt};NOT_FRONT_HEAD`]);
  assert.match(e.gh.world.checks.get(11).output.summary, /NOT_FRONT_HEAD/);
});

test('revoke one: a failure at the GET, the PATCH, the first or the second read-back leaves it unconfirmed and unledgered', async t => {
  const cases = {
    get: w => { w.hooks.run = (id, n) => { if (n === 1) throw Object.assign(new Error('github_http_502'), { code: 'github_http_502' }); }; },
    'get-other-app': w => { w.hooks.run = (id, n, c) => (n === 1 ? { ...c, appId: 1 } : c); },
    patch: w => { w.hooks.revoke = () => { throw Object.assign(new Error('github_transport_unconfirmed'), { code: 'github_transport_unconfirmed' }); }; },
    first: w => { w.hooks.run = (id, n, c) => (n === 2 ? { ...c, conclusion: 'success' } : c); },
    second: w => { w.hooks.run = (id, n, c) => (n === 3 ? { ...c, summary: 'written by someone else' } : c); },
  };
  for (const [name, hook] of Object.entries(cases)) {
    const e = await setup(t);
    const A = sha(0xa2);
    e.gh.green(12, A);
    await ledgered(e.ledger, { headSha: A, checkRunId: 12 });
    hook(e.gh.world);
    const own = new Map([[12, (await e.ledger.list()).entries.at(-1).entry]]);
    const r = await revokeGreens({ github: e.gh, targets: [{ checkRunId: 12, headSha: A, reason: 'NOT_FRONT_HEAD', own: true }], appId: APP, mainSha: T, ledger: e.ledger, own, clock: e.clock, sleep: e.sleep });
    assert.deepEqual([r.revoked.length, r.unconfirmed.length], [0, 1], name);
    assert.notEqual((await e.ledger.list()).entries.at(-1).entry.phase, 'revoked', name);
  }
  // already failure: no write, revoked once both read-backs show it
  const e = await setup(t);
  e.gh.green(13, sha(0xa3), { conclusion: 'failure' });
  const r = await revokeGreens({ github: e.gh, targets: [{ checkRunId: 13, headSha: sha(0xa3), reason: 'NOT_FRONT_HEAD', own: false }], appId: APP, mainSha: T, ledger: e.ledger, own: new Map(), clock: e.clock, sleep: e.sleep });
  assert.deepEqual([r.revoked.length, r.sideEffects, e.gh.world.writes], [1, 0, []]);
});

test('an unconfirmed revocation: TRAIN_REVOKE_UNCONFIRMED, the proof says unconfirmed, no front batch', async t => {
  const e = await setup(t);
  const A = sha(0xa4);
  e.gh.green(14, A);
  await ledgered(e.ledger, { headSha: A, checkRunId: 14 });
  e.gh.world.hooks.run = (id, n, c) => (n === 3 ? { ...c, conclusion: 'success' } : c);
  const { facts, sideEffects } = await e.run();
  assert.deepEqual([facts.decision, facts.sweep.unconfirmed, facts.openFrontBatch, sideEffects >= 1], ['TRAIN_REVOKE_UNCONFIRMED', 1, null, true]);
  const proof = await e.store.latestProof();
  assert.deepEqual([proof.clean, proof.unconfirmed, proof.pr, proof.headSha, proof.claimId], [false, 1, 910, H, CLAIM]);
  assert.ok(!e.native.kinds().includes('touch'));
});

// ---- the incremental sweep ----
test('incremental sweep: the old head of a force push and of a plain push, greens only other nodes published, reopened and re-based pulls', async t => {
  const A1 = sha(0xb1), A2 = sha(0xb2), B0 = sha(0xb3), B1 = sha(0xb4), C1 = sha(0xc1), C2 = sha(0xc2), C3 = sha(0xc3), D1 = sha(0xd1), E1 = sha(0xe1), F1 = sha(0xf1), M1 = sha(0xf2);
  const e = await setup(t, { stream: [C1, C2, C3, M1] });
  const recent = iso(NOW - 60_000);
  e.gh.pull(901, { head: A2, commits: [A1, A2], updated: recent });
  e.gh.pull(902, { head: B1, commits: [B1], forcePushes: [{ before: B0, after: B1 }, { before: null, after: B1 }], updated: recent });
  e.gh.pull(903, { head: D1, updated: recent });                    // reopened: updated, open again
  e.gh.pull(904, { head: E1, base: 'release', updated: recent });   // its base changed: updated
  e.gh.pull(905, { head: F1, updated: iso(NOW - 3_600_000) });      // not updated since the cursor: the full sweep's
  for (const [id, h] of [[21, A1], [22, B0], [23, C1], [24, C2], [25, C3], [26, D1], [27, E1], [28, F1], [29, M1], [30, H]]) e.gh.green(id, h);
  e.gh.world.inMain.add(M1);
  const { facts } = await e.run();
  const revoked = [...e.gh.world.writes].sort((a, b) => a - b);
  assert.deepEqual(revoked, [21, 22, 23, 24, 25, 26, 27], 'old heads, every node of the stream (three here), reopened and re-based; not in-main, not the front, not outside the cursor');
  assert.deepEqual([facts.sweep.kind, facts.sweep.complete, facts.sweep.revoked, facts.sweep.unconfirmed], ['incremental', true, 7, 0]);
  assert.equal(e.native.kinds().filter(k => k === 'holders').length >= 2, true, 'greens of other nodes: holders read again first');
  assert.deepEqual(facts.wouldRevoke.filter(r => !r.own).map(r => r.checkRunId), [21, 22, 23, 24, 25, 26, 27]);
  // the cursor moved to the newest pull seen; the proof carries it
  assert.equal((await e.store.readFullSweep('on')).incrementalCursor, recent);
  assert.equal((await e.store.latestProof()).prUpdatedCursor, recent);
});

test('incremental sweep fails closed: a stream that cannot be read, an incomplete pulls page, a pull over 250 commits', async t => {
  for (const [name, prep] of [['stream', e => { e.streamDown = true; }], ['pulls', e => { e.gh.world.hooks.updatedIncomplete = true; }],
    ['250', e => { e.gh.pull(906, { head: sha(0xe6), commits: Array.from({ length: 251 }, (_, i) => sha(0x10000 + i)), updated: iso(NOW - 1000) }); }],
    ['ledger', async e => { await fs.writeFile(path.join(e.ledger.directory, 'stray.json'), '{}'); }]]) {
    const e = await setup(t);
    await prep(e);
    const { facts } = await e.run();
    assert.deepEqual([facts.decision, facts.sweep.complete, facts.openFrontBatch], ['TRAIN_SWEEP_INCOMPLETE', false, null], name);
    assert.equal((await e.store.latestProof()).clean, false, name);
    assert.equal((await e.store.readFullSweep('on')).incrementalCursor, CURSOR, `${name}: the cursor stays`);
  }
});

// ---- the role ----
test('others\' greens need the role in the same run; this node\'s own greens do not', async t => {
  const OWN = sha(0xc7), OTHER = sha(0xc8);
  const e = await setup(t, { stream: [OTHER], native: { reread: false } });
  e.gh.green(31, OWN); e.gh.green(32, OTHER);
  await ledgered(e.ledger, { headSha: OWN, checkRunId: 31 });
  const { facts } = await e.run();
  assert.deepEqual([e.gh.world.writes, facts.decision], [[31], 'NOT_ON_DUTY'], 'the re-read said no role: only the own green');
  // no role at all (review R2 M3): the front is unknown, so only own greens that cannot be the front's are revoked: T is not
  // main's tip, or the head is not its PR's current head (closed counts); the current head of an open PR on T stays, as does
  // one whose PR cannot be read; nobody else's green is touched
  const idle = await setup(t, { stream: [OTHER], native: { onDuty: false } });
  const CUR = sha(0xc9), STALE = sha(0xca), GONE = sha(0xcb), FRONTISH = H;
  for (const [id, h] of [[31, OWN], [32, OTHER], [33, CUR], [34, STALE], [35, GONE], [36, FRONTISH]]) idle.gh.green(id, h);
  idle.gh.pull(930, { head: CUR }); idle.gh.pull(931, { head: sha(0xcc) }); idle.gh.pull(932, { head: GONE, state: 'closed' });
  await ledgered(idle.ledger, { headSha: OWN, checkRunId: 31, baseSha: OLD_T });
  await ledgered(idle.ledger, { pr: 930, headSha: CUR, checkRunId: 33 });
  await ledgered(idle.ledger, { pr: 931, headSha: STALE, checkRunId: 34 });
  await ledgered(idle.ledger, { pr: 932, headSha: GONE, checkRunId: 35 });
  await ledgered(idle.ledger, { pr: 910, headSha: FRONTISH, checkRunId: 36 });
  await ledgered(idle.ledger, { pr: 999, headSha: sha(0xcd), checkRunId: 37 });
  idle.gh.green(37, sha(0xcd));
  const off = await idle.run();
  assert.deepEqual([[...idle.gh.world.writes].sort((a, b) => a - b), off.facts.decision, off.facts.onDuty, off.sideEffects], [[31, 34, 35], 'NOT_ON_DUTY', false, 3]);
  assert.ok(!idle.native.kinds().some(k => ['keepalive', 'touch', 'adopt', 'return', 'nodes'].includes(k)));
});

// ---- the front and main ----
test('main moved outside the train: the front\'s own green is revoked and the front batch reopens, counted against the head', async t => {
  const e = await setup(t);
  e.gh.green(41, H, { summary: summaryOf(OLD_T) });
  await ledgered(e.ledger, { pr: 910, headSha: H, baseSha: OLD_T, checkRunId: 41 });
  await e.store.appendFrontBatch({ writtenAt: iso(NOW - 900_000), runId: RUN, pr: 910, headSha: H, baseSha: OLD_T, testSha: S, testTree: TREE, claimId: CLAIM, since: iso(NOW - 300_000), attempt: 1 });
  const { facts } = await e.run();
  assert.deepEqual([e.gh.world.writes, facts.wouldRevoke[0].reason, facts.decision, facts.openFrontBatch?.attempt], [[41], 'MAIN_MOVED_OUTSIDE_TRAIN', 'OPEN_FRONT_BATCH', 2]);
  // a third batch of the same head is refused (the second is over: the CI clock no longer runs on H)
  await e.store.appendFrontBatch({ writtenAt: iso(e.now + 1), runId: RUN, pr: 910, headSha: H, baseSha: T, testSha: S, testTree: TREE, claimId: CLAIM, since: iso(NOW - 300_000), attempt: 2 });
  e.native.holder = { ...e.native.holder, ciState: 'failed', ciHeadSha: H };
  e.native.calls.length = 0;
  const again = await e.run();
  assert.deepEqual([again.facts.decision, e.native.kinds().includes('touch')], ['TRAIN_FRONT_ATTEMPTS_USED', false]);
});

test('revoke-only (under PAUSE): the revoke-head request takes the front\'s current green; no batch, touch, adopt, return or keepalive', async t => {
  const e = await setup(t, { job: { mode: 'revoke-only', onSince: null, revokeHeadRequestId: '22222222-3333-4444-8555-666666666666' } });
  e.gh.green(51, H);
  await ledgered(e.ledger, { pr: 910, headSha: H, checkRunId: 51 });
  e.gh.green(52, sha(0xd5));
  await ledgered(e.ledger, { headSha: sha(0xd5), checkRunId: 52 });
  const { facts } = await e.run();
  assert.deepEqual([e.gh.world.writes.sort(), facts.decision, facts.actions.revokeHead, facts.openFrontBatch], [[51, 52], 'REVOKE_ONLY_DONE',
    { requestId: '22222222-3333-4444-8555-666666666666', done: true }, null]);
  assert.deepEqual(e.native.kinds(), ['holders'], 'no Native write (and no nodes read) in revoke-only');
  assert.equal((await e.store.latestProof()).mode, 'revoke-only');
  validateTrainFacts(facts);
  // without the request the front's current green stays
  const plain = await setup(t, { job: { mode: 'revoke-only', onSince: null } });
  plain.gh.green(51, H);
  await ledgered(plain.ledger, { pr: 910, headSha: H, checkRunId: 51 });
  assert.deepEqual([(await plain.run()).facts.decision, plain.gh.world.writes], ['REVOKE_ONLY_DONE', []]);
});

// ---- the full sweep ----
test('full sweep: segmented over runs within the stage cap, completes, reports the watermark; take-over pending until then', async t => {
  const e = await setup(t, { fullDone: false, tick: 1000, native: { recorded: true } });
  for (let n = 1; n <= 70; n++) e.gh.pull(n, { head: sha(0x20000 + n), updated: iso(NOW - 86_400_000) });
  e.gh.green(61, sha(0x20000 + 65));
  const first = await e.run();
  assert.deepEqual([first.facts.decision, first.facts.sweep.kind, first.facts.sweep.fullSweep.state, first.facts.sweep.fullSweep.sinceOn], ['TRAIN_TAKEOVER_SWEEP_PENDING', 'full-segment', 'running', false]);
  assert.ok(e.native.kinds().includes('keepalive') && !e.native.kinds().includes('touch'), 'keepalive runs while the take-over sweep is pending; no batch');
  assert.ok(e.now - NOW < 300_000, 'one run stays within the 5-minute stage cap');
  const state = await e.store.readFullSweep('on');
  assert.ok(state.full.nextPage === 1 && state.full.nextIndex > 0 && state.full.nextIndex < 70, JSON.stringify(state.full));
  assert.equal((await e.store.latestProof()).fullSweepSinceOn, false);
  e.native.calls.length = 0;
  const second = await e.run();
  assert.deepEqual([second.facts.sweep.fullSweep.state, second.facts.sweep.fullSweep.sinceOn, e.gh.world.writes], ['complete', true, [61]]);
  assert.deepEqual(e.native.calls.find(c => c[0] === 'watermark')?.[1]?.mainSha, T);
  assert.equal(second.facts.actions.watermarkReported, true);
  assert.equal(second.facts.decision, 'OPEN_FRONT_BATCH');
  assert.equal((await e.store.latestProof()).fullSweepSinceOn, true);
});

test('full sweep: a pull over 250 commits voids the round (no restart), a missing page voids it, too old restarts', async t => {
  const long = await setup(t, { fullDone: false });
  long.gh.pull(1, { head: sha(0x30001), commits: Array.from({ length: 251 }, (_, i) => sha(0x31000 + i)), updated: iso(NOW - 86_400_000) });
  const a = await long.run();
  assert.deepEqual([a.facts.decision, a.facts.sweep.fullSweep.state, a.facts.sweep.fullSweep.reason], ['TRAIN_SWEEP_INCOMPLETE', 'abandoned', 'TRAIN_PULL_OVER_250_COMMITS']);
  const a2 = await long.run();
  assert.deepEqual([a2.facts.sweep.fullSweep.state, a2.facts.sweep.fullSweep.reason, a2.facts.decision], ['abandoned', 'TRAIN_PULL_OVER_250_COMMITS', 'TRAIN_TAKEOVER_SWEEP_PENDING'],
    'not restarted: the facts tell the Owner');
  const gap = await setup(t, { fullDone: false });
  gap.gh.world.hooks.pullsPage = sort => { if (sort === 'created') throw Object.assign(new Error('github_http_502'), { code: 'github_http_502' }); };
  const b = await gap.run();
  assert.deepEqual([b.facts.sweep.fullSweep.state, b.facts.sweep.fullSweep.reason, b.facts.decision], ['abandoned', 'TRAIN_SWEEP_INCOMPLETE', 'TRAIN_SWEEP_INCOMPLETE']);
  delete gap.gh.world.hooks.pullsPage;
  assert.equal((await gap.run()).facts.sweep.fullSweep.state, 'complete', 'restarted and completed');
  // a running round older than fullSweepMaxMs (or started before onSince) is abandoned and restarted at once
  const old = await setup(t, { fullDone: false });
  await old.store.writeFullSweep({ writtenAt: iso(NOW - 1000), runId: RUN, mode: 'on', incrementalCursor: CURSOR, inMain: [],
    full: { ...FULL0, state: 'running', via: 'sweep', startedAt: iso(NOW - 22_000_000), onSince: ON_SINCE, mainSha: T, nextPage: 3 } });
  const c = await old.run();
  assert.deepEqual([c.facts.sweep.fullSweep.state, c.facts.sweep.fullSweep.startedAt], ['complete', iso(NOW)]);
  // a complete round from before onSince does not count
  const before = await setup(t, { fullDone: false });
  await before.store.writeFullSweep({ writtenAt: iso(NOW - 1000), runId: RUN, mode: 'on', incrementalCursor: CURSOR, inMain: [],
    full: { ...FULL0, state: 'complete', via: 'sweep', startedAt: iso(NOW - 7_200_000), completedAt: iso(NOW - 7_000_000), onSince: iso(NOW - 9_000_000), mainSha: T } });
  const d = await before.run();
  assert.equal(d.facts.sweep.fullSweep.startedAt, iso(NOW), 'a new round since onSince');
});

test('take-over with a watermark present: still a full on-mode sweep (the stream cannot show other nodes\' published greens; review R2 B1)', async t => {
  const e = await setup(t, { fullDone: false, native: { nodes: [], watermark: { completedAt: iso(NOW - 7_200_000), updatedCursor: iso(NOW - 5_400_000), mainSha: T } } });
  e.gh.pull(920, { head: sha(0x920), updated: iso(NOW - 5_000_000) });
  e.gh.green(71, sha(0x920));
  const { facts } = await e.run();
  assert.equal(facts.sweep.kind, 'full-segment');
  assert.ok(e.gh.world.calls.includes('pulls-created'), 'the full sweep runs');
  assert.equal((await e.store.readFullSweep('on')).full.via, 'sweep');
  assert.ok(facts.decision === 'OPEN_FRONT_BATCH' ? facts.sweep.fullSweep.state === 'complete' : facts.decision === 'TRAIN_TAKEOVER_SWEEP_PENDING');
  // an old record completed "via watermark" never counts as the take-over sweep
  const old = await setup(t, { fullDone: false });
  await old.store.writeFullSweep({ writtenAt: iso(NOW - 1000), runId: RUN, mode: 'on', incrementalCursor: CURSOR, inMain: [],
    full: { ...FULL0, state: 'complete', via: 'watermark', startedAt: iso(NOW - 60_000), completedAt: iso(NOW - 30_000), onSince: ON_SINCE, mainSha: T } });
  const o = await old.run();
  assert.equal(o.facts.sweep.kind, 'full-segment');
  assert.equal((await old.store.readFullSweep('on')).full.via, 'sweep');
});

// ---- Source ----
test('Source check (ci_nodes_status): a node heard within 24 hours on another Source stops on mode; older, never heard, nodeless or not deployed do not; unreadable defers', async t => {
  const entry = (s, ago, o = {}) => ({ bindingId: CLAIM, agentName: 'DESK-W-591', live: true, rank: 1, markedAt: null,
    node: { name: 'DESK-W-591', sourceManifestSha256: s, state: 'NORMAL', mode: 'STANDBY', lastHeartbeatAt: ago === null ? null : iso(NOW - ago) }, ...o });
  const e = await setup(t, { native: { nodes: [entry(SOURCE, 1000), entry('f'.repeat(64), 3_600_000)], dropped: 1 } });
  const { facts, sideEffects } = await e.run();
  assert.deepEqual([facts.decision, sideEffects, e.gh.world.calls, facts.nodes.length, facts.nodesDropped], ['TRAIN_SOURCE_MISMATCH', 0, [], 2, 1]);
  assert.deepEqual(facts.nodes[1], { node: 'DESK-W-591', sourceManifestSha256: 'f'.repeat(64), state: 'NORMAL', lastHeartbeatAt: iso(NOW - 3_600_000) });
  for (const nodes of [[entry('f'.repeat(64), 25 * 3_600_000)], [entry(null, 1000)], [entry('f'.repeat(64), null)], [entry(null, null, { node: null })], [], undefined]) {
    const ok = await setup(t, { native: { nodes } });
    const r = await ok.run();
    assert.equal(r.facts.decision, 'OPEN_FRONT_BATCH', JSON.stringify(nodes));
    validateTrainFacts(r.facts);
  }
  for (const status of [new Error('MERGE_TRAIN_NATIVE_UNREADABLE'), { onDuty: true, deployed: true, nodes: null }]) {
    const x = await setup(t, { native: { status } });
    const r = await x.run();
    assert.deepEqual([r.facts.decision, r.sideEffects, x.gh.world.calls], ['TRAIN_SOURCE_UNREADABLE', 0, []]);
  }
  const lost = await setup(t, { native: { status: { onDuty: false, deployed: true, nodes: null } } });
  assert.deepEqual([(await lost.run()).facts.decision, lost.gh.world.calls], ['NOT_ON_DUTY', []]);
  // shadow and revoke-only never read it
  const sh = await setup(t, { job: { mode: 'shadow', onSince: null }, native: { status: new Error('x') } });
  await sh.run();
  assert.ok(!sh.native.kinds().includes('nodes'));
});

// ---- scheduling ----
test('front batch: proof, budget, touch running, the moved clock read back, then the batch with T, H, S and S\'s tree', async t => {
  const e = await setup(t);
  const { facts, sideEffects } = await e.run();
  assert.deepEqual(facts.openFrontBatch, { pr: 910, headSha: H, baseSha: T, testSha: S, testTree: TREE, claimId: CLAIM, since: iso(NOW - 300_000), attempt: 1 });
  assert.deepEqual(e.native.kinds(), ['holders', 'nodes', 'keepalive', 'touch', 'holders']);
  assert.deepEqual(e.native.calls[3][1], { pr: 910, headSha: H, ciState: 'running', hardCapMinutes: 120 });
  assert.deepEqual(e.native.calls[2][1].prs, [910]);
  assert.deepEqual([facts.actions.touchedRunning, facts.actions.keptAlive, sideEffects], [true, 1, 2]);
  const proof = validateSweepProof(await e.store.latestProof());
  assert.deepEqual([proof.mode, proof.pr, proof.headSha, proof.claimId, proof.since, proof.mainSha, proof.clean, proof.unconfirmed, proof.fullSweepSinceOn, proof.slotHardCapMinutes, proof.sweepFreshMs],
    ['on', 910, H, CLAIM, iso(NOW - 300_000), T, true, 0, true, 120, 900_000]);
  assert.equal((await e.store.frontBatches({ pr: 910, headSha: H })).length, 1);
});

test('front batch refused: a 40-minute front under a 60-minute cap, a lease too short, a clock that did not move, an incomplete sweep', async t => {
  const waited = await setup(t, { job: { slotHardCapMinutes: 60 }, native: { holder: { takenAt: iso(NOW - 40 * 60_000) } } });
  assert.deepEqual([(await waited.run()).facts.decision, waited.native.kinds().includes('touch')], ['TRAIN_FRONT_BUDGET_SHORT', false]);
  const lease = await setup(t, { native: { expiresAt: iso(NOW + 20 * 60_000) } });
  assert.equal((await lease.run()).facts.decision, 'TRAIN_FRONT_BUDGET_SHORT');
  const stuck = await setup(t, { native: { moveUntil: false } });
  const s = await stuck.run();
  assert.deepEqual([s.facts.decision, s.facts.actions.touchedRunning, s.facts.openFrontBatch], ['TRAIN_FRONT_BUDGET_SHORT', true, null]);
  assert.equal((await stuck.store.frontBatches({ pr: 910, headSha: H })).length, 0, 'no batch, no attempt counted');
  const torn = await setup(t);
  torn.streamDown = true;
  assert.deepEqual([(await torn.run()).facts.openFrontBatch, torn.native.kinds().includes('touch')], [null, false], 'S only after a confirmed sweep');
});

test('a front batch longer than sweepFreshMs: the next stage 10 refreshes the proof, opens nothing and counts no attempt; stage 8 then proves the green (review R2 M1)', async t => {
  const e = await setup(t);
  const first = await e.run();
  assert.equal(first.facts.openFrontBatch.attempt, 1);
  const frontJob = { repo: REPO, pr: 910, headSha: H, baseSha: T, testSha: S };
  const stage8 = async () => trainHeadDecision({ job: frontJob, claimId: CLAIM, holders: { onDuty: true, holders: [e.native.holder] }, proof: await e.store.latestProof(),
    storeRefused: e.store.refused, front: (await e.store.frontBatches({ pr: 910, headSha: H }))[0], ledger: await e.ledger.list(), pulls: { complete: true, pulls: [] }, now: e.now });
  assert.equal(await stage8(), null, 'fresh at first');
  e.now += 20 * 60_000;
  assert.equal(await stage8(), TRAIN_SINGLE_GREEN_NOT_PROVEN, 'older than sweepFreshMs: parked in B');
  e.native.calls.length = 0;
  const again = await e.run();
  assert.deepEqual([again.facts.decision, again.facts.openFrontBatch, again.facts.actions.touchedRunning, e.native.kinds().includes('touch')],
    ['TRAIN_FRONT_BATCH_RUNNING', null, false, false]);
  validateTrainFacts(again.facts);
  assert.equal((await e.store.frontBatches({ pr: 910, headSha: H })).length, 1, 'no attempt 2');
  assert.equal(await stage8(), null, 'the refreshed proof covers the running batch');
  // a new S (main moved), a finished attempt (frontOutcome) or a clock no longer running: not the running batch
  e.native.holder = { ...e.native.holder, ciState: null };
  assert.equal((await e.run()).facts.decision, 'OPEN_FRONT_BATCH');
  assert.equal((await e.store.frontBatches({ pr: 910, headSha: H }))[0].attempt, 2);
});

test('incremental sweep: a backlog advances run by run; the head bound counts only heads not in main; one big pull still advances (review R2 M2)', async t => {
  const e = await setup(t);
  // 30 pulls updated since the cursor, 20 heads each (600 > MAX_SWEEP_HEADS 400)
  for (let n = 1; n <= 30; n++) e.gh.pull(1000 + n, { head: sha(0x60000 + n * 100), commits: Array.from({ length: 20 }, (_, i) => sha(0x60000 + n * 100 + i)), updated: iso(NOW - 500_000 + n * 1000) });
  const first = await e.run();
  assert.deepEqual([first.facts.decision, first.facts.sweep.complete], ['TRAIN_SWEEP_INCOMPLETE', false]);
  const c1 = (await e.store.readFullSweep('on')).incrementalCursor;
  assert.ok(Date.parse(c1) > Date.parse(CURSOR) && Date.parse(c1) < Date.parse(iso(NOW - 500_000 + 30_000)), c1);
  e.now += 60_000;
  const second = await e.run();
  assert.equal(second.facts.sweep.complete, true, 'the rest fits in the second run');
  assert.equal((await e.store.readFullSweep('on')).incrementalCursor, iso(NOW - 500_000 + 30_000));
  // heads known to be in main are not counted: 600 heads, all in main, complete in one run
  const inMain = await setup(t);
  const heads = [];
  for (let n = 1; n <= 30; n++) { const c = Array.from({ length: 20 }, (_, i) => sha(0x70000 + n * 100 + i)); heads.push(...c); inMain.gh.pull(2000 + n, { head: c[19], commits: c, updated: iso(NOW - 1000) }); }
  await inMain.store.writeFullSweep({ writtenAt: iso(NOW - 500), runId: RUN, mode: 'on', incrementalCursor: CURSOR, inMain: heads,
    full: { ...FULL0, state: 'complete', via: 'sweep', startedAt: iso(NOW - 1_800_000), completedAt: iso(NOW - 1_200_000), onSince: ON_SINCE, mainSha: T } });
  assert.equal((await inMain.run()).facts.sweep.complete, true);
  // one pull over the bound by itself is taken whole (the first step of a run)
  const big = await setup(t);
  big.gh.pull(3001, { head: sha(0x80000 + 249), commits: Array.from({ length: 250 }, (_, i) => sha(0x80000 + i)),
    forcePushes: Array.from({ length: 200 }, (_, i) => ({ before: sha(0x90000 + i), after: sha(0x80000 + 249) })), updated: iso(NOW - 1000) });
  assert.equal((await big.run()).facts.sweep.complete, true);
});

test('the protected layer: a front whose H does not contain T needs main merged in first, in mode on only (review R2 M4)', async t => {
  const mk = async (o = {}) => {
    const e = await setup(t, o);
    e.gh.world.behindHeads = new Set([H]);
    e.gh.readChangedPaths = async job => { e.gh.world.calls.push('paths'); if (e.gh.world.pathsDown) throw new Error('x'); assert.deepEqual([job.pr, job.headSha, job.baseSha], [910, H, T]);
      return { complete: true, paths: e.gh.world.paths ?? ['scripts/ci/x.mjs'] }; };
    return e;
  };
  const layerOfPaths = paths => (paths.some(p => p.startsWith('scripts/ci/')) ? 'protected' : 'code');
  const run = e => runTrain({ job: jobOf(e.jobO), github: e.gh, native: e.native.port, ledger: e.ledger, sweepStore: e.store, publications: e.publications, clock: e.clock, sleep: e.sleep, layerOfPaths });
  const p = await mk();
  const r = await run(p);
  assert.deepEqual([r.facts.decision, r.facts.openFrontBatch, p.native.kinds().includes('touch')], ['FRONT_NEEDS_MAIN_MERGE', null, false]);
  const code = await mk(); code.gh.world.paths = ['apps/x.ts'];
  assert.equal((await run(code)).facts.decision, 'OPEN_FRONT_BATCH', 'the code layer does not need it (strict is off)');
  const down = await mk(); down.gh.world.pathsDown = true;
  assert.equal((await run(down)).facts.decision, 'FRONT_NEEDS_MAIN_MERGE', 'paths that cannot be read count as protected');
  const sh = await mk(); sh.jobO = { mode: 'shadow', onSince: null };
  const s = await run(sh);
  assert.ok(!sh.gh.world.calls.includes('paths') && s.facts.wouldDo === 'OPEN_FRONT_BATCH', 'shadow is as before');
});

test('settleTrain: after a write, a later failure ends UNCERTAIN with the true count; before any write it throws as before (review R2 M5)', async t => {
  const e = await setup(t);
  const out = await e.run();
  assert.ok(out.sideEffects > 0);
  const fail = code => () => { throw Object.assign(new Error(code), { code }); };
  const a = await settleTrain({ run: async () => out, live: () => {}, append: fail('EACCES') });
  assert.deepEqual([a.status, a.reason, a.sideEffects, a.train.decision], ['UNCERTAIN', 'EACCES', out.sideEffects, 'OPEN_FRONT_BATCH']);
  const b = await settleTrain({ run: async () => out, live: fail('HELD_RECORD_LEASE_LOST'), append: async () => {} });
  assert.deepEqual([b.status, b.sideEffects], ['UNCERTAIN', out.sideEffects]);
  const c = await settleTrain({ run: async () => { throw Object.assign(new Error('invalid_train_facts'), { code: 'invalid_train_facts', sideEffects: 2 }); }, live: () => {}, append: async () => {} });
  assert.deepEqual([c.status, c.reason, c.sideEffects], ['UNCERTAIN', 'invalid_train_facts', 2]);
  await assert.rejects(settleTrain({ run: async () => ({ ...out, sideEffects: 0 }), live: () => {}, append: fail('EACCES') }), e2 => e2.code === 'EACCES');
  const d = await settleTrain({ run: async () => out, live: () => {}, append: async () => {}, retain: fail('x') });
  assert.deepEqual([d.status, d.sideEffects], ['TRAIN_FACTS', out.sideEffects]);
  // runTrain itself: a throw after a write carries the count (here: the touch answer is not a reply the facts accept)
  const x = await setup(t);
  x.native.port.touch = async () => ({ onDuty: true, touched: true });
  x.native.port.holders = (h => async () => { const r = await h(); if (x.native.calls.filter(c => c[0] === 'holders').length > 1) throw Object.assign(new Error('boom'), { code: 'boom' }); return r; })(x.native.port.holders);
  const xs = await settleTrain({ run: () => x.run(), live: () => {}, append: async () => {} });
  assert.equal(xs.status, 'TRAIN_FACTS', 'a failing read-back after touch running is a decision, not a throw');
  assert.equal(xs.train.decision, 'TRAIN_FRONT_BUDGET_SHORT');
});

test('revocations and the ledger cleanup stop at the stage deadlines; what is left is unconfirmed (review R2 minor 5)', async t => {
  const e = await setup(t);
  for (let i = 0; i < 3; i++) e.gh.green(200 + i, sha(0xab00 + i));
  const targets = [0, 1, 2].map(i => ({ checkRunId: 200 + i, headSha: sha(0xab00 + i), reason: 'NOT_FRONT_HEAD', own: false }));
  const r = await revokeGreens({ github: e.gh, targets, appId: APP, mainSha: T, ledger: null, own: new Map(), clock: e.clock, sleep: e.sleep, writeUntil: e.now - 1, readUntil: e.now + 1e9 });
  assert.deepEqual([r.revoked.length, r.unconfirmed.map(u => u.code), e.gh.world.writes], [0, ['TRAIN_REVOKE_DEADLINE', 'TRAIN_REVOKE_DEADLINE', 'TRAIN_REVOKE_DEADLINE'], []]);
  const late = await revokeGreens({ github: e.gh, targets: targets.slice(0, 1), appId: APP, mainSha: T, ledger: null, own: new Map(), clock: e.clock, sleep: e.sleep, readUntil: e.now + 10 });
  assert.deepEqual([late.revoked.length, late.unconfirmed[0].code, late.sideEffects], [0, 'TRAIN_REVOKE_DEADLINE', 1]);
  const dir = (await GreenLedger.open(path.join(await tempDir(t), 'ledger'))).directory, ledger = new GreenLedger(dir, () => NOW - CLOSE_AFTER_MS - 86_400_000);
  await ledgered(ledger, { headSha: sha(0xe1), checkRunId: 1, phase: 'revoked', detail: `revoked2:${iso(NOW)},${iso(NOW)};X` });
  assert.deepEqual(await closeGreenLedgerGroups({ ledger, inMain: async () => true, now: NOW, deadline: NOW - 1, clock: () => NOW }), { closed: 0, files: 0 });
});

test('a compare GitHub answers 404 for (gone or unrelated history) is "not in main" and revoked; other failures stay unknown (review R2 minor 9)', async t => {
  const e = await setup(t);
  const GONE = sha(0xdead), ERR = sha(0xbeef);
  const compare = e.gh.readCompare;
  e.gh.readCompare = async (b, h) => { if (h === GONE) throw Object.assign(new Error('github_http_404'), { code: 'github_http_404' }); if (h === ERR) throw Object.assign(new Error('github_http_502'), { code: 'github_http_502' }); return compare(b, h); };
  const sweeper = createSweeper({ github: e.gh, appId: APP, mainSha: T });
  assert.deepEqual([await sweeper.inMainOf(GONE), await sweeper.inMainOf(ERR)], [false, null]);
});

test('touch failed only from frontOutcome, while this claim is the front and the head is still H', async t => {
  const outcome = { frontPr: 910, frontHeadSha: H, frontTestSha: S, frontAttempt: 2, frontCode: 'GITLEAKS_FINDINGS' };
  const e = await setup(t, { job: outcome });
  const { facts } = await e.run();
  assert.deepEqual([facts.decision, facts.actions.failedReported, e.native.calls.find(c => c[0] === 'touch')[1]], ['FRONT_FAILED_REPORTED', true,
    { pr: 910, headSha: H, ciState: 'failed', reason: 'GITLEAKS_FINDINGS' }]);
  for (const o of [{ front: { head: sha(0x777) } }, { native: { holder: { pr: 911, boundPr: `${REPO}#911` } } }]) {
    const x = await setup(t, { job: outcome, ...o });
    if (o.native) x.gh.pull(911, { head: sha(0x911) });
    await x.run();
    assert.ok(!x.native.calls.some(c => c[0] === 'touch' && c[1].ciState === 'failed'), JSON.stringify(o));
  }
});

test('adopt when merged as [T, H] with S\'s tree; a different tree pauses the train; return only when closed unmerged', async t => {
  const M = sha(0x9001);
  const merged = await setup(t, { front: { state: 'closed', merged: true, mergeCommitSha: M } });
  merged.gh.world.commits.set(M, { sha: M, tree: TREE, parents: [T, H] });
  merged.gh.world.inMain.add(H);
  await merged.store.appendFrontBatch({ writtenAt: iso(NOW - 900_000), runId: RUN, pr: 910, headSha: H, baseSha: T, testSha: S, testTree: TREE, claimId: CLAIM, since: iso(NOW - 300_000), attempt: 1 });
  const a = await merged.run();
  assert.deepEqual([a.facts.decision, merged.native.calls.find(c => c[0] === 'adopt')[1]], ['FRONT_ADOPTED', { pr: 910, mergeSha: M }]);
  // no record of this node: the green's own summary names T, S and the tree
  const told = await setup(t, { front: { state: 'closed', merged: true, mergeCommitSha: M } });
  told.gh.world.commits.set(M, { sha: M, tree: TREE, parents: [T, H] });
  told.gh.world.inMain.add(H);
  told.gh.green(81, H);
  assert.equal((await told.run()).facts.decision, 'FRONT_ADOPTED');
  const differs = await setup(t, { front: { state: 'closed', merged: true, mergeCommitSha: M } });
  differs.gh.world.commits.set(M, { sha: M, tree: sha(0xbad), parents: [T, H] });
  differs.gh.world.inMain.add(H);
  differs.gh.green(81, H);
  const d = await differs.run();
  assert.deepEqual([d.facts.decision, d.facts.requestPause, differs.native.kinds().includes('adopt')], ['TRAIN_LANDED_TREE_MISMATCH', 'TRAIN_LANDED_TREE_MISMATCH', false]);
  const closed = await setup(t, { front: { state: 'closed' } });
  const c = await closed.run();
  assert.deepEqual([c.facts.decision, closed.native.calls.find(x => x[0] === 'return')[1]], ['FRONT_RETURNED', { pr: 910 }]);
  const moved = await setup(t, { front: { head: sha(0x778), mergeCommitSha: null } });
  await moved.run();
  assert.ok(!moved.native.kinds().includes('return'), 'a new head stays the front');
});

// ---- shadow ----
test('shadow: the sweeps compute what they would revoke, write nothing to GitHub or KooYomi, and never count for on', async t => {
  const e = await setup(t, { fullDone: false, stream: [sha(0xc9)], job: { mode: 'shadow', onSince: null } });
  e.gh.green(91, sha(0xc9)); e.gh.green(92, sha(0x8000 + 3));
  e.gh.pull(3, {});
  const { facts, sideEffects } = await e.run();
  assert.deepEqual([sideEffects, e.gh.world.writes, e.native.kinds()], [0, [], ['holders']]);
  assert.deepEqual([facts.mode, facts.wouldRevokeCount, facts.sweep.revoked, facts.sweep.fullSweep.state, facts.sweep.proofWritten], ['shadow', 2, 0, 'complete', false]);
  assert.ok(facts.sweep.calls > 0);
  assert.equal(await e.store.latestProof(), null);
  assert.equal(await e.store.readFullSweep('on'), null, 'a shadow round is recorded apart');
  assert.equal((await e.store.readFullSweep('shadow')).full.state, 'complete');
});

// ---- the proof store ----
test('sweep store: create-only, the newest valid proof, torn or foreign files counted and ignored', async t => {
  const store = await TrainSweepStore.open(path.join(await tempDir(t), 'sweep'));
  const proof = { writtenAt: iso(NOW), runId: RUN, mode: 'on', pr: 910, headSha: H, claimId: CLAIM, since: iso(NOW - 1000), mainSha: T, clean: true, unconfirmed: 0,
    fullSweepSinceOn: true, slotHardCapMinutes: 120, sweepFreshMs: 900_000, prUpdatedCursor: CURSOR };
  await store.appendProof(proof);
  await store.appendProof({ ...proof, writtenAt: iso(NOW + 1000), clean: false, unconfirmed: 2 });
  for (const bad of [{ ...proof, clean: true, unconfirmed: 1 }, { ...proof, mode: 'shadow' }, { ...proof, since: null }, { ...proof, extra: 1 }])
    await assert.rejects(store.appendProof(bad), e => e.code === 'invalid_train_sweep_proof');
  await fs.writeFile(path.join(store.directory, `proof-${String(NOW + 5000).padStart(13, '0')}-${RUN}-00000000.json`), '{"torn":');
  const latest = await store.latestProof();
  assert.deepEqual([latest.writtenAt, latest.clean, store.refused], [iso(NOW + 1000), false, 1]);
  const files = (await fs.readdir(store.directory)).filter(n => n.startsWith('proof-'));
  assert.equal(files.length, 3);
  // review R1 m3: a foreign name never counts; a torn front batch counts only when newer than the newest valid proof
  const quiet = await TrainSweepStore.open(path.join(await tempDir(t), 'sweep'));
  await quiet.appendProof(proof);
  await fs.writeFile(path.join(quiet.directory, 'desktop.ini'), 'x');
  await fs.writeFile(path.join(quiet.directory, `front-${String(NOW - 5000).padStart(13, '0')}-${RUN}-00000000.json`), '{"torn":');
  await quiet.latestProof(); await quiet.frontBatches({ pr: 910, headSha: H });
  assert.deepEqual([quiet.refused, quiet.foreign, quiet.torn], [0, 1, 1]);
  await fs.writeFile(path.join(quiet.directory, `front-${String(NOW + 5000).padStart(13, '0')}-${RUN}-00000001.json`), '{"torn":');
  await quiet.frontBatches({ pr: 910, headSha: H });
  assert.equal(quiet.refused, 1);
});

// ---- ledger cleanup ----
test('ledger cleanup: twice-confirmed revoked or merged with the head in main, older than 14 days, moves whole to closed\\<yyyy-mm>', async t => {
  let now = NOW - CLOSE_AFTER_MS - 86_400_000;
  const dir = (await GreenLedger.open(path.join(await tempDir(t), 'ledger'))).directory, ledger = new GreenLedger(dir, () => now);
  const A = sha(0xe1), B = sha(0xe2), C = sha(0xe3), D = sha(0xe4);
  await ledgered(ledger, { headSha: A, checkRunId: 1, phase: 'revoked', detail: `revoked2:${iso(now)},${iso(now + 30_000)};NOT_FRONT_HEAD` });
  await ledgered(ledger, { headSha: B, checkRunId: 2, phase: 'revoked', detail: 'Reconcile Native admission check' });   // stage 8's own, read back once
  await ledgered(ledger, { headSha: C, checkRunId: 3, phase: 'merged' });
  await ledgered(ledger, { headSha: D, checkRunId: 4, phase: 'merged' });
  now = NOW;
  await ledgered(ledger, { headSha: sha(0xe5), checkRunId: 5, phase: 'revoked', detail: `revoked2:${iso(now)},${iso(now)};X` });   // too young
  const r = await closeGreenLedgerGroups({ ledger, inMain: async h => h === C, now });
  assert.deepEqual(r, { closed: 2, files: 4 });
  const { entries, refused } = await ledger.list();
  assert.deepEqual([refused, [...new Set(entries.map(x => x.entry.checkRunId).filter(Boolean))].sort()], [[], [2, 4, 5]], 'closed\\ is not listed');
  const month = iso(NOW - CLOSE_AFTER_MS - 86_400_000).slice(0, 7);
  assert.equal((await fs.readdir(path.join(dir, 'closed', month))).length, 4);
});

// ---- publication stream ----
test('publication stream: every page, this repository only, an unreadable page refused', async () => {
  const pages = [{ status: 'ok', revocations: [], publications: [{ repository: REPO, head_sha: sha(1) }, { repository: 'other/repo', head_sha: 'x' }], next_publication_cursor: 'b' },
    { status: 'ok', revocations: [], publications: [{ repository: REPO, head_sha: sha(2) }], next_publication_cursor: null }];
  const seen = [];
  const p = publicationHeads({ command: async i => { seen.push(i); return pages[seen.length - 1]; }, scope: 'project:p', repository: REPO });
  assert.deepEqual(await p.heads(), { complete: true, heads: [sha(1), sha(2)] });
  assert.deepEqual(seen.map(s => s.publication_cursor ?? null), [null, 'b']);
  const bad = publicationHeads({ command: async () => ({ status: 'ok', publications: [] }), scope: 'p', repository: REPO });
  await assert.rejects(bad.heads(), e => e.code === 'TRAIN_PUBLICATIONS_UNREADABLE');
  assert.equal(MAX_REVOKES_PER_RUN, 20);
});

// ---- the GitHub reads (github.mjs) and the shadow wiring over the real ports ----
async function realPort(handler, now = NOW) {
  const { generateKeyPairSync } = await import('node:crypto');
  const { createGitHubChecksPort } = await import('../src/github.mjs');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const seen = [];
  const reply = body => ({ ok: true, status: 200, json: async () => body });
  const fetchImpl = async (url, options = {}) => {
    const u = new URL(url), method = options.method ?? 'GET';
    seen.push(`${method} ${u.host}${u.pathname}${u.search}`);
    if (method === 'POST' && u.pathname === '/app/installations/99/access_tokens')
      return reply({ token: 't', expires_at: iso(now + 3_600_000), permissions: { checks: 'write', contents: 'read', pull_requests: 'read', actions_variables: 'read', environments: 'read', metadata: 'read' } });
    if (u.pathname === '/app') return reply({ id: 77 });
    if (u.pathname === '/installation/repositories') return reply({ total_count: 1, repositories: [{ id: 41, full_name: REPO }] });
    const body = await handler(u, method, options.body ? JSON.parse(options.body) : null);
    if (body === undefined) throw new Error(`unexpected ${method} ${u.pathname}${u.search}`);
    return body?.json ? body : reply(body);
  };
  return { port: createGitHubChecksPort({ repository: REPO, repositoryId: 41, appId: 77, installationId: 99, includeModeRead: true, privateKeyProvider: async () => privateKey, fetchImpl, clock: () => now }), seen, fetchImpl };
}
const pullRow = (n, updated, head = sha(0x40000 + n), state = 'open') => ({ number: n, state, updated_at: updated, head: { sha: head }, base: { ref: 'main' }, merged_at: null });

test('github.mjs sweep reads: pulls updated since a cursor across pages, 250-commit pulls, force pushes over GraphQL, own checks, one check run', async () => {
  const base = `/repos/${REPO}`;
  const pages = { 1: Array.from({ length: 100 }, (_, i) => pullRow(1000 - i, iso(NOW - i * 1000))), 2: [pullRow(800, iso(NOW - 200_000)), pullRow(799, iso(NOW - 900_000))] };
  const { port, seen } = await realPort(async (u, method, body) => {
    if (u.pathname === `${base}/pulls`) return pages[u.searchParams.get('page')] ?? [];
    if (u.pathname === `${base}/pulls/5`) return { number: 5, commits: 251, head: { sha: sha(5) } };
    if (u.pathname === `${base}/pulls/6`) return { number: 6, commits: 2, head: { sha: sha(6) } };
    if (u.pathname === `${base}/pulls/6/commits`) return [{ sha: sha(60) }, { sha: sha(6) }];
    if (method === 'POST' && u.pathname === '/graphql') {
      if (body.variables.number === 7) return { errors: [{ message: 'rate limited' }] };
      assert.match(body.query, /filteredCount/);
      return body.variables.after === null
        ? { data: { repository: { pullRequest: { timelineItems: { totalCount: 20, filteredCount: 2, pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [{ beforeCommit: { oid: sha(61) }, afterCommit: { oid: sha(62) } }] } } } } }
        : { data: { repository: { pullRequest: { timelineItems: { totalCount: 21, filteredCount: 1, pageInfo: { hasNextPage: false, endCursor: 'c2' }, nodes: [{ beforeCommit: null, afterCommit: { oid: sha(6) } }] } } } } };
    }
    if (u.pathname === `${base}/check-runs/12`) return { id: 12, app: { id: 77 }, name: SLOT, head_sha: sha(6), status: 'completed', conclusion: 'success', output: { title: 'a', summary: 'b' } };
    if (u.pathname === `${base}/commits/${sha(6)}/check-runs`) return { total_count: 1, check_runs: [{ id: 12, app: { id: 77 }, name: SLOT, head_sha: sha(6), status: 'completed', conclusion: 'success' }] };
  });
  const since = await port.readPullsUpdatedSince(iso(NOW - 300_000));
  assert.deepEqual([since.complete, since.pulls.length, since.newest], [true, 101, iso(NOW)], 'stops at the first pull older than the cursor');
  assert.ok(seen.some(s => s.includes('/pulls?state=all&sort=updated&direction=desc&per_page=100&page=2')));
  assert.deepEqual(await port.readPullCommitsBounded(5), { complete: false, tooMany: true, count: 251, headSha: sha(5), commits: [] });
  assert.deepEqual((await port.readPullCommitsBounded(6)).commits, [sha(60), sha(6)]);
  assert.deepEqual(await port.readForcePushes(6), { complete: true, events: [{ before: sha(61), after: sha(62) }, { before: null, after: sha(6) }] });
  await assert.rejects(port.readForcePushes(7), e => e.code === 'force_push_events_unconfirmed', 'a GraphQL error is refused');
  assert.deepEqual(await port.readCheckRun(12), { id: 12, appId: 77, name: SLOT, headSha: sha(6), status: 'completed', conclusion: 'success', title: 'a', summary: 'b' });
  assert.equal((await port.readOwnChecksByName(sha(6), SLOT)).checks.length, 1);
  assert.ok(seen.some(s => s.includes(`/commits/${sha(6)}/check-runs?app_id=77&check_name=${SLOT}&filter=all`)));
  await assert.rejects(port.readPullsPage({ state: 'merged' }), e => e.code === 'invalid_pulls_request');
});

test('github.mjs force pushes: unrelated timeline items do not make an empty filtered history incomplete', async () => {
  const { port } = await realPort(async (u, method, body) => {
    if (u.pathname === '/graphql') {
      assert.match(body.query, /filteredCount/);
      return { data: { repository: { pullRequest: { timelineItems: { totalCount: 20, filteredCount: 0,
        pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } };
    }
  });
  assert.deepEqual(await port.readForcePushes(1), { complete: true, events: [] });
});

test('github.mjs force pushes: a terminal page missing a matching event is refused', async () => {
  const { port } = await realPort(async u => {
    if (u.pathname === '/graphql') return { data: { repository: { pullRequest: { timelineItems: { totalCount: 20, filteredCount: 2,
      pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ beforeCommit: null, afterCommit: { oid: sha(6) } }] } } } } };
  });
  await assert.rejects(port.readForcePushes(1), e => e.code === 'force_push_events_unconfirmed');
});

test('github.mjs force pushes: a changed remaining matching count across pages is refused', async () => {
  const { port } = await realPort(async (u, method, body) => {
    if (u.pathname === '/graphql') return { data: { repository: { pullRequest: { timelineItems: { totalCount: 20,
      filteredCount: 2, pageInfo: { hasNextPage: body.variables.after === null, endCursor: 'c1' },
      nodes: [{ beforeCommit: null, afterCommit: { oid: sha(6) } }] } } } } };
  });
  await assert.rejects(port.readForcePushes(1), e => e.code === 'force_push_events_unconfirmed');
});

test('shadow over the real GitHub and KooYomi ports: every GitHub call a read (GraphQL is a read), the one KooYomi call the holders read', async t => {
  const { createMergeSlotNative, HOLDERS_RPC } = await import('../src/independent-control-checks-v2/merge-slot-native.mjs');
  const base = `/repos/${REPO}`, OLDH = sha(0x50001);
  const { port, seen, fetchImpl } = await realPort(async (u, method) => {
    if (u.host === 'x.supabase.co') return { status: 200, json: async () => ({ status: 'ok', repository: REPO, holders: [{ claim_id: CLAIM, bound_pr: `${REPO}#910`, merge_slot_until: iso(NOW + 600_000), merge_slot_ci: {} }] }) };
    if (method !== 'GET' && u.pathname !== '/graphql') return undefined;
    if (u.pathname === `${base}/branches/main`) return { name: 'main', commit: { sha: T } };
    if (u.pathname === `${base}/rules/branches/main`) return [];
    if (u.pathname === `${base}/pulls/910`) return { number: 910, state: 'open', draft: false, merged: false, mergeable: true, merge_commit_sha: S, head: { sha: H }, base: { ref: 'main', sha: T }, commits: 1 };
    if (u.pathname === `${base}/pulls/911`) return { number: 911, commits: 1, head: { sha: OLDH } };
    if (u.pathname === `${base}/pulls/911/commits`) return [{ sha: OLDH }];
    if (u.pathname === `${base}/pulls/910/commits`) return [{ sha: H }];
    if (u.pathname === `${base}/pulls`) return u.searchParams.get('page') === '1' ? [pullRow(910, iso(NOW - 2000), H), pullRow(911, iso(NOW - 1000), OLDH)].slice(0, Number(u.searchParams.get('per_page'))) : [];
    if (u.pathname === '/graphql') return { data: { repository: { pullRequest: { timelineItems: { totalCount: 20, filteredCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } };
    if (u.pathname === `${base}/compare/${T}...${H}`) return { status: 'ahead', ahead_by: 1, behind_by: 0, base_commit: { sha: T }, merge_base_commit: { sha: T } };
    if (u.pathname === `${base}/compare/${T}...${OLDH}`) return { status: 'diverged', ahead_by: 1, behind_by: 1, base_commit: { sha: T }, merge_base_commit: { sha: T } };
    if (u.pathname === `${base}/git/commits/${S}`) return { sha: S, tree: { sha: TREE }, parents: [{ sha: T }, { sha: H }] };
    if (u.pathname === `${base}/commits/${H}/check-runs`) return { total_count: 0, check_runs: [] };
    if (u.pathname === `${base}/commits/${OLDH}/check-runs`) return { total_count: 1, check_runs: [{ id: 99, app: { id: 77 }, name: SLOT, head_sha: OLDH, status: 'completed', conclusion: 'success' }] };
  });
  const native = createMergeSlotNative({ config: { supabaseUrl: 'https://x.supabase.co', publishableKey: 'pk', scope: 'project:p', repository: REPO }, nativeToken: 'clued_bnd_secret', fetchImpl });
  const store = await TrainSweepStore.open(path.join(await tempDir(t), 'sweep'));
  const job = jobOf({ mode: 'shadow', onSince: null });
  const { facts, sideEffects } = await runTrain({ job, github: port, native, ledger: null, sweepStore: store, publications: { async heads() { return { complete: true, heads: [] }; } }, appId: 77, clock: () => NOW, sleep: async () => {} });
  assert.deepEqual([sideEffects, facts.wouldRevokeCount, facts.wouldRevoke[0]?.checkRunId, facts.sweep.fullSweep.state], [0, 1, 99, 'complete']);
  assert.ok(seen.every(w => w.startsWith('GET ') || w.startsWith('POST api.github.com/graphql') || w.startsWith('POST api.github.com/app/installations/99/access_tokens')
    || w.startsWith(`POST x.supabase.co/rest/v1/rpc/${HOLDERS_RPC}`)), seen.join('\n'));
  assert.ok(!seen.some(w => w.startsWith('PATCH ')));
});
