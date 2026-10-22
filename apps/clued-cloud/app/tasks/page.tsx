"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type Session } from "@supabase/supabase-js";
import { supabase } from "../supabase-browser";
import "../contexts/contexts.css";
import "../confirm/owner.css";
import "./task-workflow.css";

// A Native account-session read. The database also refuses delegated OAuth,
// other owners and unsupported record types. Never turn a failed read into an
// empty record or treat a historical record as permission to execute it.
type Json = Record<string, unknown>;
type RecordView = { id: string; record_type: string; title: string; content: string; scope: string;
  lifecycle_status: string; execution_bucket: string | null; closure_summary: string | null;
  version: number; updated_at: string; currentness: string };
type Related = Pick<RecordView, "id" | "record_type" | "title" | "scope" | "currentness">;
type Detail = { record: RecordView; related: Related[]; claims: Json[]; ended: Json[] };
type BoundDetail = Detail & { owner: Session; target: string; generation: number };
type BoundError = { owner: Session | null; target: string; message: string };
type InputVersion = { label: string; kind: "record" | "artifact" | "declared"; version: number | string; id?: string; scope?: string };
type Deliverable = { id: string; label: string; required: boolean; path?: string; mime_type?: string; sha256?: string };
type Condition = { id: string; text: string; kind: "file_integrity" | "owner_review"; deliverable_id?: string };
type Definition = { contract: string; goal: string; scope: string; completion_level: "artifact" | "business_effect" | "physical_effect";
  input_versions: InputVersion[]; acceptance_mode: "machine" | "owner"; conditions: Condition[]; deliverables: Deliverable[] };
type Delivery = { deliverable_id: string; job_id?: string; status: "verified" | "pending" | "unknown" | "stale" | "rejected";
  reason?: string; artifact_id?: string; artifact_version?: number; path?: string; provider_file_id?: string; provider_file_version?: string;
  sha256?: string; size?: number; mime_type?: string; receipt_id?: string; verified_receipt_id?: string;
  registration_receipt_id?: string; link?: string; verified_at?: string; verification_scope?: string };
type Workflow = { contract: string; goal_version: string; definition: Definition; delivery_refs: Json[]; deliveries: Delivery[];
  inputs: (InputVersion & { qualification: "verified" | "unknown" | "declared_unverified" })[];
  completion: { ready_for_acceptance: boolean; eligible: boolean; reasons: string[]; completion_digest: string;
    owner_accepted: boolean; acceptance_receipt_id?: string } };
type Candidate = { job_id: string; label: string; path: string; state: string };
type WorkflowRead = { task_id: string; record_version: number; task_workflow: Workflow | null; delivery_candidates: Candidate[] };
type BoundWorkflow = WorkflowRead & { owner: Session; target: string; generation: number };
type ActionNotice = BoundError & { generation: number };
type Mutation = { owner: Session; target: string; generation: number };
const WORKFLOW_CONTRACT = "clued.task-goal-delivery/1";
const object = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => typeof value === "string" ? value : "";
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const kinds: Record<string, string> = { task: "任务", decision: "决定", note: "笔记" };
const currentnessNames: Record<string, string> = { CURRENT: "当前", HISTORY: "历史", UNKNOWN: "尚未确认", STALE: "已过时",
  SHADOWED_BY_ACTIVE_EVENT: "有后续事件待核对", NOT_AUTHORIZED: "无读取权限", NOT_CURRENT_FOR_EXECUTION: "不适合当前执行" };
const states: Record<string, string> = { ACTIVE: "有效", DRAINING: "收尾中", RELEASED: "已释放", EXPIRED: "已过期", SUPERSEDED: "被接管" };
const outcomes: Record<string, string> = { completed: "完成", abandoned: "放弃" };
const lifecycleNames: Record<string, string> = { active: "有效", closed: "已关闭", completed: "已完成", revoked: "已撤销",
  archived: "已归档", superseded: "已取代", cancelled: "已取消" };
const bucketNames: Record<string, string> = { now: "现在", next: "接下来", later: "以后", blocked: "受阻", done: "已完成" };
const levelNames = { artifact: "文件与报告", business_effect: "业务结果", physical_effect: "现实结果" };
const deliveryNames: Record<Delivery["status"], string> = { verified: "文件已核验", pending: "归档中，尚未核验", unknown: "尚未确认", stale: "版本或约定已变化", rejected: "核验未通过" };
const jobNames: Record<string, string> = { queued: "排队中", started: "归档中", uncertain: "结果未知", committed: "已归档", failed: "失败", cancelled: "已取消", attention_required: "需要处理" };
const workflowMessages: Record<string, string> = {
  expected_owner_mismatch: "登录账户已变化，请刷新后重新核对。",
  direct_human_session_required: "请使用你本人直接登录的账户核对任务。",
  task_not_found: "找不到任务，或当前账户无权查看。",
  record_not_found: "找不到任务，或当前账户无权查看。",
  stale_base_version: "任务版本已变化，请刷新后核对当前约定。",
  task_goal_version_stale: "目标约定已变化，原交付或确认不能用于当前目标。",
  task_completion_digest_stale: "输入或文件版本已变化，请刷新并重新核验。",
  task_completion_not_eligible: "当前完成条件尚未满足，请查看下方缺少项。",
  task_owner_acceptance_required: "请先核对内容条件并接受这次交付。",
  missing_required_delivery: "还有必需文件没有关联。",
  owner_acceptance_required: "文件条件已满足，仍需你核对内容并接受交付。",
  unsupported_completion_level: "目前可核验文件与报告；业务或现实结果仍待确认。",
  task_owner_changed: "登录账户已变化，请刷新后重新核对。",
  task_unavailable: "找不到任务，或当前账户无权查看。",
  task_record_version_conflict: "任务版本已变化，请刷新后核对当前约定。",
  task_goal_version_conflict: "目标约定已变化，原交付或确认不能用于当前目标。",
  task_completion_digest_conflict: "输入或文件版本已变化，请刷新并重新核验。",
  task_completion_checks_failed: "当前完成条件尚未满足，请查看下方缺少项。",
  task_not_current: "任务的当前状态尚未确认，请刷新核对。",
  completion_level_unsupported: "目前可核验文件与报告；业务或现实结果仍待确认。",
  input_version_unverified: "输入资料的精确版本尚未核实",
  input_source_busy: "输入资料仍在更新，请稍后刷新",
  delivery_missing: "尚未关联必需的文件",
  delivery_goal_changed: "目标约定已变化，需要重新关联当前目标的文件",
  delivery_unavailable: "此文件暂不可用，或当前范围无权读取",
  delivery_source_busy: "文件仍在更新，请稍后刷新",
  delivery_authority_changed: "文件权限或归档目录状态已变化",
  delivery_not_settled: "文件仍在归档，尚未完成核验",
  delivery_not_committed: "文件归档未成功",
  delivery_proof_missing: "文件缺少可核验的归档凭据",
  delivery_proof_invalid: "归档凭据未通过核验",
  delivery_receipt_invalid: "归档回执尚未核实",
  delivery_registry_changed: "文件位置或版本已变化",
  delivery_expectation_mismatch: "文件位置或内容校验值未满足约定",
  delivery_mime_unknown: "文件类型尚未核验，不能满足约定类型",
  delivery_mime_mismatch: "文件类型未满足约定",
  delivery_verification_unavailable: "暂时无法完成文件核验，请刷新核对",
  task_delivery_reference_unavailable: "这个文件尚不可用于此任务，请核对文件范围与当前权限。",
  task_goal_delivery_input_invalid: "完成约定或提交内容不符合要求，请核对后重试。",
  task_workflow_invalid: "完成约定不符合要求，请核对输入资料、条件与必需文件。",
  task_workflow_declared_input_requires_owner: "未自动核验的版本声明，需要由你核对并接受交付。",
};
const MESSAGES: Record<string, string> = {
  direct_human_session_required: "需要你本人直接登录 BeamingFace，授权给应用的登录不能查看任务详情。",
  record_not_found: "找不到这条记录，或当前账户无权查看。",
};
const BEIJING = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit",
  day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
