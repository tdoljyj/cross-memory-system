"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { type Session } from "@supabase/supabase-js";
import { supabase } from "../supabase-browser";
import "../contexts/contexts.css";
import "../confirm/owner.css";

// Agent messages switch (migration 20261008190000, Task 17a8649b, Owner
// Decision 2bacda7a). One switch per account, on by default: on, the account's
// Agents write to each other through Clued without asking the Owner each time;
// off, Clued refuses new messages and replies. Both RPCs run as this signed-in
// account session; Bindings and delegated OAuth logins are refused, so no
// Agent can turn it. The change carries the version the page showed, so a
// stale page never flips a newer setting.
type Json = Record<string, unknown>;
type Setting = { enabled: boolean; version: number; isDefault: boolean; updatedAt: string | null };
const object = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const MESSAGES: Record<string, string> = {
  direct_human_session_required: "需要你本人直接登录 BeamingFace，授权给应用的登录不能切换这个开关。",
  agent_messages_setting_session_required: "当前登录缺少会话信息，请退出后重新登录。",
  agent_messages_setting_version_conflict: "开关在你打开页面后被改过，已显示最新状态，请确认后再切换。",
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

function parse(value: Json): Setting {
  if (typeof value.enabled !== "boolean" || typeof value.version !== "number") throw new RequestFailure("服务返回了无法识别的结果。");
  return { enabled: value.enabled, version: value.version, isDefault: value.default === true,
    updatedAt: typeof value.updated_at === "string" ? value.updated_at : null };
}

export default function AgentMessagesPage() {
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
    setWorking(true);
    if (!keepMessages) { setError(""); setNotice(""); }
    try {
      const value = parse(await rpc("clued_agent_messages_setting_v1", {}));
      if (epoch.current === generation) setSetting(value);
    } catch (failure) {
      if (epoch.current === generation) setError(failure instanceof RequestFailure ? failure.message : "暂时无法读取开关状态。");
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  async function turn(enabled: boolean) {
    if (!current.current || working || !setting) return;
    const generation = epoch.current;
    setWorking(true); setError(""); setNotice("");
    let reload = false;
    try {
      const value = await rpc("clued_agent_messages_setting_set_v1", { enabled, base_version: setting.version });
      if (epoch.current !== generation) return;
      setSetting(parse(value));
      setNotice(enabled ? "已打开，立即生效。" : "已关闭，立即生效。");
    } catch (failure) {
      if (epoch.current !== generation) return;
      setError(failure instanceof RequestFailure ? failure.message : "结果未知，请刷新页面核对。");
      reload = true;
    } finally { if (epoch.current === generation) setWorking(false); }
    if (reload && epoch.current === generation) await load(true);
  }

  return <main className="context-page owner-confirm">
    <header><Link href="/">BeamingFace</Link> <Link href="/grants">我的授权</Link> <Link href="/work-claims">谁在做哪个任务</Link></header>
    <h1>Agent 消息</h1>
    <p className="context-muted">打开时，你账号下的 Agent（Claude Code、Codex 等）在你已授权的工作里，可以通过 BeamingFace 互相发协调消息，比如问对方修复进度、请对方释放占用的文件、排合并顺序，不用每条都来问你。消息只是 Agent 之间的请求，不算你的决定，也不给任何 Agent 增加权限。</p>
    <p className="context-muted">关闭后，BeamingFace 会拒绝新的消息和回复，Agent 会改为把需要协调的事告诉你；已经收到的消息仍然可以读。新账号默认打开。只有你本人登录 BeamingFace 才能在这里切换，Agent 改不了。</p>
    {!ready ? <p role="status">正在读取登录状态…</p> : !session ? <p><Link href="/">登录 BeamingFace</Link> 后管理 Agent 消息。</p> : <>
      <p className="context-muted">已登录 {session.user.email || session.user.id}</p>
      <section aria-label="开关" className="owner-note">
        {setting === null ? <p role="status">{working ? "正在读取…" : "暂未读到开关状态。"}</p> : <>
          <p><strong>{setting.enabled ? "已打开" : "已关闭"}</strong>{setting.isDefault ? "（默认）" : ""}</p>
          {setting.updatedAt && <p className="context-muted">上次更改：{new Date(setting.updatedAt).toLocaleString("zh-CN")}</p>}
          <div className="owner-actions">
            <button type="button" disabled={working} onClick={() => void turn(!setting.enabled)}>
              {setting.enabled ? "关闭 Agent 消息" : "打开 Agent 消息"}</button>
          </div>
        </>}
      </section>
      <button type="button" disabled={working} onClick={() => void load()}>刷新</button>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </>}
  </main>;
}
