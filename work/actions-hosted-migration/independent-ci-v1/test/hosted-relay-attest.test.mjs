// Attestation rules E1-E8 and the verdict table (design §5, §6, §11), over
// facts read by the real observer from the in-memory GitHub of world.mjs and
// tokens verified by the real OIDC verifier.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { attestRole, isBillingRefusal, parseDetailsUrl, relayExternalId, validateHostedEnvelope } from '../src/hosted-relay-v1/attest.mjs';
import { hostedHint } from '../src/hosted-relay-v1/stage.mjs';
import { digest } from '../src/proof.mjs';
import { tokenFromAnnotation } from '../src/hosted-relay-v1/oidc.mjs';
import { B, H, M0, OTHER, PR, REPO, ROLES, SHAPES, createWorld } from './fixtures/hosted-relay/world.mjs';

async function verdicts(w, roles = [...ROLES]) {
  const { verdicts: out } = await w.verifier().attest({ subject: w.subject(), roles });
  return Object.fromEntries(Object.entries(out).map(([role, v]) => [role, v.reason ? `${v.verdict}:${v.reason}` : v.verdict]));
}
const all = value => Object.fromEntries(ROLES.map(role => [role, value]));
const billingGate = w => {
  const gate = w.addHostedRun('gitleaks', { name: 'admission-gate', conclusion: 'failure', annotations: [SHAPES.billingRefusedAnnotation] });
  return gate;
};

test('a verified successful hosted run of each registered job is ATTESTED_SUCCESS with an envelope that carries no token', async () => {
  const w = createWorld();
  const runs = w.allHosted();
  const { verdicts: out } = await w.verifier().attest({ subject: w.subject(), roles: [...ROLES] });
  for (const role of ROLES) {
    const v = out[role];
    assert.equal(v.verdict, 'ATTESTED_SUCCESS', role);
    assert.equal(v.mode, 'relay'); assert.equal(v.advisory, false);
    const e = validateHostedEnvelope(v.envelope);
    assert.equal(e.mergeSha, M0); assert.equal(e.mergeBaseSha, B); assert.equal(e.headSha, H); assert.equal(e.pr, PR);
    assert.equal(e.checkName, role); assert.equal(e.hostedCheckName, `${role}-hosted-executor`);
    assert.equal(e.checkRunId, runs[role].id); assert.equal(e.runId, String(runs[role].runId)); assert.equal(e.runAttempt, '1');
    assert.equal(e.workflowBlob, w.registry.roles[role].workflowBlob);
    assert.equal(e.closureSha256, w.registry.roles[role].closureSha256);
    assert.ok(!JSON.stringify(e).includes(tokenFromAnnotation(w.state.annotations.get(runs[role].id)[0].message).split('.')[2]), 'no token bytes');
    assert.equal(relayExternalId(e), `independent-ci:relay:${role}:${H.slice(0, 12)}:run${runs[role].runId}:a1`);
  }
});

test('E1/E2: closed, draft, moved, forked, other-base or behind PRs are NOT_ELIGIBLE', async () => {
  const cases = [
    [w => { w.state.pr.state = 'closed'; }, 'E1_PR_NOT_OPEN'],
    [w => { w.state.pr.draft = true; }, 'E1_PR_DRAFT'],
    [w => { w.state.pr.head.sha = OTHER; }, 'E1_HEAD_CHANGED'],
    [w => { w.state.pr.head.repo = { full_name: 'attacker/cross-memory-system', id: 1 }; }, 'E1_FORK_OR_FOREIGN_REPOSITORY'],
    [w => { w.state.pr.base.ref = 'release'; }, 'E1_BASE_NOT_MAIN'],
    [w => { w.state.mainTip = OTHER; w.state.compares.set(`${OTHER}...${H}`, { status: 'diverged', ahead_by: 1, behind_by: 1 }); }, 'E1_BASE_NOT_MAIN_TIP'],
    [w => { w.state.compares.set(`${B}...${H}`, { status: 'diverged', ahead_by: 1, behind_by: 2 }); }, 'E2_HEAD_BEHIND_MAIN'],
  ];
  for (const [change, reason] of cases) {
    const w = createWorld(); w.allHosted(); change(w);
    assert.deepEqual(await verdicts(w), all(`NOT_ELIGIBLE:${reason}`), reason);
  }
});

