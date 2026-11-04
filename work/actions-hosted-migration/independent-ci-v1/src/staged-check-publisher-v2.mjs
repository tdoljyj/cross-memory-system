// Scanner check publication for job contract v2 (stages 3, 5, 7 of Source v2; DESIGN S6).
// NOTE: this is a NEW v2 file next to staged-check-publisher.mjs (v1). v1 itself was changed by the hosted
// relay work (b5a7db45: publishHosted, proof kinds, K before the own key; PR-A review: K on the v1 local path
// only with localRoleMutex, which the v1 one-shot never sets). This file is v1 with exactly these changes,
// so the two can be reconciled by diff:
//   - validateJobV2 / subjectOfV2 / verifyResultV2 (claim-free subject, signed-result contract v2);
//   - effect key = scanEffectKeyV2(job, definition) and external_id = scanExternalIdV2(job): a content
//     proof, one effect per (content, attempt), the same across claims (design §5.5);
//   - the complete admission must be contract /2 and observe the batch claim generation again
//     (A-strict stickiness); the protected observation and the admission must agree on the claim
//     GENERATION (claim id, fence, epoch), not on expires_at (a renewal between the two observations
//     no longer reports lease_observations_disagree);
//   - nothing else: same journal states, same revocation, same readback and the same "a settled
//     effect is only re-verified, never re-posted" rule (a settled job id is never run again).
// PR-A integration (free-minutes design S18/S19): the hosted relay changes of v1 (b5a7db45) are merged in,
// so the v2 path has them too, with the v2 job and claim rules:
//   - publishHosted({ subject, attempt, envelope }) with the clued.independent-ci.hosted-attestation/1
//     envelope, re-attested from fresh GitHub facts by the installed hostedVerifier before any journal
//     write (only this entry accepts that contract); the subject's claim generation must be the batch claim;
//   - the role-on-head mutex K(head, role) (effect-journal.mjs#claimRolePublication) is begun before the
//     own effect key by BOTH entries, local and relay, in the same journal (state\v2\effects-scan);
//   - the boundary takes a proof { kind: 'signed' | 'hosted' } instead of a bare signed envelope.
// Resident primary/standby design v0.4 §6.2 (C4, Task c2af8d17), both entries: before a role's first publication, once
// the boundary passed, a role this journal knows nothing of (no own effect key, no K(head, role)) is read back on
// GitHub (published-on-github-v2.mjs). A check of App 5368905 of the same name there, published by another node or
// install, ends the publication cleanly with role_already_on_github: no K, no effect key, nothing posted or revoked,
// no HALT. Whatever this journal knows keeps its existing path (a settled key is re-verified; K held by the other path
// is role_already_published_on_head). A read-back that is not complete refuses (fail closed).
import { prepareNativePublication, nativePublicationNoPostProof } from '../../../../scripts/ci/clued-independent-publication-port.mjs';
import { canonical, digest } from './proof.mjs';
import { freshStamp, retainedServerAnswerCurrent } from './clock-skew.mjs';
import { validateJobV2, SCANNER_ROLES_V2, subjectOfV2, scanEffectKeyV2, scanExternalIdV2, sameClaimGeneration, claimGeneration, makeJobV2, prBaseAcceptedV2, isTrainFrontJobV2, frontJobIdsV2 } from './job-v2.mjs';
import { verifyResultV2 } from './proof-v2.mjs';
import { admittedFactsMatchJobV2 } from './full-admission-v2.mjs';
import { claimRolePublication, readRolePublication, rolePublicationKey } from './effect-journal.mjs';
import { relayExternalId, validateHostedEnvelope } from './hosted-relay-v1/attest.mjs';
import { ROLE_ALREADY_ON_GITHUB_REASON, publishedNames } from './published-on-github-v2.mjs';

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const positive = value => Number.isSafeInteger(value) && value > 0;
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const ref = value => typeof value === 'string' && value.length > 0 && value.length <= 1000 && !/[\x00-\x1f]/.test(value);
const stop = (code, drift = false) => { throw Object.assign(new Error(code), { code, drift }); };
// An uncoded exception is never a transport fact (PR-A review MINOR 5): it is not a transient code.
const reason = error => /^[a-z][a-z0-9_]{0,80}$/.test(error?.code ?? '') ? error.code : 'publication_operation_unconfirmed';
const fresh = (facts, now) => retainedServerAnswerCurrent(facts)
  ?? (freshStamp(Date.parse(facts.observedAt), now) && Date.parse(facts.claimExpiresAt) > now);
