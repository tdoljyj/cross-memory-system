"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "../../supabase-browser";
type Connection = { id: string; provider: string; state: string; version: number; root_name: string };
type RecoveryDiagnostic = { stage: string; reason: string; observed_at: string; automatic_next_action: string };
type RecoveryView = { job_id: string; connection_id?: string; read_connection_id?: string; status: string; receipt_id: string; diagnostic?: RecoveryDiagnostic;
  review_available?: boolean; abandon_available?: boolean; file_name?: string; base_version?: number; source_receipt_id?: string; resolution?: string;
  automatic_recovery?: "pending" | "current_state_conflict" | "resolved" };
type AbandonConfirmation = { connection_id: string; context_connection_id: string; connection_version: number; job_id: string; base_version: number;
  source_receipt_id: string; file_name?: string; epoch: number };
type ReviewObservation = { connection_id: string; context_connection_id: string; context_connection_version: number; job_id: string; observation_id: string; base_version: number; source_receipt_id: string;
  observed_at: string; observed_state: string; file_name: string; provider_file_id: string | null;
  provider_file_version: string | null; mime_type: string | null; size: number | string | null; sha256: string | null; epoch: number };
type RecoveryConfirmation = { connection_id: string; connection_version: number; job_id: string; receipt_id: string;
  status: string; epoch: number; action: "authorize" };
const recoveryLabels: Record<string, string> = { queued: "排队中", prepared: "准备执行", started: "正在自动核验执行结果", uncertain: "正在自动恢复",
  committed: "已完成并登记", cancelled: "未完成，已结束原作业", denied: "未获执行许可", attention_required: "存在需要处理的异常", conflict: "检测到结果冲突，正在恢复", resolved: "原作业异常已处理" };
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const recoveryReasons: Record<string, string> = {
  REQUEST_UNAVAILABLE: "本次状态请求未能完成", DESCRIPTOR_UNAVAILABLE: "原作业的恢复信息暂不可用",
  CREDENTIAL_UNAVAILABLE: "Google 访问凭据暂不可用", CREDENTIAL_EXPIRING: "Google 访问凭据需要续期",
  PROVIDER_TIMEOUT: "Google 响应超时", PROVIDER_UNAVAILABLE: "Google 暂时不可用", PROVIDER_RESPONSE_INVALID: "Google 返回的信息不完整",
  PROVIDER_IDENTITY_CHANGED: "文件或 Google 账号身份发生变化", REVISION_UNCHANGED: "文件仍是写入前的版本",
  CONTENT_MISMATCH: "文件内容与这次操作的预期结果不同", PREVIOUS_REVISION_UNCONFIRMED: "原文件版本的保留状态尚未确认",
  RESULT_NOT_YET_VISIBLE: "Google 尚未返回预期结果", VERIFIED_RECORD_UNCONFIRMED: "核验结果的登记尚未完成",
  SETTLEMENT_UNCONFIRMED: "最终登记尚未完成", UNKNOWN_EFFECT: "原作业的最终结果尚未确定",
};
const recoveryStages = new Set(["request", "descriptor", "credential", "provider", "verification", "verified_record", "settlement"]);
const recoveryActions: Record<string, string> = { retry_metadata: "系统会自动重新读取 Google 状态。",
  check_existing_authorization: "系统会检查现有授权；确实失效时才需要重新授权。", inspect_original_receipt: "系统会读取原作业回执，避免重复执行。",
  continue_object_recovery: "系统继续恢复这个对象；相关限制不会作为修复完成。", none: "" };
function recoveryView(value: unknown): RecoveryView | null {
  if (!isObject(value) || typeof value.job_id !== "string" || !uuid.test(value.job_id) || typeof value.status !== "string" ||
    !Object.hasOwn(recoveryLabels, value.status) || typeof value.receipt_id !== "string" || !uuid.test(value.receipt_id)) return null;
  const view: RecoveryView = { job_id: value.job_id, status: value.status, receipt_id: value.receipt_id };
  for (const key of ["connection_id", "read_connection_id"] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "string" || !uuid.test(value[key])) return null;
      view[key] = value[key];
    }
  }
  if (value.automatic_recovery !== undefined) {
    if (!["pending", "current_state_conflict", "resolved"].includes(String(value.automatic_recovery))) return null;
    view.automatic_recovery = value.automatic_recovery as RecoveryView["automatic_recovery"];
    if (value.automatic_recovery === "resolved" && (value.status !== "resolved" ||
      !["automatically_reconciled_before", "automatically_registered_current_state"].includes(String(value.resolution)))) return null;
    if (value.automatic_recovery !== "resolved" && ["resolved", "committed", "cancelled", "denied"].includes(value.status)) return null;
  }
  if (value.status === "resolved") {
    if (!["accepted_current_state", "abandoned_registration", "automatically_reconciled_before", "automatically_registered_current_state"].includes(String(value.resolution))) return null;
    if (["automatically_reconciled_before", "automatically_registered_current_state"].includes(String(value.resolution))) {
      if (value.automatic_recovery !== "resolved" || !Number.isSafeInteger(value.base_version) || Number(value.base_version) < 1 ||
        typeof value.source_receipt_id !== "string" || !uuid.test(value.source_receipt_id) || value.source_receipt_id === value.receipt_id) return null;
      view.base_version = Number(value.base_version); view.source_receipt_id = value.source_receipt_id;
    }
    view.resolution = String(value.resolution);
  }
  // The server also grants legacy/non-candidate exits without an automatic
  // recovery marker. Only an explicit pending/terminal result suppresses them.
  if (value.automatic_recovery !== "pending" && value.automatic_recovery !== "resolved" &&
    ["conflict", "attention_required"].includes(value.status) &&
    (value.review_available === true || value.abandon_available === true) && Number.isSafeInteger(value.base_version) && Number(value.base_version) > 0 &&
    typeof value.source_receipt_id === "string" && uuid.test(value.source_receipt_id)) {
    view.review_available = value.review_available === true; view.abandon_available = value.abandon_available === true;
    view.base_version = Number(value.base_version); view.source_receipt_id = value.source_receipt_id;
    if (typeof value.file_name === "string" && value.file_name.trim() && value.file_name.length <= 255 && !/[\u0000-\u001f\u007f/\\]/.test(value.file_name)) view.file_name = value.file_name;
  }
  const d = value.diagnostic;
  if (isObject(d) && typeof d.stage === "string" && recoveryStages.has(d.stage) && typeof d.reason === "string" &&
    Object.hasOwn(recoveryReasons, d.reason) && typeof d.automatic_next_action === "string" && Object.hasOwn(recoveryActions, d.automatic_next_action) &&
    typeof d.observed_at === "string" && Number.isFinite(Date.parse(d.observed_at))) {
    view.diagnostic = { stage: d.stage, reason: d.reason, observed_at: d.observed_at, automatic_next_action: d.automatic_next_action };
  }
  return view;
}
function recoveryTitle(view: RecoveryView) {
  if (view.automatic_recovery === "pending") return "系统正在自动恢复";
  if (["automatically_reconciled_before", "automatically_registered_current_state"].includes(String(view.resolution))) return "已自动恢复使用";
  if (view.automatic_recovery === "current_state_conflict") return "当前文件状态存在冲突";
  return recoveryLabels[view.status];
}
function recoveryExplanation(view: RecoveryView) {
  if (view.resolution === "automatically_registered_current_state") return "系统已重新核验当前目录及父级权限，更新登记并恢复使用；原操作结果未确认的历史保留。";
  if (view.resolution === "automatically_reconciled_before") return "当前文件与原登记一致，系统已自动恢复使用；原操作结果未确认的历史保留。";
  if (view.automatic_recovery === "pending") return "系统会自动核验并处理这个原作业，关闭页面后仍会继续。无需手工确认或重新提交。";
  if (view.automatic_recovery === "current_state_conflict") return "当前文件状态与原操作预期不同；其他文件可继续使用。你可以查看文件后选择处理方式。";
  if (view.resolution === "accepted_current_state") return "已按 Google 当前文件状态恢复登记和使用；原操作历史保留。";
  if (view.resolution === "abandoned_registration") return "已停止管理这个文件；Google 文件没有删除。";
  return view.diagnostic ? `${recoveryReasons[view.diagnostic.reason]}。${recoveryActions[view.diagnostic.automatic_next_action]}` : recoveryLabels[view.status];
}
type RefreshStatus = { enabled: boolean; authorized_enabled?: boolean;
  pause_reason?: "none" | "reauthorization_required" | "connection_inactive" | "failure_limit" | "backoff";
  version: number; connection_version: number; failures: number; pending: boolean; next_refresh_at: string | null };
