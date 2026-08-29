export type CluedRecord = {
  id: string;
  title?: string;
  content?: string;
  summary?: string;
  body?: string;
  record_type: "state" | "task" | "decision" | "archive" | "log" | "note";
  status?: string | null;
  version?: number;
  record_version?: number | null;
  project_id?: string | null;
  effective_project_id?: string | null;
  event_type?: string | null;
  canonical_event_type?: string | null;
  event_schema_version?: number | null;
  committed_canonical_version?: number | null;
  event_scope?: string | null;
  origin_scope?: string | null;
  target_refs?: unknown;
  change_summary?: unknown;
  result?: unknown;
  receipt_id?: string | null;
  audit_visibility?: string | null;
  evidence_refs?: unknown;
  artifact_refs?: unknown;
  error_code?: string | null;
  payload?: Record<string, unknown> | null;
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
  "change_summary",
  "verification",
  "test_results",
  "rollout",
  "merge_commits",
  "outcome",
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
  "frontend_record_display_tests",
  "post_push_ancestor_check",
  "main_worktree",
  "remote_main",
] as const;

const MAX_SUMMARY_LINES = 3;
const MAX_ARRAY_RESULTS = 3;
const MAX_TAGS = 4;

const ACTION_LABELS: Record<PresentationLocale, Record<string, string>> = {
  en: {
    merge_and_close_integrated_branches: "Merge and close integrated branches",
    merge_and_close_integration_branch: "Merge and close integration branch",
    record_closed: "Record closed",
    record_updated: "Record updated",
    production_deployment_completed: "Readable log version deployed",
    production_deployment_blocked: "Cloudflare deployment not executed",
  },
  "zh-CN": {
    merge_and_close_integrated_branches: "合并并关闭集成分支",
    merge_and_close_integration_branch: "合并并关闭集成分支",
    record_closed: "记录已关闭",
    record_updated: "记录已更新",
    production_deployment_completed: "日志可读化版本已部署",
    production_deployment_blocked: "Cloudflare 部署未执行",
  },
};

const OUTCOME_LABELS: Record<PresentationLocale, Record<string, string>> = {
  en: {
    CLUED_LOG_DISPLAY_FIXED_IN_PRODUCTION: "Readable log version deployed",
  },
  "zh-CN": {
    CLUED_LOG_DISPLAY_FIXED_IN_PRODUCTION: "日志可读化版本已部署",
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
    candidateValidation: string;
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
    candidateValidation: "Candidate validation",
  },
  "zh-CN": {
    systemEvent: "系统事件",
    noSummary: "暂无可读摘要，请展开查看原始记录。",
    canonicalId: "Canonical ID",
    status: "状态",
    statusUnknown: "未记录",
    version: "版本",
    versionMissing: "未记录（原记录未提供版本号）",
    recordType: "记录类型",
    updatedAt: "更新时间",
    zeroWrite: "零写入",
    yes: "是",
    candidateValidation: "候选版本验证",
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
  ["receipt_id", "回执 ID", "Receipt ID"],
  ["evidence_refs", "证据引用", "Evidence references"],
  ["artifact_refs", "产物引用", "Artifact references"],
  ["error_code", "错误代码", "Error code"],
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
    explicitOutcomeStatus(root?.outcome),
    root?.verification,
    verification?.status,
    root?.test_results,
    root?.rollout,
    root?.change_summary,
    root?.result,
  ];

  for (const candidate of candidates) {
    const token = explicitStatusToken(candidate);
    if (token !== null) {
      const entry = EXPLICIT_STATUS_TOKENS[token];
      return { token, tone: entry.tone, label: entry[locale] };
    }
  }

  return null;
}

function explicitOutcomeStatus(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^\s*(PASS|SUCCESS|COMPLETED|BLOCKED|PAUSED|FAILED|ERROR)\b/i);
  return match ? match[1] : null;
}

function explicitStatusToken(value: unknown): string | null {
  const direct = normalizeStatusToken(value);
  if (direct) return direct;
  if (typeof value === "string") {
    const upper = value.toUpperCase();
    if (/\b(FAILED|FAILURE|ERROR)\b|失败|错误/.test(upper)) return "FAILED";
    if (/\bBLOCKED\b|阻断/.test(upper)) return "BLOCKED";
    if (/\bPAUSED\b|暂停/.test(upper)) return "PAUSED";
    if (/\b(PASS|PASSED|SUCCESS|SUCCEEDED)\b|成功|通过/.test(upper)) return "PASS";
    if (/\b(COMPLETED|DONE)\b|完成/.test(upper)) return "COMPLETED";
    return null;
  }
  if (Array.isArray(value)) {
    const tokens = value
      .map(explicitStatusToken)
      .filter((token): token is string => token !== null);
    return tokens.find((token) => ["FAILED", "ERROR", "BLOCKED", "PAUSED"].includes(token))
      ?? tokens[0]
      ?? null;
  }
  const record = asRecord(value);
  if (!record) return null;
  for (const key of ["status", "result", "verification"]) {
    const token = explicitStatusToken(record[key]);
    if (token) return token;
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
      if (normalizeStatusToken(line)) continue;
      if (!lines.includes(line)) lines.push(line);
      if (lines.length >= MAX_SUMMARY_LINES) return lines;
    }
  }
  return lines;
}

