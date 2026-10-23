"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import ImprintPanel from "../imprints/ImprintPanel";
import { type Session } from "@supabase/supabase-js";
import { supabase } from "../supabase-browser";
import "./contexts.css";

type Json = Record<string, unknown>;
type Project = { id: string; name: string };
type Context = { id: string; project_id: string; name: string; environment: string; cursor: number; version: number; created_at: string };
type Listing = { projects: Project[]; contexts: Context[] };
type Creation = { op: "context_create"; project_id: string; name: string; environment: string; idempotency_key: string };
const API = "/v1/development/owner";
const environments: Record<string, string> = { test: "测试环境", preview: "预览环境", production: "生产环境" };
const object = (value: unknown): value is Json => typeof value === "object" && value !== null;
function validContext(value: unknown): value is Context {
  return object(value) && typeof value.id === "string" && typeof value.project_id === "string" && typeof value.name === "string"
    && typeof value.environment === "string" && Object.hasOwn(environments, value.environment)
    && Number.isSafeInteger(value.cursor) && Number.isSafeInteger(value.version)
    && typeof value.created_at === "string" && Number.isFinite(Date.parse(value.created_at));
}
function validListing(value: unknown): value is Listing {
  return object(value) && value.status === "ok" && Array.isArray(value.projects)
    && value.projects.every(row => object(row) && typeof row.id === "string" && typeof row.name === "string")
    && Array.isArray(value.contexts) && value.contexts.every(validContext);
}
class RequestFailure extends Error { constructor(message: string, readonly uncertain = false) { super(message); } }
async function request(who: Session, signal: AbortSignal, input: Json): Promise<unknown> {
  const response = await fetch(API, { method: "POST", credentials: "same-origin", cache: "no-store", signal,
    headers: { Authorization: "Bearer " + who.access_token, "Content-Type": "application/json" }, body: JSON.stringify(input) });
  let value: unknown;
  try { value = await response.json(); } catch { throw new RequestFailure("服务返回了不完整的结果，请核对原操作。", true); }
  if (!response.ok) throw new RequestFailure(response.status === 401 ? "登录已失效，请重新登录。"
    : response.status === 403 ? "当前账户无权管理此上下文。" : "请求未完成，请重新读取后重试。", response.status >= 500);
  return value;
}
const pendingKey = (subject: string) => "clued.pending-development-context:" + subject;
function restoreCreation(subject: string): Creation | null {
  try {
    const raw = window.sessionStorage.getItem(pendingKey(subject));
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (object(value) && value.op === "context_create" && typeof value.project_id === "string" && typeof value.name === "string"
      && typeof value.environment === "string" && Object.hasOwn(environments, value.environment) && typeof value.idempotency_key === "string") return value as Creation;
  } catch { /* An unavailable store cannot restore an operation. */ }
  return null;
}
function preserveCreation(subject: string, input: Creation) {
  try { window.sessionStorage.setItem(pendingKey(subject), JSON.stringify(input)); }
  catch { throw new RequestFailure("浏览器无法保留待确认操作，尚未创建上下文。请允许此站点使用会话存储后重试。"); }
}
function forgetCreation(subject: string) {
  try { window.sessionStorage.removeItem(pendingKey(subject)); } catch { /* Replaying a stale entry cannot create another context. */ }
}

