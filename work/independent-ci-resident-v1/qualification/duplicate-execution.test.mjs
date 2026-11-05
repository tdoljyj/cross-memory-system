import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDuplicateExecutions, EXECUTION_CONTRACT, NON_EXECUTION_CONTRACT } from './duplicate-execution.mjs';

const H = 'a'.repeat(40), SOURCE = 'b'.repeat(64);
let n = 0;
const proof = () => (++n).toString(16).padStart(64, '0');
function event(changes = {}) {
  return { contract: EXECUTION_CONTRACT, kind: 'scanner-started', repository: 'tdoljyj/cross-memory-system',
    headSha: H, role: 'gitleaks', sourceManifestSha256: SOURCE, provider: 'linux-worker', producerId: 'company-linux-01',
    executionId: 'worker-process-1', attempt: 1, eventAt: '2026-11-02T12:00:00Z', evidenceSha256: proof(), ...changes };
}
function nonExecution(kind) {
  return { contract: NON_EXECUTION_CONTRACT, kind, repository: 'tdoljyj/cross-memory-system', headSha: H,
    role: 'gitleaks', evidenceSha256: proof() };
}

test('start and terminal of one physical execution, plus repeated collection, count once', () => {
  const start = event(), terminal = event({ kind: 'scanner-terminal', eventAt: '2026-11-02T12:01:00Z' });
  const r = analyzeDuplicateExecutions([start, terminal, { ...start }]);
  assert.equal(r.classification, 'NO_DUPLICATE_OBSERVED');
  assert.equal(r.subjects[0].executionCount, 1);
  assert.equal(r.repeatedObservations, 1);
  assert.equal(r.liveQualified, false);
  assert.equal(r.globalCoverageConfirmed, false);
  assert.equal(r.evidenceAuthenticationPerformed, false);
  assert.equal(r.scope, 'SUPPLIED_OBSERVATIONS_ONLY');
});

test('hosted and native actual launches are duplicate even across Source and attempt', () => {
  const r = analyzeDuplicateExecutions([event(), event({ provider: 'github-actions', producerId: 'run-42', executionId: 'job-43',
    sourceManifestSha256: 'c'.repeat(64), attempt: 2 })]);
  assert.equal(r.classification, 'DUPLICATE_EXECUTION');
  assert.equal(r.duplicates[0].executionCount, 2);
});

test('rerun attempt of same job is a second actual execution', () => {
  assert.equal(analyzeDuplicateExecutions([event(), event({ attempt: 2 })]).classification, 'DUPLICATE_EXECUTION');
});

test('repository casing cannot split a duplicate group; different roles and heads remain distinct', () => {
  const r = analyzeDuplicateExecutions([event(), event({ repository: 'TDOLJYJ/CROSS-MEMORY-SYSTEM', executionId: 'worker-2' }),
    event({ role: 'trivy' }), event({ headSha: 'd'.repeat(40) })]);
  assert.equal(r.duplicates.length, 1);
  assert.equal(r.subjects.length, 3);
});

test('admission, gate, relay publication and check-status are not scanner execution', () => {
  const r = analyzeDuplicateExecutions(['admission', 'gate-publication', 'relay-publication', 'check-status'].map(nonExecution));
  assert.equal(r.ignoredNonExecution, 4);
  assert.equal(r.classification, 'INSUFFICIENT_EVIDENCE');
  assert.equal(r.subjects.length, 0);
});

test('missing, malformed or arbitrary check-name records cannot become PASS', () => {
  for (const rows of [[], [null], [event({ checkName: 'gitleaks' })], [event({ kind: 'check-status' })],
    [event({ evidenceSha256: 'not-a-proof' })], [event({ attempt: 0 })], [event({ eventAt: 'yesterday' })],
    [event({ producerId: 123 })], [event({ executionId: 123 })], [event({ eventAt: '2026-02-30T12:00:00Z' })]]) {
    const r = analyzeDuplicateExecutions(rows);
    assert.equal(r.classification, 'INSUFFICIENT_EVIDENCE');
    assert.equal(r.evidenceIncomplete, true);
    assert.equal(r.liveQualified, false);
  }
});

test('terminal-only evidence cannot certify completeness but two distinct terminal receipts still alarm', () => {
  const a = event({ kind: 'scanner-terminal' });
  const b = event({ kind: 'scanner-terminal', executionId: 'other-worker' });
  assert.equal(analyzeDuplicateExecutions([a]).classification, 'INSUFFICIENT_EVIDENCE');
  const r = analyzeDuplicateExecutions([a, b]);
  assert.equal(r.classification, 'DUPLICATE_EXECUTION');
  assert.equal(r.evidenceIncomplete, true);
  assert.ok(r.reasons.includes('START_RECEIPT_MISSING'));
});

