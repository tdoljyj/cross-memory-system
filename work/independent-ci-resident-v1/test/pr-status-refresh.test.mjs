// Generation 12, defect 050560ac (PR 998 head 67b0c70a, 2026-11-05): the bundle failed on the network at 11:04, the row went to
// BACKOFF until 11:14, yet the PR page kept "当班：运行中：第 0 段". The page must follow at once: a batch that did not run, a back-off
// or a stop says why and when it is tried again, and a write lost to the same outage is tried again as soon as the text changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { RunQueue } from '../src/queue.mjs';
import { StatusBoard, parseStatus } from '../src/status.mjs';
import { LocalStore, POST_RETRY_MS, PrStatusReporter, WATCHDOG_STALE_TEXT, describe, events, statusSignature } from '../src/pr-status.mjs';
import { nodeContext, parseDutyStatus } from '../src/node-duty.mjs';
import { rulesReply, tempRoot } from './helpers.mjs';

const MIN = 60_000;
const REPO = 'tdoljyj/cross-memory-system';
const H = n => String(n).repeat(40).slice(0, 40);
const B = 'b'.repeat(40), KEY = 'c'.repeat(64);
const T0 = Date.parse('2026-11-05T11:04:00Z');

async function backoffRow(t, network) {
  let time = T0;
  const q = await RunQueue.open(path.join(await tempRoot(t), 'queue'), () => time);
  q.offer({ repo: REPO, pr: 998, headSha: H(6), baseSha: B, prUpdatedAt: null }, time, { depth: 100, cooldownMs: 10 * MIN });
  q.begin(998, H(6), KEY, 'queued', time);
  q.settle(998, H(6), { kind: 'released', klass: 'environment', code: 'BUNDLE_UNAVAILABLE', releases24h: 1, releaseCap: 3, network, networkReleases24h: 1, networkCap: 6 }, time);
  const board = new StatusBoard({ clock: () => time });
  board.update({ backfill: { complete: true, published: 0, unreadable: 0 } });
  board.setPending(q.view(time, { etaBatchMs: 22 * MIN }));
  return parseStatus(Buffer.from(JSON.stringify(board.snapshot())));
}
const pull = { pr: 998, headSha: H(6), eligible: true, hint: null, behindBy: 0 };

test('a network back-off says so, with the cause and the retry time; another back-off keeps its text', async t => {
  const net = await backoffRow(t, true);
  assert.equal(net.pending[0].network, true);
  assert.deepEqual(describe({ pull, status: net, now: T0 }), { state: 'pending', description: '网络问题，打包失败，约 11:14Z 自动重试，不用推新提交' });
  const other = await backoffRow(t, false);
  assert.equal(other.pending[0].network, false);
  assert.match(describe({ pull, status: other, now: T0 }).description, /^未准入或未执行（BUNDLE_UNAVAILABLE）：约 11:14Z 自动重试（第 1 次）/);
});

test('the status signature moves with the queue rows, so the companion posts at once (not at the next minute pass)', () => {
  const base = { current: null, breaker: null, intakePause: null, halt: null, paused: false, pending: [{ pr: 998, headSha: H(6), state: 'RUNNING', deferred: null, nextAt: null }] };
  const backoff = { ...base, pending: [{ pr: 998, headSha: H(6), state: 'BACKOFF', deferred: 'BUNDLE_UNAVAILABLE', nextAt: T0 + 10 * MIN }] };
  const stopped = { ...base, pending: [{ pr: 998, headSha: H(6), state: 'STOPPED', deferred: 'NETWORK_RELEASE_CAP_REACHED', nextAt: null }] };
  const sigs = [base, backoff, stopped].map(statusSignature);
  assert.equal(new Set(sigs).size, 3);
  assert.equal(statusSignature({ ...backoff }), sigs[1], 'unchanged rows: no extra pass');
  // the watched mark, the lease end and the network mark move it too (review round 3)
  const row = backoff.pending[0];
  for (const extra of [{ watched: true }, { claimExpiresAt: T0 + 30 * MIN }, { network: true }]) {
    assert.notEqual(statusSignature({ ...backoff, pending: [{ ...row, ...extra }] }), sigs[1], JSON.stringify(extra));
  }
});

