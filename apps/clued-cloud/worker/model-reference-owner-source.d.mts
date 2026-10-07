import type { CanonicalRef, ExistingBindingRpc } from './model-domain-rpc-source.mjs';
export const SOURCE_RPC: 'clued_model_reference_owner_approval_refs_candidate';
export interface OwnerApprovalReferences {
  readonly status: 'CURRENT_EXACT_OWNER_APPROVAL_REFS_ONLY';
  readonly approval_record_ref: CanonicalRef; readonly receipt_id: string; readonly event_id: string;
  readonly canonical_version: number; readonly request_sha256: string; readonly template_sha256: string; readonly profile_id: string;
  readonly source_scope: 'project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
  readonly task_id: '1502fd80-8ff8-4adc-b4f5-da6d462f4f8a'; readonly evaluated_at: string;
  readonly authority_effect: 'NONE'; readonly actual_execution: 'NONE'; readonly profile_issued: false;
  readonly private_actor_fields_exposed: false; readonly record_body_exposed: false;
}
export function validateSourceInput(input: unknown): unknown;
export function validateSourceOutput(output: unknown, input: unknown, now: number): Readonly<OwnerApprovalReferences>;
export function readOwnerApprovalRefsWithExistingBindingRpc(rpc: ExistingBindingRpc, input: unknown, clock?: () => number): Promise<Readonly<OwnerApprovalReferences>>;
