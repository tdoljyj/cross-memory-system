// PLAN-resident-draft-batch-20261123 §3: a draft PR is no candidate of this resident. Field 2026-11-23 (Beijing time): PR #1253's
// first attempt ended at stage 2 (REMOTE_REFS_CHANGED_SINCE_BUNDLE) at about 15:13:48, #1253 turned draft, #1254's trigger arrived, and
// at 15:23:48 the resident still started #1253's attempt 2: the live read before it compared only the state and the head. The one
// judgement (pr-candidate.mjs#prCandidate) now says pr-closed / head-moved (final) or pr-draft (held); a held PR's queue row, attempt-2
// intent and flow continuation are not scheduled and not read until its next trigger, which turns them back on, on the same head.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ETA_BATCH_MS, SUPERSEDE_LIVE_READ_MS, SUPERSEDED_AT_SAFE_POINT } from '../src/executor.mjs';
import { Ledger, batchKey } from '../src/ledger.mjs';
import { TRIGGER_CONTRACT_V2 } from '../src/trigger.mjs';
import { REQUEST_CONTRACT, RESPONSE_CONTRACT, validateResponse } from '../src/mailbox.mjs';
import { parsePull, readPullArgv } from '../src/companion.mjs';
import { mailboxCompanion } from '../src/service-ports.mjs';
import { LocalStore, PrStatusReporter, describe as prPage } from '../src/pr-status.mjs';
import { Poller } from '../src/poller.mjs';
import { StatusBoard, parseStatus } from '../src/status.mjs';
import { BASE, HEAD, SOURCE, WINDOWS_CLEAN, executorFixture, fakeCompanion, fakeEngine, holdAtA, rulesReply, tempRoot, triggerBytes } from './helpers.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-11-23T07:13:00Z');
const H = n => String(n).repeat(40).slice(0, 40);
const A = 884, B = 885, HB = H(5);
const REPO = 'tdoljyj/cross-memory-system';
const subject = (o = {}) => ({ repo: REPO, pr: A, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1, ...o });
const KEY = batchKey(subject()), KEY2 = batchKey(subject({ attempt: 2 })), KEYB = batchKey(subject({ pr: B, headSha: HB }));
const DRAFT_TEXT = '草稿：已搁置，转为可评审后自动继续';
const stagesRun = engine => engine.calls.filter(c => c[0] === 'stage').map(c => c[1]);
const count = (engine, n) => stagesRun(engine).filter(x => x === n).length;
const readsOf = (f, pr) => f.companion.calls.filter(c => c[0] === 'pr-head' && c[1] === pr).length;
// The poller's trigger after the PR turned ready again: GitHub moved updated_at (poller.mjs proposes it once more).
const readyTrigger = (f, pr = A, headSha = HEAD) => Buffer.from(JSON.stringify({ contract: TRIGGER_CONTRACT_V2, repo: REPO, pr, headSha, baseSha: BASE,
  prUpdatedAt: new Date(f.clock()).toISOString() }));
const notReady = code => ({ ok: false, code, proof: WINDOWS_CLEAN, brokerNoLaunch: false,
  outcome: { status: 'BLOCKED', reason: code, sideEffects: 0, mayHavePublished: false, diagnostic: null, scheduling: { ciRetryAfter: null, mergeQueue: { entered: false, state: null, position: null } }, safeToRerun: false } });

