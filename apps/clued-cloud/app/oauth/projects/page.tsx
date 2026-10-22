"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { type Session } from "@supabase/supabase-js";
import { supabase, restoreBrowserSession } from "../../supabase-browser";
import Link from "next/link";

const API = "/oauth/projects/api";
type Json = Record<string, unknown>;
type Project = { project_id: string; name: string; environments: string[] };
type Member = { membership_id: string; project_id: string; project_name: string; subject_id: string; environment: string; role: string; actions: string[]; expires_at: string; revoked_at: string | null; version: number };
type Invitation = { invitation_id: string; project_id: string; project_name: string; environment: string; role: string; actions: string[]; expires_at: string; version: number; target_email?: string; status?: string };
type Listing = { owned_projects: Project[]; memberships: Member[]; invitations: Invitation[] };
type Operation = { input: Json; result?: Json; expected?: Invitation };
const actions = { read: "读取开发资料", write: "新增和修改", close: "关闭/撤回记录", feedback_submit: "提交反馈" };
const environments: Record<string, string> = { test: "测试环境", preview: "预览环境", production: "生产环境" };
const object = (value: unknown): value is Json => typeof value === "object" && value !== null;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
const validInvitation = (value: unknown): value is Invitation => object(value) && typeof value.invitation_id === "string"
  && typeof value.project_id === "string" && typeof value.project_name === "string" && typeof value.environment === "string"
  && typeof value.role === "string" && strings(value.actions) && typeof value.version === "number" && Number.isSafeInteger(value.version)
  && typeof value.expires_at === "string" && Number.isFinite(Date.parse(value.expires_at));
function validListing(value: unknown): value is Listing {
  return object(value) && Array.isArray(value.owned_projects) && value.owned_projects.every(row => object(row)
    && typeof row.project_id === "string" && typeof row.name === "string" && strings(row.environments))
    && Array.isArray(value.memberships) && value.memberships.every(row => object(row) && typeof row.membership_id === "string"
      && typeof row.project_id === "string" && typeof row.project_name === "string" && typeof row.subject_id === "string"
      && typeof row.environment === "string" && typeof row.role === "string" && strings(row.actions)
      && typeof row.version === "number" && Number.isSafeInteger(row.version) && typeof row.expires_at === "string"
      && (row.revoked_at === null || typeof row.revoked_at === "string"))
    && Array.isArray(value.invitations) && value.invitations.every(validInvitation);
}
class RequestFailure extends Error { constructor(message: string, readonly uncertain = false) { super(message); } }
async function api(who: Session, signal: AbortSignal, input?: Json): Promise<unknown> {
  const response = await fetch(API, { method: input ? "POST" : "GET", credentials: "same-origin", cache: "no-store", signal,
    headers: { Authorization: "Bearer " + who.access_token, ...(input ? { "Content-Type": "application/json" } : {}) },
    ...(input ? { body: JSON.stringify(input) } : {}) });
  let result: unknown;
  try { result = await response.json(); } catch { throw new RequestFailure("服务返回了不完整的结果，请核对原操作。", true); }
  if (!response.ok) throw new RequestFailure(
    response.status === 401 ? "登录已失效，请重新登录。" : response.status === 409 ? "状态已变化，请重新读取后再操作。"
      : response.status === 403 ? "当前账户不符合此邀请或操作的资格。" : "本次操作未完成，请稍后重试。", response.status >= 500);
  return result;
}
const pendingKey = (subject: string) => "clued.pending-project-invitation:" + subject;
function restoreCreation(subject: string): Operation | null {
  try {
    const raw = window.sessionStorage.getItem(pendingKey(subject));
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!object(value) || !object(value.input)) return null;
    const input = value.input;
    return input.op === "invite_create" && typeof input.idempotency_key === "string"
      && typeof input.project_id === "string" && typeof input.environment === "string"
      && typeof input.target_email === "string" && typeof input.expires_at === "string"
      && (input.role === "reader" || input.role === "editor") && strings(input.actions) ? { input } : null;
  } catch { return null; }
}
function preserveCreation(subject: string, input: Json) {
  if (input.op !== "invite_create") return;
  try { window.sessionStorage.setItem(pendingKey(subject), JSON.stringify({ input })); }
  catch { throw new RequestFailure("浏览器无法保留待确认操作，尚未创建邀请。请允许此站点使用会话存储后重试。"); }
}
function forgetCreation(subject: string) {
  try { window.sessionStorage.removeItem(pendingKey(subject)); } catch { /* A stale entry only replays the original operation. */ }
}
const labelActions = (items: string[]) => items.map(action => actions[action as keyof typeof actions] || action).join("、");
const sameActions = (left: string[], right: string[]) => left.length === right.length && left.every(action => right.includes(action));

