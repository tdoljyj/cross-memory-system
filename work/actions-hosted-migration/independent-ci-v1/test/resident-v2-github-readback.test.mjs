// Resident primary/standby design v0.4 §6.1-§6.4 (C4, Task c2af8d17): GitHub is the shared record of what App 5368905
// already published on a head. Stage 1 stops a published head before Native is asked (HEAD_PUBLISHED_ON_GITHUB); a role
// this node knows nothing of but finds on GitHub ends cleanly (ROLE_ALREADY_ON_GITHUB).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { admissionEffectKeyV2, batchJobsV2, claimGeneration } from '../src/job-v2.mjs';
import { createGitHubChecksPort } from '../src/github.mjs';
import { EffectJournal } from '../src/effect-journal.mjs';
import { recordBatchClaim, readBatchClaim } from '../src/batch-claim-v2.mjs';
import { CHECKS_V2 } from '../src/resident-v2/prepare-record.mjs';
import { HEAD_INTERRUPTED_ON_GITHUB, HEAD_PUBLISHED_ON_GITHUB, PUBLISHED_ROLE_CHECK_NAMES, PUBLISHER_APP_ID, ROLE_ALREADY_ON_GITHUB, publishedNames, readPublishedChecks } from '../src/published-on-github-v2.mjs';
import { createFixtureWorkAdmissionPublisherV2 } from '../src/formal-work-admission-check-v2/publisher.mjs';
import { CONTROL_CHECKS_V2, createFixtureControlPublisherV2, QUEUE_POLL_MS } from '../src/independent-control-checks-v2/publisher.mjs';
import { HEAD, BASE, tempDir, admittedFacts } from './resident-v2-fixtures.mjs';
import { TRANSIENT_CODES, outcomeFailureCode } from '../src/resident-v2/stage-fact.mjs';

const REPO = 'tdoljyj/cross-memory-system', APP = 5368905, OTHER_APP = 15368;
const iso = ms => new Date(ms).toISOString();
const jobsFor = (attempt = 1) => batchJobsV2({ repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, testSha: HEAD, sourceManifestSha256: 'd'.repeat(64), createdAt: iso(Date.now() - 60_000), attempt });
const claim = () => ({ claimId: randomUUID(), fence: 3, epoch: 1, expiresAt: iso(Date.now() + 3600_000) });
const run = (id, name, { app = APP, head = HEAD, conclusion = 'success' } = {}) => ({ id, name, head_sha: head, status: 'completed', conclusion, app: { id: app }, external_id: `independent-ci:${name}` });

// Stage 8 also reads main's live branch rules and GitHub's test merge (phase 2, step 3a): the six checks pinned to
// 5368905, strict on, the test merge exactly [BASE, HEAD] with HEAD's own tree.
const SIX = ['kooyumi-work-admission', 'gitleaks', 'trivy', 'contract-placement', 'kooyumi-admission-verified', 'kooyumi-merge-slot'];
const TREE = 'c'.repeat(40), TEST_MERGE = 'e'.repeat(40);
const RULES = [{ type: 'pull_request', rulesetId: 24182890, parameters: { allowed_merge_methods: ['merge', 'squash', 'rebase'], required_approving_review_count: 0 } },
  { type: 'required_status_checks', rulesetId: 24182890, parameters: { strict_required_status_checks_policy: true, required_status_checks: SIX.map(context => ({ context, integration_id: APP })) } }];
const COMMITS = { [HEAD]: { sha: HEAD, tree: TREE, parents: [BASE] }, [TEST_MERGE]: { sha: TEST_MERGE, tree: TREE, parents: [BASE, HEAD] } };
const memoryLedger = () => ({ records: [], async append(r) { this.records.push({ phase: r.phase, headSha: r.job.headSha }); } });

