// Train-run job contract (resident quota redesign phase 2, step 3c-1; DESIGN §21.1, §41.4, §41.7; Owner decision 2eea28a1).
// Stage 10 ("train maintenance") runs outside any batch, so the one job of its stage package names a run, not a
// PR: the repository, a run id (the 16+12 hex shape of a batch id, so the plan, the C# boundary and the broker
// take it unchanged), the mode and the installed Source. Pure data: no I/O, no network, no credential.
//
// The run key is the package's batchKey; the run id starts with its first 16 hex digits, like a batch id
// starts with its batch key. Contract /2 (step 3c-2b, DESIGN §41.7): mode shadow | on | revoke-only; the policy's
// train clocks; onSince (when this node last became eligible for on-mode duty); the executor's frontOutcome of a
// finally failed front batch (flat fields, all null or all set; §41.4 "touch failed"); an accepted revoke-head
// request (§41.3). /1 is no longer produced or accepted. FormalPublicBoundaryV2.cs#ValidateTrainRun is the same
// table (test/fixtures/train-run-cases.json runs on both sides).
// Contract /3 (strict-permanent mode, Owner decision 9e2511fe, resident DESIGN §65): /2 plus `sweep`, the policy's train.sweep:
//   gate   the take-over full sweep gates every batch and the full-sweep proof can cover a green with strict off (§41, §60-§62);
//   audit  strict stays on for good: no full sweep gates anything; a full round is a background audit at most once a day;
//   off    the same without the audit rounds.
// Contract /4 (R3 batch 2, task 04f9b91b): /3 plus frontFailed after frontCode; /3 is no longer produced or accepted (one field
// table per contract number; a stage-10 job is made and run within one call, so there is no job of /3 in flight). The frontOutcome
// has one more flat field, frontFailed (boolean). The executor reports every final
// end of a front batch that has no automatic attempt 2, so stage 10 never waits on a clock to learn the batch ended;
// frontFailed is true only for a failure of the PR itself (failure table `deterministic-pr`), and only then does stage 10
// touch failed, bisect a batch of several or skip opening (train-maintenance.mjs). The resident and the Source change together.
// /2 is no longer produced or accepted (the resident and the Source change together).
import { createHash } from 'node:crypto';
import { digest } from '../proof.mjs';
import { TRAIN_CONTROL_TIMING, TRAIN_PROTOCOL_VERSION } from '../merge-train-v2-contract.mjs';

export const TRAIN_RUN_CONTRACT = 'clued.independent-ci.train-run/4';
export const TRAIN_RUN_KEY_CONTRACT = 'clued.independent-ci.train-run-key/1';
export const TRAIN_RUN_ROLE = 'train-run';
export const TRAIN_RUN_FIELDS = Object.freeze(['contract', 'id', 'repo', 'runId', 'mode', 'sourceManifestSha256', 'createdAt', 'slotHardCapMinutes', 'frontBatchBudgetMs',
  'sweepFreshMs', 'fullSweepMaxMs', 'onSince', 'frontPr', 'frontHeadSha', 'frontTestSha', 'frontAttempt', 'frontCode', 'frontFailed', 'revokeHeadRequestId', 'sweep']);
export const TRAIN_RUN_IDENTITY = Object.freeze(TRAIN_RUN_FIELDS.filter(k => !['contract', 'id', 'createdAt'].includes(k)));
export const TRAIN_RUN_MODES = Object.freeze(['shadow', 'on', 'revoke-only']);
export const TRAIN_RUN_SWEEPS = Object.freeze(['gate', 'audit', 'off']);
// The fields after the four of /1: what the resident passes (derive-batch.mjs --train-params).
export const TRAIN_RUN_PARAMS = Object.freeze(TRAIN_RUN_IDENTITY.slice(4));
const FRONT = Object.freeze(['frontPr', 'frontHeadSha', 'frontTestSha', 'frontAttempt', 'frontCode', 'frontFailed']);
// Policy /8 bounds (DESIGN §41.7).
export const TRAIN_RUN_BOUNDS = Object.freeze({ slotHardCapMinutes: [60, 180], frontBatchBudgetMs: [60_000, 10_800_000], sweepFreshMs: [60_000, 3_600_000], fullSweepMaxMs: [600_000, 86_400_000] });
// Shadow derivations that name no params (fixtures, derive-batch.mjs#deriveTrainRun only; the CLI always takes them).
export const TRAIN_RUN_SHADOW_DEFAULTS = Object.freeze({ slotHardCapMinutes: 120, frontBatchBudgetMs: 3_600_000, sweepFreshMs: 900_000, fullSweepMaxMs: 21_600_000,
  onSince: null, frontPr: null, frontHeadSha: null, frontTestSha: null, frontAttempt: null, frontCode: null, frontFailed: null, revokeHeadRequestId: null, sweep: 'gate' });