test('a write lost to the outage is tried again at the next pass once the text changed; the same text after POST_RETRY_MS', async t => {
  const root = await tempRoot(t);
  let now = T0, up = false;
  const posted = [];
  const run = async argv => {
    if (argv.some(a => a.includes('/rules/branches/main'))) return rulesReply(['ci-suites']);
    if (argv.includes('POST')) { if (!up) return { code: 1, stdout: '' }; posted.push(argv.join(' ')); return { code: 0, stdout: '{}' }; }
    return { code: 0, stdout: '{}' };
  };
  const reporter = new PrStatusReporter({ node: 'node-b', repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', run, clock: () => now,
    store: await LocalStore.open(path.join(root, 'store.json'), () => now) });
  const behind = { pr: 998, headSha: H(6), eligible: false, hint: 'merge-main', behindBy: 2 };
  // the line is down: the write fails
  assert.equal((await reporter.pass({ pulls: [behind], status: null })).posted, 0);
  up = true;
  // same text, too soon: left alone
  now += 30_000;
  assert.equal((await reporter.pass({ pulls: [behind], status: null })).posted, 0);
  // the text changed (the PR is now 3 behind): tried at once
  assert.equal((await reporter.pass({ pulls: [{ ...behind, behindBy: 3 }], status: null })).posted, 1);
  assert.match(posted[0], new RegExp(nodeContext('node-b').replace(/[()]/g, '\\$&')));
  // a failed text is tried again after POST_RETRY_MS, which is short (2 minutes)
  assert.equal(POST_RETRY_MS, 2 * MIN);
  up = false;
  assert.equal((await reporter.pass({ pulls: [{ ...behind, behindBy: 4 }], status: null })).posted, 0);
  up = true;
  now += POST_RETRY_MS;
  assert.equal((await reporter.pass({ pulls: [{ ...behind, behindBy: 4 }], status: null })).posted, 1);
});

test('review round 4: the reporter puts the re-run line after the duty word and keeps the watchdog tail last', async t => {
  const root = await tempRoot(t);
  let now = T0;
  const posted = [];
  const run = async argv => {
    if (argv.some(a => a.includes('/rules/branches/main'))) return rulesReply(['ci-suites']);
    if (argv.includes('POST')) { posted.push(argv.find(a => a.startsWith('description=')).slice('description='.length)); return { code: 0, stdout: '{}' }; }
    return { code: 0, stdout: '{}' };
  };
  const reporter = new PrStatusReporter({ node: 'node-b', repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', run, clock: () => now,
    store: await LocalStore.open(path.join(root, 'store.json'), () => now) });
  reporter.rerunLine = h => h === H(6);
  reporter.watchdogStale = () => true;
  const board = new StatusBoard({ clock: () => now });
  board.update({ backfill: { complete: true, published: 0, unreadable: 0 } });
  board.setState('RUNNING', null);
  board.setCurrent({ key: 'a'.repeat(64), pr: 998, headSha: H(6), baseSha: B, attempt: 1, stage: 3, since: new Date(T0).toISOString() });
  const status = parseStatus(Buffer.from(JSON.stringify(board.snapshot())));
  assert.equal((await reporter.pass({ pulls: [{ pr: 998, headSha: H(6), eligible: true, hint: null, behindBy: 0 }], status })).posted, 1);
  assert.match(posted[0], /^当班：已自动补跑一次必需测试；运行中：第 3 段/);
  assert.ok(posted[0].endsWith(WATCHDOG_STALE_TEXT), posted[0]);
  assert.equal(parseDutyStatus({ login: 'owner', context: nodeContext('node-b'), created_at: new Date(T0).toISOString(), description: posted[0] }, 'owner')?.word, '当班');
});

test('review round 20: a network back-off whose time came and that a per-row deferral holds says the deferral, not the network and a passed time', async t => {
  const MIN = 60_000, REPO = 'tdoljyj/cross-memory-system', H = n => String(n).repeat(40).slice(0, 40), B = 'b'.repeat(40), KEY = 'c'.repeat(64);
  const T0 = Date.parse('2026-11-05T11:04:00Z');
  let time = T0;
  const q = await RunQueue.open(path.join(await tempRoot(t), 'queue'), () => time);
  q.offer({ repo: REPO, pr: 998, headSha: H(6), baseSha: B, prUpdatedAt: null }, time, { depth: 100, cooldownMs: 10 * MIN });
  q.begin(998, H(6), KEY, 'queued', time);
  q.settle(998, H(6), { kind: 'released', klass: 'environment', code: 'BUNDLE_UNAVAILABLE', releases24h: 1, releaseCap: 3, network: true, networkReleases24h: 1, networkCap: 6 }, time);
  const page = () => {
    const board = new StatusBoard({ clock: () => time });
    board.update({ backfill: { complete: true, published: 0, unreadable: 0 } });
    board.setPending(q.view(time, { etaBatchMs: 22 * MIN }));
    return describe({ pull: { pr: 998, headSha: H(6), eligible: true, hint: null, behindBy: 0 }, status: parseStatus(Buffer.from(JSON.stringify(board.snapshot()))), now: time }).description;
  };
  assert.match(page(), /^网络问题/, 'the back-off itself names the network');
  time = T0 + 11 * MIN;
  for (const [code, text] of [['PR_DAILY_BATCH_LIMIT', '排队中：本 PR 今日批次已满，之后自动重试'], ['TRAIN_NON_FRONT_RUNS_OFF', '排队中：合并列车只跑车头批次，成为车头后再跑，之后自动重试']]) {
    q.defer(998, code, time);
    assert.equal(page(), text, code);
  }
});

