"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { type Session } from "@supabase/supabase-js";
import { supabase } from "../../supabase-browser";
import "../../contexts/contexts.css";

// Multi-copy mode, a "race" (GenericWorkClaim §5.3): the Owner lets several
// Agents work on one Task at once. Step 1 issues a single-use confirmation
// over the exact view (Task, copies, shared resources); step 2 turns the race
// on for exactly that view. Both RPCs run as this signed-in account session;
// the database refuses Bindings and delegated OAuth tokens, so an Agent cannot
// start a race itself. The page never holds or forwards a Binding token.
type Json = Record<string, unknown>;
type Issued = { confirmation_token: string; view_digest: string; expires_at: string; view: Json;
  suggested_copies: number | null; max_copies: number | null };
type Race = { task_id: string; copies: number; shared_resources: string[]; enabled_at: string };
const object = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE = /^(global|project:[0-9a-fA-F-]{36})$/;
const MAX_COPIES = 8;
const MESSAGES: Record<string, string> = {
  reauthentication_required: "为安全起见，开启前 15 分钟内需要重新登录。请退出后重新登录，再从第一步开始。",
  confirmation_token_session_id_required: "当前登录缺少会话信息，请退出后重新登录。",
  direct_human_session_required: "需要你本人直接登录 BeamingFace，授权给应用的登录不能开启多份模式。",
  work_claim_task_invalid: "任务 ID 格式不对。",
  work_claim_task_unavailable: "找不到这个任务，或它不在所选范围内、已不是进行中的任务。",
  work_claim_multi_copies_invalid: "份数需在 2 到 " + MAX_COPIES + " 之间。",
  work_claim_multi_shared_invalid: "请填写 1–50 个共享资源，每行一个。",
  work_claim_multi_task_busy: "这个任务正被领取中。请等现有领取结束或释放后再开启。",
  work_claim_multi_already_set: "这个任务已经开过多份模式，每个任务只能开一次。",
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

const lines = (text: string) => text.split("\n").map(line => line.trim()).filter(Boolean);
// A link may name the Task: /work-claims/race?task=<id>&scope=<scope>. Read
// once as initial state; the form only renders after the session is known, so
// the server render never shows these values.
function linked(name: string, pattern: RegExp) {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get(name);
  return value && pattern.test(value) ? value : null;
}

export default function WorkClaimRacePage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [taskId, setTaskId] = useState(() => linked("task", TASK_ID)?.toLowerCase() ?? "");
  const [scope, setScope] = useState(() => linked("scope", SCOPE) ?? "global");
  const [copies, setCopies] = useState("2");
  const [shared, setShared] = useState("");
  const [issued, setIssued] = useState<Issued | null>(null);
  const [pending, setPending] = useState<Issued | null>(null);
  const [race, setRace] = useState<Race | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const current = useRef<Session | null>(null);
  const epoch = useRef(0);

  useEffect(() => {
    const lifetime = epoch;
    let disposed = false;
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      if (disposed) return;
      const changed = current.current?.user.id !== next?.user.id;
      current.current = next; setSession(next); setReady(true);
      if (!changed) return;
      ++epoch.current;
      setIssued(null); setPending(null); setRace(null); setError(""); setWorking(false);
    });
    return () => { disposed = true; ++lifetime.current; data.subscription.unsubscribe(); };
  }, []);

  const copyCount = /^\d+$/.test(copies.trim()) ? Number(copies.trim()) : NaN;
  const sharedList = lines(shared);
  const formValid = TASK_ID.test(taskId.trim()) && SCOPE.test(scope.trim())
    && copyCount >= 2 && copyCount <= MAX_COPIES
    && sharedList.length >= 1 && sharedList.length <= 50 && sharedList.every(item => item.length <= 400 && !/\s/.test(item));
  const editing = !issued && !pending && !race;

  async function preview(event: FormEvent) {
    event.preventDefault();
    if (!current.current || working || !formValid) return;
    const generation = epoch.current;
    setWorking(true); setError("");
    try {
      const value = await rpc("clued_work_claim_multi_confirmation_issue_v1",
        { task_id: taskId.trim().toLowerCase(), scope: scope.trim(), copies: copyCount, shared_resources: sharedList });
      if (epoch.current !== generation) return;
      if (value.status !== "issued" || typeof value.confirmation_token !== "string" || typeof value.view_digest !== "string"
        || typeof value.expires_at !== "string" || !object(value.confirmation_view)) {
        throw new RequestFailure("预览结果不完整，请重新生成。");
      }
      setIssued({ confirmation_token: value.confirmation_token, view_digest: value.view_digest,
        expires_at: value.expires_at, view: value.confirmation_view,
        suggested_copies: typeof value.suggested_copies === "number" ? value.suggested_copies : null,
        max_copies: typeof value.max_copies === "number" ? value.max_copies : null });
    } catch (failure) {
      if (epoch.current === generation) setError(failure instanceof RequestFailure ? failure.message : "暂时无法生成预览。");
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  // Step 2 is safe to repeat with the same token: a race that already
  // committed is returned again, never recorded twice.
  async function confirm(retry?: Issued) {
    const target = retry ?? issued;
    if (!current.current || working || !target) return;
    const generation = epoch.current;
    setWorking(true); setError(""); setPending(target); setIssued(null);
    try {
      const value = await rpc("clued_work_claim_multi_enable_v1",
        { confirmation_token: target.confirmation_token, view_digest: target.view_digest });
      if (epoch.current !== generation) return;
      const enabled = object(value.race) ? value.race : {};
      if (value.status !== "committed" || typeof enabled.task_id !== "string" || typeof enabled.enabled_at !== "string") {
        throw new RequestFailure("开启结果尚未确认，请核对原操作。", true);
      }
      setRace({ task_id: enabled.task_id, copies: Number(enabled.copies),
        shared_resources: Array.isArray(enabled.shared_resources) ? enabled.shared_resources.map(String) : [],
        enabled_at: enabled.enabled_at });
      setPending(null);
    } catch (failure) {
      if (epoch.current !== generation) return;
      if (failure instanceof RequestFailure && !failure.uncertain) setPending(null);
      setError(failure instanceof RequestFailure && !failure.uncertain ? failure.message
        : "开启结果尚未确认。请点“核对原操作”，系统会沿用同一确认，不会重复开启。");
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  function restart() { setIssued(null); setPending(null); setRace(null); setError(""); }
  async function signOut() {
    ++epoch.current; current.current = null; setSession(null); restart();
    try { await supabase.auth.signOut(); } catch { setError("退出尚未确认，请重新加载页面后检查登录状态。"); }
  }

  const viewShared = issued && Array.isArray(issued.view.shared_resources) ? issued.view.shared_resources.map(String) : [];
  return <main className="context-page">
    <header><Link href="/">BeamingFace</Link> <Link href="/grants">我的授权</Link></header>
    <h1>多份模式（赛马）</h1>
    <p className="context-muted">让几个 Agent 同时做同一个任务，各自领取一份、互不冲突。谁的结果先写回共享资源（或先合并 PR），就采用谁的，其余各份随即作废。每个任务只能开启一次，只能由你本人登录开启：先生成预览，核对无误后再确认。</p>
    {!ready ? <p role="status">正在读取登录状态…</p> : !session ? <p><Link href="/">登录 BeamingFace</Link> 后开启多份模式。</p> : <>
      <p>已登录 {session.user.email || session.user.id} <button type="button" onClick={() => void signOut()}>退出</button></p>
      {editing && <form onSubmit={preview} aria-label="多份模式内容">
        <label>任务 ID<input required maxLength={36} disabled={working} value={taskId} onChange={event => setTaskId(event.target.value)} /></label>
        <label>范围（global 或 project:项目 ID）<input required maxLength={44} disabled={working} value={scope} onChange={event => setScope(event.target.value)} /></label>
        <label>份数（2–{MAX_COPIES}）<input required inputMode="numeric" maxLength={2} disabled={working} value={copies} onChange={event => setCopies(event.target.value)} /></label>
        <label>共享资源（每行一个：仓库路径或通配，或 storage:、repo:、record: 开头的资源）<textarea required disabled={working} value={shared} onChange={event => setShared(event.target.value)} /></label>
        <button type="submit" disabled={working || !formValid}>第一步：生成确认预览</button>
      </form>}
      {issued && <section aria-label="确认预览"><h2>请核对后确认</h2>
        <p>任务：{String(issued.view.task_title ?? "")}（{String(issued.view.task_id ?? "")}）</p>
        <p>范围：{String(issued.view.scope ?? "")}</p>
        <p>份数：{String(issued.view.copies ?? "")}{issued.suggested_copies !== null && <>（建议 {issued.suggested_copies} 份：过去 7 天连接过 BeamingFace 的不同 Agent 数，至少 2；上限 {issued.max_copies ?? MAX_COPIES}）</>}</p>
        <p>共享资源：</p>
        <ul>{viewShared.map(item => <li key={item}><code>{item}</code></li>)}</ul>
        <p>开启后：每份领取都消耗任务的领取额度；第一份写回上述资源或合并 PR 的被采用，其余作废。</p>
        <p>预览有效期至 {new Date(issued.expires_at).toLocaleTimeString()}。</p>
        <button type="button" disabled={working} onClick={() => void confirm()}>第二步：确认开启</button>
        <button type="button" disabled={working} onClick={restart}>返回修改</button>
      </section>}
      {pending && !working && <section aria-label="待核对开启"><p>有一次开启结果尚未确认。</p>
        <button type="button" onClick={() => void confirm(pending)}>核对原操作</button></section>}
      {race && <section aria-label="已开启" role="status"><h2>多份模式已开启</h2>
        <p>任务 {race.task_id}：最多 {race.copies} 份同时进行，开启于 {new Date(race.enabled_at).toLocaleString()}。</p>
        <p>共享资源：{race.shared_resources.join("、")}</p>
        <p>各 Agent 照常领取这个任务即可，每份会自动分到一个编号。</p>
        <button type="button" onClick={restart}>再开启一个</button></section>}
    </>}
    {error && <p role="alert">{error}</p>}
  </main>;
}
