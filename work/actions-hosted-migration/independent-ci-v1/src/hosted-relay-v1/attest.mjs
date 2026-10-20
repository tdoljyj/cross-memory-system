// Pure attestation of one GitHub-hosted run (design S15, rules E1-E8 of §5).
// Input: observed GitHub facts (observe.mjs), the OIDC verification result
// (oidc.mjs) and the validated registry. Output: one verdict per role and, for
// ATTESTED_SUCCESS only, the hosted-attestation envelope that publication binds
// to. No I/O. In 'hint' mode (companion) the token is decoded without a
// signature check and the verdict is advisory scheduling data only; only a
// 'relay' verdict inside the protected relay stage can lead to publication.
// E9 (fresh Native admission) and E10 (plan and K(head, role)) are checked by
// the publisher, after this function, immediately before the write.
import { digest } from '../proof.mjs';
import { HOSTED_APP_ID, isValidatedRegistry, registryDigestOf, relayFail } from './registry.mjs';
import { decodeJwtUnverified, MAX_TOKEN_LENGTH } from './oidc.mjs';

export const FACTS_CONTRACT = 'clued.independent-ci.hosted-relay-facts/1';
export const VERDICT_CONTRACT = 'clued.independent-ci.hosted-relay-verdict/1';
export const HOSTED_ENVELOPE_CONTRACT = 'clued.independent-ci.hosted-attestation/1';
export const VERDICTS = Object.freeze(['ATTESTED_SUCCESS', 'BILLING_REFUSED', 'HOSTED_NOT_SUCCESS', 'PENDING', 'ABSENT',
  'NOT_ELIGIBLE', 'ATTESTATION_FAILED']);
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const DIGITS = /^[1-9][0-9]{0,19}$/;
const ATTEMPT = /^[1-9][0-9]{0,3}$/;
// Billing refusal text seen on PR888 (2026-10-20). Used only to classify a
// fallback; a changed text still falls back as HOSTED_NOT_SUCCESS (§5 end).
const BILLING = /recent account payments have failed|spending limit needs to be increased/i;
const ENVELOPE_KEYS = ['contract', 'registrySha256', 'role', 'checkName', 'hostedCheckName', 'repository', 'repositoryId', 'pr',
  'headSha', 'baseSha', 'mergeSha', 'mergeBaseSha', 'runId', 'runAttempt', 'checkRunId', 'runUrl', 'jobUrl', 'workflowPath',
  'workflowBlob', 'closureSha256', 'claimsSha256', 'tokenSha256', 'iat', 'attestationSha256'];

export const isBillingRefusal = annotation => annotation?.level === 'failure' && typeof annotation.message === 'string'
  && BILLING.test(annotation.message);

export const relayExternalId = ({ role, headSha, runId, runAttempt }) =>
  `independent-ci:relay:${role}:${headSha.slice(0, 12)}:run${runId}:a${runAttempt}`;

// https://github.com/<owner>/<repo>/actions/runs/<run_id>/job/<job_id>; the job id is the check run id.
export function parseDetailsUrl(url, repository) {
  if (typeof url !== 'string' || url.length > 300) return null;
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/actions\/runs\/([1-9][0-9]{0,19})\/job\/([1-9][0-9]{0,19})$/.exec(url);
  if (!match || match[1] !== repository) return null;
  return { runId: match[2], jobId: Number(match[3]), runUrl: `https://github.com/${repository}/actions/runs/${match[2]}` };
}

const verdict = (mode, role, value, reason, envelope = null) => Object.freeze({ contract: VERDICT_CONTRACT, mode,
  advisory: mode === 'hint', role, verdict: value, reason, envelope });

