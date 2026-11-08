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
//
// Step 3c-2 (design v0.5 §5.2): a train front batch tests S != H. Its record names S under contract /2 (`testSha`
// after `baseSha`), so the control consumer can re-derive the exact jobs; a batch that tests the head keeps contract
// /1 byte for byte, and a /1 record always means S = H.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, digest } from './proof.mjs';
import { batchRefV2, claimGeneration, isTrainFrontJobV2, sameClaimGeneration, validateJobV2, validateObservedClaim } from './job-v2.mjs';

export const BATCH_CLAIM_CONTRACT = 'clued.independent-ci.batch-claim/1';
export const BATCH_CLAIM_CONTRACT_FRONT = 'clued.independent-ci.batch-claim/2';
const FIELDS = ['contract', 'batchRef', 'repo', 'pr', 'headSha', 'baseSha', 'sourceManifestSha256', 'attempt', 'createdAt', 'claim', 'observedAt', 'integrity'];
const FIELDS_FRONT = [...FIELDS.slice(0, 6), 'testSha', ...FIELDS.slice(6)];
const HASH = /^[a-f0-9]{64}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const SUBJECT = ['repo', 'pr', 'headSha', 'baseSha', 'sourceManifestSha256', 'attempt', 'createdAt'];
const SUBJECT_FRONT = ['repo', 'pr', 'headSha', 'baseSha', 'testSha', 'sourceManifestSha256', 'attempt', 'createdAt'];
// Compared on every read; createdAt is recorded (SUBJECT) but never part of the identity.
const identityOf = subject => subject.filter(k => k !== 'createdAt');
const shapeFor = job => isTrainFrontJobV2(job)
  ? { contract: BATCH_CLAIM_CONTRACT_FRONT, fields: FIELDS_FRONT, subject: SUBJECT_FRONT }
  : { contract: BATCH_CLAIM_CONTRACT, fields: FIELDS, subject: SUBJECT };
// The tested commit a record names: its own field under /2, the head under /1.
export const recordTestShaV2 = record => (record?.contract === BATCH_CLAIM_CONTRACT_FRONT ? record.testSha : record?.headSha);

async function directoryOk(directory) {
  if (!path.isAbsolute(directory)) fail('BATCH_CLAIM_DIRECTORY_INVALID');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const st = await fs.lstat(directory);
  if (!st.isDirectory() || st.isSymbolicLink()) fail('BATCH_CLAIM_DIRECTORY_INVALID');
}
const fileFor = (directory, ref) => { if (!HASH.test(ref)) fail('BATCH_CLAIM_REF_INVALID'); return path.join(directory, `${ref}.json`); };
// A head/attempt may be repaired once across base, train-test and Source variants too.
const rewriteRef = job => digest({ repo: job.repo, headSha: job.headSha, attempt: job.attempt });
const rewriteMarker = (directory, job) => path.join(directory, `${rewriteRef(job)}.rewrite-once`);
const archiveFor = (directory, job) => path.join(directory, `${batchRefV2(job)}.superseded.json`);
async function exists(file) { try { await fs.lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function withClaimLock(directory, job, operation) {
  await directoryOk(directory);
  const lock = path.join(directory, `${rewriteRef(job)}.rewrite-lock`);
  let handle;
  try { handle = await fs.open(lock, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') fail('BATCH_CLAIM_BUSY'); throw e; }
  try { return await operation(); }
  finally { await handle.close(); await fs.unlink(lock); }
}

function body(job, claim, observedAt) {
  const shape = shapeFor(job);
  const v = { contract: shape.contract, batchRef: batchRefV2(job), ...Object.fromEntries(shape.subject.map(k => [k, job[k]])),
    claim: claimGeneration(claim), observedAt };
  return { ...v, integrity: digest(v) };
}

export function validateBatchClaimRecord(record, job) {
  validateJobV2(job);
  const shape = shapeFor(job);
  if (!plain(record) || Object.keys(record).length !== shape.fields.length || !shape.fields.every(k => Object.hasOwn(record, k))
    || record.contract !== shape.contract || record.batchRef !== batchRefV2(job) || !identityOf(shape.subject).every(k => record[k] === job[k])
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
  return withClaimLock(directory, job, async () => {
    const file = fileFor(directory, batchRefV2(job));
    const record = body(job, observedClaim, observedAt);
    // A crash after archiving the old record must never reopen create-only admission.
    if (!(await exists(file)) && await exists(archiveFor(directory, job))) fail('BATCH_CLAIM_REWRITE_INCOMPLETE');
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
  });
}

// Stage one only. The installed publisher supplies the fresh no-publication proof under
// the same lock used to begin an effect. All uncertainty fails closed; the one-time
// reservation is intentionally retained after any crash or incomplete replacement.
export async function rewriteUnpublishedBatchClaim(directory, job, expectedClaim, observedClaim, observedAt, verifyUnpublished) {
  validateJobV2(job); validateObservedClaim(observedClaim);
  if (job.role !== 'work-admission' || typeof verifyUnpublished !== 'function') fail('BATCH_CLAIM_RECORD_STAGE_ONE_ONLY');
  const next = body(job, observedClaim, observedAt);
  validateBatchClaimRecord(next, job);
  return withClaimLock(directory, job, async () => {
    const file = fileFor(directory, batchRefV2(job)), archive = archiveFor(directory, job), marker = rewriteMarker(directory, job);
    const prior = await readRecord(file, job);
    if (!prior || !sameClaimGeneration(prior.claim, expectedClaim) || sameClaimGeneration(prior.claim, observedClaim)) fail('BATCH_CLAIM_CHANGED');
    if (await exists(marker) || await exists(archive)) fail('BATCH_CLAIM_CHANGED');
    await verifyUnpublished();
    // The callback may await I/O. Keep the generation CAS at the actual replacement boundary.
    const current = await readRecord(file, job);
    if (!current || current.integrity !== prior.integrity) fail('BATCH_CLAIM_CHANGED');
    const reservation = await fs.open(marker, 'wx', 0o600);
    try { await reservation.writeFile(canonical({ batchRef: batchRefV2(job), oldIntegrity: prior.integrity, newIntegrity: next.integrity })); await reservation.sync(); }
    finally { await reservation.close(); }
    const temporary = path.join(directory, `${batchRefV2(job)}.${randomUUID()}.rewrite-tmp`);
    const staged = await fs.open(temporary, 'wx', 0o600);
    try { await staged.writeFile(canonical(next)); await staged.sync(); }
    finally { await staged.close(); }
    // Both noncanonical names are excluded by the consumer's exact 64-hex.json scan.
    // A crash in the gap leaves no active claim: every reader and writer fails closed.
    await fs.rename(file, archive);
    await fs.rename(temporary, file);
    return { record: next, rewritten: true };
  });
}

// An older in-flight stage-one publisher cannot begin its effect after a repair.
// Existing effects retain their reconciliation path; this excludes only NEW intents.
export async function withBatchClaimPublication(directory, job, expectedClaim, operation) {
  validateJobV2(job);
  if (job.role !== 'work-admission' || typeof operation !== 'function') fail('BATCH_CLAIM_RECORD_STAGE_ONE_ONLY');
  return withClaimLock(directory, job, async () => {
    const current = await readRecord(fileFor(directory, batchRefV2(job)), job);
    if (!current || !sameClaimGeneration(current.claim, expectedClaim)) fail('BATCH_CLAIM_CHANGED');
    return operation();
  });
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