test('conflicting reuse of proof id, execution event or Source is insufficient, not silently merged', () => {
  const a = event();
  assert.ok(analyzeDuplicateExecutions([a, { ...a, executionId: 'other' }]).reasons.includes('PROOF_ID_CONFLICT'));
  assert.ok(analyzeDuplicateExecutions([a, event({ eventAt: '2026-11-02T12:00:01Z' })]).reasons.includes('EXECUTION_EVENT_CONFLICT'));
  const r = analyzeDuplicateExecutions([a, event({ kind: 'scanner-terminal', sourceManifestSha256: 'c'.repeat(64) })]);
  assert.ok(r.reasons.includes('EXECUTION_SOURCE_CONFLICT'));
  assert.equal(r.classification, 'INSUFFICIENT_EVIDENCE');
});

test('terminal before start is an evidence error', () => {
  const r = analyzeDuplicateExecutions([event(), event({ kind: 'scanner-terminal', eventAt: '2026-11-02T11:59:59Z' })]);
  assert.equal(r.classification, 'INSUFFICIENT_EVIDENCE');
  assert.ok(r.reasons.includes('TERMINAL_PRECEDES_START'));
});

test('accessors, coercible objects, symbols and sparse/accessor arrays are not evaluated', () => {
  let touched = 0;
  const getter = event(); Object.defineProperty(getter, 'executionId', { enumerable: true, get() { touched++; return 'secret'; } });
  const coercible = event({ executionId: { toString() { touched++; return 'secret'; } } });
  const symbolic = event(); symbolic[Symbol('secret')] = 'secret';
  const array = []; Object.defineProperty(array, '0', { enumerable: true, get() { touched++; return event(); } });
  for (const rows of [[getter], [coercible], [symbolic], array, Array(1)]) {
    assert.equal(analyzeDuplicateExecutions(rows).classification, 'INSUFFICIENT_EVIDENCE');
  }
  assert.equal(touched, 0);
});

test('report is deterministic and includes hashes, not execution identifiers or unallowlisted secrets', () => {
  const a = event(), b = event({ executionId: 'worker-2' });
  const first = analyzeDuplicateExecutions([a, b]), second = analyzeDuplicateExecutions([b, a]);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first).includes('worker-process-1'), false);
  const refused = analyzeDuplicateExecutions([event({ secret: 'ghp_example_do_not_emit' })]);
  assert.equal(JSON.stringify(refused).includes('ghp_example'), false);
});

test('oversized input and unexpected array properties fail boundedly', () => {
  assert.deepEqual(analyzeDuplicateExecutions(Array(10_001)).reasons, ['OBSERVATIONS_BOUND']);
  const values = []; values.extra = 'unsafe';
  assert.deepEqual(analyzeDuplicateExecutions(values).reasons, ['OBSERVATIONS_FIELDS']);
});

test('Proxy reflection failures cannot disclose or evaluate arbitrary thrown code properties', () => {
  let touched = 0;
  const secret = 'SECRET_PROXY_ERROR_MUST_NOT_APPEAR';
  const thrownValues = [
    { code: secret },
    { code: { toString() { touched++; return secret; }, toJSON() { touched++; return secret; } } },
    Object.defineProperty({}, 'code', { get() { touched++; return secret; } }),
    new Proxy({}, { get() { touched++; return secret; }, getPrototypeOf() { touched++; return null; } }),
    secret,
    null,
  ];
  for (const thrown of thrownValues) {
    for (const trap of ['ownKeys', 'getPrototypeOf']) {
      const row = new Proxy(event(), { [trap]() { throw thrown; } });
      const r = analyzeDuplicateExecutions([row]);
      assert.deepEqual(r.reasons, ['OBSERVATION_REFUSED']);
      assert.equal(r.classification, 'INSUFFICIENT_EVIDENCE');
      assert.equal(JSON.stringify(r).includes(secret), false);
    }
    const array = new Proxy([], { ownKeys() { throw thrown; } });
    const r = analyzeDuplicateExecutions(array);
    assert.deepEqual(r.reasons, ['OBSERVATIONS_REFUSED']);
    assert.equal(JSON.stringify(r).includes(secret), false);
  }
  assert.equal(touched, 0, 'no thrown-value code getter, coercion, serialization or Proxy trap is invoked');
});
