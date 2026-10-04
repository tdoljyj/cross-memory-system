"use client";

import { useEffect, useRef, useState } from "react";
import { type Session } from "@supabase/supabase-js";
import { supabase } from "../../supabase-browser";

// Headless Binding issuance (Task 364212a1, Owner Decision 6e0371e3). A client
// that cannot do OAuth (CI, a runner, a script) gets its own Binding token here.
// Step 1 asks Clued to render exactly what will be issued and returns a
// single-use confirmation token over that view; "确认签发" commits that view
// and returns the Binding token once. Only its hash is stored. Every RPC runs
// as this signed-in account session; Bindings and delegated OAuth are refused.
type Json = Record<string, unknown>;
type Grant = { resource_kind: string; resource_id: string; environment: string; actions: string[]; name?: string };
type Row = { binding_id: string; agent_name: string; vendor: string; kind: string; expires_at: string | null;
  created_at: string | null; version: number | null; grants: Grant[] | null; roles: string[]; replaced_by: string | null };
type Pending = { confirmation_token: string; view_digest: string; view: Json };
type Issued = { token: string; binding_id: string; expires_at: string; replaced: Json | null };

const object = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown) => Array.isArray(value) ? value.map(String) : [];
const grantKey = (grant: { resource_kind: string; resource_id: string; environment: string }) =>
  JSON.stringify([grant.resource_kind, grant.resource_id, grant.environment]);
const ACTIONS: Record<string, string> = {
  read: "读取", write: "新增和修改", close: "关闭和归档", restore: "恢复记录", feedback_submit: "提交反馈", audit: "查看审计回执",
};
const ROLES: Record<string, string> = { "ci-admission": "CI 准入", "release-door": "发布门口" };
const DAYS = [7, 30, 90];
const MESSAGES: Record<string, string> = {
  direct_human_session_required: "需要你本人直接登录 Clued，授权给应用的登录不能签发令牌。",
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
  return Array.isArray(value) ? value.filter(object).map(item => ({ resource_kind: String(item.resource_kind),
    resource_id: String(item.resource_id), environment: String(item.environment), actions: strings(item.actions),
    name: typeof item.name === "string" ? item.name : undefined })) : [];
}
function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter(object).map(item => ({ binding_id: String(item.binding_id),
    agent_name: String(item.agent_name ?? ""), vendor: String(item.vendor ?? ""), kind: String(item.kind),
    expires_at: typeof item.expires_at === "string" ? item.expires_at : null,
    created_at: typeof item.created_at === "string" ? item.created_at : null,
    version: typeof item.version === "number" ? item.version : null,
    grants: Array.isArray(item.grants) ? grants(item.grants) : null, roles: strings(item.roles),
    replaced_by: typeof item.replaced_by === "string" ? item.replaced_by : null })) : [];
}
const resourceName = (grant: Grant) => grant.resource_id === "global" ? "全局视图"
  : grant.resource_id === "profile" ? "个人资料" : grant.name ? `${grant.name}（${grant.resource_id}）` : grant.resource_id;
const when = (value: string | null) => value ? new Date(value).toLocaleString("zh-CN") : "未设定";
const failure = (error: unknown, fallback: string) => error instanceof RequestFailure ? error.message : fallback;

