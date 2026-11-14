// Parameterised, deterministic batch derivation (DESIGN S4). Replaces, as one reviewed program, what
// a human/agent did by hand per batch with derive-bNN.py + bind-rNN-activation.mjs +
// prepare-bNN-launch-glue.py + prepare-payload.mjs + derive-fixed-batch.ps1:
//   inputs  = the installed claim-free record (resident\record, admin-only) + one trigger subject;
//   outputs = eight sealed stage packages (plan, jobs, stage row, work manifest) in a NEW directory.
// No compilation (S12: one generic helper, installed once), no claim, no Owner window per batch,
// no host write outside --out, no network, no secret. The same inputs always give the same bytes.
//
//   node derive-batch.mjs --subject-json <json> --batch-key <64hex> --batch-id <16hex-12hex> --out <new dir> [--record <dir>]
// stdout: {status:'RESIDENT_BATCH_DERIVED', batchKey, batchId, packageSha256, ciSourceManifestSha256, sourceCommit, gitleaksTomlSha256,
//          testSha (the tested commit S every job of the batch names; the engine copies it into the descriptor),
//          stages:[{number,name,entryRole,jobId,jobIds,workManifestSha256,planSha256,directory,runMilliseconds,linuxWorker}]}
// Stage 10 (quota phase 2, step 3c-1; DESIGN §22.1): one train run outside any batch, in its own new directory, from the
// same record. Its one job is a train run (train-run.mjs); the run key is the package's batchKey, the run id its batchId.
//   node derive-batch.mjs --train-run <16hex-12hex> --train-key <64hex> --mode shadow --out <new dir> [--record <dir>]
// stdout: {status:'RESIDENT_TRAIN_RUN_DERIVED', runKey, runId, mode, stage:{number:10,...same row fields}}
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical, digest } from '../proof.mjs';
import { batchJobsV2, MAX_ATTEMPT_V2 } from '../job-v2.mjs';
import { hash } from './prepare-record.mjs';
import { validateRecordV2 } from './record.mjs';
import { BATCH_ID, ENTRY_V2, FORMAL_STAGES_V2, HEX64, RECORD_FILES, REPO, TRAIN_STAGE_V2, WIN_RECORD } from './layout.mjs';
import { TRAIN_RUN_ROLE, TRAIN_RUN_SHADOW_DEFAULTS, makeTrainRun } from './train-run.mjs';
import { STAGE_CONTRACT, PLAN_CONTRACT_V2, stageDirectory, workManifest } from './stage-package.mjs';

export const BATCH_CONTRACT = 'clued.independent-ci.resident-batch/2';
// Must equal the resident ledger's batchKey (independent-ci-resident-v1/src/ledger.mjs).
export const BATCH_KEY_CONTRACT = 'clued.independent-ci.resident-batch-key/1';
const SHA = /^[a-f0-9]{40}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

// Step 3c-2 (design v0.5 §5.2): a train front batch's subject also names the tested commit S (`testSha`, GitHub's test
// merge of [T, H], read live by stage 10), never equal to the head; every other subject has no such field and tests the
// head (S = H). The field joins the batch key only when present, so every existing key stays what it was.
const SUBJECT_KEYS = 'attempt|baseSha|createdAt|headSha|pr|repo|sourceManifestSha256';
const SUBJECT_KEYS_FRONT = 'attempt|baseSha|createdAt|headSha|pr|repo|sourceManifestSha256|testSha';
export function validateSubject(s, now = Date.now()) {
  check(plain(s) && [SUBJECT_KEYS, SUBJECT_KEYS_FRONT].includes(Object.keys(s).sort().join('|')), 'RESIDENT_SUBJECT_FIELDS_REQUIRED');
  check(s.repo === REPO && Number.isSafeInteger(s.pr) && s.pr > 0 && SHA.test(s.headSha) && SHA.test(s.baseSha) && HEX64.test(s.sourceManifestSha256)
    && Number.isSafeInteger(s.attempt) && s.attempt >= 1 && s.attempt <= MAX_ATTEMPT_V2 && ISO.test(s.createdAt)
    && Date.parse(s.createdAt) <= now + 300_000 && (!Object.hasOwn(s, 'testSha') || (SHA.test(s.testSha) && s.testSha !== s.headSha)), 'RESIDENT_SUBJECT_REFUSED');
  return s;
}
export const subjectTestSha = s => (Object.hasOwn(s, 'testSha') ? s.testSha : s.headSha);
export const residentBatchKey = s => digest({ contract: BATCH_KEY_CONTRACT, repo: s.repo, pr: s.pr, headSha: s.headSha, baseSha: s.baseSha, sourceManifestSha256: s.sourceManifestSha256, attempt: s.attempt,
  ...(Object.hasOwn(s, 'testSha') ? { testSha: s.testSha } : {}) });

