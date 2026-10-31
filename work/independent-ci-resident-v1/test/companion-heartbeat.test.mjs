// The companion's node heartbeat (step 3c-2b, DESIGN §41.6a) over a transport test double: what it reports, when it sends,
// the notifications, the take-over comment once per receipt; and the one wire call against a fake fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CompanionHeartbeat, HANDOVER_MARKER, HEARTBEAT_RPC, NODE_HEARTBEAT_EVERY_MS, WATCHDOG_STALE_MS, handoverComment, heartbeatPayload, parseHeartbeatReply,
  readHeartbeatToken, serviceRunningFrom, supabaseHeartbeatTransport } from '../src/companion-heartbeat.mjs';
import { companionHeartbeat } from '../src/companion-main.mjs';
import { tempRoot } from './helpers.mjs';

const MIN = 60_000;
const NOW = Date.parse('2026-11-01T10:00:00Z');
const SRC = 'c'.repeat(64), H = '4'.repeat(40), RECEIPT = '0a1b2c3d-0000-4000-8000-0000000000bb';
const TOKEN = 'clued_bnd_FixtureHeartbeatToken0123456789';
const status = (o = {}) => ({ writtenAt: NOW - 10_000, executor: { state: 'IDLE' }, halt: null, paused: false, intakePause: null, current: null,
  node: { name: 'turing', mode: 'ACTIVE', probe: { at: NOW - 5 * MIN, result: 'held' } }, versions: { windows: { ciSourceManifestSha256: SRC } }, ...o });

// The input check of clued_private.ci_node_heartbeat_v1 (migration 20261031090000_merge_train_failover_v1.sql), mirrored: true
// when the server would accept p_input.
const has = (o, k) => Object.hasOwn(o, k);
const jt = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v);
function serverAccepts(p) {
  const keys = ['action', 'scope', 'state', 'mode', 'probe', 'intake_paused_until', 'halt', 'ci_source_manifest_sha256', 'service_running', 'snapshot_age_seconds', 'node_name'];
  if (Object.keys(p).some(k => !keys.includes(k)) || jt(p.state) !== 'string' || !['NORMAL', 'HALTED', 'PAUSED', 'INTAKE_PAUSED', 'UNKNOWN'].includes(p.state)) return false;
  if (jt(p.service_running) !== 'boolean') return false;
  if (has(p, 'mode') && p.mode !== null && (jt(p.mode) !== 'string' || !['ACTIVE', 'STANDBY', 'UNCERTAIN'].includes(p.mode))) return false;
  if (p.state !== 'UNKNOWN' && (p.mode ?? null) === null) return false;
  if (has(p, 'probe') && p.probe !== null && (jt(p.probe) !== 'string' || !/^[a-z][a-z-]{0,39}$/.test(p.probe))) return false;
  if (has(p, 'ci_source_manifest_sha256') && p.ci_source_manifest_sha256 !== null && !/^[0-9a-f]{64}$/.test(p.ci_source_manifest_sha256)) return false;
  if (has(p, 'snapshot_age_seconds') && p.snapshot_age_seconds !== null && (jt(p.snapshot_age_seconds) !== 'number' || !/^[0-9]{1,9}$/.test(String(p.snapshot_age_seconds)))) return false;
  if (has(p, 'halt') && p.halt !== null && (jt(p.halt) !== 'object' || Buffer.byteLength(JSON.stringify(p.halt)) > 2048)) return false;
  if (has(p, 'node_name') && jt(p.node_name) !== 'string') return false;
  if ((p.state === 'INTAKE_PAUSED') !== (jt(p.intake_paused_until) === 'string')) return false;
  if (p.state !== 'INTAKE_PAUSED' && has(p, 'intake_paused_until')) return false;
  return p.action === 'ci_node_heartbeat';
}

