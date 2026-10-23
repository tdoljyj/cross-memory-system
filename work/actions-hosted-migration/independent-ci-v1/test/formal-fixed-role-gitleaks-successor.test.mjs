// Pure Source-v4 successor gates. These reports/observations never acquire an
// actual self-test, observation, qualification or signer capability.
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchJobsV2, subjectOfV2 } from '../src/job-v2.mjs';
import { REVIEWED_COMMITS, REVIEWED_HISTORY_PROOF, validateSelfTestReport, requiredScannerPlan } from '../worker/formal-gitleaks-v4/required-history/prepare.mjs';
import { REVIEWED_COMMITS as LEGACY_COMMITS } from '../worker/formal-gitleaks-v3/required-history/prepare.mjs';
import { validateCleanupObservation } from '../worker/formal-fixed-role-policy-v3/policy.mjs';
import { observationFacts } from '../worker/protected-job-bridge-v4/signed-result.mjs';
import { takeActualObservation } from '../worker/formal-gitleaks-v4/adapter.mjs';

const iso = ms => new Date(ms).toISOString();
function report() {
  return { exact_historical_fingerprints: 729, default_rules_unchanged: true, global_fingerprints: 0,
    commits: 101, files_at_commits: 172, verified_git_objects: 130, ignore_sha256: 'abbbece0db8ff3e524736006e0bc8ecf078358b48fae91c8d0bc3046728b8f5a',
    regression: { baseline_detection: true, exact_history_only: true, new_commit_detection: true, different_path_detection: true,
      scheduling_marker_new_commit_detection: true, scheduling_marker_different_path_detection: true, valid_private_key_detection: true,
      handover_acceptance_artifact_proof: { actual_git_artifact_passes: true, forged_digest_rejected: true, valid_nonancestor_rejected: true,
        wrong_line_rejected: true, wrong_path_rejected: true } } };
}
function execution() {
  const now = Date.now();
  const job = batchJobsV2({ repo: 'tdoljyj/cross-memory-system', pr: 920, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
    sourceManifestSha256: 'c'.repeat(64), createdAt: iso(now - 60000), attempt: 1 }).gitleaks;
  const observation = { contract: 'clued.independent-ci.formal-scanner-observation/2', domain: 'production-observation', fixture: false,
    formalEligible: false, qualificationIssued: false, checksWritten: false, subject: subjectOfV2(job), sourceManifestSha256: job.sourceManifestSha256,
    profile: 'required-gitleaks-history/1', sourceSha: 'd'.repeat(40), requiredHistoricalExceptions: 729, reviewedHistoryProof: { ...REVIEWED_HISTORY_PROOF }, startedAt: iso(now - 5000),
    finishedAt: iso(now - 1000), exitCode: 0, conclusion: 'success', logs: { stdout: { sha256: 'e'.repeat(64) }, stderr: { sha256: 'f'.repeat(64) } },
    cleanup: { complete: true, wholeContainerTreeStopped: true, containerRemoved: true, observedAt: iso(now - 500) } };
  return { job, observation, issue: { job, expiresAt: iso(now + 60000) }, now };
}

test('Source v4 has exactly 729 findings/101 commits; the legacy Source remains 726/100', () => {
  assert.deepEqual(REVIEWED_COMMITS, { findings: 729, commits: 101, sha256: '37fcdae7442b1235f75f2325c13e508a0189443a24e62627bf338fa8285488bf' });
  assert.deepEqual(LEGACY_COMMITS, { findings: 726, commits: 100, sha256: 'fcb2cc04ee35e01fbfc4bfc3dc9b0bb0ba78a6c4083ab5e17433c549450d59bb' });
});

test('the actual self-test must retain every old guard and prove new marker and valid-PEM detection', async () => {
  assert.doesNotThrow(() => validateSelfTestReport(report()));
  for (const edit of [r => r.exact_historical_fingerprints = 726, r => r.exact_historical_fingerprints = 730,
    r => r.global_fingerprints = 1, r => r.default_rules_unchanged = false, r => r.commits = 100,
    r => r.files_at_commits = 170, r => r.verified_git_objects = 131, r => r.ignore_sha256 = 'a'.repeat(64), r => r.extra = true]) {
    const value = report(); edit(value); assert.throws(() => validateSelfTestReport(value), { code: 'UNCHANGED_REVIEW_SELF_TEST_REQUIRED' });
  }
  for (const key of ['baseline_detection', 'exact_history_only', 'new_commit_detection', 'different_path_detection',
    'scheduling_marker_new_commit_detection', 'scheduling_marker_different_path_detection', 'valid_private_key_detection']) {
    for (const value of [false, undefined]) {
      const changed = report(); changed.regression[key] = value;
      assert.throws(() => validateSelfTestReport(changed), { code: 'UNCHANGED_REVIEW_SELF_TEST_REQUIRED' }, key);
    }
  }
  for (const key of Object.keys(report().regression.handover_acceptance_artifact_proof)) {
    const changed = report(); changed.regression.handover_acceptance_artifact_proof[key] = false;
    assert.throws(() => validateSelfTestReport(changed), { code: 'UNCHANGED_REVIEW_SELF_TEST_REQUIRED' }, key);
  }
  await assert.rejects(requiredScannerPlan({ contract: 'clued.independent-ci.required-gitleaks-input/2' }, report()),
    { code: 'ACTUAL_TRUSTED_SELF_TEST_OBSERVATION_REQUIRED' });
});

test('policy and result bridge agree on 729 and reject both legacy/mismatched counts and incomplete cleanup', () => {
  const { job, observation, issue, now } = execution();
  assert.equal(validateCleanupObservation(job, observation), observation);
  assert.equal(observationFacts(issue, observation, now).exitCode, 0);
  for (const count of [726, 728, 730, undefined]) {
    const changed = { ...observation, requiredHistoricalExceptions: count };
    assert.throws(() => validateCleanupObservation(job, changed), { code: 'ACTUAL_ROLE_CLEANUP_UNCONFIRMED' });
    assert.throws(() => observationFacts(issue, changed, now), { code: 'ACTUAL_HISTORY_CLEANUP_REQUIRED' });
  }
  for (const key of Object.keys(REVIEWED_HISTORY_PROOF)) {
    const changed = { ...observation, reviewedHistoryProof: { ...observation.reviewedHistoryProof, [key]: null } };
    assert.throws(() => validateCleanupObservation(job, changed), { code: 'ACTUAL_ROLE_CLEANUP_UNCONFIRMED' }, key);
    assert.throws(() => observationFacts(issue, changed, now), { code: 'ACTUAL_HISTORY_CLEANUP_REQUIRED' }, key);
  }
  const noProof = { ...observation }; delete noProof.reviewedHistoryProof;
  assert.throws(() => validateCleanupObservation(job, noProof), { code: 'ACTUAL_ROLE_CLEANUP_UNCONFIRMED' });
  assert.throws(() => observationFacts(issue, noProof, now), { code: 'ACTUAL_HISTORY_CLEANUP_REQUIRED' });
  for (const key of ['complete', 'wholeContainerTreeStopped', 'containerRemoved']) {
    const changed = { ...observation, cleanup: { ...observation.cleanup, [key]: false } };
    assert.throws(() => validateCleanupObservation(job, changed), { code: 'ACTUAL_ROLE_CLEANUP_UNCONFIRMED' });
    assert.throws(() => observationFacts(issue, changed, now), { code: 'ACTUAL_HISTORY_CLEANUP_REQUIRED' });
  }
  assert.throws(() => takeActualObservation(observation, job), { code: 'ACTUAL_PROTECTED_HISTORY_OBSERVATION_REQUIRED' });
});