test('E3: a PR that changes CI files, .gitattributes or a role closure falls back for that role', async () => {
  const cases = [
    [['src/app.js', '.github/workflows/gitleaks.yml'], all('NOT_ELIGIBLE:E3_CI_PATH_CHANGED')],
    [['.github/workflows/gitleaks-shadow.yml', 'src/app.js'], all('NOT_ELIGIBLE:E3_CI_PATH_CHANGED')],
    [['.github/actions/ci-temporary-storage/setup.mjs'], all('NOT_ELIGIBLE:E3_CI_PATH_CHANGED')],
    [['.gitattributes', 'src/app.js'], all('NOT_ELIGIBLE:E3_PROTECTED_PATH_CHANGED')],
    // PR-A re-review: a .gitattributes at any depth (**/.gitattributes) can mark files binary for the hosted scan.
    [['docs/.gitattributes'], all('NOT_ELIGIBLE:E3_PROTECTED_PATH_CHANGED')],
    [['src/app.js', 'apps/web/vendor/.gitattributes'], all('NOT_ELIGIBLE:E3_PROTECTED_PATH_CHANGED')],
    [['docs/x.gitattributes', 'docs/.gitattributes.md', 'docs/.gitattributesx/a.txt'], all('ATTESTED_SUCCESS')],
    [['.gitleaks.toml'], { gitleaks: 'NOT_ELIGIBLE:E3_CLOSURE_PATH_CHANGED', trivy: 'ATTESTED_SUCCESS' }],
    [['.gitleaksignore'], { gitleaks: 'NOT_ELIGIBLE:E3_CLOSURE_PATH_CHANGED', trivy: 'ATTESTED_SUCCESS' }],
    [['scripts/ci/reviewed_gitleaks.py'], { gitleaks: 'NOT_ELIGIBLE:E3_CLOSURE_PATH_CHANGED', trivy: 'ATTESTED_SUCCESS' }],
    [['.trivyignore'], { gitleaks: 'ATTESTED_SUCCESS', trivy: 'NOT_ELIGIBLE:E3_CLOSURE_PATH_CHANGED' }],
    // Anything under the directory the hosted gitleaks job executes from (scripts/ci/) is a shadowing risk for
    // gitleaks: placement scripts too. trivy executes no repository script.
    [['scripts/ci/check_contract_placement.py'], { gitleaks: 'NOT_ELIGIBLE:E3_EXECUTED_PATH_CHANGED', trivy: 'ATTESTED_SUCCESS' }],
    // PR-A review BLOCKER: a PR adding scripts/ci/argparse.py would shadow the stdlib module of the hosted
    // `python3 scripts/ci/reviewed_gitleaks.py` (without -I) and could rewrite the scan inputs before the scan.
    [['scripts/ci/argparse.py'], { gitleaks: 'NOT_ELIGIBLE:E3_EXECUTED_PATH_CHANGED', trivy: 'ATTESTED_SUCCESS' }],
    [['src/app.js', 'scripts/ci/sub/tomllib/__init__.py'], { gitleaks: 'NOT_ELIGIBLE:E3_EXECUTED_PATH_CHANGED', trivy: 'ATTESTED_SUCCESS' }],
    // both sides of a rename are changed paths (github.mjs adds previous_filename): out of, or into, scripts/ci/
    [['scripts/ci/old_name.py', 'tools/new_name.py'], { gitleaks: 'NOT_ELIGIBLE:E3_EXECUTED_PATH_CHANGED', trivy: 'ATTESTED_SUCCESS' }],
    [['tools/json.py', 'scripts/ci/json.py'], { gitleaks: 'NOT_ELIGIBLE:E3_EXECUTED_PATH_CHANGED', trivy: 'ATTESTED_SUCCESS' }],
    [['scripts/cix.py', 'scripts/README.md'], { gitleaks: 'ATTESTED_SUCCESS', trivy: 'ATTESTED_SUCCESS' }],
  ];
  for (const [paths, expected] of cases) {
    const w = createWorld(); w.allHosted(); w.state.changedPaths = paths;
    assert.deepEqual(await verdicts(w), expected, paths.join(','));
  }
  const w = createWorld(); w.allHosted(); w.state.faults.readChangedPaths = 'incomplete_pr_files';
  assert.deepEqual(await verdicts(w), all('NOT_ELIGIBLE:E3_FILES_INCOMPLETE'));
});

