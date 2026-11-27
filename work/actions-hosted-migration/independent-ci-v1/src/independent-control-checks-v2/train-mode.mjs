// Merge train (DESIGN §41.2 "startup.mjs:28 把已装策略的 train.enabled 作为 trainMode 传给发布者"): how stages 1 and 8 learn
// the installed policy's train.enabled. The resident writes it, at the invocation, as one more create-only file of the
// stage directory it already writes for the generic helper (invoke-stage.mjs#prepareStageDirectory: resident\stage\<nonce>\,
// next to formal-service-entry.json and jobs.json). The train-run job of stage 10 carries its mode the same way.
// No file, or anything that is not exactly this record, is 'off': the strictest mode (strict required, no S != H job,
// no train write), so a missing or broken channel can never turn the train on.
import fs from 'node:fs/promises';
import path from 'node:path';
import { TRAIN_MODES, TRAIN_MODE_DEFAULT } from './train-rules.mjs';
import { createMergeSlotNative } from './merge-slot-native.mjs';
import { TRAIN_FAILURE, TRAIN_PROBE_FIELDS, TRAIN_PROTOCOL_VERSION } from '../merge-train-v2-contract.mjs';
import { STATE_V2 } from '../resident-v2/layout.mjs';

export const STAGE_TRAIN_MODE_CONTRACT = 'clued.independent-ci.stage-train-mode/1';
export const STAGE_TRAIN_MODE_FILE = 'train-mode.json';
// The stages that read it.
export const TRAIN_MODE_STAGES = Object.freeze([1, 8]);

// The exact bytes the resident writes (UTF-8, no newline).
export function stageTrainModeText(trainMode) {
  if (!TRAIN_MODES.includes(trainMode)) throw Object.assign(new Error('TRAIN_MODE_REFUSED'), { code: 'TRAIN_MODE_REFUSED' });
  return JSON.stringify({ contract: STAGE_TRAIN_MODE_CONTRACT, trainMode });
}

// Pure: the file's bytes (or null when there is none) -> the mode.
export function parseStageTrainMode(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 256) return TRAIN_MODE_DEFAULT;
  let v;
  try { v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return TRAIN_MODE_DEFAULT; }
  return v !== null && typeof v === 'object' && TRAIN_MODES.includes(v.trainMode) && bytes.toString('utf8') === stageTrainModeText(v.trainMode) ? v.trainMode : TRAIN_MODE_DEFAULT;
}

// The stage directory's file, read once by handle (a plain file, one link, bounded); absent or unreadable is 'off'.
export async function readStageTrainMode(stageDir) { return (await readStageTrainModeFact(stageDir)).trainMode; }

// The same read, saying whether the file was there but unusable (review R1 m4): { trainMode, unreadable }. No file is the
// contract's off (unreadable false); a file that cannot be read or is not exactly the record is off too, with unreadable
// true, so a train front job parks (TRAIN_MODE_UNREADABLE) instead of being refused as final. S = H jobs are unaffected.
export async function readStageTrainModeFact(stageDir) {
  const file = path.join(stageDir, STAGE_TRAIN_MODE_FILE);
  const broken = { trainMode: TRAIN_MODE_DEFAULT, unreadable: true };
  let st;
  try { st = await fs.lstat(file); } catch (e) { return e?.code === 'ENOENT' ? { trainMode: TRAIN_MODE_DEFAULT, unreadable: false } : broken; }
  try {
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 256) return broken;
    const h = await fs.open(file, 'r');
    try {
      const b = await h.readFile();
      if ((await h.stat()).ino !== st.ino) return broken;
      const mode = parseStageTrainMode(b);
      return mode === TRAIN_MODE_DEFAULT && b.toString('utf8') !== stageTrainModeText(TRAIN_MODE_DEFAULT) ? broken : { trainMode: mode, unreadable: false };
    } finally { await h.close(); }
  } catch { return broken; }
}

