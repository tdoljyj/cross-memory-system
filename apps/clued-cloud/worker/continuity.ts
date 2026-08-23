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

type Scope = (typeof ALL_SCOPES)[number];

export interface ContinuityEnv {
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
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    vary: "Origin",
  };
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
    throw new HttpError(
      response.status,
      typeof payload?.message === "string"
        ? payload.message
        : typeof payload?.error_description === "string"
          ? payload.error_description
          : "Clued storage request failed.",
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
      requiredLifecycle: ["resume", "append_event", "checkpoint"],
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
] as const;

const rpcByTool = {
  clued_session_resume: "clued_mcp_restore",
  clued_append_event: "clued_mcp_append_event",
  clued_session_checkpoint: "clued_mcp_commit_checkpoint",
  clued_search_context: "clued_mcp_search_context",
  clued_read_log: "clued_mcp_read_log",
  clued_audit_receipts: "clued_mcp_audit_receipts",
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
          serverInfo: { name: "Clued Continuity", version: "0.3.0" },
          instructions:
            "Resume with clued_session_resume at session start, append authoritative changes while working, and checkpoint before handoff or session end.",
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
      return json(rpcResult(rpc.id, { tools }), 200, corsHeaders(request));
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
        version: "0.3.0",
        canonicalStore: "supabase",
        mcp: "/mcp",
        api: "/v1/continuity",
        workLog: "日志.md",
        mandatoryLifecycle: ["resume", "append_event", "checkpoint"],
      });
    }
    if (url.pathname === "/.well-known/clued-continuity") {
      return json({
        schema_version: "1.0",
        canonical_store: "clued-cloud/supabase",
        mcp_endpoint: `${url.origin}/mcp`,
        http_api: `${url.origin}/v1/continuity`,
        work_log: "日志.md",
        lifecycle: {
          required: true,
          start: "resume",
          during: "append_event",
          end: "checkpoint",
          session_ttl_seconds: 3600,
          conflict_policy: "optimistic-version-check",
        },
        supported_mcp_versions: SUPPORTED_MCP_VERSIONS,
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
    if (url.pathname === "/api/bindings") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(request) });
      }
      if (request.method === "GET") return await listBindings(request, env);
      if (request.method === "POST") return await createBinding(request, env);
      if (request.method === "DELETE") return await revokeBinding(request, env);
      return json({ error: "Method not allowed." }, 405, corsHeaders(request));
    }
    return null;
  } catch (error) {
    const problem = error instanceof HttpError ? error : new HttpError(500, "Clued request failed.");
    return json({ error: problem.message, details: problem.details }, problem.status, corsHeaders(request));
  }
}
