"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "../../../supabase-browser";

// One in-memory delivery across React remounts. Never persist the Google code,
// state or provider credentials in browser storage; never feed it to Clued auth.
let delivery: Promise<{ receipt: string; owner: string }> | undefined;
class CallbackFailure extends Error {}
const reasons: Record<string, string> = {
  callback_invalid: "Google 回调参数未通过校验",
  attempt_unavailable: "原授权会话未能确认，请检查登录、有效期与尝试状态",
  verifier_unavailable: "服务端无法解密原授权校验信息",
  token_exchange_unconfirmed: "Google 授权码兑换未确认，不能重复兑换这一个授权码",
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
};
function finish(): Promise<{ receipt: string; owner: string }> {
  if (delivery) return delivery;
  const query = new URL(window.location.href).searchParams;
  const state = query.get("state"), code = query.get("code");
  const invalid = query.has("error") || query.getAll("state").length !== 1 || query.getAll("code").length !== 1;
  window.history.replaceState(null, "", "/storage/google/callback");
  delivery = (async () => {
    if (invalid || !state || !code) throw new CallbackFailure("Google 授权未完成，请返回连接页检查。");
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session) throw new CallbackFailure("请使用开始授权时的 Clued 登录会话，返回连接页检查。");
    const response = await fetch("/v1/storage/google/complete", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + data.session.access_token },
      body: JSON.stringify({ state, code }), cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
    });
    if (!response.ok) {
      // Render only our fixed allowlist, never raw server/Google error text.
      const failure: unknown = await response.json().catch(() => null);
      const reason = failure && typeof failure === "object" && "reason" in failure ? failure.reason : null;
      const message = typeof reason === "string" && Object.hasOwn(reasons, reason) ? reasons[reason] : "连接未确认，请返回连接页检查状态";
      throw new CallbackFailure(message + "。此操作不会开启文件写入；不会自动重试或放宽权限。");
    }
    const result = await response.json() as { status?: unknown; receipt_id?: unknown } | null;
    if (result?.status !== "completed" || typeof result.receipt_id !== "string") throw new CallbackFailure("尚未取得确认回执，请返回连接页检查状态。");
    return { receipt: result.receipt_id, owner: data.session.user.id };
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
      if (active && !changed && !current.error && current.data.session?.user.id === result.owner)
        setMessage("连接凭据已安全保存。回执：" + result.receipt + "。文件操作仍需独立授权与执行验收。");
    }, error => { if (active && !changed) setMessage(error instanceof CallbackFailure ? error.message : "连接尚未确认，请返回连接页检查状态。正式写入不会因此开启。"); });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, []);
  return <main className="mx-auto max-w-2xl px-6 py-16"><h1 className="text-2xl font-semibold">Google 连接</h1>
    <p className="my-6" role="status">{message}</p><Link href="/storage/connections">返回存储连接</Link></main>;
}
