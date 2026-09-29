import { projectRpcByTool, projectTools } from "./projects";
import { contextRpcByTool, contextTools, contextsEnabled, sanitizeContextResult, type ContextFeatureEnv } from "./contexts";
import { p5RpcByTool, p5TenantWritesEnabled, p5Tools, type P5FeatureEnv } from "./p5";
import {
  decorateP6Response,
  P6_CANARY_BUDGET,
  P6_CANARY_PHASES,
  P6_CONTRACT,
  P6_LATENCY_MEASUREMENT_CONTRACT,
  P6_LATENCY_POLICY,
  P6_RELEASE_PROFILE,
  p6ReleaseControlEnabled,
  versionAttribution,
  type P6FeatureEnv,
} from "./p6";
import {
  currentWorkContract,
  recordRpcByTool,
  recordTools,
  recordsV2Enabled,
  type RecordFeatureEnv,
  type UserRecordRpc,
} from "./records";
import {
  informationFlowListParameters,
  informationFlowRpcByTool,
  informationFlowTools,
  isInformationFlowPath,
  nativeCandidateRpcByAction,
  nativeContextPolicyRpcByPath,
  nativeEvidenceWithdrawalRpcByStep,
  parseCandidateAction,
  parseEvidenceWithdrawal,
  type UserInformationFlowRpc,
} from "./information-flow";
import { measurePack } from "./context-pack";
import { AGENT_CONTRACT_MARKDOWN } from "./generated/agent-contract";
import { createStorageGoogleOAuth, StorageGoogleConnectionError } from "./storage-google-oauth";
import { createStorageGoogleRecoveryOAuth } from "./storage-google-recovery-oauth";
import { createStorageGoogleProbe, storageProbeDiagnostic } from "./storage-google-probe";
import { createStorageGoogleRefresh } from "./storage-google-refresh";
import { createStorageCloudWorker } from "./storage-cloud-executor";
import { createStorageCloudRecovery } from "./storage-cloud-recovery";
import { isStorageAgentTool, storageAgentInput, storageAgentResult, storageAgentTools } from "./storage-agent-tools";
import { createStorageReadAgent, storageReadTool, StorageReadError } from "./storage-read-agent";

declare const __CLUED_BUILD_SHA__: string | null;

const DEFAULT_SUPABASE_URL = "https://ccxsikzwxlolxqlosril.supabase.co";
const DEFAULT_SUPABASE_KEY =
  "sb_publishable_tVKKh7Ok4FhBhHtHyZfwBA_i2RJD2Fg";

const ALL_SCOPES = [
  "context:read",
  "context:write",
  "audit:read",
] as const;

const OAUTH_SCOPES = ["openid", "email", "profile"] as const;

const SUPPORTED_MCP_VERSIONS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
] as const;
const MAX_JSON_BYTES = 1024 * 1024;
const KERNEL_VERSION = "0.4.0";
const RESOURCE_CENTER_AUTHORITY_CONTRACT = "clued.resource-center-authority/1";

type Scope = (typeof ALL_SCOPES)[number];

export interface ContinuityEnv extends RecordFeatureEnv, P5FeatureEnv, P6FeatureEnv, ContextFeatureEnv {
  CLUED_DELEGATED_OAUTH_V12?: string;
  CLUED_OAUTH_ORIGIN?: string;
  CLUED_PROJECTION_BUILDER_TOKEN?: string;
  CLUED_STORAGE_ACCOUNT_V1?: string;
  CLUED_STORAGE_JOBS_V1?: string;
  CLUED_STORAGE_JOBS_V2?: string;
  CLUED_STORAGE_EXECUTOR_V1?: string;
  CLUED_STORAGE_GOOGLE_V1?: string;
  CLUED_STORAGE_REFRESH_V1?: string;
  CLUED_STORAGE_POLICY_TRANSITION_V2?: string;
  CLUED_STORAGE_GOOGLE_CLIENT_ID?: string;
  CLUED_STORAGE_GOOGLE_CLIENT_SECRET?: string;
  CLUED_STORAGE_GOOGLE_REDIRECT_URI?: string;
  CLUED_STORAGE_CONNECTOR_ISSUER?: string;
  CLUED_STORAGE_VAULT_KEYS?: string;
  CLUED_STORAGE_READ_V1?: string;
  CLUED_STORAGE_READ_RECEIPT_KEYS?: string;
  CLUED_STORAGE_READ_CURSOR_KEY?: string;
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  CLUED_ALLOWED_ORIGINS?: string;
  CLUED_STORAGE_JOB_QUEUE?: StorageJobQueue;
}

export interface StorageJobQueue {
  send(body: StorageJobReference): Promise<unknown>;
}

export interface StorageJobReference {
  connection_id: string;
  job_id: string;
}

export interface StorageJobQueueMessage {
  readonly body: unknown;
  ack(): void;
}

export interface ContinuityExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

type JsonRpcId = string | number | null;

interface JsonRpcRequest extends Record<string, unknown> {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

function isJsonRpcRequest(value: Record<string, unknown>): value is JsonRpcRequest {
  return value.jsonrpc === "2.0" && typeof value.method === "string";
}

interface AuthenticatedUser {
  id: string;
  email?: string;
}

interface BindingRecord {
  id: string;
  vendor: string;
  agent_name: string;
  scopes: Scope[];
  context_keys: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(data: unknown, status = 200, extraHeaders?: HeadersInit) {
  const headers = new Headers(jsonHeaders);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function corsHeaders(request: Request) {
  const origin = request.headers.get("origin");
  return {
    "access-control-allow-origin": origin ?? "*",
    "access-control-allow-headers":
      "authorization, content-type, mcp-protocol-version, mcp-session-id",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    vary: "Origin",
  };
}

function bootstrapContract(origin: string, env?: ContinuityEnv) {
  return {
    schema_version: "1.0",
    service: "clued-continuity",
    kernel_version: KERNEL_VERSION,
    canonical_store: "clued-cloud/supabase",
    context_model: "user_id + context_key",
    work_log: "日志.md",
    endpoints: {
      mcp: `${origin}/mcp`,
      http_api: `${origin}/v1/continuity`,
      bootstrap: `${origin}/v1/continuity/bootstrap`,
      agent_instructions: `${origin}/clued-agent.md`,
      binding_portal: `${origin}/`,
      projects: `${origin}/v1/projects`,
      records: `${origin}/v1/records`,
      evidence: `${origin}/v1/evidence`,
      events: `${origin}/v1/events`,
      canonical_export: `${origin}/v1/export`,
    },
    authentication: {
      scheme: "Bearer",
      oauth: {
        enabled: true,
        authorization_server: env?.CLUED_DELEGATED_OAUTH_V12 === "true" ? (env.CLUED_OAUTH_ORIGIN ?? origin) : `${supabaseConfig(env ?? {}).url}/auth/v1`,
        consent_path: `${origin}/oauth/consent`,
        dynamic_client_registration: true,
      },
      binding_token_prefix: "clued_bnd_",
      token_storage: "hash-only",
      binding_policy: "one independent, revocable, least-privilege binding per authorization instance",
      scopes: ALL_SCOPES,
    },
    lifecycle: {
      required: true,
      start: "clued_session_resume",
      reconcile_when_required: "clued_session_reconcile",
      contract: { version: 3, url: `${origin}/clued-agent.md` },
      durable_changes: {
        condition: "authorized_business_change_only",
        capture: "material_outcomes_in_same_turn_before_reporting",
        records: "clued_record_mutate",
        decisions: "clued_decision_supersede",
        extension_events: "clued_event_append",
        legacy_event_adapter: "clued_append_event",
        duplicate_event_after_canonical_mutation: false,
      },
      end: "clued_session_checkpoint",
      checkpoint_condition: "supported_authorized_and_admitted_session",
      session_ttl_seconds: 3600,
      conflict_policy: "optimistic-version-check",
      idempotency: "required for durable writes",
    },
    capabilities: {
      import_log: "clued_import_log",
      read_log: "clued_read_log",
      search_mode: "deterministic-lexical",
      semantic_recall: false,
      continuity_hardening: {
        version: "k-cont-v1",
        checkpoint_coverage: "explicit_context_track_and_event_ids",
        unabsorbed_events: "remain_pending",
        constraints: "active_decision_type_fields_constraint_true",
        conflict_signal: "newer_active_decisions_require_reconciliation",
        resume_response_views: ["structured", "work_log"],
        resume_event_budget_bytes: { default: 65536, maximum: 262144 },
        search_budget_bytes: { default: 65536, maximum: 262144 },
        checkpoint_thresholds: { pending_events: 20, pending_bytes: 32768 },
        session_compliance: "audit_receipts_projection",
        authority_capture_completeness: "unknown_or_incomplete_never_complete",
      },
      project_lifecycle: {
        contract_version: 2,
        recognition: "decision_then_create",
        recognition_metadata: ["confidence", "reason", "source", "source_refs"],
        progress: ["not_started", "active", "paused", "completed", "archived"],
        low_confidence_mentions: "evidence_only_until_recognized",
        stable_project_identity: true,
      },
      project_views_v2: {
        enabled: env ? recordsV2Enabled(env) : false,
        levels: ["global", "project"],
        views: ["state", "task", "decision", "archive", "log"],
        canonical_write_core: true,
        semantic_contract: currentWorkContract,
      },
      p6_release_control: {
        contract: P6_CONTRACT,
        release_profile: P6_RELEASE_PROFILE,
        implementation_scope: "isolated_candidate_code",
        production_enabled: false,
        version_attribution: versionAttribution(env ?? {}),
        affinity_input_header: "Cloudflare-Workers-Version-Key",
        latency_measurement_contract: P6_LATENCY_MEASUREMENT_CONTRACT,
        latency_policy: P6_LATENCY_POLICY,
        canary_phases: P6_CANARY_PHASES,
        canary_budget: P6_CANARY_BUDGET,
      },
    },
    supported_mcp_versions: SUPPORTED_MCP_VERSIONS,
  };
}

function agentInstructions(origin: string) {
  return `${AGENT_CONTRACT_MARKDOWN}
---

Kernel: ${KERNEL_VERSION}
Canonical store: clued-cloud/supabase
MCP endpoint: ${origin}/mcp
HTTP bootstrap: ${origin}/v1/continuity/bootstrap
Binding portal: ${origin}/
`;
}

function supabaseConfig(env: ContinuityEnv) {
  return {
    url: (env.SUPABASE_URL ?? DEFAULT_SUPABASE_URL).replace(/\/$/, ""),
    key: env.SUPABASE_PUBLISHABLE_KEY ?? DEFAULT_SUPABASE_KEY,
  };
}

function bearerToken(request: Request) {
  const value = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1] ?? null;
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function issueBindingToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `clued_bnd_${base64Url(bytes)}`;
}

async function parseBody(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw new HttpError(413, "Request body is too large.");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_JSON_BYTES) throw new HttpError(413, "Request body is too large.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, "Request body must be valid UTF-8.");
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || Array.isArray(value) || typeof value !== "object") {
      throw new HttpError(400, "Request body must be a JSON object.");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

async function parseCanonicalBody(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw new HttpError(413, "Request body is too large.");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_JSON_BYTES) throw new HttpError(413, "Request body is too large.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, "Request body must be valid UTF-8.");
  }
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
  return { input, receivedPayloadHash: await sha256(text) };
}

async function handleResourceCenterAuthority(request: Request, env: ContinuityEnv) {
  validateOrigin(request, env);
  if (request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405, { allow: "POST" });
  }
  const token = bearerToken(request);
  if (!token || !/^clued_rcb_[A-Za-z0-9_-]{32,}$/.test(token)) {
    return json({ error: "Resource Center authority denied." }, 403);
  }
  const body = await parseBody(request);
  const exactRequest = body.request;
  const requestHash = body.request_sha256;
  if (!exactRequest || Array.isArray(exactRequest) || typeof exactRequest !== "object" ||
    typeof requestHash !== "string" || !/^[0-9a-f]{64}$/.test(requestHash) ||
    (exactRequest as Record<string, unknown>).contract !== RESOURCE_CENTER_AUTHORITY_CONTRACT ||
    typeof (exactRequest as Record<string, unknown>).nonce !== "string" ||
    !/^[0-9a-f-]{36}$/.test((exactRequest as Record<string, unknown>).nonce as string) ||
    await sha256(JSON.stringify(exactRequest)) !== requestHash) {
    return json({ error: "Resource Center authority denied." }, 403);
  }
  let resolved: unknown;
  try {
    resolved = await supabaseRequest(env, "/rest/v1/rpc/clued_resource_center_authority_v1", {
      method: "POST",
      body: JSON.stringify({
        p_token_hash: await sha256(token),
        p_request: exactRequest,
      }),
    });
  } catch {
    return json({ error: "Resource Center authority unavailable." }, 503);
  }
  if (!resolved || Array.isArray(resolved) || typeof resolved !== "object" ||
    (resolved as Record<string, unknown>).status !== "resolved" ||
    !(resolved as Record<string, unknown>).authority) {
    return json({ error: "Resource Center authority denied." }, 403);
  }
  return json({
    contract: RESOURCE_CENTER_AUTHORITY_CONTRACT,
    status: "resolved",
    request: exactRequest,
    request_sha256: requestHash,
    authority: (resolved as Record<string, unknown>).authority,
  });
}

async function handleResourceCenterRenewal(request: Request, env: ContinuityEnv) {
  validateOrigin(request, env);
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, { allow: "POST" });
  const token = bearerToken(request);
  if (!token || !/^clued_rcr_[a-f0-9]{64}$/.test(token)) return json({ status: "denied" }, 403);
  const body = await parseBody(request);
  if (body.contract !== "clued.resource-center-renewal/1" ||
    Object.keys(body).some(key => !["contract", "request"].includes(key)) ||
    !body.request || typeof body.request !== "object" || Array.isArray(body.request)) return json({ status: "denied" }, 403);
  try {
    const value = await supabaseRequest(env, "/rest/v1/rpc/clued_resource_center_renew_v1", {
      method: "POST", body: JSON.stringify({ p_token_hash: await sha256(token), p_request: body.request }),
    }) as Record<string, unknown>;
    if (!value || !["active", "rotated", "stopped", "fenced"].includes(String(value.status))) return json({ status: "denied" }, 403);
    // Never echo request: its credential hashes are bearer-equivalent.
    return json(Object.fromEntries(["status", "grant_id", "profile_id", "generation", "expires_at", "receipt_id"]
      .filter(key => value[key] !== undefined).map(key => [key, value[key]])));
  } catch { return json({ status: "unavailable" }, 503); }
}

