// S2c Integration Runtime PR-5 (IntegrationRuntime v0.1.8 §12): the Worker surface of the Integration
// runtime — seven Binding-channel MCP tools, the Native REST routes (/v1/integrations*), the bootstrap
// block and the error rendering — all behind CLUED_INTEGRATION_RUNTIME_V1 (unset = off, §12.1).
// The S2a unified tool registry has not landed, so the tools join the current tools / policies /
// rpcByTool pattern (§12.3 second path); moving them to the registry is recorded debt for S2a.
// The database grants no EXECUTE on these RPCs until a separately authorized flag-enabling migration
// (§5.13, OQ-21), so with the flag off they are unreachable both here and through PostgREST.

const uuidPattern = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const idempotencyKeySchema = { type: "string", minLength: 8, maxLength: 160 } as const;
const integrationIdSchema = { type: "string", pattern: uuidPattern } as const;
const baseVersionSchema = { type: "integer", minimum: 1 } as const;
const dimensionSchema = {
  type: "object",
  description: "One identity dimension: {status: VALUE | NOT_APPLICABLE | UNAVAILABLE, value?, evidence_kind?}. Weak identifiers (email, display name) are refused.",
  properties: {
    status: { type: "string", enum: ["VALUE", "NOT_APPLICABLE", "UNAVAILABLE"] },
    value: { type: "string", minLength: 1, maxLength: 255 },
    evidence_kind: { type: "string", minLength: 1, maxLength: 80 },
  },
  additionalProperties: false,
} as const;
const provenanceSchema = { type: "object", description: "Host-supplied provenance, stored as evidence only." } as const;

export const INTEGRATION_CONNECTION_SELF =
  " Connection-self operation: it acts on the Integration this BeamingFace connection belongs to and never reads or writes your BeamingFace context.";

