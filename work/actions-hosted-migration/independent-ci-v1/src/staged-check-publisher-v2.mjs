// Scanner check publication for job contract v2 (stages 3, 5, 7 of Source v2; DESIGN S6).
// NOTE: this is a NEW v2 file next to staged-check-publisher.mjs (v1). This file is v1 with exactly these changes,
// so the two can be reconciled by diff:
//   - validateJobV2 / subjectOfV2 / verifyResultV2 (claim-free subject, signed-result contract v2);
//   - effect key = scanEffectKeyV2(job, definition) and external_id = scanExternalIdV2(job): a content
//     proof, one effect per (content, attempt), the same across claims (design §5.5);
//   - the complete admission must be contract /2 and observe the batch claim generation again
//     (A-strict stickiness); the protected observation and the admission must agree on the claim
//     GENERATION (claim id, fence, epoch), not on expires_at (a renewal between the two observations
//     no longer reports lease_observations_disagree);
//   - the role-on-head mutex K(head, role) (effect-journal.mjs#claimRolePublication) is begun before the
//     own effect key, in the journal state\v2\effects-scan; a K held by any other holder refuses the publication;
//   - nothing else: same journal states, same revocation, same readback and the same "a settled
//     effect is only re-verified, never re-posted" rule (a settled job id is never run again).
// Resident primary/standby design v0.4 §6.2 (C4, Task c2af8d17): before a role's first publication, once
// the boundary passed, a role this journal knows nothing of (no own effect key, no K(head, role)) is read back on
// GitHub (published-on-github-v2.mjs). A check of App 5368905 of the same name there, published by another node or
// install, ends the publication cleanly with role_already_on_github: no K, no effect key, nothing posted or revoked,
// no HALT. Whatever this journal knows keeps its existing path (a settled key is re-verified; K held by another holder
// is role_already_published_on_head). A read-back that is not complete refuses (fail closed).
import { prepareNativePublication, nativePublicationNoPostProof } from '../../../../scripts/ci/clued-independent-publication-port.mjs';
import { canonical, digest } from './proof.mjs';
import { freshStamp, retainedServerAnswerCurrent } from './clock-skew.mjs';
import { validateJobV2, SCANNER_ROLES_V2, subjectOfV2, scanEffectKeyV2, scanExternalIdV2, sameClaimGeneration, claimGeneration, prBaseAcceptedV2, isTrainFrontJobV2, frontJobIdsV2 } from './job-v2.mjs';
import { verifyResultV2 } from './proof-v2.mjs';
import { admittedFactsMatchJobV2, fullAdmissionFailureV2 } from './full-admission-v2.mjs';
import { claimRolePublication, rolePublicationKey } from './effect-journal.mjs';
import { ROLE_ALREADY_ON_GITHUB_REASON, publishedNames } from './published-on-github-v2.mjs';
import { withdrawalTitle, withdrawalNote, verificationUnavailable, withdrawnForUnavailability } from './withdrawal-text.mjs';

const HASH = /^[a-f0-9]{64}$/;
// Generation 28 (resident docs/adr/0015, defect 664cc8eb; field #1037 head 26ac75e4, stage 7): a publication withdrawn only because its
// verification after the write could not be read (GitHub or Native did not answer in time) and with no change of its authorization observed
// used to end the head for good (PUBLICATION_REVOKED, the head burned). Such a withdrawal is now followed, at the resident's next try of the
// same stage (the bounded publication retry, executor.mjs PUBLICATION_RETRY_MS), by a REPUBLICATION: a new, completely re-proven publication of
// the same signed result under its own effect key and external_id, never a re-send of the withdrawn one.
//   - only from publish() (the local staged path), only after the withdrawal itself was confirmed (REVOKED: the PATCH to failure read back,
//     the effect recorded revoked), only for a cause withdrawnForUnavailability names, only without a Native publication (staged policy:
//     a Native publication's own ledger has one publication per job and is not re-entered here);
//   - the revoked record says so (details.republishable) and the result says so (republishSafe, the resident's only signal);
//   - republication n (1..MAX_REPUBLICATIONS) has effect key republicationKey(original, n) and the ORIGINAL external_id: every reader of
//     the head's checks (GitHub's required checks, stage 8, the merge executor's clued-merge-slot-ci.mjs#independentCheckBindsPullRequest)
//     counts the newest check of the role, and its pinned external_id formats stay as they are. The publisher's own identity reads
//     (discoverKnown, createOrAdopt) skip the checks it withdrew before (withdrawn: their check ids from the revoked records), so a lost
//     create answer of a republication is found exactly as a first publication's;
//   - K(head, role) keeps its original holder (the local path, the original key);
//   - it starts with the complete boundary before any write, like a first publication: a changed authorization refuses there (nothing
//     written), an unreadable source ends BLOCKED and safe to run again, as before; a republication withdrawn again for unavailability may be
//     followed by the next one, at most MAX_REPUBLICATIONS in all, and a withdrawal for any other cause stays final (PUBLICATION_REVOKED).
// "Withdraw first, publish again afterwards" holds: a republication is only reachable from a revoked record.
export const MAX_REPUBLICATIONS = 3;
export const republicationKey = (originalKey, n) => digest({ action: 'staged-independent-check-republication/2', effectKey: originalKey, republication: n });
const republishable = record => record?.state === 'revoked' && record.details?.republishable === true;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const positive = value => Number.isSafeInteger(value) && value > 0;
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const ref = value => typeof value === 'string' && value.length > 0 && value.length <= 1000 && !/[\x00-\x1f]/.test(value);
const stop = (code, drift = false, extra = {}) => { throw Object.assign(new Error(code), { code, drift, ...extra }); };
// Why Native's complete admission was not proven (full-admission-v2.mjs blocked(): rejected / native_changed / claim_changed /
// unavailable ...) used to be dropped here: the receipts only said full_admission_not_proven (11-04, PR #992, head 580f5dd8).
// admissionReason is the port's own code; admissionDiagnostic is its sanitized diagnostic (fixed enums only, no remote text).
// Both are carried to the withdrawal's journal record, and the diagnostic to the outcome the resident reads.
const ADMISSION_REASON = /^full_admission_[a-z_]{1,60}$/;
// Whether a refusal before anything was recorded or written is only a passing fault of the sources (GitHub unreadable after the bounded read
// retry, Native's claim observation or the admission port unavailable): then the entry says the stage is safe to run again (outcome.safeToRerun;
// the resident re-invokes this publisher stage with the same signed result, DESIGN 51), never inferred from a code by the resident.
const passingFault = error => { const r = reason(error); return verificationUnavailable(r) || r === 'native_claim_observation_unavailable'
  || r === 'native_admission_aged_before_write' || r === 'publication_window_short_before_write' || r === 'protected_facts_reobservation_unavailable'
  || (r === 'full_admission_not_proven' && verificationUnavailable(error?.admissionReason)); };
