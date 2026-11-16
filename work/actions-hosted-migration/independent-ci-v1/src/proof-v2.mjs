// Signed execution result verification for job contract v2 (DESIGN S6). Same rules as
// proof.mjs#verifyResult (installed signer registry only, Ed25519, 10-minute freshness, outcome
// shape), but the subject is the claim-free v2 subject and must match EXACTLY (no extra fields), and
// the payload contract is v2, so a v1 result can never satisfy a v2 job or the other way round.
import { verify } from 'node:crypto';
import { canonical, digest } from './proof.mjs';
import { SUBJECT_V2, subjectOfV2, validateJobV2 } from './job-v2.mjs';
import { validateGitleaksReport } from './gitleaks-report.mjs';

export const RESULT_CONTRACT_V2 = 'independent-ci.execution-result.v2';
export const ENVELOPE_CONTRACT_V2 = 'independent-ci.signed-result.v2';
const SHA256 = /^[a-f0-9]{64}$/;
const deny = reason => { throw Object.assign(new Error(reason), { code: reason }); };
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

export function verifyResultV2({ job, envelope, signers, now = Date.now(), domain = 'production', maxAgeMs = 600_000 }) {
  validateJobV2(job);
  if (!['production', 'fixture'].includes(domain) || !Number.isSafeInteger(now) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1) deny('invalid_verifier_configuration');
  if (!plain(envelope) || envelope.contract !== ENVELOPE_CONTRACT_V2 || typeof envelope.keyId !== 'string'
    || typeof envelope.signature !== 'string' || !/^[A-Za-z0-9_-]+$/.test(envelope.signature)) deny('invalid_evidence_envelope');
  const signer = signers?.get(envelope.keyId);
  if (!signer || signer.domain !== domain || !signer.publicKeyPem || !signer.runtimeId || !signer.qualificationRef || !signer.sourceAcceptanceRef) deny('untrusted_result_signer');
  const payload = envelope.payload;
  const subject = payload?.subject;
  if (!plain(payload) || payload.contract !== RESULT_CONTRACT_V2 || payload.domain !== domain || payload.runtimeId !== signer.runtimeId
    || !plain(subject) || Object.keys(subject).length !== SUBJECT_V2.length || canonical(subject) !== canonical(subjectOfV2(job))) deny('result_subject_mismatch');
  const bytes = Buffer.from(canonical(payload));
  if (bytes.length > 256 * 1024) deny('result_too_large');
  const signature = Buffer.from(envelope.signature, 'base64url');
  if (signature.length !== 64 || !verify(null, bytes, signer.publicKeyPem, signature)) deny('result_signature_invalid');
  const start = Date.parse(payload.startedAt), finish = Date.parse(payload.finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish) || start > finish || finish > now || now - finish > maxAgeMs
    || start < Date.parse(job.createdAt)) deny('stale_or_invalid_result_time');
  if (!['success', 'failure'].includes(payload.conclusion) || !Number.isInteger(payload.exitCode)
    || (payload.conclusion === 'success') !== (payload.exitCode === 0)
    || !SHA256.test(payload.stdoutSha256 ?? '') || !SHA256.test(payload.stderrSha256 ?? '') || !SHA256.test(payload.artifactsSha256 ?? '')) deny('invalid_execution_outcome');
  if (Object.hasOwn(payload, 'gitleaksReport')) {
    if (job.role !== 'gitleaks') deny('invalid_execution_outcome');
    validateGitleaksReport(payload.gitleaksReport, job);
    if (payload.exitCode !== (payload.gitleaksReport.pr.count ? 1 : 0)) deny('invalid_execution_outcome');
  }
  return Object.freeze({ payload: structuredClone(payload), evidenceSha256: digest(envelope),
    signer: { keyId: envelope.keyId, runtimeId: signer.runtimeId, qualificationRef: signer.qualificationRef, sourceAcceptanceRef: signer.sourceAcceptanceRef },
    domain, productionAuthorized: domain === 'production' });
}

export { canonical, digest, subjectOfV2 };