function beijing(value: unknown) {
  const ms = Date.parse(text(value));
  return Number.isFinite(ms) ? BEIJING.format(new Date(ms)) + "（北京时间）" : "未提供";
}
function currentness(value: string) { return (currentnessNames[value] ?? "尚未确认") + "（" + value + "）"; }
function pullUrl(value: unknown) {
  const match = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})#([0-9]{1,10})$/.exec(text(value));
  return match ? "https://github.com/" + match[1] + "/" + match[2] + "/pull/" + match[3] : null;
}
const sessionUrl = (value: unknown) => /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]{8,64}$/.test(text(value)) ? text(value) : null;
function validRelated(value: unknown): value is Related {
  return object(value) && uuid(value.id) && typeof value.record_type === "string" && Object.hasOwn(kinds, value.record_type)
    && typeof value.title === "string" && typeof value.scope === "string" && typeof value.currentness === "string";
}
function validDetail(value: unknown, id: string): value is Detail {
  if (!object(value) || value.status !== "ok" || !validRelated(value.record)) return false;
  const record = value.record as Related & Json;
  return record.id.toLowerCase() === id && typeof record.content === "string" && typeof record.lifecycle_status === "string"
    && (record.execution_bucket === null || typeof record.execution_bucket === "string")
    && (record.closure_summary === null || typeof record.closure_summary === "string") && Number.isSafeInteger(record.version)
    && Number(record.version) > 0 && typeof record.updated_at === "string" && Number.isFinite(Date.parse(record.updated_at))
    && Array.isArray(value.related) && value.related.every(validRelated) && Array.isArray(value.claims) && Array.isArray(value.ended)
    && [...value.claims, ...value.ended].every(claim => object(claim) && uuid(claim.claim_id)
      && text(claim.task_id).toLowerCase() === id);
}
class RequestFailure extends Error {}
async function request(id: string): Promise<Detail> {
  let result: { data: unknown; error: { message?: string; code?: string } | null };
  try { result = await supabase.rpc("clued_task_owner_detail_v1", { p_input: { id } }); }
  catch { throw new RequestFailure("网络请求未完成，读取结果未知。请刷新重试。"); }
  if (result.error) {
    const code = result.error.message ?? "";
    throw new RequestFailure(MESSAGES[code] ?? (result.error.code ? "请求被拒绝（" + code + "）。" : "网络请求未完成，读取结果未知。请刷新重试。"));
  }
  if (object(result.data) && (result.data.status === "rejected" || result.data.status === "failed")) {
    const code = text(result.data.error_code);
    throw new RequestFailure(MESSAGES[code] ?? "暂时无法读取详情，请刷新重试。");
  }
  if (!validDetail(result.data, id)) throw new RequestFailure("服务返回了无法确认的详情，读取结果未知。请刷新重试。");
  return result.data;
}

