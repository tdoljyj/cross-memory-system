// Stage 10 in shadow mode (resident quota redesign phase 2, step 3c-1; design v0.5 §5.2, §5.5, §5.6; DESIGN §21.2):
// the holders read and on-duty probe, the front PR facts, what the train would do, the would-revoke list, the
// read-only entry body over fake ports, the shadow records and the stage-10 outcome block.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMergeSlotNative, parseHolders, HOLDERS_RPC } from '../src/independent-control-checks-v2/merge-slot-native.mjs';
import { decideShadow, frontPullFacts, trainFacts, validateTrainFacts, wouldRevoke, WOULD_DO } from '../src/independent-control-checks-v2/train-facts.mjs';
import { readTrainFacts } from '../src/independent-control-checks-v2/train-maintenance.mjs';
import { TrainShadowStore } from '../src/independent-control-checks-v2/train-shadow-store.mjs';
import { TRAIN_RUN_SHADOW_DEFAULTS, makeTrainRun, trainRunKey } from '../src/resident-v2/train-run.mjs';
import { writeOutcome } from '../src/resident-v2/stage-inputs.mjs';
import { tempDir } from './resident-v2-fixtures.mjs';

const REPO = 'tdoljyj/cross-memory-system', APP = 5368905;
const T = '1'.repeat(40), H = '2'.repeat(40), S = '3'.repeat(40), TREE = 'c'.repeat(40), OLD = '9'.repeat(40);
const CLAIM = '11111111-2222-4333-8444-555555555555';
const holderRow = (o = {}) => ({ claim_id: CLAIM, task_id: CLAIM, bound_pr: `${REPO}#910`, bound_prs: [`${REPO}#910`], progress_ref: 'x', merge_refs: [`merge:${REPO}:main`], merge_slot_until: '2026-10-23T06:00:00Z',
  merge_slot_ci: { taken_at: '2026-10-23T05:00:00Z', ci_state: null, ci_head_sha: null, hard_cap_until: null }, ...o });
const SIX = ['kooyumi-work-admission', 'gitleaks', 'trivy', 'contract-placement', 'kooyumi-admission-verified', 'kooyumi-merge-slot'];
const rules = (strict = true) => [{ type: 'pull_request', parameters: { allowed_merge_methods: ['merge', 'squash', 'rebase'] } },
  { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: strict, required_status_checks: SIX.map(context => ({ context, integration_id: APP })) } }];
const job = makeTrainRun({ repo: REPO, runId: `${trainRunKey({ repo: REPO, seed: 'b'.repeat(64) }).slice(0, 16)}-0123456789ab`, mode: 'shadow', sourceManifestSha256: 'e'.repeat(64), createdAt: '2026-10-23T05:00:00.000Z',
  ...TRAIN_RUN_SHADOW_DEFAULTS });

test('holders: the live holder, and "not on duty" is never "queue empty"', () => {
  const r = parseHolders(200, { status: 'ok', repository: REPO, holders: [holderRow()] }, REPO);
  assert.deepEqual([r.onDuty, r.holders.length, r.holders[0].pr, r.holders[0].takenAt], [true, 1, 910, '2026-10-23T05:00:00Z']);
  assert.deepEqual(parseHolders(200, { status: 'ok', holders: [], reason: 'admission_binding_required' }, REPO), { onDuty: false, holders: [] });
  assert.deepEqual(parseHolders(200, { status: 'ok', repository: REPO, holders: [] }, REPO), { onDuty: true, holders: [] });
  assert.equal(parseHolders(200, { status: 'ok', repository: REPO, holders: [holderRow({ bound_pr: null, bound_prs: [] })] }, REPO).holders[0].pr, null);
  for (const [status, body] of [[500, {}], [200, { status: 'error' }], [200, { status: 'ok', repository: 'other/repo', holders: [] }], [200, { status: 'ok', repository: REPO, holders: [{ claim_id: 'x' }] }],
    [200, { status: 'ok', repository: REPO, holders: [], reason: 'something_else' }]])
    assert.throws(() => parseHolders(status, body, REPO), e => e.code === 'MERGE_SLOT_HOLDERS_UNREADABLE');
});

