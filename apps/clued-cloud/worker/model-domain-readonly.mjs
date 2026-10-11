/** Server-only source verifier candidate. No routes, writes, issuer or provider.
 * The source object is created in the existing authenticated Worker/RPC chain,
 * never from a request body. Its protected rows come from owner_grant_actions /
 * owner_grants_v1; ordinary Record.type_fields cannot grant authority.
 */
export const POLICY = Object.freeze({
  scope: 'project:0597aa60-9b98-4da6-a4ab-63d7705b632f',
  task: '1502fd80-8ff8-4adc-b4f5-da6d462f4f8a',
  service: 'clued-cloud/supabase',
  subject: Object.freeze({ definition_id: 'clued.model-program.DatasetSplit', version: 'v0.1',
    definition_sha256: 'f51cefe8eccd0faa75b45e78380e5b389ed266ca4034b511a85f51771f2d4f77',
    instance_schema_sha256: '062860afd3dc16fa9ee1de27582439701a67b7c5976ad45981a7cca3e515468f' }),
  registry: 'b89bb15a047cd59390428e86d33e8e2fc59d3a83954c68c2393d0e5b3dc4f3cc',
  contract: 'd8599ca8148f63a7893133ad3b13426edab25f3f48bc5291b1fb7c038a04754f',
  actions: Object.freeze(['model.dataset_split.verify', 'model.dataset_split.recognize', 'model.dataset_split.producer']),
  maxAgeMs: 300000, maxWindowMs: 3600000,
});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hex = /^[0-9a-f]{64}$/;
export class DomainReadDenied extends Error { constructor(code) { super(code); this.name = 'DomainReadDenied'; } }
const assertContract = (yes, code) => { if (!yes) throw new DomainReadDenied(code); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, fields, code) => assertContract(object(value) && Object.keys(value).sort().join('|') === [...fields].sort().join('|'), code);
const equal = (a, b) => canonical(a) === canonical(b);
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export function parseSourceUTC(value) {
  assertContract(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value), 'TIME_NOT_UTC');
  const result = Date.parse(value);
  assertContract(Number.isFinite(result) && new Date(result).toISOString().slice(0,19) === value.slice(0,19), 'TIME_INVALID');
  return result;
}
const time = parseSourceUTC;
function reference(value) {
  exact(value, ['id', 'version', 'content_hash'], 'REFERENCE_SHAPE');
  assertContract(uuid.test(value.id) && Number.isSafeInteger(value.version) && value.version > 0 && hex.test(value.content_hash), 'REFERENCE_INVALID');
}
export function validateSourceRequest(input) {
  exact(input, ['permission_record_ref', 'producer_registration_ref', 'recognition_record_ref', 'recognition_receipt_id'], 'CALLER_CONTEXT_OR_UNKNOWN_FIELD');
  for (const key of ['permission_record_ref', 'producer_registration_ref', 'recognition_record_ref']) reference(input[key]);
  assertContract(uuid.test(input.recognition_receipt_id), 'RECEIPT_REFERENCE_INVALID');
  return structuredClone(input);
}
const recordResource = ref => `record:${ref.id}@${ref.version}#${ref.content_hash}`;
function requiredResources(input, kind) {
  // Reuse the existing Native Owner resource kind. Scope, Task, subject/schema
  // and producer are checked separately against fixed policy and pinned rows.
  return [recordResource(input[kind === 'producer' ? 'producer_registration_ref' : 'permission_record_ref'])];
}
function protectedAuthority(value, input, now) {
  assertContract(object(value) && object(value.auth) && value.auth.currentness === 'CURRENT' && value.auth.revoked_at === null, 'AUTH_SOURCE_UNKNOWN_OR_REVOKED');
  const auth = value.auth;
  assertContract(auth.status === 'AUTHENTICATED' && auth.canonical_scope === POLICY.scope && auth.environment === 'NON_PRODUCTION', 'AUTH_SCOPE');
  assertContract(object(auth.principal) && uuid.test(auth.principal.subject_id) && uuid.test(auth.principal.binding_id), 'AUTH_REAL_PRINCIPAL_REQUIRED');
  assertContract(now < time(auth.expires_at), 'AUTH_EXPIRED');
  assertContract(now - time(auth.evaluated_at) >= 0 && now - time(auth.evaluated_at) <= POLICY.maxAgeMs, 'AUTH_STALE');
  assertContract(Array.isArray(value.issuer_catalog) && POLICY.actions.every(action => value.issuer_catalog.some(row => row.action === action && Array.isArray(row.doors) && row.doors.includes('model-domain'))), 'DOMAIN_ISSUER_NOT_REGISTERED');
  assertContract(Array.isArray(value.native_grants), 'PROTECTED_GRANTS_UNAVAILABLE');
  const selected = [];
  for (const action of POLICY.actions) {
    const rows = value.native_grants.filter(g => g.action === action);
    assertContract(rows.length === 1, 'INDEPENDENT_NATIVE_GRANT_MISSING_OR_AMBIGUOUS');
    const g = rows[0];
    assertContract(g.storage_source === 'clued_private.owner_grants_v1' && uuid.test(g.id) && uuid.test(g.token_id) && uuid.test(g.receipt_id), 'GRANT_NOT_NATIVE_PROTECTED_SOURCE');
    assertContract(g.user_id === auth.principal.subject_id && g.grantee_binding_id === auth.principal.binding_id && g.task_id === POLICY.task, 'GRANT_PRINCIPAL_OR_TASK');
    assertContract(g.revoked_at === null && time(g.granted_at) <= now && now < time(g.expires_at) && time(g.expires_at) - time(g.granted_at) <= POLICY.maxWindowMs, 'GRANT_REVOKED_EXPIRED_OR_WINDOW');
    assertContract(g.max_uses === null && Number.isSafeInteger(g.uses) && g.uses >= 0, 'READ_GRANT_MUST_BE_TIME_BOUND_NOT_SINGLE_USE_CONSUMPTION');
    assertContract(Array.isArray(g.resources) && equal([...g.resources].sort(), requiredResources(input, action.endsWith('.producer') ? 'producer' : 'permission')), 'GRANT_RESOURCE_NOT_EXACT');
    selected.push({ id: g.id, action: g.action, receipt_id: g.receipt_id, expires_at: g.expires_at, resources: g.resources });
  }
  return { principal: auth.principal, grants: selected };
}
function currentRecord(row, ref, type, authority, now) {
  assertContract(object(row) && row.id === ref.id && row.version === ref.version && row.content_hash === ref.content_hash, 'SERVER_RECORD_VERSION_OR_CANONICAL_HASH');
  assertContract(row.canonical_scope === POLICY.scope && row.record_currentness === 'CURRENT' && row.lifecycle_status === 'active' && row.record_type === type && row.authority === authority, 'RECORD_SCOPE_CURRENTNESS_OR_AUTHORITY');
  assertContract(time(row.evaluated_at) <= now && now - time(row.evaluated_at) <= POLICY.maxAgeMs, 'RECORD_STALE');
  return row;
}
function verifyRows(rows, input, protectedState, now) {
  assertContract(object(rows), 'CANONICAL_SOURCE_UNAVAILABLE');
  const principal = protectedState.principal;
  const permission = currentRecord(rows.permission, input.permission_record_ref, 'decision', 'user_explicit', now);
  const producer = currentRecord(rows.producer, input.producer_registration_ref, 'state', 'user_explicit', now);
  const recognition = currentRecord(rows.recognition, input.recognition_record_ref, 'state', 'observed', now);
  const grant = permission.type_fields?.domain_permission;
  assertContract(object(grant) && grant.status === 'active' && grant.revoked_at === null && grant.action === 'DatasetSplit.definition.recognize' && grant.effect === 'NON_PRODUCTION_DEFINITION_RECOGNITION_ONLY' && grant.environment === 'NON_PRODUCTION' && grant.canonical_scope === POLICY.scope && equal(grant.subject, POLICY.subject) && equal(grant.principal, principal) && equal(grant.producer_registration_ref, input.producer_registration_ref), 'DOMAIN_RECORD_IS_ONLY_BINDING_NOT_NATIVE_GRANT');
  assertContract(time(grant.not_before) <= now && now < time(grant.expires_at) && time(grant.expires_at) - time(grant.not_before) <= POLICY.maxWindowMs, 'DOMAIN_BINDING_WINDOW');
  assertContract(equal(producer.type_fields?.domain_producer, { service: POLICY.service, role: 'EXISTING_MODEL_DOMAIN_AUTHORITY_DELEGATE', domain_owner: 'MODEL PROGRAM', environment: 'NON_PRODUCTION', principal, authority_registry_sha256: POLICY.registry }), 'REGISTERED_PRODUCER_BINDING');
  const binding = recognition.type_fields?.domain_recognition;
  assertContract(recognition.type_fields?.state_kind === 'model_dataset_split_domain_recognition' && object(binding) && binding.contract_sha256 === POLICY.contract && equal(binding.subject, POLICY.subject) && equal(binding.permission_record_ref, input.permission_record_ref) && equal(binding.producer_registration_ref, input.producer_registration_ref) && equal(binding.producer, { service: POLICY.service, ...principal }) && binding.effect === 'NON_PRODUCTION_DEFINITION_RECOGNITION_ONLY', 'RECOGNITION_BINDING');
  const receipt = rows.receipt, event = rows.event;
  assertContract(object(receipt) && receipt.id === input.recognition_receipt_id && recognition.receipt_id === receipt.id && receipt.status === 'committed' && receipt.operation_family === 'record_mutation', 'RECEIPT_COMMITTED_BINDING');
  assertContract(receipt.user_id === principal.subject_id && receipt.binding_id === principal.binding_id && equal(receipt.target_refs, [{ id: recognition.id, kind: 'record', role: 'primary' }]) && equal(receipt.committed_versions, { [recognition.id]: recognition.version }), 'RECEIPT_ACTOR_TARGET_VERSION');
  assertContract(Array.isArray(receipt.event_ids) && receipt.event_ids.length === 1 && object(event) && String(event.id) === String(receipt.event_ids[0]) && ['record_created', 'record_updated'].includes(event.canonical_event_type) && event.result === 'success' && event.receipt_id === receipt.id && event.event_scope === POLICY.scope && equal(event.target_refs, receipt.target_refs), 'EVENT_RECEIPT_BINDING');
  assertContract(Number.isSafeInteger(receipt.canonical_version) && receipt.canonical_version > 0 && event.committed_canonical_version === receipt.canonical_version && event.actor_user_id === principal.subject_id && event.actor_binding_id === principal.binding_id, 'EVENT_ACTOR_OR_CANONICAL_VERSION');
  for (const view of [receipt, event]) assertContract(time(view.evaluated_at) <= now && now - time(view.evaluated_at) <= POLICY.maxAgeMs, 'TRANSACTION_SOURCE_STALE');
  return { recognition_record_ref: input.recognition_record_ref, recognition_receipt_ref: receipt.id, recognition_event_ref: String(event.id) };
}
function stablePrivateRows(rows) {
  // A new observation timestamp is expected. Every other value is source truth:
  // actor, content, version, currentness, receipt and Event must remain equal.
  exact(rows, ['permission', 'producer', 'recognition', 'receipt', 'event'], 'CANONICAL_BUNDLE_SHAPE');
  return Object.fromEntries(Object.entries(rows).map(([key, row]) => {
    assertContract(object(row), 'CANONICAL_SOURCE_UNAVAILABLE');
    const { evaluated_at, ...stable } = row;
    return [key, stable];
  }));
}
/** source methods are server-owned closures, not serialized capabilities. */
export function createM2ServerReadonlyReader(source, clock = () => Date.now()) {
  assertContract(object(source) && typeof source.readProtectedAuthority === 'function' && typeof source.readCanonicalBundle === 'function', 'REAL_SERVER_SOURCE_REQUIRED');
  return Object.freeze({ async verify(input) {
    const request = validateSourceRequest(input);
    let last = -Infinity;
    const sample = () => { const value = clock(); assertContract(Number.isSafeInteger(value) && value >= last, 'CLOCK_REGRESSED_OR_INVALID'); last = value; return value; };
    const first = structuredClone(await source.readProtectedAuthority(request));
    const auth = protectedAuthority(first, request, sample()); // No canonical reads before this.
    const privateRows = structuredClone(await source.readCanonicalBundle(request));
    verifyRows(privateRows, request, auth, sample());
    const beforeFinalRead = structuredClone(await source.readProtectedAuthority(request));
    const beforeFinalAuth = protectedAuthority(beforeFinalRead, request, sample());
    assertContract(equal(auth, beforeFinalAuth), 'AUTHORITY_CHANGED_DURING_READ');
    const finalRows = structuredClone(await source.readCanonicalBundle(request));
    const final = structuredClone(await source.readProtectedAuthority(request));
    const finalAuth = protectedAuthority(final, request, sample());
    assertContract(equal(auth, finalAuth), 'AUTHORITY_CHANGED_DURING_READ');
    const references = verifyRows(finalRows, request, finalAuth, sample());
    assertContract(equal(stablePrivateRows(privateRows), stablePrivateRows(finalRows)), 'CANONICAL_SOURCE_CHANGED_DURING_READ');
    // One acceptance instant checks every deadline. A later row-only sample
    // must not become the verdict time after Native authority has expired.
    const acceptedAt = sample();
    const acceptedAuth = protectedAuthority(final, request, acceptedAt);
    verifyRows(finalRows, request, acceptedAuth, acceptedAt);
    // Actor / identity fields never leave this server-only verifier.
    return Object.freeze({ status: 'VERIFIED_EXISTING_SOURCE_REFERENCES_READ_ONLY', ...references,
      source_scope: POLICY.scope, evaluated_at: new Date(last).toISOString(),
      authority_effect: 'NONE', actual_execution: 'NONE', m2_qualification: 'NOT_ISSUED',
      domain_authority_receipt: 'NOT_ISSUED_BY_READER', data_gate: 'NOT_ISSUED',
      private_actor_fields_exposed: false });
  } });
}
