/** Profile presentation only. The transport must authenticate the original
 * credential and its current live Binding before supplying the self-identity below.
 * Shape validation here is never proof of authentication or a permission grant. */
export interface McpProfile {
  id: string;
  name?: string;
  email?: string;
  nickname?: string;
}

export const mcpProfileTool = {
  name: "clued_account_profile",
  description: "Read the authenticated account's own stable identity for account display. " +
    "Takes no arguments. Requires the current connection to be authenticated; reads no business memory.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  securitySchemes: [{ type: "oauth2", scopes: [] }],
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid", minLength: 1, pattern: "\\S" },
      name: { type: "string", minLength: 1, maxLength: 256 },
      email: { type: "string", minLength: 1, maxLength: 320 },
      nickname: { type: "string", minLength: 1, maxLength: 256 },
    },
    required: ["id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: {
    "openai/profile": true,
    "clued/requiredScopes": [],
    "clued/scopeEnforcement": "server-side",
  },
} as const;

export class McpProfileError extends Error {
  constructor(readonly code: "mcp_profile_input_invalid" | "mcp_profile_unavailable") {
    super(code);
    this.name = "McpProfileError";
  }
}

type Data = Record<string, unknown>;
const object = (value: unknown): value is Data => {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
// Supabase Auth supplies the existing user's UUID, never a Binding/session/token ID.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const controls = /[\u0000-\u001f\u007f]/u;
const email = /^[^\s@]+@[^\s@]+$/u;

/** An omitted MCP arguments object means {}; no selector or hidden field is accepted. */
export function mcpProfileInput(args: unknown): void {
  if (args !== undefined && (!object(args) || Reflect.ownKeys(args).length !== 0)) {
    throw new McpProfileError("mcp_profile_input_invalid");
  }
}

/** Parse only a self-identity already resolved by authenticated server code.
 * Unknown internal fields are deliberately not read or copied. No fallback identity,
 * token decoding, caller selector or environment-derived identity is used. */
export function mcpProfileIdentity(value: unknown): McpProfile {
  if (!object(value)) throw new McpProfileError("mcp_profile_unavailable");
  const fields = Object.getOwnPropertyDescriptors(value);
  const id = fields.id;
  if (!id || !("value" in id) || typeof id.value !== "string" || !uuid.test(id.value)) {
    throw new McpProfileError("mcp_profile_unavailable");
  }
  const profile: McpProfile = { id: id.value };
  for (const key of ["name", "email", "nickname"] as const) {
    const field = fields[key];
    if (!field) continue;
    if (!("value" in field) || typeof field.value !== "string" || field.value.length === 0 ||
      field.value.length > (key === "email" ? 320 : 256) || field.value !== field.value.trim() ||
      controls.test(field.value) || (key === "email" && !email.test(field.value))) {
      throw new McpProfileError("mcp_profile_unavailable");
    }
    profile[key] = field.value;
  }
  return profile;
}

/** Email is display metadata captured from the normal authenticated identity
 * response at OAuth approval. It is not a live email lookup or an auth claim.
 * The transport calls this again only after its live Binding check, matching
 * the encrypted snapshot's ID to the same provider-issued account ID. */
export function mcpProfileEmailSnapshot(value: unknown, expectedId?: string): Pick<McpProfile, "id" | "email"> {
  if (!object(value)) throw new McpProfileError("mcp_profile_unavailable");
  const fields = Object.getOwnPropertyDescriptors(value);
  const id = fields.id;
  const profile = mcpProfileIdentity({ id: id && "value" in id ? id.value : undefined });
  if (expectedId !== undefined && profile.id !== expectedId) {
    throw new McpProfileError("mcp_profile_unavailable");
  }
  const field = fields.email;
  if (field && "value" in field && typeof field.value === "string" &&
    field.value.length > 0 && field.value.length <= 320 && field.value === field.value.trim() &&
    !controls.test(field.value) && email.test(field.value)) {
    profile.email = field.value;
  }
  return profile;
}

export function mcpProfileResult(authenticatedSelf: unknown) {
  const profile = mcpProfileIdentity(authenticatedSelf);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(profile) }],
    structuredContent: profile,
    isError: false as const,
  };
}

/** The callback belongs to the transport and must revalidate the current credential,
 * Binding and owning account. This helper cannot implement or prove that validation.
 * Authentication failures propagate unchanged for the transport to map to its proper
 * auth error. This helper returns no raw error body and never a partial profile. */
export async function handleMcpProfile(args: unknown, authenticateSelf: () => Promise<unknown>) {
  mcpProfileInput(args);
  const authenticatedSelf = await authenticateSelf();
  return mcpProfileResult(authenticatedSelf);
}
