// Batch claim stickiness (DESIGN S6, claim decoupling §5.3). The claim is resolved live at every
// admission; inside one batch it must stay the same generation (claim id, fence, epoch; a renewal
// that only moves expires_at is the same generation). Stage 1 (work admission) records the claim it
// observed, create-only, in the controller's protected state; every later stage reads that record and
// passes it to full-admission-v2 as `batchClaim`, so a mid-batch takeover / re-claim / handover fails
// the stage closed instead of mixing "scanned under A, published under B".
//
// The record is keyed by the batch's work-admission job id (job-v2.mjs#batchRefV2), which every job
// of the batch can recompute from its own content + attempt; no extra input is needed.
//
// Identity (resident quota redesign v0.6 §1, phase 1): the record's identity is the job content and
// attempt, exactly what batchRefV2 hashes. createdAt is the derivation time of the batch that first
// recorded the claim; it is kept in the record as a fact but is not compared, so a later batch of the
// same content and attempt (derived at another time) reads the same record instead of failing with
// BATCH_CLAIM_RECORD_INVALID. The claim generation is still compared (BATCH_CLAIM_CHANGED).
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonical, digest } from './proof.mjs';
import { batchRefV2, claimGeneration, sameClaimGeneration, validateJobV2, validateObservedClaim } from './job-v2.mjs';

export const BATCH_CLAIM_CONTRACT = 'clued.independent-ci.batch-claim/1';
const FIELDS = ['contract', 'batchRef', 'repo', 'pr', 'headSha', 'baseSha', 'sourceManifestSha256', 'attempt', 'createdAt', 'claim', 'observedAt', 'integrity'];
const HASH = /^[a-f0-9]{64}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const SUBJECT = ['repo', 'pr', 'headSha', 'baseSha', 'sourceManifestSha256', 'attempt', 'createdAt'];
// Compared on every read; createdAt is recorded (SUBJECT) but never part of the identity.
const IDENTITY = SUBJECT.filter(k => k !== 'createdAt');

async function directoryOk(directory) {
  if (!path.isAbsolute(directory)) fail('BATCH_CLAIM_DIRECTORY_INVALID');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const st = await fs.lstat(directory);
  if (!st.isDirectory() || st.isSymbolicLink()) fail('BATCH_CLAIM_DIRECTORY_INVALID');
}
const fileFor = (directory, ref) => { if (!HASH.test(ref)) fail('BATCH_CLAIM_REF_INVALID'); return path.join(directory, `${ref}.json`); };

function body(job, claim, observedAt) {
  const v = { contract: BATCH_CLAIM_CONTRACT, batchRef: batchRefV2(job), ...Object.fromEntries(SUBJECT.map(k => [k, job[k]])),
    claim: claimGeneration(claim), observedAt };
  return { ...v, integrity: digest(v) };
}

export function validateBatchClaimRecord(record, job) {
  validateJobV2(job);
  if (!plain(record) || Object.keys(record).length !== FIELDS.length || !FIELDS.every(k => Object.hasOwn(record, k))
    || record.contract !== BATCH_CLAIM_CONTRACT || record.batchRef !== batchRefV2(job) || !IDENTITY.every(k => record[k] === job[k])
    || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))
    || !plain(record.claim) || Object.keys(record.claim).sort().join('|') !== 'claimId|epoch|fence'
    || typeof record.observedAt !== 'string' || !Number.isFinite(Date.parse(record.observedAt))) fail('BATCH_CLAIM_RECORD_INVALID');
  validateObservedClaim({ ...record.claim, expiresAt: record.observedAt });
  const { integrity, ...rest } = record;
  if (integrity !== digest(rest)) fail('BATCH_CLAIM_RECORD_INVALID');
  return record;
}

async function readRecord(file, job) {
  let st;
  try { st = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 65536) fail('BATCH_CLAIM_RECORD_INVALID');
  let parsed;
  try { parsed = JSON.parse(await fs.readFile(file, 'utf8')); } catch { fail('BATCH_CLAIM_RECORD_INVALID'); }
  return validateBatchClaimRecord(parsed, job);
}

// Stage 1 only (role work-admission): create the record from the facts it just observed, or, if a
// record for this exact batch already exists (a repeated evaluation of the same content+attempt),
// require the same claim generation.
export async function recordBatchClaim(directory, job, observedClaim, observedAt) {
  validateJobV2(job); validateObservedClaim(observedClaim);
  if (job.role !== 'work-admission') fail('BATCH_CLAIM_RECORD_STAGE_ONE_ONLY');
  await directoryOk(directory);
  const file = fileFor(directory, batchRefV2(job));
  const record = body(job, observedClaim, observedAt);
  let handle;
  try { handle = await fs.open(file, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const prior = await readRecord(file, job);
    if (!prior || !sameClaimGeneration(prior.claim, observedClaim)) fail('BATCH_CLAIM_CHANGED');
    return { record: prior, created: false };
  }
  try { await handle.writeFile(canonical(record)); await handle.sync(); } finally { await handle.close(); }
  return { record, created: true };
}

// Every later stage: the batch claim must exist (stage 1 admitted this batch) and is returned as
// the generation full-admission-v2 must observe again.
export async function readBatchClaim(directory, job) {
  validateJobV2(job);
  await directoryOk(directory);
  const record = await readRecord(fileFor(directory, batchRefV2(job)), job);
  if (!record) fail('BATCH_CLAIM_MISSING');
  return Object.freeze({ ...record.claim });
}
