/** Install only inside continuity.callRpc's existing Binding branch.
 * No HTTP route/publicMCP tool is registered by this file.
 * rpc is the existing private supabaseRequest closure with host-derived
 * p_token_hash. Never serialize that closure/hash or accept it in caller JSON.
 */
import { POLICY, DomainReadDenied, validateSourceRequest, parseSourceUTC } from './model-domain-readonly.mjs';
export const SOURCE_RPC = 'clued_model_dataset_split_verify_candidate';
const allowed = ['status','recognition_record_ref','recognition_receipt_ref','recognition_event_ref',
  'source_scope','evaluated_at','authority_effect','actual_execution','m2_qualification',
  'domain_authority_receipt','data_gate','private_actor_fields_exposed'];
export async function verifyWithExistingBindingRpc(rpc, input, clock = () => Date.now()) {
  const request = validateSourceRequest(input);
  if (typeof rpc !== 'function') throw new DomainReadDenied('REAL_SERVER_RPC_REQUIRED');
  let result;
  try { result = await rpc(SOURCE_RPC, request); }
  catch { throw new DomainReadDenied('AUTHENTICATED_SOURCE_DENIED_OR_UNAVAILABLE'); }
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      Object.keys(result).sort().join('|') !== [...allowed].sort().join('|') ||
      result.status !== 'VERIFIED_EXISTING_SOURCE_REFERENCES_READ_ONLY' ||
      result.private_actor_fields_exposed !== false || result.source_scope !== POLICY.scope ||
      result.authority_effect !== 'NONE' || result.actual_execution !== 'NONE' ||
      result.m2_qualification !== 'NOT_ISSUED' || result.data_gate !== 'NOT_ISSUED' ||
      result.domain_authority_receipt !== 'NOT_ISSUED_BY_READER' ||
      !result.recognition_record_ref || Object.keys(result.recognition_record_ref).sort().join('|') !== 'content_hash|id|version' || result.recognition_record_ref.id !== request.recognition_record_ref.id || result.recognition_record_ref.version !== request.recognition_record_ref.version || result.recognition_record_ref.content_hash !== request.recognition_record_ref.content_hash ||
      result.recognition_receipt_ref !== request.recognition_receipt_id ||
      typeof result.recognition_event_ref !== 'string' || !/^[1-9][0-9]*$/.test(result.recognition_event_ref)) {
    throw new DomainReadDenied('PRIVATE_IDENTITY_LEAK_OR_INVALID_SOURCE_RESULT');
  }
  const evaluated = parseSourceUTC(result.evaluated_at), now = clock();
  if (!Number.isSafeInteger(now) || !Number.isFinite(evaluated) || evaluated > now || now - evaluated > POLICY.maxAgeMs)
    throw new DomainReadDenied('RPC_SOURCE_STALE');
  return Object.freeze(structuredClone(result));
}

/* Exact integration fragment for the existing continuity.ts private callRpc:
 * const tokenHash = await sha256(token); // same existing host transport source
 * return await verifyWithExistingBindingRpc(async (name, input) =>
 *   await supabaseRequest(env, `/rest/v1/rpc/${name}`, {
 *     method: 'POST', body: JSON.stringify({ p_token_hash: tokenHash, p_input: input })
 *   }), payload);
 * Register/invoke only after scoped review/installation. Do not add an unsanitized
 * generic record/actor endpoint or use an Agent's authority/grant fields.
 */
