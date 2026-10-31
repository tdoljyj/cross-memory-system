"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { type Session } from "@supabase/supabase-js";
import { supabase } from "../supabase-browser";
import "../contexts/contexts.css";
import "../confirm/owner.css";

// Priority page (migration 20261031070000, Task a72ecb24, Owner Decision
// be5d5b6c). Every Task has an automatic score (MTPE); the Owner may add a
// custom priority 0-100 that counts 0.3 into it and puts the record first in
// record lists. The Owner sets it here, or an Agent sets it on the Owner's
// explicit request with the Owner's words; each value shows where it came
// from and the latest change of a record is undone in one step. All three
// RPCs run as this signed-in account session; Bindings and delegated OAuth
// logins are refused. Changes carry the version the page showed.
type Json = Record<string, unknown>;
type Custom = { priority: number; version: number; source: string | null; ownerInstruction: string | null;
  agentName: string | null; updatedAt: string | null; undoAvailable: boolean };
type Item = { recordId: string; title: string; recordType: string; projectName: string | null; bucket: string | null;
  total: number | null; customPoints: number; custom: Custom };
type Change = { id: number; recordId: string; title: string; priority: number; previousPriority: number; source: string;
  ownerInstruction: string | null; agentName: string | null; createdAt: string };
const object = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => typeof value === "string" ? value : null;
const MESSAGES: Record<string, string> = {
  direct_human_session_required: "需要你本人直接登录 BeamingFace，授权给应用的登录不能改优先级。",
  custom_priority_session_required: "当前登录缺少会话信息，请退出后重新登录。",
  custom_priority_version_conflict: "这一条在你打开页面后被改过，已显示最新的值，请确认后再改。",
  custom_priority_nothing_to_undo: "这一条还没有可以撤回的修改。",
  custom_priority_record_not_active: "这一条已经结束或关闭，不能再设优先级。",
  custom_priority_record_not_found: "找不到这一条，可能已被删除，请刷新。",
  custom_priority_input_invalid: "请填 0 到 100 之间的整数（0 表示不设）。",
};
const TYPES: Record<string, string> = { task: "任务", decision: "决定", state: "状态", note: "笔记", profile_fact: "个人信息" };
class RequestFailure extends Error { constructor(message: string, readonly code = "") { super(message); } }

async function rpc(name: string, input: Json): Promise<Json> {
  let result: { data: unknown; error: { message?: string; code?: string } | null };
  try {
    result = await supabase.rpc(name, { p_input: input });
  } catch { throw new RequestFailure("网络请求未完成，请刷新后查看结果。"); }
  if (result.error) {
    const code = result.error.message ?? "";
    throw new RequestFailure(MESSAGES[code] ?? (result.error.code ? "请求被拒绝（" + code + "）。" : "网络请求未完成，请刷新后查看结果。"), code);
  }
  const value = result.data;
  if (!object(value)) throw new RequestFailure("服务返回了无法识别的结果。");
  if (value.status === "rejected" || value.status === "failed") {
    const code = typeof value.error_code === "string" ? value.error_code : String(value.status);
    throw new RequestFailure(MESSAGES[code] ?? "请求被拒绝（" + code + "）。", code);
  }
  return value;
}

function parseCustom(value: unknown): Custom {
  if (!object(value) || typeof value.priority !== "number" || typeof value.version !== "number") throw new RequestFailure("服务返回了无法识别的结果。");
  return { priority: value.priority, version: value.version, source: text(value.source), ownerInstruction: text(value.owner_instruction),
    agentName: text(value.agent_name), updatedAt: text(value.updated_at), undoAvailable: value.undo_available === true };
}

function parseOverview(value: Json): { items: Item[]; history: Change[] } {
  if (!Array.isArray(value.records) || !Array.isArray(value.history)) throw new RequestFailure("服务返回了无法识别的结果。");
  const items = value.records.map((entry): Item => {
    if (!object(entry) || typeof entry.record_id !== "string") throw new RequestFailure("服务返回了无法识别的结果。");
    const automatic = object(entry.automatic) ? entry.automatic : null;
    return { recordId: entry.record_id, title: text(entry.title) ?? "（无标题）", recordType: text(entry.record_type) ?? "",
      projectName: text(entry.project_name), bucket: text(entry.execution_bucket),
      total: automatic && typeof automatic.total === "number" ? automatic.total : null,
      customPoints: automatic && typeof automatic.custom_points === "number" ? automatic.custom_points : 0,
      custom: parseCustom(entry.custom) };
  });
  const history = value.history.map((entry): Change => {
    if (!object(entry) || typeof entry.id !== "number" || typeof entry.record_id !== "string" || typeof entry.priority !== "number"
      || typeof entry.previous_priority !== "number" || typeof entry.source !== "string" || typeof entry.created_at !== "string")
      throw new RequestFailure("服务返回了无法识别的结果。");
    return { id: entry.id, recordId: entry.record_id, title: text(entry.title) ?? "（无标题）", priority: entry.priority,
      previousPriority: entry.previous_priority, source: entry.source, ownerInstruction: text(entry.owner_instruction),
      agentName: text(entry.agent_name), createdAt: entry.created_at };
  });
  return { items, history };
}

function sourceLabel(source: string | null, agentName: string | null) {
  if (source === "owner_page") return "你在本页设的";
  if (source === "owner_undo") return "你撤回了上一次修改";
  if (source === "agent_on_owner_request") return (agentName ?? "Agent") + " 按你的要求代设";
  return "未设置";
}
const when = (value: string | null) => value ? new Date(value).toLocaleString("zh-CN") : "";

