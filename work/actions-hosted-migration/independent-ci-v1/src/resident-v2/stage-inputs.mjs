// Stage inputs of the four Source v2 node entries (run by the generic helper as clued-control):
//   node <entry> --run --stage <nonce> --config-sha256 <sha>
// The generic helper (FormalPublicBoundaryV2.cs) already verified the same files by handle; the entry
// re-verifies them in its own process before using any byte (defence in depth, same as v1 where both
// the launcher and the entry checked the installed files). It also writes the entry's outcome record,
// the one channel through which a stage's ending reaches the resident (S11).
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonical } from '../proof.mjs';
import { validateJobV2, sameBatchV2, CONTROL_ROLES_V2 } from '../job-v2.mjs';
import { validateTrainRun } from './train-run.mjs';
import { validateRoleProbeRun } from './role-probe-run.mjs';
import { validateRevocationRun, validateRevocationFacts } from './revocation-run.mjs';
import { validateTrainFacts } from '../independent-control-checks-v2/train-facts.mjs';
import { hash } from './prepare-record.mjs';
import { sanitizeAdmissionDiagnosticV2, sanitizeSchedulingV2 } from '../admission-facts-v2.mjs';
import { validateRecordV2 } from './record.mjs';
import { validatePlanV2 } from './stage-package.mjs';
import { NONCE32, HEX64, OUTCOME_CONTRACT, STATE_V2, WIN_STAGE, stageJobRolesValid } from './layout.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

export function parseEntryArgs(argv) {
  check(Array.isArray(argv) && argv.length === 5 && argv[0] === '--run' && argv[1] === '--stage' && NONCE32.test(argv[2] ?? '')
    && argv[3] === '--config-sha256' && HEX64.test(argv[4] ?? ''), 'FIXED_V2_ENTRY_ARGUMENTS_REQUIRED');
  return Object.freeze({ nonce: argv[2], configSha256: argv[4] });
}

async function readStageFile(dir, name, max) {
  const file = path.join(dir, name);
  const st = await fs.lstat(file);
  check(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size > 0 && st.size <= max, 'STAGE_INPUT_BOUNDARY');
  const h = await fs.open(file, 'r');
  try { const b = await h.readFile(); check(b.length === st.size && (await h.stat()).ino === st.ino, 'STAGE_INPUT_CHANGED'); return b; }
  finally { await h.close(); }
}

// entryRole: the role the calling entry implements. recordDocs: held record bytes (held-source v4).
const trainFactsOrNull = f => { try { return validateTrainFacts(f); } catch { return null; } };

export async function loadStageInputs({ nonce, configSha256, entryRole, recordDocs, stageRoot = WIN_STAGE, now = Date.now(), identity = null }) {
  const dir = path.join(stageRoot, nonce);
  const st = await fs.lstat(dir);
  check(st.isDirectory() && !st.isSymbolicLink(), 'STAGE_INPUT_DIRECTORY_REQUIRED');
  const planBytes = await readStageFile(dir, 'formal-service-entry.json', 65536);
  check(hash(planBytes) === configSha256, 'EXACT_STAGE_PLAN_REQUIRED');
  const plan = JSON.parse(planBytes.toString('utf8'));
  const row = validatePlanV2(plan);
  check(plan.entryRole === entryRole, 'FIXED_FORMAL_ENTRY_ROLE_REQUIRED');
  const record = validateRecordV2(recordDocs, { now, identity });
  check(plan.acceptanceSha256 === record.hashes.acceptanceSha256 && plan.sourceManifestSha256 === record.hashes.sourceManifestSha256
    && plan.installationSha256 === record.hashes.installationSha256 && plan.runtimeConfigPinSha256 === record.hashes.runtimeConfigPinSha256
    && plan.nodeSha256 === record.config.controllerNodeSha256 && plan.nodeProfileSha256 === hash(record.accepted.node), 'INSTALLED_RECORD_BINDING_CHANGED');
  const jobsBytes = await readStageFile(dir, 'jobs.json', 65536);
  check(hash(jobsBytes) === plan.jobSha256, 'EXACT_SELECTED_JOB_PLAN_PIN_REQUIRED');
  const jobs = JSON.parse(jobsBytes.toString('utf8'));
  check(Array.isArray(jobs) && jobs.length > 0 && jobs.length === row.jobRoles.length && jobsBytes.toString('utf8') === canonical(jobs), 'EXACT_STAGE_JOBS_REQUIRED');
  if (row.kind === 'train') {
    // Stage 10: exactly one train run of this installation (train-run.mjs), for the train-maintenance entry only.
    check(entryRole === 'train-maintenance' && jobs.length === 1, 'EXACT_STAGE_JOBS_REQUIRED');
    try { validateTrainRun(jobs[0]); } catch { fail('EXACT_STAGE_JOBS_REQUIRED'); }
    check(jobs[0].repo === record.config.repository && jobs[0].sourceManifestSha256 === record.config.sourceManifestSha256 && jobs[0].runId === plan.batchId, 'EXACT_STAGE_JOBS_REQUIRED');
    return Object.freeze({ nonce, dir, plan, row, jobs, resultEnvelope: null, record });
  }
  if (row.kind === 'role-probe') {
    check(entryRole === 'role-probe' && jobs.length === 1, 'EXACT_STAGE_JOBS_REQUIRED');
    try { validateRoleProbeRun(jobs[0]); } catch { fail('EXACT_STAGE_JOBS_REQUIRED'); }
    check(jobs[0].repo === record.config.repository && jobs[0].sourceManifestSha256 === record.config.sourceManifestSha256
      && jobs[0].nodeProfileSha256 === plan.nodeProfileSha256 && jobs[0].runId === plan.batchId, 'EXACT_STAGE_JOBS_REQUIRED');
    return Object.freeze({ nonce, dir, plan, row, jobs, resultEnvelope: null, record });
  }
  if (row.kind === 'revocation-maintenance') {
    check(entryRole === 'revocation-maintenance' && jobs.length === 1, 'EXACT_STAGE_JOBS_REQUIRED');
    try { validateRevocationRun(jobs[0]); } catch { fail('EXACT_STAGE_JOBS_REQUIRED'); }
    check(jobs[0].repo === record.config.repository && jobs[0].sourceManifestSha256 === record.config.sourceManifestSha256
      && jobs[0].nodeProfileSha256 === plan.nodeProfileSha256 && jobs[0].runId === plan.batchId, 'EXACT_STAGE_JOBS_REQUIRED');
    return Object.freeze({ nonce, dir, plan, row, jobs, resultEnvelope: null, record });
  }
  jobs.forEach(validateJobV2);
  check(stageJobRolesValid(row, jobs.map(j => j.role)) && jobs.every(j => j.repo === record.config.repository && j.sourceManifestSha256 === record.config.sourceManifestSha256 && sameBatchV2(j, jobs[0]))
    && (entryRole !== 'control-checks' || jobs.map(j => j.role).join('|') === CONTROL_ROLES_V2.join('|')), 'EXACT_STAGE_JOBS_REQUIRED');
  let resultEnvelope = null;
  if (entryRole === 'check-publisher') {
    const raw = await readStageFile(dir, 'result.json', 1024 * 1024);
    resultEnvelope = JSON.parse(raw.toString('utf8'));
    check(plain(resultEnvelope) && canonical(resultEnvelope) === raw.toString('utf8'), 'STAGE_INPUT_RESULT_REQUIRED');
  }
  return Object.freeze({ nonce, dir, plan, row, jobs, resultEnvelope, record });
}

