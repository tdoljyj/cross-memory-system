"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "../../../supabase-browser";

// One in-memory delivery across React remounts. Never persist the Google code,
// state or provider credentials in browser storage; never feed it to Clued auth.
let delivery: Promise<{ receipt: string; owner: string }> | undefined;
function finish(): Promise<{ receipt: string; owner: string }> {
  if (delivery) return delivery;
  const query = new URL(window.location.href).searchParams;
  const state = query.get("state"), code = query.get("code");
  const invalid = query.has("error") || query.getAll("state").length !== 1 || query.getAll("code").length !== 1;
  window.history.replaceState(null, "", "/storage/google/callback");
  delivery = (async () => {
    if (invalid || !state || !code) throw new Error("Google 授权未完成，请返回连接页重新开始。");
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session) throw new Error("请使用开始授权时的 Clued 登录会话，返回连接页重新开始。");
    const response = await fetch("/v1/storage/google/complete", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + data.session.access_token },
      body: JSON.stringify({ state, code }), cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
    });
    if (!response.ok) throw new Error("连接未启用。请返回连接页检查状态；不会自动重试授权码或放宽权限。");
    const result = await response.json() as { status?: unknown; receipt_id?: unknown } | null;
    if (result?.status !== "completed" || typeof result.receipt_id !== "string") throw new Error("尚未取得确认回执，请返回连接页检查状态。");
    return { receipt: result.receipt_id, owner: data.session.user.id };
  })();
  return delivery;
}

export default function StorageGoogleCallback() {
  const [message, setMessage] = useState("正在核对 Google 连接，请勿重复授权……");
  useEffect(() => {
    let active = true, changed = false, observed: string | null | undefined;
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      const owner = session?.user.id ?? null;
      if (owner === null || (observed !== undefined && observed !== owner)) {
        changed = true;
        if (active) setMessage("登录账号已变化，请返回连接页重新读取状态。");
      }
      observed = owner;
    });
    void finish().then(async result => {
      const current = await supabase.auth.getSession();
      if (active && !changed && !current.error && current.data.session?.user.id === result.owner)
        setMessage("连接凭据已安全保存。回执：" + result.receipt + "。文件操作仍需独立授权与执行验收。");
    }, () => { if (active && !changed) setMessage("连接尚未确认，请返回连接页检查后重新开始。正式写入不会因此开启。"); });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, []);
  return <main className="mx-auto max-w-2xl px-6 py-16"><h1 className="text-2xl font-semibold">Google 连接</h1>
    <p className="my-6" role="status">{message}</p><Link href="/storage/connections">返回存储连接</Link></main>;
}
