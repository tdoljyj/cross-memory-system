// Check-publisher entry of Source v2 (stages 3, 5, 7), run by the generic helper as clued-control:
//   node one-shot-v2.mjs --run --stage <nonce> --config-sha256 <sha>
// One signed scanner result (copied by the resident from the spool into this stage's own input
// directory) -> one independently verified check publication (staged-check-publisher-v2.mjs).
// The protected observation reads the BATCH claim generation recorded by stage 1 (A-strict) through the
// read-only Native verify RPC; it never binds a PR or charges a meter (the full evaluator does that).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest } from '../src/proof.mjs';
import { subjectOfV2, validateJobV2, scanEffectKeyV2, sameClaimGeneration, claimGeneration, SCANNER_ROLES_V2 } from '../src/job-v2.mjs';
import { verifyResultV2 } from '../src/proof-v2.mjs';
import { publishedNames } from '../src/published-on-github-v2.mjs';
import { relayExternalId, validateHostedEnvelope } from '../src/hosted-relay-v1/attest.mjs';
import { EffectJournal, rolePublicationKey } from '../src/effect-journal.mjs';
import { readBatchClaim } from '../src/batch-claim-v2.mjs';
import { createStagedCheckPublisherV2 } from '../src/staged-check-publisher-v2.mjs';
import { runEntry, controllerPrincipal, controllerPorts, observationLog } from '../src/resident-v2/entry-runtime.mjs';
import { STATE_V2 } from '../src/resident-v2/layout.mjs';

const REFS = ['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef'];
const stop = code => { throw Object.assign(new Error(code), { code }); };

// Pure verification of the clued_work_verify_v1 reply for the batch claim generation.
export function protectedFactsFromVerify({ job, batchClaim, body, status, config, accepted, now }) {
  const claim = body?.claim;
  if (status !== 200 || body?.status !== 'ok' || body.verdict !== 'ADMITTED' || body.execution_policy !== 'staged'
    || claim?.lease_key_required !== false || claim.execution_handover_pending !== false || claim.status !== 'ACTIVE'
    || claim.claim_id !== batchClaim.claimId || claim.context_key !== config.scope || claim.fence !== batchClaim.fence
    || body.current_fence !== batchClaim.fence || claim.execution_epoch !== batchClaim.epoch || body.execution_epoch !== batchClaim.epoch
    || !Array.isArray(body.paths_outside_write_set) || body.paths_outside_write_set.length
    || !(Date.parse(claim.expires_at) > now) || !(Date.parse(body.verified_at) <= now) || now - Date.parse(body.verified_at) > 30000) stop('native_claim_observation_refused');
  return { ...subjectOfV2(job), ...Object.fromEntries(REFS.map(r => [r, accepted[r]])), ciPrincipalBindingId: config.ciPrincipalBindingId,
    sourceAccepted: true, hostQualified: true, publisherQualified: true, ciPrincipalQualified: true, observedAt: body.verified_at, claimExpiresAt: claim.expires_at,
    claim: { claimId: claim.claim_id, fence: claim.fence, epoch: claim.execution_epoch } };
}

