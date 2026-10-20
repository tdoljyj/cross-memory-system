import { createHash, verify } from 'node:crypto';
import { validateJob } from './queue.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const SUBJECT = ['id', 'repo', 'pr', 'headSha', 'baseSha', 'claimId', 'fence', 'epoch', 'role', 'sourceManifestSha256', 'attempt'];
const deny = reason => { throw Object.assign(new Error(reason), { code: reason }); };

export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return deny('unsupported_evidence_value');
}

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
export const subjectOf = job => Object.fromEntries(SUBJECT.map(field => [field, job[field]]));

// Signer keys are supplied only by the installed, protected trust policy. The
// transport must never accept a registry, key, qualification or domain from a PR.
// Native currentness/revocation is checked again by the publication authority.
export function verifyResult({ job, envelope, signers, now = Date.now(), domain = 'production', maxAgeMs = 600_000 }) {
  validateJob(job);
  if (!['production', 'fixture'].includes(domain) || !Number.isSafeInteger(now)
    || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1) deny('invalid_verifier_configuration');
  if (!envelope || envelope.contract !== 'independent-ci.signed-result.v1'
    || typeof envelope.keyId !== 'string' || typeof envelope.signature !== 'string'
    || !/^[A-Za-z0-9_-]+$/.test(envelope.signature)) deny('invalid_evidence_envelope');
  const signer = signers?.get(envelope.keyId);
  if (!signer || signer.domain !== domain || !signer.publicKeyPem || !signer.runtimeId
    || !signer.qualificationRef || !signer.sourceAcceptanceRef) deny('untrusted_result_signer');
  const payload = envelope.payload;
  if (!payload || payload.contract !== 'independent-ci.execution-result.v1'
    || payload.domain !== domain || payload.runtimeId !== signer.runtimeId
    || !SUBJECT.every(field => payload.subject?.[field] === job[field])) deny('result_subject_mismatch');
  const bytes = Buffer.from(canonical(payload));
  if (bytes.length > 256 * 1024) deny('result_too_large');
  const signature = Buffer.from(envelope.signature, 'base64url');
  if (signature.length !== 64 || !verify(null, bytes, signer.publicKeyPem, signature)) deny('result_signature_invalid');
  const start = Date.parse(payload.startedAt), finish = Date.parse(payload.finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish) || start > finish || finish > now
    || now - finish > maxAgeMs || start < Date.parse(job.createdAt)) deny('stale_or_invalid_result_time');
  if (!['success', 'failure'].includes(payload.conclusion) || !Number.isInteger(payload.exitCode)
    || (payload.conclusion === 'success') !== (payload.exitCode === 0)
    || !SHA256.test(payload.stdoutSha256 ?? '') || !SHA256.test(payload.stderrSha256 ?? '')
    || !SHA256.test(payload.artifactsSha256 ?? '')) deny('invalid_execution_outcome');
  return Object.freeze({ payload: structuredClone(payload), evidenceSha256: digest(envelope),
    signer: { keyId: envelope.keyId, runtimeId: signer.runtimeId,
      qualificationRef: signer.qualificationRef, sourceAcceptanceRef: signer.sourceAcceptanceRef },
    domain, productionAuthorized: domain === 'production' });
}
