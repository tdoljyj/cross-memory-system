// Source v2 job contract (claim decoupling A-strict, DESIGN S6). Pure data: no I/O, no network,
// no credential. v1 (`clued.independent-ci.job/1`, src/queue.mjs) stays untouched for the existing
// installation; the two contracts never mix, every v2 consumer refuses a v1 job and vice versa.
//
// Identity = content + attempt. The work claim is NOT part of a job any more: it is resolved live
// from the PR trailer at every admission, callback and publication (full-admission-v2.mjs) and is
// sticky inside one batch (batch-claim-v2.mjs). `attempt` is part of the id (Owner decision
// 1b5d3687): an automatic attempt 2 therefore has new job ids, new run directories and new effect
// keys, and a settled or published job id is never run again.
//
// Contract /3 (quota phase 2 step 3b, design v0.5 §5.7): the identity also names the tested commit S
// (`testSha`) next to the head H and the base T. In the merge train the front batch tests GitHub's test
// merge of [T, H]; everywhere else, and in every batch until the train is wired (step 3c), S = H. The
// module and its exports keep the "V2" (Source v2) names; only the contract string changed. The
// subject keeps its fields: its `id` already binds S, so a result for one S never counts for another.
import { createHash } from 'node:crypto';
import { canonical, digest } from './proof.mjs';

export const JOB_CONTRACT_V2 = 'clued.independent-ci.job/3';
export const JOB_FIELDS_V2 = Object.freeze(['contract', 'id', 'repo', 'pr', 'headSha', 'baseSha', 'testSha', 'role', 'sourceManifestSha256', 'createdAt', 'attempt']);
export const IDENTITY_V2 = Object.freeze(['repo', 'pr', 'headSha', 'baseSha', 'testSha', 'sourceManifestSha256', 'role', 'attempt']);
export const SUBJECT_V2 = Object.freeze(['id', 'repo', 'pr', 'headSha', 'baseSha', 'role', 'sourceManifestSha256', 'attempt']);
// One automatic retry generation at most (attempt 2 only for a clean transient failure, see
// independent-ci-resident-v1/src/attempts.mjs). Nothing ever creates attempt 3.
export const MAX_ATTEMPT_V2 = 2;
export const ROLES_V2 = Object.freeze(['work-admission', 'gitleaks', 'trivy', 'contract-placement', 'control-admission', 'control-merge-slot']);
export const SCANNER_ROLES_V2 = Object.freeze(['gitleaks', 'trivy', 'contract-placement']);
export const CONTROL_ROLES_V2 = Object.freeze(['control-admission', 'control-merge-slot']);
export const REPO_V2 = 'tdoljyj/cross-memory-system';

