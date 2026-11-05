// Generation 12 (resident DESIGN 56.4): the CI identity's claim-assist port, two actions of the CI door clued_work_verify_v1. It never
// throws; a door without these actions (22023) or no door (404/PGRST202), a refusal, a 5xx and a cut network are each a named failure
// the stage only records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { digest } from '../src/proof.mjs';
import { CLAIM_ASSIST_BODY_MAX, DOOR_RPC, EXTEND_ACTION, JOIN_ACTION, STAGE1_LEASE_MINUTES, STAGE8_LEASE_MINUTES, createClaimAssistNative, extendLeaseIfShort, leaseAfter, stage1WithLease } from '../src/independent-control-checks-v2/claim-assist-native.mjs';
import { controllerPorts, nativeReadPost } from '../src/resident-v2/entry-runtime.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const HEAD = 'a'.repeat(40);
const config = { supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co/', publishableKey: 'sb_publishable_test', scope: 'project:p', repository: REPO };
const reply = (status, body) => async () => new Response(JSON.stringify(body), { status });
const port = fetchImpl => createClaimAssistNative({ config, fetchImpl, nativeToken: 'clued_bnd_secret' });

test('join and extend are actions of the CI door (clued_work_verify_v1): the CI token hash, the scope, the PR ref and the head; never the token itself', async () => {
  const sent = [];
  const p = port(async (url, init) => { sent.push({ url, init }); return new Response(JSON.stringify({ status: 'ok', joined: true, extended: true }), { status: 200 }); });
  assert.deepEqual(await p.joinQueue({ pr: 884, headSha: HEAD }), { ok: true, joined: true, reason: null });
  assert.deepEqual(await p.extendLease({ pr: 884, headSha: HEAD, minutes: 150 }), { ok: true, extended: true, expiresAt: null, reason: null });
  assert.deepEqual(sent.map(x => x.url), [0, 1].map(() => `https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/${DOOR_RPC}`));
  assert.deepEqual(JSON.parse(sent[0].init.body), { p_token_hash: digest('clued_bnd_secret'), p_input: { action: JOIN_ACTION, scope: 'project:p', pr_ref: `${REPO}#884`, head_sha: HEAD } });
  assert.deepEqual(JSON.parse(sent[1].init.body), { p_token_hash: digest('clued_bnd_secret'), p_input: { action: EXTEND_ACTION, scope: 'project:p', pr_ref: `${REPO}#884`, head_sha: HEAD, minutes: 150 } });
  assert.deepEqual([JOIN_ACTION, EXTEND_ACTION], ['merge_queue_join', 'lease_extend']);
  // neither action is a read: no layer repeats it
  const isRead = nativeReadPost('https://abcdefghijklmnopqrst.supabase.co');
  for (const x of sent) assert.equal(isRead(x.url, x.init), false);
  assert.ok(!sent.some(s => s.init.body.includes('clued_bnd_secret')));
  assert.equal(sent[0].init.method, 'POST');
  assert.equal(sent[0].init.redirect, 'error');
});

test('every failure is named, never thrown: not deployed, refused, 5xx, cut network, bad body; minutes out of range is not sent', async () => {
  const one = { pr: 1, headSha: HEAD };
  assert.deepEqual(await port(reply(404, { code: 'PGRST202', message: 'Could not find the function' })).joinQueue(one), { ok: false, code: 'CLAIM_ASSIST_NOT_DEPLOYED' });
  assert.deepEqual(await port(reply(403, { code: '42501', message: 'binding_not_authorized' })).joinQueue(one), { ok: false, code: 'CLAIM_ASSIST_REFUSED' });
  // the door: not the CI admission binding (rejected); then a door from before these actions (22023)
  assert.deepEqual(await port(reply(200, { status: 'rejected', error_code: 'admission_binding_required' })).joinQueue(one), { ok: false, code: 'CLAIM_ASSIST_REFUSED' });
  assert.deepEqual(await port(reply(400, { code: '22023', message: 'work_claim_ci_command_invalid' })).extendLease({ ...one, minutes: 30 }), { ok: false, code: 'CLAIM_ASSIST_NOT_DEPLOYED' });
  assert.deepEqual(await port(reply(503, { message: 'unavailable' })).extendLease({ ...one, minutes: 5 }), { ok: false, code: 'CLAIM_ASSIST_UNREACHABLE' });
  const cut = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); };
  assert.deepEqual(await port(cut).joinQueue(one), { ok: false, code: 'CLAIM_ASSIST_UNREACHABLE' });
  assert.deepEqual(await port(async () => new Response('not json', { status: 200 })).joinQueue(one), { ok: false, code: 'CLAIM_ASSIST_REFUSED' });
  assert.deepEqual(await port(reply(200, { status: 'ok', joined: false, reason: 'claim_not_bound' })).joinQueue(one), { ok: true, joined: false, reason: 'claim_not_bound' });
  assert.deepEqual(await port(reply(200, { status: 'ok', joined: false, reason: 'Free Text!' })).joinQueue(one), { ok: true, joined: false, reason: null });
  let called = 0;
  const counting = port(async () => { called++; return new Response('{}', { status: 200 }); });
  for (const m of [0, 181, 1.5, '30']) assert.deepEqual(await counting.extendLease({ ...one, minutes: m }), { ok: false, code: 'CLAIM_ASSIST_REFUSED' });
  assert.equal(called, 0);
});

