// Public, fixed-input job for a short protected read-only observer. These pure
// validators establish shape and binding only, never provenance or live authority.
// Production must obtain the record through the held installed Source and read
// the named stage-1/prior outcomes from the protected receipt directory itself.
import { createHash } from 'node:crypto';

export const RELAY_QUALIFICATION_RUN_CONTRACT = 'clued.independent-ci.relay-qualification-run/1';
export const RELAY_QUALIFICATION_OBSERVATION_CONTRACT = 'clued.independent-ci.relay-qualification-observation/1';
export const RELAY_QUALIFICATION_WINDOW_CONTRACT = 'clued.independent-ci.relay-qualification-window/1';
export const RELAY_QUALIFICATION_AUTHORITY_ID = 'c32676f4-4528-408c-b5e6-88cb27fca13a';
export const RELAY_QUALIFICATION_PHASES = Object.freeze(['initial', 'after-ref-move']);
export const RELAY_QUALIFICATION_SUBJECT_FIELDS = Object.freeze([
  'repo', 'runId', 'pr', 'headSha', 'baseSha', 'testSha', 'sourceManifestSha256',
  'nodeProfileSha256', 'claimId', 'fence', 'executionEpoch', 'stage1JobId',
  'stage1OutcomeNonce', 'stage1OutcomeSha256',
]);
// The installed window must exist before Stage 1 runs. Its outcome nonce/hash
// are post-execution locators, not pre-install authority fields. They remain
// mandatory in the full run identity and are proved from protected receipts.
export const RELAY_QUALIFICATION_WINDOW_SUBJECT_FIELDS = Object.freeze(
  RELAY_QUALIFICATION_SUBJECT_FIELDS.filter(k => !['stage1OutcomeNonce', 'stage1OutcomeSha256'].includes(k)));
export const RELAY_QUALIFICATION_RUN_FIELDS = Object.freeze([
  'contract', 'id', ...RELAY_QUALIFICATION_SUBJECT_FIELDS, 'phase',
  'priorObservationNonce', 'priorObservationSha256', 'createdAt',
]);
const SHA1 = /^[a-f0-9]{40}$/, SHA256 = /^[a-f0-9]{64}$/, NONCE = /^[a-f0-9]{32}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const RUN = /^[a-f0-9]{16}-[a-f0-9]{12}$/, DIGITS = /^[1-9][0-9]{0,19}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonicalObjectDigest = value => createHash('sha256').update(`{${Object.keys(value).sort()
  .map(k => `${JSON.stringify(k)}:${JSON.stringify(value[k])}`).join(',')}}`).digest('hex');
