// Work Claim Admission v0.1, step 2 (development/contracts/execution-admission/
// WorkClaimAdmission.v0.1.md §4.2, §8.2). Five MCP tools over the step-1 RPCs,
// plus the resume fold-in. Behind CLUED_WORK_CLAIMS_V1 so that deploying the
// Worker before the migration is applied changes nothing.

export interface WorkClaimFeatureEnv {
  CLUED_WORK_CLAIMS_V1?: string;
}

export function workClaimsEnabled(env: WorkClaimFeatureEnv) {
  return /^(1|true|on|enabled)$/i.test(env.CLUED_WORK_CLAIMS_V1?.trim() ?? "");
}

export const WORK_CLAIMS_ACTIVE_RPC = "clued_work_claims_active_v1";
export const WORK_CLAIMS_ACTIVE_OAUTH_TOOL = "clued_work_claims_active";

export const workClaimRpcByTool = {
  clued_work_claim: "clued_work_claim_v1",
  clued_work_renew: "clued_work_renew_v1",
  clued_work_release: "clued_work_release_v1",
  clued_work_verify: "clued_work_verify_v1",
  clued_work_takeover: "clued_work_takeover_v1",
} as const;

const scope = {
  type: "string",
  pattern: "^(global|project:[0-9a-fA-F-]{36})$",
  default: "global",
  description: "Context of the task: \"global\" (default) or \"project:<canonical_project_id>\".",
} as const;
const uuid = { type: "string", format: "uuid" } as const;
const writeSet = {
  type: "array", minItems: 1, maxItems: 200, uniqueItems: true,
  items: { type: "string", minLength: 1, maxLength: 400 },
  description: "Repository paths or globs this work will change (\"*\" within a segment, \"**\" across segments), or typed resources kind:value: storage:<connection_id>/<path under the registered root> (checked by the Clued storage write tools), repo:<owner>/<name>/<path>, record:<canonical id>. No whitespace; cover names with spaces by a glob. Normalized and sorted by the server.",
} as const;
const triggerRefs = {
  type: "array", maxItems: 50, uniqueItems: true,
  items: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,31}:\\S{1,200}$" },
  description: "What set this work off, as kind:value (for example ghsa:GHSA-xxxx, ci:trivy@<base_sha>, issue:<n>, pr:<n>). Two claims that share a ref conflict whatever their titles.",
} as const;
const idempotencyKey = { type: "string", minLength: 8, maxLength: 160 } as const;
const baseCommit = { type: "string", pattern: "^[0-9a-f]{7,64}$" } as const;
const holderSessionRef = { type: "string", minLength: 1, maxLength: 200, description: "Host session id, audit only." } as const;
const budget = { type: "object", description: "Declared estimates (model tokens, CI minutes). Recorded, not enforced in v1." } as const;
const leaseSeconds = { type: "integer", minimum: 60, maximum: 7200, description: "Shorter than the profile default (7200) if the work is small." } as const;

