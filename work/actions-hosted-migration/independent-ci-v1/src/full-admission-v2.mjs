// Full Native admission for job contract v2 (DESIGN S6, claim decoupling A-strict).
//
// Identical evaluator, door and freshness rules as full-admission.mjs (v1, unchanged), with one
// change of source for the claim: v1 required the PR trailer and Native to name the claim pinned in
// the job; v2 resolves the claim live from the PR trailer (body, then head commit), lets the
// existing evaluator perform the complete Native door for it, and then requires Native to be
// internally consistent about that claim (claim id, fence, epoch, ACTIVE, bound PR, lease left).
// Inside one batch the caller passes the sticky batch claim (batch-claim-v2.mjs): a different claim
// id, fence or epoch fails closed (a renewal, which only moves expires_at, does not).
// Active guarded claims additionally bind the real private head authorization;
// staged guarded claims and every pending handover remain refused. Publication
// still needs its separately qualified Native ticket port.
import fs from 'node:fs';
import path from 'node:path';
import { digest } from './proof.mjs';
import { freshStamp, serverAnswerCurrent, retainServerAnswerForFacts } from './clock-skew.mjs';
import { validateJobV2, claimGeneration, sameClaimGeneration, prBaseAcceptedV2 } from './job-v2.mjs';
import { isCurrentMergeQueueHeadV2 } from './independent-control-checks-v2/queue-facts.mjs';
import { evaluate, githubJson, parseClaimReference, VERIFY_RPC } from '../../../../scripts/ci/clued-work-admission.mjs';

import { FULL_ADMISSION_CONTRACT_V2, FULL_ADMISSION_CONTRACT_V3, supportedNativeExecution, ownerKind, reasonCodes, sanitizeAdmissionDiagnosticV2, sanitizeSchedulingV2, schedulingFactsV2, verdict } from './admission-facts-v2.mjs';
const REPO = 'tdoljyj/cross-memory-system';
const ENGINE = 'scripts/ci/clued-work-admission.mjs#evaluate';
const VARIABLE = 'CLUED_MERGE_ADMISSION_STATE';
const CORE = new URL('../../../../scripts/ci/clued-work-admission.mjs', import.meta.url);
const sha = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const at = value => typeof value === 'string' ? Date.parse(value) : NaN;
const fresh = (value, now) => freshStamp(at(value), now);
const FAILURE_REASONS = new Set(['not_configured', 'subject_invalid', 'source_changed', 'clock_invalid', 'mode_unknown',
  'principal_unknown', 'observer_unknown', 'subject_changed', 'claim_changed', 'claim_missing', 'observation_expired', 'rejected',
  'native_unsupported', 'native_changed', 'incomplete', 'unavailable'].map(value => `full_admission_${value}`));
const rejectionDiagnostic = (outcome, native, extra = {}) => ({ verdict: verdict(outcome?.verdict), reasonCodes: reasonCodes(outcome?.reasons),
  nativeVerdict: verdict(native?.verdict), nativeReasonCodes: reasonCodes(native?.reasons), ownerReviewKind: ownerKind(outcome?.owner_review?.kind),
  workflowGateFindingsPresent: Array.isArray(outcome?.workflow_gate_findings) && outcome.workflow_gate_findings.length > 0,
  ...schedulingFactsV2(outcome, native, REPO), ...extra });

// Diagnostics contain only fixed enums, booleans, an ISO time and small integers; no remote text, claim, path or
// credential (admission-facts-v2.mjs#sanitizeAdmissionDiagnosticV2).
export function fullAdmissionFailureV2(facts) {
  if (facts?.contract !== FULL_ADMISSION_CONTRACT_V2 || facts.status !== 'BLOCKED' || facts.admitted !== false || !FAILURE_REASONS.has(facts.reason)) return null;
  const diagnostic = sanitizeAdmissionDiagnosticV2(facts.diagnostic);
  return { reason: facts.reason, ...(diagnostic ? { admissionDiagnostic: diagnostic } : {}) };
}
const blocked = (reason, diagnostic) => Object.freeze({ contract: FULL_ADMISSION_CONTRACT_V2, status: 'BLOCKED', admitted: false, reason, ...(diagnostic ? { diagnostic } : {}) });

