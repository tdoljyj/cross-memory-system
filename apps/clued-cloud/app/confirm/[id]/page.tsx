"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { type Session } from "@supabase/supabase-js";
import { supabase } from "../../supabase-browser";
import { authorizationDisplayOrder } from "../../../lib/context-authorization";
import "../../contexts/contexts.css";
import "../owner.css";

// Owner Credential v0.1 §4-§5: the Owner's confirmation page for one Agent
// request, opened from the direct link /confirm/<request_id>. What is approved
// is rendered by Clued from structured fields; the Agent's note is shown apart
// and marked unverified. Approval is the Native two-step confirmation: the page
// issues a single-use token over the exact view it shows (bound to this signed-in
// session), and "批准" commits exactly that view. All RPCs run as this account
// session; the database refuses Bindings and delegated OAuth tokens.
// For "grant for a while" each requested resource is a row the Owner can untick
// (narrow) or widen to a parent Clued offers (Decision c4e82dee); "" is unticked.
// The page opens on the choice Clued sets by the action's risk (Decision b7053465).
// A connection.permission request (Decision 43ba00e2) is approved once, for the
// requesting connection only: the page names each context and action and
// what the connection already has, and approval adds them to that connection.
// A bundle (PermissionSimplification §3.3, Task 23045c17) is several requests
// the Agent or the release door opened together, for example a production
// migration and the deploy of the same commit. The page lists every pending
// member side by side, each with a checkbox ticked by default (Decision
// 383c2144); "批准" approves the ticked ones, each still with its own two-step
// confirmation over its own view and the same choice. An unticked member stays
// pending; "拒绝" still rejects the whole bundle. Scope rows are not offered
// for a bundle.
type Json = Record<string, unknown>;
type Choice = "once" | "grant";
type Options = { choice: Choice; seconds: number; anyAgent: boolean; scope: string[]; datasetSplitBootstrap?: boolean; datasetSplitCorrection?: boolean };
type ScopeRow = { resource: string; options: string[] };
type Issued = { confirmation_token: string; view_digest: string; expires_at: string; view: Json; options: Options };
type Member = { id: string; issued: Issued | null };
type Left = { id: string; action: string };
const object = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DURATIONS: [number, string][] = [[3600, "1 小时"], [14400, "4 小时"], [86400, "24 小时"], [604800, "7 天"]];
// A token this close to expiry is refreshed before use.
const REFRESH_MS = 20_000;
const MESSAGES: Record<string, string> = {
  confirmation_token_session_id_required: "当前登录缺少会话信息，请退出后重新登录。",
  direct_human_session_required: "需要你本人直接登录 BeamingFace，授权给应用的登录不能批准请求。",
  owner_request_not_found: "找不到这个请求，或它不属于当前登录的账号。",
  owner_request_id_invalid: "链接里的请求编号无效。",
  owner_request_decided: "这个请求已经处理过了。",
  owner_request_expired: "这个请求已超过 24 小时，已失效。请让 Agent 重新发起。",
  owner_grant_duration_invalid: "授权时长须在 1 分钟到 7 天之间。",
  owner_grant_resources_not_offered: "所选范围不在可选项里，请刷新页面后重选。",
  owner_grant_resources_invalid: "至少要保留一项范围。",
  confirmation_token_expired: "确认已超过 5 分钟有效期，请刷新页面后重试。",
  confirmation_token_reused: "这次确认已经用过，请刷新页面后重试。",
  confirmation_token_revoked: "确认已被更新的选择取代，请按页面当前内容操作。",
  confirmation_token_binding_mismatch: "确认与当前登录会话或页面内容不一致，请刷新页面后重试。",
  confirmation_view_stale: "请求在你查看后发生了变化，请刷新页面后重新核对。",
};
const STATUS: Record<string, string> = {
  approved_once: "已批准（只这一次）", granted: "已授权一段时间", rejected: "已拒绝", expired: "已过期", pending: "等待你确认",
};
class RequestFailure extends Error { constructor(message: string, readonly uncertain = false) { super(message); } }

type BindingContinuation = {
  binding_changed: boolean;
  previous_binding: { binding_id: string; agent_name: string; vendor: string; revoked: boolean; session_ref: string | null };
  current_binding: { binding_id: string; agent_name: string; vendor: string; session_ref: string };
  execution_claim: { claim_id: string; task_id: string; context_key: string; holder_binding_id: string;
    holder_session_ref: string; holder_label_self_reported: string; fence: number; lease_version: number;
    expires_at: string; hard_deadline_at: string };
  task: { task_id: string; title: string; version: number; content_hash: string };
};
const CORRECTION_TASK = "1502fd80-8ff8-4adc-b4f5-da6d462f4f8a";
const CORRECTION_SCOPE = "project:0597aa60-9b98-4da6-a4ab-63d7705b632f";
const SAME_BINDING_EFFECT = "REPLACE_UNUSED_GRANT_WITH_ONE_HOUR_SINGLE_USE_KEEP_ORIGINAL_APPROVAL_HISTORY";
const CONTINUATION_EFFECT = "REAUTHORIZE_CURRENT_CLAIM_HOLDER_ONE_HOUR_SINGLE_USE_KEEP_ORIGINAL_APPROVAL_HISTORY";

