import { projectRpcByTool, projectTools } from "./projects";
import { createNativeReadTrace, type NativeReadTrace } from "./native-read-trace";
import { withCanonicalMcpError } from "./mcp-error-envelope";
import { handleMcpProfile, mcpProfileTool, McpProfileError, type McpProfile } from "./mcp-profile";
import { databaseGatewayToken, resolveSupabaseConfig, type DatabaseGatewayEnv } from "./database-gateway";
import { CI_CONNECTION_RENEW_PATH, handleCiConnectionRenew, handleCiNodeGatewayV1, isCiNodeGatewayPath } from "./ci-node-gateway-v1";
import { GITHUB_EVENTS_PATH, handleGitHubEvents } from "./github-events-v1";
import { MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL, MODEL_DOMAIN_BOOTSTRAP_COMMIT_TOOL, isModelDomainTool, modelDomainSourceEnabled,
  modelDomainBootstrapRequestEnabled, modelDomainTools, modelDomainToolPolicies,
  type ModelDomainFeatureEnv, type ModelDomainToolName } from "./model-domain-tools";
import { BootstrapCompletionUnknown, BootstrapExecutionDenied, BootstrapInputDenied, BootstrapReadinessDenied } from "./model-domain-bootstrap-source.mjs";
import { dispatchModelDomainTool, ModelDomainToolDenied } from "./model-domain-dispatch";
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
import {
  WORK_CLAIMS_ACTIVE_OAUTH_TOOL,
  WORK_CLAIMS_ACTIVE_RPC,
  withWorkClaimContext,
  workClaimRpcByTool,
  workClaimToolPolicies,
  workClaimTools,
  workClaimsEnabled,
  type WorkClaimFeatureEnv,
} from "./work-claims";
import {
  OWNER_REQUEST_TOOL,
  OwnerRequestInputError,
  ownerRequestCall,
  ownerRequestRejection,
  ownerRequestToolPolicies,
  ownerRequestTools,
  ownerRequestsEnabled,
  withConfirmUrl,
  type OwnerRequestFeatureEnv,
} from "./owner-requests";
import {
  AGENT_INBOX_SUMMARY_OAUTH_TOOL,
  AGENT_INBOX_SUMMARY_RPC,
  agentMessageRpcByTool,
  agentMessageToolPolicies,
  agentMessageTools,
  agentMessagesEnabled,
  withAgentInbox,
  withAgentMessageNotice,
  withCoordinationHint,
  type AgentMessageFeatureEnv,
} from "./agent-messages";
import {
  INTEGRATION_REQUEST_RULE_REJECTIONS,
  integrationBootstrap,
  integrationCalls,
  integrationHttpStatus,
  integrationNativeRoute,
  integrationRuleEnvelope,
  integrationRuntimeEnabled,
  integrationToolPolicies,
  integrationTools,
  isIntegrationPath,
  isIntegrationTool,
  type IntegrationFeatureEnv,
  type IntegrationToolName,
} from "./integrations";
import { measurePack } from "./context-pack";
import { permissionDenial, permissionDenialResult } from "./permission-guidance";
import { sanitizeCluedResult } from "./result-sanitization";
import { AGENT_CONTRACT_MARKDOWN, AGENT_CONTRACT_VERSION, AGENT_CONTRACT_SHA256 } from "./generated/agent-contract";
import { renderAgentContractBootstrap } from "./agent-contract-bootstrap.mjs";
import { CLUED_COMPONENTS_SCHEMA, CLUED_COMPONENT_VERSIONS, MCP_SERVER_VERSION } from "./generated/components";
import { createStorageGoogleOAuth, StorageGoogleConnectionError } from "./storage-google-oauth";
import { createStorageGoogleRecoveryOAuth } from "./storage-google-recovery-oauth";
import { createStorageGoogleOnboard } from "./storage-google-onboard";
import { storageOAuthStartMaintenance, type StorageOAuthCutoverEnv } from "./storage-oauth-cutover";
import { ONBOARD_DISCLOSURE_VERSION } from "./storage-onboard-disclosure";
import { createStorageGoogleProbe, storageProbeDiagnostic } from "./storage-google-probe";
import { createStorageGoogleRefresh } from "./storage-google-refresh";
import { createStorageOwnerLifecycle, StorageOwnerLifecycleError, type OwnerReconnectInput, type OwnerDeleteInput } from "./storage-owner-lifecycle";
import { createStorageCloudWorker } from "./storage-cloud-executor";
import { createStorageDemandRuntime, runStorageDemandRenewalScheduled } from "./storage-demand-runtime";
import { storageBinaryEnabled, storageJobsEnabled, storageScheduleEnabled } from "./storage-scheduled-flags";
import storageDemandPolicy from "../../../development/contracts/storage/StorageDemandRenewal.v0.1.json";
import { createStorageCloudRecovery, storageRecoveryRefreshReference } from "./storage-cloud-recovery";
import { createStorageRecoveryReview } from "./storage-recovery-review";
import { recoveryDiagnostic, storageRecoveryListResult, storageRecoveryOwnerResult, storageRecoveryResolutionResult, type RecoveryDiagnostic, type RecoveryStage } from "./storage-recovery-diagnostics";
import { isStorageAgentTool, storageAgentInput, storageAgentResult, storageAgentTools, storageAgentToolsFor, storagePathCode, storagePathMessages,
  storageDestructiveCode, storageDestructiveMessages, storageAdoptCode, storageAdoptMessages, storageTrashBatchInput,
  storageTrashBatchResult, storageObjectReviewCode, storageObjectReviewRefusal } from "./storage-agent-tools";
import { createStagingRuntime, handleStagingPut, loadStagedContent, stageInline, stagingErrorCode, storageUploadBeginTool,
  sweepStaging, uploadBegin, uploadErrorBody, StorageUploadError, type StagingBucket } from "./storage-staging";
import { createStorageReadAgent, storageReadTool, storageContentTool, StorageReadError, STORAGE_IMAGE } from "./storage-read-agent";
import { storageConnectionsInput, storageConnectionsMessages, storageConnectionsResult, storageConnectionsTool,
  StorageConnectionsError } from "./storage-connections";

declare const __CLUED_BUILD_SHA__: string | null;

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
// The mcp.server version in config/clued-components.json (Task 6dfd7560).
const KERNEL_VERSION = MCP_SERVER_VERSION;
const RESOURCE_CENTER_AUTHORITY_CONTRACT = "clued.resource-center-authority/1";

type Scope = (typeof ALL_SCOPES)[number];

