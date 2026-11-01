"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { type Session } from "@supabase/supabase-js";
import { supabase } from "../supabase-browser";
import "../contexts/contexts.css";
import "../confirm/owner.css";
import "./nodes.css";

type Json = Record<string, unknown>;
type NodeAction = "approve" | "drain" | "retire" | "revoke";
type Node = { node_id: string; name: string; state: string; version: number; binding_id: string;
  profile_sha256: string; identity_fingerprint: string; encryption_fingerprint: string;
  qualification_status: string; publisher_approved: boolean; scan_signing_approved: boolean; connection_expires_at: string | null };
type Pool = Json & { version: number; mode: "prepared"; status: "UNCONFIGURED" | "CONFIGURED_PREPARED"; limits: Json | null };
type Listing = { nodes: Node[]; pool: Pool; bindings: { id: string; agent_name: string }[]; observed_at: string };
type Preview = { kind: "node" | "pool"; token: string; digest: string; expires: string; view: Json;
  nodeId?: string; baseVersion: number; action?: NodeAction };
type UnknownWrite = { kind: "registration" | "node" | "pool" | "preview"; nodeId?: string; baseVersion?: number; action?: NodeAction };
type RpcName = "clued_ci_nodes_v1" | "clued_ci_node_registration_v1" | "clued_ci_node_confirmation_issue_v1"
  | "clued_ci_node_apply_v1" | "clued_ci_pool_confirmation_issue_v1" | "clued_ci_pool_apply_v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/i;
const object = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown) => typeof value === "string" ? value : "";
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const STATES: Record<string, string> = { pending: "待批准", active: "已登记", draining: "排空中", retired: "已退出", revoked: "已吊销" };
const ACTIONS: Record<NodeAction, string> = { approve: "批准登记", drain: "开始排空", retire: "退出节点", revoke: "吊销节点" };
const METRICS = [
  ["execution_start", "执行次数"], ["evaluation", "未执行评估次数"], ["PR_batch", "单个 PR 的批次"],
  ["head_release", "释放次数"], ["stage8_retry", "发布重试次数"], ["head_distinct_combination_24h", "不同组合数"],
] as const;
const MESSAGES: Record<string, string> = {
  direct_human_session_required: "请用你本人的网页登录会话操作。应用连接不能批准节点或修改额度。",
  native_session_required: "请用你本人的网页登录会话操作。",
  confirmation_token_session_id_required: "登录会话信息不完整，请重新登录。",
  confirmation_token_expired: "确认已过期，请重新读取状态并生成预览。",
  confirmation_token_reused: "确认已经使用过，请重新读取状态。",
  confirmation_token_revoked: "确认已被取代，请重新生成预览。",
  confirmation_token_binding_mismatch: "确认与当前会话不一致，请重新开始。",
  confirmation_view_stale: "记录已在别处更改，请刷新后重新预览。",
  CI_VERSION_CONFLICT: "记录已在别处更改，请刷新后重新预览。",
  CI_STALE_VERSION: "记录已在别处更改，请刷新后重新预览。",
  CI_ACCEPTANCE_REF_REQUIRED: "请填写本次接受记录后重新预览。",
  CI_NATIVE_SESSION_REQUIRED: "当前网页登录会话已失效，请重新登录后读取状态。",
  CI_PROJECT_UNAVAILABLE: "项目当前不可用，或不属于此登录账户。",
  CI_BINDING_UNAVAILABLE: "所选连接已失效或没有所需权限，请刷新状态。",
  CI_NODE_NOT_FOUND: "找不到此节点，请刷新状态。",
  CI_NODE_TRANSITION_INVALID: "节点状态已改变，不能执行这项修改，请刷新状态。",
  CI_NODE_NOT_DRAINED: "节点仍有未结束作业，请完成排空后再退出。",
  CI_REGISTRATION_INVALID: "公开登记资料不符合要求，请核对资料后重新提交。",
  CI_PROFILE_INVALID: "节点公开资料不符合当前格式，请使用节点导出的公开资料。",
  CI_PUBLIC_KEY_INVALID: "公开密钥资料不符合要求，请使用节点导出的公开密钥。",
  CI_IDEMPOTENCY_CONFLICT: "此登记标识已有不同内容，请只读核对已有记录。",
  CI_REPOSITORY_INVALID: "仓库资料不完整，请核对编号和名称。",
  CI_REPOSITORY_POOL_MISMATCH: "此仓库已登记在另一个项目中，不能在本项目重新登记。",
  CI_QUOTA_LIMIT_INVALID: "六项额度须全部填写为 0 到 1000000 的整数，或全部留空。",
  CI_INPUT_INVALID: "提交内容不符合要求，请刷新并重新核对。",
  QUOTA_UNCONFIGURED: "额度尚未配置，当前保持准备状态。",
  SIGNATURE_GATEWAY_NOT_ACTIVATED: "运行资格核验入口尚未启用。节点可以登记，但不能开始运行。",
};
class RequestFailure extends Error { constructor(message: string, readonly uncertain = false) { super(message); } }

