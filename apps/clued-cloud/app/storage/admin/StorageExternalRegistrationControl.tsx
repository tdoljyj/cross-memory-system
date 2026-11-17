"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../../supabase-browser";

type Status = { connection_id: string; enabled: boolean; version: number; attention_count?: number };
export default function StorageExternalRegistrationControl({ connectionId }: { connectionId: string }) {
  const [status, setStatus] = useState<Status | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const epoch = useRef(0), pending = useRef(false);
  const load = useCallback(async () => {
    const revision = ++epoch.current; setBusy(true); setStatus(null);
    try {
      const { data, error } = await supabase.rpc("clued_storage_write_access_v1", { p_input: { action: "external_status", connection_id: connectionId } });
      if (revision !== epoch.current) return;
      if (error || !data || data.connection_id !== connectionId || typeof data.enabled !== "boolean" || !Number.isSafeInteger(data.version)) throw Error();
      setStatus(data); setMessage("");
    } catch { if (revision === epoch.current) setMessage("暂时无法读取自动同步状态，请稍后重读。"); }
    finally { if (revision === epoch.current) setBusy(false); }
  }, [connectionId]);
  useEffect(() => {
    let disposed = false;
    const liveEpoch = epoch;
    queueMicrotask(() => { if (!disposed) void load(); });
    const { data } = supabase.auth.onAuthStateChange(event => {
      if (event === "TOKEN_REFRESHED" || event === "INITIAL_SESSION") return;
      ++epoch.current; setStatus(null); setMessage("账号已变化，请重读同步状态。"); setBusy(false);
    });
    return () => { disposed = true; ++liveEpoch.current; data.subscription.unsubscribe(); };
  }, [load]);
  async function toggle() {
    if (!status || pending.current) return;
    pending.current = true; setBusy(true);
    const revision = epoch.current, previous = status;
    try {
      const { data, error } = await supabase.rpc("clued_storage_write_access_v1", { p_input: {
        action: "external_set", connection_id: connectionId, enabled: !previous.enabled, base_version: previous.version,
        disclosure_version: "clued.storage-external-registration-disclosure/1", idempotency_key: crypto.randomUUID(),
      } });
      if (revision !== epoch.current) return;
      if (error || !data || data.connection_id !== connectionId || data.enabled !== !previous.enabled || data.version !== previous.version + 1) throw Error();
      setStatus(data); setMessage(data.enabled ? "已开启。系统会在后台同步，不需要逐个登记。" : "已关闭自动同步。");
    } catch { if (revision === epoch.current) { setStatus(null); setMessage("本次设置结果尚未确认，请重读状态后再操作。"); } }
    finally { pending.current = false; if (revision === epoch.current) setBusy(false); }
  }
  return <div className="my-4 rounded-lg border p-3">
    <h3>自动同步文件目录</h3>
    <p className="my-2 text-sm">开启后，在 Google Drive 或电脑同步目录中新建、修改、改名和移动的普通文件，会自动更新到这里。同步只维护文件位置和版本，不修改文件内容。现有存储权限仍然有效。</p>
    {status && <p className="my-2">{status.enabled ? "自动同步已开启" : "自动同步已关闭"}</p>}
    {!!status?.attention_count && <p className="my-2 text-sm">有 {status.attention_count} 个目录暂未同步成功，系统会继续重试。若持续出现，请检查目录权限和连接状态。</p>}
    <button disabled={busy} onClick={() => void (status ? toggle() : load())}>{busy ? "正在处理……" : status ? status.enabled ? "关闭自动同步" : "开启自动同步" : "重读状态"}</button>
    {message && <p role="status" className="my-2 text-sm">{message}</p>}
  </div>;
}
