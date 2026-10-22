// The poller's up-to-date filter, and the PR page status and Windows notifications the companion derives from the
// executor's status (resident quota redesign v0.6 + §9, phase 1, items 6 and 7).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { COMPARE_TIMEOUT_MS, MAX_COMPARES_PER_PASS, Poller, upToDate } from '../src/poller.mjs';
import { ADVISORY_TIMEOUT_MS, LocalStore, PASS_BUDGET_MS, POST_RETRY_MS, PR_STATUS_CONTEXT, PrStatusReporter, contextFree, contextShapeSafe, describe, events, toastArgv, validateStatusConfig } from '../src/pr-status.mjs';
import { lane } from '../src/companion-main.mjs';
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
    assert.ok(argv.join(' ').includes('baseRefOid'), 'the PR list asks for the base');
    return { code: 0, stdout: JSON.stringify(pulls) };
  };
  const p = new Poller({ repo: REPO, ghExe: 'C:\\gh.exe', run, writeTrigger: async v => written.push(v), clock: () => 0 });
  assert.equal(await p.pass(), 1);
  assert.deepEqual(written.map(w => [w.pr, w.baseSha]), [[1, MAIN]]);
  assert.deepEqual(p.lastPass.pulls.map(x => [x.pr, x.eligible, x.hint, x.behindBy]), [[1, true, null, 0], [2, false, 'merge-main', 5], [3, false, 'push-any-commit', 0], [4, false, 'compare-unavailable', null]]);
  const compares = calls.filter(a => a.some(x => x.includes('/compare/'))).length;
  await p.pass();
  assert.equal(calls.filter(a => a.some(x => x.includes('/compare/'))).length - compares, 1, 'answered compares are cached; only the unavailable one is asked again');
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
  const p = new Poller({ repo: REPO, ghExe: 'C:\\gh.exe', run, writeTrigger: async () => {}, clock: () => 0 });
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
  assert.deepEqual([queued.state, queued.description], ['pending', '排队第 2 位：今日执行批次额度已满']);
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
  assert.equal(contextFree(PR_STATUS_CONTEXT, [...REQUIRED, ' RESIDENT-QUEUE (INFO ONLY) ']), false);
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
  assert.deepEqual(await reporter.pass({ pulls, status }), { posted: 2, toasts: 0, collision: false });
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
  assert.equal(r.toasts, 2, 'the collision and the HALT');
  assert.equal((await reporter.pass({ pulls, status: halted })).toasts, 0, 'each key once');
  // unknown rules: nothing is written
  required = null; now += 31 * 60_000;
  const fresh = new PrStatusReporter({ repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', run, clock: () => now,
    store: await LocalStore.open(path.join(root, 'other.json'), () => now), notifications: false });
  assert.equal((await fresh.pass({ pulls, status })).posted, 0);
  assert.deepEqual(validateStatusConfig(undefined), { prStatus: true, notifications: true });
  assert.deepEqual(validateStatusConfig({ notifications: false }), { prStatus: true, notifications: false });
  assert.throws(() => validateStatusConfig({ other: true }), { code: 'COMPANION_STATUS_CONFIG_INVALID' });
  assert.ok((await fs.readdir(root)).includes('store.json'));
});
