// Stage 8 of Source v2: the Native control pair kooyumi-admission-verified + kooyumi-merge-slot.
// Port of independent-control-checks-v1/publisher.mjs with these changes only (DESIGN S6, S8, S13):
//   - job contract /2; the batch claim recorded by stage 1 must be observed again (A-strict stickiness);
//   - effect key / external_id carry the batch claim generation (a renewal is the same generation);
//   - S8: no 5-minute "native-queue-ready.json" marker written by a human/agent any more. The helper
//     itself polls the Native merge queue READ-ONLY (the same complete admission door) every 30 s until
//     the batch claim is the queue head, the merge slot is held for this base and still valid — only then
//     does it publish both checks. If the window min(45 min merge slot, claim lease, install validUntil,
//     stage cap) ends first, it stops cleanly with RESIDENT_QUEUE_HEAD_NOT_REACHED and publishes nothing.
//     Renewing the claim / merge slot is the claim holder's job (agent contract A.6); this code never
//     renews anything;
//   - journal and observation log in state\v2\effects-control (S13);
//   - PR-A integration: the durable producer identity sourceBindingSha256 (v1's rule: everything but the
//     renewable lease and slot timestamps) is journaled, and consume() is the v2 control consumer the merge
//     gate reads through (consumer.mjs; scripts/ci/clued-work-admission.mjs provider independent-control-checks-v2).
import { digest } from '../proof.mjs';
import { validateJobV2, subjectOfV2, admissionEffectKeyV2, admissionExternalIdV2, claimGeneration, CONTROL_ROLES_V2, MAX_ATTEMPT_V2, sameBatchV2 } from '../job-v2.mjs';
import { admittedFactsMatchJobV2, fullAdmissionFailureV2 } from '../full-admission-v2.mjs';

export const APP_ID = 5368905, REPO = 'tdoljyj/cross-memory-system';
export const CONTROL_CHECKS_V2 = Object.freeze({
  'control-admission': Object.freeze({ name: 'kooyumi-admission-verified', appId: APP_ID }),
  'control-merge-slot': Object.freeze({ name: 'kooyumi-merge-slot', appId: APP_ID }),
});
export const QUEUE_POLL_MS = 30_000;
export const MERGE_SLOT_WINDOW_MS = 45 * 60_000;
const ACTION = 'independent-control-check/2';
const HASH = /^[a-f0-9]{64}$/, fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const plain = v => v && Object.getPrototypeOf(v) === Object.prototype;
// An uncoded exception is never a transport fact (PR-A review MINOR 5).
const safe = e => /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(e?.code ?? '') ? e.code : 'CONTROL_CHECK_OPERATION_UNCONFIRMED';
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const definitionFor = job => CONTROL_CHECKS_V2[job.role];
const actualConsumptions = new WeakMap();
const exact = (v, keys) => plain(v) && Object.keys(v).sort().join('|') === [...keys].sort().join('|');
const fixedJob = job => { validateJobV2(job); check(job.repo === REPO && CONTROL_ROLES_V2.includes(job.role) && job.attempt >= 1 && job.attempt <= MAX_ATTEMPT_V2, 'FIXED_INDEPENDENT_CONTROL_JOB_REQUIRED'); return freeze(structuredClone(job)); };
const prefixFor = job => `independent-ci:control:${job.role}`;
function identity(c, job, externalId) { return Number.isSafeInteger(c?.id) && c.id > 0 && c.app?.id === APP_ID && c.name === definitionFor(job).name && c.head_sha === job.headSha && c.external_id === externalId; }
const fresh = (f, now) => Number.isSafeInteger(now) && Date.parse(f.observedAt) <= now && now - Date.parse(f.observedAt) <= 30000 && Date.parse(f.claimExpiresAt) > now;

// The merge-queue facts that make the merge-slot check true (S8). Pure.
export function queueHeadReady(job, facts, now) {
  return plain(facts?.mergeSlot) && facts.mergeSlot.state === 'held' && facts.mergeSlot.ref === `merge:${job.repo}:main` && facts.mergeSlot.tip === job.baseSha
    && Date.parse(facts.mergeSlot.until) > now && facts.mergeQueueHead === true;
}