async function rpc(name: RpcName, input: Json): Promise<Json> {
  let result: { data: unknown; error: { message?: string; code?: string } | null };
  try { result = await supabase.rpc(name, { p_input: input }); }
  catch { throw new RequestFailure("请求结果尚未确认，请只读核对状态。", true); }
  if (result.error) {
    const code = result.error.message ?? "";
    // A transport/server failure may have happened after commit. Only a known
    // database rejection is definite; never automatically replay a mutation.
    const definite = Boolean(result.error.code && /^[0-9A-Z]{5}$/.test(result.error.code)
      && !/^(08|53|57|58|XX)/.test(result.error.code));
    throw new RequestFailure(MESSAGES[code] ?? (definite ? "请求被拒绝，请刷新后核对。" : "请求结果尚未确认，请只读核对状态。"), !definite);
  }
  if (!object(result.data)) throw new RequestFailure("返回结果无法识别，请只读核对状态。", true);
  if (result.data.status === "rejected" || result.data.status === "failed" || result.data.status === "unknown") {
    const code = str(result.data.error_code);
    throw new RequestFailure(MESSAGES[code] ?? "请求未能确认，请刷新后核对。", result.data.status !== "rejected");
  }
  return result.data;
}

function sessionKey(session: Session | null): string {
  if (!session) return "";
  try {
    const part = session.access_token.split(".")[1];
    const value: unknown = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    if (object(value) && UUID.test(str(value.session_id))) return session.user.id + ":" + str(value.session_id);
  } catch { /* A missing session claim must invalidate, never preserve, a preview. */ }
  return session.user.id + ":" + session.access_token;
}

function sensitiveText(value: string): boolean {
  return /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/i.test(value)
    || /\bBearer\s+[A-Za-z0-9._~+/=-]+/i.test(value)
    || /\b(?:ghp_|gho_|github_pat_)[A-Za-z0-9_]+/i.test(value)
    || /\bpostgres(?:ql)?:\/\/[^\s/:@]+:[^\s/@]+@/i.test(value);
}

function publicDocument(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (Array.isArray(value)) return value.length <= 1000 && value.every(item => publicDocument(item, depth + 1));
  if (typeof value === "string") return !sensitiveText(value);
  if (!object(value)) return value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number";
  return Object.entries(value).every(([key, item]) => !/^(d|p|q|dp|dq|qi|oth|k|private_key|password|secret|access_token|refresh_token|lease_key|confirmation_token)$/i.test(key)
    && publicDocument(item, depth + 1));
}

function validLimits(value: unknown): value is Json {
  return object(value) && Object.keys(value).length === METRICS.length
    && METRICS.every(([key]) => integer(value[key]) && Number(value[key]) <= 1000000);
}

function validPool(value: unknown): value is Pool {
  return object(value) && integer(value.version) && value.mode === "prepared"
    && ((value.status === "UNCONFIGURED" && value.limits === null)
      || (value.status === "CONFIGURED_PREPARED" && validLimits(value.limits)));
}

function uniqueEnum(value: unknown, allowed: readonly string[], min: number, max: number): boolean {
  return Array.isArray(value) && value.length >= min && value.length <= max
    && value.every(item => typeof item === "string" && allowed.includes(item)) && new Set(value).size === value.length;
}