test('E4: CI files on H that differ from the registry, links and forbidden files fall back', async () => {
  let w = createWorld(); w.allHosted();
  w.state.headFiles['.gitleaks.toml'] = '# main changed without re-registration\n'; w.rebuild();
  assert.deepEqual(await verdicts(w), { gitleaks: 'NOT_ELIGIBLE:E4_CLOSURE_MISMATCH', trivy: 'ATTESTED_SUCCESS' });
  w = createWorld(); w.allHosted(); w.state.headModes['scripts/ci/reviewed_gitleaks.py'] = '120000'; w.rebuild();
  assert.equal((await verdicts(w)).gitleaks, 'NOT_ELIGIBLE:E4_CLOSURE_MISMATCH');
  w = createWorld(); w.allHosted(); w.state.headFiles['.trivyignore'] = 'CVE-2026-0001\n'; w.rebuild();
  assert.deepEqual(await verdicts(w), { gitleaks: 'ATTESTED_SUCCESS', trivy: 'NOT_ELIGIBLE:E4_FORBIDDEN_PATH_PRESENT' });
  w = createWorld(); w.allHosted(); w.state.headFiles['.github/workflows/trivy.yml'] += '# drift\n'; w.rebuild();
  assert.equal((await verdicts(w)).trivy, 'NOT_ELIGIBLE:E4_CLOSURE_MISMATCH');
});

test('E5: absent, pending, failed, skipped, superseded and foreign runs are not attested', async () => {
  let w = createWorld();
  assert.deepEqual(await verdicts(w), all('ABSENT:E5_NO_HOSTED_RUN'));
  w = createWorld(); w.addHostedRun('gitleaks', { status: 'queued' }); w.addHostedRun('trivy', { status: 'in_progress' });
  assert.deepEqual(await verdicts(w), { gitleaks: 'PENDING:E5_HOSTED_QUEUED', trivy: 'PENDING:E5_HOSTED_IN_PROGRESS' });
  w = createWorld(); w.addHostedRun('trivy', { conclusion: 'failure' });
  assert.equal((await verdicts(w)).trivy, 'HOSTED_NOT_SUCCESS:E5_HOSTED_FAILURE');
  w = createWorld(); w.allHosted(); w.addHostedRun('gitleaks', { conclusion: 'failure' }); // a newer re-run failed
  assert.equal((await verdicts(w)).gitleaks, 'HOSTED_NOT_SUCCESS:E5_HOSTED_FAILURE');
  w = createWorld(); w.allHosted(); w.addHostedRun('gitleaks', { conclusion: 'cancelled' });
  assert.equal((await verdicts(w)).gitleaks, 'HOSTED_NOT_SUCCESS:E5_HOSTED_CANCELLED');
  // A run of the hosted job name from any app but GitHub Actions (15368) is refused, also next to a good Actions run.
  w = createWorld(); w.addHostedRun('gitleaks', { appId: 5368905 }); w.addHostedRun('trivy', { headSha: OTHER });
  const foreign = await verdicts(w, ['gitleaks', 'trivy']);
  assert.deepEqual(foreign, { gitleaks: 'ATTESTATION_FAILED:E5_FOREIGN_APP_RUN', trivy: 'ABSENT:E5_NO_HOSTED_RUN' });
  w = createWorld(); w.allHosted(); w.addHostedRun('trivy', { appId: 99999 });
  assert.deepEqual(await verdicts(w), { gitleaks: 'ATTESTED_SUCCESS', trivy: 'ATTESTATION_FAILED:E5_FOREIGN_APP_RUN' });
  w = createWorld(); w.allHosted(); w.addHostedRun('gitleaks', { appId: null });
  assert.equal((await verdicts(w)).gitleaks, 'ATTESTATION_FAILED:E5_FOREIGN_APP_RUN');
  // The required check name from the hosted app is not the registered hosted job.
  w = createWorld(); w.addHostedRun('gitleaks', { name: 'gitleaks' });
  assert.equal((await verdicts(w, ['gitleaks'])).gitleaks, 'ABSENT:E5_NO_HOSTED_RUN');
  w = createWorld(); const runs = w.allHosted(); runs.gitleaks.details_url = `https://github.com/${REPO}/actions/runs/${runs.gitleaks.runId}/job/${runs.gitleaks.id + 1}`;
  assert.equal((await verdicts(w)).gitleaks, 'ATTESTATION_FAILED:E5_DETAILS_URL_INVALID');
});

