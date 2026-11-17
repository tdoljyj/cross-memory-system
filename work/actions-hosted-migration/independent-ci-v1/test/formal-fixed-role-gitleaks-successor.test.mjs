// Pure Source-v4 successor gates. These reports/observations never acquire an
// actual self-test, observation, qualification or signer capability.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { batchJobsV2, subjectOfV2 } from '../src/job-v2.mjs';
import { IMAGE, SCAN_ARGS, REVIEWED_COMMITS, REVIEWED_HISTORY_PROOF, matchesReviewedHistoryProof, validateSelfTestReport, requiredScannerPlan } from '../worker/formal-gitleaks-v4/required-history/prepare.mjs';
import { REVIEWED_COMMITS as LEGACY_COMMITS } from '../worker/formal-gitleaks-v3/required-history/prepare.mjs';
import { validateCleanupObservation } from '../worker/formal-fixed-role-policy-v3/policy.mjs';
import { observationFacts } from '../worker/protected-job-bridge-v4/signed-result.mjs';
import { takeActualObservation } from '../worker/formal-gitleaks-v4/adapter.mjs';
import { safeGitArguments } from '../worker/formal-gitleaks-v4/required-history/selftest-shim.mjs';

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
    profile: 'required-gitleaks-history/1', sourceSha: 'd'.repeat(40), requiredHistoricalExceptions: 737, reviewedHistoryProof: { ...REVIEWED_HISTORY_PROOF }, startedAt: iso(now - 5000),
    finishedAt: iso(now - 1000), exitCode: 0, conclusion: 'success', logs: { stdout: { sha256: 'e'.repeat(64) }, stderr: { sha256: 'f'.repeat(64) } },
    cleanup: { complete: true, wholeContainerTreeStopped: true, containerRemoved: true, observedAt: iso(now - 500) } };
  return { job, observation, issue: { job, expiresAt: iso(now + 60000) }, now };
}

test('Source v4 successor has exactly 737 findings/106 commits; the legacy Source remains 726/100', () => {
  assert.deepEqual(REVIEWED_COMMITS, { findings: 737, commits: 106, sha256: '3c632792af82ed938c2b99302ef1ed422433a8fc413fbe9c96e1fec17f1dd23f' });
  assert.deepEqual(LEGACY_COMMITS, { findings: 726, commits: 100, sha256: 'fcb2cc04ee35e01fbfc4bfc3dc9b0bb0ba78a6c4083ab5e17433c549450d59bb' });
});

test('the pinned proof is exactly 177 files at 106 commits and 130 objects (adjacent values are refused)', () => {
  assert.deepEqual({ ...REVIEWED_HISTORY_PROOF }, { commits: 106, files_at_commits: 177, verified_git_objects: 130,
    reviewed_commits_sha256: REVIEWED_COMMITS.sha256, reviewed_ignore_sha256: 'feaee7014fbfcfc42d58470751720dd641d4b0ab8208228f62abf71b9e081d60' });
  for (const [key, values] of [['commits', [105, 107]], ['files_at_commits', [176, 178]], ['verified_git_objects', [129, 131]]]) for (const value of values) {
    assert.equal(matchesReviewedHistoryProof({ ...REVIEWED_HISTORY_PROOF, [key]: value }), false, `${key}=${value}`);
  }
  assert.equal(matchesReviewedHistoryProof({ ...REVIEWED_HISTORY_PROOF }), true);
});