// The GitHub port as the publishers see it; `seed` are check runs some other node or install published earlier.
function fakeGithub(seed = [], { narrowed = true } = {}) {
  const checks = seed.map(c => structuredClone(c)); let next = 1000;
  const calls = { readChangedPaths: 0, readChecks: 0, readAppChecks: 0, createCheck: 0 };
  const port = { fixture: true, checks, calls,
    async readChangedPaths(job) { calls.readChangedPaths++; return { complete: true, pr: job.pr, headSha: job.headSha, baseSha: job.baseSha, paths: ['a.txt'] }; },
    async readPullRequest(n) { return { number: n, state: 'open', merged: false, mergeable: true, merge_commit_sha: TEST_MERGE, head: { sha: HEAD, repo: { full_name: REPO } }, base: { sha: BASE, ref: 'main', repo: { full_name: REPO } } }; },
    async readBranchRules(branch) { return { complete: true, branch, rules: structuredClone(RULES) }; },
    async readGitCommit(sha) { if (!COMMITS[sha]) throw Object.assign(new Error('github_http_404'), { code: 'github_http_404' }); return structuredClone(COMMITS[sha]); },
    async readChecks(head) { calls.readChecks++; return { complete: true, checks: checks.filter(c => c.head_sha === head).map(c => structuredClone(c)) }; },
    async createCheck(body) { calls.createCheck++; const c = { id: next++, app: { id: APP }, ...structuredClone(body) }; checks.push(c); return structuredClone(c); },
    async revokeCheck(id, body) { const c = checks.find(x => x.id === id); Object.assign(c, structuredClone(body)); return structuredClone(c); } };
  if (narrowed) port.readAppChecks = async head => { calls.readAppChecks++; return { complete: true, checks: checks.filter(c => c.head_sha === head && c.app.id === APP).map(c => structuredClone(c)) }; };
  return port;
}
// Native's merge-slot deadline does not move between the observations before and after the write.
const SLOT_UNTIL = Date.now() + 3600_000;
function fakeAdmission(c) {
  let calls = 0;
  return { fixture: true, get calls() { return calls; }, async evaluatePr(job, packet) { calls++; return admittedFacts(job, c, packet, { domain: 'fixture', slotUntil: SLOT_UNTIL }); } };
}
async function stageOne(t, github) {
  const dir = await tempDir(t);
  const batchClaims = { dir, read: async j => { try { return await readBatchClaim(dir, j); } catch (e) { if (e.code === 'BATCH_CLAIM_MISSING') return null; throw e; } },
    record: (j, c, at) => recordBatchClaim(dir, j, c, at) };
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  const c = claim(), admission = fakeAdmission(c);
  const pub = createFixtureWorkAdmissionPublisherV2({ github, journal, admission, assertLive() {}, record() {}, authority: {}, batchClaims });
  return { pub, admission, batchClaims, journal, c };
}

// ---- the read-back (published-on-github-v2.mjs) ----

test('the published names are every required check but kooyumi-work-admission, of App 5368905', () => {
  assert.equal(PUBLISHER_APP_ID, APP);
  assert.deepEqual([...PUBLISHED_ROLE_CHECK_NAMES].sort(), Object.entries(CHECKS_V2).filter(([role]) => role !== 'work-admission').map(([, d]) => d.name).sort());
  assert.ok(Object.values(CHECKS_V2).every(d => d.appId === APP));
  assert.equal(HEAD_PUBLISHED_ON_GITHUB, 'HEAD_PUBLISHED_ON_GITHUB');
  assert.equal(ROLE_ALREADY_ON_GITHUB, 'ROLE_ALREADY_ON_GITHUB');
});

