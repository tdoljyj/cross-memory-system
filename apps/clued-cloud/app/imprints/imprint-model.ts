export const DOMAIN_KEYS = ["daily", "work", "learning", "creation", "interest"] as const;
export const VIEW_KEYS = ["all", "task", "decision", ...DOMAIN_KEYS] as const;
export const RECORD_TYPES = ["task", "decision", "note", "state", "profile_fact"] as const;
export type Domain = typeof DOMAIN_KEYS[number];
export type ImprintView = typeof VIEW_KEYS[number];
export type RecordType = typeof RECORD_TYPES[number];
export type Locale = "zh-CN" | "en";
export type Json = Record<string, unknown>;
export type ImprintRecord = Json & {
  id: string; title: string; content: string; record_type: string; scope: string;
  version: number; lifecycle_status: string | null; domains: Domain[]; organization_version: number;
  record_currentness: string; type_fields: Json; relations: Json; source_refs: unknown[];
  legacy_missing_fields?: Json;
  authoritative?: boolean;
};
export type ReadInput = {
  view: ImprintView; scope: string; query: string; include_history: boolean;
  record_type?: string; domains?: Domain[]; limit: number; cursor: number; id?: string; context_id?: string; source_kind?: "canonical" | "development";
};
export type ReadPage = { records: ImprintRecord[]; page: { next_cursor: number | null; complete: boolean }; coverage?: Json;
  read_semantics?: "qualified_saved_latest" | "strict_current"; selection_complete?: boolean };