const sha = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const positiveVersion = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
function validDefinition(value: unknown): value is Definition {
  if (!object(value) || value.contract !== WORKFLOW_CONTRACT || !text(value.goal).trim() || !text(value.scope).trim()
    || !Object.hasOwn(levelNames, text(value.completion_level)) || !["machine", "owner"].includes(text(value.acceptance_mode))) return false;
  if (!Array.isArray(value.input_versions) || value.input_versions.length > 16 || !value.input_versions.every(input => object(input)
    && typeof input.label === "string" && ["record", "artifact", "declared"].includes(text(input.kind))
    && (input.kind === "declared" ? typeof input.version === "string" : positiveVersion(input.version) && uuid(input.id))
    && (input.kind !== "record" || typeof input.scope === "string"))) return false;
  if (!Array.isArray(value.deliverables) || !value.deliverables.length || value.deliverables.length > 16
    || !value.deliverables.every(file => object(file) && !!text(file.id) && !!text(file.label) && typeof file.required === "boolean"
      && ["path", "mime_type", "sha256"].every(key => file[key] === undefined || typeof file[key] === "string"))
    || new Set(value.deliverables.map(file => file.id)).size !== value.deliverables.length) return false;
  const deliverables = value.deliverables;
  return (value.acceptance_mode !== "machine" || !value.input_versions.some(input => input.kind === "declared"))
    && Array.isArray(value.conditions) && !!value.conditions.length && value.conditions.length <= 16
    && value.conditions.every(condition => object(condition) && !!text(condition.id) && !!text(condition.text)
      && ["file_integrity", "owner_review"].includes(text(condition.kind))
      && (condition.kind !== "owner_review" || value.acceptance_mode === "owner")
      && (condition.kind !== "file_integrity" || deliverables.some(file => file.id === condition.deliverable_id)))
    && new Set(value.conditions.map(condition => condition.id)).size === value.conditions.length;
}
function validWorkflow(value: unknown): value is Workflow {
  if (!object(value) || value.contract !== WORKFLOW_CONTRACT || !sha(value.goal_version) || !validDefinition(value.definition)
    || !Array.isArray(value.delivery_refs) || !Array.isArray(value.deliveries) || !object(value.completion)) return false;
  const completion = value.completion;
  const definition = value.definition;
  const deliveries = value.deliveries;
  if (!Array.isArray(value.inputs) || value.inputs.length !== definition.input_versions.length
    || !value.inputs.every((input, i) => object(input) && input.label === definition.input_versions[i].label
      && input.kind === definition.input_versions[i].kind && input.version === definition.input_versions[i].version
      && ["verified", "unknown", "declared_unverified"].includes(text(input.qualification)))) return false;
  if (!["ready_for_acceptance", "eligible", "owner_accepted"].every(key => typeof completion[key] === "boolean")
    || !sha(completion.completion_digest) || !Array.isArray(completion.reasons) || !completion.reasons.every(reason => typeof reason === "string")
    || (completion.acceptance_receipt_id != null && !uuid(completion.acceptance_receipt_id))
    || completion.owner_accepted && !uuid(completion.acceptance_receipt_id)) return false;
  if (value.deliveries.length !== definition.deliverables.length
    || new Set(value.deliveries.map(delivery => object(delivery) ? delivery.deliverable_id : null)).size !== value.deliveries.length
    || value.delivery_refs.length > 16 || !value.delivery_refs.every(ref => object(ref) && Object.keys(ref).every(key => ["deliverable_id", "job_id", "goal_version"].includes(key))
      && uuid(ref.job_id) && sha(ref.goal_version) && typeof ref.deliverable_id === "string" && ref.deliverable_id.trim().length > 0 && ref.deliverable_id.length <= 80
      && (ref.goal_version !== value.goal_version || definition.deliverables.some(file => file.id === ref.deliverable_id)))
    || new Set(value.delivery_refs.map(ref => object(ref) ? ref.deliverable_id : null)).size !== value.delivery_refs.length) return false;
  const refs = value.delivery_refs;
  if (!value.deliveries.every(delivery => object(delivery) && !!text(delivery.deliverable_id)
    && definition.deliverables.some(file => file.id === delivery.deliverable_id)
    && Object.hasOwn(deliveryNames, text(delivery.status))
    && ["reason", "path", "provider_file_id", "provider_file_version", "sha256", "mime_type", "link", "verification_scope"].every(key => delivery[key] == null || typeof delivery[key] === "string")
    && (delivery.link == null || delivery.link === driveFileUrl(delivery.provider_file_id))
    && ["job_id", "artifact_id", "receipt_id", "verified_receipt_id", "registration_receipt_id"].every(key => delivery[key] == null || uuid(delivery[key]))
    && (delivery.artifact_version == null || positiveVersion(delivery.artifact_version))
    && (delivery.size == null || Number.isSafeInteger(delivery.size) && Number(delivery.size) >= 0)
    && (delivery.verified_at == null || Number.isFinite(Date.parse(text(delivery.verified_at))))
    && (delivery.status !== "verified" || uuid(delivery.job_id) && uuid(delivery.artifact_id) && positiveVersion(delivery.artifact_version) && uuid(delivery.receipt_id)
      && uuid(delivery.verified_receipt_id) && sha(delivery.sha256) && !!text(delivery.path) && !!driveFileUrl(delivery.provider_file_id)
      && !!text(delivery.provider_file_version) && Number.isFinite(Date.parse(text(delivery.verified_at)))
      && delivery.verification_scope === "persisted_storage_and_current_registry"
      && refs.some(ref => ref.deliverable_id === delivery.deliverable_id && ref.job_id === delivery.job_id && ref.goal_version === value.goal_version)))) return false;
  if (completion.ready_for_acceptance || completion.eligible) {
    if (definition.completion_level !== "artifact" || !completion.ready_for_acceptance
      || value.inputs.some(input => input.qualification === "unknown")
      || definition.deliverables.some(file => (file.required || definition.conditions.some(condition => condition.kind === "file_integrity" && condition.deliverable_id === file.id))
        && !deliveries.some(delivery => delivery.deliverable_id === file.id && delivery.status === "verified"))
      || completion.eligible && definition.acceptance_mode === "owner" && !completion.owner_accepted) return false;
  }
  return true;
}
function validWorkflowRead(value: unknown, id: string): value is WorkflowRead {
  return object(value) && value.status === "ok" && text(value.task_id).toLowerCase() === id && positiveVersion(value.record_version)
    && (value.task_workflow === null || validWorkflow(value.task_workflow)) && Array.isArray(value.delivery_candidates)
    && value.delivery_candidates.length <= 30 && value.delivery_candidates.every(candidate => object(candidate) && uuid(candidate.job_id)
      && typeof candidate.label === "string" && typeof candidate.path === "string" && typeof candidate.state === "string");
}
async function requestWorkflow(id: string, owner: string): Promise<WorkflowRead> {
  let result: { data: unknown; error: { message?: string; code?: string } | null };
  try { result = await supabase.rpc("clued_task_goal_delivery_owner_v1", { p_input: { action: "read", id, expected_owner_id: owner } }); }
  catch { throw new RequestFailure("目标与交付读取结果未知，请刷新核对。"); }
  if (result.error || object(result.data) && result.data.status !== "ok") {
    const code = result.error?.message || (object(result.data) ? text(result.data.error_code) : "");
    throw new RequestFailure(workflowMessages[code] ?? "任务目标与交付暂不可用，请刷新核对。任务正文仍可查看。");
  }
  if (!validWorkflowRead(result.data, id)) throw new RequestFailure("目标与交付返回结果无法核实，请刷新核对。");
  return result.data;
}
function validMutation(value: unknown, id: string, base: number, action: string) {
  if (!(object(value) && value.status === "committed" && uuid(value.receipt_id) && text(value.task_id).toLowerCase() === id
    && positiveVersion(value.record_version) && Number(value.record_version) >= base && Array.isArray(value.target_refs)
    && object(value.committed_versions) && Array.isArray(value.event_ids) && value.event_ids.length > 0
    && value.event_ids.every(event => typeof event === "string" && !!event || positiveVersion(event)))) return false;
  const versions = value.committed_versions;
  if (action === "accept") {
    const primary = value.target_refs.find(ref => object(ref) && ref.kind === "system" && ref.role === "primary" && uuid(ref.id));
    return object(primary) && positiveVersion(versions[text(primary.id)]) && value.target_refs.some(ref => object(ref)
      && ref.kind === "record" && ref.role === "source" && text(ref.id).toLowerCase() === id);
  }
  return versions[id] === base + 1 && Number(value.record_version) >= Number(versions[id])
    && value.target_refs.some(ref => object(ref) && ref.kind === "record" && ref.role === "primary" && text(ref.id).toLowerCase() === id);
}
function defaultDefinition(): Definition {
  return { contract: WORKFLOW_CONTRACT, goal: "", scope: "", completion_level: "artifact", input_versions: [], acceptance_mode: "owner",
    conditions: [{ id: "archive-output", kind: "file_integrity", text: "交付文件已归档并通过完整性核验", deliverable_id: "output" }],
    deliverables: [{ id: "output", label: "交付文件", required: true }] };
}
function definitionError(definition: Definition) {
  if (!definition.goal.trim() || !definition.scope.trim()) return "请填写任务目标和范围。";
  if (!definition.deliverables.length || !definition.deliverables.some(file => file.required) || definition.deliverables.some(file => !file.label.trim())) return "请填写交付文件名称，并至少保留一份必需文件。";
  if (definition.conditions.length > 16 || definition.conditions.some(condition => !condition.text.trim())) return "请填写完成条件，合计最多 16 项。";
  if (definition.input_versions.some(input => !input.label.trim() || typeof input.version === "string" && !input.version.trim())) return "请填写每份输入资料的名称和版本。";
  if (definition.acceptance_mode === "machine" && (definition.input_versions.some(input => input.kind === "declared")
    || definition.conditions.some(condition => condition.kind === "owner_review"))) return "未自动核验的版本或内容条件，需要由你核对并接受交付。";
  if (definition.deliverables.some(file => file.sha256 && !sha(file.sha256))) return "文件校验值须为完整的 64 位小写 SHA-256。";
  return "";
}
function driveFileUrl(providerId: unknown) {
  return typeof providerId === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(providerId)
    ? "https://drive.google.com/file/d/" + providerId + "/view" : null;
}
function fileLink(delivery: Delivery) {
  // Derive a stable provider link from the verified identity, never an arbitrary
  // caller-supplied or signed URL from a response.
  return delivery.status === "verified" ? driveFileUrl(delivery.provider_file_id) : null;
}
function reasonText(reason: string, definition?: Definition) {
  const separator = reason.indexOf(":"), code = separator < 0 ? reason : reason.slice(0, separator);
  const context = separator < 0 ? "" : reason.slice(separator + 1);
  const label = definition?.deliverables.find(file => file.id === context)?.label ?? context;
  return (workflowMessages[code] ?? "尚有一项完成条件未满足，请核对输入版本和文件交付。") + (label ? "：" + label : "");
}

