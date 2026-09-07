"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { type Session } from "@supabase/supabase-js";
import { supabase } from "../supabase-browser";
import { ContextSession, localDraft } from "./context-session";
import "./contexts.css";

type Item = Record<string, unknown>;
const text = (value: unknown) => typeof value === "string" ? value : "";
const objects = (value: unknown): Item[] => Array.isArray(value) ? value.filter(v => v && typeof v === "object") : [];

export default function ContextsPage() {
  const gate = useRef(new ContextSession());
  const retries = useRef(new Map<string, string>());
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState("ordinary");
  const [token, setToken] = useState("");
  const [contextId, setContextId] = useState("");
  const [environment, setEnvironment] = useState("test");
  const [contexts, setContexts] = useState<Item[]>([]);
  const [projects, setProjects] = useState<Item[]>([]);
  const [bindings, setBindings] = useState<Item[]>([]);
  const [grants, setGrants] = useState<Item[]>([]);
  const [packageData, setPackageData] = useState<Item | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [bindingId, setBindingId] = useState("");
  const [grantId, setGrantId] = useState("");
  const [grantVersion, setGrantVersion] = useState(1);
  const [history, setHistory] = useState("EXISTING_ONLY");
  const [versionPolicy, setVersionPolicy] = useState("FIXED_AT_GRANT");
  const [grantDays, setGrantDays] = useState(7);
  const grantExpiry = useRef(new Map<string, string>());
  const [actions, setActions] = useState("read");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [record, setRecord] = useState<Item | null>(null);
  const [acceptance, setAcceptance] = useState<Item | null>(null);
  const [current, setCurrent] = useState("");
  const [publicationId, setPublicationId] = useState("");
  const [publicationVersion, setPublicationVersion] = useState(1);
  const [feedback, setFeedback] = useState("");

  const clearPrivate = useCallback(() => {
    retries.current.clear();
    gate.current.reset(); setPackageData(null); setRecord(null); setAcceptance(null);
    setContent(""); setTitle(""); setFeedback(""); setCurrent(""); setBusy(false);
    setPublicationId(""); setPublicationVersion(1);
  }, []);
  useEffect(() => {
    const activeGate = gate.current;
    const { data } = supabase.auth.onAuthStateChange((event, next) => {
      if (event !== "TOKEN_REFRESHED") {
        clearPrivate(); grantExpiry.current.clear(); setToken(""); setContexts([]); setContextId("");
        setProjects([]); setBindings([]); setGrants([]); setProjectId(""); setBindingId(""); setGrantId(""); setGrantVersion(1); setName("");
      }
      setSession(next); setReady(true);
    });
    const clear = () => clearPrivate();
    const hide = () => { if (document.visibilityState === "hidden") clear(); };
    window.addEventListener("pageshow", clear); window.addEventListener("pagehide", clear);
    document.addEventListener("visibilitychange", hide);
    return () => { data.subscription.unsubscribe(); activeGate.reset(); window.removeEventListener("pageshow", clear); window.removeEventListener("pagehide", clear); document.removeEventListener("visibilitychange", hide); };
  }, [clearPrivate]);
  useEffect(() => {
    if (!packageData) return;
    const timer = setTimeout(() => { clearPrivate(); setNotice("显示已到期，请重新读取以核对最新授权。"); }, 30_000);
    return () => clearTimeout(timer);
  }, [packageData, clearPrivate]);

  async function run(input: Item, owner = false) {
    setNotice(""); setBusy(true);
    const credential = owner ? session?.access_token : token;
    if (!credential) { setNotice(owner ? "请先登录账号。" : "请输入这个会话专用的连接令牌。"); setBusy(false); return null; }
    const requestBody = { context_id: contextId || undefined, environment, mode, ...input };
    const fingerprint = JSON.stringify(requestBody);
    const mutating = input.op && !["owner_list", "context_list", "record_list", "publication_read", "feedback_list"].includes(String(input.op));
    const key = retries.current.get(fingerprint) ?? crypto.randomUUID();
    if (mutating) retries.current.set(fingerprint, key);
    try {
      const result = await gate.current.request(owner ? "/v1/contexts/owner" : "/v1/contexts", credential, {
        ...requestBody, ...(mutating ? { idempotency_key: key } : {}),
      });
      retries.current.delete(fingerprint);
      setPackageData(result); setNotice(result.status === "committed" ? "已保存，已生成回执。" : "已重新核对当前授权。");
      return result;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return null;
      setPackageData(null); setRecord(null); setAcceptance(null); setTitle(""); setContent(""); setFeedback(""); setCurrent(""); setPublicationId(""); setNotice(error instanceof Error ? error.message : "请求失败。"); return null;
    } finally { setBusy(false); }
  }
  async function loadContexts(owner = false) {
    const data = await run({ op: owner ? "owner_list" : "context_list" }, owner);
    if (data) { setContexts(objects(data.contexts)); if (owner) { setProjects(objects(data.projects)); setBindings(objects(data.bindings)); setGrants(objects(data.grants)); } }
  }
  async function saveGrant(update: boolean) {
    const key = `${contextId}/${bindingId}/${grantDays}`;
    const expires = grantExpiry.current.get(key) ?? new Date(Date.now() + grantDays * 86400_000).toISOString();
    grantExpiry.current.set(key, expires);
    const data = await run({ op: "grant_upsert", binding_id: bindingId, actions: actions.split(","), history_policy: history, version_policy: versionPolicy, expires_at: expires,
      ...(update ? { grant_id: grantId, base_version: grantVersion } : {}),
    }, true);
    const result = data?.result as Item | undefined;
    if (result) { setGrantId(text(result.id)); setGrantVersion(Number(result.version)); grantExpiry.current.delete(key); }
  }
  const payload = { title, content };

  return <main className="context-page">
    <header><Link href="/">Clued / 账号</Link><span>上下文</span></header>
    <h1>保存开发过程，按授权继续</h1>
    <p className="context-muted">开发连接可独立保存。之后登录的用户，需要获得授权并关联项目，才能读取之前的开发历史。</p>
    {!ready ? <p role="status">正在读取登录状态…</p> : !session ? <p><Link href="/">登录 Clued</Link> 后管理授权；已有独立开发连接仍可在下方使用。</p> : <p>已登录 {session.user.email} <button onClick={() => { clearPrivate(); setToken(""); void supabase.auth.signOut(); }}>退出</button></p>}
    <nav aria-label="上下文模式">{[["ordinary", "日常使用"], ["development_history", "开发历史"], ["manage", "管理授权"]].map(([id, label]) => <button key={id} aria-pressed={mode === id} onClick={() => { clearPrivate(); setToken(""); setContexts([]); setContextId(""); setMode(id); setNotice("模式已切换，请使用这个模式独立的连接。"); }}>{label}</button>)}</nav>
    <section aria-label="选择上下文">
      {mode !== "manage" && <label>当前会话的连接令牌<input type="password" autoComplete="off" value={token} onChange={e => { clearPrivate(); setContexts([]); setContextId(""); setToken(e.target.value); }} placeholder="只在此页面会话中使用" /></label>}
      <div className="context-row"><label>环境<input value={environment} onChange={e => { clearPrivate(); setEnvironment(e.target.value); }} /></label><button disabled={busy} onClick={() => void loadContexts(mode === "manage")}>读取可用上下文</button></div>
      <label>上下文<select value={contextId} onChange={e => { clearPrivate(); setContextId(e.target.value); }}><option value="">选择上下文</option>{contexts.map(c => <option key={text(c.id)} value={text(c.id)}>{text(c.name) || text(c.id)}</option>)}</select></label>
    </section>
    {mode === "manage" ? <section>
      <h2>所有者授权</h2><p className="context-muted">登录用于管理。读取和开发操作仍使用各自独立的连接，安装 Skill 不会授予权限。</p>
      <label>关联到你的项目<select value={projectId} onChange={e => setProjectId(e.target.value)}><option value="">选择已有项目</option>{projects.map(p => <option key={text(p.id)} value={text(p.id)}>{text(p.name)}</option>)}</select></label>
      <label>新上下文名称<input value={name} onChange={e => setName(e.target.value)} /></label>
      <button disabled={busy || !session || !name || !projectId} onClick={() => void run({ op: "context_create", name, project_id: projectId }, true)}>创建上下文</button>
      <hr />
      <label>授权给哪个连接<select value={bindingId} onChange={e => { setBindingId(e.target.value); setGrantId(""); setGrantVersion(1); }}><option value="">选择独立连接</option>{bindings.filter(b => !b.revoked_at).map(b => <option key={text(b.id)} value={text(b.id)}>{text(b.agent_name)} · {text(b.id).slice(0, 8)}</option>)}</select></label>
      <label>操作权限<select value={actions} onChange={e => { setActions(e.target.value); if (e.target.value.includes("write") || e.target.value.includes("publish")) { setHistory("EXISTING_AND_FUTURE"); setVersionPolicy("LATEST"); } }}><option value="read">只读历史</option><option value="read,write">读取与开发保存</option><option value="read,accept,publish">读取、接受与发布</option><option value="feedback_submit">提交反馈</option><option value="feedback_submit,feedback_manage">提交与处理反馈</option></select></label>
      <label>历史范围<select value={history} onChange={e => setHistory(e.target.value)}><option value="EXISTING_ONLY">授权时已经存在的记录</option><option value="EXISTING_AND_FUTURE">既有及未来记录</option></select></label>
      <label>版本范围<select value={versionPolicy} onChange={e => setVersionPolicy(e.target.value)}><option value="FIXED_AT_GRANT">固定为授权时版本</option><option value="LATEST">跟随获准记录的最新版本</option></select></label>
      <label>授权有效期<select value={grantDays} onChange={e => setGrantDays(Number(e.target.value))}><option value={1}>1 天</option><option value={7}>7 天</option><option value={30}>30 天</option></select></label>
      <button disabled={busy || !contextId || !bindingId} onClick={() => void saveGrant(false)}>创建授权</button>
      <label>授权 ID<input value={grantId} onChange={e => setGrantId(e.target.value)} /></label>
      <label>已有授权<select value={grantId} onChange={e => { const g = grants.find(g => g.id === e.target.value); if (g) { setGrantId(text(g.id)); setGrantVersion(Number(g.version)); setBindingId(text(g.binding_id)); setHistory(text(g.history_policy)); setVersionPolicy(text(g.version_policy)); setActions(Array.isArray(g.actions) ? g.actions.join(",") : "read"); } }}><option value="">选择要更新或撤回的授权</option>{grants.filter(g => g.context_id === contextId).map(g => <option key={text(g.id)} value={text(g.id)}>{bindings.find(b => b.id === g.binding_id)?.agent_name as string || text(g.binding_id).slice(0, 8)} · {g.revoked_at ? "已撤回" : "有效期至 " + text(g.expires_at).slice(0, 10)}</option>)}</select></label>
      <label>授权版本<input type="number" min="1" value={grantVersion} onChange={e => setGrantVersion(Number(e.target.value))} /></label>
      <button disabled={busy || !contextId || !bindingId || !grantId} onClick={() => void saveGrant(true)}>更新所选授权</button>
      <button disabled={busy || !grantId || !projectId} onClick={() => void run({ op: "link_upsert", project_id: projectId, grant_id: grantId }, true)}>把授权历史关联到项目</button>
      <button disabled={busy || !grantId} onClick={() => void run({ op: "grant_revoke", grant_id: grantId, base_version: grantVersion }, true)}>撤销这项授权</button>
    </section> : mode === "development_history" ? <section>
      <h2>开发历史</h2><p className="context-muted">此模式读取原记录和版本。批注应创建新记录并引用来源，不覆盖原文。</p>
      <button disabled={busy || !contextId} onClick={() => void run({ op: "record_list" })}>读取获准历史</button>
      <button disabled={busy || !contextId} onClick={() => void run({ op: "publication_read" })}>查看当前发布</button>
      <label>标题<input value={title} onChange={e => { setAcceptance(null); setTitle(e.target.value); }} /></label>
      <label>内容<textarea rows={7} value={content} onChange={e => { setAcceptance(null); setContent(e.target.value); }} /></label>
      <button disabled={busy || !contextId || !content} onClick={async () => { const data = await run({ op: "record_put", record_type: "note", body: payload }); setRecord((data?.result as Item) ?? null); setAcceptance(null); }}>保存为候选记录</button>
      <button onClick={() => { const blob = new Blob([JSON.stringify(localDraft(payload), null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "Clued_LOCAL_DRAFT.json"; a.click(); URL.revokeObjectURL(url); setNotice("已下载本地草稿，尚未进入 Clued。重新填写并保存后才有正式回执。"); }}>下载未同步草稿</button>
      {record && <><h3>所选记录</h3><p>版本 {String(record.version)}。修改原记录需要开发写入权限。</p><button disabled={busy} onClick={async () => { const data = await run({ op: "record_put", record_id: record.id, base_version: record.version, record_type: record.record_type, body: payload }); setRecord((data?.result as Item) ?? null); setAcceptance(null); }}>更新所选记录</button><button disabled={busy} onClick={() => void run({ op: "record_revoke", record_id: record.id, base_version: record.version, reason: "用户主动撤回" })}>撤回所选记录</button><h3>接受与发布</h3><p>发布内容就是上方当前标题与正文。接受后修改内容，需要重新接受。</p><button disabled={busy} onClick={async () => { const data = await run({ op: "accept", record_id: record.id, record_version: record.version, content_hash: record.content_hash, publication_payload: payload, audience: "authenticated_owner", channel: "canonical_api" }); setAcceptance((data?.result as Item) ?? null); }}>接受这版发布内容</button></>}
      <label>将替换的当前发布 ID（首次发布留空）<input value={current} onChange={e => setCurrent(e.target.value)} /></label>
      {acceptance && <button disabled={busy} onClick={async () => { const data = await run({ op: "publish", acceptance_id: acceptance.id, payload, audience: "authenticated_owner", channel: "canonical_api", expected_current: current || null }); const p = data?.result as Item | undefined; if (p) { setPublicationId(text(p.id)); setPublicationVersion(Number(p.version)); setNotice("已保存待交付版本。完成交付前，当前发布保持原样。"); } }}>准备已接受的发布</button>}
      <label>待交付或待撤回的发布 ID<input value={publicationId} onChange={e => setPublicationId(e.target.value)} /></label>
      <label>发布版本<input type="number" min="1" value={publicationVersion} onChange={e => setPublicationVersion(Number(e.target.value))} /></label>
      <button disabled={busy || !publicationId} onClick={async () => { const data = await run({ op: "publication_deliver", publication_id: publicationId, base_version: publicationVersion, expected_current: current || null }); const p = data?.result as Item | undefined; if (p) { setPublicationVersion(Number(p.version)); setCurrent(text(p.id)); setNotice("交付已核验，当前发布已切换。"); } }}>核验并完成交付</button>
      <button disabled={busy || !publicationId} onClick={() => void run({ op: "publication_withdraw", publication_id: publicationId, base_version: publicationVersion })}>撤回发布</button>
    </section> : <section>
      <h2>日常使用</h2><p className="context-muted">只读取已发布的产品内容；开发草稿与未接受记录不会出现在这里。</p>
      <button disabled={busy || !contextId} onClick={() => void run({ op: "publication_read" })}>读取当前发布</button>
      <label>反馈<textarea rows={3} value={feedback} onChange={e => setFeedback(e.target.value)} placeholder="只填写你希望提交给开发者的信息" /></label>
      <button disabled={busy || !contextId || !feedback} onClick={() => void run({ op: "feedback_submit", body: { content: feedback }, selected_evidence: [] })}>提交这段反馈</button>
      <button disabled={busy || !contextId} onClick={() => void run({ op: "feedback_list" })}>查看我的反馈与回复</button>
    </section>}
    <p role="status" aria-live="polite">{notice}</p>
    {packageData && <section aria-label="本次读取结果"><h2>本次结果</h2><ContextResult data={packageData} selectRecord={mode === "development_history" ? row => { setRecord(row); const body = row.body as Item; setTitle(text(body?.title)); setContent(text(body?.content)); setAcceptance(null); } : undefined} /><details><summary>来源与回执详情</summary><pre>{JSON.stringify(packageData, null, 2)}</pre></details><p className="context-muted">结果在 30 秒后清除，再次使用需重新读取。退出、切换模式或隐藏页面时清除。已复制到外部聊天或文件的内容无法收回。</p></section>}
  </main>;
}

function ContextResult({ data, selectRecord }: { data: Item; selectRecord?: (row: Item) => void }) {
  const rows = [...objects(data.records), ...objects(data.feedback)];
  if (data.publication && typeof data.publication === "object") rows.push(data.publication as Item);
  if (data.result && typeof data.result === "object") rows.push(data.result as Item);
  if (!rows.length) return <p>{data.status === "committed" ? "操作已保存。" : "已完成读取；没有可展示的正文。"}</p>;
  return <>{rows.map((row, index) => {
    const body = (row.body ?? row.payload ?? row.publication_payload ?? {}) as Item;
    return <article key={text(row.id) || index}><h3>{text(body.title) || text(row.name) || "上下文记录"}</h3>{text(body.content) && <p style={{ whiteSpace: "pre-wrap" }}>{text(body.content)}</p>}{row.response && typeof row.response === "object" ? <p>回复：{text((row.response as Item).content)}</p> : null}<p className="context-muted">{row.version ? `版本 ${row.version} · ` : ""}{text(row.lifecycle_status) || text(row.state) || text(row.status)}</p>{selectRecord && row.record_type && row.body ? <button onClick={() => selectRecord(row)}>选择这条记录</button> : null}</article>;
  })}</>;
}
