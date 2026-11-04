// The machine-readable failure table (resident quota redesign v0.6 + §9, phase 1): complete over every code the
// executor can see, consistent with the installed Source's catalogue, and decided by the most specific row.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { FAILURE_TABLE, failureRow, decideFailure, validateFailureTable, UNEXECUTED_REASON_RULES, NOT_ADMITTED_CODES, TRANSIENT_CODES, CLEAN_FINAL_CODES, UNKNOWN_CODES, DETERMINISTIC_REASON_CODES, STAGE1_TRANSIENT_RELEASE_CODES } from '../src/classify.mjs';
import { UNEXECUTED_REASONS } from '../src/ledger.mjs';
import { PUMP_CODES } from '../src/engine-windows.mjs';
import * as source from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-fact.mjs';
import { DETERMINISTIC_PR_REASONS, DETERMINISTIC_PR_REASON_CODES, deterministicPrFault, refusalSafeToRerun } from '../../actions-hosted-migration/independent-ci-v1/src/formal-work-admission-check-v2/publisher.mjs';
import { writeOutcome } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-inputs.mjs';
import { DIAGNOSTIC_CODES } from '../../actions-hosted-migration/independent-ci-v1/src/admission-facts-v2.mjs';
import { CLEAN_PROOF, WINDOWS_CLEAN, tempRoot } from './helpers.mjs';
import { ATTEMPT2_RESIDENT_CODES, attempt2Decision } from '../src/attempts.mjs';

// Every code the executor can be handed: the Source catalogue, the resident's own clean endings, the companion pump's
// codes and the engine's and executor's own refusals.
const RESIDENT_CODES = ['FULL_NEXT_STAGE_AUTHORITY_WINDOW_REQUIRED', 'FORMAL_CHILD_REFUSED_OR_UNKNOWN_ORIGINAL_STOPPED', 'FIXED_PUBLIC_CHILD_REFUSED', 'ACTUAL_ISSUE_NOT_PUBLISHED',
  'ISSUE_TRANSFER_UNCONFIRMED', 'FORMAL_BRIDGE_STAGE_DEADLINE', 'REFS_GATE_UNCONFIRMED', 'STAGE_TERMINAL_UNCONFIRMED', 'STAGE_INVOKER_TERMINAL_UNCONFIRMED', 'SCM_READBACK_NOT_ORIGINAL',
  'BETWEEN_ROLES_ARCHIVE_UNCONFIRMED', 'WORKSPACE_PREPARATION_UNCONFIRMED', 'EXECUTED_HEAD_RECORD_UNCONFIRMED', 'BUNDLE_UNAVAILABLE', 'OWNER_ABORTED', 'OWNER_ABORT_REQUESTED',
  'SUPERSEDED_AT_SAFE_POINT',
  // DESIGN §26, §27: the bridge stop's stage code and the abandonment's terminal code (resident-side, never Source-mirrored)
  'BRIDGE_STAGE_STOPPED_PUMP_LOST', 'BRIDGE_ABANDONED_UNPUBLISHED',
  // DESIGN §32: the pre-stage memory gate's refusal (resident-side, never Source-mirrored)
  'LINUX_MEMORY_NOT_READY',
  // DESIGN §34: the engine's version gate before the first Linux stage (resident-side, never Source-mirrored)
  'UPGRADE_VERSION_SKEW'];
const ALL = [...new Set([...source.ALL_STAGE_CODES, ...RESIDENT_CODES, ...PUMP_CODES])];
const rowsOf = code => FAILURE_TABLE.rows.filter(r => r.code === code);