export default function TaskOwnerDetailPage() {
  const params = useSearchParams();
  const rawId = params.get("id") ?? "";
  const id = uuid(rawId) ? rawId.toLowerCase() : "";
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [detail, setDetail] = useState<BoundDetail | null>(null);
  const [error, setError] = useState<BoundError | null>(null);
  const [workflow, setWorkflow] = useState<BoundWorkflow | null>(null);
  const [workflowError, setWorkflowError] = useState<ActionNotice | null>(null);
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [editor, setEditor] = useState<Definition | null>(null);
  const [selectedJobs, setSelectedJobs] = useState<Record<string, string>>({});
  const [closure, setClosure] = useState({ goal_version: "", text: "" });
  const [readGeneration, setReadGeneration] = useState(0);
  const [renderTarget, setRenderTarget] = useState(id);
  const activeSession = useRef<Session | null>(null);
  const activeTarget = useRef(id);
  const epoch = useRef(0);
  const activeMutation = useRef<Mutation | null>(null);
  // Clear cached route state during React's guarded state adjustment. The
  // previous route is hidden in this render, including A -> B -> A before a
  // network response. No render reads or writes an asynchronous ref fence.
  if (renderTarget !== id) {
    setRenderTarget(id); setDetail(null); setError(null); setWorkflow(null); setWorkflowError(null); setNotice(null);
    setBusy(false); setUncertain(false); setEditor(null); setSelectedJobs({}); setClosure({ goal_version: "", text: "" });
  }
  const advanceGeneration = useCallback(() => {
    const generation = ++epoch.current; setReadGeneration(generation); return generation;
  }, []);
  const clearWorkflow = useCallback(() => {
    activeMutation.current = null; setWorkflow(null); setWorkflowError(null);
    setNotice(null); setBusy(false); setUncertain(false); setEditor(null); setSelectedJobs({}); setClosure({ goal_version: "", text: "" });
  }, []);

  const load = useCallback(async (who = activeSession.current, target = activeTarget.current) => {
    if (!who || !target) return;
    const generation = ++epoch.current;
    const applies = () => epoch.current === generation && activeTarget.current === target
      && activeSession.current?.user.id === who.user.id && activeSession.current?.access_token === who.access_token;
    // These reads can finish independently. An unavailable new workflow API
    // never prevents the existing canonical Task/Decision/Note read.
    const detailRequest = request(target);
    void requestWorkflow(target, who.user.id).then(value => {
      if (applies()) { setReadGeneration(generation); setWorkflow({ ...value, owner: who, target, generation }); setUncertain(false); }
    }).catch(failure => {
      if (applies()) { setReadGeneration(generation); setWorkflowError({ owner: who, target, generation,
        message: failure instanceof RequestFailure ? failure.message : "任务目标与交付暂不可用，请刷新核对。" }); }
    });
    try {
      const value = await detailRequest;
      if (applies()) { setReadGeneration(generation); setDetail({ ...value, owner: who, target, generation }); }
    } catch (failure) {
      if (applies()) { setReadGeneration(generation); setError({ owner: who, target, message: failure instanceof RequestFailure ? failure.message : "暂时无法读取详情。" }); }
    }
    return applies() ? generation : null;
  }, []);

  const prepareRead = useCallback(() => {
    setDetail(null); setError(null); setWorkflow(null); setWorkflowError(null); setEditor(null); setSelectedJobs({}); setNotice(null);
  }, []);
  function refresh() {
    if (activeMutation.current) return;
    prepareRead(); void load();
  }

  useEffect(() => {
    let disposed = false;
    const lifetime = epoch;
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      if (disposed) return;
      const changed = activeSession.current?.user.id !== next?.user.id
        || activeSession.current?.access_token !== next?.access_token;
      activeSession.current = next; setSession(next); setReady(true);
      if (changed) { advanceGeneration(); setDetail(null); setError(null); clearWorkflow(); }
    });
    return () => { disposed = true; ++lifetime.current; data.subscription.unsubscribe(); };
  }, [advanceGeneration, clearWorkflow]);

  const ownerId = session?.user.id, accessToken = session?.access_token;
  useLayoutEffect(() => {
    // Render visibility is filtered by route/state; the async target fence is
    // updated at commit, before any new route can receive an interaction.
    activeTarget.current = id; ++epoch.current; activeMutation.current = null;
    if (activeSession.current && id) void load(activeSession.current, id);
  }, [ownerId, accessToken, id, load]);



  const visible = renderTarget === id && detail && detail.target === id && detail.owner.user.id === session?.user.id
    && detail.owner.access_token === session?.access_token && detail.generation === readGeneration ? detail : null;
  const visibleError = error && error.target === id && error.owner?.user.id === session?.user.id
    && error.owner?.access_token === session?.access_token ? error.message : "";
  const visibleWorkflow = renderTarget === id && workflow && workflow.target === id && workflow.owner.user.id === session?.user.id
    && workflow.owner.access_token === session?.access_token && workflow.generation === readGeneration ? workflow : null;
  const sameVersion = visible && visibleWorkflow && visibleWorkflow.record_version === visible.record.version;
  const canWrite = !!sameVersion && visible.record.record_type === "task" && visible.record.currentness === "CURRENT"
    && visible.record.lifecycle_status === "active" && !busy && !uncertain;
  const boundMessage = (value: ActionNotice | null) => value && value.target === id && value.owner?.user.id === session?.user.id
    && value.owner?.access_token === session?.access_token && value.generation === readGeneration ? value.message : "";
  const visibleWorkflowError = boundMessage(workflowError), visibleNotice = boundMessage(notice);
  const loading = !!session && !!id && !visible && !visibleError;
  const workflowLoading = !visibleWorkflow && !visibleWorkflowError;

  const mutate = useCallback(async (action: "set_goal" | "bind_delivery" | "unbind_delivery" | "accept" | "complete", extra: Json) => {
    const who = activeSession.current, target = activeTarget.current;
    if (!who || !visible || !visibleWorkflow || !canWrite || activeMutation.current
      || visible.target !== target || visible.owner.user.id !== who.user.id || visible.owner.access_token !== who.access_token
      || visible.generation !== epoch.current || visibleWorkflow.generation !== epoch.current) return;
    const entry: Mutation = { owner: who, target, generation: epoch.current };
    activeMutation.current = entry; setBusy(true); setNotice(null);
    const applies = () => activeMutation.current === entry && epoch.current === entry.generation && activeTarget.current === target
      && activeSession.current?.user.id === who.user.id && activeSession.current?.access_token === who.access_token;
    try {
      const key = "task-goal-delivery:" + crypto.randomUUID();
      const result = await supabase.rpc("clued_task_goal_delivery_owner_v1", { p_input: { action, id: target,
        expected_owner_id: who.user.id, base_record_version: visible.record.version, idempotency_key: key, ...extra } });
      if (!applies()) return;
      if (result.error) throw new RequestFailure(workflowMessages[result.error.message ?? ""] ?? "提交结果尚未确认，请刷新核对。");
      if (object(result.data) && ["rejected", "failed"].includes(text(result.data.status))) {
        setNotice({ owner: who, target, generation: entry.generation,
          message: workflowMessages[text(result.data.error_code)] ?? "此次提交未通过，请核对当前完成条件后刷新。" });
        return;
      }
      if (!validMutation(result.data, target, visible.record.version, action)) throw new RequestFailure("提交结果无法核实，请刷新核对。");
      prepareRead(); const generation = await load(who, target);
      if (generation != null && activeSession.current?.user.id === who.user.id && activeSession.current?.access_token === who.access_token
        && activeTarget.current === target) setNotice({ owner: who, target, generation, message: "已提交并重新读取当前任务。" });
    } catch (failure) {
      if (applies()) { setUncertain(true); setNotice({ owner: who, target, generation: entry.generation,
        message: (failure instanceof RequestFailure ? failure.message : "提交结果未知，请刷新核对。") + "请先刷新核对，当前未显示为成功。" }); }
    } finally {
      // Do not unlock another account/route's newer mutation when a late old
      // request settles. load() changes the read epoch but not this identity.
      if (activeMutation.current === entry) { activeMutation.current = null; setBusy(false); }
    }
  }, [canWrite, visible, visibleWorkflow, load, prepareRead]);
  function saveGoal() {
    if (!editor) return;
    const problem = definitionError(editor);
    if (problem) { setNotice({ owner: activeSession.current, target: id, generation: epoch.current, message: problem }); return; }
    void mutate("set_goal", { workflow: editor });
  }

  async function signOut() {
    advanceGeneration(); activeSession.current = null; setSession(null); setDetail(null); setError(null); clearWorkflow();
    try {
      const result = await supabase.auth.signOut();
      if (result.error) throw result.error;
    } catch { setError({ owner: null, target: activeTarget.current, message: "退出请求未完成，请从主页重新核对登录状态。" }); }
  }

  function patchEditor(patch: Partial<Definition>) { setEditor(value => value ? { ...value, ...patch } : null); }
  function patchFile(index: number, patch: Partial<Deliverable>) {
    setEditor(value => {
      if (!value) return null;
      const file = value.deliverables[index];
      const conditions = patch.required === false ? value.conditions.filter(condition => condition.kind !== "file_integrity" || condition.deliverable_id !== file.id) : value.conditions;
      return { ...value, conditions, deliverables: value.deliverables.map((item, i) => i === index ? { ...item, ...patch } : item) };
    });
  }
  function optionalFileField(index: number, key: "path" | "mime_type" | "sha256", value: string) {
    setEditor(draft => {
      if (!draft) return null;
      return { ...draft, deliverables: draft.deliverables.map((file, i) => {
        if (i !== index) return file;
        const next = { ...file }; if (value) next[key] = value; else delete next[key]; return next;
      }) };
    });
  }
  function renderEditor() {
    if (!editor) return null;
    const ownerConditions = editor.conditions.filter(condition => condition.kind === "owner_review");
    return <form className="task-goal-editor" onSubmit={event => { event.preventDefault(); saveGoal(); }}>
      <h3>目标与完成约定</h3>
      <p className="context-muted">保留原任务正文；约定或输入版本变化后，需要按新约定重新核对交付。</p>
      <label>任务目标<textarea required maxLength={4000} value={editor.goal} onChange={event => patchEditor({ goal: event.target.value })} placeholder="这次要达成什么结果" /></label>
      <label>范围与边界<textarea required maxLength={4000} value={editor.scope} onChange={event => patchEditor({ scope: event.target.value })} placeholder="本次覆盖什么，哪些内容留待后续" /></label>
      <label>完成到哪一层<select value={editor.completion_level} onChange={event => patchEditor({ completion_level: event.target.value as Definition["completion_level"] })}>
        {Object.entries(levelNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
      </select></label>
      {editor.completion_level !== "artifact" && <p className="task-limit">目前只核验文件与报告。业务或现实结果会保留为待确认，交付一份报告不能代表该结果完成。</p>}
      <h4>输入资料与版本</h4>
      {editor.input_versions.length === 0 && <p className="context-muted">未约定版本化输入资料。</p>}
      {editor.input_versions.map((input, index) => <div className="task-input-row" key={index}>
        {input.kind === "declared" ? <>
          <label>资料名称<input required maxLength={200} value={input.label} onChange={event => patchEditor({ input_versions: editor.input_versions.map((item, i) => i === index ? { ...item, label: event.target.value } : item) })} /></label>
          <label>声明版本<input required maxLength={80} value={input.version} onChange={event => patchEditor({ input_versions: editor.input_versions.map((item, i) => i === index ? { ...item, version: event.target.value } : item) })} /></label>
          <p className="context-muted">用户声明，未自动核验；接受交付时需由你确认。</p>
        </> : <p>{input.label} · {input.kind === "record" ? "已有记录" : "已归档文件"} · 版本 {input.version}（保留原有精确引用）</p>}
        <button type="button" disabled={busy} onClick={() => patchEditor({ input_versions: editor.input_versions.filter((_, i) => i !== index) })}>移除资料 {index + 1}</button>
      </div>)}
      <button type="button" disabled={busy || editor.input_versions.length >= 16} onClick={() => patchEditor({ acceptance_mode: "owner",
        input_versions: [...editor.input_versions, { label: "", kind: "declared", version: "" }] })}>添加资料版本</button>
      <h4>交付文件</h4>
      {editor.deliverables.map((file, index) => <fieldset key={file.id} className="task-file-expectation"><legend>文件 {index + 1}</legend>
        <label>文件名称<input required maxLength={200} value={file.label} onChange={event => patchFile(index, { label: event.target.value })} /></label>
        <label className="task-checkbox"><input type="checkbox" checked={file.required} onChange={event => patchFile(index, { required: event.target.checked })} />必需文件</label>
        <details><summary>约定文件位置、类型或校验值</summary>
          <p className="context-muted">这些是匹配要求；实际核验依据来自已归档文件的凭据。</p>
          <label>约定位置<input maxLength={1000} value={file.path ?? ""} onChange={event => optionalFileField(index, "path", event.target.value)} placeholder="留空表示不限位置" /></label>
          <label>约定文件类型<input maxLength={200} value={file.mime_type ?? ""} onChange={event => optionalFileField(index, "mime_type", event.target.value)} placeholder="例如 application/pdf；留空表示不限类型" /></label>
          <label>约定 SHA-256<input maxLength={64} value={file.sha256 ?? ""} onChange={event => optionalFileField(index, "sha256", event.target.value.toLowerCase())} placeholder="如有独立提供的原文件校验值，可在这里填写" /></label>
        </details>
        <button type="button" disabled={busy || editor.deliverables.length === 1} onClick={() => patchEditor({
          deliverables: editor.deliverables.filter((_, i) => i !== index), conditions: editor.conditions.filter(condition => condition.deliverable_id !== file.id) })}>移除文件 {index + 1}</button>
      </fieldset>)}
      <button type="button" disabled={busy || editor.deliverables.length >= 16 || editor.conditions.length >= 16} onClick={() => {
        const key = "file-" + crypto.randomUUID().slice(0, 8); patchEditor({ deliverables: [...editor.deliverables, { id: key, label: "", required: true }],
          conditions: [...editor.conditions, { id: "archive-" + key, kind: "file_integrity", text: "文件已归档并通过完整性核验", deliverable_id: key }] });
      }}>添加交付文件</button>
      <h4>完成条件与验收</h4>
      <p className="context-muted">系统逐份核对文件完整性、归档版本及必需文件。内容质量由你确认。</p>
      <label>由谁确认<select value={editor.acceptance_mode} onChange={event => patchEditor({ acceptance_mode: event.target.value as Definition["acceptance_mode"] })}>
        <option value="owner">由我核对内容并接受交付</option>
        <option value="machine" disabled={editor.input_versions.some(input => input.kind === "declared") || ownerConditions.length > 0}>系统核对文件条件后通过</option>
      </select></label>
      {ownerConditions.map((condition, index) => <div key={condition.id}>
        <label>需我核对的内容条件 {index + 1}<textarea required maxLength={1000} value={condition.text} onChange={event => patchEditor({
          conditions: editor.conditions.map(item => item.id === condition.id ? { ...item, text: event.target.value } : item) })} /></label>
        <button type="button" disabled={busy} onClick={() => patchEditor({ conditions: editor.conditions.filter(item => item.id !== condition.id) })}>移除内容条件 {index + 1}</button>
      </div>)}
      <button type="button" disabled={busy || editor.conditions.length >= 16} onClick={() => patchEditor({ acceptance_mode: "owner", conditions: [...editor.conditions,
        { id: "review-" + crypto.randomUUID().slice(0, 8), kind: "owner_review", text: "" }] })}>添加内容条件</button>
      <div className="task-actions"><button type="submit" className="task-primary" disabled={busy || !canWrite}>保存完成约定</button>
        <button type="button" disabled={busy} onClick={() => setEditor(null)}>取消编辑</button></div>
    </form>;
  }
  function renderWorkflow(value: WorkflowRead, editable: boolean) {
    const current = value.task_workflow;
    if (!current) return <>
      <p className="context-muted">此任务尚未设置完成约定。</p>
      {editable && !editor && <button type="button" className="task-primary" onClick={() => setEditor(defaultDefinition())}>设置完成约定</button>}
      {editable && renderEditor()}
    </>;
    const definition = current.definition, completion = current.completion;
    const declared = definition.input_versions.some(input => input.kind === "declared");
    const historical = visible?.record.lifecycle_status !== "active" || visible.record.currentness !== "CURRENT";
    return <>
      <dl><dt>目标</dt><dd>{definition.goal}</dd><dt>范围与边界</dt><dd>{definition.scope}</dd>
        <dt>完成到哪一层</dt><dd>{levelNames[definition.completion_level]}</dd><dt>验收方式</dt><dd>{definition.acceptance_mode === "owner" ? "由我核对内容并接受交付" : "系统核对文件条件"}</dd></dl>
      {definition.completion_level !== "artifact" && <p className="task-limit">业务或现实结果仍待确认；当前交付文件不能证明该结果完成。</p>}
      <h3>输入资料与版本</h3>
      {!definition.input_versions.length ? <p className="context-muted">未约定版本化输入资料。</p> : <ul>{definition.input_versions.map((input, index) => <li key={index}>
        {input.label} · 版本 {input.version} · {input.kind === "declared" ? "用户声明，未自动核验" : current.inputs[index]?.qualification === "verified" ? "精确版本已核对" : "版本状态尚未核实"}
      </li>)}</ul>}
      <h3>完成条件</h3><ul>{definition.conditions.map(condition => <li key={condition.id}>{condition.text}{" · "}{condition.kind === "owner_review" ? "由我核对" : "文件核验"}</li>)}</ul>
      {editable && !editor && <button type="button" onClick={() => setEditor(JSON.parse(JSON.stringify(definition)) as Definition)}>修改完成约定</button>}
      {editable && renderEditor()}
      <h3>文件交付</h3><p className="context-muted">复用已经通过 BeamingFace 归档的文件。排队或结果未知时，文件尚未完成核验。</p>
      {definition.deliverables.map(file => {
        const delivery = current.deliveries.find(item => item.deliverable_id === file.id);
        const binding = current.delivery_refs.find(item => item.deliverable_id === file.id);
        const link = delivery ? fileLink(delivery) : null;
        return <div className="task-delivery" key={file.id}>
          <h4>{file.label}{file.required || definition.conditions.some(condition => condition.kind === "file_integrity" && condition.deliverable_id === file.id) ? " · 必需" : " · 可选"}</h4>
          <p className={"task-delivery-status task-status-" + (delivery?.status ?? "unknown")}>{delivery?.reason === "delivery_missing" ? "尚未关联文件" : delivery ? deliveryNames[delivery.status] : "尚未关联文件"}</p>
          {delivery?.reason && <p>{reasonText(delivery.reason)}</p>}
          {delivery?.path && <p className="task-file-path">{delivery.path}</p>}
          {delivery?.status === "verified" && <>
            <p>归档文件版本：{delivery.provider_file_version} · {delivery.mime_type ? "文件类型：" + delivery.mime_type : "文件类型尚未核验"}</p>
            <p className="context-muted">归档核验时间：{beijing(delivery.verified_at)}。依据已保存的归档凭据与当前登记版本；未在此刻重新读取 Google Drive。</p>
            {link && <a href={link} target="_blank" rel="noreferrer">打开已核验文件</a>}
            <details><summary>查看核验凭据</summary><dl><dt>文件编号</dt><dd><code>{delivery.artifact_id}</code></dd>
              <dt>文件登记版本</dt><dd>{delivery.artifact_version ?? "未提供"}</dd>
              <dt>SHA-256</dt><dd><code>{delivery.sha256}</code></dd><dt>文件大小</dt><dd>{delivery.size == null ? "未提供" : delivery.size + " 字节"}</dd>
              <dt>归档回执</dt><dd><code>{delivery.receipt_id}</code></dd><dt>核验回执</dt><dd><code>{delivery.verified_receipt_id}</code></dd>
              {delivery.registration_receipt_id && <><dt>文件登记回执</dt><dd><code>{delivery.registration_receipt_id}</code></dd></>}</dl></details>
          </>}
          {editable && !editor && <div className="task-bind-actions">
            <label>选择现有文件<select value={selectedJobs[file.id] ?? ""} onChange={event => setSelectedJobs(previous => ({ ...previous, [file.id]: event.target.value }))}>
              <option value="">请选择归档文件</option>{value.delivery_candidates.map(candidate => <option key={candidate.job_id} value={candidate.job_id}>
                {candidate.label || candidate.path} · {jobNames[candidate.state] ?? "待核对"}{candidate.path && " · " + candidate.path}
              </option>)}
            </select></label>
            <button type="button" disabled={!selectedJobs[file.id]} onClick={() => void mutate("bind_delivery", { goal_version: current.goal_version,
              deliverable_id: file.id, job_id: selectedJobs[file.id] })}>关联此文件</button>
            {binding && <button type="button" onClick={() => void mutate("unbind_delivery", { goal_version: current.goal_version, deliverable_id: file.id })}>解除文件关联</button>}
            {!value.delivery_candidates.length && <p className="context-muted">暂无可选的现有归档文件。<Link href="/storage/connections">查看文件目录连接</Link></p>}
          </div>}
        </div>;
      })}
      <h3>完成核验</h3>
      {historical ? <p className="context-muted">{visible?.record.lifecycle_status === "completed" ? "任务已完成，结案说明见上方。" : "此任务处于历史或结束状态。"}此处显示既有约定与本次读取的文件登记状态。</p> : completion.eligible ? <p className="task-status-verified">当前完成条件已满足。</p> : <>
        <p>当前尚不能标记完成。</p><ul>{completion.reasons.map((reason, index) => <li key={index}>{reasonText(reason, definition)}</li>)}</ul>
      </>}
      {definition.acceptance_mode === "machine" && <p className="context-muted">系统核验文件完整性与必需文件；此结果不评价文件内容质量。</p>}
      {!historical && definition.acceptance_mode === "owner" && <p>{completion.owner_accepted ? "你已接受当前版本的交付。" : "请打开文件，核对内容条件后接受交付。"}</p>}
      {declared && <p className="task-limit">{historical ? "输入版本包含用户声明，此声明资料未自动核验。" : "输入版本包含用户声明，仍未自动核验；接受交付表示你已了解并确认这项限制。"}</p>}
      {editable && !editor && <>
        {definition.acceptance_mode === "owner" && !completion.owner_accepted && <button type="button" className="task-primary" disabled={!completion.ready_for_acceptance || definition.completion_level !== "artifact"}
          onClick={() => void mutate("accept", { goal_version: current.goal_version, completion_digest: completion.completion_digest })}>我已核对，接受交付</button>}
        <label>完成说明<textarea maxLength={4000} value={closure.goal_version === current.goal_version ? closure.text : ""}
          onChange={event => setClosure({ goal_version: current.goal_version, text: event.target.value })} placeholder="说明交付结果与本次完成范围" /></label>
        <button type="button" className="task-primary" disabled={!completion.eligible || definition.completion_level !== "artifact"
          || closure.goal_version !== current.goal_version || !closure.text.trim()} onClick={() => void mutate("complete", {
            goal_version: current.goal_version, completion_digest: completion.completion_digest, closure_summary: closure.text })}>按当前约定标记完成</button>
      </>}
      {completion.acceptance_receipt_id && <details><summary>接受交付的凭据</summary><code>{completion.acceptance_receipt_id}</code></details>}
    </>;
  }
  return <main className="context-page owner-confirm">
    <header><Link href="/">BeamingFace</Link> <Link href="/work-claims">谁在做哪个任务</Link> <Link href="/grants">我的授权</Link></header>
    <h1>{visible ? kinds[visible.record.record_type] + "详情" : "任务详情"}</h1>
    <p className="context-muted">查看任务正文和关联记录，并按当前约定核对交付。</p>
    {!ready ? <p role="status">正在读取登录状态…</p> : !session ? <p><Link href="/">登录 BeamingFace</Link> 后查看详情。</p> : <>
      <p className="context-muted">已登录 {session.user.email || session.user.id}</p>
      {!id ? <p role="alert">请使用完整的记录 ID，从认领页的任务链接打开详情。</p> : <>
        {loading && <p role="status">正在读取详情…</p>}
        {visible && <>
          <section aria-label="记录详情">
            <h2>{visible.record.title || "（无标题）"}</h2>
            <dl>
              <dt>ID</dt><dd><code>{visible.record.id}</code></dd>
              <dt>类型</dt><dd>{kinds[visible.record.record_type]}</dd>
              <dt>范围</dt><dd><code>{visible.record.scope}</code></dd>
              <dt>状态</dt><dd>{lifecycleNames[visible.record.lifecycle_status] ?? visible.record.lifecycle_status}</dd>
              {visible.record.record_type === "task" && <><dt>执行安排</dt><dd>{visible.record.execution_bucket ? bucketNames[visible.record.execution_bucket] ?? visible.record.execution_bucket : "未提供"}</dd></>}
              <dt>版本</dt><dd>{visible.record.version}</dd>
              <dt>更新时间</dt><dd>{beijing(visible.record.updated_at)}</dd>
              <dt>当前性</dt><dd>{currentness(visible.record.currentness)}</dd>
            </dl>
            {visible.record.currentness !== "CURRENT" && <p className="context-muted">这份记录的当前性未确认为 CURRENT；请先核对后续记录，不能据此直接执行。</p>}
            <h3>正文</h3><pre>{visible.record.content || "（无正文）"}</pre>
            {visible.record.closure_summary && <><h3>结案说明</h3><pre>{visible.record.closure_summary}</pre></>}
          </section>
          {visible.record.record_type === "task" && <section className="task-workflow" aria-label="任务目标与文件交付">
            <h2>任务目标与文件交付</h2>
            {workflowLoading && <p role="status">正在核对完成约定与文件交付…</p>}
            {visibleWorkflowError && <p role="alert">{visibleWorkflowError}</p>}
            {visibleWorkflow && !sameVersion && <p role="alert">任务在读取期间发生变化，目标与正文版本尚未一致。请刷新后核对。</p>}
            {sameVersion && renderWorkflow(visibleWorkflow, canWrite)}
            {visibleNotice && <p role={uncertain ? "alert" : "status"}>{visibleNotice}</p>}
          </section>}
          <section aria-label="关联记录"><h2>关联记录</h2>
            {visible.related.length === 0 ? <p className="context-muted">没有可查看的关联记录。</p> : <ul>{visible.related.map(record => <li key={record.id}>
              <Link href={"/tasks?id=" + record.id.toLowerCase()}>{kinds[record.record_type]}：{record.title || "（无标题）"}</Link>
              {" · "}<code>{record.id}</code>{" · "}{record.scope}{" · "}{currentness(record.currentness)}
            </li>)}</ul>}
          </section>
          {visible.record.record_type === "task" && <>
            <section aria-label="任务进行中的认领"><h2>任务进行中的认领（最多 100 条）</h2>
              {visible.claims.length === 0 ? <p className="context-muted">目前没有进行中的认领。</p> : visible.claims.map(claim => claimRow(claim))}
            </section>
            <section aria-label="任务最近结束的认领"><h2>最近 24 小时结束的认领（最多 100 条）</h2>
              {visible.ended.length === 0 ? <p className="context-muted">没有。</p> : visible.ended.map(claim => claimRow(claim))}
            </section>
          </>}
        </>}
        <button type="button" disabled={loading || busy} onClick={refresh}>刷新</button>
      </>}
      <button type="button" onClick={() => void signOut()}>退出登录</button>
    </>}
    {visibleError && <p role="alert">{visibleError}</p>}
  </main>;
}

// Whitelisted public Owner-list fields only. In particular, do not serialize
// the row: private lease keys and hashes must never be displayed or persisted.
function claimRow(claim: Json) {
  const state = text(claim.state) || text(claim.status);
  const pull = pullUrl(claim.bound_pr), link = sessionUrl(claim.holder_session_url);
  const ref = text(claim.holder_session_ref);
  return <div className="owner-grant" key={text(claim.claim_id)}><dl>
    <dt>Agent</dt><dd>{text(claim.holder_client) || "客户端未报"}{text(claim.holder_client) && "（Agent 自报）"}{" · 连接 "}
      {text(claim.holder_name)}{text(claim.holder_vendor) && "（" + text(claim.holder_vendor) + "）"}{claim.holder_connection_live === false && " · 连接已断开"}</dd>
    <dt>会话</dt><dd>{text(claim.holder_session_title) || "标题未报"}{text(claim.holder_session_title) && "（Agent 自报）"}{" · "}
      {link ? <a href={link} target="_blank" rel="noreferrer">打开会话 {ref}</a> : <code>{ref || "会话 ID 未报"}</code>}</dd>
    <dt>在做什么</dt><dd>{text(claim.holder_label) || "Agent 没有填标签"}{text(claim.holder_label) && "（Agent 自报）"}</dd>
    <dt>认领</dt><dd><code>{text(claim.claim_id)}</code>{" · fence "}{Number.isSafeInteger(claim.fence) ? String(claim.fence) : "?"}</dd>
    <dt>状态</dt><dd>{states[state] ?? state}{state === "RELEASED" && text(claim.released_outcome) && "（" + (outcomes[text(claim.released_outcome)] ?? text(claim.released_outcome)) + "）"}
      {text(claim.ended_at) && " · 结束于 " + beijing(claim.ended_at)}</dd>
    <dt>领取</dt><dd>{beijing(claim.issued_at)}</dd>
    <dt>到期</dt><dd>{beijing(claim.expires_at)}</dd>
    <dt>最晚到期</dt><dd>{beijing(claim.hard_deadline_at)}</dd>
    <dt>续期</dt><dd>{Number.isSafeInteger(claim.renewals) ? String(claim.renewals) : "?"}{" / "}
      {Number.isSafeInteger(claim.max_renewals) ? String(claim.max_renewals) : "?"} 次{text(claim.progress_ref) && <> · 最近进展 <code>{text(claim.progress_ref)}</code></>}</dd>
    <dt>关联 PR</dt><dd>{pull ? <a href={pull} target="_blank" rel="noreferrer">{text(claim.bound_pr)}</a> : text(claim.bound_pr) || "无"}</dd>
    <dt>改动范围</dt><dd><ul>{Array.isArray(claim.write_set) && claim.write_set.filter(value => typeof value === "string").map(item => <li key={item}><code>{item}</code></li>)}</ul></dd>
  </dl><hr /></div>;
}
