// Stage 8 entry of Source v2 (run by the generic helper as clued-control):
//   node startup.mjs --run --stage <nonce> --config-sha256 <sha>
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EffectJournal } from '../effect-journal.mjs';
import { readBatchClaim } from '../batch-claim-v2.mjs';
import { runEntry, controllerPrincipal, controllerPorts, publicationControllerGithub, observationLog, authorityOf } from '../resident-v2/entry-runtime.mjs';
import { STATE_V2, stageByNumber } from '../resident-v2/layout.mjs';
import { STAGE8_CHECK_MS, createProductionControlPublisherV2, queueWindow } from './publisher.mjs';
import { GreenLedger } from './green-ledger.mjs';

export async function main(argv = process.argv.slice(2), output = process.stdout) {
  const startedAt = Date.now();
  return runEntry({ argv, entryRole: 'control-checks', moduleUrl: import.meta.url, output, body: async ({ args, inputs, held, live, sourceRoot }) => {
    const jobs = inputs.jobs;
    const batchClaim = await readBatchClaim(STATE_V2.batchClaims, jobs[0]);
    const { appKey, nativeToken } = await controllerPrincipal(inputs.record);
    const log = observationLog(STATE_V2.effectsControl, jobs[0].id);
    const ports = controllerPorts({ record: inputs.record, appKey, nativeToken, policyText: held.policyText, sourceRoot, live, log });
    const { admission } = ports;
    const journal = await EffectJournal.open(STATE_V2.effectsControl);
    const github = publicationControllerGithub({ ports, jobs: inputs.jobs, journal, args, record: inputs.record });
    // Phase 2, step 3a: the green ledger (migrate-acl.ps1 creates the directory, clued-control only); the train stays off.
    // A ledger that cannot be opened never burns the head: publishPair then answers GREEN_LEDGER_UNAVAILABLE and the
    // batch parks (review M2).
    let greenLedger = null;
    try { greenLedger = await GreenLedger.open(STATE_V2.greenLedger); } catch { /* parked by publishPair */ }
    const publisher = createProductionControlPublisherV2({ github, journal, admission, assertLive: live, record: log, authority: authorityOf(inputs.record.accepted), batchClaim, greenLedger });
    // The claim lease bound is read from the first live observation inside the wait; the outer bound is
    // the stage cap and the install's validUntil. Phase 2, step 2: one run only checks (STAGE8_CHECK_MS); the
    // resident parks the batch and runs this stage again on its own back-off.
    const waitUntil = queueWindow({ startedAt, claimExpiresAt: new Date(startedAt + 24 * 3600_000).toISOString(), validUntil: inputs.record.accepted.validUntil,
      stageDeadline: startedAt + stageByNumber(8).runMilliseconds, checkMs: STAGE8_CHECK_MS });
    return publisher.publishPair(jobs, { waitUntil });
  } });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