test('the actual self-test retains every old guard and proves integrity metadata, public batch-key variants, markers and valid-PEM detection', async () => {
  assert.equal(report().regression.synthetic_test_repository, '/controlled-helper-return/repo');
  assert.doesNotThrow(() => validateSelfTestReport(report()));
  for (const edit of [r => r.exact_historical_fingerprints = 733, r => r.exact_historical_fingerprints = 734, r => r.exact_historical_fingerprints = 735, r => r.exact_historical_fingerprints = 736, r => r.exact_historical_fingerprints = 738,
    r => r.global_fingerprints = 1, r => r.default_rules_unchanged = false, r => r.commits = 104, r => r.commits = 105,
    r => r.files_at_commits = 170, r => r.files_at_commits = 175, r => r.files_at_commits = 176, r => r.files_at_commits = 178,
    r => r.verified_git_objects = 129, r => r.verified_git_objects = 131, r => r.ignore_sha256 = 'a'.repeat(64), r => r.extra = true,
    r => r.regression.extra = true, r => delete r.regression.synthetic_test_repository,
    r => r.regression.synthetic_test_repository = false, r => r.regression.synthetic_test_repository = 'relative/repo']) {
    const value = report(); edit(value); assert.throws(() => validateSelfTestReport(value), { code: 'UNCHANGED_REVIEW_SELF_TEST_REQUIRED' });
  }
  for (const key of ['baseline_detection', 'exact_history_only', 'new_commit_detection', 'different_path_detection',
    'scheduling_marker_new_commit_detection', 'scheduling_marker_different_path_detection', 'valid_private_key_detection',
    'role_probe_new_commit_detection', 'role_probe_different_path_detection', 'role_probe_different_line_detection',
    'historical_json_new_commit_detection','historical_json_different_path_detection','historical_json_different_line_detection','genuine_curl_credential_detection',
    'public_batch_key_new_commit_detection','public_batch_key_different_path_detection','public_batch_key_different_line_detection',
    'integrity_metadata_new_commit_detection','integrity_metadata_different_path_detection','integrity_metadata_different_line_detection']) {
    const values = (key.startsWith('public_batch_key_') || key.startsWith('integrity_metadata_')) ? [false, undefined, 1, 'true'] : [false, undefined];
    for (const value of values) {
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

test('policy and result bridge agree on 737 and reject both legacy/mismatched counts and incomplete cleanup', () => {
  const { job, observation, issue, now } = execution();
  assert.equal(validateCleanupObservation(job, observation), observation);
  assert.equal(observationFacts(issue, observation, now).exitCode, 0);
  for (const count of [726, 730, 731, 732, 733, 734, 735, 736, 738, undefined]) {
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

test('the self-test git shim admits exactly the cc353e29 and d94cd486 one-commit catalog diffs (Decision 98fec682) and no other revision pair', () => {
  const diff = (from, to) => ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--diff-algorithm=myers', '--unified=0',
    from, to, '--', 'scripts/ci/clued-gated-proof-profiles.json'];
  const c = { templates: '/templates' }, cc353 = 'cc353e29a32b991696df95d5fc3f9b9d107e8d1c', d94 = 'd94cd486e29a7362888fc32cd807ceb38890acb6';
  for (const commit of [cc353, d94]) {
    const args = safeGitArguments(diff(`${commit}^`, commit), c);
    assert.deepEqual(args.slice(-13), ['-c', 'core.abbrev=8', ...diff(`${commit}^`, commit)]);
    assert.equal(args.filter(value => value === 'core.abbrev=8').length, 1);
  }
  for (const args of [['cat-file', '-t', cc353], ['rev-parse', `${d94}:scripts/ci/clued-gated-proof-profiles.json`]]) {
    const actual = safeGitArguments(args, c);
    assert.deepEqual(actual.slice(-args.length), args);
    assert.equal(actual.some(value => value.startsWith('core.abbrev=')), false);
  }
  for (const args of [diff(`${d94}^`, cc353), diff(`${cc353}^`, d94), diff(`${d94}^`, '0'.repeat(40)), diff(`${'0'.repeat(40)}^`, '0'.repeat(40)),
    [...diff(`${d94}^`, d94), '--stat'], ['diff', `${d94}^`, d94], ['log', d94], ['show', d94], ['fetch', 'origin', d94]]) {
    assert.throws(() => safeGitArguments(args, c), { code: 'SELF_TEST_GIT_COMMAND_REFUSED' });
  }
  for (const option of ['core.abbrev=8', 'core.abbrev=7', 'core.abbrev=40']) {
    assert.throws(() => safeGitArguments(['-c', option, ...diff(`${d94}^`, d94)], c), { code: 'SELF_TEST_GIT_OPTION_REFUSED' });
  }
});

// The role command is compared item by item with the node's installed fleet formalRoles (policy.mjs, prepare.mjs).
// A changed SCAN_ARGS changes formalRoles, which upgrade.mjs refuses in place (FLEET_SOURCE_REFS_CHANGED_NEEDS_REINSTALL).
// These are the values of the accepted fleet package 2026.11.16-446a7106 (formalRoles.gitleaks.containerCommand);
// change them only together with a release that reinstalls every node.
test('gitleaks role command equals the installed fleet formalRoles (446a7106), so the release upgrades in place', () => {
  assert.deepEqual([...SCAN_ARGS], ['git', '/repo', '--config', '/repo/.gitleaks.toml', '--gitleaks-ignore-path', '/reviewed.ignore', '--redact', '--exit-code', '1']);
  assert.equal(IMAGE, 'ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f');
});