test('holders: Task and complete validated PR projection are authoritative; legacy scalar never overrides them', () => {
  const read = row => parseHolders(200, { status: 'ok', repository: REPO, holders: [row] }, REPO).holders[0];
  const one = read(holderRow({ bound_pr: 'foreign/repo#1' }));
  assert.equal(one.taskId, CLAIM);
  assert.deepEqual(one.boundPrs, [`${REPO}#910`]);
  assert.equal(one.pr, 910);
  const many = read(holderRow({ bound_pr: `${REPO}#999`, bound_prs: [`${REPO}#912`, `${REPO}#910`] }));
  assert.deepEqual(many.boundPrs, [`${REPO}#910`, `${REPO}#912`]);
  assert.deepEqual(many.prs, [910, 912]);
  assert.equal(many.pr, null, 'selection needs exact per-PR Native/head observation, not a scalar compatibility field');
  for (const patch of [{ task_id: undefined }, { bound_prs: undefined }])
    assert.throws(() => read(holderRow(patch)), { code: 'MERGE_SLOT_HOLDERS_PROJECTION_UNSUPPORTED' });
  for (const patch of [{ task_id: 'not-a-task' }, { bound_prs: [`${REPO}#910`,`${REPO}#910`] },
    { bound_prs: ['foreign/repo#1'] }, { bound_prs: [`${REPO}#01`] }, { bound_prs: Array.from({length:51},(_,n)=>`${REPO}#${n+1}`) }])
    assert.throws(() => read(holderRow(patch)), { code: 'MERGE_SLOT_HOLDERS_UNREADABLE' });
});

