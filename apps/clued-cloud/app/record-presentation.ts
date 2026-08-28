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

export type LogTone = "success" | "blocked" | "error" | "neutral";

export type LogDetailLine = { label: string; value: string };

export type LogPresentation = {
  title: string;
  summary: string;
  tone: LogTone;
  tags: string[];
  evidence: LogDetailLine[];
  metadata: LogDetailLine[];
  rawDetails: string;
};

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
  "reason",
] as const;

const NESTED_SUMMARY_FIELDS = [
  "summary",
  "message",
  "result",
  "status",
  "error",
  "reason",
  "production",
  "production_impact",
  "impact",
  "note",
] as const;

const MAX_SUMMARY_LINES = 3;
const MAX_ARRAY_RESULTS = 3;
const MAX_TAGS = 4;

const ACTION_LABELS: Record<PresentationLocale, Record<string, string>> = {
  en: {
    merge_and_close_integrated_branches: "Merge and close integrated branches",
    merge_and_close_integration_branch: "Merge and close integration branch",
    record_closed: "Close record",
    production_deployment_completed: "Readable log version deployed",
    production_deployment_blocked: "Cloudflare deployment not executed",
  },
  "zh-CN": {
    merge_and_close_integrated_branches: "合并并关闭集成分支",
    merge_and_close_integration_branch: "合并并关闭集成分支",
    record_closed: "关闭记录",
    production_deployment_completed: "日志可读化版本已部署",
    production_deployment_blocked: "Cloudflare 部署未执行",
  },
};

const TITLE_PLACEHOLDERS = new Set([
  "结构化日志记录",
  "操作日志",
  "系统日志",
  "structured log record",
  "structured log",
  "operation log",
  "system log",
]);

const EXPLICIT_STATUS_TOKENS: Record<
  string,
  { tone: LogTone; en: string; "zh-CN": string }
> = {
  PASS: { tone: "success", en: "Passed", "zh-CN": "成功" },
  SUCCESS: { tone: "success", en: "Succeeded", "zh-CN": "成功" },
  COMPLETED: { tone: "success", en: "Completed", "zh-CN": "完成" },
  BLOCKED: { tone: "blocked", en: "Blocked", "zh-CN": "已阻断" },
  PAUSED: { tone: "blocked", en: "Paused", "zh-CN": "已暂停" },
  FAILED: { tone: "error", en: "Failed", "zh-CN": "失败" },
  ERROR: { tone: "error", en: "Error", "zh-CN": "失败" },
};

const LOG_CARD_COPY: Record<
  PresentationLocale,
  {
    systemEvent: string;
    noSummary: string;
    canonicalId: string;
    status: string;
    statusUnknown: string;
    version: string;
    versionMissing: string;
    recordType: string;
    updatedAt: string;
    zeroWrite: string;
    yes: string;
  }
> = {
  en: {
    systemEvent: "System event",
    noSummary: "No readable summary. Expand to view the raw record.",
    canonicalId: "Canonical ID",
    status: "Status",
    statusUnknown: "Not recorded",
    version: "Version",
    versionMissing: "Not recorded (the original record carries no version number)",
    recordType: "Record type",
    updatedAt: "Updated at",
    zeroWrite: "Zero write",
    yes: "Yes",
  },
  "zh-CN": {
    systemEvent: "系统事件",
    noSummary: "暂无可读摘要，请展开查看原始记录",
    canonicalId: "Canonical ID",
    status: "状态",
    statusUnknown: "未记录",
    version: "版本",
    versionMissing: "未记录（原记录未提供版本号）",
    recordType: "记录类型",
    updatedAt: "更新时间",
    zeroWrite: "零写入",
    yes: "是",
  },
};

const EVIDENCE_FIELDS: ReadonlyArray<readonly [string, string, string]> = [
  ["verification", "验证结果", "Verification"],
  ["version_id", "版本 ID", "Version ID"],
  ["worker_version", "Worker 版本", "Worker version"],
  ["deployment_id", "部署 ID", "Deployment ID"],
  ["rollback_version", "回退版本", "Rollback version"],
  ["previous_version", "上一版本", "Previous version"],
  ["authorization_type", "授权类型", "Authorization type"],
  ["authority", "授权来源", "Authority"],
  ["receipt", "回执", "Receipt"],
  ["sha", "提交 SHA", "Commit SHA"],
  ["remote_main", "远端 main", "Remote main"],
  ["url", "链接", "URL"],
  ["path", "路径", "Path"],
  ["error", "错误", "Error"],
  ["reason", "原因", "Reason"],
];

