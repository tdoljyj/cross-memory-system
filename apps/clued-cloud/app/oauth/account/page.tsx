"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { supabase } from "../../supabase-browser";
import Link from "next/link";


export default function OAuthAccountPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const pending = useRef(false);
  const requestNumber = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current = false; requestNumber.current += 1; };
  }, []);

  async function recover(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    const address = email.trim();
    if (!address) { setError("请输入账户邮箱。"); return; }
    pending.current = true;
    const request = ++requestNumber.current;
    setBusy(true); setNotice(""); setError("");
    try {
      // The existing home page validates the recovery session and sets the new password.
      const { error: failure } = await supabase.auth.resetPasswordForEmail(address, {
        redirectTo: new URL("/?type=recovery", window.location.origin).href,
      });
      if (!mounted.current || requestNumber.current !== request) return;
      if (failure) {
        setError(failure.status === 429 ? "请求过于频繁，请稍后再试。" : "暂时无法发起密码恢复，请稍后重试。");
      } else {
        setNotice("如果该邮箱可以恢复账户，你会收到密码重置链接。请检查收件箱和垃圾邮件。");
      }
    } catch {
      if (mounted.current && requestNumber.current === request) setError("密码恢复请求的结果尚未确认，请稍后检查邮箱再重试。");
    } finally {
      if (mounted.current && requestNumber.current === request) { pending.current = false; setBusy(false); }
    }
  }

  return <main className="oauth-shell"><section className="oauth-card" aria-busy={busy}>
    <Link className="oauth-brand" href="/"><span className="brand-mark" aria-hidden="true" /><span>BeamingFace</span></Link>
    <p className="oauth-kicker">账户恢复</p>
    <h1>忘记密码</h1>
    <p className="oauth-copy">输入你的 BeamingFace 账户邮箱，通过邮件中的链接设置新密码。</p>
    <form className="oauth-form" onSubmit={recover}>
      <label>账户邮箱<input type="email" autoComplete="email" required value={email} disabled={busy}
        onChange={event => { setEmail(event.target.value); setError(""); setNotice(""); }} /></label>
      <button className="primary-button" type="submit" disabled={busy}>{busy ? "正在请求…" : "发送重置链接"}</button>
    </form>
    {error && <div className="oauth-error" role="alert"><strong>尚未完成</strong><p>{error}</p></div>}
    {notice && <p className="oauth-note" role="status">{notice}</p>}
    <p className="oauth-note">设置密码后，回到原来的客户端重新发起连接，再选择授权范围。</p>
    <div className="oauth-actions"><Link className="oauth-secondary" href="/oauth/connections">返回登录</Link><Link className="oauth-secondary" href="/">BeamingFace 首页</Link></div>
  </section></main>;
}
