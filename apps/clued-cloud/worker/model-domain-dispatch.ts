import { readOwnerApprovalRefsWithExistingBindingRpc } from "./model-reference-owner-source.mjs";
import { readOwnerAnchorsWithExistingBindingRpc } from "./model-domain-owner-anchor-rpc.mjs";
import { resolveWithExistingBindingRpc } from "./model-domain-ref-resolver.mjs";
import { verifyWithExistingBindingRpc, type ExistingBindingRpc } from "./model-domain-rpc-source.mjs";
import { prepareNativeBootstrapRequest } from "./model-domain-native-bootstrap-request.mjs";
import { readBootstrapReadiness, commitBootstrap, EXACT_BOOTSTRAP_PLAN, BootstrapReadinessDenied } from "./model-domain-bootstrap-source.mjs";
import { prepareExactPlanWithExistingBindingRpc } from "./model-domain-plan-preparation.mjs";
import { verifySuccessorWithExistingBindingRpc } from "./model-domain-successor-rpc-source.mjs";
import { MODEL_REFERENCE_OWNER_APPROVAL_REFS_TOOL, MODEL_DOMAIN_OWNER_ANCHOR_REFS_TOOL, MODEL_DOMAIN_REFS_TOOL, MODEL_DOMAIN_VERIFY_TOOL, MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL,
  MODEL_DOMAIN_PLAN_PREPARATION_TOOL, MODEL_DOMAIN_SUCCESSOR_VERIFY_TOOL, MODEL_DOMAIN_BOOTSTRAP_READINESS_TOOL, MODEL_DOMAIN_BOOTSTRAP_COMMIT_TOOL,
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
    ((name === MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL || name === MODEL_DOMAIN_BOOTSTRAP_COMMIT_TOOL) && !modelDomainBootstrapRequestEnabled(env))) {
    throw new ModelDomainToolDenied();
  }
  // Completion-unknown must not be collapsed into a definite read denial.
  if (name === MODEL_DOMAIN_BOOTSTRAP_COMMIT_TOOL) return await commitBootstrap(transport.rpc, input);
  try {
    if (name === MODEL_DOMAIN_BOOTSTRAP_READINESS_TOOL) return await readBootstrapReadiness(transport.rpc, input);
    if (name === MODEL_REFERENCE_OWNER_APPROVAL_REFS_TOOL) return await readOwnerApprovalRefsWithExistingBindingRpc(transport.rpc, input);
    if (name === MODEL_DOMAIN_OWNER_ANCHOR_REFS_TOOL) return await readOwnerAnchorsWithExistingBindingRpc(transport.rpc, input);
    if (name === MODEL_DOMAIN_REFS_TOOL) return await resolveWithExistingBindingRpc(transport.rpc, input);
    if (name === MODEL_DOMAIN_VERIFY_TOOL) return await verifyWithExistingBindingRpc(transport.rpc, input);
    if (name === MODEL_DOMAIN_PLAN_PREPARATION_TOOL) return await prepareExactPlanWithExistingBindingRpc(transport.rpc, input);
    if (name === MODEL_DOMAIN_SUCCESSOR_VERIFY_TOOL) return await verifySuccessorWithExistingBindingRpc(transport.rpc, input);
    if (name === MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL) {
      const prepared = await prepareNativeBootstrapRequest(transport.rpc, input);
      const ready = await readBootstrapReadiness(transport.rpc, {});
      const resources = prepared.request.resources;
      const expectedOwners = [ready.owner_adoption_server_ref, ready.final_recognizer_server_ref]
        .map(ref => `record:${ref.id}@${ref.version}#${ref.content_hash}`);
      const expectedTargets = Object.values(EXACT_BOOTSTRAP_PLAN.targets).map(id => "record:" + id);
      if (prepared.request.idempotency_key !== EXACT_BOOTSTRAP_PLAN.idempotency_key ||
        ![...expectedOwners, ...expectedTargets, EXACT_BOOTSTRAP_PLAN.resource].every(resource => resources.includes(resource))) {
        throw new ModelDomainToolDenied();
      }
      // This is a real Owner-request submission if installed and invoked. Its
      // existing receipt/result is returned as-is, never labeled execution NONE.
      // It does not approve a grant or invoke any Canonical/M1 writer.
      return await transport.submitOwnerRequest(prepared.request);
    }
  } catch (error) {
    // Keep the already-supported, private-data-free readiness denial so the
    // Worker can distinguish this pre-submission failure from a generic source
    // denial. Validation and all Native write/claim gates stay unchanged.
    if ((name === MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL || name === MODEL_DOMAIN_BOOTSTRAP_READINESS_TOOL) && error instanceof BootstrapReadinessDenied) throw error;
    throw new ModelDomainToolDenied();
  }
  throw new ModelDomainToolDenied();
}