export interface ContinuityEnv extends DatabaseGatewayEnv, RecordFeatureEnv, P5FeatureEnv, P6FeatureEnv, ContextFeatureEnv, WorkClaimFeatureEnv, OwnerRequestFeatureEnv,
  AgentMessageFeatureEnv, IntegrationFeatureEnv, ModelDomainFeatureEnv, StorageOAuthCutoverEnv {
  CI_RENEW_SOURCE_LIMIT?: Pick<RateLimit, 'limit'>;
  CI_RENEW_IDENTITY_LIMIT?: Pick<RateLimit, 'limit'>;
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
  // StorageNormalUse N0 self-service onboarding: flag, and the browser-side
  // Google Picker configuration (public API key restricted to this site, and
  // the Cloud project number used as the Picker App ID). Absent Picker values
  // only disable "choose an existing folder".
  CLUED_STORAGE_ONBOARD_V1?: string;
  CLUED_STORAGE_GOOGLE_PICKER_API_KEY?: string;
  CLUED_STORAGE_GOOGLE_CLOUD_PROJECT_NUMBER?: string;
  CLUED_STORAGE_CONNECTOR_ISSUER?: string;
  CLUED_STORAGE_VAULT_KEYS?: string;
  CLUED_STORAGE_READ_V1?: string;
  CLUED_STORAGE_READ_RECEIPT_KEYS?: string;
  CLUED_STORAGE_READ_CURSOR_KEY?: string;
  /** Service binding to the PDF extractor Worker clued-storage-pdf (StorageNormalUse §4.5, RPC). */
  PDF_EXTRACTOR?: unknown;
  // StorageNormalUse N3 binary upload: flag, R2 staging bucket, URL signing key, staging keyring.
  CLUED_STORAGE_BINARY_V1?: string;
  CLUED_STORAGE_STAGING?: StagingBucket;
  CLUED_STORAGE_STAGING_URL_KEY?: string;
  CLUED_STORAGE_STAGING_KEYS?: string;
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
  /** Server-only identity from the OAuth provider after its current Binding check.
   * Never populate this from request headers, arguments or a Binding Token. */
  authenticatedMcpAccount?: McpProfile;
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

function buildSourceCommit(): string | null {
  return typeof __CLUED_BUILD_SHA__ === "string" &&
    /^[0-9a-f]{40}$/.test(__CLUED_BUILD_SHA__) ? __CLUED_BUILD_SHA__ : null;
}

// The component versions this build was made from, so a client can tell
// whether its Skill, hooks and scripts are current (scripts/hooks/clued_version_check.py).
function cluedComponents() {
  return { schema: CLUED_COMPONENTS_SCHEMA, versions: CLUED_COMPONENT_VERSIONS, source_commit: buildSourceCommit() };
}

function bootstrapContract(origin: string, env?: ContinuityEnv) {
  return {
    schema_version: "1.0",
    service: "clued-continuity",
    kernel_version: KERNEL_VERSION,
    components: cluedComponents(),
    agent_contract: { version: AGENT_CONTRACT_VERSION, sha256: AGENT_CONTRACT_SHA256 },
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
      contract: { version: AGENT_CONTRACT_VERSION, url: `${origin}/clued-agent.md` },
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
        resume_constraint_views: { values: ["index", "full"], default: "index", full_text_by_id_max: 50 },
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
      // IntegrationRuntime §12.4: present only with CLUED_INTEGRATION_RUNTIME_V1 on
      ...(env && integrationRuntimeEnabled(env) ? { integration_runtime: integrationBootstrap() } : {}),
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
  const { url, key } = resolveSupabaseConfig(env);
  return { url: url.replace(/\/$/, ""), key };
}

function bearerToken(request: Request) {
  const value = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1] ?? null;
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
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
  const token = init.userToken ?? databaseGatewayToken(env);
  if (!token) throw new HttpError(503, "BeamingFace database gateway is not configured.");
  const headers = new Headers(init.headers);
  headers.set("apikey", key);
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json");
  headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${url}${path}`, { ...init, headers });
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      const parsed = JSON.parse(text) as unknown;
      payload = parsed;
    } catch {
      payload = { message: response.statusText || "BeamingFace storage returned a non-JSON response." };
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
          : "BeamingFace storage request failed.";
    // Binding RPCs use the Worker gateway role after Clued authenticates the
    // connection. PostgREST maps that role's insufficient_privilege to 401;
    // forwarding it makes MCP clients restart OAuth for a resource denial.
    // A rejected Worker JWT is a server outage, not an expired client grant.
    // Explicit user/P5 JWT authentication errors retain 401.
    const status =
      !init.userToken && response.status === 401 &&
        typeof details?.code === "string" && /^PGRST30[123]$/.test(details.code)
        ? 503
        :
      response.status === 401 && details?.code === "42501"
        ? 403
        : response.status >= 500 &&
      details?.code === "P0002" &&
      (message === "project_not_found" || message === "record_not_found")
        ? 404
        : response.status;
    throw new HttpError(
      status,
      status === 503 && response.status === 401 ? "BeamingFace database gateway is temporarily unavailable." : message,
      status === 503 && response.status === 401 ? { code: "worker_gateway_unavailable" } : payload,
    );
  }
  return payload;
}

export function projectionBuilderToken(env: ContinuityEnv) {
  const token = env.CLUED_PROJECTION_BUILDER_TOKEN?.trim();
  return token?.startsWith("clued_bnd_") ? token : null;
}

async function projectionBuilderRpc(
  env: ContinuityEnv,
  rpc: "clued_mcp_projection_refresh_claim" | "clued_mcp_projection_refresh_apply",
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

async function storageDemandRuntime(env: ContinuityEnv, prepare: (request: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  if (env.CLUED_STORAGE_REFRESH_V1 !== "true") return null;
  const issuer=env.CLUED_STORAGE_CONNECTOR_ISSUER;
  if (!issuer || issuer.length<32 || !env.CLUED_STORAGE_VAULT_KEYS) throw new Error("storage_demand_unavailable");
  const issuerHash=await sha256(issuer);
  return createStorageDemandRuntime({client_id:env.CLUED_STORAGE_GOOGLE_CLIENT_ID??"",
    client_secret:env.CLUED_STORAGE_GOOGLE_CLIENT_SECRET??"",vault:JSON.parse(env.CLUED_STORAGE_VAULT_KEYS),prepare,
    refresh_rpc:async input => await supabaseRequest(env,"/rest/v1/rpc/clued_storage_refresh_worker_v1",{
      method:"POST",body:JSON.stringify({p_issuer_hash:issuerHash,p_input:input}),signal:AbortSignal.timeout(10000),redirect:"manual",
    }) as Record<string,unknown>});
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
    const demand=await storageDemandRuntime(env,async request=>await supabaseRequest(env,"/rest/v1/rpc/clued_storage_refresh_worker_v1",{
      method:"POST",body:JSON.stringify({p_issuer_hash:issuerHash,p_input:{action:"prepare_credential",connection_id:request.connection_id,
        caller_kind:"job",request:{connection_id:request.connection_id,job_id:request.job_id}}}),
      signal:AbortSignal.timeout(10000),redirect:"manual",
    }) as Record<string,unknown>);
    const recoveryRefresh=env.CLUED_STORAGE_REFRESH_V1==="true" ? await createStorageGoogleRefresh({
      client_id:env.CLUED_STORAGE_GOOGLE_CLIENT_ID??"",client_secret:env.CLUED_STORAGE_GOOGLE_CLIENT_SECRET??"",
      vault:JSON.parse(env.CLUED_STORAGE_VAULT_KEYS),rpc:async input => await supabaseRequest(env,"/rest/v1/rpc/clued_storage_refresh_worker_v1",{
        method:"POST",body:JSON.stringify({p_issuer_hash:issuerHash,p_input:input}),signal:AbortSignal.timeout(10000),redirect:"manual",
      }) as Record<string,unknown>}) : null;
    let staging: Awaited<ReturnType<typeof createStagingRuntime>> | null = null;
    if (storageBinaryEnabled(env)) { try { staging = await stagingRuntime(env, issuerHash); } catch { staging = null; } }
    const executor=await createStorageCloudWorker({client_id:env.CLUED_STORAGE_GOOGLE_CLIENT_ID??"",
      vault:JSON.parse(env.CLUED_STORAGE_VAULT_KEYS),rpc,
      account_policy_v2:env.CLUED_STORAGE_JOBS_V2==="true",
      ...(staging ? { load_staged_content: (input: Record<string, unknown>) =>
        loadStagedContent(staging, input as Parameters<typeof loadStagedContent>[1]) } : {}),
      credential_preflight:demand ? ref=>demand.job(ref) : undefined,
      recovery_refresh:recoveryRefresh ? ref=>recoveryRefresh.run(ref.connection_id,ref.job_id) : undefined});
    return await executor.run(reference);
  } catch { return {status:"unavailable"}; }
}

async function stagingRuntime(env: ContinuityEnv, issuerHash?: string) {
  const issuer = env.CLUED_STORAGE_CONNECTOR_ISSUER;
  if (!issuer || issuer.length < 32) throw new StorageUploadError("storage_upload_unavailable");
  const hash = issuerHash ?? await sha256(issuer);
  return createStagingRuntime({ bucket: env.CLUED_STORAGE_STAGING, url_key: env.CLUED_STORAGE_STAGING_URL_KEY,
    staging_keys: env.CLUED_STORAGE_STAGING_KEYS,
    rpc: async (input, tokenHash) => await supabaseRequest(env, "/rest/v1/rpc/clued_storage_staging_v1", {
      method: "POST", body: JSON.stringify({ p_issuer_hash: hash, p_token_hash: tokenHash ?? null, p_input: input }),
      signal: AbortSignal.timeout(10000), redirect: "manual",
    }) as Record<string, unknown> });
}

// Cron: staging TTLs, 12 h cancellation of unstarted binary jobs, R2 object deletion.
export async function runStorageStagingScheduled(env: ContinuityEnv) {
  if (!storageScheduleEnabled.staging(env)) return { status: "disabled" };
  try { return await sweepStaging(await stagingRuntime(env)); }
  catch { return { status: "unavailable" }; }
}

// Cron: N0 onboarding expiry in its own transaction (§8.1 step 5): attempts
// past their 30 minutes lose the staged credential, created folders stay
// orphans. It runs whenever the storage account and Google features are on, so
// switching the onboard page off never strands a staged credential; only an
// unavailable sweep while onboarding is on is reported.
export async function runStorageOnboardScheduled(env: ContinuityEnv) {
  if (!storageScheduleEnabled.onboard(env)) return { status: "disabled" };
  try {
    const issuer = env.CLUED_STORAGE_CONNECTOR_ISSUER;
    if (!issuer || issuer.length < 32) return { status: "unavailable" };
    const result = await supabaseRequest(env, "/rest/v1/rpc/clued_storage_onboard_sweep_v1", {
      method: "POST", body: JSON.stringify({ p_issuer_hash: await sha256(issuer) }),
      signal: AbortSignal.timeout(10000), redirect: "manual",
    }) as Record<string, unknown>;
    if (result?.status !== "ok" || !Number.isSafeInteger(result.expired) || Number(result.expired) < 0) return { status: "unavailable" };
    return { status: "ok", expired: Number(result.expired) };
  } catch { return { status: "unavailable" }; }
}

export async function runStorageRefreshScheduled(env: ContinuityEnv) {
  if (!storageScheduleEnabled.refresh(env)) return { status: "disabled" };
  try {
    const issuer = env.CLUED_STORAGE_CONNECTOR_ISSUER;
    if (!issuer || issuer.length < 32 || !env.CLUED_STORAGE_VAULT_KEYS) return { status: "unavailable" };
    const issuerHash = await sha256(issuer);
    const rpc = async (input: Record<string, unknown>) => await supabaseRequest(env, "/rest/v1/rpc/clued_storage_refresh_worker_v1", {
      method: "POST", body: JSON.stringify({ p_issuer_hash: issuerHash, p_input: input }),
      signal: AbortSignal.timeout(10000), redirect: "manual",
    }) as Record<string, unknown>;
    if (storageDemandPolicy.idle_scheduler_enabled) return runStorageDemandRenewalScheduled({
      client_id:env.CLUED_STORAGE_GOOGLE_CLIENT_ID??"",client_secret:env.CLUED_STORAGE_GOOGLE_CLIENT_SECRET??"",
      vault:JSON.parse(env.CLUED_STORAGE_VAULT_KEYS),refresh_rpc:rpc,
    });
    const due = await rpc({ action: "due" });
    if (!Array.isArray(due.connections) || due.connections.length > 10 || !due.connections.every(c => typeof c === "string")) return { status: "unavailable" };
    // BUG-20261007-005: a refresh held back by an unresolved journal on its root
    // is no longer silent. Scheduled recovery settles the journal (and may run a
    // recovery-only refresh); until then reads fail once the token expires.
    if (Number.isSafeInteger(due.root_busy) && Number(due.root_busy) > 0)
      console.warn(JSON.stringify({ event: "storage_refresh_root_busy", connections: Number(due.root_busy) }));
    const pendingExpired=Number.isSafeInteger(due.pending_expired) && Number(due.pending_expired)>0 ? Number(due.pending_expired) : 0;
    if (due.connections.length===0) return {status:pendingExpired?"attention_required":"ok",committed:0,unavailable:pendingExpired};
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
  if (!storageScheduleEnabled.recovery(env)) return { status: "disabled" };
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
    const absentRpc = async (input: Record<string, unknown>) => await supabaseRequest(env,
      "/rest/v1/rpc/clued_storage_recovery_absent_v1", {
        method: "POST", body: JSON.stringify({ p_issuer_hash: issuerHash, p_input: input }),
        signal: AbortSignal.timeout(10000), redirect: "manual",
      }) as Record<string, unknown>;
    const reportDiagnostic = async (reference: StorageJobReference, diagnostic: RecoveryDiagnostic) => {
      const reported = await recoveryRpc({ ...reference, action: "report", diagnostic });
      if (reported.status !== "recorded" || reported.connection_id !== reference.connection_id ||
          reported.job_id !== reference.job_id || reported.execution_permitted !== false) throw new Error("diagnostic unavailable");
    };
    const due = await recoveryRpc({ action: "due" });
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (due.status !== "ok" || !Array.isArray(due.jobs) || due.jobs.length > 3 ||
        !due.jobs.every(job => job && typeof job === "object" &&
          Object.keys(job).sort().join(",") === "connection_id,job_id" &&
          typeof job.connection_id === "string" && uuid.test(job.connection_id) &&
          typeof job.job_id === "string" && uuid.test(job.job_id))) return { status: "unavailable" };
    const refresher = env.CLUED_STORAGE_REFRESH_V1 === "true" && due.jobs.length ? await createStorageGoogleRefresh({
      client_id: env.CLUED_STORAGE_GOOGLE_CLIENT_ID ?? "", client_secret: env.CLUED_STORAGE_GOOGLE_CLIENT_SECRET ?? "",
      vault: JSON.parse(env.CLUED_STORAGE_VAULT_KEYS),
      rpc: async input => await supabaseRequest(env, "/rest/v1/rpc/clued_storage_refresh_worker_v1", {
        method: "POST", body: JSON.stringify({ p_issuer_hash: issuerHash, p_input: input }),
        signal: AbortSignal.timeout(10000), redirect: "manual",
      }) as Record<string, unknown> }).catch(() => null) : null;
    let committed = 0, released = 0, reconciled = 0, attention = 0;
    for (const reference of due.jobs as Array<{ connection_id: string; job_id: string }>) {
      let stage: RecoveryStage = "descriptor";
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
          stage = "settlement";
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
        let refreshReference = reference;
        const attempt = async () => {
          const descriptor = await recoveryRpc({ ...reference, action: "load" });
          if (descriptor.status !== "recovery_only" || descriptor.connection_id !== reference.connection_id ||
              descriptor.job_id !== reference.job_id) throw new Error("recovery descriptor unavailable");
          refreshReference = storageRecoveryRefreshReference(descriptor, reference);
          const recovery = await createStorageCloudRecovery({
            client_id: env.CLUED_STORAGE_GOOGLE_CLIENT_ID ?? "", vault: JSON.parse(env.CLUED_STORAGE_VAULT_KEYS!),
            rpc: recoveryRpc, verified: { descriptor, rpc: verifiedRpc }, absent: { rpc: absentRpc }, report_expiring: true, timeout_ms: 10000,
            report_diagnostic: reportDiagnostic, current_registration: { rpc: recoveryRpc },
          });
          return await recovery.run(reference);
        };
        let result = await attempt();
        // BUG-20261007-005: an expiring credential gets one recovery-only refresh
        // bound to this job (the root's ordinary refresh waits for a quiet root).
        if (result.status === "credential_expiring" && refresher &&
            (await refresher.run(refreshReference.connection_id, refreshReference.job_id)).status === "committed") result = await attempt();
        if (result.status === "committed") committed++;
        else if (result.status === "released_not_effected") released++;
        else if (result.status === "resolved") reconciled++;
        else attention++;
      } catch (error) {
        attention++;
        try { await reportDiagnostic(reference, recoveryDiagnostic(stage, error)); } catch { /* The same job stays due. */ }
      }
    }
    if (released) console.warn(JSON.stringify({ event: "storage_recovery_released_not_effected", released }));
    return { status: attention ? "attention_required" : "ok", committed, released,
      ...(reconciled ? { reconciled } : {}), attention };
  } catch { return { status: "unavailable" }; }
}

// A normal authenticated refusal can wake the same bounded durable recovery
// scan as cron. Caller-supplied references never select a privileged recovery
// target. Database due-time reservations coordinate concurrent Workers; this
// WeakMap merely coalesces overlapping wakes in one isolate.
const storageRecoveryWakes = new WeakMap<ContinuityEnv, Promise<unknown>>();
function wakeStorageRecovery(env: ContinuityEnv, ctx?: ContinuityExecutionContext) {
  if (!ctx) return;
  let pending = storageRecoveryWakes.get(env);
  if (!pending) {
    pending = runStorageRecoveryScheduled(env).finally(() => storageRecoveryWakes.delete(env));
    storageRecoveryWakes.set(env, pending);
  }
  ctx.waitUntil(pending);
}

// Storage fix (Owner Decision d9d6db4c): a started journal with no recorded
// provider attempt never reached Drive (every effect records its attempt first,
// and the record is refused once the journal is no longer started). The
// database cancels such journals once their admission has expired, so a
// failure before the effect no longer fences the root. Database only: no Drive
// call, no credential, and not gated on the executor switch.
export async function runStorageUnattemptedReleaseScheduled(env: ContinuityEnv):
    Promise<{ status: "disabled" | "unavailable" } | { status: "ok"; released: number }> {
  if (!storageScheduleEnabled.unattemptedRelease(env)) return { status: "disabled" };
  try {
    const issuer = env.CLUED_STORAGE_CONNECTOR_ISSUER;
    if (!issuer || issuer.length < 32) return { status: "unavailable" };
    const result = await supabaseRequest(env, "/rest/v1/rpc/clued_storage_release_unattempted_v1", {
      method: "POST", body: JSON.stringify({ p_issuer_hash: await sha256(issuer), p_input: { action: "release" } }),
      signal: AbortSignal.timeout(10000), redirect: "manual",
    }) as Record<string, unknown>;
    const released = result.released;
    if (result.status !== "ok" || typeof released !== "number" || !Number.isSafeInteger(released) || released < 0 || released > 3)
      return { status: "unavailable" };
    return { status: "ok", released };
  } catch { return { status: "unavailable" }; }
}

export async function fetchWorkerDue(env: ContinuityEnv): Promise<unknown> {
  const token = databaseGatewayToken(env);
  if (!token) throw new Error("worker_due_gateway_unconfigured");
  return supabaseRequest(env, "/rest/v1/rpc/clued_worker_due_v1", {
    method: "POST", body: JSON.stringify({ p_token_hash: await sha256(token) }),
    signal: AbortSignal.timeout(10_000), redirect: "manual",
  });
}

// One Builder per isolate. Only flags cross request boundaries. The event that
// started the pipeline owns its I/O and keeps it alive through waitUntil.
let refreshRunning = false;
let refreshRequested = false;

export async function wakeProjectionRefresh(env: ContinuityEnv) {
  if (refreshRunning) {
    refreshRequested = true;
    return;
  }
  refreshRunning = true;
  try {
    do {
      refreshRequested = false;
      await runProjectionRefreshPipeline(env);
    } while (refreshRequested);
  } finally {
    refreshRunning = false;
  }
}

function mayInvalidateApprovedProjection(request: Request) {
  if (!["POST", "PATCH", "DELETE"].includes(request.method)) return false;
  const path = new URL(request.url).pathname;
  return path === "/v1/projects" || path.startsWith("/v1/projects/") ||
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
  if (!token) throw new HttpError(503, "BeamingFace P5 gateway is not configured.");
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
    throw new HttpError(502, "BeamingFace P5 gateway returned an invalid response.");
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
  throw new HttpError(409, "BeamingFace P5 attempt replay could not be resolved.", {
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

function storageOnboardEnabled(env: ContinuityEnv) {
  return env.CLUED_STORAGE_ACCOUNT_V1 === "true" && env.CLUED_STORAGE_GOOGLE_V1 === "true" && env.CLUED_STORAGE_ONBOARD_V1 === "true";
}
/** Browser Picker configuration, or null when the Owner has not configured it. */
export function storagePickerConfiguration(env: ContinuityEnv) {
  const apiKey = env.CLUED_STORAGE_GOOGLE_PICKER_API_KEY ?? "", appId = env.CLUED_STORAGE_GOOGLE_CLOUD_PROJECT_NUMBER ?? "";
  const clientId = env.CLUED_STORAGE_GOOGLE_CLIENT_ID ?? "";
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(apiKey) || !/^[0-9]{6,20}$/.test(appId) || !/^[A-Za-z0-9._-]{1,255}$/.test(clientId)) return null;
  return { api_key: apiKey, app_id: appId, client_id: clientId };
}
async function storageOnboardRuntime(env: ContinuityEnv, token: string) {
  const issuer = env.CLUED_STORAGE_CONNECTOR_ISSUER;
  if (!issuer || issuer.length < 32 || !env.CLUED_STORAGE_VAULT_KEYS) throw new Error("Unavailable");
  const rpc = async (value: Record<string, unknown>) => await supabaseRequest(env, "/rest/v1/rpc/clued_storage_onboard_v1", {
    method: "POST", userToken: token, redirect: "manual", signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ p_issuer_secret: issuer, p_input: value }),
  }) as Record<string, unknown>;
  const onboard = await createStorageGoogleOnboard({ client_id: env.CLUED_STORAGE_GOOGLE_CLIENT_ID ?? "",
    client_secret: env.CLUED_STORAGE_GOOGLE_CLIENT_SECRET ?? "", redirect_uri: env.CLUED_STORAGE_GOOGLE_REDIRECT_URI ?? "",
    vault: JSON.parse(env.CLUED_STORAGE_VAULT_KEYS), rpc, picker_configured: storagePickerConfiguration(env) !== null,
    refresh_available: env.CLUED_STORAGE_REFRESH_V1 === "true" });
  return { rpc, onboard };
}

async function requireSupabaseUser(request: Request, env: ContinuityEnv) {
  const token = bearerToken(request);
  if (!token || token.startsWith("clued_bnd_")) {
    throw new HttpError(401, "A signed-in BeamingFace account is required.");
  }
  const user = (await supabaseRequest(env, "/auth/v1/user", {
    method: "GET",
    userToken: token,
  })) as AuthenticatedUser;
  if (!user?.id) throw new HttpError(401, "The BeamingFace session is invalid.");
  return { user, token };
}

async function storageOwnerLifecycleRuntime(env: ContinuityEnv, token: string) {
  const issuer = env.CLUED_STORAGE_CONNECTOR_ISSUER;
  if (!issuer || issuer.length < 32 || !env.CLUED_STORAGE_VAULT_KEYS) throw new Error("Unavailable");
  const vault = JSON.parse(env.CLUED_STORAGE_VAULT_KEYS);
  const oauth = await createStorageGoogleOAuth({
    client_id: env.CLUED_STORAGE_GOOGLE_CLIENT_ID ?? "",
    client_secret: env.CLUED_STORAGE_GOOGLE_CLIENT_SECRET ?? "",
    redirect_uri: env.CLUED_STORAGE_GOOGLE_REDIRECT_URI ?? "", vault,
    rpc: async value => await supabaseRequest(env, "/rest/v1/rpc/clued_storage_oauth_v1", {
      method: "POST", userToken: token, redirect: "manual", signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ p_issuer_hash: await sha256(issuer), p_input: value }),
    }) as Record<string, unknown>,
  });
  const ownerRpc=async (value:Record<string,unknown>) => await supabaseRequest(env, "/rest/v1/rpc/clued_storage_owner_lifecycle_v1", {
      method: "POST", userToken: token, redirect: "manual", signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ p_issuer_hash: await sha256(issuer), p_input: value }),
    }) as Record<string,unknown>;
  const demand=await storageDemandRuntime(env,request=>ownerRpc({action:"prepare_credential",connection_id:request.connection_id,operation:request.operation}));
  return createStorageOwnerLifecycle({ vault, oauth, rpc:ownerRpc,
    credential_preflight:demand ? (owner,connection,operation)=>demand.owner(owner,connection,operation) : undefined,
  });
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
      "Read public Clued connection metadata and the full BeamingFace Agent Contract in content[1]. When agent_contract.parts is above 1, read every part in order before work. This call never returns user context or credentials.",
    inputSchema: {
      type: "object",
      properties: {
        part: { type: "integer", minimum: 1, description: "Contract part to read, starting at 1; omit to read the full contract or its first part. Read all reported parts in order." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_session_resume",
    description:
      "Call at the start of every authorized session. Restores the latest canonical Clued checkpoint plus subsequent events, provenance, version and the next expected action. Resident constraints come as an index by default (id, title, scope, version, updated_at and a one-line summary; summary_is_full_text marks a summary that is the whole text). Before acting in an area a constraint covers, read its full text by resuming with constraint_ids.",
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
        event_order: {
          type: "string",
          enum: ["newest", "oldest"],
          default: "newest",
          description: "Order of unabsorbed events: newest first (default) or oldest first. Page with event_cursor set to the returned next_cursor in the same order.",
        },
        event_cursor: { type: "integer", minimum: 0, default: 0 },
        event_limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
        event_budget_bytes: { type: "integer", minimum: 4096, maximum: 262144, default: 65536 },
        constraint_view: {
          type: "string",
          enum: ["index", "full"],
          default: "index",
          description: "index returns each resident constraint as an index entry; full returns every constraint's full text.",
        },
        constraint_ids: {
          type: "array",
          items: { type: "string", format: "uuid" },
          maxItems: 50,
          uniqueItems: true,
          description: "Resident constraints to return in full inside an index response. Ids that are not resident constraints you may read are ignored.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_append_event",
    description:
      "Legacy continuity adapter for action, failure, blocker and note events. It rejects decision, correction and retraction events with decision_event_requires_record: record an Owner decision with clued_record_mutate (or clued_decision_supersede), correct a record with clued_record_mutate update, and clear an active event with clued_event_carrier_transition. Use clued_event_append for extension events.",
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
        context_key: {
          type: "string", minLength: 1, maxLength: 160,
          description:
            "Context the session was resumed with. Omit it to use the session's own context; a different value is rejected with session_context_mismatch.",
        },
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
      "Set or cancel the Owner-selected current focus for one eligible Universal Intake Task using explicit user confirmation, exact Task-version CAS, Event, Receipt, and projection invalidation. There is one focus per user: a set must name the focus it replaces in expected_current_focus_id (null when no focus is expected) and is rejected with owner_pin_focus_conflict, which returns the current focus, when that is not the current focus. Use it only when the Owner chooses a new focus; parallel work is claimed with clued_work_claim, never pinned. " +
      "Operation custom_priority_set sets the Owner's custom priority of one active record (priority 0-100, 0 clears it); record writes cannot set priority. " +
      "Use it only when the Owner explicitly asks for that priority, never on your own judgement, and send the Owner's own words in owner_instruction. " +
      "base_version is then the record's custom priority version, 0 when it has none; custom_priority_version_conflict returns the current value and version. " +
      "The value adds 0.3 x priority to the automatic MTPE score and puts the record first in record lists; the Owner sees it came from you and can undo it.",
    inputSchema: {
      type: "object",
      required: ["operation", "record_id", "base_version", "idempotency_key", "user_confirmed"],
      properties: {
        operation: { type: "string", enum: ["set", "cancel", "custom_priority_set"] },
        record_id: { type: "string", format: "uuid" },
        base_version: {
          type: "integer", minimum: 0,
          description: "set and cancel: the Task's record version (1 or more). custom_priority_set: the record's custom priority version, 0 when it has none.",
        },
        priority: {
          type: "integer", minimum: 0, maximum: 100,
          description: "custom_priority_set only: the custom priority the Owner asked for; 0 clears it.",
        },
        owner_instruction: {
          type: "string", minLength: 1, maxLength: 2000,
          description: "custom_priority_set only, required: the Owner's own words asking for this priority.",
        },
        expected_current_focus_id: {
          anyOf: [{ type: "string", format: "uuid" }, { type: "null" }],
          description: "Required on set: the record_id of the current Owner focus, or null when there is none. Read it from clued_mtpe_snapshot owner_selected_current_focus.",
        },
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
        context_key: {
          type: "string",
          description:
            "Context the session was resumed with. Omit it to use the session's own context; a different value is rejected with session_context_mismatch.",
        },
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
            binding_events: {
              type: "string",
              const: "all",
              description: "Also absorb every unabsorbed event this Binding wrote in this context, without listing each id.",
            },
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
      "Search authorized current context and events with deterministic term matching (whole query first, then at least 60% of its terms, or every term of a one-term query; Chinese is split into two-character terms). Without context_key, or with scope=all, every readable project and Global are searched; a context_key alone searches that scope only, and scope=context without context_key searches the session's own context. No match is not evidence that a record does not exist. Superseded history is excluded unless explicitly requested. Page with cursor set to page.next_cursor; paging stops at 10000 results (page.cursor_limit_reached), so narrow the query instead. A context_key other than the session's own context is refused with session_context_mismatch.",
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
        cursor: { type: "integer", minimum: 0, maximum: 10000, default: 0 },
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
      "Read recent receipts, compliance and fixed-watermark journal pages. Typed clock_open and clock_seal persist bounded private queue observations and create a new epoch or seal on each call. Clock pages read a fixed seal. These observations do not establish source acceptance or official metrics.",
    inputSchema: {
      type: "object",
      properties: {
        context_key: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        measurement: {
  "oneOf": [
    {"type":"object","properties":{"after_sequence":{"type":"integer","minimum":0,"maximum":9007199254740991},"end_sequence":{"type":"integer","minimum":0,"maximum":9007199254740991},"stream_id":{"type":"string","format":"uuid"},"limit":{"type":"integer","minimum":1,"maximum":500,"default":100}},"additionalProperties":false},
    {"type":"object","required":["operation","queue_ref"],"properties":{"operation":{"const":"clock_open"},"queue_ref":{"type":"string","pattern":"^merge:[a-z0-9_.-]+/[a-z0-9_.-]+:[a-z0-9_.-]+$"}},"additionalProperties":false},
    {"type":"object","required":["operation","queue_ref","epoch_id","pins"],"properties":{"operation":{"const":"clock_seal"},"queue_ref":{"type":"string","pattern":"^merge:[a-z0-9_.-]+/[a-z0-9_.-]+:[a-z0-9_.-]+$"},"epoch_id":{"type":"string","format":"uuid"},"pins":{"type":"object","required":["epoch_id","stream_id","clock_generation_id","foundation_digest","catalog_digest"],"properties":{"epoch_id":{"type":"string","format":"uuid"},"stream_id":{"type":"string","format":"uuid"},"clock_generation_id":{"type":"string","format":"uuid"},"foundation_digest":{"type":"string","pattern":"^[0-9a-f]{64}$"},"catalog_digest":{"type":"string","pattern":"^[0-9a-f]{64}$"}},"additionalProperties":false}},"additionalProperties":false},
    {"type":"object","required":["operation","queue_ref","seal_id","pins","seal_pins"],"properties":{"operation":{"const":"clock_page"},"queue_ref":{"type":"string","pattern":"^merge:[a-z0-9_.-]+/[a-z0-9_.-]+:[a-z0-9_.-]+$"},"seal_id":{"type":"string","format":"uuid"},"pins":{"type":"object","required":["epoch_id","stream_id","clock_generation_id","foundation_digest","catalog_digest"],"properties":{"epoch_id":{"type":"string","format":"uuid"},"stream_id":{"type":"string","format":"uuid"},"clock_generation_id":{"type":"string","format":"uuid"},"foundation_digest":{"type":"string","pattern":"^[0-9a-f]{64}$"},"catalog_digest":{"type":"string","pattern":"^[0-9a-f]{64}$"}},"additionalProperties":false},"seal_pins":{"type":"object","required":["end_sequence","closing_us","catalog_digest"],"properties":{"end_sequence":{"type":"integer","minimum":0,"maximum":9007199254740991},"closing_us":{"type":"string","pattern":"^-?[0-9]{1,19}$"},"catalog_digest":{"type":"string","pattern":"^[0-9a-f]{64}$"}},"additionalProperties":false},"after_sequence":{"type":"integer","minimum":0,"maximum":999999,"default":0},"limit":{"type":"integer","minimum":1,"maximum":500,"default":100}},"additionalProperties":false}
  ]
},
      },
      additionalProperties: false,
    },
  },
  ...projectTools,
  ...recordTools,
  ...informationFlowTools,
  ...p5Tools,
  ...contextTools,
  ...workClaimTools,
  ...ownerRequestTools,
  ...agentMessageTools,
  ...integrationTools,
  ...modelDomainTools,
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
    scopes: ["audit:read"], readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
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
  ...workClaimToolPolicies,
  ...ownerRequestToolPolicies,
  ...agentMessageToolPolicies,
  ...integrationToolPolicies,
  ...modelDomainToolPolicies,
} as const satisfies Record<PublicToolName, PublicToolPolicy>;

// The same annotations are published by tools/list. callTool has already
// enforced this deployment's feature and authorization checks before a wake.
const projectionWriteTools = new Set<string>([
  ...Object.entries(publicToolPolicies).filter(([, policy]) => !policy.readOnlyHint).map(([name]) => name),
  ...[...storageAgentTools, storageUploadBeginTool].filter(tool => !tool.annotations.readOnlyHint).map(tool => tool.name),
]);

export function isProjectionWriteTool(name: unknown) {
  return typeof name === "string" && projectionWriteTools.has(name);
}

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

export function publicMcpTools(env: Pick<ContinuityEnv, "PROJECT_VIEWS_V2" | "P5_TENANT_WRITES" | "CLUED_WORK_CLAIMS_V1" | "CLUED_OWNER_REQUESTS_V1" | "CLUED_AGENT_MESSAGES_V1" | "CLUED_DEVELOPMENT_CONTEXT_V14" | "CLUED_STORAGE_ACCOUNT_V1" | "CLUED_STORAGE_JOBS_V1" | "CLUED_STORAGE_GOOGLE_V1" | "CLUED_STORAGE_READ_V1" | "CLUED_STORAGE_JOBS_V2" | "CLUED_STORAGE_BINARY_V1" | "CLUED_INTEGRATION_RUNTIME_V1" | "CLUED_MODEL_DOMAIN_SOURCE_V1" | "CLUED_MODEL_DOMAIN_BOOTSTRAP_REQUEST_V1">) {
  const existing = tools.filter((tool) =>
    (!(tool.name in recordRpcByTool || tool.name in informationFlowRpcByTool) || recordsV2Enabled(env))
    && (!(tool.name in p5RpcByTool) || p5TenantWritesEnabled(env))
    && (!(tool.name in contextRpcByTool) || contextsEnabled(env))
    && (!(tool.name in workClaimRpcByTool) || workClaimsEnabled(env))
    && (tool.name !== OWNER_REQUEST_TOOL || ownerRequestsEnabled(env))
    && (!(tool.name in agentMessageRpcByTool) || agentMessagesEnabled(env))
    && (!isIntegrationTool(tool.name) || integrationRuntimeEnabled(env))
    && (!isModelDomainTool(tool.name) || (recordsV2Enabled(env) && modelDomainSourceEnabled(env)))
    && ((tool.name !== MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL && tool.name !== MODEL_DOMAIN_BOOTSTRAP_COMMIT_TOOL) ||
      (modelDomainBootstrapRequestEnabled(env) && ownerRequestsEnabled(env)))
  ).map(publishTool);
  const binary = storageBinaryEnabled(env);
  return [...existing, ...(storageJobsEnabled(env) ? storageAgentToolsFor(binary) : []), ...(binary ? [storageUploadBeginTool] : []),
    ...(storageReadEnabled(env) ? [storageReadTool, storageContentTool] : []),
    // Owner Decision 1721045d: where every storage tool's connection_id comes from.
    ...(storageJobsEnabled(env) || storageReadEnabled(env) ? [storageConnectionsTool] : [])];
}

// StorageFullCapability.v0.1 P1. Independent of the write/job flags: turning
// reads on or off never changes the write tools, and vice versa.
function storageReadEnabled(env: Pick<ContinuityEnv, "CLUED_STORAGE_ACCOUNT_V1" | "CLUED_STORAGE_GOOGLE_V1" | "CLUED_STORAGE_READ_V1">) {
  return env.CLUED_STORAGE_ACCOUNT_V1 === "true" && env.CLUED_STORAGE_GOOGLE_V1 === "true" && env.CLUED_STORAGE_READ_V1 === "true";
}

async function callStorageRead(request: Request, env: ContinuityEnv, args: unknown, tool: "browse" | "content") {
  const token = bearerToken(request);
  if (!token || !/^clued_bnd_[A-Za-z0-9_-]{32,}$/.test(token)) throw new StorageReadError("storage_read_unavailable");
  const issuer = env.CLUED_STORAGE_CONNECTOR_ISSUER;
  if (!issuer || issuer.length < 32 || !env.CLUED_STORAGE_VAULT_KEYS || !env.CLUED_STORAGE_READ_RECEIPT_KEYS || !env.CLUED_STORAGE_READ_CURSOR_KEY)
    throw new StorageReadError("storage_read_unavailable");
  const issuerHash = await sha256(issuer);
  let agent: Awaited<ReturnType<typeof createStorageReadAgent>>;
  try {
    const demand=await storageDemandRuntime(env,async request=>{
      const {caller_kind,token_hash,owner_id,...input}=request;
      void caller_kind;void owner_id;
      return await supabaseRequest(env,"/rest/v1/rpc/clued_storage_read_v1",{
        method:"POST",body:JSON.stringify({p_issuer_hash:issuerHash,p_token_hash:token_hash,p_input:{...input,action:"prepare_credential"}}),
        signal:AbortSignal.timeout(10000),redirect:"manual",
      }) as Record<string,unknown>;
    });
    agent = await createStorageReadAgent({ client_id: env.CLUED_STORAGE_GOOGLE_CLIENT_ID ?? "", vault: JSON.parse(env.CLUED_STORAGE_VAULT_KEYS),
      receipt_keys: JSON.parse(env.CLUED_STORAGE_READ_RECEIPT_KEYS), cursor_key: env.CLUED_STORAGE_READ_CURSOR_KEY,
      // §4.5: PDFs are parsed only by the extractor Worker behind this service binding.
      pdf_extractor: env.PDF_EXTRACTOR,
      credential_preflight:demand ? input=>demand.agent(input) : undefined,
      rpc: async ({ token_hash, input }) => await supabaseRequest(env, "/rest/v1/rpc/clued_storage_read_v1", {
        method: "POST", body: JSON.stringify({ p_issuer_hash: issuerHash, p_token_hash: token_hash, p_input: input }),
        signal: AbortSignal.timeout(10000), redirect: "manual",
      }) as Record<string, unknown> });
  } catch (error) {
    if (error instanceof StorageReadError) throw error;
    throw new StorageReadError("storage_read_unavailable");
  }
  return agent.run(await sha256(token), args, tool);
}

async function callStorageJob(request: Request, env: ContinuityEnv, input: Record<string, unknown>, ctx?: ContinuityExecutionContext,
  projectResult: (value: unknown, input: Record<string, unknown>) => unknown = value => value) {
  if (!storageJobsEnabled(env)) throw new HttpError(404, "Storage jobs are disabled.");
  const token = bearerToken(request);
  if (!token || !/^clued_bnd_[A-Za-z0-9_-]{32,}$/.test(token)) throw new HttpError(403, "A valid Clued Binding is required.");
  const jobsRpc=env.CLUED_STORAGE_JOBS_V2==="true"
    ? "clued_storage_jobs_router_v2" : "clued_storage_jobs_v1";
  let raw: unknown;
  try {
    raw = await supabaseRequest(env, `/rest/v1/rpc/${jobsRpc}`, {
      method: "POST", body: JSON.stringify({ p_token_hash: await sha256(token), p_input: input }),
    });
  } catch (error) {
    if (storageObjectReviewCode(error)) {
      wakeStorageRecovery(env, ctx);
      return storageObjectReviewRefusal();
    }
    throw error;
  }
  if (raw && typeof raw === "object" && "status" in raw && raw.status === "rejected" &&
      "error_code" in raw && raw.error_code === "storage_object_under_review") {
    wakeStorageRecovery(env, ctx);
    return storageObjectReviewRefusal();
  }
  if (input.action === "inspect" && raw && typeof raw === "object" &&
      "automatic_recovery" in raw && raw.automatic_recovery === "pending") wakeStorageRecovery(env, ctx);
  const result = projectResult(raw && typeof raw === "object" && ("status" in raw && raw.status === "conflict" ||
    "reason_code" in raw && ["PROVIDER_STATE_CONFLICT", "PROVIDER_RESULT_RECONCILED"].includes(String(raw.reason_code)))
    ? storageAgentResult(raw, input) : raw, input);
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
  ...workClaimRpcByTool,
  ...agentMessageRpcByTool,
} as const;


const RECORD_TYPE_REQUIRED_FIELDS: Readonly<Record<string, { field: string; error: string }>> = {
  decision: { field: "rationale", error: "decision_rationale_required" },
  state: { field: "state_kind", error: "state_state_kind_required" },
  task: { field: "execution_bucket", error: "task_execution_bucket_required" },
  profile_fact: { field: "fact_kind", error: "profile_fact_fact_kind_required" },
  note: { field: "note_kind", error: "note_note_kind_required" },
};

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
  const required = RECORD_TYPE_REQUIRED_FIELDS[typeof input.record_type === "string" ? input.record_type : ""];
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
        type_specific_fields: RECORD_TYPE_REQUIRED_FIELDS,
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
    throw new HttpError(401, "Authorize with BeamingFace OAuth or a Clued Binding Token.");
  }
  const supplied = typeof args === "object" && args ? args : {};
  // Hosts append reserved MCP annotations inside tool arguments. They are
  // transport context, never work-claim intent, authority or receiving proof
  // (nor part of an Owner Pin or custom priority request).
  // Keep the business RPC's strict allowlist and every other argument intact.
  const payload = (name in workClaimRpcByTool || name === "clued_mtpe_owner_pin") && !Array.isArray(supplied)
    ? Object.fromEntries(Object.entries(supplied).filter(([key]) => key !== "_meta"))
    : supplied;
  if (name === "clued_record_list") validateRecordListInput(payload);
  if (name === "clued_event_carrier_transition") validateEventCarrierTransitionInput(payload);
  if (name === "clued_record_mutate") validateRecordMutationInput(payload);

  if (name in contextRpcByTool) {
    if (!contextsEnabled(env)) throw new HttpError(404, "Development context is disabled.");
    if (!token.startsWith("clued_bnd_")) throw new HttpError(403, "Use an explicitly consented BeamingFace connection for development operations.");
    const contextInput = { mode: "ordinary", ...payload };
    return await supabaseRequest(env, "/rest/v1/rpc/clued_development_call_v14", {
      method: "POST",
      body: JSON.stringify({ p_token_hash: await sha256(token), p_input: contextInput }),
    });
  }

  if (name in p5RpcByTool) {
    if (!p5TenantWritesEnabled(env)) {
      throw new HttpError(404, "BeamingFace P5 tenant writes are disabled.");
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
  resume_required_or_session_expired:
    "Use session_renewal.session_token from your last committed checkpoint if you have it; otherwise call clued_session_resume and retry with the returned session_token.",
  session_not_found: "Call clued_session_resume and retry with the returned session_token.",
  session_context_mismatch:
    "This session_token was resumed with a different context_key. Omit context_key to use the session's own context, or pass the context_key you resumed with; to work in another context, resume with that context_key.",
  requested_context_not_authorized:
    "context_key must be \"global\" or \"project:<canonical_project_id>\", not a bare project ID. Retry with the prefixed key.",
  checkpoint_event_not_authorized:
    "coverage.event_ids may list only events of this checkpoint's context_key. Checkpoint each context separately: resume with that context's context_key (for example project:<id> for project-scope writes), reconcile, then checkpoint with the same context_key and its own event ids.",
  decision_event_requires_record:
    "clued_append_event no longer accepts decision, correction or retraction events: they withhold every State/Task/Decision record of their scope until materialized. Record an Owner decision with clued_record_mutate (operation create, record_type decision) or replace one with clued_decision_supersede; correct a record with clued_record_mutate update; clear an existing active event with clued_event_carrier_transition. Do not resend it as another event type.",
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
  // IntegrationRuntime §11.2 (rule codes only; the authorization codes stay HTTP 403)
  ...INTEGRATION_REQUEST_RULE_REJECTIONS,
};

// BUG-20261001-001: Hosts discard JSON-RPC data on non-200 responses. Project
// only server-defined paths/codes; never forward a body, value or raw details.
function recordValidationRejection(error: unknown) {
  if (!(error instanceof HttpError) || error.status !== 422) return null;
  const details = error.details as Record<string, unknown> | null | undefined;
  if (details?.error_code !== "INVALID_RECORD_FIELDS") return null;
  const missingFields = new Set(["operation", "record_type", "mutation", "source_refs", "source_unavailable_reason"]);
  const invalidFields = new Map([
    ["source_refs", "must_be_array"],
    ["mutation", "must_be_object"],
    ["mutation.type_fields", "must_be_object"],
    ["user_confirmed", "authority_escalation_forbidden"],
    ...Object.values(RECORD_TYPE_REQUIRED_FIELDS).map(({ field, error }) =>
      [`mutation.type_fields.${field}`, error] as [string, string]),
  ]);
  const invalid = Array.isArray(details.invalid_fields) ? details.invalid_fields.flatMap(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const { field, error } = item as Record<string, unknown>;
    return typeof field === "string" && typeof error === "string" && invalidFields.get(field) === error
      ? [{ field, error }] : [];
  }) : [];
  return {
    status: "rejected",
    error: {
      code: "INVALID_RECORD_FIELDS",
      category: "request_validation",
      message: "Record mutation has invalid fields; fix the listed fields and retry once.",
      missing_fields: Array.isArray(details.missing_fields)
        ? details.missing_fields.filter((field): field is string => typeof field === "string" && missingFields.has(field)) : [],
      invalid_fields: invalid,
      ...(details.create_contract ? { create_contract: { type_specific_fields: RECORD_TYPE_REQUIRED_FIELDS } } : {}),
      ...(invalid.some(item => item.error === "authority_escalation_forbidden") ? {
        hint: "authority=user_explicit requires user_confirmed=true, which records that the main claim is the Owner's own words in this conversation; do not ask the Owner again. Otherwise use observed/inferred.",
      } : {}),
    },
  };
}

// PermissionSimplification §3.2: the connection lacks a context or action the
// call needs. Returned as a tool error carrying what to request; a revoked or
// expired connection stays an HTTP 403, since only reconnecting helps there.
// Only the typed SQL target-denial code suppresses unsafe resource guessing.
function clockAuditTargetRejection(error: unknown, name: string, args: unknown) {
  if (!(error instanceof HttpError) || error.status !== 403 ||
    (error.details as Record<string, unknown> | null | undefined)?.code !== "42501") return null;
  if (name === "clued_audit_receipts" && error.message === "clock_transport_contributor_not_authorized") {
    const measurement = args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>).measurement : undefined;
    const operation = measurement && typeof measurement === "object" && !Array.isArray(measurement)
      ? (measurement as Record<string, unknown>).operation : undefined;
    if (["clock_open", "clock_seal", "clock_page"].includes(String(operation))) {
      return { status: "rejected", error: { code: "clock_target_permission_denied", category: "permission",
        message: "This connection cannot read the complete requested queue observation. The missing contributing permission cannot be inferred safely from this call. Review this exact target with the Owner; no broader permission is suggested." } };
    }
  }
  return null;
}
async function permissionRejection(error: unknown, name: string, args: unknown,
  request: Request, env: ContinuityEnv) {
  const clockDenial = clockAuditTargetRejection(error, name, args);
  if (clockDenial) return clockDenial;
  if (!(error instanceof HttpError) || error.status !== 403) return null;
  const details = error.details as Record<string, unknown> | null | undefined;
  if (details?.code !== "42501") return null;
  if (error.message !== "binding_not_authorized" && error.message !== "resource_action_not_authorized") return null;
  if (error.message === "binding_not_authorized") {
    // resolve_binding uses this code for both a missing permission and a
    // dead/unknown Binding. Only a live connection can request more access.
    // Delegated OAuth has already replaced its bearer with this Binding.
    const token = bearerToken(request);
    if (!token?.startsWith("clued_bnd_")) return null;
    let status: unknown;
    try {
      status = await supabaseRequest(env, "/rest/v1/rpc/clued_authorization_status_v12", {
        method: "POST", body: JSON.stringify({ p_token_hash: await sha256(token) }),
        signal: AbortSignal.timeout(10000), redirect: "manual",
      });
    } catch {
      throw new HttpError(503, "Connection authorization status is unavailable.");
    }
    const active = status && typeof status === "object" && !Array.isArray(status)
      ? (status as Record<string, unknown>).active : undefined;
    if (active === false) throw new HttpError(403, "authorization_revoked_or_expired", { code: "42501" });
    if (active !== true) throw new HttpError(503, "Connection authorization status is unavailable.");
  }
  const policy = publicToolPolicies[name as keyof typeof publicToolPolicies] as { scopes: readonly string[] } | undefined;
  return permissionDenial(error.message, name, args, policy ? policy.scopes : null);
}

// Search re-review (Task f46591b2): clued_search_context refuses malformed
// input with SQLSTATE 22023, which PostgREST answers with HTTP 400. Without
// this the Agent got a transport failure with no hint; now it is a tool error
// with a fixed message.
const SEARCH_INPUT_REJECTIONS: Readonly<Record<string, string>> = {
  invalid_query_length: "query must be 1 to 500 characters.",
  invalid_search_scope: "scope must be \"all\" or \"context\". It is the search mode; name a context with context_key.",
  invalid_page_input: "include_history must be a boolean, and limit, cursor and max_bytes integers.",
  search_cursor_too_deep: "cursor may be at most 10000. Narrow the query instead of paging further.",
  project_scope_unresolved: "context_key names a project that does not resolve to one current project. Use project:<canonical_project_id>, or search without context_key.",
};

function searchInputRejection(error: unknown, name: string) {
  if (name !== "clued_search_context" || !(error instanceof HttpError) || error.status !== 400) return null;
  const details = error.details as Record<string, unknown> | null | undefined;
  if (details?.code !== "22023" || !Object.prototype.hasOwnProperty.call(SEARCH_INPUT_REJECTIONS, error.message)) return null;
  return {
    status: "rejected",
    error: { code: error.message, category: "request_validation", message: SEARCH_INPUT_REJECTIONS[error.message] },
  };
}

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
      message: "The request was refused by a BeamingFace contract rule; reconnecting will not change the outcome.",
      ...(hint ? { hint } : {}),
    },
  };
}

// OwnerCredential §3.2: an Agent (Binding) creates or reads its own request.
// Account and legacy OAuth tokens are refused: a request names the Binding
// that asked, and delegated OAuth already arrives here as its Binding.
async function callOwnerRequest(request: Request, env: ContinuityEnv, args: unknown) {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, "Authorize with BeamingFace OAuth or a Clued Binding Token.");
  if (!token.startsWith("clued_bnd_")) throw new HttpError(403, "Owner requests require a Clued Agent Binding.");
  let result: unknown;
  try {
    const call = ownerRequestCall(args);
    result = await supabaseRequest(env, `/rest/v1/rpc/${call.rpc}`, {
      method: "POST",
      body: JSON.stringify({ p_token_hash: await sha256(token), p_input: call.input }),
    });
  } catch (error) {
    const rejection = error instanceof OwnerRequestInputError
      ? { status: "rejected", error_code: error.message }
      : error instanceof HttpError ? ownerRequestRejection(error.status, error.message) : null;
    if (!rejection) throw error;
    return { content: [{ type: "text", text: JSON.stringify(rejection) }], structuredContent: rejection, isError: true };
  }
  const body = withConfirmUrl(sanitizeCluedResult(result), new URL(request.url).origin);
  const status = (body as Record<string, unknown> | null)?.status;
  return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body,
    isError: status === "rejected" || status === "failed" };
}

// Model Program source integration. This is an exact candidate dispatch call site,
// independent of rpcByTool: no private alias or arbitrary caller-selected RPC.
// The source-only fixed Owner-anchor read uses this same Request/Binding chain
// and returns the ordinary readonly envelope; it never calls submitOwnerRequest.
async function callModelDomainTool(request: Request, env: ContinuityEnv,
  name: ModelDomainToolName, args: unknown) {
  if (!recordsV2Enabled(env) || !modelDomainSourceEnabled(env) ||
    ((name === MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL || name === MODEL_DOMAIN_BOOTSTRAP_COMMIT_TOOL) &&
      (!modelDomainBootstrapRequestEnabled(env) || !ownerRequestsEnabled(env)))) {
    throw new HttpError(404, "Unknown BeamingFace continuity tool.");
  }
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, "Authorize with a Clued Binding Token.");
  if (!token.startsWith("clued_bnd_")) throw new HttpError(403, "Model domain sources require the existing Clued Binding.");
  const tokenHash = await sha256(token);
  try {
    const result = await dispatchModelDomainTool(env, name, args, {
      rpc: async (rpc, input) => {
        try {
          return await supabaseRequest(env, `/rest/v1/rpc/${rpc}`, {
            method: "POST", body: JSON.stringify({ p_token_hash: tokenHash, p_input: input }),
          });
        } catch (error) {
          // A known SQL exception from this exact owned PostgREST invocation
          // proves the database transaction rolled back. A bare HTTP status,
          // network error or 5xx response cannot establish completion.
          const details = error instanceof HttpError && error.details &&
            typeof error.details === "object" && !Array.isArray(error.details)
            ? error.details as Record<string, unknown> : null;
          if (rpc === "clued_model_dataset_split_bootstrap_commit_candidate" &&
            error instanceof HttpError && error.status >= 400 && error.status < 500 &&
            (details?.code === "42501" || details?.code === "22023")) {
            throw new BootstrapExecutionDenied();
          }
          throw error;
        }
      },
      // The same Request, bearer and environment enter the existing Native
      // request path. There is no caller token, actor or confirmation proof.
      submitOwnerRequest: async (input) => await callOwnerRequest(request, env, input),
    });
    if (name === MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL) return result;
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false };
  } catch (error) {
    if (error instanceof BootstrapExecutionDenied) {
      const result = { status: "rejected", error_code: "BOOTSTRAP_DATABASE_TRANSACTION_REJECTED",
        completion_unknown: false, retry_allowed: false };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: true };
    }
    if (error instanceof BootstrapCompletionUnknown) {
      const result = { status: "unknown", error_code: "BOOTSTRAP_COMPLETION_UNVERIFIED",
        completion_unknown: true, retry_allowed: false };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: true };
    }
    if (error instanceof BootstrapInputDenied) throw new HttpError(400, "Exact DatasetSplit bootstrap input required.");
    if (error instanceof BootstrapReadinessDenied) throw new HttpError(403, "DatasetSplit bootstrap readiness denied or unavailable. Reason: " + error.reason + ".");
    if (error instanceof ModelDomainToolDenied) throw new HttpError(403, "Model domain source denied or unavailable.");
    throw error;
  }
}

// IntegrationRuntime §12.3: Binding channel only (a clued_bnd_ token, else 403). The RPCs authenticate
// the token hash themselves. A rule rejection, before or inside the Receipt, renders as one
// request_rule shape; authorization denials stay HTTP 403; a Receipt-level conflict is retryable.
async function callIntegrationTool(request: Request, env: ContinuityEnv, name: IntegrationToolName, args: unknown) {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, "Authorize with BeamingFace OAuth or a Clued Binding Token.");
  if (!token.startsWith("clued_bnd_")) throw new HttpError(403, "Integration operations require a Clued Agent Binding.");
  const tokenHash = await sha256(token);
  // The transport facts the Canonical baseline checks (CRV-3) come from this request, never from the
  // caller: an absent MCP-Protocol-Version header means 2025-03-26 (MCP Streamable HTTP).
  const transport = { protocol_version: request.headers.get("mcp-protocol-version") ?? "2025-03-26",
    build_sha: buildSourceCommit() };
  let result: unknown;
  try {
    let previous: Record<string, unknown> | null = null;
    for (const call of integrationCalls(name, args, transport)) {
      const input = "request_id" in call.input && call.input.request_id === null
        ? { ...call.input, request_id: previous?.request_id ?? null } : call.input;
      result = await supabaseRequest(env, `/rest/v1/rpc/${call.rpc}`, {
        method: "POST", body: JSON.stringify({ p_token_hash: tokenHash, p_input: input }),
      });
      previous = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : null;
    }
  } catch (error) {
    const rejection = requestRuleRejection(error);
    if (!rejection) throw error;
    return { content: [{ type: "text", text: JSON.stringify(rejection) }], structuredContent: rejection, isError: true };
  }
  const body = integrationRuleEnvelope(sanitizeCluedResult(result), REQUEST_RULE_REJECTIONS);
  const status = (body as Record<string, unknown> | null)?.status;
  return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body,
    isError: status === "rejected" || status === "failed" };
}

// IntegrationRuntime §12.4 Native REST: account JWT only, every route forwards to
// clued_user_integration_v1; flag off → 404. Path parameters override body fields.
async function handleIntegrationApi(request: Request, env: ContinuityEnv) {
  // flag off: 404 before anything else, including the origin check (§12.4)
  if (!integrationRuntimeEnabled(env)) return json({ error: "Not found." }, 404);
  validateOrigin(request, env);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
  const url = new URL(request.url);
  const route = integrationNativeRoute(request.method, url.pathname);
  if (!route) return json({ error: "Not found." }, 404, corsHeaders(request));
  const { token } = await requireSupabaseUser(request, env);
  const body = route.method === "POST" ? await parseBody(request) : {};
  const input = { ...body, ...(route.bind ?? {}), op: route.op };
  let result: unknown;
  try {
    result = await supabaseRequest(env, "/rest/v1/rpc/clued_user_integration_v1", {
      method: "POST", userToken: token, body: JSON.stringify({ p_input: input }),
    });
  } catch (error) {
    // A rule raised before the Receipt is the same 422 as one inside it, never an authorization 403.
    const rejection = requestRuleRejection(error);
    if (!rejection) throw error;
    return json(rejection, 422, corsHeaders(request));
  }
  return json(result, integrationHttpStatus(result), corsHeaders(request));
}

async function callTool(
  request: Request,
  env: ContinuityEnv,
  name: unknown,
  args: unknown,
  ctx?: ContinuityExecutionContext,
) {
  if (name === storageConnectionsTool.name) {
    // Lists only the classes whose tools this deployment offers.
    const offered = { reads: storageReadEnabled(env), writes: storageJobsEnabled(env) };
    if (!offered.reads && !offered.writes) throw new HttpError(404, "Storage is disabled.");
    try {
      storageConnectionsInput(args);
      const token = bearerToken(request);
      if (!token || !/^clued_bnd_[A-Za-z0-9_-]{32,}$/.test(token)) throw new StorageConnectionsError("storage_connections_unavailable");
      const result = storageConnectionsResult(await supabaseRequest(env, "/rest/v1/rpc/clued_storage_connections_v1", {
        method: "POST", body: JSON.stringify({ p_token_hash: await sha256(token) }), signal: AbortSignal.timeout(10000), redirect: "manual",
      }), offered);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false };
    } catch (error) {
      // Fixed codes only: a denied or unknown Binding and a database failure read the same.
      const code = error instanceof StorageConnectionsError ? error.code : "storage_connections_unavailable";
      const result = { error: code, message: storageConnectionsMessages[code] };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: true };
    }
  }
  if (name === storageReadTool.name || name === storageContentTool.name) {
    if (!storageReadEnabled(env)) throw new HttpError(404, "Storage reads are disabled.");
    try {
      const result = await callStorageRead(request, env, args, name === storageContentTool.name ? "content" : "browse");
      // StorageNormalUse §5.1: an image read appends one MCP image item after the metadata text.
      const image = (result as Record<PropertyKey, unknown>)[STORAGE_IMAGE] as { data: string; mimeType: string } | undefined;
      return { content: [{ type: "text", text: JSON.stringify(result) },
        ...(image ? [{ type: "image", data: image.data, mimeType: image.mimeType }] : [])], structuredContent: result, isError: false };
    } catch (error) {
      // Fixed codes only: no provider text, IDs, paths, credentials or database details.
      const code = error instanceof StorageReadError ? error.code : "storage_read_unavailable";
      const result = { error: code, message: code === "not_found_in_scope"
        ? "Not found inside the authorized root. This is not proof that it does not exist."
        : code === "cursor_invalid" ? "The cursor is invalid or expired. Start the listing or search again."
        : code === "storage_read_input_invalid" ? `Invalid input for ${String(name)}.`
        : code === "format_unsupported" ? "This object has no readable content: folders are never read, and without the Owner's normal use only text files and Google Docs are."
        : code === "document_invalid" ? "The file is damaged or not what its type says (for example an encrypted Office file, a password-protected PDF, or an XML part with a DOCTYPE). Retrying will not help."
        : code === "archive_limit_exceeded" ? "The file exceeds a safety limit for Office or PDF files (parts, entries, decompressed size, or more than 8 MiB of extracted text in one call). Retrying will not help."
        : code === "binary_too_large" ? "Reading this file would download more than 32 MiB in one call. Retrying will not help."
        : code === "export_too_large" ? "The Google Doc is larger than the 10 MB export limit."
        : code === "shortcut_not_followed" ? "Shortcuts are not followed. Read the target file inside the root instead."
        : code === "content_not_accessible" ? "This file's content is not readable with the current Google permission."
        : code === "scope_upgrade_required" ? "Reading files BeamingFace did not create, and searching by content, need the Owner to turn on normal use on the BeamingFace storage page. Retrying will not help."
        : code === "budget_exhausted" ? "This connection has used its hourly content budget (by default 256 MiB per rolling hour per authorized client and 1 GiB per account; only the Owner can change them, on the BeamingFace storage page; reserved before each body request and settled to the bytes returned). Try again later; retrying now will not help."
        : code === "request_limit_exceeded" ? "This large Office file needs more provider requests than one call may make. Retrying will not help; read an earlier or shorter range (a smaller offset + length), since each call extracts the text up to offset + length."
        : "Storage read unavailable.",
        // A fixed hint and a page number (StorageNormalUse §4.5: PDF time cut on a continuation).
        ...(error instanceof StorageReadError && error.detail ? { hint: error.detail.hint,
          ...(error.detail.next_page_start !== undefined ? { next_page_start: error.detail.next_page_start } : {}) } : {}) };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: true };
    }
  }
  if (name === storageUploadBeginTool.name) {
    if (!storageBinaryEnabled(env)) throw new HttpError(404, "Storage binary upload is disabled.");
    try {
      const token = bearerToken(request);
      if (!token || !/^clued_bnd_[A-Za-z0-9_-]{32,}$/.test(token)) throw new StorageUploadError("storage_binary_upload_disabled");
      const result = await uploadBegin(await stagingRuntime(env), await sha256(token), args, new URL(request.url).origin);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false };
    } catch (error) {
      // Fixed codes only: no database, provider, key or path details.
      const result = uploadErrorBody(stagingErrorCode(error));
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: true };
    }
  }
  if (name === "clued_storage_trash_batch") {
    if (!storageJobsEnabled(env)) throw new HttpError(404, "Storage jobs are disabled.");
    // StorageFullCapability P5 (Decision 7f9daf68): one Owner-confirmed batch of trash/untrash items.
    // Only registers a pending batch; never dispatches execution.
    try {
      const input = storageTrashBatchInput(args);
      const token = bearerToken(request);
      if (!token || !/^clued_bnd_[A-Za-z0-9_-]{32,}$/.test(token)) throw new HttpError(403, "A valid Clued Binding is required.");
      let result = storageTrashBatchResult(await supabaseRequest(env, "/rest/v1/rpc/clued_storage_trash_batch_v1", {
        method: "POST", body: JSON.stringify({ p_token_hash: await sha256(token), p_input: input }),
      }), input);
      // A Work Claim refusal (GenericWorkClaim §4.2) is a structured tool error: no batch exists.
      // A conflict says how to reach its holder.
      if (agentMessagesEnabled(env)) result = withCoordinationHint(result) as typeof result;
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: result.status === "rejected" };
    } catch (error) {
      if (storageObjectReviewCode(error)) {
        const result = storageObjectReviewRefusal();
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: true };
      }
      const pathCode = storagePathCode(error);
      const message = error instanceof Error ? error.message : "";
      const result = pathCode ? { error: pathCode, message: storagePathMessages[pathCode] }
        : message === "storage_trash_batch_item_unavailable"
          ? { error: "storage_trash_batch_item_unavailable", message: "An item does not match a BeamingFace-registered item that can be moved to (or out of) the trash at that path, Drive file ID and version. Stat each item again; leave out the root, tracks, non-empty directories and governance files without delete authority." }
          : message === "storage_trash_batch_pending_limit"
            ? { error: "storage_trash_batch_pending_limit", message: "This client registration already has 5 batches waiting for the Owner on this connection. Ask the user to confirm or let them expire before registering another; put every remaining item in one batch." }
          : message === "storage_trash_batch_conflict"
            ? { error: "storage_trash_batch_conflict", message: "This batch_id already names a batch with other items. Use a new batch_id for a different list." }
            : { error: "storage_trash_batch_unavailable", message: "Storage trash batch unavailable. Send the same batch_id and items again to read its status." };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: true };
    }
  }
  if (isStorageAgentTool(name)) {
    if (!storageJobsEnabled(env)) throw new HttpError(404, "Storage jobs are disabled.");
    let binary = false;
    try {
      // clued_storage_upload_begin was routed above; only submit and inspect reach this point.
      let input = storageAgentInput(name as "clued_storage_submit" | "clued_storage_inspect", args);
      const m = input.mutation as Record<string, unknown> | undefined;
      binary = !!m && ("staging_id" in m || "content_base64" in m);
      if (binary) {
        if (!storageBinaryEnabled(env)) throw new StorageUploadError("storage_binary_upload_disabled");
        if ("content_base64" in m!) {
          const token = bearerToken(request);
          if (!token || !/^clued_bnd_[A-Za-z0-9_-]{32,}$/.test(token)) throw new StorageUploadError("storage_binary_upload_disabled");
          // The inline staging_id is derived from (Binding, connection, job_id) by the database, so a
          // retry of the same job reuses its row (ready / consumed) instead of staging an orphan.
          const staged = await stageInline(await stagingRuntime(env), await sha256(token), {
            connection_id: String(input.connection_id), job_id: String(input.job_id),
            destination_path: String(m!.destination_path), mime_type: String(m!.mime_type),
            content_sha256: String(m!.content_sha256), content_base64: m!.content_base64 });
          const { content_base64: _inline, ...rest } = m!;
          void _inline;
          input = { ...input, mutation: { ...rest, staging_id: staged.staging_id } };
        }
      }
      let result = await callStorageJob(request, env, input, ctx, storageAgentResult) as Record<string, unknown>;
      // A Work Claim refusal (GenericWorkClaim §4.2) is a structured tool error: no job exists, nothing is dispatched.
      // A conflict says how to reach its holder.
      if (agentMessagesEnabled(env)) result = withCoordinationHint(result) as Record<string, unknown>;
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: result.status === "rejected" };
    } catch (error) {
      if (binary) {
        const code = stagingErrorCode(error);
        if (code !== "storage_upload_unavailable") {
          const result = uploadErrorBody(code);
          return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: true };
        }
      }
      // A refused path is a fixed code decided before any job exists (Worker syntax or database canonicalization).
      const pathCode = storagePathCode(error);
      if (pathCode) {
        const result = { error: pathCode, message: storagePathMessages[pathCode] };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: true };
      }
      // The trash limit (StorageFullCapability §3.4 item 4) is a fixed refusal decided before any job exists.
      const destructiveCode = storageDestructiveCode(error);
      if (destructiveCode) {
        const result = { error: destructiveCode, message: storageDestructiveMessages[destructiveCode] };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: true };
      }
      // Adopt (P7): the full-scope requirement and an already registered item are fixed refusals before any job exists.
      const adoptCode = storageAdoptCode(error);
      if (adoptCode) {
        const result = { error: adoptCode, message: storageAdoptMessages[adoptCode] };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: true };
      }
      // No provider, issuer, credentials, paths or database diagnostics in errors.
      const result = { error: "storage_job_unavailable", message: "Storage job unavailable. Check the same job ID; do not create another job to retry an unknown effect." };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: true };
    }
  }
  if (name === "clued_agent_bootstrap") {
    const result = bootstrapContract(new URL(request.url).origin, env);
    const part = args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>).part : undefined;
    return renderAgentContractBootstrap(result, {
      markdown: AGENT_CONTRACT_MARKDOWN, version: AGENT_CONTRACT_VERSION, sha256: AGENT_CONTRACT_SHA256,
    }, part);
  }
  if (typeof name === "string" && (name in recordRpcByTool || name in informationFlowRpcByTool) &&
    !recordsV2Enabled(env)) {
    throw new HttpError(404, "BeamingFace project views v2 are disabled.");
  }
  if (typeof name === "string" && name in p5RpcByTool && !p5TenantWritesEnabled(env)) {
    throw new HttpError(404, "BeamingFace P5 tenant writes are disabled.");
  }
  if (typeof name === "string" && name in workClaimRpcByTool && !workClaimsEnabled(env)) {
    throw new HttpError(404, "BeamingFace work claims are disabled.");
  }
  if (typeof name === "string" && name in agentMessageRpcByTool && !agentMessagesEnabled(env)) {
    throw new HttpError(404, "BeamingFace agent messages are disabled.");
  }
  if (isModelDomainTool(name)) return await callModelDomainTool(request, env, name, args);
  if (name === OWNER_REQUEST_TOOL) {
    if (!ownerRequestsEnabled(env)) throw new HttpError(404, "BeamingFace owner requests are disabled.");
    return await callOwnerRequest(request, env, args);
  }
  if (isIntegrationTool(name)) {
    // flag off: the name is unknown, exactly like any other (IntegrationRuntime §13.8 T-W-2)
    if (!integrationRuntimeEnabled(env)) throw new HttpError(404, "Unknown BeamingFace continuity tool.");
    return await callIntegrationTool(request, env, name, args);
  }
  if (typeof name !== "string" || !(name in rpcByTool)) {
    throw new HttpError(404, "Unknown BeamingFace continuity tool.");
  }
  let rawResult: unknown;
  try {
    rawResult = await callRpc(request, env, name as keyof typeof rpcByTool, args);
  } catch (error) {
    const denial = await permissionRejection(error, name, args, request, env);
    if (denial) return permissionDenialResult(denial);
    const rejection = (name === "clued_record_mutate" ? recordValidationRejection(error) : null)
      ?? searchInputRejection(error, name) ?? requestRuleRejection(error);
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
  const sanitized = name in contextRpcByTool ? sanitizeContextResult(rawResult) : sanitizeCluedResult(rawResult, name);
  const sourceCommit = buildSourceCommit();
  const gated = name === "clued_currentness_g6_gate" &&
    (sanitized as Record<string, unknown> | null)?.status === "transport_precheck_ready"
    ? sourceCommit
      ? { ...(sanitized as Record<string, unknown>), status: "closed" }
      : { status: "not_ready", gate: "G6_CURRENTNESS",
          missing_requirements: ["all_path_checkpoint_enforcement"] }
    : sanitized;
  // The two fold-in reads (live claims, inbox summary) are independent: start
  // the inbox read first so both run concurrently, one serial step after the RPC.
  const base = withAuthorityCapture(name, gated);
  const inbox = startAgentInboxSummary(request, env, name, args, base);
  const captured = await withAgentMessages(env, name, await withWorkClaims(request, env, name, args, base), inbox);
  const result = name in workClaimRpcByTool ? withConfirmUrl(captured, new URL(request.url).origin, "owner_request") : captured;
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
    isError: measurementRefused || Boolean((result as Record<string, unknown> | null)?.error) ||
      writeRefused(name, result),
  };
}

// BUG-20261007-001: a write the database rejected or failed is an M1 envelope
// ({status, error_code}, HTTP 200, no `error`); over MCP it is a tool error, as
// on REST (m1HttpStatus). Only the top-level status counts, by exact value: a
// verdict such as mtpe_validate "fail" or a rejected item inside a listing is
// not a refusal. The export carries its Receipt nested. Work claims and agent
// messages keep their structured-result refusals (Task 934d981c).
function writeRefused(name: string, result: unknown): boolean {
  if (name in workClaimRpcByTool || name in agentMessageRpcByTool) return false;
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const body = result as Record<string, unknown>;
  const receipt = name === "clued_canonical_export" && body.receipt && typeof body.receipt === "object"
    ? body.receipt as Record<string, unknown> : null;
  const status = receipt ? receipt.status : body.status;
  return status === "rejected" || status === "failed";
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

// Work Claim Admission v0.1 §4.2: contract version/hash are returned on every
// successful resume. Only the live-claims read is gated by CLUED_WORK_CLAIMS_V1;
// its failure is reported in the result, never thrown into the resume.
async function callWorkClaimsActive(request: Request, env: ContinuityEnv, scope: string) {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, "Authorize with BeamingFace OAuth or a Clued Binding Token.");
  const input = { scope };
  if (!token.startsWith("clued_bnd_")) {
    return await supabaseRequest(env, "/rest/v1/rpc/clued_oauth_call", {
      method: "POST",
      userToken: token,
      body: JSON.stringify({ p_tool: WORK_CLAIMS_ACTIVE_OAUTH_TOOL, p_input: input }),
    });
  }
  return await supabaseRequest(env, `/rest/v1/rpc/${WORK_CLAIMS_ACTIVE_RPC}`, {
    method: "POST",
    body: JSON.stringify({ p_token_hash: await sha256(token), p_input: input }),
  });
}

function withComponentVersions(name: string, value: unknown): unknown {
  if (name !== "clued_session_resume" || !value || typeof value !== "object" || Array.isArray(value)) return value;
  if ((value as Record<string, unknown>).error) return value;
  return { ...(value as Record<string, unknown>), clued_components: cluedComponents(),
    contract_version: AGENT_CONTRACT_VERSION, agent_contract_sha256: AGENT_CONTRACT_SHA256 };
}

async function withWorkClaims(request: Request, env: ContinuityEnv, name: string, args: unknown, raw: unknown): Promise<unknown> {
  const value = withComponentVersions(name, raw);
  if (name !== "clued_session_resume" || !workClaimsEnabled(env)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>).error) return value;
  const scope = args && typeof args === "object" && !Array.isArray(args)
    && typeof (args as Record<string, unknown>).context_key === "string"
    ? (args as Record<string, string>).context_key : "global";
  let claims: unknown = null;
  try {
    claims = sanitizeCluedResult(await callWorkClaimsActive(request, env, scope), WORK_CLAIMS_ACTIVE_OAUTH_TOOL);
  } catch {
    claims = null;
  }
  return withWorkClaimContext(value, AGENT_CONTRACT_VERSION, claims);
}

// Agent Messaging v0.1: what other Agents sent this caller. A failed summary
// read is reported in the result, never thrown into the call it is folded into.
async function callAgentInboxSummary(request: Request, env: ContinuityEnv, input: Record<string, unknown>) {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, "Authorize with BeamingFace OAuth or a Clued Binding Token.");
  if (!token.startsWith("clued_bnd_")) {
    return await supabaseRequest(env, "/rest/v1/rpc/clued_oauth_call", {
      method: "POST",
      userToken: token,
      body: JSON.stringify({ p_tool: AGENT_INBOX_SUMMARY_OAUTH_TOOL, p_input: input }),
    });
  }
  return await supabaseRequest(env, `/rest/v1/rpc/${AGENT_INBOX_SUMMARY_RPC}`, {
    method: "POST",
    body: JSON.stringify({ p_token_hash: await sha256(token), p_input: input }),
  });
}

function stringArg(args: unknown, key: string): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

// Resume: agent_inbox for this session (client_session_id), every context the
// connection reads. Renewal: agent_inbox for the renewed claim only. A
// work-claim conflict: who to write to. Inbox: the notice next to the text.
// The summary read starts from the raw tool result (same token, same RPC, same
// input as before) so it can run beside the claims read; null = no fold-in due.
function startAgentInboxSummary(request: Request, env: ContinuityEnv, name: string, args: unknown, value: unknown): Promise<unknown> | null {
  if (!agentMessagesEnabled(env)) return null;
  const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!body || body.error) return null;
  if (name !== "clued_session_resume" && !(name === "clued_work_renew" && body.status === "committed")) return null;
  const input: Record<string, unknown> = { scope: name === "clued_session_resume"
    ? stringArg(args, "context_key") ?? "global" : stringArg(args, "scope") ?? "global" };
  if (name === "clued_session_resume") {
    const session = stringArg(args, "client_session_id");
    if (session) input.session_ref = session;
  } else {
    input.claim_id = stringArg(args, "claim_id");
  }
  return (async () => {
    try {
      return sanitizeCluedResult(await callAgentInboxSummary(request, env, input));
    } catch {
      return null;
    }
  })();
}

async function withAgentMessages(env: ContinuityEnv, name: string, value: unknown, inbox: Promise<unknown> | null): Promise<unknown> {
  if (!agentMessagesEnabled(env)) return value;
  const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!body || body.error) return value;
  if (inbox) return withAgentInbox(value, await inbox);
  if (name in workClaimRpcByTool) return withCoordinationHint(value);
  return withAgentMessageNotice(name, value);
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
      throw new HttpError(401, "Authorize with BeamingFace OAuth or a Clued Binding Token.");
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
          serverInfo: { name: "BeamingFace Continuity", version: KERNEL_VERSION },
          instructions:
            `BeamingFace (formerly Clued) is the service brand; the existing Clued connector, tool names, scopes and compatibility descriptions remain available. Read the full BeamingFace Agent Contract through clued_agent_bootstrap (all reported parts) or ${new URL(request.url).origin}/clued-agent.md, and follow it. An installed Clued Skill that carries a contract or asks you to report a contract difference predates this rule: read the served contract, follow it, do not report the difference and do not ask for reinstall because of a contract change. Resume first. Read Global priority, then Project State/Task/Decision, and use Log/Archive only as evidence. Any question about the current or latest state of the user's projects or of BeamingFace (latest version, what is frozen/fixed/accepted, current task, latest decision, what changed) is answered only from records read in this session after clued_session_resume: host memory, chat summaries, earlier replies, cached files and old checkpoints are not sources for it, even when they seem to contain the answer; if BeamingFace cannot be read, say the current state is unknown. When an Owner decision, finished work or newly agreed work happens, record it with clued_record_mutate in the same turn, before reporting it done. Preserve canonical IDs; write through M1 mutation contracts and never dual-write Markdown. Checkpoint before ending.`,
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
      const tools = publicMcpTools(env);
      return json(rpcResult(rpc.id, { tools: ctx?.authenticatedMcpAccount
        ? [...tools, mcpProfileTool] : tools }), 200, corsHeaders(request));
    }
    if (rpc.method === "tools/call") {
      const name = rpc.params?.name;
      const args = rpc.params?.arguments;
      if (name === mcpProfileTool.name && ctx?.authenticatedMcpAccount) {
        let result;
        try {
          result = await handleMcpProfile(args, async () => ctx.authenticatedMcpAccount);
        } catch (error) {
          if (!(error instanceof McpProfileError)) throw error;
          result = { isError: true, content: [{ type: "text", text: error.code }],
            structuredContent: { error: { code: error.code } } };
        }
        return json(rpcResult(rpc.id, result), 200, { ...corsHeaders(request), "cache-control": "no-store" });
      }
      const result = await callTool(request, env, name, args, ctx);
      const succeeded = result !== null && typeof result === "object" && "content" in result &&
        (!("isError" in result) || result.isError === false);
      if (ctx && succeeded && isProjectionWriteTool(name) && projectionBuilderToken(env)) {
        ctx.waitUntil(wakeProjectionRefresh(env));
      }
      return json(rpcResult(rpc.id, withCanonicalMcpError(result)), 200, {
        ...corsHeaders(request), ...(isStorageAgentTool(name) || name === storageUploadBeginTool.name || name === storageReadTool.name || name === storageContentTool.name ||
          name === storageConnectionsTool.name ? { "cache-control": "no-store" } : {}),
      });
    }
    return json(rpcError(rpc.id, -32601, "Method not found"), 404, corsHeaders(request));
  } catch (error) {
    const problem = error instanceof HttpError ? error : new HttpError(500, "BeamingFace continuity failed.");
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
  let rpcValue: unknown;
  try { rpcValue = await callRpc(request, env, tool, input); }
  catch (error) {
    const clockDenial = clockAuditTargetRejection(error, tool, input);
    if (clockDenial) return json(clockDenial, 403, corsHeaders(request));
    throw error;
  }
  const result = await withWorkClaims(request, env, tool, input,
    withAuthorityCapture(tool, sanitizeCluedResult(rpcValue, tool)));
  return json(result, 200, corsHeaders(request));
}

