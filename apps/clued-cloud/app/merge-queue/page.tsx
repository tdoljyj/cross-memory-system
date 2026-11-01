"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { type Session } from "@supabase/supabase-js";
import { supabase } from "../supabase-browser";
import "../contexts/contexts.css";
import "../confirm/owner.css";

// Merge queue order (migration 20261031060000, Task a3701d3d; DESIGN.md
// §41.5). One switch per account: fifo (default) merges waiting pull requests
// in the order they joined; priority merges them by their Task's automatic
// priority. The one at the front is never displaced, and switching never
// changes it. Both RPCs run as this signed-in account session; Bindings and
// delegated OAuth logins are refused. The change carries the version the
// page showed, so a stale page never flips a newer setting.
type Json = Record<string, unknown>;
type Ordering = "fifo" | "priority";
type Setting = { ordering: Ordering; version: number; isDefault: boolean; updatedAt: string | null };
type Entry = { claimId: string; title: string; state: string; position: number; pr: string | null;
  holder: string | null; autoPriority: number | null };
type Queue = { ref: string; entries: Entry[] };
type View = { setting: Setting; queues: Queue[] };
const object = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const MESSAGES: Record<string, string> = {
  direct_human_session_required: "需要你本人直接登录 BeamingFace，授权给应用的登录不能查看或切换合并顺序。",
  merge_queue_setting_session_required: "当前登录缺少会话信息，请退出后重新登录。",
  merge_queue_setting_version_conflict: "合并顺序在你打开页面后被改过，已显示最新状态，请确认后再切换。",
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

function parseSetting(value: unknown): Setting {
  if (!object(value) || (value.ordering !== "fifo" && value.ordering !== "priority") || typeof value.version !== "number")
    throw new RequestFailure("服务返回了无法识别的结果。");
  return { ordering: value.ordering, version: value.version, isDefault: value.default === true,
    updatedAt: typeof value.updated_at === "string" ? value.updated_at : null };
}

function parseEntry(value: unknown): Entry {
  if (!object(value) || typeof value.claim_id !== "string" || typeof value.position !== "number")
    throw new RequestFailure("服务返回了无法识别的结果。");
  return { claimId: value.claim_id, title: typeof value.task_title === "string" ? value.task_title : "（没有标题的任务）",
    state: typeof value.state === "string" ? value.state : "", position: value.position,
    pr: typeof value.bound_pr === "string" ? value.bound_pr : null,
    holder: typeof value.holder_label === "string" ? value.holder_label : null,
    autoPriority: typeof value.auto_priority === "number" ? value.auto_priority : null };
}

function parseView(value: Json): View {
  if (!Array.isArray(value.queues)) throw new RequestFailure("服务返回了无法识别的结果。");
  return { setting: parseSetting(value.setting), queues: value.queues.map((queue) => {
    if (!object(queue) || typeof queue.ref !== "string" || !Array.isArray(queue.entries))
      throw new RequestFailure("服务返回了无法识别的结果。");
    return { ref: queue.ref, entries: queue.entries.map(parseEntry) };
  }) };
}

// merge:<owner>/<name>:<branch> in plain words.
function queueName(ref: string): string {
  const match = /^merge:([^:]+):(.+)$/.exec(ref);
  return match ? match[1] + " 的 " + match[2] + " 分支" : ref;
}

const ORDERING_TITLE: Record<Ordering, string> = { fifo: "按排队先后", priority: "按任务优先级" };

export default function MergeQueuePage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<View | null>(null);
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
      setView(null); setError(""); setNotice(""); setWorking(false);
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
      const value = parseView(await rpc("clued_merge_queue_v1", {}));
      if (epoch.current === generation) setView(value);
    } catch (failure) {
      if (epoch.current === generation) setError(failure instanceof RequestFailure ? failure.message : "暂时无法读取合并排队。");
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  async function turn(ordering: Ordering) {
    if (!current.current || working || !view) return;
    const generation = epoch.current;
    setWorking(true); setError(""); setNotice("");
    let reload = false;
    try {
      const value = await rpc("clued_merge_queue_ordering_set_v1", { ordering, base_version: view.setting.version });
      if (epoch.current !== generation) return;
      const setting = parseSetting(value);
      setView((previous) => previous ? { ...previous, setting } : previous);
      setNotice("已改为" + ORDERING_TITLE[ordering] + "，立即生效；排在第一位的不变。");
      reload = true;
    } catch (failure) {
      if (epoch.current !== generation) return;
      setError(failure instanceof RequestFailure ? failure.message : "结果未知，请刷新页面核对。");
      reload = true;
    } finally { if (epoch.current === generation) setWorking(false); }
    if (reload && epoch.current === generation) await load(true);
  }

  const setting = view?.setting ?? null;
  const other: Ordering = setting?.ordering === "priority" ? "fifo" : "priority";
  return <main className="context-page owner-confirm">
    <header><Link href="/">BeamingFace</Link> <Link href="/work-claims">谁在做哪个任务</Link> <Link href="/agent-messages">Agent 消息</Link></header>
    <h1>合并排队</h1>
    <p className="context-muted">同一个分支一次只合并一个拉取请求，其余的排队等候。这里决定排在第一位之后的拉取请求按什么顺序轮到：按排队先后，或按它所属任务的自动优先级（数字大的先，一样大的按排队先后，没有优先级的排在最后）。任务优先级变了，在排队下一次有变动时（有人加入、离开或续期）生效。</p>
    <p className="context-muted">已经排在第一位的那个不会被后来的插队，切换顺序也不会换掉它，它合并、关闭或超时离开后才轮到下一个。新账号默认按排队先后。只有你本人登录 BeamingFace 才能在这里切换，Agent 改不了。</p>
    {!ready ? <p role="status">正在读取登录状态…</p> : !session ? <p><Link href="/">登录 BeamingFace</Link> 后管理合并排队。</p> : <>
      <p className="context-muted">已登录 {session.user.email || session.user.id}</p>
      <section aria-label="合并顺序" className="owner-note">
        {setting === null ? <p role="status">{working ? "正在读取…" : "暂未读到合并顺序。"}</p> : <>
          <p>现在：<strong>{ORDERING_TITLE[setting.ordering]}</strong>{setting.isDefault ? "（默认）" : ""}</p>
          {setting.updatedAt && <p className="context-muted">上次更改：{new Date(setting.updatedAt).toLocaleString("zh-CN")}</p>}
          <div className="owner-actions">
            <button type="button" disabled={working} onClick={() => void turn(other)}>改为{ORDERING_TITLE[other]}</button>
          </div>
        </>}
      </section>
      {view && <section aria-label="排队情况">
        <h2>排队情况</h2>
        {view.queues.length === 0 ? <p className="context-muted">现在没有排队的拉取请求。</p> : view.queues.map((queue) =>
          <div key={queue.ref}>
            <p><strong>{queueName(queue.ref)}</strong></p>
            <ol>
              {queue.entries.map((entry) => <li key={entry.claimId}>
                {entry.state === "head" ? "第一位，正在合并" : "第 " + entry.position + " 位，等候"}
                {" · "}{entry.title}
                {entry.pr ? " · 拉取请求 " + entry.pr : " · 还没有拉取请求"}
                {" · 自动优先级 "}{entry.autoPriority === null ? "无" : String(entry.autoPriority)}
                {entry.holder ? " · " + entry.holder : ""}
              </li>)}
            </ol>
          </div>)}
      </section>}
      <button type="button" disabled={working} onClick={() => void load()}>刷新</button>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </>}
  </main>;
}
