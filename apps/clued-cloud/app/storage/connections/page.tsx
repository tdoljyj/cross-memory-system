"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../../supabase-browser";

type Connection = {
  id: string; version: number; provider: string; state: string; auth_mode: string;
  root_name: string; policy_active: boolean; actions: string[];
  refresh_enabled: boolean; database_execution_enabled: boolean; profile_current: boolean;
};
const actionName: Record<string, string> = {
  inspect: "查看任务状态", create_file: "新建文件", create_topic: "新建主题目录", modify: "改名、移动文件",
  overwrite: "覆盖文件内容", destructive: "移入回收站、从回收站恢复",
};
const stateName: Record<string, string> = {
  awaiting_provider: "等待 Google 授权", active: "已连接", reauthorization_required: "需要重新授权", revoked: "已断开",
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function isConnection(value: unknown): value is Connection {
  return isObject(value) && typeof value.id === "string" && Number.isSafeInteger(value.version)
    && typeof value.provider === "string" && typeof value.state === "string"
    && typeof value.auth_mode === "string" && typeof value.root_name === "string"
    && typeof value.policy_active === "boolean" && typeof value.refresh_enabled === "boolean"
    && typeof value.database_execution_enabled === "boolean" && typeof value.profile_current === "boolean"
    && Array.isArray(value.actions) && value.actions.every(action => typeof action === "string" && Object.hasOwn(actionName, action));
}
// A refused request keeps only a fixed reason label from our own allowlist.
class RequestFailure extends Error { reason?: string; }
async function accountRequest(body: object, path = "/v1/storage/owner") {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error("请登录 Clued 后重新读取连接。");
  const response = await fetch(path, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + data.session.access_token },
    body: JSON.stringify(body), cache: "no-store", redirect: "error",
  });
  if (!response.ok) {
    const failure = new RequestFailure("结果未确认，请重新读取连接状态；不要重复提交。");
    const detail: unknown = await response.json().catch(() => null);
    if (isObject(detail) && typeof detail.reason === "string" && /^[a-z_]{1,64}$/.test(detail.reason)) failure.reason = detail.reason;
    throw failure;
  }
  const result: unknown = await response.json();
  const latest = await supabase.auth.getSession();
  if (latest.error || latest.data.session?.user.id !== data.session.user.id) throw new Error("账号已变化，请重新读取。");
  if (!isObject(result)) throw new Error("连接状态未确认。");
  return result;
}
type ReadAccess = { active: boolean; read_generation: number; disclosure_version: string; content_disclosure_version: string; classes: string[] };
function isReadAccess(value: unknown): value is ReadAccess {
  return isObject(value) && typeof value.active === "boolean" && Number.isSafeInteger(value.read_generation)
    && typeof value.disclosure_version === "string" && typeof value.content_disclosure_version === "string"
    && Array.isArray(value.classes) && value.classes.every(item => typeof item === "string");
}
// StorageNormalUse.v0.1 §8.2: one "正常使用" toggle over the read level.
type NormalUse = { read_generation: number; disclosure_version: string; provider_scope_profile: "legacy" | "normal";
  normal_use: boolean; reconsent_required: boolean; refresh_token_count: number; refresh_token_warning: boolean; refresh_token_blocked: boolean };
function isNormalUse(value: unknown): value is NormalUse {
  return isObject(value) && Number.isSafeInteger(value.read_generation) && typeof value.disclosure_version === "string"
    && (value.provider_scope_profile === "legacy" || value.provider_scope_profile === "normal")
    && typeof value.normal_use === "boolean" && typeof value.reconsent_required === "boolean"
    && Number.isSafeInteger(value.refresh_token_count) && typeof value.refresh_token_warning === "boolean"
    && typeof value.refresh_token_blocked === "boolean";
}
// clued.storage-normal-use-disclosure/1 (StorageNormalUse §8.2). Any change to
// this text needs a new disclosure version in the database first.
const normalUseDisclosure = (root: string) =>
  `开启后，你授权的 Agent 可以读取「${root}」内的全部文件，包括你手动上传的文件：文本、文档、表格、PDF 的文字，图片内容，压缩包的目录和其中单个文件；其他文件可通过几分钟内有效的下载链接取回原始内容。视频和音频只读取时长、分辨率、大小等信息。Agent 还可以按内容搜索文件，并在该目录中新建图片、PDF、压缩包等文件（每个最多 20 MB），不会覆盖或删除已有文件；你手动上传的文件 Agent 不能改名、移动或删除。\n` +
  "读取到的内容会发送给该 Agent 所用的模型服务，已经返回的内容无法收回。\n" +
  "Google 页面会显示“查看你 Google 云端硬盘中的所有文件”。Clued 服务端只允许访问所选目录，这个限制由 Clued 保证，不由 Google 保证。\n" +
  "默认每小时额度：读取 256 MB、上传 256 MB。关闭“正常使用”会立即停止读正文、按内容搜索和上传，但不会收回 Google 授权；“撤回全部文件读取授权”会断开该 Google 账号在 Clued 中的所有连接。";
