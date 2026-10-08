import { readOwnerApprovalRefsWithExistingBindingRpc } from "./model-reference-owner-source.mjs";
import { readOwnerAnchorsWithExistingBindingRpc } from "./model-domain-owner-anchor-rpc.mjs";
import { resolveWithExistingBindingRpc } from "./model-domain-ref-resolver.mjs";
import { verifyWithExistingBindingRpc, type ExistingBindingRpc } from "./model-domain-rpc-source.mjs";
import { prepareNativeBootstrapRequest } from "./model-domain-native-bootstrap-request.mjs";
import { MODEL_REFERENCE_OWNER_APPROVAL_REFS_TOOL, MODEL_DOMAIN_OWNER_ANCHOR_REFS_TOOL, MODEL_DOMAIN_REFS_TOOL, MODEL_DOMAIN_VERIFY_TOOL, MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL,
  modelDomainSourceEnabled, modelDomainBootstrapRequestEnabled, type ModelDomainFeatureEnv,
  type ModelDomainToolName } from "./model-domain-tools";

export class ModelDomainToolDenied extends Error {
  constructor() { super("Model domain source denied or unavailable."); this.name = "ModelDomainToolDenied"; }
}

// Host-owned closures only. The Worker captures rpc and submitOwnerRequest from
// one Request and one Binding. Neither closure/hash/actor is caller JSON.
export interface ModelDomainTransport {
  readonly rpc: ExistingBindingRpc;
  readonly submitOwnerRequest: (input: unknown) => Promise<unknown>;
}
export async function dispatchModelDomainTool(env: ModelDomainFeatureEnv, name: ModelDomainToolName,
  input: unknown, transport: ModelDomainTransport): Promise<unknown> {
  if (!modelDomainSourceEnabled(env) ||
    (name === MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL && !modelDomainBootstrapRequestEnabled(env))) {
    throw new ModelDomainToolDenied();
  }
  try {
    if (name === MODEL_REFERENCE_OWNER_APPROVAL_REFS_TOOL) return await readOwnerApprovalRefsWithExistingBindingRpc(transport.rpc, input);
    if (name === MODEL_DOMAIN_OWNER_ANCHOR_REFS_TOOL) return await readOwnerAnchorsWithExistingBindingRpc(transport.rpc, input);
    if (name === MODEL_DOMAIN_REFS_TOOL) return await resolveWithExistingBindingRpc(transport.rpc, input);
    if (name === MODEL_DOMAIN_VERIFY_TOOL) return await verifyWithExistingBindingRpc(transport.rpc, input);
    if (name === MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL) {
      const prepared = await prepareNativeBootstrapRequest(transport.rpc, input);
      // This is a real Owner-request submission if installed and invoked. Its
      // existing receipt/result is returned as-is, never labeled execution NONE.
      // It does not approve a grant or invoke any Canonical/M1 writer.
      return await transport.submitOwnerRequest(prepared.request);
    }
  } catch {
    throw new ModelDomainToolDenied();
  }
  throw new ModelDomainToolDenied();
}