const RUN_ID = /^[0-9a-f]{16}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/, SHA = /^[0-9a-f]{40}$/, CODE = /^[A-Z][A-Z0-9_]{1,79}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/, ISO_MS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const within = (v, [lo, hi]) => Number.isSafeInteger(v) && v >= lo && v <= hi;
// Exactly the ISO form toISOString writes (no calendar overflow such as Feb 30), year 0001 or later like C#'s DateTime
// (review R2 minor 10: year 0000 parses in JS only).
const isoMs = v => typeof v === 'string' && ISO_MS.test(v) && !v.startsWith('0000') && Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v;
const frontOutcome = j => Number.isSafeInteger(j.frontPr) && j.frontPr > 0 && SHA.test(j.frontHeadSha ?? '') && SHA.test(j.frontTestSha ?? '')
  && [1, 2].includes(j.frontAttempt) && typeof j.frontCode === 'string' && CODE.test(j.frontCode) && typeof j.frontFailed === 'boolean';

// 受保护入口给常驻端的调度提示。下轮执行仍须重新签名领用。
export function sharedTrainSchedule(now, pending) {
  const delay = pending ? TRAIN_CONTROL_TIMING.recheckMs : 4 * TRAIN_CONTROL_TIMING.recheckMs;
  return { protocolVersion: TRAIN_PROTOCOL_VERSION, retryAt: pending === null ? null : new Date(now + delay).toISOString() };
}

// A run key from a seed, for tests and fixtures. The resident draws its own random key and run id (engine-windows.mjs
// #runTrainStage); the derivation checks only their shape: the id is the key's first 16 hex digits and a nonce.
export function trainRunKey({ repo, seed }) {
  if (!REPO.test(repo ?? '') || !HEX64.test(seed ?? '')) fail('TRAIN_RUN_KEY_REFUSED');
  return digest({ contract: TRAIN_RUN_KEY_CONTRACT, repo, seed });
}

export function trainRunJobId(job) {
  return createHash('sha256').update(JSON.stringify([TRAIN_RUN_CONTRACT, ...TRAIN_RUN_IDENTITY.map(k => job[k])])).digest('hex');
}

// onSince: null in shadow, set in on, either in revoke-only (run under PAUSE while on). frontOutcome: all null, or all
// set in on only (touch failed is an on-mode write). revokeHeadRequestId: null in shadow.
export function validateTrainRun(job) {
  if (!plain(job) || Object.keys(job).length !== TRAIN_RUN_FIELDS.length || !TRAIN_RUN_FIELDS.every(k => Object.hasOwn(job, k))
    || job.contract !== TRAIN_RUN_CONTRACT || !HEX64.test(job.id ?? '') || !REPO.test(job.repo ?? '') || !RUN_ID.test(job.runId ?? '')
    || !TRAIN_RUN_MODES.includes(job.mode) || !HEX64.test(job.sourceManifestSha256 ?? '') || typeof job.createdAt !== 'string'
    || !ISO.test(job.createdAt) || !Number.isFinite(Date.parse(job.createdAt))
    || !Object.entries(TRAIN_RUN_BOUNDS).every(([k, b]) => within(job[k], b))
    || !(job.onSince === null || isoMs(job.onSince)) || (job.mode === 'shadow' && job.onSince !== null) || (job.mode === 'on' && job.onSince === null)
    || !(FRONT.every(k => job[k] === null) || (job.mode === 'on' && frontOutcome(job)))
    || !(job.revokeHeadRequestId === null || (job.mode !== 'shadow' && typeof job.revokeHeadRequestId === 'string' && UUID.test(job.revokeHeadRequestId)))
    || !TRAIN_RUN_SWEEPS.includes(job.sweep)
    || job.id !== trainRunJobId(job)) fail('invalid_train_run');
  return job;
}

// params: every TRAIN_RUN_PARAMS field (policy clocks, onSince, frontOutcome, revokeHeadRequestId), nothing else.
export function makeTrainRun({ repo, runId, mode, sourceManifestSha256, createdAt, ...params }) {
  if (Object.keys(params).length !== TRAIN_RUN_PARAMS.length || !TRAIN_RUN_PARAMS.every(k => Object.hasOwn(params, k))) fail('invalid_train_run');
  const job = { contract: TRAIN_RUN_CONTRACT, id: null, repo, runId, mode, sourceManifestSha256, createdAt };
  for (const k of TRAIN_RUN_PARAMS) job[k] = params[k];
  job.id = trainRunJobId(job);
  return validateTrainRun(job);
}
