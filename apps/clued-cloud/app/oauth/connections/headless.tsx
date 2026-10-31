"use client";

import { useEffect, useRef, useState } from "react";
import { type Session } from "@supabase/supabase-js";
import { supabase } from "../../supabase-browser";
import ContextAuthorizationControls from '../../../lib/context-authorization-controls';
import { ACTION_LABELS as ACTIONS, applyPreset, authorizationDisplayOrder, changeRange, initialSelection, isAllContexts, operationSummary, presetActions,
  resourceKey as grantKey, resourceTitle as resourceName, selectedResources, type Resource, type OperationPreset } from '../../../lib/context-authorization';

// Headless Binding issuance (Task 364212a1, Owner Decision 6e0371e3). A client
// that cannot do OAuth (CI, a runner, a script) gets its own Binding token here.
// Step 1 asks Clued to render exactly what will be issued and returns a
// single-use confirmation token over that view; "确认签发" commits that view
// and returns the Binding token once. Only its hash is stored. Every RPC runs
// as this signed-in account session; Bindings and delegated OAuth are refused.
type Json = Record<string, unknown>;
type Grant = Resource & { limits?: Json };
type Source = { source_id: string; version: number; actions: string[] };
type Override = { override_id: string; version: number };
type Row = { binding_id: string; agent_name: string; vendor: string; kind: string; expires_at: string | null;
  created_at: string | null; version: number | null; grants: Grant[] | null; roles: string[]; replaced_by: string | null;
  scopes: string[] | null; active?: boolean; selection_format?: string; sources: Source[]; overrides: Override[] };
type Pending = { confirmation_token: string; view_digest: string; view: Json };
type Issued = { token: string; binding_id: string; expires_at: string; replaced: Json | null };

const object = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown) => Array.isArray(value) ? value.map(String) : [];
const ROLES: Record<string, string> = { "ci-admission": "CI 准入", "release-door": "发布门口" };
const SCOPE_LABELS: Record<string, string> = { 'context:read': '读取内容', 'context:write': '新增和修改内容', 'audit:read': '读取审计回执',
  'ci:heartbeat': '仅发送常驻节点心跳（不能读取任何资料）' };
// A heartbeat token (Task f2e9a8c6) carries only ci:heartbeat: it reads nothing and
// no other interface accepts it. It is issued in its own two steps and never rotated.
const heartbeatOnly = (row: Row) => row.scopes !== null && row.scopes.length === 1 && row.scopes[0] === 'ci:heartbeat';
// Where each role's token lives on GitHub (PermissionSimplification §3.5). A
// rotation moves the role at once, but the stored secret does not follow.
const ROLE_SECRETS: Record<string, string> = {
  "ci-admission": "GitHub 环境 clued-admission 的 secret CLUED_ADMISSION_CLUED_TOKEN",
  "release-door": "GitHub 环境 clued-release 的 secret CLUED_RELEASE_TOKEN",
};
const secretsFor = (roles: string[]) => roles.map(r => ROLE_SECRETS[r]).filter(Boolean);
const DAYS = [7, 30, 90];
const MESSAGES: Record<string, string> = {
  direct_human_session_required: "需要你本人直接登录 BeamingFace，授权给应用的登录不能签发令牌。",
  confirmation_token_session_id_required: "当前登录缺少会话信息，请退出后重新登录。",
  confirmation_token_expired: "确认已超过 5 分钟有效期，请重新预览。",
  confirmation_token_revoked: "确认已被更新的预览取代，请按页面当前内容操作。",
  confirmation_token_reused: "这次确认已经用过，请刷新后查看结果。",
  confirmation_view_stale: "预览之后内容发生了变化，请重新预览。",
  explicit_nonempty_selection_required: "请至少勾选一项权限。",
  selection_exceeds_requested_or_owned_permissions: "勾选的权限超出了你能授予的范围，请刷新后重选。",
  headless_binding_label_invalid: "名称需要 1 到 80 个字符，不能包含换行。",
  headless_binding_expiry_invalid: "有效期需要在 1 到 90 天之间。",
  headless_binding_replace_target_invalid: "要替换的令牌已撤销、已过期或不能替换，请刷新页面。",
  headless_binding_role_scope_missing: "被替换的令牌带有专用角色，新令牌需要保留对应权限（CI 准入要读取，发布门口要新增和修改）。",
  headless_binding_limit_reached: "有效的无头令牌已达 50 个，请先撤销不用的。",
  headless_binding_revoke_target_invalid: "这个令牌已撤销或不能在这里撤销，请刷新页面。",
};
class RequestFailure extends Error {}

