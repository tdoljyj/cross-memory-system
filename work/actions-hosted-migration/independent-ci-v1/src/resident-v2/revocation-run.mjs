// A bounded negative-effect maintenance invocation; never a PR/scanner job.
import { createHash } from 'node:crypto';
export const REVOCATION_RUN_CONTRACT = 'clued.independent-ci.revocation-maintenance-run/1';
export const REVOCATION_RUN_FIELDS = Object.freeze(['contract','id','repo','runId','sourceManifestSha256','nodeProfileSha256','createdAt']);
export const REVOCATION_FACTS_CONTRACT = 'clued.independent-ci.revocation-maintenance-facts/1';
const HEX = /^[0-9a-f]{64}$/, RUN = /^[0-9a-f]{16}-[0-9a-f]{12}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const exact = (v, fields) => v && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v,k));
export function revocationRunId(v) {
  return createHash('sha256').update(JSON.stringify([REVOCATION_RUN_CONTRACT,v.repo,v.runId,v.sourceManifestSha256,v.nodeProfileSha256])).digest('hex');
}
export function validateRevocationRun(v) {
  if (!exact(v,REVOCATION_RUN_FIELDS) || v.contract !== REVOCATION_RUN_CONTRACT || v.repo !== 'tdoljyj/cross-memory-system'
    || !HEX.test(v.id ?? '') || !RUN.test(v.runId ?? '') || !HEX.test(v.sourceManifestSha256 ?? '') || !HEX.test(v.nodeProfileSha256 ?? '')
    || typeof v.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v.createdAt)
    || !Number.isFinite(Date.parse(v.createdAt)) || v.id !== revocationRunId(v)) fail('REVOCATION_RUN_REFUSED');
  return v;
}
export function makeRevocationRun(v) {
  const job = {contract:REVOCATION_RUN_CONTRACT,id:null,...v};job.id=revocationRunId(job);return validateRevocationRun(job);
}
export function validateRevocationFacts(v) {
  const fields=['contract','pending','reconciled','notSent','acknowledged','complete'];
  if (!exact(v,fields) || v.contract !== REVOCATION_FACTS_CONTRACT || typeof v.complete !== 'boolean'
    || !['pending','reconciled','notSent','acknowledged'].every(k => Number.isSafeInteger(v[k]) && v[k]>=0 && v[k]<=100000)
    || v.complete !== (v.pending === 0)) fail('REVOCATION_FACTS_REFUSED');
  return v;
}
export function revocationQualification(record, {now=Date.now(),reserveMs=0}={}) {
  const q=record?.accepted?.revocationMaintenanceQualification;
  if (!exact(q,['contract','qualificationRef','sourceManifestSha256','allowWhileHalted','validUntil'])
    || q.contract!=='clued.independent-ci.revocation-maintenance-qualification/1'
    || typeof q.qualificationRef!=='string' || !/^receipt:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(q.qualificationRef)
    || q.sourceManifestSha256!==record.config.sourceManifestSha256 || typeof q.allowWhileHalted!=='boolean'
    || !Number.isSafeInteger(now) || !Number.isSafeInteger(reserveMs) || reserveMs<0
    || !(q.validUntil===null || (typeof q.validUntil==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(q.validUntil)
      && Number.isFinite(Date.parse(q.validUntil)) && new Date(Date.parse(q.validUntil)).toISOString()===q.validUntil && Date.parse(q.validUntil)>now+reserveMs))) return null;
  return structuredClone(q);
}
