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

export async function main(argv = process.argv.slice(2), output = process.stdout) {
  return runEntry({ argv, entryRole: 'check-publisher', moduleUrl: import.meta.url, output, body: async ({ inputs, held, live, sourceRoot }) => {
    const job = inputs.jobs[0], envelope = inputs.resultEnvelope, { config, accepted } = inputs.record;
    const batchClaim = await readBatchClaim(STATE_V2.batchClaims, job);
    const { appKey, nativeToken } = await controllerPrincipal(inputs.record);
    const log = observationLog(STATE_V2.effectsScan, job.id);
    const { github, admission, fetchImpl } = controllerPorts({ record: inputs.record, appKey, nativeToken, policyText: held.policyText, sourceRoot, live, log });
    const authority = { async observe(subject, claimGen) {
      live();
      const packet = await github.readChangedPaths(subject);
      let response, body;
      try {
        response = await fetchImpl(`${config.supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/clued_work_verify_v1`, { method: 'POST', redirect: 'error',
          headers: { apikey: config.publishableKey, authorization: `Bearer ${config.publishableKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ p_token_hash: digest(nativeToken), p_input: { scope: config.scope, claim_id: claimGen.claimId, changed_paths: packet.paths } }) });
        body = await response.json();
      } catch { stop('native_claim_observation_unconfirmed'); }
      const facts = protectedFactsFromVerify({ job: subject, batchClaim: claimGen, body, status: response.status, config, accepted, now: Date.now() });
      log('native_claim_observation', body);
      return facts;
    } };
    const journal = await EffectJournal.open(STATE_V2.effectsScan);
    const publisher = createStagedCheckPublisherV2({ nativeAdmission: admission, authority, github, journal, signers: inputs.record.signers, configuredChecks: config.checks,
      readChangedPaths: subject => github.readChangedPaths(subject), batchClaim,
      protectedDeployment: { enabled: true, domain: 'production', repository: config.repository, ciPrincipalBindingId: config.ciPrincipalBindingId, ...Object.fromEntries(REFS.map(r => [r, accepted[r]])) },
      domain: 'production' });
    return publisher.publish({ job, envelope });
  } });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
