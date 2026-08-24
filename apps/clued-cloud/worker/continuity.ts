import { projectRpcByTool, projectTools } from "./projects";
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

const SUPPORTED_MCP_VERSIONS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
] as const;
const MAX_JSON_BYTES = 1024 * 1024;
const KERNEL_VERSION = "0.3.1";

type Scope = (typeof ALL_SCOPES)[number];

export interface ContinuityEnv extends RecordFeatureEnv {
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  CLUED_ALLOWED_ORIGINS?: string;
}

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
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

interface MemoryRecord {
  id: string;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
}

interface MemoryAuditRecord {
  id: string;
  memory_id: string;
  action: "create" | "update" | "delete";
  details: Record<string, unknown>;
  occurred_at: string;
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
    },
    authentication: {
      scheme: "Bearer",
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
7. When a project is merely mentioned call \`clued_project_observe\` with intent \`possible\`; when intent or material work is explicit, use \`confirmed\`. Use \`ignore\` for one-off or third-party mentions.
8. For current work, read Global registry and priority first, then Project State, Task and Decision. Read Log or Archive only when history or evidence is needed; they never override current records.
9. Preserve the returned canonical \`id\` across API, MCP, UI and Markdown mirrors. Markdown contains query results or stable-ID references, not copied canonical bodies.
10. Write once with \`clued_record_write\` only after the project is explicitly confirmed. The database transaction creates Record + Event + Receipt; never create a second Markdown record or invent a confirmed project.

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
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
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
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message =
      typeof payload?.message === "string"
        ? payload.message
        : typeof payload?.error_description === "string"
          ? payload.error_description
          : "Clued storage request failed.";
    const status =
      response.status >= 500 &&
      payload?.code === "P0002" &&
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

function memoryText(value: unknown, field: "title" | "content") {
  if (typeof value !== "string") {
    throw new HttpError(400, `Memory ${field} is required.`);
  }
  const trimmed = value.trim();
  const limit = field === "title" ? 120 : 8000;
  if (!trimmed || trimmed.length > limit) {
    throw new HttpError(400, `Memory ${field} must be between 1 and ${limit} characters.`);
  }
  return trimmed;
}

function memoryId(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new HttpError(400, "A valid memory id is required.");
  }
  return id;
}

async function listMemories(request: Request, env: ContinuityEnv) {
  const { token } = await requireSupabaseUser(request, env);
  const rows = (await supabaseRequest(
    env,
    "/rest/v1/clued_memories?select=id,title,content,created_at,updated_at&order=updated_at.desc&limit=100",
    { method: "GET", userToken: token },
  )) as MemoryRecord[];
  return json({ memories: rows }, 200, corsHeaders(request));
}

async function createMemory(request: Request, env: ContinuityEnv) {
  const { user, token } = await requireSupabaseUser(request, env);
  const body = await parseBody(request);
  const rows = (await supabaseRequest(env, "/rest/v1/clued_memories", {
    method: "POST",
    userToken: token,
    headers: { prefer: "return=representation" },
    body: JSON.stringify({
      user_id: user.id,
      title: memoryText(body.title, "title"),
      content: memoryText(body.content, "content"),
    }),
  })) as MemoryRecord[];
  if (!rows[0]) throw new HttpError(500, "Clued did not return the created memory.");
  return json({ memory: rows[0] }, 201, corsHeaders(request));
}

async function updateMemory(request: Request, env: ContinuityEnv) {
  const { token } = await requireSupabaseUser(request, env);
  const id = memoryId(request);
  const body = await parseBody(request);
  const rows = (await supabaseRequest(
    env,
    `/rest/v1/clued_memories?id=eq.${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      userToken: token,
      headers: { prefer: "return=representation" },
      body: JSON.stringify({
        title: memoryText(body.title, "title"),
        content: memoryText(body.content, "content"),
        updated_at: new Date().toISOString(),
      }),
    },
  )) as MemoryRecord[];
  if (!rows[0]) throw new HttpError(404, "Memory not found.");
  return json({ memory: rows[0] }, 200, corsHeaders(request));
}

