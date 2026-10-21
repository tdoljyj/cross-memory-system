// Stage 1 of Source v2: the Native work-admission control check (kooyumi-work-admission). Port of
// formal-work-admission-check-v1/publisher.mjs with these changes only (DESIGN S6, S13):
//   - job contract /2 (no claim in the job; attempt 1 or 2 is part of the id);
//   - the claim is the one Native admits for the PR trailer NOW (full-admission-v2); this stage records it
//     as the batch claim (batch-claim-v2.mjs) that every later stage must observe again;
//   - effect key and external_id carry the observed claim GENERATION (claim id, fence, epoch): one
//     check per (job, generation); a renewal is the same generation;
//   - a refused evaluation leaves only a diagnostic record under a fresh key, never a not_sent record
//     under the real effect key, so a later admitted evaluation of the same content is not wedged;
//   - the journal and observation log live in state\v2\effects-work-admission, never in the spool (S13).
// It is a control check, not a scanner result, ticket, Receipt or qualification.
import { randomUUID } from 'node:crypto';
import { digest } from '../proof.mjs';
import { validateJobV2, subjectOfV2, admissionEffectKeyV2, admissionExternalIdV2, claimGeneration, MAX_ATTEMPT_V2 } from '../job-v2.mjs';
import { fullAdmissionFailureV2, admittedFactsMatchJobV2 } from '../full-admission-v2.mjs';

export const ROLE = 'work-admission', CHECK_NAME = 'kooyumi-work-admission', APP_ID = 5368905, REPO = 'tdoljyj/cross-memory-system';
const DEFINITION = Object.freeze({ name: CHECK_NAME, appId: APP_ID });
const ACTION = 'native-work-admission-check/2';
const PREFIX = 'independent-ci:native-work-admission';
const HASH = /^[a-f0-9]{64}$/, fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const plain = v => v && Object.getPrototypeOf(v) === Object.prototype;
// An uncoded exception is never a transport fact (PR-A review MINOR 5).
const safe = e => /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(e?.code ?? '') ? e.code : 'WORK_ADMISSION_OPERATION_UNCONFIRMED';
const diagnosticOf = e => fullAdmissionFailureV2({ contract: 'clued.independent-ci.full-admission/2', status: 'BLOCKED', admitted: false, reason: e?.code, diagnostic: e?.admissionDiagnostic })?.admissionDiagnostic;
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const fixedJob = job => { validateJobV2(job); check(job.repo === REPO && job.role === ROLE && job.attempt >= 1 && job.attempt <= MAX_ATTEMPT_V2, 'FIXED_WORK_ADMISSION_JOB_REQUIRED'); return freeze(structuredClone(job)); };
function identity(c, job, externalId) { return Number.isSafeInteger(c?.id) && c.id > 0 && c.app?.id === APP_ID && c.name === CHECK_NAME && c.head_sha === job.headSha && c.external_id === externalId; }

export function factsValid(job, packet, facts, domain, now, batchClaim) {
  check(packet?.complete === true && packet.pr === job.pr && packet.headSha === job.headSha && packet.baseSha === job.baseSha && Array.isArray(packet.paths)
    && packet.paths.length > 0 && packet.paths.length <= 3000 && new Set(packet.paths).size === packet.paths.length, 'COMPLETE_CURRENT_PATHS_REQUIRED');
  const rejection = fullAdmissionFailureV2(facts);
  if (rejection) throw Object.assign(new Error(rejection.reason), { code: rejection.reason, ...(rejection.admissionDiagnostic ? { admissionDiagnostic: rejection.admissionDiagnostic } : {}) });
  check(facts?.domain === domain && facts.observationOnly !== true && admittedFactsMatchJobV2(facts, job, now, { batchClaim }), 'ACTUAL_COMPLETE_NATIVE_ADMISSION_REQUIRED');
  check(facts.packetSha256 === digest(packet), 'NATIVE_CHECK_SUBJECT_CHANGED');
  check(plain(facts.mode) && ['normal', 'efficiency', 'frozen'].includes(facts.mode.state) && ['docs', 'code', 'protected'].includes(facts.mode.layer) && plain(facts.mergeSlot)
    && (facts.ownerReview === null || plain(facts.ownerReview)) && Array.isArray(facts.workflowGateFindings) && facts.workflowGateFindings.length === 0, 'COMPLETE_NATIVE_GATES_REQUIRED');
  check(typeof facts.modeProofRef === 'string' && facts.modeProofRef.length > 0 && typeof facts.observationRef === 'string' && facts.observationRef.length > 0 && HASH.test(facts.evaluationSha256 ?? ''), 'FRESH_NATIVE_OBSERVATION_REQUIRED');
  return facts;
}
const fresh = (f, now) => Number.isSafeInteger(now) && Date.parse(f.observedAt) <= now && now - Date.parse(f.observedAt) <= 30000 && Date.parse(f.claimExpiresAt) > now;
function binding(job, packet, facts, authority) {
  return digest({ subject: subjectOfV2(job), claim: claimGeneration(facts.observedClaim), pathsSha256: digest(packet.paths), scope: facts.scope, executionPolicy: facts.executionPolicy,
    mode: facts.mode, mergeSlot: facts.mergeSlot, ownerReview: facts.ownerReview, workflowGateFindings: facts.workflowGateFindings, claimExpiresAt: facts.claimExpiresAt, authority, definition: DEFINITION });
}

