"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { type Session } from "@supabase/supabase-js";
import { supabase } from "../supabase-browser";
import "../contexts/contexts.css";

// Native acceptance of a Context Policy (contract M0DCloseout 6.1): step 1
// issues a single-use confirmation over the normalized policy, step 2 accepts
// exactly that view. Both are account-session requests; a Binding cannot call
// them, and this page never holds or forwards a Binding token.
type Json = Record<string, unknown>;
type Project = { id: string; name: string };
type Issued = {
  confirmation_token: string; view_digest: string; task_class: string; base_policy_version: number;
  expires_at: string; confirmation_view: unknown;
};
type Accept = {
  idempotency_key: string; task_class: string; base_policy_version: number;
  confirmation_token: string; view_digest: string;
};
const RECORD_TYPES: Record<string, string> = {
  decision: "决定", task: "任务", state: "状态", note: "笔记", profile_fact: "个人资料",
};
const FIELDS: Record<string, string> = {
  title: "标题", content: "正文", rationale: "理由", closure_summary: "结项摘要",
};
const TOKENIZER = {
  package: "js-tiktoken", version: "1.0.21", encoding: "o200k_base", model_mapping: "gpt-4.1-2025-04-14",
};
const object = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const MESSAGES: Record<string, string> = {
  reauthentication_required: "为安全起见，确认前 15 分钟内需要重新登录。请退出后重新登录，再从第一步开始。",
  context_policy_version_conflict: "这个任务类已有其他版本的策略。请把“当前版本号”改成最新版本后，从第一步重新开始。",
  confirmation_token_expired: "确认已超过 5 分钟有效期，请从第一步重新生成预览。",
  confirmation_token_reused: "这次确认已经用过，请从第一步重新生成预览。",
  confirmation_token_revoked: "这次确认已被新的预览取代，请使用最新的预览。",
  confirmation_token_binding_mismatch: "确认与当前登录会话或预览内容不一致，请从第一步重新开始。",
};
class RequestFailure extends Error { constructor(message: string, readonly uncertain = false) { super(message); } }

async function post(who: Session, path: string, body: Json): Promise<Json> {
  let response: Response;
  try {
    response = await fetch(path, { method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { Authorization: "Bearer " + who.access_token, "Content-Type": "application/json" },
      body: JSON.stringify(body) });
  } catch { throw new RequestFailure("网络请求未完成，结果未知。", true); }
  let value: unknown;
  try { value = await response.json(); } catch { throw new RequestFailure("服务返回了不完整的结果，结果未知。", true); }
  if (response.status === 401) throw new RequestFailure("登录已失效，请重新登录。");
  if (!object(value)) throw new RequestFailure("服务返回了无法识别的结果，结果未知。", true);
  if (value.status === "rejected") {
    const code = typeof value.error_code === "string" ? value.error_code : "rejected";
    throw new RequestFailure(MESSAGES[code] ?? "请求被拒绝（" + code + "）。");
  }
  if (!response.ok) throw new RequestFailure("请求未完成（HTTP " + response.status + "）。", response.status >= 500);
  return value;
}

function toggle(list: string[], value: string, on: boolean) {
  return on ? [...new Set([...list, value])] : list.filter(item => item !== value);
}

