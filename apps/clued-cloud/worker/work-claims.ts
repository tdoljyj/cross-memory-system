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
const holderSessionRef = { type: "string", minLength: 1, maxLength: 200, description: "Your client's own session id (Claude Code: the session_01… id; Codex: its session id), never a name you made up; leave it out when you cannot get it. The Owner opens your session from it." } as const;
const budget = { type: "object", description: "Declared estimates (model tokens, CI minutes). Recorded, not enforced in v1." } as const;
const leaseSeconds = { type: "integer", minimum: 60, maximum: 7200, description: "Shorter than the profile default (7200) if the work is small." } as const;
const holderLabel = {
  type: "string", minLength: 1, maxLength: 200,
  description: "One line for people, shown to the Owner on the Clued work claims page as self-reported: what you are doing, which client, which machine (for example \"C-3 baseline refreeze · Claude Code · office laptop\"). Send it with every claim and takeover.",
} as const;
const holderClient = { type: "string", minLength: 1, maxLength: 80, description: "Your client, as people know it: Claude Code, Codex, ChatGPT, claude.ai… Self-reported." } as const;
const holderSessionTitle = { type: "string", minLength: 1, maxLength: 200, description: "Your session's title as the Owner sees it in your client, when you can read it. Self-reported." } as const;
const leaseKey = {
  type: "string", pattern: "^clued_lk_[0-9a-f]{64}$",
  description: "The claim's private lease key, from the clued_work_claim or clued_work_takeover answer. Only needed when your Binding is not the holder (after a reconnect, or when the Owner handed the claim to you). Never write it to a file, commit, pull request, record or log.",
} as const;

