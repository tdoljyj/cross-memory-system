// Stage 10 entry of Source v2, "train maintenance" (resident quota redesign phase 2, step 3c-1; design v0.5 §5.5;
// DESIGN §21; Owner decision 2eea28a1). Run by the generic helper as clued-control, outside any batch:
//   node train-maintenance.mjs --run --stage <nonce> --config-sha256 <sha>
// Step 3c-1 is shadow mode only: it reads KooYomi's merge-slot holder (which doubles as the on-duty probe), main,
// main's rules, the front PR and its test merge, and the green ledger; computes what the train WOULD do
// (train-facts.mjs); writes one shadow record; and returns the facts to the resident. It writes nothing to GitHub or
// KooYomi (sideEffects 0): no revocation, no touch, adopt or return, no batch. A read that fails ends the run BLOCKED
// with zero side effects; the resident runs it again on its own schedule.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runEntry, controllerPrincipal, controllerPorts, observationLog } from '../resident-v2/entry-runtime.mjs';
import { STATE_V2 } from '../resident-v2/layout.mjs';
import { validateTrainRun } from '../resident-v2/train-run.mjs';
import { GreenLedger } from './green-ledger.mjs';
import { APP_ID } from './publisher.mjs';
import { createMergeSlotNative } from './merge-slot-native.mjs';
import { RULESET_UNREADABLE, rulesetFacts } from './train-rules.mjs';
import { frontPullFacts, trainFacts, wouldRevoke } from './train-facts.mjs';
import { TrainShadowStore } from './train-shadow-store.mjs';

export const TRAIN_FACTS_STATUS = 'TRAIN_FACTS';
// At most this many ledgered heads are compared with main per run (each is one GitHub read).
export const MAX_LEDGER_HEADS = 30;
const SHA = /^[0-9a-f]{40}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };

// Pure over its ports (tested with fakes). ledger may be null (it could not be opened: then nothing is listed).
export async function readTrainFacts({ job, github, native, ledger, appId = APP_ID, clock = Date.now }) {
  validateTrainRun(job);
  const at = new Date(clock()).toISOString();
  const duty = await native.holders();
  if (!duty.onDuty) return trainFacts({ mode: job.mode, at, onDuty: false, holders: [], mainSha: null, rules: null, front: null, revoke: [], ledger: null });
  const mainSha = (await github.readBranchHead('main')).sha;
  let rules = null, rulesReason = null;
  try {
    const reply = await github.readBranchRules('main');
    if (reply?.complete !== true) fail(RULESET_UNREADABLE);
    rules = rulesetFacts(reply.rules, appId);
  } catch { rulesReason = RULESET_UNREADABLE; }
  const holder = duty.holders.length === 1 ? duty.holders[0] : null;
  let front = null;
  if (holder?.pr) {
    const pull = await github.readPullRequest(holder.pr);
    const headSha = SHA.test(pull?.head?.sha ?? '') ? pull.head.sha : null;
    const compare = headSha ? await github.readCompare(mainSha, headSha) : null;
    const mergeCommit = SHA.test(pull?.merge_commit_sha ?? '') ? await github.readGitCommit(pull.merge_commit_sha) : null;
    const listed = headSha ? await github.readChecks(headSha) : { complete: true, checks: [] };
    if (listed?.complete !== true || !Array.isArray(listed.checks)) fail('TRAIN_FRONT_CHECKS_UNREADABLE');
    front = frontPullFacts({ pull, mergeCommit, compare, checks: listed.checks, mainSha, appId });
  }
  let revoke = [], summary = null;
  if (ledger) {
    const { entries, refused } = await ledger.list();
    summary = { records: entries.length, refused: refused.length };
    const heads = [...new Set(entries.filter(({ entry }) => entry.checkRunId && entry.phase !== 'revoked' && entry.headSha !== front?.headSha).map(({ entry }) => entry.headSha))]
      .slice(-MAX_LEDGER_HEADS);
    const inMain = new Map();
    for (const h of heads) {
      try { const c = await github.readCompare(mainSha, h); inMain.set(h, c.aheadBy === 0 && ['behind', 'identical'].includes(c.status)); }
      catch { inMain.set(h, null); }
    }
    revoke = wouldRevoke({ entries, inMain, frontHeadSha: front?.headSha ?? null });
  }
  return trainFacts({ mode: job.mode, at, onDuty: true, holders: duty.holders, mainSha, rules, rulesReason, front, revoke, ledger: summary });
}

export async function main(argv = process.argv.slice(2), output = process.stdout) {
  return runEntry({ argv, entryRole: 'train-maintenance', moduleUrl: import.meta.url, output, successStatuses: [TRAIN_FACTS_STATUS], body: async ({ inputs, held, live, sourceRoot }) => {
    const job = validateTrainRun(inputs.jobs[0]);
    const { appKey, nativeToken } = await controllerPrincipal(inputs.record);
    const log = observationLog(STATE_V2.trainShadow, job.id);
    const { github, fetchImpl } = controllerPorts({ record: inputs.record, appKey, nativeToken, policyText: held.policyText, sourceRoot, live, log });
    const native = createMergeSlotNative({ config: inputs.record.config, fetchImpl, nativeToken });
    let ledger = null;
    try { ledger = await GreenLedger.open(STATE_V2.greenLedger); } catch { /* listed as nothing; the facts say so */ }
    const facts = await readTrainFacts({ job, github, native, ledger });
    live();
    await (await TrainShadowStore.open(STATE_V2.trainShadow)).append(job.runId, facts);
    return { status: TRAIN_FACTS_STATUS, sideEffects: 0, train: facts };
  } });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