function eligibility(registry, entry, facts) {
  const p = facts.pullRequest;
  if (!p || typeof p !== 'object') return 'E1_PR_UNOBSERVED';
  if (p.number !== facts.pr) return 'E1_PR_NUMBER_MISMATCH';
  if (p.state !== 'open') return 'E1_PR_NOT_OPEN';
  if (p.draft !== false) return 'E1_PR_DRAFT';
  if (p.headSha !== facts.headSha) return 'E1_HEAD_CHANGED';
  if (p.headRepo !== registry.repository || p.baseRepo !== registry.repository
    || (p.headRepoId !== null && p.headRepoId !== registry.repositoryId)
    || (p.baseRepoId !== null && p.baseRepoId !== registry.repositoryId)) return 'E1_FORK_OR_FOREIGN_REPOSITORY';
  if (p.baseRef !== registry.baseRef) return 'E1_BASE_NOT_MAIN';
  if (!SHA1.test(facts.mainTip ?? '') || p.baseSha !== facts.mainTip) return 'E1_BASE_NOT_MAIN_TIP';
  if (facts.baseSha !== facts.mainTip) return 'E1_SUBJECT_BASE_NOT_MAIN_TIP';
  if (typeof p.headRef !== 'string' || p.headRef.length === 0) return 'E1_HEAD_REF_UNOBSERVED';
  const compare = facts.compare;
  if (!compare || compare.baseSha !== facts.mainTip || compare.headSha !== facts.headSha) return 'E2_COMPARE_UNOBSERVED';
  if (compare.behindBy !== 0 || !['ahead', 'identical'].includes(compare.status)) return 'E2_HEAD_BEHIND_MAIN';
  const changed = facts.changedPaths;
  if (!changed || changed.complete !== true || !Array.isArray(changed.paths) || changed.paths.length === 0) return 'E3_FILES_INCOMPLETE';
  const closurePaths = new Set([...entry.closure.map(item => item.path), ...entry.mustNotExist]);
  for (const file of changed.paths) {
    if (typeof file !== 'string') return 'E3_FILES_INCOMPLETE';
    if (registry.forbiddenChangePrefixes.some(prefix => file.startsWith(prefix))) return 'E3_CI_PATH_CHANGED';
    if (registry.forbiddenChangePaths.includes(file)) return 'E3_PROTECTED_PATH_CHANGED';
    if (closurePaths.has(file)) return 'E3_CLOSURE_PATH_CHANGED';
  }
  const head = facts.headCommit;
  if (head?.sha !== facts.headSha || !SHA1.test(head.tree ?? '')) return 'E4_HEAD_TREE_UNOBSERVED';
  const observed = facts.closure;
  if (!observed || typeof observed !== 'object') return 'E4_CLOSURE_UNOBSERVED';
  for (const item of entry.closure) {
    if (!Object.hasOwn(observed, item.path)) return 'E4_CLOSURE_UNOBSERVED';
    const found = observed[item.path];
    if (found?.type !== 'blob' || found.mode !== item.mode || found.sha !== item.blob) return 'E4_CLOSURE_MISMATCH';
  }
  for (const file of entry.mustNotExist) {
    if (!Object.hasOwn(observed, file)) return 'E4_CLOSURE_UNOBSERVED';
    if (observed[file] !== null) return 'E4_FORBIDDEN_PATH_PRESENT';
  }
  return null;
}

function claimChecks(registry, entry, facts, run, details, claims) {
  const workflowRef = `${registry.repository}/${entry.workflowPath}@refs/pull/${facts.pr}/merge`;
  if (claims.iss !== registry.issuer) return 'E7_ISSUER';
  if (claims.aud !== registry.audience) return 'E7_AUDIENCE';
  if (claims.repository !== registry.repository) return 'E7_REPOSITORY';
  if (claims.repository_id !== String(registry.repositoryId)) return 'E7_REPOSITORY_ID';
  if (claims.repository_owner !== registry.repositoryOwner) return 'E7_REPOSITORY_OWNER';
  if (registry.repositoryOwnerId !== null && claims.repository_owner_id !== String(registry.repositoryOwnerId)) return 'E7_REPOSITORY_OWNER_ID';
  if (claims.event_name !== registry.eventName) return 'E7_EVENT_NAME';
  if (registry.expectedSubject !== null && claims.sub !== registry.expectedSubject) return 'E7_SUBJECT';
  if (claims.ref !== `refs/pull/${facts.pr}/merge`) return 'E7_REF';
  if (claims.base_ref !== registry.baseRef) return 'E7_BASE_REF';
  if (claims.head_ref !== facts.pullRequest.headRef) return 'E7_HEAD_REF';
  if (claims.job_workflow_ref !== workflowRef) return 'E7_JOB_WORKFLOW_REF';
  if (claims.workflow_ref !== workflowRef) return 'E7_WORKFLOW_REF';
  if (claims.runner_environment !== registry.runnerEnvironment) return 'E7_RUNNER_ENVIRONMENT';
  if (claims.run_id !== details.runId) return 'E7_RUN_ID';
  if (typeof claims.run_attempt !== 'string' || !ATTEMPT.test(claims.run_attempt)) return 'E7_RUN_ATTEMPT';
  if (claims.check_run_id !== undefined ? String(claims.check_run_id) !== String(run.id) : registry.requireCheckRunIdClaim) return 'E7_CHECK_RUN_ID';
  const started = Date.parse(run.startedAt), completed = Date.parse(run.completedAt), skew = registry.iatSkewSeconds * 1000;
  if (!Number.isSafeInteger(claims.iat) || !Number.isFinite(started) || !Number.isFinite(completed) || started > completed
    || claims.iat * 1000 < started - skew || claims.iat * 1000 > completed + skew) return 'E7_IAT_OUTSIDE_RUN';
  return null;
}

