"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { type Session } from "@supabase/supabase-js";
import { supabase } from "../supabase-browser";
import "../contexts/contexts.css";
import "../confirm/owner.css";

// Owner-managed account policy; default-on is supplied by the service, never
// guessed by the page. Native CAS and account epochs protect every update.
type Json = Record<string, unknown>;
type Setting = { enabled: boolean; version: number; isDefault: boolean; updatedAt: string | null };
const object = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const MESSAGES: Record<string, string> = {
  direct_human_session_required: "需要你本人直接登录 BeamingFace，授权给应用的登录不能切换这个开关。",
  independent_review_setting_session_required: "当前登录缺少会话信息，请退出后重新登录。",
  independent_review_setting_version_conflict: "开关在你打开页面后被改过，已显示最新状态，请确认后再切换。",
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

function parse(value: Json, status: "ok" | "committed"): Setting {
  if (value.status !== status || (status === "committed" && typeof value.changed !== "boolean") ||
    typeof value.enabled !== "boolean" || !Number.isSafeInteger(value.version) || Number(value.version) < 0) throw new RequestFailure("服务返回了无法识别的结果。");
  return { enabled: value.enabled, version: Number(value.version), isDefault: value.default === true,
    updatedAt: typeof value.updated_at === "string" ? value.updated_at : null };
}

export default function IndependentReviewPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [setting, setSetting] = useState<Setting | null>(null);
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
      setSetting(null); setError(""); setNotice(""); setWorking(false);
    });
    return () => { disposed = true; ++lifetime.current; data.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (session) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id]);

  async function load(keepMessages = false) {
    const generation = epoch.current;
    setSetting(null); setWorking(true);
    if (!keepMessages) { setError(""); setNotice(""); }
    try {
      const value = parse(await rpc("clued_independent_review_setting_v1", {}), "ok");
      if (epoch.current === generation) setSetting(value);
    } catch (failure) {
      if (epoch.current === generation) { setSetting(null); setError(failure instanceof RequestFailure ? failure.message : "暂时无法读取开关状态。"); }
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  async function turn(enabled: boolean) {
    if (!current.current || working || !setting) return;
    const generation = epoch.current;
    setWorking(true); setError(""); setNotice("");
    let reload = false;
    try {
      const value = await rpc("clued_independent_review_setting_set_v1", { enabled, base_version: setting.version });
      if (epoch.current !== generation) return;
      setSetting(parse(value, "committed"));
      setNotice(enabled ? "已开启自动授权，后续审核不再逐次询问。" : "已关闭自动授权，后续审核按任务的明确许可进行。");
    } catch (failure) {
      if (epoch.current !== generation) return;
      setError(failure instanceof RequestFailure ? failure.message : "结果未知，请刷新页面核对。");
      reload = true;
    } finally { if (epoch.current === generation) setWorking(false); }
    if (reload && epoch.current === generation) await load(true);
  }

  return <main className="context-page owner-confirm">
    <header><Link href="/">BeamingFace</Link> <Link href="/grants">我的授权</Link> <Link href="/work-claims">谁在做哪个任务</Link></header>
    <h1>独立审核自动授权</h1>
    <p className="context-muted">默认打开。Agent 可以在你已授权的工作范围内直接安排独立审核、收集结论和复审，不用每次来问你是否允许。</p>
    <p className="context-muted">审核者须独立、只读，并遵守任务已有的范围、预算和先给你确认等要求。审核通过本身不批准修改、合并、部署或发布。</p>
    <p className="context-muted">关闭后，后续审核需要该任务的明确许可。已完成的结论会保留；这个设置不会撤销已经启动的审核。只有你本人登录 BeamingFace 才能切换，Agent 改不了。</p>
    {!ready ? <p role="status">正在读取登录状态…</p> : !session ? <p><Link href="/">登录 BeamingFace</Link> 后管理独立审核。</p> : <>
      <p className="context-muted">已登录 {session.user.email || session.user.id}</p>
      <section aria-label="开关" className="owner-note">
        {setting === null ? <p role="status">{working ? "正在读取…" : "暂未读到开关状态。"}</p> : <>
          <p><strong>{setting.enabled ? "已打开" : "已关闭"}</strong>{setting.isDefault ? "（默认）" : ""}</p>
          {setting.updatedAt && <p className="context-muted">上次更改：{new Date(setting.updatedAt).toLocaleString("zh-CN")}</p>}
          <div className="owner-actions">
            <button type="button" role="switch" aria-label="独立审核自动授权" aria-checked={setting.enabled} disabled={working} onClick={() => void turn(!setting.enabled)}>
              {setting.enabled ? "关闭自动授权" : "开启自动授权"}</button>
          </div>
        </>}
      </section>
      <button type="button" disabled={working} onClick={() => void load()}>刷新</button>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </>}
  </main>;
}

