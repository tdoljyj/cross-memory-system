"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../../supabase-browser";

type Connection = {
  id: string; version: number; provider: string; state: string; auth_mode: string;
  root_name: string; policy_active: boolean; actions: string[];
  refresh_enabled: boolean; database_execution_enabled: boolean; profile_current: boolean;
};
const actionName: Record<string, string> = { inspect: "查看任务状态", create_file: "新建文件", create_topic: "新建主题目录" };
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
export default function StorageConnections() {
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
        {c.state !== "revoked" && <button disabled={busy} onClick={() => void disconnect(c)}>断开网盘连接</button>}
      </section>;
    })}
    <div className="mt-6 flex gap-4"><button disabled={busy} onClick={() => void refresh()}>刷新状态</button>
      <Link href="/storage/admin">存储管理</Link><Link href="/oauth/connections">已连接应用／客户端管理</Link></div>
  </main>;
}