test('BILLING_REFUSED is a classification only: a changed billing text still falls back', async () => {
  let w = createWorld(); billingGate(w);
  for (const role of ROLES) w.addHostedRun(role, { conclusion: 'skipped' });
  assert.deepEqual(await verdicts(w), all('BILLING_REFUSED:E5_BILLING_REFUSED'));
  w = createWorld(); billingGate(w);
  assert.deepEqual(await verdicts(w), all('BILLING_REFUSED:E5_BILLING_REFUSED'));
  w = createWorld();
  w.addHostedRun('gitleaks', { name: 'admission-gate', conclusion: 'failure', annotations: [{ ...SHAPES.billingRefusedAnnotation, message: 'Job refused: billing problem.' }] });
  for (const role of ROLES) w.addHostedRun(role, { conclusion: 'skipped' });
  assert.deepEqual(await verdicts(w), all('HOSTED_NOT_SUCCESS:E5_HOSTED_SKIPPED'));
  // Minutes ran out mid-PR: the role that finished is still relayed.
  w = createWorld(); w.addHostedRun('gitleaks'); billingGate(w);
  assert.deepEqual(await verdicts(w), { gitleaks: 'ATTESTED_SUCCESS', trivy: 'BILLING_REFUSED:E5_BILLING_REFUSED' });
  assert.equal(isBillingRefusal({ level: SHAPES.billingRefusedAnnotation.annotation_level, message: SHAPES.billingRefusedAnnotation.message }), true);
});

test('E6: exactly one identity annotation holding a hex-encoded JWT', async () => {
  const token = w => w.hexToken(w.signToken(w.claimsFor('gitleaks', { completed_at: new Date(w.state.now - 600_000).toISOString(), runId: 1 })));
  const cases = [
    [w => [], 'E6_TOKEN_MISSING'],
    [w => [{ annotation_level: 'notice', title: 'other-title', message: token(w), path: '.github' }], 'E6_TOKEN_MISSING'],
    [w => [1, 2].map(() => ({ annotation_level: 'notice', title: 'clued-hosted-relay-v1', message: token(w), path: '.github' })), 'E6_TOKEN_AMBIGUOUS'],
    [w => [{ annotation_level: 'notice', title: 'clued-hosted-relay-v1', message: 'not a token', path: '.github' }], 'E6_TOKEN_MALFORMED'],
    // What GitHub leaves of a raw JWT, and a raw JWT itself (the workflow before Task 169fd456).
    [w => [{ annotation_level: 'notice', title: 'clued-hosted-relay-v1', message: '***', path: '.github' }], 'E6_TOKEN_MALFORMED'],
    [w => [{ annotation_level: 'notice', title: 'clued-hosted-relay-v1', message: tokenFromAnnotation(token(w)), path: '.github' }], 'E6_TOKEN_MALFORMED'],
    [w => [{ annotation_level: 'notice', title: 'clued-hosted-relay-v1', message: token(w).toUpperCase(), path: '.github' }], 'E6_TOKEN_MALFORMED'],
  ];
  for (const [annotations, reason] of cases) {
    const w = createWorld(); w.addHostedRun('gitleaks', { annotations: annotations(w) });
    assert.equal((await verdicts(w, ['gitleaks'])).gitleaks, `ATTESTATION_FAILED:${reason}`, reason);
  }
  const w = createWorld(); const runs = w.allHosted(); runs.gitleaks.output.annotations_count = 3; // listing would be incomplete
  assert.equal((await verdicts(w)).gitleaks, 'ATTESTATION_FAILED:E6_ANNOTATIONS_UNOBSERVED');
});