// Pure derivation: (record docs, subject, key, id) -> file map. Tested byte-for-byte for determinism.
export function deriveBatch({ recordDocs, subject, batchKey, batchId, now = Date.now() }) {
  validateSubject(subject, now);
  check(HEX64.test(batchKey) && batchKey === residentBatchKey(subject), 'RESIDENT_BATCH_KEY_MISMATCH');
  check(BATCH_ID.test(batchId) && batchId.startsWith(batchKey.slice(0, 16)), 'RESIDENT_BATCH_ID_REFUSED');
  const record = validateRecordV2(recordDocs, { now, required: [...Object.values(ENTRY_V2), '.gitleaks.toml'] });
  const ci = record.config.sourceManifestSha256;
  // For the public descriptor: the bundle's reviewed set comes from the INSTALLED Source commit's
  // .gitleaks.toml (hash-pinned here), never from the PR head (b29 lesson).
  const sourceCommit = record.manifest.sourceSha;
  const gitleaksTomlSha256 = record.pins.get('.gitleaks.toml');
  // Job contract /3: the tested commit S is the head (S = H), or a train front batch's own S (step 3c-2, subjectTestSha).
  const jobs = batchJobsV2({ repo: subject.repo, pr: subject.pr, headSha: subject.headSha, baseSha: subject.baseSha, testSha: subjectTestSha(subject), sourceManifestSha256: ci, createdAt: subject.createdAt, attempt: subject.attempt });
  const out = {};
  const rows = [];
  for (const s of FORMAL_STAGES_V2) {
    const { files, row } = stagePackage({ record, s, stageJobs: s.jobRoles.map(r => jobs[r]), batchKey, batchId });
    Object.assign(out, files);
    rows.push(row);
  }
  const batch = { contract: BATCH_CONTRACT, batchKey, batchId, subject, ciSourceManifestSha256: ci, sourceCommit, gitleaksTomlSha256, recordHashes: record.hashes,
    jobs: Object.fromEntries(Object.entries(jobs).map(([r, j]) => [r, j.id])), stages: rows, automaticRetryAllowed: false, claimBound: false };
  out['batch.json'] = canonical(batch);
  const packageSha256 = hash(canonical({ batch: hash(out['batch.json']), stages: rows.map(r => r.workManifestSha256) }));
  return { files: out, result: { status: 'RESIDENT_BATCH_DERIVED', batchKey, batchId, packageSha256, ciSourceManifestSha256: ci, sourceCommit, gitleaksTomlSha256, testSha: jobs['work-admission'].testSha, stages: rows } };
}

// One sealed stage package (plan, stage row, jobs, work manifest), shared by the batch and stage 10.
function stagePackage({ record, s, stageJobs, batchKey, batchId, jobRoles = stageJobs.map(j => j.role) }) {
  const ci = record.config.sourceManifestSha256;
  const jobsText = canonical(stageJobs);
  const plan = { contract: PLAN_CONTRACT_V2, enabled: true, stage: s.number, entryRole: s.entryRole, batchKey, batchId,
    ownerPackageAcceptanceRef: record.accepted.ownerPackageAcceptanceRef, nodeSha256: record.config.controllerNodeSha256, nodeProfileSha256: hash(record.accepted.node),
    entrySha256: record.pins.get(ENTRY_V2[s.entryRole]), acceptanceSha256: record.hashes.acceptanceSha256, sourceManifestSha256: ci,
    installationSha256: record.hashes.installationSha256, runtimeConfigPinSha256: record.hashes.runtimeConfigPinSha256, jobSha256: hash(jobsText) };
  const stage = { contract: STAGE_CONTRACT, number: s.number, name: s.name, entryRole: s.entryRole, jobRoles, jobIds: stageJobs.map(j => j.id),
    runMilliseconds: s.runMilliseconds, linuxWorker: s.linuxWorker, batchKey, batchId };
  const files = { 'stage.json': canonical(stage), 'formal-service-entry.json': canonical(plan), 'jobs.json': jobsText };
  const wm = workManifest(files);
  const dir = stageDirectory(s.number);
  const out = {};
  for (const [n, t] of Object.entries(files)) out[`${dir}/${n}`] = t;
  out[`${dir}/work-manifest.json`] = wm;
  return { files: out, row: { number: s.number, name: s.name, entryRole: s.entryRole, jobId: stageJobs[0].id, jobIds: stage.jobIds, workManifestSha256: hash(wm),
    planSha256: hash(files['formal-service-entry.json']), directory: dir, runMilliseconds: s.runMilliseconds, linuxWorker: s.linuxWorker } };
}

