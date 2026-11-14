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
//
// Resident CI active/standby, C10 (Task bb13efb5, design v0.4 §5.9): marking
// ci-admission takes a purpose (resident node, parking spot or other), a new
// ci-admission row starts 5 minutes after the Owner confirms, a parking spot
// never admits anyone and cannot be ended while it is the only one, and
// "移交 CI 准入" ends one holder and gives another in one server transaction.
type Json = Record<string, unknown>;
type Pending = { kind: "role" | "handover"; confirmation_token: string; view_digest: string; view: Json };
const object = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const MESSAGES: Record<string, string> = {
  direct_human_session_required: "需要你本人直接登录 BeamingFace，授权给应用的登录不能管理专用 Binding。",
  confirmation_token_session_id_required: "当前登录缺少会话信息，请退出后重新登录。",
  binding_role_scope_missing: "这个 Binding 缺少该用途需要的权限（CI 准入要 context:read，发布门口要 context:write）。",
  binding_role_binding_invalid: "这个 Binding 已撤销或不属于当前账号。",
  binding_role_unchanged: "状态已经是这样了，请刷新页面。",
  binding_role_purpose_required: "给 CI 准入标专用时要选用途：常驻节点、停车位或其他。",
  binding_role_purpose_invalid: "用途不对，请刷新页面后重试。",
  binding_role_resident_holder_exists: "已经有一个有效的连接以常驻节点的用途持有 CI 准入（用途未标明的也按常驻节点算）。请用“移交 CI 准入”，或先取消它的。",
  binding_role_parking_protected: "停车位的 CI 准入不能直接取消，也不能从停车位移交。要换停车位，先新建一个，再取消这个。",
  binding_role_handover_input_invalid: "移交请求不完整，请刷新页面。",
  binding_role_handover_source_invalid: "移交的来源已经不持有 CI 准入，请刷新页面。",
  binding_role_handover_target_invalid: "移交的目标已撤销、已过期、不属于当前账号，或就是来源本身。",
  binding_role_handover_target_holds_role: "移交的目标已经持有 CI 准入。",
  ci_admission_target_not_heard: "移交的目标节点最近 5 分钟没有心跳（或还没有登记节点），不能接班。",
  ci_admission_target_halted: "移交的目标节点已停机（HALT），不能接班。",
  ci_admission_target_paused: "移交的目标节点已暂停，不能接班。",
  ci_admission_target_intake_paused: "移交的目标节点正在暂停接新（含 Windows 与 Linux 两侧版本不一致时它自己的暂停），不能接班。",
  ci_admission_target_state_unknown: "移交的目标节点状态读不出（服务没在运行或状态过旧），不能接班。",
  ci_admission_target_source_unknown: "移交的目标节点没有报过它运行的 Source，不能接班。",
  ci_admission_target_source_not_accepted: "移交的目标节点运行的 Source 与其他节点（含当前持有者）不同，不能接班。请先让它装上同一个包。",
  confirmation_token_expired: "确认已超过 5 分钟有效期，请重新点一次。",
  confirmation_token_revoked: "确认已被更新的操作取代，请按页面当前内容操作。",
  confirmation_view_stale: "Binding 在你查看后发生了变化，请刷新页面后重试。",
};
const PURPOSES: { purpose: string; label: string }[] = [
  { purpose: "resident-node", label: "常驻节点" },
  { purpose: "parking", label: "停车位" },
  { purpose: "other", label: "其他" },
];
// Button labels of the single-holder roles; a role this page does not know shows its server title.
const ROLE_LABELS: Record<string, string> = { "release-door": "发布门口", "resident-upgrade": "常驻节点升级门口" };
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
const clock = (value: unknown) => {
  const time = new Date(String(value));
  return Number.isNaN(time.getTime()) ? String(value ?? "") : time.toLocaleString("zh-CN", { hour12: false });
};
// When a role row starts admitting its Binding, in words.
const start = (detail: Json) => detail.effective_at === "infinity" ? "永不放行"
  : detail.in_force === false ? clock(detail.effective_at) + " 起生效（还没生效）" : "已生效";
