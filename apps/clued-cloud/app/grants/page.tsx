"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { type Session } from "@supabase/supabase-js";
import { supabase } from "../supabase-browser";
import AutoApprovalSwitch, { isAutoApprovalState } from "./AutoApprovalSwitch";
import "../contexts/contexts.css";
import "../confirm/owner.css";

// Owner Credential v0.1 §5: the Owner's live grants (time left, uses) with
// one-click revoke, and the Agent requests still waiting. Revoking takes effect
// for every later use. §12 successor: a persistent Owner switch saved with
// version CAS. All RPCs run as this signed-in account session.
type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const MESSAGES: Record<string, string> = {
  direct_human_session_required: "需要你本人直接登录 BeamingFace，授权给应用的登录不能管理授权。",
  owner_grant_not_found: "找不到这条授权，可能已过期。",
  owner_auto_approve_version_conflict: "设置已在别处更新，已显示最新状态。请确认后再操作。",
  owner_auto_approve_session_id_required: "请重新登录 BeamingFace 后再修改自动审批。",
  owner_auto_approve_successor_required: "自动审批设置已更新，请刷新页面。",
};
class RequestFailure extends Error {
  constructor(message: string, readonly autoApproval?: unknown) { super(message); }
}

async function rpc(name: string, input: Json, accessToken?: string): Promise<Json> {
  let result: { data: unknown; error: { message?: string; code?: string } | null };
  try {
    const request = supabase.rpc(name, { p_input: input });
    if (accessToken) request.setHeader("Authorization", "Bearer " + accessToken);
    result = await request;
  } catch { throw new RequestFailure("网络请求未完成，请刷新后查看结果。"); }
  if (result.error) {
    const code = result.error.message ?? "";
    throw new RequestFailure(MESSAGES[code] ?? (result.error.code ? "请求被拒绝（" + code + "）。" : "网络请求未完成，请刷新后查看结果。"));
  }
  const value = result.data;
  if (!object(value)) throw new RequestFailure("服务返回了无法识别的结果。");
  if (value.status === "rejected" || value.status === "failed") {
    const code = typeof value.error_code === "string" ? value.error_code : String(value.status);
    throw new RequestFailure(MESSAGES[code] ?? "请求被拒绝（" + code + "）。", value.auto_approve);
  }
  return value;
}

function remaining(expiresAt: unknown, now: number) {
  const ms = Date.parse(String(expiresAt)) - now;
  if (!Number.isFinite(ms) || ms <= 0) return "已到期";
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60) return "还剩 " + minutes + " 分钟";
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? "还剩 " + hours + " 小时 " + (minutes % 60) + " 分钟" : "还剩 " + Math.floor(hours / 24) + " 天 " + (hours % 24) + " 小时";
}
const list = (value: unknown) => Array.isArray(value) ? value.map(String) : [];
// The first 8 hex digits of an id: what Agents quote, so the Owner can match a
// row to "授权 a0e3b847" or "申请 f6b2000e" without reading whole UUIDs.
const shortId = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-/i.test(value) ? value.slice(0, 8).toLowerCase() : "";