test('explicit claim-observation exhaustion is transient only before a possible write; publishing stages still cannot rerun a batch', () => {
  const clean = { status: 'BLOCKED', reason: 'native_claim_observation_unavailable', sideEffects: 0, mayHavePublished: false };
  for (const stage of [3, 5, 7, 9]) {
    const code = source.outcomeFailureCode(clean, stage);
    assert.equal(code, 'NATIVE_ADMISSION_UNAVAILABLE');
    const decision = decideFailure({ code, stage, outcome: clean, proof: CLEAN_PROOF, started: true });
    assert.deepEqual([decision.klass, decision.row.class, decision.row.retry, decision.release], ['CLEAN', 'transient', 'attempt2', null]);
    assert.deepEqual(attempt2Decision({ policy: { automaticAttempt2: { enabled: true } }, subject: { attempt: 1 }, outcome: 'FAILED_CLEAN',
      failure: { code, stageNumber: stage, relayedRoles: 0 } }), { eligible: false, reason: 'ATTEMPT2_ROLE_MAY_BE_PUBLISHED' });
    for (const field of ['windowsTreeZero', 'serviceOriginalStopped', 'linuxUnitsInactive', 'containersZero']) {
      assert.equal(decideFailure({ code, stage, outcome: clean, proof: { ...CLEAN_PROOF, [field]: false }, started: true }).klass, 'UNKNOWN', field);
    }
    for (const [patch, expected] of [
      [{ sideEffects: 1 }, 'PUBLICATION_UNCERTAIN'], [{ mayHavePublished: true }, 'PUBLICATION_UNCERTAIN'],
      [{ mayHavePublished: undefined }, 'PUBLICATION_UNCERTAIN'], [{ status: 'UNCERTAIN' }, 'PUBLICATION_UNCERTAIN'],
      [{ status: 'RECONCILIATION_REQUIRED' }, 'RECONCILIATION_REQUIRED'], [{ status: 'REVOKED' }, 'PUBLICATION_REVOKED']]) {
      const outcome = { ...clean, ...patch }, mapped = source.outcomeFailureCode(outcome, stage);
      assert.equal(mapped, expected);
      assert.ok(!TRANSIENT_CODES.includes(mapped));
    }
    for (const reason of ['native_claim_observation_refused', 'native_claim_observation_unconfirmed']) {
      const outcome = { ...clean, reason }, mapped = source.outcomeFailureCode(outcome, stage);
      assert.equal(mapped, 'PUBLICATION_BLOCKED');
      assert.deepEqual([decideFailure({ code: mapped, stage, outcome, proof: CLEAN_PROOF, started: true }).row.class,
        failureRow({ code: mapped, stage, reason }).retry], ['clean-final', 'new-commit']);
    }
  }
});

test('the table validates, and every code the executor can be handed has a row for every stage (or its phase)', async () => {
  assert.equal(FAILURE_TABLE.contract, 'clued.independent-ci.resident-failure-table/1');
  for (const code of ALL) {
    assert.ok(rowsOf(code).length > 0, code);
    if (code === 'BUNDLE_UNAVAILABLE') { assert.ok(failureRow({ code, stage: 0, phase: 'bundle' }), code); continue; }
    for (const stage of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) assert.ok(failureRow({ code, stage }), `${code}@${stage}`);
  }
  // a code nobody lists has no row: unknown, HALT
  assert.equal(failureRow({ code: 'SOMETHING_NEW', stage: 1 }), null);
  assert.equal(decideFailure({ code: 'SOMETHING_NEW', stage: 1, proof: CLEAN_PROOF, started: false }).klass, 'UNKNOWN');
  // the committed file is the table (no second copy anywhere)
  const raw = JSON.parse(await fs.readFile(new URL('../src/failure-table.json', import.meta.url), 'utf8'));
  assert.deepEqual(raw.rows.map(r => r.code), FAILURE_TABLE.rows.map(r => r.code));
});

