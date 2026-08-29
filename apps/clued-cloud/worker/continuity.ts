import { projectRpcByTool, projectTools } from "./projects";
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
const KERNEL_VERSION = "0.3.1";

type Scope = (typeof ALL_SCOPES)[number];

export interface ContinuityEnv extends RecordFeatureEnv, P5FeatureEnv, P6FeatureEnv {
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  CLUED_ALLOWED_ORIGINS?: string;
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
        authorization_server: `${supabaseConfig(env ?? {}).url}/auth/v1`,
        consent_path: `${origin}/oauth/consent`,
        dynamic_client_registration: true,
      },
      binding_token_prefix: "clued_bnd_",
      token_storage: "hash-only",
      binding_policy: "one independent, revocable, least-privilege binding per vendor client",
      scopes: ALL_SCOPES,
    },
    lifecycle: {
      required: true,
      start: "clued_session_resume",
      during: "clued_append_event",
      end: "clued_session_checkpoint",
      session_ttl_seconds: 3600,
      conflict_policy: "optimistic-version-check",
      idempotency: "required for durable writes",
    },
    capabilities: {
      import_log: "clued_import_log",
      read_log: "clued_read_log",
      search_mode: "deterministic-lexical",
      semantic_recall: false,
      project_lifecycle: {
        certainty: ["unconfirmed", "confirmed"],
        progress: ["not_started", "active", "paused", "completed", "archived"],
        default_on_mention: "unconfirmed",
        promotion_preserves_identity: true,
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
  return `# Clued Continuity Agent Contract

Kernel: ${KERNEL_VERSION}
Canonical store: clued-cloud/supabase

1. Use a dedicated Clued Binding for this vendor/client; never share another vendor's token.
2. At the start of every authorized session call \`clued_session_resume\`.
3. Record authoritative decisions, corrections, failures and blockers with \`clued_append_event\`.
4. Before ending or handing off, call \`clued_session_checkpoint\` with the current base version.
5. Use \`clued_read_log\` for the canonical human-readable 日志.md. Import an authorized baseline only with \`clued_import_log\`.
6. Treat version conflicts and revoked/expired credentials as hard stops; resume again instead of overwriting.
7. Use \`clued_project_mutate\` for explicit Project create/update/complete/archive/restore. Project merge writes are disabled.
8. For current work, read Global registry and priority first, then Project State, Task and Decision. Read Log or Archive only when history or evidence is needed; they never override current records.
9. Preserve the returned canonical \`id\` across API, MCP, UI and Markdown mirrors. Markdown contains query results or stable-ID references, not copied canonical bodies.
10. Write once with \`clued_record_mutate\`; use \`clued_decision_supersede\` for replacement and \`clued_evidence_ingest\` for sources. The database transaction creates the Canonical entity + Event + Receipt; never dual-write Markdown.

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
    const status =
      response.status >= 500 &&
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
      requiredLifecycle: ["resume", "append_event", "checkpoint"],
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
          description: "Stable project or workspace key. Defaults to global.",
        },
        client_session_id: {
          type: "string",
          description: "Optional vendor session id for audit correlation; never a user message.",
        },
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
    name: "clued_session_checkpoint",
    description:
      "Call before ending or handing off an authorized session. Atomically commits a canonical checkpoint using optimistic concurrency and returns an audit receipt or explicit conflict.",
    inputSchema: {
      type: "object",
      required: ["session_token", "base_version", "snapshot", "summary", "next_action"],
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
        idempotency_key: { type: "string", minLength: 8, maxLength: 160 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_search_context",
    description:
      "Search authorized current context and events with deterministic lexical matching. Superseded history is excluded unless explicitly requested.",
    inputSchema: {
      type: "object",
      required: ["session_token", "query"],
      properties: {
        session_token: { type: "string" },
        query: { type: "string", minLength: 1, maxLength: 500 },
        context_key: { type: "string" },
        include_history: { type: "boolean", default: false },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
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
      "Read recent immutable receipts showing which authorized binding restored, changed or checkpointed context and when.",
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
  ...p5Tools,
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

const publicToolPolicies = {
  clued_agent_bootstrap: {
    scopes: [], readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
  },
  clued_session_resume: {
    scopes: ["context:read"], readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_append_event: {
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

export function publicMcpTools(env: Pick<ContinuityEnv, "PROJECT_VIEWS_V2" | "P5_TENANT_WRITES">) {
  return tools.filter((tool) =>
    (!(tool.name in recordRpcByTool) || recordsV2Enabled(env))
    && (!(tool.name in p5RpcByTool) || p5TenantWritesEnabled(env))
  ).map(publishTool);
}

const rpcByTool = {
  clued_session_resume: "clued_mcp_restore",
  clued_append_event: "clued_mcp_append_event",
  clued_session_checkpoint: "clued_mcp_commit_checkpoint",
  clued_search_context: "clued_mcp_search_context",
  clued_read_log: "clued_mcp_read_log",
  clued_import_log: "clued_mcp_import_log",
  clued_audit_receipts: "clued_mcp_audit_receipts",
  ...projectRpcByTool,
  ...recordRpcByTool,
  ...p5RpcByTool,
} as const;

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

  if (!token.startsWith("clued_bnd_")) {
    return await supabaseRequest(env, "/rest/v1/rpc/clued_oauth_call", {
      method: "POST",
      userToken: token,
      body: JSON.stringify({ p_tool: name, p_input: payload }),
    });
  }

  const tokenHash = await sha256(token);
  return await supabaseRequest(env, `/rest/v1/rpc/${rpcByTool[name]}`, {
    method: "POST",
    body: JSON.stringify({ p_token_hash: tokenHash, p_input: payload }),
  });
}

async function callTool(
  request: Request,
  env: ContinuityEnv,
  name: unknown,
  args: unknown,
) {
  if (name === "clued_agent_bootstrap") {
    const result = bootstrapContract(new URL(request.url).origin, env);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
      isError: false,
    };
  }
  if (typeof name === "string" && name in recordRpcByTool && !recordsV2Enabled(env)) {
    throw new HttpError(404, "Clued project views v2 are disabled.");
  }
  if (typeof name === "string" && name in p5RpcByTool && !p5TenantWritesEnabled(env)) {
    throw new HttpError(404, "Clued P5 tenant writes are disabled.");
  }
  if (typeof name !== "string" || !(name in rpcByTool)) {
    throw new HttpError(404, "Unknown Clued continuity tool.");
  }
  const result = sanitizeCluedResult(await callRpc(request, env, name as keyof typeof rpcByTool, args));
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
    isError: Boolean((result as Record<string, unknown> | null)?.error),
  };
}

function rpcResult(id: JsonRpcId | undefined, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: JsonRpcId | undefined, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}

async function handleMcp(request: Request, env: ContinuityEnv) {
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
            "Resume first. Read Global priority, then Project State/Task/Decision, and use Log/Archive only as evidence. Preserve canonical IDs; write through M1 mutation contracts and never dual-write Markdown.",
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
      const result = await callTool(request, env, name, args);
      return json(rpcResult(rpc.id, result), 200, corsHeaders(request));
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
  const result = await callRpc(request, env, tool, input);
  return json(result, 200, corsHeaders(request));
}

async function callUserProjectRpc(
  request: Request,
  env: ContinuityEnv,
  rpc: "clued_user_project_list" | "clued_user_project_mutate",
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
    const input: Record<string, unknown> = {};
    for (const key of ["certainty_status", "progress_status", "query", "limit"] as const) {
      const value = url.searchParams.get(key);
      if (value !== null) input[key] = key === "limit" ? Number(value) : value;
    }
    if (url.searchParams.get("include_dismissed") === "true") input.include_dismissed = true;
    return json(await callUserProjectRpc(request, env, "clued_user_project_list", input), 200, corsHeaders(request));
  }
  if (url.pathname === "/v1/projects" && request.method === "POST") {
    const { input, receivedPayloadHash } = await parseCanonicalBody(request);
    return json(
      await callUserProjectRpc(request, env, "clued_user_project_mutate", input, receivedPayloadHash),
      200,
      corsHeaders(request),
    );
  }
  const match = /^\/v1\/projects\/([0-9a-f-]{36})$/i.exec(url.pathname);
  if (match && request.method === "PATCH") {
    const { input, receivedPayloadHash } = await parseCanonicalBody(request);
    return json(
      await callUserProjectRpc(request, env, "clued_user_project_mutate", {
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
  rpc: UserRecordRpc,
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
    for (const key of ["level", "project_id", "record_type", "limit"] as const) {
      const value = url.searchParams.get(key);
      if (value !== null) input[key] = key === "limit" ? Number(value) : value;
    }
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
    "/v1/export": "clued_user_canonical_export",
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

async function handleContinuityRequestInner(
  request: Request,
  env: ContinuityEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/healthz" && request.method === "GET") {
      return json({
        status: "ok",
        service: "clued-continuity",
        version: KERNEL_VERSION,
        canonicalStore: "supabase",
        mcp: "/mcp",
        api: "/v1/continuity",
        workLog: "日志.md",
        mandatoryLifecycle: ["resume", "append_event", "checkpoint"],
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
    if (url.pathname === "/mcp") return await handleMcp(request, env);
    if (url.pathname in restToolByPath) return await handleRestContinuity(request, env);
    if (url.pathname === "/v1/projects" || url.pathname.startsWith("/v1/projects/")) {
      return await handleProjectApi(request, env);
    }
    if (url.pathname === "/v1/records" || url.pathname.startsWith("/v1/records/") ||
      ["/v1/decisions/supersede", "/v1/evidence", "/v1/events", "/v1/export"].includes(url.pathname)) {
      return await handleRecordApi(request, env);
    }
    if (url.pathname === "/api/bindings") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(request) });
      }
      if (request.method === "GET") return await listBindings(request, env);
      if (request.method === "POST") return await createBinding(request, env);
      if (request.method === "DELETE") return await revokeBinding(request, env);
      return json({ error: "Method not allowed." }, 405, corsHeaders(request));
    }
    if (url.pathname === "/api/memories" || url.pathname === "/api/memories/audit") {
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
): Promise<Response | null> {
  const response = await handleContinuityRequestInner(request, env);
  if (!response || !p6ReleaseControlEnabled(env)) return response;
  return decorateP6Response(request, response, env);
}