const admissionOf = error => ({ ...(ADMISSION_REASON.test(error?.admissionReason ?? '') ? { admissionReason: error.admissionReason } : {}),
  ...(error?.admissionDiagnostic ? { admissionDiagnostic: error.admissionDiagnostic } : {}) });
// An uncoded exception is never a transport fact (PR-A review MINOR 5): it is not a transient code.
const reason = error => /^[a-z][a-z0-9_]{0,80}$/.test(error?.code ?? '') ? error.code : 'publication_operation_unconfirmed';
// The publisher's own reads for a copy of a create whose answer was lost, after the port's window (createOrAdopt): at once, then after
// 10 s and 25 s more. They are GitHub reads after the write, before its confirmation: in production the confirmation's observation
// window starts at its first observation (runtime/one-shot-v2.mjs, PUBLICATION_POST_WRITE_OBSERVE_BUDGET_MS, Owner Decision
// 36946d8b), so these waits do not use it, and the delays themselves bound them.
export const ADOPT_READ_DELAYS_MS = Object.freeze([0, 10_000, 25_000]);
// What the confirmation after the write needs besides a boundary as long as the one before it: the GitHub read-back and the steps
// between its two boundaries.
export const CONFIRMATION_MARGIN_MS = 5_000;
// What the write itself needs of the pre-write observation window after the last check before it (review round 6, MAJOR 1): the role
// key and the journal (local), the reserve the recoverable publisher demands at the create (PUBLICATION_READBACK_RESERVE_MS, 2 s), and
// WRITE_NATIVE_CALLS Native calls (prepareNativePublication's current-authority verify, and an active policy's publication begin),
// each estimated as the slowest verify attempt of this publisher try before the write, answered or timed out (authority.slowestNativeReadMs).
export const WRITE_MARGIN_MS = 5_000;
export const WRITE_NATIVE_CALLS = 2;
// Whether a failed create may have landed, as the GitHub port classifies it (github.mjs): a 5xx answer to the write (ambiguous) or a
// transport failure after the request left this host. A definite refusal (a 4xx) or a failure proven before sending cannot have.
const createMayHaveLanded = error => error?.retryable === true && error?.unsent !== true;
// Whether a failed create is looked for at all (createOrAdopt): never for a Native publication (its handle says native: its runtime
// recovers by the ticket and finishes it; adopting here would skip Native's finish), never when the port proved it was not sent, and
// only when it may have landed.
export const adoptReadAllowed = (error, nativeHandle) => nativeHandle?.native !== true && nativePublicationNoPostProof(error)?.notSent !== true
  && createMayHaveLanded(error);
// The shape discoverKnown demands of a check list it trusts: complete, bounded, plain checks with unique ids, all on this head.
const checkListTrusted = (list, job) => list?.complete === true && Array.isArray(list.checks) && list.checks.length <= 10000
  && list.checks.every(c => plain(c) && positive(c.id) && c.head_sha === job.headSha) && new Set(list.checks.map(c => c.id)).size === list.checks.length;
const fresh = (facts, now) => retainedServerAnswerCurrent(facts)
  ?? (freshStamp(Date.parse(facts.observedAt), now) && Date.parse(facts.claimExpiresAt) > now);
const requiredRefs = ['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef'];

