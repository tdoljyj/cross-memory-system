import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createGitHubChecksPort } from '../src/github.mjs';
import fs from 'node:fs/promises';
import { TrainSweepStore } from '../src/independent-control-checks-v2/train-sweep-store.mjs';
import { ScanProgress } from '../src/independent-control-checks-v2/train-scan-progress.mjs';
import { createSweeper, fullSweepSegment, incrementalSweep } from '../src/independent-control-checks-v2/train-sweep.mjs';
import { tempDir } from './resident-v2-fixtures.mjs';
import { setup as setupTrain, jobOf, iso, T, H, NOW } from './train-strict-fixtures.mjs';
import { runStrictLane, strictIdentity } from '../src/independent-control-checks-v2/train-strict.mjs';

const sha = n => n.toString(16).padStart(40, '0');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const AT = '2026-11-08T00:00:00.000Z';
function historyPort(count, { pageDelay = 0, checkDelay = 0, pulls = 1, pushes = [] } = {}) {
  const commits = Array.from({ length: count }, (_, n) => sha(n + 1)), head = commits.at(-1), calls = [];
  const world = { now: Date.parse(AT), checks: new Map(), visited: [], hooks: {}, main: sha(90_000) };
  const row = number => ({ number, state: 'open', updated_at: AT, head: { sha: head }, base: { ref: 'main' }, merged_at: null });
  const fetchImpl = async (url, options) => {
    const u = new URL(url); calls.push(u.pathname);
    let body;
    if (u.pathname === '/app') body = { id: 77 };
    else if (u.pathname === '/app/installations/99/access_tokens') body = { token: 'offline-test-token', expires_at: new Date(world.now + 3_600_000).toISOString(),
      permissions: { checks: 'write', contents: 'read', pull_requests: 'read', metadata: 'read' } };
    else if (u.pathname === '/installation/repositories') body = { total_count: 1, repositories: [{ id: 41, full_name: 'owner/repo' }] };
    else if (/^\/repos\/owner\/repo\/pulls\/\d+$/.test(u.pathname)) body = { ...row(Number(u.pathname.split('/').at(-1))), commits: count };
    else if (u.pathname === '/repos/owner/repo/pulls') {
      const per = Number(u.searchParams.get('per_page')), page = Number(u.searchParams.get('page'));
      body = Array.from({ length: pulls }, (_, n) => row(n + 7)).slice((page - 1) * per, page * per);
    }
    else if (/\/commits\/[0-9a-f]{40}\/check-runs$/.test(u.pathname)) {
      world.now += checkDelay; const h = u.pathname.split('/').at(-2); world.visited.push(h);
      body = { total_count: 0, check_runs: [] };
      body = world.hooks.checks?.(h) ?? body;
    }
    else if (u.pathname.includes('/compare/')) body = world.hooks.compare?.() ?? { status: 'ahead', ahead_by: 1, behind_by: 0 };
    else if (u.pathname === '/graphql') {
      const { query, variables } = JSON.parse(options.body), start = variables.after === null ? 0 : Number(variables.after);
      world.now += pageDelay;
      const end = Math.min(start + 100, count);
      const pushEnd = Math.min(start + 100, pushes.length);
      body = { data: { repository: { pullRequest: { headRefOid: head, updatedAt: AT,
        commits: { totalCount: count, nodes: commits.slice(start, end).map(oid => ({ commit: { oid } })),
          pageInfo: { hasNextPage: end < count, endCursor: String(end) } },
        timelineItems: { filteredCount: pushes.length - start, nodes: pushes.slice(start, pushEnd).map(e => ({ beforeCommit: e.before === null ? null : { oid: e.before }, afterCommit: e.after === null ? null : { oid: e.after } })),
          pageInfo: { hasNextPage: pushEnd < pushes.length, endCursor: String(pushEnd) } } } } } };
      body = world.hooks.graphql?.(body, query, variables) ?? body;
      assert.match(query, /pullRequest/);
    } else throw new Error(`unexpected offline request ${u.pathname}`);
    return { ok: true, status: 200, json: async () => body };
  };
  return { commits, calls, world, row: n => ({ number: n, state: 'open', updatedAt: AT, headSha: head, baseRef: 'main', merged: false }),
    port: createGitHubChecksPort({ repository: 'owner/repo', repositoryId: 41, appId: 77, installationId: 99,
    privateKeyProvider: async () => privateKey, clock: () => world.now, fetchImpl }) };
}

