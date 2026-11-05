// Decision 1100a0ed: KooYomi's answer is never compared with this host's clock. Its age is the local monotonic round
// trip (at most 30 s); the lease is KooYomi's expires_at against its own verified_at. DESK-W-591 passed and failed the
// same input within 0.36 s under the old `verified_at <= Date.now()`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CLOCK_SKEW_MS, LEASE_MARGIN_MS, freshStamp, notFuture, serverAnswerCurrent, retainServerAnswerForFacts, retainedServerAnswerCurrent } from '../src/clock-skew.mjs';
import { controllerPorts } from '../src/resident-v2/entry-runtime.mjs';

const NOW = Date.parse('2026-10-31T07:00:00.000Z');
const iso = ms => new Date(ms).toISOString();

test('freshStamp (stamps of this host or the bridge): 5 s ahead at most, 30 s old at most', () => {
  assert.equal(CLOCK_SKEW_MS, 5000);
  assert.equal(freshStamp(NOW + 2000, NOW), true);
  assert.equal(freshStamp(NOW + 5001, NOW), false);
  assert.equal(freshStamp(NOW - 30_000, NOW), true);
  assert.equal(freshStamp(NOW - 30_001, NOW), false);
  assert.equal(freshStamp(NaN, NOW), false);
  assert.equal(notFuture(NOW + 5000, NOW), true);
  assert.equal(notFuture(NOW + 5001, NOW), false);
});

test('serverAnswerCurrent: form of verified_at only, monotonic age ≤ 30 s, lease server-to-server', () => {
  assert.equal(LEASE_MARGIN_MS, 5000);
  const ok = { verifiedAt: iso(NOW), expiresAt: iso(NOW + 3600_000), sentMono: 1000, nowMono: 1300 };
  assert.deepEqual(serverAnswerCurrent(ok), []);
  // Any skew between the clocks is irrelevant: only server stamps are compared.
  for (const shift of [-10_000, -2000, 2000, 10_000, 3600_000]) assert.deepEqual(serverAnswerCurrent({ ...ok, verifiedAt: iso(NOW + shift), expiresAt: iso(NOW + shift + 3600_000) }), []);
  assert.deepEqual(serverAnswerCurrent({ ...ok, nowMono: 1000 + 30_000 }), []);
  assert.deepEqual(serverAnswerCurrent({ ...ok, nowMono: 1000 + 30_001 }), ['round_trip_age']);
  assert.deepEqual(serverAnswerCurrent({ ...ok, nowMono: 999 }), ['round_trip_age']);
  assert.deepEqual(serverAnswerCurrent({ ...ok, expiresAt: iso(NOW + 5300) }), ['lease_remaining'], 'age 300 ms + margin 5 s not outlasted');
  assert.deepEqual(serverAnswerCurrent({ ...ok, expiresAt: iso(NOW + 5301) }), []);
  assert.deepEqual(serverAnswerCurrent({ ...ok, verifiedAt: 'yesterday' }), ['verified_at_form']);
  assert.deepEqual(serverAnswerCurrent({ ...ok, expiresAt: null }), ['expires_at_form']);
  assert.deepEqual(serverAnswerCurrent({ ...ok, expiresAt: iso(NOW + 5000), nowMono: 32_000 }), ['round_trip_age', 'lease_remaining'],
    'an excessive RTT cannot hide a lease which does not outlast it');
});

test('issuer-held facts keep their original monotonic deadline, cannot be changed, rebound or forged by JSON', () => {
  let mono = 100;
  const answer = { verifiedAt: iso(NOW), expiresAt: iso(NOW + 60_000), sentMono: 0 };
  const facts = { observedAt: iso(NOW), claimExpiresAt: answer.expiresAt, nested: { fence: 1 } };
  assert.equal(retainServerAnswerForFacts(facts, answer, () => mono), facts);
  assert.equal(retainedServerAnswerCurrent(facts), true);
  assert.equal(retainedServerAnswerCurrent(structuredClone(facts)), null, 'serialized fields carry no issuer-held proof');
  assert.throws(() => retainServerAnswerForFacts(facts, answer, () => mono), /server_answer_binding_refused/);
  facts.nested.fence++;
  assert.equal(retainedServerAnswerCurrent(facts), false, 'the original identity and fields are bound');
  facts.nested.fence--;
  mono = 30_000; assert.equal(retainedServerAnswerCurrent(facts), true);
  mono++; assert.equal(retainedServerAnswerCurrent(facts), false, 'checking does not refresh the send time');
  assert.throws(() => retainServerAnswerForFacts({}, answer, () => mono), /server_answer_binding_refused/);
});

// The live check every Native publication runs (entry-runtime.mjs native.current).
test('native.current: this host 2 s or 10 s slow or fast passes; a round trip over 30 s or a short lease is refused and named', async (t) => {
  const repo = 'tdoljyj/cross-memory-system', scope = 'project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
  const claim = { claim_id: '11111111-1111-4111-8111-111111111111', fence: 3, execution_epoch: 1 };
  const record = { config: { repository: repo, scope, supabaseUrl: 'https://example.invalid', publishableKey: 'sb_publishable_test' }, accepted: {} };
  let serverNow = NOW, lease = 3600_000, roundTrip = 200, mono = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { mono += roundTrip; return new Response(JSON.stringify({ status: 'ok', verdict: 'ADMITTED', execution_policy: 'active',
    current_fence: 3, execution_epoch: 1, verified_at: iso(serverNow),
    claim: { ...claim, lease_key_required: false, execution_handover_pending: false, status: 'ACTIVE', context_key: scope,
      bound_pr: `${repo}#7`, expires_at: iso(serverNow + lease) } }), { status: 200 }); };
  t.after(() => { globalThis.fetch = realFetch; });
  const logged = [];
  const { native } = controllerPorts({ record, appKey: null, nativeToken: 'clued_bnd_testtoken', policyText: '{}', sourceRoot: process.cwd(), live: () => {},
    log: (kind, data) => logged.push([kind, data]), monotonic: () => mono });
  const identity = { claim, job: { repo, pr: 7, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) } };
  const mode = { scope, paths: ['README.md'], executionPolicy: 'active', guarded: false };
  for (const offset of [-10_000, -2000, 160, 2000, 10_000]) { serverNow = Date.now() + offset; assert.equal(await native.current(identity, mode), true, `offset ${offset}`); }
  assert.equal(logged.length, 0);
  roundTrip = 30_001;
  assert.equal(await native.current(identity, mode), false);
  assert.deepEqual(logged.at(-1), ['native_current_refused_round_trip_age', { failed: ['round_trip_age'] }]);
  roundTrip = 200; lease = 4000;
  assert.equal(await native.current(identity, mode), false);
  assert.deepEqual(logged.at(-1), ['native_current_refused_lease_remaining', { failed: ['lease_remaining'] }]);
});