// Two PRs the companion reads live (prs[n]: state, head, draft; draft undefined = an older reply without the key; answer false = no answer).
//   refsOnce: the first stage 2 ends REMOTE_REFS_CHANGED_SINCE_BUNDLE (attempt 1 of the field); stage8: 'ok' or 'not-ready' (parks at B).
async function field(t, { refsOnce = false, stage8 = 'ok', status } = {}) {
  const engine = fakeEngine();
  const base = engine.runStage;
  let n2 = 0;
  engine.runStage = async (batch, stage, o) => {
    if (stage.number === 2 && refsOnce && ++n2 === 1) { engine.calls.push(['stage', 2]); return { ok: false, code: 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', proof: WINDOWS_CLEAN }; }
    if (stage.number === 8 && stage8 === 'not-ready') { engine.calls.push(['stage', 8]); return notReady('RESIDENT_QUEUE_HEAD_NOT_REACHED'); }
    engine.onStage?.(stage.number);
    return base(batch, stage, o);
  };
  const prs = { [A]: { state: 'open', headSha: HEAD, draft: false, answer: true }, [B]: { state: 'open', headSha: HB, draft: false, answer: true } };
  const pull = n => {
    const p = prs[n];
    if (!p || !p.answer) return null;
    return { number: n, state: p.state, headSha: p.headSha, ...(p.draft === undefined ? {} : { draft: p.draft }) };
  };
  let f;
  const companion = fakeCompanion({ pull }, () => f?.clock() ?? T0);
  f = await executorFixture(t, { engine, companion, now: T0, ...(status ? { status } : {}) });
  // The batch carries the installed CI Source, as a real derive does (test/safe-point-readmit.test.mjs): B goes on at stage 8 under it (§72.10).
  const derive = engine.derive.bind(engine);
  engine.derive = async (...args) => ({ ...await derive(...args), ciSourceManifestSha256: f.exec.policy.ciSourceManifestSha256 });
  return Object.assign(f, { prs });
}
async function parkedAtB(f) {
  await f.drop(triggerBytes());
  for (let i = 0; i < 3 && !Ledger.parkedAt(await f.ledger.state(KEY)); i++) await f.exec.tick();
  assert.ok(Ledger.parkedAt(await f.ledger.state(KEY)), 'parked at B');
}

// §3 item 1 (must fail before the fix) and item 2.
test('field replay #1253/#1254: the draft PR\'s due attempt 2 is held, the next PR runs in the same tick; ready again, attempt 2 runs once on the same head', async t => {
  const f = await field(t, { refsOnce: true });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'FAILED_CLEAN', 'attempt 1 ended at stage 2, clean');
  assert.equal((await f.ledger.pendingAttempts2()).length, 1, 'attempt 2 written, 600 s later');
  f.prs[A].draft = true;
  await f.drop(triggerBytes({ pr: B, headSha: HB }));
  const readsBefore = readsOf(f, A), stage1Before = count(f.engine, 1);
  f.advance(600_000);
  await f.exec.tick();
  assert.equal((await f.ledger.state(KEY2)).state, 'ABSENT', 'no attempt 2 of the draft PR is reserved');
  assert.notEqual((await f.ledger.state(KEYB)).state, 'ABSENT', 'B is reserved in the same tick');
  assert.equal(count(f.engine, 1) - stage1Before, 1, 'and B ran its stage 1');
  assert.equal((await f.ledger.pendingAttempts2()).length, 1, 'A\'s attempt-2 intent stays pending');
  for (let i = 0; i < 30; i++) { f.advance(MIN); await f.exec.tick(); }
  assert.ok(readsOf(f, A) - readsBefore <= 1, `at most one live read of A in 30 minutes (got ${readsOf(f, A) - readsBefore})`);
  assert.equal((await f.ledger.state(KEY2)).state, 'ABSENT');

  // §3 item 2: ready for review again (GitHub moves updated_at, the poller proposes the PR): attempt 2 runs once, same head, no new commit.
  f.prs[A].draft = false;
  await f.drop(readyTrigger(f));
  f.advance(1);
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.key], ['COMPLETED', KEY2]);
  assert.deepEqual(await f.ledger.pendingAttempts2(), [], 'consumed');
  assert.equal(f.queue.row(A).current.headSha, HEAD, 'the same head');
  f.advance(MIN);
  await f.exec.tick();
  assert.equal((await f.ledger.state(KEY2)).outcome, 'COMPLETED', 'once');
});

