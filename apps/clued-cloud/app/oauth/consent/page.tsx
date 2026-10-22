"use client";

import { FormEvent, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  type OAuthAuthorizationDetails,
  type Session,
} from "@supabase/supabase-js";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import DelegatedConsent from "./delegated-consent";
import { supabase } from "../../supabase-browser";


function redirectHost(uri: string) {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

function OAuthConsent() {
  const searchParams = useSearchParams();
  const authorizationId = searchParams.get("authorization_id")?.trim() ?? "";
  const [session, setSession] = useState<Session | null>(null);
  const [details, setDetails] = useState<OAuthAuthorizationDetails | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  const requestedScopes = useMemo(
    () => details?.scope.split(/\s+/).filter(Boolean) ?? [],
    [details],
  );

  const loadAuthorization = useCallback(async (id: string) => {
    setBusy(true);
    setError("");
    const { data: sessionData } = await supabase.auth.getSession();
    setSession(sessionData.session);
    if (!sessionData.session) {
      setBusy(false);
      return;
    }

    const { data, error: authorizationError } =
      await supabase.auth.oauth.getAuthorizationDetails(id);
    if (authorizationError || !data) {
      setError(authorizationError?.message ?? "授权请求无效或已过期。请返回 ChatGPT 重试。");
      setBusy(false);
      return;
    }
    if ("redirect_url" in data) {
      window.location.assign(data.redirect_url);
      return;
    }
    setDetails(data);
    setBusy(false);
  }, []);

  useEffect(() => {
    if (!authorizationId) return;
    const timer = window.setTimeout(() => void loadAuthorization(authorizationId), 0);
    return () => window.clearTimeout(timer);
  }, [authorizationId, loadAuthorization]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      setError("登录失败，请检查邮箱和密码。");
      setBusy(false);
      return;
    }
    await loadAuthorization(authorizationId);
  }

  async function decide(action: "approve" | "deny") {
    if (!authorizationId) return;
    setBusy(true);
    setError("");
    const result = action === "approve"
      ? await supabase.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true })
      : await supabase.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true });
    if (result.error || !result.data?.redirect_url) {
      setError(result.error?.message ?? "无法完成授权，请返回 ChatGPT 重试。");
      setBusy(false);
      return;
    }
    window.location.assign(result.data.redirect_url);
  }

  return (
    <main className="oauth-shell">
      <section className="oauth-card" aria-busy={busy}>
        <Link className="oauth-brand" href="/" aria-label="BeamingFace home">
          <span className="brand-mark" aria-hidden="true" />
          <span>BeamingFace</span>
        </Link>

        {!authorizationId ? (
          <div className="oauth-error" role="alert">
            <strong>无法继续</strong>
            <p>缺少 authorization_id。请从 ChatGPT 的连接流程重新打开此页面。</p>
            <Link href="/">返回 BeamingFace</Link>
          </div>
        ) : busy && !error ? (
          <div className="oauth-status">
            <span className="spinner" aria-hidden="true" />
            <p>正在验证授权请求…</p>
          </div>
        ) : !session && !error ? (
          <>
            <p className="oauth-kicker">安全登录</p>
            <h1>登录 BeamingFace 以继续</h1>
            <p className="oauth-copy">使用你的 BeamingFace 账户确认这次 AI 连接。密码只发送给 BeamingFace 的认证服务。</p>
            <form className="oauth-form" onSubmit={signIn}>
              <label>
                邮箱
                <input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
              </label>
              <label>
                密码
                <input type="password" autoComplete="current-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required />
              </label>
              <button className="primary-button" type="submit" disabled={busy}>登录并继续</button>
            </form>
          </>
        ) : details ? (
          <>
            <p className="oauth-kicker">AI 连续性授权</p>
            <h1>允许 {details.client.name || "此 AI 客户端"} 连接 BeamingFace？</h1>
            <p className="oauth-copy">
              此连接将获得一个独立、可撤销的 Binding，用于读取和更新你授权的 BeamingFace 上下文，并留下审计回执。
            </p>

            <dl className="oauth-details">
              <div><dt>登录账户</dt><dd>{details.user.email}</dd></div>
              <div><dt>返回地址</dt><dd>{redirectHost(details.redirect_uri)}</dd></div>
              <div><dt>请求范围</dt><dd>{requestedScopes.length ? requestedScopes.join(" · ") : "基础访问"}</dd></div>
            </dl>

            <ul className="oauth-permissions">
              <li>恢复对话开始时所需的当前上下文</li>
              <li>写入明确的决定、纠正、任务和状态</li>
              <li>创建检查点并读取审计回执</li>
            </ul>

            <p className="oauth-note">BeamingFace 不会向客户端发送你的密码或长期 Binding 密钥。你可以随时在“AI 连续性”中撤销此连接。</p>
            <div className="oauth-actions">
              <button className="oauth-secondary" type="button" onClick={() => void decide("deny")} disabled={busy}>拒绝</button>
              <button className="primary-button" type="button" onClick={() => void decide("approve")} disabled={busy}>允许连接</button>
            </div>
          </>
        ) : null}

        {error ? (
          <div className="oauth-error" role="alert">
            <strong>无法继续</strong>
            <p>{error}</p>
            <Link href="/">返回 BeamingFace</Link>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function ConsentRouter() {
  const params = useSearchParams();
  const requestId = params.get("request_id");
  return requestId ? <DelegatedConsent requestId={requestId} /> : <OAuthConsent />;
}

export default function OAuthConsentPage() {
  return (
    <Suspense fallback={<main className="oauth-shell"><section className="oauth-card"><div className="oauth-status"><span className="spinner" aria-hidden="true" /><p>正在加载授权页…</p></div></section></main>}>
      <ConsentRouter />
    </Suspense>
  );
}