type RenewalConfirmation = { connection_id: string; action: "enable" | "disable"; epoch: number;
  connection_version: number; delegation_version: number };
const renewalAuthorized = (status: RefreshStatus) => status.authorized_enabled ?? status.enabled;
const renewalPause = { none: "", reauthorization_required: "；连接需重新授权，续签暂时暂停，授权成功后自动恢复",
  connection_inactive: "；连接当前不可用，续签暂时暂停", failure_limit: "；连续失败已达上限，自动尝试已暂停，重新授权后恢复",
  backoff: "；续签暂时失败，正在等待有限重试" };
const probeStages: Record<string, string> = { request: "请求验证", prepare: "账号与目录当前状态", descriptor: "目录配置", credential: "连接凭据与有效期",
  identity: "Google 账号身份", directories: "Google 目录元数据与权限", boundary: "父级与同级目录边界", receipt: "最终状态复核与回执" };
const probeReasons: Record<string, string> = { DIRECTORY_NOT_APP_AUTHORIZED: "至少一个登记目录尚未通过当前应用的目录管理检查", DIRECTORY_NOT_WRITABLE: "至少一个目录当前不允许新建内容",
  DIRECTORY_APP_AUTHORIZATION_UNCONFIRMED: "Google 未返回完整的目录资格信息", DIRECTORY_WRITE_CAPABILITY_UNCONFIRMED: "Google 未返回完整的新建能力信息",
  IDENTITY_INVALID: "提供方返回的对象身份字段不完整或无效", PARENT_INVALID: "父目录身份不符合登记", LAYOUT_INVALID: "登记布局不符合检查合同",
  DIRECTORY_CHANGED: "目录名称、位置或版本发生变化", PATH_AMBIGUOUS: "目录存在同名或身份冲突", SHORTCUT_UNQUALIFIED: "检测到尚未纳入资格验证的快捷方式",
  DIRECTORY_NOT_LISTED: "目录枚举结果缺少已登记对象", ENUMERATION_INVALID: "目录枚举未确认", ENTRY_LIMIT: "目录数量超过本次检查上限",
  OBSERVATION_EXPIRED: "本次检查超过时间限制", CLOCK_INVALID: "检查时钟未确认",
  PROVIDER_AUTHENTICATION_REJECTED: "Google 未接受当前访问凭据", PROVIDER_ACCESS_REJECTED: "Google 拒绝了这次元数据访问",
  PROVIDER_OBJECT_UNAVAILABLE: "Google 未返回所查询的登记对象", PROVIDER_RATE_LIMITED: "Google 暂时限制了请求频率",
  PROVIDER_SERVER_UNAVAILABLE: "Google 服务暂时不可用", PROVIDER_RESPONSE_REJECTED: "Google 未接受这次请求",
  PROVIDER_TIMEOUT: "Google 单次元数据请求超时", RUNTIME_SUBREQUEST_LIMIT: "云端运行环境达到单次外部请求上限",
  PROVIDER_REDIRECT_REJECTED: "Google 请求出现不允许的跳转", PROVIDER_RESPONSE_INVALID: "Google 响应格式无效",
  METADATA_ID_MISMATCH: "Google 返回的对象 ID 与查询不一致", PAGINATION_INVALID: "目录分页标记无效或重复",
  PAGINATION_LIMIT: "目录分页超过本次检查上限", NAMESPACE_VISIBILITY_UNPROVEN: "目录枚举所需的只读元数据权限未确认",
  UNAUTHORIZED_WORKSPACE_MUTATION: "发现未登记的 BeamingFace 资料位置（UNAUTHORIZED_WORKSPACE_MUTATION）",
  BOUNDARY_PROFILE_UNQUALIFIED: "边界配置未通过验证", BOUNDARY_IDENTITY_INVALID: "边界对象身份无效",
  BOUNDARY_ROOT_CHANGED: "资料根身份发生变化", BOUNDARY_ALIAS_OR_CYCLE: "边界存在重复引用或循环",
  BOUNDARY_FOLDER_INVALID: "边界目录类型无效", BOUNDARY_CHANGED: "扫描期间边界发生变化",
  BOUNDARY_ENUMERATION_INVALID: "边界枚举不完整", BOUNDARY_ENTRY_LIMIT: "边界条目超过检查上限",
  BOUNDARY_PATH_AMBIGUOUS: "边界存在同名或路径冲突", BOUNDARY_SHORTCUT_UNQUALIFIED: "边界存在未验证的快捷方式",
  BOUNDARY_DEPTH_LIMIT: "边界目录深度超过检查上限", BOUNDARY_ROOT_NOT_LISTED: "边界枚举缺少资料根" };