test('the table agrees with the Source catalogue: unknown halts, the rest never does; attempt 2 exactly for the transient codes', () => {
  for (const code of UNKNOWN_CODES) for (const r of rowsOf(code)) assert.deepEqual([r.class, r.disposition, r.retry], ['unknown', 'halt', 'owner-rearm'], code);
  for (const code of [...NOT_ADMITTED_CODES, ...TRANSIENT_CODES, ...CLEAN_FINAL_CODES]) for (const r of rowsOf(code)) assert.notEqual(r.disposition, 'halt', code);
  // besides, a resident code of ATTEMPT2_RESIDENT_CODES on a row of exactly its stages (Owner decision eaa7d5e4, DESIGN §27)
  // (DESIGN 49: except the stage-1 rows of GITHUB_TRANSIENT_UNAVAILABLE and NATIVE_ADMISSION_UNAVAILABLE, which release on the entry's own safeToRerun)
  const stage1Release = r => STAGE1_TRANSIENT_RELEASE_CODES.includes(r.code) && JSON.stringify(r.stages) === '[1]' && r.disposition === 'release-if-safe' && r.retry === 'new-trigger';
  for (const r of FAILURE_TABLE.rows) assert.equal(r.retry === 'attempt2', (TRANSIENT_CODES.includes(r.code) && !stage1Release(r)) || (Object.hasOwn(ATTEMPT2_RESIDENT_CODES, r.code)
    && Array.isArray(r.stages) && r.stages.every(s => ATTEMPT2_RESIDENT_CODES[r.code].includes(s))), r.code);
  // releases only before 10-started: stage 1, or the bundle before it
  for (const r of FAILURE_TABLE.rows.filter(x => x.disposition.startsWith('release'))) assert.ok(Array.isArray(r.stages) && r.stages.every(s => s <= 1), r.code);
  // the validator refuses a table that breaks these rules
  const bad = structuredClone(FAILURE_TABLE);
  bad.rows.push({ code: 'GITHUB_TRANSIENT_UNAVAILABLE', stages: [3], class: 'transient', disposition: 'release', retry: 'attempt2', breaker: 'counts', note: 'x' });
  assert.throws(() => validateFailureTable(bad), { code: 'FAILURE_TABLE_INVALID' });
  const halt = structuredClone(FAILURE_TABLE);
  halt.rows[0] = { ...halt.rows[0], disposition: 'halt' };
  assert.throws(() => validateFailureTable(halt), { code: 'FAILURE_TABLE_INVALID' });
});

test('deterministic PR faults mirror the Source and always burn, also with a (forged) safe-to-re-run flag', () => {
  const stageChildRefused = rowsOf('STAGE_CHILD_REFUSED').find(r => r.reasons);
  // the reasons that reach the executor as STAGE_CHILD_REFUSED (the two full_admission_* ones map to their own codes)
  assert.deepEqual([...stageChildRefused.reasons].sort(), DETERMINISTIC_PR_REASONS.filter(r => !r.startsWith('full_admission_')).sort());
  assert.equal(source.outcomeFailureCode({ status: 'BLOCKED', reason: 'full_admission_subject_changed', sideEffects: 0, mayHavePublished: false }, 1), 'PR_NOT_OPEN_OR_CHANGED');
  assert.equal(source.outcomeFailureCode({ status: 'BLOCKED', reason: 'full_admission_subject_invalid', sideEffects: 0, mayHavePublished: false }, 1), 'ADMISSION_CONFIGURATION_REFUSED');
  assert.deepEqual([...rowsOf('NATIVE_NOT_ADMITTED').find(r => r.class === 'deterministic-pr' && r.reasonCodesAny).reasonCodesAny].sort(), [...DETERMINISTIC_PR_REASON_CODES].sort());
  const forged = { status: 'BLOCKED', reason: 'pr_files_page_limit', sideEffects: 0, mayHavePublished: false, safeToRerun: true, diagnostic: null };
  const d = decideFailure({ code: 'STAGE_CHILD_REFUSED', stage: 1, outcome: forged, proof: CLEAN_PROOF, started: false });
  assert.deepEqual([d.row.class, d.release, d.klass], ['deterministic-pr', null, 'CLEAN']);
  for (const code of ['PR_NOT_OPEN_OR_CHANGED', 'PROTECTED_CHANGE_NOT_UP_TO_DATE']) {
    assert.equal(decideFailure({ code, stage: 1, outcome: { ...forged, reason: 'full_admission_rejected' }, proof: CLEAN_PROOF, started: false }).release, null, code);
  }
  const truncated = decideFailure({ code: 'NATIVE_NOT_ADMITTED', stage: 1, outcome: { ...forged, reason: 'full_admission_rejected', diagnostic: { reasonCodes: ['changed_files_truncated', 'merge_slot_required'], nativeReasonCodes: [] } },
    proof: CLEAN_PROOF, started: false });
  assert.deepEqual([truncated.row.class, truncated.release], ['deterministic-pr', null]);
  // a waiting code reduced from a diagnostic that also says "not up to date": burned (the resident's own guard)
  const stale = decideFailure({ code: 'OWNER_REVIEW_REQUIRED', stage: 1, outcome: { ...forged, reason: 'full_admission_rejected',
    diagnostic: { reasonCodes: ['owner_review_required', 'protected_change_not_up_to_date'], nativeReasonCodes: [] } }, proof: CLEAN_PROOF, started: false });
  assert.deepEqual([stale.row.class, stale.row.retry, stale.release, stale.klass], ['deterministic-pr', 'new-commit', null, 'CLEAN'], 'recorded as what decided it');
  assert.deepEqual([...DETERMINISTIC_REASON_CODES].sort(), [...DETERMINISTIC_PR_REASON_CODES].sort());
});