test('review round 21: a due back-off or wait never shows a passed time; a hold names itself; a time still ahead is kept while a deferral holds the row', async t => {
  const MIN = 60_000, REPO = 'tdoljyj/cross-memory-system', H = n => String(n).repeat(40).slice(0, 40), B = 'b'.repeat(40), KEY = 'c'.repeat(64);
  const T0 = Date.parse('2026-11-05T11:04:00Z');
  const setup = async ({ klass = 'environment', code = 'BUNDLE_UNAVAILABLE', network = true, releases = 1 } = {}) => {
    const clock = { time: T0 };
    const q = await RunQueue.open(path.join(await tempRoot(t), 'queue'), () => clock.time);
    q.offer({ repo: REPO, pr: 998, headSha: H(6), baseSha: B, prUpdatedAt: '2026-11-05T11:00:00Z' }, clock.time, { depth: 100, cooldownMs: 10 * MIN });
    for (let i = 0; i < releases; i++) {
      q.begin(998, H(6), KEY, 'queued', clock.time);
      q.settle(998, H(6), { kind: 'released', klass, code, releases24h: i + 1, releaseCap: 9, network, networkReleases24h: i + 1, networkCap: 9 }, clock.time);
    }
    const page = (extra = {}) => {
      const board = new StatusBoard({ clock: () => clock.time });
      board.update({ backfill: { complete: true, published: 0, unreadable: 0 }, ...extra });
      board.setPending(q.view(clock.time, { etaBatchMs: 22 * MIN }));
      return describe({ pull: { pr: 998, headSha: H(6), eligible: true, hint: null, behindBy: 0 }, status: parseStatus(Buffer.from(JSON.stringify(board.snapshot()))), now: clock.time }).description;
    };
    return { q, clock, page };
  };
  // a hold that is not a limit: no promise to retry by itself
  let s = await setup();
  s.clock.time = T0 + 30 * MIN;
  s.q.defer(998, 'SOME_ROW_HOLD', s.clock.time);
  assert.equal(s.page(), '排队中：暂缓（SOME_ROW_HOLD）');
  // a gate of the whole queue (the breaker opened by the network failures): its text, not the passed back-off time
  s = await setup();
  s.clock.time = T0 + 40 * MIN;
  assert.equal(s.page({ breaker: { state: 'open', since: new Date(T0).toISOString(), nextTrialAt: new Date(T0 + 60 * MIN).toISOString(), cause: 'network' } }),
    '排队第 1 位：执行器熔断中（网络故障），约 12:04Z 试跑');
  // no gate the status shows: about to run, no passed time
  assert.equal(s.page(), '网络问题，打包失败，即将自动重试，不用推新提交');
  // a poked back-off deferred before its own time keeps its own text and time
  s = await setup({ network: false, releases: 2 });
  s.clock.time = T0 + 10 * MIN;
  s.q.offer({ repo: REPO, pr: 998, headSha: H(6), baseSha: B, prUpdatedAt: new Date(s.clock.time).toISOString() }, s.clock.time, { depth: 100, cooldownMs: 10 * MIN });
  s.q.defer(998, 'REEVALUATION_CAP', s.clock.time, { dropPoke: true });
  assert.equal(s.page(), '未准入或未执行（BUNDLE_UNAVAILABLE）：约 11:24Z 自动重试（第 2 次），修正后编辑 PR 可提前');
  // its deferral ran out (5 minutes) before its time came: once due it is a candidate again, about to run (review round 22, MINOR 1)
  s.clock.time = T0 + 21 * MIN;
  assert.equal(s.page(), '未准入或未执行（BUNDLE_UNAVAILABLE）：即将自动重试（第 2 次），修正后编辑 PR 可提前');
  // deferred again while due: the hold, as long as it is in force
  s.q.defer(998, 'REEVALUATION_CAP', s.clock.time);
  assert.equal(s.page(), '排队中：本提交今日重新评估次数已满，之后自动重试');
  // a gate of the whole queue comes first, like for a queued row (held, the row has no place among those that may run)
  assert.equal(s.page({ breaker: { state: 'open', since: new Date(T0).toISOString(), nextTrialAt: new Date(T0 + 60 * MIN).toISOString(), cause: 'network' } }),
    '排队中：执行器熔断中（网络故障），约 12:04Z 试跑');
  // a batch of another PR in flight: after it, not "at once" (review round 22, MINOR 2)
  s.clock.time = T0 + 27 * MIN;
  assert.equal(s.page({ current: { key: 'e'.repeat(64), pr: 10, headSha: H(1), baseSha: B, attempt: 1, stage: 3, since: new Date(T0 + 20 * MIN).toISOString() } }),
    '未准入或未执行（BUNDLE_UNAVAILABLE）：当前批次结束后自动重试（第 2 次），修正后编辑 PR 可提前');
  // a wait for the Owner, the same
  s = await setup({ klass: 'waiting', code: 'OWNER_REVIEW_REQUIRED', network: false });
  s.clock.time = T0 + 5 * MIN;
  s.q.offer({ repo: REPO, pr: 998, headSha: H(6), baseSha: B, prUpdatedAt: new Date(s.clock.time).toISOString() }, s.clock.time, { depth: 100, cooldownMs: 1 });
  s.q.defer(998, 'REEVALUATION_CAP', s.clock.time, { dropPoke: true });
  assert.equal(s.page(), '等 Owner 批准受保护改动：约 11:14Z 自动重试，批准或修正后编辑 PR 可提前');
});