async function handleResourceCenterWrite(request: Request, env: ContinuityEnv) {
  validateOrigin(request, env);
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, { allow: "POST" });
  const token = bearerToken(request);
  if (!token || !/^clued_rcw_[A-Za-z0-9_-]{32,}$/.test(token)) {
    return json({ error: "Resource Center writer denied." }, 403);
  }
  const body = await parseBody(request);
  if (body.contract !== "clued.resource-center-write/1" ||
    typeof body.nonce !== "string" || !/^[0-9a-f-]{36}$/.test(body.nonce) ||
    !body.request || typeof body.request !== "object" || Array.isArray(body.request) ||
    typeof body.request_sha256 !== "string" ||
    await sha256(JSON.stringify(body.request)) !== body.request_sha256) {
    return json({ error: "Resource Center writer denied." }, 403);
  }
  let outcome: unknown;
  try {
    outcome = await supabaseRequest(env, "/rest/v1/rpc/clued_resource_center_write_v1", {
      method: "POST", body: JSON.stringify({ p_token_hash: await sha256(token), p_request: body.request }),
    });
  } catch {
    return json({ error: "Resource Center writer unavailable." }, 503);
  }
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome) ||
    (outcome as Record<string, unknown>).status === "denied") {
    return json({ error: "Resource Center writer denied." }, 403);
  }
  return json({ contract: body.contract, nonce: body.nonce,
    request: body.request, request_sha256: body.request_sha256, outcome });
}

function sanitizeCluedResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeCluedResult);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (["user_id", "actor_user_id", "binding_id", "actor_binding_id"].includes(key)) continue;
    result[key] = sanitizeCluedResult(child);
  }
  return result;
}

function validateOrigin(request: Request, env: ContinuityEnv) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const allowed = new Set(
    (env.CLUED_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (origin !== new URL(request.url).origin && !allowed.has(origin)) {
    throw new HttpError(403, "Origin is not allowed.");
  }
}

async function supabaseRequest(
  env: ContinuityEnv,
  path: string,
  init: RequestInit & { userToken?: string } = {},
) {
  const { url, key } = supabaseConfig(env);
  const headers = new Headers(init.headers);
  headers.set("apikey", key);
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json");
  headers.set("authorization", `Bearer ${init.userToken ?? key}`);
  const response = await fetch(`${url}${path}`, { ...init, headers });
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      const parsed = JSON.parse(text) as unknown;
      payload = parsed;
    } catch {
      payload = { message: response.statusText || "Clued storage returned a non-JSON response." };
    }
  }
  if (!response.ok) {
    const details = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;
    const message =
      typeof details?.message === "string"
        ? details.message
        : typeof details?.error_description === "string"
          ? details.error_description
          : "Clued storage request failed.";
    // Binding RPCs use the storage anon role after Clued authenticates the
    // connection. PostgREST maps that role's insufficient_privilege to 401;
    // forwarding it makes MCP clients restart OAuth for a resource denial.
    // Preserve actual JWT/authentication errors as 401.
    const status =
      response.status === 401 && details?.code === "42501"
        ? 403
        : response.status >= 500 &&
      details?.code === "P0002" &&
      (message === "project_not_found" || message === "record_not_found")
        ? 404
        : response.status;
    throw new HttpError(
      status,
      message,
      payload,
    );
  }
  return payload;
}

function projectionBuilderToken(env: ContinuityEnv) {
  const token = env.CLUED_PROJECTION_BUILDER_TOKEN?.trim();
  return token?.startsWith("clued_bnd_") ? token : null;
}

async function projectionBuilderRpc(
  env: ContinuityEnv,
  rpc: "clued_mcp_projection_refresh_claim" | "clued_mcp_projection_refresh_apply" |
    "clued_mcp_projection_refresh_heartbeat",
  input: Record<string, unknown>,
) {
  const token = projectionBuilderToken(env);
  if (!token) return { status: "not_configured" } as Record<string, unknown>;
  const result = await supabaseRequest(env, `/rest/v1/rpc/${rpc}`, {
    method: "POST",
    body: JSON.stringify({ p_token_hash: await sha256(token), p_input: input }),
  });
  if (!result || Array.isArray(result) || typeof result !== "object") {
    throw new HttpError(502, "Projection Builder returned an invalid response.");
  }
  return result as Record<string, unknown>;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export async function runProjectionRefreshPipeline(
  env: ContinuityEnv,
  options: { maxCycles?: number; maxTransportRetries?: number } = {},
) {
  if (!projectionBuilderToken(env)) return { status: "not_configured", processed: 0 };
  const maxCycles = Math.max(1, Math.min(options.maxCycles ?? 12, 32));
  const maxTransportRetries = Math.max(0, Math.min(options.maxTransportRetries ?? 2, 5));
  let processed = 0;
  let casConflicts = 0;
  let transportFailures = 0;
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    let claim: Record<string, unknown>;
    try {
      claim = await projectionBuilderRpc(env, "clued_mcp_projection_refresh_claim", {});
    } catch (error) {
      transportFailures += 1;
      if (transportFailures > maxTransportRetries) {
        console.error(JSON.stringify({
          event: "projection_refresh_transport_failure",
          phase: "claim",
          attempts: transportFailures,
          error: error instanceof Error ? error.message : "unknown",
        }));
        return { status: "transport_unavailable", processed, cas_conflicts: casConflicts };
      }
      await delay(100 * (2 ** (transportFailures - 1)));
      continue;
    }
    if (claim.status === "idle" || claim.status === "not_configured") {
      return { status: claim.status, processed, cas_conflicts: casConflicts };
    }
    if (claim.status === "waiting") {
      return { status: "waiting", processed, cas_conflicts: casConflicts,
        next_attempt_at: claim.next_attempt_at };
    }
    if (claim.status === "superseded") continue;
    if (claim.status !== "claimed") {
      return { status: "builder_protocol_error", processed, cas_conflicts: casConflicts };
    }
    let applied: Record<string, unknown>;
    try {
      applied = await projectionBuilderRpc(env, "clued_mcp_projection_refresh_apply", {
        projection_key: claim.projection_key,
        lease_id: claim.lease_id,
        expected_invalidation_revision: claim.expected_invalidation_revision,
        expected_source_vector_digest: claim.expected_source_vector_digest,
      });
    } catch (error) {
      transportFailures += 1;
      if (transportFailures > maxTransportRetries) {
        console.error(JSON.stringify({
          event: "projection_refresh_transport_failure",
          phase: "apply",
          projection_key: claim.projection_key,
          attempts: transportFailures,
          error: error instanceof Error ? error.message : "unknown",
        }));
        return { status: "transport_unavailable", processed, cas_conflicts: casConflicts };
      }
      await delay(100 * (2 ** (transportFailures - 1)));
      continue;
    }
    if (applied.status === "cas_conflict") {
      casConflicts += 1;
      continue;
    }
    if (applied.status === "rebuilt" || applied.status === "reconciled") {
      processed += 1;
      transportFailures = 0;
      continue;
    }
    if (applied.status === "retry_wait") continue;
    if (applied.status === "failed") {
      return { status: "failed", processed, cas_conflicts: casConflicts,
        projection_key: applied.projection_key, error_code: applied.error_code };
    }
    return { status: "builder_protocol_error", processed, cas_conflicts: casConflicts };
  }
  return { status: "cycle_limit", processed, cas_conflicts: casConflicts };
}

export async function runStorageCloudJob(env: ContinuityEnv, reference: {connection_id:string;job_id:string}) {
  if (env.CLUED_STORAGE_ACCOUNT_V1 !== "true" || env.CLUED_STORAGE_JOBS_V1 !== "true" ||
      env.CLUED_STORAGE_GOOGLE_V1 !== "true" || env.CLUED_STORAGE_EXECUTOR_V1 !== "true") return {status:"disabled"};
  try {
    const issuer=env.CLUED_STORAGE_CONNECTOR_ISSUER;
    if (!issuer || issuer.length<32 || !env.CLUED_STORAGE_VAULT_KEYS) return {status:"unavailable"};
    const issuerHash=await sha256(issuer);
    const cloudRpc=env.CLUED_STORAGE_JOBS_V2==="true"
      ? "clued_storage_cloud_worker_router_v2" : "clued_storage_cloud_worker_v1";
    const rpc=async (input:Record<string,unknown>) => await supabaseRequest(env,`/rest/v1/rpc/${cloudRpc}`,{
      method:"POST",body:JSON.stringify({p_issuer_hash:issuerHash,p_input:input}),
      signal:AbortSignal.timeout(10000),redirect:"manual",
    }) as Record<string,unknown>;
    const recoveryRefresh=env.CLUED_STORAGE_REFRESH_V1==="true" ? await createStorageGoogleRefresh({
      client_id:env.CLUED_STORAGE_GOOGLE_CLIENT_ID??"",client_secret:env.CLUED_STORAGE_GOOGLE_CLIENT_SECRET??"",
      vault:JSON.parse(env.CLUED_STORAGE_VAULT_KEYS),rpc:async input => await supabaseRequest(env,"/rest/v1/rpc/clued_storage_refresh_worker_v1",{
        method:"POST",body:JSON.stringify({p_issuer_hash:issuerHash,p_input:input}),signal:AbortSignal.timeout(10000),redirect:"manual",
      }) as Record<string,unknown>}) : null;
    const executor=await createStorageCloudWorker({client_id:env.CLUED_STORAGE_GOOGLE_CLIENT_ID??"",
      vault:JSON.parse(env.CLUED_STORAGE_VAULT_KEYS),rpc,
      account_policy_v2:env.CLUED_STORAGE_JOBS_V2==="true",
      recovery_refresh:recoveryRefresh ? ref=>recoveryRefresh.run(ref.connection_id,ref.job_id) : undefined});
    return await executor.run(reference);
  } catch { return {status:"unavailable"}; }
}

export async function runStorageRefreshScheduled(env: ContinuityEnv) {
  if (env.CLUED_STORAGE_ACCOUNT_V1 !== "true" || env.CLUED_STORAGE_GOOGLE_V1 !== "true" || env.CLUED_STORAGE_REFRESH_V1 !== "true") return { status: "disabled" };
  try {
    const issuer = env.CLUED_STORAGE_CONNECTOR_ISSUER;
    if (!issuer || issuer.length < 32 || !env.CLUED_STORAGE_VAULT_KEYS) return { status: "unavailable" };
    const issuerHash = await sha256(issuer);
    const rpc = async (input: Record<string, unknown>) => await supabaseRequest(env, "/rest/v1/rpc/clued_storage_refresh_worker_v1", {
      method: "POST", body: JSON.stringify({ p_issuer_hash: issuerHash, p_input: input }),
      signal: AbortSignal.timeout(10000), redirect: "manual",
    }) as Record<string, unknown>;
    const due = await rpc({ action: "due" });
    if (!Array.isArray(due.connections) || due.connections.length > 10 || !due.connections.every(c => typeof c === "string")) return { status: "unavailable" };
    const refresher = await createStorageGoogleRefresh({ client_id: env.CLUED_STORAGE_GOOGLE_CLIENT_ID ?? "",
      client_secret: env.CLUED_STORAGE_GOOGLE_CLIENT_SECRET ?? "", vault: JSON.parse(env.CLUED_STORAGE_VAULT_KEYS), rpc });
    let committed = 0, unavailable = Number.isSafeInteger(due.pending_expired) && Number(due.pending_expired)>0 ? Number(due.pending_expired) : 0;
    for (const connection of due.connections) {
      const result = await refresher.run(connection);
      if (result.status === "committed") committed++; else unavailable++;
    }
    return { status: unavailable ? "attention_required" : "ok", committed, unavailable };
  } catch { return { status: "unavailable" }; }
}

// A queue consumer runs the job in its own invocation, so scan, write and
// post-write verify are not bounded by the ~30 s waitUntil extension of the
// submit request. Without the binding, or if enqueueing fails, the job runs
// in place as before; the durable job and its fences are the same either way.
async function dispatchStorageCloudJob(env: ContinuityEnv, reference: StorageJobReference) {
  if (env.CLUED_STORAGE_JOB_QUEUE) {
    try { await env.CLUED_STORAGE_JOB_QUEUE.send({ connection_id: reference.connection_id, job_id: reference.job_id }); return; }
    catch { console.warn(JSON.stringify({ event: "storage_job_enqueue_failed" })); }
  }
  await runStorageCloudJob(env, reference);
}

const STORAGE_JOB_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Each message is acknowledged once, whatever the outcome. A redelivered
// message could only reach an already started job, whose unknown effect is
// settled by scheduled recovery and must never be dispatched again.
export async function runStorageJobQueue(batch: { readonly messages: readonly StorageJobQueueMessage[] }, env: ContinuityEnv) {
  for (const message of batch.messages) {
    const body = message.body as Partial<StorageJobReference> | null;
    try {
      if (body && typeof body === "object" && typeof body.connection_id === "string" && typeof body.job_id === "string" &&
          STORAGE_JOB_UUID.test(body.connection_id) && STORAGE_JOB_UUID.test(body.job_id)) {
        await runStorageCloudJob(env, { connection_id: body.connection_id, job_id: body.job_id });
      } else {
        console.warn(JSON.stringify({ event: "storage_job_queue_message_invalid" }));
      }
    } finally {
      message.ack();
    }
  }
}

export async function runStorageRecoveryScheduled(env: ContinuityEnv) {
  if (env.CLUED_STORAGE_ACCOUNT_V1 !== "true" || env.CLUED_STORAGE_GOOGLE_V1 !== "true" ||
      env.CLUED_STORAGE_JOBS_V2 !== "true" || env.CLUED_STORAGE_EXECUTOR_V1 !== "true") return { status: "disabled" };
  try {
    const issuer = env.CLUED_STORAGE_CONNECTOR_ISSUER;
    if (!issuer || issuer.length < 32 || !env.CLUED_STORAGE_VAULT_KEYS) return { status: "unavailable" };
    const issuerHash = await sha256(issuer);
    const recoveryRpc = async (input: Record<string, unknown>) => await supabaseRequest(env,
      "/rest/v1/rpc/clued_storage_scheduled_recovery_v2", {
        method: "POST", body: JSON.stringify({ p_issuer_hash: issuerHash, p_input: input }),
        signal: AbortSignal.timeout(10000), redirect: "manual",
      }) as Record<string, unknown>;
    const verifiedRpc = async (input: Record<string, unknown>) => await supabaseRequest(env,
      "/rest/v1/rpc/clued_storage_cloud_worker_router_v2", {
        method: "POST", body: JSON.stringify({ p_issuer_hash: issuerHash, p_input: input }),
        signal: AbortSignal.timeout(10000), redirect: "manual",
      }) as Record<string, unknown>;
    const due = await recoveryRpc({ action: "due" });
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (due.status !== "ok" || !Array.isArray(due.jobs) || due.jobs.length > 3 ||
        !due.jobs.every(job => job && typeof job === "object" &&
          Object.keys(job).sort().join(",") === "connection_id,job_id" &&
          typeof job.connection_id === "string" && uuid.test(job.connection_id) &&
          typeof job.job_id === "string" && uuid.test(job.job_id))) return { status: "unavailable" };
    let committed = 0, attention = 0;
    for (const reference of due.jobs as Array<{ connection_id: string; job_id: string }>) {
      try {
        const prior = await verifiedRpc({ ...reference, action: "verified_inspect" });
        if (prior.status === "committed" && prior.connection_id === reference.connection_id &&
            prior.job_id === reference.job_id && prior.execution_permitted === false &&
            typeof prior.receipt_id === "string" && uuid.test(prior.receipt_id)) {
          committed++;
          continue;
        }
        if (prior.status === "verified" && prior.connection_id === reference.connection_id &&
            prior.job_id === reference.job_id && prior.execution_permitted === false &&
            typeof prior.verified_receipt_id === "string" && uuid.test(prior.verified_receipt_id) &&
            typeof prior.verified_digest === "string" && /^[0-9a-f]{64}$/.test(prior.verified_digest)) {
          const settled = await verifiedRpc({ ...reference, action: "settle_verified" });
          if (settled.status !== "committed" || settled.state !== "committed" ||
              settled.connection_id !== reference.connection_id || settled.job_id !== reference.job_id ||
              !settled.final_result || typeof settled.final_result !== "object" ||
              (settled.final_result as Record<string, unknown>).status !== "committed" ||
              settled.execution_permitted !== false || typeof settled.receipt_id !== "string" ||
              !uuid.test(settled.receipt_id)) throw new Error("settlement unavailable");
          committed++;
          continue;
        }
        if (prior.status !== "inspection_required" || prior.connection_id !== reference.connection_id ||
            prior.job_id !== reference.job_id || prior.execution_permitted !== false)
          throw new Error("original journal unavailable");
        const descriptor = await recoveryRpc({ ...reference, action: "load" });
        if (descriptor.status !== "recovery_only" || descriptor.connection_id !== reference.connection_id ||
            descriptor.job_id !== reference.job_id) throw new Error("recovery descriptor unavailable");
        const recovery = await createStorageCloudRecovery({
          client_id: env.CLUED_STORAGE_GOOGLE_CLIENT_ID ?? "", vault: JSON.parse(env.CLUED_STORAGE_VAULT_KEYS),
          rpc: recoveryRpc, verified: { descriptor, rpc: verifiedRpc }, timeout_ms: 10000,
        });
        const result = await recovery.run(reference);
        if (result.status === "committed") committed++; else attention++;
      } catch { attention++; }
    }
    return { status: attention ? "attention_required" : "ok", committed, attention };
  } catch { return { status: "unavailable" }; }
}

