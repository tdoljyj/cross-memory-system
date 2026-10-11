"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type Session } from "@supabase/supabase-js";
import { supabase } from "../supabase-browser";
import "../contexts/contexts.css";
import "../confirm/owner.css";

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
const MESSAGES: Record<string, string> = {
  direct_human_session_required: "需要你本人直接登录 Clued，授权给应用的登录不能查看任务详情。",
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

export default function TaskOwnerDetailPage() {
  const params = useSearchParams();
  const rawId = params.get("id") ?? "";
  const id = uuid(rawId) ? rawId.toLowerCase() : "";
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [detail, setDetail] = useState<BoundDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<BoundError | null>(null);
  const activeSession = useRef<Session | null>(null);
  const activeTarget = useRef(id);
  const epoch = useRef(0);
  // Hide the previous route's result during render, before effects run.
  activeTarget.current = id;

  useEffect(() => {
    let disposed = false;
    const lifetime = epoch;
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      if (disposed) return;
      const changed = activeSession.current?.user.id !== next?.user.id
        || activeSession.current?.access_token !== next?.access_token;
      activeSession.current = next; setSession(next); setReady(true);
      if (changed) { ++epoch.current; setDetail(null); setError(null); setLoading(false); }
    });
    return () => { disposed = true; ++lifetime.current; data.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    ++epoch.current;
    if (session && id) void load(session, id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id, session?.access_token, id]);

  async function load(who = activeSession.current, target = activeTarget.current) {
    if (!who || !target) return;
    const generation = ++epoch.current;
    setDetail(null); setError(null); setLoading(true);
    const applies = () => epoch.current === generation && activeTarget.current === target
      && activeSession.current?.user.id === who.user.id && activeSession.current?.access_token === who.access_token;
    try {
      const value = await request(target);
      if (applies()) setDetail({ ...value, owner: who, target, generation });
    } catch (failure) {
      if (applies()) setError({ owner: who, target, message: failure instanceof RequestFailure ? failure.message : "暂时无法读取详情。" });
    } finally { if (applies()) setLoading(false); }
  }

  async function signOut() {
    ++epoch.current; activeSession.current = null; setSession(null); setDetail(null); setError(null); setLoading(false);
    try {
      const result = await supabase.auth.signOut();
      if (result.error) throw result.error;
    } catch { setError({ owner: null, target: activeTarget.current, message: "退出请求未完成，请从主页重新核对登录状态。" }); }
  }

  const visible = detail && detail.target === id && detail.owner.user.id === session?.user.id
    && detail.owner.access_token === session?.access_token && detail.generation === epoch.current ? detail : null;
  const visibleError = error && error.target === id && error.owner?.user.id === session?.user.id
    && error.owner?.access_token === session?.access_token ? error.message : "";
  return <main className="context-page owner-confirm">
    <header><Link href="/">Clued</Link> <Link href="/work-claims">谁在做哪个任务</Link> <Link href="/grants">我的授权</Link></header>
    <h1>{visible ? kinds[visible.record.record_type] + "详情" : "任务详情"}</h1>
    <p className="context-muted">这里只读显示你名下的任务，以及关联的决定和笔记。</p>
    {!ready ? <p role="status">正在读取登录状态…</p> : !session ? <p><Link href="/">登录 Clued</Link> 后查看详情。</p> : <>
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
        <button type="button" disabled={loading} onClick={() => void load()}>刷新</button>
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
