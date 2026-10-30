// Native617 independent-provider identity. Pure data, never an execution grant.
// Kept separate from GitHub Actions run_id: a local job has no Actions run.
import { createHash } from 'node:crypto';

export const COMPONENT_VERSION = '1.0.0';
export const IDENTITY_SCHEMA = 'clued.independent-ci.publication-identity/1';
export const APP_ID = 5368905;
export const CHECKS = Object.freeze({
  'work-admission': 'kooyumi-work-admission',
  gitleaks: 'gitleaks',
  trivy: 'trivy',
  'contract-placement': 'contract-placement',
  'control-admission': 'kooyumi-admission-verified',
  'control-merge-slot': 'kooyumi-merge-slot',
});
const JOB_CONTRACT = 'clued.independent-ci.job/3';
const JOB_KEYS = ['contract', 'id', 'repo', 'pr', 'headSha', 'baseSha', 'testSha', 'role', 'sourceManifestSha256', 'createdAt', 'attempt'];
const JOB_ID_FIELDS = ['repo', 'pr', 'headSha', 'baseSha', 'testSha', 'sourceManifestSha256', 'role', 'attempt'];
const CLAIM_KEYS = ['claim_id', 'fence', 'execution_epoch'];
const IDENTITY_KEYS = ['schema', 'provider', 'job', 'claim', 'app_id', 'check_name', 'controller_id', 'effect_key', 'publication_key'];
const TARGET_KEYS = ['repository', 'pr_ref', 'head_sha', 'base_sha', 'claim_id', 'fence', 'execution_epoch'];
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const positive = n => Number.isSafeInteger(n) && n > 0;
const pattern = (value, regex) => typeof value === 'string' && regex.test(value);
function exact(value, fields) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length === fields.length && fields.every(key =>
    Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable);
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
function claimValid(claim) {
  return exact(claim, CLAIM_KEYS) && pattern(claim.claim_id, UUID) && positive(claim.fence) && positive(claim.execution_epoch);
}
function jobValid(job) {
  if (!exact(job, JOB_KEYS) || job.contract !== JOB_CONTRACT || job.repo !== 'tdoljyj/cross-memory-system'
    || !positive(job.pr) || job.pr > 9_999_999_999 || !pattern(job.id, HASH)
    || !['headSha', 'baseSha', 'testSha'].every(key => pattern(job[key], SHA))
    || !pattern(job.sourceManifestSha256, HASH) || !Object.hasOwn(CHECKS, job.role)
    || ![1, 2].includes(job.attempt) || typeof job.createdAt !== 'string'
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(job.createdAt)
    || !Number.isFinite(Date.parse(job.createdAt))) return false;
  return job.id === createHash('sha256').update(JSON.stringify([JOB_CONTRACT, ...JOB_ID_FIELDS.map(key => job[key])])).digest('hex');
}
// Preserve Source v2's spending rule: scanner effects belong to content/attempt,
// while the three admission/control effects also belong to the claim generation.
// Controller restart never creates a new effect or a second publication key.
function effectKey(job, claim) {
  const scanner = ['gitleaks', 'trivy', 'contract-placement'].includes(job.role);
  return digest({ action: 'native-independent-publication/1', job_id: job.id, app_id: APP_ID,
    check_name: CHECKS[job.role], ...(scanner ? {} : { claim }) });
}
function publicationKey(effect) {
  const hex = digest({ action: 'native-independent-publication-key/1', effect_key: effect }).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function validateIndependentPublicationIdentity(value) {
  if (!exact(value, IDENTITY_KEYS) || value.schema !== IDENTITY_SCHEMA || value.provider !== 'independent-ci'
    || !jobValid(value.job) || !claimValid(value.claim) || value.app_id !== APP_ID
    || value.check_name !== CHECKS[value.job.role] || !pattern(value.controller_id, UUID)) fail('independent_publication_identity_invalid');
  const effect = effectKey(value.job, value.claim);
  if (value.effect_key !== effect || value.publication_key !== publicationKey(effect)) fail('independent_publication_effect_invalid');
  return clone(value);
}
export function makeIndependentPublicationIdentity({ job, claim, controller_id }) {
  if (!jobValid(job) || !claimValid(claim) || !pattern(controller_id, UUID)) fail('independent_publication_subject_invalid');
  const effect = effectKey(job, claim);
  return validateIndependentPublicationIdentity({ schema: IDENTITY_SCHEMA, provider: 'independent-ci', job: clone(job), claim: clone(claim),
    app_id: APP_ID, check_name: CHECKS[job.role], controller_id, effect_key: effect, publication_key: publicationKey(effect) });
}
export function independentPublicationIdentityDigest(value) { return digest(validateIndependentPublicationIdentity(value)); }
export function assertIndependentPublicationTarget(value, target) {
  const identity = validateIndependentPublicationIdentity(value), { job, claim } = identity;
  if (!exact(target, TARGET_KEYS) || target.repository !== job.repo || target.pr_ref !== `${job.repo}#${job.pr}`
    || target.head_sha !== job.headSha || target.base_sha !== job.baseSha
    || !CLAIM_KEYS.every(key => target[key] === claim[key])) fail('independent_publication_target_changed');
  return identity;
}
export function independentPublicationExternalId(value, publicationId) {
  const identity = validateIndependentPublicationIdentity(value);
  if (!pattern(publicationId, UUID)) fail('independent_publication_ticket_invalid');
  return `independent-ci:native:v1:${identity.job.id}:p${publicationId}`;
}
