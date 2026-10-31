// One sealed stage package of a derived batch (DESIGN S4). Shared by derive-batch.mjs (writer) and
// invoke-stage.mjs (reader): the reader re-checks every byte against the work manifest whose SHA-256
// the resident passed on its own command line, so nothing in the work directory is trusted by path.
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonical } from '../proof.mjs';
import { hash } from './prepare-record.mjs';
import { HEX64, STAGES_V2, stageJobRolesValid } from './layout.mjs';

export const STAGE_CONTRACT = 'clued.independent-ci.resident-stage/2';
export const WORK_CONTRACT = 'clued.independent-ci.resident-stage-work/2';
export const PLAN_CONTRACT_V2 = 'clued.independent-ci.fixed-formal-windows-entry/3';
export const STAGE_FILES = Object.freeze(['stage.json', 'formal-service-entry.json', 'jobs.json']);
export const PLAN_FIELDS_V2 = Object.freeze(['contract', 'enabled', 'stage', 'entryRole', 'batchKey', 'batchId', 'ownerPackageAcceptanceRef', 'nodeSha256', 'nodeProfileSha256',
  'entrySha256', 'acceptanceSha256', 'sourceManifestSha256', 'installationSha256', 'runtimeConfigPinSha256', 'jobSha256']);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v, keys) => plain(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));

export const stageDirectory = n => `stage-${String(n).padStart(2, '0')}`;

export function validatePlanV2(plan) {
  check(exact(plan, PLAN_FIELDS_V2) && plan.contract === PLAN_CONTRACT_V2 && plan.enabled === true && Number.isSafeInteger(plan.stage), 'EXACT_FORMAL_PLAN_V2_REQUIRED');
  const row = STAGES_V2.find(s => s.number === plan.stage);
  check(row && row.entryRole === plan.entryRole && HEX64.test(plan.batchKey) && /^[0-9a-f]{16}-[0-9a-f]{12}$/.test(plan.batchId)
    && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(plan.ownerPackageAcceptanceRef)
    && ['nodeSha256', 'nodeProfileSha256', 'entrySha256', 'acceptanceSha256', 'sourceManifestSha256', 'installationSha256', 'runtimeConfigPinSha256', 'jobSha256'].every(k => HEX64.test(plan[k])), 'EXACT_FORMAL_PLAN_V2_REQUIRED');
  return row;
}

export function workManifest(files) {
  const m = { contract: WORK_CONTRACT, effectsAuthorized: false, files: Object.fromEntries(STAGE_FILES.map(n => [n, { bytes: Buffer.byteLength(files[n]), sha256: hash(files[n]) }])),
    planSha256: hash(files['formal-service-entry.json']) };
  return canonical(m);
}

async function readBounded(file, max) {
  const st = await fs.lstat(file);
  check(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size > 0 && st.size <= max, 'SEALED_STAGE_FILE_BOUNDARY');
  const h = await fs.open(file, 'r');
  try {
    const b = await h.readFile();
    const after = await h.stat();
    check(after.ino === st.ino && after.size === st.size && b.length === st.size, 'SEALED_STAGE_FILE_CHANGED');
    return b;
  } finally { await h.close(); }
}

// Reads and verifies one stage package. Returns the exact bytes the stage will publish.
export async function readSealedStage(batchDir, number, expectedWorkManifestSha256) {
  check(HEX64.test(expectedWorkManifestSha256 ?? ''), 'EXACT_STAGE_WORK_PIN_REQUIRED');
  const dir = path.join(batchDir, stageDirectory(number));
  const st = await fs.lstat(dir);
  check(st.isDirectory() && !st.isSymbolicLink(), 'SEALED_STAGE_DIRECTORY_REQUIRED');
  const wmBytes = await readBounded(path.join(dir, 'work-manifest.json'), 65536);
  check(hash(wmBytes) === expectedWorkManifestSha256, 'EXACT_REVIEWED_STAGE_MANIFEST_REQUIRED');
  const wm = JSON.parse(wmBytes.toString('utf8'));
  check(exact(wm, ['contract', 'effectsAuthorized', 'files', 'planSha256']) && wm.contract === WORK_CONTRACT && wm.effectsAuthorized === false
    && exact(wm.files, STAGE_FILES), 'EXACT_STAGE_CLOSURE_REQUIRED');
  const files = {};
  for (const name of STAGE_FILES) {
    const b = await readBounded(path.join(dir, name), 2 * 1024 * 1024);
    check(b.length === wm.files[name].bytes && hash(b) === wm.files[name].sha256, 'SEALED_STAGE_SOURCE_CHANGED');
    files[name] = b;
  }
  check(hash(files['formal-service-entry.json']) === wm.planSha256, 'SEALED_STAGE_PLAN_CHANGED');
  const stage = JSON.parse(files['stage.json'].toString('utf8'));
  const plan = JSON.parse(files['formal-service-entry.json'].toString('utf8'));
  const row = validatePlanV2(plan);
  check(stage.contract === STAGE_CONTRACT && stage.number === number && plan.stage === number && stage.entryRole === row.entryRole
    && stageJobRolesValid(row, stage.jobRoles) && stage.batchKey === plan.batchKey && stage.batchId === plan.batchId
    && hash(files['jobs.json']) === plan.jobSha256, 'SEALED_STAGE_BINDING_REQUIRED');
  return Object.freeze({ dir, files, stage, plan, row, planSha256: wm.planSha256 });
}
