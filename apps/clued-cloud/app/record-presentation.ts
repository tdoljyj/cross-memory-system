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

export function formatCanonicalRecordReference(
  record: CluedRecord,
  fallbackTitle: string,
): string {
  const item = presentCluedRecord(record, fallbackTitle);
  return `- \`${item.id}\` — ${item.title}: ${item.conclusion} [status=${item.status}; version=${item.version ?? "n/a"}]`;
}
