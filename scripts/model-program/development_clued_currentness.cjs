'use strict';

// Read-only currentness for an ALREADY issued exact development Profile.
// The qualified Host captures the original successful M1 Owner-Decision write
// result and issued Profile pins. Serialized Profiles, relayed Agent messages,
// adoption receipts and test callbacks are not trusted capture inputs.
// No Profile, permission, Gate, Grant, qualification or attempt is issued here.
const SCOPE = 'project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
const TASK = '1502fd80-8ff8-4adc-b4f5-da6d462f4f8a';
const PHASES = new Set(['preflight', 'before_observation_open', 'observation_opened',
  'consume', 'before_start', 'before_resume', 'running', 'before_result']);
const SHA = /^[0-9a-f]{64}$/;
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' :
  value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key =>
    JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
const need = (condition, code) => { if (!condition) throw new Error('DEVELOPMENT_CLUED_' + code); };

function utcInstant(value) {
  const match = typeof value === 'string'
    && /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  need(match, 'UTC_WINDOW_REQUIRED');
  const milliseconds = Date.parse(value);
  // Date.parse normalizes some impossible dates. Compare the calendar fields,
  // including millisecond precision, before accepting the parsed instant.
  const expected = match[1] + '.' + (match[2] || '').padEnd(3, '0').slice(0, 3) + 'Z';
  need(Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === expected,
    'UTC_WINDOW_REQUIRED');
  return milliseconds;
}

function decode(result) {
  need(result && !result.isError, 'TOOL_REFUSED');
  if (result.structuredContent) return result.structuredContent;
  const text = (result.content || []).find(item => item.type === 'text');
  need(text && typeof text.text === 'string' && text.text.length <= 262144, 'TOOL_RESPONSE_SHAPE');
  return JSON.parse(text.text);
}

function currentRecord(result, id, type) {
  need(result.status === 'ok' && !result.absence_claim, 'CURRENT_VIEW_UNAVAILABLE');
  const rows = (result.results || []).filter(row => row.kind === 'record' && row.id === id);
  need(rows.length === 1, 'EXACT_CURRENT_RECORD_UNAVAILABLE');
  const row = rows[0];
  need(row.scope === SCOPE && row.record_type === type && row.authoritative === true
    && row.record_currentness === 'CURRENT' && row.projection_currentness === 'CURRENT'
    && row.lifecycle_status === 'active', 'RECORD_NOT_CURRENT_ACTIVE');
  return row;
}

