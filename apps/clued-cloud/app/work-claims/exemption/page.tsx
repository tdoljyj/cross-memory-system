"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { type Session } from "@supabase/supabase-js";
import { supabase } from "../../supabase-browser";
import "../../contexts/contexts.css";

// Owner exemption from the per-Task Work Claim cap (Owner Decision d16b5bfc):
// step 1 issues a single-use confirmation over the view, step 2 grants exactly
// that view. Both RPCs run as this signed-in account session; the database
// refuses Bindings and delegated OAuth tokens, so an Agent cannot exempt its
// own Task. The page never holds or forwards a Binding token.
type Json = Record<string, unknown>;
type Issued = { confirmation_token: string; view_digest: string; expires_at: string; view: Json; status: Json };
type Granted = { exemption_id: string; expires_at: string; extra_claims: number };
const object = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE = /^(global|project:[0-9a-fA-F-]{36})$/;
const MESSAGES: Record<string, string> = {
  reauthentication_required: "为安全起见，豁免前 15 分钟内需要重新登录。请退出后重新登录，再从第一步开始。",
  confirmation_token_session_id_required: "当前登录缺少会话信息，请退出后重新登录。",
  direct_human_session_required: "需要你本人直接登录 Clued，授权给应用的登录不能批准豁免。",
  work_claim_task_unavailable: "找不到这个任务，或它不在所选范围内、已不是进行中的任务。",
  work_claim_exemption_reason_required: "请填写豁免理由（1–500 字）。",
  confirmation_token_expired: "确认已超过 5 分钟有效期，请从第一步重新生成预览。",
  confirmation_token_reused: "这次确认已经用过，请从第一步重新生成预览。",
  confirmation_token_revoked: "这次确认已被新的预览取代，请使用最新的预览。",
  confirmation_token_binding_mismatch: "确认与当前登录会话或预览内容不一致，请从第一步重新开始。",
  confirmation_view_stale: "任务在两步之间被修改过，请从第一步重新生成预览。",
};
class RequestFailure extends Error { constructor(message: string, readonly uncertain = false) { super(message); } }

async function rpc(name: string, input: Json): Promise<Json> {
  let result: { data: unknown; error: { message?: string; code?: string } | null };
  try {
    result = await supabase.rpc(name, { p_input: input });
  } catch { throw new RequestFailure("网络请求未完成，结果未知。", true); }
  if (result.error) {
    const code = result.error.message ?? "";
    if (MESSAGES[code]) throw new RequestFailure(MESSAGES[code]);
    // No code from the database means the request may not have arrived.
    throw new RequestFailure(result.error.code ? "请求被拒绝（" + code + "）。" : "网络请求未完成，结果未知。",
      !result.error.code);
  }
  const value = result.data;
  if (!object(value)) throw new RequestFailure("服务返回了无法识别的结果，结果未知。", true);
  if (value.status === "rejected" || value.status === "failed") {
    const code = typeof value.error_code === "string" ? value.error_code : String(value.status);
    throw new RequestFailure(MESSAGES[code] ?? "请求被拒绝（" + code + "）。", value.status === "failed");
  }
  return value;
}