async function deleteMemory(request: Request, env: ContinuityEnv) {
  const { token } = await requireSupabaseUser(request, env);
  const id = memoryId(request);
  const rows = (await supabaseRequest(
    env,
    `/rest/v1/clued_memories?id=eq.${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      userToken: token,
      headers: { prefer: "return=representation" },
    },
  )) as MemoryRecord[];
  if (!rows[0]) throw new HttpError(404, "Memory not found.");
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

async function listMemoryAudit(request: Request, env: ContinuityEnv) {
  const { token } = await requireSupabaseUser(request, env);
  const rows = (await supabaseRequest(
    env,
    "/rest/v1/clued_memory_audit?select=id,memory_id,action,details,occurred_at&order=occurred_at.desc&limit=50",
    { method: "GET", userToken: token },
  )) as MemoryAuditRecord[];
  return json({ audit: rows }, 200, corsHeaders(request));
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
] as const;

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
} as const;

async function callRpc(
  request: Request,
  env: ContinuityEnv,
  name: keyof typeof rpcByTool,
  args: unknown,
) {
  const token = bearerToken(request);
  if (!token?.startsWith("clued_bnd_")) {
    throw new HttpError(401, "A Clued Binding Token is required.");
  }
  const tokenHash = await sha256(token);
  const payload = typeof args === "object" && args ? args : {};
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
  if (typeof name !== "string" || !(name in rpcByTool)) {
    throw new HttpError(404, "Unknown Clued continuity tool.");
  }
  const result = await callRpc(request, env, name as keyof typeof rpcByTool, args);
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
    isError: Boolean(result?.error),
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
    rpc = (await request.json()) as JsonRpcRequest;
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400, corsHeaders(request));
  }
  if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
    return json(rpcError(rpc.id, -32600, "Invalid Request"), 400, corsHeaders(request));
  }

  try {
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
            "Resume first. For current work read Global priority, then Project State/Task/Decision, and use Log/Archive only as evidence. Preserve canonical record IDs; write once through clued_record_write and never dual-write Markdown.",
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
      const visibleTools = recordsV2Enabled(env)
        ? tools
        : tools.filter((tool) => !(tool.name in recordRpcByTool));
      return json(rpcResult(rpc.id, { tools: visibleTools }), 200, corsHeaders(request));
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
  rpc: "clued_user_project_list" | "clued_user_project_observe" | "clued_user_project_update",
  input: Record<string, unknown>,
) {
  const { token } = await requireSupabaseUser(request, env);
  return await supabaseRequest(env, `/rest/v1/rpc/${rpc}`, {
    method: "POST",
    userToken: token,
    body: JSON.stringify({ p_input: input }),
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
  if (url.pathname === "/v1/projects/observe" && request.method === "POST") {
    return json(
      await callUserProjectRpc(request, env, "clued_user_project_observe", await parseBody(request)),
      200,
      corsHeaders(request),
    );
  }
  const match = /^\/v1\/projects\/([0-9a-f-]{36})(\/merge)?$/i.exec(url.pathname);
  if (match && request.method === "PATCH" && !match[2]) {
    return json(
      await callUserProjectRpc(request, env, "clued_user_project_update", {
        ...(await parseBody(request)),
        project_id: match[1],
      }),
      200,
      corsHeaders(request),
    );
  }
  if (match && request.method === "POST" && match[2] === "/merge") {
    return json(
      await callUserProjectRpc(request, env, "clued_user_project_update", {
        ...(await parseBody(request)),
        project_id: match[1],
        action: "merge",
      }),
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
) {
  const { token } = await requireSupabaseUser(request, env);
  return await supabaseRequest(env, `/rest/v1/rpc/${rpc}`, {
    method: "POST",
    userToken: token,
    body: JSON.stringify({ p_input: input }),
  });
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
    return json(
      await callUserRecordRpc(request, env, "clued_user_record_write", await parseBody(request)),
      200,
      corsHeaders(request),
    );
  }
  return json({ error: "Method not allowed." }, 405, {
    ...corsHeaders(request),
    allow: "GET, POST, OPTIONS",
  });
}

export async function handleContinuityRequest(
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
      return json({
        resource: `${url.origin}/mcp`,
        bearer_methods_supported: ["header"],
        scopes_supported: ALL_SCOPES,
        clued_binding_portal: `${url.origin}/`,
      });
    }
    if (url.pathname === "/mcp") return await handleMcp(request, env);
    if (url.pathname in restToolByPath) return await handleRestContinuity(request, env);
    if (url.pathname === "/v1/projects" || url.pathname.startsWith("/v1/projects/")) {
      return await handleProjectApi(request, env);
    }
    if (url.pathname === "/v1/records" || url.pathname.startsWith("/v1/records/")) {
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
    if (url.pathname === "/api/memories/audit") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(request) });
      }
      if (request.method === "GET") return await listMemoryAudit(request, env);
      return json({ error: "Method not allowed." }, 405, corsHeaders(request));
    }
    if (url.pathname === "/api/memories") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(request) });
      }
      if (request.method === "GET") return await listMemories(request, env);
      if (request.method === "POST") return await createMemory(request, env);
      if (request.method === "PATCH") return await updateMemory(request, env);
      if (request.method === "DELETE") return await deleteMemory(request, env);
      return json({ error: "Method not allowed." }, 405, corsHeaders(request));
    }
    return null;
  } catch (error) {
    const problem = error instanceof HttpError ? error : new HttpError(500, "Clued request failed.");
    return json({ error: problem.message, details: problem.details }, problem.status, corsHeaders(request));
  }
}
