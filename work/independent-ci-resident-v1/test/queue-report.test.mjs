import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { advisoryLanes, lane } from '../src/companion-main.mjs';
import * as heartbeat from '../src/companion-heartbeat.mjs';
import { StatusBoard, parseStatus } from '../src/status.mjs';

const MIN = 60_000;
const NOW = Date.parse('2026-11-26T01:47:00Z');
const head = pr => pr.toString(16).padStart(40, '0');
const pull = pr => ({ pr, headSha: head(pr), eligible: true });
const row = pr => ({ pr, headSha: head(pr), state: 'QUEUED', position: 1,
  deferred: 'SAFE_POINT_READMISSION', since: NOW - 40 * MIN, eta: NOW + MIN });
const board = (overrides = {}) => ({
  writtenAt: NOW, node: { name: 'turing', mode: 'ACTIVE', source: 'a'.repeat(12) },
  executor: { state: 'IDLE', since: NOW - 40 * MIN }, current: null, pending: [], recent: [],
  backfill: { complete: true }, train: { enabled: 'off', last: null }, ...overrides,
});
const queue = () => import('../src/queue-report.mjs');

test('incident: the merged front still holds the queue and the three open heads have not entered it', async () => {
  const { queueStall, queueReport } = await queue();
  const status = board({ pending: [row(1365)], recent: [{ ...pull(1365), at: NOW - 16 * MIN }],
    train: { enabled: 'on', last: { at: NOW - MIN, mode: 'revoke-only', decision: 'NO_FRONT', onDuty: true } } });
  const pulls = [1366, 1367, 1368].map(pull);
  const stall = queueStall(status, pulls, NOW);
  assert.deepEqual([stall.code, stall.level, stall.since], ['NO_PROGRESS', 'red', NOW - 16 * MIN]);
  assert.match(stall.text, /#1365.*安全点/);
  const view = queueReport({ status, pulls, now: NOW });
  assert.equal(view.contract, 'clued.merge-queue-node-view/1');
  assert.deepEqual(view.unqueued, pulls.map(({ pr, headSha }) => ({ pr, headSha })));
  assert.notEqual(queueStall({ ...status, recent: [{ at: NOW - 14 * MIN }] }, pulls, NOW)?.level, 'red');
  assert.equal(queueStall({ ...status, recent: [{ at: NOW - 15 * MIN }] }, pulls, NOW)?.code, 'TRAIN_NOT_ON');
});

test('hard pause is yellow immediately and turns red at 30 minutes with work', async () => {
  const { queueStall } = await queue();
  const status = board({ paused: true, executor: { state: 'PAUSED', since: NOW - 30 * MIN } });
  assert.equal(queueStall({ ...status, writtenAt: NOW - 30 * MIN }, [pull(1)], NOW - 30 * MIN).level, 'yellow');
  assert.equal(queueStall(status, [pull(1)], NOW - 1).level, 'yellow');
  assert.equal(queueStall(status, [pull(1)], NOW).level, 'red');
  assert.equal(queueStall(status, [], NOW).level, 'yellow');
  const intake = { until: NOW + MIN, holders: [{ since: NOW - MIN }, { since: NOW - 32 * MIN }] };
  assert.equal(queueStall(board({ intakePause: intake }), [pull(1)], NOW).since, NOW - 32 * MIN);
  assert.equal(queueStall(board({ paused: true, halt: { code: 'PUBLICATION_UNCERTAIN', at: NOW } }), [pull(1)], NOW).code, 'PUBLICATION_UNCERTAIN');
  assert.equal(queueStall(board({ writtenAt: NOW - 6 * MIN }), [], NOW).code, 'STATUS_STALE');
  assert.equal(queueStall(null, [], NOW).code, 'STATUS_UNREADABLE');
});

test('front overdue uses the parsed stage start, twice P90 with a 15-minute floor, or 45 minutes without statistics', async () => {
  const { queueStall, queueReport } = await queue();
  const statusBoard = new StatusBoard({ clock: () => NOW });
  statusBoard.setState('RUNNING');
  statusBoard.setCurrent({ ...pull(1367), baseSha: head(1), key: 'a'.repeat(12), attempt: 1, stage: 1 });
  const sample = (age, p90Ms) => {
    const raw = statusBoard.snapshot();
    const parsed = parseStatus(Buffer.from(JSON.stringify({ ...raw,
      current: { ...raw.current, stageSince: new Date(NOW - age * MIN).toISOString() } })));
    return { ...parsed, timing: { stats: { segments: { 1: { p90Ms } } } } };
  };
  for (const [age, p90Ms, overdue] of [[15, MIN, false], [16, MIN, true], [20, 10 * MIN, false],
    [21, 10 * MIN, true], [45, null, false], [46, null, true]]) {
    const status = sample(age, p90Ms);
    assert.equal(queueStall(status, [], NOW)?.code ?? null, overdue ? 'FRONT_STAGE_OVERDUE' : null, `${age}/${p90Ms}`);
    assert.equal(queueReport({ status, pulls: [], now: NOW }).current.stageSince, NOW - age * MIN);
    assert.equal(queueReport({ status, pulls: [], now: NOW }).current.stageName, '准入');
  }
  const running = sample(10, null);
  const train = { enabled: 'on', last: { mode: 'on', at: NOW - 26 * MIN } };
  assert.equal(queueStall({ ...running, node: board().node, train }, [], NOW)?.code, 'TRAIN_STALE');
  assert.equal(queueStall({ ...running, node: { ...board().node, mode: 'STANDBY' }, train }, [], NOW), null);
});

test('view is allowlisted and bounded, and never leaks free text or reports already observed or ineligible heads', async () => {
  const { queueReport } = await queue();
  const pending = Array.from({ length: 36 }, (_, i) => ({ ...row(i + 1), privateText: 'secret source text' }));
  const pulls = [...pending.map(p => pull(p.pr)), ...Array.from({ length: 36 }, (_, i) => pull(101 + i)),
    { ...pull(999), eligible: false }, { ...pull(998), draft: true }, pull(997)];
  const status = board({ pending, recent: [pull(997)],
    versions: { generation: 8, consistent: true, upgrade: { phase: 'drain', confirmUrl: 'secret source text' },
      selfcheck: { result: 'PASS', observedAt: NOW } },
    notices: Array.from({ length: 14 }, (_, i) => ({ key: String(i), kind: 'selfcheck-failed' })) });
  const view = queueReport({ status, pulls, now: NOW });
  assert.deepEqual([view.pending.length, view.unqueued.length, view.alerts.length], [30, 30, 10]);
  assert.deepEqual(view.unqueued.map(p => p.pr), Array.from({ length: 30 }, (_, i) => 101 + i));
  assert.deepEqual(view.node.selfcheck, { result: 'PASS', observedAt: NOW });
  assert.equal(view.node.generation, 8);
  assert.equal(view.node.upgrade.phase, 'drain');
  const json = JSON.stringify(view);
  assert.doesNotMatch(json, /secret source text|confirmUrl|eta|writtenAt/);
  assert.ok(Buffer.byteLength(json) <= 32 * 1024);
});

test('queue reports only changes, keep alive at 10 minutes and retry a failed send on the next pass', async () => {
  const { QueueReporter } = await queue();
  let now = NOW;
  let reply = { status: 200, data: { status: 'ok' } };
  const sends = [];
  const reporter = new QueueReporter({ scope: 'global', readToken: async () => 'token', clock: () => now,
    transport: async ({ payload }, { token }) => { sends.push({ payload, token }); return reply; } });
  const step = (state = 'IDLE') => reporter.step({ status: board({ writtenAt: now, pending: [{ ...row(1), eta: now + MIN }],
    executor: { state, since: NOW - 40 * MIN } }), pulls: [pull(2)] });
  assert.equal(await step(), true);
  now += 10 * MIN - 1;
  assert.equal(await step(), false);
  now += 1;
  assert.equal(await step(), true);
  assert.deepEqual(sends.map(s => s.payload.action), ['ci_queue_report', 'ci_queue_report']);
  assert.equal(sends[0].payload.scope, 'global');
  assert.deepEqual(Object.keys(sends[0].payload).sort(), ['action', 'scope', 'view']);
  assert.deepEqual(sends[0].payload.view, sends[1].payload.view);
  assert.equal(sends[0].token, 'token');
  reply = { status: 503, data: null };
  assert.equal(await step('WAITING'), false);
  now += 30_000;
  reply = { status: 200, data: { status: 'ok' } };
  assert.equal(await step('WAITING'), true);
  assert.equal(sends.length, 4);
  assert.notDeepEqual(sends[1].payload.view, sends[2].payload.view);
  assert.equal(sends[2].payload.view.executor.state, sends[3].payload.view.executor.state);
});

test('old command doors suppress sends for one hour from the refusal', async () => {
  const { QueueReporter } = await queue();
  for (const reply of [{ status: 200, data: { status: 'rejected', error_code: 'heartbeat_connection_only' } },
    { status: 400, data: { code: '22023', message: 'work_claim_action_invalid' } }]) {
    let now = NOW, calls = 0;
    const reporter = new QueueReporter({ scope: 'global', readToken: async () => 'token', clock: () => now,
      transport: async () => { calls++; now += 1000; return reply; } });
    const step = () => reporter.step({ status: board({ writtenAt: now }) });
    assert.equal(await step(), false);
    now += 60 * MIN - 1;
    assert.equal(await step(), false);
    assert.equal(calls, 1);
    now += 1;
    assert.equal(await step(), false);
    assert.equal(calls, 2);
  }
});

test('the shared request sends the queue action through the existing RPC and hashes the token', async () => {
  const calls = [];
  const send = heartbeat.supabaseCiCommandRequest({ supabaseUrl: 'https://example.supabase.co', publishableKey: 'sb_publishable_key',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { status: 200, text: async () => '{"status":"ok"}' };
    } });
  const payload = { action: 'ci_queue_report', scope: 'global', view: {} };
  assert.deepEqual(await send({ payload }, { token: 'abc' }), { status: 200, data: { status: 'ok' } });
  assert.match(calls[0].url, /\/rest\/v1\/rpc\/clued_work_verify_v1$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), { p_input: payload,
    p_token_hash: createHash('sha256').update('abc').digest('hex') });
});