for (const count of [251, 1000]) test(`real GitHub port enumerates every commit of a ${count}-commit PR`, async () => {
  const { port, commits } = historyPort(count);
  const actual = await port.readPullCommitsBounded(7);
  assert.equal(actual.complete, true);
  assert.equal(actual.tooMany, false);
  assert.deepEqual(actual.commits, commits);
});

const RUN = '0123456789abcdef-0123456789ab';
async function scanSlice({ directory, h, cursor, identity = { repo: 'owner/repo', mainSha: sha(90_000), source: 'one', scope: 'all', round: AT }, incremental = false }) {
  const store = await TrainSweepStore.open(directory), clock = () => h.world.now, started = clock();
  const scan = await ScanProgress.open({ store, lane: 'on', identity, clock });
  const sweeper = createSweeper({ github: h.port, appId: 77, mainSha: identity.mainSha, clock, until: started + 150_000 });
  const result = incremental ? await incrementalSweep({ sweeper, github: h.port, entries: [], stream: { complete: true, heads: [] }, cursor,
    front: null, own: new Map(), clock, until: started + 150_000, scan })
    : await fullSweepSegment({ sweeper, github: h.port, nextPage: cursor.page, nextIndex: cursor.index, front: null, own: new Map(), scan });
  h.world.now++; await scan.save(RUN, async ms => { h.world.now += ms; });
  return { result, scan, store };
}

for (const count of [251, 1000]) test(`slow ${count}-commit full PR resumes enumeration and heads across real store restarts`, async t => {
  const directory = await tempDir(t), h = historyPort(count, { pageDelay: 40_000, checkDelay: 25_000,
    pushes: [{ before: sha(40_000), after: sha(40_001) }] });
  let cursor = { page: 1, index: 0 }, done = false, slices = 0;
  while (!done && slices < 300) {
    const { result } = await scanSlice({ directory, h, cursor }); slices++;
    assert.equal(result.ok, true, result.reason);
    done = result.reachedEnd; cursor = { page: result.nextPage, index: result.nextIndex };
  }
  assert.equal(done, true, `no completion after ${slices} slices`);
  assert.ok(slices > 2);
  assert.deepEqual(new Set(h.world.visited), new Set([...h.commits, sha(40_000), sha(40_001)]));
  assert.equal(h.world.visited.length, count + 2, 'no already-completed head is reread');
});

test('same updated_at group advances within a PR and between PRs without moving its inclusive cursor early', async t => {
  const directory = await tempDir(t), h = historyPort(251, { checkDelay: 50_000, pulls: 3 });
  let complete = false, slices = 0;
  while (!complete && slices < 300) {
    const { result } = await scanSlice({ directory, h, cursor: AT, incremental: true }); slices++;
    complete = result.complete;
    if (!complete) assert.equal(result.progress, null);
  }
  assert.equal(complete, true);
  assert.equal(h.world.visited.length, 251 * 3);
});

test('broken history page never completes or discards the blocked commit', async t => {
  const directory = await tempDir(t), h = historyPort(251);
  h.world.hooks.graphql = (body, query, vars) => {
    if (query.includes('commits(') && vars.after !== null) body.data.repository.pullRequest.commits.nodes = [];
    return body;
  };
  const { result } = await scanSlice({ directory, h, cursor: { page: 1, index: 0 } });
  assert.equal(result.ok, false);
  assert.equal(result.reachedEnd, false);
  assert.equal(h.world.visited.length, 0);
});