function validProfile(value: unknown): boolean {
  const keys = ["schema", "site_id", "environment_kinds", "slot_count", "memory_limit_mb", "identity_key_origin", "capabilities", "exclusions"];
  const capabilities = ["linux", "windows", "docker", "hyper-v", "windows-sandbox", "scan", "publish", "control", "relay", "f-pr"];
  return object(value) && Object.keys(value).every(key => keys.includes(key))
    && integer(value.slot_count) && value.slot_count >= 1 && value.slot_count <= 64
    && (!("schema" in value) || value.schema === "clued.ci-node-profile/1")
    && (!("site_id" in value) || typeof value.site_id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(value.site_id))
    && (!("environment_kinds" in value) || uniqueEnum(value.environment_kinds,
      ["E1-Linux", "E1-Windows", "E4-Windows-Sandbox", "hardened-Windows"], 1, 4))
    && (!("memory_limit_mb" in value) || integer(value.memory_limit_mb) && value.memory_limit_mb <= 1048576)
    && (!("identity_key_origin" in value) || value.identity_key_origin === "tpm" || value.identity_key_origin === "software")
    && (!("capabilities" in value) || uniqueEnum(value.capabilities, capabilities, 0, 16))
    && (!("exclusions" in value) || uniqueEnum(value.exclusions, capabilities, 0, 16));
}

function parseListing(value: Json): Listing {
  if (value.status !== "ok" || value.mode !== "prepared" || !Array.isArray(value.nodes) || value.nodes.length > 1000
    || !validPool(value.pool) || !Array.isArray(value.bindings) || !publicDocument(value)
    || !Number.isFinite(Date.parse(str(value.observed_at)))) throw new RequestFailure("当前状态尚未完整读取，不能修改。", true);
  const nodes = value.nodes;
  if (!nodes.every(node => object(node) && UUID.test(str(node.node_id)) && typeof node.name === "string"
    && str(node.state) in STATES && integer(node.version) && UUID.test(str(node.binding_id))
    && typeof node.profile_sha256 === "string" && typeof node.identity_fingerprint === "string"
    && typeof node.encryption_fingerprint === "string" && typeof node.qualification_status === "string"
    && typeof node.publisher_approved === "boolean" && typeof node.scan_signing_approved === "boolean"
    && (node.connection_expires_at === null || typeof node.connection_expires_at === "string")
    && node.runtime_eligible !== true)
    || !value.bindings.every(binding => object(binding) && UUID.test(str(binding.id)) && typeof binding.agent_name === "string")) {
    throw new RequestFailure("当前状态尚未完整读取，不能修改。", true);
  }
  return { nodes: nodes as Node[], pool: value.pool as Listing["pool"], bindings: value.bindings as Listing["bindings"], observed_at: str(value.observed_at) };
}

function parsePreview(value: Json, target: Omit<Preview, "token" | "digest" | "expires" | "view">): Preview {
  if (value.status !== "issued" || !str(value.confirmation_token) || str(value.confirmation_token).length > 512
    || !SHA.test(str(value.view_digest)) || !object(value.confirmation_view) || !publicDocument(value.confirmation_view)
    || JSON.stringify(value.confirmation_view).length > 65536 || !Number.isFinite(Date.parse(str(value.expires_at)))
    || Date.parse(str(value.expires_at)) <= Date.now()) throw new RequestFailure("预览尚未确认，请重新读取状态。", true);
  return { ...target, token: str(value.confirmation_token), digest: str(value.view_digest), expires: str(value.expires_at), view: value.confirmation_view };
}