export default function ContextsPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [listing, setListing] = useState<Listing | null>(null);
  const [listingOwner, setListingOwner] = useState("");
  const [selectedContextId, setSelectedContextId] = useState("");
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [hasPending, setHasPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [projectId, setProjectId] = useState("");
  const [name, setName] = useState("");
  const [environment, setEnvironment] = useState("test");
  const currentSession = useRef<Session | null>(null);
  const epoch = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const writeController = useRef<AbortController | null>(null);
  const pending = useRef<Creation | null>(null);

  const read = useCallback(async (who: Session, generation: number): Promise<Listing | null> => {
    readController.current?.abort();
    const controller = new AbortController(); readController.current = controller;
    setLoading(true); setError("");
    try {
      const value = await request(who, controller.signal, { op: "owner_list" });
      if (!validListing(value)) throw new RequestFailure("服务返回了不完整的上下文列表。", true);
      if (epoch.current !== generation || controller.signal.aborted) return null;
      setListing(value);
      setListingOwner(JSON.stringify([who.user.id, who.access_token]));
      setSelectedContextId(previous => value.contexts.some(context => context.id === previous) ? previous : "");
      setProjectId(previous => value.projects.some(project => project.id === previous) ? previous : "");
      return value;
    } catch (failure) {
      if (epoch.current === generation && !controller.signal.aborted) setError(failure instanceof RequestFailure ? failure.message : "暂时无法读取上下文。");
      return null;
    } finally { if (epoch.current === generation && !controller.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    const lifetime = epoch;
    let disposed = false, first = true;
    let timer: number | undefined;
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      if (disposed) return;
      const changed = first || currentSession.current?.user.id !== next?.user.id
        || currentSession.current?.access_token !== next?.access_token;
      first = false; currentSession.current = next; setSession(next); setReady(true);
      if (!changed) return;
      const generation = ++epoch.current;
      readController.current?.abort(); writeController.current?.abort(); writeController.current = null;
      window.clearTimeout(timer);
      pending.current = next ? restoreCreation(next.user.id) : null;
      setHasPending(Boolean(pending.current)); setListing(null); setListingOwner(""); setSelectedContextId("");
      setProjectId(""); setName(""); setEnvironment("test");
      setWorking(false); setError(""); setNotice(""); setLoading(Boolean(next));
      if (next) timer = window.setTimeout(() => { void read(next, generation); }, 0);
    });
    return () => { disposed = true; ++lifetime.current; window.clearTimeout(timer); readController.current?.abort(); writeController.current?.abort(); data.subscription.unsubscribe(); };
  }, [read]);

  async function create(event?: FormEvent) {
    event?.preventDefault();
    const who = currentSession.current;
    if (!who || writeController.current || loading) return;
    const recovering = Boolean(pending.current);
    const input: Creation = pending.current || { op: "context_create", project_id: projectId, name: name.trim(), environment, idempotency_key: crypto.randomUUID() };
    if (!pending.current && (!input.name || !listing?.projects.some(project => project.id === input.project_id) || !Object.hasOwn(environments, input.environment))) return;
    const generation = epoch.current;
    const controller = new AbortController(); writeController.current = controller;
    setWorking(true); setError(""); setNotice("");
    let submitted = false;
    try {
      preserveCreation(who.user.id, input);
      pending.current = input; setHasPending(true); submitted = true;
      const result = await request(who, controller.signal, input);
      if (epoch.current !== generation || controller.signal.aborted) return;
      if (!object(result) || result.status !== "committed" || !validContext(result.result)
        || result.result.project_id !== input.project_id || result.result.name !== input.name || result.result.environment !== input.environment) {
        throw new RequestFailure("创建结果尚未确认，请核对原操作。", true);
      }
      const refreshed = await read(currentSession.current || who, generation);
      if (epoch.current !== generation || controller.signal.aborted) return;
      if (!refreshed?.contexts.some(row => row.id === (result.result as Context).id && row.project_id === input.project_id
        && row.name === input.name && row.environment === input.environment)) throw new RequestFailure("尚未从最新列表确认创建结果，请核对原操作。", true);
      forgetCreation(who.user.id); pending.current = null; setHasPending(false); setName(""); setNotice("已创建上下文。");
    } catch (failure) {
      if (epoch.current !== generation || controller.signal.aborted) return;
      if (failure instanceof RequestFailure && !failure.uncertain && !recovering) {
        forgetCreation(who.user.id); pending.current = null; setHasPending(false);
        setError(failure.message);
      } else setError(submitted ? "创建结果尚未确认。请核对原操作，系统会沿用同一请求，避免重复创建。" : "尚未创建上下文，请稍后重试。");
    } finally {
      if (epoch.current === generation && !controller.signal.aborted) { writeController.current = null; setWorking(false); }
    }
  }
  async function signOut() {
    ++epoch.current; readController.current?.abort(); writeController.current?.abort(); writeController.current = null;
    currentSession.current = null; pending.current = null; setSession(null); setListing(null); setProjectId(""); setName("");
    setHasPending(false); setWorking(false); setLoading(false); setNotice(""); setError("");
    try {
      const result = await supabase.auth.signOut();
      if (result.error && !currentSession.current) setError("退出尚未确认，请重新加载页面后检查登录状态。");
    } catch { if (!currentSession.current) setError("退出尚未确认，请重新加载页面后检查登录状态。"); }
  }
  const busy = loading || working;
  const visibleListing = session && listingOwner === JSON.stringify([session.user.id, session.access_token]) ? listing : null;
  const selectedContext = visibleListing?.contexts.find(context => context.id === selectedContextId);
  return <main className="context-page">
    <header><Link href="/">BeamingFace / 账号</Link><Link href="/oauth/connections">客户端连接</Link></header>
    <h1>上下文</h1>
    <p className="context-muted">为已有项目建立独立的记录空间，再通过已授权的 AI 客户端读取、保存或反馈上下文记录。</p>
    {!ready ? <p role="status">正在读取登录状态…</p> : !session ? <p><Link href="/">登录 BeamingFace</Link> 后查看和创建自己的上下文。</p> : <>
      <p>已登录 {session.user.email || session.user.id} <button type="button" onClick={() => void signOut()}>退出</button></p>
      <button type="button" disabled={busy} onClick={() => currentSession.current && void read(currentSession.current, epoch.current)}>刷新上下文</button>
      {loading && <p role="status">正在读取上下文…</p>}
      {hasPending && <section aria-label="待确认创建"><p>有一次创建尚未确认，请先核对原操作。</p><button type="button" disabled={busy} onClick={() => void create()}>核对原操作</button></section>}
      {visibleListing && <>
        <section aria-label="已有上下文"><h2>我的上下文</h2>
          {!visibleListing.contexts.length ? <p>尚未创建上下文。</p> : visibleListing.contexts.map(context => <article key={context.id}>
            <h3>{context.name}</h3><p>{visibleListing.projects.find(project => project.id === context.project_id)?.name || "已有项目"} · {environments[context.environment]}</p>
            <button type="button" onClick={() => setSelectedContextId(context.id)} aria-pressed={selectedContextId === context.id}>浏览此上下文印记</button>
          </article>)}
        </section>
        {selectedContext && session && <ImprintPanel key={`${session.user.id}:${selectedContext.id}`}
          session={session} locale="zh-CN" developmentContextId={selectedContext.id} developmentContextName={selectedContext.name}
          projects={visibleListing.projects.filter(project => project.id === selectedContext.project_id)} />}
        <section aria-label="创建上下文"><h2>创建上下文</h2>
          {!visibleListing.projects.length ? <p>当前账户尚无自己拥有的项目，请先在 BeamingFace 中创建项目。</p> : <form onSubmit={create}>
            <label>所属项目<select required disabled={busy || hasPending} value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">选择已有项目</option>{visibleListing.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
            <label>上下文名称<input required maxLength={120} disabled={busy || hasPending} value={name} onChange={event => setName(event.target.value)} /></label>
            <label>环境<select disabled={busy || hasPending} value={environment} onChange={event => setEnvironment(event.target.value)}>{Object.entries(environments).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <button type="submit" disabled={busy || hasPending || !projectId || !name.trim()}>创建上下文</button>
          </form>}
        </section>
      </>}
      <p><Link href="/oauth/projects">开发项目资格与邀请</Link> · <Link href="/oauth/connections">管理客户端权限</Link></p>
    </>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </main>;
}