export async function runProjectionRefreshScheduled(env: ContinuityEnv) {
  if (!projectionBuilderToken(env)) return runProjectionRefreshPipeline(env);
  const runId = crypto.randomUUID();
  try {
    await projectionBuilderRpc(env, "clued_mcp_projection_refresh_heartbeat", {
      run_id: runId, phase: "start",
    });
  } catch {
    console.error(JSON.stringify({ event: "projection_refresh_heartbeat_failure", phase: "start" }));
  }
  let result = "exception";
  try {
    const outcome = await runProjectionRefreshPipeline(env);
    result = outcome.status;
    return outcome;
  } finally {
    try {
      await projectionBuilderRpc(env, "clued_mcp_projection_refresh_heartbeat", {
        run_id: runId, phase: "finish", result,
      });
    } catch {
      console.error(JSON.stringify({ event: "projection_refresh_heartbeat_failure", phase: "finish" }));
    }
  }
}

function mayInvalidateApprovedProjection(request: Request) {
  if (!["POST", "PATCH", "DELETE"].includes(request.method)) return false;
  const path = new URL(request.url).pathname;
  return path === "/mcp" || path === "/v1/projects" || path.startsWith("/v1/projects/") ||
    path === "/v1/records" || path === "/v1/decisions/supersede" ||
    path === "/v1/events" || path === "/v1/continuity/events" ||
    path === "/v1/continuity/log/import" ||
    path === "/v1/intake" || path.startsWith("/v1/intake/") ||
    path === "/v1/knowledge" || path.startsWith("/v1/knowledge/") ||
    path === "/v1/context/policies" || path.startsWith("/v1/context/policies/") ||
    /^\/v1\/evidence\/[^/]+\/withdrawal(\/|$)/.test(path);
}

function p5GatewayToken(env: ContinuityEnv) {
  const token = env.CLUED_P5_GATEWAY_TOKEN?.trim();
  if (!token) throw new HttpError(503, "Clued P5 gateway is not configured.");
  return token;
}

async function p5GatewayRpc(
  env: ContinuityEnv,
  rpc: string,
  parameters: Record<string, unknown>,
) {
  const result = await supabaseRequest(env, `/rest/v1/rpc/${rpc}`, {
    method: "POST",
    userToken: p5GatewayToken(env),
    body: JSON.stringify(parameters),
  });
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new HttpError(502, "Clued P5 gateway returned an invalid response.");
  }
  return result as Record<string, unknown>;
}

function p5FailureKind(error: unknown) {
  if (error instanceof HttpError) {
    const details = error.details;
    if (details && typeof details === "object" && !Array.isArray(details)
      && (details as Record<string, unknown>).code === "P5_TRANSACTION_COMMIT_FAILED") {
      return "database_commit_failure";
    }
  }
  return "transport_failure";
}

function p5AttemptRaceResult(result: Record<string, unknown>) {
  const error = result.error;
  const errorType = error && typeof error === "object" && !Array.isArray(error)
    ? (error as Record<string, unknown>).type
    : null;
  return [
    "P5_ATTEMPT_ALREADY_CONSUMED",
    "P5_ATTEMPT_COMPLETED",
    "P5_ATTEMPT_FAILED",
  ].includes(typeof errorType === "string" ? errorType : "") || [
    "already_consumed",
    "attempt_completed",
    "attempt_failed",
  ].includes(typeof result.status === "string" ? result.status : "");
}

function p5ResolvedCanonicalResult(resolution: Record<string, unknown>) {
  if (resolution.status !== "completed" && resolution.status !== "failed") return null;
  const result = resolution.canonical_result;
  return result && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, unknown>
    : null;
}

function p5AttemptResolutionFailed(resolution: Record<string, unknown>): never {
  const error = resolution.error;
  throw new HttpError(409, "Clued P5 attempt replay could not be resolved.", {
    status: resolution.status,
    error: error && typeof error === "object" && !Array.isArray(error) ? error : undefined,
  });
}

async function callP5Mutation(
  env: ContinuityEnv,
  tokenHash: string,
  input: Record<string, unknown>,
) {
  const parameters = { p_token_hash: tokenHash, p_input: input };
  const attempt = await p5GatewayRpc(env, "clued_p5_attempt_begin", parameters);
  if (attempt.status === "replayed") return attempt.canonical_result;
  if (attempt.status !== "open" || typeof attempt.attempt_id !== "string") return attempt;
  const attemptId = attempt.attempt_id;
  let mutation: Record<string, unknown>;
  try {
    mutation = await p5GatewayRpc(env, "clued_p5_mutate", {
      ...parameters,
      p_attempt_id: attemptId,
    });
  } catch (error) {
    // A transport error can mean either commit succeeded and its response was
    // lost, or the transaction failed at commit. Resolve the server-created
    // Attempt before recording a failure so a successful commit is never
    // overwritten by compensation.
    const resolution = await p5GatewayRpc(env, "clued_p5_attempt_resolve", {
      ...parameters,
      p_attempt_id: attemptId,
    });
    const canonicalResult = p5ResolvedCanonicalResult(resolution);
    if (canonicalResult) return canonicalResult;
    if (resolution.status !== "open") p5AttemptResolutionFailed(resolution);
    return await p5GatewayRpc(env, "clued_p5_record_commit_failure", {
      ...parameters,
      p_attempt_id: attemptId,
      p_failure_kind: p5FailureKind(error),
    });
  }
  if (!p5AttemptRaceResult(mutation)) return mutation;

  // Older gateways can surface a row-lock replay race as an HTTP-successful
  // rejected payload. Resolve it explicitly; only an exact terminal Attempt
  // may release its stored canonical result. Open, mismatched, expired, or
  // ambiguous resolutions never trigger compensation on this path.
  const resolution = await p5GatewayRpc(env, "clued_p5_attempt_resolve", {
    ...parameters,
    p_attempt_id: attemptId,
  });
  const canonicalResult = p5ResolvedCanonicalResult(resolution);
  if (canonicalResult) return canonicalResult;
  return p5AttemptResolutionFailed(resolution);
}

async function requireSupabaseUser(request: Request, env: ContinuityEnv) {
  const token = bearerToken(request);
  if (!token || token.startsWith("clued_bnd_")) {
    throw new HttpError(401, "A signed-in Clued account is required.");
  }
  const user = (await supabaseRequest(env, "/auth/v1/user", {
    method: "GET",
    userToken: token,
  })) as AuthenticatedUser;
  if (!user?.id) throw new HttpError(401, "The Clued session is invalid.");
  return { user, token };
}

function normalizeScopes(value: unknown): Scope[] {
  if (!Array.isArray(value)) return [...ALL_SCOPES];
  const scopes = value.filter((scope): scope is Scope =>
    ALL_SCOPES.includes(scope as Scope),
  );
  if (!scopes.length) throw new HttpError(400, "Choose at least one valid scope.");
  return [...new Set(scopes)];
}

function normalizeContextKeys(value: unknown) {
  if (!Array.isArray(value)) return ["*"];
  const contextKeys = value
    .filter((key): key is string => typeof key === "string")
    .map((key) => key.trim())
    .filter((key) => key.length > 0 && key.length <= 160)
    .slice(0, 20);
  if (!contextKeys.length) throw new HttpError(400, "Choose at least one context key.");
  return [...new Set(contextKeys)];
}

function safeLabel(value: unknown, fallback: string, maxLength = 80) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : fallback;
}

async function listBindings(request: Request, env: ContinuityEnv) {
  const { token } = await requireSupabaseUser(request, env);
  const rows = (await supabaseRequest(
    env,
    "/rest/v1/clued_agent_bindings?select=id,vendor,agent_name,scopes,context_keys,created_at,last_used_at,revoked_at&order=created_at.desc",
    { method: "GET", userToken: token },
  )) as BindingRecord[];
  return json({ bindings: rows }, 200, corsHeaders(request));
}

async function createBinding(request: Request, env: ContinuityEnv) {
  const { user, token: userToken } = await requireSupabaseUser(request, env);
  const body = await parseBody(request);
  const vendor = safeLabel(body.vendor, "Other", 40);
  const agentName = safeLabel(body.agentName, `${vendor} agent`, 80);
  const scopes = normalizeScopes(body.scopes);
  const contextKeys = normalizeContextKeys(body.contextKeys);
  const token = issueBindingToken();
  const tokenHash = await sha256(token);
  const rows = (await supabaseRequest(env, "/rest/v1/clued_agent_bindings", {
    method: "POST",
    userToken,
    headers: { prefer: "return=representation" },
    body: JSON.stringify({
      user_id: user.id,
      vendor,
      agent_name: agentName,
      scopes,
      context_keys: contextKeys,
      token_hash: tokenHash,
    }),
  })) as BindingRecord[];
  return json(
    {
      binding: rows[0],
      token,
      mcpUrl: `${new URL(request.url).origin}/mcp`,
      apiBaseUrl: `${new URL(request.url).origin}/v1/continuity`,
      policyUrl: `${new URL(request.url).origin}/.well-known/clued-continuity`,
      bootstrapUrl: `${new URL(request.url).origin}/v1/continuity/bootstrap`,
      agentInstructionsUrl: `${new URL(request.url).origin}/clued-agent.md`,
      requiredLifecycle: ["resume", "checkpoint"],
      clientConfig: {
        transport: "streamable-http",
        mcp: {
          url: `${new URL(request.url).origin}/mcp`,
          headers: { authorization: `Bearer ${token}` },
        },
        rest: {
          baseUrl: `${new URL(request.url).origin}/v1/continuity`,
          authorization: `Bearer ${token}`,
        },
      },
      note: "This token is shown once. Store it only in the authorized AI client.",
    },
    201,
    corsHeaders(request),
  );
}