test('read-back: this App only, every run of a name (filter=all), from the narrowed read or the complete inventory', async () => {
  const seed = [run(1, 'gitleaks', { conclusion: 'failure' }), run(2, 'gitleaks'), run(3, 'trivy', { app: OTHER_APP }), run(4, 'kooyumi-work-admission'), run(5, 'trivy', { head: 'c'.repeat(40) })];
  for (const narrowed of [true, false]) {
    const github = fakeGithub(seed, { narrowed });
    assert.deepEqual((await readPublishedChecks(github, HEAD)).map(c => c.id), [1, 2, 4]);
    assert.deepEqual(await publishedNames(github, HEAD, PUBLISHED_ROLE_CHECK_NAMES), ['gitleaks']);
    assert.equal(narrowed ? github.calls.readAppChecks : github.calls.readChecks, 2);
    assert.equal(narrowed ? github.calls.readChecks : github.calls.readAppChecks, 0);
  }
  assert.deepEqual(await publishedNames(fakeGithub([]), HEAD, PUBLISHED_ROLE_CHECK_NAMES), []);
});

test('read-back fails closed on anything but one complete, exact list', async () => {
  const reply = list => ({ async readAppChecks() { return list; } });
  const bad = [
    null, { complete: false, checks: [] }, { complete: true }, { complete: true, checks: [run(1, 'gitleaks'), run(1, 'trivy')] },
    { complete: true, checks: [run(1, 'gitleaks', { head: 'c'.repeat(40) })] }, { complete: true, checks: [{ ...run(1, 'gitleaks'), app: null }] },
    { complete: true, checks: [{ ...run(1, 'gitleaks'), name: 7 }] }, { complete: true, checks: [{ ...run(1, 'gitleaks'), id: 0 }] },
    // the narrowed read must hold this App's runs only
    { complete: true, checks: [run(1, 'gitleaks', { app: OTHER_APP })] },
  ];
  for (const list of bad) await assert.rejects(readPublishedChecks(reply(list), HEAD), { code: 'published_checks_unconfirmed' });
  await assert.rejects(readPublishedChecks({}, HEAD), { code: 'published_checks_unconfirmed' });
  await assert.rejects(readPublishedChecks(fakeGithub(), 'not-a-sha'), { code: 'published_checks_unconfirmed' });
  await assert.rejects(publishedNames(fakeGithub(), HEAD, []), { code: 'published_checks_unconfirmed' });
  // The port's own refusals (github.mjs#inventory: pagination, page limit, transport) keep their codes.
  for (const code of ['incomplete_checks', 'checks_page_limit', 'checks_pagination_changed', 'github_transport_unconfirmed']) {
    await assert.rejects(readPublishedChecks({ async readAppChecks() { throw Object.assign(new Error(code), { code }); } }, HEAD), { code });
  }
});

// ---- stage 1 ----

test('stage 1: a head carrying any role or control check of this App ends before Native, whatever its conclusion', async t => {
  for (const name of PUBLISHED_ROLE_CHECK_NAMES) for (const conclusion of ['success', 'failure']) {
    const github = fakeGithub([run(7, name, { conclusion })]);
    const { pub, admission, batchClaims } = await stageOne(t, github);
    const job = jobsFor()['work-admission'];
    const r = await pub.publish(job);
    assert.deepEqual([r.status, r.reason, r.sideEffects, r.safeToRerun, r.productionAuthorized], ['BLOCKED', HEAD_PUBLISHED_ON_GITHUB, 0, false, false], name);
    assert.deepEqual(r.publishedChecks, [name]);
    // Never reached Native (so never the Task's CI meter), never read the PR files, recorded no claim, published nothing.
    assert.equal(admission.calls, 0);
    assert.equal(github.calls.readChangedPaths, 0);
    assert.equal(await batchClaims.read(job), null);
    assert.equal(github.calls.createCheck, 0);
  }
});

test('stage 1: kooyumi-work-admission of an earlier attempt and checks of other Apps do not count', async t => {
  const github = fakeGithub([run(7, 'kooyumi-work-admission'), run(8, 'gitleaks', { app: OTHER_APP }), run(9, 'kooyumi-merge-slot', { app: OTHER_APP })], { narrowed: false });
  const { pub, admission } = await stageOne(t, github);
  const r = await pub.publish(jobsFor(2)['work-admission']);
  assert.deepEqual([r.status, r.sideEffects], ['SETTLED', 1]);
  assert.equal(admission.calls, 2);
});

