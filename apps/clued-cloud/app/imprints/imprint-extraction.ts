import { object, positive, sourceKind, uuid, type ImprintRecord, type Json } from "./imprint-model";
import { call, ImprintFailure, prepareWrite, type NativeRpc, type PreparedWrite } from "./imprint-client";
import { canAssociate } from "./imprint-associations";
import type { SuggestionSource } from "./imprint-suggestions";

export type ExtractionText = { slot: "content" | "text"; text: string };
export function extractionTexts(record: ImprintRecord): ExtractionText[] {
  if (!canAssociate(record)) return [];
  if (sourceKind(record) !== "development") return record.content ? [{ slot: "content", text: record.content }] : [];
  if (!object(record.body)) return [];
  return (["content", "text"] as const).flatMap(slot => typeof (record.body as Json)[slot] === "string" && (record.body as Json)[slot]
    ? [{ slot, text: (record.body as Json)[slot] as string }] : []);
}
export async function extractionInput(record: ImprintRecord, text: ExtractionText, fragment: SuggestionSource,
  kind: "task" | "decision", key: string, contextId?: string): Promise<Json> {
  if (!extractionTexts(record).some(value => value.slot === text.slot && value.text === text.text)
    || text.text.slice(fragment.start, fragment.end) !== fragment.text || fragment.start < 0 || fragment.end <= fragment.start
    || [...fragment.text].length > 300 || (contextId !== undefined && (!uuid(contextId) || record.context_id !== contextId)))
    throw new ImprintFailure("unavailable", "extraction_source_invalid");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text.text));
  return { idempotency_key: key, owner_text_confirmed: true, source: {
    source_kind: sourceKind(record) ?? "canonical", record_id: record.id, record_version: record.version,
    slot: text.slot, start: [...text.text.slice(0, fragment.start)].length, end: [...text.text.slice(0, fragment.end)].length,
    quote: fragment.text, kind, text_hash: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join(""),
    ...(contextId ? { context_id: contextId, environment: record.environment } : {}),
  } };
}
export type ExtractionCandidate = { candidate_id: string; candidate_version: number; candidate_status: string; scope: string;
  kind: "task" | "decision"; record_id: string | null; record_version: number | null; promotion_receipt_id: string | null };
export async function prepareExtraction(rpc: NativeRpc, pending: PreparedWrite): Promise<ExtractionCandidate> {
  const result = await call(rpc, "clued_imprint_extraction_prepare_v1", { p_input: pending.input, p_received_payload_hash: pending.hash });
  const item = result.supplemental;
  if (result.status !== "committed" || !uuid(result.receipt_id) || !object(item) || !uuid(item.candidate_id)
    || !positive(item.candidate_version) || !["pending", "promoted", "rejected", "withdrawn", "expired", "conflict"].includes(String(item.candidate_status))
    || !["task", "decision"].includes(String(item.kind)) || typeof item.scope !== "string"
    || (item.candidate_status === "promoted" && (!uuid(item.record_id) || !positive(item.record_version) || !uuid(item.promotion_receipt_id))))
    throw new ImprintFailure("unknown");
  return item as ExtractionCandidate;
}
export type ExtractionConfirmation = { candidate_id: string; candidate_version: number; record_id: string; confirmation_token: string;
  view_digest: string; expires_at: string; confirmation_view: Json };
export async function issueExtraction(rpc: NativeRpc, candidate: ExtractionCandidate, fields: Json): Promise<ExtractionConfirmation> {
  const value = await call(rpc, "clued_candidate_confirmation_issue_v1", { p_input: { tier: "information", candidate_id: candidate.candidate_id,
    base_version: candidate.candidate_version, authority: "user_explicit", confidence: null,
    confidence_reason: "The signed-in owner confirmed their own exact source fragment", native_type_fields: fields } });
  if (value.status !== "issued" || value.candidate_id !== candidate.candidate_id || value.candidate_version !== candidate.candidate_version
    || !uuid(value.record_id) || typeof value.confirmation_token !== "string" || typeof value.view_digest !== "string"
    || !/^[0-9a-f]{64}$/.test(value.view_digest) || typeof value.expires_at !== "string" || !object(value.confirmation_view)
    || value.confirmation_view.record_type !== candidate.kind || value.confirmation_view.scope !== candidate.scope
    || value.confirmation_view.id !== value.record_id || !object(value.confirmation_view.mutation)) throw new ImprintFailure("unknown");
  return value as ExtractionConfirmation;
}
export async function promotionInput(confirmation: ExtractionConfirmation, key: string): Promise<PreparedWrite> {
  return prepareWrite({ tier: "information", candidate_id: confirmation.candidate_id, base_version: confirmation.candidate_version,
    confirmation_token: confirmation.confirmation_token, view_digest: confirmation.view_digest, idempotency_key: key });
}
export async function promoteExtraction(rpc: NativeRpc, pending: PreparedWrite): Promise<string> {
  const value = await call(rpc, "clued_candidate_promote_v1", { p_input: pending.input, p_received_payload_hash: pending.hash });
  if (value.status !== "committed" || !uuid(value.receipt_id)) throw new ImprintFailure("unknown");
  return value.receipt_id;
}
