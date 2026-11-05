// Public control-check metadata, not an execution grant or credential.
import { admittedFactsMatchJobV2, ADMISSION_FIELDS_V2, ADMISSION_FIELDS_V3, FULL_ADMISSION_CONTRACT_V2, FULL_ADMISSION_CONTRACT_V3 } from '../admission-facts-v2.mjs';
export const SCAN_START_SUBJECT_MARKER = 'clued-scan-start-subject/1 ';
export function scanStartSubjectLine(job, facts, registrySha256, now = Date.now()) {
  // First Stage1 admission intentionally has batchClaimBound=null. Only the
  // subsequent scanner boundary requires a pre-existing sticky generation;
  // never forge a replacement facts object to make that scanner check pass.
  const names = facts?.contract === FULL_ADMISSION_CONTRACT_V2 ? ADMISSION_FIELDS_V2
    : facts?.contract === FULL_ADMISSION_CONTRACT_V3 ? ADMISSION_FIELDS_V3 : null;
  if (!names || !facts || Object.getPrototypeOf(facts) !== Object.prototype || facts.domain !== 'production'
    || Object.keys(facts).length !== names.length || !names.every(k => Object.hasOwn(facts, k))
    || !admittedFactsMatchJobV2(facts, job, now)) throw Object.assign(new Error('SCAN_START_SUBJECT_ADMISSION_REQUIRED'), { code: 'SCAN_START_SUBJECT_ADMISSION_REQUIRED' });
  if (!/^[a-f0-9]{64}$/.test(registrySha256)) throw Object.assign(new Error('SCAN_START_SUBJECT_PIN_REQUIRED'), { code: 'SCAN_START_SUBJECT_PIN_REQUIRED' });
  return SCAN_START_SUBJECT_MARKER + JSON.stringify({ claim_id: facts.claimId, fence: facts.fence, epoch: facts.epoch,
    source_manifest_sha256: job.sourceManifestSha256, registry_sha256: registrySha256 });
}
