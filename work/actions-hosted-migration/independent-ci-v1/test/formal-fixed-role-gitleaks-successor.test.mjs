// Pure Source-v4 successor gates. These reports/observations never acquire an
// actual self-test, observation, qualification or signer capability.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { batchJobsV2, subjectOfV2 } from '../src/job-v2.mjs';
import { REVIEWED_COMMITS, REVIEWED_HISTORY_PROOF, validateSelfTestReport, requiredScannerPlan } from '../worker/formal-gitleaks-v4/required-history/prepare.mjs';
import { REVIEWED_COMMITS as LEGACY_COMMITS } from '../worker/formal-gitleaks-v3/required-history/prepare.mjs';
import { validateCleanupObservation } from '../worker/formal-fixed-role-policy-v3/policy.mjs';
import { observationFacts } from '../worker/protected-job-bridge-v4/signed-result.mjs';
import { takeActualObservation } from '../worker/formal-gitleaks-v4/adapter.mjs';

const iso = ms => new Date(ms).toISOString();
// Evaluate only the pinned Python helper's real report/return expressions, not
// its scanner/Git side effects. This is a wire-schema fixture, never detection
// evidence. New producer fields cannot silently disappear in a hand-built JS mock.
const helperReport = (() => {
  const script = String.raw`import ast,hashlib,json,pathlib,sys
tree=ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
functions={node.name:node for node in tree.body if isinstance(node,ast.FunctionDef)}
def returned(name):
 return next(node.value for node in reversed(functions[name].body) if isinstance(node,ast.Return))
artifact=ast.literal_eval(returned('_self_test_handover_acceptance'))
records=[json.loads(line[len('# clued-reviewed-finding: '):]) for line in pathlib.Path(sys.argv[2]).read_text(encoding='utf-8').splitlines() if line.startswith('# clued-reviewed-finding: ')]
content=''.join(record['fingerprint']+'\n' for record in records)
proof={'commits':len({r['fingerprint'].split(':')[0] for r in records}),'files_at_commits':len({':'.join(r['fingerprint'].split(':')[:2]) for r in records}),'verified_git_objects':int(sys.argv[3])}
scope={'str':str,'len':len,'hashlib':hashlib,'records':records,'proof':proof,'content':content,'test_repo':pathlib.PurePosixPath('/controlled-helper-return/repo'),'root':pathlib.PurePosixPath('/controlled-helper-return'),'_self_test_handover_acceptance':lambda root:artifact}
def evaluate(value):
 return eval(compile(ast.Expression(value),'pinned-helper-return','eval'),{'__builtins__':{}},scope)
regression=evaluate(returned('self_test'))
constructor=next(node.value for node in functions['main'].body if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='report' for t in node.targets))
report=evaluate(constructor)
report['regression']=regression
print(json.dumps(report))
`;
  const result = spawnSync('python', ['-I', '-B', '-c', script,
    fileURLToPath(new URL('../../../../scripts/ci/reviewed_gitleaks.py', import.meta.url)),
    fileURLToPath(new URL('../../../../.gitleaks.toml', import.meta.url)), String(REVIEWED_HISTORY_PROOF.verified_git_objects)],
  { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
})();
const report = () => structuredClone(helperReport);
function execution() {
  const now = Date.now();
  const job = batchJobsV2({ repo: 'tdoljyj/cross-memory-system', pr: 920, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), testSha: 'a'.repeat(40),
    sourceManifestSha256: 'c'.repeat(64), createdAt: iso(now - 60000), attempt: 1 }).gitleaks;
  const observation = { contract: 'clued.independent-ci.formal-scanner-observation/2', domain: 'production-observation', fixture: false,
    formalEligible: false, qualificationIssued: false, checksWritten: false, subject: subjectOfV2(job), sourceManifestSha256: job.sourceManifestSha256,
    profile: 'required-gitleaks-history/1', sourceSha: 'd'.repeat(40), requiredHistoricalExceptions: 730, reviewedHistoryProof: { ...REVIEWED_HISTORY_PROOF }, startedAt: iso(now - 5000),
    finishedAt: iso(now - 1000), exitCode: 0, conclusion: 'success', logs: { stdout: { sha256: 'e'.repeat(64) }, stderr: { sha256: 'f'.repeat(64) } },
    cleanup: { complete: true, wholeContainerTreeStopped: true, containerRemoved: true, observedAt: iso(now - 500) } };
  return { job, observation, issue: { job, expiresAt: iso(now + 60000) }, now };
}

test('Source v4 has exactly 730 findings/102 commits; the legacy Source remains 726/100', () => {
  assert.deepEqual(REVIEWED_COMMITS, { findings: 730, commits: 102, sha256: 'f889be5ef30f8409db61b1130810b5088ca278d04886b10cf98a3a2558609192' });
  assert.deepEqual(LEGACY_COMMITS, { findings: 726, commits: 100, sha256: 'fcb2cc04ee35e01fbfc4bfc3dc9b0bb0ba78a6c4083ab5e17433c549450d59bb' });
});

test('the actual self-test must retain every old guard and prove new marker and valid-PEM detection', async () => {
  assert.equal(report().regression.synthetic_test_repository, '/controlled-helper-return/repo');
  assert.doesNotThrow(() => validateSelfTestReport(report()));
  for (const edit of [r => r.exact_historical_fingerprints = 729, r => r.exact_historical_fingerprints = 731,
    r => r.global_fingerprints = 1, r => r.default_rules_unchanged = false, r => r.commits = 101,
    r => r.files_at_commits = 170, r => r.verified_git_objects = 131, r => r.ignore_sha256 = 'a'.repeat(64), r => r.extra = true,
    r => r.regression.extra = true, r => delete r.regression.synthetic_test_repository,
    r => r.regression.synthetic_test_repository = false, r => r.regression.synthetic_test_repository = 'relative/repo']) {
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

test('policy and result bridge agree on 730 and reject both legacy/mismatched counts and incomplete cleanup', () => {
  const { job, observation, issue, now } = execution();
  assert.equal(validateCleanupObservation(job, observation), observation);
  assert.equal(observationFacts(issue, observation, now).exitCode, 0);
  for (const count of [726, 729, 731, undefined]) {
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