test('main, source, round or front changes invalidate continuation hints', async t => {
  for (const change of [{ mainSha: sha(90_001) }, { source: 'two' }, { round: 'new' }, { front: sha(50_000) }]) {
    const directory = await tempDir(t), h = historyPort(251, { checkDelay: 50_000 });
    await scanSlice({ directory, h, cursor: { page: 1, index: 0 } });
    const before = h.world.visited.length;
    await scanSlice({ directory, h, cursor: { page: 1, index: 0 }, identity: { repo: 'owner/repo', mainSha: sha(90_000), source: 'one', scope: 'all', round: AT, ...change } });
    assert.equal(h.world.visited[before], h.commits.at(-1), `${Object.keys(change)[0]} starts at the first candidate`);
  }
});

test('newer torn hint refuses recovery of an older checkpoint', async t => {
  const directory = await tempDir(t), h = historyPort(251, { checkDelay: 50_000 });
  await scanSlice({ directory, h, cursor: { page: 1, index: 0 } });
  await fs.writeFile(`${directory}/scan-on-${h.world.now + 1}-${RUN}-00000000.json`, '{');
  await assert.rejects(ScanProgress.open({ store: await TrainSweepStore.open(directory), lane: 'on', identity: {}, clock: () => h.world.now + 2 }), { code: 'TRAIN_SCAN_STATE_UNREADABLE' });
});

test('a syntactically valid checkpoint with a truncated completed inventory cannot act as completion evidence', async t => {
  const directory = await tempDir(t), h = historyPort(251, { checkDelay: 50_000 });
  const { store } = await scanSlice({ directory, h, cursor: { page: 1, index: 0 } });
  const hint = await store.readScanProgress('on');
  assert.equal(hint.units.full.pull.phase, 'judge');
  hint.units.full.pull.commits = []; hint.units.full.pull.heads = []; hint.units.full.pull.next = 0;
  h.world.now++;
  await store.writeScanProgress('on', { ...hint, writtenAt: new Date(h.world.now).toISOString() });
  const { result } = await scanSlice({ directory, h, cursor: { page: 1, index: 0 } });
  assert.equal(result.ok, false); assert.equal(result.reason, 'TRAIN_SCAN_STATE_UNREADABLE'); assert.equal(result.reachedEnd, false);
});

function pagedTrain(e, count = 251, delay = 20_000) {
  const commits = Array.from({ length: count }, (_, n) => sha(100_000 + n));
  e.gh.pull(7, { head: commits.at(-1), commits, updated: iso(NOW - 1000) });
  e.gh.readPullHistorySnapshot = async n => {
    const p = e.gh.world.pulls.get(n);
    return { headSha: p.head, count: (p.commits ?? [p.head]).length, updatedAt: p.updated };
  };
  e.gh.readPullHistoryPage = async (n, phase, cursor) => {
    const p = e.gh.world.pulls.get(n), all = phase === 'commits' ? p.commits ?? [p.head] : p.forcePushes ?? [], start = Number(cursor ?? 0), end = Math.min(start + 100, all.length);
    return { headSha: p.head, updatedAt: p.updated, count: phase === 'commits' ? all.length : all.length - start,
      rows: all.slice(start, end), next: end < all.length ? String(end) : null };
  };
  const read = e.gh.readOwnChecksByName;
  e.gh.readOwnChecksByName = async (...args) => { if (commits.includes(args[0])) e.now += delay; return read(...args); };
  return commits;
}

for (const [count, delay] of [[251, 20_000], [1000, 5_000]]) test(`real maintenance completes a slow ${count}-commit PR after restarting the store each slice`, async t => {
  const e = await setupTrain(t, { fullDone: false }), commits = pagedTrain(e, count, delay);
  e.gh.green(99, commits.at(-1));
  let complete = false, slices = 0;
  while (!complete && slices++ < 300) {
    e.store = await TrainSweepStore.open(e.store.directory);
    const { facts } = await e.run();
    assert.notEqual(facts.sweep.fullSweep.state, 'abandoned', facts.sweep.fullSweep.reason);
    complete = facts.sweep.fullSweep.state === 'complete';
    if (!complete) assert.equal((await e.store.latestProof()).fullSweepSinceOn, false);
    e.now += 1000;
  }
  assert.equal(complete, true);
  assert.ok(slices > 2);
  assert.equal(e.gh.world.checks.get(99).conclusion, 'failure');
  assert.equal(e.gh.world.reads.get(99), 3, 'unchanged first GET plus two confirmations');
  assert.equal((await e.store.latestProof()).fullSweepSinceOn, true);
});