test('E7: every signed claim must name this repository, PR, base, workflow, hosted runner, run and time', async () => {
  const run = w => w.state.checkRuns.at(-1);
  const cases = [
    [{ base_ref: 'evil' }, 'E7_BASE_REF'],
    [{ ref: 'refs/pull/8/merge' }, 'E7_REF'],
    [{ head_ref: 'other-branch' }, 'E7_HEAD_REF'],
    [{ job_workflow_ref: `${REPO}/.github/workflows/trivy.yml@refs/pull/${PR}/merge`, workflow_ref: `${REPO}/.github/workflows/trivy.yml@refs/pull/${PR}/merge` }, 'E7_JOB_WORKFLOW_REF'],
    [{ workflow_ref: `${REPO}/.github/workflows/gitleaks.yml@refs/heads/evil` }, 'E7_WORKFLOW_REF'],
    [{ runner_environment: 'self-hosted' }, 'E7_RUNNER_ENVIRONMENT'],
    [{ run_id: '1' }, 'E7_RUN_ID'],
    [{ run_attempt: 'x' }, 'E7_RUN_ATTEMPT'],
    [{ event_name: 'pull_request_target' }, 'E7_EVENT_NAME'],
    [{ repository: 'attacker/cross-memory-system' }, 'E7_REPOSITORY'],
    [{ repository_id: '1' }, 'E7_REPOSITORY_ID'],
    [{ repository_owner: 'attacker' }, 'E7_REPOSITORY_OWNER'],
    [{ repository_owner_id: '1' }, 'E7_REPOSITORY_OWNER_ID'],
    [{ sub: 'repo:tdoljyj/cross-memory-system:ref:refs/heads/main' }, 'E7_SUBJECT'],
    [{ iat: Math.floor((Date.parse('2026-10-21T06:00:00Z') - 15 * 60_000) / 1000) - 61 }, 'E7_IAT_OUTSIDE_RUN'],
    [{ iat: Math.floor((Date.parse('2026-10-21T06:00:00Z') - 10 * 60_000) / 1000) + 61 }, 'E7_IAT_OUTSIDE_RUN'],
    [{ check_run_id: '1' }, 'E7_CHECK_RUN_ID'],
    [{ aud: 'sts.amazonaws.com' }, 'E7_OIDC_AUDIENCE_MISMATCH'],
    [{ iss: 'https://attacker.invalid' }, 'E7_OIDC_ISSUER_MISMATCH'],
  ];
  for (const [claims, reason] of cases) {
    const w = createWorld(); w.addHostedRun('gitleaks', { claims });
    assert.equal((await verdicts(w, ['gitleaks'])).gitleaks, `ATTESTATION_FAILED:${reason}`, reason);
  }
  // A matching check_run_id claim is accepted.
  const w = createWorld(); w.addHostedRun('gitleaks');
  w.state.annotations.get(run(w).id)[0].message = w.hexToken(w.signToken(w.claimsFor('gitleaks', run(w), { check_run_id: String(run(w).id) })));
  assert.equal((await verdicts(w, ['gitleaks'])).gitleaks, 'ATTESTED_SUCCESS');
  // A token signed by anyone but GitHub's JWKS key.
  const forged = createWorld(); forged.addHostedRun('gitleaks');
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  forged.state.annotations.get(run(forged).id)[0].message = forged.hexToken(forged.signToken(forged.claimsFor('gitleaks', run(forged)), { key: other }));
  assert.equal((await verdicts(forged, ['gitleaks'])).gitleaks, 'ATTESTATION_FAILED:E7_OIDC_SIGNATURE_INVALID');
});