test('extendLeaseIfShort asks only when less than the wanted minutes are left, and records what came back', async () => {
  const now = Date.parse('2026-11-05T08:00:00Z'), job = { id: 'j', pr: 884, headSha: HEAD };
  const asked = [], records = [];
  const claimAssist = { extendLease: async a => { asked.push(a); return { ok: true, extended: true, reason: null }; } };
  const record = (k, d) => records.push([k, d]);
  assert.equal(await extendLeaseIfShort({ claimAssist, job, claimExpiresAt: new Date(now + STAGE1_LEASE_MINUTES * 60_000).toISOString(), minutes: STAGE1_LEASE_MINUTES, now, record }), null);
  assert.equal(await extendLeaseIfShort({ claimAssist, job, claimExpiresAt: null, minutes: STAGE1_LEASE_MINUTES, now, record }), null, 'no lease fact: nothing asked');
  assert.equal(await extendLeaseIfShort({ claimAssist: null, job, claimExpiresAt: new Date(now).toISOString(), minutes: 5, now, record }), null);
  const r = await extendLeaseIfShort({ claimAssist, job, claimExpiresAt: new Date(now + 60 * 60_000).toISOString(), minutes: STAGE8_LEASE_MINUTES, now, record });
  assert.deepEqual(r, { ok: true, extended: true, reason: null });
  assert.deepEqual(asked, [{ pr: 884, headSha: HEAD, minutes: STAGE8_LEASE_MINUTES }]);
  assert.deepEqual(records, [['native_lease_extend', { jobId: 'j', ok: true, extended: true, code: null, minutes: STAGE8_LEASE_MINUTES }]]);
});

test('round 2: the new lease end Native answered is carried; an over-long body, a bad config or subject never throw', async () => {
  const p = port(reply(200, { status: 'ok', extended: true, expires_at: '2026-11-05T10:30:00+00:00' }));
  assert.deepEqual(await p.extendLease({ pr: 884, headSha: HEAD, minutes: 90 }), { ok: true, extended: true, expiresAt: '2026-11-05T10:30:00.000Z', reason: null });
  assert.deepEqual(await port(reply(200, { status: 'ok', extended: true, expires_at: 'later' })).extendLease({ pr: 884, headSha: HEAD, minutes: 90 }),
    { ok: true, extended: true, expiresAt: null, reason: null });
  const huge = port(async () => new Response(JSON.stringify({ status: 'ok', joined: true, pad: 'x'.repeat(CLAIM_ASSIST_BODY_MAX) }), { status: 200 }));
  assert.deepEqual(await huge.joinQueue({ pr: 884, headSha: HEAD }), { ok: false, code: 'CLAIM_ASSIST_REFUSED' });
  const none = createClaimAssistNative({ config: null, fetchImpl: async () => { throw new Error('never'); }, nativeToken: 'x' });
  assert.deepEqual(await none.joinQueue({ pr: 884, headSha: HEAD }), { ok: false, code: 'CLAIM_ASSIST_REFUSED' });
  assert.deepEqual(await port(reply(200, {})).joinQueue({ pr: 'x', headSha: HEAD }), { ok: false, code: 'CLAIM_ASSIST_REFUSED' });
  assert.deepEqual(await port(reply(200, {})).joinQueue(), { ok: false, code: 'CLAIM_ASSIST_REFUSED' });
  for (const headSha of ['A'.repeat(40), 'a'.repeat(39), 'z'.repeat(40)]) assert.deepEqual(await port(async () => { throw new Error('never sent'); }).joinQueue({ pr: 884, headSha }), { ok: false, code: 'CLAIM_ASSIST_REFUSED' });
});