const iso = value => typeof value === 'string' && ISO.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
const integer = (v, lo = 1, hi = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= lo && v <= hi;
const hex = (pattern, value) => typeof value === 'string' && pattern.test(value);

// Do not invoke getters, toJSON, coercions or iterators supplied by a caller.
function fields(value, names, code) {
  check(value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype, code);
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  check(keys.length === names.length && names.every(k => Object.hasOwn(descriptors, k)
    && Object.hasOwn(descriptors[k], 'value') && descriptors[k].enumerable === true), code);
  return Object.fromEntries(names.map(k => [k, descriptors[k].value]));
}
function array(value, maximum, code) {
  check(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype, code);
  const descriptors = Object.getOwnPropertyDescriptors(value), length = descriptors.length?.value;
  check(integer(length, 0, maximum) && Reflect.ownKeys(descriptors).length === length + 1, code);
  const out = [];
  for (let i = 0; i < length; i++) {
    const d = descriptors[String(i)];
    check(d && Object.hasOwn(d, 'value') && d.enumerable === true, code); out.push(d.value);
  }
  return out;
}
function dataProperty(value, name, code) {
  check(value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype, code);
  const d = Object.getOwnPropertyDescriptor(value, name);
  check(d && Object.hasOwn(d, 'value'), code); return d.value;
}
function subjectValues(s, code) {
  check(s.repo === 'tdoljyj/cross-memory-system' && hex(RUN, s.runId) && integer(s.pr)
    && ['headSha', 'baseSha', 'testSha'].every(k => hex(SHA1, s[k])) && s.testSha === s.headSha
    && ['sourceManifestSha256', 'nodeProfileSha256', 'stage1JobId'].every(k => hex(SHA256, s[k]))
    && hex(UUID, s.claimId) && integer(s.fence) && integer(s.executionEpoch), code);
}
function subject(value, code) {
  const s = fields(value, RELAY_QUALIFICATION_SUBJECT_FIELDS, code);
  subjectValues(s, code);
  check(hex(SHA256, s.stage1OutcomeSha256) && hex(NONCE, s.stage1OutcomeNonce), code);
  return Object.freeze(s);
}
function windowSubject(value, code) {
  const s = fields(value, RELAY_QUALIFICATION_WINDOW_SUBJECT_FIELDS, code);
  subjectValues(s, code);
  return Object.freeze(s);
}
function subjectOfRun(v) { return Object.fromEntries(RELAY_QUALIFICATION_SUBJECT_FIELDS.map(k => [k, v[k]])); }
function identity(v) { return [RELAY_QUALIFICATION_RUN_CONTRACT,
  ...RELAY_QUALIFICATION_SUBJECT_FIELDS.map(k => v[k]), v.phase, v.priorObservationNonce, v.priorObservationSha256]; }

export function relayQualificationRunId(value) {
  // Called on a validator-produced snapshot or on the exact public maker input.
  const v = fields(value, RELAY_QUALIFICATION_RUN_FIELDS, 'RELAY_QUALIFICATION_RUN_REFUSED');
  subject(subjectOfRun(v), 'RELAY_QUALIFICATION_RUN_REFUSED');
  check(RELAY_QUALIFICATION_PHASES.includes(v.phase)
    && (v.phase === 'initial' ? v.priorObservationNonce === null && v.priorObservationSha256 === null
      : hex(NONCE, v.priorObservationNonce) && hex(SHA256, v.priorObservationSha256)), 'RELAY_QUALIFICATION_RUN_REFUSED');
  return digest(identity(v));
}
export function validateRelayQualificationRun(value) {
  const code = 'RELAY_QUALIFICATION_RUN_REFUSED', v = fields(value, RELAY_QUALIFICATION_RUN_FIELDS, code);
  subject(subjectOfRun(v), code);
  check(v.contract === RELAY_QUALIFICATION_RUN_CONTRACT && hex(SHA256, v.id) && iso(v.createdAt)
    && RELAY_QUALIFICATION_PHASES.includes(v.phase)
    && (v.phase === 'initial' ? v.priorObservationNonce === null && v.priorObservationSha256 === null
      : hex(NONCE, v.priorObservationNonce) && hex(SHA256, v.priorObservationSha256)
        && v.priorObservationNonce !== v.stage1OutcomeNonce)
    && v.id === digest(identity(v)), code);
  return Object.freeze(v);
}
export function makeRelayQualificationRun(value) {
  const inputNames = RELAY_QUALIFICATION_RUN_FIELDS.filter(k => !['contract', 'id'].includes(k));
  const input = fields(value, inputNames, 'RELAY_QUALIFICATION_RUN_REFUSED');
  const v = { contract: RELAY_QUALIFICATION_RUN_CONTRACT, id: null, ...input };
  v.id = relayQualificationRunId(v); return validateRelayQualificationRun(v);
}
export function relayQualificationSubjectSha256(job) {
  const v = validateRelayQualificationRun(job); return digest(RELAY_QUALIFICATION_SUBJECT_FIELDS.map(k => v[k]));
}

export const RELAY_QUALIFICATION_ROLE_OBSERVATION_FIELDS = Object.freeze([
  'role', 'verdict', 'checkRunId', 'workflowRunId', 'runAttempt', 'annotationsComplete',
  'identityAnnotationCount', 'totalAnnotationCount', 'fullAnnotationsSha256',
  'tokenPresent', 'tokenSha256', 'signatureVerified', 'verifiedClaims',
  'claimsSha256', 'checkRunIdClaimPresent', 'registryBindsCheckRunId',
  'keyThumbprintSha256', 'attestationSha256',
]);
export const RELAY_QUALIFICATION_CLAIM_FIELDS = Object.freeze([
  'iss', 'aud', 'repository', 'repository_id', 'repository_owner', 'repository_owner_id',
  'event_name', 'sub', 'ref', 'base_ref', 'head_ref', 'job_workflow_ref', 'workflow_ref',
  'runner_environment', 'run_id', 'run_attempt', 'sha', 'workflow_sha', 'job_workflow_sha',
  'iat', 'check_run_id',
]);
function claims(value, code) {
  check(value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype, code);
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  check(keys.length > 0 && keys.length <= RELAY_QUALIFICATION_CLAIM_FIELDS.length
    && keys.every(k => typeof k === 'string' && RELAY_QUALIFICATION_CLAIM_FIELDS.includes(k)), code);
  const out = {};
  for (const k of keys) {
    const d = descriptors[k]; check(Object.hasOwn(d, 'value') && d.enumerable === true, code);
    const v = d.value;
    check(k === 'iat' ? integer(v) : k === 'check_run_id' && typeof v === 'number' ? integer(v)
      : typeof v === 'string' && v.length > 0 && v.length <= 512
        && !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v), code);
    out[k] = v;
  }
  return Object.freeze(out);
}
export const RELAY_QUALIFICATION_OBSERVATION_FIELDS = Object.freeze([
  'contract', 'jobId', 'phase', 'subjectSha256', 'observedAt', 'liveQualified',
  'roles', 'refObservation', 'jwksObservation',
]);
export function validateRelayQualificationObservation(value, job) {
  const code = 'RELAY_QUALIFICATION_OBSERVATION_REFUSED', j = validateRelayQualificationRun(job);
  const o = fields(value, RELAY_QUALIFICATION_OBSERVATION_FIELDS, code);
  check(o.contract === RELAY_QUALIFICATION_OBSERVATION_CONTRACT && o.jobId === j.id && o.phase === j.phase
    && o.subjectSha256 === relayQualificationSubjectSha256(j) && iso(o.observedAt) && o.liveQualified === false, code);
  const roles = array(o.roles, 2, code);
  check(roles.length === 2, code);
  o.roles = Object.freeze(roles.map((row, i) => {
    const r = fields(row, RELAY_QUALIFICATION_ROLE_OBSERVATION_FIELDS, code);
    check(r.role === ['gitleaks', 'trivy'][i] && ['ATTESTED_SUCCESS', 'PENDING', 'REJECTED'].includes(r.verdict)
      && (r.checkRunId === null || integer(r.checkRunId))
      && (r.workflowRunId === null || hex(DIGITS, r.workflowRunId))
      && (r.runAttempt === null || hex(/^[1-9][0-9]{0,3}$/, r.runAttempt))
      && ['annotationsComplete', 'tokenPresent', 'signatureVerified', 'checkRunIdClaimPresent', 'registryBindsCheckRunId'].every(k => typeof r[k] === 'boolean')
      && integer(r.identityAnnotationCount, 0, 100) && integer(r.totalAnnotationCount, 0, 10000)
      && r.identityAnnotationCount <= r.totalAnnotationCount
      && ['fullAnnotationsSha256', 'keyThumbprintSha256', 'attestationSha256'].every(k => r[k] === null || hex(SHA256, r[k]))
      && r.annotationsComplete === (r.fullAnnotationsSha256 !== null)
      && (r.tokenSha256 === null || hex(SHA256, r.tokenSha256))
      && (r.claimsSha256 === null || hex(SHA256, r.claimsSha256))
      && r.tokenPresent === (r.tokenSha256 !== null)
      && (!r.tokenPresent ? r.signatureVerified === false && r.claimsSha256 === null && r.checkRunIdClaimPresent === false : r.identityAnnotationCount > 0)
      && (!r.signatureVerified ? r.verifiedClaims === null && r.claimsSha256 === null && r.keyThumbprintSha256 === null && r.checkRunIdClaimPresent === false
        : r.tokenPresent && r.claimsSha256 !== null && r.keyThumbprintSha256 !== null)
      && (r.verdict !== 'ATTESTED_SUCCESS' || r.checkRunId !== null && r.workflowRunId !== null && r.runAttempt !== null
        && r.annotationsComplete && r.identityAnnotationCount === 1 && r.signatureVerified && r.attestationSha256 !== null), code);
    if (r.signatureVerified) {
      r.verifiedClaims = claims(r.verifiedClaims, code);
      check(r.claimsSha256 === canonicalObjectDigest(r.verifiedClaims)
        && r.checkRunIdClaimPresent === Object.hasOwn(r.verifiedClaims, 'check_run_id'), code);
    }
    return Object.freeze(r);
  }));
  const ref = fields(o.refObservation, ['ref', 'beforeMergeSha', 'afterMergeSha', 'oldMergeReadable'], code);
  check(ref.ref === `refs/pull/${j.pr}/merge` && [ref.beforeMergeSha, ref.afterMergeSha].every(v => v === null || hex(SHA1, v))
    && typeof ref.oldMergeReadable === 'boolean' && (!ref.oldMergeReadable || ref.beforeMergeSha !== null), code);
  const jwks = fields(o.jwksObservation, ['networkFetched', 'sha256'], code);
  check(typeof jwks.networkFetched === 'boolean' && jwks.networkFetched === (jwks.sha256 !== null)
    && (jwks.sha256 === null || hex(SHA256, jwks.sha256)), code);
  o.refObservation = Object.freeze(ref); o.jwksObservation = Object.freeze(jwks);
  // No raw claims/token, arbitrary diagnostics or unbounded source text can fit
  // this closed envelope. It is observation, never an Owner acceptance.
  check(Buffer.byteLength(JSON.stringify(o)) <= 16384, code);
  return Object.freeze(o);
}