test('a real token copied onto a forged or newer check run does not attest (§6)', async () => {
  const w = createWorld();
  const real = w.addHostedRun('gitleaks');
  const copied = w.state.annotations.get(real.id)[0].message;
  w.addHostedRun('gitleaks', { token: copied }); // newer id, another run id, same token
  assert.equal((await verdicts(w, ['gitleaks'])).gitleaks, 'ATTESTATION_FAILED:E7_RUN_ID');
  // A trivy token pasted on the gitleaks job of the same run.
  const t = createWorld();
  const trivy = t.addHostedRun('trivy');
  t.addHostedRun('gitleaks', { runId: trivy.runId, token: t.state.annotations.get(trivy.id)[0].message });
  assert.equal((await verdicts(t, ['gitleaks'])).gitleaks, 'ATTESTATION_FAILED:E7_JOB_WORKFLOW_REF');
});

test('E8: the merge commit must be H on an ancestor of main with H\'s tree', async () => {
  const cases = [
    [w => ({ workflow_sha: OTHER }), w => {}, 'E8_SHA_CLAIMS_DISAGREE'],
    [w => ({}), w => { w.state.commits.delete(M0); }, 'E8_MERGE_COMMIT_UNOBSERVED'],
    [w => ({}), w => { w.state.commits.set(M0, { ...w.state.commits.get(M0), parents: [B, OTHER] }); }, 'E8_MERGE_PARENTS'],
    [w => ({}), w => { w.state.commits.set(M0, { ...w.state.commits.get(M0), parents: [H] }); }, 'E8_MERGE_PARENTS'],
    [w => ({}), w => { w.state.commits.set(M0, { ...w.state.commits.get(M0), tree: w.state.commits.get(B).tree }); }, 'E8_MERGE_TREE'],
    [w => ({}), w => { w.state.commits.set(M0, { ...w.state.commits.get(M0), parents: [OTHER, H] });
      w.state.compares.set(`${OTHER}...${B}`, { status: 'diverged', ahead_by: 2, behind_by: 1 }); }, 'E8_MERGE_BASE_NOT_ANCESTOR'],
    // A token from another head's merge commit.
    [w => ({ sha: OTHER, workflow_sha: OTHER, job_workflow_sha: OTHER }), w => {
      w.state.commits.set(OTHER, { tree: w.state.commits.get(H).tree, parents: [B, OTHER] }); }, 'E8_MERGE_PARENTS'],
  ];
  for (const [claims, change, reason] of cases) {
    const w = createWorld(); w.addHostedRun('gitleaks', { claims: claims(w) }); change(w);
    assert.equal((await verdicts(w, ['gitleaks'])).gitleaks, `ATTESTATION_FAILED:${reason}`, reason);
  }
  // A base that main has since moved past is fine as long as it is an ancestor.
  const w = createWorld(); w.addHostedRun('gitleaks');
  w.state.commits.set(M0, { ...w.state.commits.get(M0), parents: [OTHER, H] });
  w.state.compares.set(`${OTHER}...${B}`, { status: 'ahead', ahead_by: 3, behind_by: 0 });
  assert.equal((await verdicts(w, ['gitleaks'])).gitleaks, 'ATTESTED_SUCCESS');
});

