// Per-job facade for the already-qualified protected controller ports. It
// preserves the original GitHub identity, adds Native evidence on active
// executions, and never exposes either credential to a worker or caller.
import { createHash } from 'node:crypto';
import { admittedFactsMatchJobV2 } from '../../work/actions-hosted-migration/independent-ci-v1/src/admission-facts-v2.mjs';
import { digest } from '../../work/actions-hosted-migration/independent-ci-v1/src/proof.mjs';
import { makeIndependentPublicationIdentity, CHECKS } from './clued-independent-publication-identity.mjs';
import { createIndependentPublicationRuntime, nativeNoPostProof, independentCheckExternalIdMatchesJob } from './clued-independent-publication-runtime.mjs';

export const COMPONENT_VERSION = '1.1.43';
const BRAND = Symbol('qualified-native-publication-facade');
const brand = Object.freeze({});
const noPostErrors = new WeakMap();
export const isNativePublicationPort = port => port?.[BRAND] === brand;
export const nativePublicationNoPostProof = error => nativeNoPostProof(error) ?? noPostErrors.get(error) ?? null;
export async function prepareNativePublication(port, { facts, packet, payload }) {
  if (facts?.publicationRequired === true && !isNativePublicationPort(port)) fail('independent_native_publisher_not_qualified');
  return isNativePublicationPort(port) ? port.prepareNativePublication({ facts, packet, payload }) : null;
}
const fail = code => { throw Object.assign(new Error(code), { code }); };
const clone = value => JSON.parse(JSON.stringify(value));
function noPost(code, identity) {
  const error = Object.assign(new Error(code), { code });
  noPostErrors.set(error, Object.freeze({ notSent: true, jobId: identity.job.id, claimId: identity.claim.claim_id,
    fence: identity.claim.fence, epoch: identity.claim.execution_epoch }));
  return error;
}
// This identifies a real protected invocation, not a GitHub Actions run and not
// a Host conversation. The nonce must be supplied by the qualified supervisor.
export function independentControllerId({ invocationNonce, jobId, nodeId }) {
  if (!/^[0-9a-f]{32,64}$/.test(invocationNonce ?? '') || !/^[0-9a-f]{64}$/.test(jobId ?? '')
    || typeof nodeId !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(nodeId)) fail('independent_controller_invocation_invalid');
  const h = createHash('sha256').update(JSON.stringify(['clued.independent-controller-invocation/1', nodeId, invocationNonce, jobId])).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}