async function rpc(name: string, input: Json): Promise<Json> {
  let result: { data: unknown; error: { message?: string; code?: string } | null };
  try {
    result = await supabase.rpc(name, { p_input: input });
  } catch { throw new RequestFailure("网络请求未完成，请刷新后查看结果。"); }
  if (result.error) {
    const code = result.error.message ?? "";
    throw new RequestFailure(MESSAGES[code] ?? (result.error.code ? "请求被拒绝（" + code + "）。" : "网络请求未完成，请刷新后查看结果。"));
  }
  const value = result.data;
  if (!object(value)) throw new RequestFailure("服务返回了无法识别的结果。");
  if (value.status === "rejected" || value.status === "failed") {
    const code = typeof value.error_code === "string" ? value.error_code : String(value.status);
    throw new RequestFailure(MESSAGES[code] ?? "请求被拒绝（" + code + "）。");
  }
  return value;
}

function grants(value: unknown): Grant[] {
  return Array.isArray(value) ? value.filter(object).map(item => ({ ...item, resource_kind: item.resource_kind === "context" ? "context" : "scope",
    resource_id: String(item.resource_id), environment: String(item.environment), actions: strings(item.actions),
    name: typeof item.name === "string" ? item.name : undefined,
    project_id: typeof item.project_id === "string" ? item.project_id : null,
    project_name: typeof item.project_name === "string" ? item.project_name : null,
    context_name: typeof item.context_name === "string" ? item.context_name : null,
    effective_actions: Array.isArray(item.effective_actions) ? strings(item.effective_actions) : undefined })) : [];
}
function parseSources(value: unknown, required: boolean): Source[] {
  if (!required && !Array.isArray(value)) return [];
  if (!Array.isArray(value) || !value.every(item => object(item) && typeof item.source_id === 'string' && Number.isSafeInteger(item.version)
    && Number(item.version) > 0 && Array.isArray(item.actions) && item.actions.every(action => typeof action === 'string'))) throw new RequestFailure('服务返回了不完整的授权来源，请重新读取。');
  return value as Source[];
}
function parseOverrides(value: unknown, required: boolean): Override[] {
  if (!required && !Array.isArray(value)) return [];
  if (!Array.isArray(value) || !value.every(item => object(item) && typeof item.override_id === 'string' && Number.isSafeInteger(item.version)
    && Number(item.version) > 0)) throw new RequestFailure('服务返回了不完整的精确权限限制，请重新读取。');
  return value as Override[];
}
function rotationSnapshotValid(row: Row, value: unknown): boolean {
  if (!object(value) || value.binding_version !== row.version || !Array.isArray(value.sources)
    || !Array.isArray(value.exceptions) || !Array.isArray(value.grant_limits)) return false;
  const sources = value.sources, exceptions = value.exceptions;
  return row.sources.every(source => sources.some(item => object(item) && item.source_id === source.source_id
      && item.version === source.version && Array.isArray(item.actions) && item.actions.length === source.actions.length
      && source.actions.every(action => (item.actions as unknown[]).includes(action))))
    && row.overrides.every(override => exceptions.some(item => object(item) && item.override_id === override.override_id && item.version === override.version))
    && value.grant_limits.every(item => object(item) && typeof item.grant_id === 'string' && typeof item.context_id === 'string'
      && Number.isSafeInteger(item.version) && Number(item.version) > 0 && Array.isArray(item.actions)
      && typeof item.history_policy === 'string' && typeof item.version_policy === 'string' && Array.isArray(item.allowed_fields));
}
function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter(object).map(item => ({ binding_id: String(item.binding_id),
    agent_name: String(item.agent_name ?? ""), vendor: String(item.vendor ?? ""), kind: String(item.kind),
    expires_at: typeof item.expires_at === "string" && Number.isFinite(Date.parse(item.expires_at)) ? item.expires_at : null,
    created_at: typeof item.created_at === "string" ? item.created_at : null,
    version: typeof item.version === "number" ? item.version : null,
    grants: Array.isArray(item.grants) ? grants(item.grants) : null, roles: strings(item.roles),
    scopes: Array.isArray(item.scopes) && item.scopes.every(scope => typeof scope === 'string') ? [...item.scopes] : null,
    active: typeof item.active === 'boolean' ? item.active : undefined,
    replaced_by: typeof item.replaced_by === "string" ? item.replaced_by : null,
    selection_format: typeof item.selection_format === "string" ? item.selection_format : undefined,
    sources: parseSources(item.sources, item.selection_format === 'sources_v1'), overrides: parseOverrides(item.overrides, item.selection_format === 'sources_v1') })) : [];
}
const when = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN") : "未提供，尚未确认";
const unavailable = (row: Row) => row.active === false || !!row.replaced_by || (row.expires_at !== null && Date.parse(row.expires_at) <= Date.now());
const failure = (error: unknown, fallback: string) => error instanceof RequestFailure ? error.message : fallback;