test('the self-report is the server\'s p_input: the Source the executor runs, the mode, HALT with the batch, PAUSE, the intake pause, UNKNOWN when it cannot be told', () => {
  const p = heartbeatPayload({ nodeName: 'turing', scope: 'global', status: status(), serviceRunning: true, now: NOW });
  assert.deepEqual(p, { action: 'ci_node_heartbeat', scope: 'global', state: 'NORMAL', mode: 'ACTIVE', probe: 'held', halt: null, ci_source_manifest_sha256: SRC,
    service_running: true, snapshot_age_seconds: 10, node_name: 'turing' });
  const halted = heartbeatPayload({ nodeName: 'turing', status: status({ halt: { code: 'RESIDENT_SOURCE_DRIFT', at: NOW - MIN }, current: { pr: 951, headSha: H } }), serviceRunning: true, now: NOW });
  assert.deepEqual([halted.state, halted.halt], ['HALTED', { code: 'RESIDENT_SOURCE_DRIFT', at: new Date(NOW - MIN).toISOString(), pr: 951, headSha: H }]);
  const paused = heartbeatPayload({ nodeName: 'turing', status: status({ paused: true }), serviceRunning: true, now: NOW });
  assert.deepEqual([paused.state, Object.hasOwn(paused, 'intake_paused_until')], ['PAUSED', false]);
  const intake = heartbeatPayload({ nodeName: 'turing', status: status({ intakePause: { until: NOW + 30 * MIN, holders: [] } }), serviceRunning: true, now: NOW });
  assert.deepEqual([intake.state, intake.intake_paused_until], ['INTAKE_PAUSED', new Date(NOW + 30 * MIN).toISOString()]);
  assert.equal(heartbeatPayload({ nodeName: 'turing', status: status({ intakePause: { until: null, holders: [] } }), serviceRunning: true, now: NOW }).state, 'UNKNOWN', 'no end: not reported as one');
  const unknowns = [];
  for (const [s, running, error] of [[status(), false, false], [status({ writtenAt: NOW - 6 * MIN }), true, false], [null, true, true], [status({ writtenAt: NOW - 40 * MIN }), null, false]]) {
    const u = heartbeatPayload({ nodeName: 'turing', status: s, statusError: error, serviceRunning: running, now: NOW });
    unknowns.push(u);
    assert.deepEqual([u.state, u.mode, u.halt, u.probe], ['UNKNOWN', null, null, null]);
  }
  assert.deepEqual(unknowns.map(u => [u.service_running, u.snapshot_age_seconds]), [[false, 10], [true, 360], [true, null], [false, 2400]], 'SCM unknown: the snapshot\'s freshness stands in');
  assert.equal(heartbeatPayload({ nodeName: 'turing', status: status(), serviceRunning: null, now: NOW }).service_running, true);
  // a snapshot without a node (cannot probe) reports UNCERTAIN, never no mode with a readable state
  assert.equal(heartbeatPayload({ nodeName: 'turing', status: status({ node: null }), serviceRunning: true, now: NOW }).mode, 'UNCERTAIN');
  // the Source comes from the executor's status, never from the companion's own configuration
  assert.equal(heartbeatPayload({ nodeName: 'turing', status: status({ versions: null }), serviceRunning: true, now: NOW }).ci_source_manifest_sha256, null);
  // the installed record's scope; a bad name is left out (the server ignores it anyway)
  assert.equal(heartbeatPayload({ nodeName: 'turing', scope: 'project:0a1b2c3d-0000-4000-8000-0000000000bb', status: status(), serviceRunning: true, now: NOW }).scope, 'project:0a1b2c3d-0000-4000-8000-0000000000bb');
  assert.equal(Object.hasOwn(heartbeatPayload({ nodeName: 'Bad Name', status: status(), serviceRunning: true, now: NOW }), 'node_name'), false);
  // every report the companion can make passes the server's own input check
  for (const x of [p, halted, paused, intake, ...unknowns, heartbeatPayload({ nodeName: null, status: status({ node: null }), serviceRunning: true, now: NOW }),
    heartbeatPayload({ nodeName: 'turing', status: status({ node: { name: 'turing', mode: 'STANDBY', probe: { at: NOW, result: 'not-held' } } }), serviceRunning: true, now: NOW })]) assert.ok(serverAccepts(x), JSON.stringify(x));
  assert.equal(serverAccepts({ ...p, contract: 'x' }), false, 'the mirror refuses an extra key');
  assert.equal(serviceRunningFrom({ code: 0, stdout: 'SERVICE_NAME: CluedCIResident\n        STATE              : 4  RUNNING ' }), true);
  assert.equal(serviceRunningFrom({ code: 0, stdout: '        STATE              : 1  STOPPED ' }), false);
  assert.equal(serviceRunningFrom({ code: 1060, stdout: '[SC] OpenService FAILED 1060' }), null);
});

