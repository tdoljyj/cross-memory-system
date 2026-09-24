// Information Flow M0-D transport surface (contract
// development/contracts/information-flow/M0DCloseout.v0.1.md section 5.1).
// A Binding can submit, list and withdraw its own candidates, propose
// Candidate Knowledge and read packs; confirmation, promotion, reject and
// Context Policy acceptance stay Native (account-session REST only, never an
// MCP tool).

const uuidPattern = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
// Lower-case only: the store accepts no other project scope spelling.
const scopeSchema = { type: "string", pattern: "^(profile|global|project:[0-9a-f-]{36})$" } as const;
const idempotencyKeySchema = { type: "string", minLength: 8, maxLength: 160 } as const;
const requestHashSchema = { type: "string", pattern: "^[0-9a-f]{64}$" } as const;
const candidateStatusSchema = {
  type: "string", enum: ["pending", "promoted", "rejected", "conflict", "withdrawn", "expired"],
} as const;

export const informationFlowTools = [
  {
    name: "clued_intake_submit",
    description:
      "Submit Candidate Information by deterministic capture: an M0-A segment plus an explicit candidate document. The server validates both, computes the Evidence hash over the submitted segment, and stores pending candidates with authority=none. Candidates are never current truth and cannot be promoted by an Agent; promotion needs the Owner's Native two-step confirmation. The route fixes tier, source and Binding; payload fields cannot choose them.",
    inputSchema: {
      type: "object",
      required: ["idempotency_key", "scope", "segment", "candidates"],
      properties: {
        idempotency_key: idempotencyKeySchema,
        request_hash: requestHashSchema,
        scope: scopeSchema,
        segment: { type: "object", description: "M0-A segment-input.v1 document." },
        candidates: { type: "object", description: "M0-A candidate-information.v1 document for the same segment_id." },
        client_label: { type: "string", minLength: 1, maxLength: 120 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_intake_list",
    description:
      "List this Binding's own candidates in one scope (tier=information by default, or tier=knowledge). Every row is returned with authority=none and authoritative=false.",
    inputSchema: {
      type: "object",
      properties: {
        scope: scopeSchema,
        tier: { type: "string", enum: ["information", "knowledge"], default: "information" },
        status: candidateStatusSchema,
        submission_id: { type: "string", pattern: uuidPattern },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_intake_withdraw",
    description:
      "Withdraw one of this Binding's own pending Candidate Information rows (pending -> withdrawn) with row-version CAS and a Receipt.",
    inputSchema: {
      type: "object",
      required: ["idempotency_key", "candidate_id", "base_version"],
      properties: {
        idempotency_key: idempotencyKeySchema,
        request_hash: requestHashSchema,
        candidate_id: { type: "string", pattern: uuidPattern },
        base_version: { type: "integer", minimum: 1 },
        scope: scopeSchema,
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_knowledge_propose",
    description:
      "Propose Candidate Knowledge over explicit source Record versions with a closed rule id. Every source must be human-confirmed Authority Information the caller can read, at exactly the cited version, CURRENT or active; otherwise the proposal is rejected with a Receipt. No rule engine or model runs. The candidate has authority=none until the Owner promotes it natively.",
    inputSchema: {
      type: "object",
      required: ["idempotency_key", "scope", "rule_id", "assertion", "sources"],
      properties: {
        idempotency_key: idempotencyKeySchema,
        request_hash: requestHashSchema,
        scope: scopeSchema,
        rule_id: {
          type: "string",
          enum: ["knowledge.consolidate.v1", "knowledge.dedup.v1", "knowledge.cross_record_fact.v1"],
        },
        assertion: { type: "string", minLength: 1, maxLength: 2000 },
        sources: {
          type: "array", minItems: 1, maxItems: 20,
          items: {
            type: "object", required: ["id", "version"],
            properties: { id: { type: "string", pattern: uuidPattern }, version: { type: "integer", minimum: 1 } },
            additionalProperties: false,
          },
        },
        evidence_ids: { type: "array", maxItems: 20, uniqueItems: true, items: { type: "string", pattern: uuidPattern } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_context_pack",
    description:
      "Compile or read a Minimum Sufficient Context Pack under an accepted Context Policy. Compiling without an accepted policy fails closed with CONTEXT_POLICY_REQUIRED. A pack never grants execution authorization.",
    inputSchema: {
      type: "object",
      properties: {
        scope: scopeSchema,
        policy_id: { type: "string", pattern: uuidPattern },
        task_class: { type: "string", minLength: 1, maxLength: 120 },
      },
      additionalProperties: false,
    },
  },
] as const;

export const informationFlowRpcByTool = {
  clued_intake_submit: "clued_intake_submit",
  clued_intake_list: "clued_intake_list",
  clued_intake_withdraw: "clued_intake_withdraw",
  clued_knowledge_propose: "clued_knowledge_propose",
  clued_context_pack: "clued_context_pack",
} as const;

export type UserInformationFlowRpc = "clued_user_intake_submit" | "clued_user_intake_list" |
  "clued_user_intake_withdraw" | "clued_user_knowledge_propose" | "clued_user_context_pack" |
  "clued_candidate_confirmation_issue_v1" | "clued_candidate_promote_v1" | "clued_candidate_reject_v1" |
  "clued_context_policy_confirmation_issue_v1" | "clued_context_policy_accept_v1";

export const informationFlowListParameters = ["scope", "tier", "status", "submission_id", "limit"] as const;

const informationFlowPaths = /^\/v1\/(intake|knowledge|context\/(pack|policies))(\/|$)/;

export function isInformationFlowPath(pathname: string) {
  return informationFlowPaths.test(pathname);
}

// Per-candidate actions (contract 5.1). The route, not the body, fixes the
// tier: /v1/intake is Candidate Information, /v1/knowledge/candidates is
// Candidate Knowledge. Withdraw exists only for Candidate Information.
export const candidateActionPattern =
  /^\/v1\/(intake|knowledge\/candidates)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(withdraw|confirmation|promote|reject)$/i;

export type CandidateAction = {
  tier: "information" | "knowledge";
  candidateId: string;
  action: "withdraw" | "confirmation" | "promote" | "reject";
};

export function parseCandidateAction(pathname: string): CandidateAction | null {
  const match = candidateActionPattern.exec(pathname);
  if (!match) return null;
  const tier = match[1].toLowerCase() === "intake" ? "information" : "knowledge";
  const action = match[3].toLowerCase() as CandidateAction["action"];
  if (action === "withdraw" && tier !== "information") return null;
  return { tier, candidateId: match[2].toLowerCase(), action };
}

// Native-only actions: authenticated as an account session before any body
// parsing or RPC, and each request runs exactly one RPC.
export const nativeCandidateRpcByAction = {
  confirmation: "clued_candidate_confirmation_issue_v1",
  promote: "clued_candidate_promote_v1",
  reject: "clued_candidate_reject_v1",
} as const;

// Context Policy acceptance (contract 6.1): step 1 issues the confirmation
// token, step 2 consumes it. Both are Native account-session routes.
export const nativeContextPolicyRpcByPath = {
  "/v1/context/policies/confirmation": "clued_context_policy_confirmation_issue_v1",
  "/v1/context/policies": "clued_context_policy_accept_v1",
} as const;
