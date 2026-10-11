/** Source-only fixed Owner-ref read. The rpc closure is captured by the Worker
 * from its existing authenticated Request/Binding and never from caller JSON.
 * No Owner-request submission, domain grant, Canonical write or body-hash fallback.
 */
export const OWNER_ANCHOR_RPC = 'clued_model_dataset_split_owner_anchor_refs_candidate';
export const OWNER_ANCHOR_IDS = Object.freeze(['b8c1d482-9eb4-4bc5-8dd1-372b0d55174e', '46b0ff1c-f608-4ff9-89b9-dc90a61ce70f']);
const scope = 'project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
const schema = 'clued.model-owner-anchor-refs/1';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
export class OwnerAnchorReadDenied extends Error {
  constructor() { super('FIXED_OWNER_ANCHOR_REFS_DENIED_OR_UNAVAILABLE'); this.name = 'OwnerAnchorReadDenied'; }
}
const deny = () => { throw new OwnerAnchorReadDenied(); };
export async function readOwnerAnchorsWithExistingBindingRpc(rpc, input) {
  if (typeof rpc !== 'function' || !(input === undefined || exact(input, []) ||
    (exact(input, ['schema']) && input.schema === schema))) deny();
  let output;
  try { output = await rpc(OWNER_ANCHOR_RPC, { schema }); } catch { deny(); }
  const refs = ['owner_adoption_server_ref', 'final_recognizer_server_ref'];
  if (!exact(output, [...refs, 'status', 'projection_only', 'source_scope', 'authority_effect', 'domain_permission', 'm2_verdict']) ||
    output.status !== 'OWNER_ANCHOR_PROJECTION_REFS_ONLY' || output.projection_only !== true || output.source_scope !== scope ||
    output.authority_effect !== 'NONE' || output.domain_permission !== 'NOT_GRANTED' || output.m2_verdict !== 'NOT_ISSUED') deny();
  for (let i = 0; i < refs.length; i++) {
    const ref = output[refs[i]];
    if (!exact(ref, ['id', 'version', 'content_hash']) || ref.id !== OWNER_ANCHOR_IDS[i] || ref.version !== 1 ||
      typeof ref.content_hash !== 'string' || !/^[0-9a-f]{64}$/.test(ref.content_hash)) deny();
  }
  return Object.freeze(structuredClone(output));
}