const ZERO_WRITE_KEYS = ["zero_write", "zero_writes", "zero_write_verified"] as const;

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

function normalizeStatusToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim().toUpperCase().replace(/[-\s]+/g, "_");
  return Object.prototype.hasOwnProperty.call(EXPLICIT_STATUS_TOKENS, token) ? token : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Status comes only from explicit status fields. Missing status stays neutral. */
function resolveExplicitStatus(
  record: CluedRecord,
  value: StructuredValue | null,
  locale: PresentationLocale,
): { token: string; tone: LogTone; label: string } | null {
  const root = asRecord(value);
  const verification = root ? asRecord(root.verification) : null;

  const candidates: unknown[] = [
    record.status,
    root?.status,
    verification?.status,
    root?.result,
  ];

  for (const candidate of candidates) {
    const token = normalizeStatusToken(candidate);
    if (token) {
      const entry = EXPLICIT_STATUS_TOKENS[token];
      return { token, tone: entry.tone, label: entry[locale] };
    }
  }

  return null;
}

function readableLines(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [truncateSummary(value)] : [];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (value === null || value === undefined) return [];

  if (Array.isArray(value)) {
    const lines: string[] = [];
    for (const entry of value) {
      for (const line of readableLines(entry)) {
        if (normalizeStatusToken(line)) continue;
        lines.push(line);
        if (lines.length >= MAX_ARRAY_RESULTS) return lines;
      }
    }
    return lines;
  }

  const nested = asRecord(value);
  if (!nested) return [];

  const lines: string[] = [];
  for (const field of NESTED_SUMMARY_FIELDS) {
    for (const line of readableLines(nested[field])) {
      if (normalizeStatusToken(line)) continue;
      lines.push(line);
    }
  }
  return lines;
}

function logSummaryLines(value: StructuredValue): string[] {
  if (Array.isArray(value)) return readableLines(value);

  const lines: string[] = [];
  for (const field of LOG_SUMMARY_FIELDS) {
    for (const line of readableLines(value[field])) {
      if (!lines.includes(line)) lines.push(line);
      if (lines.length >= MAX_SUMMARY_LINES) return lines;
    }
  }
  return lines;
}

function humanizeIdentifier(value: string): string {
  const spaced = value.trim().replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const normalized = spaced.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return value.trim();
  return `${normalized[0].toUpperCase()}${normalized.slice(1)}`;
}

function actionLabel(value: string, locale: PresentationLocale): string {
  const key = value.trim();
  return ACTION_LABELS[locale][key] ?? humanizeIdentifier(key);
}

function isTitlePlaceholder(value: string): boolean {
  return TITLE_PLACEHOLDERS.has(value.trim().toLowerCase());
}

function eventTypeOf(
  record: CluedRecord,
  value: StructuredValue | null,
): string | null {
  const root = asRecord(value);
  const candidate =
    root?.canonical_event_type ?? root?.event_type ?? record.event_type;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

/**
 * Title priority: explicit title -> decision -> action -> event type -> system event.
 * Placeholder titles listed in TITLE_PLACEHOLDERS are never accepted.
 */
function resolveLogTitle(
  record: CluedRecord,
  value: StructuredValue | null,
  locale: PresentationLocale,
): string {
  const copy = LOG_CARD_COPY[locale];
  const root = asRecord(value);

  const candidates: string[] = [];
  if (record.title?.trim()) candidates.push(truncateSummary(record.title));
  if (root && typeof root.decision === "string" && root.decision.trim()) {
    candidates.push(truncateSummary(root.decision));
  }
  if (root && typeof root.action === "string" && root.action.trim()) {
    candidates.push(actionLabel(root.action, locale));
  }
  const eventType = eventTypeOf(record, value);
  if (eventType) candidates.push(actionLabel(eventType, locale));

  for (const candidate of candidates) {
    if (!candidate.trim()) continue;
    if (isTitlePlaceholder(candidate)) continue;
    return candidate;
  }

  return copy.systemEvent;
}

function buildTags(
  record: CluedRecord,
  value: StructuredValue | null,
  status: { tone: LogTone; label: string } | null,
): string[] {
  const tags: string[] = [];

  const eventType = eventTypeOf(record, value);
  if (eventType) tags.push(eventType);

  if (status) tags.push(status.label);

  tags.push(`ID ${record.id}`);

  if (record.version !== null && record.version !== undefined) {
    tags.push(`v${record.version}`);
  }

  return tags.slice(0, MAX_TAGS);
}

function detailValueText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? value.trim() : null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    const parts = value
      .map(detailValueText)
      .filter((part): part is string => part !== null)
      .slice(0, MAX_ARRAY_RESULTS);
    return parts.length > 0 ? parts.join(" / ") : null;
  }

  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }

  return null;
}