export const workClaimTools = [
  {
    name: "clued_work_claim",
    description:
      "Claim one existing active Task for execution before spending anything on it: before model calls, installs, builds, tests, CI or subtasks. Declares the write set (paths or globs) and trigger refs. Rejected with work_claim_conflict when another live claim names the same task, intersects the write set, or shares a trigger ref; the conflict names the holder so you stop, not retry under another title. One session (holder_session_ref) holds at most 3 live claims and one Binding at most 10 across its sessions. Each new claim or takeover takes a token from the Task's bucket (8, one back per hour) and the Binding's bucket (30, one back per 15 minutes); claiming per step or keeping one claim are both fine. A continuation takes none: claiming a Task again within 15 minutes after your Binding released its latest claim as completed with a new evidence_ref, unless someone else waited for that claim (the answer names continued_from). work_claim_budget_exhausted names the limit hit, with retry_after for a rate bucket and continuation.reason when the claim did not continue. The claim carries a fence and a lease (profile: 2 h, hard deadline 24 h). The answer's lease_key is the claim's private key: keep it in this session only, never in a file, commit, pull request, record or log; it lets this work continue after a reconnect gives you a new Binding. Idempotent by idempotency_key; a replay returns a new lease_key and the earlier one stops working.",
    inputSchema: {
      type: "object",
      required: ["task_id", "write_set", "idempotency_key", "holder_label"],
      properties: {
        scope, task_id: uuid, write_set: writeSet, trigger_refs: triggerRefs, idempotency_key: idempotencyKey,
        base_commit: baseCommit, holder_session_ref: holderSessionRef, holder_label: holderLabel,
        holder_client: holderClient, holder_session_title: holderSessionTitle, budget, lease_seconds: leaseSeconds,
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_work_renew",
    description:
      "Extend a claim's lease. Requires a new progress_ref (a head SHA or Receipt id you did not send before): a heartbeat without progress is refused with work_claim_no_progress. Bumps lease_version, never the fence. Bounded by the profile's renewal count and hard deadline. A changed write_set or trigger_refs re-runs conflict detection before it is accepted. A merge slot ref (merge:<owner>/<name>:<branch>) never conflicts: it joins that branch's merge queue, and merge_queue shows your state (head, waiting, lapsed, out), position and who is ahead. Only the head holds the slot (merge_slot_until, merge_slot_ci); a renewal keeps a waiting place. The head's slot starts when it becomes head and lapses 45 minutes after that or its last renewal, later while CI reports on its pull request, and never after the hard cap; then the next entry becomes head, and a renewal that keeps the ref joins again at the back. When your Binding is not the holder (a reconnect gave you a new one), pass the claim's lease_key with a new progress_ref (for example reconnect:<session id>): the renewal then moves the claim to your Binding (transferred: true; fence unchanged), holder_session_ref names your session, and the answer carries a new lease_key that replaces the one you sent; keep it private. Without the right key it is work_claim_not_holder; a wrong key from the holder is work_claim_lease_key_invalid. After the Owner hands a claim over on the Clued page (new fence, new key), every renew and release must carry the current key, even from the holder Binding; without it they are refused with work_claim_lease_key_required.",
    inputSchema: {
      type: "object",
      required: ["claim_id", "fence", "lease_version", "progress_ref"],
      properties: {
        scope, claim_id: uuid, fence: { type: "integer", minimum: 1 }, lease_version: { type: "integer", minimum: 1 },
        progress_ref: { type: "string", minLength: 1, maxLength: 200 }, write_set: writeSet, trigger_refs: triggerRefs,
        lease_key: leaseKey, holder_session_ref: { ...holderSessionRef, description: "Host session id, audit only; recorded when lease_key moves the claim to your Binding." },
        holder_label: { ...holderLabel, description: "Replaces the claim's label (see clued_work_claim); omit to keep it." },
        holder_client: holderClient, holder_session_title: holderSessionTitle,
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_work_release",
    description:
      "Release a claim you hold. completed or abandoned ends it; draining keeps it blocking conflicts while an already-dispatched, uncancellable action settles, and accepts no further renewal. When your Binding is not the holder, pass the claim's lease_key.",
    inputSchema: {
      type: "object",
      required: ["claim_id", "fence", "outcome"],
      properties: {
        scope, claim_id: uuid, fence: { type: "integer", minimum: 1 },
        outcome: { type: "string", enum: ["completed", "abandoned", "draining"] },
        evidence_ref: { type: "string", minLength: 1, maxLength: 200, description: "PR, commit or Receipt the outcome rests on. With completed, a new one lets the next claim of the Task within 15 minutes continue without a token." },
        lease_key: leaseKey,
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_work_verify",
    description:
      "Check a CI gate or reviewer runs: ADMITTED only when the claim is live, holds the task's current fence, and its write set covers every changed path. Reasons are listed (claim_not_found, claim_not_current, fence_superseded, paths_outside_write_set, claim_bound_to_other_pr, copy_not_adopted, task_ci_head_cap_reached, admission_binding_required). Without pr_ref it is read-only, and that is how an Agent checks a claim. With pr_ref (\"owner/repo#123\") the first admitting verify binds the claim to that pull request (one receipt) and any other pull request is then refused; once the Owner has marked a CI admission Binding, only that Binding may pass pr_ref (others get admission_binding_required). Each distinct head_sha it admits counts once toward the Task's GitHub CI meter: at most 40 heads per Task in any 24 hours, across all of its claims; a refusal gives ci_retry_after.",
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
      "Take over an expired claim (lease lapsed, holder gone). Issues a new claim on the same task with fence + 1 and marks the old one SUPERSEDED, so the old holder's fence is refused at verify and renew. A live, unexpired claim is refused with work_claim_still_active: priority never preempts. Inherits the old write set and trigger refs unless you pass new ones (re-checked for conflicts). Returns a new lease_key for the new claim (keep it private, as for clued_work_claim); the old claim's key stops working. Idempotent by idempotency_key.",
    inputSchema: {
      type: "object",
      required: ["claim_id", "idempotency_key", "holder_label"],
      properties: {
        scope, claim_id: uuid, idempotency_key: idempotencyKey, write_set: writeSet, trigger_refs: triggerRefs,
        base_commit: baseCommit, holder_session_ref: holderSessionRef, holder_label: holderLabel,
        holder_client: holderClient, holder_session_title: holderSessionTitle, budget, lease_seconds: leaseSeconds,
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
