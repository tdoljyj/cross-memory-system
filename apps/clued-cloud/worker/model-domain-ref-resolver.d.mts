import type { CanonicalRef, ExistingBindingRpc } from "./model-domain-rpc-source.mjs";
export interface RefProjectionInput {
  readonly permission_record_id: string;
  readonly producer_registration_id: string;
  readonly recognition_record_id: string;
}
export interface RefProjection {
  readonly permission_record_ref: CanonicalRef;
  readonly producer_registration_ref: CanonicalRef;
  readonly recognition_record_ref: CanonicalRef;
  readonly status: "RESOLVED_EXISTING_PROJECTION_REFERENCES_READ_ONLY";
  readonly source_scope: "project:0597aa60-9b98-4da6-a4ab-63d7705b632f";
  readonly evaluated_at: string;
  readonly projection_only: true;
  readonly authority_effect: "NONE";
  readonly actual_execution: "NONE";
  readonly m2_qualification: "NOT_ISSUED";
}
export const RESOLVE_RPC: "clued_model_dataset_split_resolve_refs_candidate";
export function resolveWithExistingBindingRpc(rpc: ExistingBindingRpc, input: unknown, clock?: () => number): Promise<Readonly<RefProjection>>;
