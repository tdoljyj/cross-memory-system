import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, parseHint, HINT_CONTRACT, DEFAULT_WAIT, RELAY_ROLES, HEAVY_ROLES, SCHEDULING_REASONS } from '../src/hosted-wait.mjs';
import { RELAYABLE_ROLES } from '../../actions-hosted-migration/independent-ci-v1/src/hosted-relay-v1/registry.mjs';

const M = 60_000;
const T0 = 1_800_000_000_000;
const SUBJ = { repo: 'tdoljyj/cross-memory-system', pr: 900, headSha: 'a'.repeat(40) };
const ON = { enabled: true };
const hint = roles => ({ observedAt: T0, roles: { gitleaks: { state: 'ABSENT' }, trivy: { state: 'ABSENT' }, ...roles } });
const bytes = v => Buffer.from(JSON.stringify(v), 'utf8');
const rec = roles => ({ contract: HINT_CONTRACT, ...SUBJ, observedAt: T0, roles });

test('relay roles are exactly the registry relayable roles; contract-placement is always local', () => {
  assert.deepEqual([...RELAY_ROLES], Object.keys(RELAYABLE_ROLES));
  assert.deepEqual([...HEAVY_ROLES], ['gitleaks', 'trivy', 'contract-placement']);
  const d = decide({ relay: ON, t0: T0, now: T0 + M, hint: hint({ gitleaks: { state: 'SUCCESS' }, trivy: { state: 'SUCCESS' } }) });
  assert.deepEqual(d.local, ['contract-placement']);
  assert.equal(d.reasons['contract-placement'], 'RELAY_ROLE_NOT_RELAYABLE');
});

test('relay disabled: start at once, all local', () => {
  const d = decide({ relay: { enabled: false }, t0: T0, now: T0, hint: null });
  assert.deepEqual([d.action, d.relayCandidates, d.local, d.reason], ['START', [], ['gitleaks', 'trivy', 'contract-placement'], 'RELAY_DISABLED']);
  assert.ok(Object.values(d.reasons).every(r => r === 'RELAY_DISABLED'));
});

test('billing refused on any role: start at once, all local', () => {
  const d = decide({ relay: ON, t0: T0, now: T0 + 1000, hint: hint({ trivy: { state: 'BILLING_REFUSED' }, gitleaks: { state: 'SUCCESS' } }) });
  assert.equal(d.action, 'START'); assert.deepEqual(d.relayCandidates, []); assert.equal(d.reason, 'RELAY_BILLING_REFUSED');
  assert.deepEqual([d.reasons.gitleaks, d.reasons.trivy], ['RELAY_HINT_BILLING_REFUSED', 'RELAY_HINT_BILLING_REFUSED']);
});

test('no hint yet: wait for the signal window, then start all local', () => {
  assert.deepEqual(decide({ relay: ON, t0: T0, now: T0 + M, hint: null }), { action: 'WAIT', until: T0 + DEFAULT_WAIT.signalMs, reason: 'RELAY_WAITING_FOR_HOSTED' });
  const d = decide({ relay: ON, t0: T0, now: T0 + 10 * M, hint: null });
  assert.equal(d.action, 'START'); assert.deepEqual(d.relayCandidates, []); assert.equal(d.reasons.gitleaks, 'RELAY_WAIT_TIMED_OUT');
});

test('queued: waits 15 minutes from first queued, running: job timeout + slack', () => {
  const h = hint({ gitleaks: { state: 'PENDING_QUEUED', queuedAt: T0 + M }, trivy: { state: 'PENDING_RUNNING', startedAt: T0 + 2 * M } });
  const d = decide({ relay: ON, t0: T0, now: T0 + 3 * M, hint: h });
  assert.equal(d.action, 'WAIT'); assert.equal(d.until, T0 + 16 * M);
  const later = decide({ relay: ON, t0: T0, now: T0 + 16 * M, hint: h });
  assert.equal(later.action, 'WAIT'); assert.equal(later.until, T0 + 2 * M + 25 * M + 10 * M);
  const end = decide({ relay: ON, t0: T0, now: T0 + 37 * M, hint: h });
  assert.equal(end.action, 'START'); assert.deepEqual(end.relayCandidates, []); assert.deepEqual(end.local, ['gitleaks', 'trivy', 'contract-placement']);
  const mixed = decide({ relay: ON, t0: T0, now: T0 + 37 * M, hint: hint({ gitleaks: { state: 'PENDING_QUEUED', queuedAt: T0 + M }, trivy: { state: 'SUCCESS' } }) });
  assert.deepEqual([mixed.relayCandidates, mixed.local, mixed.reasons.gitleaks], [['trivy'], ['gitleaks', 'contract-placement'], 'RELAY_WAIT_TIMED_OUT']);
});

