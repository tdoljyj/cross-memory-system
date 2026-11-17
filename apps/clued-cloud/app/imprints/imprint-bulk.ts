import { call, ImprintFailure, prepareWrite, type NativeRpc } from "./imprint-client";
import { normalizedDomains, object, uuid, type Domain, type Json } from "./imprint-model";

export type BulkSelection = { scope: string; context_id?: string };
export type BulkItem = { record_id: string; record_version: number; domains: Domain[]; title?: string;
  state?: "pending" | "applied" | "conflict" | "undone" | "undo_conflict"; ordinal?: number;
  organization_version?: number | null; receipt_id?: string | null; undo_receipt_id?: string | null; error_code?: string | null };
export type BulkPreview = { digest: string; rules_version: string; selection: Json; proof: Json; counts: {
  total: number; characters: number; ineligible: number; protected: number; needs_review: number; ready: number;
  personal: number; profile: number; project: number; current: number; history: number; other_currentness: number;
  automatic_marked: number; manual_or_unspecified_marked: number; unmarked: number; ready_characters: number; review_characters: number };
  items: BulkItem[]; review_sample: { record_id: string; title: string }[] };
export type BulkBatch = { available: false } | { available: true; batch_id: string; version: number;
  state: "running" | "completed" | "cancelled"; selection: Json; rules_version: string; preview_digest: string; items: BulkItem[] };
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const digest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
function items(value: unknown, batch = false): BulkItem[] {
  if (!Array.isArray(value) || value.length > 100 || new Set(value.map(v => object(v) && v.record_id)).size !== value.length
    || value.some(v => !object(v) || !uuid(v.record_id) || !integer(v.record_version) || Number(v.record_version) < 1
      || !Array.isArray(v.domains) || !v.domains.length || JSON.stringify(normalizedDomains(v.domains)) !== JSON.stringify(v.domains)
      || (batch && (!integer(v.ordinal) || Number(v.ordinal) < 1 || Number(v.ordinal) > 100
        || !["pending", "applied", "conflict", "undone", "undo_conflict"].includes(String(v.state))
        || (["applied", "undone", "undo_conflict"].includes(String(v.state)) && (!uuid(v.receipt_id) || !integer(v.organization_version)))
        || (v.state === "undone" && !uuid(v.undo_receipt_id)))))) throw new ImprintFailure("unknown", "bulk_items_invalid");
  return value as BulkItem[];
}
export function validBulkBatch(value: unknown): BulkBatch {
  if (!object(value) || typeof value.available !== "boolean") throw new ImprintFailure("unknown");
  if (!value.available) return { available: false };
  if (!uuid(value.batch_id) || !integer(value.version) || Number(value.version) < 1
    || !["running", "completed", "cancelled"].includes(String(value.state)) || !object(value.selection)
    || value.rules_version !== "imprint-explicit-local.v2" || !digest(value.preview_digest)) throw new ImprintFailure("unknown");
  const rows = items(value.items, true);
  if (!rows.length || new Set(rows.map(row => row.ordinal)).size !== rows.length) throw new ImprintFailure("unknown");
  return { ...value, items: rows } as BulkBatch;
}
export async function previewBulk(rpc: NativeRpc, selection: BulkSelection, options: {
  owner: string; isCurrent: () => boolean; onProgress?: (scanned: number, total: number, ready: number) => void;
}): Promise<BulkPreview> {
  const pageSize = 16;
  let cursor = 0, proof: Json | undefined, baseline = "", inventoryDigest = "", effectiveSelection: Json | null = null;
  let ready = 0, review = 0, readyCharacters = 0, reviewCharacters = 0;
  const seen = new Set<string>(), planned: BulkItem[] = [], samples: { record_id: string; title: string }[] = [];
  const identities = (rows: BulkItem[]) => JSON.stringify(rows.map(row => [row.record_id, row.record_version, row.domains]));
  let timeoutRetries = 0;
  // A failed read has not advanced the signed chain. Retry only PostgreSQL's
  // statement timeout, with the exact same request and a bounded scan budget.
  // Semantic conflicts, transport uncertainty and all writes remain single-shot.
  const previewRpc: NativeRpc = async (name, args) => {
    for (let attempt = 0; ; attempt++) {
      if (!options.isCurrent()) throw new ImprintFailure("unknown", "bulk_selection_changed");
      const result = await rpc(name, args);
      if (!options.isCurrent()) throw new ImprintFailure("unknown", "bulk_selection_changed");
      if (result.error?.code !== "57014" || attempt >= 2 || timeoutRetries >= 6) return result;
      timeoutRetries++;
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  };
  // The bound fails explicitly rather than silently claiming a complete scan.
  for (let page = 0; page < 10000; page++) {
    if (!options.isCurrent()) throw new ImprintFailure("unknown", "bulk_selection_changed");
    let value: Json;
    try { value = await call(previewRpc, "clued_imprint_bulk_preview_v1", { p_input: { ...selection, page_size: pageSize, ...(proof ? { proof } : {}) } }); }
    catch (failure) {
      if (failure instanceof ImprintFailure && ["bulk_preview_changed", "bulk_proof_expired"].includes(failure.code))
        throw new ImprintFailure("conflict", failure.code);
      throw failure;
    }
    if (!options.isCurrent()) throw new ImprintFailure("unknown", "bulk_selection_changed");
    if (value.status !== "ok" || value.authoritative !== false || value.max_batch_size !== 100 || !digest(value.digest)
      || value.rules_version !== "imprint-explicit-local.v2" || !object(value.selection) || !object(value.page)
      || !object(value.inventory_counts) || !object(value.proof) || !digest(value.proof.mac) || !object(value.proof.payload))
      throw new ImprintFailure("unknown");
    const base = value.inventory_counts;
    const keys = ["total", "characters", "ineligible", "protected", "classifiable", "personal", "profile", "project", "current", "history",
      "other_currentness", "automatic_marked", "manual_or_unspecified_marked", "unmarked"];
    if (keys.some(k => !integer(base[k])) || base.total !== Number(base.ineligible) + Number(base.protected) + Number(base.classifiable)
      || base.total !== Number(base.personal) + Number(base.profile) + Number(base.project)
      || base.total !== Number(base.current) + Number(base.history) + Number(base.other_currentness)
      || base.total !== Number(base.automatic_marked) + Number(base.manual_or_unspecified_marked) + Number(base.unmarked)) throw new ImprintFailure("unknown");
    const signature = JSON.stringify(keys.map(k => base[k]));
    if (selection.context_id ? value.selection.context_id !== selection.context_id || !uuid(value.selection.context_id)
      || !["test", "preview", "production"].includes(String(value.selection.environment))
      || (selection.scope !== "all" && selection.scope !== value.selection.scope)
      : value.selection.scope !== selection.scope || value.selection.context_id !== undefined) throw new ImprintFailure("unknown");
    if (page === 0) { baseline = signature; inventoryDigest = value.digest; effectiveSelection = value.selection; }
    else if (baseline !== signature || inventoryDigest !== value.digest || JSON.stringify(value.selection) !== JSON.stringify(effectiveSelection)) throw new ImprintFailure("unknown", "bulk_preview_changed");
    const rows = items(value.items);
    if (!Array.isArray(value.review_sample) || value.review_sample.some(row => !object(row) || !uuid(row.record_id) || typeof row.title !== "string")
      || rows.length + value.review_sample.length > pageSize || !integer(value.ready_characters) || !integer(value.review_characters)
      || value.page.cursor !== cursor || value.page.scanned !== rows.length + value.review_sample.length
      || !integer(value.page.scanned) || (cursor < Number(base.classifiable)
        ? Number(value.page.scanned) < 1 || Number(value.page.scanned) > Math.min(pageSize, Number(base.classifiable) - cursor)
        : value.page.scanned !== 0)) throw new ImprintFailure("unknown");
    const visited = [...rows.map(row => row.record_id), ...value.review_sample.map(row => (row as { record_id: string }).record_id)];
    if (visited.some(id => seen.has(id)) || new Set(visited).size !== visited.length) throw new ImprintFailure("unknown", "bulk_duplicate_page");
    visited.forEach(id => seen.add(id));
    cursor += Number(value.page.scanned); ready += rows.length; review += value.review_sample.length;
    readyCharacters += Number(value.ready_characters); reviewCharacters += Number(value.review_characters);
    planned.push(...rows.slice(0, Math.max(0, 100 - planned.length)));
    samples.push(...(value.review_sample as { record_id: string; title: string }[]).slice(0, Math.max(0, 20 - samples.length)));
    const complete = cursor === Number(base.classifiable);
    if (value.page.complete !== complete || value.page.next_cursor !== (complete ? null : cursor)
      || readyCharacters + reviewCharacters > Number(base.characters)) throw new ImprintFailure("unknown");
    const chain = value.proof.payload;
    if (chain.owner_id !== options.owner || chain.digest !== inventoryDigest || chain.rules_version !== value.rules_version
      || JSON.stringify(chain.selection) !== JSON.stringify(effectiveSelection) || chain.cursor !== cursor || chain.classifiable !== base.classifiable
      || chain.ready !== ready || chain.needs_review !== review || chain.ready_characters !== readyCharacters || chain.review_characters !== reviewCharacters
      || typeof chain.expires_at !== "string" || !Number.isFinite(Date.parse(chain.expires_at)) || Date.parse(chain.expires_at) <= Date.now()
      || identities(items(chain.items)) !== identities(planned)) throw new ImprintFailure("unknown", "bulk_proof_mismatch");
    proof = value.proof;
    options.onProgress?.(cursor, Number(base.classifiable), ready);
    if (complete) return { digest: inventoryDigest, rules_version: value.rules_version, selection: effectiveSelection!, proof,
      counts: { ...base, ready, needs_review: review, ready_characters: readyCharacters, review_characters: reviewCharacters } as BulkPreview["counts"], items: planned, review_sample: samples };
  }
  throw new ImprintFailure("unknown", "bulk_preview_limit_incomplete");
}
export async function readBulk(rpc: NativeRpc): Promise<BulkBatch> {
  const value = await call(rpc, "clued_imprint_bulk_status_v1", {});
  if (value.status !== "ok") throw new ImprintFailure("unknown");
  return validBulkBatch(value);
}
export async function writeBulk(rpc: NativeRpc, action: "begin" | "advance" | "cancel" | "undo",
  input: { selection: BulkSelection; digest: string; proof: Json; items: BulkItem[] } | { batch_id: string; base_version: number }, key: string,
  isCurrent: () => boolean = () => true): Promise<BulkBatch> {
  const prepared = await prepareWrite({ ...input, action, idempotency_key: key });
  if (!isCurrent()) throw new ImprintFailure("unknown", "bulk_selection_changed");
  const result = await call(rpc, "clued_imprint_bulk_mutate_v1", { p_input: prepared.input, p_received_payload_hash: prepared.hash });
  if (result.status !== "committed" || !uuid(result.receipt_id) || !object(result.supplemental)) throw new ImprintFailure("unknown");
  return validBulkBatch(result.supplemental.batch);
}
export function bulkCounts(batch: BulkBatch): Record<string, number> {
  const result = { pending: 0, applied: 0, conflict: 0, undone: 0, undo_conflict: 0 };
  if (batch.available) for (const item of batch.items) result[item.state!]++;
  return result;
}