// §3 item 3.
test('a draft PR\'s queue row is never reserved; the trigger after it turned ready runs it', async t => {
  const f = await field(t);
  f.prs[A].draft = true;
  await f.drop(triggerBytes());
  await f.exec.tick();
  assert.equal((await f.ledger.state(KEY)).state, 'ABSENT', 'not reserved');
  assert.equal(readsOf(f, A), 1);
  for (let i = 0; i < 4; i++) { f.advance(10 * MIN); await f.exec.tick(); }
  assert.equal(readsOf(f, A), 5, 'held: one terminal check every ten minutes');
  assert.equal((await f.ledger.state(KEY)).state, 'ABSENT');
  f.prs[A].draft = false;
  await f.drop(readyTrigger(f));
  f.advance(1);
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.equal((await f.ledger.state(KEY)).outcome, 'COMPLETED');
});

// §3 item 4 (must fail before the fix).
test('parked at B, turned draft: the 10-minute read ends it pr-draft and frees the place; ready again, it goes on at stage 8 with stages 2-7 untouched', async t => {
  const f = await field(t, { stage8: 'not-ready' });
  await parkedAtB(f);
  const tries = count(f.engine, 8), middle = [2, 3, 4, 5, 6, 7].map(n => count(f.engine, n));
  f.prs[A].draft = true;
  f.advance(SUPERSEDE_LIVE_READ_MS);
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode, r.safePoint], ['FAILED_CLEAN', SUPERSEDED_AT_SAFE_POINT, 'parked']);
  assert.ok(Ledger.flowEnd(await f.ledger.state(KEY)), 'a flow end (DESIGN §72.10): resumable on the same head');
  const flows = await f.ledger.pendingFlowEnds();
  assert.deepEqual(flows.map(x => [x.terminal.facts.basis, x.terminal.facts.stage, x.terminal.facts.safePoint]), [['pr-draft', 8, 'parked']]);
  assert.deepEqual(await f.exec.parkedCounts(), { inside: 0, outside: 0 }, 'the parking place is free');
  assert.equal(count(f.engine, 8), tries, 'no stage-8 try after the read showed the draft');
  const reads = readsOf(f, A);
  for (let i = 0; i < 4; i++) { f.advance(10 * MIN); await f.exec.tick(); }
  assert.equal(count(f.engine, 8), tries, 'held: no stage-8 try');
  assert.equal(readsOf(f, A), reads + 4, 'held: only the periodic terminal checks run');
  assert.equal((await f.ledger.pendingFlowEnds()).length, 1, 'the continuation is kept');
  // ready for review again: the same head goes on from stage 8 (DESIGN §72.10), nothing of stages 2-7 runs again
  f.prs[A].draft = false;
  await f.drop(readyTrigger(f));
  f.advance(1);
  await f.exec.tick();
  assert.equal(count(f.engine, 8), tries + 1, 'stage 8 tried again');
  assert.deepEqual([2, 3, 4, 5, 6, 7].map(n => count(f.engine, n)), middle, 'stages 2-7 not run again');
  assert.ok(Ledger.parkedAt(await f.ledger.state(KEY)), 'parked at B again (its stage 8 is still not ready)');
});

// §3 item 5.
test('resting at A, turned draft: ended pr-draft at stage 1; ready again, it is admitted again on the same head', async t => {
  const f = await field(t);
  const hold = holdAtA(f.exec);
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'WAITING');
  f.prs[A].draft = true;
  f.advance(SUPERSEDE_LIVE_READ_MS);
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode, r.safePoint], ['FAILED_CLEAN', SUPERSEDED_AT_SAFE_POINT, 'waiting']);
  assert.deepEqual((await f.ledger.pendingFlowEnds()).map(x => [x.terminal.facts.basis, x.terminal.facts.stage]), [['pr-draft', 1]]);
  const stage1 = count(f.engine, 1), reads = readsOf(f, A);
  for (let i = 0; i < 3; i++) { f.advance(10 * MIN); await f.exec.tick(); }
  assert.deepEqual([count(f.engine, 1), readsOf(f, A)], [stage1, reads + 3], 'held: terminal checks do not admit the row');
  hold.release();
  f.prs[A].draft = false;
  await f.drop(readyTrigger(f));
  f.advance(1);
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.equal(count(f.engine, 1), stage1 + 1, 'admitted again (stage 1)');
});