// batchClaims: { read(job) -> generation | null (missing), record(job, observedClaim, observedAt) }.
function engine({ github, journal, admission, assertLive, record, authority, batchClaims, clock = Date.now }, production) {
  const domain = production ? 'production' : 'fixture';
  async function boundary(job, batchClaim) {
    assertLive(); const packet = await github.readChangedPaths(job), facts = await admission.evaluatePr(job, packet, { batchClaim }); assertLive();
    factsValid(job, packet, facts, domain, clock(), batchClaim);
    record('native_check_boundary', { jobId: job.id, nativeObservationSha256: facts.observationSha256, packetSha256: digest(packet) });
    return { facts, bindingSha256: binding(job, packet, facts, authority) };
  }
  async function inventory(job, externalId) {
    const list = await github.readChecks(job.headSha);
    check(list?.complete === true && Array.isArray(list.checks) && list.checks.length <= 10000 && new Set(list.checks.map(c => c?.id)).size === list.checks.length
      && list.checks.every(c => Number.isSafeInteger(c?.id) && c.id > 0 && c.head_sha === job.headSha), 'COMPLETE_CHECK_INVENTORY_REQUIRED');
    return list.checks.filter(c => identity(c, job, externalId));
  }
  async function readback(job, externalId, id, conclusion) { const m = await inventory(job, externalId); check(m.length === 1 && m[0].id === id && m[0].status === 'completed' && m[0].conclusion === conclusion, 'NATIVE_CHECK_READBACK_UNCONFIRMED'); return m[0]; }
  async function transition(key, phase, next, details) { try { return await journal.transition(key, phase, next, details); } catch { return null; } }
  async function revoke({ job, key, externalId, known, phase, cause, sideEffects, admissionDiagnostic }) {
    const revKey = digest({ action: 'native-work-admission-revoke/2', effectKey: key, checkRunId: known.id }); let revPhase = 'intent', logged = false;
    try { const m = await inventory(job, externalId); check(m.length === 1 && m[0].id === known.id, 'NEGATIVE_COMPENSATION_IDENTITY_UNCONFIRMED'); }
    catch { return { status: 'UNCERTAIN', reason: 'NEGATIVE_COMPENSATION_IDENTITY_UNCONFIRMED', effectKey: key, sideEffects, productionAuthorized: false }; }
    try {
      const intent = await journal.begin(revKey, { checkRunId: known.id, appId: APP_ID, name: CHECK_NAME, headSha: job.headSha, externalId });
      if (intent.existing) return { status: 'UNCERTAIN', reason: 'NEGATIVE_COMPENSATION_RECONCILIATION_REQUIRED', effectKey: key, sideEffects, productionAuthorized: false };
      await journal.transition(revKey, 'intent', 'authorized'); revPhase = 'authorized'; await journal.transition(revKey, 'authorized', 'sent'); revPhase = 'sent'; logged = true;
    } catch { if (phase !== 'sent') return { status: 'UNCERTAIN', reason: 'NEGATIVE_COMPENSATION_JOURNAL_UNCONFIRMED', effectKey: key, sideEffects, productionAuthorized: false }; }
    try {
      assertLive(); sideEffects++;
      const patched = await github.revokeCheck(known.id, { status: 'completed', conclusion: 'failure', output: { title: 'Work admission authorization changed', summary: `Reconcile Native admission check ${key}; ${cause}. No Native ticket or Receipt is asserted.` } });
      check(identity(patched, job, externalId) && patched.status === 'completed' && patched.conclusion === 'failure', 'NEGATIVE_COMPENSATION_UNCONFIRMED'); await readback(job, externalId, known.id, 'failure');
      if (logged) await journal.transition(revKey, 'sent', 'settled', { checkRunId: known.id, conclusion: 'failure' });
      const current = await journal.read(key); check(['sent', 'uncertain', 'settled'].includes(current?.state), 'NEGATIVE_COMPENSATION_STATE_UNCONFIRMED');
      await journal.transition(key, current.state, 'revoked', { checkRunId: known.id, externalId, reason: cause, ...(admissionDiagnostic ? { admissionDiagnostic } : {}) });
      record('native_check_revoked', { effectKey: key, checkRunId: known.id, cause });
      return { status: 'REVOKED', reason: cause, ...(admissionDiagnostic ? { admissionDiagnostic } : {}), effectKey: key, checkRunId: known.id, sideEffects, productionAuthorized: false };
    } catch {
      if (revPhase === 'sent') await transition(revKey, 'sent', 'uncertain', { checkRunId: known.id, reason: 'NEGATIVE_COMPENSATION_UNCONFIRMED' });
      if (phase === 'sent') await transition(key, 'sent', 'uncertain', { checkRunId: known.id, externalId, reason: 'NEGATIVE_COMPENSATION_UNCONFIRMED' });
      return { status: 'UNCERTAIN', effectKey: key, checkRunId: known.id, sideEffects, productionAuthorized: false, reason: 'NEGATIVE_COMPENSATION_UNCONFIRMED' };
    }
  }
  return Object.freeze({ fixture: !production, async publish(input) {
    let job, key = null, externalId = null, previous = null, before, claimed = null;
    try {
      job = fixedJob(input);
      // A claim recorded earlier for this exact batch names the one effect to reconcile.
      claimed = await batchClaims.read(job);
      if (claimed) {
        key = admissionEffectKeyV2(ACTION, job, claimed, DEFINITION); externalId = admissionExternalIdV2(PREFIX, job, claimed);
        previous = await journal.read(key);
        if (previous && previous.state !== 'settled') return { status: previous.state === 'revoked' ? 'REVOKED' : 'RECONCILIATION_REQUIRED', effectKey: key, sideEffects: 0, productionAuthorized: false };
      }
      before = await boundary(job, claimed);
      if (!claimed) {
        // First admission of this batch: the observed generation becomes the sticky batch claim.
        await batchClaims.record(job, before.facts.observedClaim, before.facts.observedAt);
        claimed = claimGeneration(before.facts.observedClaim);
        key = admissionEffectKeyV2(ACTION, job, claimed, DEFINITION); externalId = admissionExternalIdV2(PREFIX, job, claimed);
        previous = await journal.read(key);
        if (previous && previous.state !== 'settled') return { status: previous.state === 'revoked' ? 'REVOKED' : 'RECONCILIATION_REQUIRED', effectKey: key, sideEffects: 0, productionAuthorized: false };
      }
      if (previous) { await readback(job, externalId, previous.details.checkRunId, 'success'); return { status: 'SETTLED', effectKey: key, checkRunId: previous.details.checkRunId, sideEffects: 0, productionAuthorized: production }; }
    } catch (e) {
      if (previous?.state === 'settled' && Number.isSafeInteger(previous.details?.checkRunId) && previous.details.checkRunId > 0)
        return revoke({ job, key, externalId, known: { id: previous.details.checkRunId }, phase: 'settled', cause: safe(e), sideEffects: 0, admissionDiagnostic: diagnosticOf(e) });
      // A refused evaluation gets a durable diagnostic record under a FRESH key only: it never blocks
      // a later, admitted evaluation of the same content and claim. Never POST or replay.
      if (job) {
        try {
          const diag = digest({ action: 'native-work-admission-blocked/2', jobId: job.id, evaluationRef: randomUUID() });
          await journal.begin(diag, { subject: subjectOfV2(job), definition: DEFINITION, observationKind: 'blocked-native-admission-control', diagnosticOnly: true });
          await journal.transition(diag, 'intent', 'not_sent', { reason: safe(e), ...(diagnosticOf(e) ? { admissionDiagnostic: diagnosticOf(e) } : {}) });
        } catch { /* diagnostic only */ }
      }
      return { status: 'BLOCKED', reason: safe(e), ...(diagnosticOf(e) ? { admissionDiagnostic: diagnosticOf(e) } : {}), sideEffects: 0, productionAuthorized: false };
    }
    let phase = 'intent', sent = false, known = null, sideEffects = 0;
    try {
      const intent = await journal.begin(key, { subject: subjectOfV2(job), claim: claimed, definition: DEFINITION, externalId, observationKind: 'actual-native-admission-control',
        nativeObservationSha256: before.facts.observationSha256, bindingSha256: before.bindingSha256, compensation: 'known-success-one-bounded-negative-patch' });
      if (intent.existing) return { status: 'RECONCILIATION_REQUIRED', effectKey: key, sideEffects, productionAuthorized: false };
      await journal.transition(key, 'intent', 'authorized', { nativeObservationSha256: before.facts.observationSha256 }); phase = 'authorized';
      assertLive(); check(fresh(before.facts, clock()), 'NATIVE_OBSERVATION_EXPIRED_BEFORE_WRITE');
      await journal.transition(key, 'authorized', 'sent', { externalId, nativeObservationSha256: before.facts.observationSha256 }); phase = 'sent'; sent = true; sideEffects++;
      const posted = await github.createCheck({ name: CHECK_NAME, head_sha: job.headSha, status: 'completed', conclusion: 'success', external_id: externalId,
        output: { title: 'Work claim and complete Native admission verified', summary: `Independent Native control check for ${REPO}#${job.pr} (attempt ${job.attempt}); observation sha256 ${before.facts.observationSha256}. This is not a scanner execution, Native publication ticket, Receipt or qualification.` } });
      check(identity(posted, job, externalId) && posted.status === 'completed' && posted.conclusion === 'success', 'NATIVE_CHECK_IDENTITY_UNCONFIRMED'); known = posted;
      const after = await boundary(job, claimed); check(after.bindingSha256 === before.bindingSha256, 'NATIVE_AUTHORIZATION_BINDING_CHANGED');
      await readback(job, externalId, known.id, 'success'); assertLive(); check(fresh(after.facts, clock()), 'NATIVE_OBSERVATION_EXPIRED_AFTER_WRITE');
      await journal.transition(key, 'sent', 'settled', { checkRunId: known.id, externalId, conclusion: 'success', nativeObservationBeforeSha256: before.facts.observationSha256, nativeObservationAfterSha256: after.facts.observationSha256, bindingSha256: after.bindingSha256 });
      record('native_check_settled', { effectKey: key, checkRunId: known.id, beforeSha256: before.facts.observationSha256, afterSha256: after.facts.observationSha256 });
      return { status: 'SETTLED', effectKey: key, checkRunId: known.id, nativeObservationBeforeSha256: before.facts.observationSha256, nativeObservationAfterSha256: after.facts.observationSha256, sideEffects, productionAuthorized: production };
    } catch (e) {
      if (sent && !known) { try { const m = await inventory(job, externalId); if (m.length === 1) known = m[0]; } catch { /* read-only discovery cannot prove a missing POST */ } }
      if (sent && known) return revoke({ job, key, externalId, known, phase, cause: safe(e), sideEffects, admissionDiagnostic: diagnosticOf(e) });
      await transition(key, phase, sent ? 'uncertain' : 'not_sent', { reason: safe(e), externalId });
      return { status: sent ? 'UNCERTAIN' : 'BLOCKED', effectKey: key, reason: safe(e), sideEffects, productionAuthorized: false };
    }
  } });
}
export function createFixtureWorkAdmissionPublisherV2(dependencies) { return engine(dependencies, false); }
export function createProductionWorkAdmissionPublisherV2(dependencies) { return engine(dependencies, true); }
