export type Resource = {
  resource_kind: "scope" | "context"; resource_id: string; environment: string; actions: string[];
  name?: string; project_id?: string | null; project_name?: string | null; context_name?: string | null;
  effective_actions?: string[]; qualification_id?: string | null;
};
export type OperationPreset = "reader" | "developer" | "full";
export type Selection = Record<string, string[]>;
export const ALL_CONTEXTS = "contexts:*";
export const ALL_PROJECTS = "project:*";
export const ACTION_LABELS: Record<string, string> = { read: "读取", write: "新增和修改", close: "关闭和归档", restore: "恢复", audit: "查看审计回执", feedback_submit: "提交反馈" };
export const ENVIRONMENT_LABELS: Record<string, string> = { test: "测试环境", preview: "预览环境", production: "生产环境" };
export const OPERATION_LABELS: Record<OperationPreset, string> = { reader: "只读", developer: "可编辑", full: "全部操作" };
export const resourceKey = (row: Resource) => JSON.stringify([row.resource_kind, row.resource_id, row.environment]);
export const isAllContexts = (row: Resource) => row.resource_kind === "scope" && row.resource_id === ALL_CONTEXTS && row.environment === "canonical";
export const isMacro = (row: Resource) => row.resource_kind === "scope" && [ALL_CONTEXTS, ALL_PROJECTS].includes(row.resource_id);
export function resourceTitle(row: Resource): string {
  if (row.resource_kind === "context") return `${row.context_name || row.name || "未命名上下文"} · ${ENVIRONMENT_LABELS[row.environment] || row.environment}`;
  if (row.resource_id === "global") return "通用内容";
  if (row.resource_id === "profile") return "个人资料";
  if (row.resource_id === ALL_CONTEXTS) return "全部上下文（含以后新建的）";
  if (row.resource_id === ALL_PROJECTS) return "自有项目正式记录（含未来项目）";
  return row.project_name || row.name || "项目正式记录";
}
export function supportedActions(row: Resource): string[] {
  return isAllContexts(row) ? ["read", "write", "close", "restore", "audit", "feedback_submit"]
    : row.resource_kind === "context" ? ["read", "write", "close", "feedback_submit"]
    : ["read", "write", "close", "restore", "audit"];
}
export function presetActions(row: Resource, preset: OperationPreset): string[] {
  const desired = preset === "reader" ? ["read"] : preset === "developer" ? ["read", "write"] : supportedActions(row);
  return row.actions.filter(action => desired.includes(action));
}
export function availablePresets(rows: Resource[]): OperationPreset[] {
  const result: OperationPreset[] = ["reader"];
  if (rows.some(row => row.actions.includes("read") && row.actions.includes("write"))) result.push("developer", "full");
  return result;
}
export function requestedResources(rows: Resource[], scopes: string[]): Resource[] {
  const allowed = (action: string) => action === "read" ? scopes.includes("context:read") : action === "audit" ? scopes.includes("audit:read")
    : ["write", "close", "restore", "feedback_submit"].includes(action) && scopes.includes("context:write");
  return rows.map(row => ({ ...row, actions: row.actions.filter(action => supportedActions(row).includes(action) && allowed(action)) }));
}
export function initialSelection(rows: Resource[]): { range: "all" | "specified"; preset: OperationPreset; selected: Selection } {
  const macro = rows.find(isAllContexts);
  const preset = availablePresets(macro ? [macro] : rows).includes("full") ? "full" : "reader";
  return { range: macro ? "all" : "specified", preset, selected: macro ? { [resourceKey(macro)]: presetActions(macro, preset) } : {} };
}
export function applyPreset(rows: Resource[], selected: Selection, preset: OperationPreset): Selection {
  return Object.fromEntries(rows.filter(row => (selected[resourceKey(row)] || []).length).map(row => [resourceKey(row), presetActions(row, preset)]));
}
export function changeRange(rows: Resource[], range: "all" | "specified", preset: OperationPreset): Selection {
  const macro = rows.find(isAllContexts);
  return range === "all" && macro ? { [resourceKey(macro)]: presetActions(macro, preset) } : {};
}
export function selectedResources(rows: Resource[], selected: Selection): Resource[] {
  return rows.map(row => ({ resource_kind: row.resource_kind, resource_id: row.resource_id, environment: row.environment,
    actions: row.actions.filter(action => (selected[resourceKey(row)] || []).includes(action)) })).filter(row => row.actions.length);
}
export function resourceGroups(rows: Resource[]): { key: string; name: string; rows: Resource[] }[] {
  const groups = new Map<string, { key: string; name: string; rows: Resource[] }>();
  for (const row of rows.filter(row => !isMacro(row))) {
    const project = row.project_id || (row.resource_kind === "scope" && row.resource_id.startsWith("project:") ? row.resource_id.slice(8) : null);
    const key = project || (row.resource_kind === "context" ? "unresolved-contexts" : "personal");
    const name = project ? row.project_name || (row.resource_kind === "scope" ? row.name : undefined) || "项目（名称暂不可用）"
      : row.resource_kind === "context" ? "上下文（所属项目尚未提供）" : "通用内容与个人资料";
    if (!groups.has(key)) groups.set(key, { key, name, rows: [] });
    else if (row.project_name) groups.get(key)!.name = row.project_name;
    groups.get(key)!.rows.push(row);
  }
  return [...groups.values()];
}
export function operationSummary(rows: Resource[], legacy = false): string {
  if (!rows.length) return "无可用操作";
  const effective = (row: Resource) => row.effective_actions || row.actions;
  const same = (a: string[], b: string[]) => a.length === b.length && a.every(action => b.includes(action));
  if (rows.every(row => same(effective(row), ["read"]))) return "只读";
  if (rows.every(row => same(effective(row), ["read", "write"]))) return "可编辑";
  if (rows.every(row => same(effective(row), supportedActions(row)))) return legacy ? "全部操作（原授权）" : "全部操作";
  return "自定义／受限";
}