const normalUseOff = "关闭“正常使用”？会立即停止读正文、按内容搜索和上传，仍可查看文件名和目录结构。这不会收回 Google 授权（Google 页面上的授权范围不变）；已经返回给 Agent 的内容无法收回。";
const startReasons: Record<string, string> = {
  storage_root_busy: "该目录还有尚未完成的文件操作，稍后再试。",
  // Until "撤回全部文件读取授权" exists, only a maintainer can reset the count
  // (runbook); a plain reconnect is never refused.
  refresh_token_limit: "该 Google 账号在 Clued 中的授权次数已达上限，暂时不能通过重新授权开启正常使用。请联系维护者处理；现有功能和重新连接不受影响。",
};
// StorageNormalUse.v0.1 §7.3 / §8.2 item 4 (N4): hourly read / upload budgets,
// per authorized Agent on this connection and for the whole account.
type BudgetScope = "connection" | "account";
type BudgetDimension = "read" | "upload";
type BudgetValues = { budget_generation: number; configured: boolean; read_bytes_per_hour: number; upload_bytes_per_hour: number };
type Budget = { connection: BudgetValues; account: BudgetValues;
  bounds: { step_bytes: number; connection: { min_bytes: number; max_bytes: number }; account: { min_bytes: number; max_bytes: number } } };
const MIB = 1048576;
function isBudgetValues(value: unknown): value is BudgetValues {
  return isObject(value) && Number.isSafeInteger(value.budget_generation) && typeof value.configured === "boolean"
    && Number.isSafeInteger(value.read_bytes_per_hour) && Number.isSafeInteger(value.upload_bytes_per_hour);
}
function isBounds(value: unknown): value is { min_bytes: number; max_bytes: number } {
  return isObject(value) && Number.isSafeInteger(value.min_bytes) && Number.isSafeInteger(value.max_bytes);
}
function isBudget(value: unknown): value is Budget {
  return isObject(value) && value.contract === "clued.storage-budget/1" && isBudgetValues(value.connection) && isBudgetValues(value.account)
    && isObject(value.bounds) && value.bounds.step_bytes === MIB && isBounds(value.bounds.connection) && isBounds(value.bounds.account);
}
// §8.2 item 4: three presets and a custom value in whole MiB within the scope's bounds.
const budgetPresets = [64, 256, 1024];
const budgetDefault: Record<BudgetScope, number> = { connection: 256, account: 1024 };
const budgetScopeName: Record<BudgetScope, string> = { connection: "每个已授权 Agent（此连接）", account: "账号合计（全部 Agent 与连接）" };
const budgetDimensionName: Record<BudgetDimension, string> = { read: "读取", upload: "上传" };
const formatMib = (mib: number) => mib >= 1024 && mib % 1024 === 0 ? `${mib / 1024} GiB` : `${mib} MiB`;
const formatBytes = (bytes: number) => formatMib(Math.floor(bytes / MIB));
type WriteLevel = "modify" | "overwrite" | "destructive";
type WriteAccess = { active: boolean; policy_generation: number; disclosure_version: string;
  overwrite_disclosure_version: string; destructive_disclosure_version?: string; classes: string[] };
function isWriteAccess(value: unknown): value is WriteAccess {
  return isObject(value) && typeof value.active === "boolean" && Number.isSafeInteger(value.policy_generation)
    && typeof value.disclosure_version === "string" && typeof value.overwrite_disclosure_version === "string"
    && (value.destructive_disclosure_version === undefined || typeof value.destructive_disclosure_version === "string")
    && Array.isArray(value.classes) && value.classes.every(item => item === "modify" || item === "overwrite" || item === "destructive");
}
// The destructive level is offered only by a server that names its disclosure (P5).
const writeLevels = (access: WriteAccess): WriteLevel[] =>
  access.destructive_disclosure_version === undefined ? ["modify", "overwrite"] : ["modify", "overwrite", "destructive"];
const writeDisclosure = (access: WriteAccess, level: WriteLevel) => level === "overwrite" ? access.overwrite_disclosure_version
  : level === "destructive" ? access.destructive_disclosure_version ?? "" : access.disclosure_version;
// Native trash batch confirmation (P5, §3.4 item 4; Decision 7f9daf68): the Agent registers one batch,
// the Owner confirms the whole list once.
type TrashItem = { operation: "delete" | "restore"; target_kind: "file" | "directory"; path: string; provider_file_id: string;
  provider_file_version: string; current: boolean; used: boolean };
type TrashBatch = { batch_id: string; status: "pending" | "confirmed"; created_at: string; expires_at: string; items: TrashItem[] };
type TrashConfirmation = { destructive: boolean; policy_generation: number; limit: number; window_hours: number;
  batches: TrashBatch[]; batches_truncated: boolean };
function isTrashConfirmation(value: unknown): value is TrashConfirmation {
  return isObject(value) && typeof value.destructive === "boolean" && Number.isSafeInteger(value.policy_generation)
    && Number.isSafeInteger(value.limit) && Number.isSafeInteger(value.window_hours) && typeof value.batches_truncated === "boolean"
    && Array.isArray(value.batches) && value.batches.every(batch => isObject(batch) && typeof batch.batch_id === "string"
      && (batch.status === "pending" || batch.status === "confirmed") && typeof batch.created_at === "string" && typeof batch.expires_at === "string"
      && Array.isArray(batch.items) && batch.items.every(item => isObject(item) && (item.operation === "delete" || item.operation === "restore")
        && (item.target_kind === "file" || item.target_kind === "directory") && typeof item.path === "string"
        && typeof item.provider_file_id === "string" && typeof item.provider_file_version === "string"
        && typeof item.current === "boolean" && typeof item.used === "boolean"));
}
const trashItemText = (item: TrashItem) => `${item.operation === "delete" ? "移入回收站" : "从回收站恢复"}${item.target_kind === "directory" ? "（空目录）" : ""}：`
  + `${item.path}（ID ${item.provider_file_id}，版本 ${item.provider_file_version}）`;