function mergeChecks(facts, claims, merge) {
  if (typeof claims.sha !== 'string' || !SHA1.test(claims.sha)) return 'E8_SHA_CLAIM_INVALID';
  if (claims.workflow_sha !== claims.sha || (claims.job_workflow_sha !== undefined && claims.job_workflow_sha !== claims.sha)) return 'E8_SHA_CLAIMS_DISAGREE';
  if (!merge || merge.sha !== claims.sha || !Array.isArray(merge.parents) || !SHA1.test(merge.tree ?? '')) return 'E8_MERGE_COMMIT_UNOBSERVED';
  if (merge.parents.length !== 2 || merge.parents[1] !== facts.headSha || !SHA1.test(merge.parents[0] ?? '')) return 'E8_MERGE_PARENTS';
  if (merge.tree !== facts.headCommit.tree) return 'E8_MERGE_TREE';
  const base = merge.baseCompare;
  if (!base || base.baseSha !== merge.parents[0] || base.headSha !== facts.mainTip) return 'E8_MERGE_BASE_UNOBSERVED';
  if (base.behindBy !== 0 || !['ahead', 'identical'].includes(base.status)) return 'E8_MERGE_BASE_NOT_ANCESTOR';
  return null;
}

// attestRole({ registry, role, facts, verification, mode }) -> verdict
//   registry: validateRegistry() result; facts: observe() result;
//   verification: oidc verify() result for this role's token (relay mode);
//   mode: 'relay' | 'hint'.
export function attestRole({ registry, role, facts, verification = null, mode = 'relay' }) {
  if (!isValidatedRegistry(registry)) relayFail('RELAY_REGISTRY_NOT_VALIDATED');
  if (!['relay', 'hint'].includes(mode)) relayFail('RELAY_ATTEST_MODE_INVALID');
  const entry = registry.roles[role];
  if (!entry) relayFail('RELAY_ROLE_NOT_REGISTERED', role);
  const out = (value, reason, envelope) => verdict(mode, role, value, reason, envelope);
  if (!facts || facts.contract !== FACTS_CONTRACT || facts.repository !== registry.repository || !Number.isSafeInteger(facts.pr)
    || facts.pr < 1 || !SHA1.test(facts.headSha ?? '') || !SHA1.test(facts.baseSha ?? '')) return out('ATTESTATION_FAILED', 'FACTS_INVALID');

  const ineligible = eligibility(registry, entry, facts);
  if (ineligible) return out('NOT_ELIGIBLE', ineligible);

  // E5: the newest run of the registered hosted job name, from GitHub Actions.
  const listed = facts.hostedRuns?.[role];
  if (!listed || listed.complete !== true || !Array.isArray(listed.checks)) return out('ATTESTATION_FAILED', 'E5_CHECK_SET_INCOMPLETE');
  const billing = facts.billing?.refused === true;
  const runs = listed.checks.filter(run => run?.appId === HOSTED_APP_ID && run.name === entry.hostedCheckName && run.headSha === facts.headSha);
  if (runs.length === 0) return billing ? out('BILLING_REFUSED', 'E5_BILLING_REFUSED') : out('ABSENT', 'E5_NO_HOSTED_RUN');
  const run = runs.reduce((a, b) => (b.id > a.id ? b : a));
  if (!Number.isSafeInteger(run.id) || run.id < 1) return out('ATTESTATION_FAILED', 'E5_CHECK_RUN_INVALID');
  if (run.status !== 'completed') return out('PENDING', run.status === 'in_progress' ? 'E5_HOSTED_IN_PROGRESS' : 'E5_HOSTED_QUEUED');
  if (run.conclusion !== 'success') {
    const refused = billing || (Array.isArray(facts.billing?.refusedRunIds) && facts.billing.refusedRunIds.includes(run.id));
    return refused ? out('BILLING_REFUSED', 'E5_BILLING_REFUSED')
      : out('HOSTED_NOT_SUCCESS', `E5_HOSTED_${String(run.conclusion ?? 'unknown').toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 40)}`);
  }
  const details = parseDetailsUrl(run.detailsUrl, registry.repository);
  if (!details || details.jobId !== run.id) return out('ATTESTATION_FAILED', 'E5_DETAILS_URL_INVALID');

  // E6: exactly one identity annotation on that very check run.
  const annotations = facts.tokenAnnotations?.[role];
  if (!annotations || annotations.checkRunId !== run.id || annotations.complete !== true || !Array.isArray(annotations.matches))
    return out('ATTESTATION_FAILED', 'E6_ANNOTATIONS_UNOBSERVED');
  if (annotations.matches.length === 0) return out('ATTESTATION_FAILED', 'E6_TOKEN_MISSING');
  if (annotations.matches.length > 1) return out('ATTESTATION_FAILED', 'E6_TOKEN_AMBIGUOUS');
  const token = annotations.matches[0];
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !JWT.test(token)) return out('ATTESTATION_FAILED', 'E6_TOKEN_MALFORMED');
  const tokenSha256 = digest(token);

  // E7: GitHub-signed claims. Relay mode accepts only a verifier result for this exact token.
  let claims;
  if (mode === 'relay') {
    if (verification?.verified !== true || verification.tokenSha256 !== tokenSha256 || !verification.claims) return out('ATTESTATION_FAILED', 'E7_SIGNATURE_UNVERIFIED');
    claims = verification.claims;
  } else {
    try { claims = decodeJwtUnverified(token).claims; } catch { return out('ATTESTATION_FAILED', 'E6_TOKEN_MALFORMED'); }
  }
  const claimFailure = claimChecks(registry, entry, facts, run, details, claims);
  if (claimFailure) return out('ATTESTATION_FAILED', claimFailure);

  // E8: the merge commit the run built is H's tree on an ancestor of current main.
  const merge = facts.merge?.[role] ?? null;
  const mergeFailure = mergeChecks(facts, claims, merge);
  if (mergeFailure) return out('ATTESTATION_FAILED', mergeFailure);

  const evidence = { contract: HOSTED_ENVELOPE_CONTRACT, registrySha256: registryDigestOf(registry), role,
    checkName: entry.checkName, hostedCheckName: entry.hostedCheckName, repository: registry.repository,
    repositoryId: registry.repositoryId, pr: facts.pr, headSha: facts.headSha, baseSha: facts.baseSha, mergeSha: claims.sha,
    mergeBaseSha: merge.parents[0], runId: details.runId, runAttempt: claims.run_attempt, checkRunId: run.id,
    runUrl: details.runUrl, jobUrl: run.detailsUrl, workflowPath: entry.workflowPath, workflowBlob: entry.workflowBlob,
    closureSha256: entry.closureSha256, claimsSha256: digest(claims), tokenSha256, iat: claims.iat };
  return out('ATTESTED_SUCCESS', null, Object.freeze({ ...evidence, attestationSha256: digest(evidence) }));
}

