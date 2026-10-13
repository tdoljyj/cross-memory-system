"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { type Session } from "@supabase/supabase-js";
import { supabase } from "../supabase-browser";
import "../contexts/contexts.css";
import "../confirm/owner.css";

// Binding roles (Task 869d2db7, Owner Decision 38ddb8cf). The Owner marks which
// Binding is the GitHub CI admission Binding and which is the release door's.
// Once marked, only that Binding binds claims to pull requests and meters CI
// (ci-admission), or consumes release grants (release-door). Each change is
// the Native two-step confirmation: the page issues a single-use token over
// the view Clued renders, and "确认" commits exactly that view. All RPCs run as
// this signed-in account session; Bindings and delegated OAuth are refused.
// A role stays locked while any Binding holds it, even a revoked or expired
// one (re-review 2, finding A), so such a Binding is listed as 已失效 with
// only its "取消" buttons: the Owner ends its role here, or marks a new one.
type Json = Record<string, unknown>;
type Pending = { confirmation_token: string; view_digest: string; view: Json };
const object = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const MESSAGES: Record<string, string> = {
  direct_human_session_required: "需要你本人直接登录 Kooyumi，授权给应用的登录不能管理专用 Binding。",
  confirmation_token_session_id_required: "当前登录缺少会话信息，请退出后重新登录。",
  binding_role_scope_missing: "这个 Binding 缺少该用途需要的权限（CI 准入要 context:read，发布门口要 context:write）。",
  binding_role_binding_invalid: "这个 Binding 已撤销或不属于当前账号。",
  binding_role_unchanged: "状态已经是这样了，请刷新页面。",
  confirmation_token_expired: "确认已超过 5 分钟有效期，请重新点一次。",
  confirmation_token_revoked: "确认已被更新的操作取代，请按页面当前内容操作。",
  confirmation_view_stale: "Binding 在你查看后发生了变化，请刷新页面后重试。",
};
class RequestFailure extends Error {}

async function rpc(name: string, input: Json): Promise<Json> {
  let result: { data: unknown; error: { message?: string; code?: string } | null };
  try {
    result = await supabase.rpc(name, { p_input: input });
  } catch { throw new RequestFailure("网络请求未完成，请刷新后查看结果。"); }
  if (result.error) {
    const code = result.error.message ?? "";
    throw new RequestFailure(MESSAGES[code] ?? (result.error.code ? "请求被拒绝（" + code + "）。" : "网络请求未完成，请刷新后查看结果。"));
  }
  const value = result.data;
  if (!object(value)) throw new RequestFailure("服务返回了无法识别的结果。");
  if (value.status === "rejected" || value.status === "failed") {
    const code = typeof value.error_code === "string" ? value.error_code : String(value.status);
    throw new RequestFailure(MESSAGES[code] ?? "请求被拒绝（" + code + "）。");
  }
  return value;
}
const list = (value: unknown) => Array.isArray(value) ? value.map(String) : [];

