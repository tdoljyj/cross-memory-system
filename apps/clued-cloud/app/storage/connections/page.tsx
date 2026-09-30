"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../../supabase-browser";

type Connection = {
  id: string; version: number; provider: string; state: string; auth_mode: string;
  root_name: string; policy_active: boolean; actions: string[];
  refresh_enabled: boolean; database_execution_enabled: boolean; profile_current: boolean;
};
const actionName: Record<string, string> = {
  inspect: "查看任务状态", create_file: "新建文件", create_topic: "新建主题目录", modify: "改名、移动文件",
};
const stateName: Record<string, string> = {
  awaiting_provider: "等待 Google 授权", active: "已连接", reauthorization_required: "需要重新授权", revoked: "已断开",
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function isConnection(value: unknown): value is Connection {
  return isObject(value) && typeof value.id === "string" && Number.isSafeInteger(value.version)
    && typeof value.provider === "string" && typeof value.state === "string"
    && typeof value.auth_mode === "string" && typeof value.root_name === "string"
    && typeof value.policy_active === "boolean" && typeof value.refresh_enabled === "boolean"
    && typeof value.database_execution_enabled === "boolean" && typeof value.profile_current === "boolean"
    && Array.isArray(value.actions) && value.actions.every(action => typeof action === "string" && Object.hasOwn(actionName, action));
}
async function accountRequest(body: object, path = "/v1/storage/owner") {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error("请登录 Clued 后重新读取连接。");
  const response = await fetch(path, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + data.session.access_token },
    body: JSON.stringify(body), cache: "no-store", redirect: "error",
  });
  if (!response.ok) throw new Error("结果未确认，请重新读取连接状态；不要重复提交。");
  const result: unknown = await response.json();
  const latest = await supabase.auth.getSession();
  if (latest.error || latest.data.session?.user.id !== data.session.user.id) throw new Error("账号已变化，请重新读取。");
  if (!isObject(result)) throw new Error("连接状态未确认。");
  return result;
}
type ReadAccess = { active: boolean; read_generation: number; disclosure_version: string; content_disclosure_version: string; classes: string[] };
function isReadAccess(value: unknown): value is ReadAccess {
  return isObject(value) && typeof value.active === "boolean" && Number.isSafeInteger(value.read_generation)
    && typeof value.disclosure_version === "string" && typeof value.content_disclosure_version === "string"
    && Array.isArray(value.classes) && value.classes.every(item => typeof item === "string");
}
type WriteAccess = { active: boolean; policy_generation: number; disclosure_version: string; classes: string[] };
function isWriteAccess(value: unknown): value is WriteAccess {
  return isObject(value) && typeof value.active === "boolean" && Number.isSafeInteger(value.policy_generation)
    && typeof value.disclosure_version === "string"
    && Array.isArray(value.classes) && value.classes.every(item => item === "modify");
}
export default function StorageConnections() {
  // Read level (StorageFullCapability P1) is loaded on demand per connection so
  // the everyday page stays one request; every change is a native CAS mutation.
  const [readAccess, setReadAccess] = useState<Record<string, ReadAccess>>({});
  // Write level (P3): changing it replaces the account policy, so the page
  // always reloads the connection list and both settings afterwards.
  const [writeAccess, setWriteAccess] = useState<Record<string, WriteAccess>>({});
  const [connections, setConnections] = useState<Connection[]>([]);
  const [workerEnabled, setWorkerEnabled] = useState(false);
  const [message, setMessage] = useState("正在读取连接……");
  const [busy, setBusy] = useState(false);
  const [defaultRefresh, setDefaultRefresh] = useState(false);
  const revision = useRef(0), operation = useRef(false);
  const refresh = useCallback(async () => {
    const epoch = ++revision.current;
    setBusy(true);
    try {
      const result = await accountRequest({ action: "connections" });
      if (epoch !== revision.current) return;
      if (!Array.isArray(result.connections) || !result.connections.every(isConnection)
        || typeof result.worker_execution_enabled !== "boolean") throw new Error("连接摘要未确认。");
      setConnections(result.connections);
      setWorkerEnabled(result.worker_execution_enabled);
      setMessage(result.connections.length ? "" : "暂无存储连接；受治理目录登记请进入管理入口。");
      return result.connections as Connection[];
    } catch (error) {
      if (epoch === revision.current) {
        setConnections([]); setWorkerEnabled(false);
        setMessage(error instanceof Error ? error.message : "连接状态未确认。");
      }
      return null;
    } finally { if (epoch === revision.current) setBusy(false); }
  }, []);
  useEffect(() => {
    let disposed = false;
    const { data } = supabase.auth.onAuthStateChange(() => {
      if (disposed) return;
      ++revision.current; setConnections([]); setWorkerEnabled(false);
      queueMicrotask(() => { if (!disposed) void refresh(); });
    });
    queueMicrotask(() => { if (!disposed) void refresh(); });
    return () => { disposed = true; ++revision.current; data.subscription.unsubscribe(); };
  }, [refresh]);
  async function connect(c: Connection) {
    if (operation.current || busy || !["awaiting_provider", "reauthorization_required"].includes(c.state)) return;
    const enrollRefresh = c.state === "awaiting_provider" && defaultRefresh;
    if (enrollRefresh && !window.confirm("连接后允许 Clued 服务端按既有范围后台续签，直到主动停用？")) return;
    operation.current = true; setBusy(true);
    const epoch = revision.current;
    try {
      const result = await accountRequest({ connection_id: c.id,
        ...(c.state === "awaiting_provider" ? { default_refresh: enrollRefresh } : {}) }, "/v1/storage/google/start");
      if (epoch !== revision.current || typeof result.authorization_url !== "string") return;
      const url = new URL(result.authorization_url);
      if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth" || url.username || url.password)
        throw new Error("授权地址未确认。");
      window.location.assign(url.href);
    } catch { if (epoch === revision.current) setMessage("Google 连接请求未确认，请刷新状态后核对。"); }
    finally { operation.current = false; if (epoch === revision.current) setBusy(false); }
  }
  async function loadReadAccess(c: Connection) {
    if (operation.current || busy) return;
    operation.current = true; setBusy(true);
    const epoch = revision.current;
    try {
      // The write level is optional here: its failure never hides the read settings.
      const [result, write] = await Promise.all([
        accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/read-access"),
        accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/write-access").catch(() => null)]);
      if (epoch !== revision.current) return;
      if (!isReadAccess(result)) throw new Error("查看设置未确认。");
      setReadAccess(current => ({ ...current, [c.id]: result }));
      if (isWriteAccess(write)) setWriteAccess(current => ({ ...current, [c.id]: write }));
    } catch { if (epoch === revision.current) setMessage("Agent 查看设置未确认，请稍后重试。"); }
    finally { operation.current = false; if (epoch === revision.current) setBusy(false); }
  }
  // level "read": file names and structure; "read_content": also text file bodies (P2).
  async function toggleRead(c: Connection, level: "read" | "read_content" = "read") {
    const current = readAccess[c.id];
    if (operation.current || busy || !current) return;
    const content = current.active && current.classes.includes("read_content");
    const enable = level === "read" ? !current.active : !content;
    if (!window.confirm(level === "read"
      ? (enable ? "允许已授权的 Agent 查看此目录内的文件名、类型和目录结构？不读取文件内容，不修改任何文件；可随时停止。"
        : "停止 Agent 查看此目录的文件名和目录结构？读正文也会一并停止。已经返回给 Agent 的结果无法收回。")
      : (enable ? "允许已授权的 Agent 读取此目录内由 Clued 创建的文本文件正文（每次最多 256 KB，每个已授权 Agent 连接每小时最多 8 MB）？正文会发送给该 Agent 所用的模型服务；不修改任何文件；可随时停止。"
        : "停止 Agent 读取文件正文？仍可查看文件名和目录结构。已经返回给 Agent 的内容无法收回。"))) return;
    const classes = level === "read" ? (enable ? ["read"] : []) : (enable ? ["read", "read_content"] : ["read"]);
    operation.current = true; setBusy(true);
    const epoch = revision.current;
    try {
      const result = await accountRequest({ action: "set_classes", connection_id: c.id, classes,
        base_generation: current.read_generation,
        disclosure_version: classes.includes("read_content") ? current.content_disclosure_version : current.disclosure_version,
        idempotency_key: crypto.randomUUID() },
      "/v1/storage/read-access");
      if (epoch !== revision.current) return;
      if (result.status !== "committed" || typeof result.receipt_id !== "string") throw new Error("回执未确认。");
      const latest = await accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/read-access");
      if (epoch !== revision.current) return;
      if (!isReadAccess(latest)) throw new Error("查看设置未确认。");
      setReadAccess(state => ({ ...state, [c.id]: latest }));
      const applied = level === "read" ? latest.active === enable : (latest.active && latest.classes.includes("read_content")) === enable;
      setMessage(applied ? `${enable ? "已允许" : "已停止"} Agent ${level === "read" ? "查看目录结构" : "读正文"}。回执：${result.receipt_id}`
        : "已提交，但最新状态未确认。请核对原回执。");
    } catch {
      if (epoch === revision.current) {
        setReadAccess(state => { const next = { ...state }; delete next[c.id]; return next; });
        setMessage("Agent 查看设置结果未确认。请重新读取设置并核对，勿重复提交。");
      }
    } finally { operation.current = false; if (epoch === revision.current) setBusy(false); }
  }
  async function toggleModify(c: Connection) {
    const current = writeAccess[c.id];
    if (operation.current || busy || !current?.active) return;
    const enable = !current.classes.includes("modify");
    if (!window.confirm(enable
      ? "允许已授权的 Agent 在此目录内改名和移动由 Clued 创建的文件？每次操作都会留下回执，可以再改回原名或原位置；不会删除或覆盖文件内容。尚未开始的排队任务会被取消，已开始但未完成的任务需先结束；可随时停止。"
      : "停止 Agent 改名和移动文件？尚未开始的排队任务会被取消，已开始但未完成的任务需先结束。新建文件和查看设置不受影响。")) return;
    operation.current = true; setBusy(true);
    const epoch = revision.current;
    let settled = epoch;
    try {
      const result = await accountRequest({ action: "set_classes", connection_id: c.id, classes: enable ? ["modify"] : [],
        base_generation: current.policy_generation, disclosure_version: current.disclosure_version,
        idempotency_key: crypto.randomUUID() }, "/v1/storage/write-access");
      if (epoch !== revision.current) return;
      if (result.status !== "committed" || typeof result.receipt_id !== "string") throw new Error("回执未确认。");
      // refresh() starts a new revision and clears busy; the readback belongs
      // to that revision, and the operation keeps the page busy until it ends.
      const reloadedList = await refresh();
      // undefined: a newer revision (sign-in change) superseded this reload.
      if (reloadedList === undefined) return;
      const reloaded = revision.current;
      settled = reloaded; setBusy(true);
      if (reloadedList === null) throw new Error("连接摘要未确认。");
      const [latest, read] = await Promise.all([
        accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/write-access"),
        accountRequest({ action: "status", connection_id: c.id }, "/v1/storage/read-access")]);
      if (reloaded !== revision.current) return;
      if (!isWriteAccess(latest) || !isReadAccess(read)) throw new Error("修改设置未确认。");
      setWriteAccess(state => ({ ...state, [c.id]: latest }));
      setReadAccess(state => ({ ...state, [c.id]: read }));
      setMessage(latest.classes.includes("modify") === enable
        ? `${enable ? "已允许" : "已停止"} Agent 改名和移动文件。回执：${result.receipt_id}` : "已提交，但最新状态未确认。请核对原回执。");
    } catch {
      // The policy (and the read access bound to it) may have changed: drop both.
      setWriteAccess(state => { const next = { ...state }; delete next[c.id]; return next; });
      setReadAccess(state => { const next = { ...state }; delete next[c.id]; return next; });
      if (settled === revision.current) {
        setMessage("Agent 修改设置结果未确认。若此目录有已开始但未完成的任务，请等它结束后再试。请重新读取设置并核对，勿重复提交。");
      }
    } finally { operation.current = false; if (settled === revision.current) setBusy(false); }
  }
  async function disconnect(c: Connection) {
    if (operation.current || busy || c.state === "revoked") return;
    if (!window.confirm("断开整个网盘连接？会停止此连接的后续存储操作与后台续签，不删除 Google Drive 文件。已开始的操作可能仍需核对原回执；断开后不再允许读取提供方来恢复未确认的结果。")) return;
    operation.current = true; setBusy(true);
    const epoch = revision.current;
    try {
      const result = await accountRequest({ action: "disconnect", connection_id: c.id, base_version: c.version,
        idempotency_key: crypto.randomUUID() });
      if (epoch !== revision.current) return;
      if (result.status !== "committed" || typeof result.receipt_id !== "string") throw new Error("断开回执未确认。");
      const latest = await refresh();
      const stopped = latest?.find(item => item.id === c.id);
      setMessage(stopped?.state === "revoked" && !stopped.policy_active && !stopped.refresh_enabled
        ? `网盘连接已断开。回执：${result.receipt_id}` : "断开已提交，但最新状态未确认。请核对原回执。");
    } catch {
      if (epoch === revision.current) { await refresh(); setMessage("断开结果未确认。请核对最新状态与原回执，勿重复提交。"); }
    } finally { operation.current = false; if (epoch === revision.current) setBusy(false); }
  }
  return <main className="mx-auto max-w-3xl px-6 py-16">
    <h1 className="text-2xl font-semibold">存储连接</h1>
    <p className="my-4">Google Drive 的授权属于当前 Clued 账号。这里显示已登记范围与实际执行状态。</p>
    <p role="status" className="my-4">{message}</p>
    {connections.map(c => {
      const available = c.state === "active" && c.auth_mode === "account_policy" && c.policy_active
        && c.profile_current && c.database_execution_enabled && workerEnabled;
      return <section key={c.id} className="my-4 rounded-xl border p-4">
        <h2 className="font-semibold">{c.provider === "google-drive" ? "Google Drive" : c.provider} · {stateName[c.state] ?? "状态待确认"}</h2>
        <p className="my-2">已登记范围：{c.root_name}</p>
        <p>账号允许的操作：{c.policy_active && c.actions.length ? c.actions.map(action => actionName[action]).join("、") : "无当前可用授权"}</p>
        <p role="status" className="my-2">{available ? "存储执行入口已开启；每项操作仍须通过当前目录、客户端和单次任务准入。" : "当前文件操作不可用或暂停；连接状态不代表写入已启用。"}</p>
        <p className="my-2 text-sm">后台续签：{c.refresh_enabled ? "开启" : "关闭"}。</p>
        {c.state === "awaiting_provider" && <label className="my-2 block">
          <input type="checkbox" disabled={busy} checked={defaultRefresh} onChange={event => setDefaultRefresh(event.target.checked)} />
          连接后开启后台续签</label>}
        {["awaiting_provider", "reauthorization_required"].includes(c.state) &&
          <button disabled={busy} onClick={() => void connect(c)}>连接／重新授权 Google</button>}
        {c.state === "active" && c.auth_mode === "account_policy" && c.policy_active && <div className="my-2">
          <p>Agent 查看目录结构：{readAccess[c.id] ? (readAccess[c.id].active
            ? (readAccess[c.id].classes.includes("read_content") ? "已允许" : "已允许（只看文件名和目录，不读内容）") : "未允许") : "未读取"}</p>
          {readAccess[c.id]
            ? <button disabled={busy} onClick={() => void toggleRead(c)}>{readAccess[c.id].active ? "停止 Agent 查看目录结构" : "允许 Agent 查看目录结构"}</button>
            : <button disabled={busy} onClick={() => void loadReadAccess(c)}>读取 Agent 查看设置</button>}
          {readAccess[c.id]?.active && <>
            <p className="mt-2">Agent 读正文：{readAccess[c.id].classes.includes("read_content") ? "已允许（仅 Clued 创建的文本文件）" : "未允许"}</p>
            <button disabled={busy} onClick={() => void toggleRead(c, "read_content")}>
              {readAccess[c.id].classes.includes("read_content") ? "停止 Agent 读正文" : "允许 Agent 读正文"}</button>
          </>}
          {writeAccess[c.id]?.active && <>
            <p className="mt-2">Agent 改名和移动文件：{writeAccess[c.id].classes.includes("modify") ? "已允许（仅 Clued 创建的文件）" : "未允许"}</p>
            <button disabled={busy} onClick={() => void toggleModify(c)}>
              {writeAccess[c.id].classes.includes("modify") ? "停止 Agent 改名和移动文件" : "允许 Agent 改名和移动文件"}</button>
          </>}
        </div>}
        {["active", "reauthorization_required"].includes(c.state) && <button disabled={busy} onClick={() => void disconnect(c)}>断开网盘连接</button>}
      </section>;
    })}
    <div className="mt-6 flex gap-4"><button disabled={busy} onClick={() => void refresh()}>刷新状态</button>
      <Link href="/storage/admin">存储管理</Link><Link href="/oauth/connections">已连接应用／客户端管理</Link></div>
  </main>;
}