// Only the protected controller transport supplies the live protocol projection.
const blockedProtocol = Object.freeze({ protocolVersion: null });
const trainAction = {
  readBatch: ['landing_prepare', 'read_batch'],
  atomicLandingQualified: ['landing_prepare', 'atomic_landing_qualified'],
  readRuleBypass: ['landing_prepare', 'read_rule_bypass'],
  verifyMember: ['landing_prepare', 'verify_member'],
  readRequiredRuns: ['landing_prepare', 'read_required_runs'],
  bisectBatch: ['batch_bisect', 'bisect_batch'],
  prepareLanding: ['landing_prepare', 'prepare_landing'],
  authorizeLandingSend: ['landing_send', 'authorize_landing_send'],
  reconcileLanding: ['landing_reconcile', 'reconcile_landing'],
  authorizeLandingInvalidation: ['landing_invalidate', 'authorize_landing_invalidation'],
  readMaintenance: ['batch_reserve', 'read_maintenance'],
  authorizeComposition: ['batch_reserve', 'authorize_composition'],
  sealBatch: ['batch_seal', 'seal_batch'],
  prepareStaging: ['staging_publish', 'prepare_staging'],
  authorizeStagingSend: ['staging_publish', 'authorize_staging_send'],
  readStagingRuns: ['staging_publish', 'read_staging_runs'],
  reconcileStaging: ['staging_publish', 'reconcile_staging'],
  fixActivationMarker: ['batch_reserve', 'fix_marker'],
  authorizeGenerationActivation: ['batch_reserve', 'authorize_generation_activation'],
  reconcileGenerationActivation: ['batch_reserve', 'reconcile_generation_activation'],
  fixStagingMarker: ['staging_publish', 'fix_marker'],
  fixLandingMarker: ['landing_prepare', 'fix_marker'],
  adoptMember: ['claim_adopt', 'adopt_member'],
};

async function sharedTrainPort({ command, config, repositoryId, sourceManifestSha256 }) {
  const boundary = { scope: config.scope, repository: config.repository, repository_id: repositoryId,
    target_branch: 'main', source_manifest_sha256: sourceManifestSha256 };
  let probe;
  try { probe = await command({ ...boundary, action: 'role_probe' }); }
  catch { return blockedProtocol; }
  if (!probe || probe.source_manifest_sha256 !== sourceManifestSha256) return blockedProtocol;
  if (probe.protocol_version !== TRAIN_PROTOCOL_VERSION || !TRAIN_PROBE_FIELDS.every(field => Object.hasOwn(probe, field))
    || probe.on_duty !== true || probe.stop_scope !== 'none' || typeof probe.node_id !== 'string' || !probe.node_id
    || !Number.isSafeInteger(probe.binding_generation) || probe.binding_generation < 1) return blockedProtocol;

  const call = async ([action, operation], subject) => {
    const reply = await command({ ...boundary, protocol_version: TRAIN_PROTOCOL_VERSION,
      node_id: probe.node_id, binding_generation: probe.binding_generation, action, operation, subject });
    if (reply?.protocol_version !== TRAIN_PROTOCOL_VERSION || !Object.hasOwn(reply, 'result')) {
      const code = Object.values(TRAIN_FAILURE).find(failure => failure.native === reply?.error_code)?.resident
        ?? TRAIN_FAILURE.LEASE_STALE.resident;
      throw Object.assign(new Error(code), { code });
    }
    return reply.result;
  };
  const port = Object.fromEntries(Object.entries(trainAction).map(([method, route]) => [method, subject => call(route, subject)]));
  port.authorizeLandingSend = (intent, evidence) => call(trainAction.authorizeLandingSend, { intent, evidence });
  return Object.freeze({ ...port, protocolVersion: TRAIN_PROTOCOL_VERSION, repositoryId });
}

// The legacy ports stages 1, 8 and 10 need with the train on (§41.2, §41.4), built only then: the merge-slot port with the node's CI
// token (holders, touch), the sweep proof store (state\v2\train-sweep, clued-control only; loaded only then; one that
// cannot be opened is no proof) and GitHub's PRs by updated time. Off and shadow: none, nothing is loaded.
export async function trainPortsV2({ trainMode, record, fetchImpl, nativeToken, github, sweepDir = STATE_V2.trainSweep, openStore = null, queueReturn = false,
  nativeCommand, repositoryId, sourceManifestSha256 }) {
  const version = record?.config.mergeTrainProtocolVersion;
  if (nativeCommand && version !== undefined && version !== 1) {
    return { trainV2: await sharedTrainPort({ command: nativeCommand, config: record.config, repositoryId, sourceManifestSha256 }) };
  }
  // Stage 8 must return failed queued PRs in every mode. This port is lazy:
  // constructing it neither reads train state nor makes a Native request.
  if (trainMode !== 'on') return queueReturn ? { slotNative: createMergeSlotNative({ config: record.config, fetchImpl, nativeToken }) } : {};
  let sweepStore = null;
  try { sweepStore = await (openStore ?? (async dir => (await import('./train-sweep-store.mjs')).TrainSweepStore.open(dir)))(sweepDir); } catch { /* not proven */ }
  return { slotNative: createMergeSlotNative({ config: record.config, fetchImpl, nativeToken }), sweepStore,
    pullsUpdatedSince: typeof github?.readPullsUpdatedSince === 'function' ? cursor => github.readPullsUpdatedSince(cursor) : null };
}
