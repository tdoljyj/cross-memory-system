"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { type Session } from "@supabase/supabase-js";
import { supabase } from "../../supabase-browser";
import Link from "next/link";
import HeadlessBindings from "./headless";
import { ALL_CONTEXTS, FUTURE_PROJECT_CONTEXTS, authorizationDisplayOrder, isFuturePolicy, isMacro, operationSummary, resourceTitle, type Resource } from '../../../lib/context-authorization';

const API = "/oauth/connections/api";
// Headless Bindings share the v12 authorization table; they are listed and
// managed in their own section (./headless.tsx), not as OAuth connections.
const HEADLESS_CLIENT = "clued-headless";

type Grant = Resource & {
  resource_kind: "scope" | "context";
  resource_id: string;
  environment: string;
  actions: string[];
  effective_actions?: string[];
  qualification_id?: string | null;
  source_refs?: { source_id: string; version: number; kind: string }[];
  limits?: Record<string, unknown>;
  precise_limit_confirmation?: PreciseIdentity;
};
type Json = Record<string, unknown>;
type PreciseIdentity = { supported: boolean; reason?: string; authorization_version: number; grant_id: string | null; grant_version: number | null;
  override_id: string | null; override_version: number | null; available_actions: string[]; current_expires_at?: string };
type LimitProposal = { actions: string[]; denied_actions: string[]; allowed_ceiling: string[] | null;
  history_policy?: string; version_policy?: string; freeze_cursor?: number; since_cursor?: number | null;
  explicit_record_ids?: string[]; allowed_fields?: string[]; expires_at: string };
type LimitDraft = { binding: Binding; grant: Grant; identity: PreciseIdentity; proposal: LimitProposal; availableActions: string[] };
type LimitPreview = { draft: LimitDraft; confirmation_token: string; view_digest: string; token_id: string; expires_at: string; view: Json };
type Source = { source_id: string; version: number; kind: string; actions: string[]; contributions: Grant[] };
type Override = { override_id: string; version: number; resource_kind: 'scope' | 'context'; resource_id: string; environment: string;
  qualification_id?: string | null; denied_actions: string[]; allowed_ceiling: string[] | null; limits?: Record<string, unknown> };
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
  selection_format?: 'sources_v1' | 'flat_v12'; sources?: Source[]; overrides?: Override[];
  coverage?: { status: 'complete' | 'restricted' | 'legacy' | 'unknown'; differences: unknown[] };
};
type Selection = Record<string, Record<string, string[]>>;
type StorageAccess = { binding_id: string; denied: boolean; generation: number; receipt_id: string | null };


const actionLabels: Record<string, string> = {
  read: "读取", write: "新增和修改", close: "关闭和归档", restore: "恢复记录",
  feedback_submit: "提交反馈", audit: "查看审计回执",
};
const rowKey = (grant: Pick<Grant, "resource_kind" | "resource_id" | "environment">) => JSON.stringify([grant.resource_kind, grant.resource_id, grant.environment]);
const failureMessage = (failure: unknown, fallback: string) =>
  failure instanceof Error && !(failure instanceof TypeError) ? failure.message : fallback;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const splitValues = (value: string) => [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))];
function validPreciseIdentity(value: unknown, binding: Binding, grant: Grant): value is PreciseIdentity {
  return isObject(value) && value.supported === true && value.authorization_version === binding.version
    && (grant.resource_kind === 'context' ? typeof value.grant_id === 'string' && Number.isSafeInteger(value.grant_version) && Number(value.grant_version) > 0
      : grant.environment === 'canonical' && (['global','profile'].includes(grant.resource_id) || /^project:[0-9a-f-]{36}$/i.test(grant.resource_id))
        && value.grant_id === null && value.grant_version === null && typeof value.override_id === 'string')
    && (value.override_id === null && value.override_version === null || typeof value.override_id === 'string' && Number.isSafeInteger(value.override_version) && Number(value.override_version) > 0)
    && stringArray(value.available_actions);
}
function preciseViewMatches(view: Json, draft: LimitDraft): boolean {
  const identity = draft.identity;
  if (view.kind !== 'authorization_precise_limits' || view.binding_id !== draft.binding.binding_id || view.authorization_version !== draft.binding.version
    || view.resource_kind !== draft.grant.resource_kind || view.resource_id !== draft.grant.resource_id || view.environment !== draft.grant.environment
    || view.grant_id !== identity.grant_id || view.grant_version !== identity.grant_version || view.override_id !== identity.override_id
    || view.override_version !== identity.override_version || !isObject(view.old) || !(draft.grant.resource_kind === 'context' ? isObject(view.old.grant) : view.old.grant === null) || !isObject(view.new)
    || !stringArray(view.old.binding_scopes) || !isObject(view.source_snapshot)) return false;
  const next = view.new;
  return Object.entries(draft.proposal).every(([key, value]) => Array.isArray(value)
    ? stringArray(next[key]) && JSON.stringify([...value].sort()) === JSON.stringify([...(next[key] as string[])].sort())
    : key === 'expires_at' ? Date.parse(String(next[key])) === Date.parse(String(value)) : next[key] === value);
}