export default function WorkClaimExemptionPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [taskId, setTaskId] = useState("");
  const [scope, setScope] = useState("global");
  const [reason, setReason] = useState("");
  const [issued, setIssued] = useState<Issued | null>(null);
  const [pending, setPending] = useState<Issued | null>(null);
  const [granted, setGranted] = useState<Granted | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const current = useRef<Session | null>(null);
  const epoch = useRef(0);

  useEffect(() => {
    // A link may name the Task: /work-claims/exemption?task=<id>&scope=<scope>
    const query = new URLSearchParams(window.location.search);
    const task = query.get("task");
    const linkScope = query.get("scope");
    if (task && TASK_ID.test(task)) setTaskId(task.toLowerCase());
    if (linkScope && SCOPE.test(linkScope)) setScope(linkScope);
    const lifetime = epoch;
    let disposed = false;
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      if (disposed) return;
      const changed = current.current?.user.id !== next?.user.id;
      current.current = next; setSession(next); setReady(true);
      if (!changed) return;
      ++epoch.current;
      setIssued(null); setPending(null); setGranted(null); setError(""); setWorking(false);
    });
    return () => { disposed = true; ++lifetime.current; data.subscription.unsubscribe(); };
  }, []);

  const formValid = TASK_ID.test(taskId.trim()) && SCOPE.test(scope.trim())
    && reason.trim().length > 0 && reason.trim().length <= 500;
  const editing = !issued && !pending && !granted;

  async function preview(event: FormEvent) {
    event.preventDefault();
    if (!current.current || working || !formValid) return;
    const generation = epoch.current;
    setWorking(true); setError("");
    try {
      const value = await rpc("clued_work_claim_exemption_confirmation_issue_v1",
        { task_id: taskId.trim().toLowerCase(), scope: scope.trim(), reason: reason.trim() });
      if (epoch.current !== generation) return;
      if (value.status !== "issued" || typeof value.confirmation_token !== "string" || typeof value.view_digest !== "string"
        || typeof value.expires_at !== "string" || !object(value.confirmation_view)) {
        throw new RequestFailure("预览结果不完整，请重新生成。");
      }
      setIssued({ confirmation_token: value.confirmation_token, view_digest: value.view_digest,
        expires_at: value.expires_at, view: value.confirmation_view,
        status: object(value.task_status) ? value.task_status : {} });
    } catch (failure) {
      if (epoch.current === generation) setError(failure instanceof RequestFailure ? failure.message : "暂时无法生成预览。");
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  // Step 2 is safe to repeat with the same token: a grant that already
  // committed is returned again, never granted twice.
  async function confirm(retry?: Issued) {
    const target = retry ?? issued;
    if (!current.current || working || !target) return;
    const generation = epoch.current;
    setWorking(true); setError(""); setPending(target); setIssued(null);
    try {
      const value = await rpc("clued_work_claim_exemption_grant_v1",
        { confirmation_token: target.confirmation_token, view_digest: target.view_digest });
      if (epoch.current !== generation) return;
      const exemption = object(value.exemption) ? value.exemption : {};
      if (value.status !== "committed" || typeof exemption.exemption_id !== "string" || typeof exemption.expires_at !== "string") {
        throw new RequestFailure("豁免结果尚未确认，请核对原操作。", true);
      }
      setGranted({ exemption_id: exemption.exemption_id, expires_at: exemption.expires_at,
        extra_claims: Number(exemption.extra_claims) });
      setPending(null);
    } catch (failure) {
      if (epoch.current !== generation) return;
      if (failure instanceof RequestFailure && !failure.uncertain) setPending(null);
      setError(failure instanceof RequestFailure && !failure.uncertain ? failure.message
        : "豁免结果尚未确认。请点“核对原操作”，系统会沿用同一确认，不会重复豁免。");
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  function restart() { setIssued(null); setPending(null); setGranted(null); setError(""); }
  async function signOut() {
    ++epoch.current; current.current = null; setSession(null); restart();
    try { await supabase.auth.signOut(); } catch { setError("退出尚未确认，请重新加载页面后检查登录状态。"); }
  }

  return <main className="context-page">
    <header><Link href="/">Clued / 账号</Link></header>
    <h1>任务领取豁免</h1>
    <p className="context-muted">一个任务 24 小时内最多领取 10 次。豁免让一个任务在批准后 24 小时内再领取 5 次，只能由你本人登录批准：先生成预览，核对无误后再确认。</p>
    {!ready ? <p role="status">正在读取登录状态…</p> : !session ? <p><Link href="/">登录 Clued</Link> 后批准豁免。</p> : <>
      <p>已登录 {session.user.email || session.user.id} <button type="button" onClick={() => void signOut()}>退出</button></p>
      {editing && <form onSubmit={preview} aria-label="豁免内容">
        <label>任务 ID<input required maxLength={36} disabled={working} value={taskId} onChange={event => setTaskId(event.target.value)} /></label>
        <label>范围（global 或 project:项目 ID）<input required maxLength={44} disabled={working} value={scope} onChange={event => setScope(event.target.value)} /></label>
        <label>理由<textarea required maxLength={500} disabled={working} value={reason} onChange={event => setReason(event.target.value)} /></label>
        <button type="submit" disabled={working || !formValid}>第一步：生成确认预览</button>
      </form>}
      {issued && <section aria-label="确认预览"><h2>请核对后确认</h2>
        <p>任务：{String(issued.view.task_title ?? "")}（{String(issued.view.task_id ?? "")}）</p>
        <p>过去 24 小时已领取 {String(issued.status.claims_last_24h ?? "?")} 次，上限 {String(issued.status.max_claims_per_task_24h ?? "?")} 次。</p>
        <p>批准后：再允许领取 {String(issued.view.extra_claims ?? "")} 次，{String(issued.view.valid_hours ?? "")} 小时内有效。</p>
        <p>理由：{String(issued.view.reason ?? "")}</p>
        <p>预览有效期至 {new Date(issued.expires_at).toLocaleTimeString()}。</p>
        <button type="button" disabled={working} onClick={() => void confirm()}>第二步：确认豁免</button>
        <button type="button" disabled={working} onClick={restart}>返回修改</button>
      </section>}
      {pending && !working && <section aria-label="待核对豁免"><p>有一次豁免结果尚未确认。</p>
        <button type="button" onClick={() => void confirm(pending)}>核对原操作</button></section>}
      {granted && <section aria-label="已豁免" role="status"><h2>豁免已生效</h2>
        <p>可再领取 {granted.extra_claims} 次，有效期至 {new Date(granted.expires_at).toLocaleString()}。</p>
        <p>豁免 ID：{granted.exemption_id}</p>
        <button type="button" onClick={restart}>再批准一个</button></section>}
    </>}
    {error && <p role="alert">{error}</p>}
  </main>;
}
