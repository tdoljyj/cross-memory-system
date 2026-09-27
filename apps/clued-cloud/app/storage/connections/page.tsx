"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "../../supabase-browser";
type Connection = { id: string; provider: string; state: string; version: number; profile_id: string };
const storageActions = { inspect: "查看存储任务状态", create_file: "新建文件", create_topic: "新建主题目录" };
type StorageAction = keyof typeof storageActions;
type Client = { binding_id: string; client_name: string; client_id: string; version: number; expires_at: string; active: boolean };
type ClientGrant = { binding_id: string; authorization_version: number; actions: StorageAction[]; expires_at: string; revoked_at: string | null; receipt_id: string; binding_current: boolean };
type GrantView = { connection_id: string; connection_version: number; connection_state: string; grants: ClientGrant[] };
type ClientDraft = { binding: string; actions: StorageAction[]; expires: string };
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isDate = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
function isClient(v: unknown): v is Client {
  return isObject(v) && typeof v.binding_id === "string" && typeof v.client_name === "string" && typeof v.client_id === "string"
    && Number.isSafeInteger(v.version) && Number(v.version) > 0 && isDate(v.expires_at) && typeof v.active === "boolean";
}
function isGrantView(v: Record<string, unknown>, id: string): v is GrantView {
  return v.connection_id === id && Number.isSafeInteger(v.connection_version) && Number(v.connection_version) > 0
    && typeof v.connection_state === "string" && Array.isArray(v.grants) && v.grants.every(g => isObject(g)
      && typeof g.binding_id === "string" && Number.isSafeInteger(g.authorization_version) && Number(g.authorization_version) > 0
      && Array.isArray(g.actions) && g.actions.length > 0 && g.actions.every(a => typeof a === "string" && Object.hasOwn(storageActions, a))
      && isDate(g.expires_at) && (g.revoked_at === null || isDate(g.revoked_at)) && typeof g.receipt_id === "string" && typeof g.binding_current === "boolean");
}
type RefreshStatus = { enabled: boolean; version: number; connection_version: number; failures: number; pending: boolean; next_refresh_at: string | null };
async function request(path: string, body: object | undefined, stillCurrent: () => boolean = () => true) {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error("请先登录 Clued，再返回此页。");
  if (!stillCurrent()) throw new Error("账号或页面已变化，请重新确认。");
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", authorization: "Bearer " + data.session.access_token },
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
  const [renewals, setRenewals] = useState<Record<string, RefreshStatus>>({});
  const [defaultRefresh, setDefaultRefresh] = useState<Record<string, boolean>>({});
  const [clients, setClients] = useState<Client[]>([]), [grantViews, setGrantViews] = useState<Record<string, GrantView>>({});
  const [clientDrafts, setClientDrafts] = useState<Record<string, ClientDraft>>({});
  const [profileId, setProfileId] = useState(""), [decisionId, setDecisionId] = useState("");
  const registrationBusy = useRef(false);
  const operationBusy = useRef(false);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const epoch = ++revision.current;
    setRenewals({});
    setClients([]); setGrantViews({}); setClientDrafts({});
    setBusy(true);
    try { const result = await request("/v1/storage/account", { action: "list" });
      if (epoch !== revision.current) return;
      if (!Array.isArray(result.connections) || !result.connections.every(c => c && typeof c.id === "string" && typeof c.provider === "string" && typeof c.state === "string" && Number.isSafeInteger(c.version))) throw new Error("连接列表未确认。");
      setConnections(result.connections); setMessage(result.connections.length ? "" : "暂无已登记连接。请先完成受治理目录登记。");
    } catch (error) { if (epoch === revision.current) { setConnections([]); setMessage(error instanceof Error ? error.message : "无法读取连接。"); } }
    finally { if (epoch === revision.current) setBusy(false); }
  }, []);
  useEffect(() => {
    let disposed = false;
    const liveRevision = revision;
    const scheduleRead = () => queueMicrotask(() => { if (!disposed) void refresh(); });
    const { data } = supabase.auth.onAuthStateChange(() => {
      if (disposed) return;
      ++revision.current; setConnections([]); setRenewals({}); setDefaultRefresh({}); setProfileId(""); setDecisionId("");
      setClients([]); setGrantViews({}); setClientDrafts({});
      // Do not await Supabase calls from inside its auth callback lock.
      scheduleRead();
    });
    scheduleRead();
    return () => { disposed = true; ++liveRevision.current; data.subscription.unsubscribe(); };
  }, [refresh]);
  async function readClients(c: Connection, epoch: number) {
    const stillCurrent = () => epoch === revision.current;
    const listed = await request("/oauth/connections/api", undefined, stillCurrent);
    if (!stillCurrent()) return;
    if (!Array.isArray(listed.bindings) || !listed.bindings.every(isClient)) throw new Error("客户端列表未确认。");
    const view = await request("/v1/storage/account", { action: "client_grants", connection_id: c.id }, stillCurrent);
    if (!stillCurrent()) return;
    if (!isGrantView(view, c.id)) throw new Error("存储授权列表未确认。");
    setClients(listed.bindings); setGrantViews(old => ({ ...old, [c.id]: view }));
    setConnections(old => old.map(item => item.id === c.id ? { ...item, version: view.connection_version, state: view.connection_state } : item));
    setClientDrafts(old => { const next = { ...old }; delete next[c.id]; return next; });
  }
  async function manageClient(c: Connection, action: "list" | "grant_client" | "revoke_client", grant?: ClientGrant) {
    if (operationBusy.current || registrationBusy.current || busy) return;
    const epoch = revision.current, view = grantViews[c.id], draft = clientDrafts[c.id];
    const client = clients.find(item => item.binding_id === draft?.binding);
    let payload: Record<string, unknown> | undefined;
    if (action !== "list") {
      if (!view) return;
      if (action === "grant_client") {
        if (view.connection_state !== "active" || !client?.active || !draft?.actions.length || !isDate(draft.expires)
          || Date.parse(draft.expires) <= Date.now() || Date.parse(draft.expires) > Date.parse(client.expires_at)) {
          setMessage("请选择有效客户端、至少一项操作和不超过客户端授权的期限。"); return;
        }
        if (!window.confirm(`授权 ${client.client_name}（${client.binding_id}）在连接 ${c.id} 下${draft.actions.map(a => storageActions[a]).join("、")}，至 ${draft.expires}？不含覆盖、移动、改名或删除；实际执行仍须通过全部门禁。`)) return;
        payload = { binding_id: client.binding_id, authorization_version: client.version, actions: draft.actions, expires_at: draft.expires };
      } else {
        if (!grant || grant.revoked_at !== null) return;
        if (!window.confirm(`停用客户端 ${grant.binding_id} 在此存储连接的权限？不影响它的 Clued 记忆权限或其他客户端；已开始的操作仍须核对回执。`)) return;
        payload = { binding_id: grant.binding_id };
      }
      // Fixed request identity and body for this confirmed operation. An uncertain
      // response clears controls and requires readback, never an automatic regrant.
      payload = { action, connection_id: c.id, base_version: view.connection_version, ...payload, idempotency_key: crypto.randomUUID() };
    }
    operationBusy.current = true; setBusy(true);
    setGrantViews(old => { const next = { ...old }; delete next[c.id]; return next; });
    try {
      if (payload) {
        const result = await request("/v1/storage/account", payload, () => epoch === revision.current);
        if (epoch !== revision.current) return;
        if (result.status !== "committed" || typeof result.receipt_id !== "string") throw new Error("授权回执未确认；请查询授权核对，不会自动重试。");
      }
      if (epoch !== revision.current) return;
      await readClients(c, epoch);
      if (epoch === revision.current) setMessage(action === "list" ? "" : "存储授权设置已确认；正式执行仍受门禁约束。");
    } catch (error) {
      if (epoch === revision.current) setMessage(error instanceof Error ? error.message : "存储授权未确认，请查询授权核对。");
    } finally { operationBusy.current = false; if (epoch === revision.current) setBusy(false); }
  }
  async function register() {
    if (registrationBusy.current || busy) return;
    const profile = profileId.trim(), decision = decisionId.trim();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (!uuid.test(profile) || !uuid.test(decision)) { setMessage("请填写有效的已登记目录 ID 和当前授权 Decision ID。"); return; }
    const epoch = revision.current;
    if (!window.confirm("登记这一个已治理目录的账号连接？目录和授权由服务端核验；此步骤不授予 Google 访问、后台续签或 Agent 文件写入权限。")) return;
    registrationBusy.current = true; setBusy(true);
    try {
      // Stable per-owner receipt identity survives page reload and a lost reply.
      // A revoked connection is not revived by replay; it stays visible as revoked.
      const result = await request("/v1/storage/account", { action: "register", profile_id: profile, source_decision_id: decision,
        idempotency_key: `storage-register-ui-v1:${profile}:${decision}` }, () => epoch === revision.current);
      if (epoch !== revision.current) return;
      if (result.status !== "committed" || typeof result.receipt_id !== "string") throw new Error("登记回执未确认，请刷新状态核对；不要另建重复连接。");
      await refresh();
    } catch (error) {
      if (epoch === revision.current) setMessage(error instanceof Error ? error.message : "登记未确认，请刷新核对；再次提交相同目录与授权会沿用同一请求。");
    } finally { registrationBusy.current = false; if (epoch === revision.current) setBusy(false); }
  }
  async function renewal(c: Connection, action: "status" | "enable" | "disable") {
    if (operationBusy.current || busy) return;
    const previous = renewals[c.id];
    if (action !== "status" && !previous) return;
    if (action === "enable" && !window.confirm("允许 Clued 服务端持续续签这条 Google 连接，直到你主动停用？手机、平板或电脑退出登录不影响续签。仅保留现有授权范围，不新增文件写入权限。")) return;
    if (action === "disable" && !window.confirm("停用后不再发起新的后台续签。已经开始的续签需要核对结果，不能靠重新开启跳过。")) return;
    const epoch = revision.current; operationBusy.current = true; setBusy(true);
    try {
      if (action !== "status") await request("/v1/storage/refresh", { action, connection_id: c.id, base_version: previous.connection_version,
        delegation_version: previous.version, idempotency_key: crypto.randomUUID(), ...(action === "enable" ? { until_revoked: true } : {}) }, () => epoch === revision.current);
      if (epoch !== revision.current) return;
      const value = await request("/v1/storage/refresh", { action: "status", connection_id: c.id }, () => epoch === revision.current);
      if (epoch !== revision.current) return;
      if (typeof value.enabled !== "boolean" || !Number.isSafeInteger(value.version) || !Number.isSafeInteger(value.connection_version) ||
        !Number.isSafeInteger(value.failures) || typeof value.pending !== "boolean" || !(value.next_refresh_at === null || typeof value.next_refresh_at === "string")) throw new Error("续签状态未确认。");
      setRenewals(old => ({ ...old, [c.id]: value as RefreshStatus }));
      setConnections(old => old.map(item => item.id === c.id ? { ...item, version: Number(value.connection_version) } : item));
      setMessage(action === "status" ? "" : "设置已确认。");
    } catch (error) {
      if (epoch === revision.current) {
        setRenewals(old => { const next = { ...old }; delete next[c.id]; return next; });
        setMessage(error instanceof Error ? error.message : "续签设置未确认，请重新查询状态。");
      }
    } finally { operationBusy.current = false; if (epoch === revision.current) setBusy(false); }
  }
  async function operate(c: Connection, revoke: boolean) {
    if (operationBusy.current || busy) return;
    if (revoke && !window.confirm("停用这条账号存储连接？这会阻止该连接后续的新执行和续签；已开始的操作需要核对回执。")) return;
    const enrollRefresh = !revoke && c.state === "awaiting_provider" && (defaultRefresh[c.id] ?? true);
    if (enrollRefresh && !window.confirm("连接成功后，允许 Clued 服务端按原范围自动续签，直到你停用？可先取消并取消勾选。已有停用或失效记录会保持关闭，不会恢复；这不授予 Agent 文件写入权限。")) return;
    operationBusy.current = true;
    setBusy(true);
    const epoch = revision.current;
    try {
      if (revoke) { await request("/v1/storage/account", { action: "revoke_connection", connection_id: c.id, base_version: c.version, idempotency_key: crypto.randomUUID() }, () => epoch === revision.current); if (epoch === revision.current) await refresh(); }
      else {
        const result = await request("/v1/storage/google/start", { connection_id: c.id,
          ...(c.state === "awaiting_provider" ? { default_refresh: enrollRefresh } : {}) }, () => epoch === revision.current);
        if (epoch !== revision.current) return;
        if (typeof result.authorization_url !== "string") throw new Error("授权地址未确认。");
        const url = new URL(result.authorization_url);
        if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth") throw new Error("授权地址未确认。");
        window.location.assign(url.href);
      }
    } catch (error) { if (epoch === revision.current) setMessage(error instanceof Error ? error.message : "操作未确认。"); }
    finally { operationBusy.current = false; if (epoch === revision.current) setBusy(false); }
  }
  return <main className="mx-auto max-w-3xl px-6 py-16"><h1 className="text-2xl font-semibold">账号存储连接</h1>
    <p className="my-4">权限统一归属 Clued 账号；手机、平板和电脑使用同一份服务端规则。Google 凭据不下发到设备。</p>
    <p role="status" className="my-4">{message}</p>
    <section className="my-4 rounded-xl border p-4"><h2>登记已治理目录</h2>
      <p className="my-2 text-sm">仅引用服务端已登记的目录与当前授权，不接受自定义磁盘路径。登记不代表写入已启用；相同请求可安全核对回执，已停用连接不会自动恢复。</p>
      <label className="my-2 block">已登记目录 ID<input className="block w-full rounded border p-2" value={profileId} disabled={busy}
        autoComplete="off" onChange={event => setProfileId(event.target.value)} /></label>
      <label className="my-2 block">当前授权 Decision ID<input className="block w-full rounded border p-2" value={decisionId} disabled={busy}
        autoComplete="off" onChange={event => setDecisionId(event.target.value)} /></label>
      <button disabled={busy || !profileId.trim() || !decisionId.trim()} onClick={() => void register()}>登记账号连接</button>
    </section>
    {connections.map(c => <section className="my-4 rounded-xl border p-4" key={c.id}>
      <h2>{c.provider} · {labels[c.state] ?? "状态待确认"}</h2><p className="my-2 break-all text-sm">连接：{c.id}</p>
      {c.state === "awaiting_provider" && <label className="my-2 block"><input type="checkbox" disabled={busy}
        checked={defaultRefresh[c.id] ?? true} onChange={event => setDefaultRefresh(old => ({ ...old, [c.id]: event.target.checked }))} />
        连接成功后自动续签（可取消；已有停用或失效设置不变）</label>}
      {c.state !== "revoked" && <div className="flex gap-4"><button disabled={busy} onClick={() => void operate(c, false)}>连接 / 重新授权 Google</button>
        <button disabled={busy} onClick={() => void operate(c, true)}>停用连接</button></div>}
      <div className="mt-4 border-t pt-4"><h3>账号级后台续签</h3>
        <p className="my-2 text-sm">新连接在授权时默认选择自动续签，可取消或随时停用；已有停用设置不会自动恢复。由服务端执行，不依赖任何设备在线，不授予 Agent 整理或写入文件的权限。</p>
        <button disabled={busy} onClick={() => void renewal(c, "status")}>查询续签状态</button>
        {renewals[c.id] && <><p role="status" className="my-2">{renewals[c.id].enabled ? "后台续签已开启" : "后台续签已关闭"}
          {renewals[c.id].pending ? "；存在尚未确认的续签。请核对结果，必要时重新授权 Google。" : ""}
          {renewals[c.id].failures > 0 ? `；连续失败 ${renewals[c.id].failures} 次。` : ""}</p>
          <button disabled={busy || (!renewals[c.id].enabled && (c.state !== "active" || renewals[c.id].pending))}
            onClick={() => void renewal(c, renewals[c.id].enabled ? "disable" : "enable")}>{renewals[c.id].enabled ? "停用后台续签" : "授权开启后台续签"}</button></>}
      </div>
      <div className="mt-4 border-t pt-4"><h3>Agent 存储权限</h3>
        <p className="my-2 text-sm">选择已经连接 Clued 的客户端，按账号统一授权，不按设备建权。记忆权限不包含存储权限；这里不会开启尚未验收的文件执行入口。</p>
        <button disabled={busy} onClick={() => void manageClient(c, "list")}>查询客户端存储授权</button>
        {grantViews[c.id] && <>
          {grantViews[c.id].grants.length === 0 && <p>暂无客户端存储授权。</p>}
          {grantViews[c.id].grants.map(g => <div key={g.binding_id} className="my-2 rounded border p-3">
            <p>{clients.find(b => b.binding_id === g.binding_id)?.client_name ?? "已登记客户端"} · {g.binding_id}</p>
            <p>已登记操作：{g.actions.map(a => storageActions[a]).join("、")}；到期：{g.expires_at}</p>
            <p>{g.revoked_at ? "已停用" : !g.binding_current || Date.parse(g.expires_at) <= Date.now() ? "已失效，不能用于新执行" : "授权已登记；实际执行仍需连接、目录与执行器门禁通过"}</p>
            <p className="break-all text-sm">回执：{g.receipt_id}</p>
            {g.revoked_at === null && <button disabled={busy} onClick={() => void manageClient(c, "revoke_client", g)}>停用此客户端存储权限</button>}
          </div>)}
          {grantViews[c.id].connection_state === "active" && <>
            <label className="my-2 block">授权客户端<select className="block w-full rounded border p-2" disabled={busy} value={clientDrafts[c.id]?.binding ?? ""}
              onChange={event => { const client = clients.find(b => b.binding_id === event.target.value);
                setClientDrafts(old => ({ ...old, [c.id]: { binding: client?.binding_id ?? "", actions: [],
                  expires: client ? new Date(Math.min(Date.now() + 3600000, Date.parse(client.expires_at))).toISOString() : "" } })); }}>
              <option value="">请选择客户端</option>{clients.filter(b => b.active && Date.parse(b.expires_at) > Date.now()).map(b =>
                <option key={b.binding_id} value={b.binding_id}>{b.client_name} · {b.binding_id}</option>)}
            </select></label>
            {clientDrafts[c.id]?.binding && <>
              {(Object.keys(storageActions) as StorageAction[]).map(a => <label className="mr-4 inline-block" key={a}><input type="checkbox" disabled={busy}
                checked={clientDrafts[c.id].actions.includes(a)} onChange={event => setClientDrafts(old => ({ ...old, [c.id]: { ...old[c.id],
                  actions: (Object.keys(storageActions) as StorageAction[]).filter(key => key === a ? event.target.checked : old[c.id].actions.includes(key)) } }))} />{storageActions[a]}</label>)}
              <p className="my-2 text-sm">本次授权最长一小时，且不超过客户端原授权期限；到期时间：{clientDrafts[c.id].expires}。不会自动续活此客户端权限。</p>
              <button disabled={busy || !clientDrafts[c.id].actions.length} onClick={() => void manageClient(c, "grant_client")}>确认授予所选存储权限</button>
            </>}
            {!clients.some(b => b.active && Date.parse(b.expires_at) > Date.now()) && <p>没有有效客户端；请先连接 Agent 到 Clued。</p>}
          </>}
        </>}
      </div>
    </section>)}
    <div className="mt-6 flex gap-4"><button disabled={busy} onClick={() => void refresh()}>刷新状态</button><Link href="/">返回 Clued 登录页</Link></div>
  </main>;
}