test('review round 22: the signature moves with the hold of a row alone, and with the parking places', () => {
  const H = n => String(n).repeat(40).slice(0, 40);
  const row = o => ({ pr: 7, headSha: H(7), state: 'BACKOFF', deferred: 'BUNDLE_UNAVAILABLE', nextAt: 1, watched: false, claimExpiresAt: null, network: false, heldBy: null, ...o });
  const sig = (o, q) => statusSignature({ current: null, pending: [row(o)], breaker: null, intakePause: null, halt: null, paused: false, queue: q });
  assert.notEqual(sig({}), sig({ heldBy: 'REEVALUATION_CAP' }));
  assert.notEqual(sig({ heldBy: 'REEVALUATION_CAP' }), sig({ heldBy: 'PR_DAILY_BATCH_LIMIT' }));
  assert.notEqual(sig({}, { parkingFull: false }), sig({}, { parkingFull: true }));
  assert.equal(sig({}), sig({}, { parkingFull: false }));
});

test('review round 22: a due back-off behind another runnable row says its estimated start, not "即将"', async t => {
  const MIN = 60_000, REPO = 'tdoljyj/cross-memory-system', H = n => String(n).repeat(40).slice(0, 40), B = 'b'.repeat(40), KEY = 'c'.repeat(64);
  const T0 = Date.parse('2026-11-05T11:04:00Z');
  let time = T0 - 5 * MIN;
  const q = await RunQueue.open(path.join(await tempRoot(t), 'queue'), () => time);
  const release = (pr, sha) => {
    q.offer({ repo: REPO, pr, headSha: sha, baseSha: B, prUpdatedAt: null }, time, { depth: 100, cooldownMs: 10 * MIN });
    q.begin(pr, sha, KEY, 'queued', time);
    q.settle(pr, sha, { kind: 'released', klass: 'environment', code: 'BUNDLE_UNAVAILABLE', releases24h: 1, releaseCap: 9, network: true, networkReleases24h: 1, networkCap: 9 }, time);
  };
  release(997, H(5)); // due first, ahead of 998
  time = T0;
  release(998, H(6));
  time = T0 + 30 * MIN;
  const board = new StatusBoard({ clock: () => time });
  board.update({ backfill: { complete: true, published: 0, unreadable: 0 } });
  const view = q.view(time, { etaBatchMs: 22 * MIN });
  board.setPending(view);
  const row = view.find(r => r.pr === 998);
  assert.ok(row.position > 1 && row.eta > time, JSON.stringify(row));
  const d = describe({ pull: { pr: 998, headSha: H(6), eligible: true, hint: null, behindBy: 0 }, status: parseStatus(Buffer.from(JSON.stringify(board.snapshot()))), now: time }).description;
  assert.equal(d, `网络问题，打包失败，约 ${new Date(row.eta).toISOString().slice(11, 16)}Z 自动重试，不用推新提交`);
});

