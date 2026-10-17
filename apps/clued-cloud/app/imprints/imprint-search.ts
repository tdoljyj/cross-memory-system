import { nonnegative, object, positive, recordScope, sourceKind, uuid, type ImprintRecord, type Json, type ReadInput } from "./imprint-model";

export type RevisionMatch = Json & {
  id: string; version: number; matched_record_version: number; source_kind: "canonical" | "development";
  scope: string; snippet?: string; content?: string; updated_at?: string;
};
export type SourceMatch = Json & {
  evidence_id: string; record_id: string; record_version: number; source_record_version: number;
  historical_record_version: number | null; snippet: string; record_updated_at: string;
};
export type RevisionRead = {
  available: boolean; reason: string; record?: Json & { id: string; version: number; title: string; content: string };
};
const characters = (value: string) => Array.from(value).length;
const timestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const contextMatches = (value: Json, contextId?: string) => contextId !== undefined
  ? value.context_id === contextId : value.context_id === undefined || value.context_id === null;
export function searchRevisions(record: ImprintRecord): RevisionMatch[] {
  return Array.isArray(record.matched_revisions) ? record.matched_revisions as RevisionMatch[] : [];
}
export function searchSources(record: ImprintRecord): SourceMatch[] {
  return Array.isArray(record.matched_sources) ? record.matched_sources as SourceMatch[] : [];
}
function counts(record: ImprintRecord, items: unknown[], total: string, truncated: string): boolean {
  if (record[total] === undefined && record[truncated] === undefined) return items.length === 0;
  return nonnegative(record[total]) && Number(record[total]) >= items.length
    && record[truncated] === (Number(record[total]) > items.length);
}
/** Validate the complete query envelope before rendering any match or count. */
export function validSearchEnvelope(record: ImprintRecord, input: ReadInput, contextId?: string): boolean {
  if (record.matched_revisions !== undefined && !Array.isArray(record.matched_revisions)) return false;
  if (record.matched_sources !== undefined && !Array.isArray(record.matched_sources)) return false;
  const revisions = searchRevisions(record), sources = searchSources(record), canonical = sourceKind(record) !== "development";
  if (canonical && (revisions.length > 20 || sources.length > 20
    || !counts(record, revisions, "matched_revision_count", "matched_revisions_truncated")
    || !counts(record, sources, "matched_source_count", "matched_sources_truncated"))) return false;
  if (!input.include_history && revisions.length > 0) return false;
  if (revisions.some(item => !object(item) || item.id !== record.id || item.scope !== record.scope
    || !contextMatches(item, contextId) || item.source_kind !== (canonical ? "canonical" : "development")
    || !positive(item.version) || item.version >= record.version || item.matched_record_version !== item.version
    || item.record_currentness !== "HISTORY" || item.authoritative !== false
    || (canonical ? item.current_input_eligible !== false || item.full_body_included !== false
      || "content" in item || "body" in item || "envelope" in item
      || typeof item.snippet !== "string" || characters(item.snippet) > 240 || !timestamp(item.updated_at)
      : typeof item.content !== "string"))) return false;
  if (!canonical && sources.length > 0) return false;
  if (sources.some(item => !object(item) || !uuid(item.evidence_id) || item.record_id !== record.id
    || item.record_version !== record.version || !positive(item.source_record_version) || item.source_record_version > record.version
    || item.scope !== record.scope || !contextMatches(item, contextId)
    || typeof item.snippet !== "string" || characters(item.snippet) > 240 || !timestamp(item.record_updated_at)
    || item.authoritative !== false || item.current_input_eligible !== false || item.full_body_included !== false
    || !["linked_evidence", "historical_evidence"].includes(String(item.source_semantics))
    || !["retained", "withdrawn", "invalidated"].includes(String(item.evidence_status))
    || (item.source_record_version < record.version
      ? !input.include_history || item.historical_record_version !== item.source_record_version || item.source_semantics !== "historical_evidence"
      : item.historical_record_version !== null && item.historical_record_version !== undefined)
    || (!input.include_history && item.evidence_status !== "retained"))) return false;
  return true;
}
export function validRevisionRead(value: Json, record: ImprintRecord, version: number, contextId?: string): boolean {
  if (value.status !== "ok" || value.available !== true || value.complete !== true
    || value.record_id !== record.id || value.record_version !== record.version || value.historical_record_version !== version
    || value.scope !== record.scope || !contextMatches(value, contextId) || value.source_kind !== "canonical"
    || value.authoritative !== false || value.current_input_eligible !== false || !object(value.record)) return false;
  const prior = value.record;
  return prior.id === record.id && prior.version === version && recordScope(prior) === record.scope
    && typeof prior.title === "string" && typeof prior.content === "string"
    && prior.record_currentness === "HISTORY" && prior.authoritative === false && prior.current_input_eligible === false
    && new TextEncoder().encode(JSON.stringify(value)).byteLength <= 131072;
}
