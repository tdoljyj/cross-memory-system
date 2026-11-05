// Stage 1 entry of Source v2 (run by the generic helper as clued-control):
//   node startup.mjs --run --stage <nonce> --config-sha256 <sha>
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EffectJournal } from '../effect-journal.mjs';
import { recordBatchClaim, readBatchClaim } from '../batch-claim-v2.mjs';
import { runEntry, controllerPrincipal, controllerPorts, publicationControllerGithub, observationLog, authorityOf } from '../resident-v2/entry-runtime.mjs';
import { STATE_V2 } from '../resident-v2/layout.mjs';
import { createProductionWorkAdmissionPublisherV2 } from './publisher.mjs';
import { readStageTrainModeFact, trainPortsV2 } from '../independent-control-checks-v2/train-mode.mjs';

export async function main(argv = process.argv.slice(2), output = process.stdout) {
  return runEntry({ argv, entryRole: 'work-admission', moduleUrl: import.meta.url, output, body: async ({ args, inputs, held, live, sourceRoot }) => {
    const job = inputs.jobs[0];
    const { appKey, nativeToken } = await controllerPrincipal(inputs.record);
    const log = observationLog(STATE_V2.effectsWorkAdmission, job.id);
    const ports = controllerPorts({ record: inputs.record, appKey, nativeToken, policyText: held.policyText, sourceRoot, live, log });
    const { admission } = ports;
    const journal = await EffectJournal.open(STATE_V2.effectsWorkAdmission);
    const github = publicationControllerGithub({ ports, jobs: inputs.jobs, journal, args, record: inputs.record, plan: inputs.plan });
    const batchClaims = {
      read: async j => { try { return await readBatchClaim(STATE_V2.batchClaims, j); } catch (e) { if (e.code === 'BATCH_CLAIM_MISSING') return null; throw e; } },
      record: (j, claim, at) => recordBatchClaim(STATE_V2.batchClaims, j, claim, at),
    };
    // Merge train (§41.2, §41.4): the installed train.enabled from this stage directory (default off); with it on, the
    // holders, touch and sweep-proof ports for the front batch's second touch running.
    const { trainMode, unreadable: trainModeUnreadable } = await readStageTrainModeFact(inputs.dir);
    const { slotNative = null, sweepStore = null } = await trainPortsV2({ trainMode, record: inputs.record, fetchImpl: ports.fetchImpl, nativeToken, github: ports.github });
    return createProductionWorkAdmissionPublisherV2({ github, journal, admission, assertLive: live, record: log, authority: authorityOf(inputs.record.accepted), batchClaims,
      trainMode, trainModeUnreadable, slotNative, sweepStore, scanStartRegistrySha256: ports.scanStartRegistrySha256,
      // Generation 10: the held record's end (runEntry sets it), so a re-read wait never leaves the withdrawal without time.
      deadlineAt: () => live.deadlineAt ?? null }).publish(job);
  } });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