test('stage 1: the work admission of this very job (same job id and attempt) from another node stops it; that of another attempt does not', async t => {
  const job = jobsFor()['work-admission'];
  const own = { ...run(7, 'kooyumi-work-admission'), external_id: `independent-ci:native-work-admission:v2:${job.id}:a1:c12345678:f3:e1` };
  const github = fakeGithub([own]);
  const { pub, admission } = await stageOne(t, github);
  const r = await pub.publish(job);
  // Alone (no role or control check): the run that wrote it was interrupted before any check ran (resident DESIGN §78): the
  // transient HEAD_INTERRUPTED_ON_GITHUB, so the resident's attempt 2 runs the head; this attempt's identity is never posted again.
  assert.deepEqual([r.status, r.reason, r.publishedChecks, r.sideEffects, r.safeToRerun], ['BLOCKED', HEAD_INTERRUPTED_ON_GITHUB, ['kooyumi-work-admission'], 0, false]);
  assert.equal(outcomeFailureCode({ ...r, mayHavePublished: false }, 1), HEAD_INTERRUPTED_ON_GITHUB);
  assert.ok(TRANSIENT_CODES.includes(HEAD_INTERRUPTED_ON_GITHUB));
  assert.equal(admission.calls, 0);
  assert.equal(github.calls.createCheck, 0);
  // Beside a role check it is a head that ran: HEAD_PUBLISHED_ON_GITHUB, final, as before.
  const ran = await stageOne(t, fakeGithub([own, { ...run(8, 'gitleaks'), external_id: `independent-ci:staged:v2:${jobsFor().gitleaks.id}:a1` }]));
  const r2 = await ran.pub.publish(job);
  assert.deepEqual([r2.status, r2.reason, r2.publishedChecks], ['BLOCKED', HEAD_PUBLISHED_ON_GITHUB, ['gitleaks', 'kooyumi-work-admission']]);
  assert.equal(outcomeFailureCode({ ...r2, mayHavePublished: false }, 1), HEAD_PUBLISHED_ON_GITHUB);
  // attempt 2 is another job id: attempt 1's work admission does not stop it
  const second = await stageOne(t, fakeGithub([own]));
  assert.equal((await second.pub.publish(jobsFor(2)['work-admission'])).status, 'SETTLED');
});

test('stage 1: a read-back that is not complete refuses before Native (fail closed), keeping the port code', async t => {
  for (const code of ['incomplete_checks', 'checks_page_limit', 'github_transport_unconfirmed', 'published_checks_unconfirmed']) {
    const github = fakeGithub();
    github.readAppChecks = async () => { throw Object.assign(new Error(code), { code }); };
    const { pub, admission } = await stageOne(t, github);
    const r = await pub.publish(jobsFor()['work-admission']);
    // DESIGN 49: a GitHub read that outlived the bounded read retry (github_transport_unconfirmed, github_http_5xx) wrote and recorded nothing, so
    // the entry says it is safe to re-run and the resident releases the head; an incomplete or unconfirmed inventory is a refusal and stays false.
    assert.deepEqual([r.status, r.reason, r.sideEffects, r.safeToRerun], ['BLOCKED', code, 0, code === 'github_transport_unconfirmed']);
    assert.equal(admission.calls, 0);
    assert.equal(github.calls.createCheck, 0);
  }
});

test('stage 1: a batch that already recorded its claim is this node\'s own and keeps its path', async t => {
  const github = fakeGithub();
  const { pub, batchClaims } = await stageOne(t, github);
  const job = jobsFor()['work-admission'];
  assert.equal((await pub.publish(job)).status, 'SETTLED');
  // This batch's own role checks appear on the head; stage 1 of the same batch only re-verifies its settled check.
  github.checks.push(run(50, 'gitleaks'));
  assert.ok(await batchClaims.read(job));
  const again = await pub.publish(job);
  assert.deepEqual([again.status, again.sideEffects], ['SETTLED', 0]);
  assert.equal(github.calls.readAppChecks, 1);
});

