// Owner Credential v0.1, step 2 (development/contracts/owner-authorization/
// OwnerCredential.v0.1.md §3.2, §10). One MCP tool over the step-1 Agent RPCs:
// an Agent asks the Owner for a grant and gets a direct confirmation link, or
// reads the status of a request it made. Agents never approve: approval is the
// Owner's two-step confirmation on /confirm/<id>. Behind CLUED_OWNER_REQUESTS_V1
// so that deploying the Worker changes nothing until the flag is set.

export interface OwnerRequestFeatureEnv {
  CLUED_OWNER_REQUESTS_V1?: string;
}

export function ownerRequestsEnabled(env: OwnerRequestFeatureEnv) {
  return /^(1|true|on|enabled)$/i.test(env.CLUED_OWNER_REQUESTS_V1?.trim() ?? "");
}

export const OWNER_REQUEST_TOOL = "clued_owner_request";
export const OWNER_REQUEST_CREATE_RPC = "clued_owner_request_v1";
export const OWNER_REQUEST_STATUS_RPC = "clued_owner_request_status_v1";

const uuid = { type: "string", format: "uuid" } as const;

export const ownerRequestTools = [
  {
    name: OWNER_REQUEST_TOOL,
    description:
      "Ask the Owner to approve an action that needs their permission (registered actions: release.production, migration.production, work_claim.extra_claims). Create: send action, resources (kind:value or repository paths/globs) and idempotency_key, optionally task_id, suggested_grant and agent_note. The result carries request_id and confirm_url: give confirm_url to the Owner as is. The Owner opens it signed in to Clued and approves once, grants a time-limited permission, or rejects; you cannot approve it and must not claim the Owner approved in your own words. Status: send request_id alone to read pending, approved_once, granted, rejected or expired. A request expires after 24 hours. Idempotent by idempotency_key.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string", pattern: "^(global|project:[0-9a-fA-F-]{36})$", default: "global",
          description: "Context of the task: \"global\" (default) or \"project:<canonical_project_id>\".",
        },
        request_id: { ...uuid, description: "Status read: the request to check. Send it without the create fields." },
        action: { type: "string", minLength: 3, maxLength: 130, description: "Registered action, for example release.production." },
        resources: {
          type: "array", minItems: 1, maxItems: 50, uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 400 },
          description: "What the action touches, as kind:value (repo:owner/name/**, storage:..., record:<id>) or repository paths/globs.",
        },
        task_id: { ...uuid, description: "Optional: the active Task this is for; a grant from this request then applies to that Task only." },
        suggested_grant: {
          type: "object",
          properties: {
            expires_seconds: { type: "integer", minimum: 60, maximum: 604800 },
            max_uses: { type: "integer", minimum: 1, maximum: 1000 },
          },
          additionalProperties: false,
          description: "Optional suggestion for a time-limited grant; the Owner decides.",
        },
        agent_note: {
          type: "string", minLength: 1, maxLength: 2000,
          description: "Optional explanation. The page shows it separately, marked unverified; it never changes what is approved.",
        },
        idempotency_key: { type: "string", minLength: 8, maxLength: 160 },
      },
      additionalProperties: false,
    },
  },
] as const;

export const ownerRequestToolPolicies = {
  [OWNER_REQUEST_TOOL]: {
    scopes: ["context:write"], readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
} as const;

const CREATE_FIELDS = ["action", "resources", "task_id", "suggested_grant", "agent_note", "idempotency_key"];

export class OwnerRequestInputError extends Error {}

// Picks the RPC: request_id alone (with an optional scope) reads status,
// anything else creates. Mixing the two is refused rather than guessed.
export function ownerRequestCall(args: unknown): { rpc: string; input: Record<string, unknown> } {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new OwnerRequestInputError("owner_request_input_invalid");
  const input = args as Record<string, unknown>;
  if (!("request_id" in input)) return { rpc: OWNER_REQUEST_CREATE_RPC, input };
  if (CREATE_FIELDS.some((field) => field in input)) throw new OwnerRequestInputError("owner_request_status_fields_invalid");
  return { rpc: OWNER_REQUEST_STATUS_RPC, input };
}

const REJECTION = /^(owner_request|owner_grant|work_claim|intake_payload)_[a-z_]+$/;

// Database contract rejections (22023 → HTTP 400) become tool results that
// name the rule; authentication and authorization failures stay HTTP errors.
export function ownerRequestRejection(status: number, message: string) {
  if (status !== 400 || !REJECTION.test(message)) return null;
  return { status: "rejected", error_code: message };
}

// Adds the absolute confirmation link to the request in the result: "request"
// from this tool, "owner_request" from a work claim refused over the per-Task
// cap (OwnerCredential §6.2).
export function withConfirmUrl(result: unknown, origin: string, key: "request" | "owner_request" = "request"): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const body = result as Record<string, unknown>;
  const request = body[key];
  if (!request || typeof request !== "object" || Array.isArray(request)) return result;
  const path = (request as Record<string, unknown>).confirm_path;
  if (typeof path !== "string" || !/^\/confirm\/[0-9a-f-]{36}$/.test(path)) return result;
  return { ...body, [key]: { ...(request as Record<string, unknown>), confirm_url: origin + path } };
}