export default function BindingRolesPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [bindings, setBindings] = useState<Json[] | null>(null);
  const [roles, setRoles] = useState<Json[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
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
      setBindings(null); setRoles([]); setPending(null); setError(""); setNotice(""); setWorking(false);
    });
    return () => { disposed = true; ++lifetime.current; data.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (session) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id]);

  async function load() {
    const generation = epoch.current;
    setWorking(true); setError("");
    try {
      const value = await rpc("clued_binding_roles_list_v1", {});
      if (epoch.current !== generation) return;
      setBindings(Array.isArray(value.bindings) ? value.bindings.filter(object) : []);
      setRoles(Array.isArray(value.roles) ? value.roles.filter(object) : []);
    } catch (failure) {
      if (epoch.current === generation) setError(failure instanceof RequestFailure ? failure.message : "暂时无法读取 Binding。");
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  // Step 1: Clued renders what will change and issues a token for exactly that.
  async function ask(bindingId: string, role: string, enabled: boolean) {
    if (!current.current || working) return;
    const generation = epoch.current;
    setWorking(true); setError(""); setNotice(""); setPending(null);
    try {
      const value = await rpc("clued_binding_role_confirmation_issue_v1", { binding_id: bindingId, role, enabled });
      if (epoch.current !== generation) return;
      if (value.status !== "issued" || typeof value.confirmation_token !== "string" || typeof value.view_digest !== "string"
        || !object(value.confirmation_view)) throw new RequestFailure("确认内容不完整，请刷新页面。");
      setPending({ confirmation_token: value.confirmation_token, view_digest: value.view_digest, view: value.confirmation_view });
    } catch (failure) {
      if (epoch.current === generation) setError(failure instanceof RequestFailure ? failure.message : "暂时无法生成确认。");
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  // Step 2: commit exactly the view on screen.
  async function confirm() {
    if (!current.current || working || !pending) return;
    const generation = epoch.current;
    const target = pending;
    setWorking(true); setError("");
    try {
      await rpc("clued_binding_role_set_v1", { confirmation_token: target.confirmation_token, view_digest: target.view_digest });
      if (epoch.current !== generation) return;
      setPending(null);
      setNotice(target.view.enabled ? "已设定，立即生效。" : "已取消，立即生效。");
    } catch (failure) {
      if (epoch.current === generation) { setPending(null); setError(failure instanceof RequestFailure ? failure.message : "结果未知，请刷新页面核对。"); }
    } finally { if (epoch.current === generation) setWorking(false); }
    if (epoch.current === generation) await load();
  }

  const view = pending?.view ?? null;
  const others = view && Array.isArray(view.others) ? view.others.filter(object) : [];
  return <main className="context-page owner-confirm">
    <header><Link href="/">Kooyumi</Link> <Link href="/grants">我的授权</Link></header>
    <h1>专用 Binding</h1>
    <p className="context-muted">把 GitHub 上 CI 准入用的 Binding、生产发布用的 Binding 标出来。标出之后，只有它们能做对应的事，其他 Agent 的 Binding 都不行。标出的 Binding 撤销或过期后，这件事谁都做不了，直到你在这里给新的 Binding 标上，或者取消它。从没标出过的用途，保持原来的行为。</p>
    {!ready ? <p role="status">正在读取登录状态…</p> : !session ? <p><Link href="/">登录 Kooyumi</Link> 后管理专用 Binding。</p> : <>
      <p className="context-muted">已登录 {session.user.email || session.user.id}</p>
      {view && <section aria-label="确认更改" className="owner-note"><h2>确认更改</h2>
        <p className="context-muted">以下内容由 Kooyumi 生成。</p>
        <dl>
          <dt>Binding</dt><dd>{String(view.agent_name ?? "")}（{String(view.vendor ?? "")}）</dd>
          <dt>权限</dt><dd>{list(view.scopes).join("、")}</dd>
          <dt>用途</dt><dd>{String(view.role_title ?? view.role ?? "")}</dd>
          <dt>操作</dt><dd>{view.enabled ? "设为专用" : "取消专用"}</dd>
          {others.length > 0 && <><dt>同一用途</dt><dd>{others.map(other => String(other.agent_name ?? "") + (other.live === false ? "（已失效）" : "")).join("、")}（仍然保留这个用途）</dd></>}
        </dl>
        <div className="owner-actions">
          <button type="button" disabled={working} onClick={() => void confirm()}>确认</button>
          <button type="button" disabled={working} onClick={() => setPending(null)}>取消</button>
        </div></section>}
      <section aria-label="Binding 列表"><h2>我的 Binding</h2>
        {bindings === null ? <p role="status">正在读取…</p> : bindings.length === 0 ? <p className="context-muted">目前没有有效的 Binding。</p>
          : bindings.map(binding => {
            const held = list(binding.roles);
            const live = binding.live !== false;
            return <div key={String(binding.binding_id)} className="owner-grant">
              <dl>
                <dt>名称</dt><dd>{String(binding.agent_name ?? "")}（{String(binding.vendor ?? "")}）{live ? "" : "，已失效"}</dd>
                <dt>权限</dt><dd>{list(binding.scopes).join("、")}</dd>
                <dt>专用</dt><dd>{held.length ? held.map(role => String(roles.find(r => r.role === role)?.title ?? role)).join("；") : "无"}</dd>
              </dl>
              <div className="context-row">{roles.map(role => {
                const name = String(role.role);
                const has = held.includes(name);
                if (!live && !has) return null;
                return <button key={name} type="button" disabled={working || !!pending}
                  onClick={() => void ask(String(binding.binding_id), name, !has)}>
                  {(has ? "取消：" : "设为：") + (name === "ci-admission" ? "CI 准入" : "发布门口")}</button>;
              })}</div>
              <hr />
            </div>;
          })}
      </section>
      <button type="button" disabled={working} onClick={() => void load()}>刷新</button>
    </>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </main>;
}
