import { canEditDue, domain, matchesProjection, normalizeRecord, normalizedDomains, object, sourceKind, uniqueRecords, uuid,
  type Domain, type ImprintRecord, type Json, type ReadInput, type ReadPage } from "./imprint-model";
import { NativeReadFailure, runNativeRead, type NativeReadOperation, type NativeReadOptions } from "../native-read-recovery";
import { validRevisionRead, validSearchEnvelope, type RevisionRead } from "./imprint-search";
export type NativeRpc = (name: string, args: Json, signal?: AbortSignal) => PromiseLike<{
  data: unknown; error: { message?: string; code?: string } | null; status?: number;
}>;
export class ImprintFailure extends Error {
  constructor(public reason: "unknown" | "conflict" | "unavailable", public code = "", public readFailure?: NativeReadFailure) { super(reason); }
}
const CONFLICT_CODES = new Set(["record_version_conflict", "organization_version_conflict", "association_version_conflict", "development_record_version_conflict",
  "context_version_conflict", "stale_base_version", "IDEMPOTENCY_KEY_CONFLICT"]);
export async function call(rpc: NativeRpc, name: string, args: Json): Promise<Json> {
  try {
    const result = await rpc(name, args);
    if (result.error) throw new ImprintFailure(CONFLICT_CODES.has(result.error.message ?? "") || result.error.code === "40001" ? "conflict" : "unavailable", result.error.message ?? result.error.code ?? "");
    if (!object(result.data)) throw new ImprintFailure("unknown");
    if (result.data.status === "conflict") throw new ImprintFailure("conflict");
    if (result.data.status === "rejected") {
      const code = typeof result.data.error_code === "string" ? result.data.error_code : "";
      throw new ImprintFailure(CONFLICT_CODES.has(code) ? "conflict" : "unavailable", code);
    }
    return result.data;
  } catch (failure) { if (failure instanceof ImprintFailure) throw failure; throw new ImprintFailure("unknown"); }
}
const READ_OPERATIONS: Record<string, NativeReadOperation> = {
  clued_imprint_read_v1: "imprints.read", clued_development_imprint_read_v1: "imprints.read", clued_imprint_source_v1: "imprints.source",
  clued_imprint_revision_read_v1: "imprints.source",
};
/** Only the named read RPCs recover. Write calls keep their original single attempt. */
async function callRead<T>(rpc: NativeRpc, name: string, args: Json, options: NativeReadOptions, validate: (value: Json) => T): Promise<T> {
  const operation = READ_OPERATIONS[name];
  if (!operation) throw new ImprintFailure("unknown", "read_operation_invalid");
  let admittedFailure: ImprintFailure | undefined;
  try {
    return await runNativeRead(operation, async ({ signal }) => {
      const result = await rpc(name, args, signal);
      if (result.error) {
        if (result.status === 0) {
          const type = /^AbortError\b/.test(result.error.message ?? "") ? "AbortError"
            : /^TypeError\b/.test(result.error.message ?? "") ? "TypeError" : "Unknown";
          throw new NativeReadFailure({ category: "transport", phase: "transport", status: 0, type });
        }
        admittedFailure = new ImprintFailure(CONFLICT_CODES.has(result.error.message ?? "") || result.error.code === "40001"
          ? "conflict" : "unavailable", result.error.message ?? result.error.code ?? "");
        const http = typeof result.status === "number" && result.status >= 400;
        throw new NativeReadFailure({ category: http ? "http" : "semantic", phase: http ? "http" : "semantic",
          status: result.status, type: http ? "HttpError" : "SemanticError" });
      }
      if (!object(result.data)) throw new NativeReadFailure({ category: "payload", phase: "payload", status: result.status, type: "PayloadError" });
      if (result.data.status === "conflict" || result.data.status === "rejected") {
        const code = typeof result.data.error_code === "string" ? result.data.error_code : "";
        admittedFailure = new ImprintFailure(result.data.status === "conflict" || CONFLICT_CODES.has(code) ? "conflict" : "unavailable", code);
        throw new NativeReadFailure({ category: "semantic", phase: "semantic", status: result.status, type: "SemanticError" });
      }
      try { return validate(result.data); }
      catch (failure) {
        if (failure instanceof ImprintFailure) admittedFailure = failure;
        const semantic = failure instanceof ImprintFailure && failure.reason !== "unknown";
        throw new NativeReadFailure({ category: semantic ? "semantic" : "payload", phase: semantic ? "semantic" : "payload",
          status: result.status, type: semantic ? "SemanticError" : "PayloadError" });
      }
    }, options);
  } catch (failure) {
    if (failure instanceof NativeReadFailure) {
      // A transport interruption proves neither an empty scope nor an authorization denial.
      if (failure.category === "transport" || failure.category === "cancelled" || failure.category === "stale") {
        throw new ImprintFailure("unknown", "read_interrupted", failure);
      }
      if (admittedFailure) { admittedFailure.readFailure = failure; throw admittedFailure; }
      throw new ImprintFailure("unknown", "read_result_unconfirmed", failure);
    }
    throw new ImprintFailure("unknown");
  }
}
export async function readImprints(rpc: NativeRpc, input: ReadInput, contextId?: string,
  options: NativeReadOptions = { isCurrent: () => true }): Promise<ReadPage> {
  const development = contextId !== undefined;
  if (development && !uuid(contextId)) throw new ImprintFailure("unavailable", "invalid_development_context");
  return await callRead(rpc, development ? "clued_development_imprint_read_v1" : "clued_imprint_read_v1",
    { p_input: development ? { ...input, context_id: contextId } : input }, options,
    value => parseImprintPage(value, input, contextId));
}
function parseImprintPage(value: Json, input: ReadInput, contextId?: string): ReadPage {
  const development = contextId !== undefined;
  if (development && typeof value.view_unavailable_reason === "string") throw new ImprintFailure("unavailable", "development_formal_view_unavailable");
  const browseView = input.view === "all" || domain(input.view);
  const browse = browseView && value.read_semantics === "qualified_saved_latest";
  if (value.read_semantics !== undefined && value.read_semantics !== (browseView ? "qualified_saved_latest" : "strict_current")) throw new ImprintFailure("unknown");
  if (browse && typeof value.selection_complete !== "boolean") throw new ImprintFailure("unknown");
  const projectionUnknown = value.current_projection_unavailable === true || value.projection_rebuild_required === true;
  if (projectionUnknown && (!browse || value.selection_complete !== false)) throw new ImprintFailure("unknown");
  if (value.status !== "ok" || !Array.isArray(value.records) || !object(value.page)
    || typeof value.page.complete !== "boolean" || !(value.page.next_cursor === null || (Number.isSafeInteger(value.page.next_cursor) && Number(value.page.next_cursor) > input.cursor))) throw new ImprintFailure("unknown");
  const records = value.records.map(record => normalizeRecord(record, development));
  if (records.some(record => !record || !matchesProjection(record, input) || !validSearchEnvelope(record, input, contextId) || (development && (record.context_id !== contextId
    || !["canonical", "development"].includes(String(record.source_kind)) || (input.source_kind && record.source_kind !== input.source_kind))))) throw new ImprintFailure("unknown");
  if (input.id && records.length !== 1) throw new ImprintFailure("unknown");
  if (records.some(record => {
    if (!record) return true;
    const candidate = development && record.source_kind === "development" && record.source_semantics === "development_context"
      && record.authoritative === false && ["candidate", "qualification_unavailable"].includes(String(record.qualification))
      && ["UNKNOWN", "STALE", "HISTORY"].includes(record.record_currentness);
    if (candidate) return !browseView;
    if (development && !browseView && record.source_kind !== "canonical") return true;
    if (record.record_currentness === "CURRENT") return false;
    if (record.record_currentness === "HISTORY") return !(browse || input.include_history);
    return !(input.include_history && ["UNKNOWN", "STALE", "SHADOWED_BY_ACTIVE_EVENT", "NOT_CURRENT_FOR_EXECUTION"].includes(record.record_currentness) && record.authoritative === false);
  })) throw new ImprintFailure("unknown");
  try { return { records: uniqueRecords(records as ImprintRecord[]), page: { next_cursor: value.page.next_cursor as number | null, complete: value.page.complete },
    ...(object(value.coverage) ? { coverage: value.coverage } : {}), ...(value.read_semantics !== undefined ? { read_semantics: value.read_semantics as "qualified_saved_latest" | "strict_current" } : {}),
    ...(typeof value.selection_complete === "boolean" ? { selection_complete: value.selection_complete } : {}) }; }
  catch { throw new ImprintFailure("unknown"); }
}
export type SourceRead = { available: boolean; content: string | null; evidence: Json | null; segment: unknown; reason: string; historical: boolean; evidenceStatus: string; historicalRecordVersion?: number };
export async function readSource(rpc: NativeRpc, recordId: string, evidenceId: string, includeHistory = false, recordVersion?: number,
  options: NativeReadOptions = { isCurrent: () => true }, historicalRecordVersion?: number): Promise<SourceRead> {
  if (historicalRecordVersion !== undefined && (!includeHistory || !Number.isSafeInteger(historicalRecordVersion)
    || historicalRecordVersion < 1 || recordVersion === undefined || historicalRecordVersion >= recordVersion)) throw new ImprintFailure("unknown");
  return await callRead(rpc, "clued_imprint_source_v1", { p_input: { record_id: recordId, evidence_id: evidenceId,
    include_history: includeHistory, ...(recordVersion !== undefined ? { record_version: recordVersion } : {}),
    ...(historicalRecordVersion !== undefined ? { historical_record_version: historicalRecordVersion } : {}) } }, options, value => {
    const available = value.status === "available" || (value.status === "ok" && value.available === true);
    const unavailable = value.status === "unavailable" || (value.status === "ok" && value.available === false);
    if (!available && !unavailable) throw new ImprintFailure("unknown");
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 131072
      || (object(value.evidence) && value.evidence.id !== evidenceId)) throw new ImprintFailure("unknown");
    if (available && (value.record_id !== recordId || !object(value.evidence) || value.evidence.id !== evidenceId
      || value.complete !== true || typeof value.content !== "string"
      || value.authoritative !== false || value.current_input_eligible !== false)) throw new ImprintFailure("unknown");
    if (available && recordVersion !== undefined && value.record_version !== recordVersion) throw new ImprintFailure("unknown");
    const historical = value.source_semantics === "historical_evidence";
    if (available && historicalRecordVersion !== undefined && (!historical || value.historical_record_version !== historicalRecordVersion
      || value.source_record_version !== historicalRecordVersion)) throw new ImprintFailure("unknown");
    if (available && historical && (value.authoritative !== false || value.current_input_eligible !== false)) throw new ImprintFailure("unknown");
    if (available && (value.evidence_status === "withdrawn" || value.evidence_status === "invalidated")
      && (!includeHistory || !historical || value.authoritative !== false || value.current_input_eligible !== false)) throw new ImprintFailure("unknown");
    return { available, content: available && typeof value.content === "string" ? value.content : null,
      evidence: object(value.evidence) ? value.evidence : null, segment: value.segment ?? null,
      reason: typeof value.unavailable_reason === "string" ? value.unavailable_reason : "", historical,
      evidenceStatus: typeof value.evidence_status === "string" ? value.evidence_status : "",
      ...(historicalRecordVersion !== undefined ? { historicalRecordVersion } : {}) };
  });
}
export async function readRevision(rpc: NativeRpc, record: ImprintRecord, version: number, contextId?: string,
  options: NativeReadOptions = { isCurrent: () => true }): Promise<RevisionRead> {
  if (sourceKind(record) !== "canonical" || !Number.isSafeInteger(version) || version < 1 || version >= record.version
    || (contextId !== undefined && (!uuid(contextId) || record.context_id !== contextId))) throw new ImprintFailure("unknown");
  return await callRead(rpc, "clued_imprint_revision_read_v1", { p_input: { record_id: record.id, record_version: record.version,
    historical_record_version: version, scope: record.scope, ...(contextId !== undefined ? { context_id: contextId } : {}) } }, options, value => {
    if (value.status === "ok" && value.available === false && typeof value.unavailable_reason === "string")
      return { available: false, reason: value.unavailable_reason };
    if (!validRevisionRead(value, record, version, contextId)) throw new ImprintFailure("unknown");
    return { available: true, reason: "", record: value.record as RevisionRead["record"] };
  });
}
export type PreparedWrite = { input: Json; serialized: string; hash: string };
export async function prepareWrite(input: Json): Promise<PreparedWrite> {
  const serialized = JSON.stringify(input);
  const bytes = new TextEncoder().encode(serialized);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return { input: JSON.parse(serialized) as Json, serialized, hash: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("") };
}
export async function mutateRecord(rpc: NativeRpc, pending: PreparedWrite): Promise<{ receipt: string }> {
  const value = await call(rpc, "clued_user_record_mutate", { p_input: pending.input, p_received_payload_hash: pending.hash });
  if (value.status !== "committed" || typeof value.receipt_id !== "string" || !value.receipt_id) throw new ImprintFailure("unknown");
  return { receipt: value.receipt_id };
}
export function noteInput(id: string, key: string, scope: string, title: string, content: string): Json {
  return { operation: "create", id, idempotency_key: key, record_type: "note", record_schema_version: 1,
    lifecycle_status: "active", scope, authority: "user_explicit", user_confirmed: true, confidence: 1,
    confidence_reason: "Direct note saved by the signed-in owner", source_refs: [], source_unavailable_reason: "Direct entry in BeamingFace",
    mutation: { title: title.trim(), content, type_fields: { note_kind: "observation" }, relations: {} } };
}
export function taskDueInput(record: ImprintRecord, key: string, dueAt: string | null): Json {
  if (!canEditDue(record)) throw new ImprintFailure("unavailable", "terminal_or_noncurrent_task");
  return { operation: "update", id: record.id, idempotency_key: key, record_type: "task",
    record_schema_version: record.record_schema_version ?? 1, base_version: record.version, scope: record.scope,
    authority: "user_explicit", user_confirmed: true, confidence: 1, confidence_reason: "Due date edited by the signed-in owner",
    mutation: { type_fields: { due_at: dueAt } } };
}
export function organizationInput(record: ImprintRecord, domains: Domain[], key: string, contextId?: string): Json {
  if (contextId !== undefined && !sourceKind(record)) throw new ImprintFailure("unavailable", "missing_development_source_kind");
  return { record_id: record.id, record_version: record.version, base_version: record.organization_version,
    domains: normalizedDomains(domains), idempotency_key: key, ...(contextId !== undefined ? { context_id: contextId, source_kind: sourceKind(record) } : {}) };
}
export async function setOrganization(rpc: NativeRpc, pending: PreparedWrite, contextId?: string): Promise<{ receipt: string; domains: Domain[]; version: number }> {
  if (contextId !== undefined && (!uuid(contextId) || pending.input.context_id !== contextId)) throw new ImprintFailure("unavailable", "invalid_development_context");
  if (contextId === undefined && pending.input.context_id !== undefined) throw new ImprintFailure("unavailable", "wrong_namespace");
  const value = await call(rpc, contextId !== undefined ? "clued_development_imprint_organization_set_v1" : "clued_imprint_organization_set_v1", { p_input: pending.input, p_received_payload_hash: pending.hash });
  const supplemental = object(value.supplemental) ? value.supplemental : null;
  const org = supplemental && object(supplemental.organization) ? supplemental.organization : null;
  if (value.status !== "committed" || typeof value.receipt_id !== "string" || !value.receipt_id || !org
    || !uuid(org.record_id) || org.record_id.toLowerCase() !== pending.input.record_id || !Number.isSafeInteger(org.version)
    || !Array.isArray(org.domains) || !org.domains.every(domain)
    || JSON.stringify(normalizedDomains(org.domains)) !== JSON.stringify(pending.input.domains)) throw new ImprintFailure("unknown");
  return { receipt: value.receipt_id, domains: normalizedDomains(org.domains), version: Number(org.version) };
}

export async function setAssociation(rpc: NativeRpc, pending: PreparedWrite): Promise<{ receipt: string; changed: boolean }> {
  const value = await call(rpc, "clued_imprint_association_set_v1", { p_input: pending.input, p_received_payload_hash: pending.hash });
  const supplemental = object(value.supplemental) ? value.supplemental : null;
  const saved = supplemental && object(supplemental.association) ? supplemental.association : null;
  if (value.status !== "committed" || !uuid(value.receipt_id) || !saved || saved.record_id !== pending.input.record_id
    || saved.source_kind !== pending.input.source_kind || typeof saved.changed !== "boolean"
    || saved.version !== Number(pending.input.base_version) + (saved.changed ? 1 : 0)) throw new ImprintFailure("unknown");
  return { receipt: value.receipt_id, changed: saved.changed };
}