// Bounded retry of the verify request (KooYomi Task a3ad42a9; the issuer's RETRY_WAITS_MS, resident DESIGN §7.8). A
// request that timed out or failed on the network, or that Native answered 5xx or 429 (the anon role's 3 s statement
// timeout is a 500/57014), is sent again after 1, 2 and 4 s, and only while the wait still leaves a short attempt
// before OBSERVE_BUDGET_MS from the first request (monotonic time; the changed-paths read before it has its own
// bound); every attempt's own wait is the same 10 s as v1 one-shot.mjs (PR-A review MINOR), cut to that budget. Each
// attempt is a new read verified exactly as before, with its own verified_at checked against its own arrival. The
// monotonic deadline is checked again after a scheduled wait and before accepting a reply (an abort timer can run
// late); the held record must still be live at that arrival. Thus a
// retried answer is as fresh and complete as a first one; a verified refusal (native_claim_observation_refused) and
// any other failure, such as a body that is not JSON, a redirect or a bad URL (native_claim_observation_unconfirmed),
// never retry. Exhausted: native_claim_observation_unavailable, mapped to NATIVE_ADMISSION_UNAVAILABLE only on a
// clean BLOCKED with zero side effects; this does not enable a new batch attempt after a role may have published.
// The verify RPC is read-only, so a retry never writes or re-posts a check, on the publisher's first
// boundary (before its journal says sent) or on the one after its write. Like the answer's, a retry's observation
// log line must be written: if it cannot be, the observation fails closed.
export const OBSERVE_RETRY_WAITS_MS = Object.freeze([1000, 2000, 4000]);
export const OBSERVE_BUDGET_MS = 30000;
const OBSERVE_ATTEMPT_MS = 10000, OBSERVE_MIN_ATTEMPT_MS = 2000;
const transientStatus = status => status === 429 || (status >= 500 && status <= 599);
// fetch (undici) on Node 24: the attempt's own timeout is a TimeoutError; a network failure is a TypeError ("fetch
// failed" while connecting or sending, "terminated" while reading the body) whose cause carries a socket or DNS code.
// A TypeError without one (a redirect refused by redirect:'error', a bad URL or header, a fault in this code) is not.
// A dual-stack connect gives an AggregateError whose own code is only its first attempt's: every attempt's code counts.
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
  'ENETDOWN', 'EHOSTDOWN', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
export const transientFetchError = error => error?.name === 'TimeoutError'
  || (error instanceof TypeError && ['fetch failed', 'terminated'].includes(error.message)
    && [error.cause?.code, ...(Array.isArray(error.cause?.errors) ? error.cause.errors.map(e => e?.code) : [])].some(code => NETWORK_CODES.has(code)));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// The protected observation port of a v2 scanner publisher (this entry and the stage-R relay entry): the
// read-only Native verify RPC for the batch claim generation. It never binds a PR or charges a meter.
// clock (verified_at freshness), monotonic (the retry budget), sleep and timeoutSignal are the tests' seams.
export function protectedAuthority({ config, accepted, github, fetchImpl, nativeToken, live, log, clock = Date.now, monotonic = () => performance.now(), sleep = pause,
  timeoutSignal = ms => AbortSignal.timeout(ms), recoveryState = null }) {
  return { async observe(subject, claimGen) {
    live();
    const state = recoveryState?.();
    const windowStarted = monotonic();
    if (state && state.deadline === null) { state.startedAt = monotonic(); state.deadline = state.startedAt + PUBLICATION_OBSERVE_BUDGET_MS; }
    if (state) state.observationCalls++;
    const packet = await github.readChangedPaths(subject);
    const url = `${config.supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/clued_work_verify_v1`;
    const request = JSON.stringify({ p_token_hash: digest(nativeToken), p_input: { scope: config.scope, claim_id: claimGen.claimId, changed_paths: packet.paths } });
    const deadline = Math.min((state ? windowStarted : monotonic()) + OBSERVE_BUDGET_MS, state?.deadline ?? Infinity);
    let lastTransient = false;
    const unavailable = data => {
      log('native_claim_observation_unavailable', data);
      if (state) state.exhaustion = { subjectSha256: digest(subjectOfV2(subject)), claimSha256: digest(claimGeneration(claimGen)), transient: lastTransient, ...data };
      stop('native_claim_observation_unavailable');
    };
    for (let attempt = 1; ; attempt++) {
      live();
      const remaining = deadline - monotonic();
      if (remaining <= 0) {
        unavailable({ attempt: attempt - 1, cause: 'budget', status: null });
      }
      let response = null, body, cause = null;
      try {
        if (state) state.verifyRequests++;
        response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: timeoutSignal(Math.max(1, Math.min(OBSERVE_ATTEMPT_MS, Math.ceil(remaining)))),
          headers: { apikey: config.publishableKey, authorization: `Bearer ${config.publishableKey}`, 'content-type': 'application/json' }, body: request });
        if (transientStatus(response.status)) {
          cause = 'status';
          try { await response.body?.cancel(); } catch { /* the answer is discarded either way */ }
        } else body = await response.json();
      } catch (error) {
        if (!transientFetchError(error)) stop('native_claim_observation_unconfirmed');
        cause = response ? 'body' : 'transport';
      }
      if (cause === null) {
        const facts = protectedFactsFromVerify({ job: subject, batchClaim: claimGen, body, status: response.status, config, accepted, now: clock() });
        live();
        if (monotonic() > deadline) {
          unavailable({ attempt, cause: 'budget', status: response.status });
        }
        log('native_claim_observation', body);
        return facts;
      }
      lastTransient = true;
      const wait = OBSERVE_RETRY_WAITS_MS[attempt - 1];
      const exhausted = wait === undefined || monotonic() + wait + OBSERVE_MIN_ATTEMPT_MS > deadline;
      if (exhausted) unavailable({ attempt, cause, status: response?.status ?? null });
      log('native_claim_observation_retry', { attempt, cause, status: response?.status ?? null });
      await sleep(wait);
    }
  } };
}