export function factsValid(job, packet, facts, domain, now, batchClaim, { requireQueueHead = job.role === 'control-merge-slot' } = {}) {
  check(packet?.complete === true && packet.pr === job.pr && packet.headSha === job.headSha && packet.baseSha === job.baseSha && Array.isArray(packet.paths)
    && packet.paths.length > 0 && packet.paths.length <= 3000 && new Set(packet.paths).size === packet.paths.length, 'COMPLETE_CURRENT_PATHS_REQUIRED');
  const rejection = fullAdmissionFailureV2(facts);
  if (rejection) fail(rejection.reason);
  check(facts?.domain === domain && admittedFactsMatchJobV2(facts, job, now, { batchClaim }) && facts.packetSha256 === digest(packet), 'ACTUAL_COMPLETE_NATIVE_ADMISSION_REQUIRED');
  check(plain(facts.mode) && ['normal', 'efficiency', 'frozen'].includes(facts.mode.state) && ['docs', 'code', 'protected'].includes(facts.mode.layer) && plain(facts.mergeSlot)
    && (facts.ownerReview === null || plain(facts.ownerReview)) && Array.isArray(facts.workflowGateFindings) && facts.workflowGateFindings.length === 0, 'COMPLETE_NATIVE_GATES_REQUIRED');
  check(typeof facts.modeProofRef === 'string' && facts.modeProofRef.length > 0 && HASH.test(facts.evaluationSha256 ?? ''), 'FRESH_NATIVE_OBSERVATION_REQUIRED');
  if (requireQueueHead) check(queueHeadReady(job, facts, now), 'LIVE_ACTUAL_MERGE_SLOT_REQUIRED');
  return facts;
}
function binding(job, packet, facts, authority) {
  return digest({ subject: subjectOfV2(job), claim: claimGeneration(facts.observedClaim), pathsSha256: digest(packet.paths), scope: facts.scope, executionPolicy: facts.executionPolicy,
    mode: facts.mode, mergeSlot: facts.mergeSlot, mergeQueueHead: facts.mergeQueueHead, executionHandoverPending: facts.executionHandoverPending, ownerReview: facts.ownerReview,
    workflowGateFindings: facts.workflowGateFindings, claimExpiresAt: facts.claimExpiresAt, authority, definition: definitionFor(job) });
}

// The durable producer identity excludes the renewable lease and slot timestamps (v1 sourceBinding); the
// live before/after binding above still includes every one of them.
function sourceBinding(job, packet, facts, authority) {
  return digest({ subject: subjectOfV2(job), claim: claimGeneration(facts.observedClaim), pathsSha256: digest(packet.paths), scope: facts.scope, executionPolicy: facts.executionPolicy,
    guarded: facts.guarded, mode: facts.mode, ownerReview: facts.ownerReview, workflowGateFindings: facts.workflowGateFindings, authority, definition: definitionFor(job),
    slot: job.role === 'control-merge-slot' ? { state: facts.mergeSlot.state, ref: facts.mergeSlot.ref, tip: facts.mergeSlot.tip, queueHead: facts.mergeQueueHead } : null });
}