test('all hosted success: start immediately relaying both relayable roles', () => {
  const d = decide({ relay: ON, t0: T0, now: T0 + 5 * M, hint: hint({ gitleaks: { state: 'SUCCESS' }, trivy: { state: 'SUCCESS' } }) });
  assert.deepEqual([d.action, d.relayCandidates, d.local, d.reason], ['START', ['gitleaks', 'trivy'], ['contract-placement'], 'RELAY_ALL_HOSTED_SUCCESS']);
});

test('total cap: start no later than t0 + 60 minutes even while running', () => {
  const h = hint({ gitleaks: { state: 'PENDING_RUNNING', startedAt: T0 + 59 * M }, trivy: { state: 'SUCCESS' } });
  assert.equal(decide({ relay: ON, t0: T0, now: T0 + 59 * M, hint: h }).until, T0 + 60 * M);
  const d = decide({ relay: ON, t0: T0, now: T0 + 60 * M, hint: h });
  assert.equal(d.action, 'START'); assert.equal(d.reason, 'RELAY_TOTAL_WAIT_REACHED'); assert.deepEqual(d.local, ['gitleaks', 'contract-placement']);
});

test('hosted not success or not eligible: those roles local, no waiting for them', () => {
  const d = decide({ relay: ON, t0: T0, now: T0 + M, hint: hint({ gitleaks: { state: 'HOSTED_NOT_SUCCESS' }, trivy: { state: 'SUCCESS' } }) });
  assert.deepEqual([d.action, d.relayCandidates, d.local, d.reasons.gitleaks], ['START', ['trivy'], ['gitleaks', 'contract-placement'], 'RELAY_HINT_HOSTED_NOT_SUCCESS']);
  const none = decide({ relay: ON, t0: T0, now: T0 + M, hint: hint({ gitleaks: { state: 'NOT_ELIGIBLE' }, trivy: { state: 'HOSTED_NOT_SUCCESS' } }) });
  assert.deepEqual([none.reason, none.relayCandidates, none.reasons.gitleaks], ['RELAY_NO_ELIGIBLE_ROLE', [], 'RELAY_HINT_NOT_ELIGIBLE']);
  for (const d2 of [d, none]) assert.ok(Object.values(d2.reasons).every(r => SCHEDULING_REASONS.includes(r)));
});

test('policy role subset: a disabled role never becomes a relay candidate', () => {
  const d = decide({ relay: { enabled: true, roles: ['gitleaks'] }, t0: T0, now: T0 + M, hint: hint({ gitleaks: { state: 'SUCCESS' }, trivy: { state: 'SUCCESS' } }) });
  assert.deepEqual([d.relayCandidates, d.reasons.trivy], [['gitleaks'], 'RELAY_ROLE_NOT_RELAYABLE']);
  assert.throws(() => decide({ relay: { enabled: true, roles: ['contract-placement'] }, t0: T0, now: T0, hint: null }), /RELAY_WAIT_POLICY_INVALID/);
});

test('parseHint: exact record parses; malformed role degrades to NOT_ELIGIBLE; wrong subject or a non-relayable role refused', () => {
  const p = parseHint(bytes(rec({ gitleaks: { state: 'SUCCESS' }, trivy: { state: 'PENDING_QUEUED' } })), SUBJ);
  assert.equal(p.roles.gitleaks.state, 'SUCCESS'); assert.equal(p.roles.trivy.state, 'NOT_ELIGIBLE');
  assert.equal(parseHint(bytes(rec({ trivy: { state: 'WAT' } })), SUBJ).roles.trivy.state, 'NOT_ELIGIBLE');
  assert.throws(() => parseHint(bytes(rec({})), { ...SUBJ, headSha: 'b'.repeat(40) }), /HOSTED_HINT_SUBJECT_MISMATCH/);
  assert.throws(() => parseHint(bytes({ ...rec({}), extra: 1 }), SUBJ), /HOSTED_HINT_REFUSED/);
  assert.throws(() => parseHint(bytes(rec({ evil: { state: 'SUCCESS' } })), SUBJ), /HOSTED_HINT_REFUSED/);
  assert.throws(() => parseHint(bytes(rec({ 'contract-placement': { state: 'SUCCESS' } })), SUBJ), /HOSTED_HINT_REFUSED/);
  assert.throws(() => parseHint(Buffer.alloc(3000, 32), SUBJ), /HOSTED_HINT_REFUSED/);
});

test('lying hint can only reduce relaying: a fake SUCCESS still goes through stage R verification', () => {
  // decide() only proposes candidates; stage R re-verifies (covered by the relay tests). Here: a hint
  // can never add a role the policy excludes, and BILLING_REFUSED anywhere forces all-local.
  const d = decide({ relay: { enabled: true, roles: ['trivy'] }, t0: T0, now: T0, hint: hint({ gitleaks: { state: 'SUCCESS' }, trivy: { state: 'BILLING_REFUSED' } }) });
  assert.deepEqual(d.relayCandidates, []);
});
