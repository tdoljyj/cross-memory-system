import type { CanonicalRef, ExistingBindingRpc } from './model-domain-rpc-source.mjs';
export interface ActorFreeReadonlySource {
  readonly status: 'ACTOR_FREE_EXISTING_SOURCE_REFERENCES_READ_ONLY';
  readonly recognition_record_ref: Readonly<CanonicalRef>;
  readonly recognition_receipt_ref: string;
  readonly recognition_event_ref: string;
  readonly source_scope: 'project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
  readonly evaluated_at: string;
  readonly authority_effect: 'NONE';
  readonly actual_execution: 'NONE';
  readonly m2_qualification: 'NOT_ISSUED';
  readonly domain_authority_receipt: 'NOT_ISSUED_BY_READER';
  readonly data_gate: 'NOT_ISSUED';
  readonly private_actor_fields_exposed: false;
}
export const SUCCESSOR_SOURCE_RPC: 'clued_model_dataset_split_verify_successor_candidate';
export function verifySuccessorWithExistingBindingRpc(rpc: ExistingBindingRpc, input: unknown, clock?: () => number): Promise<Readonly<ActorFreeReadonlySource>>;
