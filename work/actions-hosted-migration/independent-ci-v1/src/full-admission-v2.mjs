// Full Native admission for job contract v2 (DESIGN S6, claim decoupling A-strict).
//
// Identical evaluator, door and freshness rules as full-admission.mjs (v1, unchanged), with one
// change of source for the claim: v1 required the PR trailer and Native to name the claim pinned in
// the job; v2 resolves the claim live from the PR trailer (body, then head commit), lets the
// existing evaluator perform the complete Native door for it, and then requires Native to be
// internally consistent about that claim (claim id, fence, epoch, ACTIVE, bound PR, lease left).
// Inside one batch the caller passes the sticky batch claim (batch-claim-v2.mjs): a different claim
// id, fence or epoch fails closed (a renewal, which only moves expires_at, does not).
// No gate is relaxed: guarded claims (lease_key_required) and pending handovers are still refused.
import fs from 'node:fs';
import path from 'node:path';
import { digest } from './proof.mjs';
import { validateJobV2, claimGeneration, sameClaimGeneration } from './job-v2.mjs';
import { isCurrentMergeQueueHeadV2 } from './independent-control-checks-v2/queue-facts.mjs';
import { evaluate, githubJson, parseClaimReference } from '../../../../scripts/ci/clued-work-admission.mjs';

export const FULL_ADMISSION_CONTRACT_V2 = 'clued.independent-ci.full-admission/2';
const REPO = 'tdoljyj/cross-memory-system';
const ENGINE = 'scripts/ci/clued-work-admission.mjs#evaluate';
const VARIABLE = 'CLUED_MERGE_ADMISSION_STATE';
const CORE = new URL('../../../../scripts/ci/clued-work-admission.mjs', import.meta.url);
const sha = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const at = value => typeof value === 'string' ? Date.parse(value) : NaN;
const fresh = (value, now) => Number.isFinite(at(value)) && at(value) <= now && now - at(value) <= 30_000;
const FAILURE_REASONS = new Set(['not_configured', 'subject_invalid', 'source_changed', 'clock_invalid', 'mode_unknown',
  'principal_unknown', 'observer_unknown', 'subject_changed', 'claim_changed', 'claim_missing', 'observation_expired', 'rejected',
  'native_unsupported', 'native_changed', 'incomplete', 'unavailable'].map(value => `full_admission_${value}`));
const REASON_CODES = new Set(['claim_trailer_missing', 'claim_not_found', 'claim_not_current', 'fence_superseded',
  'copy_not_adopted', 'claim_bound_to_other_pr', 'claim_head_cap_reached', 'task_ci_head_cap_reached', 'work_claim_conflict',
  'path_outside_write_set', 'paths_outside_write_set', 'head_budget_exhausted', 'ci_budget_exhausted', 'merge_slot_required',
  'merge_slot_missing', 'owner_grant_required', 'owner_grant_missing', 'owner_grant_revoked', 'owner_grant_expired',
  'admission_binding_required', 'authorization_revoked_or_expired', 'binding_not_authorized', 'resource_action_not_authorized',
  'evaluation_not_completed', 'workflow_change_not_authorized', 'workflow_missing_admission_gate', 'work_claim_execution_epoch_stale']);
const REASON_PREFIXES = Object.freeze({ 'changed_files_truncated:': 'changed_files_truncated', 'claim_base_unknown:': 'claim_base_unknown',
  'workflow_gate:': 'workflow_gate', 'policy_file_removed:': 'policy_file_removed', 'policy_file_invalid:': 'policy_file_invalid',
  'protected_change_not_up_to_date:': 'protected_change_not_up_to_date', 'owner_review_required (': 'owner_review_required',
  'owner_review_unavailable:': 'owner_review_unavailable', 'workflow runs unavailable:': 'workflow_runs_unavailable' });
