import type { ExistingBindingRpc, CanonicalRef } from './model-domain-rpc-source.mjs';
export interface ExactPlanPreparation {
  readonly status: 'PLAN_ARTIFACT_PROPOSAL_UNCOMMITTED_UNAUTHORIZED';
  readonly plan_utf8: string;
  readonly plan_sha256: string;
  readonly plan_bytes: number;
  readonly role_inputs: {
    readonly producer_record_id: string; readonly permission_record_id: string; readonly recognition_record_id: string; readonly idempotency_key: string;
    readonly owner_adoption_server_ref: CanonicalRef; readonly final_recognizer_server_ref: CanonicalRef;
  };
  readonly actual_execution: 'NONE'; readonly execution: false; readonly mutation_permitted: false;
  readonly authority_effect: 'NONE'; readonly plan_semantics: 'PROPOSAL_ONLY_NEVER_NATIVE_INTENT';
  readonly immutable_resource: null; readonly SQL_emitted: false;
  readonly domain_permission: 'NOT_GRANTED'; readonly m2_verdict: 'NOT_ISSUED';
}
export function prepareExactPlanWithExistingBindingRpc(rpc: ExistingBindingRpc, input: unknown): Promise<Readonly<ExactPlanPreparation>>;