test('hint mode reuses the same rules without a signature and is advisory only', async () => {
  const w = createWorld(); w.addHostedRun('gitleaks');
  const run = w.state.checkRuns.at(-1);
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  w.state.annotations.get(run.id)[0].message = w.hexToken(w.signToken(w.claimsFor('gitleaks', run), { key: other }));
  const facts = await w.observer().observe({ repo: REPO, pr: PR, headSha: H, baseSha: B, roles: ['gitleaks'] });
  const hint = hostedHint({ registry: w.registry, facts });
  assert.equal(hint.advisory, true);
  assert.equal(hint.roles.gitleaks.verdict, 'ATTESTED_SUCCESS'); // a lie the hint cannot detect
  assert.equal(attestRole({ registry: w.registry, role: 'gitleaks', facts }).reason, 'E7_SIGNATURE_UNVERIFIED');
  assert.equal((await verdicts(w, ['gitleaks'])).gitleaks, 'ATTESTATION_FAILED:E7_OIDC_SIGNATURE_INVALID');
  assert.throws(() => attestRole({ registry: structuredClone(w.registry), role: 'gitleaks', facts }), { code: 'RELAY_REGISTRY_NOT_VALIDATED' });
  assert.throws(() => attestRole({ registry: w.registry, role: 'kooyumi-merge-slot', facts }), { code: 'RELAY_ROLE_NOT_REGISTERED' });
  assert.equal(attestRole({ registry: w.registry, role: 'gitleaks', facts: { ...facts, contract: 'x' } }).reason, 'FACTS_INVALID');
});

test('hosted-attestation envelopes are integrity-checked and details URLs parse as on the real API', async () => {
  const w = createWorld(); w.allHosted();
  const { verdicts: out } = await w.verifier().attest({ subject: w.subject(), roles: ['gitleaks'] });
  const envelope = out.gitleaks.envelope;
  assert.equal(validateHostedEnvelope(envelope), envelope);
  assert.throws(() => validateHostedEnvelope({ ...envelope, runId: '7' }), { code: 'RELAY_ENVELOPE_INVALID' });
  const { attestationSha256, ...rest } = { ...envelope, mergeSha: OTHER };
  assert.throws(() => validateHostedEnvelope({ ...rest, attestationSha256 }), { code: 'RELAY_ENVELOPE_INVALID' });
  const resealed = { ...rest, attestationSha256: digest(rest) };
  assert.equal(validateHostedEnvelope(resealed).mergeSha, OTHER); // integrity only: the publisher must re-attest
  const { tokenSha256, ...missing } = envelope;
  assert.throws(() => validateHostedEnvelope(missing), { code: 'RELAY_ENVELOPE_INVALID' });
  assert.throws(() => validateHostedEnvelope({ ...envelope, hostedCheckName: envelope.checkName }), { code: 'RELAY_ENVELOPE_INVALID' });
  const real = SHAPES.hostedSuccessCheckRun;
  assert.deepEqual(parseDetailsUrl(real.details_url, REPO), { runId: '39479025770', jobId: real.id, runUrl: `https://github.com/${REPO}/actions/runs/39479025770` });
  assert.equal(parseDetailsUrl(SHAPES.independentCheckRun.details_url, REPO), null);
  assert.equal(parseDetailsUrl(real.details_url, 'attacker/cross-memory-system'), null);
});

// PR-A round-3 review: every .gitattributes of the registry commit is pinned, so when main later changes one (the PR
// itself does not touch it, E3 passes), the head's bytes differ and E4 stops relaying both roles until re-pin.
test('E4: a pinned nested .gitattributes that main changed later is a closure mismatch for both roles', async () => {
  let w = createWorld(); w.allHosted();
  assert.deepEqual(await verdicts(w), all('ATTESTED_SUCCESS'));
  w = createWorld(); w.allHosted(); w.state.headFiles['docs/.gitattributes'] = '*.md binary\n'; w.rebuild();
  assert.deepEqual(await verdicts(w), all('NOT_ELIGIBLE:E4_CLOSURE_MISMATCH'));
  w = createWorld(); w.allHosted(); delete w.state.headFiles['docs/.gitattributes']; w.rebuild();
  assert.deepEqual(await verdicts(w), all('NOT_ELIGIBLE:E4_CLOSURE_MISMATCH'));
});