const DIAGNOSTIC_CODES = new Set([...REASON_CODES, ...Object.values(REASON_PREFIXES), 'unknown_reason']);
const verdict = value => ['ADMITTED', 'REJECTED', 'ERROR', 'PR_NOT_OPEN', 'NOT_APPLICABLE'].includes(value) ? value : 'UNKNOWN';
const ownerKind = value => ['granted', 'pending', 'transient', 'rpc_unavailable', 'refused'].includes(value) ? value : 'UNKNOWN';
const reasonCodes = values => [...new Set((Array.isArray(values) ? values.slice(0, 64) : []).map(value => {
  if (REASON_CODES.has(value)) return value;
  return typeof value === 'string' ? Object.entries(REASON_PREFIXES).find(([prefix]) => value.startsWith(prefix))?.[1] ?? 'unknown_reason' : 'unknown_reason';
}))].sort();
const rejectionDiagnostic = (outcome, native, extra = {}) => ({ verdict: verdict(outcome?.verdict), reasonCodes: reasonCodes(outcome?.reasons),
  nativeVerdict: verdict(native?.verdict), nativeReasonCodes: reasonCodes(native?.reasons), ownerReviewKind: ownerKind(outcome?.owner_review?.kind),
  workflowGateFindingsPresent: Array.isArray(outcome?.workflow_gate_findings) && outcome.workflow_gate_findings.length > 0, ...extra });

// Diagnostics contain only fixed enums and booleans; no remote text, claim, path or credential.
export function fullAdmissionFailureV2(facts) {
  if (facts?.contract !== FULL_ADMISSION_CONTRACT_V2 || facts.status !== 'BLOCKED' || facts.admitted !== false || !FAILURE_REASONS.has(facts.reason)) return null;
  const d = facts.diagnostic, diagnostic = {};
  if (plain(d)) {
    diagnostic.verdict = verdict(d.verdict); diagnostic.nativeVerdict = verdict(d.nativeVerdict); diagnostic.ownerReviewKind = ownerKind(d.ownerReviewKind);
    for (const field of ['reasonCodes', 'nativeReasonCodes']) diagnostic[field] = [...new Set((Array.isArray(d[field]) ? d[field].slice(0, 64) : []).map(value => DIAGNOSTIC_CODES.has(value) ? value : 'unknown_reason'))].sort();
    for (const field of ['workflowGateFindingsPresent', 'modeFresh', 'recorderFresh']) if (typeof d[field] === 'boolean') diagnostic[field] = d[field];
    if (['mode', 'principal', 'observer', 'pull_request', 'claim_reference', 'evaluate', 'post_evaluate', 'post_pull_request', 'native'].includes(d.phase)) diagnostic.phase = d.phase;
  }
  return { reason: facts.reason, ...(Object.keys(diagnostic).length ? { admissionDiagnostic: diagnostic } : {}) };
}
const blocked = (reason, diagnostic) => Object.freeze({ contract: FULL_ADMISSION_CONTRACT_V2, status: 'BLOCKED', admitted: false, reason, ...(diagnostic ? { diagnostic } : {}) });