function naturalizeMachineLine(value: string, locale: PresentationLocale): string {
  const line = value.trim().replace(/\s+/g, " ");
  if (locale !== "zh-CN") return line;
  let match = line.match(/^npm test:?\s*(?:PASS|PASSED)\s*(\d+\/\d+)$/i);
  if (match) return `测试 ${match[1]} 通过`;
  match = line.match(/^frontend record display tests?:?\s*(?:PASS|PASSED)\s*(\d+\/\d+)$/i);
  if (match) return `前端记录显示测试 ${match[1]} 通过`;
  match = line.match(/^(\d+\/\d+)\s*(?:PASS|PASSED)$/i);
  if (match) return `${match[1]} 项验证通过`;
  if (/^build:?\s*(?:PASS|PASSED)$/i.test(line)) return "构建通过";
  if (/^typecheck:?\s*(?:PASS|PASSED)$/i.test(line)) return "类型检查通过";
  if (/^bidirectional:?\s*(?:PASS|PASSED)$/i.test(line)) return "双向检查通过";
  match = line.match(/^healthz?\s*(\d{3})$/i);
  if (match) return `健康检查返回 ${match[1]}`;
  if (/^(main_worktree:\s*)?clean$/i.test(line)) return "工作树干净";
  return line;
}

function formatLogSummary(lines: string[], locale: PresentationLocale): string {
  const readable = [...new Set(lines.map((line) => naturalizeMachineLine(line, locale)))];
  if (locale !== "zh-CN") return readable.join("; ");
  const sentence = readable.join("；");
  return /[。！？]$/.test(sentence) ? sentence : `${sentence}。`;
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

function outcomeLabel(value: unknown, locale: PresentationLocale): string | null {
  if (typeof value !== "string") return null;
  for (const [token, label] of Object.entries(OUTCOME_LABELS[locale])) {
    if (value.includes(token)) return label;
  }
  return null;
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
  const labeledOutcome = outcomeLabel(root?.outcome, locale);
  if (labeledOutcome) candidates.push(labeledOutcome);
  if (root && Array.isArray(root.test_results) && root.test_results.length > 0) {
    candidates.push(copy.candidateValidation);
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
  locale: PresentationLocale,
): string[] {
  const tags: string[] = [];

  const eventType = eventTypeOf(record, value);
  const root = asRecord(value);
  const categorySource = [root?.action, eventType]
    .filter((entry): entry is string => typeof entry === "string")
    .join(" ")
    .toLowerCase();
  if (/deploy|production|rollout|cloudflare/.test(categorySource)) {
    tags.push(locale === "zh-CN" ? "部署" : "Deploy");
  } else if (/merge|branch|commit|git/.test(categorySource)) {
    tags.push("Git");
  } else if (/test|verif|candidate|check/.test(categorySource)) {
    tags.push(locale === "zh-CN" ? "验证" : "Validation");
  } else if (/record|archive/.test(categorySource)) {
    tags.push(locale === "zh-CN" ? "记录" : "Record");
  } else {
    tags.push(locale === "zh-CN" ? "操作" : "Operation");
  }

  if (status) tags.push(status.label);

  tags.push(`ID ${record.id}`);

  const version = record.version ?? record.record_version;
  if (version !== null && version !== undefined) {
    tags.push(`v${version}`);
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
    const raw = root[key] ?? nestedFieldValue(root.change_summary, key);
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

function nestedFieldValue(value: unknown, key: string): unknown {
  if (Array.isArray(value)) {
    const matches = value
      .map((entry) => nestedFieldValue(entry, key))
      .filter((entry) => entry !== undefined);
    return matches.length > 0 ? matches : undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  if (record[key] !== undefined) return record[key];
  for (const nested of Object.values(record)) {
    const match = nestedFieldValue(nested, key);
    if (match !== undefined) return match;
  }
  return undefined;
}

function buildMetadata(
  record: CluedRecord,
  status: { tone: LogTone; label: string } | null,
  locale: PresentationLocale,
): LogDetailLine[] {
  const copy = LOG_CARD_COPY[locale];
  const version = record.version ?? record.record_version;

  return [
    { label: copy.canonicalId, value: record.id },
    { label: copy.status, value: status ? status.label : copy.statusUnknown },
    {
      label: copy.version,
      value:
        version === null || version === undefined
          ? copy.versionMissing
          : `v${version}`,
    },
    { label: copy.recordType, value: record.record_type },
    { label: copy.updatedAt, value: record.updated_at },
  ];
}

function stringifyStructuredValue(value: unknown): string | null {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

function hasLogEnvelope(record: CluedRecord): boolean {
  return [
    record.event_type,
    record.canonical_event_type,
    record.record_version,
    record.event_schema_version,
    record.committed_canonical_version,
    record.change_summary,
    record.result,
    record.receipt_id,
    record.evidence_refs,
    record.artifact_refs,
    record.error_code,
  ].some((value) => value !== null && value !== undefined);
}

function resolveLogSource(record: CluedRecord): {
  plainText: string | null;
  structuredValue: StructuredValue | null;
} {
  const source = record.content ?? record.body ?? record.payload ?? record.summary ?? "";
  const envelope: Record<string, unknown> = {};
  const append = (key: string, value: unknown) => {
    if (value !== null && value !== undefined) envelope[key] = value;
  };

  append("canonical_event_type", record.canonical_event_type);
  append("event_type", record.event_type);
  append("record_version", record.record_version);
  append("event_schema_version", record.event_schema_version);
  append("committed_canonical_version", record.committed_canonical_version);
  append("event_scope", record.event_scope);
  append("origin_scope", record.origin_scope);
  append("target_refs", record.target_refs);
  append("change_summary", record.change_summary);
  append("result", record.result);
  append("receipt_id", record.receipt_id);
  append("audit_visibility", record.audit_visibility);
  append("evidence_refs", record.evidence_refs);
  append("artifact_refs", record.artifact_refs);
  append("error_code", record.error_code);

  const withEnvelope = (value: StructuredValue): StructuredValue => {
    if (Object.keys(envelope).length === 0) return value;
    return Array.isArray(value)
      ? { result: value, ...envelope }
      : { ...value, ...envelope };
  };

  if (typeof source === "string") {
    const structuredValue = parseStructuredValue(source);
    return structuredValue
      ? { plainText: null, structuredValue: withEnvelope(structuredValue) }
      : Object.keys(envelope).length > 0
        ? { plainText: null, structuredValue: { summary: source, ...envelope } }
        : { plainText: source, structuredValue: null };
  }

  if (source !== null && typeof source === "object") {
    return { plainText: null, structuredValue: withEnvelope(source as StructuredValue) };
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
    version: record.version ?? record.record_version ?? null,
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
      tags: buildTags(record, null, status, locale),
      evidence: [],
      metadata: buildMetadata(record, status, locale),
      rawDetails: hasLogEnvelope(record)
        ? stringifyStructuredValue(record) ?? summary
        : summary,
    };
  }

  const title = resolveLogTitle(record, structuredValue, locale);
  const summaryLines = logSummaryLines(structuredValue).filter((line) => line !== title);
  const eventType = eventTypeOf(record, structuredValue);
  const summary = summaryLines.length > 0
    ? formatLogSummary(summaryLines, locale)
    : status && eventType
      ? `${actionLabel(eventType, locale)}${locale === "zh-CN" ? "：" : ": "}${status.label}`
      : copy.noSummary;

  return {
    title,
    summary,
    tone: status ? status.tone : "neutral",
    tags: buildTags(record, structuredValue, status, locale),
    evidence: buildEvidence(structuredValue, locale),
    metadata: buildMetadata(record, status, locale),
    rawDetails: hasLogEnvelope(record)
      ? stringifyStructuredValue(record) ?? ""
      : stringifyStructuredValue(structuredValue) ?? "",
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

export function formatRecordTime(
  value: string,
  locale: PresentationLocale,
  now: Date = new Date(),
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const time = date.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDifference = Math.round((startToday - startDate) / 86_400_000);
  if (dayDifference === 0) return locale === "zh-CN" ? `今天 ${time}` : `Today ${time}`;
  if (dayDifference === 1) return locale === "zh-CN" ? `昨天 ${time}` : `Yesterday ${time}`;
  return date.toLocaleString(locale, {
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatCanonicalRecordReference(
  record: CluedRecord,
  fallbackTitle: string,
): string {
  const item = presentCluedRecord(record, fallbackTitle);
  return `- \`${item.id}\` — ${item.title}: ${item.conclusion} [status=${item.status}; version=${item.version ?? "n/a"}]`;
}
