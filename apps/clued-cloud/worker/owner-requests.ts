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
export const OWNER_REQUEST_BUNDLE_RPC = "clued_owner_request_bundle_v1";

const uuid = { type: "string", format: "uuid" } as const;

export const ownerRequestTools = [
  {
    name: OWNER_REQUEST_TOOL,
    description:
      "Ask the Owner to approve an action that needs their permission (registered actions: release.production, migration.production, repo.protected_change, work_claim.extra_claims, connection.permission). Create: send action, resources (kind:value or repository paths/globs) and idempotency_key, optionally task_id, suggested_grant and agent_note. The result carries request_id and confirm_url: give confirm_url to the Owner as is. The Owner opens it signed in to BeamingFace and approves once, grants a time-limited permission, or rejects; you cannot approve it and must not claim the Owner approved in your own words. connection.permission asks for a permission your own connection lacks, one resource per context and action: permission:<global|profile|project:<id>>/<read|write|close|restore|audit>, for example permission:project:<id>/write, or a preset role instead of the action: reader (read), developer (read, write, close, restore) or full (all five canonical operations), for example permission:project:<id>/developer; project:* keeps its original meaning: all of the Owner's own project canonical records, including later projects. The new permission:contexts:*/reader|developer|full or individual action requests the Owner's profile, personal records (the existing global canonical scope), all own project canonical records and all own Contexts whose projects are also own, existing and future; it does not include shared projects automatically. For this new contexts:* syntax only, developer means read/write; full intersects requested client scopes and each resource's supported operations (canonical read/write/close/restore/audit, Context read/write/close/feedback_submit). Existing exact restrictions and revocations remain; macro consent does not clear them, grant production/member/Secret/model/storage rights, or override a downscoped access token. For example permission:contexts:*/full. No task_id or suggested_grant for connection.permission. Any live connection can send it, even one that cannot read or write that context. Once the Owner approves, the permission is on this same connection: retry the refused call, no reconnect needed. repo.protected_change is opened only by the admission check for a pushed pull request (agent contract §1.7); asking for it yourself is refused with owner_request_action_door_only: give the Owner the link the check printed. Several actions for the same work, for example a production migration and the deploy of the same commit: send actions [{action, resources}, ...] (2 to 5, distinct, not connection.permission) instead of action and resources; you get one confirm_url, the Owner approves all of them with one click, and request.bundle lists each member's request_id and status. Send session_ref (your Host session id) when you create: once the Owner decides, the answer comes to that session by itself, as agent_inbox.owner_answers in clued_session_resume and clued_work_renew and as owner_answers in clued_agent_inbox, so you need not ask again or wait for the Owner to tell you. Status: send request_id alone to read pending, approved_once, granted, rejected or expired; reading a decided request's status also marks its answer read. A request expires after 24 hours. Idempotent by idempotency_key. Other actions require context:write.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string", pattern: "^(global|project:[0-9a-fA-F-]{36})$", default: "global",
          description: "Context of the task: \"global\" (default) or \"project:<canonical_project_id>\".",
        },
        request_id: { ...uuid, description: "Status read: the request to check. Send it without the create fields." },
        action: { type: "string", minLength: 3, maxLength: 130, description: "Registered action, for example release.production." },
        actions: {
          type: "array", minItems: 2, maxItems: 5,
          items: {
            type: "object",
            properties: {
              action: { type: "string", minLength: 3, maxLength: 130 },
              resources: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 400 } },
            },
            required: ["action", "resources"],
            additionalProperties: false,
          },
          description: "Instead of action and resources: several actions the Owner approves with one click, for example migration.production with one resource per migration file and release.production for the same commit.",
        },
        resources: {
          type: "array", minItems: 1, maxItems: 50, uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 400 },
          description: "What the action touches, as kind:value (repo:owner/name/**, storage:..., record:<id>, permission:<context>/<action>) or repository paths/globs.",
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
        session_ref: {
          type: "string", minLength: 1, maxLength: 200,
          description: "Create: your Host session id (the holder_session_ref you claim with). The Owner's answer then comes to this session rather than every session of your connection.",
        },
        idempotency_key: { type: "string", minLength: 8, maxLength: 160 },
      },
      additionalProperties: false,
    },
  },
] as const;

export const ownerRequestToolPolicies = {
  [OWNER_REQUEST_TOOL]: {
    scopes: ["context:read"], readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
} as const;

const CREATE_FIELDS = ["action", "actions", "resources", "task_id", "suggested_grant", "agent_note", "idempotency_key"];

export class OwnerRequestInputError extends Error {}

// Picks the RPC: request_id alone (with an optional scope) reads status,
// actions creates a bundle, anything else creates one request. Mixing them is
// refused rather than guessed.
export function ownerRequestCall(args: unknown): { rpc: string; input: Record<string, unknown> } {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new OwnerRequestInputError("owner_request_input_invalid");
  const input = args as Record<string, unknown>;
  if ("actions" in input && !("request_id" in input)) {
    if ("action" in input || "resources" in input) throw new OwnerRequestInputError("owner_request_bundle_invalid");
    return { rpc: OWNER_REQUEST_BUNDLE_RPC, input };
  }
  if (!("request_id" in input)) return { rpc: OWNER_REQUEST_CREATE_RPC, input };
  if (CREATE_FIELDS.some((field) => field in input)) throw new OwnerRequestInputError("owner_request_status_fields_invalid");
  // A status read is the asking Binding's own read (§13): session_ref changes
  // nothing there, so it is dropped rather than refused.
  const status = { ...input };
  delete status.session_ref;
  return { rpc: OWNER_REQUEST_STATUS_RPC, input: status };
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
// cap (OwnerCredential §6.2). A request the Owner's auto-approval switch
// already approved (§12) gets no link: there is nothing left to confirm, and
// the grant in the result is the receipt.
export function withConfirmUrl(result: unknown, origin: string, key: "request" | "owner_request" = "request"): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const body = result as Record<string, unknown>;
  const request = body[key];
  if (!request || typeof request !== "object" || Array.isArray(request)) return result;
  const grant = (request as Record<string, unknown>).grant;
  if (grant && typeof grant === "object" && (grant as Record<string, unknown>).auto_approved === true) return result;
  const path = (request as Record<string, unknown>).confirm_path;
  if (typeof path !== "string" || !/^\/confirm\/[0-9a-f-]{36}$/.test(path)) return result;
  return { ...body, [key]: { ...(request as Record<string, unknown>), confirm_url: origin + path } };
}
