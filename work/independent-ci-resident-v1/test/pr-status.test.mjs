// The poller's up-to-date filter, and the PR page status and Windows notifications the companion derives from the
// executor's status (resident quota redesign v0.6 + §9, phase 1, items 6 and 7).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { COMPARE_TIMEOUT_MS, MAX_COMPARES_PER_PASS, Poller, upToDate } from '../src/poller.mjs';
import { ADVISORY_TIMEOUT_MS, LocalStore, PASS_BUDGET_MS, POST_RETRY_MS, PrStatusReporter, contextFree, contextShapeSafe, describe, events, toastArgv, validateStatusConfig } from '../src/pr-status.mjs';
import { nodeContext, standbyContext } from '../src/node-duty.mjs';
// Task 9cac75be A3: no default node; these reporters are the node named node-b (node: 'node-b').
const PR_STATUS_CONTEXT = nodeContext('node-b');

test('a Native claim or head authorization change notice does not claim that PR text changed', () => {
  const shown = events({ status: { pending: [], notices: [{ kind: 'new-trigger', code: 'CLAIM_CHANGED', key: 'native:1', pr: 1, headSha: 'a'.repeat(40) }] }, now: Date.now() });
  assert.match(shown[0].title, /认领或授权已更新/);
  assert.ok(!shown[0].body.includes('正文'));
});
import { lane } from '../src/companion-main.mjs';
import { restPolls } from './gh-rest-stub.mjs';

test('C2 role notices are fixed local notifications without a PR status or retry instruction', () => {
  const now = Date.parse('2026-10-25T00:00:00Z');
  const s = { writtenAt: now, current: null, halt: null, pending: [], notices: [
    { kind: 'role-probe-connection', key: 'connection:1', code: 'ROLE_PROBE_CONNECTION_UNAUTHORIZED' },
    { kind: 'role-probe-uncertain', key: 'uncertain:1', code: 'ROLE_PROBE_UNCERTAIN' } ] };
  const notes = events({ status: s, now }); assert.equal(notes.length, 2);
  assert.match(notes[0].title, /连接授权/); assert.match(notes[1].title, /三次/);
  assert.ok(notes.every(x => !x.title.includes('PR #')));
});
import { Runner } from '../src/runner.mjs';
import { StatusBoard, parseStatus } from '../src/status.mjs';
import { rulesReply, tempRoot } from './helpers.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const MAIN = 'd'.repeat(40), OLD = 'e'.repeat(40);
const H = n => String(n).repeat(40).slice(0, 40);
const TRAILER = 'x\nClued-Work-Claim: 842cf499-1519-4ba9-b3be-b9ac3f6e8ee4\n';
const REQUIRED = ['kooyumi-work-admission', 'gitleaks', 'trivy', 'contract-placement', 'kooyumi-admission-verified', 'kooyumi-merge-slot'];

test('up to date with main = PR base.sha is the main tip AND compare says behind_by 0; the hint names what to do', () => {
  assert.deepEqual(upToDate({ mainSha: MAIN, baseSha: MAIN, behindBy: 0 }), { eligible: true, hint: null });
  assert.deepEqual(upToDate({ mainSha: MAIN, baseSha: OLD, behindBy: 0 }), { eligible: false, hint: 'push-any-commit' });
  assert.deepEqual(upToDate({ mainSha: MAIN, baseSha: OLD, behindBy: 3 }), { eligible: false, hint: 'merge-main' });
  assert.deepEqual(upToDate({ mainSha: MAIN, baseSha: MAIN, behindBy: 2 }), { eligible: false, hint: 'merge-main' });
  assert.deepEqual(upToDate({ mainSha: MAIN, baseSha: MAIN, behindBy: null }), { eligible: false, hint: 'compare-unavailable' });
});

test('the poller proposes only up-to-date heads (the nine stale-base burns of 2026-10-22), caches compares, reports the rest', async () => {
  const pulls = [
    { number: 1, headRefOid: H(1), baseRefOid: MAIN, isDraft: false, body: TRAILER, updatedAt: 't' },   // up to date
    { number: 2, headRefOid: H(2), baseRefOid: OLD, isDraft: false, body: TRAILER, updatedAt: 't' },    // stale base, behind
    { number: 3, headRefOid: H(3), baseRefOid: OLD, isDraft: false, body: TRAILER, updatedAt: 't' },    // contains main, base not moved
    { number: 4, headRefOid: H(4), baseRefOid: MAIN, isDraft: false, body: TRAILER, updatedAt: 't' },   // compare unavailable
  ];
  const behind = { [H(1)]: 0, [H(2)]: 5, [H(3)]: 0 };
  const calls = [], written = [];
  const run = async argv => {
    calls.push(argv);
    const compare = argv.find(a => a.includes('/compare/'));
    if (compare) {
      const head = compare.split('...')[1].split('?')[0];
      return head in behind ? { code: 0, stdout: JSON.stringify({ behind_by: behind[head], base: MAIN }) } : { code: 1, stdout: '' };
    }
    if (argv.includes('api')) return { code: 0, stdout: `${MAIN}\n` };
    return { code: 0, stdout: JSON.stringify(pulls) };
  };
  let clock = 0;
  const p = new Poller({ repo: REPO, ghExe: 'C:\\gh.exe', run: restPolls(run, { main: () => MAIN, pulls: () => pulls }), writeTrigger: async v => written.push(v), clock: () => clock });
  assert.equal(await p.pass(), 1);
  assert.deepEqual(written.map(w => [w.pr, w.baseSha]), [[1, MAIN]]);
  assert.deepEqual(p.lastPass.pulls.map(x => [x.pr, x.eligible, x.hint, x.behindBy]), [[1, true, null, 0], [2, false, 'merge-main', 5], [3, false, 'push-any-commit', 0], [4, false, 'compare-unavailable', null]]);
  const comparesNow = () => calls.filter(a => a.some(x => x.includes('/compare/'))).length;
  const compares = comparesNow();
  clock += 59_999;
  await p.pass();
  assert.equal(comparesNow() - compares, 0, 'answered compares are cached; the unavailable one waits one minute');
  clock += 1;
  await p.pass();
  assert.equal(comparesNow() - compares, 1, 'then only the unavailable one is asked again');
});

test('the advisory work is bounded: short calls, at most MAX_COMPARES_PER_PASS compares and a pass budget for the reporter', async t => {
  // poller: 15 uncached PRs -> 10 compares this pass, the rest "compare-unavailable" until the next pass
  const pulls = Array.from({ length: 15 }, (_, i) => ({ number: i + 1, headRefOid: String(i + 1).padStart(40, 'c'), baseRefOid: MAIN, isDraft: false, body: TRAILER, updatedAt: 't' }));
  const timeouts = [];
  const run = async (argv, o) => {
    if (argv.some(a => a.includes('/compare/'))) { timeouts.push(o.timeoutMs); return { code: 0, stdout: JSON.stringify({ behind_by: 0, base: MAIN }) }; }
    if (argv.includes('api')) return { code: 0, stdout: `${MAIN}\n` };
    return { code: 0, stdout: JSON.stringify(pulls) };
  };
  const p = new Poller({ repo: REPO, ghExe: 'C:\\gh.exe', run: restPolls(run, { main: () => MAIN, pulls: () => pulls }), writeTrigger: async () => {}, clock: () => 0 });
  assert.equal(await p.pass(), MAX_COMPARES_PER_PASS);
  assert.deepEqual([timeouts.length, [...new Set(timeouts)]], [MAX_COMPARES_PER_PASS, [COMPARE_TIMEOUT_MS]]);
  assert.equal(p.lastPass.pulls.filter(x => x.hint === 'compare-unavailable').length, 5);
  assert.equal(await p.pass(), 5, 'the next pass compares the rest');
  // reporter: every call is short; a failed write is left alone for POST_RETRY_MS; no call starts after the budget
  const root = await tempRoot(t);
  let now = Date.parse('2026-10-22T09:00:00Z');
  const calls = [];
  let postOk = false, cost = 0;
  const run2 = async (argv, o) => {
    calls.push([argv, o.timeoutMs]); now += cost;
    if (argv.some(a => a.includes('/rules/branches/main'))) return rulesReply(REQUIRED);
    return { code: postOk ? 0 : 1, stdout: '{}' };
  };
  const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const reporter = new PrStatusReporter({ node: 'node-b', repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: PS, run: run2, clock: () => now,
    store: await LocalStore.open(path.join(root, 'store.json'), () => now) });
  const prs = [{ pr: 7, headSha: H(7), eligible: false, hint: 'merge-main', behindBy: 2 }, { pr: 9, headSha: H(9), eligible: false, hint: 'merge-main', behindBy: 3 }];
  const posts = () => calls.filter(([a]) => a.includes('POST')).length;
  assert.equal((await reporter.pass({ pulls: prs, status: null })).posted, 0);
  assert.equal(posts(), 2);
  assert.ok(calls.every(([, ms]) => ms === ADVISORY_TIMEOUT_MS));
  postOk = true;
  assert.equal((await reporter.pass({ pulls: prs, status: null })).posted, 0, 'a failed head is not retried every minute');
  now += POST_RETRY_MS;
  assert.equal((await reporter.pass({ pulls: prs, status: null })).posted, 2, 'retried after POST_RETRY_MS');
  // budget: each call takes 40 s, so the second write never starts
  cost = 40_000; now += 31 * 60_000;
  const slow = new PrStatusReporter({ node: 'node-b', repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: PS, run: run2, clock: () => now,
    store: await LocalStore.open(path.join(root, 'slow.json'), () => now), notifications: false });
  const before = posts();
  assert.equal((await slow.pass({ pulls: prs, status: null })).posted, 1);
  assert.equal(posts() - before, 1, `nothing starts after ${PASS_BUDGET_MS} ms`);
});

