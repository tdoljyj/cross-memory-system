"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "../../supabase-browser";

type TransitionStatus = {
  contract: "clued.storage-policy-transition-status/2";
  manifest_id: string;
  connection_id: string;
  manifest_sha256: string;
  expected_inventory_digest: string;
  expires_at: string;
  status: "reviewed" | "committed" | "expired";
  policy_id: string | null;
  transition_receipt_id: string | null;
  policy_receipt_id: string | null;
  execution_permitted: false;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha256 = /^[0-9a-f]{64}$/;
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function isTransitionStatus(value: unknown, manifestId: string): value is TransitionStatus {
  if (!isObject(value) || value.contract !== "clued.storage-policy-transition-status/2" ||
    value.manifest_id !== manifestId || typeof value.connection_id !== "string" || !uuid.test(value.connection_id) ||
    typeof value.manifest_sha256 !== "string" || !sha256.test(value.manifest_sha256) ||
    typeof value.expected_inventory_digest !== "string" || !sha256.test(value.expected_inventory_digest) ||
    typeof value.expires_at !== "string" || !Number.isFinite(Date.parse(value.expires_at)) ||
    !["reviewed", "committed", "expired"].includes(String(value.status)) || value.execution_permitted !== false) return false;
  for (const key of ["policy_id", "transition_receipt_id", "policy_receipt_id"] as const) {
    if (value[key] !== null && (typeof value[key] !== "string" || !uuid.test(value[key]))) return false;
  }
  return true;
}

async function request(body: Record<string, unknown>, owner: string) {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session || data.session.user.id !== owner) throw new Error("请先使用原 BeamingFace 账号登录。");
  const response = await fetch("/v1/storage/policy-transition", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${data.session.access_token}` },
    body: JSON.stringify(body), cache: "no-store", redirect: "error",
  });
  if (!response.ok) throw new Error("账号存储入口切换未确认；不会自动重试或回退到旧入口。");
  const value: unknown = await response.json();
  const current = await supabase.auth.getSession();
  if (current.error || current.data.session?.user.id !== owner) throw new Error("账号已变化，请重新打开原确认链接。");
  return value;
}

export default function StorageTransition() {
  const [status, setStatus] = useState<TransitionStatus | null>(null);
  const [message, setMessage] = useState("正在核对账号存储切换清单……");
  const [busy, setBusy] = useState(true);
  const revision = useRef(0);
  const operationBusy = useRef(false);
  const manifestId = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("manifest") ?? "";

  const inspect = useCallback(async () => {
    const epoch = ++revision.current;
    setBusy(true); setStatus(null);
    if (!uuid.test(manifestId)) { setMessage("切换链接无效；没有执行任何更改。"); setBusy(false); return; }
    try {
      const session = await supabase.auth.getSession();
      const owner = session.data.session?.user.id;
      if (session.error || !owner) throw new Error("请先登录 BeamingFace，再重新打开此确认链接。");
      const value = await request({ action: "describe", manifest_id: manifestId }, owner);
      if (epoch !== revision.current || !isTransitionStatus(value, manifestId)) throw new Error("切换清单状态未确认。");
      setStatus(value);
      setMessage(value.status === "reviewed" ? "清单已核对，等待账号本人确认。" :
        value.status === "committed" ? "账号统一存储入口已启用。" : "切换清单已过期，没有执行任何更改。");
    } catch (error) {
      if (epoch === revision.current) setMessage(error instanceof Error ? error.message : "切换清单状态未确认。");
    } finally { if (epoch === revision.current) setBusy(false); }
  }, [manifestId]);

  useEffect(() => {
    let disposed = false;
    const liveRevision = revision;
    const schedule = () => queueMicrotask(() => { if (!disposed) void inspect(); });
    const { data } = supabase.auth.onAuthStateChange(() => { ++revision.current; setStatus(null); schedule(); });
    schedule();
    return () => { disposed = true; ++liveRevision.current; data.subscription.unsubscribe(); };
  }, [inspect]);

  async function confirmTransition() {
    if (operationBusy.current || busy || status?.status !== "reviewed" || Date.parse(status.expires_at) <= Date.now()) return;
    operationBusy.current = true;
    if (!window.confirm("确认把这条 Google Drive 连接切换为 BeamingFace 账号统一存储入口？手机、平板和电脑将共用同一份账号规则；不会修改或删除云盘文件，也不会扩大 Google 授权范围。切换后旧的逐客户端存储授权入口不会恢复。")) { operationBusy.current = false; return; }
    const epoch = revision.current;
    setBusy(true); setStatus(null); setMessage("正在切换；请勿重复提交……");
    try {
      const session = await supabase.auth.getSession();
      const owner = session.data.session?.user.id;
      if (session.error || !owner) throw new Error("请先登录 BeamingFace，再重新打开此确认链接。");
      const value = await request({ action: "transition", manifest_id: status.manifest_id,
        manifest_sha256: status.manifest_sha256, expected_inventory_digest: status.expected_inventory_digest,
        idempotency_key: `storage-policy-transition-ui-v2:${status.manifest_id}:${status.manifest_sha256}` }, owner);
      if (epoch !== revision.current || !isObject(value) || value.status !== "committed" ||
        typeof value.receipt_id !== "string" || !uuid.test(value.receipt_id)) throw new Error("账号存储入口切换回执未确认；不会自动重试。");
      const readback = await request({ action: "inspect", manifest_id: status.manifest_id }, owner);
      if (epoch !== revision.current || !isTransitionStatus(readback, status.manifest_id) || readback.status !== "committed" ||
        !readback.transition_receipt_id || !readback.policy_receipt_id || !readback.policy_id) throw new Error("切换后的账号策略回执未确认。");
      setStatus(readback); setMessage("账号统一存储入口已启用，并已核对两份独立回执。");
    } catch (error) {
      if (epoch === revision.current) setMessage(error instanceof Error ? error.message : "账号存储入口切换未确认；不会自动重试。");
    } finally { operationBusy.current = false; if (epoch === revision.current) setBusy(false); }
  }

  return <main className="mx-auto max-w-2xl px-6 py-16">
    <h1 className="text-2xl font-semibold">启用账号统一存储入口</h1>
    <p className="my-4">这是一次账号级切换，不按设备建权。Google 凭据仍只保存在 BeamingFace 服务端。</p>
    <p role="status" className="my-4">{message}</p>
    {status && <section className="my-4 rounded-xl border p-4">
      <p>Google Drive 连接：<span className="break-all">{status.connection_id}</span></p>
      <p>清单有效期：{status.expires_at}</p>
      {status.status === "reviewed" && <button disabled={busy} onClick={() => void confirmTransition()}>确认启用账号统一存储</button>}
      {status.status === "committed" && <>
        <p className="break-all">账号策略：{status.policy_id}</p>
        <p className="break-all">切换回执：{status.transition_receipt_id}</p>
        <p className="break-all">策略回执：{status.policy_receipt_id}</p>
      </>}
    </section>}
    <div className="mt-6 flex gap-4"><button disabled={busy} onClick={() => void inspect()}>重新核对</button><Link href="/storage/connections">返回存储连接</Link></div>
  </main>;
}