export default function OAuthProjectsPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [working, setWorking] = useState(false);
  const [hasPending, setHasPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [register, setRegister] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [environment, setEnvironment] = useState("");
  const [targetEmail, setTargetEmail] = useState("");
  const [role, setRole] = useState<"reader" | "editor">("reader");
  const [inviteActions, setInviteActions] = useState<string[]>(["read"]);
  const [days, setDays] = useState(7);
  const [createdLink, setCreatedLink] = useState("");
  const [now, setNow] = useState(0);
  const currentSession = useRef<Session | null>(null);
  const epoch = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const writeController = useRef<AbortController | null>(null);
  const inviteToken = useRef("");
  const operation = useRef<Operation | null>(null);

  const applyListing = useCallback((value: Listing) => {
    setListing(value);
    setSelected(Object.fromEntries(value.memberships.map(member => [member.membership_id, [...member.actions]])));
    setNow(Date.now());
  }, []);
  const read = useCallback(async (who: Session, generation: number) => {
    readController.current?.abort();
    const controller = new AbortController(); readController.current = controller;
    setLoading(true); setError("");
    try {
      const value = await api(who, controller.signal);
      if (!validListing(value)) throw new Error("服务返回了不完整的项目资格列表。");
      if (epoch.current !== generation || controller.signal.aborted) return;
      applyListing(value);
      if (inviteToken.current) {
        const inspected = await api(who, controller.signal, { op: "invite_inspect", invite_token: inviteToken.current });
        if (!validInvitation(inspected)) throw new Error("无法确认此邀请的具体范围。");
        if (epoch.current === generation && !controller.signal.aborted) setInvitation(inspected);
      }
    } catch (failure) {
      if (epoch.current === generation && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : "暂时无法读取项目资格。");
    } finally {
      if (epoch.current === generation && !controller.signal.aborted) setLoading(false);
    }
  }, [applyListing]);
  useEffect(() => {
    let mounted = true;
    void restoreBrowserSession().then(result => {
      if (mounted && result.error) setError("登录链接未通过验证，请重新打开邀请或验证邮件中的链接。");
    });
    return () => { mounted = false; };
  }, []);
  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const token = fragment.get("invite") || "";
    if (token && /^clued_inv_[a-f0-9]{64}$/.test(token)) inviteToken.current = token;
    if (fragment.has("invite")) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, []);
  useEffect(() => {
    let disposed = false, first = true;
    let timer: number | undefined;
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (disposed) return;
      const previousId = currentSession.current?.user.id;
      const changed = first || previousId !== nextSession?.user.id;
      first = false; currentSession.current = nextSession; setSession(nextSession);
      if (!changed) return;
      const generation = ++epoch.current;
      readController.current?.abort(); writeController.current?.abort(); writeController.current = null;
      window.clearTimeout(timer);
      if (previousId) inviteToken.current = "";
      const recovered = nextSession ? restoreCreation(nextSession.user.id) : null;
      operation.current = recovered;
      setListing(null); setInvitation(null); setSelected({}); setCreatedLink(""); setPassword("");
      setError(""); setNotice(""); setAuthBusy(false); setWorking(false); setHasPending(Boolean(recovered));
      setProjectId(""); setEnvironment(""); setTargetEmail(""); setInviteActions(["read"]); setRole("reader");
      setLoading(Boolean(nextSession));
      if (nextSession) timer = window.setTimeout(() => { void read(nextSession, generation); }, 0);
    });
    return () => { disposed = true; window.clearTimeout(timer); readController.current?.abort(); writeController.current?.abort(); data.subscription.unsubscribe(); };
  }, [read]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setAuthBusy(true); setError(""); setNotice("");
    const generation = epoch.current;
    try {
      const result = register
        ? await supabase.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: new URL("/oauth/projects", window.location.origin).href } })
        : await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (epoch.current !== generation) return;
      if (result.error) setError(register ? "暂时无法注册，请检查邮箱和密码后重试。" : "登录失败，请检查邮箱和密码。");
      else if (register) setNotice("请按邮件提示验证邮箱，然后重新打开原来的项目邀请链接。注册不会自动创建个人记忆。");
    } catch { if (epoch.current === generation) setError("账户服务暂不可用，请稍后重试。"); }
    finally { if (epoch.current === generation) { setPassword(""); setAuthBusy(false); } }
  }
  async function switchAccount() {
    ++epoch.current; readController.current?.abort(); writeController.current?.abort(); writeController.current = null;
    inviteToken.current = ""; operation.current = null;
    setListing(null); setInvitation(null); setSelected({}); setCreatedLink(""); setHasPending(false); setWorking(false); setLoading(false);
    setAuthBusy(true); setError(""); setNotice("");
    const generation = epoch.current;
    try {
      const { error: failure } = await supabase.auth.signOut({ scope: "local" });
      if (failure && epoch.current === generation) setError("退出未完成，请重新读取当前账户的项目。");
    } catch { if (epoch.current === generation) setError("退出未完成，请稍后重试。"); }
    finally { if (epoch.current === generation) setAuthBusy(false); }
  }
  async function reload() { const who = currentSession.current; if (who && !writeController.current) await read(who, epoch.current); }

  const perform = useCallback(async (next?: Operation) => {
    const who = currentSession.current, generation = epoch.current;
    if (!who || writeController.current) return;
    if (next && operation.current) return;
    const candidate = next || operation.current;
    if (!candidate) return;
    let pending: Operation = candidate;
    operation.current = pending; setHasPending(true); setWorking(true); setError(""); setNotice("");
    const controller = new AbortController(); writeController.current = controller;
    const stillCurrent = () => epoch.current === generation && currentSession.current?.user.id === who.user.id && !controller.signal.aborted;
    try {
      if (!pending.result) {
        preserveCreation(who.user.id, pending.input);
        const result = await api(who, controller.signal, pending.input);
        if (!object(result)) throw new RequestFailure("操作结果不完整，请核对原操作。", true);
        if (!stillCurrent()) return;
        pending = { ...pending, result }; operation.current = pending;
      }
      const confirmed = pending.result!;
      const value = await api(who, controller.signal);
      if (!validListing(value)) throw new RequestFailure("操作已返回，最新状态尚未确认，请核对原操作。", true);
      if (!stillCurrent()) return;
      const op = pending.input.op;
      if (op === "invite_create") {
        const found = value.invitations.find(item => item.invitation_id === confirmed.invitation_id);
        if (!found) throw new RequestFailure("最新列表尚未确认邀请，请核对原操作。", true);
        const token = confirmed.invite_token;
        if (found.status !== "pending" || Date.parse(found.expires_at) <= Date.now()) {
          setCreatedLink(""); setNotice("已核实原邀请已经关闭或过期。需要时请明确创建新邀请。");
        } else if (typeof token === "string" && /^clued_inv_[a-f0-9]{64}$/.test(token)) {
          setCreatedLink(new URL("/oauth/projects#invite=" + encodeURIComponent(token), window.location.origin).href);
          setNotice("邀请已创建。复制下方链接，发送给指定受邀人；链接仅显示这一次。");
        } else {
          setCreatedLink(""); setNotice("已确认原邀请，链接无法再次取回。请先撤销该邀请，再明确创建新邀请。");
        }
      } else if (op === "invite_accept") {
        if (!pending.expected || !value.memberships.some(member => member.membership_id === confirmed.membership_id && member.subject_id === who.user.id && !member.revoked_at
          && member.role === pending.expected?.role && sameActions(member.actions, pending.expected?.actions || [])
          && member.expires_at === pending.expected?.expires_at && Date.parse(member.expires_at) > Date.now()
          && member.project_id === pending.expected?.project_id && member.environment === pending.expected?.environment)) {
          throw new RequestFailure("最新状态尚未确认项目资格，请核对原操作。", true);
        }
        inviteToken.current = ""; setInvitation(null); setNotice("已加入指定项目。回到客户端重新连接，再选择允许它使用的权限。");
      } else if (op === "member_reduce") {
        const member = value.memberships.find(item => item.membership_id === pending.input.membership_id);
        if (!member || member.version <= Number(pending.input.base_version) || !strings(pending.input.actions) || !sameActions(member.actions, pending.input.actions)) {
          throw new RequestFailure("最新状态尚未确认减权，请核对原操作。", true);
        }
        setNotice("已减少该成员的项目权限。");
      } else if (op === "member_revoke") {
        const member = value.memberships.find(item => item.membership_id === pending.input.membership_id);
        if (member && !member.revoked_at) throw new RequestFailure("最新状态尚未确认撤销，请核对原操作。", true);
        setNotice("已撤销该成员的项目资格。");
      } else if (op === "invite_revoke") {
        const invite = value.invitations.find(item => item.invitation_id === pending.input.invitation_id);
        if (invite && !["revoked", "cancelled"].includes((invite.status || "").toLowerCase())) throw new RequestFailure("最新状态尚未确认撤销，请核对原操作。", true);
        setCreatedLink(""); setNotice("已撤销该邀请。");
      }
      applyListing(value);
      if (op === "invite_create") forgetCreation(who.user.id);
      operation.current = null; setHasPending(false);
    } catch (failure) {
      if (!stillCurrent()) return;
      const uncertain = pending.result || !(failure instanceof RequestFailure) || failure.uncertain;
      if (!uncertain) {
        if (pending.input.op === "invite_create") forgetCreation(who.user.id);
        operation.current = null; setHasPending(false);
      }
      setError(uncertain ? "原操作结果尚未确认。请核对原操作，不要重复创建新的邀请。" : failure instanceof Error ? failure.message : "本次操作未完成。");
    } finally {
      if (stillCurrent()) { writeController.current = null; setWorking(false); }
    }
  }, [applyListing]);

  const busy = loading || authBusy || working;
  const locked = busy || hasPending;
  const project = listing?.owned_projects.find(item => item.project_id === projectId);
  const allowedActions = role === "reader" ? ["read"] : Object.keys(actions);
  const invitationAlreadyPending = listing?.invitations.some(item => item.project_id === projectId && item.environment === environment
    && item.target_email?.toLowerCase() === targetEmail.trim().toLowerCase() && item.status === "pending" && Date.parse(item.expires_at) > now) || false;
  const createInvitation = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!project || !project.environments.includes(environment) || !inviteActions.length || locked || invitationAlreadyPending) return;
    const eligibleActions = role === "reader" ? ["read"] : Object.keys(actions);
    await perform({ input: { op: "invite_create", project_id: projectId, environment, target_email: targetEmail.trim(), role,
      actions: inviteActions.filter(action => eligibleActions.includes(action)), expires_at: new Date(Date.now() + days * 86400000).toISOString(),
      idempotency_key: crypto.randomUUID() } });
  }, [project, environment, inviteActions, locked, perform, projectId, targetEmail, role, days, invitationAlreadyPending]);
  async function acceptInvitation() {
    if (!invitation || !inviteToken.current || locked) return;
    await perform({ input: { op: "invite_accept", invite_token: inviteToken.current, base_version: invitation.version, idempotency_key: crypto.randomUUID() }, expected: invitation });
  }

  return <main className="oauth-shell"><section className="oauth-card" aria-busy={busy}>
    <Link className="oauth-brand" href="/"><span className="brand-mark" aria-hidden="true" /><span>BeamingFace</span></Link>
    <h1>开发项目资格</h1><p className="oauth-copy">接受指定项目邀请，或管理你拥有的项目成员。加入项目后，仍由你选择授予每个客户端的权限。</p>
    {busy && <p role="status">正在核验账户与项目…</p>}
    {error && <div className="oauth-error" role="alert"><strong>尚未完成</strong><p>{error}</p>
      </div>}
    {hasPending && !working && <div className="oauth-note" role="status"><p>有一项待确认操作。先核对原结果，再开始新的操作。</p><button type="button" disabled={busy} onClick={() => void perform()}>核对原操作</button></div>}
    {notice && <p className="oauth-note" role="status">{notice}</p>}
    {!session && !loading && <><h2>{register ? "注册 BeamingFace 账户" : "登录 BeamingFace 账户"}</h2>
      <form className="oauth-form" onSubmit={authenticate}>
        <label>邮箱<input type="email" required autoComplete="email" value={email} disabled={authBusy} onChange={event => setEmail(event.target.value)} /></label>
        <label>密码<input type="password" required minLength={8} autoComplete={register ? "new-password" : "current-password"} value={password} disabled={authBusy} onChange={event => setPassword(event.target.value)} /></label>
        <button className="primary-button" disabled={authBusy} type="submit">{register ? "注册并验证邮箱" : "登录并查看邀请"}</button>
      </form><div className="oauth-actions"><button className="oauth-secondary" disabled={authBusy} type="button" onClick={() => { setRegister(!register); setPassword(""); setError(""); }}>{register ? "已有账户，登录" : "没有账户，注册"}</button><Link href="/oauth/account">忘记密码</Link></div>
      <p className="oauth-note">使用邀请指定的邮箱。验证或切换账户后，请重新打开原邀请链接。</p></>}
    {session && <>
      <p>当前账户：{session.user.email || session.user.id}</p><div className="oauth-actions">
        <button className="oauth-secondary" type="button" disabled={authBusy} onClick={() => void switchAccount()}>切换账户</button>
        <button className="oauth-secondary" type="button" disabled={busy || hasPending} onClick={() => void reload()}>重新读取</button></div>
      {invitation && <section className="oauth-permissions"><h2>确认项目邀请</h2><p>{invitation.project_name} · {environments[invitation.environment] || invitation.environment}</p>
        <p>允许：{labelActions(invitation.actions)}</p><p>有效期至：{new Date(invitation.expires_at).toLocaleString("zh-CN")}</p>
        <button className="primary-button" type="button" disabled={locked || Date.parse(invitation.expires_at) <= now} onClick={() => void acceptInvitation()}>接受此邀请</button></section>}
      {listing && <><h2>我的项目资格</h2>
        {!listing.memberships.some(member => member.subject_id === session.user.id && !member.revoked_at) && <p>尚未加入开发项目。请向项目所有者索取定向邀请，并打开邀请链接。</p>}
        {listing.memberships.filter(member => member.subject_id === session.user.id).map(member => <div className="oauth-permissions" key={member.membership_id}>
          <strong>{member.project_name} · {environments[member.environment] || member.environment}</strong>
          <p>{member.revoked_at ? "资格已撤销" : Date.parse(member.expires_at) <= now ? "资格已过期" : labelActions(member.actions)}</p></div>)}
        {!!listing.owned_projects.length && <><h2>邀请项目成员</h2><form className="oauth-form" onSubmit={createInvitation}>
          <label>项目<select required value={projectId} disabled={locked} onChange={event => { setProjectId(event.target.value); setEnvironment(""); }}><option value="">请选择项目</option>{listing.owned_projects.map(item => <option key={item.project_id} value={item.project_id}>{item.name}</option>)}</select></label>
          <label>环境<select required value={environment} disabled={locked || !project} onChange={event => setEnvironment(event.target.value)}><option value="">请选择环境</option>{project?.environments.map(item => <option key={item} value={item}>{environments[item] || item}</option>)}</select></label>
          <label>受邀邮箱<input type="email" required value={targetEmail} disabled={locked} onChange={event => setTargetEmail(event.target.value)} /></label>
          <label>资格<select value={role} disabled={locked} onChange={event => { setRole(event.target.value as "reader" | "editor"); setInviteActions(["read"]); }}><option value="reader">只读成员</option><option value="editor">开发维护成员</option></select></label>
          <fieldset disabled={locked}><legend>允许的操作</legend>{allowedActions.map(action => <label key={action} style={{ display: "flex", gap: 8, margin: "8px 0" }}><input type="checkbox" checked={inviteActions.includes(action)} onChange={event => setInviteActions(old => event.target.checked ? [...old, action] : old.filter(item => item !== action))} />{actions[action as keyof typeof actions]}</label>)}</fieldset>
          <label>有效期<select value={days} disabled={locked} onChange={event => setDays(Number(event.target.value))}><option value={1}>1 天</option><option value={7}>7 天</option><option value={14}>14 天</option></select></label>
          <button className="primary-button" type="submit" disabled={locked || !project || !environment || !inviteActions.length || invitationAlreadyPending}>创建定向邀请</button>
        </form>{invitationAlreadyPending && <p className="oauth-note">已有相同项目、环境和受邀人的待接受邀请。请先撤销原邀请，再创建新邀请。</p>}<p className="oauth-note">此邀请不含成员管理或生产发布权限。链接不会自动发送。</p></>}
        {createdLink && <label className="oauth-form">复制邀请链接<input type="text" readOnly value={createdLink} onFocus={event => event.currentTarget.select()} /></label>}
        {!!listing.invitations.length && <><h2>已创建的邀请</h2>{listing.invitations.map(item => <div className="oauth-permissions" key={item.invitation_id}>
          <strong>{item.project_name} · {environments[item.environment] || item.environment}</strong><p>{item.target_email} · {item.status}</p>
          <p>{labelActions(item.actions)}</p><p>邀请编号：{item.invitation_id}</p>
          <button className="oauth-secondary" type="button" disabled={locked || Date.parse(item.expires_at) <= now || ["revoked", "accepted", "cancelled"].includes((item.status || "").toLowerCase())}
            onClick={() => void perform({ input: { op: "invite_revoke", invitation_id: item.invitation_id, base_version: item.version, idempotency_key: crypto.randomUUID() } })}>撤销邀请</button>
        </div>)}</>}
        {listing.memberships.filter(member => listing.owned_projects.some(item => item.project_id === member.project_id)).map(member => <fieldset className="oauth-permissions" disabled={locked || !!member.revoked_at || Date.parse(member.expires_at) <= now} key={member.membership_id}>
          <legend>{member.project_name} · {environments[member.environment] || member.environment}</legend><p>成员：{member.subject_id}</p>
          {member.actions.map(action => <label key={action} style={{ display: "flex", gap: 8, margin: "8px 0" }}><input type="checkbox" checked={(selected[member.membership_id] || []).includes(action)}
            onChange={event => setSelected(old => ({ ...old, [member.membership_id]: event.target.checked ? [...(old[member.membership_id] || []), action] : (old[member.membership_id] || []).filter(item => item !== action) }))} />{actions[action as keyof typeof actions] || action}</label>)}
          <div className="oauth-actions"><button className="oauth-secondary" type="button" disabled={!(selected[member.membership_id]?.length) || sameActions(member.actions, selected[member.membership_id] || [])}
            onClick={() => void perform({ input: { op: "member_reduce", membership_id: member.membership_id, base_version: member.version,
              actions: member.actions.filter(action => (selected[member.membership_id] || []).includes(action)), idempotency_key: crypto.randomUUID() } })}>保存减少的权限</button>
            <button className="oauth-secondary" type="button" onClick={() => void perform({ input: { op: "member_revoke", membership_id: member.membership_id, base_version: member.version, idempotency_key: crypto.randomUUID() } })}>撤销成员资格</button></div>
        </fieldset>)}
      </>}
      <p><Link href="/oauth/connections">管理客户端连接</Link></p>
    </>}
  </section></main>;
}