test('the paged port recovers a legacy over-250 abandoned round by a fresh complete enumeration', async t => {
  const e = await setupTrain(t), previous = await e.store.readFullSweep('on');
  await e.store.writeFullSweep({ ...previous, writtenAt: iso(e.now - 500), full: { ...previous.full, state: 'abandoned', completedAt: null, reason: 'TRAIN_PULL_OVER_250_COMMITS' } });
  pagedTrain(e, 251, 0);
  const { facts } = await e.run();
  assert.equal(facts.sweep.fullSweep.state, 'complete');
  assert.equal(facts.sweep.fullSweep.reason, null);
  assert.equal((await e.store.readFullSweep('on')).full.commits, 503, '251 incremental commits plus the fresh full round of 252');
});

test('unknown containment and unconfirmed revocation cannot commit a fine cursor or publish clean', async t => {
  for (const failure of ['compare', 'readback', 'duty']) {
    const e = await setupTrain(t, { fullDone: false }), commits = pagedTrain(e, 251, 0);
    e.gh.green(99, commits.at(-1));
    if (failure === 'compare') e.gh.world.hooks.compare = (base, head) => head === commits.at(-1) ? Object.assign(new Error('offline unknown'), { code: 'github_http_502' }) : null;
    if (failure === 'readback') e.gh.world.hooks.run = (id, n, actual) => id === 99 && n >= 2 ? { ...actual, conclusion: 'success' } : actual;
    if (failure === 'duty') e.native.reread = false;
    const { facts } = await e.run();
    assert.equal(facts.openFrontBatch, null, failure);
    assert.equal((await e.store.latestProof()).clean, false, failure);
    const hint = await e.store.readScanProgress('on');
    assert.ok(hint === null || hint.units.full === undefined, failure);
    if (failure !== 'compare') assert.equal(hint, null, 'no fine checkpoint advances without both revocation readbacks and fresh duty');
  }
});

for (const race of ['updatedAt', 'forcePushCount']) test(`a PR ${race} changed during resumed head judgments cannot advance or publish clean`, async t => {
  const e = await setupTrain(t, { fullDone: false }), commits = pagedTrain(e);
  await e.run();
  const hint = await e.store.readScanProgress('on');
  assert.equal(hint.units.full.pull.phase, 'judge');
  // Exercise the resumed full PR rather than first encountering this same PR through the independent update feed.
  e.gh.readPullsUpdatedSince = async since => ({ complete: true, pulls: [], newest: since });
  let changed = false;
  e.gh.world.hooks.own = head => {
    if (!changed && commits.includes(head)) {
      changed = true;
      if (race === 'updatedAt') e.gh.world.pulls.get(7).updated = iso(e.now);
      else e.gh.world.pulls.get(7).forcePushes = [{ before: sha(60_000), after: commits.at(-1) }];
    }
  };
  e.now++;
  const { facts } = await e.run();
  assert.equal(changed, true);
  assert.equal(facts.sweep.fullSweep.state, 'abandoned');
  assert.equal(facts.sweep.fullSweep.reason, race === 'updatedAt' ? 'TRAIN_PULL_COMMITS_INCOMPLETE' : 'TRAIN_FORCE_PUSHES_INCOMPLETE');
  assert.equal((await e.store.latestProof()).clean, false);
  assert.equal(facts.openFrontBatch, null);
});