test('a stalled advisory call ends the pass: nothing it could not do is recorded as done or failed (independent re-review, MINOR-B)', async t => {
  const root = await tempRoot(t);
  let now = Date.parse('2026-10-22T09:00:00Z');
  const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  // A busy Runner (an earlier child still running) refuses every call: the HALT toast keeps its key, no head is failed.
  let mode = 'busy';
  const calls = [];
  const run = async argv => {
    calls.push(argv);
    if (mode === 'busy') return { code: null, stdout: '', stderr: '', refused: 'RUNNER_BUSY_WITH_UNFINISHED_CHILD' };
    if (mode === 'slow-rules' && argv.some(a => a.includes('/rules/branches/main'))) return { code: null, stdout: '', stderr: '', timedOut: true };
    if (argv.some(a => a.includes('/rules/branches/main'))) return rulesReply(REQUIRED);
    return { code: 0, stdout: '{}' };
  };
  const reporter = new PrStatusReporter({ node: 'node-b', repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: PS, run, clock: () => now, store: await LocalStore.open(path.join(root, 's.json'), () => now) });
  const prs = [{ pr: 9, headSha: H(9), eligible: false, hint: 'merge-main', behindBy: 3 }];
  const halted = boardStatus(b => b.update({ halt: { code: 'X_Y', at: '2026-10-22T09:00:00Z' } }), now);
  const first = await reporter.pass({ pulls: prs, status: halted });
  assert.deepEqual([first.stalled, first.toasts, first.posted, calls.length], [true, 0, 0, 1], 'one refused call, then the pass ends');
  assert.equal(reporter.store.data.notified['halt:X_Y:2026-10-22T09:00:00Z'], undefined, 'the HALT toast is still owed');
  // the rules read times out: no write, and the head is not marked failed
  mode = 'slow-rules';
  const second = await reporter.pass({ pulls: prs, status: halted });
  assert.deepEqual([second.stalled, second.toasts, second.posted, reporter.failed.size], [true, 1, 0, 0]);
  mode = 'ok';
  assert.equal((await reporter.pass({ pulls: prs, status: halted })).posted, 1, 'written once the Runner answers again');
  // poller: a timed-out compare stops this pass without using the budget, then retries with bounded backoff
  let slowHead = null;
  const slowCalls = [];
  const pulls = [1, 2, 3].map(i => ({ number: i, headRefOid: String(i).padStart(40, 'c'), baseRefOid: MAIN, isDraft: false, body: TRAILER, updatedAt: 't' }));
  const prun = async argv => {
    const c = argv.find(a => a.includes('/compare/'));
    if (c?.includes(slowHead)) {
      slowCalls.push(clock);
      return { code: null, stdout: '', stderr: '', timedOut: true };
    }
    if (c) return { code: 0, stdout: JSON.stringify({ behind_by: 0, base: MAIN }) };
    if (argv.includes('api')) return { code: 0, stdout: `${MAIN}\n` };
    return { code: 0, stdout: JSON.stringify(pulls) };
  };
  let clock = 0;
  const p = new Poller({ repo: REPO, ghExe: 'C:\\gh.exe', run: restPolls(prun, { main: () => MAIN, pulls: () => pulls }), writeTrigger: async () => {}, clock: () => clock });
  slowHead = pulls[0].headRefOid;
  assert.equal(await p.pass(), 0, 'the first compare hangs: nothing compared after it this pass');
  assert.equal(p.compareBudget, MAX_COMPARES_PER_PASS, 'the budget is not used by a stalled call');
  assert.equal(await p.pass(), 2, 'next pass: the slow one is skipped, the PRs behind it are compared');
  for (const minutes of [1, 2, 4, 4]) {
    const beforeRetry = slowCalls.length;
    clock += minutes * 60_000 - 1;
    await p.pass();
    assert.equal(slowCalls.length, beforeRetry);
    clock += 1;
    await p.pass();
    assert.equal(slowCalls.length, beforeRetry + 1);
  }
  clock += 4 * 60_000;
  slowHead = 'none';
  assert.equal(await p.pass(), 1, 'the next capped retry proposes the head when the compare succeeds');
});

test('two lanes: a hung advisory child never stops the companion answering the mailbox (independent review M1)', async () => {
  // fake children: the advisory one never exits (the Runner never kills it), the companion's ones exit at once
  const child = () => { const handlers = {}; return { stdout: null, stderr: null, on: (e, f) => { handlers[e] = f; }, handlers }; };
  const hung = [];
  const advisory = new Runner({ spawnImpl: () => { const c = child(); hung.push(c); return c; } });
  const runner = new Runner({ spawnImpl: () => { const c = child(); setImmediate(() => c.handlers.close?.(0)); return c; } });
  let ticks = 0, steps = 0, advisoryCalls = 0, stopped = false;
  const wait = () => new Promise(r => setImmediate(r));
  const stop = () => stopped || ++ticks > 400;
  await Promise.all([
    lane({ runner, sleep: wait, stop, work: async () => { const r = await runner.run(['C:\\wsl.exe', 'x'], { timeoutMs: 1_000 }); if (r.code === 0) steps += 1; } }),
    lane({ runner: advisory, sleep: wait, stop, work: async () => { advisoryCalls += 1; await advisory.run(['C:\\gh.exe', 'api'], { timeoutMs: 1 }); } }),
  ]);
  assert.equal(hung.length, 1, 'the advisory lane waits for its own hung child');
  assert.equal(advisoryCalls, 1);
  assert.equal(advisory.busy, true);
  assert.ok(steps > 50, `the companion lane kept answering (${steps} steps)`);
  stopped = true;
});

const boardStatus = (fn, now) => { const b = new StatusBoard({ clock: () => now }); fn(b); return parseStatus(Buffer.from(JSON.stringify(b.snapshot()))); };