// Older same-Binding views have none of these fields. A successor must carry
// the whole server-rendered subject and agree with its exact grantee/scope;
// a partial successor never falls back to the older confirmation wording.
function bindingContinuation(view: Json, request: Json | null): BindingContinuation | null {
  const correction = object(view.correction) ? view.correction : null;
  if (!correction) return null;
  const successor = "binding_continuation" in correction || "previous_binding_id" in correction
    || "new_binding_id" in correction || (typeof correction.effect === "string" && correction.effect !== SAME_BINDING_EFFECT);
  if (!successor) return null;
  const c = correction.binding_continuation;
  const bad = () => { throw new RequestFailure("接续会话或认领信息不完整、不一致，暂时无法确认。请刷新页面重新核对。"); };
  if (!object(c) || c.schema !== "clued.dataset-split-native-binding-continuation.v1"
    || typeof c.binding_changed !== "boolean" || !object(c.previous_binding) || !object(c.current_binding)
    || !object(c.execution_claim) || !object(c.task) || !object(view.grantee) || !object(view.task)) return bad();
  const previous = c.previous_binding, next = c.current_binding, claim = c.execution_claim, task = c.task;
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 500;
  const uuid = (value: unknown): value is string => typeof value === "string" && REQUEST_ID.test(value);
  const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
  const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
  const resources = view.resources, original = request?.resources;
  if (!uuid(previous.binding_id) || !uuid(next.binding_id) || typeof previous.revoked !== "boolean"
    || !text(previous.agent_name) || !text(previous.vendor) || !text(next.agent_name) || !text(next.vendor)
    || !(previous.session_ref === null || text(previous.session_ref)) || !text(next.session_ref)
    || !uuid(claim.claim_id) || !text(claim.holder_session_ref) || !text(claim.holder_label_self_reported)
    || !positive(claim.fence) || !positive(claim.lease_version) || !date(claim.expires_at) || !date(claim.hard_deadline_at)
    || Date.parse(String(claim.expires_at)) > Date.parse(String(claim.hard_deadline_at))
    || task.task_id !== CORRECTION_TASK || claim.task_id !== CORRECTION_TASK || view.task.task_id !== CORRECTION_TASK
    || claim.context_key !== CORRECTION_SCOPE || !positive(task.version) || !text(task.title)
    || typeof task.content_hash !== "string" || !/^[0-9a-f]{64}$/.test(task.content_hash)
    || correction.previous_binding_id !== previous.binding_id || correction.new_binding_id !== next.binding_id
    || c.binding_changed !== (previous.binding_id !== next.binding_id)
    || correction.effect !== (c.binding_changed ? CONTINUATION_EFFECT : SAME_BINDING_EFFECT)
    || view.grantee.binding_id !== next.binding_id || view.grantee.any_agent !== false
    || claim.holder_binding_id !== next.binding_id || next.session_ref !== claim.holder_session_ref
    || view.action !== "model.dataset_split.bootstrap" || view.choice !== "grant" || view.max_uses !== 1
    || !Number.isInteger(view.expires_seconds) || Number(view.expires_seconds) < 60 || Number(view.expires_seconds) > 3600
    || !Array.isArray(resources) || !Array.isArray(original) || resources.length !== 6 || original.length !== 6
    || !resources.every(text) || !original.every(text) || new Set(resources).size !== 6 || new Set(original).size !== 6
    || [...resources].sort().some((resource, index) => resource !== [...original].sort()[index])) return bad();
  return c as unknown as BindingContinuation;
}

async function rpc(name: string, input: Json): Promise<Json> {
  let result: { data: unknown; error: { message?: string; code?: string } | null };
  try {
    result = await supabase.rpc(name, { p_input: input });
  } catch { throw new RequestFailure("网络请求未完成，结果未知。", true); }
  if (result.error) {
    const code = result.error.message ?? "";
    if (MESSAGES[code]) throw new RequestFailure(MESSAGES[code]);
    throw new RequestFailure(result.error.code ? "请求被拒绝（" + code + "）。" : "网络请求未完成，结果未知。",
      !result.error.code);
  }
  const value = result.data;
  if (!object(value)) throw new RequestFailure("服务返回了无法识别的结果，结果未知。", true);
  if (value.status === "rejected" || value.status === "failed") {
    const code = typeof value.error_code === "string" ? value.error_code : String(value.status);
    throw new RequestFailure(MESSAGES[code] ?? "请求被拒绝（" + code + "）。", value.status === "failed");
  }
  return value;
}

function issueInput(requestId: string, options: Options, rows: ScopeRow[]): Json {
  // The fixed bootstrap plan accepts only the requester, the original scope,
  // at most one hour and one use. "once" is a different, 24-hour Native grant.
  if (options.datasetSplitBootstrap) return { request_id: requestId, choice: "grant",
    expires_seconds: 3600, max_uses: 1, grantee: "requester" };
  const grantee = options.anyAgent ? "any_agent" : "requester";
  if (options.choice === "once") return { request_id: requestId, choice: "once", grantee };
  const input: Json = { request_id: requestId, choice: "grant", expires_seconds: options.seconds, grantee };
  // Sent only when the Owner changed the scope; otherwise Clued keeps the request's.
  if (options.scope.some((chosen, index) => chosen !== rows[index]?.resource)) input.resources = options.scope.filter(Boolean);
  return input;
}
function scopeRows(value: unknown): ScopeRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter(object).map(row => ({ resource: String(row.resource ?? ""), options: list(row.options) }))
    .filter(row => row.resource && row.options.includes(row.resource));
}
function durationText(seconds: number) {
  const known = DURATIONS.find(([value]) => value === seconds);
  if (known) return known[1];
  return seconds % 3600 === 0 ? seconds / 3600 + " 小时" : Math.round(seconds / 60) + " 分钟";
}
const list = (value: unknown) => Array.isArray(value) ? value.map(String) : [];
// The other members of this request's bundle, as listed by Clued.
function bundleOthers(request: Json, id: string): Json[] {
  return Array.isArray(request.bundle) ? request.bundle.filter(object)
    .filter(member => typeof member.request_id === "string" && REQUEST_ID.test(member.request_id) && member.request_id !== id) : [];
}
const termText = (view: Json) => view.choice === "once" ? "只这一次，24 小时内用掉" : durationText(Number(view.expires_seconds)) + "内有效";
const usesText = (view: Json) => view.max_uses == null ? "不限" : "最多 " + String(view.max_uses) + " 次";
function actionText(view: Json | null | undefined, fallback?: unknown) {
  if (view && view.action_title) return String(view.action_title) + "（" + String(view.action ?? "") + "）";
  return String(view?.action ?? fallback ?? "");
}
const PERMISSION_ACTION = "connection.permission";
const ACTION_LABELS: Record<string, string> = { read: "读取", write: "新增和修改", close: "关闭和归档", restore: "恢复", audit: "查看审计回执", feedback_submit: "提交反馈", reader: "只读", developer: "可编辑（新上下文策略）", full: "全部操作（本次可用）" };
const ENVIRONMENT_LABELS: Record<string, string> = { test: "测试环境", preview: "预览环境", production: "生产环境" };
const CONTEXT_LABELS: Record<string, string> = { global: "个人记录", profile: "个人资料", "contexts:*": "全部上下文（含以后新建的自有项目与上下文）", "project:*": "自有项目正式记录（含未来项目）" };
function permissionText(context: string, name: unknown, action: string) {
  const label = typeof name === "string" && name ? name : CONTEXT_LABELS[context] ?? context;
  return label + " → " + (ACTION_LABELS[action] ?? action);
}
function currentText(row: Json) {
  const id = String(row.resource_id ?? "");
  const where = row.resource_kind === "scope" ? CONTEXT_LABELS[id] ?? row.project_name ?? row.name ?? id
    : String(row.context_name ?? row.name ?? id) + " · " + (ENVIRONMENT_LABELS[String(row.environment)] ?? String(row.environment ?? ""));
  return String(where) + "：" + list(row.effective_actions ?? row.actions).map(action => ACTION_LABELS[action] ?? action).join("、");
}