function optionalDate(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}
function validGrant(value: unknown): boolean {
  return isObject(value) && (value.resource_kind === "scope" || value.resource_kind === "context")
    && typeof value.resource_id === "string" && typeof value.environment === "string"
    && Array.isArray(value.actions) && value.actions.every(action => typeof action === "string")
    && (value.effective_actions === undefined || Array.isArray(value.effective_actions) && value.effective_actions.every(action => typeof action === "string"));
}

function isBinding(value: unknown): value is Binding {
  return isObject(value) && typeof value.binding_id === "string" && typeof value.client_id === "string"
    && typeof value.client_name === "string" && typeof value.version === "number"
    && Number.isSafeInteger(value.version) && typeof value.expires_at === "string"
    && Number.isFinite(Date.parse(value.expires_at)) && typeof value.active === "boolean"
    && optionalDate(value.created_at) && optionalDate(value.last_used_at)
    && (value.selection_format === undefined || value.selection_format === "flat_v12" || value.selection_format === "sources_v1")
    && (value.selection_format !== "sources_v1" || (Array.isArray(value.sources) && value.sources.every(source =>
      isObject(source) && typeof source.source_id === "string" && Number.isSafeInteger(source.version) && Number(source.version) > 0
      && typeof source.kind === "string" && Array.isArray(source.actions) && source.actions.every(action => typeof action === "string")
      && Array.isArray(source.contributions) && source.contributions.every(validGrant)) && Array.isArray(value.overrides) && value.overrides.every(item =>
        isObject(item) && typeof item.override_id === "string" && Number.isSafeInteger(item.version) && Number(item.version) > 0
        && (item.resource_kind === "scope" || item.resource_kind === "context") && typeof item.resource_id === "string" && typeof item.environment === "string"
        && Array.isArray(item.denied_actions) && item.denied_actions.every(action => typeof action === "string")
        && (item.allowed_ceiling === null || Array.isArray(item.allowed_ceiling) && item.allowed_ceiling.every(action => typeof action === "string")))
      && isObject(value.coverage) && ["complete", "restricted", "legacy", "unknown"].includes(String(value.coverage.status)) && Array.isArray(value.coverage.differences)))
    && Array.isArray(value.grants) && value.grants.every(grant =>
      isObject(grant) && (grant.resource_kind === "scope" || grant.resource_kind === "context")
      && typeof grant.resource_id === "string" && typeof grant.environment === "string"
      && Array.isArray(grant.actions) && grant.actions.every(action => typeof action === "string")
      && (grant.effective_actions === undefined || (Array.isArray(grant.effective_actions) && grant.effective_actions.every(action => typeof action === "string"))));
}

