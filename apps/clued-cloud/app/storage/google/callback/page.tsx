"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "../../../supabase-browser";

const isProfile = (value: unknown): value is "legacy" | "normal" | "full" =>
  value === "legacy" || value === "normal" || value === "full";
const isMasterState = (value: unknown): value is "on" | "off" | "partial" => value === "on" || value === "off" || value === "partial";
// One in-memory delivery across React remounts. Never persist the Google code,
// state or provider credentials in browser storage; never feed it to Clued auth.
type Delivery = { receipt: string; owner: string; refreshEnabled?: boolean; recovery?: boolean; originalReceipt?: string; originalUnconfirmed?: boolean;
  scopeProfile?: "legacy" | "normal" | "full"; requestedProfile?: "legacy" | "normal" | "full"; normalUse?: boolean; onboard?: boolean;
  masterState?: "on" | "off" | "partial" };
function masterResultText(result: Delivery) {
  if (result.masterState === "on" && result.scopeProfile === "full") return "。全部 Agent 文件操作已开启";
  if (result.masterState === "off") return "。全部 Agent 文件操作已停止";
  if (result.masterState === "partial") return "。Agent 文件操作部分开启，请返回连接页核对实际权限";
  return result.masterState === "on" || result.requestedProfile === "full" ? "。全部 Agent 文件操作尚未确认，请返回连接页核对总开关" : "";
}
let delivery: Promise<Delivery> | undefined;
class CallbackFailure extends Error {}
const reasons: Record<string, string> = {
  callback_invalid: "Google 回调参数未通过校验",
  attempt_unavailable: "原授权会话未能确认，请检查登录、有效期与尝试状态",
  verifier_unavailable: "服务端无法解密原授权校验信息",
  token_exchange_unconfirmed: "Google 授权码兑换未确认，不能重复兑换这一个授权码",
  token_invalid_client: "Google 拒绝了服务端应用凭据，请由维护者核对客户端配置，暂勿重新授权",
  token_invalid_grant: "Google 拒绝了本次授权码或校验信息，请由维护者排查；不能重复兑换这个授权码",
  token_unauthorized_client: "Google 未允许这个客户端执行授权码兑换，请由维护者核对应用配置",
  token_invalid_request: "Google 未接受服务端兑换请求格式，请由维护者排查",
  token_unsupported_grant_type: "Google 未接受服务端兑换类型，请由维护者排查",
  token_http_rejected: "Google 拒绝了凭据兑换请求，尚未确认具体类别，请由维护者排查",
  token_response_unreadable: "已收到兑换响应但无法安全解析，不能重复兑换这个授权码",
  token_transport_unconfirmed: "服务端未确认 Google 兑换响应，不能重复兑换这个授权码",
  token_response_invalid: "Google 返回的凭据格式未通过校验",
  refresh_token_missing: "Google 未返回有效的离线续签凭据",
  scope_mismatch: "Google 返回的权限范围与批准的两项权限不一致",
  provider_identity_unconfirmed: "Google 云盘账号身份未通过校验",
  root_metadata_unavailable: "无法读取已登记根目录的文件信息",
  root_identity_mismatch: "根目录身份、类型或回收状态与登记不一致",
  root_not_authorized: "尚未将已登记根目录授权给这个 Google 应用",
  root_not_writable: "当前 Google 账号不能在已登记根目录中新建对象",
  root_parent_mismatch: "根目录的父目录与登记不一致",
  token_lifetime_insufficient: "取得的 Google 凭据剩余有效期不足",
  credential_seal_unavailable: "服务端凭据加密未完成",
  credential_commit_unconfirmed: "凭据保存回执未确认，请先返回连接页核对状态，不要重复授权",
  storage_root_busy: "该目录还有尚未完成的文件操作，稍后再试；原有授权保持不变",
  refresh_token_limit: "该 Google 账号在 BeamingFace 中的授权次数已达上限，暂时不能通过重新授权开启正常使用；原有授权保持不变，请联系维护者处理",
  // StorageNormalUse N0 page-only labels (§5.3); retry from the new-connection page.
  root_shared_drive: "所选目录在共享云端硬盘中，自助接入只支持“我的云端硬盘”里的目录",
  root_not_owned: "所选目录不属于你的 Google 账号，请选择你自己的目录",
  root_overlaps_existing: "所选目录与已连接的资料根相同、在其中或包含它",
  root_name_changed: "所选目录的名称已变化，请返回新建连接页重新选择并确认",
  onboard_track_name_conflict: "所选目录下已有与子目录同名的文件夹，请返回新建连接页修改子目录名称",
  onboard_effect_ambiguous: "Drive 中找到多个本次接入创建的同名对象，请联系维护者",
  root_multiple_parents: "所选目录有多个上级目录，不支持作为资料根",
  root_ancestry_unavailable: "暂时无法核对目录的上级关系，可在新建连接页重试",
  onboard_effect_unconfirmed: "Drive 目录创建结果未确认，可在新建连接页重试，不会重复创建",
  activation_unconfirmed: "连接启用未确认，可在新建连接页核对并重试，不会重复创建目录",
  onboard_expired: "本次接入已超过 30 分钟，请重新开始",
  onboard_run_active: "这次接入仍在处理中，请几分钟后在新建连接页刷新状态",
  onboard_run_superseded: "这次接入已由另一次重试接管，请在新建连接页核对状态",
};
async function settleOriginal(state: string, token: string, owner: string, receipt: string): Promise<Delivery> {
  const current = await supabase.auth.getSession();
  if (current.error || current.data.session?.user.id !== owner) throw new CallbackFailure("登录账号已变化，请返回连接页重新读取状态。");
  const headers = { "content-type": "application/json", authorization: "Bearer " + token };
  const post = async (path: string, body: object) => {
    const sameOwner = await supabase.auth.getSession();
    if (sameOwner.error || sameOwner.data.session?.user.id !== owner) throw new CallbackFailure("登录账号已变化，请返回连接页重新读取状态。");
    const response = await fetch(path, { method: "POST", headers, body: JSON.stringify(body), cache: "no-store",
      redirect: "error", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(15000) }).catch(() => null);
    return (response?.ok ? await response.json().catch(() => null) : null) as Record<string, unknown> | null;
  };
  const target = await post("/v1/storage/google/recovery/auto-target", { state });
  if (target?.status === "manual") return { receipt, owner, recovery: true }; // Consent began before automatic settlement was offered.
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (target?.status !== "ready" || target.execution_permitted !== false ||
    typeof target.connection_id !== "string" || !uuid.test(target.connection_id) ||
    typeof target.job_id !== "string" || !uuid.test(target.job_id))
    return { receipt, owner, recovery: true, originalUnconfirmed: true };
  const reference = { connection_id: target.connection_id, job_id: target.job_id };
  const settled = await post("/v1/storage/recovery", { action: "settle", ...reference });
  if (settled?.status === "committed" && settled.job_id === reference.job_id &&
    settled.execution_permitted === false && typeof settled.receipt_id === "string" && uuid.test(settled.receipt_id))
    return { receipt, owner, recovery: true, originalReceipt: settled.receipt_id };
  // One read of the original job resolves a lost settlement reply. Never
  // repeat the metadata comparison or the Google authorization-code exchange.
  const inspected = await post("/v1/storage/recovery", { action: "inspect", ...reference });
  if (inspected?.status === "committed" && inspected.job_id === reference.job_id && inspected.connection_id === reference.connection_id &&
    inspected.execution_permitted === false && typeof inspected.receipt_id === "string" && uuid.test(inspected.receipt_id))
    return { receipt, owner, recovery: true, originalReceipt: inspected.receipt_id };
  return { receipt, owner, recovery: true, originalUnconfirmed: true };
}
function finish(): Promise<Delivery> {
  if (delivery) return delivery;
  const query = new URL(window.location.href).searchParams;
  const state = query.get("state"), code = query.get("code");
  const invalid = query.has("error") || query.getAll("state").length !== 1 || query.getAll("code").length !== 1;
  window.history.replaceState(null, "", "/storage/google/callback");
  delivery = (async () => {
    if (invalid || !state || !code) throw new CallbackFailure("Google 授权未完成，请返回连接页检查。");
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session) throw new CallbackFailure("请使用开始授权时的 BeamingFace 登录会话，返回连接页检查。");
    const response = await fetch("/v1/storage/google/complete", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + data.session.access_token },
      body: JSON.stringify({ state, code }), cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(15000),
    }).catch(() => null);
    const body: unknown = await response?.json().catch(() => null);
    const result = body as { status?: unknown; receipt_id?: unknown; refresh_enabled?: unknown; purpose?: unknown;
      provider_scope_profile?: unknown; requested_scope_profile?: unknown; normal_use_enabled?: unknown; master_state?: unknown } | null;
    if (!response?.ok || result?.status !== "completed" || typeof result.receipt_id !== "string") {
      // Render only our fixed allowlist, never raw server/Google error text.
      const reason = body && typeof body === "object" && "reason" in body ? body.reason : null;
      // Every unconfirmed delivery (including 200 with a truncated body) gets
      // one bounded read, never a repeat of complete or the authorization code.
      // State stays in this in-memory closure only; a remount reuses delivery.
      try {
        const current = await supabase.auth.getSession();
        if (!current.error && current.data.session?.user.id === data.session.user.id) {
          const inspected = await fetch("/v1/storage/google/recovery/inspect", {
            method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + data.session.access_token },
            body: JSON.stringify({ state }), cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(10000),
          });
          const receipt = (inspected.ok ? await inspected.json() : null) as { status?: unknown; execution_permitted?: unknown; receipt_id?: unknown } | null;
          if (receipt?.status === "completed" && receipt.execution_permitted === false && typeof receipt.receipt_id === "string")
            return await settleOriginal(state, data.session.access_token, data.session.user.id, receipt.receipt_id);
        }
      } catch { /* Unknown remains unknown; never exchange the code twice. */ }
      const message = typeof reason === "string" && Object.hasOwn(reasons, reason) ? reasons[reason] : "连接未确认，请返回连接页检查状态";
      throw new CallbackFailure(message + "。请核对连接状态和原回执；不会自动重试或放宽权限。");
    }
    if (result.purpose === "credential_recovery")
      return await settleOriginal(state, data.session.access_token, data.session.user.id, result.receipt_id);
    if (result.purpose === "onboard") return { receipt: result.receipt_id, owner: data.session.user.id, onboard: true,
      ...(typeof result.refresh_enabled === "boolean" ? { refreshEnabled: result.refresh_enabled } : {}),
      ...(isProfile(result.provider_scope_profile) ? { scopeProfile: result.provider_scope_profile } : {}),
      ...(isProfile(result.requested_scope_profile) ? { requestedProfile: result.requested_scope_profile } : {}),
      ...(isMasterState(result.master_state) ? { masterState: result.master_state } : {}),
      ...(typeof result.normal_use_enabled === "boolean" ? { normalUse: result.normal_use_enabled } : {}) };
    return { receipt: result.receipt_id, owner: data.session.user.id,
      ...(typeof result.refresh_enabled === "boolean" ? { refreshEnabled: result.refresh_enabled } : {}),
      ...(isProfile(result.provider_scope_profile) ? { scopeProfile: result.provider_scope_profile } : {}),
      ...(isProfile(result.requested_scope_profile) ? { requestedProfile: result.requested_scope_profile } : {}),
      ...(isMasterState(result.master_state) ? { masterState: result.master_state } : {}),
      ...(typeof result.normal_use_enabled === "boolean" ? { normalUse: result.normal_use_enabled } : {}) };
  })();
  return delivery;
}