// Create-only, fsynced. Written in the entry's finally block, so every ending that reaches it is
// recorded; an ending that does not (a crash, a kill) is "outcome missing" = UNKNOWN for the resident.
export async function writeOutcome({ receiptsRoot = STATE_V2.receipts, nonce, plan, jobIds, result, clock = Date.now }) {
  check(NONCE32.test(nonce ?? ''), 'OUTCOME_NONCE_INVALID');
  const r = plain(result) ? result : {};
  const sideEffects = Number.isSafeInteger(r.sideEffects) && r.sideEffects >= 0 ? r.sideEffects : 1;
  const status = typeof r.status === 'string' && /^[A-Z][A-Z_]{1,60}$/.test(r.status) ? r.status : 'UNCERTAIN';
  const outcome = { contract: OUTCOME_CONTRACT, nonce, stage: plan?.stage ?? null, entryRole: plan?.entryRole ?? null, jobIds: Array.isArray(jobIds) ? jobIds : [],
    status, reason: typeof r.reason === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(r.reason) ? r.reason : null, sideEffects,
    // Anything but a clean BLOCKED with zero side effects may have published. Stage 10 facts with zero side effects
    // (shadow mode writes nothing to GitHub or KooYomi) are the other clean ending; in on and revoke-only mode (DESIGN §41.3,
    // §41.4) facts /2 with side effects are a normal ending that may have published (stage-fact.mjs accepts exactly
    // mayHavePublished === sideEffects > 0 there, and shadow only with zero).
    mayHavePublished: !((status === 'BLOCKED' || (plan?.entryRole === 'train-maintenance' && status === 'TRAIN_FACTS')) && sideEffects === 0), diagnostic: sanitizeAdmissionDiagnosticV2(r.admissionDiagnostic),
    // Resident quota redesign v0.6 §9 phase 1: the entry's own "safe to re-run" flag (only ever on a clean BLOCKED with
    // zero side effects) and the scheduling facts Native reported (ci_retry_after, merge-queue entry). The resident
    // releases a stage only on this flag, never by inferring it from a reason code.
    safeToRerun: status === 'BLOCKED' && sideEffects === 0 && r.safeToRerun === true, scheduling: sanitizeSchedulingV2(r.scheduling),
    // Generation 28 (resident docs/adr/0015): a scanner publisher's own "the withdrawal was for unavailability only, a republication may
    // follow" (staged-check-publisher-v2.mjs#revoke), only ever on a REVOKED ending of a check publisher. The resident runs the stage again on
    // this flag alone, within its bounded publication retry; it never infers it from a reason code.
    ...(status === 'REVOKED' && plan?.entryRole === 'check-publisher' && r.republishSafe === true ? { republishSafe: true } : {}),
    // Stage 10 only: the train facts (train-facts.mjs); facts that do not validate are written as null, and the stage fact
    // is then no success (stage-fact.mjs: STAGE_OUTCOME_MISSING).
    train: plan?.entryRole === 'train-maintenance' ? trainFactsOrNull(r.train) : null,
    ...(plan?.entryRole === 'revocation-maintenance' ? { revocation: (() => { try { return validateRevocationFacts(r.revocation); } catch { return null; } })() } : {}),
    at: new Date(clock()).toISOString() };
  await fs.mkdir(receiptsRoot, { recursive: true });
  const h = await fs.open(path.join(receiptsRoot, `outcome-${nonce}.json`), 'wx', 0o600);
  try { await h.writeFile(canonical(outcome) + '\n'); await h.sync(); } finally { await h.close(); }
  return outcome;
}