test('review round 23: a used-up daily budget is a gate for due and queued rows; a queued row\'s deferral says nothing once it ran out', async t => {
  const MIN = 60_000, REPO = 'tdoljyj/cross-memory-system', H = n => String(n).repeat(40).slice(0, 40), B = 'b'.repeat(40), KEY = 'c'.repeat(64);
  const T0 = Date.parse('2026-11-05T11:04:00Z');
  let time = T0;
  const q = await RunQueue.open(path.join(await tempRoot(t), 'queue'), () => time);
  q.offer({ repo: REPO, pr: 998, headSha: H(8), baseSha: B, prUpdatedAt: null }, time, { depth: 100, cooldownMs: 10 * MIN });
  q.begin(998, H(8), KEY, 'queued', time);
  q.settle(998, H(8), { kind: 'released', klass: 'environment', code: 'BUNDLE_UNAVAILABLE', releases24h: 1, releaseCap: 3, network: true, networkReleases24h: 1, networkCap: 6 }, time);
  q.offer({ repo: REPO, pr: 997, headSha: H(7), baseSha: B, prUpdatedAt: null }, time, { depth: 100, cooldownMs: 10 * MIN });
  q.defer(997, 'UNEXECUTED_COOLDOWN', time, { until: time + 10 * MIN });
  const page = (pr, extra = {}) => {
    const board = new StatusBoard({ clock: () => time });
    board.update({ backfill: { complete: true, published: 0, unreadable: 0 }, ...extra });
    board.setPending(q.view(time, { etaBatchMs: 22 * MIN }));
    return describe({ pull: { pr, headSha: H(pr % 10), eligible: true, hint: null, behindBy: 0 }, status: parseStatus(Buffer.from(JSON.stringify(board.snapshot()))), now: time }).description;
  };
  time = T0 + 5 * MIN;
  assert.equal(page(997), '排队中：冷却中（10 分钟）', 'a queued row while its deferral holds it');
  time = T0 + 30 * MIN;
  const view = q.view(time, { etaBatchMs: 22 * MIN }), r997 = view.find(r => r.pr === 997);
  assert.equal(r997.reason, null, 'the cool-down ran out');
  assert.equal(page(997), `排队第 ${r997.position} 位，预计 ${new Date(r997.eta).toISOString().slice(11, 16)}Z 开始`);
  const full = { limits: { batches24h: 40, maxBatches: 40, evaluations24h: 1, maxEvaluations: 100 } };
  assert.equal(page(998, full), '排队第 1 位：今日执行批次额度已满，明天继续', 'a due back-off');
  assert.equal(page(997, full), '排队第 2 位：今日执行批次额度已满，明天继续', 'a queued row: no estimate');
  const evals = { limits: { batches24h: 1, maxBatches: 40, evaluations24h: 100, maxEvaluations: 100 } };
  assert.equal(page(998, evals), '排队第 1 位：今日评估额度已满');
  // the signature moves when a budget fills
  const sig = extra => { const b = new StatusBoard({ clock: () => time }); b.update({ backfill: { complete: true, published: 0, unreadable: 0 }, ...extra }); return statusSignature(parseStatus(Buffer.from(JSON.stringify(b.snapshot())))); };
  assert.notEqual(sig({ limits: { batches24h: 39, maxBatches: 40, evaluations24h: 1, maxEvaluations: 100 } }), sig(full));
  assert.notEqual(sig({ limits: { batches24h: 1, maxBatches: 40, evaluations24h: 99, maxEvaluations: 100 } }), sig(evals));
});