// What of Native's merge-slot observation a publication's authorization binding includes (the before/after comparison
// of one publication, authorization_binding_changed).
//   - A scanner role (gitleaks, trivy, contract-placement; stages 3, 5, 7): its result is a scan of the head's content and
//     grants nothing about merging. Whether the claim is in the merge queue, at its head, or has lapsed out of it is
//     stage 8's business (control-merge-slot, LIVE_ACTUAL_MERGE_SLOT_REQUIRED) and the merge slot's own check. Joining,
//     leaving or lapsing during a publication must not revoke a scan, so the slot's state, its until and its observed
//     state are not bound. What the observation says about WHICH slot and WHICH main tip it was read against stays
//     bound (ref, tip): a main that moves under the publication still voids it, as before. Everything else bound by
//     boundary() (subject, claim generation, execution policy, PR base, mode, Owner review, refs, principal, signer,
//     definition) is untouched; the slot's shape is still required (full_admission_incomplete) and the claim lease
//     and the Native admission itself are still judged as ever.
//   - Any other role routed through this publisher keeps the whole slot in its binding (fail closed).
// Same rule as §41.8 for stage 8 (slot by state, ref and tip, never its until), taken one step further because a scan
// does not depend on the slot at all. Exported for tests.
export function slotBindingFor(job, mergeSlot) {
  if (!SCANNER_ROLES_V2.includes(job?.role)) return mergeSlot;
  return { ref: mergeSlot?.ref ?? null, tip: mergeSlot?.tip ?? null };
}