export const RELAY_QUALIFICATION_WINDOW_FIELDS = Object.freeze([
  'contract', 'qualificationRef', 'sourceManifestSha256', 'ownerReceiptRef',
  'authorityDecisionId', 'authorityDecisionSha256', 'authorityReadReceiptRef',
  'subject', 'validUntil', 'allowedPhases', 'executionPolicy', 'guarded',
  'changedPaths', 'changedPathsSha256',
]);
// Like the existing revocation capability validator, this validates the block
// only in a previously validated, held installed record. A caller-supplied
// record/object, UUID or digest cannot prove that authority was actually read.
export function relayQualificationWindow(record, { job = null, now = Date.now(), reserveMs = 0 } = {}) {
  try {
    const code = 'RELAY_QUALIFICATION_WINDOW_REFUSED';
    const accepted = dataProperty(record, 'accepted', code);
    const config = dataProperty(record, 'config', code);
    const q = fields(dataProperty(accepted, 'relayQualificationWindow', code),
      RELAY_QUALIFICATION_WINDOW_FIELDS, code);
    const s = windowSubject(q.subject, code), phases = array(q.allowedPhases, 2, code);
    const changedPaths = array(q.changedPaths, 2000, code);
    check(changedPaths.length > 0 && changedPaths.every((p, i) => typeof p === 'string' && p.length > 0 && p.length <= 512
      && !/[\\\x00-\x1f\x7f:]/.test(p) && !p.startsWith('/')
      && p.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
      && (i === 0 || changedPaths[i - 1] < p))
      && hex(SHA256, q.changedPathsSha256) && q.changedPathsSha256 === digest(changedPaths), code);
    check(q.contract === RELAY_QUALIFICATION_WINDOW_CONTRACT
      && hex(/^receipt:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/, q.qualificationRef)
      && hex(SHA256, q.sourceManifestSha256) && q.sourceManifestSha256 === dataProperty(config, 'sourceManifestSha256', code)
      && q.sourceManifestSha256 === s.sourceManifestSha256
      && hex(UUID, q.ownerReceiptRef) && q.ownerReceiptRef === dataProperty(accepted, 'ownerReceiptRef', code)
      && q.authorityDecisionId === RELAY_QUALIFICATION_AUTHORITY_ID && hex(SHA256, q.authorityDecisionSha256)
      && hex(UUID, q.authorityReadReceiptRef) && integer(now) && integer(reserveMs, 0, 86_400_000)
      && ['staged', 'active'].includes(q.executionPolicy) && typeof q.guarded === 'boolean'
      && iso(q.validUntil) && Date.parse(q.validUntil) > now + reserveMs
      && phases.length > 0 && phases.every((v, i) => typeof v === 'string' && RELAY_QUALIFICATION_PHASES.includes(v)
        && (i === 0 || RELAY_QUALIFICATION_PHASES.indexOf(phases[i - 1]) < RELAY_QUALIFICATION_PHASES.indexOf(v))), code);
    if (job !== null) {
      const j = validateRelayQualificationRun(job);
      check(phases.includes(j.phase) && RELAY_QUALIFICATION_WINDOW_SUBJECT_FIELDS.every(k => s[k] === j[k]), code);
    }
    return Object.freeze({ ...q, subject: s, allowedPhases: Object.freeze(phases), changedPaths: Object.freeze(changedPaths) });
  } catch { return null; }
}