const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v, keys) => plain(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const positive = v => Number.isSafeInteger(v) && v > 0;

// The id is domain-separated by the contract string, so a /3 id can never equal a v1 or /2 id.
export function jobIdV2(job) {
  return createHash('sha256').update(JSON.stringify([JOB_CONTRACT_V2, ...IDENTITY_V2.map(k => job[k])])).digest('hex');
}

export function validateJobV2(job) {
  if (!exact(job, JOB_FIELDS_V2) || job.contract !== JOB_CONTRACT_V2 || !HASH.test(job.id ?? '') || !REPO.test(job.repo ?? '')
    || !positive(job.pr) || !SHA.test(job.headSha ?? '') || !SHA.test(job.baseSha ?? '') || !SHA.test(job.testSha ?? '') || !ROLES_V2.includes(job.role)
    || !HASH.test(job.sourceManifestSha256 ?? '') || typeof job.createdAt !== 'string' || !ISO.test(job.createdAt)
    || !Number.isFinite(Date.parse(job.createdAt)) || !positive(job.attempt) || job.attempt > MAX_ATTEMPT_V2
    || job.id !== jobIdV2(job)) fail('invalid_job_v2');
  return job;
}

// S defaults to H: only the train's front batch (step 3c) ever passes another testSha.
export function makeJobV2({ repo, pr, headSha, baseSha, testSha = headSha, role, sourceManifestSha256, createdAt, attempt }) {
  const job = { contract: JOB_CONTRACT_V2, id: null, repo, pr, headSha, baseSha, testSha, role, sourceManifestSha256, createdAt, attempt };
  job.id = jobIdV2(job);
  return validateJobV2(job);
}

export const subjectOfV2 = job => Object.fromEntries(SUBJECT_V2.map(k => [k, job[k]]));

// The six jobs of one batch share everything but the role.
export function batchJobsV2(subject) {
  return Object.fromEntries(ROLES_V2.map(role => [role, makeJobV2({ ...subject, role })]));
}
export const sameBatchV2 = (a, b) => ['repo', 'pr', 'headSha', 'baseSha', 'testSha', 'sourceManifestSha256', 'attempt', 'createdAt'].every(k => a?.[k] === b?.[k]);
// The batch claim of every job is recorded under its batch's work-admission job id (batch-claim-v2.mjs).
export const batchRefV2 = job => jobIdV2({ ...job, role: 'work-admission' });

// ---- observed work claim (A-strict: resolved live, never installed) ----
export const OBSERVED_CLAIM_FIELDS = Object.freeze(['claimId', 'fence', 'epoch', 'expiresAt']);
export function validateObservedClaim(c) {
  if (!exact(c, OBSERVED_CLAIM_FIELDS) || !UUID.test(c.claimId ?? '') || !positive(c.fence) || !positive(c.epoch)
    || typeof c.expiresAt !== 'string' || !Number.isFinite(Date.parse(c.expiresAt))) fail('invalid_observed_claim');
  return c;
}
// One claim generation: same claim id, fence and epoch. A renewal changes only expiresAt and is the
// same generation; a takeover, continuation, handover or re-claim is a new generation.
export const claimGeneration = c => ({ claimId: c.claimId, fence: c.fence, epoch: c.epoch });
export function validateClaimGeneration(c) {
  if (!plain(c) || !UUID.test(c.claimId ?? '') || !positive(c.fence) || !positive(c.epoch)
    || Object.keys(c).some(k => !OBSERVED_CLAIM_FIELDS.includes(k))) fail('invalid_claim_generation');
  return claimGeneration(c);
}
export const sameClaimGeneration = (a, b) => !!a && !!b && a.claimId === b.claimId && a.fence === b.fence && a.epoch === b.epoch;

// ---- publication identities ----
// Scanner checks are content proofs: one effect per (job content, attempt), whatever claim is live,
// so the same content is published once across claims (design §5.5).
export function scanEffectKeyV2(job, definition) {
  validateJobV2(job);
  return digest({ action: 'staged-independent-check/2', subject: subjectOfV2(job), definition });
}
export function scanExternalIdV2(job) { validateJobV2(job); return `independent-ci:staged:v2:${job.id}:a${job.attempt}`; }

// Admission checks state "this claim generation admitted this content": one effect per (job, claim
// generation). A new generation is a new effect; a revocation still compensates the old one.
export function admissionEffectKeyV2(action, job, claim, definition) {
  validateJobV2(job);
  if (!['native-work-admission-check/2', 'independent-control-check/2'].includes(action)) fail('invalid_effect_action');
  return digest({ action, subject: subjectOfV2(job), claim: validateClaimGeneration(claim), definition });
}
export function admissionExternalIdV2(prefix, job, claim) {
  validateJobV2(job); validateClaimGeneration(claim);
  if (!['independent-ci:native-work-admission', `independent-ci:control:${job.role}`].includes(prefix)) fail('invalid_external_prefix');
  return `${prefix}:v2:${job.id}:a${job.attempt}:c${claim.claimId.slice(0, 8)}:f${claim.fence}:e${claim.epoch}`;
}

export { canonical, digest };