test('review round 23: a due wait is not held by the evaluation budget (its retry has its own)', async t => {
  const MIN = 60_000, REPO = 'tdoljyj/cross-memory-system', H = n => String(n).repeat(40).slice(0, 40), B = 'b'.repeat(40), KEY = 'c'.repeat(64);
  const T0 = Date.parse('2026-11-05T11:04:00Z');
  let time = T0;
  const q = await RunQueue.open(path.join(await tempRoot(t), 'queue'), () => time);
  q.offer({ repo: REPO, pr: 998, headSha: H(8), baseSha: B, prUpdatedAt: null }, time, { depth: 100, cooldownMs: 10 * MIN });
  q.begin(998, H(8), KEY, 'queued', time);
  q.settle(998, H(8), { kind: 'released', klass: 'waiting', code: 'OWNER_REVIEW_REQUIRED', releases24h: 1, releaseCap: 9 }, time);
  time = T0 + 30 * MIN;
  const board = new StatusBoard({ clock: () => time });
  board.update({ backfill: { complete: true, published: 0, unreadable: 0 }, limits: { batches24h: 1, maxBatches: 40, evaluations24h: 100, maxEvaluations: 100 } });
  board.setPending(q.view(time, { etaBatchMs: 22 * MIN }));
  assert.equal(describe({ pull: { pr: 998, headSha: H(8), eligible: true, hint: null, behindBy: 0 }, status: parseStatus(Buffer.from(JSON.stringify(board.snapshot()))), now: time }).description,
    '等 Owner 批准受保护改动：即将自动重试，批准或修正后编辑 PR 可提前');
});

test('review round 24: a global deferral the status shows is a gate; the ">1 hour" notice names what holds the row now', async t => {
  const MIN = 60_000, REPO = 'tdoljyj/cross-memory-system', H = n => String(n).repeat(40).slice(0, 40), B = 'b'.repeat(40), KEY = 'c'.repeat(64);
  const T0 = Date.parse('2026-11-05T11:04:00Z');
  let time = T0;
  const q = await RunQueue.open(path.join(await tempRoot(t), 'queue'), () => time);
  q.offer({ repo: REPO, pr: 998, headSha: H(8), baseSha: B, prUpdatedAt: null }, time, { depth: 100, cooldownMs: 10 * MIN });
  q.begin(998, H(8), KEY, 'queued', time);
  q.settle(998, H(8), { kind: 'released', klass: 'environment', code: 'BUNDLE_UNAVAILABLE', releases24h: 1, releaseCap: 3, network: true, networkReleases24h: 1, networkCap: 6 }, time);
  q.offer({ repo: REPO, pr: 997, headSha: H(7), baseSha: B, prUpdatedAt: null }, time, { depth: 100, cooldownMs: 10 * MIN });
  q.defer(997, 'PR_DAILY_BATCH_LIMIT', time);
  const status = (extra = {}) => {
    const board = new StatusBoard({ clock: () => time });
    board.update({ backfill: { complete: true, published: 0, unreadable: 0 }, ...extra });
    board.setPending(q.view(time, { etaBatchMs: 22 * MIN }));
    return parseStatus(Buffer.from(JSON.stringify(board.snapshot())));
  };
  const page = (pr, st) => describe({ pull: { pr, headSha: H(pr % 10), eligible: true, hint: null, behindBy: 0 }, status: st, now: time }).description;
  const hold = code => ({ queue: { generation: 'a'.repeat(12), live: 2, depth: 100, parkingFull: false, hold: code } });
  const skew = hold('VERSION_SKEW');
  time = T0 + 30 * MIN;
  assert.equal(page(998, status(skew)), '排队第 1 位：两端版本不一致，等升级处理完', 'a due back-off');
  assert.equal(page(997, status(skew)), '排队第 2 位：两端版本不一致，等升级处理完', 'a queued row whose deferral ran out');
  // only the global deferrals are a gate; the executor's own last reason is not read any more (review round 25)
  assert.equal(page(998, status(hold('PR_DAILY_BATCH_LIMIT'))), '网络问题，打包失败，即将自动重试，不用推新提交');
  assert.equal(page(998, status({ executor: { state: 'DEFERRED', since: new Date(T0).toISOString(), reason: 'VERSION_SKEW' } })), '网络问题，打包失败，即将自动重试，不用推新提交');
  assert.notEqual(statusSignature(status()), statusSignature(status(skew)), 'the signature moves with a global deferral');
  // the notice (over an hour in the queue): a queued row whose deferral ran out while the parking places are full names the parking
  // places, not "前面还有批次"
  time = T0 + 65 * MIN;
  const st = status({ queue: { generation: 'a'.repeat(12), live: 2, depth: 100, parkingFull: true } });
  const n = events({ status: st, now: time }).filter(e => e.key.startsWith('wait:997:'));
  assert.deepEqual(n.map(e => [e.key, e.body]), [[`wait:997:${H(7)}:PARKING_FULL`, `提交 ${H(7).slice(0, 8)}：停靠的批次已满。`]]);
  // while its deferral is in force and no gate holds, the deferral, as before
  q.defer(997, 'PR_DAILY_BATCH_LIMIT', time);
  assert.deepEqual(events({ status: status(), now: time }).filter(e => e.key.startsWith('wait:997:')).map(e => e.key), [`wait:997:${H(7)}:PR_DAILY_BATCH_LIMIT`]);
});