test('the PR page text per head: running stage, queue position, outcome, HALT, stale; generic texts are weak', () => {
  const now = Date.parse('2026-10-22T09:00:00Z');
  const pull = (o = {}) => ({ pr: 7, headSha: H(7), eligible: true, hint: null, behindBy: 0, ...o });
  assert.deepEqual(describe({ pull: pull({ eligible: false, hint: 'merge-main', behindBy: 4 }), status: null, now }).state, 'pending');
  assert.match(describe({ pull: pull({ eligible: false, hint: 'push-any-commit' }), status: null, now }).description, /推一个任意提交即可/);
  assert.equal(describe({ pull: pull({ eligible: false, hint: 'compare-unavailable' }), status: null, now }), null);
  const s = fn => boardStatus(b => { b.update({ backfill: { complete: true, published: 0, unreadable: 0 } }); fn(b); }, now);
  assert.match(describe({ pull: pull(), status: s(b => b.setCurrent({ key: 'a'.repeat(64), pr: 7, headSha: H(7), baseSha: MAIN, attempt: 1, stage: 4 })), now }).description, /第 4 段（trivy 扫描）/);
  const queued = describe({ pull: pull(), status: s(b => b.setPending([{ pr: 6, headSha: H(6), baseSha: MAIN }, { pr: 7, headSha: H(7), baseSha: MAIN, deferred: 'DAILY_BATCH_LIMIT' }])), now });
  assert.deepEqual([queued.state, queued.description], ['pending', '排队第 2 位：今日执行批次额度已满，明天继续']);
  // generation 15 (DESIGN 60.2): the take-over sweep after main was rewritten says why nothing goes green
  const sweepView = pending => ({ at: new Date(now).toISOString(), mode: 'on', kind: 'full-segment', complete: true, revoked: 0, unconfirmed: 0, fullState: 'running',
    fullCompletedAt: null, fullSinceOn: false, onSince: null, fullScope: 'all', fullScopeReason: pending, fullAllPending: pending });
  const held = pending => describe({ pull: pull(), now, status: s(b => { b.setPending([{ pr: 7, headSha: H(7), baseSha: MAIN }]);
    b.update({ queue: { depth: 1, generation: 'a'.repeat(12), hold: 'TRAIN_TAKEOVER_SWEEP_PENDING', live: 1, parkingFull: false }, train: { enabled: 'on', last: null, sweep: sweepView(pending) } }); }) }).description;
  assert.match(held('TRAIN_MAIN_REWRITTEN'), /：main 被改写，合并列车在重扫全部 PR 和提交，扫完前不发绿$/);
  assert.match(held(null), /：合并列车接管扫描中$/);
  assert.equal(describe({ pull: pull(), status: s(b => b.outcome({ pr: 7, headSha: H(7), outcome: 'COMPLETED' })), now }).state, 'success');
  assert.equal(describe({ pull: pull(), status: s(b => b.outcome({ pr: 7, headSha: H(7), outcome: 'FAILED_CLEAN', code: 'STAGE_CHILD_REFUSED', retry: 'new-commit' })), now }).state, 'failure');
  assert.equal(describe({ pull: pull(), status: s(b => b.outcome({ pr: 7, headSha: H(7), outcome: 'FAILED_CLEAN', code: 'GITHUB_TRANSIENT_UNAVAILABLE', retry: 'attempt2' })), now }).state, 'pending');
  // review R3 MINOR 10: S recomputed by GitHub needs no new commit (the next stage 10 opens the second front batch)
  const gone = describe({ pull: pull(), status: s(b => b.outcome({ pr: 7, headSha: H(7), outcome: 'FAILED_CLEAN', code: 'TRAIN_TEST_COMMIT_GONE', retry: 'new-commit' })), now });
  assert.equal(gone.state, 'pending');
  assert.match(gone.description, /不用推新提交/);
  assert.match(describe({ pull: pull(), status: s(b => b.setPending([{ pr: 7, headSha: H(7), baseSha: MAIN, deferred: 'TRAIN_NON_FRONT_RUNS_OFF' }])), now }).description, /只跑车头批次/);
  // defect a8910e41: the binding run is released (NOT_EXECUTED) and its head waits within the duty: the same words, no new commit asked for
  const boundRun = describe({ pull: pull(), status: s(b => b.outcome({ pr: 7, headSha: H(7), outcome: 'NOT_EXECUTED', code: 'TRAIN_FRONT_CLAIM_BOUND', klass: 'queue', retry: 'new-trigger' })), now });
  assert.deepEqual([boundRun.state, /已为队首认领绑定此 PR.*不用推新提交/.test(boundRun.description)], ['pending', true]);
  assert.match(describe({ pull: pull(), status: s(b => b.setPending([{ pr: 7, headSha: H(7), baseSha: MAIN, deferred: 'TRAIN_FRONT_BOUND_HEAD' }])), now }).description, /已为队首认领绑定/);
  assert.equal(describe({ pull: pull(), status: s(b => b.outcome({ pr: 7, headSha: H(7), outcome: 'NOT_ADMITTED', code: 'OWNER_REVIEW_REQUIRED', klass: 'waiting' })), now }).state, 'pending');
  assert.equal(describe({ pull: pull(), status: s(b => b.outcome({ pr: 7, headSha: H(7), outcome: 'IGNORED', code: 'HEAD_ALREADY_PUBLISHED_NO_RETRY' })), now }), null, 'what was written stays');
  assert.equal(describe({ pull: pull(), status: s(b => b.update({ halt: { code: 'ROLE_ALREADY_PUBLISHED_ON_HEAD', at: '2026-10-22T08:00:00Z' } })), now }).state, 'error');
  const stale = boardStatus(b => b.update({ backfill: { complete: true, published: 0, unreadable: 0 } }), now - 10 * 60_000);
  assert.match(describe({ pull: pull(), status: stale, now }).description, /未更新/);
  assert.equal(describe({ pull: pull(), status: s(() => {}), now }).weak, true, '"proposed" never replaces a written status');
  for (const d of [describe({ pull: pull({ eligible: false, hint: 'merge-main', behindBy: 123456 }), status: null, now })]) assert.ok(d.description.length <= 140);
});

test('the status context can never be a required check: its shape, and a live read of main\'s rules before any write', () => {
  assert.equal(contextShapeSafe(PR_STATUS_CONTEXT), true);
  for (const r of REQUIRED) assert.equal(contextShapeSafe(r), false, r);
  assert.equal(contextFree(PR_STATUS_CONTEXT, REQUIRED), true);
  assert.equal(contextFree(PR_STATUS_CONTEXT, [...REQUIRED, ' RESIDENT-QUEUE/NODE-B (INFO ONLY) ']), false);
  assert.equal(PR_STATUS_CONTEXT, 'resident-queue/node-b (info only)', 'review NIT 1: each node its own name');
  assert.equal(contextFree(PR_STATUS_CONTEXT, null), false, 'unknown rules: never');
});