async function readResponse(response: Response, fallback: string): Promise<unknown> {
  if (!response.ok) {
    if (response.status === 400) {
      const problem: unknown = await response.json().catch(() => null);
      if (isObject(problem) && problem.error === 'authorization_empty_projection_requires_binding_revoke') {
        throw new Error('本次修改未保存。要取消此连接的全部权限，请重新读取后使用“撤销此连接”。');
      }
    }
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
  return binding.grants.filter(grant => !isFuturePolicy(grant) && (binding.selection_format === "sources_v1" ? !isMacro(grant) : !coveredByAll(binding, selection, grant))).map(grant => ({
    resource_kind: grant.resource_kind, resource_id: grant.resource_id, environment: grant.environment,
    actions: chosenActions(binding, selection, grant),
  })).filter(grant => grant.actions.length > 0);
}
function rangeName(binding: Binding): string {
  const all = binding.grants.some(grant => grant.resource_kind === 'scope' && grant.resource_id === ALL_CONTEXTS);
  if (all) return binding.coverage?.status === 'complete' ? '全部权限（含以后新建的自有内容）' : '全部权限策略 · 自定义／受限';
  return authorizationDisplayOrder(binding.grants.filter(grant => !(grant.resource_kind === 'scope' && grant.resource_id.startsWith('project:') && grant.resource_id !== ALL_PROJECTS && allProjectsGrant(binding))))
    .map(resourceTitle).join('、') || '无业务范围';
}
const grantTitle = resourceTitle;
const sourceTitle = (source: Source) => source.kind === 'contexts_policy' ? '全部权限策略（已有和未来）'
  : source.kind === 'future_owned_project_policy' ? '未来项目记录'
  : source.kind === 'future_owned_context_policy' ? '未来项目上下文'
  : source.kind === 'legacy_project_policy' ? '原自有项目正式记录策略' : source.kind === 'legacy_effective_baseline' ? '原授权保全' : '独立明确授权';
function exceptionsFor(binding: Binding, selection: Selection) {
  return binding.grants.filter(grant => !isMacro(grant)).flatMap(grant => {
    const before = grant.effective_actions ?? grant.actions;
    const kept = chosenActions(binding, selection, grant);
    const removed = before.filter(action => !kept.includes(action));
    if (!removed.length) return [];
    const existing = binding.overrides?.find(item => rowKey(item) === rowKey(grant));
    return [{ ...(existing ? { override_id: existing.override_id, base_version: existing.version } : {}),
      resource_kind: grant.resource_kind, resource_id: grant.resource_id, environment: grant.environment,
      ...(grant.qualification_id ? { qualification_id: grant.qualification_id } : {}),
      denied_actions: [...new Set([...(existing?.denied_actions ?? []), ...removed])],
      ...(existing?.allowed_ceiling ? { allowed_ceiling: existing.allowed_ceiling } : {}) }];
  });
}

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
  const [sourceSelection, setSourceSelection] = useState<Selection>({});
  const [limitDraft, setLimitDraft] = useState<LimitDraft | null>(null);
  const [limitPreview, setLimitPreview] = useState<LimitPreview | null>(null);
  const [limitUncertain, setLimitUncertain] = useState(false);
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
    setBindings(rows); setLimitDraft(null); setLimitPreview(null); setLimitUncertain(false);
    setSelection(Object.fromEntries(rows.map(binding => [binding.binding_id,
      Object.fromEntries(binding.grants.map(grant => [rowKey(grant), [...(binding.selection_format === "sources_v1" ? grant.effective_actions ?? [] : grant.actions)]])),
    ])));
    setSourceSelection(Object.fromEntries(rows.map(binding => [binding.binding_id, Object.fromEntries((binding.sources ?? []).map(source => [source.source_id, [...source.actions]]))])));
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
      setSelection({}); setSourceSelection({});
      setLoaded(false);
      setPending(null); setLimitDraft(null); setLimitPreview(null); setLimitUncertain(false);
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
          ...(op === "reduce" ? binding.selection_format === 'sources_v1' ? { selection_format: 'sources_v1',
            sources: (binding.sources ?? []).map(source => ({ source_id: source.source_id, base_version: source.version,
              action_cap: source.actions.filter(action => (sourceSelection[binding.binding_id]?.[source.source_id] ?? []).includes(action)) })),
            exceptions: exceptionsFor(binding, selection) } : { selected } : {}),
        }),
      });
      await readResponse(response, "无法确认此次操作结果，请重新读取连接。");
      submitted = true;
      if (accountEpoch.current !== epoch || controller.signal.aborted) return;
      const latest = await readBindings(currentSession.current ?? who, epoch, false);
      if (!latest || accountEpoch.current !== epoch) return;
      const updated = latest.find(row => row.binding_id === binding.binding_id);
      const confirmed = op === "revoke" ? !updated || !updated.active
         : updated && updated.version > binding.version && (binding.selection_format === 'sources_v1'
          ? updated.selection_format === 'sources_v1' && Array.isArray(updated.sources) && updated.sources.every(source => {
            const before = binding.sources?.find(item => item.source_id === source.source_id);
            return !!before && source.actions.every(action => (sourceSelection[binding.binding_id]?.[source.source_id] ?? []).includes(action));
          }) && exceptionsFor(binding, selection).every(exception => updated.overrides?.some(actual => rowKey(actual) === rowKey(exception)
            && exception.denied_actions.every(action => actual.denied_actions.includes(action))))
          : updated.grants.every(grant => {
          const allowed = selected.find(row => rowKey(row) === rowKey(grant));
          // A project row Clued rebuilt from project:* is allowed what project:* is.
          const all = grant.resource_kind === "scope" && grant.resource_id.startsWith("project:")
            ? selected.find(row => row.resource_kind === "scope" && row.resource_id === ALL_PROJECTS) : undefined;
          return grant.actions.every(action => allowed?.actions.includes(action) || all?.actions.includes(action));
        }));
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
  }, [applyBindings, needsReload, readBindings, selection, sourceSelection]);

  function openLimits(binding: Binding, grant: Grant) {
    const identity = grant.precise_limit_confirmation, limits = grant.limits;
    if (!validPreciseIdentity(identity, binding, grant) || !limits
      || typeof (identity.current_expires_at ?? limits.expires_at) !== 'string' || !Number.isFinite(Date.parse(String(identity.current_expires_at ?? limits.expires_at)))
      || grant.resource_kind === 'context' && (!['EXISTING_ONLY','EXISTING_AND_FUTURE','SINCE_CURSOR','EXPLICIT_SET'].includes(String(limits.history_policy))
        || !['LATEST','FIXED_AT_GRANT'].includes(String(limits.version_policy)) || !Number.isSafeInteger(limits.freeze_cursor) || Number(limits.freeze_cursor) < 0
        || !(limits.since_cursor === null || Number.isSafeInteger(limits.since_cursor) && Number(limits.since_cursor) >= 0)
        || !stringArray(limits.explicit_record_ids) || !stringArray(limits.allowed_fields))) {
      setError('这个资源的精确权限身份或现有限制尚未完整提供，不能创建放宽确认。请重新读取。'); return;
    }
    const override = binding.overrides?.find(item => item.override_id === identity.override_id);
    if (identity.override_id && (!override || override.version !== identity.override_version)) { setError('精确例外已有变化，请重新读取。'); return; }
    const proposal: LimitProposal = { actions: stringArray(limits.actions) ? [...limits.actions] : [...(grant.effective_actions ?? [])],
      denied_actions: [...(override?.denied_actions ?? [])], allowed_ceiling: override?.allowed_ceiling ? [...override.allowed_ceiling] : null,
      expires_at: String(identity.current_expires_at ?? limits.expires_at), ...(grant.resource_kind === 'context' ? {
        history_policy: String(limits.history_policy), version_policy: String(limits.version_policy), freeze_cursor: Number(limits.freeze_cursor),
        since_cursor: limits.since_cursor === null ? null : Number(limits.since_cursor), explicit_record_ids: [...(limits.explicit_record_ids as string[])], allowed_fields: [...(limits.allowed_fields as string[])] } : {}) };
    setLimitDraft({ binding, grant, identity, proposal, availableActions: [...identity.available_actions] });
    setLimitPreview(null); setLimitUncertain(false); setError(''); setNotice('');
  }
  function editLimit(change: Partial<LimitProposal>) {
    setLimitDraft(old => old ? { ...old, proposal: { ...old.proposal, ...change } } : old); setLimitPreview(null); setLimitUncertain(false);
  }
  async function nativeLimits(who: Session, controller: AbortController, input: Json): Promise<Json> {
    const response = await fetch(API, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { Authorization: `Bearer ${who.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    if (response.status >= 500) throw new TypeError('精确权限结果未知');
    let data: unknown;
    try { data = await readResponse(response, '精确权限确认被拒绝，请重新读取。'); }
    catch (failure) { if (response.ok) throw new TypeError('精确权限结果未知'); throw failure; }
    if (!isObject(data)) throw new TypeError('未知确认结果');
    if (data.status === 'rejected' || data.status === 'failed') throw new Error('精确权限确认被拒绝：' + String(data.error_code ?? data.status));
    return data;
  }
  async function previewLimits() {
    const who = currentSession.current, draft = limitDraft, epoch = accountEpoch.current;
    if (!who || !draft || writeController.current || needsReload || !draft.binding.active || Date.parse(draft.binding.expires_at) <= Date.now()) return;
    const expiry = Date.parse(draft.proposal.expires_at);
    if (!draft.proposal.actions.length || draft.grant.resource_kind === 'context' && !draft.proposal.allowed_fields?.length
      || !Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.parse(draft.binding.expires_at)) {
      setError('请选择动作及适用字段范围；有效期须在未来，并且不超过此连接的有效期。'); return;
    }
    const controller = new AbortController(); writeController.current = controller; setPending(draft.binding.binding_id); setError(''); setLimitPreview(null);
    try {
      const value = await nativeLimits(who, controller, { op: 'limit_confirmation_issue', binding_id: draft.binding.binding_id, base_version: draft.binding.version,
        resource_kind: draft.grant.resource_kind, resource_id: draft.grant.resource_id, environment: draft.grant.environment, grant_id: draft.identity.grant_id,
        grant_base_version: draft.identity.grant_version, override_id: draft.identity.override_id, override_base_version: draft.identity.override_version, new: draft.proposal });
      if (accountEpoch.current !== epoch || currentSession.current?.user.id !== who.user.id || controller.signal.aborted) return;
      if (value.status !== 'issued' || typeof value.confirmation_token !== 'string' || typeof value.view_digest !== 'string' || typeof value.token_id !== 'string'
        || typeof value.expires_at !== 'string' || !Number.isFinite(Date.parse(value.expires_at)) || !isObject(value.confirmation_view) || !preciseViewMatches(value.confirmation_view, draft))
        throw new Error('精确限制的旧值、新值或版本预览不完整，暂时不能确认。请重新读取。');
      setLimitPreview({ draft, confirmation_token: value.confirmation_token, view_digest: value.view_digest, token_id: value.token_id, expires_at: value.expires_at, view: value.confirmation_view });
    } catch (failure) { if (accountEpoch.current === epoch && !controller.signal.aborted) setError(failureMessage(failure, '预览尚未确认，请重新读取。')); }
    finally { if (writeController.current === controller) writeController.current = null; if (accountEpoch.current === epoch) setPending(null); }
  }
  async function confirmLimits() {
    const who = currentSession.current, target = limitPreview, epoch = accountEpoch.current;
    if (!who || !target || writeController.current || !preciseViewMatches(target.view, target.draft)) return;
    if (!limitUncertain && Date.parse(target.expires_at) <= Date.now()) { setLimitPreview(null); setError('预览已过期，请重新预览后确认。'); return; }
    const controller = new AbortController(); writeController.current = controller; setPending(target.draft.binding.binding_id); setError('');
    let submitted = false;
    try {
      const value = await nativeLimits(who, controller, { op: 'limit_confirm', confirmation_token: target.confirmation_token, view_digest: target.view_digest });
      if (accountEpoch.current !== epoch || currentSession.current?.user.id !== who.user.id || controller.signal.aborted) return;
      if (value.status !== 'committed' || typeof value.receipt_id !== 'string' || value.binding_id !== target.draft.binding.binding_id || !Number.isSafeInteger(value.version)
        || Number(value.version) <= target.draft.binding.version) throw new TypeError('确认回执尚未核实');
      submitted = true;
      const latest = await readBindings(who, epoch, false);
      if (!latest || accountEpoch.current !== epoch) return;
      const actual = latest.find(binding => binding.binding_id === target.draft.binding.binding_id);
      if (!actual || actual.version < Number(value.version)) throw new TypeError('确认后状态未核实');
      applyBindings(latest); setNotice(`此上下文的精确限制已确认，最新状态已读取。回执：${value.receipt_id}`);
    } catch (failure) {
      if (accountEpoch.current !== epoch || controller.signal.aborted) return;
      if (failure instanceof TypeError || submitted) { setLimitUncertain(true); setNeedsReload(true); setError('确认结果尚未核实。可核对原确认，系统沿用同一令牌和摘要，不重新放宽。'); }
      else { setLimitPreview(null); setNeedsReload(true); setError(failureMessage(failure, '精确限制确认被拒绝，请重新读取。')); }
    } finally { if (writeController.current === controller) writeController.current = null; if (accountEpoch.current === epoch) setPending(null); }
  }

  async function revokeStorage(binding: Binding) {
    const who = currentSession.current, epoch = accountEpoch.current;
    const prior = storageAccess[binding.binding_id];
    if (!who || !storageLoaded || !prior || prior.denied || writeController.current || needsReload) return;
    if (!window.confirm(`仅撤销 ${binding.client_name} 的网盘访问？此客户端的 BeamingFace 记忆权限、其他客户端和整个网盘连接不变。已开始的文件操作仍需核对原回执。`)) return;
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
        <Link className="oauth-brand" href="/" aria-label="返回 BeamingFace 首页">
          <span className="brand-mark" aria-hidden="true" /><span>BeamingFace</span>
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
          <h2 style={{ fontSize: 20 }}>登录你的 BeamingFace 账户</h2>
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
            const changed = (binding.sources ?? []).some(source => source.actions.some(action => !(sourceSelection[binding.binding_id]?.[source.source_id] ?? []).includes(action))) || binding.grants.some(grant => (binding.selection_format === 'sources_v1' ? grant.effective_actions ?? [] : grant.actions).some(action =>
              !(selection[binding.binding_id]?.[rowKey(grant)] ?? []).includes(action)));
            return <article key={binding.binding_id} style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 18, marginTop: 18 }}>
              <h2 style={{ fontSize: 20, margin: "0 0 14px", overflowWrap: "anywhere" }}>{binding.client_name || binding.client_id}</h2>
              <dl className="oauth-details">
                <div><dt>状态</dt><dd>{!binding.active ? "已撤销或失效" : expired ? "已过期" : "授权有效"}</dd></div>
                <div><dt>授权日期</dt><dd>{binding.created_at ? <time dateTime={binding.created_at}>{new Date(binding.created_at).toLocaleString("zh-CN")}</time> : "暂无记录"}</dd></div>
                <div><dt>最近使用</dt><dd>{binding.last_used_at ? <time dateTime={binding.last_used_at}>{new Date(binding.last_used_at).toLocaleString("zh-CN")}</time> : "暂无记录"}</dd></div>
                <div><dt>有效期至</dt><dd><time dateTime={binding.expires_at}>{new Date(binding.expires_at).toLocaleString("zh-CN")}</time></dd></div>
                <div><dt>连接编号</dt><dd>{binding.binding_id}</dd></div>
                <div><dt>范围</dt><dd>{rangeName(binding)}</dd></div>
                <div><dt>操作权限</dt><dd>{binding.coverage?.status === 'restricted' || binding.coverage?.status === 'unknown' ? '自定义／受限' : operationSummary(binding.grants.filter(grant => !isMacro(grant)), binding.selection_format !== 'sources_v1')}</dd></div>
              </dl>
              {!binding.grants.some(grant => grant.resource_kind === 'context' || grant.resource_id === ALL_CONTEXTS || grant.resource_id === FUTURE_PROJECT_CONTEXTS) && <p className="oauth-copy">原授权尚不包含项目上下文。需要扩大时，请让当前客户端重新申请授权，并在 BeamingFace 确认页核对新增范围与限制。</p>}
              {binding.coverage && binding.coverage.status !== 'complete' && binding.coverage.differences.length > 0 && <details><summary>实际权限差异／限制</summary><pre>{JSON.stringify(binding.coverage.differences, null, 2)}</pre></details>}
              {binding.selection_format === 'sources_v1' && <section aria-label="授权来源"><h3>逐项收窄授权来源</h3><p>只修改勾选来源；派生资源不是另一次独立授权。原授权不会因删掉新策略而被误删。</p>
                {(binding.sources ?? []).map(source => <fieldset key={source.source_id} disabled={busy || unavailable || needsReload}>
                  <legend>{sourceTitle(source)}</legend>{source.actions.map(action => <label key={action}><input type="checkbox"
                    checked={(sourceSelection[binding.binding_id]?.[source.source_id] ?? []).includes(action)} onChange={event => {
                      const checked = event.target.checked; setSourceSelection(old => ({ ...old, [binding.binding_id]: { ...old[binding.binding_id],
                        [source.source_id]: source.actions.filter(item => item === action ? checked : (old[binding.binding_id]?.[source.source_id] ?? []).includes(item)) } }));
                    }} />{actionLabels[action] || action}</label>)}<details><summary>来源与覆盖详情</summary><p>{source.source_id} · 版本 {source.version}</p>
                      <ul>{source.contributions.map(grant => <li key={rowKey(grant)}>{resourceTitle(grant)}：{grant.actions.map(action => actionLabels[action] || action).join('、')}</li>)}</ul></details>
                </fieldset>)}
              </section>}
              {binding.grants.filter(grant => !isMacro(grant)).length === 0 && <p className="oauth-copy">此连接当前没有可访问的内容范围。</p>}
              {authorizationDisplayOrder(binding.grants.filter(grant => !isFuturePolicy(grant) && (binding.selection_format === "sources_v1" ? !isMacro(grant) : !coveredByAll(binding, selection, grant)))).map(grant => <fieldset key={rowKey(grant)} disabled={busy || unavailable || needsReload}
                style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 12, margin: "12px 0", minWidth: 0 }}>
                <legend style={{ fontSize: 12, overflowWrap: "anywhere" }}>
                  {grantTitle(grant)}
                </legend>
                {grant.resource_id === ALL_PROJECTS && <p className="oauth-copy">以后新建的项目自动包含在内。这里的勾选同时作用于下面没有单独列出的每个项目。</p>}
                {grant.effective_actions && grant.resource_id !== ALL_PROJECTS && <p className="oauth-copy">当前实际可用：{grant.effective_actions.length ? grant.effective_actions.map(action => actionLabels[action] || action).join("、") : "无可用操作"}</p>}
                {grant.limits && <details><summary>保留的读取和写入限制</summary><pre>{JSON.stringify(grant.limits, null, 2)}</pre></details>}
                {grant.precise_limit_confirmation?.supported === true && <button type="button" disabled={busy || unavailable || needsReload || limitPreview !== null}
                  onClick={() => openLimits(binding, grant)}>{grant.resource_kind === 'context' ? '单独调整此上下文的精确限制' : '单独调整此范围的精确限制'}</button>}
                {grant.precise_limit_confirmation?.supported === false && <p className="oauth-copy">此资源的精确限制确认暂不可用{grant.precise_limit_confirmation.reason ? '：' + grant.precise_limit_confirmation.reason : '。'}；不能通过全部上下文策略解除限制。</p>}
                {grant.source_refs && <details><summary>授权来源</summary><pre>{JSON.stringify(grant.source_refs, null, 2)}</pre></details>}
                {(binding.selection_format === 'sources_v1' ? grant.effective_actions ?? [] : grant.actions).map(action => <label key={action} style={{ display: "flex", alignItems: "center", gap: 10, margin: "9px 0", fontSize: 13 }}>
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
              {limitDraft?.binding.binding_id === binding.binding_id && <section aria-label="精确上下文限制调整">
                <h3>单独调整：{resourceTitle(limitDraft.grant)}</h3><p>只调整这一个内容范围。放宽已有精确限制都需要下面独立确认；最终能力仍受原授权来源与客户端范围限制。</p>
                <fieldset disabled={busy || limitPreview !== null || needsReload}><legend>拟调整为</legend>
                  <div>{limitDraft.availableActions.map(action => <label key={action}><input type="checkbox" checked={limitDraft.proposal.actions.includes(action)}
                    onChange={event => editLimit({ actions: event.target.checked ? [...limitDraft.proposal.actions.filter(value => value !== action), action] : limitDraft.proposal.actions.filter(value => value !== action) })} />{actionLabels[action] ?? action}</label>)}</div>
                  {limitDraft.grant.resource_kind === 'context' && <><label>历史范围<select value={limitDraft.proposal.history_policy} onChange={event => editLimit({ history_policy: event.target.value })}>
                    <option value="EXISTING_ONLY">授权时已存在的内容</option><option value="EXISTING_AND_FUTURE">已有及以后新增的内容</option>
                    <option value="SINCE_CURSOR">指定位置之后新增的内容</option><option value="EXPLICIT_SET">明确列出的记录</option></select></label>
                  <label>版本范围<select value={limitDraft.proposal.version_policy} onChange={event => editLimit({ version_policy: event.target.value })}>
                    <option value="LATEST">最新保留版本</option><option value="FIXED_AT_GRANT">固定到指定位置的版本</option></select></label>
                  <label>固定位置<input type="number" min={0} step={1} value={limitDraft.proposal.freeze_cursor} onChange={event => editLimit({ freeze_cursor: Number(event.target.value) })} /></label>
                  <label>起始位置（可留空）<input type="number" min={0} step={1} value={limitDraft.proposal.since_cursor ?? ''} onChange={event => editLimit({ since_cursor: event.target.value === '' ? null : Number(event.target.value) })} /></label>
                  <label>明确记录编号（逗号分隔）<input value={limitDraft.proposal.explicit_record_ids?.join(',') ?? ''} onChange={event => editLimit({ explicit_record_ids: splitValues(event.target.value) })} /></label>
                  <label>允许字段（逗号分隔；* 表示全部字段）<input value={limitDraft.proposal.allowed_fields?.join(',') ?? ''} onChange={event => editLimit({ allowed_fields: splitValues(event.target.value) })} /></label>
                  </>}<label>精确拒绝动作（逗号分隔）<input value={limitDraft.proposal.denied_actions.join(',')} onChange={event => editLimit({ denied_actions: splitValues(event.target.value) })} /></label>
                  <label>动作允许上限（空值表示无额外上限）<input value={limitDraft.proposal.allowed_ceiling?.join(',') ?? ''} onChange={event => editLimit({ allowed_ceiling: event.target.value.trim() ? splitValues(event.target.value) : null })} /></label>
                  <label>有效期至<input value={limitDraft.proposal.expires_at} onChange={event => editLimit({ expires_at: event.target.value })} /></label>
                  <button type="button" onClick={() => editLimit({ expires_at: binding.expires_at })}>使用此连接的有效期</button>
                  <button type="button" onClick={() => void previewLimits()}>预览精确限制变更</button>
                </fieldset>
                {!limitPreview && <button type="button" disabled={busy} onClick={() => { setLimitDraft(null); setLimitUncertain(false); }}>取消精确限制调整</button>}
                {limitPreview && <section aria-label="独立确认精确限制"><h4>核对旧值与新值</h4>
                  <p>{String(limitPreview.view.client_name ?? binding.client_name)} · {resourceTitle(limitPreview.draft.grant)}；授权版本 {String(limitPreview.view.authorization_version)}。</p>
                  <table><thead><tr><th>原限制</th><th>拟调整为</th></tr></thead><tbody><tr><td><pre>{JSON.stringify(limitPreview.view.old, null, 2)}</pre></td><td><pre>{JSON.stringify(limitPreview.view.new, null, 2)}</pre></td></tr></tbody></table>
                  <details><summary>授权来源与版本核对</summary><pre>{JSON.stringify(limitPreview.view.source_snapshot, null, 2)}</pre></details>
                  <p>本次确认只对应以上资源、环境、旧值与新值。任何版本变化都需要重新预览。</p>
                  <button type="button" disabled={busy} onClick={() => void confirmLimits()}>{limitUncertain ? '核对原精确限制确认' : '确认此上下文的精确限制变更'}</button>
                  {!limitUncertain && <button type="button" disabled={busy} onClick={() => { setLimitPreview(null); setLimitDraft(null); }}>取消这次精确确认</button>}
                </section>}
              </section>}
              {storageLoaded && storageAccess[binding.binding_id] && <div className="oauth-actions">
                <p className="oauth-copy">{storageAccess[binding.binding_id].denied ? "网盘访问已单独撤销" : "网盘访问按账号规则单独管理"}</p>
                {!storageAccess[binding.binding_id].denied && <button className="oauth-secondary" type="button"
                  disabled={busy || needsReload} onClick={() => void revokeStorage(binding)}>仅撤销此客户端的网盘访问</button>}
              </div>}
              {!storageLoaded && <p className="oauth-copy">网盘访问状态未确认；重新读取连接后再管理。</p>}
              {unavailable ? <p className="oauth-copy">此连接无法恢复。需要继续访问时，请从客户端重新发起授权。</p> : <>
                <p className="oauth-copy" style={{ marginBottom: 14 }}>{changed ? "权限调整尚未保存。保存后不能在此重新增加已移除的权限。" : "取消勾选可减少权限；扩大范围需当前客户端申请并由你明确确认。"}</p>
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