export const integrationTools = [
  {
    name: "clued_integration_install",
    description:
      "Install or bind this connection as a BeamingFace Integration: opens an Installation Request and consumes it in one call (both steps are idempotent; repeat with the same request_key and idempotency_key). intent create_or_bind creates or binds by the full identity; rebind, reauthorization, reinstall, recovery, adapter_migration, verification_repair and bind_connection target one existing Integration. The provider connection identity is always derived by the server." + INTEGRATION_CONNECTION_SELF,
    inputSchema: {
      type: "object",
      required: ["request_key", "intent", "host", "host_surface", "adapter_family", "adapter_version", "idempotency_key"],
      properties: {
        request_key: { type: "string", minLength: 16, maxLength: 160 },
        intent: {
          type: "string",
          enum: ["create_or_bind", "bind_connection", "rebind", "reauthorization", "reinstall", "recovery",
            "adapter_migration", "verification_repair"],
        },
        target_integration_id: integrationIdSchema,
        host: { type: "string", minLength: 1, maxLength: 80 },
        host_surface: { type: "string", minLength: 1, maxLength: 80 },
        tenant: dimensionSchema,
        account: dimensionSchema,
        adapter_family: { type: "string", minLength: 1, maxLength: 80 },
        adapter_version: { type: "string", minLength: 1, maxLength: 40 },
        package_version: { type: "string", minLength: 1, maxLength: 40 },
        installation_phase: { type: "string", enum: ["STARTED", "COMPLETED"] },
        source_provenance: provenanceSchema,
        callback_provenance: provenanceSchema,
        idempotency_key: idempotencyKeySchema,
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_integration_status",
    description:
      "Read the Integration this connection belongs to: identity, claim state, lifecycle, revocation, the Canonical evaluation and effective capabilities. Optional profiles project READY(profile); emit_ready_receipt (with idempotency_key) binds the projection to a Receipt. Without integration_id it reports the Integration whose current connection this is, or NOT_ADOPTED." + INTEGRATION_CONNECTION_SELF,
    inputSchema: {
      type: "object",
      properties: {
        integration_id: integrationIdSchema,
        profiles: {
          type: "array", minItems: 1, maxItems: 10,
          items: {
            type: "object", required: ["id", "version"],
            properties: { id: { type: "string", minLength: 1, maxLength: 120 }, version: { type: "integer", minimum: 1 } },
            additionalProperties: false,
          },
        },
        emit_ready_receipt: { type: "boolean" },
        idempotency_key: idempotencyKeySchema,
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_integration_declare",
    description:
      "Declare this Integration's Host surface, capabilities (within the surface ceiling; a declaration can only narrow) and Host features, and record an adapter or package upgrade. Requires the Integration's base_version." + INTEGRATION_CONNECTION_SELF,
    inputSchema: {
      type: "object",
      required: ["idempotency_key", "integration_id", "base_version", "host_surface", "declared_capabilities", "adapter_family", "adapter_version"],
      properties: {
        idempotency_key: idempotencyKeySchema,
        integration_id: integrationIdSchema,
        base_version: baseVersionSchema,
        host_surface: { type: "string", minLength: 1, maxLength: 80 },
        declared_capabilities: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 80 } },
        host_features: { type: "object", additionalProperties: { type: "boolean" } },
        adapter_family: { type: "string", minLength: 1, maxLength: 80 },
        adapter_version: { type: "string", minLength: 1, maxLength: 40 },
        package_version: { type: "string", minLength: 1, maxLength: 40 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_integration_report",
    description:
      "Report a narrowing Host or adapter fact (host_state DEGRADED / HARD_UNAVAILABLE, adapter_state DEGRADED / BLOCKED), or clear your own earlier report. An adapter can never widen or override an operator or policy fact." + INTEGRATION_CONNECTION_SELF,
    inputSchema: {
      type: "object",
      required: ["idempotency_key", "integration_id", "base_version", "action", "truth_class"],
      properties: {
        idempotency_key: idempotencyKeySchema,
        integration_id: integrationIdSchema,
        base_version: baseVersionSchema,
        action: { type: "string", enum: ["set", "clear"] },
        truth_class: { type: "string", enum: ["host_state", "adapter_state"] },
        value: { type: "string", enum: ["DEGRADED", "HARD_UNAVAILABLE", "BLOCKED"] },
        mask: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 80 } },
        reason: { type: "string", minLength: 1, maxLength: 500 },
        valid_until: { type: "string", minLength: 1, maxLength: 64 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_integration_identity_update",
    description:
      "Strengthen this Integration's tenant or account identity with verified evidence and re-claim it, or (action request_reconcile) move a CLAIM_CONFLICT Integration to PENDING_RECONCILE for the Owner to resolve in BeamingFace. Verified dimensions cannot be withdrawn here." + INTEGRATION_CONNECTION_SELF,
    inputSchema: {
      type: "object",
      required: ["idempotency_key", "integration_id", "base_version"],
      properties: {
        action: { type: "string", enum: ["update", "request_reconcile"], default: "update" },
        idempotency_key: idempotencyKeySchema,
        integration_id: integrationIdSchema,
        base_version: baseVersionSchema,
        tenant: dimensionSchema,
        account: dimensionSchema,
        active_binding_domain: { type: "string", minLength: 1, maxLength: 80 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_integration_verify",
    description:
      "Record a verification of this Integration: kind canonical_baseline checks the Canonical runtime baseline from server-observed evidence (the Worker supplies the MCP transport facts; a caller-supplied transport is ignored); kind ready_profile checks one READY profile and requires the Integration to be operable. Failures are recorded as FAIL results with a Receipt. A canonical_baseline retry with the same idempotency_key replays only under the same MCP protocol version and BeamingFace build; after either changes, verify again with a new idempotency_key." + INTEGRATION_CONNECTION_SELF,
    inputSchema: {
      type: "object",
      required: ["kind", "idempotency_key", "integration_id", "base_version"],
      properties: {
        kind: { type: "string", enum: ["canonical_baseline", "ready_profile"] },
        idempotency_key: idempotencyKeySchema,
        integration_id: integrationIdSchema,
        base_version: baseVersionSchema,
        profile_id: { type: "string", minLength: 1, maxLength: 120 },
        profile_version: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_integration_revoke",
    description:
      "Revoke this Integration from the Host side. It always revokes every credential of this connection's own provider-connection identity; when the Integration also holds Bindings of another identity, the result is PARTIAL_CONNECTION_REVOKE and the Owner should revoke the whole Integration in BeamingFace. A revoked Integration is only recovered by the Owner's explicit restore in BeamingFace; reconnecting never restores it." + INTEGRATION_CONNECTION_SELF,
    inputSchema: {
      type: "object",
      required: ["idempotency_key", "integration_id", "reason"],
      properties: {
        idempotency_key: idempotencyKeySchema,
        integration_id: integrationIdSchema,
        reason: { type: "string", minLength: 1, maxLength: 500 },
      },
      additionalProperties: false,
    },
  },
] as const;

export type IntegrationToolName = (typeof integrationTools)[number]["name"];

// §12.2 annotations. Interim scope (OQ-12): ["context:read"] until the S2a registry can express
// connection-self operations (the description says so).
export const integrationToolPolicies = {
  clued_integration_install: {
    scopes: ["context:read"], readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_integration_status: {
    scopes: ["context:read"], readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_integration_declare: {
    scopes: ["context:read"], readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_integration_report: {
    scopes: ["context:read"], readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_integration_identity_update: {
    scopes: ["context:read"], readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_integration_verify: {
    scopes: ["context:read"], readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_integration_revoke: {
    scopes: ["context:read"], readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
  },
} as const;

// The public RPC behind each tool (install is two calls; identity_update has two targets).
export const integrationRpcByTool = {
  clued_integration_install: "clued_integration_create_or_bind_v1",
  clued_integration_status: "clued_integration_status_v1",
  clued_integration_declare: "clued_integration_declare_v1",
  clued_integration_report: "clued_integration_report_v1",
  clued_integration_identity_update: "clued_integration_identity_update_v1",
  clued_integration_verify: "clued_integration_verify_v1",
  clued_integration_revoke: "clued_integration_revoke_self_v1",
} as const;

export type IntegrationFeatureEnv = { CLUED_INTEGRATION_RUNTIME_V1?: string };

// §12.1: its own flag, same shape as the other Worker flags; never recordsV2Enabled.
export function integrationRuntimeEnabled(env: IntegrationFeatureEnv) {
  return /^(1|true|on|enabled)$/i.test(env.CLUED_INTEGRATION_RUNTIME_V1?.trim() ?? "");
}

export function isIntegrationTool(name: unknown): name is IntegrationToolName {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(integrationRpcByTool, name);
}

export type IntegrationRpcCall = { rpc: string; input: Record<string, unknown> };

function objectArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args) ? { ...(args as Record<string, unknown>) } : {};
}

// The RPC calls one tool call makes, in order. For install, the second call's request_id is filled
// in from the first call's result by the caller. verify's transport is always the Worker's (§13.8
// T-W-5): a caller field of the same name is overwritten for canonical_baseline (CRV-3) and dropped
// for every other kind, which never reads it, so it stays out of their idempotency hash.
export function integrationCalls(name: IntegrationToolName, args: unknown,
  transport: { protocol_version: string | null; build_sha: string | null }): IntegrationRpcCall[] {
  const input = objectArgs(args);
  switch (name) {
    case "clued_integration_install": {
      const { idempotency_key, ...open } = input;
      const intent = typeof open.intent === "string" ? open.intent : "";
      return [
        { rpc: "clued_integration_request_open_v1", input: open },
        { rpc: "clued_integration_create_or_bind_v1",
          input: { idempotency_key, request_id: null, binding_intent: intent.toUpperCase() } },
      ];
    }
    case "clued_integration_identity_update": {
      const { action, ...rest } = input;
      if (action === "request_reconcile") {
        const { idempotency_key, integration_id, base_version } = rest;
        return [{ rpc: "clued_integration_reconcile_request_v1", input: { idempotency_key, integration_id, base_version } }];
      }
      return [{ rpc: "clued_integration_identity_update_v1", input: rest }];
    }
    case "clued_integration_verify": {
      const { transport: _caller, ...rest } = input;
      void _caller;
      return [{ rpc: "clued_integration_verify_v1",
        input: rest.kind === "canonical_baseline" ? { ...rest, transport } : rest }];
    }
    default:
      return [{ rpc: integrationRpcByTool[name], input }];
  }
}

// §11.2 request rules: every 42501 code an Integration RPC raises that is not an authorization
// denial (§13.8 T-W-4). One hint registry for both transports (§11.1).
export const INTEGRATION_AUTHORIZATION_CODES = [
  "binding_not_authorized", "direct_human_session_required", "integration_not_owned",
  "integration_connection_required", "platform_admin_required", "binding_not_owned",
] as const;

const OWNER_RESTORE = "A revoked Integration is restored only by the Owner in BeamingFace (restore), with a new authorization from the same client when it is in a claim conflict; reconnecting does not restore it.";
export const INTEGRATION_REQUEST_RULE_REJECTIONS: Readonly<Record<string, string | null>> = {
  installation_request_expired: "Open a new Installation Request and retry.",
  installation_request_closed: "Open a new Installation Request and retry.",
  installation_request_key_conflict: "Use a new request_key for a different installation attempt.",
  installation_request_bound_to_other_integration:
    "A Request binds exactly one Integration; open a new Request for the new target.",
  installation_request_intent_mismatch: null,
  identity_weak_identifier_forbidden:
    "Record that dimension as UNAVAILABLE; weak identifiers are never used to merge identities.",
  identity_dimension_evidence_unverified: null,
  identity_dimension_not_applicable_mismatch: null,
  identity_dimension_downgrade_forbidden: "Withdrawing a verified dimension needs a rebind Request.",
  host_not_registered: null,
  host_surface_not_registered: null,
  provider_not_registered: null,
  binding_owned_by_other_integration:
    "This Binding belongs to another Integration. The Owner can move it in BeamingFace (confirm_rebind, adopt_binding, restore or reconcile); if it is that Integration's current connection, switch that Integration to another connection or reconcile first. Do not revoke that Integration for this: revoking it revokes this Binding too.",
  binding_predates_revocation:
    "This authorization was issued before a revocation and cannot restore or create a connection. Reconnect in the Host and approve again on the consent page.",
  binding_not_adoptable: "Only personal Bindings that are live can be used.",
  integration_rebind_requires_owner_confirmation: "Ask the Owner to confirm this connection in BeamingFace (confirm_rebind).",
  integration_host_mismatch: "The Host is an identity dimension; install a new Integration for this Host.",
  integration_provider_mismatch: null,
  integration_recovery_forbidden: "Recovery of this Integration is only by the Owner's explicit restore in BeamingFace.",
  integration_revoked_requires_explicit_restore: OWNER_RESTORE,
  integration_superseded: "Use the Integration named in superseded_by.",
  integration_claim_blocked:
    "Finish the reconcile first; if the Integration is revoked, restore it with a new authorization from the same client (same key), then reconcile.",
  reconcile_not_applicable: null,
  reconcile_requires_active_connection: "Use REPLACE_HOLDER, or revoke or pause this Integration.",
  reauthorization_scope_expansion_forbidden:
    "Reauthorize with the original scope; a wider scope needs the Owner's explicit approval in BeamingFace.",
  restore_requires_new_authorization_decision: "Complete a new authorization first, then restore.",
  reauth_mark_not_open: null,
  capability_declaration_exceeds_ceiling: "A Host Adapter can only keep or narrow capabilities.",
  capability_unknown: null,
  host_feature_not_supported: null,
  adapter_report_cannot_expand: null,
  verification_not_eligible: "Read the blocking reasons in clued_integration_status before verifying again.",
  ready_profile_unknown: null,
  ready_verification_requires_operable: null,
  lifecycle_transition_invalid: null,
  // raised inside the Receipt (22023 → M1 rejected envelope), never as 42501
  derivation_input_invalid:
    "The change would make this Integration's inputs contradictory; supplemental.reason_codes names them.",
};

// Receipt-level rejections that are concurrency, not rules (§11.1): retryable conflicts.
export const INTEGRATION_CONFLICT_CODES = new Set([
  "integration_version_conflict", "installation_request_version_conflict", "identity_claim_retry_exhausted",
  "integration_revoke_connection_set_changed",
]);

const RULE_MESSAGE = "The request was refused by a BeamingFace contract rule; reconnecting will not change the outcome.";

// §12.3 integrationRuleEnvelope: an M1 envelope rejected inside the Receipt renders exactly like the
// pre-Receipt rule rejection (category request_rule, same hint table); a conflict code renders as a
// retryable conflict. Anything else is returned unchanged.
export function integrationRuleEnvelope(result: unknown, rules: Readonly<Record<string, string | null>>): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const value = result as Record<string, unknown>;
  if (value.status !== "rejected" || typeof value.error_code !== "string") return result;
  const code = value.error_code;
  const keep = { receipt_id: value.receipt_id ?? null, replayed: value.replayed ?? false,
    ...(value.supplemental && typeof value.supplemental === "object" && Object.keys(value.supplemental).length
      ? { supplemental: value.supplemental } : {}) };
  if (INTEGRATION_CONFLICT_CODES.has(code)) {
    return { status: "rejected", error: { code, category: "conflict", retryable: true }, ...keep };
  }
  if (Object.prototype.hasOwnProperty.call(rules, code)) {
    const hint = rules[code];
    return { status: "rejected", error: { code, category: "request_rule", message: RULE_MESSAGE, ...(hint ? { hint } : {}) }, ...keep };
  }
  return result;
}

// §12.4 bootstrap block, present only with the flag on.
export const INTEGRATION_STATES = ["INSTALL_PENDING", "INSTALLED", "AUTH_PENDING", "VERIFYING", "ACTIVE", "DEGRADED",
  "BLOCKED", "REAUTH_REQUIRED", "INCOMPATIBLE", "REVOKED"] as const;
export const INTEGRATION_CAPABILITY_VOCABULARY = ["context.read", "context.write", "audit.read", "project.read",
  "project.write", "evidence.write", "development_history.read"] as const;

export function integrationBootstrap() {
  return {
    enabled: true,
    contract: "clued.integration-runtime.v1",
    derivation_contract: "clued.integration-derivation.v1",
    facts_schema: "clued.integration-facts.v1",
    capability_vocabulary: INTEGRATION_CAPABILITY_VOCABULARY,
    tools: integrationTools.map((tool) => tool.name),
    states: INTEGRATION_STATES,
  };
}

// §12.4 Native REST: every route forwards to clued_user_integration_v1 with the account JWT.
const integrationIdPart = "([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})";
const integrationActionPattern = new RegExp(
  `^/v1/integrations/${integrationIdPart}/(revoke|restore|reconcile|lifecycle|identity|capability-expansion)$`);
const integrationItemPattern = new RegExp(`^/v1/integrations/${integrationIdPart}$`);
const confirmRebindPattern = new RegExp(`^/v1/integrations/requests/${integrationIdPart}/confirm-rebind$`);

export function isIntegrationPath(pathname: string) {
  return pathname === "/v1/integrations" || pathname.startsWith("/v1/integrations/");
}

export type IntegrationNativeRoute = { method: "GET" | "POST"; op: string; bind?: Record<string, string> };

// The Native op for a (method, path), or null for an unknown route. Path parameters are bound into
// the input by the caller and override body fields of the same name.
export function integrationNativeRoute(method: string, pathname: string): IntegrationNativeRoute | null {
  if (pathname === "/v1/integrations") return method === "GET" ? { method: "GET", op: "list" } : null;
  if (pathname === "/v1/integrations/binding-inventory") return method === "GET" ? { method: "GET", op: "binding_inventory" } : null;
  if (pathname === "/v1/integrations/adopt-binding") return method === "POST" ? { method: "POST", op: "adopt_binding" } : null;
  if (pathname === "/v1/integrations/requests") return method === "POST" ? { method: "POST", op: "request_open" } : null;
  const confirm = confirmRebindPattern.exec(pathname);
  if (confirm) return method === "POST" ? { method: "POST", op: "confirm_rebind", bind: { request_id: confirm[1].toLowerCase() } } : null;
  const item = integrationItemPattern.exec(pathname);
  if (item) return method === "GET" ? { method: "GET", op: "status", bind: { integration_id: item[1].toLowerCase() } } : null;
  const action = integrationActionPattern.exec(pathname);
  if (action && method === "POST") {
    const op = ({ revoke: "revoke", restore: "restore", reconcile: "reconcile", lifecycle: "lifecycle",
      identity: "identity_update", "capability-expansion": "capability_expansion" } as const)[
      action[2] as "revoke" | "restore" | "reconcile" | "lifecycle" | "identity" | "capability-expansion"];
    return { method: "POST", op, bind: { integration_id: action[1].toLowerCase() } };
  }
  return null;
}

// HTTP status of a Native M1 envelope: committed 200, a conflict 409, a rule or input rejection 422,
// a failure 500 (§11.1: REST conflicts are 409).
export function integrationHttpStatus(result: unknown) {
  const value = result as { status?: string; error_code?: string } | null;
  if (value?.status === "failed") return 500;
  if (value?.status !== "rejected") return 200;
  return INTEGRATION_CONFLICT_CODES.has(value.error_code ?? "") || /IDEMPOTENCY_KEY_CONFLICT/.test(value.error_code ?? "") ? 409 : 422;
}
