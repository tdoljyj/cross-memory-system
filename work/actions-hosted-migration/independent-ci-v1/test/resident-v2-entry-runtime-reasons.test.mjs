import test from 'node:test';
import assert from 'node:assert/strict';
import { safeReason } from '../src/resident-v2/entry-runtime.mjs';
import { ALL_STAGE_CODES, githubTransientReason, outcomeFailureCode } from '../src/resident-v2/stage-fact.mjs';

const UNKNOWN = 'ENTRY_OPERATION_UNCONFIRMED';

test('Native PR Task waiting states preserve the existing unburned claim wait; conflicts refuse', () => {
  for (const state of ['unbound', 'no_live_claim', 'handover_pending', 'head_not_authorized']) {
    assert.equal(outcomeFailureCode({ status: 'BLOCKED', sideEffects: 0, mayHavePublished: false,
      reason: 'full_admission_rejected', diagnostic: { reasonCodes: [`pr_task_binding_${state}`] } }, 1), 'CLAIM_NOT_CURRENT');
  }
  assert.equal(outcomeFailureCode({ status: 'BLOCKED', sideEffects: 0, mayHavePublished: false,
    reason: 'full_admission_rejected', diagnostic: { reasonCodes: ['pr_task_binding_conflict'] } }, 1), 'NATIVE_NOT_ADMITTED');
});

test('public entry reasons preserve fixed stage, lifecycle and transport semantics', () => {
  for (const code of [...ALL_STAGE_CODES, 'HELD_RECORD_LEASE_LOST', 'HELD_RECORD_PROCESS_UNCONFIRMED',
    'RECORD_ACCEPTANCE_INVALID', 'FIXED_V2_ENTRY_ARGUMENTS_REQUIRED', 'STAGE_INPUT_CHANGED',
    'secret_file_boundary_unconfirmed', 'native_claim_observation_unavailable', 'full_admission_unavailable',
    'full_admission_claim_missing', 'full_admission_subject_changed', 'evidence_identity_conflict', 'BRIDGE_RESULT_DEADLINE',
    'github_transport_unconfirmed', 'github_http_403', 'github_http_429', 'github_http_500', 'github_http_599']) {
    assert.equal(safeReason(Object.assign(new Error('not public'), { code })), code);
  }
  assert.equal(githubTransientReason(safeReason({ code: 'github_http_429' })), true);
  assert.equal(githubTransientReason(safeReason({ code: 'github_http_503' })), true);
  assert.equal(githubTransientReason(safeReason({ code: 'github_http_403' })), false);
  const failure = code => outcomeFailureCode({ status: 'BLOCKED', sideEffects: 0, mayHavePublished: false, reason: safeReason({ code }) }, 1);
  assert.equal(failure('BRIDGE_RESULT_DEADLINE'), 'BRIDGE_TRANSPORT_TIMEOUT');
  assert.equal(failure('full_admission_claim_missing'), 'CLAIM_NOT_CURRENT');
  assert.equal(failure('full_admission_subject_changed'), 'PR_NOT_OPEN_OR_CHANGED');
  assert.equal(failure('evidence_identity_conflict'), 'EVIDENCE_IDENTITY_CONFLICT');
});

test('unknown strings and unbounded or malformed HTTP suffixes never become public reasons', () => {
  for (const code of ['SECRET_TOKEN_FROM_EXCEPTION', 'SECRET', 'github_http_099', 'github_http_600',
    'github_http_500_SECRET', 'github_http_0500', 'github_http_5e2', 'github_http_500\n',
    'HELD_RECORD_LEASE_LOST_SECRET', '', null, undefined, 503, NaN, Symbol('secret'), 503n]) {
    assert.equal(safeReason({ code, message: 'SECRET_MESSAGE' }), UNKNOWN);
  }
  for (const value of [null, undefined, 'SECRET', 503, true, Symbol('secret'), 503n]) assert.equal(safeReason(value), UNKNOWN);
});

test('entry reason extraction never invokes code getters or coerces their values', () => {
  let reads = 0, coercions = 0;
  const code = { [Symbol.toPrimitive]() { coercions++; throw new Error('SECRET_COERCION'); },
    toString() { coercions++; return 'github_http_503'; }, valueOf() { coercions++; return 'HELD_RECORD_LEASE_LOST'; } };
  assert.equal(safeReason({ code }), UNKNOWN);
  assert.equal(safeReason(new Proxy({}, { get() { reads++; throw new Error('SECRET_GET_TRAP'); } })), UNKNOWN);
  for (const error of [Object.defineProperty({}, 'code', { get() { reads++; return 'HELD_RECORD_LEASE_LOST'; } }),
    Object.create(Object.defineProperty({}, 'code', { get() { reads++; throw code; } })),
    Object.create({ code: 'HELD_RECORD_LEASE_LOST' })]) assert.equal(safeReason(error), UNKNOWN);
  assert.equal(reads, 0);
  assert.equal(coercions, 0);
});

test('reflection trap failures are opaque even when their thrown values contain malicious codes', () => {
  let thrownCodeReads = 0, coercions = 0;
  const secret = 'SECRET_REFLECTION_VALUE';
  const secretCode = { [Symbol.toPrimitive]() { coercions++; return secret; }, toString() { coercions++; return secret; } };
  const throwingValues = [secret, null, { code: secret }, { code: secretCode },
    Object.defineProperty({}, 'code', { get() { thrownCodeReads++; return secret; } }),
    new Proxy({}, { get() { thrownCodeReads++; throw secret; }, getOwnPropertyDescriptor() { thrownCodeReads++; throw secret; } })];
  for (const thrown of throwingValues) {
    const error = new Proxy({}, { getOwnPropertyDescriptor() { throw thrown; } });
    assert.equal(safeReason(error), UNKNOWN);
  }
  const { proxy, revoke } = Proxy.revocable({}, {}); revoke();
  assert.equal(safeReason(proxy), UNKNOWN);
  assert.equal(thrownCodeReads, 0);
  assert.equal(coercions, 0);
});

test('entry reason extraction does not inspect prototypes, enumerate keys, or read error properties', () => {
  let traps = 0;
  const error = new Proxy({ code: 'HELD_RECORD_LEASE_LOST' }, {
    getPrototypeOf() { traps++; throw { code: 'SECRET_PROTOTYPE' }; },
    ownKeys() { traps++; throw { code: 'SECRET_KEYS' }; },
    get() { traps++; throw { code: 'SECRET_GET' }; },
  });
  assert.equal(safeReason(error), 'HELD_RECORD_LEASE_LOST');
  assert.equal(traps, 0);
});