// §3 item 6.
test('缺答时普通行等待，旧版无 draft 字段的答复保持兼容，draft 可经传输返回', async t => {
  const { prCandidate } = await import('../src/pr-candidate.mjs');
  const s = subject();
  assert.equal(prCandidate(null, s), null, 'no answer is no fact');
  assert.deepEqual(prCandidate({ number: A, state: 'open', headSha: HEAD }, s)?.basis, null);
  assert.equal(prCandidate({ number: A, state: 'open', headSha: HEAD, draft: false }, s)?.basis, null);
  assert.equal(prCandidate({ number: A, state: 'closed', headSha: HEAD, draft: true }, s)?.basis, 'pr-closed');
  assert.equal(prCandidate({ number: A, state: 'merged', headSha: HEAD }, s)?.basis, 'pr-closed');
  assert.equal(prCandidate({ number: A, state: 'open', headSha: H(7), draft: true }, s)?.basis, 'head-moved');
  assert.equal(prCandidate({ number: A, state: 'open', headSha: HEAD, draft: true }, s)?.basis, 'pr-draft');
  assert.equal(prCandidate({ number: A, state: 'open', headSha: HEAD, draft: 'yes' }, s)?.basis, null, 'only a boolean true is a draft');

  // GitHub's read: draft is asked for and kept only when it is a boolean; the mailbox and the service port carry it.
  assert.match(readPullArgv('C:\\gh.exe', REPO, A).at(-1), /draft: \.draft/);
  const row = { number: A, state: 'open', merged: false, head: HEAD };
  assert.equal(parsePull(JSON.stringify({ ...row, draft: true }), A).draft, true);
  assert.equal(parsePull(JSON.stringify({ ...row, draft: false }), A).draft, false);
  assert.equal(Object.hasOwn(parsePull(JSON.stringify(row), A), 'draft'), false, 'an older reply: no draft fact');
  assert.equal(Object.hasOwn(parsePull(JSON.stringify({ ...row, draft: null }), A), 'draft'), false);
  const start = Date.parse('2026-11-23T07:00:00Z');
  const request = { contract: REQUEST_CONTRACT, requestId: 'abc0f111-867b-44ad-aa49-37c91a90fb03', kind: 'pr-head', batchId: '0000000000000000-000000000000', pr: A,
    createdAt: new Date(start).toISOString(), deadline: new Date(start + 120000).toISOString() };
  const response = p => ({ contract: RESPONSE_CONTRACT, requestId: request.requestId, kind: request.kind, ok: true, code: null, proof: null, directory: null, verified: null,
    usage: null, pull: p, jobTree: null, memory: null, prune: null, observedAt: new Date(start).toISOString() });
  const observed = validateResponse(response({ number: A, state: 'open', headSha: HEAD, draft: true }), request);
  assert.equal((await mailboxCompanion({ send: async () => request, await: async () => observed }, async () => {}).prHead(A)).draft, true);
  const legacy = validateResponse(response({ number: A, state: 'open', headSha: HEAD }), request);
  assert.equal(Object.hasOwn(await mailboxCompanion({ send: async () => request, await: async () => legacy }, async () => {}).prHead(A), 'draft'), false);
  assert.throws(() => validateResponse(response({ number: A, state: 'open', headSha: HEAD, draft: 'yes' }), request), { code: 'MAILBOX_RESPONSE_PULL_REFUSED' });

  // An older reply (no draft key) at B: the 10-minute read keeps the batch parked.
  const f = await field(t, { stage8: 'not-ready' });
  f.prs[A].draft = undefined;
  await parkedAtB(f);
  f.advance(SUPERSEDE_LIVE_READ_MS);
  await f.exec.tick();
  assert.ok(Ledger.parkedAt(await f.ledger.state(KEY)), 'no draft fact: it stands');
  // 预留前缺答时保留该行，等读到完整答复再调度。
  const g = await field(t);
  g.prs[A].answer = false;
  await g.drop(triggerBytes());
  assert.equal((await g.exec.tick()).reason, 'QUEUE_PR_STATUS_UNCONFIRMED');
  assert.equal((await g.ledger.state(KEY)).state, 'ABSENT');
  g.prs[A].answer = true;
  g.advance(SUPERSEDE_LIVE_READ_MS);
  assert.equal((await g.exec.tick()).state, 'COMPLETED');
});