function beat(o = {}) {
  const sent = [], notes = [], comments = [], memo = new Map();
  let now = NOW, replies = o.replies ?? [{ ok: true, tokenRefused: false, notRegistered: false, autoHandovers: [], watchdogTickAt: NOW, watchdogStale: false }];
  let st = o.status ?? status();
  const hb = new CompanionHeartbeat({ nodeName: 'desk-w-591', scope: 'global', clock: () => now, readToken: async () => (o.token === undefined ? TOKEN : o.token), readStatus: async () => st,
    serviceRunning: async () => true,
    transport: async (msg, auth) => { sent.push({ msg, auth }); return replies.length > 1 ? replies.shift() : replies[0]; },
    notify: async (key, title, body) => { notes.push({ key, title, body }); },
    memory: { get: async k => memo.get(k) ?? 0, set: async (k, v) => { memo.set(k, v); } },
    handover: { ownerLogin: async () => 'tdoljyj', panelIssue: async () => 77, commentExists: async () => o.existing ?? false, comment: async (issue, body) => { comments.push({ issue, body }); return true; } } });
  return { hb, sent, notes, comments, memo, advance: ms => { now += ms; }, setStatus: s => { st = s; }, setReplies: r => { replies = r; } };
}

test('no token installed: nothing runs; with one: every 10 minutes, at once on a change, the token as the transport\'s credential', async () => {
  const none = beat({ token: null });
  assert.deepEqual(await none.hb.step(), { skipped: 'NO_TOKEN' });
  assert.equal(none.sent.length, 0);
  const t = beat();
  assert.equal((await t.hb.step()).sent, true);
  assert.deepEqual([t.sent[0].auth.token, t.sent[0].msg.payload.node_name, t.sent[0].msg.payload.state, t.sent[0].msg.payload.scope], [TOKEN, 'desk-w-591', 'NORMAL', 'global']);
  t.advance(MIN);
  assert.deepEqual(await t.hb.step(), { skipped: 'NOT_DUE' });
  t.setStatus(status({ halt: { code: 'X_Y', at: NOW } }));
  assert.equal((await t.hb.step()).payload.state, 'HALTED', 'a change goes at once');
  t.advance(MIN);
  assert.deepEqual(await t.hb.step(), { skipped: 'NOT_DUE' }, 'the snapshot age alone is no change');
  t.advance(NODE_HEARTBEAT_EVERY_MS);
  assert.equal((await t.hb.step()).sent, true);
  assert.equal(t.sent.length, 3);
});

test('three failures in a row, or a refused token, notify once per spell; a stale watchdog notifies once per tick', async () => {
  const fail = { ok: false, tokenRefused: false, notRegistered: false, autoHandovers: [], watchdogTickAt: null, watchdogStale: null };
  const t = beat({ replies: [fail] });
  for (let i = 0; i < 4; i += 1) { await t.hb.step(); t.advance(NODE_HEARTBEAT_EVERY_MS); }
  assert.deepEqual(t.notes.map(n => n.title), ['节点心跳发不出去'], 'once, at the third failure');
  const refused = beat({ replies: [{ ...fail, tokenRefused: true }] });
  await refused.hb.step();
  assert.match(refused.notes[0].body, /换一个心跳令牌/);
  const w = beat({ replies: [{ ok: true, tokenRefused: false, notRegistered: false, autoHandovers: [], watchdogTickAt: NOW - WATCHDOG_STALE_MS - 1, watchdogStale: null }] });
  assert.equal((await w.hb.step()).watchdogStale, true);
  w.advance(NODE_HEARTBEAT_EVERY_MS);
  await w.hb.step();
  assert.deepEqual(w.notes.map(n => n.title), ['自动接班看门狗未运行']);
  // the server's own stale flag wins; a watchdog that never ticked is stale too; an answer without one keeps what was known
  const never = beat({ replies: [{ ok: true, tokenRefused: false, notRegistered: false, autoHandovers: [], watchdogTickAt: null, watchdogStale: true }] });
  assert.equal((await never.hb.step()).watchdogStale, true);
  never.setReplies([{ ok: true, tokenRefused: false, notRegistered: false, autoHandovers: [], watchdogTickAt: null, watchdogStale: null }]);
  never.advance(NODE_HEARTBEAT_EVERY_MS);
  assert.equal((await never.hb.step()).watchdogStale, true, 'unknown: kept');
  // not registered: its own notice, at once and once per spell, not the failure count
  const unreg = beat({ replies: [{ ...fail, notRegistered: true }] });
  for (let i = 0; i < 4; i += 1) { assert.equal((await unreg.hb.step()).notRegistered, true); unreg.advance(NODE_HEARTBEAT_EVERY_MS); }
  assert.deepEqual(unreg.notes.map(n => n.title), ['节点心跳未登记']);
  assert.equal(unreg.hb.failures, 0);
});