// attestHead -> { roles: { role: verdict }, billingRefused }
export function attestHead({ registry, facts, verifications = {}, mode = 'relay' }) {
  if (!isValidatedRegistry(registry)) relayFail('RELAY_REGISTRY_NOT_VALIDATED');
  const roles = Array.isArray(facts?.roles) ? facts.roles : [];
  return Object.freeze({ contract: VERDICT_CONTRACT, mode, advisory: mode === 'hint', pr: facts?.pr ?? null, headSha: facts?.headSha ?? null,
    billingRefused: facts?.billing?.refused === true,
    roles: Object.freeze(Object.fromEntries(roles.map(role => [role, attestRole({ registry, role, facts, verification: verifications[role] ?? null, mode })]))) });
}

// Shape and integrity of an envelope handed to the publisher. Integrity only:
// the publisher must still re-attest it from fresh facts before any write.
export function validateHostedEnvelope(envelope) {
  const keys = envelope && typeof envelope === 'object' && !Array.isArray(envelope) ? Object.keys(envelope) : [];
  if (keys.length !== ENVELOPE_KEYS.length || !ENVELOPE_KEYS.every(key => Object.hasOwn(envelope, key))
    || envelope.contract !== HOSTED_ENVELOPE_CONTRACT || !SHA256.test(envelope.registrySha256) || typeof envelope.role !== 'string'
    || typeof envelope.checkName !== 'string' || typeof envelope.hostedCheckName !== 'string' || envelope.checkName === envelope.hostedCheckName
    || typeof envelope.repository !== 'string' || !Number.isSafeInteger(envelope.repositoryId) || !Number.isSafeInteger(envelope.pr) || envelope.pr < 1
    || ![envelope.headSha, envelope.baseSha, envelope.mergeSha, envelope.mergeBaseSha, envelope.workflowBlob].every(value => SHA1.test(value ?? ''))
    || !DIGITS.test(envelope.runId ?? '') || !ATTEMPT.test(envelope.runAttempt ?? '') || !Number.isSafeInteger(envelope.checkRunId) || envelope.checkRunId < 1
    || parseDetailsUrl(envelope.jobUrl, envelope.repository)?.jobId !== envelope.checkRunId
    || parseDetailsUrl(envelope.jobUrl, envelope.repository).runUrl !== envelope.runUrl
    || parseDetailsUrl(envelope.jobUrl, envelope.repository).runId !== envelope.runId
    || typeof envelope.workflowPath !== 'string' || ![envelope.closureSha256, envelope.claimsSha256, envelope.tokenSha256].every(value => SHA256.test(value ?? ''))
    || !Number.isSafeInteger(envelope.iat)) relayFail('RELAY_ENVELOPE_INVALID');
  const { attestationSha256, ...evidence } = envelope;
  if (attestationSha256 !== digest(evidence)) relayFail('RELAY_ENVELOPE_INVALID', 'integrity');
  return envelope;
}