function packetValid(job, packet) {
  return plain(packet) && Object.keys(packet).length === 5 && packet.complete === true && packet.pr === job.pr
    && packet.headSha === job.headSha && packet.baseSha === job.baseSha && Array.isArray(packet.paths)
    && packet.paths.length > 0 && packet.paths.length <= 3000 && new Set(packet.paths).size === packet.paths.length
    && packet.paths.every(value => typeof value === 'string' && value.length > 0 && value.length <= 4096
      && !/[\x00-\x1f\\:]/.test(value) && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..'));
}
function samePr(pr, job) {
  return pr?.number === job.pr && pr.state === 'open' && pr.head?.sha === job.headSha && pr.base?.sha === job.baseSha
    && pr.head.repo?.full_name === job.repo && pr.base.repo?.full_name === job.repo && pr.base.ref === 'main';
}
const batchClaimValid = c => c === null || c === undefined || (plain(c) && uuid.test(c.claimId ?? '') && Number.isSafeInteger(c.fence) && c.fence > 0
  && Number.isSafeInteger(c.epoch) && c.epoch > 0);

// All providers are installed protected controller ports, never PR data. options.batchClaim is the
// batch's sticky claim generation (null only for the batch's first admission, stage 1).
export function createFullAdmissionPortV2({ protectedConfig, tokenProvider, modeProvider, recorderProvider,
  fetchImpl = globalThis.fetch, clock = Date.now, fixtureHooks = null } = {}) {
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
        if (!plain(options) || Object.keys(options).some(k => k !== 'batchClaim') || !batchClaimValid(batchClaim)) return blocked('full_admission_subject_invalid');
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
        // A-strict: the claim is whatever the PR names NOW (body trailer, else head commit trailer).
        phase = 'claim_reference'; let reference = parseClaimReference(pr.body);
        if (!reference) reference = parseClaimReference((await githubJson(fetchImpl, env, `/repos/${REPO}/commits/${job.headSha}`))?.commit?.message);
        if (!reference || !uuid.test(reference.claim_id ?? '')) return blocked('full_admission_claim_missing');
        if (reference.scope !== config.scope || (batchClaim && reference.claim_id !== batchClaim.claimId)) return blocked('full_admission_claim_changed');
        let native = null;
        const recorder = { newId: () => baseRecorder.newId(), record(kind, data) {
          baseRecorder.record(kind, data);
          if (kind === 'claim_verification') native = structuredClone(data.result?.payload);
        } };
        phase = 'evaluate'; const outcome = await evaluateImpl({ env, event: { pull_request: pr }, eventName: 'pull_request', fetchImpl,
          workspace: config.workspace, withSummary: false, readPolicyFile: () => config.policyText,
          observation_recorder: recorder, observation_entry: 'independent_pr' });
        phase = 'post_evaluate'; const finished = clock(), prRef = `${REPO}#${job.pr}`;
        if (!Number.isSafeInteger(finished) || finished < started || !fresh(mode.observedAt, finished)
          || !fresh(observation.observedAt, finished)) return blocked('full_admission_observation_expired', rejectionDiagnostic(outcome, native, { modeFresh: fresh(mode.observedAt, finished), recorderFresh: fresh(observation.observedAt, finished) }));
        if (outcome.admitted !== true || outcome.verdict !== 'ADMITTED') return blocked('full_admission_rejected', rejectionDiagnostic(outcome, native));
        phase = 'post_pull_request';
        if (outcome.head_sha !== job.headSha || outcome.base_sha !== job.baseSha || outcome.pr_ref !== prRef
          || outcome.claim_id !== reference.claim_id || outcome.scope !== config.scope
          || digest([...outcome.changed_paths].sort()) !== digest([...packet.paths].sort())
          || !samePr(await githubJson(fetchImpl, env, `/repos/${REPO}/pulls/${job.pr}`), job)) return blocked('full_admission_subject_changed');
        phase = 'native'; const claim = native?.claim;
        if (native?.status !== 'ok' || native.verdict !== 'ADMITTED' || native.execution_authorized !== true
          || native.execution_policy !== 'staged' || claim?.lease_key_required !== false
          || claim.execution_handover_pending !== false) return blocked('full_admission_native_unsupported');
        // Native must be internally consistent about the claim the PR names now.
        if (claim.claim_id !== reference.claim_id || native.current_fence !== claim.fence || native.execution_epoch !== claim.execution_epoch
          || !Number.isSafeInteger(claim.fence) || claim.fence < 1 || !Number.isSafeInteger(claim.execution_epoch) || claim.execution_epoch < 1
          || claim.context_key !== config.scope || claim.status !== 'ACTIVE' || claim.bound_pr !== prRef || native.bound_pr !== prRef
          || native.pr_ref !== prRef || native.head_sha !== job.headSha || native.base_sha !== job.baseSha || !fresh(native.verified_at, finished)
          || !(at(claim.expires_at) > finished) || !Array.isArray(native.paths_outside_write_set)
          || native.paths_outside_write_set.length) return blocked('full_admission_native_changed');
        const observedClaim = { claimId: claim.claim_id, fence: claim.fence, epoch: claim.execution_epoch, expiresAt: claim.expires_at };
        // Batch stickiness: one claim generation per batch (a renewal keeps the generation).
        if (batchClaim && !sameClaimGeneration(observedClaim, batchClaim)) return blocked('full_admission_claim_changed');
        if (!plain(outcome.admission_mode) || !plain(outcome.merge_slot)
          || !['normal', 'efficiency', 'frozen'].includes(outcome.admission_mode.state)) return blocked('full_admission_incomplete');
        const facts = { contract: FULL_ADMISSION_CONTRACT_V2, status: 'ADMITTED', admitted: true,
          completeAdmission: true, evaluator: ENGINE, domain: config.domain, repository: REPO, scope: config.scope,
          prRef, headSha: job.headSha, baseSha: job.baseSha, jobId: job.id, role: job.role, attempt: job.attempt,
          claimId: observedClaim.claimId, fence: observedClaim.fence, epoch: observedClaim.epoch, observedClaim,
          batchClaimBound: batchClaim ? claimGeneration(batchClaim) : null,
          sourceManifestSha256: job.sourceManifestSha256, executionPolicy: native.execution_policy, guarded: claim.lease_key_required, executionHandoverPending: claim.execution_handover_pending,
          mergeQueueHead: isCurrentMergeQueueHeadV2(claim, observedClaim, job, finished),
          mode: { state: outcome.admission_mode.state, layer: outcome.admission_mode.layer, policyVersion: outcome.admission_mode.policy_version },
          mergeSlot: structuredClone(outcome.merge_slot), ownerReview: outcome.owner_review ? {
            kind: outcome.owner_review.kind, grantId: outcome.owner_review.grant_id, carriedFrom: outcome.owner_review.carried_from ?? null } : null,
          workflowGateFindings: [...(outcome.workflow_gate_findings ?? [])], observedAt: new Date(finished).toISOString(),
          claimExpiresAt: claim.expires_at, modeProofRef: mode.proofRef, observationRef: observation.observationRef,
          packetSha256: digest(packet), evaluationSha256: digest(outcome) };
        return Object.freeze({ ...facts, observationSha256: digest(facts) });
      } catch { return blocked('full_admission_unavailable', { phase }); }
    },
  });
}

