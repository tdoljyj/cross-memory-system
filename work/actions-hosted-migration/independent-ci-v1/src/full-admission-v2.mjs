// Full Native admission for job contract v2 (DESIGN S6, claim decoupling A-strict).
//
// Identical evaluator, door and freshness rules as full-admission.mjs (v1), with one
// change of source for the claim: v1 fixes the claim in the job; v2 resolves
// the current claim from Native's PR -> Task binding, lets the
// existing evaluator perform the complete Native door for it, and then requires Native to be
// internally consistent about that claim (claim id, Task, fence, epoch, ACTIVE, exact PR, lease left).
// Inside one batch the caller passes the sticky batch claim (batch-claim-v2.mjs): a different claim
// id, fence or epoch fails closed (a renewal, which only moves expires_at, does not).
// Active guarded claims additionally bind the real private head authorization;
// staged guarded claims and every pending handover remain refused. Publication
// still needs its separately qualified Native ticket port.
import fs from 'node:fs';
import path from 'node:path';
import { digest } from './proof.mjs';
import { networkFault } from './read-retry.mjs';
import { verificationUnavailable } from './withdrawal-text.mjs';
import { freshStamp, serverAnswerCurrent, retainServerAnswerForFacts } from './clock-skew.mjs';
import { validateJobV2, claimGeneration, sameClaimGeneration, prBaseAcceptedV2, isTrainFrontJobV2 } from './job-v2.mjs';
import { isCurrentMergeQueueHeadV2 } from './independent-control-checks-v2/queue-facts.mjs';
import { evaluate, githubJson, mergeSlotState, VERIFY_RPC } from '../../../../scripts/ci/clued-work-admission.mjs';
import { normalizePRTaskBinding } from '../../../../scripts/ci/clued-pr-task-binding.mjs';
import { TRAIN_FAILURE } from './merge-train-v2-contract.mjs';

import { FULL_ADMISSION_CONTRACT_V2, FULL_ADMISSION_CONTRACT_V3, effectiveGuard, supportedNativeExecution, ownerKind, reasonCodes, sanitizeAdmissionDiagnosticV2, sanitizeSchedulingV2, schedulingFactsV2, verdict } from './admission-facts-v2.mjs';
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
FAILURE_REASONS.add(TRAIN_FAILURE.LEASE_STALE.native);
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
// Generation 10 (resident DESIGN 53.6): whether an exception the evaluation caught was the line or a passing server fault, in the shapes
// the code it runs really throws:
//   - Source github.mjs (the mode read, the installation token): a coded error github_http_500/502/503/504 or
//     github_transport_unconfirmed (withdrawal-text.mjs#verificationUnavailable, the read-retry set);
//   - a bare network failure (read-retry.mjs#networkFault) or a timeout;
//   - scripts/ci/clued-work-admission.mjs: githubJson's "GitHub API <route> returned 502" and the Native RPC's
//     "Clued <rpc> returned 503" or "... returned 503: <detail>" (describe(): the status, then ": " and the details).
// Anything else (a credential refused, 401, 403, 404, 429, an evaluator fault) is not.
const RETURNED_5XX = / returned (?:500|502|503|504)(?::|$)/;
export const transportFault = error => networkFault(error) || error?.name === 'TimeoutError' || verificationUnavailable(error?.code)
  || (error instanceof Error && RETURNED_5XX.test(error.message ?? ''));
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
// bc982192 (C3, batch route push only): GitHub's compare of base...x is 'ahead' or 'identical' exactly when x contains base.
async function baseOnMain(readFetch, env, job) {
  for (const to of [job.headSha, 'main']) {
    const c = await githubJson(readFetch, env, `/repos/${REPO}/compare/${job.baseSha}...${to}`);
    if (!['ahead', 'identical'].includes(c?.status)) return false;
  }
  return true;
}
// bc982192 (push landing, a batch stamped push only): a train front batch tests S = merge(T, H...), which contains main's tip T even
// when H does not; the evaluator judged H (not_needed). On exactly that tip, outside the protected layer (whose head must still contain
// the tip: MergeAdmission v0.2 §2.4, the evaluator rejects it), the slot is the claim's own, by the evaluator's same rule
// (mergeSlotState). No route: the evaluator's slot, as on origin/main.
function frontSlot(job, outcome, native, routePush) {
  const slot = outcome.merge_slot;
  if (!routePush || !isTrainFrontJobV2(job) || slot?.state !== 'not_needed' || slot.tip !== job.baseSha || outcome.admission_mode?.layer === 'protected') return structuredClone(slot);
  return mergeSlotState({ repository: REPO, branch: 'main', tip: job.baseSha, upToDate: true, claim: native?.claim ?? null, verifiedAt: native?.verified_at ?? null });
}
// routePush (bc982192): a batch stamped push; its S = H job runs on the merge base of head and main, so GitHub's base.sha is a fact
// for it too (every read of one admission must still agree), and the batch base is proven on main instead (baseOnMain).
function samePr(pr, job, base = null, routePush = false) {
  return pr?.number === job.pr && pr.state === 'open' && pr.head?.sha === job.headSha
    && (prBaseAcceptedV2(job, pr.base?.sha) || (routePush && /^[0-9a-f]{40}$/.test(pr.base?.sha ?? '')))
    && (base === null || pr.base.sha === base)
    && pr.head.repo?.full_name === job.repo && pr.base.repo?.full_name === job.repo && pr.base.ref === 'main';
}
const batchClaimValid = c => c === null || c === undefined || (plain(c) && uuid.test(c.claimId ?? '') && Number.isSafeInteger(c.fence) && c.fence > 0
  && Number.isSafeInteger(c.epoch) && c.epoch > 0);