class ProbeRequestError extends Error {
  constructor(message: string, readonly hasDirectoryIssues = false) { super(message); }
}
const directoryIssueLabels: Record<string,string> = {
  DIRECTORY_NOT_APP_AUTHORIZED:"尚未通过当前应用的目录管理检查",
  DIRECTORY_APP_AUTHORIZATION_UNCONFIRMED:"Google 未返回完整的目录资格信息",
  DIRECTORY_NOT_WRITABLE:"当前不允许新建内容",
  DIRECTORY_WRITE_CAPABILITY_UNCONFIRMED:"Google 未返回完整的新建能力信息",
};
function directoryIssueSummary(value: unknown): string {
  if (!isObject(value) || value.contract!=="clued.storage-directory-diagnostic/1" ||
    !Number.isSafeInteger(value.total_directories) || Number(value.total_directories)<1 || Number(value.total_directories)>1024 ||
    value.checked_directories!==value.total_directories || !Number.isSafeInteger(value.failed_directories) ||
    Number(value.failed_directories)<1 || Number(value.failed_directories)>Number(value.total_directories) ||
    !Array.isArray(value.failures) || value.failures.length!==Math.min(Number(value.failed_directories),16) ||
    value.truncated!==(Number(value.failed_directories)>16)) return "";
  const seen = new Set<string>(), rows: string[] = [];
  for (const item of value.failures) {
    if (!isObject(item) || typeof item.path!=="string" || !item.path.length || item.path.length>1000 ||
      /[\u0000-\u001f\u007f]/.test(item.path) || typeof item.provider_file_id!=="string" ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(item.provider_file_id) || seen.has(item.path) ||
      !Array.isArray(item.reasons) || item.reasons.length<1 || item.reasons.length>2 ||
      new Set(item.reasons).size!==item.reasons.length ||
      item.reasons.some(reason=>typeof reason!=="string" || !Object.hasOwn(directoryIssueLabels,reason))) return "";
    seen.add(item.path);
    rows.push(`${item.path}：${item.reasons.map(reason=>directoryIssueLabels[String(reason)]).join("；")}`);
  }
  return `已核对 ${value.checked_directories} 个登记目录，${value.failed_directories} 个目录的资格未确认。\n${rows.join("\n")}${value.truncated ? `\n仅显示前 16 个，另有 ${Number(value.failed_directories)-16} 个目录未列出。` : ""}\n`;
}
class ReviewRefreshError extends Error {}
async function request(path: string, body: object | undefined, stillCurrent: () => boolean = () => true) {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error("请先登录 BeamingFace，再返回此页。");
  if (!stillCurrent()) throw new Error("账号或页面已变化，请重新确认。");
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", authorization: "Bearer " + data.session.access_token },
    body: JSON.stringify(body), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!stillCurrent()) throw new Error("账号或页面已变化，请重新确认。");
  if (!response.ok) {
    if (path === "/v1/storage/refresh" && response.status === 404) throw new Error("后台续签服务暂未开放，请稍后重新查询；当前续签设置没有改变。");
    if (path === "/v1/storage/google/probe" && response.status === 403) {
      const failure: unknown = await response.json().catch(() => null);
      if (isObject(failure) && failure.execution_permitted === false && isObject(failure.diagnostic)) {
        const { stage, reason } = failure.diagnostic;
        if (typeof stage === "string" && Object.hasOwn(probeStages, stage) && typeof reason === "string" &&
          (reason === "UNCONFIRMED" || Object.hasOwn(probeReasons, reason))) {
          const summary = stage === "directories" ? directoryIssueSummary(failure.diagnostic.directories) : "";
          const localIssue = stage === "directories" && Object.hasOwn(directoryIssueLabels, reason);
          throw new ProbeRequestError(`${summary || `目录检查未确认：${probeStages[stage]}${reason === "UNCONFIRMED" ? "" : `；${probeReasons[reason]}`}。`}${localIssue ? "个别目录资格未确认，其他已获授权的目录仍可正常使用。" : ""}本次检查不会自动重试或更改授权。`, Boolean(summary));
        }
      }
    }
    throw new Error(response.status === 404 ? "账号存储连接尚未开放，原入口未切换。" : "操作未确认，请刷新状态后检查；不会自动重试或放宽权限。");
  }
  const value: unknown = await response.json();
  const current = await supabase.auth.getSession();
  if (!stillCurrent() || current.error || current.data.session?.user.id !== data.session.user.id) throw new Error("账号已变化，请重新读取连接。");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("响应未确认。");
  return value as Record<string, unknown>;
}
const labels: Record<string, string> = { awaiting_provider: "等待 Google 授权", active: "Google 连接已建立（不代表文件写入已启用）", reauthorization_required: "需要重新授权", revoked: "已停用" };
export default function StorageConnections() {
  const [connections, setConnections] = useState<Connection[]>([]), [message, setMessage] = useState("正在读取……"), [busy, setBusy] = useState(false);
  const [renewals, setRenewals] = useState<Record<string, RefreshStatus>>({});
  const [renewalConfirmation, setRenewalConfirmation] = useState<RenewalConfirmation | null>(null);
  const renewalChoice = useRef<RenewalConfirmation | null>(null);
  const [probeMessages, setProbeMessages] = useState<Record<string, string>>({});
  const [recoveryJobs, setRecoveryJobs] = useState<Record<string, string>>({}), [recoveryViews, setRecoveryViews] = useState<Record<string, RecoveryView>>({});
  const [automaticJobs, setAutomaticJobs] = useState<Record<string, RecoveryView[]>>({});
  const [automaticMessages, setAutomaticMessages] = useState<Record<string, string>>({});
  const [recoveryConfirmation, setRecoveryConfirmation] = useState<RecoveryConfirmation | null>(null);
  const [reviewObservation, setReviewObservation] = useState<ReviewObservation | null>(null);
  const [abandonConfirmation, setAbandonConfirmation] = useState<AbandonConfirmation | null>(null);
  const [profileId, setProfileId] = useState(""), [decisionId, setDecisionId] = useState("");
  const registrationBusy = useRef(false);
  const operationBusy = useRef(false);
  const revision = useRef(0);
  const accountId = useRef<string | null>(null);
  const confirmation = useRef<RecoveryConfirmation | null>(null);
  const review = useRef<ReviewObservation | null>(null);
  const abandon = useRef<AbandonConfirmation | null>(null);
  const recoveryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const recoveryReads = useRef(new Map<string, number>());
  const recoveryLatest = useRef<Record<string, RecoveryView[]>>({});
  const loadRecoveries = useCallback(async function load(c: Connection, epoch: number) {
    if (epoch !== revision.current) return;
    const read = (recoveryReads.current.get(c.id) ?? 0) + 1;
    recoveryReads.current.set(c.id, read);
    const current = () => epoch === revision.current && recoveryReads.current.get(c.id) === read;
    clearTimeout(recoveryTimers.current.get(c.id)); recoveryTimers.current.delete(c.id);
    let shouldPoll = false;
    setAutomaticMessages(old => ({ ...old, [c.id]: "正在自动读取文件操作的恢复状态……" }));
    try {
      const result = await request("/v1/storage/recovery", { action: "list", connection_id: c.id }, current);
      if (!current()) return;
      if (result.execution_permitted !== false || result.connection_id !== c.id || !Array.isArray(result.jobs) || result.jobs.length > 20 ||
        !result.jobs.every(job => isObject(job) && typeof job.connection_id === "string" && uuid.test(job.connection_id) &&
          (job.read_connection_id !== undefined ? job.read_connection_id === c.id : job.connection_id === c.id) &&
          job.execution_permitted === false)) throw new Error("Invalid recovery list");
      const jobs = result.jobs.map(recoveryView);
      if (jobs.some(job => job === null) || new Set(jobs.map(job => job!.job_id)).size !== jobs.length) throw new Error("Invalid recovery list");
      const views = jobs as RecoveryView[];
      recoveryLatest.current[c.id] = views;
      if (review.current?.context_connection_id === c.id && !views.some(job => job.review_available && job.connection_id === review.current?.connection_id && job.job_id === review.current?.job_id &&
          job.base_version === review.current?.base_version && job.source_receipt_id === review.current?.source_receipt_id)) {
        review.current = null; setReviewObservation(null);
      }
      if (abandon.current?.context_connection_id === c.id && !views.some(job => job.abandon_available && job.connection_id === abandon.current?.connection_id && job.job_id === abandon.current?.job_id &&
          job.base_version === abandon.current?.base_version && job.source_receipt_id === abandon.current?.source_receipt_id)) {
        abandon.current = null; setAbandonConfirmation(null);
      }
      shouldPoll = views.some(job => ["prepared", "started", "uncertain", "conflict", "attention_required"].includes(job.status));
      setAutomaticJobs(old => ({ ...old, [c.id]: views }));
      setAutomaticMessages(old => ({ ...old, [c.id]: !views.length ? "没有需要恢复的文件操作。"
        : shouldPoll ? "系统正在自动处理以下原作业，关闭页面后仍会继续。" : "文件操作恢复结果如下。" }));

    } catch {
      shouldPoll = true;
      if (current()) {
        delete recoveryLatest.current[c.id];
        if (review.current?.context_connection_id === c.id) { review.current = null; setReviewObservation(null); }
        if (abandon.current?.context_connection_id === c.id) { abandon.current = null; setAbandonConfirmation(null); }
        setAutomaticMessages(old => ({ ...old, [c.id]: "暂时未能读取恢复进度；后台恢复不依赖这个页面。系统会重新读取状态，不会重复文件操作。" }));
      }
    } finally {
      // Poll only the scoped status. The background worker owns recovery and
      // backoff; a status poll never sends settlement or a provider effect.
      if (current() && shouldPoll) recoveryTimers.current.set(c.id, setTimeout(() => { void load(c, epoch); }, 30_000));
    }
  }, []);
  const refresh = useCallback(async () => {
    const epoch = ++revision.current;
    for (const timer of recoveryTimers.current.values()) clearTimeout(timer); recoveryTimers.current.clear();
    confirmation.current = null; setRecoveryConfirmation(null);
    review.current = null; setReviewObservation(null);
    abandon.current = null; setAbandonConfirmation(null);
    setRenewals({}); renewalChoice.current = null; setRenewalConfirmation(null);
    setProbeMessages({});
    setRecoveryJobs({}); setRecoveryViews({});
    recoveryLatest.current = {}; setAutomaticJobs({}); setAutomaticMessages({});
    setBusy(true);
    try { const result = await request("/v1/storage/owner", { action: "connections" }, () => epoch === revision.current);
      if (epoch !== revision.current) return;
      if (!Array.isArray(result.connections) || !result.connections.every(c => isObject(c) && typeof c.id === "string" && typeof c.provider === "string" && typeof c.state === "string" &&
        Number.isSafeInteger(c.version) && typeof c.root_name === "string" && c.root_name.trim().length > 0)) throw new Error("连接列表未确认。");
      setConnections(result.connections); setMessage(result.connections.length ? "" : "暂无已登记连接。请先完成受治理目录登记。");
      for (const c of result.connections.slice(0, 5)) void loadRecoveries(c, epoch);
    } catch (error) { if (epoch === revision.current) { setConnections([]); setMessage(error instanceof Error ? error.message : "无法读取连接。"); } }
    finally { if (epoch === revision.current) setBusy(false); }
  }, [loadRecoveries]);
  useEffect(() => {
    let disposed = false;
    const liveRevision = revision;
    const scheduleRead = () => queueMicrotask(() => { if (!disposed) void refresh(); });
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (disposed) return;
      const nextAccount = session?.user.id ?? null;
      // getSession can refresh the token during a button request. The same
      // account's refreshed credential does not invalidate its connection/CAS view.
      if (event === "TOKEN_REFRESHED" && nextAccount !== null && nextAccount === accountId.current) return;
      accountId.current = nextAccount;
      ++revision.current; setConnections([]); setRenewals({}); renewalChoice.current = null; setRenewalConfirmation(null); setProfileId(""); setDecisionId("");
      for (const timer of recoveryTimers.current.values()) clearTimeout(timer); recoveryTimers.current.clear();
      confirmation.current = null; setRecoveryConfirmation(null); recoveryLatest.current = {}; setAutomaticJobs({}); setAutomaticMessages({});
      review.current = null; setReviewObservation(null);
      abandon.current = null; setAbandonConfirmation(null);
      setProbeMessages({});
      setRecoveryJobs({}); setRecoveryViews({});
      // Do not await Supabase calls from inside its auth callback lock.
      scheduleRead();
    });
    scheduleRead();
    const timers = recoveryTimers.current;
    return () => { disposed = true; ++liveRevision.current; confirmation.current = null; review.current = null; abandon.current = null;
      for (const timer of timers.values()) clearTimeout(timer); timers.clear(); data.subscription.unsubscribe(); };
  }, [refresh]);
  function confirmAbandon(c: Connection, job: RecoveryView) {
    if (busy || operationBusy.current || registrationBusy.current || !job.abandon_available || !job.base_version || !job.source_receipt_id ||
      !job.connection_id || !(recoveryLatest.current[c.id] ?? []).some(item => item.connection_id === job.connection_id && item.job_id === job.job_id && item.abandon_available &&
        item.base_version === job.base_version && item.source_receipt_id === job.source_receipt_id)) return;
    const snapshot = { connection_id: job.connection_id, context_connection_id: c.id, connection_version: c.version, job_id: job.job_id, base_version: job.base_version,
      source_receipt_id: job.source_receipt_id, file_name: job.file_name, epoch: revision.current };
    review.current = null; setReviewObservation(null); confirmation.current = null; setRecoveryConfirmation(null);
    abandon.current = snapshot; setAbandonConfirmation(snapshot);
  }
  async function abandonRegistration(c: Connection, approved: AbandonConfirmation) {
    if (busy || operationBusy.current || registrationBusy.current || abandon.current !== approved || approved.epoch !== revision.current ||
        approved.context_connection_id !== c.id || approved.connection_version !== c.version || !(automaticJobs[c.id] ?? []).some(job =>
          job.abandon_available && job.connection_id === approved.connection_id && job.job_id === approved.job_id && job.base_version === approved.base_version && job.source_receipt_id === approved.source_receipt_id)) return;
    const epoch = revision.current;
    abandon.current = null; setAbandonConfirmation(null); operationBusy.current = true; setBusy(true);
    try {
      const value = await request("/v1/storage/recovery", { action: "review_abandon", connection_id: approved.connection_id, job_id: approved.job_id,
        base_version: approved.base_version, source_receipt_id: approved.source_receipt_id, confirmed: true }, () => epoch === revision.current);
      if (epoch !== revision.current) return;
      if (value.status !== "resolved" || value.resolution !== "abandoned_registration" || value.connection_id !== approved.connection_id || value.job_id !== approved.job_id ||
          value.execution_permitted !== false || typeof value.receipt_id !== "string" || !uuid.test(value.receipt_id)) throw new Error("Unconfirmed withdrawal");
      setMessage("已停止管理相关旧登记并解除这条保护；Google 文件没有删除，原作业历史保留。");
    } catch {
      if (epoch === revision.current) setMessage("本次处理结果尚未确认，正在读取原作业状态；不会再次提交或改动 Google 文件。");
    } finally {
      operationBusy.current = false;
      if (epoch === revision.current) { setBusy(false); void loadRecoveries(c, epoch); }
    }
  }
  async function prepareReview(c: Connection, job: RecoveryView) {
    if (busy || operationBusy.current || registrationBusy.current || !job.review_available || !job.connection_id ||
      !(recoveryLatest.current[c.id] ?? []).some(item => item.connection_id === job.connection_id && item.job_id === job.job_id && item.review_available &&
        item.base_version === job.base_version && item.source_receipt_id === job.source_receipt_id)) return;
    const epoch = revision.current, read = recoveryReads.current.get(c.id);
    operationBusy.current = true; setBusy(true); review.current = null; setReviewObservation(null); abandon.current = null; setAbandonConfirmation(null);
    try {
      const value = await request("/v1/storage/recovery", { action: "review_prepare", connection_id: job.connection_id, job_id: job.job_id }, () => epoch === revision.current);
      if (epoch !== revision.current || recoveryReads.current.get(c.id) !== read) return;
      if (value.status !== "review_prepared" || value.execution_permitted !== false || value.connection_id !== job.connection_id || value.job_id !== job.job_id ||
        typeof value.observation_id !== "string" || !uuid.test(value.observation_id) || value.base_version !== job.base_version ||
        value.source_receipt_id !== job.source_receipt_id || typeof value.observed_at !== "string" || !Number.isFinite(Date.parse(value.observed_at)) ||
        !["before", "after", "changed", "absent"].includes(String(value.observed_state)) || typeof value.file_name !== "string" ||
        !value.file_name.trim() || value.file_name.length > 255 || /[\u0000-\u001f\u007f]/.test(value.file_name) ||
        !(value.provider_file_id === null || typeof value.provider_file_id === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value.provider_file_id)) ||
        !(value.provider_file_version === null || typeof value.provider_file_version === "string" && /^[0-9]{1,30}$/.test(value.provider_file_version)) ||
        !(value.mime_type === null || typeof value.mime_type === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(value.mime_type)) ||
        !(value.size === null || typeof value.size === "string" && /^[0-9]{1,30}$/.test(value.size) || Number.isSafeInteger(value.size) && Number(value.size) >= 0) ||
        !(value.sha256 === null || typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256))) throw new Error("Invalid review observation");
      if (job.automatic_recovery === "current_state_conflict" && (value.observed_state === "before" || value.observed_state === "after")) {
        setMessage("当前文件状态无需人工取舍，后台程序会继续自动核验并处理原作业。");
        void loadRecoveries(c, epoch); return;
      }
      const observation = { ...value, context_connection_id: c.id, context_connection_version: c.version, epoch } as ReviewObservation;
      review.current = observation; setReviewObservation(observation);
    } catch {
      if (epoch === revision.current) setMessage("当前文件状态尚未读全，暂不显示确认操作。系统继续恢复原作业。");
    } finally { operationBusy.current = false; if (epoch === revision.current) setBusy(false); }
  }
  async function resolveReview(c: Connection, observation: ReviewObservation, action: "review_accept" | "review_abandon") {
    if (busy || operationBusy.current || registrationBusy.current || review.current !== observation ||
      observation.epoch !== revision.current || observation.context_connection_id !== c.id || observation.context_connection_version !== c.version ||
      !(recoveryLatest.current[c.id] ?? []).some(job => job.connection_id === observation.connection_id && job.job_id === observation.job_id &&
        job.base_version === observation.base_version && job.source_receipt_id === observation.source_receipt_id)) return;
    const epoch = revision.current;
    // Consume the displayed observation once. A stale, cancelled or double
    // clicked confirmation cannot submit an acceptance for another object.
    review.current = null; setReviewObservation(null); operationBusy.current = true; setBusy(true);
    try {
      const value = await request("/v1/storage/recovery", { action, connection_id: observation.connection_id, job_id: observation.job_id,
        base_version: observation.base_version, source_receipt_id: observation.source_receipt_id, confirmed: true,
        ...(action === "review_accept" ? { observation_id: observation.observation_id } : {}) }, () => epoch === revision.current);
      if (epoch !== revision.current) return;
      if (value.review_error === "REVIEW_REFRESH_REQUIRED") throw new ReviewRefreshError();
      const resolution = action === "review_accept" ? "accepted_current_state" : "abandoned_registration";
      if (value.status !== "resolved" || value.resolution !== resolution || value.connection_id !== observation.connection_id || value.job_id !== observation.job_id ||
        value.execution_permitted !== false || typeof value.receipt_id !== "string" || !uuid.test(value.receipt_id)) throw new Error("Unconfirmed review");
      setMessage(action === "review_accept" ? "已按 Google 当前文件状态恢复登记和使用。原操作的历史结果保留，没有重新覆盖文件。" : "已停止管理这个文件；Google 文件没有删除。原操作的历史结果保留。");
    } catch (error) {
      if (epoch === revision.current) setMessage(error instanceof ReviewRefreshError
        ? "这次读取记录已过期，或文件与登记状态已变化。请重新查看当前文件，再确认处理；本次没有重新覆盖文件。"
        : "登记结果尚未确认，正在读取原作业状态；不会再次提交确认或改动文件。");
    } finally {
      operationBusy.current = false;
      if (epoch === revision.current) { setBusy(false); void loadRecoveries(c, epoch); }
    }
  }
  async function recover(c: Connection, action: "inspect" | "authorize", approved?: RecoveryConfirmation) {
    if (operationBusy.current || registrationBusy.current || busy) return;
    const job = recoveryJobs[c.id]?.trim(), prior = recoveryViews[c.id];
    if (!job || !uuid.test(job)) { setMessage("请填写原存储任务 ID；不要生成新任务重试。"); return; }
    if (action === "inspect") { confirmation.current = null; setRecoveryConfirmation(null); }
    if (action === "authorize") {
      if (!["active", "reauthorization_required"].includes(c.state) || prior?.job_id !== job || !["started", "uncertain", "conflict", "attention_required"].includes(prior.status)) return;
      if (!approved) {
        const snapshot: RecoveryConfirmation = { connection_id: c.id, connection_version: c.version, job_id: job,
          receipt_id: prior.receipt_id, status: prior.status, epoch: revision.current, action };
        confirmation.current = snapshot; setRecoveryConfirmation(snapshot); return;
      }
      if (confirmation.current !== approved || approved.epoch !== revision.current || approved.connection_id !== c.id ||
        approved.connection_version !== c.version || approved.job_id !== job || approved.receipt_id !== prior.receipt_id || approved.status !== prior.status || approved.action !== action) return;
      confirmation.current = null; setRecoveryConfirmation(null);
    }
    const epoch = revision.current;
    operationBusy.current = true; setBusy(true);
    setRecoveryViews(old => { const next = { ...old }; delete next[c.id]; return next; });
    try {
      if (action === "authorize") {
        const result = await request("/v1/storage/google/recovery/auto-start", { connection_id: c.id, job_id: job }, () => epoch === revision.current);
        if (epoch !== revision.current) return;
        if (typeof result.authorization_url !== "string") throw new Error("Unconfirmed");
        const url = new URL(result.authorization_url);
        if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth" || url.username || url.password) throw new Error("Unconfirmed");
        window.location.assign(url.href); return;
      }
      const result = await request("/v1/storage/recovery", { action, connection_id: c.id, job_id: job }, () => epoch === revision.current);
      if (epoch !== revision.current) return;
      if (result.execution_permitted !== false || result.job_id !== job || typeof result.receipt_id !== "string" || !uuid.test(result.receipt_id)) throw new Error("Unconfirmed");
      if (action === "inspect") {
        if (result.connection_id !== c.id || typeof result.status !== "string" || !Object.hasOwn(recoveryLabels, result.status)) throw new Error("Unconfirmed");
        const view = recoveryView(result); if (!view) throw new Error("Unconfirmed");
        setRecoveryViews(old => ({ ...old, [c.id]: view }));
        setMessage("已读取原任务；回执不代表重新取得写入权限。");
      }
    } catch {
      if (epoch === revision.current) {
        setMessage("本次读取未完成，正在重新读取原作业状态；不会重复文件操作或恢复权限。");
        if (action !== "inspect") {
          try {
            const result = await request("/v1/storage/recovery", { action: "inspect", connection_id: c.id, job_id: job }, () => epoch === revision.current);
            const view = result.execution_permitted === false && result.connection_id === c.id ? recoveryView(result) : null;
            if (epoch === revision.current && view?.job_id === job) {
              setRecoveryViews(old => ({ ...old, [c.id]: view })); setMessage(recoveryExplanation(view));
            }
          } catch { /* A lost reply is never a reason to repeat a file operation. */ }
        }
        if (epoch === revision.current) void loadRecoveries(c, epoch);
      }
    } finally { operationBusy.current = false; if (epoch === revision.current) setBusy(false); }
  }
  async function observeDirectories(c: Connection) {
    if (operationBusy.current || registrationBusy.current || busy || c.state !== "active") return;
    const epoch = revision.current;
    operationBusy.current = true; setBusy(true);
    const report = (value: string, summary = "目录检查已完成，请查看下方结果。") => {
      setMessage(summary); setProbeMessages(old => ({ ...old, [c.id]: value }));
    };
    report("正在只读检查全部登记目录的信息和新建能力；不会创建文件或更改授权。", "正在检查目录信息，请查看下方进度。");
    try {
      const result = await request("/v1/storage/google/probe", { connection_id: c.id }, () => epoch === revision.current);
      if (epoch !== revision.current) return;
      if (result.status !== "metadata_observed" || result.execution_permitted !== false ||
        typeof result.attempt_id !== "string" || !/^[0-9a-f-]{36}$/.test(result.attempt_id) ||
        typeof result.receipt_id !== "string" || !/^[0-9a-f-]{36}$/.test(result.receipt_id)) throw new Error("目录检查回执未确认；文件写入保持关闭。");
      report(`已登记目录的访问与元数据检查已记录。回执：${result.receipt_id}。这不是完整存储资格验收，不会开启文件写入。`);
      const b = result.boundary_observation;
      if (isObject(b) && b.contract === "clued.storage-boundary-observation/1" && b.status === "clean" &&
        b.digest_format === "sorted-json/1" && Number.isSafeInteger(b.observed_at_ms) && Number(b.observed_at_ms) >= 0 &&
        b.policy_version === "clued.resource-center-mutation-policy/1" && b.scanner_contract === "clued.google-drive-boundary/1" &&
        typeof b.descriptor_sha256 === "string" && /^[a-f0-9]{64}$/.test(b.descriptor_sha256) &&
        typeof b.scan_config_sha256 === "string" && /^[a-f0-9]{64}$/.test(b.scan_config_sha256)) {
        // Only validated, explicit fields may enter the owner-visible evidence summary.
        const evidence = { attempt_id: result.attempt_id, receipt_id: result.receipt_id,
          boundary_observation: { contract: b.contract, status: b.status, observed_at_ms: b.observed_at_ms,
            policy_version: b.policy_version, scanner_contract: b.scanner_contract, digest_format: b.digest_format,
            descriptor_sha256: b.descriptor_sha256, scan_config_sha256: b.scan_config_sha256 }, execution_permitted: false };
        report(`目录检查回执：${result.receipt_id}。本次父级与同级边界只读扫描未发现违规；这只是观察时点检测，不是原子快照。边界结果需连同受审发布版本另存验收证据，不包含在旧目录回执合同中。不会开启文件写入。验收摘要：${JSON.stringify(evidence)}`);
      }
    } catch (error) {
      if (epoch === revision.current) report(error instanceof ProbeRequestError ? error.message : "目录检查暂未完成，不会自动重试或更改授权。",
        error instanceof ProbeRequestError && error.hasDirectoryIssues ? "检查已完成，有待确认目录，请查看下方结果。" : "目录检查未确认，请查看下方结果。");
    } finally { operationBusy.current = false; if (epoch === revision.current) setBusy(false); }
  }
  async function register() {
    if (registrationBusy.current || busy) return;
    const profile = profileId.trim(), decision = decisionId.trim();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (!uuid.test(profile) || !uuid.test(decision)) { setMessage("请填写有效的已登记目录 ID 和当前授权 Decision ID。"); return; }
    const epoch = revision.current;
    if (!window.confirm("登记这一个已治理目录的账号连接？目录和授权由服务端核验；此步骤不授予 Google 访问、后台续签或 Agent 文件写入权限。")) return;
    registrationBusy.current = true; setBusy(true);
    try {
      // Stable per-owner receipt identity survives page reload and a lost reply.
      // A revoked connection is not revived by replay; it stays visible as revoked.
      const result = await request("/v1/storage/account", { action: "register", profile_id: profile, source_decision_id: decision,
        idempotency_key: `storage-register-ui-v1:${profile}:${decision}` }, () => epoch === revision.current);
      if (epoch !== revision.current) return;
      if (result.status !== "committed" || typeof result.receipt_id !== "string") throw new Error("登记回执未确认，请刷新状态核对；不要另建重复连接。");
      await refresh();
    } catch (error) {
      if (epoch === revision.current) setMessage(error instanceof Error ? error.message : "登记未确认，请刷新核对；再次提交相同目录与授权会沿用同一请求。");
    } finally { registrationBusy.current = false; if (epoch === revision.current) setBusy(false); }
  }
  async function renewal(c: Connection, action: "status" | "enable" | "disable", approved?: RenewalConfirmation) {
    if (operationBusy.current || busy) return;
    const previous = renewals[c.id];
    if (action !== "status" && !previous) return;
    if (action !== "status" && !approved) {
      const choice = { connection_id: c.id, action, epoch: revision.current,
        connection_version: previous.connection_version, delegation_version: previous.version };
      renewalChoice.current = choice; setRenewalConfirmation(choice); return;
    }
    if (action !== "status" && (renewalChoice.current !== approved || approved?.epoch !== revision.current ||
      approved.connection_id !== c.id || approved.action !== action ||
      approved.connection_version !== previous.connection_version || approved.delegation_version !== previous.version)) return;
    // One use, exact CAS and current account/page. A later query, cancellation
    // or account change invalidates the inline confirmation before any request.
    renewalChoice.current = null; setRenewalConfirmation(null);
    const epoch = revision.current; operationBusy.current = true; setBusy(true);
    try {
      if (action !== "status") {
        const changed = await request("/v1/storage/refresh", { action, connection_id: c.id, base_version: previous.connection_version,
          delegation_version: previous.version, idempotency_key: crypto.randomUUID(), ...(action === "enable" ? { until_revoked: true } : {}) }, () => epoch === revision.current);
        if (changed.status !== "committed" || typeof changed.receipt_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(changed.receipt_id)) throw new Error("续签设置结果未确认，请重新查询状态；不会自动重试。");
      }
      if (epoch !== revision.current) return;
      const value = await request("/v1/storage/refresh", { action: "status", connection_id: c.id }, () => epoch === revision.current);
      if (epoch !== revision.current) return;
      if (typeof value.enabled !== "boolean" || !Number.isSafeInteger(value.version) || Number(value.version) < 0 ||
        !Number.isSafeInteger(value.connection_version) || Number(value.connection_version) < 1 ||
        !Number.isSafeInteger(value.failures) || Number(value.failures) < 0 || typeof value.pending !== "boolean" ||
        !(value.next_refresh_at === null || typeof value.next_refresh_at === "string") ||
        (value.authorized_enabled !== undefined && typeof value.authorized_enabled !== "boolean") ||
        (value.pause_reason !== undefined && (typeof value.pause_reason !== "string" || !Object.hasOwn(renewalPause, value.pause_reason))))
        throw new Error("续签状态未确认。");
      if (action !== "status" && renewalAuthorized(value as RefreshStatus) !== (action === "enable")) throw new Error("续签设置尚未生效，请重新查询状态；不会自动重试。");
      setRenewals(old => ({ ...old, [c.id]: value as RefreshStatus }));
      setConnections(old => old.map(item => item.id === c.id ? { ...item, version: Number(value.connection_version) } : item));
      setMessage(action === "status" ? "" : "设置已确认。");
    } catch (error) {
      if (epoch === revision.current) {
        setRenewals(old => { const next = { ...old }; delete next[c.id]; return next; });
        setMessage(error instanceof Error ? error.message : "续签设置未确认，请重新查询状态。");
      }
    } finally { operationBusy.current = false; if (epoch === revision.current) setBusy(false); }
  }
  const renderedEpoch = revision.current;
  return <main className="mx-auto max-w-3xl px-6 py-16"><h1 className="text-2xl font-semibold">存储管理</h1>
    <p className="my-4">仅当前登录账号可管理受治理目录、查看自动恢复记录和设置续签。文件操作的核验与恢复由后台程序执行。</p>
    <p role="status" className="my-4">{message}</p>
    <section className="my-4 rounded-xl border p-4"><h2>登记已治理目录</h2>
      <p className="my-2 text-sm">仅引用服务端已登记的目录与当前授权，不接受自定义磁盘路径。登记不代表写入已启用；相同请求可安全核对回执，已停用连接不会自动恢复。</p>
      <label className="my-2 block">已登记目录 ID<input className="block w-full rounded border p-2" value={profileId} disabled={busy}
        autoComplete="off" onChange={event => setProfileId(event.target.value)} /></label>
      <label className="my-2 block">当前授权 Decision ID<input className="block w-full rounded border p-2" value={decisionId} disabled={busy}
        autoComplete="off" onChange={event => setDecisionId(event.target.value)} /></label>
      <button disabled={busy || !profileId.trim() || !decisionId.trim()} onClick={() => void register()}>登记账号连接</button>
    </section>
    {connections.map(c => <section className="my-4 rounded-xl border p-4" key={c.id}>
      <h2>{c.root_name}</h2><p className="my-2">{c.provider === "google-drive" ? "Google Drive" : c.provider} · {labels[c.state] ?? "状态待确认"}</p>
      <p className="my-2 break-all text-sm">已登记目录：{c.root_name}</p>
      <details className="my-2 text-sm"><summary>连接技术信息</summary><p className="break-all">连接：{c.id}</p></details>
      <section className="my-4 rounded border p-3" aria-label="文件操作自动恢复">
        <h3>文件操作自动恢复</h3>
        <button disabled={busy} onClick={() => { if (!operationBusy.current && !registrationBusy.current) void loadRecoveries(c, renderedEpoch); }}>读取本目录文件操作状态</button>
        <p role="status" aria-live="polite" className="my-2">{automaticMessages[c.id]}</p>
        {(automaticJobs[c.id] ?? []).map(job => <article key={job.job_id} className="my-2 border-t pt-2">
          <p>{recoveryTitle(job)}</p><p className="my-1 text-sm">{recoveryExplanation(job)}</p>
          {(job.review_available || job.abandon_available) && <details className="my-2 text-sm"><summary>可选冲突处理</summary>
          {job.review_available && <button disabled={busy} onClick={() => void prepareReview(c, job)}>查看当前文件并处理冲突</button>}
          {job.abandon_available && <><p className="my-2 text-sm">{job.review_available ? "也可停止管理相关旧登记，以解除旧保护；Google 文件保留。" : "这个旧作业暂不能自动核对。可停止管理相关旧登记，以解除旧保护；Google 文件保留。"}</p>
            <button disabled={busy} onClick={() => confirmAbandon(c, job)}>停止管理旧登记并解除保护</button></>}
          </details>}
          <details className="text-sm"><summary>操作记录与诊断</summary><p className="break-all">任务：{job.job_id}；回执：{job.receipt_id}</p>
            {job.source_receipt_id && <p className="break-all">原作业回执：{job.source_receipt_id}</p>}
            {job.diagnostic && <><p>{recoveryReasons[job.diagnostic.reason]}。{recoveryActions[job.diagnostic.automatic_next_action]}</p>
              <p>最近核验：{new Date(job.diagnostic.observed_at).toLocaleString()}</p></>}
          </details>
        </article>)}
        {abandonConfirmation?.context_connection_id === c.id && <section role="region" aria-label="确认停止管理旧登记" className="my-3 rounded border p-3">
          <h4>确认停止管理旧登记</h4><p className="my-2 break-all">{abandonConfirmation.file_name ?? "这条原作业的旧登记"}</p>
          <p className="my-2 text-sm">这会停止 BeamingFace 管理相关旧登记并解除这条保护，不删除或覆盖 Google 文件，不把原操作记为成功。需要再次通过 BeamingFace 管理这个文件时，须重新登记。</p>
          <details className="text-sm"><summary>原操作记录</summary><p className="break-all">任务：{abandonConfirmation.job_id}；回执：{abandonConfirmation.source_receipt_id}</p></details>
          <div className="my-2 flex gap-4"><button disabled={busy} onClick={() => void abandonRegistration(c, abandonConfirmation)}>确认停止管理（不删除文件）</button>
            <button disabled={busy} onClick={() => { abandon.current = null; setAbandonConfirmation(null); }}>保留旧登记</button></div>
        </section>}
        {reviewObservation?.context_connection_id === c.id && <section role="region" aria-label="确认当前 Google 文件" className="my-3 rounded border p-3">
          <h4>已直接读取 Google 当前文件</h4><p className="my-2 break-all">{reviewObservation.file_name}</p>
          <p>{({ before: "文件仍是原操作之前的状态。", after: "文件符合原操作的预期状态。", changed: "文件已变成与原操作预期不同的状态。", absent: "Google 当前没有这个文件。" } as Record<string, string>)[reviewObservation.observed_state]}</p>
          <p className="my-2 text-sm">下方确认只采纳本次读取的文件状态，不会重做覆盖，也不会把原操作改记为成功。确认只适用于这个原文件和登记版本，读取记录过期时须重新读取。</p>
          {reviewObservation.provider_file_id && <a className="underline" href={`https://drive.google.com/file/d/${reviewObservation.provider_file_id}/view`} target="_blank" rel="noopener noreferrer">在 Google Drive 查看文件</a>}
          <div className="my-3 flex flex-wrap gap-4"><button disabled={busy} onClick={() => void resolveReview(c, reviewObservation, "review_accept")}>
            {reviewObservation.observed_state === "absent" ? "确认当前文件不存在" : "保留当前文件并恢复使用"}</button>
            <button disabled={busy} onClick={() => void resolveReview(c, reviewObservation, "review_abandon")}>停止管理这个文件（不删除）</button>
            <button disabled={busy} onClick={() => { review.current = null; setReviewObservation(null); }}>暂不采用</button></div>
          <details className="text-sm"><summary>本次读取记录</summary><p className="break-all">版本：{reviewObservation.provider_file_version ?? "无"}；读取时间：{reviewObservation.observed_at}；内容校验：{reviewObservation.sha256 ?? "不适用"}</p></details>
        </section>}
      </section>
      <details className="my-4 rounded border p-3"><summary>按原任务编号查看技术诊断</summary>
        <p className="my-2 text-sm">使用原任务 ID 只读查看状态和记录。后台程序自动核验与恢复，不需要在此手工结算。</p>
        <label className="my-2 block">原存储任务 ID<input className="block w-full rounded border p-2" autoComplete="off" disabled={busy}
          value={recoveryJobs[c.id] ?? ""} onChange={event => {
            confirmation.current = null; setRecoveryConfirmation(null);
            setRecoveryJobs(old => ({ ...old, [c.id]: event.target.value }));
            setRecoveryViews(old => { const next = { ...old }; delete next[c.id]; return next; });
          }} /></label>
        <button disabled={busy || !recoveryJobs[c.id]?.trim()} onClick={() => void recover(c, "inspect")}>查询原任务回执</button>
        {recoveryViews[c.id] && <><p role="status" className="my-2 break-all">{recoveryExplanation(recoveryViews[c.id])}；回执：{recoveryViews[c.id].receipt_id}</p>
          {c.state === "reauthorization_required" && ["started", "uncertain", "conflict", "attention_required"].includes(recoveryViews[c.id].status) &&
            <button disabled={busy} onClick={() => void recover(c, "authorize")}>重新授权并自动核对原任务（凭据失效时）</button>}</>}
        {recoveryConfirmation?.connection_id === c.id && <section role="region" aria-label="确认原作业恢复" className="my-3 rounded border p-3">
          <h4>重新授权原作业</h4>
          <p className="my-2">为这个原作业重新取得同一 Google 账号的两项既有权限。Google 同意后将自动只读核对原对象，结果一致即登记原回执；不恢复已停用连接、Agent 权限或后台续签，不重新创建文件。Google 最终同意由你确认。</p>
          <p className="text-sm break-all">原任务：{recoveryConfirmation.job_id}</p>
          <div className="mt-2 flex gap-4"><button disabled={busy} onClick={() => void recover(c, recoveryConfirmation.action, recoveryConfirmation)}>
            继续前往 Google 授权</button>
            <button disabled={busy} onClick={() => { confirmation.current = null; setRecoveryConfirmation(null); }}>取消本次确认</button></div>
        </section>}
      </details>
      {c.state === "active" && <div className="my-2"><button disabled={busy} onClick={() => void observeDirectories(c)}>检查全部登记目录的信息和新建能力</button>
        <p>此检查只读取 Google 目录信息，不创建文件或更改授权。个别目录资格未确认时，其他已获授权的目录仍可正常使用。</p>
        <p className="text-sm">只核对服务端登记目录的访问与元数据，不读取文件正文，不授予 Agent 写入权限。</p>
        {probeMessages[c.id] && <p role="status" aria-live="polite" className="my-2 whitespace-pre-line break-words">{probeMessages[c.id]}</p>}</div>}
      <div className="mt-4 border-t pt-4"><h3>账号级后台续签</h3>
        <p className="my-2 text-sm">新连接在授权时默认选择自动续签，可取消或随时停用；已有停用设置不会自动恢复。由服务端执行，不依赖任何设备在线，不授予 Agent 整理或写入文件的权限。</p>
        <button disabled={busy} onClick={() => void renewal(c, "status")}>查询续签状态</button>
        {renewals[c.id] && <><p role="status" className="my-2">{renewalAuthorized(renewals[c.id]) ? "后台续签已开启" : "后台续签已关闭"}
          {renewalAuthorized(renewals[c.id]) && renewalPause[renewals[c.id].pause_reason ?? "none"]}
          {renewals[c.id].pending ? "；存在尚未确认的续签。请核对结果，必要时重新授权 Google。" : ""}
          {renewals[c.id].failures > 0 ? `；连续失败 ${renewals[c.id].failures} 次。` : ""}</p>
          <button disabled={busy || (!renewalAuthorized(renewals[c.id]) && (c.state !== "active" || renewals[c.id].pending))}
            onClick={() => void renewal(c, renewalAuthorized(renewals[c.id]) ? "disable" : "enable")}>{renewalAuthorized(renewals[c.id]) ? "停用后台续签" : "授权开启后台续签"}</button></>}
        {renewalConfirmation?.connection_id === c.id &&
          <section role="region" aria-label="确认后台续签设置" className="my-3 rounded border p-3">
            <h4>确认后台续签设置</h4>
            <p className="my-2">{renewalConfirmation.action === "enable"
              ? `允许 BeamingFace 服务端持续续签「${c.root_name}」的 Google 连接，直到你主动停用？手机、平板或电脑退出登录不影响续签。仅保留现有授权范围，不新增文件写入权限。`
              : `停用「${c.root_name}」的后台续签？停用后不再发起新的后台续签。已经开始的续签需要核对结果，不能靠重新开启跳过。`}</p>
            <div className="my-2 flex gap-4"><button disabled={busy}
              onClick={() => void renewal(c, renewalConfirmation.action, renewalConfirmation)}>
              {renewalConfirmation.action === "enable" ? "确认开启后台续签" : "确认停用后台续签"}</button>
              <button disabled={busy} onClick={() => { renewalChoice.current = null; setRenewalConfirmation(null); }}>取消续签设置</button></div>
          </section>}
      </div>
    </section>)}
    <div className="mt-6 flex gap-4"><button disabled={busy} onClick={() => void refresh()}>刷新状态</button><Link href="/storage/connections">返回存储连接</Link></div>
  </main>;
}