// PLAN-executor-standing-read-20261125 item 4: the service port keeps the code of a read without a pull (the executor's livePull still
// treats it as no answer; standingRead puts the code in its receipt).
test('port: pr-head without a pull rejects with the code (PR_HEAD_UNAVAILABLE, PR_HEAD_NO_ANSWER); with a pull it returns it as before', async () => {
  const start = Date.parse('2026-11-25T05:00:00Z');
  const request = { contract: REQUEST_CONTRACT, requestId: 'abc0f111-867b-44ad-aa49-37c91a90fb04', kind: 'pr-head', batchId: '0000000000000000-000000000000', pr: A,
    createdAt: new Date(start).toISOString(), deadline: new Date(start + 120000).toISOString() };
  const response = (ok, code, p) => validateResponse({ contract: RESPONSE_CONTRACT, requestId: request.requestId, kind: request.kind, ok, code, proof: null, directory: null,
    verified: null, usage: null, pull: p, jobTree: null, memory: null, prune: null, observedAt: new Date(start).toISOString() }, request);
  const port = answer => mailboxCompanion({ send: async () => request, await: async () => answer }, async () => {});
  await assert.rejects(port(response(false, 'PR_HEAD_UNAVAILABLE', null)).prHead(A), { code: 'PR_HEAD_UNAVAILABLE' });
  await assert.rejects(port(null).prHead(A), { code: 'PR_HEAD_NO_ANSWER' });
  await assert.rejects(port(response(true, null, null)).prHead(A), { code: 'PR_HEAD_UNAVAILABLE' }, 'ok without a pull is no answer either');
  await assert.rejects(port({ ok: false, code: 'not a code', pull: null }).prHead(A), { code: 'PR_HEAD_UNAVAILABLE' });
  assert.deepEqual(await port(response(true, null, { number: A, state: 'open', headSha: HEAD, draft: false })).prHead(A), { number: A, state: 'open', headSha: HEAD, draft: false });
});

// §3 item 7.
test('structure: executor.mjs compares a live read\'s state or head only through pr-candidate.mjs', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = await fs.readFile(path.join(here, '..', 'src', 'executor.mjs'), 'utf8');
  assert.ok(/from '\.\/pr-candidate\.mjs'/.test(src), 'the one judgement is imported');
  const compare = /\blive\??\.state\s*[!=]==|[!=]==\s*live\??\.state\b|\blive\??\.headSha\s*[!=]==\s*subject\.headSha|subject\.headSha\s*[!=]==\s*live\??\.headSha/g;
  const lines = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => compare.test(l) || (compare.lastIndex = 0, false));
  assert.deepEqual(lines, [], 'no state or head comparison of a live read outside pr-candidate.mjs');
});

