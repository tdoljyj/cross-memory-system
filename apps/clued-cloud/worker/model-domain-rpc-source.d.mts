export interface CanonicalRef { readonly id: string; readonly version: number; readonly content_hash: string }
export type ExistingBindingRpc = (name: string, input: unknown) => Promise<unknown>;
export interface VerifySourceInput {
  readonly permission_record_ref: CanonicalRef;
  readonly producer_registration_ref: CanonicalRef;
  readonly recognition_record_ref: CanonicalRef;
  readonly recognition_receipt_id: string;
}
export interface VerifiedReadonlySource {
  readonly status: "VERIFIED_EXISTING_SOURCE_REFERENCES_READ_ONLY";
  readonly recognition_record_ref: CanonicalRef;
  readonly recognition_receipt_ref: string;
  readonly recognition_event_ref: string;
  readonly source_scope: "project:0597aa60-9b98-4da6-a4ab-63d7705b632f";
  readonly evaluated_at: string;
  readonly authority_effect: "NONE";
  readonly actual_execution: "NONE";
  readonly m2_qualification: "NOT_ISSUED";
  readonly domain_authority_receipt: "NOT_ISSUED_BY_READER";
  readonly data_gate: "NOT_ISSUED";
  readonly private_actor_fields_exposed: false;
}
export const SOURCE_RPC: "clued_model_dataset_split_verify_candidate";
export function verifyWithExistingBindingRpc(rpc: ExistingBindingRpc, input: unknown, clock?: () => number): Promise<Readonly<VerifiedReadonlySource>>;