// Stage 10: one train run (contract /2). Pure; the same inputs always give the same bytes (createdAt is the derivation
// time). params: the train-run /2 params (train-run.mjs#TRAIN_RUN_PARAMS); only a shadow run may leave them out.
export function deriveTrainRun({ recordDocs, runId, runKey, mode, params = null, now = Date.now() }) {
  check(HEX64.test(runKey ?? '') && BATCH_ID.test(runId ?? '') && runId.startsWith(runKey.slice(0, 16)), 'RESIDENT_TRAIN_RUN_REFUSED');
  check(params === null ? mode === 'shadow' : plain(params), 'RESIDENT_TRAIN_RUN_REFUSED');
  const record = validateRecordV2(recordDocs, { now, required: [ENTRY_V2['train-maintenance']] });
  let job;
  try { job = makeTrainRun({ ...(params ?? TRAIN_RUN_SHADOW_DEFAULTS), repo: record.config.repository, runId, mode, sourceManifestSha256: record.config.sourceManifestSha256, createdAt: new Date(now).toISOString() }); }
  catch { fail('RESIDENT_TRAIN_RUN_REFUSED'); }
  const { files, row } = stagePackage({ record, s: TRAIN_STAGE_V2, stageJobs: [job], batchKey: runKey, batchId: runId, jobRoles: [TRAIN_RUN_ROLE] });
  return { files, result: { status: 'RESIDENT_TRAIN_RUN_DERIVED', runKey, runId, mode, stage: row } };
}

export function readRecordDocs(dir) {
  const docs = {};
  for (const n of RECORD_FILES) {
    const p = path.join(dir, n);
    const st = fs.lstatSync(p);
    check(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size > 0 && st.size <= 4 * 1024 * 1024, 'RECORD_FILE_BOUNDARY');
    docs[n] = fs.readFileSync(p);
  }
  return docs;
}

export function writeBatch(outDir, files) {
  check(path.isAbsolute(outDir) && !fs.existsSync(outDir), 'RESIDENT_BATCH_EXISTS_PRESERVE_NO_RETRY');
  fs.mkdirSync(outDir);
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(outDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text, { flag: 'wx' });
  }
}

export function main(argv = process.argv.slice(2), { now = Date.now(), output = process.stdout } = {}) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    check(['--subject-json', '--batch-key', '--batch-id', '--out', '--record', '--train-run', '--train-key', '--mode', '--train-params'].includes(argv[i]) && typeof argv[i + 1] === 'string' && !Object.hasOwn(args, argv[i]), 'RESIDENT_DERIVATION_ARGUMENTS_REFUSED');
    args[argv[i]] = argv[i + 1];
  }
  if (Object.hasOwn(args, '--train-run')) {
    // --train-params: the train-run /2 params as one JSON object (always given by the resident, every mode).
    check(args['--train-key'] && args['--mode'] && args['--train-params'] && args['--out'] && !args['--subject-json'] && !args['--batch-key'] && !args['--batch-id'], 'RESIDENT_DERIVATION_ARGUMENTS_REFUSED');
    let params;
    try { params = JSON.parse(args['--train-params']); } catch { fail('RESIDENT_TRAIN_RUN_REFUSED'); }
    const { files, result } = deriveTrainRun({ recordDocs: readRecordDocs(args['--record'] ?? WIN_RECORD), runId: args['--train-run'], runKey: args['--train-key'], mode: args['--mode'], params, now });
    writeBatch(args['--out'], files);
    output.write(JSON.stringify(result) + '\n');
    return 0;
  }
  check(args['--subject-json'] && args['--batch-key'] && args['--batch-id'] && args['--out'] && !args['--train-key'] && !args['--mode'] && !args['--train-params'], 'RESIDENT_DERIVATION_ARGUMENTS_REFUSED');
  let subject;
  try { subject = JSON.parse(args['--subject-json']); } catch { fail('RESIDENT_SUBJECT_FIELDS_REQUIRED'); }
  const { files, result } = deriveBatch({ recordDocs: readRecordDocs(args['--record'] ?? WIN_RECORD), subject, batchKey: args['--batch-key'], batchId: args['--batch-id'], now });
  writeBatch(args['--out'], files);
  output.write(JSON.stringify(result) + '\n');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main(); }
  catch (e) { process.stdout.write(JSON.stringify({ status: 'RESIDENT_DERIVATION_REFUSED', code: /^[A-Z][A-Z0-9_]{1,79}$/.test(e.code ?? '') ? e.code : 'RESIDENT_DERIVATION_UNCONFIRMED' }) + '\n'); process.exitCode = 2; }
}
