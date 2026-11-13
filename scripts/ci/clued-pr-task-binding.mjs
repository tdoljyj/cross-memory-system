// One Native PR -> Task -> current claim projection. This module grants no
// execution authority and never reads PR bodies, commit trailers or credentials.
export const PR_BINDING_ACTION = 'resolve_pr_claim';
export const PR_BINDING_STATES = Object.freeze(['bound', 'unbound', 'no_live_claim', 'handover_pending', 'conflict', 'head_not_authorized']);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[a-z0-9][a-z0-9_.-]{0,99}\/[a-z0-9_.-]{1,100}$/;
const SCOPE = /^(?:global|project:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const integer = v => Number.isSafeInteger(v) && v > 0;
const iso = v => typeof v === 'string'
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v));

export class PRTaskBindingError extends Error {
  constructor(code) { super(code); this.name = 'PRTaskBindingError'; this.code = code; }
}
const requireThat = (ok, code) => { if (!ok) throw new PRTaskBindingError(code); };

export function prBindingSubject({ scope, repository, prNumber, headSha, baseSha, targetBranch }, { allowUnknownScope = false } = {}) {
  // A missing scope is unknown, never global. Repository identity remains the
  // caller's independently configured/trusted repository, not a PR body value.
  const unresolved = allowUnknownScope && (scope === undefined || scope === null);
  requireThat(unresolved || (typeof scope === 'string' && SCOPE.test(scope)), 'pr_binding_scope_required');
  requireThat(typeof repository === 'string' && REPO.test(repository)
    && !['.', '..'].includes(repository.split('/')[1]), 'pr_binding_repository_invalid');
  requireThat(integer(prNumber) && SHA.test(headSha ?? '') && SHA.test(baseSha ?? ''), 'pr_binding_subject_invalid');
  requireThat(typeof targetBranch === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(targetBranch)
    && !targetBranch.includes('..') && !targetBranch.includes('//') && !targetBranch.endsWith('/'), 'pr_binding_target_invalid');
  return Object.freeze({ scope: unresolved ? null : scope, repository, prNumber, headSha, baseSha, targetBranch,
    prRef: `${repository}#${prNumber}` });
}

export function normalizePRTaskBinding(reply, expected, { allowUnresolvedScope = false } = {}) {
  const s = prBindingSubject(expected, { allowUnknownScope: allowUnresolvedScope });
  requireThat(plain(reply) && reply.status === 'ok' && PR_BINDING_STATES.includes(reply.binding_status), 'pr_binding_response_invalid');
  const unresolved = ['unbound', 'conflict'].includes(reply.binding_status) && reply.scope === null
    && reply.task_id === null && reply.claim === null;
  requireThat(reply.repository === s.repository && reply.pr_number === s.prNumber && reply.pr_ref === s.prRef
    && reply.head_sha === s.headSha && reply.base_sha === s.baseSha && reply.target_branch === s.targetBranch
    && (reply.scope === s.scope || unresolved), 'pr_binding_subject_changed');
  requireThat((reply.reason === null || (typeof reply.reason === 'string' && reply.reason.length <= 200))
    && typeof reply.auto_bound === 'boolean'
    && (reply.receipt_id === null || UUID.test(reply.receipt_id ?? ''))
    && (reply.head_authorization_id === null || UUID.test(reply.head_authorization_id ?? '')),
  'pr_binding_response_invalid');
  const state = reply.binding_status;
  requireThat(s.scope !== null || ['unbound', 'conflict'].includes(state), 'pr_binding_scope_required');
  const hasTask = ['bound', 'no_live_claim', 'handover_pending', 'head_not_authorized'].includes(state);
  requireThat(hasTask ? UUID.test(reply.task_id ?? '') : reply.task_id === null, 'pr_binding_task_invalid');
  const hasClaim = ['bound', 'handover_pending', 'head_not_authorized'].includes(state);
  let claim = null;
  if (hasClaim) {
    const c = reply.claim;
    requireThat(plain(c) && UUID.test(c.claim_id ?? '') && c.task_id === reply.task_id && c.context_key === s.scope
      && integer(c.fence) && integer(c.execution_epoch) && integer(c.lease_version) && iso(c.expires_at)
      && c.status === 'ACTIVE' && typeof c.execution_handover_pending === 'boolean', 'pr_binding_claim_invalid');
    requireThat(state === 'handover_pending' ? c.execution_handover_pending === true : c.execution_handover_pending === false,
      'pr_binding_claim_invalid');
    claim = Object.freeze({ ...c });
  } else requireThat(reply.claim === null, 'pr_binding_claim_invalid');
  requireThat(reply.auto_bound === false || (state === 'bound' && UUID.test(reply.receipt_id ?? '')
    && UUID.test(reply.head_authorization_id ?? '')), 'pr_binding_response_invalid');
  // No ADMITTED verdict is synthesized. The ordinary complete Native verify,
  // freshness/epoch checks and purpose-specific execution gates still follow.
  return Object.freeze({ ...reply, claim });
}

export async function resolvePRTaskBinding({ command, readOnly = false, ...expected }) {
  requireThat(typeof command === 'function', 'pr_binding_transport_required');
  requireThat(typeof readOnly === 'boolean', 'pr_binding_read_mode_invalid');
  const s = prBindingSubject(expected, { allowUnknownScope: true });
  const reply = await command({ action: PR_BINDING_ACTION, ...(s.scope === null ? {} : { scope: s.scope }), pr_ref: s.prRef,
    head_sha: s.headSha, base_sha: s.baseSha, target_branch: s.targetBranch,
    ...(readOnly ? { read_only: true } : {}) });
  requireThat(!readOnly || reply?.auto_bound === false, 'pr_binding_read_only_violated');
  // Generic CI does not know a Task's scope before Native resolves its PR.
  // Only the authenticated Native result may supply it; installed consumers
  // always pass their fixed scope and therefore retain the strict comparison.
  const discoveredScope = s.scope === null ? reply?.scope : s.scope;
  return normalizePRTaskBinding(reply, { ...s, scope: discoveredScope },
    { allowUnresolvedScope: s.scope === null && discoveredScope === null });
}

