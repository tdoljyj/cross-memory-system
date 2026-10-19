import {isCurrentMergeQueueHead} from './independent-control-checks-v1/queue-facts.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { validateJob } from './queue.mjs';
import { digest } from './proof.mjs';
import { evaluate, githubJson, parseClaimReference } from '../../../../scripts/ci/clued-work-admission.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const ENGINE = 'scripts/ci/clued-work-admission.mjs#evaluate';
const VARIABLE = 'CLUED_MERGE_ADMISSION_STATE';
const CORE = new URL('../../../../scripts/ci/clued-work-admission.mjs', import.meta.url);
const sha = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const at = value => typeof value === 'string' ? Date.parse(value) : NaN;
const fresh = (value, now) => Number.isFinite(at(value)) && at(value) <= now && now - at(value) <= 30_000;
const blocked = reason => Object.freeze({ contract: 'clued.independent-ci.full-admission/1', status: 'BLOCKED', admitted: false, reason });

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

// All providers below are installed protected controller ports, never PR data.
// The existing evaluator owns layer, workflow, Owner and merge-slot decisions.
// This adapter supplies a truthful independent observation and verifies its
// subject; it creates no Actions run identity, publication ticket or qualification.
export function createFullAdmissionPort({ protectedConfig, tokenProvider, modeProvider, recorderProvider,
  fetchImpl = globalThis.fetch, clock = Date.now } = {}) {
  const config = plain(protectedConfig) ? structuredClone(protectedConfig) : null;
  // A finite first run observes the real designated role and full Native door;
  // it cannot provide publication authorization or pre-issue Host qualification.
  const observationOnly = config?.finiteFirstRun === true && config?.observationOnly === true;
  const principalRefField = observationOnly ? 'ciPrincipalRoleRef' : 'ciPrincipalQualificationRef';
  const finiteFlagsValid = observationOnly || config?.finiteFirstRun !== true && config?.observationOnly !== true;
  const configured = config && ['production', 'fixture'].includes(config.domain) && config.repository === REPO
    && finiteFlagsValid
    && (config.scope === 'global' || /^project:[a-f0-9-]{36}$/.test(config.scope))
    && path.isAbsolute(config.workspace ?? '') && sha.test(config.sourceManifestSha256 ?? '')
    && sha.test(config.evaluatorSha256 ?? '') && sha.test(config.policySha256 ?? '')
    && typeof config.policyText === 'string' && digest(config.policyText) === config.policySha256
    && uuid.test(config.ciPrincipalBindingId ?? '') && typeof config[principalRefField] === 'string'
    && config[principalRefField].length > 0 && typeof config.publishableKey === 'string'
    && /^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey) && (() => {
      try { const url = new URL(config.supabaseUrl); return url.protocol === 'https:' && !url.username && !url.password
        && !url.search && !url.hash && !url.port && ['', '/'].includes(url.pathname); } catch { return false; }
    })();
  return Object.freeze({
    fixture: config?.domain === 'fixture',
    async evaluatePr(job, packet) {
      if (!configured || typeof tokenProvider !== 'function' || typeof recorderProvider !== 'function'
        || typeof fetchImpl !== 'function' || typeof clock !== 'function') return blocked('full_admission_not_configured');
      try {
        validateJob(job);
        if (job.repo !== config.repository || job.sourceManifestSha256 !== config.sourceManifestSha256 || !packetValid(job, packet)) return blocked('full_admission_subject_invalid');
        if (digest(fs.readFileSync(CORE, 'utf8')) !== config.evaluatorSha256) return blocked('full_admission_source_changed');
        const started = clock();
        if (!Number.isSafeInteger(started)) return blocked('full_admission_clock_invalid');
        const mode = typeof modeProvider === 'function' ? await modeProvider() : config.modeObservation;
        const modeReturnedAt = clock();
        if (!plain(mode) || mode.complete !== true || mode.repository !== REPO || mode.variable !== VARIABLE
          || mode.source !== 'github-repository-variables' || typeof mode.exists !== 'boolean'
          || !Number.isSafeInteger(modeReturnedAt) || modeReturnedAt < started
          || !fresh(mode.observedAt, modeReturnedAt) || typeof mode.proofRef !== 'string' || !mode.proofRef
          || (mode.exists && typeof mode.value !== 'string')) return blocked('full_admission_mode_unknown');
        const credentials = await tokenProvider();
        if (!plain(credentials) || typeof credentials.githubToken !== 'string' || !credentials.githubToken
          || !/^clued_bnd_[A-Za-z0-9_-]{8,480}$/.test(credentials.ciAdmissionToken ?? '')
          || credentials.ciPrincipalBindingId !== config.ciPrincipalBindingId
          || credentials[principalRefField] !== config[principalRefField]) return blocked('full_admission_principal_unknown');
        const observation = await recorderProvider({ repository: REPO, jobId: job.id, domain: config.domain });
        const recorderReturnedAt = clock();
        const baseRecorder = observation?.recorder;
        if (observation?.kind !== 'independent-controller' || observation.domain !== config.domain
          || !Number.isSafeInteger(recorderReturnedAt) || recorderReturnedAt < modeReturnedAt
          || !fresh(observation.observedAt, recorderReturnedAt) || typeof observation.observationRef !== 'string' || !observation.observationRef
          || typeof baseRecorder?.newId !== 'function' || typeof baseRecorder?.record !== 'function') return blocked('full_admission_observer_unknown');
        // These compatibility env keys carry real repository/config/credentials,
        // never a fabricated GITHUB_RUN_ID, GITHUB_ACTIONS or Actions event identity.
        const env = { GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: credentials.githubToken,
          CLUED_CONTEXT_READ_TOKEN: credentials.ciAdmissionToken, CLUED_SUPABASE_URL: config.supabaseUrl,
          CLUED_SUPABASE_PUBLISHABLE_KEY: config.publishableKey, [VARIABLE]: mode.exists ? mode.value : '' };
        const pr = await githubJson(fetchImpl, env, `/repos/${REPO}/pulls/${job.pr}`);
        if (!samePr(pr, job)) return blocked('full_admission_subject_changed');
        let reference = parseClaimReference(pr.body);
        if (!reference) reference = parseClaimReference((await githubJson(fetchImpl, env, `/repos/${REPO}/commits/${job.headSha}`))?.commit?.message);
        if (reference?.claim_id !== job.claimId || reference.scope !== config.scope) return blocked('full_admission_claim_changed');
        let native = null;
        const recorder = { newId: () => baseRecorder.newId(), record(kind, data) {
          baseRecorder.record(kind, data);
          if (kind === 'claim_verification') native = structuredClone(data.result?.payload);
        } };
        const outcome = await evaluate({ env, event: { pull_request: pr }, eventName: 'pull_request', fetchImpl,
          workspace: config.workspace, withSummary: false, readPolicyFile: () => config.policyText,
          observation_recorder: recorder, observation_entry: 'independent_pr' });
        const finished = clock(), prRef = `${REPO}#${job.pr}`;
        if (!Number.isSafeInteger(finished) || finished < started || !fresh(mode.observedAt, finished)
          || !fresh(observation.observedAt, finished)) return blocked('full_admission_observation_expired');
        if (outcome.admitted !== true || outcome.verdict !== 'ADMITTED') return blocked('full_admission_rejected');
        if (outcome.head_sha !== job.headSha || outcome.base_sha !== job.baseSha || outcome.pr_ref !== prRef
          || outcome.claim_id !== job.claimId || outcome.scope !== config.scope
          || digest([...outcome.changed_paths].sort()) !== digest([...packet.paths].sort())
          || !samePr(await githubJson(fetchImpl, env, `/repos/${REPO}/pulls/${job.pr}`), job)) return blocked('full_admission_subject_changed');
        // Compatibility validation comes from the *actual evaluator's* Native
        // verification, never an asserted marker or a second synthetic verdict.
        const claim = native?.claim;
        if (native?.status !== 'ok' || native.verdict !== 'ADMITTED' || native.execution_authorized !== true
          || native.execution_policy !== 'staged' || claim?.lease_key_required !== false
          || claim.execution_handover_pending !== false) return blocked('full_admission_native_unsupported');
        if (native.current_fence !== job.fence || native.execution_epoch !== job.epoch || claim.fence !== job.fence
          || claim.execution_epoch !== job.epoch || claim.claim_id !== job.claimId || claim.context_key !== config.scope
          || claim.status !== 'ACTIVE' || claim.bound_pr !== prRef || native.bound_pr !== prRef || native.pr_ref !== prRef
          || native.head_sha !== job.headSha || native.base_sha !== job.baseSha || !fresh(native.verified_at, finished)
          || !(at(claim.expires_at) > finished) || !Array.isArray(native.paths_outside_write_set)
          || native.paths_outside_write_set.length) return blocked('full_admission_native_changed');
        if (!plain(outcome.admission_mode) || !plain(outcome.merge_slot)
          || !['normal', 'efficiency', 'frozen'].includes(outcome.admission_mode.state)) return blocked('full_admission_incomplete');
        const facts = { contract: 'clued.independent-ci.full-admission/1', status: 'ADMITTED', admitted: true,
          ...(observationOnly ? { observationOnly: true, publicationAuthorized: false } : {}),
          completeAdmission: true, evaluator: ENGINE, domain: config.domain, repository: REPO, scope: config.scope,
          prRef, headSha: job.headSha, baseSha: job.baseSha, claimId: job.claimId, fence: job.fence, epoch: job.epoch,
          sourceManifestSha256: job.sourceManifestSha256, executionPolicy: native.execution_policy, guarded: claim.lease_key_required, executionHandoverPending: claim.execution_handover_pending,
          mergeQueueHead: isCurrentMergeQueueHead(claim,job,finished),
          mode: { state: outcome.admission_mode.state, layer: outcome.admission_mode.layer, policyVersion: outcome.admission_mode.policy_version },
          mergeSlot: structuredClone(outcome.merge_slot), ownerReview: outcome.owner_review ? {
            kind: outcome.owner_review.kind, grantId: outcome.owner_review.grant_id, carriedFrom: outcome.owner_review.carried_from ?? null } : null,
          workflowGateFindings: [...(outcome.workflow_gate_findings ?? [])], observedAt: new Date(finished).toISOString(),
          claimExpiresAt: claim.expires_at, modeProofRef: mode.proofRef, observationRef: observation.observationRef,
          packetSha256: digest(packet), evaluationSha256: digest(outcome) };
        return Object.freeze({ ...facts, observationSha256: digest(facts) });
      } catch { return blocked('full_admission_unavailable'); }
    },
  });
}