test('an automatic take-over to this node: one marked @Owner comment on the compute panel issue per receipt', async () => {
  const FROM = '0a1b2c3d-0000-4000-8000-0000000000aa';
  const h = { receiptId: RECEIPT, from: FROM, to: null, at: new Date(NOW).toISOString(), trigger: 'silent' };
  const t = beat({ replies: [{ ok: true, tokenRefused: false, notRegistered: false, autoHandovers: [h], watchdogTickAt: NOW, watchdogStale: false }] });
  await t.hb.step();
  t.advance(NODE_HEARTBEAT_EVERY_MS);
  await t.hb.step();
  assert.equal(t.comments.length, 1);
  assert.equal(t.comments[0].issue, 77);
  assert.ok(t.comments[0].body.startsWith(HANDOVER_MARKER(RECEIPT)) && t.comments[0].body.includes('@tdoljyj') && t.comments[0].body.includes(FROM) && t.comments[0].body.includes('desk-w-591'));
  // already on the issue (another start or machine): not again
  const seen = beat({ existing: true, replies: [{ ok: true, tokenRefused: false, notRegistered: false, autoHandovers: [h], watchdogTickAt: NOW, watchdogStale: false }] });
  await seen.hb.step();
  assert.equal(seen.comments.length, 0);
  assert.ok(seen.memo.has(`auto-handover:${RECEIPT}`));
  // several receipts in one answer: one comment each
  const two = beat({ replies: [{ ok: true, tokenRefused: false, notRegistered: false, autoHandovers: [h, { ...h, receiptId: '0a1b2c3d-0000-4000-8000-0000000000cc' }], watchdogTickAt: NOW, watchdogStale: false }] });
  await two.hb.step();
  assert.equal(two.comments.length, 2);
  assert.equal(handoverComment(h, 'tdoljyj', 'desk-w-591').split('\n')[0], `<!-- clued-auto-handover:${RECEIPT} -->`);
});