export default function HeadlessBindings() {
  const [session, setSession] = useState<Session | null>(null);
  const [list, setList] = useState<Row[] | null>(null);
  const [eligible, setEligible] = useState<Grant[]>([]);
  const [label, setLabel] = useState("");
  const [days, setDays] = useState(30);
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [preset, setPreset] = useState<OperationPreset>('full');
  const [range, setRange] = useState<'all' | 'specified'>('specified');
  const [custom, setCustom] = useState(false);
  const [selectionNotice, setSelectionNotice] = useState('');
  const [replaces, setReplaces] = useState<Row | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [copied, setCopied] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [heartbeatLabel, setHeartbeatLabel] = useState("");
  const [heartbeatDays, setHeartbeatDays] = useState(90);
  const [heartbeatPending, setHeartbeatPending] = useState<Pending | null>(null);
  const current = useRef<Session | null>(null);
  const epoch = useRef(0);

  useEffect(() => {
    const lifetime = epoch;
    let disposed = false;
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      if (disposed) return;
      const changed = current.current?.user.id !== next?.user.id;
      current.current = next; setSession(next);
      if (!changed) return;
      ++epoch.current;
      setList(null); setEligible([]); setChosen({}); setReplaces(null); setPending(null); setIssued(null);
      setLabel(""); setError(""); setNotice(""); setWorking(false);
      setHeartbeatLabel(""); setHeartbeatPending(null);
    });
    return () => { disposed = true; ++lifetime.current; data.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (session) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id]);

  async function load() {
    const generation = epoch.current;
    setWorking(true); setError("");
    try {
      const value = await rpc("clued_headless_binding_list_v1", {});
      if (epoch.current !== generation) return;
      const resources = grants(value.eligible);
      setList(rows(value.bindings)); setEligible(resources);
      if (!replaces) { const initial = initialSelection(resources); setChosen(initial.selected); setRange(initial.range); setPreset(initial.preset); setCustom(false); setSelectionNotice(''); }
      setPending(null);
    } catch (problem) {
      if (epoch.current === generation) setError(failure(problem, "暂时无法读取无头令牌。"));
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  function selection(): Grant[] {
    return replaces?.selection_format === 'sources_v1' ? [] : selectedResources(eligible, chosen);
  }

  function toggle(grant: Grant, action: string, on: boolean) {
    setCustom(true); setPending(null);
    setChosen(previous => {
      const values = previous[grantKey(grant)] ?? [];
      return { ...previous, [grantKey(grant)]: on ? grant.actions.filter(item => item === action || values.includes(item))
        : values.filter(item => item !== action) };
    });
  }

  function rotate(row: Row) {
    setReplaces(row); setLabel(row.agent_name); setIssued(null); setPending(null); setNotice(""); setError("");
    setChosen(Object.fromEntries((row.grants ?? []).map(grant => [grantKey(grant), [...grant.actions]])));
    setRange((row.grants ?? []).some(isAllContexts) ? 'all' : 'specified');
    const operation = operationSummary(row.grants ?? []); setPreset(operation === '只读' ? 'reader' : operation === '可编辑' ? 'developer' : 'full'); setCustom(operation === '自定义／受限');
    setSelectionNotice('轮换沿用原授权及限制；新连接默认选择不会扩大旧令牌范围。');
  }

  function resetForm() {
    setReplaces(null); setLabel(""); setDays(30); setPending(null);
    const initial = initialSelection(eligible); setChosen(initial.selected); setRange(initial.range); setPreset(initial.preset); setCustom(false); setSelectionNotice('');
  }

  // Step 1: Clued renders what will be issued and returns a token for exactly that.
  async function preview() {
    if (!current.current || working) return;
    const generation = epoch.current;
    setWorking(true); setError(""); setNotice(""); setIssued(null);
    try {
      const value = await rpc("clued_headless_binding_confirmation_issue_v1", { label: label.trim(), days,
        selected: selection(), ...(replaces ? { replaces_binding_id: replaces.binding_id } : {}),
        ...(replaces?.selection_format === 'sources_v1' ? { selection_format: 'sources_v1',
          sources: replaces.sources.map(source => ({ source_id: source.source_id, base_version: source.version, action_cap: source.actions })),
          exceptions: replaces.overrides.map(item => ({ override_id: item.override_id, base_version: item.version })) } : {}) });
      if (epoch.current !== generation) return;
      if (value.status !== "issued" || typeof value.confirmation_token !== "string" || typeof value.view_digest !== "string"
        || !object(value.confirmation_view)) throw new RequestFailure("服务返回了无法识别的确认内容。");
      if (replaces?.selection_format === 'sources_v1' && !rotationSnapshotValid(replaces, value.confirmation_view.source_snapshot)) throw new RequestFailure('轮换的授权来源或限制版本预览不完整，请重新读取。');
      setPending({ confirmation_token: value.confirmation_token, view_digest: value.view_digest, view: value.confirmation_view });
    } catch (problem) {
      if (epoch.current === generation) setError(failure(problem, "暂时无法生成预览。"));
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  // Step 2: commit exactly the previewed view; the token is returned once.
  async function confirm() {
    const target = pending;
    if (!target || working) return;
    const generation = epoch.current;
    setWorking(true); setError("");
    try {
      const value = await rpc("clued_headless_binding_issue_v1",
        { confirmation_token: target.confirmation_token, view_digest: target.view_digest });
      if (epoch.current !== generation) return;
      setPending(null);
      if (value.status === "committed" && typeof value.token === "string" && typeof value.binding_id === "string") {
        setIssued({ token: value.token, binding_id: value.binding_id, expires_at: String(value.expires_at),
          replaced: object(value.replaced) ? value.replaced : null });
        setCopied(false); resetForm();
      } else {
        setNotice("这次确认已经处理过。令牌只在签发时显示一次；如果没有保存，请撤销它并重新签发。");
      }
      await load();
    } catch (problem) {
      if (epoch.current === generation) { setPending(null); setError(failure(problem, "签发结果未确认，请刷新后查看，不要重复提交。")); }
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  // A heartbeat token: the same two Native steps, with no permission to choose.
  async function previewHeartbeat() {
    if (!current.current || working) return;
    const generation = epoch.current;
    setWorking(true); setError(""); setNotice(""); setIssued(null);
    try {
      const value = await rpc("clued_headless_heartbeat_binding_confirmation_issue_v1", { label: heartbeatLabel.trim(), days: heartbeatDays });
      if (epoch.current !== generation) return;
      if (value.status !== "issued" || typeof value.confirmation_token !== "string" || typeof value.view_digest !== "string"
        || !object(value.confirmation_view)) throw new RequestFailure("服务返回了无法识别的确认内容。");
      setHeartbeatPending({ confirmation_token: value.confirmation_token, view_digest: value.view_digest, view: value.confirmation_view });
    } catch (problem) {
      if (epoch.current === generation) setError(failure(problem, "暂时无法生成预览。"));
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  async function confirmHeartbeat() {
    const target = heartbeatPending;
    if (!target || working) return;
    const generation = epoch.current;
    setWorking(true); setError("");
    try {
      const value = await rpc("clued_headless_heartbeat_binding_issue_v1",
        { confirmation_token: target.confirmation_token, view_digest: target.view_digest });
      if (epoch.current !== generation) return;
      setHeartbeatPending(null);
      if (value.status === "committed" && typeof value.token === "string" && typeof value.binding_id === "string") {
        setIssued({ token: value.token, binding_id: value.binding_id, expires_at: String(value.expires_at), replaced: null });
        setCopied(false); setHeartbeatLabel("");
      } else {
        setNotice("这次确认已经处理过。令牌只在签发时显示一次；如果没有保存，请撤销它并重新签发。");
      }
      await load();
    } catch (problem) {
      if (epoch.current === generation) { setHeartbeatPending(null); setError(failure(problem, "签发结果未确认，请刷新后查看，不要重复提交。")); }
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  // Headless tokens are revoked through their v12 authorization; legacy ones
  // have none, so Clued revokes them through clued_headless_binding_revoke_v1.
  async function revoke(row: Row) {
    if (working || (row.kind === "headless" && row.version === null)) return;
    const roles = row.roles.length ? `它带有专用角色 ${row.roles.map(r => ROLES[r] ?? r).join("、")}，撤销后这些角色仍然锁定：在你到「专用 Binding」页（/bindings）给有效的连接标上或取消之前，任何连接都做不了这些事。` : "";
    if (!window.confirm(`撤销「${row.agent_name}」？使用这个令牌的客户端会立即失去访问。${roles}`)) return;
    const generation = epoch.current;
    setWorking(true); setError(""); setNotice("");
    try {
      if (row.kind === "headless") {
        await rpc("clued_authorization_manage_v12", { op: "revoke", binding_id: row.binding_id, base_version: row.version });
      } else {
        await rpc("clued_headless_binding_revoke_v1", { binding_id: row.binding_id });
      }
      if (epoch.current !== generation) return;
      setNotice(`已撤销「${row.agent_name}」。`);
      await load();
    } catch (problem) {
      if (epoch.current === generation) setError(failure(problem, "撤销结果未确认，请刷新后查看。"));
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  async function copy(token: string) {
    try { await navigator.clipboard.writeText(token); setCopied(true); } catch { setCopied(false); }
  }

  if (!session) return null;
  const view = pending?.view;
  const viewReplaces = view && object(view.replaces) ? view.replaces : null;
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  // The issue form, shown above the list or, while rotating, inside the card
  // being rotated so the Owner sees it where they clicked.
  const form = <div aria-label={replaces ? "轮换表单" : "签发表单"}>
    <h3 style={{ fontSize: 17, margin: "22px 0 8px" }}>{replaces ? `轮换「${replaces.agent_name}」` : "签发新令牌"}</h3>
    {replaces && <p className="oauth-copy">新令牌签发后，旧令牌再保留 1 小时，之后自动失效；它的专用角色会移到新令牌。
      <button className="oauth-secondary" type="button" disabled={working || pending !== null} onClick={resetForm}>改为签发新令牌</button></p>}
    <fieldset disabled={working || pending !== null} style={{ border: "none", padding: 0, margin: 0, minWidth: 0 }}>
      <label className="oauth-form" style={{ display: "block" }}>名称（例如 GitHub CI 准入）
        <input value={label} maxLength={80} onChange={event => setLabel(event.target.value)} /></label>
      <label style={{ display: "block", margin: "12px 0" }}>有效期
        <select value={days} onChange={event => setDays(Number(event.target.value))}>
          {DAYS.map(d => <option key={d} value={d}>{`${d} 天`}</option>)}
        </select></label>
      {replaces?.selection_format === 'sources_v1' && <p>本次轮换保留原授权来源、精确拒绝和字段／历史／版本限制；需要收窄时，先在连接管理保存并重新读取。预览会绑定每项现有版本。</p>}
      <ContextAuthorizationControls rows={eligible} selected={chosen} preset={preset} range={range} custom={custom}
        allowLegacyProjectPolicy={!!replaces?.grants?.some(grant => grant.resource_id === 'project:*')}
        busy={working || pending !== null || replaces?.selection_format === 'sources_v1'} notice={selectionNotice} onRange={next => { setRange(next); setCustom(false); setChosen(changeRange(eligible, next, preset)); setPending(null);
          setSelectionNotice(next === 'specified' ? '已清空精确选择，请重新勾选需要的范围。' : '已改为全部上下文策略，请核对取消的精确选择和未来规则。'); }}
        onPreset={next => { setPreset(next); setCustom(false); setChosen(old => applyPreset(eligible, old, next)); setPending(null); }}
        onResource={(row, checked) => { setChosen(old => ({ ...old, [grantKey(row)]: checked ? presetActions(row, preset) : [] })); setPending(null); }}
        onAction={toggle} />
      <button className="primary-button" type="button" onClick={() => void preview()}
        disabled={!label.trim() || (replaces?.selection_format === 'sources_v1' ? replaces.sources.every(source => source.actions.length === 0) : selection().length === 0)}>预览</button>
    </fieldset>
    {pending && view && <section aria-label="确认签发" className="oauth-note" style={{ marginTop: 16 }}>
      <strong>请确认要签发的令牌</strong>
      <dl className="oauth-details">
        <div><dt>名称</dt><dd>{String(view.label)}</dd></div>
        <div><dt>有效期</dt><dd>{`签发后 ${String(view.days)} 天`}</dd></div>
        <div><dt>权限</dt><dd>{authorizationDisplayOrder(grants(view.selected)).map(grant => `${resourceName(grant)}：${grant.actions.map(a => ACTIONS[a] ?? a).join("、")}`).join("；")}</dd></div>
        {object(view.source_snapshot) && <div><dt>保留的来源与限制版本</dt><dd><pre>{JSON.stringify(view.source_snapshot, null, 2)}</pre></dd></div>}
        {viewReplaces && <div><dt>替换</dt><dd>{`「${String(viewReplaces.agent_name)}」，签发后 ${String(viewReplaces.grace_minutes)} 分钟失效`}
          {strings(viewReplaces.roles).length ? `；角色 ${strings(viewReplaces.roles).map(r => ROLES[r] ?? r).join("、")} 移到新令牌` : ""}</dd></div>}
      </dl>
      <div className="oauth-actions">
        <button className="oauth-secondary" type="button" disabled={working} onClick={() => setPending(null)}>取消</button>
        <button className="primary-button" type="button" disabled={working} onClick={() => void confirm()}>{working ? "正在签发…" : "确认签发"}</button>
      </div>
    </section>}
  </div>;
  const heartbeatView = heartbeatPending?.view;
  const heartbeatForm = <div aria-label="心跳令牌表单">
    <h3 style={{ fontSize: 17, margin: "22px 0 8px" }}>常驻节点心跳令牌</h3>
    <p className="oauth-copy">权限：{SCOPE_LABELS['ci:heartbeat']}。只给常驻节点的心跳程序用；任何读取、写入、审计接口都不接受它。签发后在「CI 准入自动接班」页把它挂到对应节点。</p>
    <fieldset disabled={working || pending !== null || heartbeatPending !== null} style={{ border: "none", padding: 0, margin: 0, minWidth: 0 }}>
      <label className="oauth-form" style={{ display: "block" }}>名称（例如 TURING 心跳）
        <input value={heartbeatLabel} maxLength={80} onChange={event => setHeartbeatLabel(event.target.value)} /></label>
      <label style={{ display: "block", margin: "12px 0" }}>有效期
        <select value={heartbeatDays} onChange={event => setHeartbeatDays(Number(event.target.value))}>
          {DAYS.map(d => <option key={d} value={d}>{`${d} 天`}</option>)}
        </select></label>
      <button className="primary-button" type="button" onClick={() => void previewHeartbeat()} disabled={!heartbeatLabel.trim()}>预览心跳令牌</button>
    </fieldset>
    {heartbeatPending && heartbeatView && <section aria-label="确认签发心跳令牌" className="oauth-note" style={{ marginTop: 16 }}>
      <strong>请确认要签发的心跳令牌</strong>
      <dl className="oauth-details">
        <div><dt>名称</dt><dd>{String(heartbeatView.label)}</dd></div>
        <div><dt>有效期</dt><dd>{`签发后 ${String(heartbeatView.days)} 天`}</dd></div>
        <div><dt>权限</dt><dd>{strings(heartbeatView.scopes).map(scope => SCOPE_LABELS[scope] ?? `未识别范围：${scope}`).join("、")}</dd></div>
      </dl>
      <div className="oauth-actions">
        <button className="oauth-secondary" type="button" disabled={working} onClick={() => setHeartbeatPending(null)}>取消</button>
        <button className="primary-button" type="button" disabled={working} onClick={() => void confirmHeartbeat()}>{working ? "正在签发…" : "确认签发心跳令牌"}</button>
      </div>
    </section>}
  </div>;
  return (
    <section aria-label="无头令牌" style={{ borderTop: "1px solid var(--line)", marginTop: 28, paddingTop: 20 }}>
      <h2 style={{ fontSize: 20, margin: "0 0 8px" }}>无头令牌（CI、runner、脚本）</h2>
      <p className="oauth-copy">给不能走 OAuth 的客户端单独签发一个令牌：只给勾选的权限，必须设定有效期，令牌只显示一次。
        Claude、ChatGPT 这类客户端请继续在客户端里连接（OAuth）。</p>
      {error && <div className="oauth-error" role="alert"><strong>尚未完成</strong><p>{error}</p></div>}
      {notice && <p className="oauth-note" role="status">{notice}</p>}

      {issued && <div className="oauth-note" role="status" aria-label="新令牌">
        <strong>令牌已签发，只显示这一次</strong>
        <p>现在把它存进客户端的密钥设置（例如 GitHub environment secret）。离开或刷新页面后无法再次查看。</p>
        {issued.replaced && secretsFor(strings(issued.replaced.roles_moved)).length > 0 && <p role="alert">
          <strong>请更新：</strong>{secretsFor(strings(issued.replaced.roles_moved)).join("；")}。
          旧令牌 {when(String(issued.replaced.expires_at))} 失效，在那之前不更新，用到它的流程会失败。</p>}
        <p><code style={{ overflowWrap: "anywhere" }}>{issued.token}</code></p>
        <div className="oauth-actions">
          <button className="primary-button" type="button" onClick={() => void copy(issued.token)}>{copied ? "已复制" : "复制令牌"}</button>
          <button className="oauth-secondary" type="button" onClick={() => setIssued(null)}>我已保存，关闭</button>
        </div>
        <dl className="oauth-details">
          <div><dt>连接编号</dt><dd>{issued.binding_id}</dd></div>
          <div><dt>有效期至</dt><dd>{when(issued.expires_at)}</dd></div>
          {issued.replaced && <div><dt>旧令牌</dt><dd>{`将于 ${when(String(issued.replaced.expires_at))} 失效`}
            {strings(issued.replaced.roles_moved).length ? `；角色 ${strings(issued.replaced.roles_moved).map(r => ROLES[r] ?? r).join("、")} 已移到新令牌` : ""}</dd></div>}
        </dl>
        <p className="oauth-copy">用法：REST 接口发 <code>{`Authorization: Bearer <令牌>`}</code> 到 <code>{`${origin}/v1/…`}</code>；
          数据库 RPC 传令牌的 SHA-256 作为 <code>p_token_hash</code>。MCP 地址只接受 OAuth。</p>
      </div>}

      {list === null ? <p role="status">{working ? "正在读取无头令牌…" : "无头令牌尚未读取。"}</p> : <>
        {!replaces && form}
        {!replaces && heartbeatForm}
        {list.length === 0 && <p className="oauth-copy">还没有无头令牌。</p>}
        {list.map(row => <article key={row.binding_id} style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 14, marginTop: 12 }}>
          <strong style={{ overflowWrap: "anywhere" }}>{row.agent_name}</strong>
          <dl className="oauth-details">
            <div><dt>类型</dt><dd>{row.kind === "legacy" ? "旧方式创建" : heartbeatOnly(row) ? "常驻节点心跳令牌" : "无头令牌"}</dd></div>
            <div><dt>状态</dt><dd>{row.active === false ? '已失效' : row.expires_at && Date.parse(row.expires_at) <= Date.now() ? '已过期' : row.active === true ? '当前有效' : '尚未确认'}</dd></div>
            <div><dt>有效期至</dt><dd>{row.replaced_by ? `已被替换，${when(row.expires_at)} 失效` : when(row.expires_at)}</dd></div>
            {row.kind === 'legacy' && <><div><dt>客户端操作范围</dt><dd>{row.scopes === null ? '未提供，尚未确认' : row.scopes.length ? row.scopes.map(scope => SCOPE_LABELS[scope] ?? `未识别范围：${scope}`).join('、') : '未声明可用操作'}</dd></div>
              {!row.grants && <div><dt>具体资源范围</dt><dd>授权明细未提供，不能推断为全部上下文；需要核对实际资格和资源授权。</dd></div>}</>}
            {row.roles.length > 0 && <div><dt>专用角色</dt><dd>{row.roles.map(r => ROLES[r] ?? r).join("、")}</dd></div>}
            {secretsFor(row.roles).length > 0 && <div><dt>令牌存放在</dt><dd>{secretsFor(row.roles).join("；")}</dd></div>}
            {heartbeatOnly(row) && <div><dt>权限</dt><dd>{SCOPE_LABELS['ci:heartbeat']}</dd></div>}
            {row.grants && !heartbeatOnly(row) && <div><dt>权限</dt><dd>{authorizationDisplayOrder(row.grants).map(grant => `${resourceName(grant)}：${grant.actions.map(a => ACTIONS[a] ?? a).join("、")}`).join("；")}</dd></div>}
            <div><dt>连接编号</dt><dd>{row.binding_id}</dd></div>
          </dl>
          <div className="oauth-actions">
            {!row.replaced_by && !heartbeatOnly(row) && replaces?.binding_id !== row.binding_id && <button className="oauth-secondary" type="button"
              disabled={working || pending !== null || unavailable(row)} onClick={() => rotate(row)}>轮换为新令牌</button>}
            <button className="oauth-secondary" style={{ color: "#ffc5c5" }} type="button"
              disabled={working || pending !== null} onClick={() => void revoke(row)}>撤销</button>
          </div>
          {replaces?.binding_id === row.binding_id && form}
        </article>)}

      </>}

    </section>
  );
}
