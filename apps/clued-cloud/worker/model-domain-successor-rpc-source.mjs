/** Actor-free successor reader inside the existing private Binding RPC branch.
 * This adapter registers no route, accepts no authority, and never retries the
 * legacy reader. The server owns authentication, grants and Canonical checks.
 */
import { POLICY, DomainReadDenied, validateSourceRequest, parseSourceUTC } from './model-domain-readonly.mjs';

export const SUCCESSOR_SOURCE_RPC = 'clued_model_dataset_split_verify_successor_candidate';
const inputKeys = ['permission_record_ref', 'producer_registration_ref', 'recognition_record_ref', 'recognition_receipt_id'];
const outputKeys = ['status', 'recognition_record_ref', 'recognition_receipt_ref', 'recognition_event_ref',
  'source_scope', 'evaluated_at', 'authority_effect', 'actual_execution', 'm2_qualification',
  'domain_authority_receipt', 'data_gate', 'private_actor_fields_exposed'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const deny = code => { throw new DomainReadDenied(code); };
function exactDataObject(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && keys.every(key => typeof key === 'string' && fields.includes(key) &&
    Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}
function canonicalRef(value) {
  return exactDataObject(value, ['id', 'version', 'content_hash']) &&
    typeof value.id === 'string' && uuid.test(value.id) &&
    Number.isSafeInteger(value.version) && value.version > 0 &&
    typeof value.content_hash === 'string' && /^[0-9a-f]{64}$/.test(value.content_hash);
}
function equalRef(left, right) {
  return left.id === right.id && left.version === right.version && left.content_hash === right.content_hash;
}

export async function verifySuccessorWithExistingBindingRpc(rpc, input, clock = () => Date.now()) {
  if (!exactDataObject(input, inputKeys) || !inputKeys.slice(0, 3).every(key => canonicalRef(input[key])) ||
      typeof input.recognition_receipt_id !== 'string' || !uuid.test(input.recognition_receipt_id)) {
    deny('CALLER_CONTEXT_OR_INVALID_SUCCESSOR_REFERENCE');
  }
  const request = validateSourceRequest(input);
  if (typeof rpc !== 'function') deny('REAL_SERVER_RPC_REQUIRED');
  let result;
  try { result = await rpc(SUCCESSOR_SOURCE_RPC, structuredClone(request)); }
  catch { deny('AUTHENTICATED_SUCCESSOR_SOURCE_DENIED_OR_UNAVAILABLE'); }
  if (!exactDataObject(result, outputKeys) ||
      result.status !== 'ACTOR_FREE_EXISTING_SOURCE_REFERENCES_READ_ONLY' ||
      result.private_actor_fields_exposed !== false || result.source_scope !== POLICY.scope ||
      result.authority_effect !== 'NONE' || result.actual_execution !== 'NONE' ||
      result.m2_qualification !== 'NOT_ISSUED' || result.data_gate !== 'NOT_ISSUED' ||
      result.domain_authority_receipt !== 'NOT_ISSUED_BY_READER' ||
      !canonicalRef(result.recognition_record_ref) || !equalRef(result.recognition_record_ref, request.recognition_record_ref) ||
      result.recognition_receipt_ref !== request.recognition_receipt_id ||
      typeof result.recognition_event_ref !== 'string' || !/^[1-9][0-9]{0,18}$/.test(result.recognition_event_ref) ||
      BigInt(result.recognition_event_ref) > 9223372036854775807n) {
    deny('PRIVATE_IDENTITY_LEAK_OR_INVALID_SUCCESSOR_SOURCE_RESULT');
  }
  const evaluated = parseSourceUTC(result.evaluated_at), now = clock();
  if (!Number.isSafeInteger(now) || evaluated > now || now - evaluated > POLICY.maxAgeMs) deny('SUCCESSOR_RPC_SOURCE_STALE');
  const snapshot = structuredClone(result);
  Object.freeze(snapshot.recognition_record_ref);
  return Object.freeze(snapshot);
}