// §3 item 8 (must fail before the fix).
test('status: a queued row behind a running batch is due no earlier than that batch\'s estimated end and names it; a held draft head is rewritten once', async t => {
  let f = null;
  const board = new StatusBoard({ clock: () => f?.clock() ?? T0 });
  board.update({ backfill: { complete: true, published: 0, unreadable: 0 } });
  f = await field(t, { status: board });
  let seen = null;
  f.engine.onStage = n => { if (n === 4 && !seen) seen = parseStatus(Buffer.from(JSON.stringify(board.snapshot()))); };
  await f.drop(triggerBytes());
  await f.drop(triggerBytes({ pr: B, headSha: HB }));
  const started = f.clock();
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.ok(seen, 'the board was read while A ran stage 4');
  assert.equal(seen.current?.pr, A);
  const row = seen.pending.find(p => p.pr === B);
  const eta = typeof row?.eta === 'number' ? row.eta : Date.parse(row?.eta ?? '');
  assert.ok(eta >= started + ETA_BATCH_MS, `B is due no earlier than A's estimated end (eta ${row?.eta})`);
  const page = prPage({ pull: { pr: B, headSha: HB, eligible: true }, status: seen, now: f.clock() });
  assert.match(page.description, new RegExp(`#${A} 的批次在跑（第 4 段）`), page.description);

  // The PR page of a draft head this node wrote before: rewritten once to say it is held; a head it never wrote stays untouched.
  const root = await tempRoot(t);
  const now = T0;
  const store = await LocalStore.open(path.join(root, 'store.json'), () => now);
  const calls = [];
  const run = async argv => { calls.push(argv); return argv.some(a => a.includes('/rules/branches/main')) ? rulesReply(['kooyumi-work-admission']) : { code: 0, stdout: '{}' }; };
  const reporter = new PrStatusReporter({ node: 'node-b', repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', run, clock: () => now, store });
  const status = parseStatus(Buffer.from(JSON.stringify(board.snapshot())));
  const posts = () => calls.filter(a => a.includes('POST'));
  const descriptionOf = a => a[a.indexOf('description=') >= 0 ? a.indexOf('description=') : a.findIndex(x => x.startsWith('description='))];
  assert.ok((await reporter.pass({ pulls: [{ pr: A, headSha: HEAD, eligible: true, hint: null, behindBy: 0 }], status })).posted >= 1, 'A\'s page written while it was open');
  const before = posts().length;
  const drafts = [{ pr: A, headSha: HEAD }, { pr: 886, headSha: H(6) }];
  const other = [{ pr: B, headSha: HB, eligible: true, hint: null, behindBy: 0 }];
  await reporter.pass({ pulls: other, drafts, status });
  const draftPosts = posts().slice(before).filter(a => a.some(x => x.includes(`/statuses/${HEAD}`)));
  assert.equal(draftPosts.length, 1, 'rewritten once');
  assert.ok(draftPosts[0].some(x => x.includes(DRAFT_TEXT)), String(descriptionOf(draftPosts[0])));
  assert.equal(posts().slice(before).filter(a => a.some(x => x.includes(`/statuses/${H(6)}`))).length, 0, 'never written before: untouched');
  const again = posts().length;
  await reporter.pass({ pulls: other, drafts, status });
  assert.equal(posts().slice(again).filter(a => a.some(x => x.includes(`/statuses/${HEAD}`))).length, 0, 'only once');

  // The poller names the draft PRs it skipped (for the rewrite above), and still proposes none of them.
  const written = [];
  const pollRun = async argv => {
    if (argv.some(a => a.includes('/compare/'))) return { code: 0, stdout: JSON.stringify({ behind_by: 0, base: 'd'.repeat(40), merge_base: 'd'.repeat(40) }) };
    if (argv.some(a => a.includes('/git/ref') || a.includes('/branches/main') || a.includes('commits/main'))) return { code: 0, stdout: JSON.stringify({ sha: 'd'.repeat(40), object: { sha: 'd'.repeat(40) } }) };
    return { code: 0, stdout: '[]' };
  };
  const poller = new Poller({ repo: REPO, ghExe: 'C:\\gh.exe', run: pollRun, writeTrigger: async x => { written.push(x); }, clock: () => now });
  poller.openPulls = async () => [{ number: A, headRefOid: HEAD, baseRefOid: 'd'.repeat(40), isDraft: true, updatedAt: 't' }];
  poller.mainTip = async () => 'd'.repeat(40);
  await poller.pass();
  assert.deepEqual(written, [], 'a draft is never proposed');
  assert.deepEqual(poller.lastPass.drafts, [{ pr: A, headSha: HEAD }]);
});
