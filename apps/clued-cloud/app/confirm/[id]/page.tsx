"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { type Session } from "@supabase/supabase-js";
import { supabase } from "../../supabase-browser";
import "../../contexts/contexts.css";
import "../owner.css";

// Owner Credential v0.1 §4-§5: the Owner's confirmation page for one Agent
// request, opened from the direct link /confirm/<request_id>. What is approved
// is rendered by Clued from structured fields; the Agent's note is shown apart
// and marked unverified. Approval is the Native two-step confirmation: the page
// issues a single-use token over the exact view it shows (bound to this signed-in
// session), and "批准" commits exactly that view. All RPCs run as this account
// session; the database refuses Bindings and delegated OAuth tokens.
// For "grant for a while" each requested resource is a row the Owner can untick
// (narrow) or widen to a parent Clued offers (Decision c4e82dee); "" is unticked.
// The page opens on the choice Clued sets by the action's risk (Decision b7053465).
// A connection.permission request (Decision 43ba00e2) is approved once, for the
// requesting connection only: the page names each context and action and
// what the connection already has, and approval adds them to that connection.
// A bundle (PermissionSimplification §3.3, Task 23045c17) is several requests
// the Agent or the release door opened together, for example a production
// migration and the deploy of the same commit. The page shows every pending
// member and "批准" approves all of them: each still gets its own two-step
// confirmation over its own view, with the same choice; scope rows are not
// offered for a bundle.
type Json = Record<string, unknown>;
type Choice = "once" | "grant";
type Options = { choice: Choice; seconds: number; anyAgent: boolean; scope: string[] };
type ScopeRow = { resource: string; options: string[] };
type Issued = { confirmation_token: string; view_digest: string; expires_at: string; view: Json; options: Options };
type Member = { id: string; issued: Issued | null };
const object = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DURATIONS: [number, string][] = [[3600, "1 小时"], [14400, "4 小时"], [86400, "24 小时"], [604800, "7 天"]];
// A token this close to expiry is refreshed before use.
const REFRESH_MS = 20_000;
const MESSAGES: Record<string, string> = {
  confirmation_token_session_id_required: "当前登录缺少会话信息，请退出后重新登录。",
  direct_human_session_required: "需要你本人直接登录 Clued，授权给应用的登录不能批准请求。",
  owner_request_not_found: "找不到这个请求，或它不属于当前登录的账号。",
  owner_request_id_invalid: "链接里的请求编号无效。",
  owner_request_decided: "这个请求已经处理过了。",
  owner_request_expired: "这个请求已超过 24 小时，已失效。请让 Agent 重新发起。",
  owner_grant_duration_invalid: "授权时长须在 1 分钟到 7 天之间。",
  owner_grant_resources_not_offered: "所选范围不在可选项里，请刷新页面后重选。",
  owner_grant_resources_invalid: "至少要保留一项范围。",
  confirmation_token_expired: "确认已超过 5 分钟有效期，请刷新页面后重试。",
  confirmation_token_reused: "这次确认已经用过，请刷新页面后重试。",
  confirmation_token_revoked: "确认已被更新的选择取代，请按页面当前内容操作。",
  confirmation_token_binding_mismatch: "确认与当前登录会话或页面内容不一致，请刷新页面后重试。",
  confirmation_view_stale: "请求在你查看后发生了变化，请刷新页面后重新核对。",
};
const STATUS: Record<string, string> = {
  approved_once: "已批准（只这一次）", granted: "已授权一段时间", rejected: "已拒绝", expired: "已过期", pending: "等待你确认",
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

function issueInput(requestId: string, options: Options, rows: ScopeRow[]): Json {
  const grantee = options.anyAgent ? "any_agent" : "requester";
  if (options.choice === "once") return { request_id: requestId, choice: "once", grantee };
  const input: Json = { request_id: requestId, choice: "grant", expires_seconds: options.seconds, grantee };
  // Sent only when the Owner changed the scope; otherwise Clued keeps the request's.
  if (options.scope.some((chosen, index) => chosen !== rows[index]?.resource)) input.resources = options.scope.filter(Boolean);
  return input;
}
function scopeRows(value: unknown): ScopeRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter(object).map(row => ({ resource: String(row.resource ?? ""), options: list(row.options) }))
    .filter(row => row.resource && row.options.includes(row.resource));
}
function durationText(seconds: number) {
  const known = DURATIONS.find(([value]) => value === seconds);
  if (known) return known[1];
  return seconds % 3600 === 0 ? seconds / 3600 + " 小时" : Math.round(seconds / 60) + " 分钟";
}
const list = (value: unknown) => Array.isArray(value) ? value.map(String) : [];
// The other members of this request's bundle, as listed by Clued.
function bundleOthers(request: Json, id: string): Json[] {
  return Array.isArray(request.bundle) ? request.bundle.filter(object)
    .filter(member => typeof member.request_id === "string" && REQUEST_ID.test(member.request_id) && member.request_id !== id) : [];
}
const PERMISSION_ACTION = "connection.permission";
const ACTION_LABELS: Record<string, string> = { read: "读取", write: "新增和修改", close: "关闭和归档", restore: "恢复", audit: "查看审计回执" };
const CONTEXT_LABELS: Record<string, string> = { global: "个人记忆", profile: "个人资料" };
function permissionText(context: string, name: unknown, action: string) {
  const label = typeof name === "string" && name ? name : CONTEXT_LABELS[context] ?? context;
  return label + " → 正式记忆 → " + (ACTION_LABELS[action] ?? action);
}
function currentText(row: Json) {
  const id = String(row.resource_id ?? "");
  const where = row.resource_kind === "scope" ? CONTEXT_LABELS[id] ?? id : id;
  return where + "：" + list(row.actions).map(action => ACTION_LABELS[action] ?? action).join("、");
}

