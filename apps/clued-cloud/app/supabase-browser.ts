/// <reference types="vite/client" />
"use client";

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

import { resolveSupabasePublicConfig } from "./supabase-public-config";

// Read only these public build values, never Worker environment or server secrets.
const { url: SUPABASE_URL, key: SUPABASE_PUBLISHABLE_KEY } = resolveSupabasePublicConfig({
  VITE_CLUED_SUPABASE_URL: import.meta.env.VITE_CLUED_SUPABASE_URL,
  VITE_CLUED_SUPABASE_PUBLISHABLE_KEY: import.meta.env.VITE_CLUED_SUPABASE_PUBLISHABLE_KEY,
});
type RestoredSession = { session: Session | null; error: Error | null; authType: string | null };
type AuthWindow = Window & {
  __cluedBrowserSupabase?: SupabaseClient;
  __cluedBrowserAuthConfig?: { url: string; key: string };
  __cluedAuthRestorePromise?: Promise<RestoredSession>;
};

function sharedClient(): SupabaseClient {
  if (typeof window === "undefined") {
    // SSR never persists an identity or places an auth client in a process-wide cache.
    return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  const browser = window as AuthWindow;
  if (browser.__cluedBrowserSupabase && (browser.__cluedBrowserAuthConfig?.url !== SUPABASE_URL
    || browser.__cluedBrowserAuthConfig?.key !== SUPABASE_PUBLISHABLE_KEY)) {
    throw new Error("BeamingFace 登录服务配置已变化，请重新加载页面后继续。");
  }
  if (!browser.__cluedBrowserSupabase) {
    browser.__cluedBrowserSupabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
  }
  browser.__cluedBrowserAuthConfig = { url: SUPABASE_URL, key: SUPABASE_PUBLISHABLE_KEY };
  return browser.__cluedBrowserSupabase;
}

// The browser instance survives module replacement and route chunks. Callback
// handling is explicitly shared too, so the first visited page cannot change it.
export const supabase = sharedClient();

export async function restoreBrowserSession(): Promise<RestoredSession> {
  const browser = window as AuthWindow;
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const accessToken = fragment.get("access_token");
  const refreshToken = fragment.get("refresh_token");
  const code = url.searchParams.get("code");
  const authType = fragment.get("type") ?? url.searchParams.get("type");
  const hasCallback = Boolean(accessToken || refreshToken || code || fragment.get("error") || url.searchParams.get("error"));
  if (browser.__cluedAuthRestorePromise) {
    if (hasCallback) return { session: null, error: new Error("另一条登录链接仍在处理中，请稍后重新打开此链接。"), authType };
    return browser.__cluedAuthRestorePromise;
  }
  if (!hasCallback) {
    const { data, error } = await supabase.auth.getSession();
    return { session: data.session, error, authType };
  }
  const callbackError = fragment.get("error") || url.searchParams.get("error");
  // Remove credentials before any request. Preserve the view hint, which is never
  // identity evidence: only a verified returned session can enable password setup.
  url.searchParams.delete("code");
  url.searchParams.delete("error");
  url.searchParams.delete("error_description");
  if (authType === "recovery" || authType === "invite") url.searchParams.set("type", authType);
  if (accessToken || refreshToken || fragment.has("error")) url.hash = "";
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  const pending = (async (): Promise<RestoredSession> => {
    try {
      if (callbackError || Boolean(accessToken) !== Boolean(refreshToken)) {
        return { session: null, error: new Error("登录链接无效或已过期，请重新获取。"), authType };
      }
      const { data, error } = accessToken && refreshToken
        ? await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
        : await supabase.auth.exchangeCodeForSession(code!);
      return { session: data.session, error, authType };
    } catch {
      return { session: null, error: new Error("登录链接尚未验证完成，请重新打开原链接后重试。"), authType };
    }
  })();
  browser.__cluedAuthRestorePromise = pending;
  try { return await pending; }
  finally { if (browser.__cluedAuthRestorePromise === pending) delete browser.__cluedAuthRestorePromise; }
}
