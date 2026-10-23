// The machine-readable failure table (resident quota redesign v0.6 + §9, phase 1): complete over every code the
// executor can see, consistent with the installed Source's catalogue, and decided by the most specific row.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { FAILURE_TABLE, failureRow, decideFailure, validateFailureTable, UNEXECUTED_REASON_RULES, NOT_ADMITTED_CODES, TRANSIENT_CODES, CLEAN_FINAL_CODES, UNKNOWN_CODES, DETERMINISTIC_REASON_CODES } from '../src/classify.mjs';
import { UNEXECUTED_REASONS } from '../src/ledger.mjs';
import { PUMP_CODES } from '../src/engine-windows.mjs';
import * as source from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-fact.mjs';
import { DETERMINISTIC_PR_REASONS, DETERMINISTIC_PR_REASON_CODES } from '../../actions-hosted-migration/independent-ci-v1/src/formal-work-admission-check-v2/publisher.mjs';
import { DIAGNOSTIC_CODES } from '../../actions-hosted-migration/independent-ci-v1/src/admission-facts-v2.mjs';
import { CLEAN_PROOF, WINDOWS_CLEAN } from './helpers.mjs';

// Every code the executor can be handed: the Source catalogue, the resident's own clean endings, the companion pump's
// codes and the engine's and executor's own refusals.
const RESIDENT_CODES = ['FULL_NEXT_STAGE_AUTHORITY_WINDOW_REQUIRED', 'FORMAL_CHILD_REFUSED_OR_UNKNOWN_ORIGINAL_STOPPED', 'FIXED_PUBLIC_CHILD_REFUSED', 'ACTUAL_ISSUE_NOT_PUBLISHED',
  'ISSUE_TRANSFER_UNCONFIRMED', 'FORMAL_BRIDGE_STAGE_DEADLINE', 'REFS_GATE_UNCONFIRMED', 'STAGE_TERMINAL_UNCONFIRMED', 'STAGE_INVOKER_TERMINAL_UNCONFIRMED', 'SCM_READBACK_NOT_ORIGINAL',
  'BETWEEN_ROLES_ARCHIVE_UNCONFIRMED', 'WORKSPACE_PREPARATION_UNCONFIRMED', 'EXECUTED_HEAD_RECORD_UNCONFIRMED', 'BUNDLE_UNAVAILABLE', 'OWNER_ABORTED', 'OWNER_ABORT_REQUESTED',
  'SUPERSEDED_AT_SAFE_POINT'];
const ALL = [...new Set([...source.ALL_STAGE_CODES, ...RESIDENT_CODES, ...PUMP_CODES])];
const rowsOf = code => FAILURE_TABLE.rows.filter(r => r.code === code);

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
  for (const r of FAILURE_TABLE.rows) assert.equal(r.retry === 'attempt2', TRANSIENT_CODES.includes(r.code), r.code);
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
  assert.deepEqual([...rowsOf('NATIVE_NOT_ADMITTED').find(r => r.reasonCodesAny).reasonCodesAny].sort(), [...DETERMINISTIC_PR_REASON_CODES].sort());
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
  assert.equal(row('GITHUB_TRANSIENT_UNAVAILABLE', 1).retry, 'attempt2');
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
  // a safe-to-re-run flag never releases a code whose row only burns (a transient at stage 1 keeps the attempt-2 path)
  assert.equal(decideFailure({ code: 'GITHUB_TRANSIENT_UNAVAILABLE', stage: 1, outcome: { ...safe, reason: 'github_http_503' }, proof: CLEAN_PROOF, started: false }).release, null);
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