test('round 2: leaseAfter and stage 1 report the lease end Native answered; any other result or failure leaves the result as it was', async () => {
  const before = '2026-11-05T09:00:00.000Z', after = '2026-11-05T10:30:00.000Z';
  assert.equal(leaseAfter(before, { ok: true, extended: true, expiresAt: after }), after);
  assert.equal(leaseAfter(before, { ok: true, extended: true, expiresAt: null }), null, 'extended but no end named: no stale end');
  assert.equal(leaseAfter(before, { ok: true, extended: false, expiresAt: null }), before);
  assert.equal(leaseAfter(before, { ok: false, code: 'CLAIM_ASSIST_NOT_DEPLOYED' }), before);
  const now = Date.parse('2026-11-05T08:00:00Z'), job = { id: 'j', pr: 884, headSha: HEAD };
  const settled = { status: 'SETTLED', effectKey: 'k', sideEffects: 1, scheduling: { ciRetryAfter: null, mergeQueue: null, claimExpiresAt: before } };
  const ok = { extendLease: async () => ({ ok: true, extended: true, expiresAt: after, reason: null }) };
  assert.deepEqual(await stage1WithLease({ result: settled, claimAssist: ok, job, now }), { ...settled, scheduling: { ...settled.scheduling, claimExpiresAt: after } });
  let asked = 0;
  const counting = { extendLease: async () => { asked++; return { ok: true, extended: true, expiresAt: after }; } };
  for (const result of [{ ...settled, status: 'BLOCKED' }, { ...settled, scheduling: null }, { ...settled, scheduling: { ...settled.scheduling, claimExpiresAt: '2026-11-05T12:00:00.000Z' } }]) {
    assert.deepEqual(await stage1WithLease({ result, claimAssist: counting, job, now }), result);
  }
  assert.equal(asked, 0, 'only a SETTLED result with a short lease asks');
  const throwing = { extendLease: async () => { throw new Error('boom'); } };
  assert.deepEqual(await stage1WithLease({ result: settled, claimAssist: throwing, job, now, record: () => { throw new Error('log full'); } }), settled);
});

test('round 2: the claim-assist POSTs go through the entry fetch once, never retried like a read', async () => {
  const record = { config: { repository: REPO, scope: `project:${randomUUID()}`, supabaseUrl: 'https://example.invalid', publishableKey: 'sb_publishable_test' }, accepted: {}, ciTokenPinSha256: 'a'.repeat(64) };
  let calls = 0;
  const ports = controllerPorts({ record, appKey: null, nativeToken: 'clued_bnd_testtoken', policyText: '{}', sourceRoot: process.cwd(), live() {}, log() {},
    baseFetch: async () => { calls++; return new Response('{"message":"unavailable"}', { status: 503 }); }, readRetry: { sleep: async () => {} } });
  const p = createClaimAssistNative({ config: record.config, fetchImpl: ports.fetchImpl, nativeToken: 'clued_bnd_testtoken' });
  assert.deepEqual(await p.joinQueue({ pr: 884, headSha: HEAD }), { ok: false, code: 'CLAIM_ASSIST_UNREACHABLE' });
  assert.deepEqual(await p.extendLease({ pr: 884, headSha: HEAD, minutes: 30 }), { ok: false, code: 'CLAIM_ASSIST_UNREACHABLE' });
  assert.equal(calls, 2);
});

test('review round 27: a line cut while the 200 answer is read is unreachable, not a refusal', async () => {
  const cutBody = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"status":"o')); c.error(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })); } }), { status: 200 });
  const c = createClaimAssistNative({ config: { supabaseUrl: 'https://x.supabase.co', publishableKey: 'k', scope: 's', repository: 'tdoljyj/cross-memory-system' }, fetchImpl: async () => cutBody(), nativeToken: 't' });
  assert.deepEqual(await c.joinQueue({ pr: 1, headSha: 'a'.repeat(40) }), { ok: false, code: 'CLAIM_ASSIST_UNREACHABLE' });
  assert.deepEqual(await c.extendLease({ pr: 1, headSha: 'a'.repeat(40), minutes: 180 }), { ok: false, code: 'CLAIM_ASSIST_UNREACHABLE' });
});
