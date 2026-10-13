"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { type Session } from "@supabase/supabase-js";
import { supabase } from "../../supabase-browser";
import Link from "next/link";
import HeadlessBindings from "./headless";

const API = "/oauth/connections/api";
// Headless Bindings share the v12 authorization table; they are listed and
// managed in their own section (./headless.tsx), not as OAuth connections.
const HEADLESS_CLIENT = "clued-headless";

type Grant = {
  resource_kind: "scope" | "context";
  resource_id: string;
  environment: string;
  actions: string[];
  effective_actions?: string[];
  qualification_id?: string | null;
};
type Binding = {
  binding_id: string;
  client_id: string;
  client_name: string;
  version: number;
  expires_at: string;
  created_at?: string | null;
  last_used_at?: string | null;
  active: boolean;
  grants: Grant[];
};
type Selection = Record<string, Record<string, string[]>>;
type StorageAccess = { binding_id: string; denied: boolean; generation: number; receipt_id: string | null };


const actionLabels: Record<string, string> = {
  read: "读取", write: "新增和修改", close: "关闭和归档", restore: "恢复记录",
  feedback_submit: "提交反馈", audit: "查看审计回执",
};
const environmentLabels: Record<string, string> = {
  canonical: "正式记忆", test: "测试环境", preview: "预览环境", production: "生产环境",
};
const rowKey = (grant: Grant) => JSON.stringify([grant.resource_kind, grant.resource_id, grant.environment]);
const failureMessage = (failure: unknown, fallback: string) =>
  failure instanceof Error && !(failure instanceof TypeError) ? failure.message : fallback;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalDate(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function isBinding(value: unknown): value is Binding {
  return isObject(value) && typeof value.binding_id === "string" && typeof value.client_id === "string"
    && typeof value.client_name === "string" && typeof value.version === "number"
    && Number.isSafeInteger(value.version) && typeof value.expires_at === "string"
    && Number.isFinite(Date.parse(value.expires_at)) && typeof value.active === "boolean"
    && optionalDate(value.created_at) && optionalDate(value.last_used_at)
    && Array.isArray(value.grants) && value.grants.every(grant =>
      isObject(grant) && (grant.resource_kind === "scope" || grant.resource_kind === "context")
      && typeof grant.resource_id === "string" && typeof grant.environment === "string"
      && Array.isArray(grant.actions) && grant.actions.every(action => typeof action === "string")
      && (grant.effective_actions === undefined || (Array.isArray(grant.effective_actions) && grant.effective_actions.every(action => typeof action === "string"))));
}

async function readResponse(response: Response, fallback: string): Promise<unknown> {
  if (!response.ok) {
    const messages: Record<number, string> = {
      401: "登录已失效，请重新登录后再读取连接。",
      403: "当前账户无权管理此连接。",
      409: "连接状态已发生变化，请重新读取后再操作。",
      410: "连接已过期或失效，请重新读取其状态。",
    };
    throw new Error(messages[response.status] || fallback);
  }
  if (response.status === 204) return null;
  try { return await response.json(); } catch { throw new Error(fallback); }
}

// "我的全部项目（含以后新建的）" (PermissionSimplification §3.1): Clued keeps one
// project entry per project for a project:* grant. While project:* stays
// selected, a project row it covers is not shown or sent; Clued rebuilds it
// from project:*, so narrowing project:* narrows every covered project.
const ALL_PROJECTS = "project:*";
const allProjectsGrant = (binding: Binding) => binding.grants.find(grant =>
  grant.resource_kind === "scope" && grant.resource_id === ALL_PROJECTS && grant.environment === "canonical");
function chosenActions(binding: Binding, selection: Selection, grant: Grant) {
  return grant.actions.filter(action => (selection[binding.binding_id]?.[rowKey(grant)] ?? []).includes(action));
}
function coveredByAll(binding: Binding, selection: Selection, grant: Grant) {
  const all = allProjectsGrant(binding);
  return !!all && grant !== all && grant.resource_kind === "scope" && grant.environment === "canonical"
    && grant.resource_id.startsWith("project:") && grant.actions.every(action => all.actions.includes(action))
    && chosenActions(binding, selection, all).length > 0;
}
function selectedGrants(binding: Binding, selection: Selection): Grant[] {
  return binding.grants.filter(grant => !coveredByAll(binding, selection, grant)).map(grant => ({
    resource_kind: grant.resource_kind, resource_id: grant.resource_id, environment: grant.environment,
    actions: chosenActions(binding, selection, grant),
  })).filter(grant => grant.actions.length > 0);
}
// The preset role a connection's entries match (Decision b32fc5b9), else 自定义.
const DEVELOPER = ["close", "read", "restore", "write"];
function roleName(binding: Binding): string {
  const scopes = binding.grants.filter(grant => grant.resource_kind === "scope" && grant.environment === "canonical");
  if (!scopes.length || binding.grants.some(grant => grant.resource_kind !== "scope")) return "自定义";
  const sorted = (grant: Grant) => [...grant.actions].sort().join(",");
  const projects = scopes.filter(grant => grant.resource_id.startsWith("project:"));
  const personal = scopes.filter(grant => !grant.resource_id.startsWith("project:"));
  if (scopes.every(grant => sorted(grant) === "read")) return "只读";
  if (personal.length === 1 && personal[0].resource_id === "global" && sorted(personal[0]) === "read"
    && projects.length > 0 && projects.every(grant => sorted(grant) === DEVELOPER.join(","))) return "项目开发者";
  if (personal.some(grant => grant.resource_id === "global") && personal.some(grant => grant.resource_id === "profile")
    && scopes.every(grant => DEVELOPER.every(action => grant.actions.includes(action)))) return "全部";
  return "自定义";
}
const grantTitle = (grant: Grant) => grant.resource_id === "global" ? "全局视图"
  : grant.resource_id === "profile" ? "个人资料" : grant.resource_id === ALL_PROJECTS ? "我的全部项目（含以后新建的）" : grant.resource_id;

export default function OAuthConnectionsPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [storageAccess, setStorageAccess] = useState<Record<string, StorageAccess>>({});
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [selection, setSelection] = useState<Selection>({});
  const [pending, setPending] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [now, setNow] = useState(0);
  const currentSession = useRef<Session | null>(null);
  const accountEpoch = useRef(0);
  const readNumber = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const writeController = useRef<AbortController | null>(null);

  const applyBindings = useCallback((rows: Binding[]) => {
    setBindings(rows);
    setSelection(Object.fromEntries(rows.map(binding => [binding.binding_id,
      Object.fromEntries(binding.grants.map(grant => [rowKey(grant), [...grant.actions]])),
    ])));
    setNow(Date.now());
    setLoaded(true);
    setNeedsReload(false);
  }, []);

  const readStorageAccess = useCallback(async (who: Session, epoch: number): Promise<Record<string, StorageAccess> | null> => {
    const response = await fetch("/v1/storage/owner", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { Authorization: `Bearer ${who.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "clients" }),
    });
    const value = await readResponse(response, "无法读取客户端网盘访问状态。");
    if (!isObject(value) || !Array.isArray(value.clients) || !value.clients.every(row => isObject(row)
      && typeof row.binding_id === "string" && typeof row.denied === "boolean"
      && typeof row.generation === "number" && Number.isSafeInteger(row.generation) && row.generation >= 0
      && (row.receipt_id === null || typeof row.receipt_id === "string"))) {
      throw new Error("客户端网盘访问状态未确认。");
    }
    const latest = await supabase.auth.getSession();
    if (accountEpoch.current !== epoch || latest.error || latest.data.session?.user.id !== who.user.id) return null;
    const rows = Object.fromEntries((value.clients as StorageAccess[]).map(row => [row.binding_id, row]));
    setStorageAccess(rows); setStorageLoaded(true);
    return rows;
  }, []);

  const readBindings = useCallback(async (who: Session, epoch: number, apply = true): Promise<Binding[] | null> => {
    if (accountEpoch.current !== epoch) return null;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    const request = ++readNumber.current;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(API, {
        headers: { Authorization: `Bearer ${who.access_token}` },
        credentials: "same-origin", cache: "no-store", signal: controller.signal,
      });
      const value = await readResponse(response, "暂时无法读取连接，请稍后重试。");
      if (!isObject(value) || !Array.isArray(value.bindings) || !value.bindings.every(isBinding)) {
        throw new Error("连接服务返回了不完整的状态，请稍后重新读取。");
      }
      if (accountEpoch.current !== epoch || request !== readNumber.current || controller.signal.aborted) return null;
      const rows: Binding[] = value.bindings.filter((binding: Binding) => binding.client_id !== HEADLESS_CLIENT);
      if (apply) {
        applyBindings(rows);
        try { await readStorageAccess(who, epoch); } catch { if (accountEpoch.current === epoch) { setStorageAccess({}); setStorageLoaded(false); } }
      }
      return rows;
    } catch (failure) {
      if (accountEpoch.current !== epoch || controller.signal.aborted) return null;
      setNeedsReload(true);
      throw failure;
    } finally {
      if (accountEpoch.current === epoch && request === readNumber.current) setLoading(false);
    }
  }, [applyBindings, readStorageAccess]);

  useEffect(() => {
    let disposed = false;
    let firstEvent = true;
    let timer: number | undefined;
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (disposed) return;
      const changed = firstEvent || currentSession.current?.user.id !== nextSession?.user.id;
      firstEvent = false;
      currentSession.current = nextSession;
      setSession(nextSession);
      setAuthReady(true);
      if (!changed) return;
      const epoch = ++accountEpoch.current;
      readController.current?.abort();
      writeController.current?.abort();
      writeController.current = null;
      window.clearTimeout(timer);
      setBindings([]);
      setStorageAccess({}); setStorageLoaded(false);
      setSelection({});
      setLoaded(false);
      setPending(null);
      setAuthBusy(false);
      setNeedsReload(false);
      setError("");
      setNotice("");
      setPassword("");
      setLoading(Boolean(nextSession));
      if (nextSession) {
        // Keep the auth callback synchronous; ignore results from an earlier account.
        timer = window.setTimeout(() => {
          void readBindings(nextSession, epoch).catch(failure => {
            if (!disposed && accountEpoch.current === epoch) {
              setError(failureMessage(failure, "暂时无法读取连接，请检查网络后重试。"));
            }
          });
        }, 0);
      }
    });
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      readController.current?.abort();
      writeController.current?.abort();
      data.subscription.unsubscribe();
    };
  }, [readBindings]);

  useEffect(() => {
    const expiries = bindings.filter(binding => binding.active)
      .map(binding => Date.parse(binding.expires_at)).filter(expiry => expiry > now);
    if (!expiries.length) return;
    const delay = Math.min(Math.max(0, Math.min(...expiries) - Date.now()) + 10, 2_147_483_647);
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [bindings, now]);

  async function reload() {
    const who = currentSession.current;
    const epoch = accountEpoch.current;
    if (!who) return;
    try {
      await readBindings(who, epoch);
    } catch (failure) {
      if (accountEpoch.current === epoch) setError(failureMessage(failure, "暂时无法读取连接，请检查网络后重试。"));
    }
  }

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthBusy(true);
    setError("");
    const epoch = accountEpoch.current;
    try {
      const { error: failure } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (failure && accountEpoch.current === epoch) setError("登录失败，请检查邮箱和密码。");
    } catch {
      if (accountEpoch.current === epoch) setError("暂时无法登录，请稍后重试。");
    } finally {
      if (accountEpoch.current === epoch) { setPassword(""); setAuthBusy(false); }
    }
  }

  async function switchAccount() {
    setAuthBusy(true);
    setError("");
    const epoch = accountEpoch.current;
    try {
      const { error: failure } = await supabase.auth.signOut({ scope: "local" });
      if (failure && accountEpoch.current === epoch) setError("未能退出当前账户，请稍后重试。");
    } catch {
      if (accountEpoch.current === epoch) setError("未能退出当前账户，请稍后重试。");
    } finally {
      if (accountEpoch.current === epoch) setAuthBusy(false);
    }
  }

  const changeBinding = useCallback(async (binding: Binding, op: "revoke" | "reduce") => {
    const who = currentSession.current;
    const epoch = accountEpoch.current;
    if (!who || writeController.current || needsReload) return;
    if (!binding.active || Date.parse(binding.expires_at) <= Date.now()) {
      setNow(Date.now());
      setError("此连接已失效，不能修改或恢复。需要访问时，请从客户端重新发起授权。");
      return;
    }
    const selected = selectedGrants(binding, selection);
    const controller = new AbortController();
    writeController.current = controller;
    setPending(binding.binding_id);
    setError("");
    setNotice("");
    let submitted = false;
    try {
      const response = await fetch(API, {
        method: "POST", credentials: "same-origin", signal: controller.signal,
        headers: { Authorization: `Bearer ${who.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ op, binding_id: binding.binding_id, base_version: binding.version,
          ...(op === "reduce" ? { selected } : {}),
        }),
      });
      await readResponse(response, "无法确认此次操作结果，请重新读取连接。");
      submitted = true;
      if (accountEpoch.current !== epoch || controller.signal.aborted) return;
      const latest = await readBindings(currentSession.current ?? who, epoch, false);
      if (!latest || accountEpoch.current !== epoch) return;
      const updated = latest.find(row => row.binding_id === binding.binding_id);
      const confirmed = op === "revoke" ? !updated || !updated.active
        : updated && updated.version > binding.version && updated.grants.every(grant => {
          const allowed = selected.find(row => rowKey(row) === rowKey(grant));
          // A project row Clued rebuilt from project:* is allowed what project:* is.
          const all = grant.resource_kind === "scope" && grant.resource_id.startsWith("project:")
            ? selected.find(row => row.resource_kind === "scope" && row.resource_id === ALL_PROJECTS) : undefined;
          return grant.actions.every(action => allowed?.actions.includes(action) || all?.actions.includes(action));
        });
      if (!confirmed) throw new Error("重新读取后尚未确认此次变更，请再次读取状态后再操作。");
      applyBindings(latest);
      setNotice(op === "revoke" ? "连接已撤销，最新状态已读取。" : "权限已减少，最新状态已读取。");
    } catch (failure) {
      if (accountEpoch.current !== epoch || controller.signal.aborted) return;
      setNeedsReload(true);
      setError(submitted
        ? "请求已提交，但尚未确认最终状态。请重新读取连接，避免重复操作。"
        : failureMessage(failure, "操作结果尚未确认，请检查网络并重新读取连接。"));
    } finally {
      if (writeController.current === controller) writeController.current = null;
      if (accountEpoch.current === epoch) setPending(null);
    }
  }, [applyBindings, needsReload, readBindings, selection]);

  async function revokeStorage(binding: Binding) {
    const who = currentSession.current, epoch = accountEpoch.current;
    const prior = storageAccess[binding.binding_id];
    if (!who || !storageLoaded || !prior || prior.denied || writeController.current || needsReload) return;
    if (!window.confirm(`仅撤销 ${binding.client_name} 的网盘访问？此客户端的 Kooyumi 记忆权限、其他客户端和整个网盘连接不变。已开始的文件操作仍需核对原回执。`)) return;
    const controller = new AbortController();
    writeController.current = controller; setPending(binding.binding_id); setError(""); setNotice("");
    try {
      const response = await fetch("/v1/storage/owner", {
        method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal,
        headers: { Authorization: `Bearer ${who.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revoke_client", binding_id: binding.binding_id,
          base_generation: prior.generation, idempotency_key: crypto.randomUUID() }),
      });
      const value = await readResponse(response, "网盘访问撤销结果未确认。");
      if (!isObject(value) || value.status !== "committed" || typeof value.receipt_id !== "string")
        throw new Error("网盘访问回执未确认。");
      const latest = await readStorageAccess(who, epoch);
      if (!latest?.[binding.binding_id]?.denied || latest[binding.binding_id].generation <= prior.generation)
        throw new Error("撤销回读未确认。");
      if (accountEpoch.current === epoch) setNotice(`此客户端的网盘访问已撤销。回执：${value.receipt_id}；记忆权限不变。`);
    } catch {
      if (accountEpoch.current === epoch && !controller.signal.aborted) {
        setStorageLoaded(false); setNeedsReload(true);
        setError("网盘访问撤销结果未确认。请重新读取当前状态和原回执，不要再次提交。");
      }
    } finally {
      if (writeController.current === controller) writeController.current = null;
      if (accountEpoch.current === epoch) setPending(null);
    }
  }

  const busy = authBusy || loading || pending !== null;
  return (
    <main className="oauth-shell">
      <section className="oauth-card" aria-busy={busy}>
        <Link className="oauth-brand" href="/" aria-label="返回 Kooyumi 首页">
          <span className="brand-mark" aria-hidden="true">◆</span><span>Kooyumi</span>
        </Link>
        <p className="oauth-kicker">账户授权</p>
        <h1>已连接的客户端</h1>
        <p className="oauth-copy">查看每个独立连接的权限，保留需要的操作，或停止该连接的后续访问。</p>
        <p><Link href="/oauth/projects">开发项目资格与邀请</Link></p>
        {!authReady && <p role="status">正在确认登录状态…</p>}
        {error && <div className="oauth-error" role="alert">
          <strong>尚未完成</strong><p>{error}</p>
          {loaded && <p>下方保留最近一次成功读取的状态与当前选择。</p>}
        </div>}
        {notice && <p className="oauth-note" role="status">{notice}</p>}
        {authReady && !session && <>
          <h2 style={{ fontSize: 20 }}>登录你的 Kooyumi 账户</h2>
          <p className="oauth-copy">使用授权连接时的同一个账户。</p>
          <form className="oauth-form" onSubmit={signIn}>
            <label>邮箱<input type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} disabled={authBusy} /></label>
            <label>密码<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} disabled={authBusy} /></label>
            <button className="primary-button" type="submit" disabled={authBusy}>{authBusy ? "正在登录…" : "登录并查看连接"}</button>
          </form>
          <p><Link href="/oauth/account">忘记密码</Link></p>
        </>}
        {session && <>
          <dl className="oauth-details"><div><dt>当前账户</dt><dd>{session.user.email || "已登录账户"}</dd></div></dl>
          <div className="oauth-actions" style={{ marginBottom: 22 }}>
            <button className="oauth-secondary" type="button" onClick={() => void switchAccount()} disabled={busy}>切换账户</button>
            <button className="oauth-secondary" type="button" onClick={() => void reload()} disabled={busy}>{loading ? "正在读取…" : "重新读取连接"}</button>
          </div>
          {loading && <p role="status">正在读取连接状态…</p>}
          {loaded && bindings.length === 0 && <p role="status">这个账户还没有已授权的客户端连接。</p>}
          {bindings.map(binding => {
            const expired = Date.parse(binding.expires_at) <= now;
            const unavailable = !binding.active || expired;
            const changed = binding.grants.some(grant => grant.actions.some(action =>
              !(selection[binding.binding_id]?.[rowKey(grant)] ?? []).includes(action)));
            return <article key={binding.binding_id} style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 18, marginTop: 18 }}>
              <h2 style={{ fontSize: 20, margin: "0 0 14px", overflowWrap: "anywhere" }}>{binding.client_name || binding.client_id}</h2>
              <dl className="oauth-details">
                <div><dt>状态</dt><dd>{!binding.active ? "已撤销或失效" : expired ? "已过期" : "授权有效"}</dd></div>
                <div><dt>授权日期</dt><dd>{binding.created_at ? <time dateTime={binding.created_at}>{new Date(binding.created_at).toLocaleString("zh-CN")}</time> : "暂无记录"}</dd></div>
                <div><dt>最近使用</dt><dd>{binding.last_used_at ? <time dateTime={binding.last_used_at}>{new Date(binding.last_used_at).toLocaleString("zh-CN")}</time> : "暂无记录"}</dd></div>
                <div><dt>有效期至</dt><dd><time dateTime={binding.expires_at}>{new Date(binding.expires_at).toLocaleString("zh-CN")}</time></dd></div>
                <div><dt>连接编号</dt><dd>{binding.binding_id}</dd></div>
                <div><dt>角色</dt><dd>{roleName(binding)}</dd></div>
                {allProjectsGrant(binding) && <div><dt>项目范围</dt><dd>我的全部项目（含以后新建的，只含你自己的项目）</dd></div>}
              </dl>
              {binding.grants.length === 0 && <p className="oauth-copy">此连接没有业务访问权限。</p>}
              {binding.grants.filter(grant => !coveredByAll(binding, selection, grant)).map(grant => <fieldset key={rowKey(grant)} disabled={busy || unavailable || needsReload}
                style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 12, margin: "12px 0", minWidth: 0 }}>
                <legend style={{ fontSize: 12, overflowWrap: "anywhere" }}>
                  {grantTitle(grant)} · {environmentLabels[grant.environment] || grant.environment}
                </legend>
                {grant.resource_id === ALL_PROJECTS && <p className="oauth-copy">以后新建的项目自动包含在内。这里的勾选同时作用于下面没有单独列出的每个项目。</p>}
                {grant.effective_actions && grant.resource_id !== ALL_PROJECTS && <p className="oauth-copy">当前实际可用：{grant.effective_actions.length ? grant.effective_actions.map(action => actionLabels[action] || action).join("、") : "无可用操作"}</p>}
                {grant.actions.map(action => <label key={action} style={{ display: "flex", alignItems: "center", gap: 10, margin: "9px 0", fontSize: 13 }}>
                  <input type="checkbox" style={{ width: 18, height: 18, accentColor: "var(--green)" }}
                    checked={(selection[binding.binding_id]?.[rowKey(grant)] ?? []).includes(action)}
                    onChange={event => {
                      const checked = event.target.checked;
                      setSelection(previous => {
                        const values = previous[binding.binding_id]?.[rowKey(grant)] ?? [];
                        return { ...previous, [binding.binding_id]: {
                          ...previous[binding.binding_id], [rowKey(grant)]: checked
                            ? grant.actions.filter(item => item === action || values.includes(item))
                            : values.filter(item => item !== action),
                        } };
                      });
                    }} />{grant.resource_kind === "context" && action === "close" ? "关闭/撤回记录" : actionLabels[action] || action}
                </label>)}
              </fieldset>)}
              {storageLoaded && storageAccess[binding.binding_id] && <div className="oauth-actions">
                <p className="oauth-copy">{storageAccess[binding.binding_id].denied ? "网盘访问已单独撤销" : "网盘访问按账号规则单独管理"}</p>
                {!storageAccess[binding.binding_id].denied && <button className="oauth-secondary" type="button"
                  disabled={busy || needsReload} onClick={() => void revokeStorage(binding)}>仅撤销此客户端的网盘访问</button>}
              </div>}
              {!storageLoaded && <p className="oauth-copy">网盘访问状态未确认；重新读取连接后再管理。</p>}
              {unavailable ? <p className="oauth-copy">此连接无法恢复。需要继续访问时，请从客户端重新发起授权。</p> : <>
                <p className="oauth-copy" style={{ marginBottom: 14 }}>{changed ? "权限调整尚未保存。保存后不能在此重新增加已移除的权限。" : "取消勾选可减少权限；新增权限需要重新授权。"}</p>
                <div className="oauth-actions">
                  <button className="oauth-secondary" style={{ color: "#ffc5c5" }} type="button" disabled={busy || needsReload} onClick={() => void changeBinding(binding, "revoke")}>撤销此连接</button>
                  <button className="primary-button" type="button" disabled={busy || needsReload || !changed} onClick={() => void changeBinding(binding, "reduce")}>
                    {pending === binding.binding_id ? "正在处理…" : "保存减少后的权限"}
                  </button>
                </div>
              </>}
            </article>;
          })}
          <p className="oauth-note">减少或撤销权限会阻止之后的相应访问，不能收回客户端此前已经取得的数据。不同连接分别管理。</p>
          <HeadlessBindings />
        </>}
      </section>
    </main>
  );
}