// All providers are installed protected controller ports, never PR data. options.batchClaim is the
// batch's sticky claim generation (null only for the batch's first admission, stage 1). options.scheduling
// (optional) receives the scheduling facts (schedulingFactsV2) of every evaluation that reached Native,
// admitted or not; it is told, never asked, and nothing it does can change the admission.
// batchRoute (bc982192): the batch's route stamp its stage read (batch-route.mjs); only 'push' changes anything (samePr, baseOnMain,
// frontSlot), anything else is null: every answer exactly as on origin/main.
export function createFullAdmissionPortV2({ protectedConfig, tokenProvider, modeProvider, recorderProvider,
  fetchImpl = globalThis.fetch, clock = Date.now, monotonic = () => performance.now(), fixtureHooks = null, batchRoute = null } = {}) {
  const routePush = batchRoute === 'push';
  // Two fixed commits compare the same way and main only moves forward: a batch base proven on main stays proven (per process).
  const onMain = new Set();
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
    // packet: the changed-paths packet, or (bf57ff10 P2 E1, 2026-11-07) a function returning a promise of it, so the
    // issuer can read it side by side with this evaluation (windows-issuer.mjs#issuerEvaluate). A deferred packet is
    // checked exactly as a given one, only later: no Native RPC is sent before it has arrived complete and valid
    // (timedFetch below), and every answer given after the subject check waits for it and is replaced by
    // full_admission_subject_invalid when it failed or is invalid, which is what a given invalid packet returned before
    // anything else. The facts are assembled only after every read (mode, PR, packet, evaluation) is complete.
    // The guarantee is "no Native contact without a valid packet" (Native verify carries pr_ref: a write); GitHub reads
    // may run meanwhile, but once the packet has failed or is invalid every further read of this evaluation throws at
    // once instead of being sent (review MINOR 2: no read budget spent on an answer that can no longer count).
    async evaluatePr(job, packet, options = {}) {
      if (!configured || typeof tokenProvider !== 'function' || typeof recorderProvider !== 'function'
        || typeof fetchImpl !== 'function' || typeof clock !== 'function') return blocked('full_admission_not_configured');
      const deferred = typeof packet === 'function';
      let packetRefused = false;
      const packetRead = deferred ? Promise.resolve().then(packet).then(value => ({ ok: true, value }), () => ({ ok: false }))
        .then(p => { if (!p.ok || !packetValid(job, p.value)) packetRefused = true; return p; }) : null;
      const refusedNow = () => { if (packetRefused) throw Object.assign(new Error('full_admission_packet_refused'), { code: 'full_admission_packet_refused' }); };
      const packetGate = async () => {
        const p = await packetRead;
        if (!p.ok || !packetValid(job, p.value)) throw Object.assign(new Error('full_admission_packet_refused'), { code: 'full_admission_packet_refused' });
        return p.value;
      };
      let pastSubject = false;
      const answer = await evaluateWith(job, deferred ? null : packet, options, { deferred, packetGate, refusedNow, past: () => { pastSubject = true; } });
      if (!deferred || !pastSubject) return answer;
      const p = await packetRead;
      return p.ok && packetValid(job, p.value) ? answer : blocked('full_admission_subject_invalid');
    },
  });
  async function evaluateWith(job, packet, options, { deferred, packetGate, refusedNow, past }) {
      let phase = 'mode';
      let staleLease = false;
      // Every GitHub read of a deferred-packet evaluation stops at once when the packet has already failed.
      const readFetch = deferred ? (url, opts) => { refusedNow(); return fetchImpl(url, opts); } : fetchImpl;
      try {
        validateJobV2(job);
        const batchClaim = options?.batchClaim ?? null;
        const admissionCommand = options?.admissionCommand;
        if (!plain(options) || Object.keys(options).some(k => !['batchClaim', 'scheduling', 'admissionCommand'].includes(k)) || !batchClaimValid(batchClaim)
          || (admissionCommand !== undefined && (typeof admissionCommand !== 'function' || job.role !== 'work-admission' || isTrainFrontJobV2(job)))
          || !(options.scheduling === undefined || typeof options.scheduling === 'function')) return blocked('full_admission_subject_invalid');
        const tell = (outcome, native) => { try { options.scheduling?.(Object.freeze(sanitizeSchedulingV2(schedulingFactsV2(outcome, native, REPO)))); } catch { /* told, never asked */ } };
        if (job.repo !== config.repository || job.sourceManifestSha256 !== config.sourceManifestSha256 || (!deferred && !packetValid(job, packet))) return blocked('full_admission_subject_invalid');
        past();
        if (digest(evaluatorBytes()) !== config.evaluatorSha256) return blocked('full_admission_source_changed');
        const started = clock();
        if (!Number.isSafeInteger(started)) return blocked('full_admission_clock_invalid');
        // bf57ff10 P2 E1: the mode read and (installation token, then the PR read) run side by side; they were one after the
        // other. Their results are judged only when all are complete, in the old order and with the old phases, so each
        // refusal and failure is the old one; the PR is read only with credentials that pass the principal check.
        const credentialsValid = credentials => plain(credentials) && typeof credentials.githubToken === 'string' && !!credentials.githubToken
          && /^clued_bnd_[A-Za-z0-9_-]{8,480}$/.test(credentials.ciAdmissionToken ?? '')
          && credentials.ciPrincipalBindingId === config.ciPrincipalBindingId
          && credentials.ciPrincipalQualificationRef === config.ciPrincipalQualificationRef;
        const modeRead = (async () => { const value = typeof modeProvider === 'function' ? await modeProvider() : config.modeObservation; return { value, at: clock() }; })();
        const principalRead = Promise.resolve().then(() => tokenProvider());
        const prRead = principalRead.then(c => credentialsValid(c) ? githubJson(readFetch, { GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: c.githubToken }, `/repos/${REPO}/pulls/${job.pr}`) : null);
        const [modeResult, principalResult, prResult] = await Promise.allSettled([modeRead, principalRead, prRead]);
        if (modeResult.status === 'rejected') throw modeResult.reason;
        const mode = modeResult.value.value, modeReturnedAt = modeResult.value.at;
        if (!plain(mode) || mode.complete !== true || mode.repository !== REPO || mode.variable !== VARIABLE
          || mode.source !== 'github-repository-variables' || typeof mode.exists !== 'boolean'
          || !Number.isSafeInteger(modeReturnedAt) || modeReturnedAt < started
          || !fresh(mode.observedAt, modeReturnedAt) || typeof mode.proofRef !== 'string' || !mode.proofRef
          || (mode.exists && typeof mode.value !== 'string')) return blocked('full_admission_mode_unknown');
        phase = 'principal'; if (principalResult.status === 'rejected') throw principalResult.reason;
        const credentials = principalResult.value;
        if (!credentialsValid(credentials)) return blocked('full_admission_principal_unknown');
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
        phase = 'pull_request'; if (prResult.status === 'rejected') throw prResult.reason;
        const pr = prResult.value;
        if (!samePr(pr, job, null, routePush)) return blocked('full_admission_subject_changed');
        const prBase = pr.base.sha;
        // bc982192 (batch route push): an S = H batch runs on the merge base of its head and main; it counts only while GitHub shows that
        // base an ancestor of the head and of main's tip (or that tip), proven every time, also when it happens to equal base.sha.
        if (routePush && !isTrainFrontJobV2(job) && !onMain.has(`${job.baseSha}:${job.headSha}`)) {
          phase = 'base';
          if (!(await baseOnMain(readFetch, env, job))) return blocked('full_admission_subject_changed');
          onMain.add(`${job.baseSha}:${job.headSha}`);
          phase = 'pull_request';
        }
        // The evaluator resolves Native's current PR -> Task -> claim. Source
        // does not repeat that RPC or trust an advisory body/commit trailer.
        // The age of Native's answer is measured on this host's monotonic clock from the send of its verify call
        // (Decision 1100a0ed); without a seen send, from the start of the evaluation, which is earlier.
        let native = null, nativeSentMono = null, verifySentMono = null;
        const evaluateStartMono = monotonic();
        const verifyUrl = new URL(`/rest/v1/rpc/${VERIFY_RPC}`, config.supabaseUrl).href;
        // A deferred packet gates every Native RPC of the evaluation: none is sent before the packet is complete and valid.
        const timedFetch = async (url, opts) => {
          if (deferred && String(url).includes('/rest/v1/rpc/')) await packetGate();
          else if (deferred) refusedNow();
          if (String(url).endsWith(`/rest/v1/rpc/${VERIFY_RPC}`)) verifySentMono = monotonic();
          if (admissionCommand && new URL(url).origin !== 'https://api.github.com') {
            if (String(url) !== verifyUrl || opts?.method !== 'POST' || staleLease) throw new Error('train_admission_command_refused');
            const reply = await admissionCommand(JSON.parse(opts.body).p_input);
            staleLease = reply.status === 'rejected' && reply.error_code === TRAIN_FAILURE.LEASE_STALE.native;
            return Response.json(reply);
          }
          return fetchImpl(url, opts);
        };
        const recorder = { newId: () => baseRecorder.newId(), record(kind, data) {
          baseRecorder.record(kind, data);
          if (kind === 'claim_verification') { native = structuredClone(data.result?.payload); nativeSentMono = verifySentMono ?? evaluateStartMono; }
        } };
        phase = 'evaluate'; const outcome = await evaluateImpl({ env, event: { pull_request: pr }, eventName: 'pull_request', fetchImpl: timedFetch,
          workspace: config.workspace, bindingScope: config.scope, withSummary: false, readPolicyFile: () => config.policyText,
          readMainControlRegistry: true,
          observation_recorder: recorder, observation_entry: 'independent_pr' });
        if (staleLease) return blocked(TRAIN_FAILURE.LEASE_STALE.native);
        phase = 'post_evaluate'; tell(outcome, native); const finished = clock(), prRef = `${REPO}#${job.pr}`;
        if (!Number.isSafeInteger(finished) || finished < started || !fresh(mode.observedAt, finished)
          || !fresh(observation.observedAt, finished)) return blocked('full_admission_observation_expired', rejectionDiagnostic(outcome, native, { modeFresh: fresh(mode.observedAt, finished), recorderFresh: fresh(observation.observedAt, finished) }));
        if (outcome.admitted !== true || outcome.verdict !== 'ADMITTED') return blocked('full_admission_rejected', rejectionDiagnostic(outcome, native));
        phase = 'claim_reference';
        const binding = normalizePRTaskBinding(outcome.claim_binding, { scope: config.scope, repository: REPO,
          prNumber: job.pr, headSha: job.headSha, baseSha: prBase, targetBranch: pr.base.ref });
        if (binding.binding_status !== 'bound') return blocked('full_admission_claim_missing');
        const reference = binding.claim;
        if (outcome.task_id !== binding.task_id || (batchClaim && reference.claim_id !== batchClaim.claimId)) return blocked('full_admission_claim_changed');
        phase = 'post_pull_request';
        if (deferred) packet = await packetGate();
        if (outcome.head_sha !== job.headSha || outcome.base_sha !== prBase || outcome.pr_ref !== prRef
          || outcome.claim_id !== reference.claim_id || outcome.scope !== config.scope
          || digest([...outcome.changed_paths].sort()) !== digest([...packet.paths].sort())
          || !samePr(await githubJson(readFetch, env, `/repos/${REPO}/pulls/${job.pr}`), job, prBase, routePush)) return blocked('full_admission_subject_changed');
        phase = 'native'; const claim = native?.claim;
        // The guard in force (admission-facts-v2.mjs#effectiveGuard): a handed-over claim runs while Native's policy is staged.
        const guarded = effectiveGuard(native?.execution_policy, claim?.lease_key_required);
        if (native?.status !== 'ok' || native.verdict !== 'ADMITTED' || native.execution_authorized !== true
          || !supportedNativeExecution(native.execution_policy, guarded)
          || (guarded && !uuid.test(native.head_authorization_id ?? ''))
          || claim.execution_handover_pending !== false) return blocked('full_admission_native_unsupported');
        // Native must be internally consistent about this exact PR's Task and
        // current claim. The old single-PR claim field is not binding authority.
        if (claim.claim_id !== reference.claim_id || native.current_fence !== claim.fence || native.execution_epoch !== claim.execution_epoch
          || !Number.isSafeInteger(claim.fence) || claim.fence < 1 || !Number.isSafeInteger(claim.execution_epoch) || claim.execution_epoch < 1
          || claim.fence !== reference.fence || claim.execution_epoch !== reference.execution_epoch || claim.task_id !== binding.task_id
          || claim.context_key !== config.scope || claim.status !== 'ACTIVE' || binding.pr_ref !== prRef
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
          sourceManifestSha256: job.sourceManifestSha256, executionPolicy: native.execution_policy, guarded, executionHandoverPending: claim.execution_handover_pending,
          ...(active ? { publicationRequired: true, headAuthorizationId: guarded ? native.head_authorization_id : null } : {}),
          mergeQueueHead: isCurrentMergeQueueHeadV2(claim, observedClaim, job, finished),
          mode: { state: outcome.admission_mode.state, layer: outcome.admission_mode.layer, policyVersion: outcome.admission_mode.policy_version },
          mergeSlot: frontSlot(job, outcome, native, routePush), ownerReview: outcome.owner_review ? {
            kind: outcome.owner_review.kind, grantId: outcome.owner_review.grant_id, carriedFrom: outcome.owner_review.carried_from ?? null } : null,
          workflowGateFindings: [...(outcome.workflow_gate_findings ?? [])], observedAt: new Date(finished).toISOString(),
          claimExpiresAt: claim.expires_at, modeProofRef: mode.proofRef, observationRef: observation.observationRef,
          packetSha256: digest(packet), evaluationSha256: digest(outcome) };
        return retainServerAnswerForFacts(Object.freeze({ ...facts, observationSha256: digest(facts) }),
          { verifiedAt: native.verified_at, expiresAt: claim.expires_at, sentMono: nativeSentMono ?? evaluateStartMono }, monotonic);
      } catch (error) {
        if (staleLease) return blocked(TRAIN_FAILURE.LEASE_STALE.native);
        return blocked('full_admission_unavailable', { phase, transport: transportFault(error) });
      }
  }
}

export { FULL_ADMISSION_CONTRACT_V2, FULL_ADMISSION_CONTRACT_V3, supportedNativeExecution, admittedFactsMatchJobV2, sanitizeAdmissionDiagnosticV2, sanitizeSchedulingV2, schedulingFactsV2 } from './admission-facts-v2.mjs';