export default function PriorityPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  const [history, setHistory] = useState<Change[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
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
      setItems(null); setHistory([]); setDrafts({}); setError(""); setNotice(""); setWorking(false);
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
      const value = parseOverview(await rpc("clued_priority_overview_v1", {}));
      if (epoch.current !== generation) return;
      setItems(value.items); setHistory(value.history); setDrafts({});
    } catch (failure) {
      if (epoch.current === generation) setError(failure instanceof RequestFailure ? failure.message : "暂时无法读取优先级。");
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  async function change(item: Item, name: "clued_priority_custom_set_v1" | "clued_priority_custom_undo_v1", priority?: number) {
    if (!current.current || working) return;
    const generation = epoch.current;
    setWorking(true); setError(""); setNotice("");
    let reload = false;
    try {
      const input: Json = { record_id: item.recordId, base_version: item.custom.version };
      if (priority !== undefined) input.priority = priority;
      const value = await rpc(name, input);
      if (epoch.current !== generation) return;
      const custom = parseCustom(value.custom_priority);
      setNotice(value.changed === false ? "没有变化。"
        : name === "clued_priority_custom_undo_v1" ? "已撤回，「" + item.title + "」现在是 " + custom.priority + "。"
          : "已保存，「" + item.title + "」现在是 " + custom.priority + "。");
      reload = true;
    } catch (failure) {
      if (epoch.current !== generation) return;
      setError(failure instanceof RequestFailure ? failure.message : "结果未知，请刷新页面核对。");
      reload = true;
    } finally { if (epoch.current === generation) setWorking(false); }
    if (reload && epoch.current === generation) await load(true);
  }

  function save(item: Item) {
    const raw = (drafts[item.recordId] ?? "").trim();
    if (!/^(0|[1-9][0-9]?|100)$/.test(raw)) { setNotice(""); setError(MESSAGES.custom_priority_input_invalid); return; }
    void change(item, "clued_priority_custom_set_v1", Number(raw));
  }

  return <main className="context-page owner-confirm">
    <header><Link href="/">BeamingFace</Link> <Link href="/grants">我的授权</Link> <Link href="/work-claims">谁在做哪个任务</Link></header>
    <h1>优先级</h1>
    <p className="context-muted">每条任务都有一个<strong>自动分</strong>（0–100）：系统按任务里写的紧急程度、是否卡住别的事、风险、影响面、时间要求和成本自动算出来，用来决定先推荐做什么、合并排队谁在前。</p>
    <p className="context-muted">你可以给任意一条加上<strong>你的优先级</strong>（0–100，0 表示不设）。它按 0.3 倍加进自动分（填 100 就加 30 分），记录列表里设过的也排在最前面。Agent 自己不能填这个数；只有你在这里改，或者你明确让某个 Agent 去改时它才会改，而且会记下你的原话。每次修改都有记录，你可以一键撤回最近一次。</p>
    {!ready ? <p role="status">正在读取登录状态…</p> : !session ? <p><Link href="/">登录 BeamingFace</Link> 后管理优先级。</p> : <>
      <p className="context-muted">已登录 {session.user.email || session.user.id}</p>
      <button type="button" disabled={working} onClick={() => void load()}>刷新</button>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {items === null ? <p role="status">{working ? "正在读取…" : "暂未读到优先级。"}</p> : items.length === 0 ? <p>现在没有进行中的任务。</p> :
        <section aria-label="进行中的任务">
          <table>
            <thead><tr><th>事项</th><th>自动分</th><th>你的优先级</th><th>来源</th><th>修改</th></tr></thead>
            <tbody>{items.map(item => <tr key={item.recordId}>
              <td>{item.title}<br /><span className="context-muted">{[TYPES[item.recordType] ?? item.recordType, item.projectName].filter(Boolean).join(" · ")}</span></td>
              <td>{item.total === null ? "—" : item.total}{item.customPoints > 0 && <span className="context-muted">（含你加的 {item.customPoints}）</span>}</td>
              <td>{item.custom.priority === 0 ? "不设" : item.custom.priority}</td>
              <td>{sourceLabel(item.custom.source, item.custom.agentName)}
                {item.custom.ownerInstruction && <><br /><span className="context-muted">你的原话：「{item.custom.ownerInstruction}」</span></>}
                {item.custom.updatedAt && <><br /><span className="context-muted">{when(item.custom.updatedAt)}</span></>}</td>
              <td>
                <input aria-label={"「" + item.title + "」的优先级"} inputMode="numeric" size={4} placeholder={String(item.custom.priority)}
                  value={drafts[item.recordId] ?? ""} disabled={working}
                  onChange={event => { const value = event.target.value; setDrafts(previous => ({ ...previous, [item.recordId]: value })); }} />
                <button type="button" disabled={working} onClick={() => save(item)}>保存</button>
                {item.custom.undoAvailable && <button type="button" disabled={working} onClick={() => void change(item, "clued_priority_custom_undo_v1")}>撤回上一次修改</button>}
              </td>
            </tr>)}</tbody>
          </table>
        </section>}
      {history.length > 0 && <section aria-label="最近的修改">
        <h2>最近的修改</h2>
        <ul>{history.map(entry => <li key={entry.id}>
          {when(entry.createdAt)}「{entry.title}」：{entry.previousPriority === 0 ? "不设" : entry.previousPriority} → {entry.priority === 0 ? "不设" : entry.priority}，{sourceLabel(entry.source, entry.agentName)}
          {entry.ownerInstruction && <>，你的原话：「{entry.ownerInstruction}」</>}
        </li>)}</ul>
      </section>}
    </>}
  </main>;
}
