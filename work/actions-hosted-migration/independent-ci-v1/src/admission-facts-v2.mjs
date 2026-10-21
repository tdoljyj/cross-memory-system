// Pure validation of complete Native admission facts of contract /2 (DESIGN S6). Split out of
// full-admission-v2.mjs so that the Linux side (bridge v4 protocol, scanner adapters) can validate the
// facts it receives without loading the Windows-only evaluator (scripts/ci/clued-work-admission.mjs).
// No I/O. full-admission-v2.mjs re-exports everything here unchanged.
import { digest } from './proof.mjs';
import { sameClaimGeneration } from './job-v2.mjs';

export const FULL_ADMISSION_CONTRACT_V2 = 'clued.independent-ci.full-admission/2';
export const ADMISSION_ENGINE = 'scripts/ci/clued-work-admission.mjs#evaluate';
const sha = /^[a-f0-9]{64}$/;
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const at = value => typeof value === 'string' ? Date.parse(value) : NaN;

// Shared validation of admitted v2 facts for every consumer (publishers, bridge, adapters).
export const ADMISSION_FIELDS_V2 = Object.freeze(['contract', 'status', 'admitted', 'completeAdmission', 'evaluator', 'domain', 'repository', 'scope',
  'prRef', 'headSha', 'baseSha', 'jobId', 'role', 'attempt', 'claimId', 'fence', 'epoch', 'observedClaim', 'batchClaimBound', 'sourceManifestSha256',
  'executionPolicy', 'guarded', 'executionHandoverPending', 'mergeQueueHead', 'mode', 'mergeSlot', 'ownerReview', 'workflowGateFindings', 'observedAt',
  'claimExpiresAt', 'modeProofRef', 'observationRef', 'packetSha256', 'evaluationSha256', 'observationSha256']);
export function admittedFactsMatchJobV2(facts, job, now, { batchClaim = null } = {}) {
  if (!plain(facts) || facts.contract !== FULL_ADMISSION_CONTRACT_V2 || facts.status !== 'ADMITTED' || facts.admitted !== true || facts.completeAdmission !== true
    || facts.evaluator !== ADMISSION_ENGINE || facts.repository !== job.repo || facts.prRef !== `${job.repo}#${job.pr}` || facts.headSha !== job.headSha
    || facts.baseSha !== job.baseSha || facts.jobId !== job.id || facts.role !== job.role || facts.attempt !== job.attempt
    || facts.sourceManifestSha256 !== job.sourceManifestSha256 || facts.executionPolicy !== 'staged' || facts.guarded !== false
    || facts.executionHandoverPending !== false || !plain(facts.observedClaim) || facts.observedClaim.claimId !== facts.claimId
    || facts.observedClaim.fence !== facts.fence || facts.observedClaim.epoch !== facts.epoch || facts.observedClaim.expiresAt !== facts.claimExpiresAt
    || !Number.isSafeInteger(now) || !(at(facts.observedAt) <= now) || now - at(facts.observedAt) > 30_000 || !(at(facts.claimExpiresAt) > now)) return false;
  if (batchClaim && !sameClaimGeneration(facts.observedClaim, batchClaim)) return false;
  const { observationSha256, ...body } = facts;
  return sha.test(observationSha256 ?? '') && digest(body) === observationSha256;
}

// The one admission check of the Linux scanner adapters and the bridge v4 protocol (replaces the three
// per-adapter v1 validateAdmission copies). A scanner stage's admission is always made under the batch
// claim recorded by stage 1, so batchClaimBound is required and must name the observed claim; a caller
// that already holds the run's generation passes it as batchClaim (renewal = same generation).
export function validateFormalAdmissionV2(job, a, now = Date.now(), { batchClaim = null } = {}) {
  const generation = v => plain(v) && Object.keys(v).sort().join('|') === 'claimId|epoch|fence';
  if (!plain(a) || Object.keys(a).sort().join('|') !== [...ADMISSION_FIELDS_V2].sort().join('|') || a.domain !== 'production'
    || !generation(a.batchClaimBound) || !sameClaimGeneration(a.observedClaim, a.batchClaimBound)
    || !admittedFactsMatchJobV2(a, job, now, { batchClaim })) {
    throw Object.assign(new Error('FRESH_COMPLETE_NATIVE_ADMISSION_REQUIRED'), { code: 'FRESH_COMPLETE_NATIVE_ADMISSION_REQUIRED' });
  }
  return a;
}
