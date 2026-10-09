import type { ExistingBindingRpc, CanonicalRef } from './model-domain-rpc-source.mjs';
export const BOOTSTRAP_READINESS_RPC: 'clued_model_dataset_split_bootstrap_readiness_candidate';
export const BOOTSTRAP_COMMIT_RPC: 'clued_model_dataset_split_bootstrap_commit_candidate';
export const EXACT_BOOTSTRAP_PLAN: Readonly<{ resource: string; sha256: string; idempotency_key: string;
 targets: Readonly<{producer_record_id:string;permission_record_id:string;recognition_record_id:string}> }>;
export interface BootstrapReadiness {
 readonly status: 'FIXED_OWNER_CHAIN_AND_PLAN_READINESS_ONLY';
 readonly owner_adoption_server_ref: CanonicalRef; readonly final_recognizer_server_ref: CanonicalRef;
 readonly immutable_plan_resource: string; readonly plan_sha256: string;
 readonly max_uses: 1; readonly max_window_seconds: 3600; readonly evaluated_at: string;
 readonly bootstrap_write_authorized: false; readonly domain_permission: 'NOT_GRANTED';
 readonly m2_verdict: 'NOT_ISSUED'; readonly private_actor_fields_exposed: false;
}
export interface BootstrapCommitResult {
 readonly status:'COMMITTED_NON_PRODUCTION_M1_DEFINITION_PROJECTIONS_ONLY';
 readonly actual_execution:'CANONICAL_RECORD_MUTATION';
 readonly producer_record_ref:CanonicalRef;readonly permission_record_ref:CanonicalRef;readonly recognition_record_ref:CanonicalRef;
 readonly canonical_receipt_ids: readonly string[];readonly canonical_event_ids: readonly string[];
 readonly evaluated_at:string;readonly domain_authority_receipt:'NOT_KERNEL_RECEIPT';
 readonly data_gate:'NOT_ISSUED';readonly m2_verdict:'NOT_ISSUED';
 readonly training_or_data_use_authorized:false;readonly private_actor_fields_exposed:false;
}
export class BootstrapInputDenied extends Error { constructor(); }
export class BootstrapExecutionDenied extends Error { constructor(); }
export class BootstrapCompletionUnknown extends Error { constructor(); }
export class BootstrapReadinessDenied extends Error { constructor(); }
export function readBootstrapReadiness(rpc:ExistingBindingRpc,input:unknown,clock?:()=>number):Promise<Readonly<BootstrapReadiness>>;
export function commitBootstrap(rpc:ExistingBindingRpc,input:unknown,clock?:()=>number):Promise<Readonly<BootstrapCommitResult>>;
