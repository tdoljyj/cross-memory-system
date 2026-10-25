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
// Stage R (hosted relay, free-minutes design S19) is not part of the batch derivation: its job list is the
// relay candidates the resident decided after the hosted wait (20-plan-intent). One more deterministic call
// adds exactly that one package to the existing batch directory (create-only, from the same record):
//   node derive-batch.mjs --relay-roles gitleaks,trivy --batch-dir <dir> --batch-key <64hex> --batch-id <id> [--record <dir>]
// stdout: {status:'RESIDENT_RELAY_STAGE_DERIVED', batchKey, batchId, stage:{number:9,...same row fields}}
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
import { BATCH_ID, ENTRY_V2, FORMAL_STAGES_V2, HEX64, RECORD_FILES, RELAY_STAGE_V2, REPO, TRAIN_STAGE_V2, WIN_RECORD, stageJobRolesValid } from './layout.mjs';
import { TRAIN_RUN_ROLE, makeTrainRun } from './train-run.mjs';
import { STAGE_CONTRACT, PLAN_CONTRACT_V2, stageDirectory, workManifest } from './stage-package.mjs';

export const BATCH_CONTRACT = 'clued.independent-ci.resident-batch/2';
// Must equal the resident ledger's batchKey (independent-ci-resident-v1/src/ledger.mjs).
export const BATCH_KEY_CONTRACT = 'clued.independent-ci.resident-batch-key/1';
const SHA = /^[a-f0-9]{40}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

export function validateSubject(s, now = Date.now()) {
  check(plain(s) && Object.keys(s).sort().join('|') === 'attempt|baseSha|createdAt|headSha|pr|repo|sourceManifestSha256', 'RESIDENT_SUBJECT_FIELDS_REQUIRED');
  check(s.repo === REPO && Number.isSafeInteger(s.pr) && s.pr > 0 && SHA.test(s.headSha) && SHA.test(s.baseSha) && HEX64.test(s.sourceManifestSha256)
    && Number.isSafeInteger(s.attempt) && s.attempt >= 1 && s.attempt <= MAX_ATTEMPT_V2 && ISO.test(s.createdAt)
    && Date.parse(s.createdAt) <= now + 300_000, 'RESIDENT_SUBJECT_REFUSED');
  return s;
}
export const residentBatchKey = s => digest({ contract: BATCH_KEY_CONTRACT, repo: s.repo, pr: s.pr, headSha: s.headSha, baseSha: s.baseSha, sourceManifestSha256: s.sourceManifestSha256, attempt: s.attempt });

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
  // Job contract /3: the tested commit S is the head (S = H) until step 3c's train front batch brings another one.
  const jobs = batchJobsV2({ repo: subject.repo, pr: subject.pr, headSha: subject.headSha, baseSha: subject.baseSha, testSha: subject.headSha, sourceManifestSha256: ci, createdAt: subject.createdAt, attempt: subject.attempt });
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

// One sealed stage package (plan, stage row, jobs, work manifest), shared by the batch, stage R and stage 10.
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

// Stage R for an already derived batch: the same record, the batch's own subject and job ids (re-derived and
// compared, never trusted from the file), and the relay candidate roles (a non-empty ordered subset of the
// relayable roles). Pure; the same inputs always give the same bytes.
export function deriveRelayStage({ recordDocs, batchJson, roles, batchKey, batchId, now = Date.now() }) {
  const text = Buffer.isBuffer(batchJson) ? batchJson.toString('utf8') : batchJson;
  let batch;
  try { batch = JSON.parse(text); } catch { fail('RESIDENT_BATCH_RECORD_REFUSED'); }
  check(plain(batch) && batch.contract === BATCH_CONTRACT && batch.batchKey === batchKey && batch.batchId === batchId && canonical(batch) === text, 'RESIDENT_BATCH_RECORD_REFUSED');
  check(Array.isArray(roles) && stageJobRolesValid(RELAY_STAGE_V2, roles), 'RESIDENT_RELAY_ROLES_REFUSED');
  const subject = validateSubject(batch.subject, now);
  check(batchKey === residentBatchKey(subject), 'RESIDENT_BATCH_KEY_MISMATCH');
  const record = validateRecordV2(recordDocs, { now, required: [...Object.values(ENTRY_V2), '.gitleaks.toml'] });
  const ci = record.config.sourceManifestSha256;
  check(batch.ciSourceManifestSha256 === ci, 'RESIDENT_BATCH_RECORD_REFUSED');
  const jobs = batchJobsV2({ repo: subject.repo, pr: subject.pr, headSha: subject.headSha, baseSha: subject.baseSha, testSha: subject.headSha, sourceManifestSha256: ci, createdAt: subject.createdAt, attempt: subject.attempt });
  check(plain(batch.jobs) && Object.keys(batch.jobs).length === Object.keys(jobs).length && Object.entries(jobs).every(([r, j]) => batch.jobs[r] === j.id), 'RESIDENT_BATCH_RECORD_REFUSED');
  const { files, row } = stagePackage({ record, s: RELAY_STAGE_V2, stageJobs: roles.map(r => jobs[r]), batchKey, batchId });
  return { files, result: { status: 'RESIDENT_RELAY_STAGE_DERIVED', batchKey, batchId, stage: row } };
}