test('review round 24: the daily budgets reach the status at most once a minute also when no scheduling pass reads them', async t => {
  const { executorFixture, fakeEngine } = await import('./helpers.mjs');
  const { LIMITS_REFRESH_MS } = await import('../src/executor.mjs');
  const T0 = Date.parse('2026-11-05T11:04:00Z');
  let f;
  const board = new StatusBoard({ clock: () => f?.clock() ?? T0 });
  f = await executorFixture(t, { engine: fakeEngine(), status: board, now: T0 });
  let reads = 0;
  const usage = f.exec.ledger.usage.bind(f.exec.ledger);
  f.exec.ledger.usage = async (...a) => { reads++; return usage(...a); };
  assert.equal((await f.exec.tick()).state, 'IDLE', 'no row: the scheduling pass ends before the budgets');
  const limits = () => parseStatus(Buffer.from(JSON.stringify(board.snapshot()))).limits;
  assert.deepEqual(limits(), { batches24h: 0, maxBatches: f.exec.policy.limits.maxBatchesPer24h, evaluations24h: 0, maxEvaluations: f.exec.policy.limits.maxEvaluationsPer24h });
  const after1 = reads;
  f.advance(LIMITS_REFRESH_MS - 1);
  await f.exec.tick();
  assert.equal(reads, after1, 'not again within the minute');
  f.advance(1);
  await f.exec.tick();
  assert.equal(reads, after1 + 1, 'again after it');
});

test('review round 25: a global deferral stays on the status while a batch rests at A, and goes once a pass gets past it', async t => {
  const { executorFixture, holdAtA, triggerBytes } = await import('./helpers.mjs');
  const H = n => String(n).repeat(40).slice(0, 40);
  const W0 = Date.parse('2026-10-20T12:00:00Z');
  let f;
  const board = new StatusBoard({ clock: () => f?.clock() ?? W0 });
  f = await executorFixture(t, { status: board, now: W0 });
  holdAtA(f.exec, { when: s => s.pr === 884 });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'WAITING');
  await f.drop(triggerBytes({ pr: 900, headSha: H(4) }));
  const gate = f.exec.trainGate.bind(f.exec);
  f.exec.trainGate = () => ({ state: 'DEFERRED', reason: 'TRAIN_SOURCE_MISMATCH' });
  const r = await f.exec.tick();
  assert.equal(r.state, 'WAITING', 'the tick shows the batch resting at A');
  const page = () => describe({ pull: { pr: 900, headSha: H(4), eligible: true, hint: null, behindBy: 0 }, status: parseStatus(Buffer.from(JSON.stringify(board.snapshot()))), now: f.clock() }).description;
  assert.equal(page(), '排队第 1 位：合并列车的 Source 不一致，等 Owner 处理');
  f.exec.trainGate = gate;
  f.advance(60_000);
  await f.exec.tick();
  assert.equal(parseStatus(Buffer.from(JSON.stringify(board.snapshot()))).queue.hold, null, 'a pass that got past the gate clears it');
});

test('review round 25: the notice of a back-off whose own time is ahead names its own reason, as its page, also while a deferral holds it', async t => {
  const MIN = 60_000, REPO = 'tdoljyj/cross-memory-system', H = n => String(n).repeat(40).slice(0, 40), B = 'b'.repeat(40), KEY = 'c'.repeat(64);
  const T0 = Date.parse('2026-11-05T10:00:00Z');
  let time = T0;
  const q = await RunQueue.open(path.join(await tempRoot(t), 'queue'), () => time);
  q.offer({ repo: REPO, pr: 998, headSha: H(8), baseSha: B, prUpdatedAt: null }, time, { depth: 100, cooldownMs: 10 * MIN });
  time = T0 + 64 * MIN;
  q.begin(998, H(8), KEY, 'queued', time);
  q.settle(998, H(8), { kind: 'released', klass: 'environment', code: 'BUNDLE_UNAVAILABLE', releases24h: 1, releaseCap: 3, network: false }, time);
  q.defer(998, 'UNEXECUTED_COOLDOWN', time);
  const board = new StatusBoard({ clock: () => time });
  board.update({ backfill: { complete: true, published: 0, unreadable: 0 } });
  board.setPending(q.view(time, { etaBatchMs: 22 * MIN }));
  const st = parseStatus(Buffer.from(JSON.stringify(board.snapshot())));
  assert.match(describe({ pull: { pr: 998, headSha: H(8), eligible: true, hint: null, behindBy: 0 }, status: st, now: time }).description, /^未准入或未执行（BUNDLE_UNAVAILABLE）：约 /);
  assert.deepEqual(events({ status: st, now: time }).filter(e => e.key.startsWith('wait:')).map(e => e.key), [`wait:998:${H(8)}:BUNDLE_UNAVAILABLE`]);
});