function registrationDocument(source: string, bindings: Listing["bindings"]): Json {
  if (source.length > 65536) throw new RequestFailure("公开登记资料超过大小限制。请使用节点导出的公开资料。");
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new RequestFailure("登记资料格式不完整，请粘贴节点导出的公开资料。"); }
  const keys = ["binding_id", "name", "profile", "profile_sha256", "identity_public_jwk", "encryption_public_jwk",
    "qualification_digest", "qualification_source", "publisher_requested", "scan_signing_requested"];
  if (!object(value) || !publicDocument(value) || Object.keys(value).some(key => !keys.includes(key))
    || !bindings.some(binding => binding.id === value.binding_id) || !str(value.name).trim() || str(value.name).length > 100
    || !validProfile(value.profile) || !SHA.test(str(value.profile_sha256)) || !SHA.test(str(value.qualification_digest))
    || !/^[0-9a-f]{40}$/.test(str(value.qualification_source))
    || typeof value.publisher_requested !== "boolean" || typeof value.scan_signing_requested !== "boolean") {
    throw new RequestFailure("公开登记资料不符合要求。请核对连接、摘要和公开密钥，不能包含密码或私钥。");
  }
  for (const key of ["identity_public_jwk", "encryption_public_jwk"]) {
    const jwk = value[key];
    if (!object(jwk) || Object.keys(jwk).length !== 4 || !Object.keys(jwk).every(item => ["kty", "crv", "x", "y"].includes(item))
      || !Object.values(jwk).every(item => typeof item === "string")
      || jwk.kty !== "EC" || jwk.crv !== "P-256" || !/^[A-Za-z0-9_-]{43}$/.test(str(jwk.x))
      || !/^[A-Za-z0-9_-]{43}$/.test(str(jwk.y))) throw new RequestFailure("请使用节点导出的 P-256 公开密钥资料。");
  }
  return value;
}

function recovered(write: UnknownWrite, listing: Listing): boolean {
  if (write.kind === "preview") return true;
  if (write.kind === "pool") return listing.pool.version > Number(write.baseVersion);
  const node = listing.nodes.find(item => item.node_id === write.nodeId);
  if (write.kind === "registration") return Boolean(node);
  const expected: Record<NodeAction, string> = { approve: "active", drain: "draining", retire: "retired", revoke: "revoked" };
  return Boolean(node && node.version > Number(write.baseVersion) && node.state === expected[write.action!]);
}

function localTime(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "未提供";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short", hour12: false }).format(new Date(value)) + "（北京时间）";
}