// One write class per change; each has its own confirmation text (P3 modify, P4 overwrite, P5 destructive).
const writeText = {
  modify: {
    name: "改名和移动文件",
    on: "允许已授权的 Agent 在此目录内改名和移动由 Clued 创建的文件？每次操作都会留下回执，可以再改回原名或原位置；不会删除或覆盖文件内容。尚未开始的排队任务会被取消，已开始但未完成的任务需先结束；可随时停止。",
    off: "停止 Agent 改名和移动文件？尚未开始的排队任务会被取消，已开始但未完成的任务需先结束。新建文件和查看设置不受影响。",
  },
  overwrite: {
    name: "覆盖文件内容",
    on: "允许已授权的 Agent 覆盖此目录内由 Clued 创建的文本文件的内容（每次最多 1 MB）？覆盖前的内容会保存为永久保留的 Google Drive 版本，可以撤回；每个文件保留最近 10 个。不会删除文件。尚未开始的排队任务会被取消，已开始但未完成的任务需先结束；可随时停止。",
    off: "停止 Agent 覆盖文件内容？已保存的旧版本不受影响。尚未开始的排队任务会被取消，已开始但未完成的任务需先结束。",
  },
  destructive: {
    name: "把文件移入回收站",
    on: "允许已授权的 Agent 把此目录内由 Clued 创建的文件和空目录移入 Google Drive 回收站，并可从回收站恢复 Clued 移入的项目？不会永久删除；但 Google 会在移入回收站 30 天后自动永久删除，之后无法恢复。每个任务只处理一个文件或一个空目录，不处理非空目录；同一客户端登记在 24 小时内超过 5 项时，需要您在本页对 Agent 列出的整批项目一次确认。您手动上传的文件不受影响。尚未开始的排队任务会被取消，已开始但未完成的任务需先结束；可随时停止。",
    off: "停止 Agent 把文件移入回收站和从回收站恢复？已在回收站中的文件不受影响，仍会在 30 天后被 Google 永久删除。尚未开始的排队任务会被取消，已开始但未完成的任务需先结束。",
  },
} as const;
export default function StorageConnections() {
  // Read level (StorageFullCapability P1) is loaded on demand per connection so
  // the everyday page stays one request; every change is a native CAS mutation.
  const [readAccess, setReadAccess] = useState<Record<string, ReadAccess>>({});
  // Write level (P3): changing it replaces the account policy, so the page
  // always reloads the connection list and both settings afterwards.
  const [writeAccess, setWriteAccess] = useState<Record<string, WriteAccess>>({});
  // Trash batch confirmation (P5), loaded on demand per connection.
  const [trash, setTrash] = useState<Record<string, TrashConfirmation>>({});
  // Normal use (StorageNormalUse §8.2), loaded on demand like the read level.
  const [normalUse, setNormalUse] = useState<Record<string, NormalUse>>({});
  // Hourly budgets (N4), loaded on demand. Drafts are "64" / "256" / "1024" or
  // "custom" per connection, scope and dimension; custom values are whole MiB.
  const [budget, setBudget] = useState<Record<string, Budget>>({});
  const [budgetDraft, setBudgetDraft] = useState<Record<string, string>>({});
  const [connections, setConnections] = useState<Connection[]>([]);
  const [workerEnabled, setWorkerEnabled] = useState(false);
  const [message, setMessage] = useState("正在读取连接……");
  const [busy, setBusy] = useState(false);
  const [defaultRefresh, setDefaultRefresh] = useState(false);
  const revision = useRef(0), operation = useRef(false);
  const refresh = useCallback(async () => {
    const epoch = ++revision.current;
    setBusy(true);
    try {
      const result = await accountRequest({ action: "connections" });
      if (epoch !== revision.current) return;
      if (!Array.isArray(result.connections) || !result.connections.every(isConnection)
        || typeof result.worker_execution_enabled !== "boolean") throw new Error("连接摘要未确认。");
      setConnections(result.connections);
      setWorkerEnabled(result.worker_execution_enabled);
      setMessage(result.connections.length ? "" : "暂无存储连接；受治理目录登记请进入管理入口。");
      return result.connections as Connection[];
    } catch (error) {
      if (epoch === revision.current) {
        setConnections([]); setWorkerEnabled(false);
        setMessage(error instanceof Error ? error.message : "连接状态未确认。");
      }
      return null;
    } finally { if (epoch === revision.current) setBusy(false); }
  }, []);
  useEffect(() => {
    let disposed = false;
    const { data } = supabase.auth.onAuthStateChange(() => {
      if (disposed) return;
      ++revision.current; setConnections([]); setWorkerEnabled(false);
      queueMicrotask(() => { if (!disposed) void refresh(); });
    });
    queueMicrotask(() => { if (!disposed) void refresh(); });
    return () => { disposed = true; ++revision.current; data.subscription.unsubscribe(); };
  }, [refresh]);
  async function connect(c: Connection) {
    if (operation.current || busy || !["awaiting_provider", "reauthorization_required"].includes(c.state)) return;
    const enrollRefresh = c.state === "awaiting_provider" && defaultRefresh;
    if (enrollRefresh && !window.confirm("连接后允许 Clued 服务端按既有范围后台续签，直到主动停用？")) return;
    operation.current = true; setBusy(true);
    const epoch = revision.current;
    try {
      const result = await accountRequest({ connection_id: c.id,
        ...(c.state === "awaiting_provider" ? { default_refresh: enrollRefresh } : {}) }, "/v1/storage/google/start");
      if (epoch !== revision.current || typeof result.authorization_url !== "string") return;
      const url = new URL(result.authorization_url);
      if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth" || url.username || url.password)
        throw new Error("授权地址未确认。");
      window.location.assign(url.href);
    } catch { if (epoch === revision.current) setMessage("Google 连接请求未确认，请刷新状态后核对。"); }
    finally { operation.current = false; if (epoch === revision.current) setBusy(false); }
  }
  async function loadReadAccess(c: Connection) {
    if (operation.current || busy) return;
    operation.current = true; setBusy(true);
    const epoch = revision.current;
    try {
      // The write level is optional here: its failure never hides the read settings.
      const [result, write] = await Promise.all([
        accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/read-access"),
        accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/write-access").catch(() => null)]);
      if (epoch !== revision.current) return;
      if (!isReadAccess(result)) throw new Error("查看设置未确认。");
      setReadAccess(current => ({ ...current, [c.id]: result }));
      if (isWriteAccess(write)) setWriteAccess(current => ({ ...current, [c.id]: write }));
    } catch { if (epoch === revision.current) setMessage("Agent 查看设置未确认，请稍后重试。"); }
    finally { operation.current = false; if (epoch === revision.current) setBusy(false); }
  }
  // level "read": file names and structure; "read_content": also text file bodies (P2).
  async function toggleRead(c: Connection, level: "read" | "read_content" = "read") {
    const current = readAccess[c.id];
    if (operation.current || busy || !current) return;
    const content = current.active && current.classes.includes("read_content");
    const enable = level === "read" ? !current.active : !content;
    if (!window.confirm(level === "read"
      ? (enable ? "允许已授权的 Agent 查看此目录内的文件名、类型和目录结构？不读取文件内容，不修改任何文件；可随时停止。"
        : "停止 Agent 查看此目录的文件名和目录结构？读正文也会一并停止。已经返回给 Agent 的结果无法收回。")
      : (enable ? "允许已授权的 Agent 读取此目录内由 Clued 创建的文本文件正文（每次最多 256 KB，每个已授权 Agent 连接每小时最多 8 MB）？正文会发送给该 Agent 所用的模型服务；不修改任何文件；可随时停止。"
        : "停止 Agent 读取文件正文？仍可查看文件名和目录结构。已经返回给 Agent 的内容无法收回。"))) return;
    const classes = level === "read" ? (enable ? ["read"] : []) : (enable ? ["read", "read_content"] : ["read"]);
    operation.current = true; setBusy(true);
    const epoch = revision.current;
    try {
      const result = await accountRequest({ action: "set_classes", connection_id: c.id, classes,
        base_generation: current.read_generation,
        disclosure_version: classes.includes("read_content") ? current.content_disclosure_version : current.disclosure_version,
        idempotency_key: crypto.randomUUID() },
      "/v1/storage/read-access");
      if (epoch !== revision.current) return;
      if (result.status !== "committed" || typeof result.receipt_id !== "string") throw new Error("回执未确认。");
      const latest = await accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/read-access");
      if (epoch !== revision.current) return;
      if (!isReadAccess(latest)) throw new Error("查看设置未确认。");
      setReadAccess(state => ({ ...state, [c.id]: latest }));
      const applied = level === "read" ? latest.active === enable : (latest.active && latest.classes.includes("read_content")) === enable;
      setMessage(applied ? `${enable ? "已允许" : "已停止"} Agent ${level === "read" ? "查看目录结构" : "读正文"}。回执：${result.receipt_id}`
        : "已提交，但最新状态未确认。请核对原回执。");
    } catch {
      if (epoch === revision.current) {
        setReadAccess(state => { const next = { ...state }; delete next[c.id]; return next; });
        setMessage("Agent 查看设置结果未确认。请重新读取设置并核对，勿重复提交。");
      }
    } finally { operation.current = false; if (epoch === revision.current) setBusy(false); }
  }
  async function loadNormalUse(c: Connection) {
    if (operation.current || busy) return;
    operation.current = true; setBusy(true);
    const epoch = revision.current;
    try {
      const result = await accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/normal-use");
      if (epoch !== revision.current) return;
      if (!isNormalUse(result)) throw new Error("正常使用设置未确认。");
      setNormalUse(current => ({ ...current, [c.id]: result }));
    } catch { if (epoch === revision.current) setMessage("正常使用设置未确认，请稍后重试。"); }
    finally { operation.current = false; if (epoch === revision.current) setBusy(false); }
  }
  // Normal credential: one native CAS mutation. Legacy credential: the same
  // disclosure, then Google consent to the normal set on this connection; the
  // callback enables normal use in the same transaction when Google grants it.
  async function toggleNormalUse(c: Connection) {
    const current = normalUse[c.id];
    if (operation.current || busy || !current) return;
    const enable = !current.normal_use;
    if (enable && current.reconsent_required && current.refresh_token_blocked) {
      setMessage(startReasons.refresh_token_limit); return;
    }
    if (!window.confirm(enable ? normalUseDisclosure(c.root_name) +
      (current.reconsent_required ? "\n确认后将前往 Google 授权页面，请勾选“查看你 Google 云端硬盘中的所有文件”。" : "") : normalUseOff)) return;
    operation.current = true; setBusy(true);
    const epoch = revision.current;
    try {
      if (enable && current.reconsent_required) {
        const result = await accountRequest({ connection_id: c.id, normal_use: { disclosure_version: current.disclosure_version } },
          "/v1/storage/google/start");
        if (epoch !== revision.current || typeof result.authorization_url !== "string") return;
        const url = new URL(result.authorization_url);
        if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth" || url.username || url.password)
          throw new Error("授权地址未确认。");
        window.location.assign(url.href);
        return;
      }
      const result = await accountRequest({ action: enable ? "enable" : "disable", connection_id: c.id,
        base_generation: current.read_generation, disclosure_version: current.disclosure_version, idempotency_key: crypto.randomUUID() },
      "/v1/storage/normal-use");
      if (epoch !== revision.current) return;
      if (result.status === "reconsent_required") {
        setNormalUse(state => { const next = { ...state }; delete next[c.id]; return next; });
        setMessage("需要重新授权 Google 才能开启正常使用。请重新读取设置后再开启。"); return;
      }
      if (result.status !== "committed" || typeof result.receipt_id !== "string") throw new Error("回执未确认。");
      const latest = await accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/normal-use");
      if (epoch !== revision.current) return;
      if (!isNormalUse(latest)) throw new Error("正常使用设置未确认。");
      setNormalUse(state => ({ ...state, [c.id]: latest }));
      // The read level changed too; drop its cached view so it is read again.
      setReadAccess(state => { const next = { ...state }; delete next[c.id]; return next; });
      setMessage(latest.normal_use === enable ? `${enable ? "已开启" : "已关闭"}正常使用。回执：${result.receipt_id}`
        : "已提交，但最新状态未确认。请核对原回执。");
    } catch (error) {
      if (epoch === revision.current) {
        setNormalUse(state => { const next = { ...state }; delete next[c.id]; return next; });
        const reason = error instanceof RequestFailure && error.reason ? startReasons[error.reason] : undefined;
        setMessage(reason ?? "正常使用设置结果未确认。请重新读取设置并核对，勿重复提交。");
      }
    } finally { operation.current = false; if (epoch === revision.current) setBusy(false); }
  }
  async function loadBudget(c: Connection) {
    if (operation.current || busy) return;
    operation.current = true; setBusy(true);
    const epoch = revision.current;
    try {
      const result = await accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/budget");
      if (epoch !== revision.current) return;
      if (!isBudget(result)) throw new Error("额度设置未确认。");
      setBudget(current => ({ ...current, [c.id]: result }));
      setBudgetDraft(current => {
        const next = { ...current };
        for (const scope of ["connection", "account"] as const) for (const dimension of ["read", "upload"] as const) {
          const mib = Math.floor(result[scope][`${dimension}_bytes_per_hour`] / MIB);
          const key = `${c.id}:${scope}:${dimension}`;
          next[key] = budgetPresets.includes(mib) ? String(mib) : "custom";
          next[key + ":custom"] = String(mib);
        }
        return next;
      });
    } catch { if (epoch === revision.current) setMessage("额度设置未确认，请稍后重试。"); }
    finally { operation.current = false; if (epoch === revision.current) setBusy(false); }
  }
  // The chosen value in MiB, or null when a custom value is not a whole number within the bounds.
  function budgetChoice(c: Connection, scope: BudgetScope, dimension: BudgetDimension, current: Budget) {
    const key = `${c.id}:${scope}:${dimension}`;
    const choice = budgetDraft[key] === "custom" ? budgetDraft[key + ":custom"] ?? "" : budgetDraft[key] ?? "";
    if (!/^[1-9][0-9]{0,6}$/.test(choice)) return null;
    const mib = Number(choice);
    return mib * MIB >= current.bounds[scope].min_bytes && mib * MIB <= current.bounds[scope].max_bytes ? mib : null;
  }
  async function saveBudget(c: Connection, scope: BudgetScope) {
    const current = budget[c.id];
    if (operation.current || busy || !current) return;
    const read = budgetChoice(c, scope, "read", current), upload = budgetChoice(c, scope, "upload", current);
    if (read === null || upload === null) {
      setMessage(`自定义额度须为 ${formatBytes(current.bounds[scope].min_bytes)} 到 ${formatBytes(current.bounds[scope].max_bytes)} 之间的整数 MiB。`);
      return;
    }
    if (!window.confirm(`将${budgetScopeName[scope]}的每小时额度改为：读取 ${formatMib(read)}、上传 ${formatMib(upload)}？` +
      "保存后立即生效：之后每次读取和上传都按新额度检查；调低到已用量以下时，新的读取或上传要等滚动一小时内的用量回落。" +
      "已经返回的内容和已签发的上传链接不受影响；不改变任何授权、正常使用、写入设置或排队任务。")) return;
    operation.current = true; setBusy(true);
    const epoch = revision.current;
    try {
      const result = await accountRequest({ action: "set", scope, ...(scope === "connection" ? { connection_id: c.id } : {}),
        base_generation: current[scope].budget_generation, read_bytes_per_hour: read * MIB, upload_bytes_per_hour: upload * MIB,
        idempotency_key: crypto.randomUUID() }, "/v1/storage/budget");
      if (epoch !== revision.current) return;
      if (result.status !== "committed" || typeof result.receipt_id !== "string") throw new Error("回执未确认。");
      const latest = await accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/budget");
      if (epoch !== revision.current) return;
      if (!isBudget(latest)) throw new Error("额度设置未确认。");
      setBudget(state => ({ ...state, [c.id]: latest }));
      setMessage(latest[scope].read_bytes_per_hour === read * MIB && latest[scope].upload_bytes_per_hour === upload * MIB
        ? `已更新${budgetScopeName[scope]}的每小时额度，立即生效。回执：${result.receipt_id}` : "已提交，但最新状态未确认。请核对原回执。");
    } catch {
      if (epoch === revision.current) {
        setBudget(state => { const next = { ...state }; delete next[c.id]; return next; });
        setMessage("额度设置结果未确认。请重新读取额度设置并核对，勿重复提交。");
      }
    } finally { operation.current = false; if (epoch === revision.current) setBusy(false); }
  }
  async function loadTrash(c: Connection) {
    if (operation.current || busy) return;
    operation.current = true; setBusy(true);
    const epoch = revision.current;
    try {
      const result = await accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/trash-confirmation");
      if (epoch !== revision.current) return;
      if (!isTrashConfirmation(result)) throw new Error("回收站确认设置未确认。");
      setTrash(state => ({ ...state, [c.id]: result }));
    } catch { if (epoch === revision.current) setMessage("回收站确认设置未确认，请稍后重试。"); }
    finally { operation.current = false; if (epoch === revision.current) setBusy(false); }
  }
  // §3.4 item 4: the Owner confirms a whole pending batch once ("全部确认").
  async function confirmTrash(c: Connection, batch: TrashBatch) {
    const current = trash[c.id];
    if (operation.current || busy || !current?.destructive || batch.status !== "pending" || !batch.items.every(item => item.current)) return;
    if (!window.confirm(`确认这批共 ${batch.items.length} 项（24 小时内有效，每项只用一次）？移入回收站的项目，Google 会在 30 天后自动永久删除。\n\n`
      + batch.items.map(trashItemText).join("\n"))) return;
    operation.current = true; setBusy(true);
    const epoch = revision.current;
    try {
      const result = await accountRequest({ action: "confirm", connection_id: c.id, batch_id: batch.batch_id,
        base_generation: current.policy_generation, idempotency_key: crypto.randomUUID() }, "/v1/storage/trash-confirmation");
      if (epoch !== revision.current) return;
      if (result.status !== "committed" || typeof result.receipt_id !== "string") throw new Error("回执未确认。");
      const latest = await accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/trash-confirmation");
      if (epoch !== revision.current) return;
      if (!isTrashConfirmation(latest)) throw new Error("回收站确认设置未确认。");
      setTrash(state => ({ ...state, [c.id]: latest }));
      setMessage(`已确认这批 ${batch.items.length} 项。回执：${result.receipt_id}`);
    } catch {
      if (epoch === revision.current) {
        setTrash(state => { const next = { ...state }; delete next[c.id]; return next; });
        setMessage("回收站确认结果未确认。请重新读取并核对，勿重复提交。");
      }
    } finally { operation.current = false; if (epoch === revision.current) setBusy(false); }
  }
  async function toggleWrite(c: Connection, level: WriteLevel) {
    const current = writeAccess[c.id];
    if (operation.current || busy || !current?.active) return;
    const enable = !current.classes.includes(level);
    if (!window.confirm(enable ? writeText[level].on : writeText[level].off)) return;
    const classes = enable ? [...current.classes, level].sort() : current.classes.filter(item => item !== level);
    operation.current = true; setBusy(true);
    const epoch = revision.current;
    let settled = epoch;
    try {
      const result = await accountRequest({ action: "set_classes", connection_id: c.id, classes,
        base_generation: current.policy_generation,
        disclosure_version: writeDisclosure(current, level),
        idempotency_key: crypto.randomUUID() }, "/v1/storage/write-access");
      if (epoch !== revision.current) return;
      if (result.status !== "committed" || typeof result.receipt_id !== "string") throw new Error("回执未确认。");
      // refresh() starts a new revision and clears busy; the readback belongs
      // to that revision, and the operation keeps the page busy until it ends.
      const reloadedList = await refresh();
      // undefined: a newer revision (sign-in change) superseded this reload.
      if (reloadedList === undefined) return;
      const reloaded = revision.current;
      settled = reloaded; setBusy(true);
      if (reloadedList === null) throw new Error("连接摘要未确认。");
      const [latest, read] = await Promise.all([
        accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/write-access"),
        accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/read-access")]);
      if (reloaded !== revision.current) return;
      if (!isWriteAccess(latest) || !isReadAccess(read)) throw new Error("修改设置未确认。");
      setWriteAccess(state => ({ ...state, [c.id]: latest }));
      setReadAccess(state => ({ ...state, [c.id]: read }));
      setMessage(latest.classes.includes(level) === enable
        ? `${enable ? "已允许" : "已停止"} Agent ${writeText[level].name}。回执：${result.receipt_id}` : "已提交，但最新状态未确认。请核对原回执。");
    } catch {
      // The policy (and the read access bound to it) may have changed: drop both.
      setWriteAccess(state => { const next = { ...state }; delete next[c.id]; return next; });
      setReadAccess(state => { const next = { ...state }; delete next[c.id]; return next; });
      if (settled === revision.current) {
        setMessage("Agent 修改设置结果未确认。若此目录有已开始但未完成的任务，请等它结束后再试。请重新读取设置并核对，勿重复提交。");
      }
    } finally { operation.current = false; if (settled === revision.current) setBusy(false); }
  }
  async function disconnect(c: Connection) {
    if (operation.current || busy || c.state === "revoked") return;
    if (!window.confirm("断开整个网盘连接？会停止此连接的后续存储操作与后台续签，不删除 Google Drive 文件。已开始的操作可能仍需核对原回执；断开后不再允许读取提供方来恢复未确认的结果。")) return;
    operation.current = true; setBusy(true);
    const epoch = revision.current;
    try {
      const result = await accountRequest({ action: "disconnect", connection_id: c.id, base_version: c.version,
        idempotency_key: crypto.randomUUID() });
      if (epoch !== revision.current) return;
      if (result.status !== "committed" || typeof result.receipt_id !== "string") throw new Error("断开回执未确认。");
      const latest = await refresh();
      const stopped = latest?.find(item => item.id === c.id);
      setMessage(stopped?.state === "revoked" && !stopped.policy_active && !stopped.refresh_enabled
        ? `网盘连接已断开。回执：${result.receipt_id}` : "断开已提交，但最新状态未确认。请核对原回执。");
    } catch {
      if (epoch === revision.current) { await refresh(); setMessage("断开结果未确认。请核对最新状态与原回执，勿重复提交。"); }
    } finally { operation.current = false; if (epoch === revision.current) setBusy(false); }
  }
  return <main className="mx-auto max-w-3xl px-6 py-16">
    <h1 className="text-2xl font-semibold">存储连接</h1>
    <p className="my-4">Google Drive 的授权属于当前 Clued 账号。这里显示已登记范围与实际执行状态。</p>
    <p role="status" className="my-4">{message}</p>
    {connections.map(c => {
      const available = c.state === "active" && c.auth_mode === "account_policy" && c.policy_active
        && c.profile_current && c.database_execution_enabled && workerEnabled;
      return <section key={c.id} className="my-4 rounded-xl border p-4">
        <h2 className="font-semibold">{c.provider === "google-drive" ? "Google Drive" : c.provider} · {stateName[c.state] ?? "状态待确认"}</h2>
        <p className="my-2">已登记范围：{c.root_name}</p>
        <p>账号允许的操作：{c.policy_active && c.actions.length ? c.actions.map(action => actionName[action]).join("、") : "无当前可用授权"}</p>
        <p role="status" className="my-2">{available ? "存储执行入口已开启；每项操作仍须通过当前目录、客户端和单次任务准入。" : "当前文件操作不可用或暂停；连接状态不代表写入已启用。"}</p>
        <p className="my-2 text-sm">后台续签：{c.refresh_enabled ? "开启" : "关闭"}。</p>
        {c.state === "awaiting_provider" && <label className="my-2 block">
          <input type="checkbox" disabled={busy} checked={defaultRefresh} onChange={event => setDefaultRefresh(event.target.checked)} />
          连接后开启后台续签</label>}
        {["awaiting_provider", "reauthorization_required"].includes(c.state) &&
          <button disabled={busy} onClick={() => void connect(c)}>连接／重新授权 Google</button>}
        {c.state === "active" && c.auth_mode === "account_policy" && c.policy_active && <div className="my-2">
          <p className="font-semibold">正常使用：{normalUse[c.id] ? (normalUse[c.id].normal_use ? "已开启（可读取目录内全部文件并按内容搜索）" : "未开启") : "未读取"}</p>
          {normalUse[c.id]
            ? <button disabled={busy} onClick={() => void toggleNormalUse(c)}>{normalUse[c.id].normal_use ? "关闭正常使用" : "开启正常使用"}</button>
            : <button disabled={busy} onClick={() => void loadNormalUse(c)}>读取正常使用设置</button>}
          {normalUse[c.id] && !normalUse[c.id].normal_use && normalUse[c.id].reconsent_required &&
            <p className="my-1 text-sm">开启需要重新授权 Google（增加“查看你 Google 云端硬盘中的所有文件”）；授权完成前，现有功能照常可用。</p>}
          {normalUse[c.id]?.refresh_token_warning && <p role="status" className="my-1 text-sm">{normalUse[c.id].refresh_token_blocked
            ? "该 Google 账号在 Clued 中的授权次数已达上限，暂时不能通过重新授权开启正常使用；请联系维护者处理。Google 超过上限时会静默作废最早的授权；若某个连接突然需要重新授权，可能是这个原因，重新连接仍可使用。"
            : `该 Google 账号在 Clued 中的授权次数已较多（${normalUse[c.id].refresh_token_count} 次）。Google 超过上限时会静默作废最早的授权；若某个连接突然需要重新授权，可能是这个原因。`}</p>}
          <div className="mt-3">
            <p className="font-semibold">每小时额度：{budget[c.id]
              ? `每个已授权 Agent 读取 ${formatBytes(budget[c.id].connection.read_bytes_per_hour)}、上传 ${formatBytes(budget[c.id].connection.upload_bytes_per_hour)}；` +
                `账号合计读取 ${formatBytes(budget[c.id].account.read_bytes_per_hour)}、上传 ${formatBytes(budget[c.id].account.upload_bytes_per_hour)}`
              : "未读取"}</p>
            {budget[c.id] ? <>
              <p className="my-1 text-sm">按滚动一小时计算；读取与上传分别计量，每个 Agent 和账号合计都不能超出。用完后 Agent 会收到“额度已用完”，一小时内逐步恢复。只有你可以在这里修改。</p>
              {(["connection", "account"] as const).map(scope => <div key={scope} className="my-2">
                <p className="text-sm">{budgetScopeName[scope]}（可设 {formatBytes(budget[c.id].bounds[scope].min_bytes)}–{formatBytes(budget[c.id].bounds[scope].max_bytes)}）</p>
                {(["read", "upload"] as const).map(dimension => {
                  const key = `${c.id}:${scope}:${dimension}`;
                  return <label key={dimension} className="mr-4 text-sm">{budgetDimensionName[dimension]}{" "}
                    <select aria-label={`${budgetScopeName[scope]}${budgetDimensionName[dimension]}额度`} disabled={busy} value={budgetDraft[key] ?? ""}
                      onChange={event => { const value = event.target.value; setBudgetDraft(state => ({ ...state, [key]: value })); }}>
                      {budgetPresets.map(mib => <option key={mib} value={String(mib)}>{formatMib(mib)}{mib === budgetDefault[scope] ? "（默认）" : ""}</option>)}
                      <option value="custom">自定义</option>
                    </select>
                    {budgetDraft[key] === "custom" && <> <input aria-label={`${budgetScopeName[scope]}${budgetDimensionName[dimension]}自定义额度（MiB）`}
                      type="number" inputMode="numeric" step={1} min={budget[c.id].bounds[scope].min_bytes / MIB} max={budget[c.id].bounds[scope].max_bytes / MIB}
                      disabled={busy} value={budgetDraft[key + ":custom"] ?? ""}
                      onChange={event => { const value = event.target.value; setBudgetDraft(state => ({ ...state, [key + ":custom"]: value })); }} /> MiB</>}
                  </label>;
                })}
                <button disabled={busy} onClick={() => void saveBudget(c, scope)}>{scope === "connection" ? "保存此连接的额度" : "保存账号合计额度"}</button>
              </div>)}
            </> : <button disabled={busy} onClick={() => void loadBudget(c)}>读取额度设置</button>}
          </div>
          <p className="mt-3 text-sm font-semibold">高级</p>
          <p>Agent 查看目录结构：{readAccess[c.id] ? (readAccess[c.id].active
            ? (readAccess[c.id].classes.includes("read_content") ? "已允许" : "已允许（只看文件名和目录，不读内容）") : "未允许") : "未读取"}</p>
          {readAccess[c.id]
            ? <button disabled={busy} onClick={() => void toggleRead(c)}>{readAccess[c.id].active ? "停止 Agent 查看目录结构" : "允许 Agent 查看目录结构"}</button>
            : <button disabled={busy} onClick={() => void loadReadAccess(c)}>读取 Agent 查看设置</button>}
          {readAccess[c.id]?.active && <>
            <p className="mt-2">Agent 读正文：{readAccess[c.id].classes.includes("read_content") ? "已允许（仅 Clued 创建的文本文件）" : "未允许"}</p>
            <button disabled={busy} onClick={() => void toggleRead(c, "read_content")}>
              {readAccess[c.id].classes.includes("read_content") ? "停止 Agent 读正文" : "允许 Agent 读正文"}</button>
          </>}
          {writeAccess[c.id]?.active && writeLevels(writeAccess[c.id]).map(level => <div key={level}>
            <p className="mt-2">Agent {writeText[level].name}：{writeAccess[c.id].classes.includes(level) ? "已允许（仅 Clued 创建的文件）" : "未允许"}</p>
            <button disabled={busy} onClick={() => void toggleWrite(c, level)}>
              {writeAccess[c.id].classes.includes(level) ? `停止 Agent ${writeText[level].name}` : `允许 Agent ${writeText[level].name}`}</button>
          </div>)}
          {writeAccess[c.id]?.active && writeAccess[c.id].classes.includes("destructive") && <div>
            <p className="mt-2">回收站批量确认：同一客户端登记在 24 小时内移入回收站超过 5 项时，Agent 会把其余项目列成一批，在这里一次确认。</p>
            {trash[c.id] ? <>
              {trash[c.id].batches.length === 0 ? <p>没有待确认或已确认的批次。</p> : trash[c.id].batches.map(batch =>
                <div key={batch.batch_id} className="mt-2">
                  <p>{batch.status === "pending" ? "待确认批次" : "已确认批次"}（{batch.items.length} 项，{batch.expires_at} 前有效）</p>
                  {batch.items.map((item, index) => <p key={index}>{trashItemText(item)}
                    {item.used ? "：已使用" : item.current ? "" : "：已变化，不能确认，请让 Agent 重新列出"}</p>)}
                  {batch.status === "pending" && <button disabled={busy || !batch.items.every(item => item.current)}
                    onClick={() => void confirmTrash(c, batch)}>全部确认</button>}
                </div>)}
              {trash[c.id].batches_truncated && <p>只显示最近 20 个批次。</p>}
            </> : <button disabled={busy} onClick={() => void loadTrash(c)}>读取回收站确认</button>}
          </div>}
        </div>}
        {["active", "reauthorization_required"].includes(c.state) && <button disabled={busy} onClick={() => void disconnect(c)}>断开网盘连接</button>}
      </section>;
    })}
    <div className="mt-6 flex gap-4"><button disabled={busy} onClick={() => void refresh()}>刷新状态</button>
      <Link href="/storage/onboard">新建 Google Drive 连接</Link><Link href="/storage/admin">存储管理</Link><Link href="/oauth/connections">已连接应用／客户端管理</Link></div>
  </main>;
}