export default function HeadlessBindings() {
  const [session, setSession] = useState<Session | null>(null);
  const [list, setList] = useState<Row[] | null>(null);
  const [eligible, setEligible] = useState<Grant[]>([]);
  const [label, setLabel] = useState("");
  const [days, setDays] = useState(30);
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [replaces, setReplaces] = useState<Row | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [copied, setCopied] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
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
      setList(rows(value.bindings)); setEligible(grants(value.eligible));
    } catch (problem) {
      if (epoch.current === generation) setError(failure(problem, "暂时无法读取无头令牌。"));
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  function selection(): Grant[] {
    return eligible.map(grant => ({ resource_kind: grant.resource_kind, resource_id: grant.resource_id,
      environment: grant.environment, actions: grant.actions.filter(action => (chosen[grantKey(grant)] ?? []).includes(action)) }))
      .filter(grant => grant.actions.length > 0);
  }

  function toggle(grant: Grant, action: string, on: boolean) {
    setChosen(previous => {
      const values = previous[grantKey(grant)] ?? [];
      return { ...previous, [grantKey(grant)]: on ? grant.actions.filter(item => item === action || values.includes(item))
        : values.filter(item => item !== action) };
    });
  }

  function rotate(row: Row) {
    setReplaces(row); setLabel(row.agent_name); setIssued(null); setPending(null); setNotice(""); setError("");
    setChosen(Object.fromEntries((row.grants ?? []).map(grant => [grantKey(grant), [...grant.actions]])));
  }

  function resetForm() {
    setReplaces(null); setLabel(""); setDays(30); setChosen({}); setPending(null);
  }

  // Step 1: Clued renders what will be issued and returns a token for exactly that.
  async function preview() {
    if (!current.current || working) return;
    const generation = epoch.current;
    setWorking(true); setError(""); setNotice(""); setIssued(null);
    try {
      const value = await rpc("clued_headless_binding_confirmation_issue_v1", { label: label.trim(), days,
        selected: selection(), ...(replaces ? { replaces_binding_id: replaces.binding_id } : {}) });
      if (epoch.current !== generation) return;
      if (value.status !== "issued" || typeof value.confirmation_token !== "string" || typeof value.view_digest !== "string"
        || !object(value.confirmation_view)) throw new RequestFailure("服务返回了无法识别的确认内容。");
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

  async function revoke(row: Row) {
    if (working || row.kind !== "headless" || row.version === null) return;
    if (!window.confirm(`撤销「${row.agent_name}」？使用这个令牌的客户端会立即失去访问。`)) return;
    const generation = epoch.current;
    setWorking(true); setError(""); setNotice("");
    try {
      await rpc("clued_authorization_manage_v12", { op: "revoke", binding_id: row.binding_id, base_version: row.version });
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
      {eligible.map(grant => <fieldset key={grantKey(grant)}
        style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 12, margin: "12px 0", minWidth: 0 }}>
        <legend style={{ fontSize: 12, overflowWrap: "anywhere" }}>{resourceName(grant)}</legend>
        {grant.actions.map(action => <label key={action} style={{ display: "flex", alignItems: "center", gap: 10, margin: "9px 0", fontSize: 13 }}>
          <input type="checkbox" style={{ width: 18, height: 18, accentColor: "var(--green)" }}
            checked={(chosen[grantKey(grant)] ?? []).includes(action)}
            onChange={event => toggle(grant, action, event.target.checked)} />{ACTIONS[action] ?? action}
        </label>)}
      </fieldset>)}
      <button className="primary-button" type="button" onClick={() => void preview()}
        disabled={!label.trim() || selection().length === 0}>预览</button>
    </fieldset>
    {pending && view && <section aria-label="确认签发" className="oauth-note" style={{ marginTop: 16 }}>
      <strong>请确认要签发的令牌</strong>
      <dl className="oauth-details">
        <div><dt>名称</dt><dd>{String(view.label)}</dd></div>
        <div><dt>有效期</dt><dd>{`签发后 ${String(view.days)} 天`}</dd></div>
        <div><dt>权限</dt><dd>{grants(view.selected).map(grant => `${resourceName(grant)}：${grant.actions.map(a => ACTIONS[a] ?? a).join("、")}`).join("；")}</dd></div>
        {viewReplaces && <div><dt>替换</dt><dd>{`「${String(viewReplaces.agent_name)}」，签发后 ${String(viewReplaces.grace_minutes)} 分钟失效`}
          {strings(viewReplaces.roles).length ? `；角色 ${strings(viewReplaces.roles).map(r => ROLES[r] ?? r).join("、")} 移到新令牌` : ""}</dd></div>}
      </dl>
      <div className="oauth-actions">
        <button className="oauth-secondary" type="button" disabled={working} onClick={() => setPending(null)}>取消</button>
        <button className="primary-button" type="button" disabled={working} onClick={() => void confirm()}>{working ? "正在签发…" : "确认签发"}</button>
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
        {list.length === 0 && <p className="oauth-copy">还没有无头令牌。</p>}
        {list.map(row => <article key={row.binding_id} style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 14, marginTop: 12 }}>
          <strong style={{ overflowWrap: "anywhere" }}>{row.agent_name}</strong>
          <dl className="oauth-details">
            <div><dt>类型</dt><dd>{row.kind === "legacy" ? "旧方式创建（全部权限、无有效期）" : "无头令牌"}</dd></div>
            <div><dt>有效期至</dt><dd>{row.replaced_by ? `已被替换，${when(row.expires_at)} 失效` : when(row.expires_at)}</dd></div>
            {row.roles.length > 0 && <div><dt>专用角色</dt><dd>{row.roles.map(r => ROLES[r] ?? r).join("、")}</dd></div>}
            {row.grants && <div><dt>权限</dt><dd>{row.grants.map(grant => `${resourceName(grant)}：${grant.actions.map(a => ACTIONS[a] ?? a).join("、")}`).join("；")}</dd></div>}
            <div><dt>连接编号</dt><dd>{row.binding_id}</dd></div>
          </dl>
          <div className="oauth-actions">
            {!row.replaced_by && replaces?.binding_id !== row.binding_id && <button className="oauth-secondary" type="button"
              disabled={working || pending !== null} onClick={() => rotate(row)}>轮换为新令牌</button>}
            {row.kind === "headless" && <button className="oauth-secondary" style={{ color: "#ffc5c5" }} type="button"
              disabled={working || pending !== null} onClick={() => void revoke(row)}>撤销</button>}
          </div>
          {replaces?.binding_id === row.binding_id && form}
        </article>)}

      </>}

    </section>
  );
}