function makeDevelopmentCurrentnessReader({tools, ownerCapture, issued, sessionRef}) {
  // ownerCapture must come directly from the Host's admitted, successful M1
  // capture of the human's exact experiment answer, never from a Profile file.
  const capture = decode(ownerCapture);
  const record = capture.supplemental?.record;
  need(capture.status === 'committed' && typeof capture.receipt_id === 'string'
    && Array.isArray(capture.event_ids) && capture.event_ids.length > 0, 'ORIGINAL_M1_CAPTURE_REQUIRED');
  need(record?.record_type === 'decision' && record.authority === 'user_explicit'
    && record.lifecycle_status === 'active' && record.canonical_scope === SCOPE
    && record.receipt_id === capture.receipt_id && SHA.test(record.content_hash), 'EXACT_OWNER_DECISION_REQUIRED');
  const rationale = record.type_fields?.rationale;
  need(rationale && typeof rationale === 'object' && !Array.isArray(rationale),
    'EXACT_DEVELOPMENT_APPROVAL_REQUIRED');
  // The public M1 schema carries this payload only inside rationale.
  const approval = rationale.model_development_experiment_approval;
  need(approval && typeof approval === 'object' && !Array.isArray(approval)
    && approval.kind === 'EXACT_BOUNDED_DEVELOPMENT_EXPERIMENT'
    && approval.task_id === TASK && approval.purpose_id === 'development'
    && approval.max_attempts === 1 && approval.training_allowed === false
    && approval.production_allowed === false && approval.qualification_allowed === false,
  'EXACT_DEVELOPMENT_APPROVAL_REQUIRED');
  need(issued && issued.task_id === TASK && issued.profile_id === approval.profile_id
    && issued.status === 'ISSUED'
    && issued.request_sha256 === approval.request_sha256 && SHA.test(issued.request_sha256)
    && SHA.test(issued.profile_sha256) && SHA.test(issued.execution_plan_sha256)
    && typeof issued.claim_id === 'string' && Number.isInteger(issued.claim_fence)
    && issued.claim_fence > 0 && Number.isInteger(issued.task_version) && issued.task_version > 0
    && typeof issued.task_query === 'string' && issued.task_query.length > 0,
  'ISSUED_EXACT_PROFILE_BINDING_REQUIRED');
  need(!issued.profile_id.toLowerCase().startsWith('m1-'), 'TERMINAL_PROFILE_FORBIDDEN');
  need(typeof sessionRef === 'string' && sessionRef.length > 0, 'HOST_SESSION_REQUIRED');
  const start = utcInstant(approval.window?.not_before);
  const stop = utcInstant(approval.window?.stop_at);
  need(Number.isFinite(start) && Number.isFinite(stop) && start < stop
    && stop - start <= 86400000, 'APPROVAL_WINDOW');
  const pins = clone(issued);
  const original = {id: record.id, version: record.version, content: record.content,
    approval_rationale:canonical(record.type_fields.rationale),
    content_hash: record.content_hash, receipt_id: capture.receipt_id};
  const methods = ['clued_session_resume', 'clued_search_context',
    'clued_session_reconcile', 'clued_work_verify'];
  const calls = {};
  for (const method of methods) {
    const name = 'mcp__codex_apps__clued_' + method;
    need(typeof tools?.[name] === 'function', 'ACTUAL_PROTECTED_TOOL_REQUIRED');
    calls[method] = tools[name].bind(tools);
  }

  async function read(phase, bound) {
    need(PHASES.has(phase), 'PHASE');
    const identity = bound?.identity;
    need(identity?.task_id === TASK && identity.profile_id === pins.profile_id
      && identity.profile_sha256 === pins.profile_sha256 && identity.request_sha256 === pins.request_sha256
      && identity.approval_record_id === original.id && identity.approval_version === original.version
      && identity.approval_receipt_id === original.receipt_id
      && bound.execution_plan_sha256 === pins.execution_plan_sha256, 'REQUEST_BINDING_DRIFT');
    need(Date.now() >= start && Date.now() < stop, 'APPROVAL_EXPIRED_OR_EARLY');
    const resumed = decode(await calls.clued_session_resume({context_key: SCOPE,
      client_session_id: sessionRef, event_limit: 1, event_budget_bytes: 4096}));
    need(resumed.status === 'restored' && resumed.context_key === SCOPE
      && typeof resumed.session_token === 'string', 'AUTHORIZED_SESSION_REQUIRED');
    const claim = (resumed.active_work_claims || []).find(row => row.claim_id === pins.claim_id);
    need(claim?.status === 'ACTIVE' && claim.task_id === TASK && claim.context_key === SCOPE
      && claim.fence === pins.claim_fence && claim.holder_session_ref === sessionRef
      && claim.execution_handover_pending === false, 'CLAIM_NOT_CURRENT');
    const observe = async () => Promise.all([
      calls.clued_search_context({session_token: resumed.session_token, context_key: SCOPE,
        scope: 'context', query: pins.profile_id, limit: 20, max_bytes: 65536}),
      calls.clued_search_context({session_token: resumed.session_token, context_key: SCOPE,
        scope: 'context', query: pins.task_query, limit: 20, max_bytes: 262144}),
      calls.clued_work_verify({claim_id: pins.claim_id, scope: SCOPE})]);
    const check = ([approvalRead, taskRead, verified]) => {
    const live = currentRecord(decode(approvalRead), original.id, 'decision');
    need(live.version === original.version && live.content === original.content
      && canonical(live.type_fields?.rationale) === original.approval_rationale,
      'APPROVAL_CHANGED_OR_REVOKED');
    const task = currentRecord(decode(taskRead), TASK, 'task');
    need(task.version === pins.task_version, 'TASK_CHANGED_REVALIDATION_REQUIRED');
    const gate = decode(verified);
    need(gate.status === 'ok' && gate.verdict === 'ADMITTED' && gate.current_fence === pins.claim_fence
      && gate.claim?.claim_id === pins.claim_id && gate.claim.fence === pins.claim_fence
      && gate.claim.task_id === TASK && gate.claim.context_key === SCOPE
      && gate.claim.status === 'ACTIVE' && gate.claim.execution_handover_pending === false
      && gate.claim.holder_session_ref === sessionRef, 'CLAIM_NOT_VERIFIED');
    return task;
    };
    check(await observe());
    const reconciled = decode(await calls.clued_session_reconcile({session_token: resumed.session_token,
      context_key: SCOPE}));
    need(reconciled.currentness_state === 'CURRENT' && reconciled.admission_eligible === true,
      'CURRENTNESS_UNAVAILABLE');
    // Reconcile may adopt a new vector. Re-read the exact decision/task/claim
    // afterwards; CURRENT alone cannot bless changed or revoked approval.
    // This remains a bounded point observation, not an atomic execution grant.
    const task = check(await observe());
    need(Date.now() >= start && Date.now() < stop, 'APPROVAL_EXPIRED_DURING_READ');
    return {kind: 'CURRENT_OWNER_DECISION_AND_PROFILE_BINDING_OBSERVATION',
      approval_record_id: original.id, approval_version: original.version,
      approval_receipt_id: original.receipt_id, approval_content_hash: original.content_hash,
      task_id: TASK, task_version: task.version, claim_id: claim.claim_id, claim_fence: claim.fence,
      request_sha256: pins.request_sha256, profile_sha256: pins.profile_sha256,
      authority_effect: 'NONE', permission_issued: false, attempt_consumed: false};
  }
  return Object.freeze({read});
}

module.exports = Object.freeze({makeDevelopmentCurrentnessReader});