async function callUserProjectRpc(
  request: Request,
  env: ContinuityEnv,
  rpc: "clued_user_project_list_v2" | "clued_user_project_mutate_v2",
  input: Record<string, unknown>,
  receivedPayloadHash?: string,
  trace?: NativeReadTrace | null,
) {
  let token: string;
  trace?.stage("auth_started");
  try {
    ({ token } = await requireSupabaseUser(request, env));
    trace?.stage("auth_completed");
  } catch (error) {
    trace?.stage("auth_failed");
    throw error;
  }
  trace?.stage("rpc_started");
  try {
    const result = await supabaseRequest(env, `/rest/v1/rpc/${rpc}`, {
      method: "POST",
      userToken: token,
      body: JSON.stringify(receivedPayloadHash
        ? { p_input: input, p_received_payload_hash: receivedPayloadHash }
        : { p_input: input }),
    });
    trace?.stage("rpc_completed");
    return result;
  } catch (error) {
    trace?.stage("rpc_failed");
    throw error;
  }
}

async function handleProjectApi(request: Request, env: ContinuityEnv, trace?: NativeReadTrace | null) {
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
    return json(await callUserProjectRpc(request, env, "clued_user_project_list_v2", input, undefined, trace), 200, corsHeaders(request));
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
    throw new HttpError(404, "BeamingFace project views v2 are disabled.");
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
      sanitizeCluedResult(await callUserRecordRpc(request, env, "clued_user_record_list", input), "clued_record_list"),
      200,
      corsHeaders(request),
    );
  }
  if (url.pathname === "/v1/records" && request.method === "POST") {
    const { input, receivedPayloadHash } = await parseCanonicalBody(request);
    const result = await callUserRecordRpc(request, env, "clued_user_record_mutate", input, receivedPayloadHash);
    return json(sanitizeCluedResult(result, "clued_record_mutate"), m1HttpStatus(result), corsHeaders(request));
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
    return json(sanitizeCluedResult(result, url.pathname === "/v1/export" ? "clued_canonical_export" : undefined),
      m1HttpStatus(result), corsHeaders(request));
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
    throw new HttpError(401, "A signed-in BeamingFace account is required.");
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
    throw new HttpError(404, "BeamingFace project views v2 are disabled.");
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
  trace?: NativeReadTrace | null,
): Promise<Response | null> {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/healthz" && request.method === "GET") {
      const sourceCommit = buildSourceCommit();
      return json({
        status: "ok",
        service: "clued-continuity",
        version: KERNEL_VERSION,
        components: CLUED_COMPONENT_VERSIONS,
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
    // StorageNormalUse N3 signed upload URL: the HMAC token is the only credential (no Binding bearer).
    if (url.pathname.startsWith("/storage/staging/")) {
      if (!storageBinaryEnabled(env)) return json({ error: "not_found" }, 404, { "cache-control": "no-store" });
      let runtime: Awaited<ReturnType<typeof stagingRuntime>> | null = null;
      try { runtime = await stagingRuntime(env); } catch { runtime = null; }
      return await handleStagingPut(request, runtime, url.pathname.slice("/storage/staging/".length));
    }
    if (url.pathname === "/v1/storage/recovery") {
      validateOrigin(request, env);
      // Recovery remains available when new jobs/execution are disabled. It is
      // native Owner only; credential renewal is confined to the original
      // unsettled job. It never enters the normal executor or replays an effect.
      const headers = { ...corsHeaders(request), "cache-control": "no-store" };
      if (env.CLUED_STORAGE_ACCOUNT_V1 !== "true" || env.CLUED_STORAGE_GOOGLE_V1 !== "true") return json({ error: "Not found." }, 404, headers);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, { ...headers, allow: "POST, OPTIONS" });
      const { token } = await requireSupabaseUser(request, env);
      let recoveryReference: { connection_id: string; job_id: string } | undefined;
      let originalOwnerStatus: Record<string, unknown> | undefined;
      let reportRecoveryDiagnostic: ((reference: { connection_id: string; job_id: string }, diagnostic: RecoveryDiagnostic) => Promise<void>) | undefined;
      let inspectOriginalRecovery: (() => Promise<Record<string, unknown>>) | undefined;
      let originalReviewInput: Record<string, unknown> | undefined;
      let reviewMutationDispatched = false;
      let recoveryStage: RecoveryStage = "request";
      try {
        const input = await parseBody(request), issuer = env.CLUED_STORAGE_CONNECTOR_ISSUER;
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
        const finalReview = input.action === "review_accept" || input.action === "review_abandon";
        const reviewKeys = ["action", "connection_id", "job_id", "base_version", "source_receipt_id", "confirmed", "observation_id"];
        if (typeof input.action !== "string" || !["list", "inspect", "settle", "review_prepare", "review_accept", "review_abandon"].includes(input.action) ||
            typeof input.connection_id !== "string" || !uuid.test(input.connection_id) || !issuer || issuer.length < 32 ||
            (input.action === "list" ? Object.keys(input).length !== 2 : typeof input.job_id !== "string" || !uuid.test(input.job_id)) ||
            (finalReview ? Object.keys(input).some(key => !reviewKeys.includes(key)) || input.confirmed !== true ||
              !Number.isSafeInteger(input.base_version) || Number(input.base_version) < 1 || !uuid.test(String(input.source_receipt_id)) ||
              (input.action === "review_accept" || input.observation_id !== undefined) && !uuid.test(String(input.observation_id))
              : input.action !== "list" && Object.keys(input).length !== 3)) throw new Error("Unavailable");
        if (finalReview) originalReviewInput = structuredClone(input);
        const issuerHash = await sha256(issuer);
        const rpc = async (value: Record<string, unknown>) => await supabaseRequest(env, "/rest/v1/rpc/clued_storage_native_recovery_v1", {
          method: "POST", userToken: token, redirect: "manual", signal: AbortSignal.timeout(10000),
          body: JSON.stringify({ p_issuer_hash: issuerHash, p_input: value }),
        }) as Record<string, unknown>;
        if (input.action === "list") return json(storageRecoveryListResult(
          await rpc({ action: "recovery_list", connection_id: input.connection_id }), input.connection_id), 200, headers);
        const reference = { connection_id: input.connection_id, job_id: input.job_id as string };
        recoveryReference = reference;
        inspectOriginalRecovery = async () => storageRecoveryOwnerResult(await rpc({ ...reference, action: "recovery_inspect" }), reference);
        const ownerStatus = await inspectOriginalRecovery();
        originalOwnerStatus = ownerStatus;
        reportRecoveryDiagnostic = async (pinned, diagnostic) => {
          const result = await supabaseRequest(env, "/rest/v1/rpc/clued_storage_scheduled_recovery_v2", {
            method: "POST", redirect: "manual", signal: AbortSignal.timeout(10000),
            body: JSON.stringify({ p_issuer_hash: issuerHash, p_input: { ...pinned, action: "report", diagnostic } }),
          }) as Record<string, unknown>;
          if (result.status !== "recorded" || result.connection_id !== pinned.connection_id ||
              result.job_id !== pinned.job_id || result.execution_permitted !== false) throw new Error("diagnostic unavailable");
        };
        const matchesReview = (result: Record<string, unknown>) => result.status === "resolved" &&
          result.resolution === (input.action === "review_accept" ? "accepted_current_state" : "abandoned_registration") &&
          result.source_receipt_id === input.source_receipt_id && result.base_version === input.base_version &&
          (result.observation_id ?? null) === (input.observation_id ?? null);
        let refreshAttempted = false, refreshReference = reference;
        const refreshOriginalOnce = async () => {
          if (refreshAttempted || env.CLUED_STORAGE_REFRESH_V1 !== "true" || !env.CLUED_STORAGE_VAULT_KEYS) return false;
          refreshAttempted = true;
          try {
            const refresh = await createStorageGoogleRefresh({ client_id: env.CLUED_STORAGE_GOOGLE_CLIENT_ID ?? "",
              client_secret: env.CLUED_STORAGE_GOOGLE_CLIENT_SECRET ?? "", vault: JSON.parse(env.CLUED_STORAGE_VAULT_KEYS),
              rpc: async value => await supabaseRequest(env, "/rest/v1/rpc/clued_storage_refresh_worker_v1", {
                method: "POST", body: JSON.stringify({ p_issuer_hash: issuerHash, p_input: value }), redirect: "manual", signal: AbortSignal.timeout(10000),
              }) as Record<string, unknown> });
            return (await refresh.run(refreshReference.connection_id, refreshReference.job_id)).status === "committed";
          } catch { return false; }
        };
        let reviewOwnerStatus = ownerStatus;
        const readOwnerReview = async (revalidate?: { observation_id: string; base_version: number; source_receipt_id: string }): Promise<Record<string, unknown>> => {
          const attempt = async () => {
            if (reviewOwnerStatus.status === "resolved") return reviewOwnerStatus;
            if (reviewOwnerStatus.review_available !== true) throw new HttpError(409, "Review changed.");
            if (!env.CLUED_STORAGE_VAULT_KEYS) throw new Error("DRIVE_CREDENTIAL_UNAVAILABLE");
            if (revalidate && (revalidate.base_version !== reviewOwnerStatus.base_version ||
                revalidate.source_receipt_id !== reviewOwnerStatus.source_receipt_id)) throw new HttpError(409, "Review changed.");
            recoveryStage = "descriptor";
            const descriptor = await supabaseRequest(env, "/rest/v1/rpc/clued_storage_native_recovery_load_v2", {
              method: "POST", userToken: token, redirect: "manual", signal: AbortSignal.timeout(10000),
              body: JSON.stringify({ p_issuer_secret: issuer, p_input: { ...reference, action: "recovery_load" } }),
            }) as Record<string, unknown>;
            if (descriptor.version !== reviewOwnerStatus.base_version || reviewOwnerStatus.source_receipt_id !== reviewOwnerStatus.receipt_id)
              throw new HttpError(409, "Review changed.");
            refreshReference = storageRecoveryRefreshReference(descriptor, reference);
            recoveryStage = "verification";
            const review = await createStorageRecoveryReview({ client_id: env.CLUED_STORAGE_GOOGLE_CLIENT_ID ?? "",
              vault: JSON.parse(env.CLUED_STORAGE_VAULT_KEYS), descriptor, source_receipt_id: String(reviewOwnerStatus.source_receipt_id),
              rpc: async value => await supabaseRequest(env, "/rest/v1/rpc/clued_storage_scheduled_recovery_v2", {
                method: "POST", redirect: "manual", signal: AbortSignal.timeout(10000),
                body: JSON.stringify({ p_issuer_hash: issuerHash, p_input: value }),
              }) as Record<string, unknown> });
            return review.prepare(reference, revalidate);
          };
          try { return await attempt(); }
          catch (error) {
            if (!(error instanceof Error) || error.message !== "storage_recovery_credential_expiring" || !await refreshOriginalOnce()) throw error;
            // An existing delegation may refresh this original job once. Both
            // current Owner identity and the sealed descriptor are reloaded;
            // no flag, consent, connection or provider effect is enabled.
            reviewOwnerStatus = await inspectOriginalRecovery!();
            originalOwnerStatus = reviewOwnerStatus;
            return attempt();
          }
        };
        if (input.action === "inspect") {
          // Status only, even without a vault or after connection revocation.
          return json(ownerStatus, 200, headers);
        }
        if (finalReview) {
          recoveryStage = "settlement";
          if (ownerStatus.status === "resolved") {
            if (!matchesReview(ownerStatus)) throw new HttpError(409, "Review changed.");
            return json(ownerStatus, 200, headers);
          }
          if (input.action === "review_accept") {
            const validated = await readOwnerReview({ observation_id: String(input.observation_id), base_version: Number(input.base_version),
              source_receipt_id: String(input.source_receipt_id) });
            if (validated.status === "resolved") {
              if (!matchesReview(validated)) throw new HttpError(409, "Review changed.");
              return json(validated, 200, headers);
            }
            if (validated.status !== "review_revalidated") throw new HttpError(409, "Review changed.");
          }
          recoveryStage = "settlement";
          reviewMutationDispatched = true;
          const reviewed = storageRecoveryResolutionResult(await rpc(input), reference);
          if (!matchesReview(reviewed)) throw new Error("Unavailable");
          return json(reviewed, 200, headers);
        }
        if (ownerStatus.status === "resolved") return json(ownerStatus, 200, headers);
        if (input.action === "review_prepare") {
          return json(await readOwnerReview(), 200, headers);
        }
        if (["committed", "cancelled", "denied"].includes(String(ownerStatus.status))) return json(ownerStatus, 200, headers);
        recoveryStage = "credential";
        if (!env.CLUED_STORAGE_VAULT_KEYS) throw new Error("Unavailable");
        // Owner lookup above prevents the fixed issuer bridge from becoming a
        // cross-account recovery endpoint. This branch never calls the executor.
        const verifiedRpc = async (value: Record<string, unknown>) => await supabaseRequest(env,
          "/rest/v1/rpc/clued_storage_cloud_worker_router_v2", {
            method: "POST", redirect: "manual", signal: AbortSignal.timeout(10000),
            body: JSON.stringify({ p_issuer_hash: issuerHash, p_input: value }),
          }) as Record<string, unknown>;
        recoveryStage = "descriptor";
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
          recoveryStage = "settlement";
          const settled = await verifiedRpc({ ...reference, action: "settle_verified" });
          if (settled.status !== "committed" || settled.state !== "committed" ||
              !uuid.test(String(settled.receipt_id)) || settled.execution_permitted !== false) throw new Error("Unavailable");
          return json({ status: "committed", job_id: reference.job_id, receipt_id: settled.receipt_id,
            execution_permitted: false }, 200, headers);
        }
        if (verifiedStatus?.status === "none") throw new Error("No original effect");
        const recoveryAttempt=async()=>{
        recoveryStage = "descriptor";
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
        if (accountDescriptor) refreshReference = storageRecoveryRefreshReference(accountDescriptor, reference);
        const recovery = await createStorageCloudRecovery({ client_id: env.CLUED_STORAGE_GOOGLE_CLIENT_ID ?? "",
          vault: JSON.parse(env.CLUED_STORAGE_VAULT_KEYS!),
          rpc: async value => value.action === "reconcile_before" ? await supabaseRequest(env,
            "/rest/v1/rpc/clued_storage_scheduled_recovery_v2", {
              method: "POST", redirect: "manual", signal: AbortSignal.timeout(10000),
              body: JSON.stringify({ p_issuer_hash: issuerHash, p_input: value }),
            }) as Record<string, unknown> : rpc(value),
          report_expiring:true, report_diagnostic: reportRecoveryDiagnostic,
          ...(accountDescriptor?.status === "recovery_only" ? {
            verified: { descriptor: accountDescriptor, rpc: verifiedRpc },
            current_registration: { rpc: async value => await supabaseRequest(env, "/rest/v1/rpc/clued_storage_scheduled_recovery_v2", {
              method: "POST", redirect: "manual", signal: AbortSignal.timeout(10000),
              body: JSON.stringify({ p_issuer_hash: issuerHash, p_input: value }),
            }) as Record<string, unknown> },
            absent: { rpc: async value => await supabaseRequest(env, "/rest/v1/rpc/clued_storage_recovery_absent_v1", {
              method: "POST", redirect: "manual", signal: AbortSignal.timeout(10000),
              body: JSON.stringify({ p_issuer_hash: issuerHash, p_input: value }),
            }) as Record<string, unknown> },
          } : {}) });
        return recovery.run(reference);
        };
        let recovered=await recoveryAttempt();
        if(recovered.status==="credential_expiring" && await refreshOriginalOnce()){
            // Re-enter the same live Owner RPC before loading the new sealed
            // version. A late renewal cannot substitute for that Owner session.
            const freshOwnerStatus=await inspectOriginalRecovery();
            if(["committed","cancelled","denied","resolved"].includes(String(freshOwnerStatus.status)))
              return json(freshOwnerStatus,200,headers);
            recovered=await recoveryAttempt();
        }
        if (recovered.status === "released_not_effected") {
          // The absence RPC preserves its legacy internal result. Return the
          // current Owner-visible state of this same job after it commits.
          return json(await inspectOriginalRecovery(), 200, headers);
        }
        if (["inspection_required", "credential_expiring"].includes(recovered.status)) {
          // Recording a verified result or diagnostic may have committed even
          // if its reply was lost. Inspect this same original job once; never
          // resend settlement or dispatch a replacement effect in this request.
          let latest = ownerStatus;
          try { latest = await inspectOriginalRecovery(); } catch { /* Preserve the confirmed original receipt. */ }
          if (["committed", "cancelled", "denied", "resolved"].includes(String(latest.status))) return json(latest, 200, headers);
          return json({ ...latest, ...recovered, status: latest.status, outcome: "inspection_required",
            job_id: reference.job_id, receipt_id: latest.receipt_id, execution_permitted: false }, 200, headers);
        }
        return json(recovered,200,headers);
      } catch (error) {
        const diagnostic = recoveryDiagnostic(recoveryStage, error);
        if (originalReviewInput && recoveryReference && originalOwnerStatus && inspectOriginalRecovery) {
          let latest: Record<string, unknown> | undefined;
          try { latest = await inspectOriginalRecovery(); } catch { /* Completion remains unknown, never repeat confirmation. */ }
          if (latest?.status === "resolved" && latest.resolution === (originalReviewInput.action === "review_accept" ? "accepted_current_state" : "abandoned_registration") &&
              latest.source_receipt_id === originalReviewInput.source_receipt_id && latest.base_version === originalReviewInput.base_version &&
              (latest.observation_id ?? null) === (originalReviewInput.observation_id ?? null)) return json(latest, 200, headers);
          return json({ ...originalOwnerStatus, status: "attention_required", outcome: "inspection_required", diagnostic,
            review_error: !reviewMutationDispatched || error instanceof HttpError && [400, 403, 409].includes(error.status) ? "REVIEW_REFRESH_REQUIRED" : "REVIEW_COMPLETION_UNKNOWN",
            execution_permitted: false }, 200, headers);
        }
        if (recoveryReference && originalOwnerStatus && reportRecoveryDiagnostic) {
          try { await reportRecoveryDiagnostic(recoveryReference, diagnostic); } catch { /* Preserve the original failure. */ }
          let latest = originalOwnerStatus;
          try { latest = await inspectOriginalRecovery!(); } catch { /* No false success after a lost reply. */ }
          if (["committed", "cancelled", "denied", "resolved"].includes(String(latest.status))) return json(latest,200,headers);
          return json({ ...latest, outcome: "inspection_required",
            diagnostic, execution_permitted: false }, 200, headers);
        }
        // No detailed job diagnostics before the Owner lookup succeeds.
        return json({ status: "inspection_required", execution_permitted: false }, 403, headers);
      }
    }
    if (url.pathname === "/v1/storage/google/probe") {
      validateOrigin(request, env);
      if (env.CLUED_STORAGE_ACCOUNT_V1 !== "true" || env.CLUED_STORAGE_GOOGLE_V1 !== "true") return json({ error: "Not found." }, 404);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
      if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, { allow: "POST, OPTIONS" });
      const { user, token } = await requireSupabaseUser(request, env);
      try {
        const input = await parseBody(request), issuer = env.CLUED_STORAGE_CONNECTOR_ISSUER;
        if (!issuer || issuer.length < 32 || !env.CLUED_STORAGE_VAULT_KEYS) throw new Error("Unavailable");
        const demand=await storageDemandRuntime(env,async prepared=>await supabaseRequest(env,"/rest/v1/rpc/clued_storage_owner_lifecycle_v1",{
          method:"POST",userToken:token,redirect:"manual",signal:AbortSignal.timeout(10000),
          body:JSON.stringify({p_issuer_hash:await sha256(issuer),p_input:{action:"prepare_credential",connection_id:prepared.connection_id,operation:"probe"}}),
        }) as Record<string,unknown>);
        const probe = await createStorageGoogleProbe({ client_id: env.CLUED_STORAGE_GOOGLE_CLIENT_ID ?? "",
          vault: JSON.parse(env.CLUED_STORAGE_VAULT_KEYS),
          credential_preflight:demand ? connection=>demand.owner(user.id,connection,"probe") : undefined,
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
      const maintenance = storageOAuthStartMaintenance(env, url.pathname, corsHeaders(request));
      if (maintenance) return maintenance;
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
          // N0: a claimed onboard attempt completes through the onboard runtime.
          ...(url.pathname === "/v1/storage/google/complete" && storageOnboardEnabled(env)
            ? { onboard: (await storageOnboardRuntime(env, token)).onboard } : {}),
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
          // normal_use (StorageNormalUse §2.4, §8.2): re-consent with the normal
          // set; full_scope (StorageFullCapability P7, Decision 6dc1cf20):
          // re-consent with the full set. The disclosure version the Owner
          // confirmed is bound to the attempt and checked by the database.
          // Otherwise keep the recorded profile.
          const consentOf = (value: unknown) => !!value && typeof value === "object" && !Array.isArray(value) &&
            Object.keys(value).length === 1 && typeof (value as Record<string, unknown>).disclosure_version === "string";
          if (Object.keys(input).some(key => !["connection_id", "default_refresh", "normal_use", "full_scope"].includes(key)) ||
              typeof input.connection_id !== "string" ||
              ("default_refresh" in input && typeof input.default_refresh !== "boolean") ||
              ("normal_use" in input && !consentOf(input.normal_use)) || ("full_scope" in input && !consentOf(input.full_scope)) ||
              ("normal_use" in input && "full_scope" in input)) throw new Error("Invalid");
          if (input.default_refresh === true && env.CLUED_STORAGE_REFRESH_V1 !== "true") throw new Error("Unavailable");
          const consent = (input.normal_use ?? input.full_scope) as Record<string, unknown> | undefined;
          result = await (await createStorageGoogleOAuth(configuration)).start(input.connection_id, input.default_refresh === true,
            input.normal_use ? "normal" : input.full_scope ? "full" : "keep",
            consent ? { disclosure_version: String(consent.disclosure_version) } : undefined);
        } else {
          if (Object.keys(input).length !== 2 || typeof input.state !== "string" || typeof input.code !== "string") throw new Error("Invalid");
          result = await (await createStorageGoogleOAuth(configuration)).complete({ state: input.state, code: input.code });
          // A completed fresh Google authorization may belong to a reconnect.
          // Activation uses the same live Native session and never exchanges a
          // code twice or revives the disconnected credential.
          const { user } = await requireSupabaseUser(request, env);
          const activated = await (await storageOwnerLifecycleRuntime(env, token)).completeReconnect(user.id, input.state);
          if (activated.status !== "not_applicable") result = activated;
        }
        return json(result, 200, { ...corsHeaders(request), "cache-control": "no-store" });
      } catch (error) {
        return json({ error: "Storage Google connection unavailable.",
          ...(error instanceof StorageGoogleConnectionError ? { reason: error.reason,
            ...(error.onboard_attempt_id ? { onboard_attempt_id: error.onboard_attempt_id } : {}) } : {}) },
          403, { ...corsHeaders(request), "cache-control": "no-store" });
      }
    }
    // StorageNormalUse N0 (§8.1): self-service onboarding from the native page.
    if (["/v1/storage/onboard/config", "/v1/storage/onboard/begin", "/v1/storage/onboard/resume",
      "/v1/storage/onboard/status"].includes(url.pathname)) {
      validateOrigin(request, env);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
      if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, { allow: "POST, OPTIONS" });
      const headers = { ...corsHeaders(request), "cache-control": "no-store" };
      if (!storageOnboardEnabled(env)) {
        // The page shows a fixed message; nothing else is disclosed.
        return url.pathname.endsWith("/config")
          ? json({ enabled: false, reason: "onboard_disabled" }, 200, headers) : json({ error: "Not found." }, 404);
      }
      const maintenance = storageOAuthStartMaintenance(env, url.pathname, headers);
      if (maintenance) return maintenance;
      const { user, token } = await requireSupabaseUser(request, env);
      try {
        const input = await parseBody(request);
        const { rpc, onboard } = await storageOnboardRuntime(env, token);
        let result: unknown;
        if (url.pathname.endsWith("/config")) {
          if (Object.keys(input).length) throw new Error("Invalid");
          const listed = await rpc({ action: "list" });
          const picker = storagePickerConfiguration(env);
          result = { enabled: true, disclosure_version: ONBOARD_DISCLOSURE_VERSION, allowed: listed.allowed === true,
            picker, ...(picker ? {} : { picker_reason: "picker_unconfigured" }), refresh_available: env.CLUED_STORAGE_REFRESH_V1 === "true",
            refresh_token_count: listed.refresh_token_count, attempts: listed.attempts };
        } else if (url.pathname.endsWith("/begin")) {
          result = await onboard.begin(String(user.id), input as never);
        } else {
          if (Object.keys(input).length !== 1 || typeof input.onboard_attempt_id !== "string") throw new Error("Invalid");
          result = url.pathname.endsWith("/resume") ? await onboard.resume(input.onboard_attempt_id)
            : await rpc({ action: "status", onboard_attempt_id: input.onboard_attempt_id });
        }
        return json(result, 200, headers);
      } catch (error) {
        return json({ error: "Storage onboarding unavailable.",
          ...(error instanceof StorageGoogleConnectionError ? { reason: error.reason,
            ...(error.onboard_attempt_id ? { onboard_attempt_id: error.onboard_attempt_id } : {}) } : {}) }, 403, headers);
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
        // Bug 38bb5ddf: directories that need the Owner, and the Owner's
        // confirmation of one's current sharing, are separate RPCs, so the
        // source-pinned management functions stay unchanged.
        const attention = input.action === "digest_attention", accept = input.action === "digest_accept";
        const result = await supabaseRequest(env, attention ? "/rest/v1/rpc/clued_storage_access_digest_attention_v1"
          : accept ? "/rest/v1/rpc/clued_storage_access_digest_accept_v1" : "/rest/v1/rpc/clued_storage_owner_manage_v2", {
          method: "POST", userToken: token, body: JSON.stringify({ p_input: attention ? { action: "list" }
            : accept ? { action: "accept", artifact_id: input.artifact_id, observed_access: input.observed_access } : input }),
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
    if (url.pathname === "/v1/storage/read-access" || url.pathname === "/v1/storage/write-access" || url.pathname === "/v1/storage/normal-use"
      || url.pathname === "/v1/storage/budget" || url.pathname === "/v1/storage/trash-confirmation") {
      // StorageFullCapability.v0.1: native Owner control of the read level (P1)
      // and the modify write level (P3); StorageNormalUse.v0.1 §8.2 normal use
      // and §7.3 hourly budgets (N4); the native trash batch confirmation (P5, §3.4 item 4).
      // The RPC checks the live auth session itself; never a Binding or service role.
      const rpc = url.pathname === "/v1/storage/read-access" ? "clued_storage_read_access_v1"
        : url.pathname === "/v1/storage/normal-use" ? "clued_storage_normal_use_v1"
          : url.pathname === "/v1/storage/budget" ? "clued_storage_budget_v1"
            : url.pathname === "/v1/storage/trash-confirmation" ? "clued_storage_trash_confirmation_v1" : "clued_storage_write_access_v1";
      validateOrigin(request, env);
      const headers = { ...corsHeaders(request), "cache-control": "no-store" };
      if (env.CLUED_STORAGE_ACCOUNT_V1 !== "true") return json({ error: "Not found." }, 404, headers);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, { ...headers, allow: "POST, OPTIONS" });
      const { token } = await requireSupabaseUser(request, env);
      try {
        const input = await parseBody(request);
        const result = await supabaseRequest(env, `/rest/v1/rpc/${rpc}`, {
          method: "POST", userToken: token, body: JSON.stringify({ p_input: input }),
        });
        return json(result, 200, headers);
      } catch (error) {
        // N4: a stale CAS base or an out-of-bounds value is refused before any
        // receipt, so the page can say "not saved" instead of "unconfirmed".
        const reason = rpc === "clued_storage_budget_v1" && error instanceof HttpError
          && (error.message === "storage_owner_version_conflict" || error.message === "storage_budget_out_of_bounds")
          ? error.message
          // A level switch is refused while the root has an unresolved job; the page says so.
          : rpc === "clued_storage_write_access_v1" && error instanceof HttpError
            && error.message === "storage_root_has_unresolved_mutation" ? "storage_root_busy" : undefined;
        return json({ error: "Storage access operation unavailable.", ...(reason ? { reason } : {}) }, reason ? 409 : 403, headers);
      }
    }
    if (url.pathname === "/v1/storage/lifecycle") {
      validateOrigin(request, env);
      const headers = { ...corsHeaders(request), "cache-control": "no-store" };
      if (env.CLUED_STORAGE_ACCOUNT_V1 !== "true" || env.CLUED_STORAGE_GOOGLE_V1 !== "true") return json({ error: "Not found." }, 404, headers);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, { ...headers, allow: "POST, OPTIONS" });
      const { user, token } = await requireSupabaseUser(request, env);
      try {
        const input = await parseBody(request);
        const maintenance = storageOAuthStartMaintenance(env, url.pathname, headers, input.action);
        if (maintenance) return maintenance;
        const runtime = await storageOwnerLifecycleRuntime(env, token);
        const action = input.action;
        const body = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "action"));
        let result;
        if (action === "list" && Object.keys(body).length === 0) result = { ...await runtime.list(user.id), worker_execution_enabled: env.CLUED_STORAGE_EXECUTOR_V1 === "true" };
        else if (action === "reconnect") result = await runtime.reconnect(user.id, body as OwnerReconnectInput);
        else if (action === "delete") result = await runtime.delete(user.id, body as OwnerDeleteInput);
        else if (action === "preview_delete" && Object.keys(body).length === 1 && typeof body.connection_id === "string") result = await runtime.previewDelete(user.id, body.connection_id);
        else if (action === "recover" && Object.keys(body).length === 1 && typeof body.attempt_id === "string") result = await runtime.recover(user.id, body.attempt_id);
        else return json({ error: "Storage operation not recognized.", reason: "input_invalid" }, 400, headers);
        return json(result, 200, headers);
      } catch (error) {
        const reason = error instanceof StorageOwnerLifecycleError ? error.reason : "lifecycle_unavailable";
        return json({ error: "Storage connection operation unavailable.", reason }, 409, headers);
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
      return await handleProjectApi(request, env, trace);
    }
    if (url.pathname === "/v1/records" || url.pathname.startsWith("/v1/records/") ||
      ["/v1/decisions/supersede", "/v1/evidence", "/v1/events", "/v1/export"].includes(url.pathname)) {
      return await handleRecordApi(request, env);
    }
    if (isInformationFlowPath(url.pathname)) return await handleInformationFlowApi(request, env);
    if (isIntegrationPath(url.pathname)) return await handleIntegrationApi(request, env);
    if (url.pathname === "/api/bindings") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(request) });
      }
      if (request.method === "GET") return await listBindings(request, env);
      // Retired (Owner Decision 6e0371e3): it issued full-scope Bindings without
      // an expiry. OAuth clients connect through /oauth; CI, runners and scripts
      // get a scoped, expiring token on /oauth/connections.
      if (request.method === "POST") {
        return json({ error: "Binding issuance moved.", replacement: "/oauth/connections" }, 410, corsHeaders(request));
      }
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
    const problem = error instanceof HttpError ? error : new HttpError(500, "BeamingFace request failed.");
    return json({ error: problem.message, details: problem.details }, problem.status, corsHeaders(request));
  }
}

