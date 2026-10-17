import { canEditDue, object, positive, recordIdentity, sourceKind, uuid,
  type ImprintRecord, type Json } from "./imprint-model";
import { ImprintFailure, readImprints, type NativeRpc } from "./imprint-client";
import type { NativeReadOptions } from "../native-read-recovery";

export type Association = { record_id: string; source_kind: "canonical"; record_type: "task" | "decision";
  record_version: number; current_version: number; title: string };
export type AssociationMatch = { record: ImprintRecord; reason: "identity" | "title" | "terms" | "search"; score: number };
export type AssociationMatches = { matches: AssociationMatch[]; complete: boolean };
export type AssociationRead = { scope: string; recordType: "task" | "decision" };

export function associations(record: ImprintRecord): Association[] {
  if (!Array.isArray(record.associations)) return [];
  return record.associations.filter((value): value is Association => object(value) && uuid(value.record_id)
    && value.source_kind === "canonical" && ["task", "decision"].includes(String(value.record_type))
    && positive(value.record_version) && positive(value.current_version) && typeof value.title === "string");
}
export function canAssociate(record: ImprintRecord): boolean {
  if (!Number.isSafeInteger(record.association_version) || Number(record.association_version) < 0
    || !Array.isArray(record.associations)) return false;
  if (sourceKind(record) === "development") return record.lifecycle_status === "ACTIVE"
    && record.record_currentness === "UNKNOWN" && uuid(record.context_id);
  return record.record_schema_version === 1 && record.lifecycle_status === "active"
    && record.record_currentness === "CURRENT" && record.authoritative === true;
}
export function eligibleAssociationTarget(source: ImprintRecord, target: ImprintRecord, contextId?: string): boolean {
  return recordIdentity(source) !== recordIdentity(target) && target.scope === source.scope
    && sourceKind(target) !== "development" && target.record_schema_version === 1
    && target.lifecycle_status === "active" && target.record_currentness === "CURRENT" && target.authoritative === true
    && (canEditDue(target) || target.record_type === "decision")
    && (contextId === undefined || target.context_id === contextId);
}
const folded = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
const GENERIC = new Set(["任务", "记录", "印记", "测试", "验收", "方案", "内容", "今天", "我们", "这个", "the", "and", "for", "with", "task", "note", "test"]);
function terms(text: string): Set<string> {
  const found = new Set<string>();
  for (const word of text.normalize("NFKC").toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}|[\p{Script=Han}]+/gu) ?? []) {
    if (/^[\p{Script=Han}]+$/u.test(word)) {
      const chars = [...word]; for (let i = 0; i + 1 < chars.length; i++) found.add(chars[i] + chars[i + 1]);
    } else found.add(word);
  }
  for (const word of GENERIC) found.delete(word);
  return found;
}
/** Text overlap is a suggestion, never semantic identity or execution authority. */
export function rankAssociationMatches(source: ImprintRecord, targets: ImprintRecord[], query = "", contextId?: string): AssociationMatch[] {
  const body = source.title + "\n" + source.content, normalized = folded(body), sourceTerms = terms(body);
  return targets.filter(target => eligibleAssociationTarget(source, target, contextId)).flatMap(target => {
    const title = folded(target.title), shared = [...terms(target.title)].filter(term => sourceTerms.has(term));
    const reason = body.toLowerCase().includes(target.id) ? "identity" : title.length >= 4 && normalized.includes(title) ? "title"
      : shared.length >= 2 ? "terms" : query.trim() ? "search" : null;
    if (!reason) return [];
    return [{ record: target, reason, score: reason === "identity" ? 1000 : reason === "title" ? 500 : shared.length } satisfies AssociationMatch];
  }).sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id));
}
/** Existing strict-current readers do the authorization and scope filtering. */
export async function findExistingAssociations(rpc: NativeRpc, source: ImprintRecord, query: string, contextId: string | undefined,
  options: NativeReadOptions): Promise<AssociationMatches> {
  if (!canAssociate(source)) throw new ImprintFailure("unavailable", "association_source_unavailable");
  if (contextId !== undefined && (source.context_id !== contextId || !uuid(contextId))) throw new ImprintFailure("unavailable", "invalid_development_context");
  const targets: ImprintRecord[] = []; let complete = true;
  for (const view of ["task", "decision"] as const) {
    let cursor = 0;
    for (let page = 0; page < 2; page++) {
      if (!options.isCurrent()) throw new ImprintFailure("unknown", "read_interrupted");
      const result = await readImprints(rpc, { view, scope: source.scope, query: query.trim(), include_history: false,
        limit: 30, cursor, ...(contextId ? { source_kind: "canonical" as const } : {}) }, contextId, options);
      targets.push(...result.records);
      if (result.selection_complete === false) complete = false;
      if (result.page.complete) break;
      if (page === 1 || result.page.next_cursor === null) { complete = false; break; }
      cursor = result.page.next_cursor;
    }
  }
  const unique = new Map<string, ImprintRecord>();
  for (const target of targets) {
    const prior = unique.get(recordIdentity(target));
    if (prior && JSON.stringify(prior) !== JSON.stringify(target)) throw new ImprintFailure("unknown", "association_candidate_changed");
    unique.set(recordIdentity(target), target);
  }
  const matches = rankAssociationMatches(source, [...unique.values()], query, contextId);
  return { matches: matches.slice(0, 20), complete: complete && matches.length <= 20 };
}
export function associationInput(source: ImprintRecord, target: ImprintRecord | Association, action: "add" | "remove", key: string,
  contextId?: string): Json {
  if (!canAssociate(source)) throw new ImprintFailure("unavailable", "association_source_unavailable");
  if (contextId !== undefined && (source.context_id !== contextId || !uuid(contextId))) throw new ImprintFailure("unavailable", "invalid_development_context");
  if (action === "add" && (!("id" in target) || !eligibleAssociationTarget(source, target as ImprintRecord, contextId)))
    throw new ImprintFailure("unavailable", "association_target_unavailable");
  const targetId = "record_id" in target ? target.record_id : target.id;
  if (!uuid(targetId) || (action === "remove" && !associations(source).some(value => value.record_id === targetId)))
    throw new ImprintFailure("unavailable", "association_target_unavailable");
  return { record_id: source.id, record_version: source.version, base_version: source.association_version,
    source_kind: sourceKind(source) ?? "canonical", action, target_id: targetId, idempotency_key: key,
    ...(action === "add" ? { target_version: "id" in target ? target.version : target.current_version } : {}),
    ...(contextId ? { context_id: contextId, environment: source.environment } : {}) };
}