export default function PoliciesPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [taskClass, setTaskClass] = useState("general");
  const [scopes, setScopes] = useState<string[]>(["global"]);
  const [types, setTypes] = useState<string[]>(Object.keys(RECORD_TYPES));
  const [allowAgent, setAllowAgent] = useState(true);
  const [requireEvidence, setRequireEvidence] = useState(false);
  const [required, setRequired] = useState<string[]>(["title", "content"]);
  const [maxItems, setMaxItems] = useState("50");
  const [tokenBudget, setTokenBudget] = useState("8000");
  const [baseVersion, setBaseVersion] = useState("0");
  const [rationale, setRationale] = useState("启用 context-pack：允许 Agent 写入的记录进入上下文包，条目标注 AGENT_AUTHORED，包为非权威。");
  const [issued, setIssued] = useState<Issued | null>(null);
  const [pendingAccept, setPendingAccept] = useState<Accept | null>(null);
  const [accepted, setAccepted] = useState<string | null>(null);
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
      const generation = ++epoch.current;
      setProjects(null); setIssued(null); setPendingAccept(null); setAccepted(null); setError(""); setWorking(false);
      if (!next) return;
      fetch("/v1/projects?limit=200", { headers: { Authorization: "Bearer " + next.access_token }, cache: "no-store" })
        .then(async response => {
          if (!response.ok) throw new Error("project-list-failed");
          const value: unknown = await response.json();
          const rows = object(value) && Array.isArray(value.projects) ? value.projects : [];
          if (epoch.current === generation) {
            setProjects(rows.filter((row): row is Project => object(row) && typeof row.id === "string" && typeof row.name === "string"));
          }
        })
        .catch(() => { if (epoch.current === generation) setProjects([]); });
    });
    return () => { disposed = true; ++lifetime.current; data.subscription.unsubscribe(); };
  }, []);

  const optional = Object.keys(FIELDS).filter(field => !required.includes(field));
  const policy = {
    schema: "clued.context-policy.v1", task_class: taskClass.trim(), allowed_scopes: scopes,
    allowed_record_types: types, allow_agent_authored: allowAgent, require_evidence: requireEvidence,
    fields: { required, optional }, verbatim_constraints: [], max_items: Number(maxItems),
    token_budget: Number(tokenBudget), tokenizer: TOKENIZER, freshness: { mode: "current", reason: null },
  };
  const formValid = /^[a-z0-9][a-z0-9._:-]{0,119}$/.test(policy.task_class) && scopes.length > 0 && types.length > 0
    && required.length > 0 && Number.isInteger(policy.max_items) && policy.max_items >= 1 && policy.max_items <= 200
    && Number.isInteger(policy.token_budget) && policy.token_budget >= 1 && policy.token_budget <= 32768
    && /^\d+$/.test(baseVersion) && rationale.trim().length > 0;
  const editing = !issued && !pendingAccept && !accepted;

  async function preview(event: FormEvent) {
    event.preventDefault();
    const who = current.current;
    if (!who || working || !formValid) return;
    const generation = epoch.current;
    setWorking(true); setError("");
    try {
      const value = await post(who, "/v1/context/policies/confirmation",
        { policy, rationale: rationale.trim(), base_policy_version: Number(baseVersion) });
      if (epoch.current !== generation) return;
      if (value.status !== "issued" || typeof value.confirmation_token !== "string" || typeof value.view_digest !== "string"
        || typeof value.task_class !== "string" || typeof value.expires_at !== "string") {
        throw new RequestFailure("预览结果不完整，请重新生成。");
      }
      setIssued({ confirmation_token: value.confirmation_token, view_digest: value.view_digest,
        task_class: value.task_class, base_policy_version: Number(baseVersion), expires_at: value.expires_at,
        confirmation_view: value.confirmation_view });
    } catch (failure) {
      if (epoch.current === generation) setError(failure instanceof RequestFailure ? failure.message : "暂时无法生成预览。");
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  async function accept(retry?: Accept) {
    const who = current.current;
    if (!who || working) return;
    const input: Accept | null = retry ?? (issued && { idempotency_key: crypto.randomUUID(), task_class: issued.task_class,
      base_policy_version: issued.base_policy_version, confirmation_token: issued.confirmation_token,
      view_digest: issued.view_digest });
    if (!input) return;
    const generation = epoch.current;
    setWorking(true); setError(""); setPendingAccept(input); setIssued(null);
    try {
      const value = await post(who, "/v1/context/policies", { ...input });
      if (epoch.current !== generation) return;
      const supplemental = object(value.supplemental) ? value.supplemental : {};
      if (value.status !== "committed" || typeof supplemental.policy_id !== "string") {
        throw new RequestFailure("接受结果尚未确认，请核对原操作。", true);
      }
      setAccepted(supplemental.policy_id); setPendingAccept(null);
    } catch (failure) {
      if (epoch.current !== generation) return;
      if (failure instanceof RequestFailure && !failure.uncertain) setPendingAccept(null);
      setError(failure instanceof RequestFailure && !failure.uncertain ? failure.message
        : "接受结果尚未确认。请点“核对原操作”，系统会沿用同一请求，不会重复接受。");
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  function restart() { setIssued(null); setPendingAccept(null); setAccepted(null); setError(""); }
  async function signOut() {
    ++epoch.current; current.current = null; setSession(null); restart();
    try { await supabase.auth.signOut(); } catch { setError("退出尚未确认，请重新加载页面后检查登录状态。"); }
  }

  return <main className="context-page">
    <header><Link href="/">BeamingFace / 账号</Link><Link href="/contexts">上下文</Link></header>
    <h1>上下文策略</h1>
    <p className="context-muted">规定 Agent 通过 context-pack 能读到哪些记录。接受策略需要你本人登录确认：先生成预览，核对无误后再确认接受。</p>
    {!ready ? <p role="status">正在读取登录状态…</p> : !session ? <p><Link href="/">登录 BeamingFace</Link> 后设置上下文策略。</p> : <>
      <p>已登录 {session.user.email || session.user.id} <button type="button" onClick={() => void signOut()}>退出</button></p>
      {editing && <form onSubmit={preview} aria-label="策略内容">
        <label>任务类<input required maxLength={120} disabled={working} value={taskClass} onChange={event => setTaskClass(event.target.value)} /></label>
        <fieldset><legend>记录范围</legend>
          <label><input type="checkbox" disabled={working} checked={scopes.includes("profile")} onChange={event => setScopes(toggle(scopes, "profile", event.target.checked))} />个人资料</label>
          <label><input type="checkbox" disabled={working} checked={scopes.includes("global")} onChange={event => setScopes(toggle(scopes, "global", event.target.checked))} />个人记录</label>
          {projects === null ? <p role="status">正在读取项目…</p> : projects.map(project => <label key={project.id}>
            <input type="checkbox" disabled={working} checked={scopes.includes("project:" + project.id)} onChange={event => setScopes(toggle(scopes, "project:" + project.id, event.target.checked))} />项目：{project.name}</label>)}
        </fieldset>
        <fieldset><legend>记录类型</legend>{Object.entries(RECORD_TYPES).map(([value, label]) => <label key={value}>
          <input type="checkbox" disabled={working} checked={types.includes(value)} onChange={event => setTypes(toggle(types, value, event.target.checked))} />{label}</label>)}
        </fieldset>
        <fieldset><legend>必需字段（其余为可选）</legend>{Object.entries(FIELDS).map(([value, label]) => <label key={value}>
          <input type="checkbox" disabled={working} checked={required.includes(value)} onChange={event => setRequired(toggle(required, value, event.target.checked))} />{label}</label>)}
        </fieldset>
        <label><input type="checkbox" disabled={working} checked={allowAgent} onChange={event => setAllowAgent(event.target.checked)} />包含 Agent 写入的记录（标注为 Agent 写入，包为非权威）</label>
        <label><input type="checkbox" disabled={working} checked={requireEvidence} onChange={event => setRequireEvidence(event.target.checked)} />只包含带证据的记录</label>
        <label>最多条目数（1–200）<input inputMode="numeric" disabled={working} value={maxItems} onChange={event => setMaxItems(event.target.value)} /></label>
        <label>token 预算（1–32768）<input inputMode="numeric" disabled={working} value={tokenBudget} onChange={event => setTokenBudget(event.target.value)} /></label>
        <label>当前版本号（首次为 0）<input inputMode="numeric" disabled={working} value={baseVersion} onChange={event => setBaseVersion(event.target.value)} /></label>
        <label>理由<textarea required maxLength={2000} disabled={working} value={rationale} onChange={event => setRationale(event.target.value)} /></label>
        <button type="submit" disabled={working || !formValid}>第一步：生成确认预览</button>
      </form>}
      {issued && <section aria-label="确认预览"><h2>请核对后确认</h2>
        <p>任务类 {issued.task_class}，预览有效期至 {new Date(issued.expires_at).toLocaleTimeString()}。</p>
        <pre>{JSON.stringify(issued.confirmation_view, null, 2)}</pre>
        <button type="button" disabled={working} onClick={() => void accept()}>第二步：确认接受</button>
        <button type="button" disabled={working} onClick={restart}>返回修改</button>
      </section>}
      {pendingAccept && !working && <section aria-label="待核对接受"><p>有一次接受结果尚未确认。</p>
        <button type="button" onClick={() => void accept(pendingAccept)}>核对原操作</button></section>}
      {accepted && <section aria-label="已接受" role="status"><h2>策略已接受</h2><p>策略 ID：{accepted}</p>
        <button type="button" onClick={restart}>再设置一条</button></section>}
    </>}
    {error && <p role="alert">{error}</p>}
  </main>;
}
