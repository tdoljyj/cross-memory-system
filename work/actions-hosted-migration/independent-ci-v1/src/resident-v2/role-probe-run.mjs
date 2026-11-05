// C2: one role read, outside a batch, evaluation or publication (a /2 watch names one PR, compared locally only). Pure wire contract.
import { createHash } from 'node:crypto';
export const ROLE_PROBE_RUN_CONTRACT = 'clued.independent-ci.role-probe-run/1';
// Generation 12 (resident DESIGN 56.2), the queue watch: /2 adds watchPr, one PR of this repository whose batch rests at parking
// point B waiting for the merge queue. The probe's one holders read then also says whether the single live slot holder is bound
// to exactly that PR (ROLE_PROBE_HELD_WATCHED_HEAD): one bit about the resident's own PR, never a holder list. A run without a
// watch keeps /1 byte for byte.
export const ROLE_PROBE_RUN_CONTRACT_WATCH = 'clued.independent-ci.role-probe-run/2';
export const ROLE_PROBE_RUN_FIELDS = Object.freeze(['contract', 'id', 'repo', 'runId', 'sourceManifestSha256', 'nodeProfileSha256', 'createdAt']);
export const ROLE_PROBE_RUN_FIELDS_WATCH = Object.freeze([...ROLE_PROBE_RUN_FIELDS, 'watchPr']);
export const ROLE_PROBE_REASONS = Object.freeze({ held: 'ROLE_PROBE_HELD', 'not-held': 'ROLE_PROBE_NOT_HELD',
  uncertain: 'ROLE_PROBE_UNCERTAIN', connection: 'ROLE_PROBE_CONNECTION_UNAUTHORIZED', watchedHead: 'ROLE_PROBE_HELD_WATCHED_HEAD' });
export const validWatchPr = v => Number.isSafeInteger(v) && v > 0 && v < 10_000_000_000;
const HEX = /^[0-9a-f]{64}$/, RUN = /^[0-9a-f]{16}-[0-9a-f]{12}$/, REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const fail = () => { throw Object.assign(new Error('ROLE_PROBE_RUN_REFUSED'), { code: 'ROLE_PROBE_RUN_REFUSED' }); };
export function roleProbeRunId(v) {
  if (v.contract === ROLE_PROBE_RUN_CONTRACT_WATCH)
    return createHash('sha256').update(JSON.stringify([ROLE_PROBE_RUN_CONTRACT_WATCH, v.repo, v.runId, v.sourceManifestSha256, v.nodeProfileSha256, v.watchPr])).digest('hex');
  return createHash('sha256').update(JSON.stringify([ROLE_PROBE_RUN_CONTRACT, v.repo, v.runId, v.sourceManifestSha256, v.nodeProfileSha256])).digest('hex');
}
export function validateRoleProbeRun(v) {
  const watch = v?.contract === ROLE_PROBE_RUN_CONTRACT_WATCH, fields = watch ? ROLE_PROBE_RUN_FIELDS_WATCH : ROLE_PROBE_RUN_FIELDS;
  if (!v || Object.getPrototypeOf(v) !== Object.prototype || Object.keys(v).length !== fields.length
    || !fields.every(k => Object.hasOwn(v, k)) || ![ROLE_PROBE_RUN_CONTRACT, ROLE_PROBE_RUN_CONTRACT_WATCH].includes(v.contract)
    || (watch && !validWatchPr(v.watchPr))
    || !HEX.test(v.id ?? '') || !REPO.test(v.repo ?? '') || !RUN.test(v.runId ?? '') || !HEX.test(v.sourceManifestSha256 ?? '')
    || !HEX.test(v.nodeProfileSha256 ?? '') || typeof v.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v.createdAt)
    || !Number.isFinite(Date.parse(v.createdAt)) || v.id !== roleProbeRunId(v)) fail();
  return v;
}
// watchPr: absent or null -> /1 (no watch); a PR number -> /2.
export function makeRoleProbeRun({ watchPr = null, ...v }) {
  const job = watchPr === null ? { contract: ROLE_PROBE_RUN_CONTRACT, id: null, ...v } : { contract: ROLE_PROBE_RUN_CONTRACT_WATCH, id: null, ...v, watchPr };
  job.id = roleProbeRunId(job);
  return validateRoleProbeRun(job);
}
// The watched-head reason is a held answer (the node is on duty) that also names the watched PR as the slot holder.
export function roleProbeFact(reason) {
  if (reason === ROLE_PROBE_REASONS.held || reason === ROLE_PROBE_REASONS.watchedHead) return { result: 'held', code: reason };
  if (reason === ROLE_PROBE_REASONS['not-held']) return { result: 'not-held', code: reason };
  if ([ROLE_PROBE_REASONS.uncertain, ROLE_PROBE_REASONS.connection].includes(reason)) return { result: 'uncertain', code: reason };
  return null;
}
