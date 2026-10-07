import type { ExistingBindingRpc } from "./model-domain-rpc-source.mjs";
export interface NativeBootstrapInput {
  readonly producer_record_id: string;
  readonly permission_record_id: string;
  readonly recognition_record_id: string;
  readonly idempotency_key: string;
  readonly immutable_plan_resource: string;
}
export interface NativeBootstrapRequest {
  readonly action: "model.dataset_split.bootstrap";
  readonly scope: "project:0597aa60-9b98-4da6-a4ab-63d7705b632f";
  readonly task_id: "1502fd80-8ff8-4adc-b4f5-da6d462f4f8a";
  readonly resources: readonly string[];
  readonly suggested_grant: { readonly expires_seconds: 3600; readonly max_uses: 1 };
  readonly idempotency_key: string;
  readonly agent_note: string;
}
export interface PreparedNativeBootstrapRequest {
  readonly status: "NATIVE_WRITE_REQUEST_PAYLOAD_CANDIDATE_NOT_SUBMITTED";
  readonly request: NativeBootstrapRequest;
}
export function prepareNativeBootstrapRequest(rpc: ExistingBindingRpc, input: unknown): Promise<Readonly<PreparedNativeBootstrapRequest>>;