export default function StorageGoogleCallback() {
  const [message, setMessage] = useState("正在核对 Google 连接，请勿重复授权……");
  useEffect(() => {
    let active = true, changed = false, observed: string | null | undefined;
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      const owner = session?.user.id ?? null;
      if (owner === null || (observed !== undefined && observed !== owner)) {
        changed = true;
        if (active) setMessage("登录账号已变化，请返回连接页重新读取状态。");
      }
      observed = owner;
    });
    void finish().then(async result => {
      const current = await supabase.auth.getSession();
      if (!active || changed || current.error || current.data.session?.user.id !== result.owner) return;
      const masterText = masterResultText(result);
      if (result.onboard) {
        setMessage("Google Drive 连接已建立，资料根目录已登记。回执：" + result.receipt +
          (masterText || (result.normalUse === true ? "。正常使用已开启" : result.scopeProfile === "legacy" && result.requestedProfile === "normal"
            ? "。未授予“查看你 Google 云端硬盘中的所有文件”，正常使用未开启，Agent 可查看目录结构" : "。Agent 可查看目录结构")) +
          (result.refreshEnabled === true ? "。后台自动续期已开启" : "。后台自动续期未开启：连接约 1 小时后读写都不可用") +
          "。客户端仍须通过存储资格审核后才能使用。");
      } else if (result.recovery) {
        setMessage("恢复凭据已安全保存。回执：" + result.receipt +
          (result.originalReceipt ? "。原任务结果已自动核验并登记。回执：" + result.originalReceipt :
            result.originalUnconfirmed ? "。原任务结果尚未确认，请查询原任务回执；不会自动重试或重新授权" :
              "。本次授权沿用旧的凭据恢复流程，请返回查询原任务") +
          "。连接停用状态、Agent 权限和后台续签设置未改变；没有重新创建文件。");
      } else {
        // Legacy scope upgrades retain their narrower result. A master result
        // claims all permissions only with an explicit ON and real full scope.
        const legacyScopeText = result.requestedProfile === "full" ? (result.scopeProfile === "full" ? "。已允许管理已有文件（完整云端硬盘权限）"
          : "。未授予“查看、修改、创建和删除你 Google 云端硬盘中的所有文件”，管理已有文件未允许" +
            (result.scopeProfile === "legacy" ? "；也未授予“查看你 Google 云端硬盘中的所有文件”，正常使用不可用" : "")) : "";
        const legacyReadText = result.scopeProfile === "legacy" && (result.requestedProfile === "normal" || result.normalUse !== undefined)
          ? "。未授予“查看你 Google 云端硬盘中的所有文件”，正常使用未开启"
          : result.normalUse === true ? "。正常使用已开启" : result.normalUse === false ? "。正常使用未自动开启，请返回连接页开启" : "";
        setMessage("连接凭据已安全保存。回执：" + result.receipt +
          (typeof result.refreshEnabled === "boolean" ? (result.refreshEnabled ? "。后台续签已开启" : "。后台续签保持关闭") : "") +
          (result.masterState ? masterText : legacyScopeText + legacyReadText + masterText) +
          "。执行仍须通过目录和客户端检查。");
      }
    }, error => { if (active && !changed) setMessage(error instanceof CallbackFailure ? error.message : "连接尚未确认，请返回连接页检查状态和原回执。"); });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, []);
  return <main className="mx-auto max-w-2xl px-6 py-16"><h1 className="text-2xl font-semibold">Google 连接</h1>
    <p className="my-6" role="status">{message}</p><Link href="/storage/connections">返回存储连接</Link></main>;
}