test('strict lane resumes the same slow PR without broadening eligible authority', async t => {
  const e = await setupTrain(t, { strict: true, fullDone: false }), commits = pagedTrain(e, 251, 20_000), job = jobOf();
  e.gh.world.behindHeads = new Set([commits[0]]); e.gh.green(99, commits[0]); e.gh.green(100, commits.at(-1));
  const identity = strictIdentity({ job, holder: e.native.holder, headSha: H, mainSha: T, scope: 'all' });
  let ready = false, slices = 0;
  while (!ready && slices++ < 100) {
    e.store = await TrainSweepStore.open(e.store.directory);
    const started = e.now;
    const r = await runStrictLane({ identity, job, sweepStore: e.store, github: e.gh, native: e.native.port, entries: [], stream: { complete: true, heads: [] },
      own: new Map(), appId: 5368905, clock: e.clock, sleep: e.sleep, started, until: { write: started + 270_000, read: started + 290_000 },
      ledger: e.ledger, revokeHead: false, fx: { n: 0 } });
    ready = r.ready; e.now += 1000;
  }
  assert.equal(ready, true);
  assert.ok(slices > 2);
  assert.equal(e.gh.world.checks.get(99).conclusion, 'success', 'ineligible deferred head was not revoked by strict coverage');
  assert.equal(e.gh.world.checks.get(100).conclusion, 'failure');
  assert.equal(e.gh.world.reads.get(100), 3);
});

test('current scope still enumerates only closed-unmerged head or merged-main force-push ends', async t => {
  for (const merged of [false, true]) {
    const directory = await tempDir(t), h = historyPort(1000, { pushes: [{ before: sha(40_000), after: sha(40_001) }] });
    const github = { ...h.port, readPullsPage: async ({ page }) => ({ complete: true, page, last: true, pulls: [{ ...h.row(7), state: 'closed', merged }] }) };
    const scan = await ScanProgress.open({ store: await TrainSweepStore.open(directory), lane: 'on', identity: { merged }, clock: () => h.world.now });
    const result = await fullSweepSegment({ sweeper: createSweeper({ github, appId: 77, mainSha: h.world.main }), github,
      nextPage: 1, nextIndex: 0, front: null, own: new Map(), scope: 'current', scan });
    assert.equal(result.reachedEnd, true);
    assert.deepEqual(new Set(h.world.visited), new Set(merged ? [sha(40_000), sha(40_001)] : [h.commits.at(-1)]));
    assert.equal(h.calls.filter(p => p === '/graphql').length, merged ? 2 : 0);
  }
});

test('force-push pagination resumes across slices and keeps every before/after endpoint including nulls', async t => {
  const directory = await tempDir(t), pushes = Array.from({ length: 101 }, (_, n) => ({ before: n === 0 ? null : sha(40_000 + n), after: sha(50_000 + n) }));
  const h = historyPort(251, { pageDelay: 50_000, checkDelay: 10_000, pushes });
  let cursor = { page: 1, index: 0 }, complete = false, slices = 0;
  while (!complete && slices++ < 100) {
    const { result } = await scanSlice({ directory, h, cursor });
    assert.equal(result.ok, true, result.reason);
    cursor = { page: result.nextPage, index: result.nextIndex }; complete = result.reachedEnd;
  }
  assert.equal(complete, true);
  assert.deepEqual(new Set(h.world.visited), new Set([...h.commits, ...pushes.flatMap(e => [e.before, e.after]).filter(Boolean)]));
});

test('duplicate pages, cursor cycles, changed history counts and head races all fail closed', async t => {
  for (const failure of ['duplicate', 'cursor', 'count', 'head']) {
    const directory = await tempDir(t), h = historyPort(251);
    h.world.hooks.graphql = (body, query, vars) => {
      const p = body.data.repository.pullRequest;
      if (query.includes('commits(') && vars.after !== null) {
        if (failure === 'duplicate') p.commits.nodes[0] = { commit: { oid: h.commits[0] } };
        if (failure === 'cursor') p.commits.pageInfo = { hasNextPage: true, endCursor: vars.after };
        if (failure === 'count') p.commits.totalCount++;
        if (failure === 'head') p.headRefOid = sha(99_999);
      }
      return body;
    };
    const { result } = await scanSlice({ directory, h, cursor: { page: 1, index: 0 } });
    assert.equal(result.ok, false, failure); assert.equal(result.reachedEnd, false, failure);
    assert.equal(h.world.visited.length, 0, failure);
  }
});