export const workClaimTools = [
  {
    name: "clued_work_claim",
    description:
      "Claim one existing active Task for execution before spending anything on it: before model calls, installs, builds, tests, CI or subtasks. Declares the write set (paths or globs) and trigger refs. Rejected with work_claim_conflict when another live claim names the same task, intersects the write set, or shares a trigger ref; the conflict names the holder so you stop, not retry under another title. One session (holder_session_ref) holds at most 3 live claims and one Binding at most 10 across its sessions. Each new claim or takeover takes a token from the Task's bucket (8, one back per hour) and the Binding's bucket (30, one back per 15 minutes); claiming per step or keeping one claim are both fine. work_claim_budget_exhausted names the limit hit, with retry_after for a rate bucket. The claim carries a fence and a lease (profile: 2 h, hard deadline 24 h). Idempotent by idempotency_key.",
    inputSchema: {
      type: "object",
      required: ["task_id", "write_set", "idempotency_key"],
      properties: {
        scope, task_id: uuid, write_set: writeSet, trigger_refs: triggerRefs, idempotency_key: idempotencyKey,
        base_commit: baseCommit, holder_session_ref: holderSessionRef, budget, lease_seconds: leaseSeconds,
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_work_renew",
    description:
      "Extend a claim's lease. Requires a new progress_ref (a head SHA or Receipt id you did not send before): a heartbeat without progress is refused with work_claim_no_progress. Bumps lease_version, never the fence. Bounded by the profile's renewal count and hard deadline. A changed write_set or trigger_refs re-runs conflict detection before it is accepted.",
    inputSchema: {
      type: "object",
      required: ["claim_id", "fence", "lease_version", "progress_ref"],
      properties: {
        scope, claim_id: uuid, fence: { type: "integer", minimum: 1 }, lease_version: { type: "integer", minimum: 1 },
        progress_ref: { type: "string", minLength: 1, maxLength: 200 }, write_set: writeSet, trigger_refs: triggerRefs,
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_work_release",
    description:
      "Release a claim you hold. completed or abandoned ends it; draining keeps it blocking conflicts while an already-dispatched, uncancellable action settles, and accepts no further renewal.",
    inputSchema: {
      type: "object",
      required: ["claim_id", "fence", "outcome"],
      properties: {
        scope, claim_id: uuid, fence: { type: "integer", minimum: 1 },
        outcome: { type: "string", enum: ["completed", "abandoned", "draining"] },
        evidence_ref: { type: "string", minLength: 1, maxLength: 200, description: "PR, commit or Receipt the outcome rests on." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_work_verify",
    description:
      "Check a CI gate or reviewer runs: ADMITTED only when the claim is live, holds the task's current fence, and its write set covers every changed path. Reasons are listed (claim_not_found, claim_not_current, fence_superseded, paths_outside_write_set, claim_bound_to_other_pr, claim_head_cap_reached). Without pr_ref it is read-only; with pr_ref (\"owner/repo#123\") the first admitting verify binds the claim to that pull request (one receipt) and any other pull request is then refused; each distinct head_sha it admits is recorded, and a claim admits at most 20 heads.",
    inputSchema: {
      type: "object",
      required: ["claim_id"],
      properties: {
        scope, claim_id: uuid,
        changed_paths: { type: "array", maxItems: 2000, items: { type: "string", minLength: 1, maxLength: 400 } },
        head_sha: { type: "string", pattern: "^[0-9a-f]{7,64}$" }, base_sha: { type: "string", pattern: "^[0-9a-f]{7,64}$" },
        pr_ref: { type: "string", pattern: "^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}#[0-9]{1,10}$" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_work_takeover",
    description:
      "Take over an expired claim (lease lapsed, holder gone). Issues a new claim on the same task with fence + 1 and marks the old one SUPERSEDED, so the old holder's fence is refused at verify and renew. A live, unexpired claim is refused with work_claim_still_active: priority never preempts. Inherits the old write set and trigger refs unless you pass new ones (re-checked for conflicts). Idempotent by idempotency_key.",
    inputSchema: {
      type: "object",
      required: ["claim_id", "idempotency_key"],
      properties: {
        scope, claim_id: uuid, idempotency_key: idempotencyKey, write_set: writeSet, trigger_refs: triggerRefs,
        base_commit: baseCommit, holder_session_ref: holderSessionRef, budget, lease_seconds: leaseSeconds,
      },
      additionalProperties: false,
    },
  },
] as const;

export const workClaimToolPolicies = {
  clued_work_claim: {
    scopes: ["context:write"], readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_work_renew: {
    scopes: ["context:write"], readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
  },
  clued_work_release: {
    scopes: ["context:write"], readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
  },
  clued_work_verify: {
    // With pr_ref the first admitting verify binds the claim (one receipt), so not read-only.
    scopes: ["context:read"], readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  clued_work_takeover: {
    scopes: ["context:write"], readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
  },
} as const;

// Resume fold-in. The Worker adds contract_version (what it serves at
// /clued-agent.md, so a Skill can compare its local copy) and the live claims
// of this user. A failed claims read never fails the resume: the fields say so.
export function withWorkClaimContext(
  resume: unknown,
  contractVersion: number,
  claims: unknown,
): unknown {
  if (!resume || typeof resume !== "object" || Array.isArray(resume)) return resume;
  const record = resume as Record<string, unknown>;
  if (record.error) return resume;
  const body = claims && typeof claims === "object" && !Array.isArray(claims)
    ? claims as Record<string, unknown> : null;
  if (!body || body.status !== "ok" || !Array.isArray(body.active_work_claims)) {
    return { ...record, contract_version: contractVersion, active_work_claims: null, active_work_claims_unavailable: true };
  }
  return {
    ...record,
    contract_version: contractVersion,
    active_work_claims: body.active_work_claims,
    active_work_claim_count: body.active_work_claims.length,
    work_claim_profile: body.work_claim_profile ?? null,
  };
}