const name = (binding: Json | null | undefined) => String(binding?.agent_name ?? "") + "（" + String(binding?.vendor ?? "") + "）";

export default function BindingRolesPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [bindings, setBindings] = useState<Json[] | null>(null);
  const [roles, setRoles] = useState<Json[]>([]);
  const [delay, setDelay] = useState(5);
  const [pending, setPending] = useState<Pending | null>(null);
  const [handoverFrom, setHandoverFrom] = useState<string | null>(null);
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
      setBindings(null); setRoles([]); setPending(null); setHandoverFrom(null); setError(""); setNotice(""); setWorking(false);
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
      if (typeof value.activation_delay_minutes === "number") setDelay(value.activation_delay_minutes);
    } catch (failure) {
      if (epoch.current === generation) setError(failure instanceof RequestFailure ? failure.message : "暂时无法读取 Binding。");
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  // Step 1: Clued renders what will change and issues a token for exactly that.
  async function issue(kind: Pending["kind"], rpcName: string, input: Json) {
    if (!current.current || working) return;
    const generation = epoch.current;
    setWorking(true); setError(""); setNotice(""); setPending(null);
    try {
      const value = await rpc(rpcName, input);
      if (epoch.current !== generation) return;
      if (value.status !== "issued" || typeof value.confirmation_token !== "string" || typeof value.view_digest !== "string"
        || !object(value.confirmation_view)) throw new RequestFailure("确认内容不完整，请刷新页面。");
      setHandoverFrom(null);
      setPending({ kind, confirmation_token: value.confirmation_token, view_digest: value.view_digest, view: value.confirmation_view });
    } catch (failure) {
      if (epoch.current === generation) setError(failure instanceof RequestFailure ? failure.message : "暂时无法生成确认。");
    } finally { if (epoch.current === generation) setWorking(false); }
  }
  const ask = (bindingId: string, role: string, enabled: boolean, purpose?: string) =>
    issue("role", "clued_binding_role_confirmation_issue_v1",
      purpose ? { binding_id: bindingId, role, enabled, purpose } : { binding_id: bindingId, role, enabled });
  const askHandover = (from: string, to: string) =>
    issue("handover", "clued_binding_role_handover_confirmation_issue_v1", { from_binding_id: from, to_binding_id: to });

  // Step 2: commit exactly the view on screen.
  async function confirm() {
    if (!current.current || working || !pending) return;
    const generation = epoch.current;
    const target = pending;
    setWorking(true); setError("");
    try {
      const result = await rpc(target.kind === "handover" ? "clued_binding_role_handover_v1" : "clued_binding_role_set_v1",
        { confirmation_token: target.confirmation_token, view_digest: target.view_digest });
      if (epoch.current !== generation) return;
      setPending(null);
      const minutes = String(target.view.delay_minutes ?? delay);
      if (target.kind === "handover") {
        const from = object(target.view.from) ? target.view.from : null;
        const to = object(target.view.to) ? target.view.to : null;
        setNotice("已移交：" + name(from) + " 的 CI 准入已结束；" + name(to) + " 从 " + clock(result.effective_at)
          + " 起生效（" + minutes + " 分钟后），在那之前两者都不能做 CI 准入。");
      } else if (!target.view.enabled) setNotice("已取消，立即生效。");
      else if (target.view.activation === "never") setNotice("已设为停车位：它只占住 CI 准入，永远不放行任何连接。请照常尽快在连接页吊销这个连接。");
      else if (target.view.activation === "delayed") setNotice("已设定，" + clock(result.effective_at) + " 起生效（" + minutes + " 分钟后）。");
      else setNotice("已设定，立即生效。");
    } catch (failure) {
      if (epoch.current === generation) { setPending(null); setError(failure instanceof RequestFailure ? failure.message : "结果未知，请刷新页面核对。"); }
    } finally { if (epoch.current === generation) setWorking(false); }
    if (epoch.current === generation) await load();
  }

  const view = pending?.view ?? null;
  const others = view && Array.isArray(view.others) ? view.others.filter(object) : [];
  const ci = roles.find(r => r.role === "ci-admission");
  const parkingCount = Number(ci?.parking_count ?? 0);
  const source = handoverFrom ? bindings?.find(b => String(b.binding_id) === handoverFrom) ?? null : null;
  // Handover targets: live, can read, and holding no ci-admission row.
  const targets = source ? (bindings ?? []).filter(b => b.live !== false && list(b.scopes).includes("context:read")
    && !list(b.roles).includes("ci-admission") && String(b.binding_id) !== handoverFrom) : [];
  const othersLine = others.map(other => String(other.agent_name ?? "") + (other.live === false ? "（已失效）" : "")
    + (other.purpose_title ? "，" + String(other.purpose_title) : "")).join("、");
  return <main className="context-page owner-confirm">
    <header><Link href="/">BeamingFace</Link> <Link href="/grants">我的授权</Link> <Link href="/bindings/failover">CI 准入自动接班</Link></header>
    <h1>专用 Binding</h1>
    <p className="context-muted">把 GitHub 上 CI 准入用的 Binding、生产发布用的 Binding 标出来。标出之后，只有它们能做对应的事，其他 Agent 的 Binding 都不行。标出的 Binding 撤销或过期后，这件事谁都做不了，直到你在这里给新的 Binding 标上，或者取消它。从没标出过的用途，保持原来的行为。</p>
    <p className="context-muted">CI 准入另有三条规矩：标的时候要选用途（常驻节点、停车位或其他）；新标的 CI 准入要在你确认 {delay} 分钟后才生效，停车位永远不放行；常驻节点之间换班用“移交 CI 准入”，一次确认就收旧给新。</p>
    {!ready ? <p role="status">正在读取登录状态…</p> : !session ? <p><Link href="/">登录 BeamingFace</Link> 后管理专用 Binding。</p> : <>
      <p className="context-muted">已登录 {session.user.email || session.user.id}</p>
      {ci?.marked === true && parkingCount === 0 && <p className="context-muted">CI 准入还没有停车位：如果它的持有者都被取消，这个用途就对所有连接开放。建议先建一个停车位（新建一个连接，在这里设为“CI 准入：停车位”，然后吊销那个连接）。</p>}
      {view && pending?.kind === "handover" && <section aria-label="确认更改" className="owner-note"><h2>确认移交</h2>
        <p className="context-muted">以下内容由 BeamingFace 生成。</p>
        <dl>
          <dt>用途</dt><dd>{String(view.role_title ?? view.role ?? "")}</dd>
          <dt>从</dt><dd>{name(object(view.from) ? view.from : null)}{object(view.from) && view.from.live === false ? "，已失效" : ""}
            {object(view.from) && view.from.purpose_title ? "（" + String(view.from.purpose_title) + "）" : ""}：确认后立即结束</dd>
          <dt>移交给</dt><dd>{name(object(view.to) ? view.to : null)}：用途为常驻节点，确认 {String(view.delay_minutes ?? delay)} 分钟后才生效</dd>
          <dt>期间</dt><dd>这 {String(view.delay_minutes ?? delay)} 分钟里两者都不能做 CI 准入，PR 只是晚一点开始；其他已生效的持有者不受影响。</dd>
          {others.length > 0 && <><dt>其他持有者</dt><dd>{othersLine}（不变）</dd></>}
        </dl>
        <div className="owner-actions">
          <button type="button" disabled={working} onClick={() => void confirm()}>确认</button>
          <button type="button" disabled={working} onClick={() => setPending(null)}>取消</button>
        </div></section>}
      {view && pending?.kind === "role" && <section aria-label="确认更改" className="owner-note"><h2>确认更改</h2>
        <p className="context-muted">以下内容由 BeamingFace 生成。</p>
        <dl>
          <dt>Binding</dt><dd>{name(view)}</dd>
          <dt>权限</dt><dd>{list(view.scopes).join("、")}</dd>
          <dt>用途</dt><dd>{String(view.role_title ?? view.role ?? "")}{view.purpose_title ? "：" + String(view.purpose_title) : ""}</dd>
          <dt>操作</dt><dd>{view.enabled ? "设为专用" : "取消专用"}</dd>
          <dt>生效</dt><dd>{!view.enabled ? "立即结束" : view.activation === "never" ? "永不放行，只占住这个用途"
            : view.activation === "delayed" ? "确认 " + String(view.delay_minutes ?? delay) + " 分钟后才生效" : "立即生效"}</dd>
          {others.length > 0 && <><dt>同一用途</dt><dd>{othersLine}（仍然保留这个用途）</dd></>}
        </dl>
        {!view.enabled && others.length === 0 && <p role="alert">这是这个用途的最后一个持有者：取消后，这个用途对所有连接开放。</p>}
        <div className="owner-actions">
          <button type="button" disabled={working} onClick={() => void confirm()}>确认</button>
          <button type="button" disabled={working} onClick={() => setPending(null)}>取消</button>
        </div></section>}
      {source && !pending && <section aria-label="移交 CI 准入" className="owner-note"><h2>移交 CI 准入</h2>
        <p className="context-muted">从 {name(source)} 移交给下面哪一个连接？移交后它的用途是常驻节点，{delay} 分钟后才生效；停车位和其他持有者不变。</p>
        {targets.length === 0 ? <p className="context-muted">没有可以移交的连接：目标要有效、有 context:read，而且还没有 CI 准入。</p>
          : <div className="context-row">{targets.map(target => <button key={String(target.binding_id)} type="button" disabled={working}
            onClick={() => void askHandover(String(source.binding_id), String(target.binding_id))}>{"移交给：" + name(target)}</button>)}</div>}
        <button type="button" disabled={working} onClick={() => setHandoverFrom(null)}>返回</button>
      </section>}
      <section aria-label="Binding 列表"><h2>我的 Binding</h2>
        {bindings === null ? <p role="status">正在读取…</p> : bindings.length === 0 ? <p className="context-muted">目前没有有效的 Binding。</p>
          : bindings.map(binding => {
            const held = list(binding.roles);
            const live = binding.live !== false;
            const details = Array.isArray(binding.role_details) ? binding.role_details.filter(object) : [];
            const detail = (role: string) => details.find(d => d.role === role) ?? null;
            const busy = working || !!pending || !!handoverFrom;
            return <div key={String(binding.binding_id)} className="owner-grant">
              <dl>
                <dt>名称</dt><dd>{name(binding)}{live ? "" : "，已失效"}</dd>
                <dt>权限</dt><dd>{list(binding.scopes).join("、")}</dd>
                <dt>专用</dt><dd>{held.length ? held.map(role => {
                  const title = String(roles.find(r => r.role === role)?.title ?? role);
                  const row = detail(role);
                  if (!row) return title;
                  return title + (row.purpose_title ? "：" + String(row.purpose_title) : "") + "，" + start(row);
                }).join("；") : "无"}</dd>
              </dl>
              <div className="context-row">{roles.map(role => {
                const key = String(role.role);
                const has = held.includes(key);
                if (key !== "ci-admission") {
                  if (!live && !has) return null;
                  return <button key={key} type="button" disabled={busy}
                    onClick={() => void ask(String(binding.binding_id), key, !has)}>{(has ? "取消：" : "设为：") + (ROLE_LABELS[key] ?? String(role.title ?? key))}</button>;
                }
                if (!has) return live ? PURPOSES.map(p => <button key={key + p.purpose} type="button" disabled={busy}
                  onClick={() => void ask(String(binding.binding_id), key, true, p.purpose)}>{"设为 CI 准入：" + p.label}</button>) : null;
                if (detail(key)?.purpose === "parking") return parkingCount > 1
                  ? <button key={key} type="button" disabled={busy}
                    onClick={() => void ask(String(binding.binding_id), key, false)}>取消：CI 准入（停车位）</button>
                  : <span key={key} className="context-muted">停车位不能直接取消：要换停车位，先新建一个。</span>;
                return [<button key={key} type="button" disabled={busy}
                  onClick={() => void ask(String(binding.binding_id), key, false)}>取消：CI 准入</button>,
                <button key={key + "-handover"} type="button" disabled={busy}
                  onClick={() => { setError(""); setNotice(""); setHandoverFrom(String(binding.binding_id)); }}>移交 CI 准入…</button>];
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