function requiresContextCoverage(view: Json, request?: Json | null): boolean {
  return view.action === PERMISSION_ACTION && [...list(view.resources), ...list(request?.resources)].some(resource => /^permission:contexts:\*\//.test(resource));
}
function contextCoverageValid(view: Json): boolean {
  const coverage = object(view.context_coverage) ? view.context_coverage : null;
  const connection = object(view.connection) ? view.connection : null;
  const textArray = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string');
  return !!coverage && !!connection && coverage.snapshot_complete === true && coverage.future_rule === 'owned_existing_and_future'
    && Number.isSafeInteger(coverage.authorization_version) && Number(coverage.authorization_version) > 0
    && coverage.authorization_version === connection.version && typeof connection.binding_id === 'string'
    && textArray(coverage.requested_actions) && textArray(coverage.missing_actions) && Array.isArray(coverage.restricted_resources)
    && Array.isArray(coverage.resources) && coverage.resources.every(row => object(row) && ['scope','context'].includes(String(row.resource_kind))
      && typeof row.resource_id === 'string' && typeof row.environment === 'string' && textArray(row.actual_actions) && textArray(row.missing_actions));
}

export default function OwnerConfirmPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const params = useParams<{ id: string }>();
  const rawId = typeof params?.id === "string" ? params.id : "";
  const requestId = REQUEST_ID.test(rawId) ? rawId.toLowerCase() : null;
  const [request, setRequest] = useState<Json | null>(null);
  const [options, setOptions] = useState<Options>({ choice: "grant", seconds: 14400, anyAgent: false, scope: [] });
  const [rows, setRows] = useState<ScopeRow[]>([]);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [pending, setPending] = useState<Issued | null>(null);
  const [done, setDone] = useState<{ kind: "granted" | "rejected"; grant?: Json; count?: number; left?: Left[]; corrected?: boolean; subjectChanged?: boolean } | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  // Bundle members (the request on the page included) the Owner unticked.
  const [skipped, setSkipped] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const current = useRef<Session | null>(null);
  const epoch = useRef(0);
  // Only a changed-Binding preview pins this signed-in session. A new auth
  // token requires a fresh preview; older same-Binding semantics are kept.
  const continuationSession = useRef<string | null>(null);
  // The first correction response has not yet told us whether its Binding
  // changes. Pin its issuer while it is pending as well as the shown view.
  const correctionIssueSession = useRef<{ owner_id: string; access_token: string } | null>(null);

  useEffect(() => {
    const lifetime = epoch;
    let disposed = false;
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      if (disposed) return;
      const pinnedToken = correctionIssueSession.current?.access_token ?? continuationSession.current;
      const strictSessionChanged = pinnedToken !== null
        && current.current?.user.id === next?.user.id
        && pinnedToken !== next?.access_token;
      const changed = current.current?.user.id !== next?.user.id || strictSessionChanged;
      current.current = next; setSession(next); setReady(true);
      if (!changed) return;
      continuationSession.current = null;
      correctionIssueSession.current = null;
      ++epoch.current;
      setRequest(null); setIssued(null); setPending(null); setDone(null); setError(""); setWorking(false); setRows([]); setMembers([]);
      setSkipped([]);
      if (strictSessionChanged && next && requestId) void load(requestId);
    });
    return () => { disposed = true; ++lifetime.current; data.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!session || !requestId) return;
    void load(requestId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id, requestId]);

  async function load(id: string) {
    const generation = epoch.current;
    setWorking(true); setError("");
    try {
      const value = await rpc("clued_owner_request_view_v1", { request_id: id });
      if (epoch.current !== generation) return;
      if (!object(value.request)) throw new RequestFailure("请求内容不完整，请刷新页面。");
      setRequest(value.request);
      const view = object(value.view) ? value.view : {};
      // Clued picks the default choice by the action's risk (Decision b7053465);
      // a server without default_choice keeps "grant" and the view's duration.
      const seconds = Number(value.suggested_expires_seconds ?? view.expires_seconds);
      const others = bundleOthers(value.request, id).filter(member => member.status === "pending");
      const datasetSplitBootstrap = value.request.action === "model.dataset_split.bootstrap";
      const offered = others.length || datasetSplitBootstrap ? [] : scopeRows(value.resource_options);
      const initial: Options = { choice: datasetSplitBootstrap ? "grant" : value.default_choice === "once" ? "once" : "grant",
        seconds: datasetSplitBootstrap ? 3600 : Number.isInteger(seconds) && seconds >= 60 ? seconds : 14400,
        anyAgent: false, scope: offered.map(row => row.resource), datasetSplitBootstrap };
      setRows(offered); setOptions(initial);
      const next: Member[] = others.map(member => ({ id: String(member.request_id), issued: null }));
      setMembers(next); setSkipped([]);
      if (value.request.status === "pending") {
        await issue(id, initial, generation, offered);
        await issueMembers(next, initial, generation);
      }
    } catch (failure) {
      if (epoch.current === generation) setError(failure instanceof RequestFailure ? failure.message : "暂时无法读取请求。");
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  // Step 1: a token over exactly the view these options produce. A newer
  // issue revokes the older token, so only what is on screen can be approved.
  async function issue(id: string, next: Options, generation: number, offered = rows): Promise<Issued | null> {
    const issuer = next.datasetSplitCorrection && current.current
      ? { owner_id: current.current.user.id, access_token: current.current.access_token } : null;
    if (next.datasetSplitCorrection && !issuer) return null;
    if (issuer) correctionIssueSession.current = issuer;
    try {
      const value = next.datasetSplitCorrection
        ? await rpc("clued_dataset_split_grant_correction_issue_v1", { request_id: id })
        : await rpc("clued_owner_grant_confirmation_issue_v1", issueInput(id, next, offered));
      if (epoch.current !== generation || (issuer && (current.current?.user.id !== issuer.owner_id
        || current.current?.access_token !== issuer.access_token))) return null;
      if (value.status !== "issued" || typeof value.confirmation_token !== "string" || typeof value.view_digest !== "string"
        || typeof value.expires_at !== "string" || !object(value.confirmation_view)) {
        throw new RequestFailure("确认内容不完整，请刷新页面。");
      }
      if (next.datasetSplitBootstrap && (value.confirmation_view.action !== "model.dataset_split.bootstrap"
        || value.confirmation_view.choice !== "grant" || value.confirmation_view.expires_seconds !== 3600
        || value.confirmation_view.max_uses !== 1 || !object(value.confirmation_view.grantee)
        || value.confirmation_view.grantee.any_agent !== false)) {
        throw new RequestFailure("服务返回的授权范围或期限与这次请求不一致，暂时无法批准。");
      }
      if (next.datasetSplitCorrection && (!object(value.confirmation_view.correction)
        || value.confirmation_view.correction.request_id !== id
        || value.confirmation_view.correction.previous_grant_id !== "4970e492-d26e-4974-adaa-757b2146b171")) {
        throw new RequestFailure("修正内容与原申请不一致，暂时无法确认。");
      }
      if (next.datasetSplitCorrection) {
        const continuation = bindingContinuation(value.confirmation_view, request);
        continuationSession.current = continuation?.binding_changed ? issuer?.access_token ?? null : null;
      }
      const result = { confirmation_token: value.confirmation_token, view_digest: value.view_digest,
        expires_at: value.expires_at, view: value.confirmation_view, options: next };
      setIssued(result);
      return result;
    } finally {
      if (correctionIssueSession.current === issuer) correctionIssueSession.current = null;
    }
  }

  // The same choice for every other pending member of the bundle.
  async function issueMembers(list: Member[], next: Options, generation: number): Promise<Member[] | null> {
    const result: Member[] = [];
    for (const member of list) {
      const value = await rpc("clued_owner_grant_confirmation_issue_v1", issueInput(member.id, next, []));
      if (epoch.current !== generation) return null;
      if (value.status !== "issued" || typeof value.confirmation_token !== "string" || typeof value.view_digest !== "string"
        || typeof value.expires_at !== "string" || !object(value.confirmation_view)) {
        throw new RequestFailure("确认内容不完整，请刷新页面。");
      }
      result.push({ id: member.id, issued: { confirmation_token: value.confirmation_token, view_digest: value.view_digest,
        expires_at: value.expires_at, view: value.confirmation_view, options: next } });
    }
    setMembers(current => current.map(member => result.find(item => item.id === member.id) ?? member));
    return result;
  }

  async function choose(next: Options) {
    if (!requestId || working || !current.current) return;
    const generation = epoch.current;
    setOptions(next); setIssued(null); setMembers(members.map(member => ({ id: member.id, issued: null })));
    setWorking(true); setError("");
    try { await issue(requestId, next, generation); await issueMembers(members, next, generation); } catch (failure) {
      if (epoch.current === generation) setError(failure instanceof RequestFailure ? failure.message : "暂时无法生成确认。");
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  // Step 2. A token about to expire is reissued for the same options first; it
  // is used only if Clued renders the identical view, otherwise the new view is
  // shown for another look. Repeating with the same token is safe: a grant that
  // already committed is returned again, never granted twice.
  // One handler for every scope row: data-index names the row; a checkbox
  // keeps (the requested resource) or unticks it, a select picks an option.
  function pickScope(event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    const target = event.currentTarget;
    const index = Number(target.dataset.index);
    const row = rows[index];
    if (!row) return;
    const chosen = target.type === "checkbox" ? ((target as HTMLInputElement).checked ? row.resource : "") : target.value;
    void choose({ ...options, scope: options.scope.map((value, at) => at === index ? chosen : value) });
  }

  // A retry re-checks the request on the page; otherwise it is committed only
  // when ticked, then every ticked member follows.
  async function approve(retry?: Issued) {
    let target = retry ?? issued;
    const mine = Boolean(retry) || !skipped.includes(requestId ?? "");
    const chosen = members.filter(member => !skipped.includes(member.id));
    if (!requestId || !current.current || working || (mine ? !target : !chosen.length)) return;
    const generation = epoch.current;
    setWorking(true); setError("");
    try {
      let grant: Json | undefined;
      if (mine && target) {
        if (target.options.datasetSplitCorrection && bindingContinuation(target.view, request)?.binding_changed
          && continuationSession.current !== current.current?.access_token) {
          throw new RequestFailure("登录会话已经变化，请重新预览接续授权后再确认。");
        }
        if (!retry && Date.parse(target.expires_at) - Date.now() < REFRESH_MS) {
          const shown = target.view_digest;
          const fresh = await issue(requestId, target.options, generation);
          if (!fresh) return;
          if (fresh.view_digest !== shown) throw new RequestFailure("请求内容有变化，请核对后再点批准。");
          target = fresh;
        }
        if (requiresContextCoverage(target.view, request) && !contextCoverageValid(target.view)) throw new RequestFailure('全部上下文的覆盖、版本或限制预览不完整，请重新读取后再批准。');
        setPending(target); setIssued(null);
        const value = await rpc("clued_owner_grant_v1", { confirmation_token: target.confirmation_token, view_digest: target.view_digest });
        if (epoch.current !== generation) return;
        if (value.status !== "committed" || !object(value.grant) || typeof value.grant.grant_id !== "string") {
          throw new RequestFailure("批准结果尚未确认，请核对原操作。", true);
        }
        setPending(null);
        grant = value.grant;
      }
      const result = await approveMembers(chosen, mine ? 1 : 0, generation);
      if (!result) return;
      const left: Left[] = [...(mine ? [] : [{ id: requestId, action: actionText(issued?.view, request?.action) }]),
        ...members.filter(member => skipped.includes(member.id))
          .map(member => ({ id: member.id, action: actionText(member.issued?.view) }))];
      setDone({ kind: "granted", grant: grant ?? result.grant, count: result.count + (mine ? 1 : 0), left,
        corrected: Boolean(target?.options.datasetSplitCorrection),
        subjectChanged: Boolean(target?.options.datasetSplitCorrection && bindingContinuation(target.view, request)?.binding_changed) });
    } catch (failure) {
      if (epoch.current !== generation) return;
      const uncertain = !(failure instanceof RequestFailure) || failure.uncertain;
      if (!uncertain) setPending(null);
      setError(uncertain ? "批准结果尚未确认。请点“核对原操作”，系统会沿用同一确认，不会重复批准。" : failure.message);
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  // The ticked members after the request on the page (`before` counts it when
  // it was approved), each over its own view. A member whose token is about to
  // expire is reissued first and used only if Clued renders the identical view.
  async function approveMembers(chosen: Member[], before: number, generation: number): Promise<{ count: number; grant?: Json } | null> {
    let count = 0;
    let grant: Json | undefined;
    for (const member of chosen) {
      const stop = (reason: string) => new RequestFailure((before + count ? "前 " + (before + count) + " 项已批准，" : "")
        + "第 " + (before + count + 1) + " 项未完成：" + reason + "请刷新页面核对剩下的。");
      let target = member.issued;
      if (!target) throw stop("确认还没生成。");
      if (Date.parse(target.expires_at) - Date.now() < REFRESH_MS) {
        const fresh = await issueMembers([member], target.options, generation);
        if (!fresh) return null;
        if (fresh[0].issued?.view_digest !== target.view_digest || !fresh[0].issued) throw stop("内容有变化。");
        target = fresh[0].issued;
      }
      try {
        const value = await rpc("clued_owner_grant_v1", { confirmation_token: target.confirmation_token, view_digest: target.view_digest });
        if (epoch.current !== generation) return null;
        if (value.status !== "committed") throw new RequestFailure("批准结果尚未确认。");
        grant ??= object(value.grant) ? value.grant : undefined;
      } catch (failure) {
        throw stop(failure instanceof RequestFailure ? failure.message : "批准结果尚未确认。");
      }
      count++;
    }
    return { count, grant };
  }

  // A bundle checkbox: data-id names the member (or the request on the page).
  function pick(event: ChangeEvent<HTMLInputElement>) {
    const id = event.currentTarget.dataset.id;
    const ticked = event.currentTarget.checked;
    if (!id || working) return;
    setSkipped(now => ticked ? now.filter(item => item !== id) : now.includes(id) ? now : [...now, id]);
  }

  async function reject() {
    if (!requestId || !current.current || working) return;
    const generation = epoch.current;
    setWorking(true); setError("");
    try {
      await rpc("clued_owner_request_reject_v1", { request_id: requestId });
      for (const member of members) await rpc("clued_owner_request_reject_v1", { request_id: member.id });
      if (epoch.current !== generation) return;
      setIssued(null); setDone({ kind: "rejected" });
    } catch (failure) {
      if (epoch.current === generation) setError(failure instanceof RequestFailure ? failure.message : "暂时无法拒绝，请稍后重试。");
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  async function signIn(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setWorking(true); setError("");
    try {
      const { error: failure } = await supabase.auth.signInWithPassword({ email, password });
      if (failure) setError("登录失败，请检查邮箱和密码。");
    } catch { setError("登录请求未完成，请重试。"); } finally { setWorking(false); }
  }

  async function signOut() {
    ++epoch.current; current.current = null; setSession(null);
    continuationSession.current = null;
    correctionIssueSession.current = null;
    setRequest(null); setIssued(null); setPending(null); setDone(null); setError(""); setMembers([]); setSkipped([]);
    try { await supabase.auth.signOut(); } catch { setError("退出尚未确认，请重新加载页面后检查登录状态。"); }
  }

  const view = issued?.view ?? null;
  const status = request ? String(request.status ?? "") : "";
  const oldGrant = request && object(request.grant) ? request.grant : null;
  const canCorrect = requestId === "af1cabdb-5259-4ca3-94d3-133f1af122c8"
    && request?.action === "model.dataset_split.bootstrap" && status === "approved_once"
    && oldGrant?.grant_id === "4970e492-d26e-4974-adaa-757b2146b171"
    && oldGrant.uses === 0 && oldGrant.max_uses === 1 && oldGrant.revoked === false
    && Date.parse(String(oldGrant.expires_at)) > Date.now() + 3600_000;
  const correction = view && object(view.correction) ? view.correction : null;
  const continuation = view && options.datasetSplitCorrection ? bindingContinuation(view, request) : null;
  const subjectChanged = continuation?.binding_changed === true;
  const viewRequest = view && object(view.request) ? view.request : null;
  const note = viewRequest && typeof viewRequest.agent_note_unverified === "string" ? viewRequest.agent_note_unverified : "";
  // Re-review 9: a note the admission check wrote (repo.protected_change) is
  // not an Agent's claim; it names the pull request and links its compare view.
  const admissionNote = Boolean(viewRequest && viewRequest.note_source === "ci-admission");
  // Re-review 10: the link is shown only when it ends at the very commit the
  // grant names (repo:<owner>/<name>/<sha>), in the same repository.
  const linkMatch = admissionNote ? /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/compare\/[0-9a-f]{40}\.\.\.([0-9a-f]{40})/.exec(note) : null;
  const granted = view ? list(view.resources) : [];
  const compareLink = linkMatch && granted.length === 1 && granted[0] === "repo:" + linkMatch[1] + "/" + linkMatch[2] ? linkMatch[0] : "";
  const grantee = view && object(view.grantee) ? view.grantee : null;
  const task = view && object(view.task) ? view.task : null;
  const kept = options.scope.filter(Boolean).length;
  const permission = request?.action === PERMISSION_ACTION;
  const connection = view && object(view.connection) ? view.connection : null;
  const permissions = view && Array.isArray(view.permissions) ? view.permissions.filter(object) : [];
  const existing = connection && Array.isArray(connection.current) ? connection.current.filter(object) : [];
  const coverage = view && object(view.context_coverage) ? view.context_coverage : null;
  const needsCoverage = !!view && requiresContextCoverage(view, request);
  const incompleteCoverage = needsCoverage && (!view || !contextCoverageValid(view));
  // A bundle is listed side by side, the request on the page first.
  const items = view && members.length ? [{ id: requestId ?? "", view: view as Json | null },
    ...members.map(member => ({ id: member.id, view: member.issued?.view ?? null }))] : [];
  const picked = items.filter(item => !skipped.includes(item.id));
  // A deploy usually needs the migration opened with it in the same bundle.
  const deployAlone = picked.some(item => item.view?.action === "release.production")
    && items.some(item => skipped.includes(item.id) && item.view?.action === "migration.production");
  const leftover = request && status !== "pending" ? bundleOthers(request, requestId ?? "").filter(member => member.status === "pending") : [];

  return <main className="context-page owner-confirm">
    <header><Link href="/">BeamingFace</Link><Link href="/grants">我的授权</Link></header>
    <h1>确认 Agent 的请求</h1>
    {!requestId ? <p role="alert">链接无效：缺少请求编号。请让 Agent 重新发送链接。</p>
      : !ready ? <p role="status">正在读取登录状态…</p>
      : !session ? <section aria-label="登录"><p>请先登录 BeamingFace，再确认这个请求。</p>
        <form onSubmit={signIn}>
          <label>邮箱<input type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} /></label>
          <label>密码<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label>
          <div className="owner-actions"><button type="submit" disabled={working}>登录</button></div>
        </form>
        <p className="context-muted">也可以先在 <Link href="/">BeamingFace 首页</Link> 登录，再重新打开这个链接。</p></section>
      : <>
        <p className="context-muted">已登录 {session.user.email || session.user.id} <button type="button" onClick={() => void signOut()}>退出</button></p>
        {done?.kind === "granted" && permission && <section aria-label="已批准" role="status"><h2>已批准</h2>
          <p>权限已加到这个连接上。Agent 重试刚才被拒的操作即可，不用重新连接。</p>
          <p>可以在 <Link href="/oauth/connections">连接管理</Link> 随时收窄或撤销这个连接的权限。</p></section>}
        {done?.kind === "granted" && !permission && <section aria-label="已批准" role="status"><h2>{done.subjectChanged ? "接续会话授权已确认" : done.corrected ? "授权期限已修正" : "已批准"}</h2>
          {done.corrected && <p>{done.subjectChanged
            ? "旧授权已撤销，原申请和批准历史保留；新授权仅给刚才确认的接续会话，在 1 小时内使用 1 次。"
            : "旧授权已撤销，原申请和批准历史保留；新授权仅给原发起者，在 1 小时内使用 1 次。"}</p>}
          {(done.count ?? 1) > 1 && <p>同一批 {done.count} 项已批准，每项各自生成一个授权。</p>}
          <p>{done.grant?.max_uses === 1 ? "只允许这一次" : "授权已生效"}，有效期至 {new Date(String(done.grant?.expires_at)).toLocaleString()}。</p>
          <p>Agent 重试时会自动用上这次批准。可以在 <Link href="/grants">我的授权</Link> 随时撤销。</p>
          {(done.left?.length ?? 0) > 0 && <><p>同一批还有 {done.left?.length} 项没勾，仍等你确认：</p><ul>{done.left?.map(item =>
            <li key={item.id}><a href={"/confirm/" + item.id}>{item.action}</a></li>)}</ul></>}</section>}
        {done?.kind === "rejected" && <section aria-label="已拒绝" role="status"><h2>已拒绝</h2><p>Agent 不会得到这次授权。</p></section>}
        {!done && request && status !== "pending" && <section aria-label="请求状态"><h2>{STATUS[status] ?? status}</h2>
          <p>{canCorrect ? "原批准已保留。这次动作只接受 1 小时、1 次的授权，可在下方确认收窄期限。" : "这个请求已不需要处理。"}{status === "expired" ? "如仍需要，请让 Agent 重新发起。" : ""}</p>
          {leftover.length > 0 && <><p>同一批还有 {leftover.length} 项等你确认：</p><ul>{leftover.map(member =>
            <li key={String(member.request_id)}><Link href={"/confirm/" + String(member.request_id)}>{String(member.action ?? "")}</Link></li>)}</ul></>}</section>}
        {!done && canCorrect && !pending && !correction && <section aria-label="修正授权期限">
          <p>先核对这份申请的限时修正。页面会显示新授权给谁；如接续会话改变，需要你本人明确确认。预览不会修改授权。</p>
          <button type="button" disabled={working} onClick={() => void choose({ ...options, choice: "grant",
            seconds: 3600, anyAgent: false, scope: [], datasetSplitBootstrap: true, datasetSplitCorrection: true })}>查看限时修正</button>
        </section>}
        {!done && !pending && correction && view && <section aria-label="确认限时修正">
          <h2>{subjectChanged ? "确认授权给当前接续会话" : "确认收窄授权期限"}</h2>
          <p>{subjectChanged ? "原申请和批准历史保留，动作和六个对象的范围不变。这次新授权将给下面的当前接续会话，需要你本人确认。"
            : "原申请和批准历史保留，动作、原发起者和范围保持一致。"}</p>
          <dl><dt>动作</dt><dd>{actionText(view)}</dd>
            <dt>范围</dt><dd><ul>{list(view.resources).map(resource => <li key={resource}>{resource}</li>)}</ul></dd>
            <dt>原授权</dt><dd>{String(correction.previous_grant_id)}</dd>
            <dt>原期限</dt><dd>{new Date(String(correction.previous_expires_at)).toLocaleString()}</dd>
            <dt>新期限</dt><dd>确认后 1 小时内有效，且不超过原期限</dd>
            <dt>次数</dt><dd>1 次</dd><dt>给谁</dt><dd>{subjectChanged ? "当前接续会话：" : ""}{String(grantee?.agent_name ?? "原发起请求的 Agent")}</dd>
            {continuation && <>
              <dt>原申请的连接</dt><dd>{continuation.previous_binding.agent_name}（{continuation.previous_binding.vendor}） {continuation.previous_binding.binding_id}</dd>
              <dt>原申请会话</dt><dd>{continuation.previous_binding.session_ref ?? "原申请未记录会话"}</dd>
              <dt>当前接续连接</dt><dd>{continuation.current_binding.agent_name}（{continuation.current_binding.vendor}） {continuation.current_binding.binding_id}</dd>
              <dt>当前接续会话</dt><dd>{continuation.execution_claim.holder_session_ref}</dd>
              <dt>任务与版本</dt><dd>{continuation.task.title} {continuation.task.task_id} · 版本 {continuation.task.version}</dd>
              <dt>任务内容摘要</dt><dd>{continuation.task.content_hash}</dd>
              <dt>当前认领</dt><dd>{continuation.execution_claim.claim_id} · fence {continuation.execution_claim.fence} · lease {continuation.execution_claim.lease_version}</dd>
              <dt>认领有效期</dt><dd>{new Date(continuation.execution_claim.expires_at).toLocaleString()}（最长至 {new Date(continuation.execution_claim.hard_deadline_at).toLocaleString()}）</dd>
              <dt>会话自报说明（未核实）</dt><dd>{continuation.execution_claim.holder_label_self_reported}</dd>
            </>}
          </dl>
          <button type="button" disabled={working || !issued} onClick={() => void approve()}>{subjectChanged ? "确认授权给当前接续会话" : "确认限时修正"}</button>
          <button type="button" disabled={working} onClick={() => { setIssued(null); setError("");
            continuationSession.current = null;
            setOptions({ ...options, datasetSplitCorrection: false }); }}>返回原批准</button>
        </section>}
        {!done && status === "pending" && <>
          {!permission && <section aria-label="选择" className="owner-choice"><h2>怎么批</h2>
            {options.datasetSplitBootstrap ? <p>仅给发起请求的 Agent，在 1 小时内使用 1 次，范围保持这份请求列出的对象。</p> : <>
            <div className="context-row">
              <button type="button" aria-pressed={options.choice === "once"} disabled={working}
                onClick={() => void choose({ ...options, choice: "once" })}>只批这一次</button>
              <button type="button" aria-pressed={options.choice === "grant"} disabled={working}
                onClick={() => void choose({ ...options, choice: "grant" })}>这一类管一段时间</button>
            </div>
            {options.choice === "grant" && <label>时长
              <select value={String(options.seconds)} disabled={working}
                onChange={event => void choose({ ...options, seconds: Number(event.target.value) })}>
                {(DURATIONS.some(([value]) => value === options.seconds) ? DURATIONS : [...DURATIONS, [options.seconds, durationText(options.seconds)] as [number, string]])
                  .map(([value, label]) => <option key={value} value={String(value)}>{label}</option>)}
              </select></label>}
            <label className="owner-check"><input type="checkbox" checked={options.anyAgent} disabled={working}
              onChange={event => void choose({ ...options, anyAgent: event.target.checked })} />我的任何 Agent 都可以用（默认只给发起请求的 Agent）</label>
            {options.choice === "grant" && rows.length > 0 && <fieldset className="owner-scope" disabled={working}>
              <legend>范围（取消勾选即收窄，选上一级即放宽）</legend>
              {rows.map((row, index) => {
                const chosen = options.scope[index] ?? "";
                return <div key={row.resource} className="owner-scope-row">
                  <label className="owner-check"><input type="checkbox" checked={chosen !== ""}
                    disabled={working || (chosen !== "" && kept <= 1)}
                    data-index={index} onChange={pickScope} />
                    {row.options.length > 1 ? "" : row.resource}</label>
                  {row.options.length > 1 && <select aria-label={"范围：" + row.resource} value={chosen || row.resource}
                    disabled={working || chosen === ""} data-index={index} onChange={pickScope}>
                    {row.options.map((option, at) => <option key={option} value={option}>
                      {option}{at === 0 ? "（请求的范围）" : ""}</option>)}
                  </select>}
                </div>;
              })}
            </fieldset>}
            </>}
          </section>}
          {view && permission && <section aria-label="要批准什么"><h2>要批准什么</h2>
            <p className="context-muted">以下内容由 BeamingFace 生成，Agent 改不了。批准后权限加到这个连接上，不用重新连接。</p>
            <dl>
              <dt>给哪个连接</dt><dd>{String(connection?.client_name ?? grantee?.agent_name ?? "发起请求的连接")}</dd>
              <dt>要加的权限</dt><dd><ul>{authorizationDisplayOrder(permissions).map(item => <li key={String(item.resource)}>
                {permissionText(String(item.context ?? ""), item.context_name, String(item.action ?? ""))}</li>)}</ul></dd>
              <dt>它现在已有</dt><dd><ul>{authorizationDisplayOrder(existing).map(row => <li key={String(row.resource_kind) + ":" + String(row.resource_id)}>{currentText(row)}</li>)}</ul></dd>
              {typeof connection?.version === 'number' && <><dt>授权版本</dt><dd>{String(connection.version)}</dd></>}
              {task && <><dt>任务</dt><dd>{String(task.title ?? "")}</dd></>}
              <dt>期限</dt><dd>{connection?.expires_at ? "跟这个连接一样，到 " + new Date(String(connection.expires_at)).toLocaleString() + " 为止" : "跟这个连接一样"}</dd>
            </dl>
            {needsCoverage && <section aria-label="全部上下文覆盖预览"><h3>实际覆盖与保留限制</h3>
              {incompleteCoverage ? <p role="alert">覆盖、版本或限制预览不完整，暂时无法批准。请重新读取请求。</p> : <>
                <p>包含个人资料、个人记录及以下自有项目正式记录和上下文。以后新建的自有项目与上下文自动包含；共享或受邀资源不自动加入。</p>
                <p>本次申请：{list(coverage?.requested_actions).map(action => ACTION_LABELS[action] ?? action).join('、')}。</p>
                {list(coverage?.missing_actions).length > 0 && <p>客户端未申请或无法增加：{list(coverage?.missing_actions).map(action => ACTION_LABELS[action] ?? action).join('、')}。实际授权受限。</p>}
                <ul>{authorizationDisplayOrder(Array.isArray(coverage?.resources) ? coverage.resources.filter(object) : []).map(row => <li key={String(row.resource_kind) + ':' + String(row.resource_id) + ':' + String(row.environment)}>
                  {currentText({ ...row, effective_actions: row.actual_actions })}
                  {list(row.missing_actions).length > 0 && <p>缺项：{list(row.missing_actions).map(action => ACTION_LABELS[action] ?? action).join('、')}</p>}
                  {object(row.limits) && <details><summary>原限制保持</summary><pre>{JSON.stringify(row.limits, null, 2)}</pre></details>}
                </li>)}</ul>
                {Array.isArray(coverage?.restricted_resources) && coverage.restricted_resources.length > 0 && <details><summary>受限资源／精确例外</summary><pre>{JSON.stringify(coverage.restricted_resources, null, 2)}</pre></details>}
                <p>本次宏授权保留现有精确拒绝和字段／历史／版本限制，不能顺带解除它们。</p>
              </>}
            </section>}
            </section>}
          {view && !permission && <section aria-label="要批准什么"><h2>要批准什么</h2>
            <p className="context-muted">以下内容由 BeamingFace 生成，Agent 改不了。</p>
            <dl>
              {!items.length && <><dt>动作</dt><dd>{actionText(view)}</dd>
                <dt>范围</dt><dd><ul>{list(view.resources).map(resource => <li key={resource}>{resource}</li>)}</ul></dd></>}
              {task && <><dt>任务</dt><dd>{String(task.title ?? "")}</dd></>}
              <dt>给谁</dt><dd>{grantee?.any_agent ? "我的任何 Agent" : String(grantee?.agent_name ?? "发起请求的 Agent") + (grantee?.vendor ? "（" + String(grantee.vendor) + "）" : "")}</dd>
              <dt>期限</dt><dd>{termText(view)}</dd>
              <dt>次数</dt><dd>{usesText(view)}</dd>
            </dl>
            {items.length > 0 && <fieldset aria-label="同一批" className="owner-bundle" disabled={working}>
              <legend>同一批共 {items.length} 项，勾上的才会批准</legend>
              {items.map(item => {
                const other = item.view;
                const differs = other && (termText(other) !== termText(view) || usesText(other) !== usesText(view));
                return <label key={item.id} className="owner-check owner-bundle-item">
                  <input type="checkbox" checked={!skipped.includes(item.id)} data-id={item.id} onChange={pick} />
                  <span><strong>{other ? actionText(other) : "正在生成…"}</strong>
                    {other && <ul>{list(other.resources).map(resource => <li key={resource}>{resource}</li>)}</ul>}
                    {differs && <span className="context-muted">期限：{termText(other)}；次数：{usesText(other)}</span>}</span>
                </label>;
              })}
            </fieldset>}
            {items.length > 0 && picked.length < items.length && <p className="context-muted">没勾的项保持待确认，之后还可以再批。</p>}
            {deployAlone && <p className="owner-warning" role="note">部署通常依赖同批迁移，只批部署可能出错。</p>}</section>}
          {note && admissionNote && <section aria-label="准入检查说明" className="owner-note"><h2>准入检查说明</h2>
            <p className="context-muted">这段话由 BeamingFace 的准入检查根据 PR 写出，不是 Agent 自述；批准前请打开链接看这些提交改了什么。</p><p>{note}</p>
            {compareLink ? <p><a href={compareLink} target="_blank" rel="noreferrer">在 GitHub 上查看这些提交的改动</a></p>
              : <p className="context-muted">说明里的链接与要批准的提交不一致，已隐藏；请在 GitHub 上按上面的提交核对。</p>}</section>}
          {note && !admissionNote && <section aria-label="Agent 说明" className="owner-note"><h2>Agent 说明（未核实）</h2>
            <p className="context-muted">这段话是 Agent 自己写的，不改变上面要批准的内容。</p><p>{note}</p></section>}
          {!pending && <div className="owner-actions">
            <button type="button" disabled={working || incompleteCoverage || (items.length ? !picked.length || picked.some(item => !item.view) : !issued)}
              onClick={() => void approve()}>批准</button>
            <button type="button" disabled={working} onClick={() => void reject()}>拒绝</button>
          </div>}
        </>}
        {pending && !working && <section aria-label="待核对"><p>有一次批准结果尚未确认。</p>
          <div className="owner-actions"><button type="button" onClick={() => void approve(pending)}>核对原操作</button></div></section>}
        {working && <p role="status">处理中…</p>}
      </>}
    {error && <p role="alert">{error}</p>}
  </main>;
}