export function createIndependentPublicationPort({ job, controllerId, github, native, journal, assertCurrent,
  observeStopped, registerController, clock = Date.now }) {
  if (typeof assertCurrent !== 'function') fail('independent_current_observer_required');
  const handles = new WeakMap(), modes = new Map();
  const inventory = async head => {
    if (head !== job.headSha) fail('independent_check_inventory_subject_changed');
    const result = await github.readChecks(head);
    if (result?.complete !== true || !Array.isArray(result.checks) || result.checks.length > 10000
      || new Set(result.checks.map(c => c?.id)).size !== result.checks.length
      || result.checks.some(c => !Number.isSafeInteger(c?.id) || c.id < 1 || c.head_sha !== head)) fail('independent_check_inventory_unconfirmed');
    return result.checks;
  };
  const nativeGithub = { createCheck: body => github.createCheck(body), revokeCheck: (id, body) => github.revokeCheck(id, body),
    readChecks: inventory, readCheck: async id => (await inventory(job.headSha)).find(c => c.id === id) };
  const runtime = createIndependentPublicationRuntime({ native, github: nativeGithub, journal, observeStopped,
    assertCurrent: identity => assertCurrent(clone(identity), clone(modes.get(identity.effect_key))) });
  const facade = {};
  for (const [key, value] of Object.entries(github)) facade[key] = typeof value === 'function' ? (...args) => Reflect.apply(value, github, args) : value;
  Object.defineProperty(facade, BRAND, { value: brand });
  facade.prepareNativePublication = async ({ facts, packet, payload }) => {
    if (!admittedFactsMatchJobV2(facts, job, clock(), { batchClaim: facts?.observedClaim })
      || packet?.complete !== true || packet.pr !== job.pr || packet.headSha !== job.headSha || packet.baseSha !== job.baseSha
      || !Array.isArray(packet.paths) || digest(packet) !== facts.packetSha256) fail('independent_complete_admission_required');
    const identity = makeIndependentPublicationIdentity({ job, controller_id: controllerId,
      claim: { claim_id: facts.claimId, fence: facts.fence, execution_epoch: facts.epoch } });
    if (payload?.name !== CHECKS[job.role] || payload.head_sha !== job.headSha) throw noPost('independent_publication_subject_changed', identity);
    const mode = { executionPolicy: facts.executionPolicy, guarded: facts.guarded, scope: facts.scope, paths: [...packet.paths] };
    modes.set(identity.effect_key, mode);
    if (await assertCurrent(clone(identity), clone(mode)) !== true) throw noPost('independent_current_authority_refused', identity);
    if (registerController) await registerController(clone(identity), clone(mode));
    const context = { identity, scope: facts.scope, paths: packet.paths, payload };
    const nativeHandle = facts.executionPolicy === 'active' ? await runtime.prepare(context) : null;
    const handle = Object.freeze({ native: nativeHandle !== null, publicationId: nativeHandle?.publicationId ?? null });
    handles.set(handle, { identity, mode, payloadSha256: digest(payload), nativeHandle });
    return handle;
  };
  facade.createCheck = async (payload, handle) => {
    const prepared = handles.get(handle); handles.delete(handle);
    if (!prepared) fail('independent_publication_prepare_required');
    if (digest(payload) !== prepared.payloadSha256) {
      if (prepared.nativeHandle?.recoveryRequired) fail('independent_prepared_payload_changed');
      throw noPost('independent_prepared_payload_changed', prepared.identity);
    }
    if (await assertCurrent(clone(prepared.identity), clone(prepared.mode)) !== true) {
      if (prepared.nativeHandle?.recoveryRequired) fail('independent_current_authority_refused');
      throw noPost('independent_current_authority_refused', prepared.identity);
    }
    if (!prepared.nativeHandle) return github.createCheck(payload);
    const result = prepared.nativeHandle.recoveryRequired ? await runtime.recover(prepared.nativeHandle.key) : await runtime.createCheck(prepared.nativeHandle);
    if (result.status === 'NOT_SENT') throw noPost('independent_publication_not_sent', prepared.identity);
    if (result.status !== 'SETTLED') fail('independent_native_publication_revoked');
    return result.check;
  };
  // Parent publishers may compensate a check after their final full-admission
  // read. Preserve the Native reference so the separate revoker can still find
  // the exact effect. A known negative check needs no second PATCH.
  facade.revokeCheck = async (checkId, payload) => {
    const check = await nativeGithub.readCheck(checkId);
    if (check?.app?.id !== 5368905 || check.name !== CHECKS[job.role] || check.head_sha !== job.headSha
      || !independentCheckExternalIdMatchesJob(check.external_id, job)) fail('independent_revocation_subject_changed');
    if (check.status === 'completed' && check.conclusion === 'failure') return check;
    const tag = String(check.output?.summary ?? '').split('\n').find(line => line.startsWith(`Native publication independent-ci:native:v1:${job.id}:p`));
    const body = clone(payload);
    if (tag) body.output = { ...body.output, summary: `${body.output?.summary ?? ''}\n\n${tag}` };
    return github.revokeCheck(checkId, body);
  };
  return Object.freeze(facade);
}

// One control-pair/relay invocation can publish several sealed jobs. Route
// opaque capabilities to their own per-job facade, never by caller paths.
export function createIndependentPublicationPortsForJobs({ jobs, controllerIdFor, ...options }) {
  if (!Array.isArray(jobs) || !jobs.length || jobs.length > 6 || new Set(jobs.map(j => j.id)).size !== jobs.length
    || new Set(jobs.map(j => j.role)).size !== jobs.length || typeof controllerIdFor !== 'function'
    || !jobs.every(j => ['repo','pr','headSha','baseSha','testSha','sourceManifestSha256','attempt'].every(k => j[k] === jobs[0][k]))) fail('independent_publication_jobs_invalid');
  const children = new Map(jobs.map(job => [job.id, createIndependentPublicationPort({ ...options, job, controllerId: controllerIdFor(job) })]));
  const owners = new WeakMap(), facade = {};
  for (const [key,value] of Object.entries(options.github)) facade[key] = typeof value === 'function' ? (...args) => Reflect.apply(value,options.github,args) : value;
  Object.defineProperty(facade,BRAND,{value:brand});
  facade.prepareNativePublication = async input => {
    const child = children.get(input.facts?.jobId);if(!child)fail('independent_publication_job_not_sealed');
    const handle = await child.prepareNativePublication(input);owners.set(handle,child);return handle;
  };
  facade.createCheck = async (payload,handle) => {
    const child = owners.get(handle);owners.delete(handle);if(!child)fail('independent_publication_prepare_required');
    return child.createCheck(payload,handle);
  };
  facade.revokeCheck = async (id,payload) => {
    const inventory = await options.github.readChecks(jobs[0].headSha);
    if(inventory?.complete!==true||!Array.isArray(inventory.checks))fail('independent_check_inventory_unconfirmed');
    const check = inventory.checks.find(c=>c.id===id),job = jobs.find(j=>CHECKS[j.role]===check?.name);
    if(!job)fail('independent_revocation_subject_changed');return children.get(job.id).revokeCheck(id,payload);
  };
  return Object.freeze(facade);
}