test('every Native reason code is placed: a named code, deterministic, a named not-admitted reason, or unmapped (burned)', () => {
  const named = DIAGNOSTIC_CODES.filter(c => source.notAdmittedCode({ reasonCodes: [c] }) !== 'NATIVE_NOT_ADMITTED');
  const rows = rowsOf('NATIVE_NOT_ADMITTED').filter(r => Array.isArray(r.stages));
  const within = rows.find(r => r.class === 'not-admitted').reasonCodesWithin;
  const placed = new Set([...named, ...DETERMINISTIC_REASON_CODES, ...within]);
  assert.deepEqual(DIAGNOSTIC_CODES.filter(c => !placed.has(c)), ['unknown_reason']);
  assert.ok(rows.find(r => r.class === 'waiting').reasonCodesWithin.every(c => within.includes(c)), 'the waiting reasons are named not-admitted reasons too');
  const decide = codes => decideFailure({ code: 'NATIVE_NOT_ADMITTED', stage: 1, outcome: { status: 'BLOCKED', reason: 'full_admission_rejected', sideEffects: 0, mayHavePublished: false, safeToRerun: true,
    diagnostic: { reasonCodes: codes, nativeReasonCodes: [] } }, proof: CLEAN_PROOF, started: false });
  for (const codes of [[], ['unknown_reason'], ['workflow_gate', 'unknown_reason']]) {
    const d = decide(codes);
    assert.deepEqual([d.row.class, d.row.breaker, d.release], ['unmapped-stage-1', 'counts', null], JSON.stringify(codes));
  }
  assert.deepEqual([decide(['workflow_gate']).row.class, decide(['workflow_gate']).release], ['not-admitted', 'NOT_ADMITTED']);
  assert.deepEqual([decide(['merge_slot_required']).row.class, decide(['merge_slot_required']).release], ['waiting', 'NOT_ADMITTED']);
});

