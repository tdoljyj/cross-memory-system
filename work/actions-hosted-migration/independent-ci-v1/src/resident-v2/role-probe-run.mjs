// C2: one role read, outside a PR, batch, evaluation or publication. Pure wire contract.
import { createHash } from 'node:crypto';
export const ROLE_PROBE_RUN_CONTRACT = 'clued.independent-ci.role-probe-run/1';
export const ROLE_PROBE_RUN_FIELDS = Object.freeze(['contract', 'id', 'repo', 'runId', 'sourceManifestSha256', 'nodeProfileSha256', 'createdAt']);
export const ROLE_PROBE_REASONS = Object.freeze({ held: 'ROLE_PROBE_HELD', 'not-held': 'ROLE_PROBE_NOT_HELD',
  uncertain: 'ROLE_PROBE_UNCERTAIN', connection: 'ROLE_PROBE_CONNECTION_UNAUTHORIZED' });
const HEX = /^[0-9a-f]{64}$/, RUN = /^[0-9a-f]{16}-[0-9a-f]{12}$/, REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const fail = () => { throw Object.assign(new Error('ROLE_PROBE_RUN_REFUSED'), { code: 'ROLE_PROBE_RUN_REFUSED' }); };
export function roleProbeRunId(v) {
  return createHash('sha256').update(JSON.stringify([ROLE_PROBE_RUN_CONTRACT, v.repo, v.runId, v.sourceManifestSha256, v.nodeProfileSha256])).digest('hex');
}
export function validateRoleProbeRun(v) {
  if (!v || Object.getPrototypeOf(v) !== Object.prototype || Object.keys(v).length !== ROLE_PROBE_RUN_FIELDS.length
    || !ROLE_PROBE_RUN_FIELDS.every(k => Object.hasOwn(v, k)) || v.contract !== ROLE_PROBE_RUN_CONTRACT
    || !HEX.test(v.id ?? '') || !REPO.test(v.repo ?? '') || !RUN.test(v.runId ?? '') || !HEX.test(v.sourceManifestSha256 ?? '')
    || !HEX.test(v.nodeProfileSha256 ?? '') || typeof v.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v.createdAt)
    || !Number.isFinite(Date.parse(v.createdAt)) || v.id !== roleProbeRunId(v)) fail();
  return v;
}
export function makeRoleProbeRun(v) {
  const job = { contract: ROLE_PROBE_RUN_CONTRACT, id: null, ...v };
  job.id = roleProbeRunId(job);
  return validateRoleProbeRun(job);
}
export function roleProbeFact(reason) {
  if (reason === ROLE_PROBE_REASONS.held) return { result: 'held', code: reason };
  if (reason === ROLE_PROBE_REASONS['not-held']) return { result: 'not-held', code: reason };
  if ([ROLE_PROBE_REASONS.uncertain, ROLE_PROBE_REASONS.connection].includes(reason)) return { result: 'uncertain', code: reason };
  return null;
}