export function claimReferenceFromBinding(projection) {
  requireThat(plain(projection), 'pr_binding_unknown');
  requireThat(projection.binding_status === 'bound',
    `pr_binding_${PR_BINDING_STATES.includes(projection.binding_status) ? projection.binding_status : 'unknown'}`);
  const p = normalizePRTaskBinding(projection, { scope: projection.scope, repository: projection.repository,
    prNumber: projection.pr_number, headSha: projection.head_sha, baseSha: projection.base_sha, targetBranch: projection.target_branch });
  requireThat(p.binding_status === 'bound',
    `pr_binding_${PR_BINDING_STATES.includes(projection?.binding_status) ? projection.binding_status : 'unknown'}`);
  return Object.freeze({ claim_id: p.claim.claim_id, scope: p.scope, task_id: p.task_id,
    fence: p.claim.fence, execution_epoch: p.claim.execution_epoch });
}

const TERMINAL_ADMISSION_FIELDS = ['receipt_id', 'claim_id', 'fence', 'execution_epoch', 'lease_version', 'head_authorization_id'];
const exactFields = (value, keys) => plain(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));

// Immutable evidence of an actual full CI admission, never a resolver result.
// This is metadata only; Native still verifies its Receipt, holder-ready proof,
// current generation, occupancy and execution drain before releasing anything.
export function normalizeTerminalAdmission(value, generation = null) {
  requireThat(exactFields(value, TERMINAL_ADMISSION_FIELDS)
    && UUID.test(value.receipt_id ?? '') && UUID.test(value.claim_id ?? '')
    && UUID.test(value.head_authorization_id ?? '') && integer(value.fence)
    && integer(value.execution_epoch) && integer(value.lease_version), 'terminal_admission_invalid');
  requireThat(generation === null || (value.claim_id === generation.claimId && value.fence === generation.fence
    && value.execution_epoch === generation.epoch), 'terminal_admission_generation_changed');
  return Object.freeze({ ...value });
}

export function terminalAdmissionFromVerification(value) {
  if (value?.verdict !== 'ADMITTED' || value.execution_authorized !== true
    || value.terminal_admission_receipt_id === undefined && value.terminal_admission === undefined) return null;
  const reference = normalizeTerminalAdmission(value.terminal_admission,
    { claimId: value.claim?.claim_id, fence: value.claim?.fence, epoch: value.claim?.execution_epoch });
  requireThat(reference.receipt_id === value.terminal_admission_receipt_id
    && reference.lease_version === value.claim?.lease_version
    && reference.head_authorization_id === value.head_authorization_id, 'terminal_admission_changed');
  return reference;
}

export function normalizeTerminalProof(value, expected = {}) {
  requireThat(exactFields(value, ['last_admission', 'observation']), 'terminal_proof_invalid');
  const last_admission = normalizeTerminalAdmission(value.last_admission), o = value.observation;
  const fields = ['repository', 'pr_ref', 'head_sha', 'base_sha', 'target_branch', 'state', 'merged'];
  requireThat(plain(o) && typeof o.merged === 'boolean' && exactFields(o, o.merged ? [...fields, 'merge_sha'] : fields)
    && REPO.test(o.repository ?? '') && typeof o.pr_ref === 'string' && o.pr_ref.startsWith(o.repository + '#')
    && /^[1-9][0-9]{0,9}$/.test(o.pr_ref.slice(o.repository.length + 1))
    && SHA.test(o.head_sha ?? '') && SHA.test(o.base_sha ?? '') && o.state === 'closed'
    && typeof o.target_branch === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(o.target_branch)
    && !o.target_branch.includes('..') && !o.target_branch.includes('//') && !o.target_branch.endsWith('/')
    && (!o.merged || SHA.test(o.merge_sha ?? '')), 'terminal_observation_invalid');
  requireThat((expected.repository === undefined || o.repository === expected.repository)
    && (expected.prNumber === undefined || o.pr_ref === `${o.repository}#${expected.prNumber}`)
    && (expected.headSha === undefined || o.head_sha === expected.headSha)
    && (expected.targetBranch === undefined || o.target_branch === expected.targetBranch)
    && (expected.merged === undefined || o.merged === expected.merged)
    && (expected.mergeSha === undefined || o.merge_sha === expected.mergeSha), 'terminal_observation_changed');
  return Object.freeze({ last_admission, observation: Object.freeze({ ...o }) });
}

export function terminalProofForPull(lastAdmission, pull, expected) {
  requireThat(pull?.number === expected.prNumber && pull.state === 'closed' && typeof pull.merged === 'boolean'
    && pull.head?.repo?.full_name === expected.repository && pull.base?.repo?.full_name === expected.repository,
  'terminal_observation_invalid');
  return normalizeTerminalProof({ last_admission: lastAdmission, observation: {
    repository: expected.repository, pr_ref: `${expected.repository}#${pull.number}`,
    head_sha: pull.head?.sha, base_sha: pull.base?.sha, target_branch: pull.base?.ref,
    state: pull.state, merged: pull.merged, ...(pull.merged ? { merge_sha: pull.merge_commit_sha } : {}) } }, expected);
}