function engine({ github, journal, admission, assertLive, record, authority, batchClaim, clock = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) }, production) {
  const domain = production ? 'production' : 'fixture';
  async function observe(job) { assertLive(); const packet = await github.readChangedPaths(job), facts = await admission.evaluatePr(job, packet, { batchClaim }); assertLive(); return { packet, facts }; }
  async function boundary(job) {
    const { packet, facts } = await observe(job); factsValid(job, packet, facts, domain, clock(), batchClaim);
    record('native_check_boundary', { jobId: job.id, nativeObservationSha256: facts.observationSha256, packetSha256: digest(packet) });
    return { facts, bindingSha256: binding(job, packet, facts, authority), sourceBindingSha256: sourceBinding(job, packet, facts, authority) };
  }
  async function inventory(job, externalId) {
    const list = await github.readChecks(job.headSha);
    check(list?.complete === true && Array.isArray(list.checks) && list.checks.length <= 10000 && new Set(list.checks.map(c => c?.id)).size === list.checks.length
      && list.checks.every(c => Number.isSafeInteger(c?.id) && c.id > 0 && c.head_sha === job.headSha), 'COMPLETE_CHECK_INVENTORY_REQUIRED');
    const matches = list.checks.filter(c => identity(c, job, externalId));
    if (matches.length === 1) check(!list.checks.some(c => c.app?.id === APP_ID && c.name === definitionFor(job).name && c.id > matches[0].id), 'NEWER_CONTROL_JUDGEMENT_PRESENT');
    return matches;
  }
  async function readback(job, externalId, id, conclusion) { const m = await inventory(job, externalId); check(m.length === 1 && m[0].id === id && m[0].status === 'completed' && m[0].conclusion === conclusion, 'NATIVE_CHECK_READBACK_UNCONFIRMED'); return m[0]; }
  async function transition(key, phase, next, details) { try { return await journal.transition(key, phase, next, details); } catch { return null; } }
  async function revoke({ job, key, externalId, known, phase, cause, sideEffects }) {
    const revKey = digest({ action: 'independent-control-revoke/2', effectKey: key, checkRunId: known.id }); let revPhase = 'intent', logged = false;
    try { const m = await inventory(job, externalId); check(m.length === 1 && m[0].id === known.id, 'NEGATIVE_COMPENSATION_IDENTITY_UNCONFIRMED'); }
    catch { return { status: 'UNCERTAIN', reason: 'NEGATIVE_COMPENSATION_IDENTITY_UNCONFIRMED', effectKey: key, sideEffects, productionAuthorized: false }; }
    try {
      const intent = await journal.begin(revKey, { checkRunId: known.id, appId: APP_ID, name: definitionFor(job).name, headSha: job.headSha, externalId });
      if (intent.existing) return { status: 'UNCERTAIN', reason: 'NEGATIVE_COMPENSATION_RECONCILIATION_REQUIRED', effectKey: key, sideEffects, productionAuthorized: false };
      await journal.transition(revKey, 'intent', 'authorized'); revPhase = 'authorized'; await journal.transition(revKey, 'authorized', 'sent'); revPhase = 'sent'; logged = true;
    } catch { if (phase !== 'sent') return { status: 'UNCERTAIN', reason: 'NEGATIVE_COMPENSATION_JOURNAL_UNCONFIRMED', effectKey: key, sideEffects, productionAuthorized: false }; }
    try {
      assertLive(); sideEffects++;
      const patched = await github.revokeCheck(known.id, { status: 'completed', conclusion: 'failure', output: { title: 'Independent control authorization changed', summary: `Reconcile Native admission check ${key}; ${cause}. No Native ticket or Receipt is asserted.` } });
      check(identity(patched, job, externalId) && patched.status === 'completed' && patched.conclusion === 'failure', 'NEGATIVE_COMPENSATION_UNCONFIRMED'); await readback(job, externalId, known.id, 'failure');
      if (logged) await journal.transition(revKey, 'sent', 'settled', { checkRunId: known.id, conclusion: 'failure' });
      const current = await journal.read(key); check(['sent', 'uncertain', 'settled'].includes(current?.state), 'NEGATIVE_COMPENSATION_STATE_UNCONFIRMED');
      await journal.transition(key, current.state, 'revoked', { checkRunId: known.id, externalId, reason: cause });
      record('native_check_revoked', { jobId: job.id, effectKey: key, checkRunId: known.id, cause });
      return { status: 'REVOKED', effectKey: key, checkRunId: known.id, reason: cause, sideEffects, productionAuthorized: false };
    } catch {
      if (revPhase === 'sent') await transition(revKey, 'sent', 'uncertain', { checkRunId: known.id, reason: 'NEGATIVE_COMPENSATION_UNCONFIRMED' });
      if (phase === 'sent') await transition(key, 'sent', 'uncertain', { checkRunId: known.id, externalId, reason: 'NEGATIVE_COMPENSATION_UNCONFIRMED' });
      return { status: 'UNCERTAIN', effectKey: key, checkRunId: known.id, sideEffects, productionAuthorized: false, reason: 'NEGATIVE_COMPENSATION_UNCONFIRMED' };
    }
  }
  async function publishOne(input) {
    let job, key, externalId, previous, before;
    try {
      job = fixedJob(input); key = admissionEffectKeyV2(ACTION, job, batchClaim, definitionFor(job)); externalId = admissionExternalIdV2(prefixFor(job), job, batchClaim);
      previous = await journal.read(key);
      if (previous && previous.state !== 'settled') return { status: previous.state === 'revoked' ? 'REVOKED' : 'RECONCILIATION_REQUIRED', effectKey: key, sideEffects: 0, productionAuthorized: false };
      before = await boundary(job);
      if (previous) { await readback(job, externalId, previous.details.checkRunId, 'success'); return { status: 'SETTLED', effectKey: key, checkRunId: previous.details.checkRunId, sideEffects: 0, productionAuthorized: production }; }
    } catch (e) {
      if (previous?.state === 'settled' && Number.isSafeInteger(previous.details?.checkRunId) && previous.details.checkRunId > 0) return revoke({ job, key, externalId, known: { id: previous.details.checkRunId }, phase: 'settled', cause: safe(e), sideEffects: 0 });
      return { status: 'BLOCKED', reason: safe(e), sideEffects: 0, productionAuthorized: false };
    }
    let phase = 'intent', sent = false, known = null, sideEffects = 0;
    try {
      const intent = await journal.begin(key, { subject: subjectOfV2(job), claim: batchClaim, definition: definitionFor(job), externalId, observationKind: 'actual-native-admission-control', nativeObservationSha256: before.facts.observationSha256, bindingSha256: before.bindingSha256, sourceBindingSha256: before.sourceBindingSha256, compensation: 'known-success-one-bounded-negative-patch' });
      if (intent.existing) return { status: 'RECONCILIATION_REQUIRED', effectKey: key, sideEffects, productionAuthorized: false };
      await journal.transition(key, 'intent', 'authorized', { nativeObservationSha256: before.facts.observationSha256 }); phase = 'authorized';
      assertLive(); check(fresh(before.facts, clock()), 'NATIVE_OBSERVATION_EXPIRED_BEFORE_WRITE');
      await journal.transition(key, 'authorized', 'sent', { externalId, nativeObservationSha256: before.facts.observationSha256 }); phase = 'sent'; sent = true; sideEffects++;
      const posted = await github.createCheck({ name: definitionFor(job).name, head_sha: job.headSha, status: 'completed', conclusion: 'success', external_id: externalId,
        output: { title: 'Complete Native control and exact subject verified', summary: `Independent Native control check for ${REPO}#${job.pr} (attempt ${job.attempt}); observation sha256 ${before.facts.observationSha256}. This is not a scanner execution, Native publication ticket, Receipt or qualification.` } });
      check(identity(posted, job, externalId) && posted.status === 'completed' && posted.conclusion === 'success', 'NATIVE_CHECK_IDENTITY_UNCONFIRMED'); known = posted;
      const after = await boundary(job); check(after.bindingSha256 === before.bindingSha256, 'NATIVE_AUTHORIZATION_BINDING_CHANGED');
      await readback(job, externalId, known.id, 'success'); assertLive(); check(fresh(after.facts, clock()), 'NATIVE_OBSERVATION_EXPIRED_AFTER_WRITE');
      await journal.transition(key, 'sent', 'settled', { checkRunId: known.id, externalId, conclusion: 'success', nativeObservationBeforeSha256: before.facts.observationSha256, nativeObservationAfterSha256: after.facts.observationSha256, bindingSha256: after.bindingSha256, sourceBindingSha256: after.sourceBindingSha256 });
      record('native_check_settled', { jobId: job.id, effectKey: key, checkRunId: known.id, beforeSha256: before.facts.observationSha256, afterSha256: after.facts.observationSha256 });
      return { status: 'SETTLED', effectKey: key, checkRunId: known.id, sideEffects, productionAuthorized: production };
    } catch (e) {
      if (sent && !known) { try { const m = await inventory(job, externalId); if (m.length === 1) known = m[0]; } catch { /* read-only discovery cannot prove a missing POST */ } }
      if (sent && known) return revoke({ job, key, externalId, known, phase, cause: safe(e), sideEffects });
      await transition(key, phase, sent ? 'uncertain' : 'not_sent', { reason: safe(e), externalId });
      return { status: sent ? 'UNCERTAIN' : 'BLOCKED', effectKey: key, reason: safe(e), sideEffects, productionAuthorized: false };
    }
  }
  // S8: read-only wait for the queue head, then publish the pair in the fixed order.
  async function waitForQueueHead(slotJob, waitUntil) {
    for (let polls = 1; ; polls++) {
      let observed = null;
      try { const { packet, facts } = await observe(slotJob); factsValid(slotJob, packet, facts, domain, clock(), batchClaim, { requireQueueHead: false }); observed = facts; }
      catch (e) { if (['full_admission_claim_changed', 'full_admission_rejected', 'full_admission_claim_missing'].includes(e.code)) return { ready: false, reason: e.code, polls }; }
      if (observed && queueHeadReady(slotJob, observed, clock())) return { ready: true, polls };
      if (clock() + QUEUE_POLL_MS > waitUntil) return { ready: false, reason: 'RESIDENT_QUEUE_HEAD_NOT_REACHED', polls };
      await sleep(QUEUE_POLL_MS);
    }
  }
  // The v2 consumer (merge gate): a settled journal entry of exactly this job and batch claim generation,
  // a fresh complete admission before and after the GitHub read-back, the same durable producer identity.
  // A settled check whose authority changed is compensated once (revoked), never re-posted.
  async function consume(input, selector) {
    const job = fixedJob(input);
    check(exact(selector, ['repository', 'pr', 'headSha', 'baseSha', 'name']) && selector.repository === job.repo && selector.pr === job.pr && selector.headSha === job.headSha
      && selector.baseSha === job.baseSha && selector.name === definitionFor(job).name, 'CONTROL_CONSUMER_SUBJECT_REQUIRED');
    const key = admissionEffectKeyV2(ACTION, job, batchClaim, definitionFor(job)), externalId = admissionExternalIdV2(prefixFor(job), job, batchClaim);
    const stored = await journal.read(key);
    let journalIdentity = false;
    try {
      check(stored?.state === 'settled' && digest(stored.subject?.subject) === digest(subjectOfV2(job)) && digest(stored.subject.claim) === digest(claimGeneration(batchClaim))
        && digest(stored.subject.definition) === digest(definitionFor(job)) && stored.subject.externalId === externalId && Number.isSafeInteger(stored.details?.checkRunId), 'TRUSTED_SETTLED_CONTROL_JOURNAL_REQUIRED');
      journalIdentity = true;
      const before = await boundary(job);
      check(stored.details.sourceBindingSha256 === before.sourceBindingSha256, 'CONTROL_JOURNAL_AUTHORITY_CHANGED');
      const observed = await readback(job, externalId, stored.details.checkRunId, 'success');
      const after = await boundary(job);
      check(after.bindingSha256 === before.bindingSha256, 'CONTROL_CONSUMER_AUTHORITY_CHANGED'); assertLive(); check(fresh(after.facts, clock()), 'CONTROL_CONSUMPTION_EXPIRED');
      const proof = freeze({ contract: 'clued.independent-ci.control-consumption/2', domain, producer: 'independent-control-checks-v2', subject: subjectOfV2(job), claim: claimGeneration(batchClaim),
        definition: definitionFor(job), check: structuredClone(observed), effectKey: key, journalRevision: stored.revision, bindingSha256: after.bindingSha256, sourceBindingSha256: after.sourceBindingSha256,
        nativeObservationBeforeSha256: before.facts.observationSha256, nativeObservationAfterSha256: after.facts.observationSha256, observedAt: after.facts.observedAt, claimExpiresAt: after.facts.claimExpiresAt,
        mergeSlot: structuredClone(after.facts.mergeSlot), mergeQueueHead: after.facts.mergeQueueHead, productionAuthorized: production, qualificationIssued: false, nativeTicketIssued: false });
      if (production) actualConsumptions.set(proof, { selector: structuredClone(selector), expiresAt: Math.min(Date.parse(proof.observedAt) + 30000, Date.parse(proof.claimExpiresAt),
        job.role === 'control-merge-slot' ? Date.parse(proof.mergeSlot.until) : Infinity, authority?.acceptanceValidUntil ? Date.parse(authority.acceptanceValidUntil) : Infinity) });
      return proof;
    } catch (error) {
      if (journalIdentity && Number.isSafeInteger(stored.details?.checkRunId) && stored.details.checkRunId > 0) return revoke({ job, key, externalId, known: { id: stored.details.checkRunId }, phase: 'settled', cause: safe(error), sideEffects: 0 });
      throw error;
    }
  }
  return Object.freeze({ fixture: !production, waitForQueueHead, publishOne, consume, async publishPair(jobs, { waitUntil }) {
    try {
      check(Array.isArray(jobs) && jobs.length === 2 && jobs.map(j => j.role).join('|') === CONTROL_ROLES_V2.join('|') && sameBatchV2(jobs[0], jobs[1]), 'TWO_FIXED_CONTROL_JOBS_REQUIRED');
      jobs.forEach(fixedJob);
      check(Number.isSafeInteger(waitUntil) && waitUntil > clock(), 'QUEUE_WINDOW_REQUIRED');
    } catch (e) { return { status: 'BLOCKED', reason: safe(e), sideEffects: 0, productionAuthorized: false }; }
    const head = await waitForQueueHead(jobs[1], waitUntil);
    record('native_queue_wait', { jobId: jobs[1].id, ready: head.ready, polls: head.polls });
    if (!head.ready) return { status: 'BLOCKED', reason: head.reason, sideEffects: 0, productionAuthorized: false, polls: head.polls };
    const results = []; let sideEffects = 0;
    for (const job of jobs) {
      const r = await publishOne(job); sideEffects += r.sideEffects ?? 0; results.push({ role: job.role, ...r });
      if (r.status !== 'SETTLED') return { status: r.status === 'BLOCKED' && sideEffects > 0 ? 'UNCERTAIN' : r.status, reason: r.reason ?? 'CONTROL_PAIR_INCOMPLETE', results, sideEffects, productionAuthorized: false };
    }
    return { status: 'SETTLED', results, sideEffects, productionAuthorized: production, qualificationIssued: false, nativeTicketIssued: false };
  } });
}
export function createFixtureControlPublisherV2(dependencies) { return engine(dependencies, false); }
// A production consumption proof is usable only for exactly its selector and only within its expiry.
export function takeActualControlConsumptionV2(value, selector) {
  const actual = actualConsumptions.get(value);
  check(actual && digest(actual.selector) === digest(selector) && Date.now() < actual.expiresAt && value.productionAuthorized === true && value.domain === 'production', 'ACTUAL_CURRENT_CONTROL_CONSUMPTION_REQUIRED');
  return value;
}
export function createProductionControlPublisherV2(dependencies) { return engine(dependencies, true); }
// Window of the S8 wait: merge slot 45 min, the batch claim's lease, the install's validUntil and the
// stage cap minus the time two publications need.
export function queueWindow({ startedAt, claimExpiresAt, validUntil, stageDeadline, publicationReserveMs = 7 * 60_000 }) {
  return Math.min(startedAt + MERGE_SLOT_WINDOW_MS, Date.parse(claimExpiresAt), validUntil === null ? Infinity : Date.parse(validUntil), stageDeadline - publicationReserveMs);
}