// Task a3ad42a9, alternative A: one recovery of only the current publisher, inside the SAME
// native helper/nonce. The original helper's absolute phase deadline and final cleanup receipt
// remain authoritative. This is explicitly up to two pre-write observation rounds, not a 30 s
// total promise: all observations, intervening guards and waits share one fixed 60 s deadline.
// A crash never resumes this in-memory continuation; existing resident crash/HALT rules apply.
export const PUBLICATION_OBSERVE_BUDGET_MS = 60000;
export const PUBLICATION_READBACK_RESERVE_MS = OBSERVE_MIN_ATTEMPT_MS;
export function createRecoverableCheckPublisherV2({ publisherOptions, authorityOptions, readCurrentBatchClaim, live, log,
  clock = Date.now, monotonic = () => performance.now() }) {
  if (typeof readCurrentBatchClaim !== 'function' || typeof live !== 'function' || typeof log !== 'function') stop('publication_recovery_unconfirmed');
  let active = null;
  const usedRoles = new Set();
  const safeLog = (kind, data) => {
    try { log(kind, data); } catch { if (active) active.unsafe = true; stop('publication_recovery_unconfirmed'); }
  };
  const safeLive = () => {
    try { live(); } catch { if (active) active.unsafe = true; stop('publication_recovery_unconfirmed'); }
  };
  const markMutation = () => { if (!active) stop('publication_recovery_unconfirmed'); active.mutationAttempted = true; };
  const guardNewPublication = () => {
    if (!active || !Number.isFinite(active.observation.deadline) || monotonic() + PUBLICATION_READBACK_RESERVE_MS > active.observation.deadline) {
      if (active) active.unsafe = true;
      stop('publication_recovery_unconfirmed');
    }
  };
  const journal = Object.fromEntries(['read', 'begin', 'transition'].map(name => [name, async (...args) => {
    if (name !== 'read') markMutation();
    if (name === 'begin' && active?.observedJob) {
      const j = active.observedJob, d = publisherOptions.configuredChecks[j.role];
      if (args[0] === rolePublicationKey({ repo: j.repo, headSha: j.headSha, role: j.role, checkName: d.name, appId: d.appId })) guardNewPublication();
    }
    return publisherOptions.journal[name](...args);
  }]));
  const github = new Proxy(publisherOptions.github, { get(target, name) {
    const value = Reflect.get(target, name);
    if (typeof value !== 'function') return value;
    return async (...args) => {
      safeLive();
      if (name === 'createCheck' || name === 'revokeCheck') markMutation();
      if (name === 'createCheck') guardNewPublication();
      // Revocation and journal persistence are compensation, never bounded by the retry deadline.
      const result = await value.apply(target, args);
      safeLive();
      return result;
    };
  } });
  const nativeAdmission = { ...publisherOptions.nativeAdmission, async evaluatePr(...args) {
    if (!active) stop('publication_recovery_unconfirmed');
    active.evaluations++;
    safeLive();
    const result = await publisherOptions.nativeAdmission.evaluatePr(...args);
    safeLive();
    return result;
  } };
  const baseAuthority = protectedAuthority({ ...authorityOptions, github, live: safeLive, log: safeLog, clock, monotonic,
    recoveryState: () => active?.observation ?? null });
  const authority = { ...(publisherOptions.domain === 'fixture' ? { fixture: true } : {}), async observe(job, claim) {
    if (!active) stop('publication_recovery_unconfirmed');
    active.observedJob = structuredClone(job);
    return baseAuthority.observe(job, claim);
  } };
  const publisher = createStagedCheckPublisherV2({ ...publisherOptions, journal, github, nativeAdmission, authority, clock });
  const requireGuard = condition => { if (!condition) stop('publication_recovery_unconfirmed'); };
  async function proveNoEffects(op, result) {
    const job = op.observedJob;
    validateJobV2(job);
    requireGuard(SCANNER_ROLES_V2.includes(job.role) && digest(op.input) === op.inputSha256);
    const definition = publisherOptions.configuredChecks[job.role];
    requireGuard(definition && Object.keys(definition).sort().join('|') === 'appId|name'
      && Number.isSafeInteger(definition.appId) && definition.appId > 0 && typeof definition.name === 'string');
    const mutexKey = rolePublicationKey({ repo: job.repo, headSha: job.headSha, role: job.role, checkName: definition.name, appId: definition.appId });
    let key;
    const evidence = async () => {
      safeLive();
      if (op.method === 'publish') {
        requireGuard(digest(subjectOfV2(op.input.job)) === digest(subjectOfV2(job)));
        verifyResultV2({ job, envelope: op.input.envelope, signers: publisherOptions.signers, now: clock(), domain: publisherOptions.domain });
      } else {
        const s = op.input.subject, e = op.input.envelope;
        validateHostedEnvelope(e);
        requireGuard(['repo', 'pr', 'headSha', 'baseSha', 'sourceManifestSha256'].every(k => s[k] === job[k])
          && op.input.attempt === job.attempt && e.role === job.role && sameClaimGeneration(s, publisherOptions.batchClaim));
        const confirmed = await publisherOptions.hostedVerifier.confirm(e);
        requireGuard(confirmed?.confirmed === true && confirmed.attestationSha256 === e.attestationSha256);
      }
      requireGuard(sameClaimGeneration(await readCurrentBatchClaim(job), publisherOptions.batchClaim));
      safeLive();
    };
    if (op.method === 'publish') key = scanEffectKeyV2(job, definition);
    else {
      const e = op.input.envelope;
      const externalId = relayExternalId({ role: job.role, headSha: job.headSha, runId: e.runId, runAttempt: e.runAttempt });
      key = digest({ action: 'hosted-relay-check/2', roleMutexKey: mutexKey, externalId, definition });
    }
    requireGuard(result.effectKey === key && (op.method !== 'publishHosted' || result.roleMutex?.key === mutexKey && result.roleMutex.held === false));
    const latch = op.observation.exhaustion;
    requireGuard(latch?.transient === true && latch.attempt > 0 && latch.subjectSha256 === digest(subjectOfV2(job))
      && latch.claimSha256 === digest(claimGeneration(publisherOptions.batchClaim)));
    const within = () => requireGuard(monotonic() + OBSERVE_MIN_ATTEMPT_MS <= op.observation.deadline);
    within();
    await evidence();
    requireGuard(await journal.read(key) === null && await journal.read(mutexKey) === null);
    requireGuard((await publishedNames(github, job.headSha, [definition.name], definition.appId)).length === 0);
    // Recheck after the potentially slow remote read. No absence inferred from any thrown read.
    requireGuard(await journal.read(key) === null && await journal.read(mutexKey) === null);
    await evidence();
    within();
    requireGuard(!op.mutationAttempted && op.evaluations === 0 && !op.unsafe);
    return { jobId: job.id, role: job.role, effectKey: key, roleMutexKey: mutexKey, inputSha256: op.inputSha256,
      claim: claimGeneration(publisherOptions.batchClaim), maxPublisherAttempts: 2, maxObservationMs: PUBLICATION_OBSERVE_BUDGET_MS };
  }
  const run = async (method, input) => {
    if (active) stop('publication_recovery_unconfirmed');
    // Only the internal continuation below can use a role twice. A fresh public call must
    // never reset that role's 60 s allowance or re-enter a previous SETTLED relay prefix.
    const subject = method === 'publish' ? input?.job : input?.subject;
    const role = method === 'publish' ? input?.job?.role : input?.envelope?.role;
    const roleId = digest({ repo: subject?.repo, headSha: subject?.headSha, role });
    if (usedRoles.has(roleId)) return { status: 'UNCERTAIN', reason: 'publication_recovery_reentry_refused', sideEffects: 0,
      mayHavePublished: true, productionAuthorized: false, ...(method === 'publishHosted' ? { roleMutex: { key: null, held: true } } : {}) };
    usedRoles.add(roleId);
    const op = { method, input: structuredClone(input), inputSha256: digest(input), mutationAttempted: false,
      evaluations: 0, unsafe: false, attempts: 1, observation: { deadline: null, startedAt: null, observationCalls: 0, verifyRequests: 0, exhaustion: null }, observedJob: null };
    active = op;
    let result;
    try {
      result = await publisher[method](op.input);
      const exhausted = result?.status === 'BLOCKED' && result.reason === 'native_claim_observation_unavailable' && result.sideEffects === 0;
      if (exhausted) {
        if (!op.observation.exhaustion || result.mayHavePublished === true || op.mutationAttempted || op.evaluations !== 0 || op.unsafe) op.unsafe = true;
        else if (monotonic() + OBSERVE_MIN_ATTEMPT_MS <= op.observation.deadline) {
          try {
            const proof = await proveNoEffects(op, result);
            safeLog('publication_recovery_intent', proof);
            // No new helper, nonce, job, evaluator operation or phase allowance is issued here.
            op.attempts = 2; op.observation.exhaustion = null;
            result = await publisher[method](op.input);
          } catch { op.unsafe = true; }
        }
      }
      safeLog('publication_recovery_result', { jobId: op.observedJob?.id ?? null, publisherAttempts: op.attempts,
        maxObservationMs: PUBLICATION_OBSERVE_BUDGET_MS, observationCalls: op.observation.observationCalls, verifyRequests: op.observation.verifyRequests,
        observationElapsedMs: op.observation.startedAt === null ? 0 : monotonic() - op.observation.startedAt, observationBudgetRemainingMs: op.observation.deadline === null ? null : Math.max(0, op.observation.deadline - monotonic()),
        mutationAttempted: op.mutationAttempted, fullEvaluations: op.evaluations, status: result?.status ?? null, unconfirmed: op.unsafe });
    } catch { op.unsafe = true; }
    finally { active = null; }
    if (!op.unsafe) return result;
    return { ...result, status: 'UNCERTAIN', reason: 'publication_recovery_unconfirmed', sideEffects: result?.sideEffects ?? 0,
      productionAuthorized: false, mayHavePublished: true, ...(method === 'publishHosted' ? { roleMutex: { key: result?.roleMutex?.key ?? null, held: true } } : {}) };
  };
  return Object.freeze({ fixture: publisher.fixture, publish: input => run('publish', input), publishHosted: input => run('publishHosted', input) });
}

