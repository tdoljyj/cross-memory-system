// The poller's up-to-date filter, and the PR page status and Windows notifications the companion derives from the
// executor's status (resident quota redesign v0.6 + §9, phase 1, items 6 and 7).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { COMPARE_RETRY_MS, COMPARE_TIMEOUT_MS, MAX_COMPARES_PER_PASS, Poller, SLOW_COMPARE_SKIP_MS, upToDate } from '../src/poller.mjs';
import { ADVISORY_TIMEOUT_MS, LocalStore, PASS_BUDGET_MS, POST_RETRY_MS, PR_STATUS_CONTEXT, PrStatusReporter, contextFree, contextShapeSafe, describe, events, toastArgv, validateStatusConfig } from '../src/pr-status.mjs';
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
import { tempRoot } from './helpers.mjs';

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
  clock += 60_000;
  await p.pass();
  assert.equal(comparesNow() - compares, 0, 'answered compares are cached; the unavailable one waits COMPARE_RETRY_MS (60-second poll)');
  clock += COMPARE_RETRY_MS;
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
    if (argv.some(a => a.includes('/rules/branches/main'))) return { code: 0, stdout: REQUIRED.join('\n') + '\n' };
    return { code: postOk ? 0 : 1, stdout: '{}' };
  };
  const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const reporter = new PrStatusReporter({ repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: PS, run: run2, clock: () => now,
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
  const slow = new PrStatusReporter({ repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: PS, run: run2, clock: () => now,
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
    if (argv.some(a => a.includes('/rules/branches/main'))) return { code: 0, stdout: REQUIRED.join('\n') + '\n' };
    return { code: 0, stdout: '{}' };
  };
  const reporter = new PrStatusReporter({ repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: PS, run, clock: () => now, store: await LocalStore.open(path.join(root, 's.json'), () => now) });
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
  // poller: a compare that times out stops this pass's compares (budget kept) and is skipped for a while
  let slowHead = null;
  const pulls = [1, 2, 3].map(i => ({ number: i, headRefOid: String(i).padStart(40, 'c'), baseRefOid: MAIN, isDraft: false, body: TRAILER, updatedAt: 't' }));
  const prun = async argv => {
    const c = argv.find(a => a.includes('/compare/'));
    if (c) return c.includes(slowHead) ? { code: null, stdout: '', stderr: '', timedOut: true } : { code: 0, stdout: JSON.stringify({ behind_by: 0, base: MAIN }) };
    if (argv.includes('api')) return { code: 0, stdout: `${MAIN}\n` };
    return { code: 0, stdout: JSON.stringify(pulls) };
  };
  let clock = 0;
  const p = new Poller({ repo: REPO, ghExe: 'C:\\gh.exe', run: restPolls(prun, { main: () => MAIN, pulls: () => pulls }), writeTrigger: async () => {}, clock: () => clock });
  slowHead = pulls[0].headRefOid;
  assert.equal(await p.pass(), 0, 'the first compare hangs: nothing compared after it this pass');
  assert.equal(p.compareBudget, MAX_COMPARES_PER_PASS, 'the budget is not used by a stalled call');
  assert.equal(await p.pass(), 2, 'next pass: the slow one is skipped, the PRs behind it are compared');
  clock += SLOW_COMPARE_SKIP_MS;
  slowHead = 'none';
  assert.equal(await p.pass(), 1, 'after the skip window it is asked again');
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
  assert.deepEqual(describe({ pull: pull({ eligible: false, hint: 'merge-main', behindBy: 4 }), status: null, now }).state, 'failure');
  assert.match(describe({ pull: pull({ eligible: false, hint: 'push-any-commit' }), status: null, now }).description, /推一个任意提交即可/);
  assert.equal(describe({ pull: pull({ eligible: false, hint: 'compare-unavailable' }), status: null, now }), null);
  const s = fn => boardStatus(b => { b.update({ backfill: { complete: true, published: 0, unreadable: 0 } }); fn(b); }, now);
  assert.match(describe({ pull: pull(), status: s(b => b.setCurrent({ key: 'a'.repeat(64), pr: 7, headSha: H(7), baseSha: MAIN, attempt: 1, stage: 4 })), now }).description, /第 4 段（trivy 扫描）/);
  const queued = describe({ pull: pull(), status: s(b => b.setPending([{ pr: 6, headSha: H(6), baseSha: MAIN }, { pr: 7, headSha: H(7), baseSha: MAIN, deferred: 'DAILY_BATCH_LIMIT' }])), now });
  assert.deepEqual([queued.state, queued.description], ['pending', '排队第 2 位：今日执行批次额度已满，明天继续']);
  assert.equal(describe({ pull: pull(), status: s(b => b.outcome({ pr: 7, headSha: H(7), outcome: 'COMPLETED' })), now }).state, 'success');
  assert.equal(describe({ pull: pull(), status: s(b => b.outcome({ pr: 7, headSha: H(7), outcome: 'FAILED_CLEAN', code: 'STAGE_CHILD_REFUSED', retry: 'new-commit' })), now }).state, 'failure');
  assert.equal(describe({ pull: pull(), status: s(b => b.outcome({ pr: 7, headSha: H(7), outcome: 'FAILED_CLEAN', code: 'GITHUB_TRANSIENT_UNAVAILABLE', retry: 'attempt2' })), now }).state, 'pending');
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
  assert.equal(contextFree(PR_STATUS_CONTEXT, [...REQUIRED, ' RESIDENT-QUEUE/TURING (INFO ONLY) ']), false);
  assert.equal(PR_STATUS_CONTEXT, 'resident-queue/turing (info only)', 'review NIT 1: each node its own name');
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
  assert.deepEqual(argv.slice(0, 6), ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand']);
  const script = Buffer.from(argv[6], 'base64').toString('utf16le');
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
    if (argv.some(a => a.includes('/rules/branches/main'))) return required ? { code: 0, stdout: required.join('\n') + '\n' } : { code: 1, stdout: '' };
    return { code: 0, stdout: '{}' };
  };
  const reporter = new PrStatusReporter({ repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', run, clock: () => now, store });
  const pulls = [{ pr: 7, headSha: H(7), eligible: true, hint: null, behindBy: 0 }, { pr: 9, headSha: H(9), eligible: false, hint: 'merge-main', behindBy: 2 }];
  const status = boardStatus(b => { b.update({ backfill: { complete: true, published: 0, unreadable: 0 } }); b.outcome({ pr: 7, headSha: H(7), outcome: 'COMPLETED' }); }, now);
  const posts = () => calls.filter(a => a.includes('POST'));
  assert.deepEqual(await reporter.pass({ pulls, status }), { posted: 2, toasts: 0, collision: false, stalled: false });
  const first = posts();
  assert.deepEqual(first.map(a => a[a.indexOf('-f') + 1]), ['state=success', 'state=failure']);
  assert.ok(first.every(a => a.includes(`context=${PR_STATUS_CONTEXT}`) && a.includes(`repos/${REPO}/statuses/${a[4].split('/').pop()}`)));
  assert.ok(first.every(a => !a.some(x => /comments/.test(x))), 'never a comment');
  assert.equal((await reporter.pass({ pulls, status })).posted, 0, 'unchanged: nothing written');
  // a generic "proposed" never replaces what was written
  assert.equal((await reporter.pass({ pulls, status: boardStatus(b => b.update({ backfill: { complete: true, published: 0, unreadable: 0 } }), now) })).posted, 0);
  // the store survives a companion restart
  const again = new PrStatusReporter({ repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', run, clock: () => now,
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
  // unknown rules: nothing is written
  required = null; now += 31 * 60_000;
  const fresh = new PrStatusReporter({ repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', run, clock: () => now,
    store: await LocalStore.open(path.join(root, 'other.json'), () => now), notifications: false });
  assert.equal((await fresh.pass({ pulls, status })).posted, 0);
  assert.deepEqual(validateStatusConfig(undefined), { prStatus: true, notifications: true, node: 'turing' });
  assert.deepEqual(validateStatusConfig({ notifications: false }), { prStatus: true, notifications: false, node: 'turing' });
  assert.throws(() => validateStatusConfig({ other: true }), { code: 'COMPANION_STATUS_CONFIG_INVALID' });
  assert.ok((await fs.readdir(root)).includes('store.json'));
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
  assert.deepEqual([back.state, back.description], ['pending', '未准入或未执行（CLAIM_NOT_CURRENT）：约 09:10Z 自动重试（第 1 次），修正后编辑 PR 可提前']);
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
    if (argv.some(a => a.includes('/rules/branches/main'))) return { code: 0, stdout: REQUIRED.join('\n') + '\n' };
    if (argv[4] === 'user') return { code: 0, stdout: 'tdoljyj\n' };
    if (argv[4]?.includes('/statuses?')) return { code: 0, stdout: '[]' };
    return { code: 0, stdout: '{}' };
  };
  const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const reporter = new PrStatusReporter({ repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: PS, run, clock: () => now, store: await LocalStore.open(path.join(root, 's.json'), () => now),
    notifications: false, writeRequest: async () => {} });
  const pulls = [{ pr: 7, headSha: H(7), eligible: true, hint: null, behindBy: 0 }, { pr: 8, headSha: H(8), eligible: true, hint: null, behindBy: 0 }];
  const board = (fn, at = now) => boardStatus(b => { b.setState('IDLE'); b.update({ backfill: { complete: true, published: 0, unreadable: 0 } }); b.setPending([{ pr: 7, headSha: H(7), baseSha: MAIN, position: 1 }]); fn(b); }, at);
  const posts = () => calls.filter(a => a.includes('POST'));
  assert.equal((await reporter.pass({ pulls, status: board(() => {}) })).posted, 1, 'only its own commit (PR 8 was never queued here)');
  const first = posts().at(-1);
  assert.ok(first.includes('context=resident-queue/turing (info only)'));
  assert.match(first.find(a => a.startsWith('description=')), /^description=当班：排队第 1 位/);
  now += 5 * 60_000;
  assert.equal((await reporter.pass({ pulls, status: board(() => {}) })).posted, 0, 'unchanged within 14 minutes');
  now += 9 * 60_000;
  assert.equal((await reporter.pass({ pulls, status: board(() => {}) })).posted, 1, 'written again after 14 minutes (NIT 4)');
  assert.equal(reporter.store.data.posted[H(7)].kind, 'duty');
  // the node turns STANDBY (C3): its 当班 becomes 已交班 once; nothing else is written under its context
  now += 60_000;
  const standby = board(b => b.update({ node: { name: 'turing', mode: 'STANDBY', probe: { at: new Date(now).toISOString(), result: 'not-held', failures: 0, failingSince: null } } }));
  assert.equal((await reporter.pass({ pulls, status: standby })).posted, 1);
  assert.match(posts().at(-1).find(a => a.startsWith('description=')), /^description=已交班：/);
  now += 60_000;
  assert.equal((await reporter.pass({ pulls, status: standby })).posted, 0, 'once');
});

test('C5: another node on duty locks this one: the dual-active hold goes into requests\\, its commits say 双活停机; both contexts are checked against the rules', async t => {
  const root = await tempRoot(t);
  let now = Date.parse('2026-10-23T06:00:00Z');
  const requests = [];
  let required = REQUIRED;
  const other = [{ context: 'resident-queue/company-01 (info only)', state: 'pending', description: '当班：运行中：第 3 段（gitleaks 发布）', created_at: new Date(now - 60_000).toISOString(), login: 'tdoljyj' }];
  const calls = [];
  const run = async argv => {
    calls.push(argv);
    if (argv.some(a => a.includes('/rules/branches/main'))) return { code: 0, stdout: required.join('\n') + '\n' };
    if (argv[4] === 'user') return { code: 0, stdout: 'tdoljyj\n' };
    if (argv[4]?.includes(`/commits/${H(9)}/statuses?`)) return { code: 0, stdout: JSON.stringify(other) };
    if (argv[4]?.includes('/statuses?')) return { code: 0, stdout: '[]' };
    return { code: 0, stdout: '{}' };
  };
  const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const store = await LocalStore.open(path.join(root, 's.json'), () => now);
  const reporter = new PrStatusReporter({ repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: PS, run, clock: () => now, store, writeRequest: async v => { requests.push(v); } });
  const pulls = [{ pr: 7, headSha: H(7), eligible: true, hint: null, behindBy: 0 }, { pr: 9, headSha: H(9), eligible: true, hint: null, behindBy: 0 }];
  const node = { name: 'turing', mode: 'ACTIVE', probe: { at: new Date(now - 30_000).toISOString(), result: 'held', failures: 0, failingSince: null } };
  const status = boardStatus(b => { b.setState('IDLE'); b.update({ backfill: { complete: true, published: 0, unreadable: 0 }, node }); b.setPending([{ pr: 7, headSha: H(7), baseSha: MAIN, position: 1 }]); }, now);
  const r = await reporter.pass({ pulls, status });
  assert.equal(requests.length, 1);
  assert.deepEqual([requests[0].contract, requests[0].holder], ['clued.independent-ci.resident-intake-pause/1', 'dual-active']);
  assert.ok(r.toasts >= 1, 'the Owner is told');
  assert.match(calls.filter(a => a.includes('POST') && a.includes(`repos/${REPO}/statuses/${H(7)}`)).at(-1).find(a => a.startsWith('description=')), /^description=双活停机：另一节点 company-01 也在当班/);
  // the lock survives a companion restart (the reporter's own store)
  const again = new PrStatusReporter({ repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: PS, run, clock: () => now, store: await LocalStore.open(path.join(root, 's.json'), () => now),
    writeRequest: async v => { requests.push(v); } });
  assert.equal(again.store.data.node.lock.other, 'company-01');
  // either context among the required checks: nothing is written, the Owner is told which
  required = [...REQUIRED, 'resident-standby (info only)'];
  now += 31 * 60_000;
  const before = calls.filter(a => a.includes('POST')).length;
  const c = await again.pass({ pulls, status: boardStatus(b => { b.update({ backfill: { complete: true, published: 0, unreadable: 0 }, node }); }, now) });
  assert.deepEqual([c.collision, calls.filter(a => a.includes('POST')).length - before], [true, 0]);
  assert.equal(again.collision, 'resident-standby (info only)');
  assert.deepEqual(validateStatusConfig({ node: 'company-01' }), { prStatus: true, notifications: true, node: 'company-01' });
  assert.throws(() => validateStatusConfig({ node: 'Company 01' }), { code: 'COMPANION_STATUS_CONFIG_INVALID' });
});

test('C5 review: notifications before the duty reads; a pass whose duty fails writes nothing; a reminder toast owed is shown later; refreshes stop at 900', async t => {
  const root = await tempRoot(t);
  let now = Date.parse('2026-10-23T06:00:00Z');
  const calls = [];
  const run = async argv => {
    calls.push(argv);
    if (argv.some(a => a.includes('/rules/branches/main'))) return { code: 0, stdout: REQUIRED.join('\n') + '\n' };
    if (argv[4] === 'user') return { code: 0, stdout: 'tdoljyj\n' };
    if (argv[4]?.includes('/statuses?')) return { code: 0, stdout: '[]' };
    return { code: 0, stdout: '{}' };
  };
  const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const reporter = new PrStatusReporter({ repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: PS, run, clock: () => now, store: await LocalStore.open(path.join(root, 's.json'), () => now), writeRequest: async () => {} });
  const node = { name: 'turing', mode: 'ACTIVE', probe: { at: new Date(now - 30_000).toISOString(), result: 'held', failures: 0, failingSince: null } };
  const halted = boardStatus(b => { b.update({ backfill: { complete: true, published: 0, unreadable: 0 }, node, halt: { code: 'X_Y', at: '2026-10-23T05:59:00Z' } }); }, now);
  await reporter.pass({ pulls: [{ pr: 7, headSha: H(7), eligible: true, hint: null, behindBy: 0 }], status: halted });
  const toastAt = calls.findIndex(a => a.includes('-EncodedCommand')), readAt = calls.findIndex(a => a[4]?.includes('/statuses?'));
  assert.ok(toastAt >= 0 && readAt > toastAt, 'the HALT toast before any status read (review M4)');
  // m1: the duty throws: no PR page write at all this pass (never under a fallback name)
  reporter.duty.prepare = async () => { throw new Error('bad memory'); };
  const posts = () => calls.filter(a => a.includes('POST')).length;
  const before = posts();
  now += 60_000;
  await reporter.pass({ pulls: [{ pr: 9, headSha: H(9), eligible: false, hint: 'merge-main', behindBy: 2 }], status: halted });
  assert.equal(posts(), before);
  // m8: a duty text is refreshed at most REFRESH_MAX_POSTS times per head
  const r2 = new PrStatusReporter({ repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: PS, run, clock: () => now, store: await LocalStore.open(path.join(root, 'r.json'), () => now), notifications: false });
  const queued = () => boardStatus(b => { b.setState('IDLE'); b.update({ backfill: { complete: true, published: 0, unreadable: 0 } }); b.setPending([{ pr: 7, headSha: H(7), baseSha: MAIN, position: 1 }]); }, now);
  const pulls = [{ pr: 7, headSha: H(7), eligible: true, hint: null, behindBy: 0 }];
  assert.equal((await r2.pass({ pulls, status: queued() })).posted, 1);
  r2.store.data.posted[H(7)].n = 900;
  now += 15 * 60_000;
  assert.equal((await r2.pass({ pulls, status: queued() })).posted, 0, 'no refresh past 900 writes');
  // m6: a reminder toast that could not be shown is owed and shown in a later pass
  const store = await LocalStore.open(path.join(root, 'm.json'), () => now);
  store.data.node.toasts['standby:7:x:unclaimed'] = { title: 'PR #7：当班节点没接手', body: 'b', at: new Date(now).toISOString() };
  const r3 = new PrStatusReporter({ repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: PS, run, clock: () => now, store });
  assert.equal((await r3.pass({ pulls: [], status: queued() })).toasts, 1);
  assert.deepEqual(store.data.node.toasts, {});
  assert.ok(store.data.notified['standby:7:x:unclaimed']);
});
