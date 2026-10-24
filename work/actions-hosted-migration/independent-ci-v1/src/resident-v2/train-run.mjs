// Train-run job contract (resident quota redesign phase 2, step 3c-1; DESIGN §21.1; Owner decision 2eea28a1).
// Stage 10 ("train maintenance") runs outside any batch, so the one job of its stage package names a run, not a
// PR: the repository, a run id (the 16+12 hex shape of a batch id, so the plan, the C# boundary and the broker
// take it unchanged), the mode and the installed Source. Pure data: no I/O, no network, no credential.
//
// The run key is the package's batchKey; the run id starts with its first 16 hex digits, like a batch id
// starts with its batch key. In step 3c-1 the only mode is 'shadow' (read-only); step 3c-2 adds 'on'.
import { createHash } from 'node:crypto';
import { digest } from '../proof.mjs';

export const TRAIN_RUN_CONTRACT = 'clued.independent-ci.train-run/1';
export const TRAIN_RUN_KEY_CONTRACT = 'clued.independent-ci.train-run-key/1';
export const TRAIN_RUN_ROLE = 'train-run';
export const TRAIN_RUN_FIELDS = Object.freeze(['contract', 'id', 'repo', 'runId', 'mode', 'sourceManifestSha256', 'createdAt']);
export const TRAIN_RUN_IDENTITY = Object.freeze(['repo', 'runId', 'mode', 'sourceManifestSha256']);
export const TRAIN_RUN_MODES = Object.freeze(['shadow']);

const RUN_ID = /^[0-9a-f]{16}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

// A run key from a seed, for tests and fixtures. The resident draws its own random key and run id (engine-windows.mjs
// #runTrainStage); the derivation checks only their shape: the id is the key's first 16 hex digits and a nonce.
export function trainRunKey({ repo, seed }) {
  if (!REPO.test(repo ?? '') || !HEX64.test(seed ?? '')) fail('TRAIN_RUN_KEY_REFUSED');
  return digest({ contract: TRAIN_RUN_KEY_CONTRACT, repo, seed });
}

export function trainRunJobId(job) {
  return createHash('sha256').update(JSON.stringify([TRAIN_RUN_CONTRACT, ...TRAIN_RUN_IDENTITY.map(k => job[k])])).digest('hex');
}

export function validateTrainRun(job) {
  if (!plain(job) || Object.keys(job).length !== TRAIN_RUN_FIELDS.length || !TRAIN_RUN_FIELDS.every(k => Object.hasOwn(job, k))
    || job.contract !== TRAIN_RUN_CONTRACT || !HEX64.test(job.id ?? '') || !REPO.test(job.repo ?? '') || !RUN_ID.test(job.runId ?? '')
    || !TRAIN_RUN_MODES.includes(job.mode) || !HEX64.test(job.sourceManifestSha256 ?? '') || typeof job.createdAt !== 'string'
    || !ISO.test(job.createdAt) || !Number.isFinite(Date.parse(job.createdAt)) || job.id !== trainRunJobId(job)) fail('invalid_train_run');
  return job;
}

export function makeTrainRun({ repo, runId, mode, sourceManifestSha256, createdAt }) {
  const job = { contract: TRAIN_RUN_CONTRACT, id: null, repo, runId, mode, sourceManifestSha256, createdAt };
  job.id = trainRunJobId(job);
  return validateTrainRun(job);
}
