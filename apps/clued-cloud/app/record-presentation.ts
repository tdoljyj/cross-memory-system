export type CluedRecord = {
  id: string;
  title?: string;
  content?: string;
  summary?: string;
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

export type PresentationLocale = "zh-CN" | "en";

type StructuredValue = Record<string, unknown> | unknown[];

const RECORD_SUMMARY_FIELDS = [
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

const LOG_SUMMARY_FIELDS = [
  "summary",
  "message",
  "result",
  "verification",
  "error",
] as const;

const ACTION_LABELS: Record<PresentationLocale, Record<string, string>> = {
  en: {
    merge_and_close_integrated_branches: "Merge and close integrated branches",
    record_closed: "Close record",
  },
  "zh-CN": {
    merge_and_close_integrated_branches: "合并并关闭集成分支",
    record_closed: "关闭记录",
  },
};

const STRUCTURED_LOG_LABELS: Record<PresentationLocale, string> = {
  en: "Structured log record",
  "zh-CN": "结构化日志记录",
};

function parseStructuredValue(value: string): StructuredValue | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object"
      ? parsed as StructuredValue
      : null;
  } catch {
    return null;
  }
}

function truncateSummary(value: string): string {
  const normalized = value.trim();
  return normalized.length > 240 ? `${normalized.slice(0, 237)}…` : normalized;
}

function summaryFromStructuredValue(value: StructuredValue): string | null {
  if (Array.isArray(value)) return null;

  for (const field of RECORD_SUMMARY_FIELDS) {
    const candidate = value[field];
    if (typeof candidate === "string" && candidate.trim()) return truncateSummary(candidate);
    if (typeof candidate === "number" || typeof candidate === "boolean") return String(candidate);
  }

  return null;
}

function readableScalars(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [truncateSummary(value)] : [];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(readableScalars);
  if (!value || typeof value !== "object") return [];

  const nested = value as Record<string, unknown>;
  return ["summary", "message", "result", "status", "error"]
    .flatMap((field) => readableScalars(nested[field]));
}

function structuredLogSummary(value: StructuredValue, fallback: string): string {
  if (Array.isArray(value)) return fallback;

  const lines: string[] = [];
  for (const field of LOG_SUMMARY_FIELDS) {
    for (const candidate of readableScalars(value[field])) {
      if (!lines.includes(candidate)) lines.push(candidate);
      if (lines.length === 3) return lines.join("\n");
    }
  }

  return lines.length > 0 ? lines.join("\n") : fallback;
}

function humanizeIdentifier(value: string): string {
  const normalized = value.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return normalized ? `${normalized[0].toUpperCase()}${normalized.slice(1)}` : value;
}

function actionLabel(value: string, locale: PresentationLocale): string {
  return ACTION_LABELS[locale][value.trim()] ?? humanizeIdentifier(value);
}

function structuredLogTitle(
  record: CluedRecord,
  value: StructuredValue,
  locale: PresentationLocale,
): string {
  if (record.title?.trim()) return record.title.trim();
  if (Array.isArray(value)) return STRUCTURED_LOG_LABELS[locale];

  const decision = value.decision;
  if (typeof decision === "string" && decision.trim()) return truncateSummary(decision);

  const action = value.action;
  if (typeof action === "string" && action.trim()) return actionLabel(action, locale);

  const eventType = value.canonical_event_type;
  if (typeof eventType === "string" && eventType.trim()) return actionLabel(eventType, locale);

  return STRUCTURED_LOG_LABELS[locale];
}

function stringifyStructuredValue(value: StructuredValue): string | null {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

function resolveLogSource(record: CluedRecord): {
  plainText: string | null;
  structuredValue: StructuredValue | null;
} {
  const source = record.content ?? record.body ?? record.payload ?? record.summary ?? "";
  if (typeof source === "string") {
    const structuredValue = parseStructuredValue(source);
    return structuredValue
      ? { plainText: null, structuredValue }
      : { plainText: source, structuredValue: null };
  }

  if (source !== null && typeof source === "object") {
    return { plainText: null, structuredValue: source as StructuredValue };
  }

  return { plainText: String(source), structuredValue: null };
}

export function presentCluedRecord(
  record: CluedRecord,
  fallbackTitle: string,
): CluedRecordPresentation {
  const conclusion = record.record_type === "log"
    ? record.content ?? record.body ?? (record.payload ? JSON.stringify(record.payload) : record.summary ?? "")
    : record.body ?? record.content ?? (record.payload ? JSON.stringify(record.payload) : record.summary ?? "");

  return {
    id: record.id,
    title: record.title ?? record.event_type ?? fallbackTitle,
    conclusion,
    status: record.status ?? record.record_type,
    version: record.version ?? null,
    updatedAt: record.updated_at,
  };
}

export function presentCluedRecordDisplay(
  record: CluedRecord,
  fallbackTitle: string,
  locale: PresentationLocale = "en",
): CluedRecordDisplay {
  const presentation = presentCluedRecord(record, fallbackTitle);

  if (record.record_type === "log") {
    const { plainText, structuredValue } = resolveLogSource(record);
    if (!structuredValue) {
      return {
        ...presentation,
        summary: plainText ?? presentation.conclusion,
        rawDetails: null,
      };
    }

    const fallback = STRUCTURED_LOG_LABELS[locale];
    return {
      ...presentation,
      title: structuredLogTitle(record, structuredValue, locale),
      summary: structuredLogSummary(structuredValue, fallback),
      rawDetails: stringifyStructuredValue(structuredValue),
    };
  }

  const structuredSource = record.body ?? record.content;
  const structuredValue = structuredSource
    ? parseStructuredValue(structuredSource)
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
    rawDetails: stringifyStructuredValue(structuredValue),
  };
}

export function formatCanonicalRecordReference(
  record: CluedRecord,
  fallbackTitle: string,
): string {
  const item = presentCluedRecord(record, fallbackTitle);
  return `- \`${item.id}\` — ${item.title}: ${item.conclusion} [status=${item.status}; version=${item.version ?? "n/a"}]`;
}