// ---- github.mjs readAppChecks ----

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
// The App's GitHub as the port reads it; answer(page) is the check-runs reply of that page.
function checksPort(answer) {
  const searches = [];
  const reply = body => ({ ok: true, status: 200, json: async () => body });
  const fetchImpl = async (url, options) => {
    const u = new URL(url), key = `${options.method} ${u.pathname}`;
    if (key === 'GET /app') return reply({ id: APP });
    if (key === 'POST /app/installations/9/access_tokens') return reply({ token: 'installation-token', expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      permissions: { checks: 'write', contents: 'read', pull_requests: 'read', metadata: 'read' } });
    if (key === 'GET /installation/repositories') return reply({ total_count: 1, repositories: [{ id: 41, full_name: REPO }] });
    if (key === `GET /repos/${REPO}/commits/${HEAD}/check-runs`) { searches.push(u.search); return reply(answer(Number(u.searchParams.get('page')))); }
    throw new Error(`unexpected ${key}`);
  };
  return { port: createGitHubChecksPort({ repository: REPO, repositoryId: 41, appId: APP, installationId: 9, privateKeyProvider: async () => privateKey, fetchImpl }), searches };
}
const runs = (from, n, o) => Array.from({ length: n }, (_, i) => run(from + i, 'gitleaks', o));

test('github.mjs readAppChecks: app_id and filter=all on every page; complete, or refused', async () => {
  const ok = checksPort(page => ({ total_count: 150, check_runs: page === 1 ? runs(1, 100) : runs(101, 50) }));
  const list = await ok.port.readAppChecks(HEAD);
  assert.deepEqual([list.complete, list.checks.length], [true, 150]);
  assert.deepEqual(ok.searches, ['?app_id=5368905&filter=all&per_page=100&page=1', '?app_id=5368905&filter=all&per_page=100&page=2']);
  for (const [answer, code] of [
    [page => ({ total_count: 150, check_runs: page === 1 ? runs(1, 100) : runs(101, 30) }), 'incomplete_checks'],
    [page => ({ total_count: page === 1 ? 150 : 151, check_runs: page === 1 ? runs(1, 100) : runs(101, 51) }), 'checks_pagination_changed'],
    [page => ({ total_count: 1001, check_runs: runs(page * 100, 100) }), 'checks_page_limit'],
    [() => ({ total_count: 1, check_runs: [run(1, 'gitleaks', { app: OTHER_APP })] }), 'invalid_check_set'],
  ]) await assert.rejects(checksPort(answer).port.readAppChecks(HEAD), { code });
  // The unnarrowed inventory is unchanged.
  const all = checksPort(() => ({ total_count: 1, check_runs: [run(1, 'gitleaks', { app: OTHER_APP })] }));
  assert.equal((await all.port.readChecks(HEAD)).checks.length, 1);
  assert.deepEqual(all.searches, ['?filter=all&per_page=100&page=1']);
});

// ---- the control pair (stage 8) ----

async function controlPair(t, github) {
  const jobs = jobsFor(), c = claim();
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  const admission = { fixture: true, async evaluatePr(job, packet) {
    return admittedFacts(job, c, packet, { domain: 'fixture', mergeQueueHead: true, slotUntil: SLOT_UNTIL, batchClaim: claimGeneration(c) });
  } };
  const greenLedger = memoryLedger();
  const pub = createFixtureControlPublisherV2({ github, journal, admission, assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(c), greenLedger, sleep: async () => {} });
  return { pub, pair: [jobs['control-admission'], jobs['control-merge-slot']], journal, batchClaim: claimGeneration(c), greenLedger };
}