function packetValid(job, packet) {
  return plain(packet) && Object.keys(packet).length === 5 && packet.complete === true && packet.pr === job.pr
    && packet.headSha === job.headSha && packet.baseSha === job.baseSha && Array.isArray(packet.paths)
    && packet.paths.length > 0 && packet.paths.length <= 3000 && new Set(packet.paths).size === packet.paths.length
    && packet.paths.every(value => typeof value === 'string' && value.length > 0 && value.length <= 4096
      && !/[\x00-\x1f\\:]/.test(value) && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..'));
}
// The PR's base.sha: the batch base for a batch that tests the head; for a train front batch (S != H) the commit GitHub
// reads, which every read of one admission must report alike (`base`: the first read's; design v0.5 §5.7).
function samePr(pr, job, base = null) {
  return pr?.number === job.pr && pr.state === 'open' && pr.head?.sha === job.headSha && prBaseAcceptedV2(job, pr.base?.sha)
    && (base === null || pr.base.sha === base)
    && pr.head.repo?.full_name === job.repo && pr.base.repo?.full_name === job.repo && pr.base.ref === 'main';
}
const batchClaimValid = c => c === null || c === undefined || (plain(c) && uuid.test(c.claimId ?? '') && Number.isSafeInteger(c.fence) && c.fence > 0
  && Number.isSafeInteger(c.epoch) && c.epoch > 0);

// All providers are installed protected controller ports, never PR data. options.batchClaim is the
// batch's sticky claim generation (null only for the batch's first admission, stage 1). options.scheduling
// (optional) receives the scheduling facts (schedulingFactsV2) of every evaluation that reached Native,
// admitted or not; it is told, never asked, and nothing it does can change the admission.
export function createFullAdmissionPortV2({ protectedConfig, tokenProvider, modeProvider, recorderProvider,
  fetchImpl = globalThis.fetch, clock = Date.now, monotonic = () => performance.now(), fixtureHooks = null } = {}) {
  const config = plain(protectedConfig) ? structuredClone(protectedConfig) : null;
  const configured = config && ['production', 'fixture'].includes(config.domain) && config.repository === REPO
    && config.finiteFirstRun !== true && config.observationOnly !== true
    && (config.scope === 'global' || /^project:[a-f0-9-]{36}$/.test(config.scope))
    && path.isAbsolute(config.workspace ?? '') && sha.test(config.sourceManifestSha256 ?? '')
    && sha.test(config.evaluatorSha256 ?? '') && sha.test(config.policySha256 ?? '')
    && typeof config.policyText === 'string' && digest(config.policyText) === config.policySha256
    && uuid.test(config.ciPrincipalBindingId ?? '') && typeof config.ciPrincipalQualificationRef === 'string'
    && config.ciPrincipalQualificationRef.length > 0 && typeof config.publishableKey === 'string'
    && /^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey) && (() => {
      try { const url = new URL(config.supabaseUrl); return url.protocol === 'https:' && !url.username && !url.password
        && !url.search && !url.hash && !url.port && ['', '/'].includes(url.pathname); } catch { return false; }
    })();
  // The evaluator source is pinned by hash. Only the fixture domain may inject a reader/evaluator
  // (unit tests); production always hashes and runs the installed scripts/ci evaluator.
  const hooks = config?.domain === 'fixture' && plain(fixtureHooks) ? fixtureHooks : {};
  const evaluatorBytes = typeof hooks.evaluatorReader === 'function' ? hooks.evaluatorReader : () => fs.readFileSync(CORE, 'utf8');
  const evaluateImpl = typeof hooks.evaluateImpl === 'function' ? hooks.evaluateImpl : evaluate;
  return Object.freeze({
    fixture: config?.domain === 'fixture',
    async evaluatePr(job, packet, options = {}) {
      if (!configured || typeof tokenProvider !== 'function' || typeof recorderProvider !== 'function'
        || typeof fetchImpl !== 'function' || typeof clock !== 'function') return blocked('full_admission_not_configured');
      let phase = 'mode';
      try {
        validateJobV2(job);
        const batchClaim = options?.batchClaim ?? null;
        if (!plain(options) || Object.keys(options).some(k => !['batchClaim', 'scheduling'].includes(k)) || !batchClaimValid(batchClaim)
          || !(options.scheduling === undefined || typeof options.scheduling === 'function')) return blocked('full_admission_subject_invalid');
        const tell = (outcome, native) => { try { options.scheduling?.(Object.freeze(sanitizeSchedulingV2(schedulingFactsV2(outcome, native, REPO)))); } catch { /* told, never asked */ } };
        if (job.repo !== config.repository || job.sourceManifestSha256 !== config.sourceManifestSha256 || !packetValid(job, packet)) return blocked('full_admission_subject_invalid');
        if (digest(evaluatorBytes()) !== config.evaluatorSha256) return blocked('full_admission_source_changed');
        const started = clock();
        if (!Number.isSafeInteger(started)) return blocked('full_admission_clock_invalid');
        const mode = typeof modeProvider === 'function' ? await modeProvider() : config.modeObservation;
        const modeReturnedAt = clock();
        if (!plain(mode) || mode.complete !== true || mode.repository !== REPO || mode.variable !== VARIABLE
          || mode.source !== 'github-repository-variables' || typeof mode.exists !== 'boolean'
          || !Number.isSafeInteger(modeReturnedAt) || modeReturnedAt < started
          || !fresh(mode.observedAt, modeReturnedAt) || typeof mode.proofRef !== 'string' || !mode.proofRef
          || (mode.exists && typeof mode.value !== 'string')) return blocked('full_admission_mode_unknown');
        phase = 'principal'; const credentials = await tokenProvider();
        if (!plain(credentials) || typeof credentials.githubToken !== 'string' || !credentials.githubToken
          || !/^clued_bnd_[A-Za-z0-9_-]{8,480}$/.test(credentials.ciAdmissionToken ?? '')
          || credentials.ciPrincipalBindingId !== config.ciPrincipalBindingId
          || credentials.ciPrincipalQualificationRef !== config.ciPrincipalQualificationRef) return blocked('full_admission_principal_unknown');
        phase = 'observer'; const observation = await recorderProvider({ repository: REPO, jobId: job.id, domain: config.domain });
        const recorderReturnedAt = clock();
        const baseRecorder = observation?.recorder;
        if (observation?.kind !== 'independent-controller' || observation.domain !== config.domain
          || !Number.isSafeInteger(recorderReturnedAt) || recorderReturnedAt < modeReturnedAt
          || !fresh(observation.observedAt, recorderReturnedAt) || typeof observation.observationRef !== 'string' || !observation.observationRef
          || typeof baseRecorder?.newId !== 'function' || typeof baseRecorder?.record !== 'function') return blocked('full_admission_observer_unknown');
        const env = { GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: credentials.githubToken,
          CLUED_CONTEXT_READ_TOKEN: credentials.ciAdmissionToken, CLUED_SUPABASE_URL: config.supabaseUrl,
          CLUED_SUPABASE_PUBLISHABLE_KEY: config.publishableKey, [VARIABLE]: mode.exists ? mode.value : '' };
        phase = 'pull_request'; const pr = await githubJson(fetchImpl, env, `/repos/${REPO}/pulls/${job.pr}`);
        if (!samePr(pr, job)) return blocked('full_admission_subject_changed');
        const prBase = pr.base.sha;
        // A-strict: the claim is whatever the PR names NOW (body trailer, else head commit trailer).
        phase = 'claim_reference'; let reference = parseClaimReference(pr.body);
        if (!reference) reference = parseClaimReference((await githubJson(fetchImpl, env, `/repos/${REPO}/commits/${job.headSha}`))?.commit?.message);
        if (!reference || !uuid.test(reference.claim_id ?? '')) return blocked('full_admission_claim_missing');
        if (reference.scope !== config.scope || (batchClaim && reference.claim_id !== batchClaim.claimId)) return blocked('full_admission_claim_changed');
        // The age of Native's answer is measured on this host's monotonic clock from the send of its verify call
        // (Decision 1100a0ed); without a seen send, from the start of the evaluation, which is earlier.
        let native = null, nativeSentMono = null, verifySentMono = null;
        const evaluateStartMono = monotonic();
        const timedFetch = (url, opts) => { if (String(url).endsWith(`/rest/v1/rpc/${VERIFY_RPC}`)) verifySentMono = monotonic(); return fetchImpl(url, opts); };
        const recorder = { newId: () => baseRecorder.newId(), record(kind, data) {
          baseRecorder.record(kind, data);
          if (kind === 'claim_verification') { native = structuredClone(data.result?.payload); nativeSentMono = verifySentMono ?? evaluateStartMono; }
        } };
        phase = 'evaluate'; const outcome = await evaluateImpl({ env, event: { pull_request: pr }, eventName: 'pull_request', fetchImpl: timedFetch,
          workspace: config.workspace, withSummary: false, readPolicyFile: () => config.policyText,
          observation_recorder: recorder, observation_entry: 'independent_pr' });
        phase = 'post_evaluate'; tell(outcome, native); const finished = clock(), prRef = `${REPO}#${job.pr}`;
        if (!Number.isSafeInteger(finished) || finished < started || !fresh(mode.observedAt, finished)
          || !fresh(observation.observedAt, finished)) return blocked('full_admission_observation_expired', rejectionDiagnostic(outcome, native, { modeFresh: fresh(mode.observedAt, finished), recorderFresh: fresh(observation.observedAt, finished) }));
        if (outcome.admitted !== true || outcome.verdict !== 'ADMITTED') return blocked('full_admission_rejected', rejectionDiagnostic(outcome, native));
        phase = 'post_pull_request';
        if (outcome.head_sha !== job.headSha || outcome.base_sha !== prBase || outcome.pr_ref !== prRef
          || outcome.claim_id !== reference.claim_id || outcome.scope !== config.scope
          || digest([...outcome.changed_paths].sort()) !== digest([...packet.paths].sort())
          || !samePr(await githubJson(fetchImpl, env, `/repos/${REPO}/pulls/${job.pr}`), job, prBase)) return blocked('full_admission_subject_changed');
        phase = 'native'; const claim = native?.claim;
        if (native?.status !== 'ok' || native.verdict !== 'ADMITTED' || native.execution_authorized !== true
          || !supportedNativeExecution(native.execution_policy, claim?.lease_key_required)
          || (claim.lease_key_required && !uuid.test(native.head_authorization_id ?? ''))
          || claim.execution_handover_pending !== false) return blocked('full_admission_native_unsupported');
        // Native must be internally consistent about the claim the PR names now.
        if (claim.claim_id !== reference.claim_id || native.current_fence !== claim.fence || native.execution_epoch !== claim.execution_epoch
          || !Number.isSafeInteger(claim.fence) || claim.fence < 1 || !Number.isSafeInteger(claim.execution_epoch) || claim.execution_epoch < 1
          || claim.context_key !== config.scope || claim.status !== 'ACTIVE' || claim.bound_pr !== prRef || native.bound_pr !== prRef
          || native.pr_ref !== prRef || native.head_sha !== job.headSha || native.base_sha !== prBase
          || serverAnswerCurrent({ verifiedAt: native.verified_at, expiresAt: claim.expires_at, sentMono: nativeSentMono ?? evaluateStartMono, nowMono: monotonic() }).length
          || !Array.isArray(native.paths_outside_write_set)
          || native.paths_outside_write_set.length) return blocked('full_admission_native_changed');
        const observedClaim = { claimId: claim.claim_id, fence: claim.fence, epoch: claim.execution_epoch, expiresAt: claim.expires_at };
        // Batch stickiness: one claim generation per batch (a renewal keeps the generation).
        if (batchClaim && !sameClaimGeneration(observedClaim, batchClaim)) return blocked('full_admission_claim_changed');
        if (!plain(outcome.admission_mode) || !plain(outcome.merge_slot)
          || !['normal', 'efficiency', 'frozen'].includes(outcome.admission_mode.state)) return blocked('full_admission_incomplete');
        const active = native.execution_policy === 'active';
        const facts = { contract: active ? FULL_ADMISSION_CONTRACT_V3 : FULL_ADMISSION_CONTRACT_V2, status: 'ADMITTED', admitted: true,
          completeAdmission: true, evaluator: ENGINE, domain: config.domain, repository: REPO, scope: config.scope,
          prRef, headSha: job.headSha, baseSha: job.baseSha, jobId: job.id, role: job.role, attempt: job.attempt,
          claimId: observedClaim.claimId, fence: observedClaim.fence, epoch: observedClaim.epoch, observedClaim,
          batchClaimBound: batchClaim ? claimGeneration(batchClaim) : null,
          sourceManifestSha256: job.sourceManifestSha256, executionPolicy: native.execution_policy, guarded: claim.lease_key_required, executionHandoverPending: claim.execution_handover_pending,
          ...(active ? { publicationRequired: true, headAuthorizationId: claim.lease_key_required ? native.head_authorization_id : null } : {}),
          mergeQueueHead: isCurrentMergeQueueHeadV2(claim, observedClaim, job, finished),
          mode: { state: outcome.admission_mode.state, layer: outcome.admission_mode.layer, policyVersion: outcome.admission_mode.policy_version },
          mergeSlot: structuredClone(outcome.merge_slot), ownerReview: outcome.owner_review ? {
            kind: outcome.owner_review.kind, grantId: outcome.owner_review.grant_id, carriedFrom: outcome.owner_review.carried_from ?? null } : null,
          workflowGateFindings: [...(outcome.workflow_gate_findings ?? [])], observedAt: new Date(finished).toISOString(),
          claimExpiresAt: claim.expires_at, modeProofRef: mode.proofRef, observationRef: observation.observationRef,
          packetSha256: digest(packet), evaluationSha256: digest(outcome) };
        return retainServerAnswerForFacts(Object.freeze({ ...facts, observationSha256: digest(facts) }),
          { verifiedAt: native.verified_at, expiresAt: claim.expires_at, sentMono: nativeSentMono ?? evaluateStartMono }, monotonic);
      } catch { return blocked('full_admission_unavailable', { phase }); }
    },
  });
}

export { FULL_ADMISSION_CONTRACT_V2, FULL_ADMISSION_CONTRACT_V3, ADMISSION_FIELDS_V2, ADMISSION_FIELDS_V3, supportedNativeExecution, admittedFactsMatchJobV2, sanitizeAdmissionDiagnosticV2, sanitizeSchedulingV2, schedulingFactsV2 } from './admission-facts-v2.mjs';
