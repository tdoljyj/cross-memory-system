import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, parseHint, HINT_CONTRACT, DEFAULT_WAIT, RELAY_ROLES, HEAVY_ROLES } from '../src/hosted-wait.mjs';
import { RELAYABLE_ROLES } from '../../actions-hosted-migration/independent-ci-v1/src/hosted-relay-v1/registry.mjs';

const M = 60_000, T0 = 1_800_000_000_000;
const SUBJ = { repo: 'tdoljyj/cross-memory-system', pr: 900, headSha: 'a'.repeat(40) };
const ON = { enabled: true };
const hint = roles => ({ observedAt: T0, roles: { gitleaks: { state: 'ABSENT' }, trivy: { state: 'ABSENT' }, ...roles } });
const bytes = v => Buffer.from(JSON.stringify(v), 'utf8');
const rec = roles => ({ contract: HINT_CONTRACT, ...SUBJ, observedAt: T0, roles });
function held(d, reason) {
  assert.equal(d.action, 'WAIT');
  if (reason) assert.equal(d.reason, reason);
  assert.equal(d.local, undefined, 'a wait never authorizes a Native role');
  assert.equal(d.relayCandidates, undefined);
}

test('relay roles mirror the registry; only dual SUCCESS schedules StageR and placement stays local', () => {
  assert.deepEqual([...RELAY_ROLES], Object.keys(RELAYABLE_ROLES));
  assert.deepEqual([...HEAVY_ROLES], ['gitleaks', 'trivy', 'contract-placement']);
  for (const now of [T0, T0 + M, T0 + 2 * DEFAULT_WAIT.totalMs]) {
    const d = decide({ relay: ON, t0: T0, now, hint: hint({ gitleaks: { state: 'SUCCESS' }, trivy: { state: 'SUCCESS' } }) });
    assert.deepEqual([d.action, d.relayCandidates, d.local, d.reason],
      ['START', ['gitleaks', 'trivy'], ['contract-placement'], 'RELAY_ALL_HOSTED_SUCCESS']);
    assert.equal(d.reasons['contract-placement'], 'RELAY_ROLE_NOT_RELAYABLE');
  }
});

test('relay disabled preserves the Native-only route regardless of hint or elapsed time', () => {
  for (const h of [null, hint({ gitleaks: { state: 'SUCCESS' }, trivy: { state: 'BILLING_REFUSED' } })]) {
    const d = decide({ relay: { enabled: false }, t0: T0, now: T0 + 120 * M, hint: h });
    assert.deepEqual([d.action, d.relayCandidates, d.local, d.reason],
      ['START', [], ['gitleaks', 'trivy', 'contract-placement'], 'RELAY_DISABLED']);
    assert.ok(Object.values(d.reasons).every(r => r === 'RELAY_DISABLED'));
  }
});

test('billing, failed hosted scan and NOT_ELIGIBLE never authorize local fallback', () => {
  for (const state of ['BILLING_REFUSED', 'HOSTED_NOT_SUCCESS', 'NOT_ELIGIBLE']) {
    for (const role of RELAY_ROLES) {
      const d = decide({ relay: ON, t0: T0, now: T0 + M,
        hint: hint({ gitleaks: { state: 'SUCCESS' }, trivy: { state: 'SUCCESS' }, [role]: { state } }) });
      held(d, 'RELAY_PROVIDER_TRANSFER_REQUIRED');
      assert.ok(d.until > T0 + M);
    }
  }
});

test('missing hints wait through signal timeout and total hard stop without a provider transfer', () => {
  const early = decide({ relay: ON, t0: T0, now: T0 + M, hint: null });
  held(early, 'RELAY_WAITING_FOR_HOSTED');
  assert.equal(early.until, T0 + DEFAULT_WAIT.signalMs);
  for (const now of [T0 + DEFAULT_WAIT.signalMs, T0 + DEFAULT_WAIT.totalMs, T0 + 24 * 60 * M]) {
    const d = decide({ relay: ON, t0: T0, now, hint: null });
    held(d, 'RELAY_PROVIDER_TRANSFER_REQUIRED');
    assert.equal(d.until, now + DEFAULT_WAIT.pollMs);
  }
});