function buildEvidence(value: StructuredValue | null, locale: PresentationLocale): LogDetailLine[] {
  const root = asRecord(value);
  if (!root) return [];

  const lines: LogDetailLine[] = [];

  for (const [key, zh, en] of EVIDENCE_FIELDS) {
    const raw = root[key];
    if (raw === undefined) continue;
    const text = detailValueText(raw);
    if (text === null) continue;
    lines.push({ label: locale === "zh-CN" ? zh : en, value: text });
  }

  for (const key of ZERO_WRITE_KEYS) {
    if (root[key] === true) {
      const copy = LOG_CARD_COPY[locale];
      lines.push({ label: copy.zeroWrite, value: copy.yes });
      break;
    }
  }

  return lines;
}

function buildMetadata(
  record: CluedRecord,
  status: { tone: LogTone; label: string } | null,
  locale: PresentationLocale,
): LogDetailLine[] {
  const copy = LOG_CARD_COPY[locale];

  return [
    { label: copy.canonicalId, value: record.id },
    { label: copy.status, value: status ? status.label : copy.statusUnknown },
    {
      label: copy.version,
      value:
        record.version === null || record.version === undefined
          ? copy.versionMissing
          : `v${record.version}`,
    },
    { label: copy.recordType, value: record.record_type },
    { label: copy.updatedAt, value: record.updated_at },
  ];
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

/**
 * Pure projection for the readable log card. Never mutates the input record and
 * never drops or rewrites raw evidence: `rawDetails` always carries the complete
 * original JSON or the complete original text.
 */
export function presentCluedLogCard(
  record: CluedRecord,
  fallbackTitle: string,
  locale: PresentationLocale = "en",
): LogPresentation {
  const copy = LOG_CARD_COPY[locale];
  const { plainText, structuredValue } = resolveLogSource(record);
  const status = resolveExplicitStatus(record, structuredValue, locale);

  if (!structuredValue) {
    const summary = plainText ?? "";
    return {
      title: record.title?.trim() && !isTitlePlaceholder(record.title)
        ? truncateSummary(record.title)
        : fallbackTitle || copy.systemEvent,
      summary,
      tone: status ? status.tone : "neutral",
      tags: buildTags(record, null, status),
      evidence: [],
      metadata: buildMetadata(record, status, locale),
      rawDetails: summary,
    };
  }

  const title = resolveLogTitle(record, structuredValue, locale);
  const summaryLines = logSummaryLines(structuredValue).filter((line) => line !== title);
  const summary = summaryLines.length > 0 ? summaryLines.join("\n") : copy.noSummary;

  return {
    title,
    summary,
    tone: status ? status.tone : "neutral",
    tags: buildTags(record, structuredValue, status),
    evidence: buildEvidence(structuredValue, locale),
    metadata: buildMetadata(record, status, locale),
    rawDetails: stringifyStructuredValue(structuredValue) ?? "",
  };
}

export function presentCluedRecordDisplay(
  record: CluedRecord,
  fallbackTitle: string,
  locale: PresentationLocale = "en",
): CluedRecordDisplay {
  const presentation = presentCluedRecord(record, fallbackTitle);

  if (record.record_type === "log") {
    const card = presentCluedLogCard(record, fallbackTitle, locale);
    return {
      ...presentation,
      title: card.title,
      summary: card.summary,
      rawDetails: card.rawDetails,
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