test('the most specific row wins: waiting only when every reason is a wait; an unmapped stage-1 reason burns and counts', () => {
  const row = (code, stage, o = {}) => failureRow({ code, stage, ...o });
  assert.equal(row('NATIVE_NOT_ADMITTED', 1, { diagnostic: { reasonCodes: ['merge_slot_required'], nativeReasonCodes: ['evaluation_not_completed'] } }).class, 'waiting');
  assert.equal(row('NATIVE_NOT_ADMITTED', 1, { diagnostic: { reasonCodes: ['merge_slot_required', 'workflow_gate'] } }).class, 'not-admitted');
  // no reason code at all, or an unknown one: unmapped, burned (v0.6 §1; independent review of phase 1, MINOR 2)
  assert.equal(row('NATIVE_NOT_ADMITTED', 1, { diagnostic: { reasonCodes: [] } }).class, 'unmapped-stage-1');
  assert.equal(row('NATIVE_NOT_ADMITTED', 1, { diagnostic: { reasonCodes: ['unknown_reason'] } }).class, 'unmapped-stage-1');
  assert.equal(row('NATIVE_NOT_ADMITTED', 3).class, 'clean-final');
  for (const code of ['OWNER_REVIEW_REQUIRED', 'TASK_CI_HEAD_CAP_REACHED']) assert.equal(row(code, 1).class, 'waiting', code);
  const unmapped = row('STAGE_CHILD_REFUSED', 1, { reason: 'BATCH_CLAIM_RECORD_INVALID' });
  assert.deepEqual([unmapped.class, unmapped.disposition, unmapped.breaker], ['unmapped-stage-1', 'burn', 'counts']);
  assert.equal(row('STAGE_CHILD_REFUSED', 2, { reason: 'pr_files_page_limit' }).class, 'clean-final', 'the reason rows are stage 1 only');
  // DESIGN 49 (Owner decision 4f5f35d3): stage 1 releases a passing GitHub / Native fault on the entry's own safeToRerun; the other stages keep attempt 2
  for (const code of ['GITHUB_TRANSIENT_UNAVAILABLE', 'NATIVE_ADMISSION_UNAVAILABLE']) {
    assert.deepEqual([row(code, 1).class, row(code, 1).disposition, row(code, 1).retry], ['environment', 'release-if-safe', 'new-trigger'], code);
    for (const stage of [0, 2, 3, 5, 7, 8]) assert.equal(row(code, stage).retry, 'attempt2', `${code}@${stage}`);
  }
  assert.equal(row('BUNDLE_UNAVAILABLE', 0, { phase: 'bundle' }).disposition, 'release');
  assert.equal(row('BUNDLE_UNAVAILABLE', 0, { phase: 'stage' }), null);
});

test('a release needs the outcome\'s own safeToRerun or the broker\'s no-launch, the Windows proof, and no 10-started', () => {
  const safe = { status: 'BLOCKED', reason: 'full_admission_rejected', sideEffects: 0, mayHavePublished: false, safeToRerun: true, diagnostic: { reasonCodes: ['owner_grant_required'], nativeReasonCodes: [] } };
  const d = (o) => decideFailure({ code: 'OWNER_REVIEW_REQUIRED', stage: 1, outcome: safe, proof: WINDOWS_CLEAN, started: false, ...o });
  assert.deepEqual([d().release, d().klass], ['NOT_ADMITTED', 'NOT_ADMITTED']);
  // no flag: burned (clean only with the full two-host proof), never released by inference from the code
  assert.deepEqual([d({ outcome: { ...safe, safeToRerun: false } }).release, d({ outcome: { ...safe, safeToRerun: false } }).klass], [null, 'UNKNOWN']);
  assert.deepEqual([d({ outcome: null, proof: CLEAN_PROOF }).release, d({ outcome: null, proof: CLEAN_PROOF }).klass], [null, 'CLEAN']);
  assert.equal(d({ started: true, proof: CLEAN_PROOF }).release, null, 'after 10-started nothing is released');
  assert.equal(d({ proof: { windowsTreeZero: true } }).release, null, 'the runner must read back as the original');
  // the broker's "no launch, original restored" answer at stage 1
  const b = decideFailure({ code: 'BROKER_REQUEST_EXPIRED', stage: 1, outcome: null, brokerNoLaunch: true, proof: WINDOWS_CLEAN, started: false });
  assert.deepEqual([b.release, b.row.class], ['BROKER_NOT_LAUNCHED', 'environment']);
  assert.equal(decideFailure({ code: 'BROKER_REQUEST_EXPIRED', stage: 3, brokerNoLaunch: true, proof: CLEAN_PROOF, started: false }).release, null, 'stage 1 only');
  assert.equal(decideFailure({ code: 'BROKER_BUSY', stage: 1, brokerNoLaunch: true, proof: CLEAN_PROOF, started: false }).klass, 'UNKNOWN');
  // a safe-to-re-run flag never releases a code whose row only burns (a transient after stage 1 keeps the attempt-2 path)
  assert.equal(decideFailure({ code: 'GITHUB_TRANSIENT_UNAVAILABLE', stage: 3, outcome: { ...safe, reason: 'github_http_503' }, proof: CLEAN_PROOF, started: false }).release, null);
  // ... but at stage 1 (DESIGN 49) a passing GitHub / Native fault with the flag is released, not burned into attempt 2; without the flag it still burns (attempt 2)
  for (const code of ['GITHUB_TRANSIENT_UNAVAILABLE', 'NATIVE_ADMISSION_UNAVAILABLE']) {
    const o = { ...safe, reason: 'github_http_503', diagnostic: null };
    assert.deepEqual([decideFailure({ code, stage: 1, outcome: o, proof: WINDOWS_CLEAN, started: false }).release, decideFailure({ code, stage: 1, outcome: o, proof: WINDOWS_CLEAN, started: false }).klass], ['NOT_ADMITTED', 'NOT_ADMITTED'], code);
    const unflagged = decideFailure({ code, stage: 1, outcome: { ...o, safeToRerun: false }, proof: CLEAN_PROOF, started: false });
    assert.deepEqual([unflagged.release, unflagged.klass], [null, 'CLEAN'], code);
    assert.equal(decideFailure({ code, stage: 1, outcome: o, proof: WINDOWS_CLEAN, started: true }).release, null, 'after 10-started nothing is released');
  }
});