export async function handleContinuityRequest(
  request: Request,
  env: ContinuityEnv,
  ctx?: ContinuityExecutionContext,
): Promise<Response | null> {
  // A fixed serving-Worker door, not MCP/Owner authentication or a browser
  // credential flow. Keep its transient runtime credentials out of general
  // tracing, projection invalidation and response decoration.
  const pathname = new URL(request.url).pathname;
  if (pathname === GITHUB_EVENTS_PATH) return handleGitHubEvents(request, env);
  if (pathname === CI_CONNECTION_RENEW_PATH) return handleCiConnectionRenew(request, env, (name, args, signal) =>
    supabaseRequest(env, "/rest/v1/rpc/" + name, {
      method: "POST", body: JSON.stringify(args), signal, redirect: "error", cache: "no-store",
    }));
  if (isCiNodeGatewayPath(pathname)) return handleCiNodeGatewayV1(request, env);
  const trace = createNativeReadTrace(request);
  const response = await handleContinuityRequestInner(request, env, ctx, trace);
  if (response) trace?.complete(response);
  if (response?.ok && ctx && projectionBuilderToken(env) &&
    mayInvalidateApprovedProjection(request)) {
    ctx.waitUntil(wakeProjectionRefresh(env));
  }
  if (!response || !p6ReleaseControlEnabled(env)) return response;
  return decorateP6Response(request, response, env);
}