// batchClaim: the sticky claim generation recorded by stage 1 for this batch (batch-claim-v2.mjs).
export function createStagedCheckPublisherV2({ nativeAdmission, authority, github, journal, signers,
  configuredChecks, readChangedPaths, protectedDeployment, batchClaim, clock = Date.now, domain = 'production',
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const deployment = plain(protectedDeployment) ? structuredClone(protectedDeployment) : null;
  const checks = plain(configuredChecks) ? structuredClone(configuredChecks) : null;
  const configured = ['production', 'fixture'].includes(domain) && deployment?.enabled === true
    && deployment.domain === domain && ref(deployment.repository) && requiredRefs.every(k => ref(deployment[k]))
    && UUID.test(deployment.ciPrincipalBindingId ?? '') && typeof nativeAdmission?.evaluatePr === 'function'
    && typeof authority?.observe === 'function' && typeof github?.readPullRequest === 'function'
    && typeof github?.readChecks === 'function' && typeof github?.createCheck === 'function'
    && typeof github?.revokeCheck === 'function' && ['begin', 'read', 'transition'].every(k => typeof journal?.[k] === 'function')
    && signers instanceof Map && typeof readChangedPaths === 'function' && typeof clock === 'function' && checks
    && plain(batchClaim) && UUID.test(batchClaim.claimId ?? '') && positive(batchClaim.fence) && positive(batchClaim.epoch)
    && (domain !== 'fixture' || github.fixture === true && authority.fixture === true && nativeAdmission.fixture === true)
    && (domain !== 'production' || !github.fixture && !authority.fixture && !nativeAdmission.fixture);

  function definitionFor(job) {
    const d = checks?.[job.role];
    if (!plain(d) || Object.keys(d).some(k => !['name', 'appId'].includes(k)) || !ref(d.name) || d.name.length > 100
      || !positive(d.appId) || [5365273, 5164952].includes(d.appId)) stop('unregistered_check_role');
    return d;
  }
  function identity(check, definition, job, externalId) {
    return positive(check?.id) && check.app?.id === definition.appId && check.head_sha === job.headSha
      && check.name === definition.name && check.external_id === externalId;
  }
  async function readback(known, definition, job, externalId, conclusion) {
    const list = await github.readChecks(job.headSha);
    if (list?.complete !== true || !Array.isArray(list.checks) || new Set(list.checks.map(c => c.id)).size !== list.checks.length) stop('check_readback_unconfirmed');
    const actual = list.checks.find(c => c.id === known.id);
    if (!identity(actual, definition, job, externalId) || actual.status !== 'completed' || actual.conclusion !== conclusion) stop('check_readback_unconfirmed');
    return actual;
  }
  // C4: true only when this journal holds nothing for the role on the head (no K record, whatever it holds) and GitHub
  // holds a check of this App by that name. The caller has already found no own effect key. A train front batch: only the
  // checks of its own front subject's jobs (§41.4).
  async function onGithubOnly(mutex, job, definition) {
    if (await journal.read(rolePublicationKey(mutex))) return false;
    return (await publishedNames(github, job.headSha, [definition.name], definition.appId, frontJobIdsV2(job))).length > 0;
  }
  // The two reads the after-write verification depends on, nothing else: the PR and the head's check inventory.
  async function probeGithub(job) {
    await github.readPullRequest(job.pr);
    const list = await github.readChecks(job.headSha);
    if (list?.complete !== true || !Array.isArray(list.checks)) stop('check_readback_unconfirmed');
  }
  // Generation 13 (DESIGN §57.4, Task a7951534): a create whose answer was lost (the port's own read-back, github.mjs, found no copy within
  // its window) may still have landed: GitHub can show the check later. The publisher reads the head's checks again at
  // ADOPT_READ_DELAYS_MS and adopts a copy that is exactly what it sent (App, name, head, external_id, completed, conclusion, title,
  // summary); it never sends the create again. Only a failure that may have landed is looked for (createMayHaveLanded). None found:
  // the original error, as before (the error path then finds any copy that is not exact and withdraws it). A create the port proved never sent is not looked for, and neither is a Native publication (a
  // handle with native true: the create is Native's begin, the POST with its marker and Native's finish; its runtime has its own recovery, which
  // finds the check by its ticket and finishes it, never POSTs again, and adopting it here would skip Native's finish).
  async function createOrAdopt(payload, nativeHandle, definition, job, externalId, withdrawn = new Set()) {
    try { return await github.createCheck(payload, nativeHandle); }
    catch (error) {
      if (!adoptReadAllowed(error, nativeHandle)) throw error;
      for (const delay of ADOPT_READ_DELAYS_MS) {
        if (delay > 0) await sleep(delay);
        let list = null;
        try { list = await github.readChecks(job.headSha); } catch { continue; }
        if (!checkListTrusted(list, job)) continue;
        const copies = list.checks.filter(c => identity(c, definition, job, externalId) && !withdrawn.has(c.id));
        if (copies.length > 1) break;
        const copy = copies[0];
        if (copy && copy.status === 'completed' && copy.conclusion === payload.conclusion && copy.output?.title === payload.output.title
          && copy.output?.summary === payload.output.summary) return copy;
        if (copy) break;
      }
      throw error;
    }
  }
  async function discoverKnown(definition, job, externalId, withdrawn = new Set()) {
    const list = await github.readChecks(job.headSha);
    if (!checkListTrusted(list, job)) stop('check_discovery_unconfirmed');
    const matches = list.checks.filter(check => identity(check, definition, job, externalId) && !withdrawn.has(check.id));
    if (matches.length !== 1) stop('check_discovery_unconfirmed');
    return matches[0];
  }
  // The protected facts of the job, observed now and checked against the job, the batch claim, the qualification and the deployment.
  async function observeFacts(job, verified) {
    const facts = await authority.observe(job, batchClaim);
    if (!plain(facts)) stop('protected_facts_unconfirmed');
    if (retainedServerAnswerCurrent(facts) === null && Number.isFinite(Date.parse(facts.claimExpiresAt)) && Date.parse(facts.claimExpiresAt) <= clock()) stop('protected_lease_expired', true);
    if (!fresh(facts, clock())) stop('protected_facts_unconfirmed');
    if (!Object.entries(subjectOfV2(job)).every(([k, value]) => facts[k] === value)) stop('protected_subject_changed', true);
    if (!sameClaimGeneration(facts.claim, batchClaim)) stop('protected_claim_changed', true);
    if (facts.sourceAccepted !== true || facts.hostQualified !== true || facts.publisherQualified !== true || facts.ciPrincipalQualified !== true)
      stop('protected_qualification_missing', ['sourceAccepted', 'hostQualified', 'publisherQualified', 'ciPrincipalQualified'].some(k => facts[k] === false));
    if (!requiredRefs.every(k => facts[k] === deployment[k]) || facts.ciPrincipalBindingId !== deployment.ciPrincipalBindingId
      || verified.signer.sourceAcceptanceRef !== facts.sourceAcceptanceRef || verified.signer.qualificationRef !== facts.hostQualificationRef)
      stop('protected_qualification_changed', true);
    return facts;
  }
  // Generation 13 (DESIGN §57.2, Task 7b21f820): live authority is a Native answer at most FRESH_MS old (Decision 1100a0ed), and
  // Native's complete admission, which runs after the protected facts were observed, may itself take longer. The facts are then observed
  // once more, with every check of observeFacts and the same claim generation as `claim` (what the admission observed): the bound is
  // never widened, and only a real change (another claim generation, an expired lease, a qualification or subject change) is a change
  // of authorization. observeFacts refuses facts that are not fresh when they arrive (protected_facts_unconfirmed), so one observation
  // is enough and there is no second. Its exhaustion (no answer in its window, or the publication's window spent) has a code of its
  // own, protected_facts_reobservation_unavailable: it comes after a complete admission, so it is never the pre-admission exhaustion
  // the recoverable publisher may run again in the same window (runtime/one-shot-v2.mjs); before the write it is a clean, rerunnable
  // BLOCKED, after it the write is compensated as before (review round 2, MAJOR A).
  async function liveFacts(job, verified, facts, claim) {
    if (fresh(facts, clock())) return facts;
    try { facts = await observeFacts(job, verified); }
    catch (error) { if (reason(error) === 'native_claim_observation_unavailable') stop('protected_facts_reobservation_unavailable'); throw error; }
    if (!sameClaimGeneration(facts.claim, claim)) stop('lease_observations_disagree', true);
    return facts;
  }
  // What is left of the publication's pre-write observation window (authority.windowLeftMs, production only), or null; how much of it
  // is used (authority.windowUsedMs), or null without a window; the window the confirmation after the write will have
  // (authority.confirmationWindowMs, Owner Decision 36946d8b), or null without one.
  const windowLeft = () => (typeof authority.windowLeftMs === 'function' ? authority.windowLeftMs() : null);
  const windowUsed = () => (typeof authority.windowUsedMs === 'function' ? authority.windowUsedMs() : null);
  const confirmationWindow = () => (typeof authority.confirmationWindowMs === 'function' ? authority.confirmationWindowMs() : null);
  const slowestNativeRead = () => (typeof authority.slowestNativeReadMs === 'function' ? authority.slowestNativeReadMs() : 0);
  // The Native admission must still be live when the check is written (the port refuses an older one: prepareNativePublication) and
  // when the publication settles. Before anything is recorded an aged admission is a clean, rerunnable stop. After the write and its
  // read-back, an aged admission is re-evaluated once, completely (boundary), and must bind exactly what the write was authorized
  // under (bindingSha256, evidence); only a real change, or an admission that cannot be made live again, compensates the write.
  // Generation 13 (DESIGN §57.2, Owner Decision 36946d8b): whether the write can still be made and confirmed. Production (null or absent
  // methods: no windows) gives the observations before the write and those after it a window each. The write must fit what is left of
  // the pre-write window (WRITE_MARGIN_MS plus WRITE_NATIVE_CALLS times the slowest Native read before it; review round 6, MAJOR 1);
  // the confirmation, estimated as long as the boundary before the write (`confirmMs`: boundary().ms, the window it used from its first
  // observation on) plus CONFIRMATION_MARGIN_MS, must fit the post-write window. A write that cannot is not made: the publication ends
  // before anything is recorded, safe to run again with windows of its own (publication_window_short_before_write). Write steps slower
  // than the estimate still meet the recoverable publisher's reserve at the create (guardNewPublication, unchanged: UNCERTAIN).
  function writeFits(confirmMs) {
    const left = windowLeft(), confirm = confirmationWindow();
    return (left === null || left >= WRITE_MARGIN_MS + WRITE_NATIVE_CALLS * slowestNativeRead())
      && (confirm === null || confirm >= confirmMs + CONFIRMATION_MARGIN_MS);
  }
  async function liveAfterWrite(job, envelope, definition, before, after) {
    if (fresh(after.native, clock())) return after;
    const again = await boundary(job, envelope, definition);
    if (again.bindingSha256 !== before.bindingSha256 || again.verified.evidenceSha256 !== before.verified.evidenceSha256) stop('authorization_binding_changed', true);
    if (!fresh(again.native, clock())) stop('lease_expired_after_write', true);
    return again;
  }
  async function boundary(job, envelope, definition, expectedEvidenceSha256 = null) {
    let verified;
    try { verified = verifyResultV2({ job, envelope, signers, now: clock(), domain }); }
    catch { stop('execution_proof_refused', true); }
    if (expectedEvidenceSha256 && expectedEvidenceSha256 !== verified.evidenceSha256) stop('evidence_identity_conflict', true);
    // The time this boundary uses from its first observation on, that observation included (the proof check before it is not
    // counted): the window's own monotonic clock in production (windowUsedMs: 0 before the window's first observation, which this
    // one may be), the wall clock otherwise (review rounds 2 and 3, MINOR 1).
    const wallAt = clock(), usedAt = windowUsed();
    const used = () => { const now = windowUsed(); return usedAt !== null && now !== null ? Math.max(0, now - usedAt) : Math.max(0, clock() - wallAt); };
    let facts = await observeFacts(job, verified);
    const pr = await github.readPullRequest(job.pr);
    if (pr.state !== 'open' || pr.head?.sha !== job.headSha || !prBaseAcceptedV2(job, pr.base?.sha) || pr.base?.ref !== 'main'
      || pr.head?.repo?.full_name !== job.repo || pr.base?.repo?.full_name !== job.repo) stop('github_subject_changed', true);
    const packet = await readChangedPaths(job);
    if (!packet || Object.keys(packet).some(k => !['complete', 'pr', 'headSha', 'baseSha', 'paths'].includes(k))
      || packet.complete !== true || packet.pr !== job.pr || packet.headSha !== job.headSha || packet.baseSha !== job.baseSha
      || !Array.isArray(packet.paths) || !packet.paths.length || packet.paths.length > 3000 || new Set(packet.paths).size !== packet.paths.length
      || packet.paths.some(p => typeof p !== 'string' || !p || p.length > 4096 || /[\x00-\x1f\\:]/.test(p) || p.startsWith('/') || p.split('/').some(part => !part || part === '.' || part === '..')))
      stop('native_path_observation_unconfirmed');
    const native = await nativeAdmission.evaluatePr(job, packet, { batchClaim });
    if (!['clued.independent-ci.full-admission/2', 'clued.independent-ci.full-admission/3'].includes(native?.contract) || native.status !== 'ADMITTED' || native.domain !== domain) {
      const failure = fullAdmissionFailureV2(native);
      stop('full_admission_not_proven', false, { ...(failure ? { admissionReason: failure.reason } : {}), ...(failure?.admissionDiagnostic ? { admissionDiagnostic: failure.admissionDiagnostic } : {}) });
    }
    if (!admittedFactsMatchJobV2(native, job, clock(), { batchClaim })) stop('native_identity_changed', true);
    if (native.packetSha256 !== digest(packet) || !HASH.test(native.evaluationSha256 ?? '') || !ref(native.modeProofRef) || !ref(native.observationRef)) stop('full_admission_observation_unconfirmed');
    if (!plain(native.mode) || !ref(native.mode.state) || !ref(native.mode.layer)
      || !(ref(native.mode.policyVersion) || Number.isSafeInteger(native.mode.policyVersion))
      || !plain(native.mergeSlot) || !ref(native.mergeSlot.state)
      || !(native.ownerReview === null || plain(native.ownerReview) && ref(native.ownerReview.kind))
      || !Array.isArray(native.workflowGateFindings) || native.workflowGateFindings.length) stop('full_admission_incomplete');
    // Generation, not expires_at: a renewal between the two observations is not a disagreement.
    if (!sameClaimGeneration(facts.claim, native.observedClaim)) stop('lease_observations_disagree', true);
    facts = await liveFacts(job, verified, facts, native.observedClaim);
    try {
      const stillVerified = verifyResultV2({ job, envelope, signers, now: clock(), domain });
      if (canonical(stillVerified.signer) !== canonical(verified.signer)) stop('execution_proof_refused');
    } catch { stop('execution_proof_refused'); }
    // §38.8 n2: the PR base.sha read here is bound too, so the before and after reads of one publication must agree on it
    // (for a batch that tests the head it is T anyway; a train front batch reads it as a fact).
    return { verified, native, packet, facts, ms: used(), bindingSha256: digest({ subject: subjectOfV2(job), claim: claimGeneration(native.observedClaim), executionPolicy: native.executionPolicy, prBaseSha: pr.base.sha,
      ...(native.publicationRequired ? { guarded: native.guarded, publicationRequired: true, headAuthorizationId: native.headAuthorizationId } : {}),
      mode: native.mode, mergeSlot: slotBindingFor(job, native.mergeSlot), ownerReview: native.ownerReview, refs: Object.fromEntries(requiredRefs.map(k => [k, facts[k]])),
      ciPrincipalBindingId: facts.ciPrincipalBindingId, signer: verified.signer, appId: definition.appId, name: definition.name }) };
  }
  async function transition(key, phase, next, details) {
    try { return await journal.transition(key, phase, next, details); } catch { return null; }
  }
  // republish: { n } when publish() may follow this withdrawal by republication n + 1 (a staged publication withdrawn after its write).
  async function revoke({ key, phase, known, definition, job, externalId, cause, sideEffects, admissionReason, admissionDiagnostic, republish = null }) {
    // full_admission_not_proven hides the port's own reason; wording follows that reason when it is known.
    const whyWithdrawn = cause === 'full_admission_not_proven' && admissionReason ? admissionReason : cause;
    const again = republish !== null && withdrawnForUnavailability(whyWithdrawn);
    const revocationKey = digest({ action: 'staged-independent-check-revoke/2', effectKey: key, checkRunId: known.id });
    let revocationPhase = 'intent', revocationLogged = false;
    try {
      const intent = await journal.begin(revocationKey, { checkRunId: known.id, appId: definition.appId, headSha: job.headSha, externalId });
      if (intent.existing) return { status: 'UNCERTAIN', effectKey: key, reason: 'revocation_reconciliation_required', sideEffects, productionAuthorized: false };
      await journal.transition(revocationKey, 'intent', 'authorized'); revocationPhase = 'authorized';
      await journal.transition(revocationKey, 'authorized', 'sent'); revocationPhase = 'sent'; revocationLogged = true;
    } catch {
      if (phase !== 'sent') return { status: 'UNCERTAIN', effectKey: key, reason: 'revocation_journal_unconfirmed', sideEffects, productionAuthorized: false };
    }
    try {
      sideEffects++;
      const patched = await github.revokeCheck(known.id, { status: 'completed', conclusion: 'failure',
        output: { title: withdrawalTitle('Independent CI', whyWithdrawn), summary: `Staged Native observation; reconcile ${key}${withdrawalNote(whyWithdrawn)}` } });
      if (!identity(patched, definition, job, externalId) || patched.status !== 'completed' || patched.conclusion !== 'failure') stop('revocation_unconfirmed');
      await readback(known, definition, job, externalId, 'failure');
      if (revocationLogged) await journal.transition(revocationKey, 'sent', 'settled', { checkRunId: known.id, conclusion: 'failure' });
      const current = await journal.read(key);
      if (!['sent', 'uncertain', 'settled'].includes(current?.state)) stop('revocation_state_unconfirmed');
      await journal.transition(key, current.state, 'revoked', { checkRunId: known.id, externalId, reason: cause, ...(admissionReason ? { admissionReason } : {}), ...(admissionDiagnostic ? { admissionDiagnostic } : {}),
        ...(again ? { republishable: true } : {}) });
      return { status: 'REVOKED', effectKey: key, checkRunId: known.id, reason: cause, ...(admissionDiagnostic ? { admissionDiagnostic } : {}), sideEffects, productionAuthorized: false,
        ...(republish?.n ? { republication: republish.n } : {}), ...(again && republish.n < MAX_REPUBLICATIONS ? { republishSafe: true } : {}) };
    } catch {
      if (revocationPhase === 'sent') await transition(revocationKey, 'sent', 'uncertain', { reason: 'revocation_unconfirmed', checkRunId: known.id });
      if (phase === 'sent') await transition(key, 'sent', 'uncertain', { reason: 'revocation_unconfirmed', checkRunId: known.id, externalId });
      return { status: 'UNCERTAIN', effectKey: key, reason: 'revocation_unconfirmed', sideEffects, productionAuthorized: false };
    }
  }
  return Object.freeze({
    fixture: domain === 'fixture',
    async publish(input) {
      if (!configured) return { status: 'BLOCKED', reason: 'staged_publisher_not_configured', sideEffects: 0, productionAuthorized: false };
      let job, envelope, definition, key, mutex, externalId, previous, before, original = null, republication = 0;
      const withdrawn = new Set();
      try {
        if (!plain(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'job') || !Object.hasOwn(input, 'envelope')) stop('publication_input_invalid');
        job = structuredClone(input.job); envelope = structuredClone(input.envelope); validateJobV2(job);
        if (job.repo !== deployment.repository) stop('repository_not_configured');
        definition = definitionFor(job);
        key = scanEffectKeyV2(job, definition);
        // §41.4: a train front batch holds its own K(head, S, role), apart from the non-front run of H.
        mutex = { repo: job.repo, headSha: job.headSha, role: job.role, checkName: definition.name, appId: definition.appId, ...(isTrainFrontJobV2(job) ? { testSha: job.testSha } : {}) };
        externalId = scanExternalIdV2(job);
        previous = await journal.read(key);
        if (previous && previous.state !== 'settled') {
          if (!republishable(previous)) return { status: previous.state === 'revoked' ? 'REVOKED' : 'RECONCILIATION_REQUIRED', effectKey: key, sideEffects: 0, productionAuthorized: false };
          // Generation 28 (ADR 0015): the original was withdrawn for unavailability only. The first republication that is not itself so
          // withdrawn is this publication's own: absent (publish it now), settled (re-verified like any settled publication) or anything
          // else (as for the original: REVOKED or RECONCILIATION_REQUIRED, never a further one). The signed result must be the original's.
          original = { key, externalId, evidenceSha256: previous.subject?.evidenceSha256 ?? null };
          if (positive(previous.details?.checkRunId)) withdrawn.add(previous.details.checkRunId);
          let slot = null;
          for (let n = 1; n <= MAX_REPUBLICATIONS && !slot; n++) {
            const k = republicationKey(original.key, n), record = await journal.read(k);
            if (!record || record.state === 'settled') slot = { n, k, record };
            else if (!republishable(record)) return { status: record.state === 'revoked' ? 'REVOKED' : 'RECONCILIATION_REQUIRED', effectKey: k, republication: n, sideEffects: 0, productionAuthorized: false };
            else if (positive(record.details?.checkRunId)) withdrawn.add(record.details.checkRunId);
          }
          if (!slot) return { status: 'REVOKED', effectKey: key, reason: 'republication_limit_reached', sideEffects: 0, productionAuthorized: false };
          republication = slot.n; key = slot.k; previous = slot.record;
        }
        before = await boundary(job, envelope, definition, previous?.subject.evidenceSha256 ?? original?.evidenceSha256 ?? null);
        if (previous) {
          if (previous.subject.evidenceSha256 !== before.verified.evidenceSha256) stop('evidence_identity_conflict', true);
          await readback({ id: previous.details.checkRunId }, definition, job, externalId, previous.details.conclusion);
          return { status: 'SETTLED', effectKey: key, checkRunId: previous.details.checkRunId, sideEffects: 0, productionAuthorized: domain === 'production', mode: 'staged' };
        }
        // A republication publishes only what the original did: never under a Native publication (see MAX_REPUBLICATIONS).
        if (republication && before.native.publicationRequired === true) stop('republication_native_unsupported');
        if (!original && await onGithubOnly(mutex, job, definition)) return { status: 'BLOCKED', effectKey: key, reason: ROLE_ALREADY_ON_GITHUB_REASON, sideEffects: 0, productionAuthorized: false };
        // DESIGN 51 (B): GitHub must answer once more, right before anything is recorded or written. If it cannot (after the bounded
        // read retry), the publication ends here with nothing in the journal, no K and nothing on GitHub, safe to run again, instead
        // of writing a check whose verification then cannot be done.
        await probeGithub(job);
        if (!fresh(before.native, clock())) stop('native_admission_aged_before_write');
        if (!writeFits(before.ms)) stop('publication_window_short_before_write');
      } catch (error) {
        if (previous?.state === 'settled' && positive(previous.details?.checkRunId)) {
          const known = { id: previous.details.checkRunId, app: { id: definition.appId }, head_sha: job.headSha, name: definition.name, external_id: externalId };
          return revoke({ key, phase: 'settled', known, definition, job, externalId, cause: reason(error), sideEffects: 0, ...admissionOf(error) });
        }
        return { status: previous ? 'UNCERTAIN' : 'BLOCKED', ...(key ? { effectKey: key } : {}), reason: reason(error), ...(!previous && passingFault(error) ? { safeToRerun: true } : {}), ...(admissionOf(error).admissionDiagnostic ? { admissionDiagnostic: admissionOf(error).admissionDiagnostic } : {}),
          ...(republication ? { republication } : {}), sideEffects: 0, productionAuthorized: false };
      }
      let phase = 'intent', sent = false, known = null, sideEffects = 0;
      try {
        // K(head, role) first: another holder of this role on this head refuses the publication before its own key exists.
        try {
          // A republication holds K under the original holder (the same record: an existing claim, never a conflict).
          await claimRolePublication(journal, mutex, { path: 'local', effectKey: original?.key ?? key, externalId: original?.externalId ?? externalId });
        } catch (error) {
          if (error?.code === 'role_already_published_on_head') return { status: 'BLOCKED', effectKey: key, reason: 'role_already_published_on_head', sideEffects: 0, productionAuthorized: false };
          throw error;
        }
        const intent = await journal.begin(key, { subject: subjectOfV2(job), definition, evidenceSha256: before.verified.evidenceSha256,
          observationKind: 'staged-native-observation', nativeObservationSha256: before.native.observationSha256, externalId,
          compensation: 'known-check-patch-failure-on-any-unsettled-write', ...(republication ? { republicationOf: original.key, republication } : {}) });
        if (intent.existing) return { status: 'RECONCILIATION_REQUIRED', effectKey: key, sideEffects: 0, productionAuthorized: false };
        await journal.transition(key, 'intent', 'authorized', { observationKind: 'staged-native-observation', nativeObservationSha256: before.native.observationSha256 }); phase = 'authorized';
        if (!fresh(before.native, clock())) stop('lease_expired_before_write', true);
        const payload = { name: definition.name, head_sha: job.headSha, status: 'completed', conclusion: before.verified.payload.conclusion,
          external_id: externalId, output: { title: `${definition.name}: ${before.verified.payload.conclusion}`,
            summary: `Independent CI job ${job.id} (attempt ${job.attempt}${republication ? `, republication ${republication} after a withdrawn verification` : ''}); signed execution sha256 ${before.verified.evidenceSha256}; staged Native observation sha256 ${before.native.observationSha256}. ${before.native.publicationRequired ? 'The protected publisher attaches its Native Receipt.' : 'No Native publication ticket or Receipt is asserted.'}` } };
        const nativeHandle = await prepareNativePublication(github, { facts: before.native, packet: before.packet, payload });
        await journal.transition(key, 'authorized', 'sent', { externalId, nativeObservationSha256: before.native.observationSha256 }); phase = 'sent'; sent = true; sideEffects++;
        const created = await createOrAdopt(payload, nativeHandle, definition, job, externalId, withdrawn);
        if (!identity(created, definition, job, externalId)) stop('check_identity_unconfirmed'); known = created;
        let after = await boundary(job, envelope, definition);
        if (after.bindingSha256 !== before.bindingSha256 || after.verified.evidenceSha256 !== before.verified.evidenceSha256) stop('authorization_binding_changed', true);
        await readback(known, definition, job, externalId, before.verified.payload.conclusion);
        after = await liveAfterWrite(job, envelope, definition, before, after);
        await journal.transition(key, 'sent', 'settled', { checkRunId: known.id, externalId, conclusion: before.verified.payload.conclusion,
          observationKind: 'staged-native-observation', nativeObservationBeforeSha256: before.native.observationSha256, nativeObservationAfterSha256: after.native.observationSha256,
          evidenceSha256: before.verified.evidenceSha256 });
        return { status: 'SETTLED', mode: 'staged', effectKey: key, checkRunId: known.id, evidenceSha256: before.verified.evidenceSha256, ...(republication ? { republication } : {}),
          nativeObservationBeforeSha256: before.native.observationSha256, nativeObservationAfterSha256: after.native.observationSha256, sideEffects, productionAuthorized: domain === 'production' };
      } catch (error) {
        if (sent && !known && sideEffects === 1 && nativePublicationNoPostProof(error)?.notSent === true) {
          await transition(key, phase, 'revoked', { reason: 'native_publication_not_sent', notSent: true, externalId });
          return { status: 'BLOCKED', effectKey: key, reason: 'native_publication_not_sent', sideEffects: 0, productionAuthorized: false };
        }
        if (sent && !known) {
          try { known = await discoverKnown(definition, job, externalId, withdrawn); }
          catch { /* UNCERTAIN records local uncertainty; it cannot revoke a remote success. */ }
        }
        if (sent && known) return revoke({ key, phase, known, definition, job, externalId, cause: reason(error), sideEffects, ...admissionOf(error),
          republish: before.native.publicationRequired === true ? null : { n: republication } });
        await transition(key, phase, sent ? 'uncertain' : 'not_sent', { reason: reason(error), ...(known ? { checkRunId: known.id, externalId } : {}) });
        return { status: sent ? 'UNCERTAIN' : 'BLOCKED', effectKey: key, reason: reason(error), ...(republication ? { republication } : {}), sideEffects, productionAuthorized: false };
      }
    }
  });
}
