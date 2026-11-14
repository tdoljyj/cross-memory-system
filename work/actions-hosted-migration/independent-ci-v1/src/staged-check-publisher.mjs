import { canonical, digest, subjectOf, verifyResult } from './proof.mjs';
import { validateJob } from './queue.mjs';

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const positive = value => Number.isSafeInteger(value) && value > 0;
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const ref = value => typeof value === 'string' && value.length > 0 && value.length <= 1000 && !/[\x00-\x1f]/.test(value);
const stop = (code, drift = false) => { throw Object.assign(new Error(code), { code, drift }); };
const reason = error => /^[a-z][a-z0-9_]{0,80}$/.test(error?.code ?? '') ? error.code : 'publication_observation_unconfirmed';
const fresh = (observedAt, expiresAt, now) => Number.isSafeInteger(now) && Number.isFinite(Date.parse(observedAt))
  && Date.parse(observedAt) <= now && now - Date.parse(observedAt) <= 30_000 && Date.parse(expiresAt) > now;
const requiredRefs = ['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef'];

// This staged adapter deliberately does not call Native publication_begin/finish:
// its complete admission observations are digests, not Native tickets or Receipts.
// Every dependency and deployment fact below is installed protected control code.
// publish({ job, envelope }) publishes one required check of a local formal role;
// the envelope is the Linux worker's Ed25519 signed result (independent-ci.signed-result.v1).
export function createStagedCheckPublisher({ nativeAdmission, authority, github, journal, signers,
  configuredChecks, readChangedPaths, protectedDeployment, clock = Date.now, domain = 'production' } = {}) {
  const deployment = plain(protectedDeployment) ? structuredClone(protectedDeployment) : null;
  const checks = plain(configuredChecks) ? structuredClone(configuredChecks) : null;
  const configured = ['production', 'fixture'].includes(domain) && deployment?.enabled === true
    && deployment.domain === domain && ref(deployment.repository) && requiredRefs.every(k => ref(deployment[k]))
    && UUID.test(deployment.ciPrincipalBindingId ?? '') && typeof nativeAdmission?.evaluatePr === 'function'
    && typeof authority?.observe === 'function' && typeof github?.readPullRequest === 'function'
    && typeof github?.readChecks === 'function' && typeof github?.createCheck === 'function'
    && typeof github?.revokeCheck === 'function' && ['begin', 'read', 'transition'].every(k => typeof journal?.[k] === 'function')
    && signers instanceof Map && typeof readChangedPaths === 'function' && typeof clock === 'function' && checks
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
  async function discoverKnown(definition, job, externalId) {
    // One bounded complete inventory, with the original immutable selectors.
    // A lost POST response is never permission to POST again or select broadly.
    const list = await github.readChecks(job.headSha);
    if (list?.complete !== true || !Array.isArray(list.checks) || list.checks.length > 10000
      || list.checks.some(c => !plain(c) || !positive(c.id) || c.head_sha !== job.headSha)
      || new Set(list.checks.map(c => c.id)).size !== list.checks.length) stop('check_discovery_unconfirmed');
    const matches = list.checks.filter(check => identity(check, definition, job, externalId));
    if (matches.length !== 1) stop('check_discovery_unconfirmed');
    return matches[0];
  }
  async function boundary(job, envelope, definition, expectedEvidenceSha256 = null) {
    // Reject unusable execution/Host/Source/PR subjects before the Native call,
    // which can bind a PR and charge its Task's existing CI admission meter.
    let verified;
    try { verified = verifyResult({ job, envelope, signers, now: clock(), domain }); }
    catch { stop('execution_proof_refused', true); }
    if (expectedEvidenceSha256 && expectedEvidenceSha256 !== verified.evidenceSha256) stop('evidence_identity_conflict', true);
    const facts = await authority.observe(job);
    if (!plain(facts)) stop('protected_facts_unconfirmed');
    if (Number.isFinite(Date.parse(facts.claimExpiresAt)) && Date.parse(facts.claimExpiresAt) <= clock()) stop('protected_lease_expired', true);
    if (!fresh(facts.observedAt, facts.claimExpiresAt, clock())) stop('protected_facts_unconfirmed');
    if (!Object.entries(subjectOf(job)).every(([k, value]) => facts[k] === value)) stop('protected_subject_changed', true);
    if (facts.sourceAccepted !== true || facts.hostQualified !== true || facts.publisherQualified !== true || facts.ciPrincipalQualified !== true)
      stop('protected_qualification_missing', ['sourceAccepted', 'hostQualified', 'publisherQualified', 'ciPrincipalQualified'].some(k => facts[k] === false));
    if (!requiredRefs.every(k => facts[k] === deployment[k]) || facts.ciPrincipalBindingId !== deployment.ciPrincipalBindingId
      || verified.signer.sourceAcceptanceRef !== facts.sourceAcceptanceRef || verified.signer.qualificationRef !== facts.hostQualificationRef)
      stop('protected_qualification_changed', true);
    const pr = await github.readPullRequest(job.pr);
    if (pr.state !== 'open' || pr.head?.sha !== job.headSha || pr.base?.sha !== job.baseSha || pr.base?.ref !== 'main'
      || pr.head?.repo?.full_name !== job.repo || pr.base?.repo?.full_name !== job.repo) stop('github_subject_changed', true);
    const packet = await readChangedPaths(job);
    if (!packet || Object.keys(packet).some(k => !['complete', 'pr', 'headSha', 'baseSha', 'paths'].includes(k))
      || packet.complete !== true || packet.pr !== job.pr || packet.headSha !== job.headSha || packet.baseSha !== job.baseSha
      || !Array.isArray(packet.paths) || !packet.paths.length || packet.paths.length > 3000 || new Set(packet.paths).size !== packet.paths.length
      || packet.paths.some(p => typeof p !== 'string' || !p || p.length > 4096 || /[\x00-\x1f\\:]/.test(p) || p.startsWith('/') || p.split('/').some(part => !part || part === '.' || part === '..')))
      stop('native_path_observation_unconfirmed');
    const native = await nativeAdmission.evaluatePr(job, packet);
    if (native?.contract !== 'clued.independent-ci.full-admission/1' || native.completeAdmission !== true
      || native.observationOnly === true || native.publicationAuthorized === false
      || native.domain !== domain || native.evaluator !== 'scripts/ci/clued-work-admission.mjs#evaluate'
      || native.status !== 'ADMITTED' || native.admitted !== true) stop('full_admission_not_proven');
    if (native.executionPolicy !== 'staged' || native.guarded !== false) stop('native_policy_changed', true);
    if (native.packetSha256 !== digest(packet) || !HASH.test(native.evaluationSha256 ?? '')
      || !ref(native.modeProofRef) || !ref(native.observationRef)) stop('full_admission_observation_unconfirmed');
    if (!plain(native.mode) || !ref(native.mode.state) || !ref(native.mode.layer)
      || !(ref(native.mode.policyVersion) || Number.isSafeInteger(native.mode.policyVersion))
      || !plain(native.mergeSlot) || !ref(native.mergeSlot.state)
      || !(native.ownerReview === null || plain(native.ownerReview) && ref(native.ownerReview.kind))
      || !Array.isArray(native.workflowGateFindings) || native.workflowGateFindings.length) stop('full_admission_incomplete');
    const { observationSha256, ...observed } = native;
    if (!HASH.test(observationSha256 ?? '') || digest(observed) !== observationSha256) stop('native_observation_digest_invalid');
    if (native.repository !== job.repo || native.prRef !== `${job.repo}#${job.pr}`
      || !['headSha', 'baseSha', 'claimId', 'fence', 'epoch', 'sourceManifestSha256'].every(k => native[k] === job[k])) stop('native_identity_changed', true);
    if (!fresh(native.observedAt, native.claimExpiresAt, clock())) stop('native_lease_or_observation_expired', true);
    if (facts.claimExpiresAt !== native.claimExpiresAt) stop('lease_observations_disagree', true);
    if (!fresh(facts.observedAt, facts.claimExpiresAt, clock())) stop('protected_facts_expired_during_admission');
    try {
      const stillVerified = verifyResult({ job, envelope, signers, now: clock(), domain });
      if (canonical(stillVerified.signer) !== canonical(verified.signer)) stop('execution_proof_refused');
    } catch { stop('execution_proof_refused'); }
    return { verified, native, bindingSha256: digest({ subject: subjectOf(job), executionPolicy: native.executionPolicy,
      mode: native.mode, mergeSlot: native.mergeSlot, ownerReview: native.ownerReview,
      claimExpiresAt: native.claimExpiresAt, refs: Object.fromEntries(requiredRefs.map(k => [k, facts[k]])),
      ciPrincipalBindingId: facts.ciPrincipalBindingId, signer: verified.signer, appId: definition.appId, name: definition.name }) };
  }
  async function transition(key, phase, next, details) {
    try { return await journal.transition(key, phase, next, details); } catch { return null; }
  }
  async function revoke({ key, phase, known, definition, job, externalId, cause, sideEffects }) {
    const revocationKey = digest({ action: 'staged-independent-check-revoke', effectKey: key, checkRunId: known.id });
    let revocationPhase = 'intent', revocationLogged = false;
    try {
      const intent = await journal.begin(revocationKey, { checkRunId: known.id, appId: definition.appId, headSha: job.headSha, externalId });
      if (intent.existing) return { status: 'UNCERTAIN', effectKey: key, reason: 'revocation_reconciliation_required', sideEffects, productionAuthorized: false };
      await journal.transition(revocationKey, 'intent', 'authorized'); revocationPhase = 'authorized';
      await journal.transition(revocationKey, 'authorized', 'sent'); revocationPhase = 'sent'; revocationLogged = true;
    } catch {
      // This invocation's fresh POST already has a durable 'sent' intent which
      // explicitly includes this bounded negative compensation. A secondary
      // journal failure must not leave that known success green. For older
      // effects, an unavailable marker cannot prove a PATCH was never sent.
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
      let job, envelope, definition, key, externalId, previous, before;
      try {
        if (!plain(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'job') || !Object.hasOwn(input, 'envelope')) stop('publication_input_invalid');
        job = structuredClone(input.job); envelope = structuredClone(input.envelope); validateJob(job);
        if (job.repo !== deployment.repository) stop('repository_not_configured');
        definition = definitionFor(job);
        key = digest({ action: 'staged-independent-check', subject: subjectOf(job), definition });
        externalId = `independent-ci:staged:${job.id}:f${job.fence}:e${job.epoch}:a${job.attempt}`;
        previous = await journal.read(key);
        if (previous && previous.state !== 'settled') return { status: previous.state === 'revoked' ? 'REVOKED' : 'RECONCILIATION_REQUIRED', effectKey: key, sideEffects: 0, productionAuthorized: false };
        before = await boundary(job, envelope, definition, previous?.subject.evidenceSha256);
        if (previous) {
          if (previous.subject.evidenceSha256 !== before.verified.evidenceSha256) stop('evidence_identity_conflict', true);
          await readback({ id: previous.details.checkRunId }, definition, job, externalId, previous.details.conclusion);
          return { status: 'SETTLED', effectKey: key, checkRunId: previous.details.checkRunId, sideEffects: 0, productionAuthorized: domain === 'production', mode: 'staged' };
        }
      } catch (error) {
        if (previous?.state === 'settled' && positive(previous.details?.checkRunId)) {
          const known = { id: previous.details.checkRunId, app: { id: definition.appId }, head_sha: job.headSha, name: definition.name, external_id: externalId };
          return revoke({ key, phase: 'settled', known, definition, job, externalId, cause: reason(error), sideEffects: 0 });
        }
        return { status: previous ? 'UNCERTAIN' : 'BLOCKED', ...(key ? { effectKey: key } : {}), reason: reason(error), sideEffects: 0, productionAuthorized: false };
      }
      let phase = 'intent', sent = false, known = null, sideEffects = 0;
      try {
        const intent = await journal.begin(key, { subject: subjectOf(job), definition, evidenceSha256: before.verified.evidenceSha256,
          observationKind: 'staged-native-observation', nativeObservationSha256: before.native.observationSha256, externalId,
          compensation: 'known-check-patch-failure-on-any-unsettled-write' });
        if (intent.existing) return { status: 'RECONCILIATION_REQUIRED', effectKey: key, sideEffects: 0, productionAuthorized: false };
        await journal.transition(key, 'intent', 'authorized', { observationKind: 'staged-native-observation', nativeObservationSha256: before.native.observationSha256 }); phase = 'authorized';
        if (!fresh(before.native.observedAt, before.native.claimExpiresAt, clock())) stop('lease_expired_before_write', true);
        await journal.transition(key, 'authorized', 'sent', { externalId, nativeObservationSha256: before.native.observationSha256 }); phase = 'sent'; sent = true; sideEffects++;
        const created = await github.createCheck({ name: definition.name, head_sha: job.headSha, status: 'completed', conclusion: before.verified.payload.conclusion,
          external_id: externalId, output: { title: `${definition.name}: ${before.verified.payload.conclusion}`,
            summary: `Independent CI job ${job.id}; signed execution sha256 ${before.verified.evidenceSha256}; staged Native observation sha256 ${before.native.observationSha256}. No Native publication ticket or Receipt is asserted.` } });
        if (!identity(created, definition, job, externalId)) stop('check_identity_unconfirmed'); known = created;
        const after = await boundary(job, envelope, definition);
        if (after.bindingSha256 !== before.bindingSha256 || after.verified.evidenceSha256 !== before.verified.evidenceSha256) stop('authorization_binding_changed', true);
        await readback(known, definition, job, externalId, before.verified.payload.conclusion);
        if (!fresh(after.native.observedAt, after.native.claimExpiresAt, clock())) stop('lease_expired_after_write', true);
        await journal.transition(key, 'sent', 'settled', { checkRunId: known.id, externalId, conclusion: before.verified.payload.conclusion,
          observationKind: 'staged-native-observation', nativeObservationBeforeSha256: before.native.observationSha256, nativeObservationAfterSha256: after.native.observationSha256,
          evidenceSha256: before.verified.evidenceSha256 });
        return { status: 'SETTLED', mode: 'staged', effectKey: key, checkRunId: known.id, evidenceSha256: before.verified.evidenceSha256,
          nativeObservationBeforeSha256: before.native.observationSha256, nativeObservationAfterSha256: after.native.observationSha256, sideEffects, productionAuthorized: domain === 'production' };
      } catch (error) {
        if (sent && !known) {
          try { known = await discoverKnown(definition, job, externalId); }
          catch { /* UNCERTAIN records local uncertainty; it cannot revoke a remote success or enforce GitHub merge protection. */ }
        }
        if (sent && known) return revoke({ key, phase, known, definition, job, externalId, cause: reason(error), sideEffects });
        await transition(key, phase, sent ? 'uncertain' : 'not_sent', { reason: reason(error), ...(known ? { checkRunId: known.id, externalId } : {}) });
        return { status: sent ? 'UNCERTAIN' : 'BLOCKED', effectKey: key, reason: reason(error), sideEffects, productionAuthorized: false };
      }
    }
  });
}