test('the reply is read tolerantly; the wire call posts the CI command door with the token hashed, never the token itself', async t => {
  const ok = { status: 'ok', received_at: '2026-11-01T10:00:00.123+00:00', node_ids: ['0a1b2c3d-0000-4000-8000-0000000000dd'], intake_paused_until: null,
    watchdog: { last_tick_at: '2026-11-01T09:59:00+00:00', stale: false },
    auto_handovers: [{ receipt_id: RECEIPT.toUpperCase(), from_binding_id: '0A1B2C3D-0000-4000-8000-0000000000AA', to_binding_id: '0a1b2c3d-0000-4000-8000-0000000000ee',
      effective_at: '2026-11-01T10:05:00+00:00', trigger: 'silent', created_at: '2026-11-01T10:00:00+00:00' }, { receipt_id: 'x' }, 'junk'] };
  assert.deepEqual(parseHeartbeatReply(ok), { ok: true, tokenRefused: false, notRegistered: false, watchdogTickAt: Date.parse('2026-11-01T09:59:00Z'), watchdogStale: false,
    autoHandovers: [{ receiptId: RECEIPT, from: '0a1b2c3d-0000-4000-8000-0000000000aa', to: '0a1b2c3d-0000-4000-8000-0000000000ee', at: '2026-11-01T10:05:00.000Z', trigger: 'silent' }] });
  // missing or odd optional parts never fail the beat
  for (const v of [{ status: 'ok' }, { status: 'ok', watchdog: 'x', auto_handovers: {} }, { status: 'ok', watchdog: { last_tick_at: null, stale: 'yes' }, auto_handovers: null }]) {
    const r = parseHeartbeatReply(v);
    assert.deepEqual([r.ok, r.autoHandovers, r.watchdogTickAt, r.watchdogStale], [true, [], null, null]);
  }
  assert.equal(parseHeartbeatReply({ status: 'ok', watchdog: { last_tick_at: null, stale: true } }).watchdogStale, true);
  assert.deepEqual(parseHeartbeatReply({ status: 'rejected', error_code: 'ci_node_not_registered' }), { ok: false, tokenRefused: false, notRegistered: true, autoHandovers: [], watchdogTickAt: null, watchdogStale: null });
  assert.equal(parseHeartbeatReply('ok').ok, false);
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { status: [200, 404, 403][calls.length - 1] ?? 400, text: async () => (calls.length === 1 ? JSON.stringify(ok) : '{"code":"PGRST202"}') }; };
  const send = supabaseHeartbeatTransport({ supabaseUrl: 'https://abc123.supabase.co', publishableKey: 'sb_publishable_x1', fetchImpl });
  const payload = heartbeatPayload({ nodeName: 'turing', scope: 'global', status: status(), serviceRunning: true, now: NOW });
  assert.equal((await send({ payload }, { token: TOKEN })).ok, true);
  assert.equal(HEARTBEAT_RPC, 'clued_work_verify_v1');
  assert.equal(calls[0].url, 'https://abc123.supabase.co/rest/v1/rpc/clued_work_verify_v1');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, { p_token_hash: createHash('sha256').update(TOKEN).digest('hex'), p_input: payload });
  assert.equal(body.p_input.action, 'ci_node_heartbeat');
  assert.ok(!calls[0].init.body.includes(TOKEN) && calls[0].init.headers.apikey === 'sb_publishable_x1');
  assert.equal((await send({ payload }, { token: TOKEN })).ok, false, 'not deployed yet (404): a failed beat, never an error');
  assert.equal((await send({ payload }, { token: TOKEN })).tokenRefused, true, '403: the token is refused');
  assert.deepEqual([(await send({ payload }, { token: TOKEN })).ok, calls.length], [false, 4], '400 (input refused): a failed beat');
  assert.throws(() => supabaseHeartbeatTransport({ supabaseUrl: 'https://example.com', publishableKey: 'sb_publishable_x1', fetchImpl }));
  // the token file, and the companion without one
  const root = await tempRoot(t);
  assert.equal(await readHeartbeatToken(root), null);
  assert.equal(await companionHeartbeat({ root, nodeName: 'turing', ghExe: 'gh', repo: 'r/r', powershellExe: 'C:\\ps.exe', run: async () => ({ code: 0 }), store: { data: { notified: {} } } }), null);
  await fs.mkdir(path.join(root, 'secrets', 'heartbeat'), { recursive: true });
  await fs.writeFile(path.join(root, 'secrets', 'heartbeat', 'ci-node-heartbeat.token'), `${TOKEN}\r\n`);
  assert.equal(await readHeartbeatToken(root), TOKEN);
  const hb = await companionHeartbeat({ root, nodeName: 'turing', ghExe: 'gh', repo: 'r/r', powershellExe: 'C:\\ps.exe', run: async () => ({ code: 0 }), store: { data: { notified: {} }, save: async () => {} },
    readJson: async () => ({ supabaseUrl: 'https://abc123.supabase.co', publishableKey: 'sb_publishable_x1', scope: 'project:0a1b2c3d-0000-4000-8000-0000000000bb' }) });
  assert.ok(hb instanceof CompanionHeartbeat);
  assert.equal(hb.scope, 'project:0a1b2c3d-0000-4000-8000-0000000000bb', 'the installed record\'s scope');
});