// Stage 10: one train run. Pure; the same inputs always give the same bytes (createdAt is the derivation time).
export function deriveTrainRun({ recordDocs, runId, runKey, mode, now = Date.now() }) {
  check(HEX64.test(runKey ?? '') && BATCH_ID.test(runId ?? '') && runId.startsWith(runKey.slice(0, 16)), 'RESIDENT_TRAIN_RUN_REFUSED');
  const record = validateRecordV2(recordDocs, { now, required: [ENTRY_V2['train-maintenance']] });
  let job;
  try { job = makeTrainRun({ repo: record.config.repository, runId, mode, sourceManifestSha256: record.config.sourceManifestSha256, createdAt: new Date(now).toISOString() }); }
  catch { fail('RESIDENT_TRAIN_RUN_REFUSED'); }
  const { files, row } = stagePackage({ record, s: TRAIN_STAGE_V2, stageJobs: [job], batchKey: runKey, batchId: runId, jobRoles: [TRAIN_RUN_ROLE] });
  return { files, result: { status: 'RESIDENT_TRAIN_RUN_DERIVED', runKey, runId, mode, stage: row } };
}

// Adds the stage-R files to an existing batch directory; the stage directory itself must be new.
export function writeRelayStage(batchDir, files) {
  check(path.isAbsolute(batchDir) && fs.lstatSync(batchDir).isDirectory(), 'RESIDENT_BATCH_DIRECTORY_REQUIRED');
  const dirs = new Set(Object.keys(files).map(rel => rel.split('/')[0]));
  check(dirs.size === 1, 'RESIDENT_RELAY_STAGE_REFUSED');
  const stageDir = path.join(batchDir, [...dirs][0]);
  check(!fs.existsSync(stageDir), 'RESIDENT_RELAY_STAGE_EXISTS_PRESERVE_NO_RETRY');
  fs.mkdirSync(stageDir);
  for (const [rel, t] of Object.entries(files)) fs.writeFileSync(path.join(batchDir, ...rel.split('/')), t, { flag: 'wx' });
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
    check(['--subject-json', '--batch-key', '--batch-id', '--out', '--record', '--relay-roles', '--batch-dir', '--train-run', '--train-key', '--mode'].includes(argv[i]) && typeof argv[i + 1] === 'string' && !Object.hasOwn(args, argv[i]), 'RESIDENT_DERIVATION_ARGUMENTS_REFUSED');
    args[argv[i]] = argv[i + 1];
  }
  if (Object.hasOwn(args, '--train-run')) {
    check(args['--train-key'] && args['--mode'] && args['--out'] && !args['--subject-json'] && !args['--batch-dir'] && !args['--batch-key'] && !args['--batch-id'] && !args['--relay-roles'], 'RESIDENT_DERIVATION_ARGUMENTS_REFUSED');
    const { files, result } = deriveTrainRun({ recordDocs: readRecordDocs(args['--record'] ?? WIN_RECORD), runId: args['--train-run'], runKey: args['--train-key'], mode: args['--mode'], now });
    writeBatch(args['--out'], files);
    output.write(JSON.stringify(result) + '\n');
    return 0;
  }
  if (Object.hasOwn(args, '--relay-roles')) {
    check(args['--batch-dir'] && args['--batch-key'] && args['--batch-id'] && !args['--subject-json'] && !args['--out'] && !args['--train-key'] && !args['--mode'], 'RESIDENT_DERIVATION_ARGUMENTS_REFUSED');
    check(/^[a-z-]{1,40}(,[a-z-]{1,40}){0,3}$/.test(args['--relay-roles']), 'RESIDENT_RELAY_ROLES_REFUSED');
    const batchJson = fs.readFileSync(path.join(args['--batch-dir'], 'batch.json'));
    const { files, result } = deriveRelayStage({ recordDocs: readRecordDocs(args['--record'] ?? WIN_RECORD), batchJson, roles: args['--relay-roles'].split(','),
      batchKey: args['--batch-key'], batchId: args['--batch-id'], now });
    writeRelayStage(args['--batch-dir'], files);
    output.write(JSON.stringify(result) + '\n');
    return 0;
  }
  check(args['--subject-json'] && args['--batch-key'] && args['--batch-id'] && args['--out'] && !args['--batch-dir'] && !args['--train-key'] && !args['--mode'], 'RESIDENT_DERIVATION_ARGUMENTS_REFUSED');
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