test('NODE_ROLE_NOT_HELD (C3, DESIGN §29): a stage-1 node-role row released on the entry\'s own flag, also beside a deterministic PR reason; the older Source\'s reason form is the same answer', async t => {
  const root = await tempRoot(t);
  let n = 0;
  // A stage-1 refusal as the entry really writes it: the publisher's own flag (refusalSafeToRerun; `old` is the publisher before
  // C3, whose flag was false beside any deterministic reason), then the entry's outcome record and the stage fact's view of it.
  const real = async (reasonCodes, { old = false, flag = undefined } = {}) => {
    const diagnostic = { reasonCodes };
    const safeToRerun = flag ?? (old ? !deterministicPrFault('full_admission_rejected', diagnostic)
      : refusalSafeToRerun({ step: 'boundary', claimed: null, reason: 'full_admission_rejected', diagnostic }));
    const written = await writeOutcome({ receiptsRoot: root, nonce: String(++n).padStart(32, '0'), plan: { stage: 1, entryRole: 'work-admission' }, jobIds: [],
      result: { status: 'BLOCKED', reason: 'full_admission_rejected', sideEffects: 0, admissionDiagnostic: diagnostic, safeToRerun } });
    return { code: source.outcomeFailureCode(written, 1), outcome: source.outcomeFacts(written) };
  };
  const row = failureRow({ code: 'NODE_ROLE_NOT_HELD', stage: 1 });
  assert.deepEqual([row.class, row.disposition, row.retry, row.breaker], ['node-role', 'release-if-safe', 'new-trigger', 'neutral']);
  assert.deepEqual(rowsOf('NODE_ROLE_NOT_HELD').map(r => r.stages), [[1], 'any']);
  assert.equal(failureRow({ code: 'NODE_ROLE_NOT_HELD', stage: 3 }).class, 'clean-final', 'never produced after stage 1');
  assert.ok(NOT_ADMITTED_CODES.includes('NODE_ROLE_NOT_HELD'));
  const decide = (x, o = {}) => decideFailure({ code: x.code, stage: 1, outcome: x.outcome, proof: WINDOWS_CLEAN, started: false, ...o });
  // the Source names it from the reason alone, before every other reason, and its flag stays true beside a deterministic one
  // (the 2026-10-29 review: it was false there, so the head was burned)
  for (const reasonCodes of [['admission_binding_required'], ['admission_binding_required', 'protected_change_not_up_to_date'], ['changed_files_truncated', 'admission_binding_required'],
    ['policy_file_removed', 'admission_binding_required', 'owner_review_required'], ['policy_file_invalid', 'admission_binding_required']]) {
    const x = await real(reasonCodes);
    assert.deepEqual([x.code, x.outcome.safeToRerun], ['NODE_ROLE_NOT_HELD', true], reasonCodes.join());
    const d = decide(x);
    assert.deepEqual([d.row.class, d.release, d.klass, d.row.breaker], ['node-role', 'NOT_ADMITTED', 'NOT_ADMITTED', 'neutral'], reasonCodes.join());
  }
  // never released by inference from the code: without the entry's flag it burns like any other stage-1 answer
  const noFlag = await real(['admission_binding_required'], { flag: false });
  const burned = decide(noFlag, { proof: CLEAN_PROOF });
  assert.deepEqual([burned.row.class, burned.release, burned.klass], ['node-role', null, 'CLEAN']);
  assert.equal(decide(await real(['admission_binding_required']), { started: true, proof: CLEAN_PROOF }).release, null, 'after 10-started nothing is released');
  // a deterministic reason WITHOUT the role reason stays unsafe to re-run: burned, as before
  const stale = await real(['owner_review_required', 'protected_change_not_up_to_date']);
  assert.deepEqual([stale.outcome.safeToRerun, decide(stale, { proof: CLEAN_PROOF }).release, decide(stale, { proof: CLEAN_PROOF }).row.class], [false, null, 'deterministic-pr']);
  // The older Source: NATIVE_NOT_ADMITTED + the reason. Its publisher's flag is true for the reason alone, so it is the same answer
  // (released, STANDBY); beside a deterministic reason its flag is false, so the head is burned as it was before C3, and the
  // table still calls it node-role (the node is not on duty, whatever happened to the head)
  const oldPlain = await real(['admission_binding_required'], { old: true });
  assert.deepEqual([oldPlain.code, oldPlain.outcome.safeToRerun], ['NODE_ROLE_NOT_HELD', true], 'a fixture of the new mapping; the older Source says NATIVE_NOT_ADMITTED:');
  const asOld = x => ({ ...x, code: 'NATIVE_NOT_ADMITTED' });
  const od = decide(asOld(oldPlain));
  assert.deepEqual([od.row.class, od.release, od.klass], ['node-role', 'NOT_ADMITTED', 'NOT_ADMITTED']);
  const oldMixed = await real(['admission_binding_required', 'protected_change_not_up_to_date'], { old: true });
  assert.equal(oldMixed.outcome.safeToRerun, false, 'the older publisher');
  const om = decide(asOld(oldMixed), { proof: CLEAN_PROOF });
  assert.deepEqual([om.row.class, om.release, om.klass], ['node-role', null, 'CLEAN']);
  // without the role reason the older code keeps its own answers
  assert.equal(failureRow({ code: 'NATIVE_NOT_ADMITTED', stage: 1, diagnostic: { reasonCodes: ['binding_not_authorized'] } }).class, 'not-admitted');
  assert.equal(failureRow({ code: 'NATIVE_NOT_ADMITTED', stage: 1, diagnostic: { reasonCodes: ['protected_change_not_up_to_date'] } }).class, 'deterministic-pr');
});

test('every release reason is registered with its cool-down and the budget that bounds it (v0.6 §7 minor 6; phase 2)', () => {
  assert.deepEqual(Object.keys(UNEXECUTED_REASON_RULES).sort(), [...UNEXECUTED_REASONS].sort());
  for (const [reason, rule] of Object.entries(UNEXECUTED_REASON_RULES)) {
    assert.equal(rule.cooldown, reason !== 'SUPERSEDED', reason);
    assert.ok([null, 'waitingRetriesPer24h', 'releasesPerHeadPer24h'].includes(rule.cap.waiting) && [null, 'releasesPerHeadPer24h'].includes(rule.cap.other), reason);
  }
  assert.deepEqual(UNEXECUTED_REASON_RULES.NOT_ADMITTED.cap, { waiting: 'waitingRetriesPer24h', other: 'releasesPerHeadPer24h' });
  assert.deepEqual(UNEXECUTED_REASON_RULES.SUPERSEDED.cap, { waiting: null, other: null });
});
