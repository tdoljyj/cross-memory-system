export type CluedRecord = {
  id: string;
  title?: string;
  body?: string;
  record_type: "state" | "task" | "decision" | "archive" | "log" | "note";
  status?: string;
  version?: number;
  project_id?: string | null;
  effective_project_id?: string | null;
  event_type?: string;
  payload?: Record<string, unknown>;
  updated_at: string;
};

export type CluedRecordPresentation = {
  id: string;
  title: string;
  conclusion: string;
  status: string;
  version: number | null;
  updatedAt: string;
};

export type CluedRecordDisplay = CluedRecordPresentation & {
  summary: string;
  rawDetails: string | null;
};

const SUMMARY_FIELDS = [
  "summary",
  "message",
  "user_message",
  "decision",
  "action",
  "canonical_event_type",
  "event_type",
  "title",
  "description",
] as const;

function parseStructuredValue(value: string): Record<string, unknown> | unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object"
      ? parsed as Record<string, unknown> | unknown[]
      : null;
  } catch {
    return null;
  }
}

function truncateSummary(value: string): string {
  const normalized = value.trim();
  return normalized.length > 240 ? `${normalized.slice(0, 237)}…` : normalized;
}

function summaryFromStructuredValue(value: Record<string, unknown> | unknown[]): string | null {
  if (Array.isArray(value)) return null;

  for (const field of SUMMARY_FIELDS) {
    const candidate = value[field];
    if (typeof candidate === "string" && candidate.trim()) return truncateSummary(candidate);
    if (typeof candidate === "number" || typeof candidate === "boolean") return String(candidate);
  }

  return null;
}

export function presentCluedRecord(
  record: CluedRecord,
  fallbackTitle: string,
): CluedRecordPresentation {
  return {
    id: record.id,
    title: record.title ?? record.event_type ?? fallbackTitle,
    conclusion: record.body ?? (record.payload ? JSON.stringify(record.payload) : ""),
    status: record.status ?? record.record_type,
    version: record.version ?? null,
    updatedAt: record.updated_at,
  };
}

export function presentCluedRecordDisplay(
  record: CluedRecord,
  fallbackTitle: string,
): CluedRecordDisplay {
  const presentation = presentCluedRecord(record, fallbackTitle);
  const structuredValue = record.body
    ? parseStructuredValue(record.body)
    : record.payload ?? null;

  if (!structuredValue) {
    return {
      ...presentation,
      summary: presentation.conclusion,
      rawDetails: null,
    };
  }

  return {
    ...presentation,
    summary: summaryFromStructuredValue(structuredValue) ?? presentation.title,
    rawDetails: JSON.stringify(structuredValue, null, 2),
  };
}

export function formatCanonicalRecordReference(
  record: CluedRecord,
  fallbackTitle: string,
): string {
  const item = presentCluedRecord(record, fallbackTitle);
  return `- \`${item.id}\` — ${item.title}: ${item.conclusion} [status=${item.status}; version=${item.version ?? "n/a"}]`;
}