test('queued/running deadlines and late hard stops only change the wait reason, never the provider', () => {
  const h = hint({ gitleaks: { state: 'PENDING_QUEUED', queuedAt: T0 + M }, trivy: { state: 'PENDING_RUNNING', startedAt: T0 + 2 * M } });
  const early = decide({ relay: ON, t0: T0, now: T0 + 3 * M, hint: h });
  held(early); assert.equal(early.until, T0 + 16 * M);
  for (const now of [T0 + 16 * M, T0 + 37 * M, T0 + 120 * M])
    held(decide({ relay: ON, t0: T0, now, hint: h }), 'RELAY_PROVIDER_TRANSFER_REQUIRED');
  const running = hint({ gitleaks: { state: 'PENDING_RUNNING', startedAt: T0 + 59 * M }, trivy: { state: 'SUCCESS' } });
  held(decide({ relay: ON, t0: T0, now: T0 + 60 * M, hint: running }), 'RELAY_PROVIDER_TRANSFER_REQUIRED');
});

test('a role subset cannot silently route the omitted hosted role to Native', () => {
  for (const roles of [[], ['gitleaks'], ['trivy'], ['gitleaks', 'gitleaks']]) {
    held(decide({ relay: { enabled: true, roles }, t0: T0, now: T0,
      hint: hint({ gitleaks: { state: 'SUCCESS' }, trivy: { state: 'SUCCESS' } }) }), 'RELAY_HOSTED_ROLE_SET_INCOMPLETE');
  }
  assert.throws(() => decide({ relay: { enabled: true, roles: ['contract-placement'] }, t0: T0, now: T0, hint: null }), /RELAY_WAIT_POLICY_INVALID/);
});

test('every non-success state combined with SUCCESS keeps both hosted roles off Native', () => {
  for (const state of ['ABSENT', 'PENDING_QUEUED', 'PENDING_RUNNING', 'HOSTED_NOT_SUCCESS', 'BILLING_REFUSED', 'NOT_ELIGIBLE']) {
    const value = { state, queuedAt: T0, startedAt: T0 };
    held(decide({ relay: ON, t0: T0, now: T0 + 120 * M, hint: hint({ gitleaks: value, trivy: { state: 'SUCCESS' } }) }));
  }
});

test('parseHint preserves exact subject binding; malformed roles cannot become Native authority', () => {
  const p = parseHint(bytes(rec({ gitleaks: { state: 'SUCCESS' }, trivy: { state: 'PENDING_QUEUED' } })), SUBJ);
  assert.equal(p.roles.gitleaks.state, 'SUCCESS'); assert.equal(p.roles.trivy.state, 'NOT_ELIGIBLE');
  held(decide({ relay: ON, t0: T0, now: T0 + 120 * M, hint: p }), 'RELAY_PROVIDER_TRANSFER_REQUIRED');
  assert.equal(parseHint(bytes(rec({ trivy: { state: 'WAT' } })), SUBJ).roles.trivy.state, 'NOT_ELIGIBLE');
  assert.throws(() => parseHint(bytes(rec({})), { ...SUBJ, headSha: 'b'.repeat(40) }), /HOSTED_HINT_SUBJECT_MISMATCH/);
  for (const value of [{ ...rec({}), extra: 1 }, rec({ evil: { state: 'SUCCESS' } }), rec({ 'contract-placement': { state: 'SUCCESS' } })])
    assert.throws(() => parseHint(bytes(value), SUBJ), /HOSTED_HINT_REFUSED/);
  assert.throws(() => parseHint(Buffer.alloc(3000, 32), SUBJ), /HOSTED_HINT_REFUSED/);
});
