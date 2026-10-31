"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../../supabase-browser";
import { MASTER_DISCLOSURE_VERSION, MASTER_OFF_DISCLOSURE, REFRESH_RECONNECT_CONFIRMATION, RECONNECT_REFRESH_DISCLOSURE_VERSION, RECONNECT_REFRESH_DISCLOSURE, renderMasterDisclosure } from "../../../worker/storage-master-disclosure";

type Connection = {
  id: string; version: number; provider: string; state: string; auth_mode: string;
  root_name: string; policy_active: boolean; actions: string[];
  refresh_enabled: boolean; database_execution_enabled: boolean; profile_current: boolean;
  profile_version: number; root_folder_id: string; managed_root: string;
  created_by_clued: boolean; root_stopped: boolean; root_stop_generation: number;
  normal_use_enabled: boolean;
  physical_location: { status: "verified" | "unavailable"; source: "google_drive_metadata"; path?: string; root_name?: string; observed_at?: string };
  pending_lifecycle?: { attempt_id: string; operation: "reconnect" | "delete"; state: string; execution_permitted: false };
  // Storage step 3: directories still matched by Drive version (older servers omit it).
  access_digest_missing?: DigestMissing;
  // Bug 38bb5ddf: directories that need the Owner, from a separate read.
  access_digest_attention?: DigestAttention;
};
type DigestMissing = { count: number; directories: { path: string; since: string }[] };
function isDigestMissing(value: unknown): value is DigestMissing {
  return isObject(value) && Number.isSafeInteger(value.count) && Number(value.count) >= 0 && Array.isArray(value.directories)
    && value.directories.length <= 20 && value.directories.every(d => isObject(d) && typeof d.path === "string" && typeof d.since === "string");
}
type DigestAttention = { count: number; directories: { path: string; reason: "access_differs" | "not_found" | "unreadable" }[] };
function isDigestAttention(value: unknown): value is DigestAttention {
  return isObject(value) && Number.isSafeInteger(value.count) && Number(value.count) >= 0 && Array.isArray(value.directories)
    && value.directories.length <= 20 && value.directories.every(d => isObject(d) && typeof d.path === "string"
      && ["access_differs", "not_found", "unreadable"].includes(String(d.reason)));
}
const attentionReason: Record<DigestAttention["directories"][number]["reason"], string> = {
  access_differs: "共享设置与上级目录不同（单独分享给了别人或改了权限）",
  not_found: "在 Google Drive 中已找不到（可能已删除或移出资料根）",
  unreadable: "Google Drive 一直无法读出它的共享设置",
};
const actionName: Record<string, string> = {
  inspect: "查看任务状态", create_file: "新建文件", create_topic: "新建主题目录", modify: "改名、移动文件",
  overwrite: "覆盖文件内容", destructive: "移入回收站、从回收站恢复", modify_subtree: "移动整个文件夹",
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
    && Number.isSafeInteger(value.profile_version) && Number(value.profile_version) > 0
    && typeof value.root_folder_id === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value.root_folder_id)
    && typeof value.managed_root === "string" && typeof value.created_by_clued === "boolean"
    && typeof value.root_stopped === "boolean" && Number.isSafeInteger(value.root_stop_generation)
    && typeof value.normal_use_enabled === "boolean" && isObject(value.physical_location)
    && ["verified", "unavailable"].includes(String(value.physical_location.status))
    && value.physical_location.source === "google_drive_metadata"
    && (value.physical_location.status !== "verified" || (typeof value.physical_location.path === "string"
      && typeof value.physical_location.root_name === "string"))
    && (value.pending_lifecycle === undefined || (isObject(value.pending_lifecycle)
      && typeof value.pending_lifecycle.attempt_id === "string" && /^[0-9a-f-]{36}$/.test(value.pending_lifecycle.attempt_id)
      && ["reconnect", "delete"].includes(String(value.pending_lifecycle.operation))
      && ["prepared", "started", "uncertain"].includes(String(value.pending_lifecycle.state))
      && value.pending_lifecycle.execution_permitted === false))
    && Array.isArray(value.actions) && value.actions.every(action => typeof action === "string" && Object.hasOwn(actionName, action))
    && (value.access_digest_missing === undefined || isDigestMissing(value.access_digest_missing));
}
// A refused request keeps only a fixed reason label from our own allowlist.
class RequestFailure extends Error { reason?: string; }
async function accountRequest(body: object, path = "/v1/storage/owner", context?: { owner: string | null; current: () => boolean }) {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error("请登录 BeamingFace 后重新读取连接。");
  if (context && (!context.current() || data.session.user.id !== context.owner)) throw new Error("账号已变化，请重新读取。");
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
  if (latest.error || latest.data.session?.user.id !== data.session.user.id || (context && !context.current())) throw new Error("账号已变化，请重新读取。");
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
// StorageFullCapability P7 (Decision 6dc1cf20): a server that offers the full
// scope names its state and disclosure; an older one omits both.
type NormalUse = { read_generation: number; disclosure_version: string; provider_scope_profile: "legacy" | "normal" | "full";
  normal_use: boolean; reconsent_required: boolean; refresh_token_count: number; refresh_token_warning: boolean; refresh_token_blocked: boolean;
  full_scope?: boolean; full_scope_disclosure_version?: string };
function isNormalUse(value: unknown): value is NormalUse {
  return isObject(value) && Number.isSafeInteger(value.read_generation) && typeof value.disclosure_version === "string"
    && (value.provider_scope_profile === "legacy" || value.provider_scope_profile === "normal" || value.provider_scope_profile === "full")
    && typeof value.normal_use === "boolean" && typeof value.reconsent_required === "boolean"
    && Number.isSafeInteger(value.refresh_token_count) && typeof value.refresh_token_warning === "boolean"
    && typeof value.refresh_token_blocked === "boolean"
    && (value.full_scope === undefined || typeof value.full_scope === "boolean")
    && (value.full_scope_disclosure_version === undefined || typeof value.full_scope_disclosure_version === "string")
    && (value.full_scope === undefined) === (value.full_scope_disclosure_version === undefined);
}
type MasterState = "on" | "off" | "partial" | "unknown";
type MasterAccess = { contract: "clued.storage-master-control/1"; connection_id: string; state: Exclude<MasterState, "unknown">;
  master_generation: number; status_digest: string; disclosure_version: string; provider_scope_profile: "legacy" | "normal" | "full";
  reconsent_required: boolean; read_classes: string[]; read_content: boolean; normal_use: boolean; write_classes: string[];
  agent_enabled: boolean; create_enabled: boolean; read_enabled: boolean; write_enabled: boolean };
function isMasterAccess(value: unknown): value is MasterAccess {
  if (!isObject(value)) return false;
  const readClasses = value.read_classes, writeClasses = value.write_classes;
  return value.contract === "clued.storage-master-control/1"
    && typeof value.connection_id === "string" && /^[0-9a-f-]{36}$/.test(value.connection_id)
    && ["on", "off", "partial"].includes(String(value.state)) && Number.isSafeInteger(value.master_generation) && Number(value.master_generation) >= 0
    && typeof value.status_digest === "string" && /^[0-9a-f]{64}$/.test(value.status_digest) && typeof value.disclosure_version === "string"
    && ["legacy", "normal", "full"].includes(String(value.provider_scope_profile)) && typeof value.reconsent_required === "boolean"
    && Array.isArray(readClasses) && readClasses.every(item => item === "read" || item === "read_content")
    && typeof value.read_content === "boolean" && typeof value.normal_use === "boolean" && typeof value.agent_enabled === "boolean" && typeof value.create_enabled === "boolean"
    && typeof value.read_enabled === "boolean" && typeof value.write_enabled === "boolean"
    && Array.isArray(writeClasses) && writeClasses.every(item => ["modify", "overwrite", "destructive", "modify_subtree"].includes(String(item)))
    && (value.state !== "on" || (value.provider_scope_profile === "full" && value.reconsent_required === false && value.agent_enabled === true
      && value.normal_use === true && value.read_content === true && value.create_enabled === true && value.read_enabled === true && value.write_enabled === true
      && ["read", "read_content"].every(item => readClasses.includes(item))
      && ["modify", "overwrite", "destructive", "modify_subtree"].every(item => writeClasses.includes(item))))
    && (value.state !== "off" || (value.agent_enabled === false && value.create_enabled === false && value.normal_use === false
      && value.read_content === false && value.read_enabled === false && value.write_enabled === false));
}
function masterReadingStatus(master: MasterAccess | undefined) {
  if (!master) return "总开关状态未确认；实际读取权限未确认";
  if (master.state === "off") return "总开关已关闭；读取与搜索已停止";
  if (!master.agent_enabled) return "当前执行条件未满足；读取与搜索已停止";
  if (!master.read_enabled || !master.read_classes.includes("read")) return "目录结构和正文读取均已停止";
  if (!master.read_content || !master.read_classes.includes("read_content")) return "当前仅允许查看文件名和目录结构";
  return master.normal_use ? "已允许读取目录内全部文件并按内容搜索" : "仅允许读取 BeamingFace 创建的文本文件；全部文件读取与搜索未开启";
}
const masterStateName: Record<MasterState, string> = { on: "全开", off: "全关", partial: "部分开启", unknown: "状态未确认" };
function MasterAccessSwitch({ state, statusId, disabled, onToggle }: { state: MasterState; statusId: string; disabled: boolean; onToggle: (enable: boolean) => void }) {
  return <label className="inline-flex cursor-pointer items-center gap-3">
    <input type="checkbox" aria-label="Agent 文件操作总开关" aria-describedby={statusId} className="peer sr-only"
      checked={state === "on"} aria-checked={state === "partial" ? "mixed" : state === "on"}
      ref={element => { if (element) element.indeterminate = state === "partial"; }}
      disabled={disabled || state === "unknown"} onChange={event => {
        // The native click clears indeterminate before confirmation. Restore
        // the verified state until the committed status is read back.
        event.target.checked = state === "on";
        event.target.indeterminate = state === "partial";
        onToggle(state !== "on");
      }} />
    <span aria-hidden="true" className={`relative h-7 w-14 rounded-full border border-[var(--line)] transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-[var(--green)] peer-disabled:opacity-50 ${state === "on" ? "bg-[var(--green)]" : state === "partial" ? "bg-[var(--green)]/30" : "bg-[var(--panel)]"}`}>
      <span className={`absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--ink)] text-xs text-black transition-transform ${state === "on" ? "translate-x-7" : state === "partial" ? "translate-x-3.5" : "translate-x-0"}`}>
        {state === "partial" ? "−" : state === "unknown" ? "?" : ""}
      </span>
    </span>
    <span id={statusId} aria-live="polite">{masterStateName[state]}</span>
  </label>;
}
// clued.storage-normal-use-disclosure/1 (StorageNormalUse §8.2). Any change to
// this text needs a new disclosure version in the database first.
const normalUseDisclosure = (root: string) =>
  `开启后，你授权的 Agent 可以读取「${root}」内的全部文件，包括你手动上传的文件：文本、文档、表格、PDF 的文字，图片内容，压缩包的目录和其中单个文件；其他文件可通过几分钟内有效的下载链接取回原始内容。视频和音频只读取时长、分辨率、大小等信息。Agent 还可以按内容搜索文件，并在该目录中新建图片、PDF、压缩包等文件（每个最多 20 MB），不会覆盖或删除已有文件；你手动上传的文件 Agent 不能改名、移动或删除。\n` +
  "读取到的内容会发送给该 Agent 所用的模型服务，已经返回的内容无法收回。\n" +
  "Google 页面会显示“查看你 Google 云端硬盘中的所有文件”。Clued 服务端只允许访问所选目录，这个限制由 Clued 保证，不由 Google 保证。\n" +
  "默认每小时额度：读取 256 MB、上传 256 MB。关闭“正常使用”会立即停止读正文、按内容搜索和上传，但不会收回 Google 授权；“撤回全部文件读取授权”会断开该 Google 账号在 Clued 中的所有连接。";
// clued.storage-full-scope-disclosure/1 (StorageFullCapability P7, Decision
// 6dc1cf20). Any change to this text needs a new disclosure version in the
// database first.
const fullScopeDisclosure = (root: string) =>
  `允许管理已有文件后，Clued 可以“纳管”「${root}」里你自己拥有的已有文件和文件夹：一次一个，只登记、不改动。纳管后，它们和 Clued 自己创建的文件一样，受你打开的写入等级约束：文件可以改名和移动，1 MB 以内的文本文件可以覆盖，文件夹可以整体移动，空文件夹和文件可以移入回收站。纳管属于“改名和移动文件”等级；这一步只升级 Google 授权，不会打开任何写入等级。\n` +
  "Google 页面会显示“查看、修改、创建和删除你 Google 云端硬盘中的所有文件”。Clued 服务端只允许访问所选目录，这个限制由 Clued 保证，不由 Google 保证；授权凭据一旦泄露，整个云端硬盘都可能被读取或改写。\n" +
  "关闭对应的写入等级会立即停止纳管和修改，但不会收回 Google 授权。要收回授权，请在 Google 账号的“第三方应用和服务”中移除 Clued；这会断开该 Google 账号在 Clued 中的所有连接，之后需要重新连接。";
const normalUseOff = "关闭“正常使用”？会立即停止读正文、按内容搜索和上传，仍可查看文件名和目录结构。这不会收回 Google 授权（Google 页面上的授权范围不变）；已经返回给 Agent 的内容无法收回。";
const startReasons: Record<string, string> = {
  storage_root_busy: "该目录还有尚未完成的文件操作，稍后再试。",
  // Until "撤回全部文件读取授权" exists, only a maintainer can reset the count
  // (runbook); a plain reconnect is never refused.
  refresh_token_limit: "该 Google 账号在 BeamingFace 中的授权次数已达上限，暂时不能通过重新授权开启正常使用。请联系维护者处理；现有功能和重新连接不受影响。",
  refresh_token_limit_full: "该 Google 账号在 BeamingFace 中的授权次数已达上限，暂时不能通过重新授权允许管理已有文件。请联系维护者处理；现有功能和重新连接不受影响。",
  storage_full_scope_disclosure_changed: "说明已更新，请重新读取设置后再确认。",
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
type WriteLevel = "modify" | "overwrite" | "destructive" | "modify_subtree";
type WriteAccess = { active: boolean; policy_generation: number; disclosure_version: string;
  overwrite_disclosure_version: string; destructive_disclosure_version?: string; subtree_disclosure_version?: string; classes: string[] };
function isWriteAccess(value: unknown): value is WriteAccess {
  return isObject(value) && typeof value.active === "boolean" && Number.isSafeInteger(value.policy_generation)
    && typeof value.disclosure_version === "string" && typeof value.overwrite_disclosure_version === "string"
    && (value.destructive_disclosure_version === undefined || typeof value.destructive_disclosure_version === "string")
    && (value.subtree_disclosure_version === undefined || typeof value.subtree_disclosure_version === "string")
    && Array.isArray(value.classes)
    && value.classes.every(item => item === "modify" || item === "overwrite" || item === "destructive" || item === "modify_subtree");
}
// The destructive (P5) and modify_subtree (P6) levels are offered only by a server that names their disclosure.
const writeLevels = (access: WriteAccess): WriteLevel[] => [
  "modify", "overwrite",
  ...(access.destructive_disclosure_version === undefined ? [] : ["destructive" as const]),
  ...(access.subtree_disclosure_version === undefined ? [] : ["modify_subtree" as const]),
];
const writeDisclosure = (access: WriteAccess, level: WriteLevel) => level === "overwrite" ? access.overwrite_disclosure_version
  : level === "destructive" ? access.destructive_disclosure_version ?? ""
  : level === "modify_subtree" ? access.subtree_disclosure_version ?? "" : access.disclosure_version;
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
type DeletePreview = { trash_available: true; root_folder_id: string; root_name: string; root_version: string;
  metadata_digest: string; item_count: number; connection_version: number; profile_version: number;
  confirmation_contract?: "clued.storage-owner-confirmation/2"; confirmation_mode?: "whole_created_root_v2" };
const wholeRootPreview = (v: DeletePreview) => v.confirmation_contract === "clued.storage-owner-confirmation/2"
  && v.confirmation_mode === "whole_created_root_v2";
function isDeletePreview(v: unknown, c: Connection): v is DeletePreview {
  return isObject(v) && v.trash_available === true && v.root_folder_id === c.root_folder_id
    && typeof v.root_name === "string" && typeof v.root_version === "string" && /^[0-9]{1,30}$/.test(v.root_version)
    && typeof v.metadata_digest === "string" && /^[0-9a-f]{64}$/.test(v.metadata_digest)
    && Number.isSafeInteger(v.item_count) && Number(v.item_count) >= 0
    && v.connection_version === c.version && v.profile_version === c.profile_version
    && ((v.confirmation_contract === undefined && v.confirmation_mode === undefined)
      || (v.confirmation_contract === "clued.storage-owner-confirmation/2" && v.confirmation_mode === "whole_created_root_v2"));
}
const deletePreviewReasons = {
  picked_or_legacy_root: "这是已有或自行选择的文件夹，此次只删除连接，保留文件夹及全部内容。",
  connection_inactive: "这个连接目前未处于已连接状态，无法核对文件夹。需要连带处理文件夹时，请先重新连接。",
  storage_connection_unavailable: "当前连接的有效状态或访问资格未能确认。请关闭窗口并刷新状态后核对。",
  fresh_authorization_required: "当前 Google 授权无法用于核对文件夹，需要核查授权状态。本次只删除连接，保留 Drive 文件夹。",
  metadata_unavailable: "未能读取 Google 的文件夹信息，暂时无法核对删除条件。本次只删除连接，保留 Drive 文件夹。",
  root_drift: "文件夹的位置、所有权或访问资格与登记信息不一致。本次保留 Drive 文件夹，请先核对连接与文件夹。",
  inventory_unavailable: "未能完整核对文件夹内的文件和子文件夹。本次只删除连接，保留 Drive 文件夹。",
  operation_deadline: "完整核对未能在限定时间内完成。本次只删除连接，保留 Drive 文件夹。",
  can_trash_unavailable: "未能确认 Google 允许把这个文件夹移入回收站。本次只删除连接，保留 Drive 文件夹。",
  conditional_capability_unavailable: "本次读取未取得删除所需的版本保护信息，暂时不能连带移入回收站。此连接无需因此重新连接。",
  whole_root_trash_unavailable: "当前服务尚未确认支持整文件夹回收。本次只删除连接，保留 Drive 文件夹。",
  preview_version_conflict: "连接状态在核对期间发生了变化。请关闭窗口并刷新状态，再重新核对；本次保留 Drive 文件夹。",
  lifecycle_unavailable: "文件夹删除条件尚未确认，当前无法确定具体原因。本次只删除连接，保留 Drive 文件夹。",
} as const;
type DeletePreviewReason = keyof typeof deletePreviewReasons;
function knownDeletePreviewReason(value: unknown): DeletePreviewReason {
  return typeof value === "string" && Object.hasOwn(deletePreviewReasons, value) ? value as DeletePreviewReason : "lifecycle_unavailable";
}
function refusedDeletePreview(v: unknown, c: Connection): DeletePreviewReason {
  if (isObject(v) && v.trash_available === true) {
    if (v.root_folder_id !== c.root_folder_id) return "root_drift";
    if (Number.isSafeInteger(v.connection_version) && Number.isSafeInteger(v.profile_version)
      && (v.connection_version !== c.version || v.profile_version !== c.profile_version)) return "preview_version_conflict";
    return "lifecycle_unavailable";
  }
  return isObject(v) && v.trash_available === false ? knownDeletePreviewReason(v.reason) : "lifecycle_unavailable";
}
type LifecycleDialog = { kind: "reconnect" | "delete"; connection: Connection; masterEnabled: boolean; defaultRefresh: boolean;
  trashRoot: boolean; reading: boolean; preview?: DeletePreview; previewReason?: DeletePreviewReason };
const folderHref = (c: Connection) => `https://drive.google.com/drive/folders/${encodeURIComponent(c.root_folder_id)}`;
const folderName = (c: Connection) => c.physical_location.status === "verified" ? c.physical_location.root_name! : c.root_name;
const registeredLocation = (c: Connection) => c.managed_root.startsWith("/clued-cloud/") ? null : c.managed_root;
// One write class per change; each has its own confirmation text (P3 modify, P4 overwrite, P5 destructive,
// P6 modify_subtree).
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
  modify_subtree: {
    name: "移动整个文件夹",
    on: "允许已授权的 Agent 把此目录内由 Clued 创建的文件夹，连同里面的全部内容，移动到另一个已登记的文件夹？文件夹名称不变，内容不会被删除或覆盖；只在共享设置完全相同的两个文件夹之间移动，不会改变谁能访问这些内容。每次操作都会留下回执，可以再移回原位置。不能移动一级目录（轨道），也不能移进文件夹自身。尚未开始的排队任务会被取消，已开始但未完成的任务需先结束；可随时停止。",
    off: "停止 Agent 移动整个文件夹？已移动的文件夹保持现状。尚未开始的排队任务会被取消，已开始但未完成的任务需先结束。",
  },
} as const;
export default function StorageConnections() {
  // Read the configured file range and read classes together. A range alone
  // never proves that Agent content reading is currently allowed.
  const [readAccess, setReadAccess] = useState<Record<string, ReadAccess>>({});
  // Write level (P3): changing it replaces the account policy, so the page
  // always reloads the connection list and both settings afterwards.
  const [writeAccess, setWriteAccess] = useState<Record<string, WriteAccess>>({});
  // Trash batch confirmation (P5), loaded on demand per connection.
  const [trash, setTrash] = useState<Record<string, TrashConfirmation>>({});
  // Read normal-use truth with the list, so an unknown cache is never presented as off.
  const [normalUse, setNormalUse] = useState<Record<string, NormalUse>>({});
  const [masterAccess, setMasterAccess] = useState<Record<string, MasterAccess>>({});
  // Hourly budgets (N4), loaded on demand. Drafts are "64" / "256" / "1024" or
  // "custom" per connection, scope and dimension; custom values are whole MiB.
  const [budget, setBudget] = useState<Record<string, Budget>>({});
  const [budgetDraft, setBudgetDraft] = useState<Record<string, string>>({});
  const [connections, setConnections] = useState<Connection[]>([]);
  const [workerEnabled, setWorkerEnabled] = useState(false);
  const [message, setMessage] = useState("正在读取连接……");
  const [busy, setBusy] = useState(false);
  const [defaultRefresh, setDefaultRefresh] = useState(true);
  const [dialog, setDialog] = useState<LifecycleDialog | null>(null);
  const dialogElement = useRef<HTMLDivElement | null>(null);
  const revision = useRef(0), operation = useRef(false), ownerId = useRef<string | null>(null);
  useEffect(() => { if (dialog) dialogElement.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [dialog?.kind, dialog?.connection.id]);
  const refresh = useCallback(async () => {
    const epoch = ++revision.current;
    setDialog(null);
    setNormalUse({});
    setReadAccess({});
    setWriteAccess({});
    setMasterAccess({});
    setBusy(true);
    try {
      const owner = await supabase.auth.getSession();
      if (epoch !== revision.current) return;
      ownerId.current = owner.data.session?.user.id ?? null;
      const result = await accountRequest({ action: "list" }, "/v1/storage/lifecycle");
      if (epoch !== revision.current) return;
      if (result.contract !== "clued.storage-owner-lifecycle/1" || result.complete !== true
        || !Array.isArray(result.connections) || !result.connections.every(isConnection)
        || typeof result.worker_execution_enabled !== "boolean") throw new Error("连接摘要未确认。");
      setConnections(result.connections);
      setWorkerEnabled(result.worker_execution_enabled);
      setMessage(result.connections.length ? "" : "暂无存储连接；受治理目录登记请进入管理入口。");
      // Bug 38bb5ddf: the directories that need the Owner, read separately and
      // only when some directory still lacks its digest (every such directory
      // is among them); an unanswered or refused read only leaves this notice out.
      if ((result.connections as Connection[]).some(c => (c.access_digest_missing?.count ?? 0) > 0))
        void accountRequest({ action: "digest_attention" }).then(answer => {
        if (epoch !== revision.current || answer.contract !== "clued.storage-access-digest-attention/1"
          || !Array.isArray(answer.connections)) return;
        const found = new Map<string, DigestAttention>();
        for (const item of answer.connections as unknown[]) if (isObject(item) && typeof item.connection_id === "string") {
          const value = { count: item.count, directories: item.directories };
          if (isDigestAttention(value)) found.set(item.connection_id, value);
        }
        setConnections(current => current.map(c => found.has(c.id) ? { ...c, access_digest_attention: found.get(c.id) } : c));
      }).catch(() => undefined);
      const loaded = await Promise.all((result.connections as Connection[])
        .filter(c => c.state === "active" && c.auth_mode === "account_policy")
        .map(async c => {
          const [normal, read, write, master] = await Promise.all([
            accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/normal-use").catch(() => null),
            accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/read-access").catch(() => null),
            accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/write-access").catch(() => null),
            accountRequest({ action: "master_status", connection_id: c.id }).catch(() => null),
          ]);
          return { id: c.id, normal, read, write, master };
        }));
      if (epoch !== revision.current) return null;
      setNormalUse(Object.fromEntries(loaded.flatMap(item => isNormalUse(item.normal) ? [[item.id, item.normal]] : [])));
      setReadAccess(Object.fromEntries(loaded.flatMap(item => isReadAccess(item.read) ? [[item.id, item.read]] : [])));
      setWriteAccess(Object.fromEntries(loaded.flatMap(item => isWriteAccess(item.write) ? [[item.id, item.write]] : [])));
      setMasterAccess(Object.fromEntries(loaded.flatMap(item => isMasterAccess(item.master) && item.master.connection_id === item.id ? [[item.id, item.master]] : [])));
      return result.connections as Connection[];
    } catch (error) {
      if (epoch === revision.current) {
        setConnections([]); setWorkerEnabled(false);
        setMessage(error instanceof Error ? error.message : "连接状态未确认。");
      }
      return epoch === revision.current ? null : undefined;
    } finally { if (epoch === revision.current) setBusy(false); }
  }, []);
  useEffect(() => {
    let disposed = false;
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (disposed) return;
      if (event === "TOKEN_REFRESHED" && session?.user.id === ownerId.current) return;
      ownerId.current = session?.user.id ?? null;
      ++revision.current; setConnections([]); setWorkerEnabled(false);
      setDialog(null);
      setNormalUse({}); setReadAccess({}); setWriteAccess({}); setMasterAccess({}); setBudget({}); setBudgetDraft({}); setTrash({});
      queueMicrotask(() => { if (!disposed) void refresh(); });
    });
    queueMicrotask(() => { if (!disposed) void refresh(); });
    return () => { disposed = true; ++revision.current; data.subscription.unsubscribe(); };
  }, [refresh]);
  async function connect(c: Connection) {
    if (operation.current || busy || !["awaiting_provider", "reauthorization_required"].includes(c.state)) return;
    const enrollRefresh = c.state === "awaiting_provider" && defaultRefresh;
    if (enrollRefresh && !window.confirm("连接后允许 BeamingFace 服务端按既有范围后台续签，直到主动停用？")) return;
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
  async function readMasterAccess(c: Connection, epoch: number) {
    try {
      const result = await accountRequest({ action: "master_status", connection_id: c.id }, "/v1/storage/owner",
        { owner: ownerId.current, current: () => epoch === revision.current });
      if (epoch !== revision.current) return;
      if (!isMasterAccess(result) || result.connection_id !== c.id) throw new Error("总开关状态未确认。");
      setMasterAccess(state => ({ ...state, [c.id]: result }));
      return result;
    } catch {
      if (epoch === revision.current) setMasterAccess(state => { const next = { ...state }; delete next[c.id]; return next; });
    }
  }
  async function loadMasterAccess(c: Connection) {
    if (operation.current || busy) return;
    operation.current = true; setBusy(true);
    const epoch = revision.current;
    try {
      const result = await readMasterAccess(c, epoch);
      if (epoch === revision.current) setMessage(result ? "" : "总开关状态未确认，请稍后重新读取。");
    } finally { operation.current = false; if (epoch === revision.current) setBusy(false); }
  }
  async function changeMasterAccess(c: Connection, enabled: boolean) {
    const current = masterAccess[c.id];
    if (operation.current || busy || !current || (enabled && current.state === "on") || (!enabled && current.state === "off")) return;
    if (current.disclosure_version !== MASTER_DISCLOSURE_VERSION) { setMessage("总开关说明已更新，请重新读取状态后确认。"); return; }
    if (!window.confirm(enabled ? renderMasterDisclosure(folderName(c)) : MASTER_OFF_DISCLOSURE)) return;
    operation.current = true; setBusy(true);
    const epoch = revision.current;
    const context = { owner: ownerId.current, current: () => epoch === revision.current };
    let settled = epoch;
    try {
      if (enabled && current.reconsent_required) {
        const result = await accountRequest({ connection_id: c.id, full_scope: { disclosure_version: MASTER_DISCLOSURE_VERSION } }, "/v1/storage/google/start", context);
        if (epoch !== revision.current) return;
        if (typeof result.authorization_url !== "string") throw new Error("授权地址未确认。");
        const url = new URL(result.authorization_url);
        if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth" || url.username || url.password)
          throw new Error("授权地址未确认。");
        window.location.assign(url.href);
        return;
      }
      const result = await accountRequest({ action: "master_set", connection_id: c.id, enabled,
        base_generation: current.master_generation, base_status_digest: current.status_digest,
        disclosure_version: current.disclosure_version, idempotency_key: crypto.randomUUID() }, "/v1/storage/owner", context);
      if (epoch !== revision.current) return;
      if (result.status !== "committed" || typeof result.receipt_id !== "string") throw new Error("回执未确认。");
      const list = await refresh();
      if (list === undefined) return;
      settled = revision.current; setBusy(true);
      if (list === null) throw new Error("连接状态未确认。");
      const latest = await readMasterAccess(c, settled);
      if (settled !== revision.current) return;
      setMessage(latest?.state === (enabled ? "on" : "off") && latest.master_generation > current.master_generation && latest.status_digest !== current.status_digest
        ? `Agent 文件操作已${enabled ? "全部开启" : "全部停止"}。回执：${result.receipt_id}`
        : "已取得总开关回执，但最新状态未确认。请重新读取状态并核对原回执，勿重复提交。");
    } catch (error) {
      if (settled === revision.current) {
        setMasterAccess(state => { const next = { ...state }; delete next[c.id]; return next; });
        const reason = error instanceof RequestFailure && error.reason ? startReasons[error.reason] : undefined;
        setMessage(reason ?? "总开关结果未确认。请重新读取状态并核对，勿重复提交。");
      }
    } finally { operation.current = false; if (settled === revision.current) setBusy(false); }
  }
  async function loadReadAccess(c: Connection) {
    if (operation.current || busy) return;
    operation.current = true; setBusy(true);
    const epoch = revision.current;
    try {
      // The write level is optional here: its failure never hides the read settings.
      const [result, write] = await Promise.all([
        accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/read-access"),
        accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/write-access").catch(() => null),
        readMasterAccess(c, epoch)]);
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
      const [latest, normal] = await Promise.all([
        accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/read-access"),
        accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/normal-use").catch(() => null),
        readMasterAccess(c, epoch),
      ]);
      if (epoch !== revision.current) return;
      if (!isReadAccess(latest)) throw new Error("查看设置未确认。");
      setReadAccess(state => ({ ...state, [c.id]: latest }));
      setNormalUse(state => {
        const next = { ...state };
        if (isNormalUse(normal)) next[c.id] = normal; else delete next[c.id];
        return next;
      });
      const applied = level === "read" ? latest.active === enable : (latest.active && latest.classes.includes("read_content")) === enable;
      setMessage(applied ? `${enable ? "已允许" : "已停止"} Agent ${level === "read" ? "查看目录结构" : "读正文"}。回执：${result.receipt_id}`
        : "已提交，但最新状态未确认。请核对原回执。");
    } catch {
      if (epoch === revision.current) {
        setReadAccess(state => { const next = { ...state }; delete next[c.id]; return next; });
        setNormalUse(state => { const next = { ...state }; delete next[c.id]; return next; });
        setMasterAccess(state => { const next = { ...state }; delete next[c.id]; return next; });
        setMessage("Agent 查看设置结果未确认。请重新读取设置并核对，勿重复提交。");
      }
    } finally { operation.current = false; if (epoch === revision.current) setBusy(false); }
  }
  async function loadNormalUse(c: Connection) {
    if (operation.current || busy) return;
    operation.current = true; setBusy(true);
    const epoch = revision.current;
    try {
      const [result, read] = await Promise.all([
        accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/normal-use"),
        accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/read-access").catch(() => null),
        readMasterAccess(c, epoch),
      ]);
      if (epoch !== revision.current) return;
      if (!isNormalUse(result)) throw new Error("正常使用设置未确认。");
      setNormalUse(current => ({ ...current, [c.id]: result }));
      setReadAccess(current => {
        const next = { ...current };
        if (isReadAccess(read)) next[c.id] = read; else delete next[c.id];
        return next;
      });
    } catch { if (epoch === revision.current) setMessage("读取与搜索设置未确认，请稍后重试。"); }
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
      const [latest, read] = await Promise.all([
        accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/normal-use"),
        accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/read-access").catch(() => null),
        readMasterAccess(c, epoch),
      ]);
      if (epoch !== revision.current) return;
      if (!isNormalUse(latest)) throw new Error("正常使用设置未确认。");
      setNormalUse(state => ({ ...state, [c.id]: latest }));
      setReadAccess(state => {
        const next = { ...state };
        if (isReadAccess(read)) next[c.id] = read; else delete next[c.id];
        return next;
      });
      setMessage(latest.normal_use === enable ? `${enable ? "已开启" : "已关闭"}读取与搜索。回执：${result.receipt_id}`
        : "已提交，但最新状态未确认。请核对原回执。");
    } catch (error) {
      if (epoch === revision.current) {
        setNormalUse(state => { const next = { ...state }; delete next[c.id]; return next; });
        setReadAccess(state => { const next = { ...state }; delete next[c.id]; return next; });
        setMasterAccess(state => { const next = { ...state }; delete next[c.id]; return next; });
        const reason = error instanceof RequestFailure && error.reason ? startReasons[error.reason] : undefined;
        setMessage(reason ?? "正常使用设置结果未确认。请重新读取设置并核对，勿重复提交。");
      }
    } finally { operation.current = false; if (epoch === revision.current) setBusy(false); }
  }
  // Full scope (P7): the confirmed disclosure, then Google consent to the full
  // set on this connection. It upgrades the grant only; the callback reports
  // what Google granted.
  async function upgradeFullScope(c: Connection) {
    const current = normalUse[c.id];
    if (operation.current || busy || !current || current.full_scope !== false || !current.full_scope_disclosure_version) return;
    if (current.refresh_token_blocked) { setMessage(startReasons.refresh_token_limit_full); return; }
    if (!window.confirm(fullScopeDisclosure(c.root_name) +
      "\n确认后将前往 Google 授权页面，请勾选“查看、修改、创建和删除你 Google 云端硬盘中的所有文件”。")) return;
    operation.current = true; setBusy(true);
    const epoch = revision.current;
    try {
      const result = await accountRequest({ connection_id: c.id, full_scope: { disclosure_version: current.full_scope_disclosure_version } },
        "/v1/storage/google/start");
      if (epoch !== revision.current || typeof result.authorization_url !== "string") return;
      const url = new URL(result.authorization_url);
      if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth" || url.username || url.password)
        throw new Error("授权地址未确认。");
      window.location.assign(url.href);
    } catch (error) {
      if (epoch === revision.current) {
        setNormalUse(state => { const next = { ...state }; delete next[c.id]; return next; });
        const reason = error instanceof RequestFailure && error.reason ? startReasons[error.reason] : undefined;
        setMessage((reason === startReasons.refresh_token_limit ? startReasons.refresh_token_limit_full : reason) ??
          "未能开始 Google 授权。请重新读取设置后再试。");
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
    } catch (error) {
      if (epoch === revision.current) {
        setBudget(state => { const next = { ...state }; delete next[c.id]; return next; });
        const reason = error instanceof RequestFailure ? error.reason : undefined;
        setMessage(reason === "storage_owner_version_conflict" ? "额度设置已变化（或连接已断开），本次未保存。请重新读取额度设置后再改。"
          : reason === "storage_budget_out_of_bounds" ? "额度超出允许范围，本次未保存。请重新读取额度设置查看可选范围。"
            : "额度设置结果未确认。请重新读取额度设置并核对，勿重复提交。");
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
    await changeWrite(c, [level], enable);
  }
  // Decision 62e796f9: every write level at once, behind one confirmation that
  // shows each level's own text. The database still takes one level per change,
  // each with its own disclosure, so the levels are changed one after another.
  async function setAllWrite(c: Connection, enable: boolean) {
    const current = writeAccess[c.id];
    if (operation.current || busy || !current?.active) return;
    const levels = writeLevels(current).filter(level => current.classes.includes(level) !== enable);
    if (levels.length === 0) return;
    if (!window.confirm((enable ? `一次允许以下 ${levels.length} 项：` : `一次停止以下 ${levels.length} 项：`) +
      levels.map(level => `\n\n【${writeText[level].name}】${enable ? writeText[level].on : writeText[level].off}`).join(""))) return;
    await changeWrite(c, enable ? levels : [...levels].reverse(), enable);
  }
  async function changeWrite(c: Connection, levels: WriteLevel[], enable: boolean) {
    let current = writeAccess[c.id];
    operation.current = true; setBusy(true);
    const epoch = revision.current;
    let settled = epoch;
    const receipts: string[] = [];
    try {
      for (const level of levels) {
        const classes = enable ? [...current.classes, level].sort() : current.classes.filter(item => item !== level);
        const result = await accountRequest({ action: "set_classes", connection_id: c.id, classes,
          base_generation: current.policy_generation,
          disclosure_version: writeDisclosure(current, level),
          idempotency_key: crypto.randomUUID() }, "/v1/storage/write-access");
        if (epoch !== revision.current) return;
        if (result.status !== "committed" || typeof result.receipt_id !== "string") throw new Error("回执未确认。");
        receipts.push(result.receipt_id);
        if (receipts.length < levels.length) {
          // The next change is based on the generation this one produced.
          const next = await accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/write-access");
          if (epoch !== revision.current) return;
          if (!isWriteAccess(next) || !next.active || next.classes.includes(level) !== enable) throw new Error("修改设置未确认。");
          current = next;
        }
      }
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
        accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/read-access"),
        readMasterAccess(c, reloaded)]);
      if (reloaded !== revision.current) return;
      if (!isWriteAccess(latest) || !isReadAccess(read)) throw new Error("修改设置未确认。");
      setWriteAccess(state => ({ ...state, [c.id]: latest }));
      setReadAccess(state => ({ ...state, [c.id]: read }));
      const done = levels.every(level => latest.classes.includes(level) === enable);
      setMessage(!done ? "已提交，但最新状态未确认。请核对原回执。"
        : levels.length === 1 ? `${enable ? "已允许" : "已停止"} Agent ${writeText[levels[0]].name}。回执：${receipts[0]}`
        : `${enable ? "已允许" : "已停止"} Agent ${levels.map(level => writeText[level].name).join("、")}。回执：${receipts.join("、")}`);
    } catch (error) {
      // The policy (and the read access bound to it) may have changed: drop both.
      setWriteAccess(state => { const next = { ...state }; delete next[c.id]; return next; });
      setReadAccess(state => { const next = { ...state }; delete next[c.id]; return next; });
      setMasterAccess(state => { const next = { ...state }; delete next[c.id]; return next; });
      if (settled === revision.current) {
        // A partial run names what already changed; each change kept its own receipt.
        const partial = receipts.length > 0 && receipts.length < levels.length
          ? `已${enable ? "允许" : "停止"}：${levels.slice(0, receipts.length).map(level => writeText[level].name).join("、")}（回执：${receipts.join("、")}）；其余未完成。` : "";
        setMessage(partial + (error instanceof RequestFailure && error.reason === "storage_root_busy"
          // Refused before any change: the root has a job that started and has not ended.
          ? `${partial ? "" : "未修改："}此目录有一个已开始但未结束的任务，结束前不能修改 Agent 权限。没有动过网盘的任务约两分钟内会自动结束；之后重新读取设置再试。`
          : "Agent 修改设置结果未确认。若此目录有已开始但未完成的任务，请等它结束后再试。请重新读取设置并核对，勿重复提交。"));
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
  async function openLifecycle(c: Connection, kind: LifecycleDialog["kind"]) {
    if (operation.current || busy || (c.pending_lifecycle && !(kind === "reconnect"
      && c.pending_lifecycle.operation === "reconnect" && c.pending_lifecycle.state === "prepared"))) return;
    if (kind === "reconnect" && (c.state !== "revoked" || !c.root_stopped || c.root_stop_generation < 1)) return;
    const next: LifecycleDialog = { kind, connection: c, masterEnabled: kind === "reconnect", defaultRefresh: kind === "reconnect", trashRoot: false,
      reading: kind === "delete" && c.created_by_clued && c.state === "active",
      ...(kind === "delete" ? { previewReason: !c.created_by_clued ? "picked_or_legacy_root" as const
        : c.state !== "active" ? "connection_inactive" as const : "lifecycle_unavailable" as const } : {}) };
    setDialog(next);
    if (!next.reading) return;
    operation.current = true; setBusy(true);
    const epoch = revision.current;
    const context = { owner: ownerId.current, current: () => epoch === revision.current };
    try {
      const value = await accountRequest({ action: "preview_delete", connection_id: c.id }, "/v1/storage/lifecycle", context);
      if (epoch !== revision.current) return;
      setDialog(current => current?.connection.id === c.id && current.kind === "delete"
        ? { ...current, reading: false, ...(isDeletePreview(value, c) ? { preview: value, trashRoot: !wholeRootPreview(value) }
          : { previewReason: refusedDeletePreview(value, c) }) } : current);
    } catch (error) {
      if (epoch === revision.current) setDialog(current => current?.connection.id === c.id
        ? { ...current, reading: false, previewReason: knownDeletePreviewReason(error instanceof RequestFailure
          ? error.reason === "storage_owner_lifecycle_conflict" ? "preview_version_conflict" : error.reason : undefined) } : current);
    } finally { operation.current = false; if (epoch === revision.current) setBusy(false); }
  }
  async function submitLifecycle() {
    if (operation.current || busy || !dialog || dialog.reading) return;
    const choice = dialog, c = choice.connection, epoch = revision.current;
    const context = { owner: ownerId.current, current: () => epoch === revision.current };
    if (choice.trashRoot && (!choice.preview || !isDeletePreview(choice.preview, c))) return;
    operation.current = true; setBusy(true); setDialog(null);
    try {
      const common = { connection_id: c.id, base_version: c.version, profile_version: c.profile_version,
        request_id: crypto.randomUUID() };
      const confirmation = { contract: "clued.storage-owner-confirmation/1", root_folder_id: c.root_folder_id, confirmed: true };
      const result = await accountRequest(choice.kind === "reconnect"
        ? { action: "reconnect", ...common, root_stop_generation: c.root_stop_generation,
          confirmation: { ...confirmation, contract: REFRESH_RECONNECT_CONFIRMATION,
            master_enabled: choice.masterEnabled, disclosure_version: MASTER_DISCLOSURE_VERSION,
            default_refresh: choice.defaultRefresh, refresh_disclosure_version: RECONNECT_REFRESH_DISCLOSURE_VERSION } }
        : { action: "delete", ...common, confirmation: choice.trashRoot && wholeRootPreview(choice.preview!)
          ? { contract: "clued.storage-owner-confirmation/2", root_folder_id: c.root_folder_id, confirmed: true,
            trash_created_root: true, confirmation_mode: "whole_created_root_v2" }
          : { ...confirmation, trash_created_root: choice.trashRoot,
            ...(choice.trashRoot ? { metadata_digest: choice.preview!.metadata_digest, root_version: choice.preview!.root_version } : {}) } },
        "/v1/storage/lifecycle", context);
      if (epoch !== revision.current) return;
      if (choice.kind === "reconnect") {
        if (typeof result.authorization_url !== "string") throw new Error("授权地址未确认。");
        const url = new URL(result.authorization_url);
        if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth" || url.username || url.password)
          throw new Error("授权地址未确认。");
        window.location.assign(url.href); return;
      }
      if (result.status === "completed" && typeof result.receipt_id === "string" && result.connection_id === c.id
        && result.root_trashed === choice.trashRoot) {
        const latest = await refresh();
        if (latest === undefined) return;
        setMessage(latest !== null && !latest.some(item => item.id === c.id)
          ? `连接已删除${choice.trashRoot ? "，文件夹及其中内容已移入 Google Drive 回收站" : "，Drive 文件夹已保留"}。`
          : "已取得删除回执，连接列表尚未核实。请刷新状态核对。");
      } else {
        const latest = await refresh();
        if (latest !== undefined) setMessage("删除结果尚未确认。请使用此连接的“核对上次操作结果”，不要重复删除。");
      }
    } catch {
      if (epoch === revision.current) {
        const latest = await refresh();
        if (latest !== undefined) setMessage("操作结果未确认。请先核对连接状态和上次操作结果；不要重复提交。");
      }
    } finally { operation.current = false; if (epoch === revision.current) setBusy(false); }
  }
  async function recoverLifecycle(c: Connection) {
    if (operation.current || busy || !c.pending_lifecycle) return;
    operation.current = true; setBusy(true);
    const epoch = revision.current;
    const context = { owner: ownerId.current, current: () => epoch === revision.current };
    try {
      const result = await accountRequest({ action: "recover", attempt_id: c.pending_lifecycle.attempt_id }, "/v1/storage/lifecycle", context);
      if (epoch !== revision.current) return;
      const latest = await refresh();
      if (latest !== undefined) setMessage(result.status === "completed" && typeof result.receipt_id === "string"
        ? "已核实上次操作完成。" : result.status === "cancelled"
          ? "上次操作准备已过期并取消；可以重新确认。" : result.status === "waiting"
            ? "Google 授权尚未完成。若已关闭授权页，可点击“重新打开 Google 授权”，重新确认后继续。"
            : "上次操作仍未确认。此次仅核对结果，没有再次删除文件夹或重新授权。");
    } catch { if (epoch === revision.current) setMessage("上次操作暂时无法核实，请稍后再核对；不要重复提交。"); }
    finally { operation.current = false; if (epoch === revision.current) setBusy(false); }
  }
  return <main className="mx-auto max-w-3xl px-6 py-16">
    <h1 className="text-2xl font-semibold">存储连接</h1>
    <p className="my-4">Google Drive 的授权属于当前 BeamingFace 账号。这里显示已登记范围与实际执行状态。</p>
    <p role="status" className="my-4">{message}</p>
    {connections.map(c => {
      const available = c.state === "active" && c.auth_mode === "account_policy" && c.policy_active
        && c.profile_current && c.database_execution_enabled && workerEnabled;
      const normal = normalUse[c.id], read = readAccess[c.id], write = writeAccess[c.id], master = masterAccess[c.id];
      const fullScope = master ? master.provider_scope_profile === "full" : normal?.full_scope;
      const readCurrent = normal !== undefined && read !== undefined && normal.read_generation === read.read_generation;
      const levels = write ? writeLevels(write) : [];
      const allowedWrites = write?.active ? levels.filter(level => write.classes.includes(level)) : [];
      return <section key={c.id} className="my-4 rounded-xl border p-4">
        <h2 className="font-semibold">{c.provider === "google-drive" ? "Google Drive" : c.provider} · {stateName[c.state] ?? "状态待确认"}</h2>
        <p className="my-2 font-semibold">文件夹：{folderName(c)}</p>
        <a className="underline" href={folderHref(c)} target="_blank" rel="noopener noreferrer">打开对应 Drive 文件夹</a>
        {c.state === "active" && c.auth_mode === "account_policy" && <div className="my-4 border-y py-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h3 className="font-semibold">Agent 文件操作</h3>
            <MasterAccessSwitch state={master?.state ?? "unknown"} statusId={`master-state-${c.id}`} disabled={busy}
              onToggle={enabled => void changeMasterAccess(c, enabled)} />
          </div>
          <p className="my-2 text-sm">全开包括读取、搜索、新建、纳管和全部修改权限；全关停止此连接的全部 Agent 文件操作。下方单项设置决定部分开启状态。</p>
          {master?.state === "partial" && <button disabled={busy} onClick={() => void changeMasterAccess(c, false)}>停止全部 Agent 文件操作</button>}
          {!master && <button disabled={busy} onClick={() => void loadMasterAccess(c)}>重新读取总开关状态</button>}
          {master?.reconsent_required && <p className="my-2 text-sm">全开需要重新授权 Google 的完整云端硬盘权限；授权完成并核验前，保持当前权限状态。</p>}
        </div>}
        <details className="my-3 text-sm">
          <summary className="cursor-pointer font-semibold">连接详情与执行诊断</summary>
          <p className="my-2">连接执行条件：{available ? "已满足" : "当前未满足"}。Agent 的实际权限见总开关与下方设置。</p>
          {c.physical_location.status === "verified"
            ? <p className="my-2 break-all">Drive 位置：{c.physical_location.path}</p>
            : <div className="my-2"><p>Drive 当前名称与路径暂未核实。</p>
              {registeredLocation(c) && <p className="break-all">已登记位置（未核验当前路径）：{registeredLocation(c)}</p>}</div>}
          <p className="break-all text-xs text-gray-500">文件夹标识：{c.root_folder_id}</p>
          <p className="my-2">账号授权上限：{c.policy_active && c.actions.length ? c.actions.map(action => actionName[action]).join("、") : "无当前可用授权"}。实际启用情况见下方权限设置；执行还须通过当前目录、客户端和单次任务准入。</p>
          <p className="my-2">后台续签：{c.refresh_enabled ? "开启" : "关闭"}。</p>
          {c.access_digest_missing && c.access_digest_missing.count > (c.access_digest_attention?.count ?? 0) &&
            <p className="my-2">后台正在自动核对 {c.access_digest_missing.count - (c.access_digest_attention?.count ?? 0)} 个目录的共享设置，无需操作。</p>}
        </details>
        {c.access_digest_attention && c.access_digest_attention.count > 0 && <div role="status" className="my-3 text-sm">
          <p className="font-semibold">有 {c.access_digest_attention.count} 个目录暂不写入</p>
          <p className="my-1">为防止资料被意外共享，Agent 暂不向以下目录新建或修改文件，其他目录不受影响：</p>
          <ul className="list-disc pl-6">{c.access_digest_attention.directories.map(d =>
            <li key={d.path}>{d.path || "（根目录）"}：{attentionReason[d.reason]}</li>)}</ul>
          {c.access_digest_attention.count > c.access_digest_attention.directories.length &&
            <p>另有 {c.access_digest_attention.count - c.access_digest_attention.directories.length} 个未列出。</p>}
          <p className="my-1">共享设置恢复为与上级目录一致、或目录重新出现在原位置后，会自动恢复写入。</p>
        </div>}
        {c.state === "awaiting_provider" && <label className="my-2 block">
          <input type="checkbox" disabled={busy} checked={defaultRefresh} onChange={event => setDefaultRefresh(event.target.checked)} />
          首次连接后开启后台续签（默认选中，可取消）</label>}
        {["awaiting_provider", "reauthorization_required"].includes(c.state) &&
          <button disabled={busy} onClick={() => void connect(c)}>连接／重新授权 Google</button>}
        {c.state === "active" && c.auth_mode === "account_policy" && <div className="my-2">
          <section aria-labelledby={`reading-${c.id}`} className="my-4 border-t pt-4">
            <h3 id={`reading-${c.id}`} className="font-semibold">读取与搜索</h3>
            <p role="status" className="my-2">{!master && busy ? "正在读取实际状态……" : masterReadingStatus(master)}</p>
            <p className="my-1 text-sm">本组控制所选目录内的读取与内容搜索。全部文件读取与搜索设置也包含新建图片、PDF 等文件；实际新建权限见下方写入权限。</p>
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer font-semibold">细分读取权限</summary>
              <p className="my-2">全部文件读取与搜索：{!normal || !readCurrent ? "配置未确认" : normal.normal_use ? "已配置开启" : "未配置开启"}</p>
              {normal && <button disabled={busy} onClick={() => void toggleNormalUse(c)}>{normal.normal_use ? "关闭读取与搜索" : "开启读取与搜索"}</button>}
              {(!normal || !readCurrent) && <button disabled={busy} onClick={() => void loadNormalUse(c)}>重新读取读取与搜索状态</button>}
              {normal && !normal.normal_use && normal.reconsent_required &&
                <p className="my-1">开启需要重新授权 Google（增加“查看你 Google 云端硬盘中的所有文件”）；授权完成前，现有功能照常可用。</p>}
              <p className="mt-2">Agent 查看目录结构：{read ? (read.active ? "已配置允许" : "未配置允许") : "未确认"}</p>
              {read
                ? <button disabled={busy} onClick={() => void toggleRead(c)}>{read.active ? "停止 Agent 查看目录结构" : "允许 Agent 查看目录结构"}</button>
                : <button disabled={busy} onClick={() => void loadReadAccess(c)}>读取 Agent 查看设置</button>}
              {read?.active && <>
                <p className="mt-2">Agent 读正文：{read.classes.includes("read_content")
                  ? !readCurrent ? "已配置允许；文件范围未确认" : normal?.normal_use ? "已配置允许（目录内全部文件）" : "已配置允许（仅 BeamingFace 创建的文本文件）" : "未配置允许"}</p>
                <button disabled={busy} onClick={() => void toggleRead(c, "read_content")}>
                  {read.classes.includes("read_content") ? "停止 Agent 读正文" : "允许 Agent 读正文"}</button>
              </>}
            </details>
          </section>
          <section aria-labelledby={`file-scope-${c.id}`} className="my-4 border-t pt-4">
            <h3 id={`file-scope-${c.id}`} className="font-semibold">可操作的文件范围</h3>
            <p className="my-2">修改对象：仅 BeamingFace 创建或已纳管的文件和文件夹。</p>
            {master?.state === "off" && <p className="my-1 text-sm">总开关已关闭，纳管与修改已停止；Google 授权范围保留。</p>}
            {fullScope === true ? <>
              <p className="my-1 text-sm">可纳管你拥有的已有文件和文件夹：需先允许“改名和移动文件”，再由 Agent 一次纳管一个；纳管只登记、不改动。</p>
              <p className="my-1 text-sm">Google 已授予完整云端硬盘权限；修改仍限于此目录内已纳管的对象，并受下方写入权限控制。</p>
            </> : fullScope === false ? <>
              <button disabled={busy} onClick={() => void upgradeFullScope(c)}>允许纳管已有文件</button>
              <p className="my-1 text-sm">需要重新授权 Google（增加“查看、修改、创建和删除你 Google 云端硬盘中的所有文件”）；只扩展可纳管范围，不开启任何写入操作。授权完成前，现有功能照常可用。</p>
            </> : <p className="my-1 text-sm">已有文件的纳管授权状态未确认。</p>}
          </section>
          <section aria-labelledby={`writing-${c.id}`} className="my-4 border-t pt-4">
            <h3 id={`writing-${c.id}`} className="font-semibold">写入权限</h3>
            <p role="status" className="my-2">新建文件与目录：{!master ? "状态未确认" : master.agent_enabled && master.create_enabled ? "已允许" : "已停止"}</p>
            <p role="status" className="my-2">{!master ? "总开关状态未确认；实际写入权限未确认" : master.state === "off" ? "总开关已关闭；Agent 写入已停止" : !master.agent_enabled || !master.write_enabled ? "当前执行条件未满足；Agent 写入已停止" : master.write_classes.length ? `已有文件修改：已允许 ${master.write_classes.length} / 4 项操作` : "已有文件修改已全部停止"}</p>
            <p className="my-1 text-sm">新建权限随总开关和全部文件读取与搜索设置生效；下方细项控制已有文件和文件夹的修改。</p>
            {write?.active ? <>
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer font-semibold">按操作设置写入权限</summary>
                <div className="my-2 flex flex-wrap gap-4">
                  <button disabled={busy || allowedWrites.length === levels.length} onClick={() => void setAllWrite(c, true)}>允许全部修改操作</button>
                  <button disabled={busy || allowedWrites.length === 0} onClick={() => void setAllWrite(c, false)}>停止全部修改操作</button>
                </div>
                {levels.map(level => <div key={level} className="my-2">
                  <p>Agent {writeText[level].name}：{write.classes.includes(level) ? "已配置允许" : "未配置允许"}</p>
                  <button disabled={busy} onClick={() => void toggleWrite(c, level)}>
                    {write.classes.includes(level) ? `停止 Agent ${writeText[level].name}` : `允许 Agent ${writeText[level].name}`}</button>
                </div>)}
              </details>
            </> : <button disabled={busy} onClick={() => void loadReadAccess(c)}>重新读取写入权限</button>}
            {write?.active && write.classes.includes("destructive") && <div className="mt-3 text-sm">
              <p className="font-semibold">回收站批量确认</p>
              <p>同一客户端登记在 24 小时内移入回收站超过 5 项时，Agent 会把其余项目列成一批，在这里一次确认。</p>
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
          </section>
          {normal?.refresh_token_warning && <p role="status" className="my-1 text-sm">{normal.refresh_token_blocked
            ? "该 Google 账号在 BeamingFace 中的授权次数已达上限，暂时不能通过重新授权开启读取与搜索或扩大可纳管范围；请联系维护者处理。Google 超过上限时会静默作废最早的授权；若某个连接突然需要重新授权，可能是这个原因，重新连接仍可使用。"
            : `该 Google 账号在 BeamingFace 中的授权次数已较多（${normal.refresh_token_count} 次）。Google 超过上限时会静默作废最早的授权；若某个连接突然需要重新授权，可能是这个原因。`}</p>}
          <details className="my-4 border-t pt-4 text-sm">
            <summary className="cursor-pointer font-semibold">每小时额度：{budget[c.id]
              ? `每个已授权 Agent 读取 ${formatBytes(budget[c.id].connection.read_bytes_per_hour)}、上传 ${formatBytes(budget[c.id].connection.upload_bytes_per_hour)}；` +
                `账号合计读取 ${formatBytes(budget[c.id].account.read_bytes_per_hour)}、上传 ${formatBytes(budget[c.id].account.upload_bytes_per_hour)}`
              : "未读取"}</summary>
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
          </details>
        </div>}
        {["active", "reauthorization_required"].includes(c.state) && <button disabled={busy} onClick={() => void disconnect(c)}>断开网盘连接</button>}
        {c.pending_lifecycle ? <div role="status" className="my-2">
          <p>{c.pending_lifecycle.operation === "reconnect" && c.pending_lifecycle.state === "prepared"
            ? "Google 授权尚未完成。关闭授权页后，可以重新打开并继续连接。"
            : `上次${c.pending_lifecycle.operation === "delete" ? "删除" : "重新连接"}操作尚待核对。`}</p>
          {c.pending_lifecycle.operation === "reconnect" && c.pending_lifecycle.state === "prepared"
            && c.state === "revoked" && c.root_stopped && c.root_stop_generation > 0 &&
            <button className="mr-4" disabled={busy} onClick={() => void openLifecycle(c, "reconnect")}>重新打开 Google 授权</button>}
          <button disabled={busy} onClick={() => void recoverLifecycle(c)}>核对上次操作结果</button>
        </div> : <div className="mt-3 flex gap-4">
          {c.state === "revoked" && c.root_stopped && c.root_stop_generation > 0 &&
            <button disabled={busy} onClick={() => void openLifecycle(c, "reconnect")}>重新连接这个文件夹</button>}
          <button disabled={busy} onClick={() => void openLifecycle(c, "delete")}>删除连接</button>
        </div>}
      </section>;
    })}
    {dialog && <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-6">
      <div ref={dialogElement} role="dialog" aria-modal="true" aria-labelledby="lifecycle-title"
        onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); setDialog(null); }
          if (event.key === "Tab") {
            const items = [...event.currentTarget.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), input:not(:disabled)")];
            const first = items[0], last = items[items.length - 1];
            if (event.shiftKey && event.target === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && event.target === last) { event.preventDefault(); first?.focus(); }
          }
        }} className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-xl bg-white p-6 text-gray-900">
        <h2 id="lifecycle-title" className="text-xl font-semibold">{dialog.kind === "delete" ? "删除连接" : "重新连接原文件夹"}</h2>
        <p className="my-3 font-semibold">文件夹：{dialog.preview?.root_name ?? folderName(dialog.connection)}</p>
        {dialog.connection.physical_location.status === "verified" && <p className="break-all">位置：{dialog.connection.physical_location.path}</p>}
        <a className="underline" href={folderHref(dialog.connection)} target="_blank" rel="noopener noreferrer">打开这个 Drive 文件夹核对</a>
        <p className="my-2 break-all text-sm">文件夹标识：{dialog.connection.root_folder_id}</p>
        {dialog.kind === "reconnect" ? <>
          <p className="my-3">继续使用这个文件夹和原项目，重新取得 Google 授权，不会另建同名文件夹。</p>
          <label className="block"><input type="checkbox" disabled={busy} checked={dialog.masterEnabled}
            onChange={event => { const masterEnabled = event.target.checked; setDialog(current => current ? { ...current, masterEnabled } : null); }} /> 重新连接后开启全部 Agent 文件操作（默认）</label>
          {dialog.masterEnabled && <p className="my-3 whitespace-pre-line text-sm">{renderMasterDisclosure(folderName(dialog.connection))}</p>}
          <label className="block"><input type="checkbox" disabled={busy} checked={dialog.defaultRefresh}
            onChange={event => { const defaultRefresh = event.target.checked; setDialog(current => current ? { ...current, defaultRefresh } : null); }} /> 重新连接后后台自动续签（默认选中，可随时停用）</label>
          <p className="my-3 text-sm">{RECONNECT_REFRESH_DISCLOSURE}</p>
        </> : <>
          <p className="my-3">删除后会停止此连接的文件操作和后台续签，并从连接列表移除；操作记录会保留。</p>
          {dialog.reading ? <p role="status">正在核对文件夹及其中内容……</p> : dialog.preview ? <>
            <label className="block"><input type="checkbox" disabled={busy} checked={dialog.trashRoot}
              onChange={event => { const trashRoot = event.target.checked; setDialog(current => current ? { ...current, trashRoot } : null); }} /> 同时把 BeamingFace 新建的文件夹及其中全部内容移入 Drive 回收站</label>
            {wholeRootPreview(dialog.preview) ? <>
              <p className="my-2 text-sm">刚才核对了其中 {dialog.preview.item_count} 个文件和子文件夹。勾选后，你确认回收上面标识的整个文件夹及执行时的全部内容，包括确认后新放进去的内容。</p>
              <p className="my-2 text-sm">显示的清单仅供参考；执行以这个文件夹标识为准，即使其名称、位置或内容在确认后发生变化，也会回收这个文件夹及当时其中的全部内容。</p>
              <p className="my-2 text-sm">可从 Google Drive 回收站恢复；Google 会在 30 天后自动永久删除。</p>
            </> : <p className="my-2 text-sm">已核对其中 {dialog.preview.item_count} 个文件和子文件夹，包括你后来放进去的内容。可从 Google Drive 回收站恢复；Google 会在 30 天后自动永久删除。</p>}
          </> : <p className="my-2 text-sm">{deletePreviewReasons[dialog.previewReason ?? "lifecycle_unavailable"]}</p>}
        </>}
        <div className="mt-5 flex gap-4">
          <button onClick={() => setDialog(null)}>取消</button>
          <button disabled={busy || dialog.reading} onClick={() => void submitLifecycle()}>{dialog.kind === "reconnect"
            ? "确认并前往 Google 授权" : dialog.trashRoot ? "删除连接并移入回收站" : "仅删除连接，保留文件夹"}</button>
        </div>
      </div>
    </div>}
    <div className="mt-6 flex gap-4"><button disabled={busy} onClick={() => void refresh()}>刷新状态</button>
      <Link href="/storage/onboard">新建 Google Drive 连接</Link><Link href="/storage/admin">存储管理</Link><Link href="/oauth/connections">已连接应用／客户端管理</Link></div>
  </main>;
}