export default function OwnerConfirmPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const params = useParams<{ id: string }>();
  const rawId = typeof params?.id === "string" ? params.id : "";
  const requestId = REQUEST_ID.test(rawId) ? rawId.toLowerCase() : null;
  const [request, setRequest] = useState<Json | null>(null);
  const [options, setOptions] = useState<Options>({ choice: "grant", seconds: 14400, anyAgent: false, scope: [] });
  const [rows, setRows] = useState<ScopeRow[]>([]);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [pending, setPending] = useState<Issued | null>(null);
  const [done, setDone] = useState<{ kind: "granted" | "rejected"; grant?: Json; count?: number } | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
      setRequest(null); setIssued(null); setPending(null); setDone(null); setError(""); setWorking(false); setRows([]); setMembers([]);
    });
    return () => { disposed = true; ++lifetime.current; data.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!session || !requestId) return;
    void load(requestId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id, requestId]);

  async function load(id: string) {
    const generation = epoch.current;
    setWorking(true); setError("");
    try {
      const value = await rpc("clued_owner_request_view_v1", { request_id: id });
      if (epoch.current !== generation) return;
      if (!object(value.request)) throw new RequestFailure("请求内容不完整，请刷新页面。");
      setRequest(value.request);
      const view = object(value.view) ? value.view : {};
      // Clued picks the default choice by the action's risk (Decision b7053465);
      // a server without default_choice keeps "grant" and the view's duration.
      const seconds = Number(value.suggested_expires_seconds ?? view.expires_seconds);
      const others = bundleOthers(value.request, id).filter(member => member.status === "pending");
      const offered = others.length ? [] : scopeRows(value.resource_options);
      const initial: Options = { choice: value.default_choice === "once" ? "once" : "grant",
        seconds: Number.isInteger(seconds) && seconds >= 60 ? seconds : 14400,
        anyAgent: false, scope: offered.map(row => row.resource) };
      setRows(offered); setOptions(initial);
      const next: Member[] = others.map(member => ({ id: String(member.request_id), issued: null }));
      setMembers(next);
      if (value.request.status === "pending") {
        await issue(id, initial, generation, offered);
        await issueMembers(next, initial, generation);
      }
    } catch (failure) {
      if (epoch.current === generation) setError(failure instanceof RequestFailure ? failure.message : "暂时无法读取请求。");
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  // Step 1: a token over exactly the view these options produce. A newer
  // issue revokes the older token, so only what is on screen can be approved.
  async function issue(id: string, next: Options, generation: number, offered = rows): Promise<Issued | null> {
    const value = await rpc("clued_owner_grant_confirmation_issue_v1", issueInput(id, next, offered));
    if (epoch.current !== generation) return null;
    if (value.status !== "issued" || typeof value.confirmation_token !== "string" || typeof value.view_digest !== "string"
      || typeof value.expires_at !== "string" || !object(value.confirmation_view)) {
      throw new RequestFailure("确认内容不完整，请刷新页面。");
    }
    const result = { confirmation_token: value.confirmation_token, view_digest: value.view_digest,
      expires_at: value.expires_at, view: value.confirmation_view, options: next };
    setIssued(result);
    return result;
  }

  // The same choice for every other pending member of the bundle.
  async function issueMembers(list: Member[], next: Options, generation: number): Promise<Member[] | null> {
    const result: Member[] = [];
    for (const member of list) {
      const value = await rpc("clued_owner_grant_confirmation_issue_v1", issueInput(member.id, next, []));
      if (epoch.current !== generation) return null;
      if (value.status !== "issued" || typeof value.confirmation_token !== "string" || typeof value.view_digest !== "string"
        || typeof value.expires_at !== "string" || !object(value.confirmation_view)) {
        throw new RequestFailure("确认内容不完整，请刷新页面。");
      }
      result.push({ id: member.id, issued: { confirmation_token: value.confirmation_token, view_digest: value.view_digest,
        expires_at: value.expires_at, view: value.confirmation_view, options: next } });
    }
    setMembers(current => current.map(member => result.find(item => item.id === member.id) ?? member));
    return result;
  }

  async function choose(next: Options) {
    if (!requestId || working || !current.current) return;
    const generation = epoch.current;
    setOptions(next); setIssued(null); setMembers(members.map(member => ({ id: member.id, issued: null })));
    setWorking(true); setError("");
    try { await issue(requestId, next, generation); await issueMembers(members, next, generation); } catch (failure) {
      if (epoch.current === generation) setError(failure instanceof RequestFailure ? failure.message : "暂时无法生成确认。");
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  // Step 2. A token about to expire is reissued for the same options first; it
  // is used only if Clued renders the identical view, otherwise the new view is
  // shown for another look. Repeating with the same token is safe: a grant that
  // already committed is returned again, never granted twice.
  // One handler for every scope row: data-index names the row; a checkbox
  // keeps (the requested resource) or unticks it, a select picks an option.
  function pickScope(event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    const target = event.currentTarget;
    const index = Number(target.dataset.index);
    const row = rows[index];
    if (!row) return;
    const chosen = target.type === "checkbox" ? ((target as HTMLInputElement).checked ? row.resource : "") : target.value;
    void choose({ ...options, scope: options.scope.map((value, at) => at === index ? chosen : value) });
  }

  async function approve(retry?: Issued) {
    let target = retry ?? issued;
    if (!requestId || !current.current || working || !target) return;
    const generation = epoch.current;
    setWorking(true); setError("");
    try {
      if (!retry && Date.parse(target.expires_at) - Date.now() < REFRESH_MS) {
        const shown = target.view_digest;
        const fresh = await issue(requestId, target.options, generation);
        if (!fresh) return;
        if (fresh.view_digest !== shown) throw new RequestFailure("请求内容有变化，请核对后再点批准。");
        target = fresh;
      }
      setPending(target); setIssued(null);
      const value = await rpc("clued_owner_grant_v1", { confirmation_token: target.confirmation_token, view_digest: target.view_digest });
      if (epoch.current !== generation) return;
      if (value.status !== "committed" || !object(value.grant) || typeof value.grant.grant_id !== "string") {
        throw new RequestFailure("批准结果尚未确认，请核对原操作。", true);
      }
      setPending(null);
      const count = await approveMembers(target.options, generation);
      if (count === null) return;
      setDone({ kind: "granted", grant: value.grant, count: count + 1 });
    } catch (failure) {
      if (epoch.current !== generation) return;
      const uncertain = !(failure instanceof RequestFailure) || failure.uncertain;
      if (!uncertain) setPending(null);
      setError(uncertain ? "批准结果尚未确认。请点“核对原操作”，系统会沿用同一确认，不会重复批准。" : failure.message);
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  // After the request on the page: every other member, each over its own
  // view. A member whose token is about to expire is reissued first and used
  // only if Clued renders the identical view.
  async function approveMembers(chosen: Options, generation: number): Promise<number | null> {
    let count = 0;
    for (const member of members) {
      const stop = (reason: string) => new RequestFailure("前 " + (count + 1) + " 项已批准，第 " + (count + 2) + " 项未完成："
        + reason + "请刷新页面核对剩下的。");
      let target = member.issued;
      if (!target) throw stop("确认还没生成。");
      if (Date.parse(target.expires_at) - Date.now() < REFRESH_MS) {
        const fresh = await issueMembers([member], chosen, generation);
        if (!fresh) return null;
        if (fresh[0].issued?.view_digest !== target.view_digest || !fresh[0].issued) throw stop("内容有变化。");
        target = fresh[0].issued;
      }
      try {
        const value = await rpc("clued_owner_grant_v1", { confirmation_token: target.confirmation_token, view_digest: target.view_digest });
        if (epoch.current !== generation) return null;
        if (value.status !== "committed") throw new RequestFailure("批准结果尚未确认。");
      } catch (failure) {
        throw stop(failure instanceof RequestFailure ? failure.message : "批准结果尚未确认。");
      }
      count++;
    }
    return count;
  }

  async function reject() {
    if (!requestId || !current.current || working) return;
    const generation = epoch.current;
    setWorking(true); setError("");
    try {
      await rpc("clued_owner_request_reject_v1", { request_id: requestId });
      for (const member of members) await rpc("clued_owner_request_reject_v1", { request_id: member.id });
      if (epoch.current !== generation) return;
      setIssued(null); setDone({ kind: "rejected" });
    } catch (failure) {
      if (epoch.current === generation) setError(failure instanceof RequestFailure ? failure.message : "暂时无法拒绝，请稍后重试。");
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  async function signIn(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setWorking(true); setError("");
    try {
      const { error: failure } = await supabase.auth.signInWithPassword({ email, password });
      if (failure) setError("登录失败，请检查邮箱和密码。");
    } catch { setError("登录请求未完成，请重试。"); } finally { setWorking(false); }
  }

  async function signOut() {
    ++epoch.current; current.current = null; setSession(null);
    setRequest(null); setIssued(null); setPending(null); setDone(null); setError(""); setMembers([]);
    try { await supabase.auth.signOut(); } catch { setError("退出尚未确认，请重新加载页面后检查登录状态。"); }
  }

  const view = issued?.view ?? null;
  const status = request ? String(request.status ?? "") : "";
  const viewRequest = view && object(view.request) ? view.request : null;
  const note = viewRequest && typeof viewRequest.agent_note_unverified === "string" ? viewRequest.agent_note_unverified : "";
  // Re-review 9: a note the admission check wrote (repo.protected_change) is
  // not an Agent's claim; it names the pull request and links its compare view.
  const admissionNote = Boolean(viewRequest && viewRequest.note_source === "ci-admission");
  const compareLink = admissionNote ? (/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}/.exec(note)?.[0] ?? "") : "";
  const grantee = view && object(view.grantee) ? view.grantee : null;
  const task = view && object(view.task) ? view.task : null;
  const kept = options.scope.filter(Boolean).length;
  const permission = request?.action === PERMISSION_ACTION;
  const connection = view && object(view.connection) ? view.connection : null;
  const permissions = view && Array.isArray(view.permissions) ? view.permissions.filter(object) : [];
  const existing = connection && Array.isArray(connection.current) ? connection.current.filter(object) : [];
  const leftover = request && status !== "pending" ? bundleOthers(request, requestId ?? "").filter(member => member.status === "pending") : [];

  return <main className="context-page owner-confirm">
    <header><Link href="/">Clued</Link><Link href="/grants">我的授权</Link></header>
    <h1>确认 Agent 的请求</h1>
    {!requestId ? <p role="alert">链接无效：缺少请求编号。请让 Agent 重新发送链接。</p>
      : !ready ? <p role="status">正在读取登录状态…</p>
      : !session ? <section aria-label="登录"><p>请先登录 Clued，再确认这个请求。</p>
        <form onSubmit={signIn}>
          <label>邮箱<input type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} /></label>
          <label>密码<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label>
          <div className="owner-actions"><button type="submit" disabled={working}>登录</button></div>
        </form>
        <p className="context-muted">也可以先在 <Link href="/">Clued 首页</Link> 登录，再重新打开这个链接。</p></section>
      : <>
        <p className="context-muted">已登录 {session.user.email || session.user.id} <button type="button" onClick={() => void signOut()}>退出</button></p>
        {done?.kind === "granted" && permission && <section aria-label="已批准" role="status"><h2>已批准</h2>
          <p>权限已加到这个连接上。Agent 重试刚才被拒的操作即可，不用重新连接。</p>
          <p>可以在 <Link href="/oauth/connections">连接管理</Link> 随时收窄或撤销这个连接的权限。</p></section>}
        {done?.kind === "granted" && !permission && <section aria-label="已批准" role="status"><h2>已批准</h2>
          {(done.count ?? 1) > 1 && <p>同一批 {done.count} 项都已批准，每项各自生成一个授权。</p>}
          <p>{done.grant?.max_uses === 1 ? "只允许这一次" : "授权已生效"}，有效期至 {new Date(String(done.grant?.expires_at)).toLocaleString()}。</p>
          <p>Agent 重试时会自动用上这次批准。可以在 <Link href="/grants">我的授权</Link> 随时撤销。</p></section>}
        {done?.kind === "rejected" && <section aria-label="已拒绝" role="status"><h2>已拒绝</h2><p>Agent 不会得到这次授权。</p></section>}
        {!done && request && status !== "pending" && <section aria-label="请求状态"><h2>{STATUS[status] ?? status}</h2>
          <p>这个请求已不需要处理。{status === "expired" ? "如仍需要，请让 Agent 重新发起。" : ""}</p>
          {leftover.length > 0 && <><p>同一批还有 {leftover.length} 项等你确认：</p><ul>{leftover.map(member =>
            <li key={String(member.request_id)}><Link href={"/confirm/" + String(member.request_id)}>{String(member.action ?? "")}</Link></li>)}</ul></>}</section>}
        {!done && status === "pending" && <>
          {!permission && <section aria-label="选择" className="owner-choice"><h2>怎么批</h2>
            <div className="context-row">
              <button type="button" aria-pressed={options.choice === "once"} disabled={working}
                onClick={() => void choose({ ...options, choice: "once" })}>只批这一次</button>
              <button type="button" aria-pressed={options.choice === "grant"} disabled={working}
                onClick={() => void choose({ ...options, choice: "grant" })}>这一类管一段时间</button>
            </div>
            {options.choice === "grant" && <label>时长
              <select value={String(options.seconds)} disabled={working}
                onChange={event => void choose({ ...options, seconds: Number(event.target.value) })}>
                {(DURATIONS.some(([value]) => value === options.seconds) ? DURATIONS : [...DURATIONS, [options.seconds, durationText(options.seconds)] as [number, string]])
                  .map(([value, label]) => <option key={value} value={String(value)}>{label}</option>)}
              </select></label>}
            <label className="owner-check"><input type="checkbox" checked={options.anyAgent} disabled={working}
              onChange={event => void choose({ ...options, anyAgent: event.target.checked })} />我的任何 Agent 都可以用（默认只给发起请求的 Agent）</label>
            {options.choice === "grant" && rows.length > 0 && <fieldset className="owner-scope" disabled={working}>
              <legend>范围（取消勾选即收窄，选上一级即放宽）</legend>
              {rows.map((row, index) => {
                const chosen = options.scope[index] ?? "";
                return <div key={row.resource} className="owner-scope-row">
                  <label className="owner-check"><input type="checkbox" checked={chosen !== ""}
                    disabled={working || (chosen !== "" && kept <= 1)}
                    data-index={index} onChange={pickScope} />
                    {row.options.length > 1 ? "" : row.resource}</label>
                  {row.options.length > 1 && <select aria-label={"范围：" + row.resource} value={chosen || row.resource}
                    disabled={working || chosen === ""} data-index={index} onChange={pickScope}>
                    {row.options.map((option, at) => <option key={option} value={option}>
                      {option}{at === 0 ? "（请求的范围）" : ""}</option>)}
                  </select>}
                </div>;
              })}
            </fieldset>}
          </section>}
          {view && permission && <section aria-label="要批准什么"><h2>要批准什么</h2>
            <p className="context-muted">以下内容由 Clued 生成，Agent 改不了。批准后权限加到这个连接上，不用重新连接。</p>
            <dl>
              <dt>给哪个连接</dt><dd>{String(connection?.client_name ?? grantee?.agent_name ?? "发起请求的连接")}</dd>
              <dt>要加的权限</dt><dd><ul>{permissions.map(item => <li key={String(item.resource)}>
                {permissionText(String(item.context ?? ""), item.context_name, String(item.action ?? ""))}</li>)}</ul></dd>
              <dt>它现在已有</dt><dd><ul>{existing.map(row => <li key={String(row.resource_kind) + ":" + String(row.resource_id)}>{currentText(row)}</li>)}</ul></dd>
              {task && <><dt>任务</dt><dd>{String(task.title ?? "")}</dd></>}
              <dt>期限</dt><dd>{connection?.expires_at ? "跟这个连接一样，到 " + new Date(String(connection.expires_at)).toLocaleString() + " 为止" : "跟这个连接一样"}</dd>
            </dl></section>}
          {view && !permission && <section aria-label="要批准什么"><h2>要批准什么</h2>
            <p className="context-muted">以下内容由 Clued 生成，Agent 改不了。</p>
            <dl>
              <dt>动作</dt><dd>{String(view.action_title ?? "")}（{String(view.action ?? "")}）</dd>
              <dt>范围</dt><dd><ul>{list(view.resources).map(resource => <li key={resource}>{resource}</li>)}</ul></dd>
              {task && <><dt>任务</dt><dd>{String(task.title ?? "")}</dd></>}
              <dt>给谁</dt><dd>{grantee?.any_agent ? "我的任何 Agent" : String(grantee?.agent_name ?? "发起请求的 Agent") + (grantee?.vendor ? "（" + String(grantee.vendor) + "）" : "")}</dd>
              <dt>期限</dt><dd>{view.choice === "once" ? "只这一次，24 小时内用掉" : durationText(Number(view.expires_seconds)) + "内有效"}</dd>
              <dt>次数</dt><dd>{view.max_uses == null ? "不限" : "最多 " + String(view.max_uses) + " 次"}</dd>
            </dl>
            {members.length > 0 && <section aria-label="同一批" className="owner-bundle">
              <h3>同一批，一起批准（共 {members.length + 1} 项）</h3>
              <p className="context-muted">点“批准全部”会把下面每一项也按上面的选择批准，每项各自生成一个授权。</p>
              {members.map(member => {
                const other = member.issued?.view;
                return <dl key={member.id}>
                  <dt>动作</dt><dd>{other ? String(other.action_title ?? "") + "（" + String(other.action ?? "") + "）" : "正在生成…"}</dd>
                  {other && <><dt>范围</dt><dd><ul>{list(other.resources).map(resource => <li key={resource}>{resource}</li>)}</ul></dd></>}
                </dl>;
              })}
            </section>}</section>}
          {note && admissionNote && <section aria-label="准入检查说明" className="owner-note"><h2>准入检查说明</h2>
            <p className="context-muted">这段话由 Clued 的准入检查根据 PR 写出，不是 Agent 自述；批准前请打开链接看这些提交改了什么。</p><p>{note}</p>
            {compareLink && <p><a href={compareLink} target="_blank" rel="noreferrer">在 GitHub 上查看这些提交的改动</a></p>}</section>}
          {note && !admissionNote && <section aria-label="Agent 说明" className="owner-note"><h2>Agent 说明（未核实）</h2>
            <p className="context-muted">这段话是 Agent 自己写的，不改变上面要批准的内容。</p><p>{note}</p></section>}
          {!pending && <div className="owner-actions">
            <button type="button" disabled={working || !issued || members.some(member => !member.issued)} onClick={() => void approve()}>
              {members.length ? "批准全部 " + (members.length + 1) + " 项" : "批准"}</button>
            <button type="button" disabled={working} onClick={() => void reject()}>拒绝</button>
          </div>}
        </>}
        {pending && !working && <section aria-label="待核对"><p>有一次批准结果尚未确认。</p>
          <div className="owner-actions"><button type="button" onClick={() => void approve(pending)}>核对原操作</button></div></section>}
        {working && <p role="status">处理中…</p>}
      </>}
    {error && <p role="alert">{error}</p>}
  </main>;
}