test('stage 8: a control check already on GitHub from another node ends the pair before either half is published', async t => {
  for (const name of ['kooyumi-admission-verified', 'kooyumi-merge-slot']) {
    const github = fakeGithub([run(7, name)]);
    const { pub, pair, greenLedger } = await controlPair(t, github);
    const r = await pub.publishPair(pair, { waitUntil: Date.now() + 2 * QUEUE_POLL_MS });
    assert.deepEqual([r.status, r.reason, r.sideEffects], ['BLOCKED', ROLE_ALREADY_ON_GITHUB, 0], name);
    assert.deepEqual(greenLedger.records, [], 'refused before the green-ledger intent: nothing recorded');
    assert.equal(r.role, name === 'kooyumi-merge-slot' ? 'control-merge-slot' : 'control-admission');
    assert.equal(github.calls.createCheck, 0);
  }
  // publishOne on its own refuses the same way.
  const github = fakeGithub([run(7, 'kooyumi-merge-slot')]);
  const { pub, pair } = await controlPair(t, github);
  const one = await pub.publishOne(pair[1]);
  assert.deepEqual([one.status, one.reason, one.sideEffects], ['BLOCKED', ROLE_ALREADY_ON_GITHUB, 0]);
});

test('stage 8: one half this node published, the other already on GitHub: a clean refusal; an unsettled half keeps reconciliation', async t => {
  const github = fakeGithub();
  const { pub, pair, journal, batchClaim } = await controlPair(t, github);
  assert.equal((await pub.publishOne(pair[0])).status, 'SETTLED');
  github.checks.push(run(70, 'kooyumi-merge-slot'));
  const r = await pub.publishPair(pair, { waitUntil: Date.now() + 2 * QUEUE_POLL_MS });
  assert.deepEqual([r.status, r.reason, r.role, r.sideEffects, github.calls.createCheck], ['BLOCKED', ROLE_ALREADY_ON_GITHUB, 'control-merge-slot', 0, 1]);
  // A half whose write may have happened (journal sent) is never hidden behind a clean code: the existing reconciliation.
  const g = fakeGithub([run(71, 'kooyumi-merge-slot')]);
  const u = await controlPair(t, g);
  const key = admissionEffectKeyV2('independent-control-check/2', u.pair[0], u.batchClaim, CONTROL_CHECKS_V2['control-admission']);
  await u.journal.begin(key, { note: 'a write that may have happened' });
  await u.journal.transition(key, 'intent', 'authorized'); await u.journal.transition(key, 'authorized', 'sent');
  const halted = await u.pub.publishPair(u.pair, { waitUntil: Date.now() + 2 * QUEUE_POLL_MS });
  assert.equal(halted.status, 'RECONCILIATION_REQUIRED');
  assert.equal(g.calls.createCheck, 0);
});

test('stage 8: a pair this node published is known and re-verified on the next try; a read-back that is not complete refuses', async t => {
  const github = fakeGithub();
  const { pub, pair, greenLedger } = await controlPair(t, github);
  const first = await pub.publishPair(pair, { waitUntil: Date.now() + 2 * QUEUE_POLL_MS });
  assert.deepEqual([first.status, first.sideEffects, github.calls.createCheck], ['SETTLED', 2, 2]);
  assert.deepEqual(greenLedger.records.map(r => r.phase), ['intent', 'posted', 'settled'], 'the merge-slot green is ledgered before it is posted');
  const again = await pub.publishPair(pair, { waitUntil: Date.now() + 2 * QUEUE_POLL_MS });
  assert.deepEqual([again.status, again.sideEffects, github.calls.createCheck], ['SETTLED', 0, 2]);
  const broken = fakeGithub();
  broken.readAppChecks = async () => { throw Object.assign(new Error('incomplete_checks'), { code: 'incomplete_checks' }); };
  const b = await controlPair(t, broken);
  const r = await b.pub.publishPair(b.pair, { waitUntil: Date.now() + 2 * QUEUE_POLL_MS });
  assert.deepEqual([r.status, r.reason, r.sideEffects, broken.calls.createCheck], ['BLOCKED', 'incomplete_checks', 0, 0]);
});