test('holders: one read-only POST with the token hash, the scope and the repository; a transport failure is unreadable', async () => {
  const seen = [];
  const port = createMergeSlotNative({ config: { supabaseUrl: 'https://x.supabase.co/', publishableKey: 'pk', scope: 'project:p', repository: REPO }, nativeToken: 'clued_bnd_secret',
    fetchImpl: async (url, opts) => { seen.push({ url, body: JSON.parse(opts.body), method: opts.method }); return { status: 200, json: async () => ({ status: 'ok', repository: REPO, holders: [] }) }; } });
  assert.deepEqual(await port.holders(), { onDuty: true, holders: [] });
  assert.equal(seen[0].url, `https://x.supabase.co/rest/v1/rpc/${HOLDERS_RPC}`);
  assert.deepEqual([seen[0].method, seen[0].body.p_input], ['POST', { scope: 'project:p', repository: REPO }]);
  assert.match(seen[0].body.p_token_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(seen).includes('clued_bnd_secret'), 'the token itself never leaves the process');
  const down = createMergeSlotNative({ config: { supabaseUrl: 'https://x', publishableKey: 'pk', scope: 's', repository: REPO }, nativeToken: 't', fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  await assert.rejects(down.holders(), e => e.code === 'MERGE_SLOT_HOLDERS_UNREADABLE');
});

const openPull = (o = {}) => ({ state: 'open', draft: false, merged: false, mergeable: true, merge_commit_sha: S, head: { sha: H }, base: { ref: 'main', sha: T }, ...o });
const facts = (o = {}) => frontPullFacts({ pull: openPull(o.pull), mergeCommit: o.mergeCommit === undefined ? { sha: S, tree: TREE, parents: [T, H] } : o.mergeCommit,
  compare: o.compare ?? { status: 'ahead', aheadBy: 1, behindBy: 0 }, checks: o.checks ?? [], mainSha: T, appId: APP });

test('what the train would do (design §5.2, §5.6)', () => {
  const one = [{ claimId: CLAIM, pr: 910 }];
  const d = (o, extra = {}) => decideShadow({ onDuty: true, holders: one, front: facts(o), rules: { strict: true, mergeOnly: false }, mainSha: T, ...extra });
  assert.equal(d({}), 'OPEN_FRONT_BATCH');
  assert.equal(decideShadow({ onDuty: false, holders: [] }), 'NOT_ON_DUTY');
  assert.equal(decideShadow({ onDuty: true, holders: [] }), 'NO_FRONT');
  assert.equal(decideShadow({ onDuty: true, holders: [one[0], one[0]] }), 'FRONT_AMBIGUOUS');
  assert.equal(decideShadow({ onDuty: true, holders: [{ claimId: CLAIM, pr: null }] }), 'FRONT_NOT_BOUND');
  for (const pull of [{ state: 'closed' }, { draft: true }, { base: { ref: 'other' } }]) assert.equal(d({ pull }), 'FRONT_NOT_RUNNABLE');
  // a conflict, or strict on while the head does not contain main's tip: the author merges main first
  assert.equal(d({ pull: { mergeable: false } }), 'FRONT_NEEDS_MAIN_MERGE');
  assert.equal(d({ compare: { status: 'diverged', aheadBy: 1, behindBy: 2 } }), 'FRONT_NEEDS_MAIN_MERGE');
  // with strict off a head behind main is fine: the train tests GitHub's test merge
  assert.equal(d({ compare: { status: 'diverged', aheadBy: 1, behindBy: 2 } }, { rules: { strict: false, mergeOnly: true } }), 'OPEN_FRONT_BATCH');
  // still computing, no test merge, or not exactly [T, H]
  assert.equal(d({ pull: { mergeable: null } }), 'FRONT_TEST_MERGE_NOT_READY');
  assert.equal(d({ mergeCommit: null }), 'FRONT_TEST_MERGE_NOT_READY');
  assert.equal(d({ mergeCommit: { sha: S, tree: TREE, parents: [OLD, H] } }), 'FRONT_TEST_MERGE_NOT_READY');
  // the head already carries the App's merge-slot success
  const green = [{ id: 7, app: { id: APP }, name: 'kooyumi-merge-slot', head_sha: H, status: 'completed', conclusion: 'success' }];
  assert.equal(d({ checks: green }), 'FRONT_GREEN_WAIT_MERGE');
  assert.equal(d({ checks: [{ ...green[0], app: { id: 1 } }] }), 'OPEN_FRONT_BATCH', 'only App 5368905 counts');
  assert.equal(d({ checks: [...green, { ...green[0], id: 8, conclusion: 'failure' }] }), 'OPEN_FRONT_BATCH', 'the newest judgement counts');
  assert.ok(WOULD_DO.length === 11);
});

test('would revoke: ledgered greens neither in main nor the front head; revoked, merged-in and unknown ones stay out', () => {
  const e = (headSha, checkRunId, phase, pr = 1) => ({ entry: { headSha, checkRunId, phase, pr } });
  const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'd'.repeat(40);
  const entries = [e(A, 1, 'posted'), e(A, 1, 'settled'), e(B, 2, 'settled'), e(B, 2, 'revoked'), e(C, 3, 'merged'), e(H, 4, 'settled'), { entry: { headSha: OLD, checkRunId: null, phase: 'intent' } }];
  const inMain = new Map([[A, false], [B, false], [C, true], [H, false]]);
  assert.deepEqual(wouldRevoke({ entries, inMain, frontHeadSha: H }), [{ headSha: A, checkRunId: 1, pr: 1, phase: 'settled' }]);
  // a head whose containment could not be read is never listed
  assert.deepEqual(wouldRevoke({ entries, inMain: new Map([[A, null]]), frontHeadSha: H }), []);
});

function fakeGithub(o = {}) {
  const state = { main: T, rules: rules(true), pull: openPull(), commits: { [S]: { sha: S, tree: TREE, parents: [T, H] } }, checks: [], compare: {}, ...o };
  return { state, reads: [],
    async readBranchHead(name) { this.reads.push(`branch:${name}`); return { name, sha: state.main }; },
    async readBranchRules(branch) { this.reads.push('rules'); if (state.rulesError) throw new Error('github_http_403'); return { complete: true, branch, rules: state.rules }; },
    async readPullRequest(n) { this.reads.push(`pull:${n}`); return structuredClone(state.pull); },
    async readCompare(base, head) { this.reads.push(`compare:${head.slice(0, 1)}`); return state.compare[head] ?? { baseSha: base, headSha: head, status: 'ahead', aheadBy: 1, behindBy: 0 }; },
    async readGitCommit(sha) { this.reads.push(`commit:${sha.slice(0, 1)}`); return structuredClone(state.commits[sha]); },
    async readChecks(head) { this.reads.push(`checks:${head.slice(0, 1)}`); return { complete: true, checks: state.checks }; },
    async readOwnChecksByName(head, name) { this.reads.push(`own:${head.slice(0, 1)}`); return { complete: true, checks: state.checks.filter(c => c.head_sha === head && c.name === name) }; },
    async readPullsPage(o) { this.reads.push(`pulls:${o.sort}`); return { complete: true, page: o.page, pulls: [], last: true }; },
    // writes must never be called in shadow mode
    async createCheck() { throw new Error('write in shadow mode'); }, async revokeCheck() { throw new Error('write in shadow mode'); } };
}
const native = reply => ({ async holders() { return reply; } });
const ledgerOf = entries => ({ async list() { return { entries, refused: [] }; } });
const noPublications = { async heads() { return { complete: true, heads: [] }; } };

test('the shadow run reads only and says what it would do', async t => {
  const { TrainSweepStore } = await import('../src/independent-control-checks-v2/train-sweep-store.mjs');
  const sweepStore = await TrainSweepStore.open(path.join(await tempDir(t), 'sweep'));
  const old = { id: 5, app: { id: APP }, name: 'kooyumi-merge-slot', head_sha: OLD, status: 'completed', conclusion: 'success', output: { summary: 'x' } };
  const github = fakeGithub({ compare: { [OLD]: { status: 'diverged', aheadBy: 1, behindBy: 1 } }, checks: [old] });
  const ledger = ledgerOf([{ entry: { headSha: OLD, checkRunId: 5, phase: 'settled', pr: 900 } }]);
  const f = await readTrainFacts({ job, github, native: native({ onDuty: true, holders: [parseHolders(200, { status: 'ok', repository: REPO, holders: [holderRow()] }, REPO).holders[0]] }), ledger,
    sweepStore, publications: noPublications, clock: () => Date.parse('2026-10-23T05:01:00Z') });
  assert.deepEqual([f.wouldDo, f.decision, f.mainSha, f.rules.strict, f.front.pr, f.front.headSha, f.front.testMergeSha, f.front.testMergeParentsOk, f.wouldRevokeCount],
    ['OPEN_FRONT_BATCH', 'OPEN_FRONT_BATCH', T, true, 910, H, S, true, 1]);
  assert.deepEqual(f.wouldRevoke, [{ headSha: OLD, checkRunId: 5, reason: 'NOT_FRONT_HEAD', own: true }]);
  assert.deepEqual(github.reads, ['branch:main', 'rules', 'pull:910', 'compare:2', 'commit:3', 'checks:2', 'own:9', 'compare:9', 'own:2', 'pulls:updated', 'pulls:created'], 'reads only, in this order');
  assert.deepEqual([f.sweep.kind, f.sweep.complete, f.sweep.revoked, f.sweep.proofWritten, f.sweep.fullSweep.state, f.openFrontBatch, f.actions.keptAlive], ['full-segment', true, 0, false, 'complete', null, 0]);
  assert.equal(await sweepStore.latestProof(), null, 'shadow writes no proof');
  // not on duty: nothing else is read
  const idle = fakeGithub();
  const off = await readTrainFacts({ job, github: idle, native: native({ onDuty: false, holders: [] }), ledger, clock: () => 0 });
  assert.deepEqual([off.wouldDo, off.onDuty, idle.reads], ['NOT_ON_DUTY', false, []]);
  // unreadable rules are recorded, not fatal; a failing GitHub read is (BLOCKED by runEntry, zero side effects)
  const noRules = await readTrainFacts({ job, github: fakeGithub({ rulesError: true }), native: native({ onDuty: true, holders: [] }), ledger: null, clock: () => 0 });
  assert.deepEqual([noRules.rules, noRules.rulesReason, noRules.wouldDo, noRules.ledger], [null, 'RULESET_UNREADABLE', 'NO_FRONT', { records: 0, refused: 0 }]);
  const broken = fakeGithub(); broken.readBranchHead = async () => { throw Object.assign(new Error('github_http_502'), { code: 'github_http_502' }); };
  await assert.rejects(readTrainFacts({ job, github: broken, native: native({ onDuty: true, holders: [] }), ledger: null }), e => e.code === 'github_http_502');
});

test('shadow records are create-only and validated; the stage-10 outcome carries valid facts only', async t => {
  const dir = path.join(await tempDir(t), 'shadow');
  const store = await TrainShadowStore.open(dir);
  const f = trainFacts({ mode: 'shadow', at: '2026-10-23T05:01:00.000Z', onDuty: true, holders: [], mainSha: T, rules: { strict: true, mergeOnly: false }, front: null, revoke: [], ledger: { records: 0, refused: 0 } });
  const name = await store.append(job.runId, f);
  assert.match(name, /^\d{13}-[0-9a-f]{16}-[0-9a-f]{12}\.json$/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')), { runId: job.runId, facts: f });
  await assert.rejects(store.append(job.runId, f), e => e.code === 'EEXIST');
  await assert.rejects(store.append(job.runId, { ...f, mode: 'off' }), e => e.code === 'invalid_train_facts');
  // facts /2: shadow acts on nothing; a front batch exists only in on and only as OPEN_FRONT_BATCH
  assert.equal(f.contract, 'clued.independent-ci.train-facts/2');
  const batch = { pr: 910, headSha: H, baseSha: T, testSha: S, testTree: TREE, claimId: CLAIM, since: '2026-10-23T05:00:00.000Z', attempt: 1 };
  for (const bad of [{ ...f, decision: 'TRAIN_REVOKE_UNCONFIRMED' }, { ...f, actions: { ...f.actions, keptAlive: 1 } }, { ...f, sweep: { ...f.sweep, revoked: 1 } },
    { ...f, openFrontBatch: batch }, { ...f, mode: 'on', decision: 'OPEN_FRONT_BATCH' }, { ...f, mode: 'revoke-only', decision: 'REVOKE_ONLY_DONE', actions: { ...f.actions, touchedRunning: true } },
    { ...f, mode: 'on', requestPause: 'TRAIN_LANDED_TREE_MISMATCH' }, { ...f, decision: 'SOMETHING' }, { ...f, nodes: [{ node: 'x' }] }])
    assert.throws(() => validateTrainFacts(bad), e => e.code === 'invalid_train_facts');
  assert.equal(validateTrainFacts({ ...f, mode: 'on', decision: 'OPEN_FRONT_BATCH', openFrontBatch: batch }).openFrontBatch.testSha, S);
  // resident DESIGN §75: H's own tree, optional, a SHA, and only for a front of one member
  const open = b => ({ ...f, mode: 'on', decision: 'OPEN_FRONT_BATCH', openFrontBatch: b });
  assert.equal(validateTrainFacts(open({ ...batch, headTree: TREE })).openFrontBatch.headTree, TREE);
  for (const bad of [{ ...batch, headTree: 'x' }, { ...batch, headTree: null }, { ...batch, headTree: TREE, members: [{ pr: 910, headSha: H }, { pr: 911, headSha: OLD }] }])
    assert.throws(() => validateTrainFacts(open(bad)), e => e.code === 'invalid_train_facts');
  // Fable's review ruling B2: stage 10's own compare T...H says T is in H; only true, and only for a front of one member
  assert.equal(validateTrainFacts(open({ ...batch, baseInHead: true })).openFrontBatch.baseInHead, true);
  for (const bad of [{ ...batch, baseInHead: false }, { ...batch, baseInHead: 'true' }, { ...batch, baseInHead: true, members: [{ pr: 910, headSha: H }, { pr: 911, headSha: OLD }] }])
    assert.throws(() => validateTrainFacts(open(bad)), e => e.code === 'invalid_train_facts');
  assert.equal(validateTrainFacts({ ...f, mode: 'on', decision: 'TRAIN_LANDED_TREE_MISMATCH', requestPause: 'TRAIN_LANDED_TREE_MISMATCH' }).requestPause, 'TRAIN_LANDED_TREE_MISMATCH');
  assert.equal(validateTrainFacts({ ...f, mode: 'revoke-only', decision: 'REVOKE_ONLY_DONE', sweep: { ...f.sweep, revoked: 3 } }).sweep.revoked, 3);
  assert.throws(() => validateTrainFacts({ ...f, wouldDo: 'REVOKE_EVERYTHING' }), e => e.code === 'invalid_train_facts');
  const receipts = path.join(await tempDir(t), 'receipts');
  const plan = { stage: 10, entryRole: 'train-maintenance' };
  const good = await writeOutcome({ receiptsRoot: receipts, nonce: 'a'.repeat(32), plan, jobIds: [job.id], result: { status: 'TRAIN_FACTS', sideEffects: 0, train: f } });
  assert.deepEqual([good.status, good.mayHavePublished, good.train], ['TRAIN_FACTS', false, f]);
  const bad = await writeOutcome({ receiptsRoot: receipts, nonce: 'b'.repeat(32), plan, jobIds: [job.id], result: { status: 'TRAIN_FACTS', sideEffects: 0, train: { ...f, contract: 'x' } } });
  assert.equal(bad.train, null);
  const other = await writeOutcome({ receiptsRoot: receipts, nonce: 'c'.repeat(32), plan: { stage: 8, entryRole: 'control-checks' }, jobIds: [], result: { status: 'SETTLED', sideEffects: 2, train: f } });
  assert.equal(other.train, null);
});

// The production ports (github.mjs, merge-slot-native.mjs) under a fetch that answers only reads: every GitHub call is a
// GET except the installation-token mint, and the one KooYomi call is the read-only holders RPC (review of 3c-1, m6).
test('wiring: the real GitHub and KooYomi ports, a fetch that refuses every write', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { createGitHubChecksPort } = await import('../src/github.mjs');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const now = Date.parse('2026-10-23T05:01:00Z'), seen = [];
  const reply = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  const base = `/repos/${REPO}`;
  const fetchImpl = async (url, options = {}) => {
    const u = new URL(url), method = options.method ?? 'GET', where = `${method} ${u.host}${u.pathname}`;
    seen.push(where);
    if (u.host === 'x.supabase.co') {
      assert.equal(`${method} ${u.pathname}`, `POST /rest/v1/rpc/${HOLDERS_RPC}`);
      return { status: 200, json: async () => ({ status: 'ok', repository: REPO, holders: [holderRow()] }) };
    }
    assert.equal(u.host, 'api.github.com', where);
    if (method === 'POST' && u.pathname === '/app/installations/99/access_tokens')
      return reply({ token: 't', expires_at: new Date(now + 3_600_000).toISOString(), permissions: { checks: 'write', contents: 'read', pull_requests: 'read', actions_variables: 'read', environments: 'read', metadata: 'read' } });
    assert.equal(method, 'GET', `a write in shadow mode: ${where}`);
    if (u.pathname === '/app') return reply({ id: 77 });
    if (u.pathname === '/installation/repositories') return reply({ total_count: 1, repositories: [{ id: 41, full_name: REPO }] });
    if (u.pathname === `${base}/branches/main`) return reply({ name: 'main', commit: { sha: T } });
    if (u.pathname === `${base}/rules/branches/main`) return reply(rules(true));
    if (u.pathname === `${base}/pulls/910`) return reply({ number: 910, ...openPull() });
    if (u.pathname === `${base}/compare/${T}...${H}`) return reply({ status: 'ahead', ahead_by: 1, behind_by: 0, base_commit: { sha: T }, merge_base_commit: { sha: T } });
    if (u.pathname === `${base}/git/commits/${S}`) return reply({ sha: S, tree: { sha: TREE }, parents: [{ sha: T }, { sha: H }] });
    if (u.pathname === `${base}/commits/${H}/check-runs`) return reply({ total_count: 0, check_runs: [] });
    throw new Error(`unexpected ${where}`);
  };
  const github = createGitHubChecksPort({ repository: REPO, repositoryId: 41, appId: 77, installationId: 99, includeModeRead: true, privateKeyProvider: async () => privateKey, fetchImpl, clock: () => now });
  const native = createMergeSlotNative({ config: { supabaseUrl: 'https://x.supabase.co', publishableKey: 'pk', scope: 'project:p', repository: REPO }, nativeToken: 'clued_bnd_secret', fetchImpl });
  const f = await readTrainFacts({ job, github, native, ledger: null, clock: () => now });
  assert.deepEqual([f.onDuty, f.front.pr, f.front.headSha, f.mainSha, f.wouldDo], [true, 910, H, T, 'OPEN_FRONT_BATCH']);
  assert.ok(seen.every(w => w.startsWith('GET ') || w === 'POST api.github.com/app/installations/99/access_tokens' || w === `POST x.supabase.co/rest/v1/rpc/${HOLDERS_RPC}`), seen.join('\n'));
});