export const VIEW_LABELS: Record<Locale, Record<ImprintView, string>> = {
  "zh-CN": { all: "全部", task: "任务", decision: "决策", daily: "日常", work: "工作", learning: "学习", creation: "创作", interest: "兴趣" },
  en: { all: "All", task: "Tasks", decision: "Decisions", daily: "Daily life", work: "Work", learning: "Learning", creation: "Creation", interest: "Interests" },
};
export const object = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
export const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
export const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export const domain = (value: unknown): value is Domain => typeof value === "string" && (DOMAIN_KEYS as readonly string[]).includes(value);
export const recordType = (value: unknown): value is RecordType => typeof value === "string" && (RECORD_TYPES as readonly string[]).includes(value);
export function normalizedDomains(values: readonly Domain[]): Domain[] { return DOMAIN_KEYS.filter(key => values.includes(key)); }
export function recordScope(value: Json): string {
  const scope = value.canonical_scope ?? value.scope;
  if (scope === "project" && uuid(value.project_id)) return "project:" + value.project_id.toLowerCase();
  return typeof scope === "string" ? scope : "";
}
export function validScope(value: string, all = false): boolean {
  return (all && value === "all") || value === "global" || value === "profile" || (value.startsWith("project:") && uuid(value.slice(8)));
}
export function normalizeRecord(value: unknown, development = false): ImprintRecord | null {
  const legacy = object(value) && value.source_semantics === "legacy_compatibility";
  if (!object(value) || !uuid(value.id) || typeof value.title !== "string" || typeof value.content !== "string"
    || !(development ? typeof value.record_type === "string" && value.record_type.trim().length > 0 : recordType(value.record_type))
    || !positive(value.version) || !validScope(recordScope(value))
    || !(typeof value.lifecycle_status === "string" || (legacy && value.lifecycle_status === null)) || typeof value.record_currentness !== "string"
    || !Array.isArray(value.domains) || !value.domains.every(domain) || !nonnegative(value.organization_version)
    || !(object(value.type_fields) || ((legacy || development) && value.type_fields == null))
    || !(object(value.relations) || ((legacy || development) && value.relations == null))
    || !(Array.isArray(value.source_refs) || ((legacy || development) && value.source_refs == null))) return null;
  return { ...value, id: value.id.toLowerCase(), scope: recordScope(value), domains: normalizedDomains(value.domains),
    title: value.title, content: value.content, record_type: value.record_type as string, version: value.version,
    lifecycle_status: value.lifecycle_status as string | null, organization_version: value.organization_version,
    record_currentness: value.record_currentness, type_fields: object(value.type_fields) ? value.type_fields : {},
    relations: object(value.relations) ? value.relations : {}, source_refs: Array.isArray(value.source_refs) ? value.source_refs : [],
    ...(legacy ? { legacy_missing_fields: { lifecycle_status: value.lifecycle_status, type_fields: value.type_fields,
      relations: value.relations, source_refs: value.source_refs, record_schema_version: value.record_schema_version ?? null } } : {}) };
}
export function matchesProjection(record: ImprintRecord, input: ReadInput): boolean {
  if (input.id) return record.id === input.id.toLowerCase();
  if (input.scope !== "all" && record.scope !== input.scope) return false;
  if (input.view === "task" || input.view === "decision") { if (record.record_type !== input.view) return false; }
  else if (domain(input.view) && !record.domains.includes(input.view)) return false;
  return (!input.record_type || record.record_type === input.record_type) && (input.domains ?? []).every(key => record.domains.includes(key));
}
// Repeated entrances reference one identity. Different bodies for one ID are an
// invalid envelope; choosing a newer timestamp would invent Current Truth.
export function uniqueRecords(records: ImprintRecord[]): ImprintRecord[] {
  const found = new Map<string, ImprintRecord>();
  for (const record of records) {
    const identity = recordIdentity(record);
    const prior = found.get(identity);
    if (prior && JSON.stringify(prior) !== JSON.stringify(record)) throw new Error("ambiguous_record_identity");
    if (!prior) found.set(identity, record);
  }
  return [...found.values()];
}
export function recordIdentity(record: ImprintRecord): string { return (sourceKind(record) ?? "canonical") + ":" + record.id; }
export function sourceKind(record: ImprintRecord): "canonical" | "development" | null {
  if (record.source_kind === "canonical" || record.source_kind === "development") return record.source_kind;
  if (record.source_semantics === "canonical_record" || record.source_semantics === "legacy_compatibility") return "canonical";
  if (record.source_semantics === "development_context") return "development";
  return null;
}
export function canEditDue(record: ImprintRecord): boolean {
  return record.record_type === "task" && record.record_schema_version === 1 && record.lifecycle_status === "active" && record.record_currentness === "CURRENT";
}
// This panel reads typed Records. Event carriers have their own authority
// contract and are never accepted by applying this Record predicate.
export function immediateAuthoritativeRecord(record: ImprintRecord): boolean {
  return record.authoritative === true && record.record_currentness === "CURRENT"
    && sourceKind(record) !== "development" && record.source_semantics !== "legacy_compatibility"
    && recordType(record.record_type);
}
export function evidenceReferences(record: ImprintRecord): string[] {
  return [...new Set(record.source_refs.flatMap(ref => uuid(ref) ? [ref.toLowerCase()]
    : object(ref) && uuid(ref.evidence_id ?? ref.id) ? [String(ref.evidence_id ?? ref.id).toLowerCase()] : []))];
}
export function relatedReferences(record: ImprintRecord): string[] {
  return [...new Set(Object.values(record.relations).flatMap(value => (Array.isArray(value) ? value : [value])
    .flatMap(ref => uuid(ref) ? [ref.toLowerCase()] : object(ref) && uuid(ref.record_id ?? ref.id)
      ? [String(ref.record_id ?? ref.id).toLowerCase()] : [])))];
}
export function beijingInput(iso: unknown): string {
  if (typeof iso !== "string" || !Number.isFinite(Date.parse(iso))) return "";
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const part = (key: string) => parts.find(item => item.type === key)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}
export function dueIso(input: string): string | null {
  if (!input) return null;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(input)) throw new Error("invalid_due_at");
  const date = new Date(input + ":00+08:00");
  if (!Number.isFinite(date.getTime()) || beijingInput(date.toISOString()) !== input) throw new Error("invalid_due_at");
  return date.toISOString();
}
export class SelectionFence {
  private selection: object | null = null;
  private generations = new Map<string, number>();
  select(selection: object) { this.selection = selection; }
  selected(selection: object): boolean { return this.selection === selection; }
  begin(lane: string) {
    const generation = (this.generations.get(lane) ?? 0) + 1;
    this.generations.set(lane, generation);
    return { selection: this.selection, generation, lane };
  }
  current(ticket: ReturnType<SelectionFence["begin"]>): boolean {
    return ticket.selection === this.selection && ticket.generation === this.generations.get(ticket.lane);
  }
}