export default function OwnerGrantsPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [grants, setGrants] = useState<Json[] | null>(null);
  const [packages, setPackages] = useState<Json[]>([]);
  const [requests, setRequests] = useState<Json[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [auto, setAuto] = useState<Json | null>(null);
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
      setGrants(null); setPackages([]); setRequests([]); setAuto(null); setError(""); setNotice(""); setWorking(false);
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
      const value = await rpc("clued_owner_grants_list_v1", {});
      if (epoch.current !== generation) return;
      setGrants(Array.isArray(value.grants) ? value.grants.filter(object) : []);
      setPackages(Array.isArray(value.sealed_packages) ? value.sealed_packages.filter(object) : []);
      setRequests(Array.isArray(value.pending_requests) ? value.pending_requests.filter(object) : []);
      setAuto(object(value.auto_approve) ? value.auto_approve : null);
    } catch (failure) {
      if (epoch.current === generation) setError(failure instanceof RequestFailure ? failure.message : "暂时无法读取授权。");
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  async function revoke(grantId: string, acceptance?: string) {
    if (!current.current || working) return;
    const generation = epoch.current;
    setWorking(true); setError(""); setNotice("");
    try {
      const result = await rpc("clued_owner_grant_revoke_v1", { grant_id: grantId, ...(acceptance ? { acceptance_sha256: acceptance } : {}) }, current.current.access_token);
      if (epoch.current !== generation) return;
      if (acceptance) await load();
      if (epoch.current !== generation) return;
      setGrants(previous => (previous ?? []).filter(grant => grant.grant_id !== grantId));
      setNotice(acceptance
        ? (object(result.current_package) ? "已撤销。当前封存包为 " + String(result.current_package.version) + "。" : "已撤销。当前没有可用封存包。")
        : "已撤销，之后的使用都会被拒绝。");
    } catch (failure) {
      if (epoch.current === generation) setError(failure instanceof RequestFailure ? failure.message : "暂时无法撤销，请刷新后重试。");
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  async function setAutoEnabled(enabled: boolean, baseVersion: number) {
    const clickedSession = current.current;
    if (!clickedSession || working || !isAutoApprovalState(auto) || auto.version !== baseVersion) return;
    const generation = epoch.current;
    setWorking(true); setError(""); setNotice("");
    try {
      const value = await rpc("clued_owner_auto_approve_set_v1", { enabled, base_version: baseVersion }, clickedSession.access_token);
      if (epoch.current !== generation) return;
      if (value.status !== "committed" || !isAutoApprovalState(value.auto_approve)) throw new RequestFailure("服务返回了无法识别的自动审批状态，请刷新后查看结果。");
      setAuto(value.auto_approve);
      setNotice(value.auto_approve.on ? "自动审批已开启。" : "自动审批已关闭，新的申请需要你确认。");
    } catch (failure) {
      if (epoch.current !== generation) return;
      if (failure instanceof RequestFailure && isAutoApprovalState(failure.autoApproval)) setAuto(failure.autoApproval);
      setError(failure instanceof RequestFailure ? failure.message : "暂时无法保存，请刷新后查看结果。");
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  const now = Date.now();
  return <main className="context-page owner-confirm">
    <header><Link href="/">BeamingFace</Link> <Link href="/work-claims">谁在做哪个任务</Link> <Link href="/work-claims/race">多份模式</Link> <Link href="/bindings">专用 Binding</Link></header>
    <h1>我的授权</h1>
    <p><Link href="/independent-review">独立审核自动授权</Link>：默认打开，Agent 在已有授权范围内安排审核，无需逐次询问。</p>
    <p><Link href="/priority">优先级</Link>：看每条任务的自动分，给你在意的任务加上你的优先级，或撤回 Agent 按你要求代设的值。</p>
    <p className="context-muted">你给 Agent 的授权都在这里。撤销立即生效。</p>
    {!ready ? <p role="status">正在读取登录状态…</p> : !session ? <p><Link href="/">登录 BeamingFace</Link> 后查看你的授权。</p> : <>
      <p className="context-muted">已登录 {session.user.email || session.user.id}</p>
      <AutoApprovalSwitch auto={auto} working={working}
        onToggle={(enabled, baseVersion) => void setAutoEnabled(enabled, baseVersion)} />
      {packages.filter(pkg => pkg.classification === "current").map(pkg => <section key={String(pkg.grant_id)}>
        <h2>当前封存包 {String(pkg.version)}</h2>
        <p>{pkg.after_revoke_version ? "撤销后将使用 " + String(pkg.after_revoke_version) + "。" : "撤销后将没有可用封存包。"}</p>
        <button type="button" disabled={working} onClick={() => void revoke(String(pkg.grant_id), String(pkg.acceptance_sha256))}>撤销此封存包</button>
      </section>)}
      {requests.length > 0 && <section aria-label="等待确认"><h2>等待你确认</h2>
        <ul>{requests.map(request => <li key={String(request.request_id)}>
          {shortId(request.request_id) && <code>申请 {shortId(request.request_id)}</code>}{" "}
          <Link href={String(request.confirm_path)}>{String(request.action)}：{list(request.resources).join("、")}</Link>
          <span className="context-muted"> · {remaining(request.expires_at, now)}</span></li>)}</ul></section>}
      <section aria-label="有效授权"><h2>有效授权</h2>
        {grants === null ? <p role="status">正在读取…</p> : grants.length === 0 ? <p className="context-muted">目前没有有效授权。</p>
          : grants.map(grant => <div key={String(grant.grant_id)} className="owner-grant">
            <dl>
              <dt>编号</dt><dd><code>授权 {shortId(grant.grant_id)}</code>{shortId(grant.request_id) && <>{" · "}<code>申请 {shortId(grant.request_id)}</code></>}</dd>
              <dt>动作</dt><dd>{String(grant.action_title ?? "")}（{String(grant.action ?? "")}）</dd>
              <dt>范围</dt><dd><ul>{list(grant.resources).map(resource => <li key={resource}>{resource}</li>)}</ul></dd>
              {shortId(grant.task_id) && <><dt>任务</dt><dd>{typeof grant.task_title === "string" && grant.task_title ? grant.task_title + " " : ""}<code>{shortId(grant.task_id)}</code></dd></>}
              {grant.auto_approved === true && <><dt>来源</dt><dd>自动审批</dd></>}
              <dt>给谁</dt><dd>{grant.any_agent ? "我的任何 Agent" : String(grant.agent_name ?? "发起请求的 Agent")}</dd>
              <dt>剩余</dt><dd>{remaining(grant.expires_at, now)}</dd>
              <dt>已用</dt><dd>{String(grant.uses ?? 0)}{grant.max_uses == null ? " 次（不限）" : " / " + String(grant.max_uses) + " 次"}</dd>
            </dl>
            <div className="owner-actions"><button type="button" disabled={working} onClick={() => void revoke(String(grant.grant_id))}>撤销</button></div>
            <hr />
          </div>)}
      </section>
      <button type="button" disabled={working} onClick={() => void load()}>刷新</button>
    </>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </main>;
}