const requiredRefs = ['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef'];
const SUBJECT_KEYS = ['baseSha', 'claimId', 'epoch', 'fence', 'headSha', 'pr', 'repo', 'sourceManifestSha256'];

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
// hostedVerifier: the installed hosted relay verifier (hosted-relay-v1/stage.mjs), for publishHosted only.
export function createStagedCheckPublisherV2({ nativeAdmission, authority, github, journal, signers,
  configuredChecks, readChangedPaths, protectedDeployment, batchClaim, clock = Date.now, domain = 'production', hostedVerifier = null } = {}) {
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
  const hostedConfigured = configured && typeof hostedVerifier?.confirm === 'function' && HASH.test(hostedVerifier.registrySha256 ?? '')
    && positive(hostedVerifier.publisherAppId) && (domain === 'fixture') === (hostedVerifier.fixture === true);

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
  async function discoverKnown(definition, job, externalId) {
    const list = await github.readChecks(job.headSha);
    if (list?.complete !== true || !Array.isArray(list.checks) || list.checks.length > 10000
      || list.checks.some(c => !plain(c) || !positive(c.id) || c.head_sha !== job.headSha)
      || new Set(list.checks.map(c => c.id)).size !== list.checks.length) stop('check_discovery_unconfirmed');
    const matches = list.checks.filter(check => identity(check, definition, job, externalId));
    if (matches.length !== 1) stop('check_discovery_unconfirmed');
    return matches[0];
  }
  // proof: { kind: 'signed', envelope } for a local formal role, or { kind: 'hosted', envelope, fresh } for a
  // hosted relay. `fresh` re-attests the hosted run from new GitHub facts (before the write); without it only
  // the envelope's own integrity is rechecked (after the write).
  async function proofOf(job, proof) {
    if (proof.kind === 'signed') {
      try { return verifyResultV2({ job, envelope: proof.envelope, signers, now: clock(), domain }); }
      catch { stop('execution_proof_refused', true); }
    }
    try { validateHostedEnvelope(proof.envelope); } catch { stop('hosted_attestation_invalid', true); }
    if (proof.fresh) {
      let confirmed;
      try { confirmed = await hostedVerifier.confirm(proof.envelope); } catch { stop('hosted_attestation_not_confirmed'); }
      if (confirmed?.confirmed !== true || confirmed.attestationSha256 !== proof.envelope.attestationSha256) stop('hosted_attestation_not_confirmed');
    }
    return { evidenceSha256: proof.envelope.attestationSha256, payload: { conclusion: 'success' }, signer: null };
  }
  async function boundary(job, proof, definition, expectedEvidenceSha256 = null) {
    const verified = await proofOf(job, proof);
    if (expectedEvidenceSha256 && expectedEvidenceSha256 !== verified.evidenceSha256) stop('evidence_identity_conflict', true);
    const facts = await authority.observe(job, batchClaim);
    if (!plain(facts)) stop('protected_facts_unconfirmed');
    if (retainedServerAnswerCurrent(facts) === null && Number.isFinite(Date.parse(facts.claimExpiresAt)) && Date.parse(facts.claimExpiresAt) <= clock()) stop('protected_lease_expired', true);
    if (!fresh(facts, clock())) stop('protected_facts_unconfirmed');
    if (!Object.entries(subjectOfV2(job)).every(([k, value]) => facts[k] === value)) stop('protected_subject_changed', true);
    if (!sameClaimGeneration(facts.claim, batchClaim)) stop('protected_claim_changed', true);
    if (facts.sourceAccepted !== true || facts.hostQualified !== true || facts.publisherQualified !== true || facts.ciPrincipalQualified !== true)
      stop('protected_qualification_missing', ['sourceAccepted', 'hostQualified', 'publisherQualified', 'ciPrincipalQualified'].some(k => facts[k] === false));
    if (!requiredRefs.every(k => facts[k] === deployment[k]) || facts.ciPrincipalBindingId !== deployment.ciPrincipalBindingId
      || (verified.signer !== null && (verified.signer.sourceAcceptanceRef !== facts.sourceAcceptanceRef
        || verified.signer.qualificationRef !== facts.hostQualificationRef)))
      stop('protected_qualification_changed', true);
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
    if (!['clued.independent-ci.full-admission/2', 'clued.independent-ci.full-admission/3'].includes(native?.contract) || native.status !== 'ADMITTED' || native.domain !== domain) stop('full_admission_not_proven');
    if (!admittedFactsMatchJobV2(native, job, clock(), { batchClaim })) stop('native_identity_changed', true);
    if (native.packetSha256 !== digest(packet) || !HASH.test(native.evaluationSha256 ?? '') || !ref(native.modeProofRef) || !ref(native.observationRef)) stop('full_admission_observation_unconfirmed');
    if (!plain(native.mode) || !ref(native.mode.state) || !ref(native.mode.layer)
      || !(ref(native.mode.policyVersion) || Number.isSafeInteger(native.mode.policyVersion))
      || !plain(native.mergeSlot) || !ref(native.mergeSlot.state)
      || !(native.ownerReview === null || plain(native.ownerReview) && ref(native.ownerReview.kind))
      || !Array.isArray(native.workflowGateFindings) || native.workflowGateFindings.length) stop('full_admission_incomplete');
    // Generation, not expires_at: a renewal between the two observations is not a disagreement.
    if (!sameClaimGeneration(facts.claim, native.observedClaim)) stop('lease_observations_disagree', true);
    if (!fresh(facts, clock())) stop('protected_facts_expired_during_admission');
    if (proof.kind === 'signed') {
      try {
        const stillVerified = verifyResultV2({ job, envelope: proof.envelope, signers, now: clock(), domain });
        if (canonical(stillVerified.signer) !== canonical(verified.signer)) stop('execution_proof_refused');
      } catch { stop('execution_proof_refused'); }
    } else {
      try { validateHostedEnvelope(proof.envelope); } catch { stop('hosted_attestation_invalid'); }
    }
    // §38.8 n2: the PR base.sha read here is bound too, so the before and after reads of one publication must agree on it
    // (for a batch that tests the head it is T anyway; a train front batch reads it as a fact).
    return { verified, native, packet, bindingSha256: digest({ subject: subjectOfV2(job), claim: claimGeneration(native.observedClaim), executionPolicy: native.executionPolicy, prBaseSha: pr.base.sha,
      ...(native.publicationRequired ? { guarded: native.guarded, publicationRequired: true, headAuthorizationId: native.headAuthorizationId } : {}),
      mode: native.mode, mergeSlot: slotBindingFor(job, native.mergeSlot), ownerReview: native.ownerReview, refs: Object.fromEntries(requiredRefs.map(k => [k, facts[k]])),
      ciPrincipalBindingId: facts.ciPrincipalBindingId, signer: verified.signer, appId: definition.appId, name: definition.name }) };
  }
  // A settled relay publication, checked again before it is reported settled: the current hosted envelope's
  // integrity, the protected facts and claim, the PR subject and a fresh complete Native admission, then the
  // GitHub read-back of the known check. Any drift revokes the known check once; nothing is ever re-posted.
  async function reverifySettled({ key, settled, definition, job, externalId, envelope }) {
    try {
      await boundary(job, { kind: 'hosted', envelope, fresh: false }, definition);
      await readback({ id: settled.details.checkRunId }, definition, job, externalId, 'success');
    } catch (error) {
      const known = { id: settled.details.checkRunId, app: { id: definition.appId }, head_sha: job.headSha, name: definition.name, external_id: externalId };
      return revoke({ key, phase: 'settled', known, definition, job, externalId, cause: reason(error), sideEffects: 0 });
    }
    return { status: 'SETTLED', mode: 'hosted-relay', effectKey: key, checkRunId: settled.details.checkRunId, externalId, sideEffects: 0, productionAuthorized: domain === 'production' };
  }
  async function transition(key, phase, next, details) {
    try { return await journal.transition(key, phase, next, details); } catch { return null; }
  }
  async function revoke({ key, phase, known, definition, job, externalId, cause, sideEffects }) {
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
        output: { title: 'Independent CI authorization changed', summary: `Staged Native observation; reconcile ${key}` } });
      if (!identity(patched, definition, job, externalId) || patched.status !== 'completed' || patched.conclusion !== 'failure') stop('revocation_unconfirmed');
      await readback(known, definition, job, externalId, 'failure');
      if (revocationLogged) await journal.transition(revocationKey, 'sent', 'settled', { checkRunId: known.id, conclusion: 'failure' });
      const current = await journal.read(key);
      if (!['sent', 'uncertain', 'settled'].includes(current?.state)) stop('revocation_state_unconfirmed');
      await journal.transition(key, current.state, 'revoked', { checkRunId: known.id, externalId, reason: cause });
      return { status: 'REVOKED', effectKey: key, checkRunId: known.id, reason: cause, sideEffects, productionAuthorized: false };
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
      let job, envelope, definition, key, mutex, externalId, previous, before;
      try {
        if (!plain(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'job') || !Object.hasOwn(input, 'envelope')) stop('publication_input_invalid');
        job = structuredClone(input.job); envelope = structuredClone(input.envelope); validateJobV2(job);
        if (job.repo !== deployment.repository) stop('repository_not_configured');
        definition = definitionFor(job);
        key = scanEffectKeyV2(job, definition);
        // §41.4: a train front batch holds its own K(head, S, role), apart from the non-front run of H (never relayed).
        mutex = { repo: job.repo, headSha: job.headSha, role: job.role, checkName: definition.name, appId: definition.appId, ...(isTrainFrontJobV2(job) ? { testSha: job.testSha } : {}) };
        externalId = scanExternalIdV2(job);
        previous = await journal.read(key);
        if (previous && previous.state !== 'settled') return { status: previous.state === 'revoked' ? 'REVOKED' : 'RECONCILIATION_REQUIRED', effectKey: key, sideEffects: 0, productionAuthorized: false };
        before = await boundary(job, { kind: 'signed', envelope }, definition, previous?.subject.evidenceSha256);
        if (previous) {
          if (previous.subject.evidenceSha256 !== before.verified.evidenceSha256) stop('evidence_identity_conflict', true);
          await readback({ id: previous.details.checkRunId }, definition, job, externalId, previous.details.conclusion);
          return { status: 'SETTLED', effectKey: key, checkRunId: previous.details.checkRunId, sideEffects: 0, productionAuthorized: domain === 'production', mode: 'staged' };
        }
        if (await onGithubOnly(mutex, job, definition)) return { status: 'BLOCKED', effectKey: key, reason: ROLE_ALREADY_ON_GITHUB_REASON, sideEffects: 0, productionAuthorized: false };
      } catch (error) {
        if (previous?.state === 'settled' && positive(previous.details?.checkRunId)) {
          const known = { id: previous.details.checkRunId, app: { id: definition.appId }, head_sha: job.headSha, name: definition.name, external_id: externalId };
          return revoke({ key, phase: 'settled', known, definition, job, externalId, cause: reason(error), sideEffects: 0 });
        }
        return { status: previous ? 'UNCERTAIN' : 'BLOCKED', ...(key ? { effectKey: key } : {}), reason: reason(error), sideEffects: 0, productionAuthorized: false };
      }
      let phase = 'intent', sent = false, known = null, sideEffects = 0;
      try {
        // K(head, role) first: a hosted relay that already holds this role on this head refuses the local
        // publication before its own key exists (free-minutes design §7.4).
        try {
          await claimRolePublication(journal, mutex, { path: 'local', effectKey: key, externalId });
        } catch (error) {
          if (error?.code === 'role_already_published_on_head') return { status: 'BLOCKED', effectKey: key, reason: 'role_already_published_on_head', sideEffects: 0, productionAuthorized: false };
          throw error;
        }
        const intent = await journal.begin(key, { subject: subjectOfV2(job), definition, evidenceSha256: before.verified.evidenceSha256,
          observationKind: 'staged-native-observation', nativeObservationSha256: before.native.observationSha256, externalId,
          compensation: 'known-check-patch-failure-on-any-unsettled-write' });
        if (intent.existing) return { status: 'RECONCILIATION_REQUIRED', effectKey: key, sideEffects: 0, productionAuthorized: false };
        await journal.transition(key, 'intent', 'authorized', { observationKind: 'staged-native-observation', nativeObservationSha256: before.native.observationSha256 }); phase = 'authorized';
        if (!fresh(before.native, clock())) stop('lease_expired_before_write', true);
        const payload = { name: definition.name, head_sha: job.headSha, status: 'completed', conclusion: before.verified.payload.conclusion,
          external_id: externalId, output: { title: `${definition.name}: ${before.verified.payload.conclusion}`,
            summary: `Independent CI job ${job.id} (attempt ${job.attempt}); signed execution sha256 ${before.verified.evidenceSha256}; staged Native observation sha256 ${before.native.observationSha256}. ${before.native.publicationRequired ? 'The protected publisher attaches its Native Receipt.' : 'No Native publication ticket or Receipt is asserted.'}` } };
        const nativeHandle = await prepareNativePublication(github, { facts: before.native, packet: before.packet, payload });
        await journal.transition(key, 'authorized', 'sent', { externalId, nativeObservationSha256: before.native.observationSha256 }); phase = 'sent'; sent = true; sideEffects++;
        const created = await github.createCheck(payload, nativeHandle);
        if (!identity(created, definition, job, externalId)) stop('check_identity_unconfirmed'); known = created;
        const after = await boundary(job, { kind: 'signed', envelope }, definition);
        if (after.bindingSha256 !== before.bindingSha256 || after.verified.evidenceSha256 !== before.verified.evidenceSha256) stop('authorization_binding_changed', true);
        await readback(known, definition, job, externalId, before.verified.payload.conclusion);
        if (!fresh(after.native, clock())) stop('lease_expired_after_write', true);
        await journal.transition(key, 'sent', 'settled', { checkRunId: known.id, externalId, conclusion: before.verified.payload.conclusion,
          observationKind: 'staged-native-observation', nativeObservationBeforeSha256: before.native.observationSha256, nativeObservationAfterSha256: after.native.observationSha256,
          evidenceSha256: before.verified.evidenceSha256 });
        return { status: 'SETTLED', mode: 'staged', effectKey: key, checkRunId: known.id, evidenceSha256: before.verified.evidenceSha256,
          nativeObservationBeforeSha256: before.native.observationSha256, nativeObservationAfterSha256: after.native.observationSha256, sideEffects, productionAuthorized: domain === 'production' };
      } catch (error) {
        if (sent && !known && sideEffects === 1 && nativePublicationNoPostProof(error)?.notSent === true) {
          await transition(key, phase, 'revoked', { reason: 'native_publication_not_sent', notSent: true, externalId });
          return { status: 'BLOCKED', effectKey: key, reason: 'native_publication_not_sent', sideEffects: 0, productionAuthorized: false };
        }
        if (sent && !known) {
          try { known = await discoverKnown(definition, job, externalId); }
          catch { /* UNCERTAIN records local uncertainty; it cannot revoke a remote success. */ }
        }
        if (sent && known) return revoke({ key, phase, known, definition, job, externalId, cause: reason(error), sideEffects });
        await transition(key, phase, sent ? 'uncertain' : 'not_sent', { reason: reason(error), ...(known ? { checkRunId: known.id, externalId } : {}) });
        return { status: sent ? 'UNCERTAIN' : 'BLOCKED', effectKey: key, reason: reason(error), sideEffects, productionAuthorized: false };
      }
    },
    // Hosted relay publication (design S17/S18, rules E9 and E10), v2. Input:
    //   subject: { repo, pr, headSha, baseSha, claimId, fence, epoch, sourceManifestSha256 } (the claim fields
    //            must be the batch claim generation; sourceManifestSha256 is the CI Source of the jobs)
    //   attempt: the per-head attempt (1, or 2 for the one automatic attempt 2)
    //   envelope: clued.independent-ci.hosted-attestation/1 from the relay stage
    // Every result carries roleMutex { key, held }: once K is held by this relay, only SETTLED is a usable
    // outcome; anything else needs reconciliation, because K now refuses the local path for this role on this head.
    async publishHosted(input) {
      const result = (fields, mutexKey = null, held = false) => ({ productionAuthorized: false, ...fields, roleMutex: { key: mutexKey, held } });
      if (!hostedConfigured) return result({ status: 'BLOCKED', reason: 'hosted_relay_not_configured', sideEffects: 0 });
      let job, envelope, definition, key, mutex, mutexKey = null, externalId, previous, before;
      try {
        if (!plain(input) || Object.keys(input).sort().join('|') !== 'attempt|envelope|subject') stop('publication_input_invalid');
        envelope = structuredClone(input.envelope);
        try { validateHostedEnvelope(envelope); } catch { stop('hosted_attestation_invalid'); }
        const subject = input.subject;
        if (!plain(subject) || Object.keys(subject).sort().join('|') !== SUBJECT_KEYS.join('|')) stop('publication_input_invalid');
        // A-strict: the relay publishes under the batch claim generation stage 1 recorded, never another one.
        if (!sameClaimGeneration(subject, batchClaim)) stop('hosted_claim_changed', true);
        // The installed evaluator takes a v2 job-shaped subject; its id is the deterministic content id of
        // the role. It is never issued to the bridge, scheduled or published under (the relay has its own
        // effect key and external id), so a relayed role never gets a local run.
        try {
          // The relay never carries a train front batch (relay-entry-v2.mjs refuses S != H): it tests the head itself.
          job = makeJobV2({ repo: subject.repo, pr: subject.pr, headSha: subject.headSha, baseSha: subject.baseSha, testSha: subject.headSha, role: envelope.role,
            sourceManifestSha256: subject.sourceManifestSha256, createdAt: new Date(clock()).toISOString(), attempt: input.attempt });
        } catch { stop('publication_input_invalid'); }
        if (job.repo !== deployment.repository) stop('repository_not_configured');
        if (envelope.repository !== job.repo || envelope.pr !== job.pr || envelope.headSha !== job.headSha || envelope.baseSha !== job.baseSha) stop('hosted_subject_mismatch');
        if (envelope.registrySha256 !== hostedVerifier.registrySha256) stop('hosted_registry_changed');
        definition = definitionFor(job);
        if (definition.name !== envelope.checkName || definition.appId !== hostedVerifier.publisherAppId) stop('hosted_check_definition_mismatch');
        externalId = relayExternalId({ role: job.role, headSha: job.headSha, runId: envelope.runId, runAttempt: envelope.runAttempt });
        mutex = { repo: job.repo, headSha: job.headSha, role: job.role, checkName: definition.name, appId: definition.appId };
        mutexKey = rolePublicationKey(mutex);
        key = digest({ action: 'hosted-relay-check/2', roleMutexKey: mutexKey, externalId, definition });
        previous = await journal.read(key);
        if (previous) {
          // Re-entry never resends: anything but settled is reconciliation. A settled relay is re-verified like
          // publish() does (PR head, protected facts and claim, fresh Native admission, read-back); any drift
          // compensates the known check once (revoked), never re-posts.
          if (previous.state !== 'settled') return result({ status: previous.state === 'revoked' ? 'REVOKED' : 'RECONCILIATION_REQUIRED', effectKey: key, sideEffects: 0 }, mutexKey, true);
          return { ...(await reverifySettled({ key, settled: previous, definition, job, externalId, envelope })), roleMutex: { key: mutexKey, held: true } };
        }
        before = await boundary(job, { kind: 'hosted', envelope, fresh: true }, definition);
        if (await onGithubOnly(mutex, job, definition)) return result({ status: 'BLOCKED', effectKey: key, reason: ROLE_ALREADY_ON_GITHUB_REASON, sideEffects: 0 }, mutexKey, false);
      } catch (error) {
        return result({ status: 'BLOCKED', ...(key ? { effectKey: key } : {}), reason: reason(error), sideEffects: 0 }, mutexKey, false);
      }
      let phase = 'intent', sent = false, known = null, sideEffects = 0, held = false;
      try {
        held = true; // from here on K may exist; only a clean refusal below proves it does not
        try { await claimRolePublication(journal, mutex, { path: 'relay', effectKey: key, externalId }); }
        catch (error) {
          if (error?.code !== 'role_already_published_on_head') throw error;
          // K is held by another holder. A newer hosted run (or run attempt) of a role the relay already SETTLED
          // on this head resolves to that publication (re-verified, nothing posted); a local holder, or a relay
          // holder that is not settled, stays a refusal (HALT: genuinely uncertain).
          const other = await readRolePublication(journal, mutex);
          const settled = other.holder?.path === 'relay' && other.holder.effectKey !== key ? await journal.read(other.holder.effectKey) : null;
          if (settled?.state === 'settled' && positive(settled.details?.checkRunId) && settled.subject?.roleMutexKey === mutexKey) {
            return { ...(await reverifySettled({ key: other.holder.effectKey, settled, definition, job, externalId: other.holder.externalId, envelope })), roleMutex: { key: mutexKey, held: true } };
          }
          return result({ status: 'REFUSED', effectKey: key, reason: 'role_already_published_on_head', sideEffects: 0 }, mutexKey, false);
        }
        const intent = await journal.begin(key, { subject: subjectOfV2(job), claim: claimGeneration(batchClaim), definition, roleMutexKey: mutexKey, externalId,
          attestationSha256: envelope.attestationSha256, observationKind: 'staged-native-observation',
          nativeObservationSha256: before.native.observationSha256, compensation: 'known-check-patch-failure-on-any-unsettled-write' });
        if (intent.existing) return result({ status: 'RECONCILIATION_REQUIRED', effectKey: key, sideEffects: 0 }, mutexKey, true);
        await journal.transition(key, 'intent', 'authorized', { observationKind: 'staged-native-observation', nativeObservationSha256: before.native.observationSha256 }); phase = 'authorized';
        if (!fresh(before.native, clock())) stop('lease_expired_before_write', true);
        const payload = { name: definition.name, head_sha: job.headSha, status: 'completed', conclusion: 'success',
          external_id: externalId, output: { title: `${definition.name}: success`,
            summary: `Relayed GitHub-hosted run ${envelope.runUrl} (attempt ${envelope.runAttempt}), job ${envelope.jobUrl}; `
              + `merge commit ${envelope.mergeSha} on base ${envelope.mergeBaseSha}; workflow ${envelope.workflowPath} blob ${envelope.workflowBlob}; `
              + `closure sha256 ${envelope.closureSha256}; OIDC claims sha256 ${envelope.claimsSha256}; registry sha256 ${envelope.registrySha256}; `
              + `attestation sha256 ${envelope.attestationSha256}; staged Native observation sha256 ${before.native.observationSha256}; `
              + `Source manifest sha256 ${job.sourceManifestSha256}; attempt ${job.attempt}. ${before.native.publicationRequired ? 'The protected publisher attaches its Native Receipt.' : 'No Native publication ticket or Receipt is asserted.'}` } };
        const nativeHandle = await prepareNativePublication(github, { facts: before.native, packet: before.packet, payload });
        await journal.transition(key, 'authorized', 'sent', { externalId, nativeObservationSha256: before.native.observationSha256 }); phase = 'sent'; sent = true; sideEffects++;
        const created = await github.createCheck(payload, nativeHandle);
        if (!identity(created, definition, job, externalId)) stop('check_identity_unconfirmed'); known = created;
        const after = await boundary(job, { kind: 'hosted', envelope, fresh: false }, definition);
        if (after.bindingSha256 !== before.bindingSha256 || after.verified.evidenceSha256 !== before.verified.evidenceSha256) stop('authorization_binding_changed', true);
        await readback(known, definition, job, externalId, 'success');
        if (!fresh(after.native, clock())) stop('lease_expired_after_write', true);
        await journal.transition(key, 'sent', 'settled', { checkRunId: known.id, externalId, conclusion: 'success', attestationSha256: envelope.attestationSha256,
          observationKind: 'staged-native-observation', nativeObservationBeforeSha256: before.native.observationSha256,
          nativeObservationAfterSha256: after.native.observationSha256 });
        return result({ status: 'SETTLED', mode: 'hosted-relay', effectKey: key, checkRunId: known.id, externalId, attestationSha256: envelope.attestationSha256,
          nativeObservationBeforeSha256: before.native.observationSha256, nativeObservationAfterSha256: after.native.observationSha256,
          sideEffects, productionAuthorized: domain === 'production' }, mutexKey, true);
      } catch (error) {
        if (sent && !known && sideEffects === 1 && nativePublicationNoPostProof(error)?.notSent === true) {
          await transition(key, phase, 'revoked', { reason: 'native_publication_not_sent', notSent: true, externalId });
          return { status: 'BLOCKED', effectKey: key, reason: 'native_publication_not_sent', sideEffects: 0, productionAuthorized: false };
        }
        if (sent && !known) {
          try { known = await discoverKnown(definition, job, externalId); }
          catch { /* UNCERTAIN: the relay cannot prove what GitHub holds. */ }
        }
        if (sent && known) return { ...(await revoke({ key, phase, known, definition, job, externalId, cause: reason(error), sideEffects })), roleMutex: { key: mutexKey, held } };
        await transition(key, phase, sent ? 'uncertain' : 'not_sent', { reason: reason(error), ...(known ? { checkRunId: known.id, externalId } : {}) });
        return result({ status: sent ? 'UNCERTAIN' : 'BLOCKED', effectKey: key, reason: reason(error), sideEffects }, mutexKey, held);
      }
    }
  });
}