test('review round 26: a batch going on from A ends a global deferral an earlier pass met (no stale "等 companion 就绪")', async t => {
  const { executorFixture, fakeCompanion, fakeEngine, holdAtA, triggerBytes } = await import('./helpers.mjs');
  const H = n => String(n).repeat(40).slice(0, 40);
  const W0 = Date.parse('2026-10-20T12:00:00Z');
  const script = {};
  let f;
  const board = new StatusBoard({ clock: () => f?.clock() ?? W0 });
  const now = () => parseStatus(Buffer.from(JSON.stringify(board.snapshot())));
  const page = s => describe({ pull: { pr: 900, headSha: H(4), eligible: true, hint: null, behindBy: 0 }, status: s, now: f.clock() }).description;
  const seen = [];
  const engine = fakeEngine();
  const run = engine.runStage.bind(engine);
  engine.runStage = async (b, st, o) => { const s = now(); seen.push([st.number, s.queue?.hold ?? null, page(s)]); return run(b, st, o); };
  f = await executorFixture(t, { engine, companion: fakeCompanion(script), status: board, now: W0 });
  const atA = holdAtA(f.exec, { when: s => s.pr === 884 });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'WAITING');
  await f.drop(triggerBytes({ pr: 900, headSha: H(4) }));
  script.heartbeat = 1; // a stale heartbeat: the pass meets COMPANION_NOT_READY
  await f.exec.tick();
  assert.equal(now().queue.hold, 'COMPANION_NOT_READY');
  assert.equal(page(now()), '排队第 1 位：等 companion 就绪', 'while the batch only rests at A');
  delete script.heartbeat;
  atA.release();
  f.advance(60_000);
  seen.length = 0;
  assert.equal((await f.exec.tick()).state, 'COMPLETED', 'the batch at A went on to its end, with no scheduling pass');
  assert.ok(seen.length > 0);
  assert.deepEqual(seen.filter(([, hold]) => hold !== null), [], 'no hold while the batch runs');
  assert.equal(now().queue.hold, null);
  assert.doesNotMatch(page(now()), /companion/);
});

test('review round 26: under HALT the ">1 hour" notice names the row\'s own hold, not a kept queue gate', async t => {
  const MIN = 60_000, REPO = 'tdoljyj/cross-memory-system', H = n => String(n).repeat(40).slice(0, 40), B = 'b'.repeat(40);
  const T0 = Date.parse('2026-11-05T10:00:00Z');
  let time = T0;
  const q = await RunQueue.open(path.join(await tempRoot(t), 'queue'), () => time);
  q.offer({ repo: REPO, pr: 997, headSha: H(7), baseSha: B, prUpdatedAt: null }, time, { depth: 100, cooldownMs: 10 * MIN });
  time = T0 + 65 * MIN;
  const board = new StatusBoard({ clock: () => time });
  board.update({ backfill: { complete: true, published: 0, unreadable: 0 }, halt: { code: 'RESIDENT_SOURCE_DRIFT', at: null },
    queue: { generation: 'a'.repeat(12), live: 1, depth: 100, parkingFull: false, hold: 'COMPANION_NOT_READY' } });
  board.setPending(q.view(time, { etaBatchMs: 22 * MIN }));
  const st = parseStatus(Buffer.from(JSON.stringify(board.snapshot())));
  assert.match(describe({ pull: { pr: 997, headSha: H(7), eligible: true, hint: null, behindBy: 0 }, status: st, now: time }).description, /^执行器已停机/);
  assert.deepEqual(events({ status: st, now: time }).filter(e => e.key.startsWith('wait:')).map(e => e.key), [`wait:997:${H(7)}:QUEUED`]);
});