// Shared validation of admitted v2 facts for every consumer (publishers, bridge, adapters).
export const ADMISSION_FIELDS_V2 = Object.freeze(['contract', 'status', 'admitted', 'completeAdmission', 'evaluator', 'domain', 'repository', 'scope',
  'prRef', 'headSha', 'baseSha', 'jobId', 'role', 'attempt', 'claimId', 'fence', 'epoch', 'observedClaim', 'batchClaimBound', 'sourceManifestSha256',
  'executionPolicy', 'guarded', 'executionHandoverPending', 'mergeQueueHead', 'mode', 'mergeSlot', 'ownerReview', 'workflowGateFindings', 'observedAt',
  'claimExpiresAt', 'modeProofRef', 'observationRef', 'packetSha256', 'evaluationSha256', 'observationSha256']);
export function admittedFactsMatchJobV2(facts, job, now, { batchClaim = null } = {}) {
  if (!plain(facts) || facts.contract !== FULL_ADMISSION_CONTRACT_V2 || facts.status !== 'ADMITTED' || facts.admitted !== true || facts.completeAdmission !== true
    || facts.evaluator !== ENGINE || facts.repository !== job.repo || facts.prRef !== `${job.repo}#${job.pr}` || facts.headSha !== job.headSha
    || facts.baseSha !== job.baseSha || facts.jobId !== job.id || facts.role !== job.role || facts.attempt !== job.attempt
    || facts.sourceManifestSha256 !== job.sourceManifestSha256 || facts.executionPolicy !== 'staged' || facts.guarded !== false
    || facts.executionHandoverPending !== false || !plain(facts.observedClaim) || facts.observedClaim.claimId !== facts.claimId
    || facts.observedClaim.fence !== facts.fence || facts.observedClaim.epoch !== facts.epoch || facts.observedClaim.expiresAt !== facts.claimExpiresAt
    || !Number.isSafeInteger(now) || !(at(facts.observedAt) <= now) || now - at(facts.observedAt) > 30_000 || !(at(facts.claimExpiresAt) > now)) return false;
  if (batchClaim && !sameClaimGeneration(facts.observedClaim, batchClaim)) return false;
  const { observationSha256, ...body } = facts;
  return sha.test(observationSha256 ?? '') && digest(body) === observationSha256;
}
