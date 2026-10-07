import type { CanonicalRef, ExistingBindingRpc } from './model-domain-rpc-source.mjs';
export const OWNER_ANCHOR_RPC: 'clued_model_dataset_split_owner_anchor_refs_candidate';
export const OWNER_ANCHOR_IDS: readonly ['b8c1d482-9eb4-4bc5-8dd1-372b0d55174e', '46b0ff1c-f608-4ff9-89b9-dc90a61ce70f'];
export interface OwnerAnchorRefProjection {
  readonly owner_adoption_server_ref: CanonicalRef;
  readonly final_recognizer_server_ref: CanonicalRef;
  readonly status: 'OWNER_ANCHOR_PROJECTION_REFS_ONLY';
  readonly projection_only: true;
  readonly source_scope: 'project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
  readonly authority_effect: 'NONE';
  readonly domain_permission: 'NOT_GRANTED';
  readonly m2_verdict: 'NOT_ISSUED';
}
export class OwnerAnchorReadDenied extends Error { constructor(); }
export function readOwnerAnchorsWithExistingBindingRpc(rpc: ExistingBindingRpc, input: unknown): Promise<Readonly<OwnerAnchorRefProjection>>;