test('a throwing queue transport cannot prevent the production heartbeat and PR status lanes from writing', async () => {
  const { QueueReporter } = await queue();
  const seen = [];
  const transport = async () => { seen.push('queue'); throw new Error('offline'); };
  const runner = { busy: false };
  const readStatus = async () => board();
  const queueReporter = new QueueReporter({ scope: 'global', transport, readToken: async () => 'token', clock: () => NOW });
  const beat = new heartbeat.CompanionHeartbeat({ nodeName: 'turing', scope: 'global', clock: () => NOW,
    readToken: async () => 'token', readStatus, serviceRunning: async () => true,
    transport: async ({ payload }) => { seen.push(payload.action); return { ok: true, autoHandovers: [] }; } });
  const { poller, lanes } = advisoryLanes({ advisory: runner, pollRunner: runner, clock: () => NOW,
    repo: 'owner/repo', ghExe: 'gh', readStatus, writeTrigger: async () => {},
    heartbeat: beat, heartbeatRunner: runner, queueReporter,
    renewKeyCheck: async () => {}, retentionNotifier: { step: async () => {} }, pruneOldBundles: async () => {},
    backstop: async () => {}, reporter: { pass: ({ pulls }) => { assert.deepEqual(pulls, [pull(1)]); seen.push('pr'); } } });
  poller.lastPass = { pulls: [pull(1)] };
  assert.equal(lanes.length, 4);
  await Promise.all(lanes.slice(1).map(spec => {
    let done = false;
    return lane({ ...spec, stop: () => done, sleep: async () => { done = true; } });
  }));
  assert.deepEqual(seen.sort(), ['ci_node_heartbeat', 'pr', 'queue']);
});