export async function main(argv = process.argv.slice(2), output = process.stdout) {
  return runEntry({ argv, entryRole: 'check-publisher', moduleUrl: import.meta.url, output, body: async ({ inputs, held, live, sourceRoot }) => {
    const job = inputs.jobs[0], envelope = inputs.resultEnvelope, { config, accepted } = inputs.record;
    const batchClaim = await readBatchClaim(STATE_V2.batchClaims, job);
    const { appKey, nativeToken } = await controllerPrincipal(inputs.record);
    const log = observationLog(STATE_V2.effectsScan, job.id);
    const { github, admission, fetchImpl } = controllerPorts({ record: inputs.record, appKey, nativeToken, policyText: held.policyText, sourceRoot, live, log });
    const journal = await EffectJournal.open(STATE_V2.effectsScan);
    const publisher = createRecoverableCheckPublisherV2({ authorityOptions: { config, accepted, github, fetchImpl, nativeToken },
      readCurrentBatchClaim: j => readBatchClaim(STATE_V2.batchClaims, j), live, log, publisherOptions: { nativeAdmission: admission, github, journal, signers: inputs.record.signers, configuredChecks: config.checks,
      readChangedPaths: subject => github.readChangedPaths(subject), batchClaim,
      protectedDeployment: { enabled: true, domain: 'production', repository: config.repository, ciPrincipalBindingId: config.ciPrincipalBindingId, ...Object.fromEntries(REFS.map(r => [r, accepted[r]])) },
      domain: 'production' } });
    return publisher.publish({ job, envelope });
  } });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
