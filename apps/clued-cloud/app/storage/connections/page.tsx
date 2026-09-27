"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "../../supabase-browser";
type Connection = { id: string; provider: string; state: string; version: number; profile_id: string };
async function request(path: string, body: object) {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error("请先登录 Clued，再返回此页。");
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + data.session.access_token },
    body: JSON.stringify(body), cache: "no-store", redirect: "error" });
  if (!response.ok) throw new Error(response.status === 404 ? "账号存储连接尚未开放，原入口未切换。" : "操作未确认，请刷新状态后检查；不会自动重试或放宽权限。");
  const value: unknown = await response.json();
  const current = await supabase.auth.getSession();
  if (current.error || current.data.session?.user.id !== data.session.user.id) throw new Error("账号已变化，请重新读取连接。");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("响应未确认。");
  return value as Record<string, unknown>;
}
const labels: Record<string, string> = { awaiting_provider: "等待 Google 授权", active: "Google 连接已建立（不代表文件写入已启用）", reauthorization_required: "需要重新授权", revoked: "已停用" };
export default function StorageConnections() {
  const [connections, setConnections] = useState<Connection[]>([]), [message, setMessage] = useState("正在读取……"), [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const epoch = ++revision.current;
    setBusy(true);
    try { const result = await request("/v1/storage/account", { action: "list" });
      if (epoch !== revision.current) return;
      if (!Array.isArray(result.connections) || !result.connections.every(c => c && typeof c.id === "string" && typeof c.provider === "string" && typeof c.state === "string" && Number.isSafeInteger(c.version))) throw new Error("连接列表未确认。");
      setConnections(result.connections); setMessage(result.connections.length ? "" : "暂无已登记连接。请先完成受治理目录登记。");
    } catch (error) { if (epoch === revision.current) { setConnections([]); setMessage(error instanceof Error ? error.message : "无法读取连接。"); } }
    finally { if (epoch === revision.current) setBusy(false); }
  }, []);
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange(() => {
      ++revision.current; setConnections([]);
      // Do not await Supabase calls from inside its auth callback lock.
      queueMicrotask(() => { void refresh(); });
    });
    void refresh();
    return () => { ++revision.current; data.subscription.unsubscribe(); };
  }, [refresh]);
  async function operate(c: Connection, revoke: boolean) {
    if (revoke && !window.confirm("停用这条账号存储连接？这会阻止该连接后续的新执行和续签；已开始的操作需要核对回执。")) return;
    setBusy(true);
    const epoch = revision.current;
    try {
      if (revoke) { await request("/v1/storage/account", { action: "revoke_connection", connection_id: c.id, base_version: c.version, idempotency_key: crypto.randomUUID() }); if (epoch === revision.current) await refresh(); }
      else {
        const result = await request("/v1/storage/google/start", { connection_id: c.id });
        if (epoch !== revision.current) return;
        if (typeof result.authorization_url !== "string") throw new Error("授权地址未确认。");
        const url = new URL(result.authorization_url);
        if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth") throw new Error("授权地址未确认。");
        window.location.assign(url.href);
      }
    } catch (error) { if (epoch === revision.current) setMessage(error instanceof Error ? error.message : "操作未确认。"); }
    finally { if (epoch === revision.current) setBusy(false); }
  }
  return <main className="mx-auto max-w-3xl px-6 py-16"><h1 className="text-2xl font-semibold">账号存储连接</h1>
    <p className="my-4">权限统一归属 Clued 账号；手机、平板和电脑使用同一份服务端规则。Google 凭据不下发到设备。</p>
    <p role="status" className="my-4">{message}</p>
    {connections.map(c => <section className="my-4 rounded-xl border p-4" key={c.id}>
      <h2>{c.provider} · {labels[c.state] ?? "状态待确认"}</h2><p className="my-2 break-all text-sm">连接：{c.id}</p>
      {c.state !== "revoked" && <div className="flex gap-4"><button disabled={busy} onClick={() => void operate(c, false)}>连接 / 重新授权 Google</button>
        <button disabled={busy} onClick={() => void operate(c, true)}>停用连接</button></div>}
    </section>)}
    <div className="mt-6 flex gap-4"><button disabled={busy} onClick={() => void refresh()}>刷新状态</button><Link href="/">返回 Clued 登录页</Link></div>
  </main>;
}