async function revokeBinding(request: Request, env: ContinuityEnv) {
  const { token } = await requireSupabaseUser(request, env);
  const id = new URL(request.url).searchParams.get("id");
  if (!id) throw new HttpError(400, "Binding id is required.");
  await supabaseRequest(
    env,
    `/rest/v1/clued_agent_bindings?id=eq.${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      userToken: token,
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ revoked_at: new Date().toISOString() }),
    },
  );
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

const tools = [
  {
    name: "clued_agent_bootstrap",
    description:
      "Read the public, vendor-neutral Clued Continuity connection and lifecycle contract. This call never returns user context or credentials.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "clued_session_resume",
    description:
      "Call at the start of every authorized session. Restores the latest canonical Clued checkpoint plus subsequent events, provenance, version and the next expected action.",
    inputSchema: {
      type: "object",
      properties: {
        context_key: {
          type: "string",
          description: "Context to resume: \"global\" (default) or \"project:<canonical_project_id>\". A bare project UUID is rejected.",
        },
        client_session_id: {
          type: "string",
          description: "Optional vendor session id for audit correlation; never a user message.",
        },
        response_view: {
          type: "string",
          enum: ["structured", "work_log"],
          default: "structured",
          description: "Choose structured pending events or the rendered work log; the response never duplicates both.",
        },
        event_cursor: { type: "integer", minimum: 0, default: 0 },
        event_limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
        event_budget_bytes: { type: "integer", minimum: 4096, maximum: 262144, default: 65536 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_append_event",
    description:
      "Append a durable continuity event for a decision, correction, action, failure, blocker or retracted conclusion. Use during work whenever authoritative context changes.",
    inputSchema: {
      type: "object",
      required: ["session_token", "base_version", "event_type", "payload"],
      properties: {
        context_key: { type: "string" },
        session_token: {
          type: "string",
          description: "Short-lived token returned by clued_session_resume.",
        },
        event_type: {
          type: "string",
          enum: ["decision", "correction", "action", "failure", "blocker", "retraction", "note"],
        },
        payload: { type: "object" },
        base_version: { type: "integer", minimum: 0 },
        idempotency_key: { type: "string", minLength: 8, maxLength: 160 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_event_carrier_transition",
    description:
      "Atomically supersede, retract, or resolve one authorized active continuity Event carrier using its transition version. Supersede and retract append a separate successor Event in the same transaction; resolve requires a verified continuity-only proof receipt. The original Event remains history and never becomes a Record.",
    inputSchema: {
      type: "object",
      required: ["context_key", "source_event_id", "expected_transition_version", "transition", "idempotency_key"],
      properties: {
        context_key: { type: "string", minLength: 1, maxLength: 160 },
        source_event_id: { type: "integer", minimum: 1 },
        expected_transition_version: { type: "integer", minimum: 1 },
        transition: { type: "string", enum: ["supersede", "retract", "resolve"] },
        idempotency_key: { type: "string", minLength: 8, maxLength: 160 },
        session_token: { type: "string", description: "Required for supersede and retract successor append." },
        base_version: { type: "integer", minimum: 0, description: "Continuity CAS version for successor append." },
        event_type: { type: "string", enum: ["decision", "correction", "action", "failure", "blocker"] },
        payload: { type: "object", description: "Successor Event payload for supersede or retract." },
        proof_receipt_id: { type: "string", format: "uuid", description: "Required for continuity-only resolve." },
      },
      oneOf: [
        { properties: { transition: { const: "supersede" } }, required: ["session_token", "base_version", "event_type", "payload"] },
        { properties: { transition: { const: "retract" } }, required: ["session_token", "base_version", "payload"] },
        { properties: { transition: { const: "resolve" } }, required: ["proof_receipt_id"] },
      ],
      additionalProperties: false,
    },
  },
  {
    name: "clued_session_reconcile",
    description:
      "Compare this authorized session with the server currentness vector and create a typed admission or observation receipt. Only an eligible result updates the session admission state; an observation does not unlock checkpointing.",
    inputSchema: {
      type: "object",
      required: ["session_token"],
      properties: {
        session_token: { type: "string" },
        context_key: { type: "string", minLength: 1, maxLength: 160, default: "global" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_projection_rebuild",
    description:
      "Bind an already written active Global Record to one authorized projection generation. Requires a separate projection builder grant, exact invalidation revision and source vector digest; all checks and fence release occur in the database transaction.",
    inputSchema: {
      type: "object",
      required: ["projection_key", "record_id", "expected_invalidation_revision", "expected_source_vector_digest"],
      properties: {
        projection_key: { type: "string", minLength: 1, maxLength: 160 },
        record_id: { type: "string", format: "uuid" },
        expected_invalidation_revision: { type: "integer", minimum: 0 },
        expected_source_vector_digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_full_global_reconcile",
    description:
      "Resolve the Global unknown-impact aggregate fence only after an authorized complete source scan and all specific projections are current. Requires a separate aggregate builder grant and exact revision/source digest CAS.",
    inputSchema: {
      type: "object",
      required: ["expected_invalidation_revision", "expected_source_vector_digest"],
      properties: {
        expected_invalidation_revision: { type: "integer", minimum: 0 },
        expected_source_vector_digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_currentness_g6_gate",
    description:
      "Read the server G6 currentness gate for one Project. Requires authorized Global and Project reads; returns a generic not_ready result while any required source remains unresolved.",
    inputSchema: {
      type: "object",
      required: ["project_id"],
      properties: { project_id: { type: "string", format: "uuid" } },
      additionalProperties: false,
    },
  },
  {
    name: "clued_mtpe_snapshot",
    description:
      "Read the deterministic Universal Intake candidate universe, system recommendations, Owner-selected focus, executability, and selected Frontier. Requires complete authorized source coverage.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "clued_mtpe_validate",
    description:
      "Validate Universal Intake coverage, priority/executability completeness, and successor bindings without mutating Canonical work.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "clued_mtpe_owner_pin",
    description:
      "Set or cancel the Owner-selected current focus for one eligible Universal Intake Task using explicit user confirmation, exact Task-version CAS, Event, Receipt, and projection invalidation.",
    inputSchema: {
      type: "object",
      required: ["operation", "record_id", "base_version", "idempotency_key", "user_confirmed"],
      properties: {
        operation: { type: "string", enum: ["set", "cancel"] },
        record_id: { type: "string", format: "uuid" },
        base_version: { type: "integer", minimum: 1 },
        idempotency_key: { type: "string", minLength: 8, maxLength: 160 },
        user_confirmed: { type: "boolean", const: true },
        reason: { type: "string", minLength: 1, maxLength: 1000 },
        request_hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_session_checkpoint",
    description:
      "Call before ending or handing off an authorized session. Atomically commits a canonical checkpoint using optimistic concurrency and returns an audit receipt or explicit conflict. A checkpoint covers only events of its own context_key: checkpoint project-scope writes in a session resumed with that project's context_key, and global writes in a global session.",
    inputSchema: {
      type: "object",
      required: ["session_token", "base_version", "snapshot", "summary", "next_action", "coverage"],
      properties: {
        context_key: { type: "string" },
        session_token: {
          type: "string",
          description: "Short-lived token returned by clued_session_resume.",
        },
        base_version: { type: "integer", minimum: 0 },
        snapshot: { type: "object" },
        summary: { type: "string", minLength: 1, maxLength: 4000 },
        next_action: { type: "string", minLength: 1, maxLength: 1000 },
        coverage: {
          type: "object",
          required: ["mode", "contexts", "tracks", "event_ids"],
          properties: {
            mode: { type: "string", const: "explicit" },
            contexts: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 160 } },
            tracks: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 80 } },
            event_ids: { type: "array", uniqueItems: true, items: { type: "integer", minimum: 1 } },
          },
          additionalProperties: false,
        },
        idempotency_key: { type: "string", minLength: 8, maxLength: 160 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_search_context",
    description:
      "Search authorized current context and events with deterministic term matching (whole query first, then at least 60% of its terms, or every term of a one-term query; Chinese is split into two-character terms). Without context_key, or with scope=all, every readable project and Global are searched; a context_key alone searches that scope only, and scope=context without context_key searches the session's own context. No match is not evidence that a record does not exist. Superseded history is excluded unless explicitly requested.",
    inputSchema: {
      type: "object",
      required: ["session_token", "query"],
      properties: {
        session_token: { type: "string" },
        query: { type: "string", minLength: 1, maxLength: 500 },
        context_key: { type: "string" },
        scope: { type: "string", enum: ["all", "context"] },
        include_history: { type: "boolean", default: false },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        cursor: { type: "integer", minimum: 0, default: 0 },
        max_bytes: { type: "integer", minimum: 4096, maximum: 262144, default: 65536 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_read_log",
    description:
      "Read the canonical human-readable 日志.md projection for this authorized context. The projection is generated from the same checkpoints and events used by every vendor.",
    inputSchema: {
      type: "object",
      required: ["session_token"],
      properties: {
        session_token: { type: "string" },
        context_key: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_import_log",
    description:
      "Import an authorized # 日志 Markdown baseline into the canonical context. Resume first and supply the exact current base version plus an idempotency key.",
    inputSchema: {
      type: "object",
      required: ["session_token", "base_version", "markdown", "idempotency_key"],
      properties: {
        session_token: { type: "string" },
        base_version: { type: "integer", minimum: 0 },
        markdown: { type: "string", minLength: 1, maxLength: 1048576 },
        idempotency_key: { type: "string", minLength: 8, maxLength: 140 },
        context_key: { type: "string" },
        source: { type: "string", minLength: 1, maxLength: 80 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_audit_receipts",
    description:
      "Read recent immutable receipts plus a server-derived restore → append → checkpoint compliance view and checkpoint reminders.",
    inputSchema: {
      type: "object",
      properties: {
        context_key: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
      additionalProperties: false,
    },
  },
  ...projectTools,
  ...recordTools,
  ...informationFlowTools,
  ...p5Tools,
  ...contextTools,
] as const;

type PublicToolName = (typeof tools)[number]["name"];

type PublicToolPolicy = {
  scopes: readonly Scope[];
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

const structuredObjectOutputSchema = {
  type: "object",
  description: "Structured Clued result. Tool-specific fields are versioned by the Canonical Store contract.",
  additionalProperties: true,
} as const;

export const publicToolPolicies = {
  clued_context: {
    scopes: ["context:read"], readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
  },
  clued_agent_bootstrap: {
    scopes: [], readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
  },
  clued_session_resume: {
    scopes: ["context:read"], readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_append_event: {
    scopes: ["context:write"], readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_event_carrier_transition: {
    scopes: ["context:write"], readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
  },
  clued_session_reconcile: {
    scopes: ["context:read"], readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
  },
  clued_projection_rebuild: {
    scopes: ["context:write"], readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
  },
  clued_full_global_reconcile: {
    scopes: ["context:write"], readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
  },
  clued_currentness_g6_gate: {
    scopes: ["context:read"], readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_mtpe_snapshot: {
    scopes: ["context:read"], readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_mtpe_validate: {
    scopes: ["context:read"], readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_mtpe_owner_pin: {
    scopes: ["context:write"], readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_session_checkpoint: {
    scopes: ["context:write"], readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
  },
  clued_search_context: {
    scopes: ["context:read"], readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_read_log: {
    scopes: ["context:read"], readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_import_log: {
    scopes: ["context:write"], readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
  },
  clued_audit_receipts: {
    scopes: ["audit:read"], readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_project_mutate: {
    scopes: ["context:write"], readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
  },
  clued_project_list: {
    scopes: ["context:read"], readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_record_list: {
    scopes: ["context:read"], readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_record_mutate: {
    scopes: ["context:write"], readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
  },
  clued_decision_supersede: {
    scopes: ["context:write"], readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
  },
  clued_evidence_ingest: {
    scopes: ["context:write"], readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_event_append: {
    scopes: ["context:write"], readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_canonical_export: {
    scopes: ["context:read", "audit:read"], readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_intake_submit: {
    scopes: ["context:write"], readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_intake_list: {
    scopes: ["context:read"], readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_intake_withdraw: {
    scopes: ["context:write"], readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_knowledge_propose: {
    scopes: ["context:write"], readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_context_pack: {
    scopes: ["context:read"], readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_p5_session_open: {
    scopes: ["context:read"], readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_p5_mutate: {
    scopes: ["context:write"], readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
  },
  clued_p5_workspace_switch: {
    scopes: ["context:write"], readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_p5_pending_intent: {
    scopes: ["context:read"], readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_p5_git_divergence: {
    scopes: ["audit:read"], readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
} as const satisfies Record<PublicToolName, PublicToolPolicy>;

function publishTool<T extends (typeof tools)[number]>(tool: T) {
  const policy = publicToolPolicies[tool.name];
  const scopeStatement = policy.scopes.length
    ? ` Required Clued scope${policy.scopes.length === 1 ? "" : "s"}: ${policy.scopes.join(", ")}.`
    : " Public metadata call; no authenticated Clued scope is required.";
  return {
    ...tool,
    description: `${tool.description}${scopeStatement}`,
    outputSchema: structuredObjectOutputSchema,
    annotations: {
      readOnlyHint: policy.readOnlyHint,
      destructiveHint: policy.destructiveHint,
      idempotentHint: policy.idempotentHint,
      openWorldHint: policy.openWorldHint,
    },
    _meta: {
      "clued/requiredScopes": policy.scopes,
      "clued/scopeEnforcement": "server-side",
    },
  };
}

export function publicMcpTools(env: Pick<ContinuityEnv, "PROJECT_VIEWS_V2" | "P5_TENANT_WRITES" | "CLUED_DEVELOPMENT_CONTEXT_V14" | "CLUED_STORAGE_ACCOUNT_V1" | "CLUED_STORAGE_JOBS_V1" | "CLUED_STORAGE_GOOGLE_V1" | "CLUED_STORAGE_READ_V1">) {
  const existing = tools.filter((tool) =>
    (!(tool.name in recordRpcByTool || tool.name in informationFlowRpcByTool) || recordsV2Enabled(env))
    && (!(tool.name in p5RpcByTool) || p5TenantWritesEnabled(env))
    && (!(tool.name in contextRpcByTool) || contextsEnabled(env))
  ).map(publishTool);
  return [...existing, ...(storageJobsEnabled(env) ? storageAgentTools : []), ...(storageReadEnabled(env) ? [storageReadTool] : [])];
}

// StorageFullCapability.v0.1 P1. Independent of the write/job flags: turning
// reads on or off never changes the write tools, and vice versa.
function storageReadEnabled(env: Pick<ContinuityEnv, "CLUED_STORAGE_ACCOUNT_V1" | "CLUED_STORAGE_GOOGLE_V1" | "CLUED_STORAGE_READ_V1">) {
  return env.CLUED_STORAGE_ACCOUNT_V1 === "true" && env.CLUED_STORAGE_GOOGLE_V1 === "true" && env.CLUED_STORAGE_READ_V1 === "true";
}

async function callStorageRead(request: Request, env: ContinuityEnv, args: unknown) {
  const token = bearerToken(request);
  if (!token || !/^clued_bnd_[A-Za-z0-9_-]{32,}$/.test(token)) throw new StorageReadError("storage_read_unavailable");
  const issuer = env.CLUED_STORAGE_CONNECTOR_ISSUER;
  if (!issuer || issuer.length < 32 || !env.CLUED_STORAGE_VAULT_KEYS || !env.CLUED_STORAGE_READ_RECEIPT_KEYS || !env.CLUED_STORAGE_READ_CURSOR_KEY)
    throw new StorageReadError("storage_read_unavailable");
  const issuerHash = await sha256(issuer);
  let agent: Awaited<ReturnType<typeof createStorageReadAgent>>;
  try {
    agent = await createStorageReadAgent({ client_id: env.CLUED_STORAGE_GOOGLE_CLIENT_ID ?? "", vault: JSON.parse(env.CLUED_STORAGE_VAULT_KEYS),
      receipt_keys: JSON.parse(env.CLUED_STORAGE_READ_RECEIPT_KEYS), cursor_key: env.CLUED_STORAGE_READ_CURSOR_KEY,
      rpc: async ({ token_hash, input }) => await supabaseRequest(env, "/rest/v1/rpc/clued_storage_read_v1", {
        method: "POST", body: JSON.stringify({ p_issuer_hash: issuerHash, p_token_hash: token_hash, p_input: input }),
        signal: AbortSignal.timeout(10000), redirect: "manual",
      }) as Record<string, unknown> });
  } catch (error) {
    if (error instanceof StorageReadError) throw error;
    throw new StorageReadError("storage_read_unavailable");
  }
  return agent.run(await sha256(token), args);
}

function storageJobsEnabled(env: Pick<ContinuityEnv, "CLUED_STORAGE_ACCOUNT_V1" | "CLUED_STORAGE_JOBS_V1">) {
  return env.CLUED_STORAGE_ACCOUNT_V1 === "true" && env.CLUED_STORAGE_JOBS_V1 === "true";
}

async function callStorageJob(request: Request, env: ContinuityEnv, input: Record<string, unknown>, ctx?: ContinuityExecutionContext,
  projectResult: (value: unknown, input: Record<string, unknown>) => unknown = value => value) {
  if (!storageJobsEnabled(env)) throw new HttpError(404, "Storage jobs are disabled.");
  const token = bearerToken(request);
  if (!token || !/^clued_bnd_[A-Za-z0-9_-]{32,}$/.test(token)) throw new HttpError(403, "A valid Clued Binding is required.");
  const jobsRpc=env.CLUED_STORAGE_JOBS_V2==="true"
    ? "clued_storage_jobs_router_v2" : "clued_storage_jobs_v1";
  const result = projectResult(await supabaseRequest(env, `/rest/v1/rpc/${jobsRpc}`, {
    method: "POST", body: JSON.stringify({ p_token_hash: await sha256(token), p_input: input }),
  }), input);
  // Same durable job, root fence and fixed executor for REST and MCP. Inspect
  // never dispatches. A queued reply alone is neither admission nor completion.
  if (ctx && input.action === "submit" && result && typeof result === "object" && "status" in result &&
      ["queued", "started", "uncertain"].includes(String(result.status)) &&
      "connection_id" in result && typeof result.connection_id === "string" && result.connection_id === input.connection_id &&
      "job_id" in result && typeof result.job_id === "string" && result.job_id === input.job_id) {
    ctx.waitUntil(dispatchStorageCloudJob(env, { connection_id: result.connection_id, job_id: result.job_id }));
  }
  return result;
}

const rpcByTool = {
  ...contextRpcByTool,
  clued_session_resume: "clued_mcp_restore",
  clued_append_event: "clued_mcp_append_event",
  clued_event_carrier_transition: "clued_mcp_event_carrier_transition",
  clued_session_reconcile: "clued_mcp_session_reconcile",
  clued_projection_rebuild: "clued_mcp_projection_rebuild",
  clued_full_global_reconcile: "clued_mcp_full_global_reconcile",
  clued_currentness_g6_gate: "clued_mcp_currentness_g6_gate",
  clued_mtpe_snapshot: "clued_mcp_mtpe_snapshot",
  clued_mtpe_validate: "clued_mcp_mtpe_validate",
  clued_mtpe_owner_pin: "clued_mcp_mtpe_owner_pin",
  clued_session_checkpoint: "clued_mcp_commit_checkpoint",
  clued_search_context: "clued_mcp_search_context",
  clued_read_log: "clued_mcp_read_log",
  clued_import_log: "clued_mcp_import_log",
  clued_audit_receipts: "clued_mcp_audit_receipts",
  ...projectRpcByTool,
  ...recordRpcByTool,
  ...informationFlowRpcByTool,
  ...p5RpcByTool,
} as const;


function validateRecordMutationInput(args: unknown) {
  if (!args || Array.isArray(args) || typeof args !== "object") {
    throw new HttpError(422, "Record mutation must be a JSON object.", {
      error_code: "INVALID_RECORD_FIELDS",
      missing_fields: ["operation", "record_type", "mutation", "source_refs", "source_unavailable_reason"],
      invalid_fields: [],
    });
  }
  const input = args as Record<string, unknown>;
  if (input.operation !== "create") return;
  const missing: string[] = [];
  const invalid: Array<{ field: string; error: string }> = [];
  for (const field of ["mutation", "source_refs", "source_unavailable_reason"] as const) {
    if (!(field in input)) missing.push(field);
  }
  if ("source_refs" in input && !Array.isArray(input.source_refs)) {
    invalid.push({ field: "source_refs", error: "must_be_array" });
  }
  const mutation = input.mutation;
  if (mutation !== undefined && (!mutation || Array.isArray(mutation) || typeof mutation !== "object")) {
    invalid.push({ field: "mutation", error: "must_be_object" });
  }
  const mutationObject = mutation && !Array.isArray(mutation) && typeof mutation === "object"
    ? mutation as Record<string, unknown>
    : null;
  const typeFields = mutationObject?.type_fields;
  if (mutationObject && (!typeFields || Array.isArray(typeFields) || typeof typeFields !== "object")) {
    invalid.push({ field: "mutation.type_fields", error: "must_be_object" });
  }
  const fields = typeFields && !Array.isArray(typeFields) && typeof typeFields === "object"
    ? typeFields as Record<string, unknown>
    : null;
  const requiredTypeField: Record<string, { field: string; error: string }> = {
    decision: { field: "rationale", error: "decision_rationale_required" },
    state: { field: "state_kind", error: "state_state_kind_required" },
    task: { field: "execution_bucket", error: "task_execution_bucket_required" },
    profile_fact: { field: "fact_kind", error: "profile_fact_fact_kind_required" },
    note: { field: "note_kind", error: "note_note_kind_required" },
  };
  const required = requiredTypeField[typeof input.record_type === "string" ? input.record_type : ""];
  if (required && fields && !(required.field in fields)) {
    invalid.push({ field: `mutation.type_fields.${required.field}`, error: required.error });
  }
  if (input.authority === "user_explicit" && input.user_confirmed !== true) {
    invalid.push({ field: "user_confirmed", error: "authority_escalation_forbidden" });
  }
  if (missing.length || invalid.length) {
    throw new HttpError(422, "Record mutation has invalid fields.", {
      error_code: "INVALID_RECORD_FIELDS",
      missing_fields: missing,
      invalid_fields: invalid,
      create_contract: {
        required_envelope_fields: ["mutation", "source_refs", "source_unavailable_reason"],
        type_specific_fields: requiredTypeField,
      },
    });
  }
}

function validateRecordListInput(args: unknown) {
  if (!args || Array.isArray(args) || typeof args !== "object") {
    throw new HttpError(422, "Record list input must be a JSON object.");
  }
  const input = args as Record<string, unknown>;
  if ("include_history" in input && typeof input.include_history !== "boolean") {
    throw new HttpError(422, "include_history must be a boolean.");
  }
  // Keep the server's default-current view when an older client omits the flag.
  // History is available only through the explicit, shared DB-core argument.
  for (const key of ["mode", "history", "diagnostic"]) {
    if (key in input) throw new HttpError(422, "Use include_history for record history.");
  }
}

function validateEventCarrierTransitionInput(args: unknown) {
  if (!args || Array.isArray(args) || typeof args !== "object") {
    throw new HttpError(422, "Event carrier transition input must be a JSON object.");
  }
  const input = args as Record<string, unknown>;
  const allowed = new Set([
    "context_key", "source_event_id", "expected_transition_version", "transition",
    "idempotency_key", "session_token", "base_version", "event_type", "payload", "proof_receipt_id",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key)) ||
    typeof input.context_key !== "string" || !input.context_key.trim() || input.context_key.length > 160 ||
    !Number.isSafeInteger(input.source_event_id) || (input.source_event_id as number) < 1 ||
    !Number.isSafeInteger(input.expected_transition_version) || (input.expected_transition_version as number) < 1 ||
    typeof input.idempotency_key !== "string" || input.idempotency_key.length < 8 || input.idempotency_key.length > 160) {
    throw new HttpError(422, "Invalid event carrier transition input.");
  }
  if (input.transition === "resolve") {
    if (typeof input.proof_receipt_id !== "string" ||
      ["session_token", "base_version", "event_type", "payload"].some((key) => key in input)) {
      throw new HttpError(422, "Resolve requires only a verified proof receipt.");
    }
    return;
  }
  if (input.transition !== "supersede" && input.transition !== "retract") {
    throw new HttpError(422, "Invalid event carrier transition.");
  }
  if (typeof input.session_token !== "string" ||
    !Number.isSafeInteger(input.base_version) || (input.base_version as number) < 0 ||
    !input.payload || Array.isArray(input.payload) || typeof input.payload !== "object" ||
    "proof_receipt_id" in input) {
    throw new HttpError(422, "A successor Event requires session, version, and payload.");
  }
  if (input.transition === "supersede" &&
    !["decision", "correction", "action", "failure", "blocker"].includes(String(input.event_type))) {
    throw new HttpError(422, "Invalid successor Event type.");
  }
  if (input.transition === "retract" && "event_type" in input) {
    throw new HttpError(422, "Retraction Event type is set by the server.");
  }
}

async function callRpc(
  request: Request,
  env: ContinuityEnv,
  name: keyof typeof rpcByTool,
  args: unknown,
) {
  const token = bearerToken(request);
  if (!token) {
    throw new HttpError(401, "Authorize with Clued OAuth or a Clued Binding Token.");
  }
  const payload = typeof args === "object" && args ? args : {};
  if (name === "clued_record_list") validateRecordListInput(payload);
  if (name === "clued_event_carrier_transition") validateEventCarrierTransitionInput(payload);
  if (name === "clued_record_mutate") validateRecordMutationInput(payload);

  if (name in contextRpcByTool) {
    if (!contextsEnabled(env)) throw new HttpError(404, "Development context is disabled.");
    if (!token.startsWith("clued_bnd_")) throw new HttpError(403, "Use an explicitly consented Clued connection for development operations.");
    const contextInput = { mode: "ordinary", ...payload };
    return await supabaseRequest(env, "/rest/v1/rpc/clued_development_call_v14", {
      method: "POST",
      body: JSON.stringify({ p_token_hash: await sha256(token), p_input: contextInput }),
    });
  }

  if (name in p5RpcByTool) {
    if (!p5TenantWritesEnabled(env)) {
      throw new HttpError(404, "Clued P5 tenant writes are disabled.");
    }
    if (!token.startsWith("clued_bnd_")) {
      throw new HttpError(403, "P5 tenant operations require an independent revocable Agent Binding.");
    }
    const tokenHash = await sha256(token);
    if (name === "clued_p5_mutate") {
      return await callP5Mutation(env, tokenHash, payload as Record<string, unknown>);
    }
    return await p5GatewayRpc(env, rpcByTool[name], {
      p_token_hash: tokenHash,
      p_input: payload,
    });
  }

  // Bind G6 to the Worker serving this request. A later deploy or rollback
  // cannot reuse a previous commit's production transport attestation.
  const transportPayload = name === "clued_currentness_g6_gate"
    ? {
        ...(!Array.isArray(payload) ? payload : {}),
        __transport_source_commit: typeof __CLUED_BUILD_SHA__ === "string" &&
          /^[0-9a-f]{40}$/.test(__CLUED_BUILD_SHA__) ? __CLUED_BUILD_SHA__ : null,
      }
    : payload;

  if (!token.startsWith("clued_bnd_")) {
    return await supabaseRequest(env, "/rest/v1/rpc/clued_oauth_call", {
      method: "POST",
      userToken: token,
      body: JSON.stringify({ p_tool: name, p_input: transportPayload }),
    });
  }

  const tokenHash = await sha256(token);
  return await supabaseRequest(env, `/rest/v1/rpc/${rpcByTool[name]}`, {
    method: "POST",
    body: JSON.stringify({ p_token_hash: tokenHash, p_input: transportPayload }),
  });
}

// Storage raises insufficient_privilege (42501) both for authorization denials
// and for requests whose shape or state breaks a contract rule. Hosts render an
// HTTP 403 as "blocked" or "reconnect", which never helps with the latter, so
// the listed rule rejections become tool errors that name the rule. Anything
// not listed, including every authorization denial, keeps the HTTP 403.
const REQUEST_RULE_REJECTIONS: Readonly<Record<string, string | null>> = {
  lifecycle_action_cannot_edit_record_content:
    "close and restore may only carry mutation.closure_summary and mutation.closed_reason; omit source_refs, source_unavailable_reason, observed_at, confidence and other content fields.",
  resume_required: "Call clued_session_resume and retry with the returned session_token.",
  resume_required_or_session_expired: "Call clued_session_resume and retry with the returned session_token.",
  session_not_found: "Call clued_session_resume and retry with the returned session_token.",
  requested_context_not_authorized:
    "context_key must be \"global\" or \"project:<canonical_project_id>\", not a bare project ID. Retry with the prefixed key.",
  checkpoint_event_not_authorized:
    "coverage.event_ids may list only events of this checkpoint's context_key. Checkpoint each context separately: resume with that context's context_key (for example project:<id> for project-scope writes), reconcile, then checkpoint with the same context_key and its own event ids.",
  authority_escalation_forbidden: null,
  authorized_exact_annotation_source_required: null,
  carrier_transition_receipt_invalid: null,
  continuity_only_proof_required: null,
  cross_project_next_task: null,
  cross_project_state: null,
  currentness_subject_required: null,
  delegated_whole_account_export_not_supported: null,
  development_owner_operation_not_supported: null,
  feedback_submitter_required: null,
  materialization_receipt_required: null,
  membership_expansion_requires_new_invitation: null,
  project_lifecycle_v2_confirmation_receipt_invalid: null,
  project_not_active: null,
  project_not_confirmed: null,
  project_scope_mismatch: null,
  terminal_receipt_not_verified: null,
  terminal_restore_requires_explicit_authorization: null,
};

function requestRuleRejection(error: unknown) {
  if (!(error instanceof HttpError) || error.status !== 403) return null;
  const details = error.details as Record<string, unknown> | null | undefined;
  if (details?.code !== "42501") return null;
  if (!Object.prototype.hasOwnProperty.call(REQUEST_RULE_REJECTIONS, error.message)) return null;
  const hint = REQUEST_RULE_REJECTIONS[error.message];
  return {
    status: "rejected",
    error: {
      code: error.message,
      category: "request_rule",
      message: "The request was refused by a Clued contract rule; reconnecting will not change the outcome.",
      ...(hint ? { hint } : {}),
    },
  };
}

async function callTool(
  request: Request,
  env: ContinuityEnv,
  name: unknown,
  args: unknown,
  ctx?: ContinuityExecutionContext,
) {
  if (name === storageReadTool.name) {
    if (!storageReadEnabled(env)) throw new HttpError(404, "Storage reads are disabled.");
    try {
      const result = await callStorageRead(request, env, args);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false };
    } catch (error) {
      // Fixed codes only: no provider text, IDs, paths, credentials or database details.
      const code = error instanceof StorageReadError ? error.code : "storage_read_unavailable";
      const result = { error: code, message: code === "not_found_in_scope"
        ? "Not found inside the authorized root. This is not proof that it does not exist."
        : code === "cursor_invalid" ? "The cursor is invalid or expired. Start the listing or search again."
        : code === "storage_read_input_invalid" ? "Invalid input for clued_storage_browse." : "Storage read unavailable." };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: true };
    }
  }
  if (isStorageAgentTool(name)) {
    if (!storageJobsEnabled(env)) throw new HttpError(404, "Storage jobs are disabled.");
    try {
      const input = storageAgentInput(name, args);
      const result = await callStorageJob(request, env, input, ctx, storageAgentResult);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false };
    } catch {
      // No provider, issuer, credentials, paths or database diagnostics in errors.
      const result = { error: "storage_job_unavailable", message: "Storage job unavailable. Check the same job ID; do not create another job to retry an unknown effect." };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: true };
    }
  }
  if (name === "clued_agent_bootstrap") {
    const result = bootstrapContract(new URL(request.url).origin, env);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
      isError: false,
    };
  }
  if (typeof name === "string" && (name in recordRpcByTool || name in informationFlowRpcByTool) &&
    !recordsV2Enabled(env)) {
    throw new HttpError(404, "Clued project views v2 are disabled.");
  }
  if (typeof name === "string" && name in p5RpcByTool && !p5TenantWritesEnabled(env)) {
    throw new HttpError(404, "Clued P5 tenant writes are disabled.");
  }
  if (typeof name !== "string" || !(name in rpcByTool)) {
    throw new HttpError(404, "Unknown Clued continuity tool.");
  }
  let rawResult: unknown;
  try {
    rawResult = await callRpc(request, env, name as keyof typeof rpcByTool, args);
  } catch (error) {
    const rejection = requestRuleRejection(error);
    if (!rejection) throw error;
    return { content: [{ type: "text", text: JSON.stringify(rejection) }],
      structuredContent: rejection, isError: true };
  }
  // MSCP packs (S4): the Worker counts the exact pack_text and enforces the
  // policy budget before the result is sanitized. Covers Binding and
  // delegated OAuth callers alike.
  // A refusal by the measurement step (tokenizer unavailable, integrity or
  // budget) is an MCP tool error.
  let measurementRefused = false;
  if (name === "clued_context_pack") {
    const measured = await measurePack(rawResult);
    rawResult = measured.result;
    measurementRefused = measured.httpStatus !== undefined;
  }
  const sanitized = name in contextRpcByTool ? sanitizeContextResult(rawResult) : sanitizeCluedResult(rawResult);
  const sourceCommit = typeof __CLUED_BUILD_SHA__ === "string" &&
    /^[0-9a-f]{40}$/.test(__CLUED_BUILD_SHA__) ? __CLUED_BUILD_SHA__ : null;
  const gated = name === "clued_currentness_g6_gate" &&
    (sanitized as Record<string, unknown> | null)?.status === "transport_precheck_ready"
    ? sourceCommit
      ? { ...(sanitized as Record<string, unknown>), status: "closed" }
      : { status: "not_ready", gate: "G6_CURRENTNESS",
          missing_requirements: ["all_path_checkpoint_enforcement"] }
    : sanitized;
  const result = withAuthorityCapture(name, gated);
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
    isError: measurementRefused || Boolean((result as Record<string, unknown> | null)?.error),
  };
}

// BUG-20260924-001 L1: Currentness only covers writes that reached Clued. The
// server never sees Host conversations, so it cannot claim that every
// authoritative decision was captured; say so next to the currentness result.
const authorityCaptureUnknown = {
  state: "unknown",
  basis: "server_observes_only_writes_that_reached_clued",
  independent_of: "currentness",
} as const;

function withAuthorityCapture(name: string, value: unknown): unknown {
  if (name !== "clued_session_resume" && name !== "clued_session_reconcile") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (record.error || "authority_capture_completeness" in record) return value;
  return { ...record, authority_capture_completeness: authorityCaptureUnknown };
}

function rpcResult(id: JsonRpcId | undefined, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: JsonRpcId | undefined, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}

async function handleMcp(request: Request, env: ContinuityEnv, ctx?: ContinuityExecutionContext) {
  validateOrigin(request, env);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method !== "POST") {
    return json(
      { error: "Use MCP Streamable HTTP POST requests at this endpoint." },
      405,
      { ...corsHeaders(request), allow: "POST, OPTIONS" },
    );
  }

  let rpc: JsonRpcRequest;
  try {
    const parsed = await parseBody(request);
    if (!isJsonRpcRequest(parsed)) {
      return json(rpcError(null, -32600, "Invalid Request"), 400, corsHeaders(request));
    }
    rpc = parsed;
  } catch (error) {
    const problem = error instanceof HttpError ? error : new HttpError(400, "Parse error");
    return json(rpcError(null, -32700, problem.message), problem.status, corsHeaders(request));
  }

  try {
    // Challenge during MCP connection setup, before Inspector can issue a
    // protected tools/call.  The bearer is validated by the protected tool
    // dispatcher; this gate only moves OAuth discovery/PKCE ahead of the
    // business-call budget.
    if (rpc.method === "initialize" && !bearerToken(request)) {
      throw new HttpError(401, "Authorize with Clued OAuth or a Clued Binding Token.");
    }
    if (rpc.method === "initialize") {
      const requestedVersion = rpc.params?.protocolVersion;
      const protocolVersion =
        typeof requestedVersion === "string" &&
        SUPPORTED_MCP_VERSIONS.includes(requestedVersion as (typeof SUPPORTED_MCP_VERSIONS)[number])
          ? requestedVersion
          : SUPPORTED_MCP_VERSIONS[0];
      return json(
        rpcResult(rpc.id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "Clued Continuity", version: KERNEL_VERSION },
          instructions:
            `Follow the Clued Agent Contract at ${new URL(request.url).origin}/clued-agent.md. Resume first. Read Global priority, then Project State/Task/Decision, and use Log/Archive only as evidence. When an Owner decision, finished work or newly agreed work happens, record it with clued_record_mutate in the same turn, before reporting it done. Preserve canonical IDs; write through M1 mutation contracts and never dual-write Markdown. Checkpoint before ending.`,
        }),
        200,
        corsHeaders(request),
      );
    }
    if (rpc.method === "notifications/initialized") {
      return new Response(null, { status: 202, headers: corsHeaders(request) });
    }
    if (rpc.method === "ping") {
      return json(rpcResult(rpc.id, {}), 200, corsHeaders(request));
    }
    if (rpc.method === "tools/list") {
      return json(rpcResult(rpc.id, { tools: publicMcpTools(env) }), 200, corsHeaders(request));
    }
    if (rpc.method === "tools/call") {
      const name = rpc.params?.name;
      const args = rpc.params?.arguments;
      const result = await callTool(request, env, name, args, ctx);
      return json(rpcResult(rpc.id, result), 200, {
        ...corsHeaders(request), ...(isStorageAgentTool(name) || name === storageReadTool.name ? { "cache-control": "no-store" } : {}),
      });
    }
    return json(rpcError(rpc.id, -32601, "Method not found"), 404, corsHeaders(request));
  } catch (error) {
    const problem = error instanceof HttpError ? error : new HttpError(500, "Clued continuity failed.");
    const headers = corsHeaders(request);
    if (problem.status === 401) {
      Object.assign(headers, {
        "www-authenticate": `Bearer realm="Clued", resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", request.url)}"`,
      });
    }
    return json(
      rpcError(rpc.id, problem.status === 401 ? -32001 : -32000, problem.message, problem.details),
      problem.status,
      headers,
    );
  }
}

const restToolByPath = {
  "/v1/continuity/resume": "clued_session_resume",
  "/v1/continuity/events": "clued_append_event",
  "/v1/continuity/checkpoint": "clued_session_checkpoint",
  "/v1/continuity/search": "clued_search_context",
  "/v1/continuity/log": "clued_read_log",
  "/v1/continuity/log/import": "clued_import_log",
  "/v1/continuity/audit": "clued_audit_receipts",
} as const;

async function handleRestContinuity(request: Request, env: ContinuityEnv) {
  validateOrigin(request, env);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405, {
      ...corsHeaders(request),
      allow: "POST, OPTIONS",
    });
  }
  const path = new URL(request.url).pathname as keyof typeof restToolByPath;
  const tool = restToolByPath[path];
  const input = await parseBody(request);
  const result = withAuthorityCapture(tool, await callRpc(request, env, tool, input));
  return json(result, 200, corsHeaders(request));
}

async function callUserProjectRpc(
  request: Request,
  env: ContinuityEnv,
  rpc: "clued_user_project_list_v2" | "clued_user_project_mutate_v2",
  input: Record<string, unknown>,
  receivedPayloadHash?: string,
) {
  const { token } = await requireSupabaseUser(request, env);
  return await supabaseRequest(env, `/rest/v1/rpc/${rpc}`, {
    method: "POST",
    userToken: token,
    body: JSON.stringify(receivedPayloadHash
      ? { p_input: input, p_received_payload_hash: receivedPayloadHash }
      : { p_input: input }),
  });
}

async function handleProjectApi(request: Request, env: ContinuityEnv) {
  validateOrigin(request, env);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  const url = new URL(request.url);
  if (url.pathname === "/v1/projects" && request.method === "GET") {
    if (url.searchParams.has("certainty_status")) {
      return json({ error: "legacy_project_certainty_forbidden" }, 400, corsHeaders(request));
    }
    const input: Record<string, unknown> = {};
    for (const key of ["progress_status", "query", "limit"] as const) {
      const value = url.searchParams.get(key);
      if (value !== null) input[key] = key === "limit" ? Number(value) : value;
    }
    if (url.searchParams.get("include_dismissed") === "true") input.include_dismissed = true;
    return json(await callUserProjectRpc(request, env, "clued_user_project_list_v2", input), 200, corsHeaders(request));
  }
  if (url.pathname === "/v1/projects" && request.method === "POST") {
    const { input, receivedPayloadHash } = await parseCanonicalBody(request);
    return json(
      await callUserProjectRpc(request, env, "clued_user_project_mutate_v2", input, receivedPayloadHash),
      200,
      corsHeaders(request),
    );
  }
  const match = /^\/v1\/projects\/([0-9a-f-]{36})$/i.exec(url.pathname);
  if (match && request.method === "PATCH") {
    const { input, receivedPayloadHash } = await parseCanonicalBody(request);
    return json(
      await callUserProjectRpc(request, env, "clued_user_project_mutate_v2", {
        ...input,
        canonical_project_id: match[1],
      }, receivedPayloadHash),
      200,
      corsHeaders(request),
    );
  }
  return json({ error: "Method not allowed." }, 405, {
    ...corsHeaders(request),
    allow: "GET, POST, PATCH, OPTIONS",
  });
}

async function callUserRecordRpc(
  request: Request,
  env: ContinuityEnv,
  rpc: UserRecordRpc | UserInformationFlowRpc,
  input: Record<string, unknown>,
  receivedPayloadHash?: string,
) {
  const { token } = await requireSupabaseUser(request, env);
  return await callVerifiedUserRpc(env, token, rpc, input, receivedPayloadHash);
}

// For callers that already verified the account session with
// requireSupabaseUser, so /auth/v1/user is not called twice.
async function callVerifiedUserRpc(
  env: ContinuityEnv,
  token: string,
  rpc: UserRecordRpc | UserInformationFlowRpc,
  input: Record<string, unknown>,
  receivedPayloadHash?: string,
) {
  return await supabaseRequest(env, `/rest/v1/rpc/${rpc}`, {
    method: "POST",
    userToken: token,
    body: JSON.stringify(receivedPayloadHash
      ? { p_input: input, p_received_payload_hash: receivedPayloadHash }
      : { p_input: input }),
  });
}

function m1HttpStatus(result: unknown) {
  const value = result as { status?: string; error_code?: string } | null;
  if (value?.status === "failed") return 500;
  if (value?.status !== "rejected") return 200;
  return /CONFLICT|VERSION|NOW_CONFLICT/.test(value.error_code ?? "") ? 409 : 422;
}

async function handleRecordApi(request: Request, env: ContinuityEnv) {
  validateOrigin(request, env);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  const url = new URL(request.url);
  if (url.pathname === "/v1/records/config" && request.method === "GET") {
    return json(
      { enabled: recordsV2Enabled(env), semantic_contract: currentWorkContract },
      200,
      corsHeaders(request),
    );
  }
  if (!recordsV2Enabled(env)) {
    throw new HttpError(404, "Clued project views v2 are disabled.");
  }
  if (url.pathname === "/v1/records" && request.method === "GET") {
    const input: Record<string, unknown> = {};
    const allowedParameters = new Set(["level", "project_id", "record_type", "limit", "include_history"]);
    for (const key of url.searchParams.keys()) {
      if (!allowedParameters.has(key) || url.searchParams.getAll(key).length !== 1) {
        throw new HttpError(422, "Invalid record list query parameters.");
      }
    }
    for (const key of ["level", "project_id", "record_type", "limit"] as const) {
      const value = url.searchParams.get(key);
      if (value !== null) input[key] = key === "limit" ? Number(value) : value;
    }
    const includeHistory = url.searchParams.get("include_history");
    if (includeHistory !== null) {
      if (includeHistory !== "true" && includeHistory !== "false") {
        throw new HttpError(422, "include_history must be true or false.");
      }
      input.include_history = includeHistory === "true";
    }
    validateRecordListInput(input);
    return json(
      await callUserRecordRpc(request, env, "clued_user_record_list", input),
      200,
      corsHeaders(request),
    );
  }
  if (url.pathname === "/v1/records" && request.method === "POST") {
    const { input, receivedPayloadHash } = await parseCanonicalBody(request);
    const result = await callUserRecordRpc(request, env, "clued_user_record_mutate", input, receivedPayloadHash);
    return json(result, m1HttpStatus(result), corsHeaders(request));
  }
  const mutationRoutes: Record<string, UserRecordRpc> = {
    "/v1/decisions/supersede": "clued_user_decision_supersede",
    "/v1/evidence": "clued_user_evidence_ingest",
    "/v1/events": "clued_user_event_append",
    "/v1/export": "clued_user_canonical_export_v2",
  };
  const rpc = mutationRoutes[url.pathname];
  if (rpc && request.method === "POST") {
    const { input, receivedPayloadHash } = await parseCanonicalBody(request);
    const result = await callUserRecordRpc(request, env, rpc, input, receivedPayloadHash);
    return json(result, m1HttpStatus(result), corsHeaders(request));
  }
  return json({ error: "Method not allowed." }, 405, {
    ...corsHeaders(request),
    allow: "GET, POST, OPTIONS",
  });
}

// Candidate CAS failures are raised with lower-case codes; everything else
// follows the M1 mapping. A stale session is a step-up challenge (RFC 9470);
// a token failure is a denial; a committed conflict or expiry transition is
// still a conflict for the caller.
function informationFlowHttpStatus(result: unknown) {
  const value = result as {
    status?: string; error_code?: string; supplemental?: { outcome?: string };
  } | null;
  if (value?.status === "issued") return 200;
  if (value?.status === "committed" &&
    (value.supplemental?.outcome === "conflict" || value.supplemental?.outcome === "expired")) return 409;
  if (value?.status === "rejected") {
    const code = value.error_code ?? "";
    if (code === "reauthentication_required") return 401;
    if (/^confirmation_token_/.test(code)) return 403;
    if (/^(candidate_version_conflict|knowledge_source_version_mismatch|confirmation_view_stale|candidate_not_pending|candidate_previously_rejected|candidate_expired|context_policy_version_conflict|evidence_withdrawal_version_conflict|evidence_already_withdrawn|knowledge_evidence_withdrawn|knowledge_source_evidence_withdrawn)$/
      .test(code)) return 409;
    if (code === "TOKENIZER_UNAVAILABLE") return 503;
    if (code === "CONTEXT_PACK_INTEGRITY") return 502;
  }
  // A manifest that failed revalidation (STALE or PROJECTION_REQUIRED).
  if (value?.status === "stale") return 409;
  return m1HttpStatus(result);
}

function informationFlowHeaders(request: Request, result: unknown, extra: Record<string, string> = {}) {
  const value = result as { status?: string; error_code?: string } | null;
  const headers: Record<string, string> = { ...corsHeaders(request), ...extra };
  if (value?.status === "rejected" && value.error_code === "reauthentication_required") {
    headers["www-authenticate"] =
      'Bearer error="insufficient_user_authentication", error_description="A more recent sign-in is required", max_age="900"';
  }
  return headers;
}

// Native-only routes: a Binding token, or no token, is refused (and logged)
// before the body is read or any RPC runs. The Worker does not decode the
// JWT: auth_time, TTL and single use are enforced by the definer RPCs, which
// are authoritative.
async function requireNativeBearer(request: Request, env: ContinuityEnv, denial: Record<string, string>) {
  const bearer = bearerToken(request);
  if (!bearer || bearer.startsWith("clued_bnd_")) {
    console.warn(JSON.stringify({
      event: "information_flow_native_route_denied", ...denial, reason: "binding_or_missing_token",
    }));
    throw new HttpError(401, "A signed-in Clued account is required.");
  }
  return await requireSupabaseUser(request, env);
}

// Confirmation (step 1), promotion (step 2) and reject (contract 4.3.2, 5.1).
async function handleNativeCandidateAction(
  request: Request,
  env: ContinuityEnv,
  target: { tier: "information" | "knowledge"; candidateId: string; action: "confirmation" | "promote" | "reject" },
) {
  const { token } = await requireNativeBearer(request, env, { route: target.action, tier: target.tier });
  const { input, receivedPayloadHash } = await parseCanonicalBody(request);
  if ("candidate_id" in input && String(input.candidate_id).toLowerCase() !== target.candidateId) {
    throw new HttpError(422, "candidate_id does not match the request path.");
  }
  if ("tier" in input && input.tier !== target.tier) {
    throw new HttpError(422, "tier is fixed by the request path.");
  }
  const bound = { ...input, tier: target.tier, candidate_id: target.candidateId };
  const rpc = nativeCandidateRpcByAction[target.action];
  if (target.action === "confirmation") {
    // Issue and consume are separate requests; a token never rides along.
    if ("confirmation_token" in input) {
      throw new HttpError(422, "Confirmation and promotion are separate requests.");
    }
    const result = await callVerifiedUserRpc(env, token, rpc, bound);
    return json(result, informationFlowHttpStatus(result), informationFlowHeaders(request, result, {
      "cache-control": "no-store", pragma: "no-cache",
    }));
  }
  const result = await callVerifiedUserRpc(env, token, rpc, bound, receivedPayloadHash);
  return json(result, informationFlowHttpStatus(result), informationFlowHeaders(request, result));
}

async function handleInformationFlowApi(request: Request, env: ContinuityEnv) {
  validateOrigin(request, env);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (!recordsV2Enabled(env)) {
    throw new HttpError(404, "Clued project views v2 are disabled.");
  }
  const url = new URL(request.url);
  if (url.pathname === "/v1/intake" && request.method === "GET") {
    const input: Record<string, unknown> = {};
    const allowed = new Set<string>(informationFlowListParameters);
    for (const key of url.searchParams.keys()) {
      if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
        throw new HttpError(422, "Invalid intake list query parameters.");
      }
    }
    for (const key of informationFlowListParameters) {
      const value = url.searchParams.get(key);
      if (value === null) continue;
      if (key === "limit") {
        if (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > 200) {
          throw new HttpError(422, "limit must be an integer from 1 to 200.");
        }
        input.limit = Number(value);
      } else {
        input[key] = value;
      }
    }
    const result = await callUserRecordRpc(request, env, "clued_user_intake_list", input);
    return json(result, 200, corsHeaders(request));
  }
  const routes: Record<string, UserInformationFlowRpc> = {
    "/v1/intake": "clued_user_intake_submit",
    "/v1/knowledge/candidates": "clued_user_knowledge_propose",
  };
  const rpc = routes[url.pathname];
  if (rpc && request.method === "POST") {
    const { input, receivedPayloadHash } = await parseCanonicalBody(request);
    const result = await callUserRecordRpc(request, env, rpc, input, receivedPayloadHash);
    return json(result, informationFlowHttpStatus(result), corsHeaders(request));
  }
  const candidateAction = parseCandidateAction(url.pathname);
  if (candidateAction?.action === "withdraw" && request.method === "POST") {
    const { input, receivedPayloadHash } = await parseCanonicalBody(request);
    if ("candidate_id" in input && String(input.candidate_id).toLowerCase() !== candidateAction.candidateId) {
      throw new HttpError(422, "candidate_id does not match the request path.");
    }
    // The path binds the candidate; the idempotency hash covers it server-side.
    const result = await callUserRecordRpc(request, env, "clued_user_intake_withdraw",
      { ...input, candidate_id: candidateAction.candidateId }, receivedPayloadHash);
    return json(result, informationFlowHttpStatus(result), corsHeaders(request));
  }
  if (candidateAction && candidateAction.action !== "withdraw" && request.method === "POST") {
    return await handleNativeCandidateAction(request, env, {
      tier: candidateAction.tier, candidateId: candidateAction.candidateId, action: candidateAction.action,
    });
  }
  if (url.pathname === "/v1/context/pack" && request.method === "POST") {
    // Compile, or (Native only) revalidate a stored manifest with
    // {manifest_id}. The Worker only measures a compiled pack.
    const { input } = await parseCanonicalBody(request);
    const measured = await measurePack(await callUserRecordRpc(request, env, "clued_user_context_pack", input));
    return json(measured.result, measured.httpStatus ?? informationFlowHttpStatus(measured.result),
      corsHeaders(request));
  }
  const policyRpc = nativeContextPolicyRpcByPath[url.pathname as keyof typeof nativeContextPolicyRpcByPath];
  if (policyRpc && request.method === "POST") {
    const confirmation = url.pathname === "/v1/context/policies/confirmation";
    const { token } = await requireNativeBearer(request, env, {
      route: confirmation ? "policy_confirmation" : "policy_accept",
    });
    const { input, receivedPayloadHash } = await parseCanonicalBody(request);
    if (confirmation) {
      // Issue and consume are separate requests; a token never rides along.
      if ("confirmation_token" in input) {
        throw new HttpError(422, "Confirmation and acceptance are separate requests.");
      }
      const result = await callVerifiedUserRpc(env, token, policyRpc, input);
      return json(result, informationFlowHttpStatus(result), informationFlowHeaders(request, result, {
        "cache-control": "no-store", pragma: "no-cache",
      }));
    }
    const result = await callVerifiedUserRpc(env, token, policyRpc, input, receivedPayloadHash);
    return json(result, informationFlowHttpStatus(result), informationFlowHeaders(request, result));
  }
  const withdrawal = parseEvidenceWithdrawal(url.pathname);
  if (withdrawal && request.method === "POST") {
    // Evidence withdrawal (contract 6.4): Native only, two steps, the path
    // binds the Evidence id.
    const { token } = await requireNativeBearer(request, env, {
      route: withdrawal.step === "confirmation" ? "evidence_withdrawal_confirmation" : "evidence_withdraw",
    });
    const { input, receivedPayloadHash } = await parseCanonicalBody(request);
    if ("evidence_id" in input && String(input.evidence_id).toLowerCase() !== withdrawal.evidenceId) {
      throw new HttpError(422, "evidence_id does not match the request path.");
    }
    const bound = { ...input, evidence_id: withdrawal.evidenceId };
    const rpc = nativeEvidenceWithdrawalRpcByStep[withdrawal.step];
    if (withdrawal.step === "confirmation") {
      // Issue and consume are separate requests; a token never rides along.
      if ("confirmation_token" in input) {
        throw new HttpError(422, "Confirmation and withdrawal are separate requests.");
      }
      const result = await callVerifiedUserRpc(env, token, rpc, bound);
      return json(result, informationFlowHttpStatus(result), informationFlowHeaders(request, result, {
        "cache-control": "no-store", pragma: "no-cache",
      }));
    }
    const result = await callVerifiedUserRpc(env, token, rpc, bound, receivedPayloadHash);
    return json(result, informationFlowHttpStatus(result), informationFlowHeaders(request, result));
  }
  const known = url.pathname === "/v1/intake" ? "GET, POST, OPTIONS"
    : url.pathname in routes || candidateAction || url.pathname === "/v1/context/pack" || policyRpc || withdrawal
      ? "POST, OPTIONS" : null;
  if (!known) return json({ error: "Not found." }, 404, corsHeaders(request));
  return json({ error: "Method not allowed." }, 405, { ...corsHeaders(request), allow: known });
}

async function handleContinuityRequestInner(
  request: Request,
  env: ContinuityEnv,
  ctx?: ContinuityExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/healthz" && request.method === "GET") {
      const sourceCommit = typeof __CLUED_BUILD_SHA__ === "string" &&
        /^[0-9a-f]{40}$/.test(__CLUED_BUILD_SHA__) ? __CLUED_BUILD_SHA__ : null;
      return json({
        status: "ok",
        service: "clued-continuity",
        version: KERNEL_VERSION,
        canonicalStore: "supabase",
        mcp: "/mcp",
        api: "/v1/continuity",
        workLog: "日志.md",
        mandatoryLifecycle: ["resume", "checkpoint"],
        ...(sourceCommit ? { source_commit: sourceCommit } : {}),
      });
    }
    if (url.pathname === "/.well-known/clued-continuity") {
      return json(bootstrapContract(url.origin, env));
    }
    if (url.pathname === "/v1/continuity/bootstrap") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(request) });
      }
      if (request.method !== "GET" && request.method !== "POST") {
        return json({ error: "Method not allowed." }, 405, {
          ...corsHeaders(request),
          allow: "GET, POST, OPTIONS",
        });
      }
      return json(bootstrapContract(url.origin, env), 200, corsHeaders(request));
    }
    if (url.pathname === "/clued-agent.md") {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed." }, 405, { allow: "GET" });
      }
      return new Response(agentInstructions(url.origin), {
        status: 200,
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    }
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      const { url: supabaseUrl } = supabaseConfig(env);
      return json({
        resource: `${url.origin}/mcp`,
        bearer_methods_supported: ["header"],
        authorization_servers: [`${supabaseUrl}/auth/v1`],
        scopes_supported: OAUTH_SCOPES,
        clued_binding_scopes: ALL_SCOPES,
        clued_binding_portal: `${url.origin}/`,
      });
    }
    if (url.pathname === "/mcp") return await handleMcp(request, env, ctx);
    if (url.pathname === "/v1/storage/recovery") {
      validateOrigin(request, env);
      // Recovery remains available when new jobs/execution are disabled. It is
      // native Owner only and never enters the normal executor or refresh path.
      const headers = { ...corsHeaders(request), "cache-control": "no-store" };
      if (env.CLUED_STORAGE_ACCOUNT_V1 !== "true" || env.CLUED_STORAGE_GOOGLE_V1 !== "true") return json({ error: "Not found." }, 404, headers);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, { ...headers, allow: "POST, OPTIONS" });
      const { token } = await requireSupabaseUser(request, env);
      try {
        const input = await parseBody(request), issuer = env.CLUED_STORAGE_CONNECTOR_ISSUER;
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
        if (Object.keys(input).length !== 3 || typeof input.action !== "string" || !["inspect", "settle"].includes(input.action) ||
            typeof input.connection_id !== "string" || !uuid.test(input.connection_id) ||
            typeof input.job_id !== "string" || !uuid.test(input.job_id) || !issuer || issuer.length < 32) throw new Error("Unavailable");
        const reference = { connection_id: input.connection_id, job_id: input.job_id };
        const issuerHash = await sha256(issuer);
        const rpc = async (value: Record<string, unknown>) => await supabaseRequest(env, "/rest/v1/rpc/clued_storage_native_recovery_v1", {
          method: "POST", userToken: token, redirect: "manual", signal: AbortSignal.timeout(10000),
          body: JSON.stringify({ p_issuer_hash: issuerHash, p_input: value }),
        }) as Record<string, unknown>;
        const ownerStatus = storageAgentResult(await rpc({ ...reference, action: "recovery_inspect" }), reference);
        if (input.action === "inspect") {
          // Status only, even without a vault or after connection revocation.
          return json(ownerStatus, 200, headers);
        }
        if (!env.CLUED_STORAGE_VAULT_KEYS) throw new Error("Unavailable");
        // Owner lookup above prevents the fixed issuer bridge from becoming a
        // cross-account recovery endpoint. This branch never calls the executor.
        const verifiedRpc = async (value: Record<string, unknown>) => await supabaseRequest(env,
          "/rest/v1/rpc/clued_storage_cloud_worker_router_v2", {
            method: "POST", redirect: "manual", signal: AbortSignal.timeout(10000),
            body: JSON.stringify({ p_issuer_hash: issuerHash, p_input: value }),
          }) as Record<string, unknown>;
        let verifiedStatus: Record<string, unknown> | null = null;
        try { verifiedStatus = await verifiedRpc({ ...reference, action: "verified_inspect" }); }
        catch { /* The legacy connection is still restricted by the v1 fence. */ }
        if (verifiedStatus?.status === "committed" && verifiedStatus.job_id === reference.job_id &&
            verifiedStatus.connection_id === reference.connection_id && uuid.test(String(verifiedStatus.receipt_id)) &&
            verifiedStatus.execution_permitted === false) {
          return json({ status: "committed", job_id: reference.job_id, receipt_id: verifiedStatus.receipt_id,
            execution_permitted: false }, 200, headers);
        }
        if (verifiedStatus?.status === "verified" && verifiedStatus.job_id === reference.job_id &&
            verifiedStatus.connection_id === reference.connection_id &&
            uuid.test(String(verifiedStatus.verified_receipt_id)) &&
            /^[0-9a-f]{64}$/.test(String(verifiedStatus.verified_digest)) &&
            verifiedStatus.execution_permitted === false) {
          const settled = await verifiedRpc({ ...reference, action: "settle_verified" });
          if (settled.status !== "committed" || settled.state !== "committed" ||
              !uuid.test(String(settled.receipt_id)) || settled.execution_permitted !== false) throw new Error("Unavailable");
          return json({ status: "committed", job_id: reference.job_id, receipt_id: settled.receipt_id,
            execution_permitted: false }, 200, headers);
        }
        if (verifiedStatus?.status === "none") throw new Error("No original effect");
        let accountDescriptor: Record<string, unknown> | null = null;
        if (verifiedStatus) {
          if (verifiedStatus.status !== "inspection_required" || verifiedStatus.job_id !== reference.job_id ||
              verifiedStatus.connection_id !== reference.connection_id || verifiedStatus.execution_permitted !== false)
            throw new Error("Unavailable");
          accountDescriptor = await supabaseRequest(env, "/rest/v1/rpc/clued_storage_native_recovery_load_v2", {
            method: "POST", userToken: token, redirect: "manual", signal: AbortSignal.timeout(10000),
            body: JSON.stringify({ p_issuer_secret: issuer, p_input: { ...reference, action: "recovery_load" } }),
          }) as Record<string, unknown>;
          if (accountDescriptor.status !== "recovery_only") throw new Error("Unavailable");
        }
        const recovery = await createStorageCloudRecovery({ client_id: env.CLUED_STORAGE_GOOGLE_CLIENT_ID ?? "",
          vault: JSON.parse(env.CLUED_STORAGE_VAULT_KEYS), rpc,
          ...(accountDescriptor?.status === "recovery_only" ? { verified: { descriptor: accountDescriptor, rpc: verifiedRpc } } : {}) });
        return json(await recovery.run(reference), 200, headers);
      } catch {
        return json({ status: "inspection_required", execution_permitted: false }, 403, headers);
      }
    }
    if (url.pathname === "/v1/storage/google/probe") {
      validateOrigin(request, env);
      if (env.CLUED_STORAGE_ACCOUNT_V1 !== "true" || env.CLUED_STORAGE_GOOGLE_V1 !== "true") return json({ error: "Not found." }, 404);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
      if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, { allow: "POST, OPTIONS" });
      const { token } = await requireSupabaseUser(request, env);
      try {
        const input = await parseBody(request), issuer = env.CLUED_STORAGE_CONNECTOR_ISSUER;
        if (!issuer || issuer.length < 32 || !env.CLUED_STORAGE_VAULT_KEYS) throw new Error("Unavailable");
        const probe = await createStorageGoogleProbe({ client_id: env.CLUED_STORAGE_GOOGLE_CLIENT_ID ?? "",
          vault: JSON.parse(env.CLUED_STORAGE_VAULT_KEYS),
          rpc: async value => await supabaseRequest(env, "/rest/v1/rpc/clued_storage_directory_probe_v1", {
            method: "POST", userToken: token, redirect: "manual", signal: AbortSignal.timeout(10000),
            body: JSON.stringify({ p_issuer_hash: await sha256(issuer), p_input: value }),
          }) as Record<string, unknown>,
        });
        return json(await probe.run(input), 200, { ...corsHeaders(request), "cache-control": "no-store" });
      } catch (error) {
        return json({ error: "Storage directory observation unavailable.", execution_permitted: false, diagnostic: storageProbeDiagnostic(error) },
          403, { ...corsHeaders(request), "cache-control": "no-store" });
      }
    }
    if (["/v1/storage/google/start", "/v1/storage/google/complete", "/v1/storage/google/recovery/start",
      "/v1/storage/google/recovery/auto-start", "/v1/storage/google/recovery/auto-target",
      "/v1/storage/google/recovery/inspect"].includes(url.pathname)) {
      validateOrigin(request, env);
      if (env.CLUED_STORAGE_ACCOUNT_V1 !== "true" || env.CLUED_STORAGE_GOOGLE_V1 !== "true") return json({ error: "Not found." }, 404);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
      if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, { allow: "POST, OPTIONS" });
      const { token } = await requireSupabaseUser(request, env);
      try {
        const input = await parseBody(request);
        const issuer = env.CLUED_STORAGE_CONNECTOR_ISSUER;
        if (!issuer || issuer.length < 32 || !env.CLUED_STORAGE_VAULT_KEYS) throw new Error("Unavailable");
        const recoveryStart = url.pathname === "/v1/storage/google/recovery/start" || url.pathname === "/v1/storage/google/recovery/auto-start";
        const autoStart = url.pathname === "/v1/storage/google/recovery/auto-start";
        if (recoveryStart && (Object.keys(input).length !== 2 || typeof input.connection_id !== "string" || typeof input.job_id !== "string")) throw new Error("Invalid");
        const configuration = {
          client_id: env.CLUED_STORAGE_GOOGLE_CLIENT_ID ?? "",
          client_secret: env.CLUED_STORAGE_GOOGLE_CLIENT_SECRET ?? "",
          redirect_uri: env.CLUED_STORAGE_GOOGLE_REDIRECT_URI ?? "",
          vault: JSON.parse(env.CLUED_STORAGE_VAULT_KEYS),
          rpc: async (value: Record<string, unknown>) => {
            const callback = value.action === "claim" || value.action === "complete" || value.action === "inspect";
            return await supabaseRequest(env, recoveryStart
              ? "/rest/v1/rpc/clued_storage_recovery_oauth_start_v2"
              : callback ? "/rest/v1/rpc/clued_storage_oauth_callback_v2"
              : "/rest/v1/rpc/clued_storage_oauth_v1", {
              method: "POST", userToken: token, redirect: "manual", signal: AbortSignal.timeout(10000),
              body: JSON.stringify(callback || recoveryStart
                ? { p_issuer_secret: issuer, p_input: value }
                : { p_issuer_hash: await sha256(issuer), p_input: value }),
            }) as Record<string, unknown>;
          },
        };
        let result;
        if (recoveryStart) {
          result = await (await createStorageGoogleRecoveryOAuth(configuration,
            { connection_id: input.connection_id as string, job_id: input.job_id as string })).start();
          if (autoStart) {
            const authorization = new URL(result.authorization_url);
            const state = authorization.searchParams.get("state");
            if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state)) throw new Error("Invalid");
            const marked = await supabaseRequest(env, "/rest/v1/rpc/clued_storage_recovery_auto_target_v1", {
              method: "POST", userToken: token, redirect: "manual", signal: AbortSignal.timeout(10000),
              body: JSON.stringify({ p_issuer_secret: issuer, p_input: { action: "mark", state_hash: await sha256(state),
                connection_id: input.connection_id, job_id: input.job_id } }),
            }) as Record<string, unknown>;
            if (marked.status !== "marked") throw new Error("Unavailable");
          }
        } else if (url.pathname.endsWith("/auto-target")) {
          if (Object.keys(input).length !== 1 || typeof input.state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.state)) throw new Error("Invalid");
          result = await supabaseRequest(env, "/rest/v1/rpc/clued_storage_recovery_auto_target_v1", {
            method: "POST", userToken: token, redirect: "manual", signal: AbortSignal.timeout(10000),
            body: JSON.stringify({ p_issuer_secret: issuer, p_input: { action: "target", state_hash: await sha256(input.state) } }),
          });
        } else if (url.pathname.endsWith("/inspect")) {
          if (Object.keys(input).length !== 1 || typeof input.state !== "string") throw new Error("Invalid");
          result = await (await createStorageGoogleOAuth(configuration)).inspectRecovery(input.state);
        } else if (url.pathname.endsWith("/start")) {
          if (Object.keys(input).some(key => !["connection_id", "default_refresh"].includes(key)) || typeof input.connection_id !== "string" ||
              ("default_refresh" in input && typeof input.default_refresh !== "boolean")) throw new Error("Invalid");
          if (input.default_refresh === true && env.CLUED_STORAGE_REFRESH_V1 !== "true") throw new Error("Unavailable");
          result = await (await createStorageGoogleOAuth(configuration)).start(input.connection_id, input.default_refresh === true);
        } else {
          if (Object.keys(input).length !== 2 || typeof input.state !== "string" || typeof input.code !== "string") throw new Error("Invalid");
          result = await (await createStorageGoogleOAuth(configuration)).complete({ state: input.state, code: input.code });
        }
        return json(result, 200, { ...corsHeaders(request), "cache-control": "no-store" });
      } catch (error) {
        return json({ error: "Storage Google connection unavailable.",
          ...(error instanceof StorageGoogleConnectionError ? { reason: error.reason } : {}) },
          403, { ...corsHeaders(request), "cache-control": "no-store" });
      }
    }
    if (url.pathname === "/v1/storage/jobs") {
      validateOrigin(request, env);
      if (env.CLUED_STORAGE_ACCOUNT_V1 !== "true" || env.CLUED_STORAGE_JOBS_V1 !== "true") return json({ error: "Not found." }, 404);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
      if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, { allow: "POST, OPTIONS" });
      const token = bearerToken(request);
      if (!token || !/^clued_bnd_[A-Za-z0-9_-]{32,}$/.test(token)) return json({ error: "An explicitly granted Clued Binding is required." }, 403);
      const input = await parseBody(request);
      try {
        const result = await callStorageJob(request, env, input, ctx);
        return json(result, 200, { ...corsHeaders(request), "cache-control": "no-store" });
      } catch {
        return json({ error: "Storage job unavailable." }, 403, { ...corsHeaders(request), "cache-control": "no-store" });
      }
    }
    if (url.pathname === "/v1/storage/owner") {
      validateOrigin(request, env);
      const headers = { ...corsHeaders(request), "cache-control": "no-store" };
      if (env.CLUED_STORAGE_ACCOUNT_V1 !== "true") return json({ error: "Not found." }, 404, headers);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, { ...headers, allow: "POST, OPTIONS" });
      const { token } = await requireSupabaseUser(request, env);
      try {
        const input = await parseBody(request);
        const result = await supabaseRequest(env, "/rest/v1/rpc/clued_storage_owner_manage_v2", {
          method: "POST", userToken: token, body: JSON.stringify({ p_input: input }),
        }) as Record<string, unknown>;
        if (input.action === "connections" && Array.isArray(result.connections)) {
          // This flag reflects the Worker gate at the time of this read. Every
          // real job still rechecks the database switch and all exact authority.
          return json({ ...result, worker_execution_enabled: env.CLUED_STORAGE_EXECUTOR_V1 === "true" },
            200, headers);
        }
        return json(result, 200, headers);
      } catch {
        return json({ error: "Storage owner operation unavailable." }, 403, headers);
      }
    }
    if (url.pathname === "/v1/storage/account" || url.pathname === "/v1/storage/refresh") {
      validateOrigin(request, env);
      if (env.CLUED_STORAGE_ACCOUNT_V1 !== "true") return json({ error: "Not found." }, 404);
      if (url.pathname.endsWith("/refresh") && env.CLUED_STORAGE_REFRESH_V1 !== "true") return json({ error: "Not found." }, 404);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
      if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, { allow: "POST, OPTIONS" });
      const { token } = await requireSupabaseUser(request, env);
      const input = await parseBody(request);
      // The RPC independently checks auth.sessions. Never replace the native
      // user JWT with a service-role credential or a caller-selected owner ID.
      try {
        const result = await supabaseRequest(env, url.pathname.endsWith("/refresh") ? "/rest/v1/rpc/clued_storage_refresh_manage_v1" : "/rest/v1/rpc/clued_storage_account_v1", {
          method: "POST", userToken: token, body: JSON.stringify({ p_input: input }),
        });
        return json(result, 200, { ...corsHeaders(request), "cache-control": "no-store" });
      } catch {
        return json({ error: "Storage account operation unavailable." }, 403, { "cache-control": "no-store" });
      }
    }
    if (url.pathname === "/v1/storage/policy-transition") {
      validateOrigin(request, env);
      const headers = { ...corsHeaders(request), "cache-control": "no-store" };
      if (env.CLUED_STORAGE_POLICY_TRANSITION_V2 !== "true" || env.CLUED_STORAGE_ACCOUNT_V1 !== "true") {
        return json({ error: "Not found." }, 404, headers);
      }
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, { ...headers, allow: "POST, OPTIONS" });
      const { token } = await requireSupabaseUser(request, env);
      try {
        const input = await parseBody(request);
        const issuer = env.CLUED_STORAGE_CONNECTOR_ISSUER;
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
        const sha = /^[0-9a-f]{64}$/;
        const action = input.action;
        const allowed = action === "describe" || action === "inspect"
          ? ["action", "manifest_id"]
          : action === "transition"
            ? ["action", "manifest_id", "manifest_sha256", "expected_inventory_digest", "idempotency_key"]
            : action === "cancel_queued"
              ? ["action", "manifest_id", "manifest_sha256", "expected_inventory_digest", "idempotency_key",
                "job_id", "request_digest", "submit_receipt_id"]
              : null;
        if (!allowed || Object.keys(input).length !== allowed.length || allowed.some(key => !(key in input)) ||
            !uuid.test(String(input.manifest_id)) || !issuer || issuer.length < 32) throw new Error("Invalid");
        if (action === "transition" || action === "cancel_queued") {
          if (!sha.test(String(input.manifest_sha256)) || !sha.test(String(input.expected_inventory_digest)) ||
              typeof input.idempotency_key !== "string" || input.idempotency_key.length < 8 ||
              input.idempotency_key.length > 160 || input.idempotency_key.trim() !== input.idempotency_key) throw new Error("Invalid");
        }
        if (action === "cancel_queued" && (!uuid.test(String(input.job_id)) ||
            !sha.test(String(input.request_digest)) || !uuid.test(String(input.submit_receipt_id)))) throw new Error("Invalid");
        const result = await supabaseRequest(env, "/rest/v1/rpc/clued_storage_policy_transition_v2", {
          method: "POST", userToken: token, redirect: "manual", signal: AbortSignal.timeout(10000),
          body: JSON.stringify({ p_issuer_hash: await sha256(issuer), p_input: input }),
        });
        return json(result, 200, headers);
      } catch {
        return json({ error: "Storage policy transition unavailable.", execution_permitted: false }, 403, headers);
      }
    }
    if (url.pathname === "/v1/resource-center/authority") {
      return await handleResourceCenterAuthority(request, env);
    }
    if (url.pathname === "/v1/resource-center/write") {
      return handleResourceCenterWrite(request, env);
    }
    if (url.pathname === "/v1/resource-center/renew") {
      return handleResourceCenterRenewal(request, env);
    }
    if (url.pathname === "/v1/development" || url.pathname === "/v1/development/owner") {
      validateOrigin(request, env);
      if (!contextsEnabled(env)) return json({ error: "Development context is disabled." }, 404, corsHeaders(request));
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
      if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, { ...corsHeaders(request), allow: "POST, OPTIONS" });
      const { input } = await parseCanonicalBody(request);
      if (url.pathname.endsWith("/owner")) {
        const token = bearerToken(request);
        if (!token || token.startsWith("clued_bnd_")) throw new HttpError(403, "Sign in as the context owner to manage access.");
        await requireSupabaseUser(request, env);
        const result = await supabaseRequest(env, "/rest/v1/rpc/clued_development_owner_v14", {
          method: "POST", userToken: token, body: JSON.stringify({ p_input: input }),
        });
        return json(result, 200, corsHeaders(request));
      }
      return json(sanitizeContextResult(await callRpc(request, env, "clued_context", input)), 200, corsHeaders(request));
    }
    if (url.pathname in restToolByPath) return await handleRestContinuity(request, env);
    if (url.pathname === "/v1/projects" || url.pathname.startsWith("/v1/projects/")) {
      return await handleProjectApi(request, env);
    }
    if (url.pathname === "/v1/records" || url.pathname.startsWith("/v1/records/") ||
      ["/v1/decisions/supersede", "/v1/evidence", "/v1/events", "/v1/export"].includes(url.pathname)) {
      return await handleRecordApi(request, env);
    }
    if (isInformationFlowPath(url.pathname)) return await handleInformationFlowApi(request, env);
    if (url.pathname === "/api/bindings") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(request) });
      }
      if (request.method === "GET") return await listBindings(request, env);
      if (request.method === "POST") return await createBinding(request, env);
      if (request.method === "DELETE") return await revokeBinding(request, env);
      return json({ error: "Method not allowed." }, 405, corsHeaders(request));
    }
    if (url.pathname === "/api/memories" || url.pathname.startsWith("/api/memories/")) {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(request) });
      }
      return json({
        error: "Legacy Memory API retired.",
        replacement: "/v1/records",
        semantic_contract: "two-level-five-view-v1",
      }, 410, corsHeaders(request));
    }
    return null;
  } catch (error) {
    const problem = error instanceof HttpError ? error : new HttpError(500, "Clued request failed.");
    return json({ error: problem.message, details: problem.details }, problem.status, corsHeaders(request));
  }
}

export async function handleContinuityRequest(
  request: Request,
  env: ContinuityEnv,
  ctx?: ContinuityExecutionContext,
): Promise<Response | null> {
  const response = await handleContinuityRequestInner(request, env, ctx);
  if (response?.ok && ctx && projectionBuilderToken(env) &&
    mayInvalidateApprovedProjection(request)) {
    ctx.waitUntil(runProjectionRefreshPipeline(env));
  }
  if (!response || !p6ReleaseControlEnabled(env)) return response;
  return decorateP6Response(request, response, env);
}