test('notifications: HALT, a stopped status, a head waiting over an hour; each key once (the reporter keeps them)', async t => {
  const now = Date.parse('2026-10-22T09:00:00Z');
  const s = boardStatus(b => {
    b.update({ halt: { code: 'EXECUTED_HEADS_BACKFILL_MANIFEST_MISSING', at: '2026-10-22T08:59:00Z' } });
    b.setPending([{ pr: 7, headSha: H(7), baseSha: MAIN, deferred: 'DAILY_BATCH_LIMIT', since: '2026-10-22T07:30:00Z' }, { pr: 8, headSha: H(8), baseSha: MAIN, since: '2026-10-22T08:50:00Z' }]);
  }, now);
  const e = events({ status: s, now });
  assert.deepEqual(e.map(x => x.key), ['halt:EXECUTED_HEADS_BACKFILL_MANIFEST_MISSING:1792659540000', `wait:7:${H(7)}:DAILY_BATCH_LIMIT`]);
  assert.deepEqual(events({ status: boardStatus(() => {}, now - 6 * 60_000), now }).map(x => x.key.split(':')[0]), ['stale']);
  assert.deepEqual(events({ status: null, statusError: true, now, startedAt: now - 10 * 60_000 }).map(x => x.key), ['status-unreadable']);
  assert.deepEqual(events({ status: null, statusError: true, now, startedAt: now }).map(x => x.key), [], 'not right after the companion starts');
  // the toast: a fixed script, the texts only as Base64
  const argv = toastArgv('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'T\'"<x>', 'B; Remove-Item C:\\');
  assert.deepEqual(argv.slice(0, 8), ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand']);
  const script = Buffer.from(argv[8], 'base64').toString('utf16le');
  assert.ok(!script.includes('Remove-Item') && !script.includes('<x>'), 'no text is spliced into the script');
  assert.ok(script.includes(Buffer.from('B; Remove-Item C:\\', 'utf8').toString('base64')));
});

test('the reporter writes a status only when it changes, never over a required check, and shows each toast once', async t => {
  const root = await tempRoot(t);
  let now = Date.parse('2026-10-22T09:00:00Z');
  const store = await LocalStore.open(path.join(root, 'store.json'), () => now);
  const calls = [];
  let required = REQUIRED;
  const run = async argv => {
    calls.push(argv);
    if (argv.some(a => a.includes('/rules/branches/main'))) return required ? rulesReply(required) : { code: 1, stdout: '' };
    return { code: 0, stdout: '{}' };
  };
  const reporter = new PrStatusReporter({ node: 'node-b', repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', run, clock: () => now, store });
  const pulls = [{ pr: 7, headSha: H(7), eligible: true, hint: null, behindBy: 0 }, { pr: 9, headSha: H(9), eligible: false, hint: 'merge-main', behindBy: 2 }];
  const status = boardStatus(b => { b.update({ backfill: { complete: true, published: 0, unreadable: 0 } }); b.outcome({ pr: 7, headSha: H(7), outcome: 'COMPLETED' }); }, now);
  const posts = () => calls.filter(a => a.includes('POST'));
  assert.deepEqual(await reporter.pass({ pulls, status }), { posted: 2, toasts: 0, collision: false, stalled: false });
  const first = posts();
  assert.deepEqual(first.map(a => a[a.indexOf('-f') + 1]), ['state=success', 'state=pending']);
  assert.ok(first.every(a => a.includes(`context=${PR_STATUS_CONTEXT}`) && a.includes(`repos/${REPO}/statuses/${a[4].split('/').pop()}`)));
  assert.ok(first.every(a => !a.some(x => /comments/.test(x))), 'never a comment');
  assert.equal((await reporter.pass({ pulls, status })).posted, 0, 'unchanged: nothing written');
  // a generic "proposed" never replaces what was written
  assert.equal((await reporter.pass({ pulls, status: boardStatus(b => b.update({ backfill: { complete: true, published: 0, unreadable: 0 } }), now) })).posted, 0);
  // the store survives a companion restart
  const again = new PrStatusReporter({ node: 'node-b', repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', run, clock: () => now,
    store: await LocalStore.open(path.join(root, 'store.json'), () => now) });
  assert.equal((await again.pass({ pulls, status })).posted, 0);
  // a collision with a required check: nothing is written, the Owner is told once
  required = [...REQUIRED, PR_STATUS_CONTEXT];
  now += 31 * 60_000;
  const halted = boardStatus(b => b.update({ halt: { code: 'X_Y', at: '2026-10-22T09:31:00Z' } }), now);
  const before = posts().length;
  const r = await reporter.pass({ pulls, status: halted });
  assert.deepEqual([r.posted, r.collision, posts().length - before], [0, true, 0]);
  assert.equal(r.toasts, 1, 'the HALT (the notifications run first, before the rules are read)');
  assert.equal((await reporter.pass({ pulls, status: halted })).toasts, 1, 'the collision, one pass later');
  assert.equal((await reporter.pass({ pulls, status: halted })).toasts, 0, 'each key once');
  // unknown rules: the failure is said once per head (a status is auxiliary), nothing else is written
  required = null; now += 31 * 60_000;
  const fresh = new PrStatusReporter({ node: 'node-b', repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', run, clock: () => now,
    store: await LocalStore.open(path.join(root, 'other.json'), () => now), notifications: false });
  assert.equal((await fresh.pass({ pulls, status })).posted, 0, 'a first failure is a flap: nothing is said');
  now += 11 * 60_000;
  const before2 = posts().length;
  assert.equal((await fresh.pass({ pulls, status })).posted, 2, 'a lasting failure is said, once per head');
  assert.ok(posts().slice(before2).every(a => a.some(x => x.startsWith('description=无法读取 main 规则集'))));
  assert.equal((await fresh.pass({ pulls, status })).posted, 0, 'said once');
  // Task 9cac75be A3: no default node (the companion names its pinned node profile's)
  assert.deepEqual(validateStatusConfig(undefined), { prStatus: true, notifications: true, node: null });
  assert.deepEqual(validateStatusConfig({ notifications: false }), { prStatus: true, notifications: false, node: null });
  assert.throws(() => new PrStatusReporter({ repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', run, clock: () => now, store }),
    { code: 'PR_STATUS_NODE_REQUIRED' });
  assert.throws(() => validateStatusConfig({ other: true }), { code: 'COMPANION_STATUS_CONFIG_INVALID' });
  assert.ok((await fs.readdir(root)).includes('store.json'));
});

test('§41.6a: while the heartbeat shows the failover watchdog stale, the PR page status says 自动接班看门狗未运行 (and the toast goes as before)', async t => {
  const { CompanionHeartbeat, WATCHDOG_STALE_MS } = await import('../src/companion-heartbeat.mjs');
  const { WATCHDOG_STALE_TEXT, withWatchdogLine } = await import('../src/pr-status.mjs');
  const root = await tempRoot(t);
  let now = Date.parse('2026-10-22T09:00:00Z'), tick = now - WATCHDOG_STALE_MS - 1;
  const notes = [], calls = [];
  const nextTurn = () => new Promise(resolve => setImmediate(resolve));
  const hb = new CompanionHeartbeat({ nodeName: 'node-b', clock: () => now, readToken: async () => 'clued_hb_x', readStatus: async () => null, serviceRunning: async () => true,
    transport: async () => ({ ok: true, tokenRefused: false, autoHandover: null, watchdogTickAt: tick }), notify: async (k, title) => { notes.push(title); },
    memory: { get: async () => { await nextTurn(); return 0; }, set: async () => {} }, handover: {} });
  const run = async argv => { calls.push(argv); return argv.some(a => a.includes('/rules/branches/main')) ? rulesReply(REQUIRED) : { code: 0, stdout: '{}' }; };
  const reporter = new PrStatusReporter({ node: 'node-b', repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', run, clock: () => now,
    store: await LocalStore.open(path.join(root, 's.json'), () => now), notifications: false });
  reporter.watchdogStale = () => hb.watchdogStale === true; // as companion-main.mjs wires it
  const pulls = [{ pr: 7, headSha: H(7), eligible: true, hint: null, behindBy: 0 }];
  const status = boardStatus(b => { b.update({ backfill: { complete: true, published: 0, unreadable: 0 } }); b.outcome({ pr: 7, headSha: H(7), outcome: 'COMPLETED' }); }, now);
  const described = () => calls.filter(a => a.includes('POST')).map(a => a.find(x => x.startsWith('description=')).slice('description='.length));
  assert.equal(hb.watchdogStale, false, 'nothing known yet');
  await reporter.pass({ pulls, status });
  assert.ok(!described()[0].includes(WATCHDOG_STALE_TEXT));
  await hb.step();
  // 心跳返回时，后台通知可能仍在读取存储。
  for (let turns = 0; turns < 5 && notes.length === 0; turns++) await nextTurn();
  assert.deepEqual([hb.watchdogStale, notes], [true, ['自动接班看门狗未运行']]);
  await reporter.pass({ pulls, status });
  assert.ok(described()[1].endsWith(`；${WATCHDOG_STALE_TEXT}`), described()[1]);
  // the watchdog ticks again: the next answer clears it and the text goes back
  now += 11 * 60_000; tick = now - 60_000;
  await hb.step();
  assert.equal(hb.watchdogStale, false);
  await reporter.pass({ pulls, status: boardStatus(b => { b.update({ backfill: { complete: true, published: 0, unreadable: 0 } }); b.outcome({ pr: 7, headSha: H(7), outcome: 'COMPLETED' }); }, now) });
  assert.equal(described()[2], described()[0]);
  // a long text keeps its start (the duty word) and the warning, within the 140 characters
  const long = withWatchdogLine({ state: 'pending', description: `当班：${'x'.repeat(200)}` }, true);
  assert.ok(long.description.length <= 140 && long.description.startsWith('当班：') && long.description.endsWith(WATCHDOG_STALE_TEXT));
  assert.equal(withWatchdogLine(null, true), null);
  assert.deepEqual(withWatchdogLine({ state: 'success', description: 'x' }, false), { state: 'success', description: 'x' });
});

test('phase 2: the PR page says where the run queue has the head: its place and estimated start, a wait, a back-off, a stop, the breaker', () => {
  const now = Date.parse('2026-10-22T09:00:00Z');
  const pull = (o = {}) => ({ pr: 7, headSha: H(7), eligible: true, hint: null, behindBy: 0, ...o });
  const s = fn => boardStatus(b => { b.update({ backfill: { complete: true, published: 0, unreadable: 0 } }); fn(b); }, now);
  const row = o => ({ pr: 7, headSha: H(7), baseSha: MAIN, state: 'QUEUED', position: 2, eta: now + 22 * 60_000, ...o });
  assert.equal(describe({ pull: pull(), status: s(b => b.setPending([row()])), now }).description, '排队第 2 位，预计 09:22Z 开始');
  assert.equal(describe({ pull: pull(), status: s(b => b.setPending([row({ state: 'WAITING', position: null, reason: 'OWNER_REVIEW_REQUIRED', nextAt: now + 40 * 60_000 })])), now }).description,
    '等 Owner 批准受保护改动：约 09:40Z 自动重试，批准或修正后编辑 PR 可提前');
  const back = describe({ pull: pull(), status: s(b => b.setPending([row({ state: 'BACKOFF', position: null, reason: 'CLAIM_NOT_CURRENT', nextAt: now + 10 * 60_000, level: 1 })])), now });
  assert.deepEqual([back.state, back.description], ['pending', '未准入或未执行（CLAIM_NOT_CURRENT）：约 09:10Z 自动重试（第 1 次）；认领持有人授权此提交后，约 10 分钟内自动重试（编辑 PR 不会提前）']);
  assert.equal(describe({ pull: pull(), status: s(b => b.setPending([row({ state: 'STOPPED', position: null, reason: 'CLAIM_NOT_CURRENT', stopKind: 'release-cap' })])), now }).state, 'failure');
  assert.match(describe({ pull: pull(), status: s(b => b.setPending([row({ state: 'STOPPED', position: null, reason: 'PROTECTED_CHANGE_NOT_UP_TO_DATE', stopKind: 'burned' })])), now }).description, /请推新提交/);
  assert.match(describe({ pull: pull(), status: s(b => { b.setPending([row()]); b.update({ breaker: { state: 'open', nextTrialAt: now + 30 * 60_000 } }); }), now }).description, /熔断中，约 09:30Z 试跑/);
  assert.match(describe({ pull: pull(), status: s(b => { b.setPending([row()]); b.update({ halt: { code: 'X_Y', at: '2026-10-22T08:00:00Z' } }); }), now }).description, /停机/);
  // a supersession before stage 1 leaves what was written for the head
  assert.equal(describe({ pull: pull(), status: s(b => b.outcome({ pr: 7, headSha: H(7), outcome: 'NOT_EXECUTED', code: 'BATCH_SUPERSEDED' })), now }), null);
});

test('phase 2: the executor\'s notices become one notification each; a stopped or done row never counts as waiting', () => {
  const now = Date.parse('2026-10-22T09:00:00Z');
  const s = boardStatus(b => {
    b.setPending([{ pr: 7, headSha: H(7), baseSha: MAIN, state: 'STOPPED', firstAt: now - 3 * 3_600_000 }, { pr: 8, headSha: H(8), baseSha: MAIN, state: 'WAITING', reason: 'OWNER_REVIEW_REQUIRED', firstAt: now - 2 * 3_600_000 }]);
    b.update({ notices: [{ key: `poke:7:${H(7)}`, kind: 'new-trigger', pr: 7, headSha: H(7), code: null, at: now },
      { key: `stopped:8:${H(8)}:CLAIM_NOT_CURRENT`, kind: 'stopped', pr: 8, headSha: H(8), code: 'CLAIM_NOT_CURRENT', at: now },
      { key: 'waiting-budget:2026-10-22', kind: 'waiting-budget', pr: null, headSha: null, code: 'WAITING_BUDGET_EXHAUSTED', at: now },
      { key: 'batch-limit:2026-10-22', kind: 'batch-limit', pr: null, headSha: null, code: 'DAILY_BATCH_LIMIT', at: now },
      { key: 'breaker:1792658000000', kind: 'breaker-open', pr: null, headSha: null, code: 'STAGE_PACKAGE_REFUSED', at: now, until: now + 30 * 60_000 },
      { key: 'x', kind: 'not-a-kind', at: now }] });
  }, now);
  const e = events({ status: s, now });
  assert.deepEqual(e.map(x => x.key), [`wait:8:${H(8)}:OWNER_REVIEW_REQUIRED`, `notice:poke:7:${H(7)}`, `notice:stopped:8:${H(8)}:CLAIM_NOT_CURRENT`,
    'notice:waiting-budget:2026-10-22', 'notice:batch-limit:2026-10-22', 'notice:breaker:1792658000000']);
  assert.match(e.at(-1).body, /约 09:30Z 试跑一批/);
});

// ---- primary/standby C5 (DESIGN §23, node-duty.mjs) ----

test('C5: the node writes its own context on its own commits; duty texts are written again every 14 minutes; STANDBY hands over once', async t => {
  const root = await tempRoot(t);
  let now = Date.parse('2026-10-23T06:00:00Z');
  const calls = [];
  const run = async argv => {
    calls.push(argv);
    if (argv.some(a => a.includes('/rules/branches/main'))) return rulesReply(REQUIRED);
    if (argv[4] === 'user') return { code: 0, stdout: 'tdoljyj\n' };
    if (argv[4]?.includes('/statuses?')) return { code: 0, stdout: '[]' };
    return { code: 0, stdout: '{}' };
  };
  const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const reporter = new PrStatusReporter({ node: 'node-b', repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: PS, run, clock: () => now, store: await LocalStore.open(path.join(root, 's.json'), () => now),
    notifications: false, writeRequest: async () => {} });
  const pulls = [{ pr: 7, headSha: H(7), eligible: true, hint: null, behindBy: 0 }, { pr: 8, headSha: H(8), eligible: true, hint: null, behindBy: 0 }];
  const board = (fn, at = now) => boardStatus(b => { b.setState('IDLE'); b.update({ backfill: { complete: true, published: 0, unreadable: 0 } }); b.setPending([{ pr: 7, headSha: H(7), baseSha: MAIN, position: 1 }]); fn(b); }, at);
  const posts = () => calls.filter(a => a.includes('POST'));
  assert.equal((await reporter.pass({ pulls, status: board(() => {}) })).posted, 1, 'only its own commit (PR 8 was never queued here)');
  const first = posts().at(-1);
  assert.ok(first.includes('context=resident-queue/node-b (info only)'));
  assert.match(first.find(a => a.startsWith('description=')), /^description=当班：排队第 1 位/);
  now += 5 * 60_000;
  assert.equal((await reporter.pass({ pulls, status: board(() => {}) })).posted, 0, 'unchanged within 14 minutes');
  now += 9 * 60_000;
  assert.equal((await reporter.pass({ pulls, status: board(() => {}) })).posted, 1, 'written again after 14 minutes (NIT 4)');
  assert.equal(reporter.store.data.posted[H(7)].kind, 'duty');
  // the node turns STANDBY (C3): its 当班 becomes 已交班 once; nothing else is written under its context
  now += 60_000;
  const standby = board(b => b.update({ node: { name: 'node-b', mode: 'STANDBY', probe: { at: new Date(now).toISOString(), result: 'not-held', failures: 0, failingSince: null } } }));
  assert.equal((await reporter.pass({ pulls, status: standby })).posted, 1);
  assert.match(posts().at(-1).find(a => a.startsWith('description=')), /^description=已交班：/);
  now += 60_000;
  assert.equal((await reporter.pass({ pulls, status: standby })).posted, 0, 'once');
});

test('legacy dual-active memory is pruned and own status is replaced; both contexts still pass the rules check', async t => {
  const root = await tempRoot(t);
  let now = Date.parse('2026-10-23T06:00:00Z');
  const requests = [];
  let required = REQUIRED;
  const other = [{ context: 'resident-queue/company-01 (info only)', state: 'pending', description: '当班：运行中：第 3 段（gitleaks 发布）', created_at: new Date(now - 60_000).toISOString(), login: 'tdoljyj' }];
  const calls = [];
  const run = async argv => {
    calls.push(argv);
    if (argv.some(a => a.includes('/rules/branches/main'))) return rulesReply(required);
    if (argv[4] === 'user') return { code: 0, stdout: 'tdoljyj\n' };
    if (argv[4]?.includes(`/commits/${H(9)}/statuses?`)) return { code: 0, stdout: JSON.stringify(other) };
    if (argv[4]?.includes('/statuses?')) return { code: 0, stdout: '[]' };
    return { code: 0, stdout: '{}' };
  };
  const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const store = await LocalStore.open(path.join(root, 's.json'), () => now);
  store.data.node.lock = { other: 'company-01', heads: [H(7)] };
  store.data.node.probeAt = now - 30_000;
  store.data.posted[H(7)] = { kind: 'dual', context: 'resident-queue/node-b (info only)', state: 'error',
    description: '双活停机：另一节点也在当班', at: new Date(now - 30_000).toISOString(), n: 1 };
  await store.save();
  const reopened = await LocalStore.open(store.file, () => now, 2);
  const reporter = new PrStatusReporter({ node: 'node-b', repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: PS, run, clock: () => now, store: reopened,
    trainProtocolVersion: 2, writeRequest: async v => { requests.push(v); } });
  const pulls = [{ pr: 7, headSha: H(7), eligible: true, hint: null, behindBy: 0 }, { pr: 9, headSha: H(9), eligible: true, hint: null, behindBy: 0 }];
  const node = { name: 'node-b', mode: 'ACTIVE', probe: { at: new Date(now - 30_000).toISOString(), result: 'held', failures: 0, failingSince: null } };
  const status = boardStatus(b => { b.setState('IDLE'); b.update({ backfill: { complete: true, published: 0, unreadable: 0 }, node }); b.setPending([{ pr: 7, headSha: H(7), baseSha: MAIN, position: 1 }]); }, now);
  await reporter.pass({ pulls, status });
  assert.equal(requests.length, 0);
  assert.equal(calls.some(a => a[4]?.includes('/statuses?')), false);
  assert.match(calls.filter(a => a.includes('POST') && a.includes(`repos/${REPO}/statuses/${H(7)}`)).at(-1).find(a => a.startsWith('description=')), /^description=当班：/);
  const persisted = JSON.parse(await fs.readFile(store.file, 'utf8'));
  assert.equal(Object.hasOwn(persisted.node, 'lock'), false);
  assert.equal(Object.hasOwn(persisted.node, 'probeAt'), false);
  const again = new PrStatusReporter({ node: 'node-b', repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: PS, run, clock: () => now, store: await LocalStore.open(path.join(root, 's.json'), () => now, 2),
    trainProtocolVersion: 2, writeRequest: async v => { requests.push(v); } });
  assert.equal(again.store.data.posted[H(7)].kind, 'duty');
  // either context among the required checks: nothing is written, the Owner is told which
  required = [...REQUIRED, standbyContext('node-b')];
  now += 31 * 60_000;
  const before = calls.filter(a => a.includes('POST')).length;
  const c = await again.pass({ pulls, status: boardStatus(b => { b.update({ backfill: { complete: true, published: 0, unreadable: 0 }, node }); }, now) });
  assert.deepEqual([c.collision, calls.filter(a => a.includes('POST')).length - before], [true, 0]);
  assert.equal(again.collision, 'resident-standby/node-b (info only)');
  assert.deepEqual(validateStatusConfig({ node: 'company-01' }), { prStatus: true, notifications: true, node: 'company-01' });
  assert.throws(() => validateStatusConfig({ node: 'Company 01' }), { code: 'COMPANION_STATUS_CONFIG_INVALID' });
});

// ADR 0028, field 2026-11-13 (PR #1085): TURING (STANDBY) read DESK's 停摆（PAUSED） for 10 minutes and wrote "当班节点 desk-w-591 已停摆
// 10 分钟" under resident-standby/turing, while DESK ran the batch. End to end over the reporter: a STANDBY writes no reminder and shows no
// toast, whatever the node on duty wrote; a reminder it left pending before ADR 0028 ends once as success.
test('ADR 0028: a STANDBY writes no reminder under resident-standby/<node>; one written before ends once', async t => {
  const root = await tempRoot(t);
  let now = Date.parse('2026-11-13T03:32:00Z');
  const calls = [];
  const paused = at => ({ context: 'resident-queue/desk-w-591 (info only)', state: 'pending', description: '停摆（PAUSED）：执行器已暂停，等 Owner 恢复', created_at: new Date(at).toISOString(), login: 'tdoljyj' });
  const other = [paused(now)];
  const run = async argv => {
    calls.push(argv);
    if (argv.some(a => a.includes('/rules/branches/main'))) return rulesReply(REQUIRED);
    if (argv[4] === 'user') return { code: 0, stdout: 'tdoljyj\n' };
    if (argv[4]?.includes(`/commits/${H(7)}/statuses?`)) return { code: 0, stdout: JSON.stringify([...other].reverse()) };
    if (argv[4]?.includes('/statuses?')) return { code: 0, stdout: '[]' };
    if (argv[4]?.includes('/check-runs?')) return { code: 0, stdout: '0\n' };
    return { code: 0, stdout: '{}' };
  };
  const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const store = await LocalStore.open(path.join(root, 's.json'), () => now);
  const reporter = new PrStatusReporter({ node: 'node-b', repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: PS, run, clock: () => now, store, notify: async () => { calls.push(['toast']); } });
  const pulls = [{ pr: 7, headSha: H(7), eligible: true, hint: null, behindBy: 0 }];
  const node = () => ({ name: 'node-b', mode: 'STANDBY', probe: { at: new Date(now - 30_000).toISOString(), result: 'not-held', failures: 0, failingSince: null } });
  const status = () => boardStatus(b => { b.update({ backfill: { complete: true, published: 0, unreadable: 0 }, node: node() }); }, now);
  const standbyPosts = () => calls.filter(a => a.includes('POST') && a.some(x => x.includes(`repos/${REPO}/statuses/${H(7)}`)) && a.includes(`context=${standbyContext('node-b')}`))
    .map(a => [a.find(x => x.startsWith('state=')), a.find(x => x.startsWith('description='))]);
  for (let m = 0; m <= 40; m += 1) { await reporter.pass({ pulls, status: status() }); now += 60_000; if (m % 14 === 13) other.push(paused(now)); }
  assert.deepEqual(standbyPosts(), [], 'no reminder at 10 minutes of 停摆, nor at 30 without a pickup');
  assert.equal(calls.filter(a => a[0] === 'toast').length, 0, 'no toast');
  assert.equal(calls.filter(a => a[4]?.includes('/check-runs?')).length, 0, 'no admission read');
  // a reminder written before ADR 0028 (the reporter's memory) ends once as success
  store.data.node.standby[H(7)] = { pr: 7, at: new Date(now).toISOString() };
  await reporter.pass({ pulls, status: status() });
  now += 60_000;
  await reporter.pass({ pulls, status: status() });
  assert.deepEqual(standbyPosts(), [['state=success', 'description=备用提醒已取消（ADR 0028）']]);
  assert.deepEqual(store.data.node.standby, {});
});

test('HALT notices precede GitHub reads; a failed role projection writes nothing; refreshes stop at 900', async t => {
  const root = await tempRoot(t);
  let now = Date.parse('2026-10-23T06:00:00Z');
  const calls = [];
  const run = async argv => {
    calls.push(argv);
    if (argv.some(a => a.includes('/rules/branches/main'))) return rulesReply(REQUIRED);
    if (argv[4] === 'user') return { code: 0, stdout: 'tdoljyj\n' };
    if (argv[4]?.includes('/statuses?')) return { code: 0, stdout: '[]' };
    return { code: 0, stdout: '{}' };
  };
  const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const reporter = new PrStatusReporter({ node: 'node-b', repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: PS, run, clock: () => now, store: await LocalStore.open(path.join(root, 's.json'), () => now), writeRequest: async () => {} });
  const node = { name: 'node-b', mode: 'ACTIVE', probe: { at: new Date(now - 30_000).toISOString(), result: 'held', failures: 0, failingSince: null } };
  const halted = boardStatus(b => { b.update({ backfill: { complete: true, published: 0, unreadable: 0 }, node, halt: { code: 'X_Y', at: '2026-10-23T05:59:00Z' } }); }, now);
  await reporter.pass({ pulls: [{ pr: 7, headSha: H(7), eligible: true, hint: null, behindBy: 0 }], status: halted });
  const toastAt = calls.findIndex(a => a.includes('-EncodedCommand')), readAt = calls.findIndex(a => a.includes('GET'));
  assert.ok(toastAt >= 0 && readAt > toastAt, 'the HALT toast precedes the legacy interlock and rules reads');
  assert.ok(calls.some(a => a[4]?.includes('/statuses?')), 'the default protocol runs the legacy interlock');
  // m1: the duty throws: no PR page write at all this pass (never under a fallback name)
  reporter.duty.prepare = () => { throw new Error('bad memory'); };
  const posts = () => calls.filter(a => a.includes('POST')).length;
  const before = posts();
  now += 60_000;
  await reporter.pass({ pulls: [{ pr: 9, headSha: H(9), eligible: false, hint: 'merge-main', behindBy: 2 }], status: halted });
  assert.equal(posts(), before);
  // m8: a duty text is refreshed at most REFRESH_MAX_POSTS times per head
  const r2 = new PrStatusReporter({ node: 'node-b', repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: PS, run, clock: () => now, store: await LocalStore.open(path.join(root, 'r.json'), () => now), notifications: false });
  const queued = () => boardStatus(b => { b.setState('IDLE'); b.update({ backfill: { complete: true, published: 0, unreadable: 0 } }); b.setPending([{ pr: 7, headSha: H(7), baseSha: MAIN, position: 1 }]); }, now);
  const pulls = [{ pr: 7, headSha: H(7), eligible: true, hint: null, behindBy: 0 }];
  assert.equal((await r2.pass({ pulls, status: queued() })).posted, 1);
  r2.store.data.posted[H(7)].n = 900;
  now += 15 * 60_000;
  assert.equal((await r2.pass({ pulls, status: queued() })).posted, 0, 'no refresh past 900 writes');
});

// Node Resource Governance v1 (after Owner decision 241824b2): the node's status file (C:\ProgramData\Clued\node-governance\status.json)
// shows on the PR page as one line while it names a red line; 2026-11-08 #1040 waited 13 minutes behind a desktop toast nobody saw.
const NOW = Date.parse('2026-11-08T09:00:00Z');
const statusJson = (o = {}) => JSON.stringify({ contract: 'clued.node-governance-status/1', host: 'company-primary', writtenAt: new Date(NOW).toISOString(), level: 'red',
  intake: { drive: 'D', level: 'red' }, drives: [{ drive: 'C', freeGb: 70, totalGb: 900, level: 'green' }, { drive: 'D', freeGb: 12.34, totalGb: 2300, level: 'red' }], linuxRunners: null, ...o }, null, 2);

test('node governance: a red status becomes one line of the PR page text; gone, broken, stale or unreadable: no line and no error', async t => {
  const { NODE_STATUS_FILE, readCapacityAlert } = await import('../src/host-capacity.mjs');
  assert.equal(NODE_STATUS_FILE, 'C:\\ProgramData\\Clued\\node-governance\\status.json');
  const root = await tempRoot(t);
  const marker = path.join(root, 'status.json');
  let now = NOW;
  const calls = [];
  const run = async argv => { calls.push(argv); return argv.some(a => a.includes('/rules/branches/main')) ? rulesReply(REQUIRED) : { code: 0, stdout: '{}' }; };
  const reporter = new PrStatusReporter({ node: 'node-b', repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', run, clock: () => now,
    store: await LocalStore.open(path.join(root, 's.json'), () => now), notifications: false });
  reporter.hostCapacity = () => readCapacityAlert(marker, () => now); // as companion-main.mjs wires it (with NODE_STATUS_FILE)
  const pulls = [{ pr: 7, headSha: H(7), eligible: true, hint: null, behindBy: 0 }];
  const status = () => boardStatus(b => { b.update({ backfill: { complete: true, published: 0, unreadable: 0 } }); b.outcome({ pr: 7, headSha: H(7), outcome: 'COMPLETED' }); }, now);
  const described = () => calls.filter(a => a.includes('POST')).map(a => a.find(x => x.startsWith('description=')).slice('description='.length));
  const LINE = '节点资源红线（company-primary D: 剩 12.3 GB，暂停接新批）';
  await reporter.pass({ pulls, status: status() });
  assert.ok(!described()[0].includes('节点资源红线'), described()[0]);
  await fs.writeFile(marker, statusJson());
  await reporter.pass({ pulls, status: status() });
  assert.equal(described()[1], `${described()[0]}；${LINE}`);
  await fs.writeFile(marker, statusJson({ level: 'green', intake: { drive: 'D', level: 'green' } }));
  now += 60_000;
  await reporter.pass({ pulls, status: status() });
  assert.equal(described()[2], described()[0]);
  for (const bad of ['{"contract":"clued.node', 'not json', statusJson({ contract: 'other/1' }), '[1]', `${statusJson()}${' '.repeat(70000)}`, statusJson({ writtenAt: '2026-11-08T07:00:00Z' })]) {
    await fs.writeFile(marker, bad);
    assert.equal(await readCapacityAlert(marker, () => now), null, bad.slice(0, 30));
    const r = await reporter.pass({ pulls, status: status() });
    assert.equal(r.stalled, false);
  }
  await fs.rm(marker); await fs.mkdir(marker);
  assert.equal(await readCapacityAlert(marker, () => now), null);
  assert.equal(described().length, 3, 'no text with the line was ever written for a broken status');
  reporter.hostCapacity = () => { throw new Error('boom'); };
  await reporter.pass({ pulls, status: status() });
  reporter.hostCapacity = async () => { throw new Error('boom'); };
  await reporter.pass({ pulls, status: status() });
  assert.equal(described().length, 3);
});

test('node governance: the line names only the status numbers; the held Linux runners too; it survives a long text', async t => {
  const { readCapacityAlert, capacityText } = await import('../src/host-capacity.mjs');
  const { withCapacityLine, withWatchdogLine } = await import('../src/pr-status.mjs');
  const root = await tempRoot(t);
  const marker = path.join(root, 'status.json');
  const read = async o => { await fs.writeFile(marker, statusJson(o)); return readCapacityAlert(marker, () => NOW); };
  assert.equal(await readCapacityAlert(path.join(root, 'absent.json'), () => NOW), null);
  assert.deepEqual(await read({}), { text: '节点资源红线（company-primary D: 剩 12.3 GB，暂停接新批）' });
  assert.deepEqual(await read({ intake: { drive: 'D', level: 'yellow' }, linuxRunners: { suspended: true, detail: '<script>' } }), { text: '节点资源红线（company-primary Linux runner 已停）' });
  assert.equal(await read({ intake: { drive: 'C', level: 'green' } }), null, 'red elsewhere is the panel\'s, not the PR page\'s');
  assert.equal(capacityText(null), null);
  const want = { state: 'pending', description: `当班：${'x'.repeat(200)}` };
  const both = withWatchdogLine(withCapacityLine(want, '节点资源红线（company-primary D: 剩 12.3 GB，暂停接新批）'), true);
  assert.ok(both.description.length <= 140 && both.description.startsWith('当班：') && both.description.endsWith('；节点资源红线（company-primary D: 剩 12.3 GB，暂停接新批）；自动接班看门狗未运行'), both.description);
  assert.equal(withCapacityLine(null, 'x'), null);
  assert.deepEqual(withCapacityLine({ state: 'success', description: 'x' }, null), { state: 'success', description: 'x' });
  const once = withCapacityLine({ state: 'success', description: 'x' }, 'y');
  assert.deepEqual(withCapacityLine(once, 'y'), once, 'never twice');
});

test('node governance: companion-main.mjs hands the reporter the node status', async () => {
  const src = await fs.readFile(new URL('../src/companion-main.mjs', import.meta.url), 'utf8');
  // the governance status first, else the resident's own disk/memory hold (holder node-resource) in its status
  assert.ok(src.includes('reporter.hostCapacity = async () => (await readCapacityAlert(NODE_STATUS_FILE)) ?? resourceHoldAlert(await readStatus(values.root).catch(() => null));'),
    'companion-main.mjs sets reporter.hostCapacity');
  assert.ok(src.includes("import { NODE_STATUS_FILE, readCapacityAlert, resourceHoldAlert } from './host-capacity.mjs';"), 'companion-main.mjs imports the status read');
});

// Task 484bddac (FABLE-front-merge-stale-summary §2.3): the page never asks anyone to merge main by hand. A behind head gets one pending
// sentence whatever the train summary says: stale (defect 甲), no front in it (乙), another PR named, or this PR named. Before the fix the
// first two said "请合入最新 main 并推送" (a failure): 34 hand merges of main came from it. A conflict is GitHub's own DIRTY, not this line.
test('484bddac: a behind PR gets the same pending line under every train summary, never "请合入"', () => {
  const now = Date.parse('2026-11-22T02:00:00Z');
  const behind = pr => ({ pr, headSha: H(pr), eligible: false, hint: 'merge-main', behindBy: 3 });
  const status = (front, at = now - 60_000) => ({ writtenAt: now, current: null, pending: [], recent: [],
    train: { enabled: 'on', last: { at, mode: 'on', wouldDo: front ? 'FRONT_NEEDS_MAIN_MERGE' : 'NO_FRONT', front: front ? { pr: front, headSha: H(front) } : null } } });
  const LINE = '落后 main 3 个提交：轮到时机器人合入 main，不用手工合（没开自动合入的先开）';
  const inputs = {
    'summary stale': status(7, now - 31 * 60_000),
    'no front in the summary': status(null),
    'summary names another PR': status(7),
    'summary names this PR': status(8),
    'no status at all': null,
  };
  for (const [name, s] of Object.entries(inputs)) {
    const d = describe({ pull: behind(8), status: s, now });
    assert.deepEqual(d, { state: 'pending', description: LINE }, name);
    assert.equal(JSON.stringify(d).includes('请合入'), false, name);
  }
});

// Field defect 2026-11-23 (FABLE-resident-halt-merge-race-20261123 C): both residents were HALTed (PUBLICATION_UNCERTAIN) and the
// compute panel showed them idle: a node wrote only on the commits it had queued or run, the PRs that ended the HALT were merged, and
// the open PRs it never queued carried nothing. While HALTed, the node on duty says so on every eligible open PR head.
test('HALT: the node on duty writes 执行器已停机（码） on every eligible open PR head, also one it never queued; a STANDBY writes none', async t => {
  const root = await tempRoot(t);
  let now = Date.parse('2026-11-23T00:30:00Z');
  const calls = [];
  const run = async argv => {
    calls.push(argv);
    if (argv.some(a => a.includes('/rules/branches/main'))) return rulesReply(REQUIRED);
    if (argv[4] === 'user') return { code: 0, stdout: 'tdoljyj\n' };
    if (argv[4]?.includes('/statuses?')) return { code: 0, stdout: '[]' };
    return { code: 0, stdout: '{}' };
  };
  const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const field = (a, k) => a.find(x => x.startsWith(`${k}=`))?.slice(k.length + 1);
  const written = () => calls.filter(a => a.includes('POST')).map(a => [a.find(x => x.includes('/statuses/')).split('/').at(-1), field(a, 'state'), field(a, 'context'), field(a, 'description')]);
  const nodeAs = mode => ({ name: 'node-b', mode, probe: { at: new Date(now - 30_000).toISOString(), result: mode === 'ACTIVE' ? 'held' : 'not-held', failures: 0, failingSince: null } });
  const halted = mode => boardStatus(b => { b.update({ backfill: { complete: true, published: 0, unreadable: 0 }, node: nodeAs(mode), halt: { code: 'PUBLICATION_UNCERTAIN', at: '2026-11-23T00:21:05Z' } }); }, now);
  // Neither head was ever queued or run by this node (status.json names no row for them).
  const pulls = [{ pr: 1240, headSha: H(4), eligible: true, hint: null, behindBy: 0 }, { pr: 1241, headSha: H(5), eligible: true, hint: null, behindBy: 0 }];
  const TEXT = '执行器已停机（PUBLICATION_UNCERTAIN），等 Owner 复位';
  const reporter = new PrStatusReporter({ node: 'node-b', repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: PS, run, clock: () => now, store: await LocalStore.open(path.join(root, 's.json'), () => now), notifications: false, writeRequest: async () => {} });
  await reporter.pass({ pulls, status: halted('ACTIVE') });
  assert.deepEqual(written(), [[H(4), 'error', PR_STATUS_CONTEXT, TEXT], [H(5), 'error', PR_STATUS_CONTEXT, TEXT]]);
  assert.doesNotMatch(TEXT, /^(当班|停摆|已交班)/);
  now += 20 * 60_000;
  await reporter.pass({ pulls, status: halted('ACTIVE') });
  assert.equal(written().length, 2, 'not refreshed');
  // A STANDBY (the watchdog handed its role over) writes nothing under its queue context, HALTed or not.
  const before = written().length;
  const standby = new PrStatusReporter({ node: 'node-b', repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: PS, run, clock: () => now, store: await LocalStore.open(path.join(root, 'b.json'), () => now), notifications: false, writeRequest: async () => {} });
  await standby.pass({ pulls, status: halted('STANDBY') });
  assert.equal(written().length, before);
});

// FABLE-resident-halt-merge-race-followup-20261123 §2: the HALT rows are executor-wide and owed their end. Once the Owner's reset is
// seen (a fresh status without a halt), every HALT row this node left on a still-open head that it does not describe again in the
// pass is rewritten as a non-error row without a duty word, whatever the node's mode now (still on duty but the PR was never queued
// here; or STANDBY after the role moved). Otherwise the panel kept reading the node as HALTed and the PR as stalled until it closed.
test('HALT rows end after the reset: rewritten non-error on every still-open head, on duty or STANDBY; not while HALTed or stale', async t => {
  const root = await tempRoot(t);
  let now = Date.parse('2026-11-23T00:30:00Z');
  const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const field = (a, k) => a.find(x => x.startsWith(`${k}=`))?.slice(k.length + 1);
  const nodeAs = mode => ({ name: 'node-b', mode, probe: { at: new Date(now - 30_000).toISOString(), result: mode === 'ACTIVE' ? 'held' : 'not-held', failures: 0, failingSince: null } });
  const board = (mode, halt) => boardStatus(b => { if (!halt) b.setState('IDLE'); b.update({ backfill: { complete: true, published: 0, unreadable: 0 }, node: nodeAs(mode), ...(halt ? { halt: { code: 'PUBLICATION_UNCERTAIN', at: '2026-11-23T00:21:05Z' } } : {}) }); }, now);
  const TEXT = '执行器已停机（PUBLICATION_UNCERTAIN），等 Owner 复位';
  for (const after of ['ACTIVE', 'STANDBY']) {
    const calls = [];
    const run = async argv => {
      calls.push(argv);
      if (argv.some(a => a.includes('/rules/branches/main'))) return rulesReply(REQUIRED);
      if (argv[4] === 'user') return { code: 0, stdout: 'tdoljyj\n' };
      if (argv[4]?.includes('/statuses?')) return { code: 0, stdout: '[]' };
      return { code: 0, stdout: '{}' };
    };
    const written = () => calls.filter(a => a.includes('POST')).map(a => [a.find(x => x.includes('/statuses/')).split('/').at(-1), field(a, 'state'), field(a, 'context'), field(a, 'description')]);
    const pulls = [{ pr: 1240, headSha: H(4), eligible: true, hint: null, behindBy: 0 }, { pr: 1241, headSha: H(5), eligible: true, hint: null, behindBy: 0 }];
    const reporter = new PrStatusReporter({ node: 'node-b', repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: PS, run, clock: () => now, store: await LocalStore.open(path.join(root, `${after}.json`), () => now), notifications: false, writeRequest: async () => {} });
    await reporter.pass({ pulls, status: board('ACTIVE', true) });
    assert.deepEqual(written(), [[H(4), 'error', PR_STATUS_CONTEXT, TEXT], [H(5), 'error', PR_STATUS_CONTEXT, TEXT]], after);
    // Still HALTed, also as a STANDBY: the rows stay. A status that is not fresh is no reset either.
    now += 60_000;
    await reporter.pass({ pulls, status: board(after, true) });
    const stale = board(after, false);
    now += 60 * 60_000;
    await reporter.pass({ pulls, status: stale });
    assert.equal(written().length, 2, `${after}: nothing while HALTed or on a stale status`);
    // PR 1241 closed meanwhile: forgotten, never written. PR 1240 is still open: its HALT row ends.
    const open = pulls.slice(0, 1);
    await reporter.pass({ pulls: open, status: board(after, false) });
    const rows = written().slice(2);
    assert.equal(rows.length, 1, `${after}: ${JSON.stringify(rows)}`);
    assert.deepEqual(rows[0].slice(0, 3), [H(4), 'success', PR_STATUS_CONTEXT], after);
    assert.doesNotMatch(rows[0][3], /^(当班|已交班)/);
    assert.doesNotMatch(rows[0][3], /运行中|排队|已完成|停机|停摆/, 'not read by the panel as progress, HALT or stall');
    now += 20 * 60_000;
    await reporter.pass({ pulls: open, status: board(after, false) });
    assert.equal(written().length, 3, `${after}: once`);
  }
});

// G-5, Task 2fb32dc7 (PLAN-train-full-and-gate-poll-20261125 §2.3): the two texts of a head the poller does not propose are written
// and read back by this one module; the PR gate (scripts/ci/clued-work-admission.mjs) reads them through heldHintOf. A sentence changed
// without its reader fails here.
test('G-5 the held texts describe writes read back as their hint, with the lines added around them; nothing else does', async () => {
  const m = await import('../src/pr-status.mjs');
  assert.equal(typeof m.heldHintText, 'function', 'pr-status.mjs exports heldHintText');
  assert.equal(typeof m.heldHintOf, 'function', 'pr-status.mjs exports heldHintOf');
  const { CAPACITY_ALERT_TEXT } = await import('../src/host-capacity.mjs');
  const now = Date.parse('2026-11-25T04:00:00Z');
  for (const [hint, behindBy] of [['merge-main', 1], ['merge-main', 110], ['merge-main', 123456], ['push-any-commit', 0]]) {
    const pull = { pr: 1317, headSha: 'd'.repeat(40), eligible: false, hint, behindBy };
    const written = describe({ pull, status: null, now });
    assert.equal(written.description, m.heldHintText(hint, behindBy), `${hint}: describe writes the generator's sentence`);
    assert.equal(m.heldHintOf(written.description), hint);
    for (const around of [m.withRerunLine(written, true), m.withRerunLine(written, '补跑道：已为此提交重新派发一次'), m.withWatchdogLine(written, true),
      m.withCapacityLine(written, CAPACITY_ALERT_TEXT), m.withWatchdogLine(m.withCapacityLine(written, CAPACITY_ALERT_TEXT), true)])
      assert.equal(m.heldHintOf(around.description), hint, around.description);
  }
  // The field text (#1317 head d4dc68f3e, resident-queue/turing, 11-24 19:39:08Z).
  assert.equal(m.heldHintOf('落后 main 110 个提交：轮到时机器人合入 main，不用手工合（没开自动合入的先开）'), 'merge-main');
  const merge = m.heldHintText('merge-main', 3);
  for (const other of [null, undefined, 42, '', '当班：运行中：第 1 段（准入）', 'DRAFT', `x${merge}`, `${merge}x`, merge.slice(0, -1), `${merge.slice(0, 30)}…`,
    merge.replace('3', 'three'), '落后 main  个提交：轮到时机器人合入 main，不用手工合（没开自动合入的先开）', `${merge}\n::set-output name=admitted::true`])
    assert.equal(m.heldHintOf(other), null, String(other));
  assert.equal(m.heldHintText('compare-unavailable', 0), null);
});