export default function CiNodesPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [projectInput, setProjectInput] = useState("");
  const [project, setProject] = useState("");
  const [listing, setListing] = useState<Listing | null>(null);
  const [draft, setDraft] = useState("");
  const [acceptedRef, setAcceptedRef] = useState("");
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [repositoryId, setRepositoryId] = useState("");
  const [repositoryName, setRepositoryName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [unknown, setUnknown] = useState<UnknownWrite | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const current = useRef<Session | null>(null);
  const activeProject = useRef("");
  const epoch = useRef(0);
  const serial = useRef(0);
  const busy = useRef(false);

  useEffect(() => {
    const lifetime = epoch;
    let initialized = false;
    let disposed = false;
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      if (disposed) return;
      if (!initialized) {
        initialized = true;
        const id = new URL(window.location.href).searchParams.get("project_id") ?? "";
        if (UUID.test(id)) { activeProject.current = id.toLowerCase(); setProjectInput(id); setProject(id.toLowerCase()); }
      }
      const changed = sessionKey(current.current) !== sessionKey(next);
      current.current = next; setSession(next); setReady(true);
      if (!changed) return;
      ++epoch.current; ++serial.current; busy.current = false;
      setListing(null); setPreview(null); setUnknown(null); setDraft(""); setAcceptedRef(""); setLimits({});
      setRepositoryId(""); setRepositoryName(""); setWorking(false); setError(""); setNotice("");
    });
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { disposed = true; ++lifetime.current; data.subscription.unsubscribe(); window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (session && UUID.test(project)) void load();
    // A new account or Native session gets a new read, never an old preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey(session), project]);

  async function load() {
    if (!current.current || sessionKey(session) !== sessionKey(current.current) || project !== activeProject.current
      || !UUID.test(project) || busy.current) return;
    const generation = epoch.current, request = ++serial.current;
    const valid = () => epoch.current === generation && serial.current === request;
    busy.current = true; setWorking(true); setError(""); setPreview(null);
    try {
      const next = parseListing(await rpc("clued_ci_nodes_v1", { project_id: project }));
      if (!valid()) return;
      setListing(next);
      const nextLimits: Record<string, string> = {};
      for (const [key] of METRICS) nextLimits[key] = object(next.pool.limits) && integer(next.pool.limits[key]) ? String(next.pool.limits[key]) : "";
      setLimits(nextLimits);
      if (unknown) {
        if (recovered(unknown, next)) { setUnknown(null); setNotice("已读取当前的新记录。请以本页的最新状态和版本为准；后续修改需要新的预览。"); }
        else setNotice("上次请求仍未确认。请稍后继续只读核对，暂不重复提交。");
      }
    } catch (failure) { if (valid()) { setListing(null); setError(failure instanceof Error ? failure.message : "暂时无法读取状态。"); } }
    finally { if (valid()) { busy.current = false; setWorking(false); } }
  }

  async function mutate<T>(operation: () => Promise<T>, target: UnknownWrite, done: (value: T) => void) {
    if (!current.current || sessionKey(session) !== sessionKey(current.current) || project !== activeProject.current
      || busy.current || unknown || !listing) return;
    const generation = epoch.current;
    busy.current = true; setWorking(true); setError(""); setNotice("");
    try { const value = await operation(); if (epoch.current === generation) done(value); }
    catch (failure) {
      if (epoch.current !== generation) return;
      setPreview(null);
      const uncertain = !(failure instanceof RequestFailure) || failure.uncertain;
      if (uncertain) setUnknown(target);
      setError(failure instanceof Error ? failure.message : "请求结果尚未确认，请只读核对状态。");
    } finally { if (epoch.current === generation) { busy.current = false; setWorking(false); } }
  }

  async function register() {
    if (!listing || preview) return;
    let document: Json;
    try { document = registrationDocument(draft, listing.bindings); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "登记资料不完整。"); return; }
    const nodeId = crypto.randomUUID();
    await mutate(async () => {
      const result = await rpc("clued_ci_node_registration_v1", { ...document, project_id: project,
        node_id: nodeId, idempotency_key: crypto.randomUUID() });
      if (result.status !== "committed" || result.node_id !== nodeId || !integer(result.version)) throw new RequestFailure("登记结果尚未确认，请只读核对状态。", true);
      return result;
    }, { kind: "registration", nodeId }, () => { setDraft(""); setNotice("公开资料已登记，正在等待本人批准；尚未取得运行资格。"); setListing(null); });
  }

  async function prepareNode(node: Node, action: NodeAction) {
    if (sensitiveText(acceptedRef)) { setError("接受记录中不能包含密码、令牌或私钥。"); return; }
    if (action === "approve" && !acceptedRef.trim()) { setError("批准登记前，请填写本次接受记录。"); return; }
    await mutate(async () => parsePreview(await rpc("clued_ci_node_confirmation_issue_v1", {
      project_id: project, node_id: node.node_id, base_version: node.version, action,
      ...(acceptedRef.trim() ? { accepted_ref: acceptedRef.trim() } : {}),
    }), { kind: "node", nodeId: node.node_id, baseVersion: node.version, action }), { kind: "preview" }, setPreview);
  }

  async function preparePool() {
    if (!listing) return;
    const entered = METRICS.map(([key]) => limits[key]?.trim() ?? "");
    if (entered.some(Boolean) && !entered.every(Boolean)) {
      setError("六项额度须全部填写，或全部留空表示尚未配置。"); return;
    }
    let next: Json | null = null;
    if (entered.every(Boolean)) {
      next = {};
      for (const [index, [key]] of METRICS.entries()) {
        const value = entered[index];
        if (!/^\d+$/.test(value) || !integer(Number(value)) || Number(value) > 1000000) {
          setError("六项额度须全部填写为 0 到 1000000 的整数，或全部留空。"); return;
        }
        next[key] = Number(value);
      }
    }
    if ([acceptedRef, repositoryId, repositoryName].some(sensitiveText)) { setError("公开登记内容不能包含密码、令牌或私钥。"); return; }
    if ((repositoryId.trim() || repositoryName.trim()) && (!/^\d{1,20}$/.test(repositoryId.trim())
      || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryName.trim()))) { setError("请同时填写仓库编号和 owner/repo 名称。"); return; }
    if ((repositoryId.trim() || next !== null) && !acceptedRef.trim()) {
      setError("修改具体额度或登记仓库前，请填写本次接受记录。"); return;
    }
    await mutate(async () => parsePreview(await rpc("clued_ci_pool_confirmation_issue_v1", {
      project_id: project, base_version: listing.pool.version, limits: next,
      ...(repositoryId.trim() ? { repository: { id: repositoryId.trim(), name: repositoryName.trim() } } : {}),
      ...(acceptedRef.trim() ? { accepted_ref: acceptedRef.trim() } : {}),
    }), { kind: "pool", baseVersion: listing.pool.version }), { kind: "preview" }, setPreview);
  }

  async function confirm() {
    if (!preview || Date.parse(preview.expires) <= Date.now()) { setPreview(null); setError("确认已过期，请重新读取状态并生成预览。"); return; }
    const exact = preview;
    setPreview(null); // This token is never offered for retry, including UNKNOWN.
    await mutate(async () => {
      const result = exact.kind === "node"
        ? await rpc("clued_ci_node_apply_v1", { confirmation_token: exact.token, view_digest: exact.digest })
        : await rpc("clued_ci_pool_apply_v1", { confirmation_token: exact.token, view_digest: exact.digest });
      const version = exact.kind === "node" ? result.version : validPool(result.pool) ? result.pool.version : undefined;
      if (result.status !== "committed" || !integer(version) || version <= exact.baseVersion
        || (exact.kind === "node" ? result.node_id !== exact.nodeId : result.project_id !== project)) {
        throw new RequestFailure("修改结果尚未确认，请只读核对状态。", true);
      }
      return result;
    }, { kind: exact.kind, nodeId: exact.nodeId, baseVersion: exact.baseVersion, action: exact.action }, () => {
      setListing(null); setNotice(exact.kind === "node" ? "修改已保存。登记批准不代表已取得运行资格，请刷新查看最新记录。" : "准备阶段的额度设置已保存，请刷新查看最新记录。");
    });
  }

  function openProject() {
    if (busy.current) return;
    if (!UUID.test(projectInput.trim())) { setError("请填写有效的项目编号。"); return; }
    ++epoch.current; ++serial.current;
    setListing(null); setPreview(null); setUnknown(null); setDraft(""); setAcceptedRef(""); setLimits({});
    setRepositoryId(""); setRepositoryName(""); setError(""); setNotice("");
    const next = projectInput.trim().toLowerCase();
    activeProject.current = next;
    if (next === project) void load(); else setProject(next);
  }

  const blocked = working || unknown !== null || preview !== null || listing === null;
  return <main className="contexts-main owner-confirm ci-nodes">
    <Link href="/">← 首页</Link><h1>执行节点</h1>
    <p className="ci-prepared">准备阶段 · 尚未启用调度</p>
    <p>登记节点、核对公开资料和设置额度。节点被批准登记后，仍需后续的运行资格验收。</p>
    {!ready ? <p role="status">正在确认登录…</p> : !session ? <p><Link href="/account">登录 BeamingFace</Link> 后管理节点。</p> : <>
      <section aria-label="选择项目"><label htmlFor="ci-project">项目编号</label>
        <div className="ci-inline"><input id="ci-project" value={projectInput} disabled={working || unknown !== null}
          onChange={event => setProjectInput(event.target.value)} autoComplete="off" spellCheck={false} />
          <button type="button" disabled={working || unknown !== null} onClick={openProject}>打开项目</button></div>
      </section>
      {project && <><button type="button" disabled={working} onClick={() => void load()}>{unknown ? "只读核对状态" : "刷新状态"}</button>
        {unknown && <p role="status">上次请求结果未知。当前只核对记录，不会自动重试修改。</p>}
        {listing && <>
          <section aria-label="已登记节点"><h2>节点</h2>
            {listing.nodes.length === 0 ? <p>尚未登记节点。</p> : listing.nodes.map(node => <article className="ci-node" key={node.node_id}>
              <h3>{node.name}</h3><p>{STATES[node.state]} · 版本 {node.version}</p>
              <p>尚未取得运行资格</p>
              <dl><dt>节点编号</dt><dd>{node.node_id}</dd><dt>连接</dt><dd>{listing.bindings.find(item => item.id === node.binding_id)?.agent_name ?? node.binding_id}</dd>
                <dt>连接到期</dt><dd>{localTime(node.connection_expires_at)}</dd><dt>资料摘要</dt><dd><code>{node.profile_sha256}</code></dd>
                <dt>身份公钥指纹</dt><dd><code>{node.identity_fingerprint}</code></dd><dt>加密公钥指纹</dt><dd><code>{node.encryption_fingerprint}</code></dd>
                <dt>资格记录</dt><dd>{node.qualification_status}</dd><dt>发布权限登记</dt><dd>{node.publisher_approved ? "已批准登记" : "未批准"}</dd>
                <dt>扫描签名登记</dt><dd>{node.scan_signing_approved ? "已批准登记" : "未批准"}</dd></dl>
              <div className="owner-actions">
                {node.state === "pending" && <button type="button" disabled={blocked} onClick={() => void prepareNode(node, "approve")}>批准登记</button>}
                {node.state === "active" && <button type="button" disabled={blocked} onClick={() => void prepareNode(node, "drain")}>开始排空</button>}
                {node.state === "draining" && <button type="button" disabled={blocked} onClick={() => void prepareNode(node, "retire")}>退出节点</button>}
                {node.state !== "revoked" && <button type="button" disabled={blocked} onClick={() => void prepareNode(node, "revoke")}>吊销节点</button>}
              </div>
            </article>)}
          </section>
          <section aria-label="登记公开资料"><h2>登记新节点</h2><p>粘贴节点导出的公开登记资料。只接受公开密钥，不要填写密码或私钥。</p>
            <label htmlFor="ci-registration">公开登记资料</label><textarea id="ci-registration" value={draft} disabled={blocked}
              onChange={event => setDraft(event.target.value)} rows={7} autoComplete="off" spellCheck={false} />
            <button type="button" disabled={blocked || !draft.trim()} onClick={() => void register()}>提交登记</button>
          </section>
          <section aria-label="准备阶段额度"><h2>准备阶段额度</h2>
            <p>{listing.pool.status === "UNCONFIGURED" ? "尚未配置；新的正式执行会被拒绝。" : "已保存额度，仍保持准备状态。"} · 版本 {listing.pool.version}</p>
            <p>按最近 24 小时统计。六项须全部填写为 0 到 1000000 的整数，或全部留空表示尚未配置。</p><div className="ci-limits">{METRICS.map(([key, label]) => <label key={key} htmlFor={"ci-limit-" + key}>{label}
              <input id={"ci-limit-" + key} type="text" inputMode="numeric" value={limits[key] ?? ""} disabled={blocked}
                onChange={event => setLimits(previous => ({ ...previous, [key]: event.target.value }))} /></label>)}</div>
            <details><summary>登记仓库</summary><p>仓库编号一旦登记到项目，就不能用更换项目的方式重置额度。</p>
              <label htmlFor="ci-repository-id">仓库编号</label><input id="ci-repository-id" value={repositoryId} disabled={blocked} onChange={event => setRepositoryId(event.target.value)} />
              <label htmlFor="ci-repository-name">仓库名称（owner/repo）</label><input id="ci-repository-name" value={repositoryName} disabled={blocked} onChange={event => setRepositoryName(event.target.value)} />
            </details><button type="button" disabled={blocked} onClick={() => void preparePool()}>预览额度修改</button>
          </section>
          <label htmlFor="ci-accepted-ref">本次接受记录（如适用）</label><input id="ci-accepted-ref" value={acceptedRef} disabled={blocked}
            onChange={event => setAcceptedRef(event.target.value)} maxLength={512} />
          <p className="context-muted">状态读取于 {localTime(listing.observed_at)}</p>
        </>}
      </>}
      {preview && <section className="ci-preview" aria-label="确认修改"><h2>确认{preview.kind === "node" ? ACTIONS[preview.action!] : "额度修改"}</h2>
        <p>请核对服务器给出的完整修改内容。仅本次预览有效；登记批准仍不启用运行资格。</p>
        <pre>{JSON.stringify(preview.view, null, 2)}</pre><p>有效期至 {localTime(preview.expires)}</p>
        {Date.parse(preview.expires) <= now && <p role="status">确认已过期，请取消后重新读取状态。</p>}
        <button type="button" disabled={working || Date.parse(preview.expires) <= now} onClick={() => void confirm()}>确认修改</button>
        <button type="button" disabled={working} onClick={() => setPreview(null)}>取消</button>
      </section>}
    </>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </main>;
}
