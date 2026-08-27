export interface P5FeatureEnv {
  P5_TENANT_WRITES?: string;
}

export function p5TenantWritesEnabled(env: P5FeatureEnv) {
  return /^(1|true|on|enabled)$/i.test(env.P5_TENANT_WRITES?.trim() ?? "");
}

const identityProperties = {
  organization_id: { type: "string", format: "uuid" },
  workspace_id: { type: "string", format: "uuid" },
  context_key: { type: "string", minLength: 1, maxLength: 160 },
  role: { type: "string", enum: ["owner", "admin", "editor", "reader", "denied"] },
  scope: {
    type: "string",
    enum: ["canonical:read", "canonical:write", "project:read", "project:write", "audit:read"],
  },
  purpose: { type: "string", minLength: 1, maxLength: 160 },
  policy_version: { type: "integer", minimum: 1 },
  revocation_epoch: { type: "integer", minimum: 1 },
} as const;

const identityRequired = [
  "organization_id", "workspace_id", "context_key", "role", "scope",
  "purpose", "policy_version", "revocation_epoch",
] as const;

export const p5Tools = [
  {
    name: "clued_p5_session_open",
    description:
      "Open a short-lived P5 session after a fresh database check of User, Organization, Workspace, Context, Agent Binding, Role, Scope, Purpose, Policy Version, expiry, and Revocation Epoch.",
    inputSchema: {
      type: "object",
      required: identityRequired,
      properties: identityProperties,
      additionalProperties: false,
    },
  },
  {
    name: "clued_p5_mutate",
    description:
      "Mutate one tenant-bound Canonical Record or Project using exact Base Version CAS and an atomic Mutation + Event + immutable Receipt contract.",
    inputSchema: {
      type: "object",
      required: [...identityRequired, "session_token", "target_kind", "target_id", "base_version", "idempotency_key", "mutation"],
      properties: {
        ...identityProperties,
        session_token: { type: "string", pattern: "^clued_p5s_[0-9a-f]{64}$" },
        target_kind: { type: "string", enum: ["record", "project"] },
        target_id: { type: "string", format: "uuid" },
        base_version: { type: "integer", minimum: 1 },
        idempotency_key: { type: "string", minLength: 8, maxLength: 160 },
        mutation: { type: "object" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_p5_workspace_switch",
    description:
      "Switch an Agent Binding to another authorized Workspace and invalidate every old Session and Context immediately.",
    inputSchema: {
      type: "object",
      required: [...identityRequired, "session_token", "new_workspace_id", "new_context_key"],
      properties: {
        ...identityProperties,
        session_token: { type: "string", pattern: "^clued_p5s_[0-9a-f]{64}$" },
        new_workspace_id: { type: "string", format: "uuid" },
        new_context_key: { type: "string", minLength: 1, maxLength: 160 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_p5_pending_intent",
    description:
      "Record an offline write only as a Pending Intent; it is never a confirmed Mutation, Event, or Receipt.",
    inputSchema: {
      type: "object",
      required: [...identityRequired, "session_token", "idempotency_key", "encrypted_intent_ref"],
      properties: {
        ...identityProperties,
        session_token: { type: "string", pattern: "^clued_p5s_[0-9a-f]{64}$" },
        idempotency_key: { type: "string", minLength: 8, maxLength: 160 },
        encrypted_intent_ref: { type: "string", minLength: 1, maxLength: 1000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_p5_git_divergence",
    description:
      "Classify Git history divergence separately from Canonical CAS conflict; this never merges or overwrites either side.",
    inputSchema: {
      type: "object",
      required: ["base", "local", "remote"],
      properties: {
        base: { type: "string", pattern: "^[0-9a-f]{40}$" },
        local: { type: "string", pattern: "^[0-9a-f]{40}$" },
        remote: { type: "string", pattern: "^[0-9a-f]{40}$" },
      },
      additionalProperties: false,
    },
  },
] as const;

export const p5RpcByTool = {
  clued_p5_session_open: "clued_p5_session_open",
  clued_p5_mutate: "clued_p5_mutate",
  clued_p5_workspace_switch: "clued_p5_workspace_switch",
  clued_p5_pending_intent: "clued_p5_pending_intent",
  clued_p5_git_divergence: "clued_p5_git_divergence",
} as const;
