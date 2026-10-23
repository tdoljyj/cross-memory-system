// Check-publisher entry of Source v2 (stages 3, 5, 7), run by the generic helper as clued-control:
//   node one-shot-v2.mjs --run --stage <nonce> --config-sha256 <sha>
// One signed scanner result (copied by the resident from the spool into this stage's own input
// directory) -> one independently verified check publication (staged-check-publisher-v2.mjs).
// The protected observation reads the BATCH claim generation recorded by stage 1 (A-strict) through the
// read-only Native verify RPC; it never binds a PR or charges a meter (the full evaluator does that).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest } from '../src/proof.mjs';
import { subjectOfV2 } from '../src/job-v2.mjs';
import { EffectJournal } from '../src/effect-journal.mjs';
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
  timeoutSignal = ms => AbortSignal.timeout(ms) }) {
  return { async observe(subject, claimGen) {
    live();
    const packet = await github.readChangedPaths(subject);
    const url = `${config.supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/clued_work_verify_v1`;
    const request = JSON.stringify({ p_token_hash: digest(nativeToken), p_input: { scope: config.scope, claim_id: claimGen.claimId, changed_paths: packet.paths } });
    const deadline = monotonic() + OBSERVE_BUDGET_MS;
    for (let attempt = 1; ; attempt++) {
      live();
      const remaining = deadline - monotonic();
      if (remaining <= 0) {
        log('native_claim_observation_unavailable', { attempt: attempt - 1, cause: 'budget', status: null });
        stop('native_claim_observation_unavailable');
      }
      let response = null, body, cause = null;
      try {
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
          log('native_claim_observation_unavailable', { attempt, cause: 'budget', status: response.status });
          stop('native_claim_observation_unavailable');
        }
        log('native_claim_observation', body);
        return facts;
      }
      const wait = OBSERVE_RETRY_WAITS_MS[attempt - 1];
      const exhausted = wait === undefined || monotonic() + wait + OBSERVE_MIN_ATTEMPT_MS > deadline;
      log(exhausted ? 'native_claim_observation_unavailable' : 'native_claim_observation_retry', { attempt, cause, status: response?.status ?? null });
      if (exhausted) stop('native_claim_observation_unavailable');
      await sleep(wait);
    }
  } };
}

export async function main(argv = process.argv.slice(2), output = process.stdout) {
  return runEntry({ argv, entryRole: 'check-publisher', moduleUrl: import.meta.url, output, body: async ({ inputs, held, live, sourceRoot }) => {
    const job = inputs.jobs[0], envelope = inputs.resultEnvelope, { config, accepted } = inputs.record;
    const batchClaim = await readBatchClaim(STATE_V2.batchClaims, job);
    const { appKey, nativeToken } = await controllerPrincipal(inputs.record);
    const log = observationLog(STATE_V2.effectsScan, job.id);
    const { github, admission, fetchImpl } = controllerPorts({ record: inputs.record, appKey, nativeToken, policyText: held.policyText, sourceRoot, live, log });
    const authority = protectedAuthority({ config, accepted, github, fetchImpl, nativeToken, live, log });
    const journal = await EffectJournal.open(STATE_V2.effectsScan);
    const publisher = createStagedCheckPublisherV2({ nativeAdmission: admission, authority, github, journal, signers: inputs.record.signers, configuredChecks: config.checks,
      readChangedPaths: subject => github.readChangedPaths(subject), batchClaim,
      protectedDeployment: { enabled: true, domain: 'production', repository: config.repository, ciPrincipalBindingId: config.ciPrincipalBindingId, ...Object.fromEntries(REFS.map(r => [r, accepted[r]])) },
      domain: 'production' });
    return publisher.publish({ job, envelope });
  } });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
