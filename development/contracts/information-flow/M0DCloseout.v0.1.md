# Information Flow MVP-0 M0-D Closeout Contract v0.1

Status: **PROPOSAL / NOT FROZEN / NO IMPLEMENTATION, DEPLOYMENT OR BUDGET AUTHORIZATION**
Owner task: Canonical Task `45fb2ae7-e698-4ec0-8107-7b2a7fea4d35`
Writer: AGENT_WRITTEN
Canonical Event / Receipt: PENDING. A freeze Decision is written only after the Owner rules on §3 and the Fresh-Context review passes.
Supersedes: nothing. This extends the M0-D interface in the M0-C plan §24 and records the extra scope that Task 45fb2ae7 adds.

## 1. Purpose

This contract closes Information Flow MVP-0. It has two parts. Each closes on its own, and they must never be reported as a single verdict.

- **Part A — M0-D as originally planned.** Full regression of the frozen M0-A/B/C parents, dependency closure, and the MVP-0 seal. It must not change any Fixture, Prompt, Schema, Taxonomy, Gold or Threshold (M0-C plan §24).
- **Part B — True Runtime Integration (added by Task 45fb2ae7).**
  - Native UI and third-party Agent runtime inputs enter the Information/Knowledge pipeline, bound to the Canonical Store.
  - Promotion chain: Candidate Information → Authority Information → Candidate Knowledge → Authority Knowledge.
  - Context chain: Context Policy → Context Compiler → Minimum Sufficient Context Pack (MSCP).
  - Cross-entry Runtime E2E, restart/continuity, and regression.

Every verdict in §10 carries its qualification environment. Local or non-production qualification must never be read as production integration (§3 OD-4).

## 2. Frozen parents (re-verified 2026-09-23)

The parents were restored from the Owner-uploaded Drive copies of release `information-flow-m0-frozen-archive-20260908`.

- The release SHA256SUMS digest is `24ea8ca343cd8f6526f9e8ae56e84d136b065e976c73f2fef24c86f6feef959e`, and all three transport ZIPs match it.
- The machine evidence is `evidence/parent-reverification-20260923.json`. The implementing agent produced it; it is not independent qualification.

| Parent | Delivery root SHA-256 | Adapter-verified files | Re-run result |
|---|---|---:|---|
| IF-MVP0-A | `d238cc438301a93ba5cf922b59d53efbe177f22d1c4918ea92218942b423d12b` | 35 | contract test 8/8; normalized digest `9aa2664d309915ada57f88c406a68b62417dfed1c62314f1185183352816fdee` equals the frozen report |
| IF-MVP0-B | `de080cb8b82a0e8e126d70be202aca5c32c942894a5f01ea3c555b57061f81a3` | 12 | 12/12 gates; digest `346158d70d075730d5ae8868d8c7015727a345dc5f8d8f4234c720adbbdf4b81` equals the frozen report |
| IF-MVP0-C | `d46ae622dc19d2355a92af4b0eacdd15756a8eeeb775c0a6bff0e9c5537fb7c1` | 159 | verify PASS; fixture validate `PASS_STATIC_ACCEPTANCE`; 27/27 tests |

`scripts/information-flow/frozen-parent-adapter.mjs` returns `PASS_SOURCE_BINDING_ONLY`. The re-run used Node 22.22.2, but the parents pin Node 24.19.0, so Part A reruns on 24.19.0 (M0D-A01).

Two locked parent designs are `ARTIFACT_NOT_AVAILABLE` in both Drive and the repository. They are bound by digest only, and none of their text is reconstructed here:

- `Clued_信息与知识流转核心链路_写入链与读取链_v1.0.md`: `f8a2823ff39232edc8a2f51bd15928760f1fd3e1d6929814ccc44d36b16abf82`
- `Clued_信息提取分类_结构化存储与多视图投影技术方案_v1.0.md`: `a18ac8fd09371046e9cc3f1f599c24cf3110f12ffbbd86ae1e0e7412b46ea528`

## 3. Entry gap and Owner decisions

**Entry gap (blocking).** Per M0-C plan §21, only `PASS / …_PRIMARY_MODEL_EVALUATION_ACCEPTED` satisfies the model-evaluation precondition for M0-D. The M0-C parent holds only `PASS / CLUED_INFORMATION_FLOW_M0C_FIXTURE_AND_HARNESS_ACCEPTED`; Window B is locked and model PASS is disabled. Task 45fb2ae7 does not authorize budget or purchase.

Nothing is implemented until the Owner records the decisions below as a Canonical Decision with a Receipt. This PROPOSAL implies none of them.

- **OD-1 — model evaluation path.**
  - (a) Separately authorize M0-C Window B: Provider, exact model ID, parameters, No-Training/Retention facts, and `max_total_usd`. Part A then waits for Primary Model PASS.
  - (b) Go **model-free**. Part B runs with the M0-B extractor disabled. Candidate Information comes only from the deterministic capture in §5.1, and every claim excludes model quality. In Part A only A02 becomes `NOT_APPLICABLE_MODEL_FREE`; A01, A03 and A04 (parent regression, closure, seal) still have to pass. The closeout uses the model-free label in §10. Model extraction becomes a later successor gated by Window B.
  - (c) Defer M0-D. The verdict is `DEFERRED`, never a pass.
- **OD-2 — closeout shape.**
  - Either close MVP-0 only on Part A + Part B together, or accept a Part-B-only closeout (§10 label) while Part A waits for OD-1(a).
- **OD-3 — candidate storage.**
  - Recommended: a new isolated private candidate store (§4.2).
  - The alternative, reusing M1 Records with `authority=inferred`, is **not eligible** until an admission guard exists and passes its own gate. Inferred `state`/`task` Records are `active` and currently advance Currentness, so candidates would leak into current truth.
- **OD-4 — environment.**
  - Part B qualifies on local/embedded PostgreSQL with the full migration chain and non-production principals only.
  - Any clued-prod apply is a separate, explicitly authorized step with its own pre-apply backup and read-back. Until that read-back exists, verdicts carry `_LOCAL_QUALIFIED`.
- **OD-5 — human confirmation for promotion.**
  - Today, M1 lets any Agent Binding write `authority=user_explicit` if it sends `user_confirmed=true`. The flag is self-attested (`20260825171129_clued_m1_runtime_contracts.sql:246,327`).
  - For Part B promotion this contract requires a **new** guard (§4.3.2). Whether the same guard should also tighten general M1 writes is a separate Owner decision; this contract does not change existing M1 behavior.
  - Consequence while OD-5 stays open: a bound Agent can still write Authority Information directly through the public `clued_record_mutate`, bypassing Candidate, promotion and the token. This bypass is registered as known limitation `OPEN_BY_OD-5` (A03), recorded as observed by E2E-11, and every PASS label in §10 carries the qualifier "Agent authority confined only on the Information Flow path".

## 4. Object model

### 4.1 Tiers

| Tier | Carrier | Authority | Can enter an MSCP? |
|---|---|---|---|
| Candidate Information | Candidate store row (§4.2) conforming to M0-A `candidate-information.v1` | none | Only when the Context Policy explicitly allows `candidate` and the item carries a visible `CANDIDATE` label. Default: no. |
| Authority Information | Existing M1 Canonical Record created through the internal M1 mutation (§4.3) | `state/task/decision`: only with the §4.3.2 Native token (any authority). `note`: a Binding may self-promote as `observed` (with Evidence) or `inferred` (with `confidence`) | Yes. For `state/task/decision` this goes through the Currentness fence; other types go through the lineage check in §6.4. |
| Candidate Knowledge | Derived assertion over ≥1 Authority Information record (consolidation, dedup, cross-record fact); a store row with lineage | none | Same rule as Candidate Information |
| Authority Knowledge | M1 `note` Record whose `type_fields.knowledge` carries lineage: source Record IDs + versions, rule id, Evidence IDs | Rule-derived knowledge is `inferred` with a `confidence`; `user_explicit` only through the §4.3.2 token | Yes, only while every lineage source still passes §6.4 |

- No new Canonical Record type and no second Canonical Store. The Authority tiers reuse the M1 mutation, Event and Receipt contract.
- Currentness triggers only cover `state`, `task` and `decision` (`20260922092355_bug_20260922_002_currentness_core.sql:223`). So Authority Knowledge (`note`) is **not** Currentness-tracked, and its validity comes only from the lineage mechanism in §6.4 (slice S5).

### 4.2 Candidate store (recommended form for OD-3)

- An additive migration creates `clued_private.information_candidates` and `clued_private.knowledge_candidates`.
  - Owner-scoped with RLS.
  - No table grants to `anon`, `authenticated` or `service_role`.
  - Access only through definer RPCs.
- Required columns:
  - `id`, `user_id`, `scope`, `tier`;
  - `payload`, validated against `candidate-information.v1` or a knowledge schema;
  - `source_kind` (`native_ui` | `agent_binding`), `binding_id` (nullable);
  - `evidence_ids`, `input_digest`, `idempotency_key`;
  - `status` (`pending` / `promoted` / `rejected` / `conflict` / `withdrawn` / `expired`);
  - `promoted_record_id` + `promoted_version`;
  - `decided_by`, `decided_at`, `expires_at`;
  - a Receipt reference for each transition.
- `(user_id, idempotency_key)` is unique. Reusing a key with a different digest is rejected with an M1-style rejected Receipt.
- Candidate rows never appear as current truth in Currentness, Frontier, MTPE, the five views, search or export.

### 4.3 Promotion rules

1. **One definer RPC per promotion.** `clued_candidate_promote_v1` calls `clued_private.record_mutation_core` directly, with CAS/idempotency, `authority` no higher than the Evidence supports, and the candidate's `evidence_ids` as `source_refs`.
   - The candidate transition and the Record write commit in one transaction; a failure leaves the candidate `pending`.
   - `record_mutation_core` and `clued_private.evidence_ingest_core` must not be re-implemented or forked.
   - Provenance: the Receipt records both the originating binding (the candidate's `binding_id`, or `native_ui`) and the confirming principal. An Agent-originated candidate is never promoted as if it had no origin.
2. **Human confirmation guard (new; OD-5).** Promotion with `authority=user_explicit` is accepted only with a single-use confirmation token.
   - The Native account-session route issues the token.
   - The token is bound to user, candidate id, input digest and expiry.
   - A Binding principal is rejected for `user_explicit` promotion regardless of `user_confirmed`.
   - Promotion into `state`, `task` or `decision` (types that advance Currentness) always requires the Native token, whatever the authority. A Binding can never turn its own capture into current truth without a human.
   - A Binding may self-promote only into `note`, and only as `observed` (at least one Evidence ID in the candidate) or `inferred` (with a `confidence`). Anything else is rejected.
3. **Knowledge promotion.** Candidate Knowledge → Authority Knowledge follows the same path. At promotion time, every lineage source must be CURRENT (`state/task/decision`) or pass the lineage check (other types).
4. **Terminal transitions.** Reject, conflict and expiry are explicit transitions with a Receipt. A rejected Candidate is never silently re-proposed with the same digest.
5. **Untrusted content is data.** Agent output, pasted text and tool output cannot choose their own tier, authority, scope or target Record ID.

## 5. Runtime ingestion

### 5.1 Entry points

| Entry | Transport | Identity |
|---|---|---|
| Native UI | Account-session REST route (new `/v1/intake`) | Authenticated human; may obtain a confirmation token |
| Third-party Agent | MCP tool `clued_intake_submit` on an Agent Binding with `context:write` | Binding principal; can never confirm |

Both entries call one definer RPC, `clued_intake_submit_v1`. It:

- validates scope against the Binding's `context_keys`;
- records Evidence by calling `clued_private.evidence_ingest_core` (hash + size), never a second implementation;
- writes Candidate rows by deterministic capture only (OD-1b), using the envelope fields the caller supplied explicitly;
- emits `extension:information_flow:candidate_submitted` with `audit_visibility=audit_only` and a set `event_schema_version`.

Why that Event cannot shadow State/Task (`20260922092355_bug_20260922_002_currentness_core.sql`):
- On the typed path (schema version set), an event type with no active `typed_event_currentness_registry` entry returns before any truth carrier is created (:170-174).
- On the untyped path, the trigger returns when there is no session (:181), or because `event_currentness_dimensions` yields no dimensions for `extension:*` types (:90-99, :186).
- Even a registered audit-only carrier would stay outside the `visibility='work_log'` shadow check. A regression test asserts the event type stays unregistered unless a reviewed change adds it.

Model extraction (the M0-B prompts) attaches only after OD-1(a) reaches PASS, behind a separate flag and gate.

### 5.2 Required properties

- **Idempotency.** Submit and retry are idempotent. An unknown outcome is resolved by replaying the same key, never by using a new one.
- **Source envelope.** Records the entry, binding id, client label, `received_at` and input digest.
- **Injection resistance.** Prompt or tool injection inside the payload cannot change tier, scope, authority or target. The M0-C SEC-001…008 fixture texts are reused as runtime inputs.

## 6. Context Policy, Compiler and MSCP

### 6.1 Context Policy

`clued.context-policy.v1` is a versioned, digest-bound object with these fields:

- `task_class`;
- allowed scopes and record types;
- allowed tiers (default: Authority only);
- required and optional fields;
- verbatim constraints;
- token budget and tokenizer binding;
- freshness: `current`, explicit `historical` with a reason, or explicit `degraded` with a reason (per AGENTS.md). A `degraded` pack can never be `authoritative=true`.

Storage rules:

- An accepted policy is stored in a `clued_private.context_policies` row. The row is referenced by the approving Canonical Decision ID and carries its digest.
- Policies are never Markdown or repository files.
- Compiling without an accepted policy fails closed.

### 6.2 Compiler

The Compiler builds on `scripts/phase2-qualification/minimum-context-compiler`, which is deterministic, fail-closed and uses a real tokenizer.

- It moves behind an authenticated service read, replacing the caller-supplied policy.
- It authorizes before retrieval: source scopes are filtered before LIMIT.
- It binds Evidence IDs and hashes by reusing the `evidence-context-binding` source reader.
- There is no semantic summarization in MVP-0. Insufficient context returns an explicit `CONTEXT_INSUFFICIENT`.
- The tokenizer target (`gpt-4.1-2025-04-14` / `o200k_base`) is not accepted (compiler README). Until a separate acceptance, token counts are labeled `tokenizer_status=offline_target`.

### 6.3 MSCP

`clued.context-pack.v1` contains:

- policy id and digest;
- the complete Source Envelope: for each item, Canonical ID, version, scope, type, tier, Evidence IDs/hashes, and currentness or lineage status;
- the compile-inputs digest;
- token count and tokenizer id/status;
- a pack digest;
- `execution_authorization=NOT_GRANTED`.

Storage and determinism:

- **Only the pack manifest is stored**, in `clued_private.context_pack_manifests`: inputs digest, source list with versions, pack digest, and a stale flag. Pack bodies are recomputed on demand.
- The same inputs, policy and source versions must produce a byte-identical pack.

### 6.4 Invalidation and lineage (slice S5)

- **Pack manifests are marked stale by:**
  - a source Record update, close or supersede;
  - Evidence withdrawal;
  - a scope or binding reduction;
  - a policy version change.
  A consumer that revalidates a stale manifest gets `STALE`/`PROJECTION_REQUIRED`. A pack is never an online fallback.
- **Authority Knowledge lineage.** A new additive `clued_private.knowledge_lineage` table holds the lineage edges and a `lineage_stale` flag. A trigger sets that flag when a lineage source changes or is withdrawn. The trigger writes **only** to `knowledge_lineage`; it never modifies the Canonical `note` Record. The Record itself changes only through a Receipt-backed re-promotion or close via `record_mutation_core`. Lineage-stale knowledge is excluded from current compiles until then.
- **Evidence withdrawal (new; S5).** `public.clued_evidence` has no withdrawal state today (`20260825171129_clued_m1_runtime_contracts.sql:75-89`). S5 adds an additive, Receipt-backed Evidence withdrawal transition, owner-only and via a definer RPC, that fans out to candidates, lineage and pack manifests. Evidence rows are never deleted.

## 7. Runtime E2E scenarios (Part B)

Every scenario runs against local PostgreSQL with the full migration chain and two real principals: an account session and an Agent Binding. Each scenario produces machine evidence.

| ID | Scenario | Pass condition |
|---|---|---|
| E2E-01 | Native capture → Candidate → human token confirm → Authority Information → MSCP consumed by the third-party Agent | The pack contains the promoted Record at its exact version, with the Evidence hash |
| E2E-02 | Agent capture → Candidate → Agent promotes with `authority=user_explicit` **and `user_confirmed=true`**; Agent promotes to `observed` with no Evidence; Agent promotes its own candidate into a `task` as `inferred` | All rejected with a Receipt; Candidate stays `pending`; a later Native token confirmation succeeds; a replayed or foreign token is rejected |
| E2E-03 | Candidate Knowledge over two Authority Records → promotion → one source updated | Its `knowledge_lineage` row is flagged `lineage_stale` (the Record itself is unchanged), dependent manifests become stale, and a recompile excludes it |
| E2E-04 | Evidence withdrawal | The dependent Candidate, knowledge lineage and pack manifest are invalidated; the Evidence row still exists |
| E2E-05 | Binding scope reduction | The next compile omits the reduced scope, and the existing manifest fails revalidation |
| E2E-06 | Injection payloads (SEC-001…008 texts) through both entries | Tier, scope, authority and target unchanged; zero external actions |
| E2E-07 | Submit, kill the process before the response, retry with the same key; then retry with a different digest | A single Candidate; the digest conflict is rejected with a Receipt |
| E2E-08 | Restart/continuity: a new process and new session resume from the Canonical Store only | The same pending Candidates, and a recomputed pack digest equal to the stored manifest; no local cache used as truth |
| E2E-09 | No-model mode | Zero model/provider calls counted; claims carry `model_extraction=NOT_EVALUATED` |
| E2E-10 | Global-projection interaction | Candidate submit/transition does not invalidate or shadow Global projections; promotion to `state/task/decision` does (via `touch_currentness`); promotion to `note` does not |
| E2E-11 | OD-5 bypass probe: a bound Agent calls public `clued_record_mutate` with `authority=user_explicit` and `user_confirmed=true` | Recorded as **observed behavior**, not a pass: while OD-5 is open the write succeeds, and the result is filed under `OPEN_BY_OD-5`; runs only on a disposable local database with a synthetic principal; if OD-5 is later decided, the expectation flips to rejection |

## 8. Gates

### Part A

| Gate | Requirement |
|---|---|
| M0D-A01 PARENTS | All three delivery roots re-verified on Node 24.19.0 through the adapter, and each parent's own entry exits zero |
| M0D-A02 MODEL PRECONDITION | Passes **only** with Primary Model PASS (OD-1a). OD-1(b) makes A02 `NOT_APPLICABLE_MODEL_FREE` while A01/A03/A04 are still required; OD-1(c) makes it `DEFERRED` |
| M0D-A03 CLOSURE | Dependency locks, digests and the known-limitations register (including `OPEN_BY_OD-5`) are complete; zero parent bytes modified |
| M0D-A04 SEAL | MVP-0 manifest + SHA256SUMS over the closeout evidence |

### Part B

| Gate | Requirement |
|---|---|
| M0D-B01 SCHEMA | Only additive migrations, covering every new table (`information_candidates`, `knowledge_candidates`, `context_policies`, `context_pack_manifests`, `knowledge_lineage`, Evidence withdrawal). On local PostgreSQL: RLS and grants verified, `db:lint`, `test:authorization:migrations`, and `test:production:release-gate` (the offline unit test only; `apps/clued-cloud/scripts/production-release-gate.mjs --pre-deploy` reads production and belongs to the separately authorized apply) |
| M0D-B02 INTAKE | Both entries satisfy §5.2, including E2E-06 and E2E-07. The new MCP tool lands with a reviewed `mcp:tools:freeze` baseline diff showing exactly one added tool, approved in the S2 PR |
| M0D-B03 PROMOTION | §4.3 proven by E2E-01, 02 and 03, including the new confirmation guard; E2E-11 observation filed |
| M0D-B04 CONTEXT | Policy, compiler and MSCP determinism and fail-closed cases; E2E-01 and 05; token counts labeled per §6.2 |
| M0D-B05 INVALIDATION | E2E-03, 04 and 05, with the lineage and Evidence-withdrawal migrations |
| M0D-B06 CONTINUITY | E2E-08 |
| M0D-B07 REGRESSION | These pass: `test:context:v2`, `test:projection:refresh`, `test:mtpe:intake`, `db:test:m1`, `test:authorization:*`, `mcp:tools:verify` against the refrozen baseline, and the parent adapter. Environmental baseline failures are listed with proof that they fail identically on main |
| M0D-B08 ISOLATION | Zero production writes, zero model/provider calls (unless OD-1a), zero cost |
| M0D-B09 REVIEW | A Fresh-Context, read-only final review reports 0 BLOCKER / 0 MAJOR |

## 9. Implementation slices (after freeze)

1. **S1** Candidate store migration, RPC and tests (B01).
2. **S2** Intake entries: REST and MCP tool, plus the tools baseline refreeze (B02).
3. **S3** Promotion RPC and the human confirmation token guard (B03).
4. **S4** Migration for `context_policies` and `context_pack_manifests`, service Compiler (B01, B04).
5. **S5** Lineage, Evidence withdrawal and invalidation fan-out (B05).
6. **S6** E2E harness, continuity, regression and final review (B06–B09).

Part A runs alongside the slices once OD-1 is recorded. Each slice is its own PR with CI and review, and no slice merges before its gate passes.

## 10. Verdict labels

`<env>` is `_LOCAL_QUALIFIED` until a separately authorized production apply has been read back. After that it is omitted. While OD-5 is open, every PASS label also carries the qualifier "Agent authority confined only on the Information Flow path".

- `PASS / CLUED_INFORMATION_FLOW_M0D_MVP0_CLOSED<env>` — Part A + Part B, with Primary Model PASS.
- `PASS / CLUED_INFORMATION_FLOW_M0D_MVP0_CLOSED_RUNTIME_WITHOUT_MODEL_EXTRACTION<env>` — OD-1(b): Part A A01/A03/A04 pass (A02 N/A) and Part B complete.
- `PASS / CLUED_INFORMATION_FLOW_M0D_PART_B_RUNTIME_ACCEPTED<env>` — the OD-2 Part-B-only closeout; MVP-0 stays open.
- `DEFERRED / CLUED_INFORMATION_FLOW_M0D_MODEL_PRECONDITION_UNMET` — OD-1(c).
- `BLOCKED / CLUED_INFORMATION_FLOW_M0D_GAPS_FOUND`
- `FAIL / CLUED_INFORMATION_FLOW_M0D_AUTHORITY_OR_ISOLATION_VIOLATION`

## 11. Does not authorize

- production migration, deployment or release;
- Provider/model calls, or any budget;
- purchase;
- changes to M0-A/B/C bytes;
- promotion of real user data during qualification;
- changes to the general M1 `user_confirmed` semantics (OD-5);
- MTPE/Frontier changes;
- entry to Phase 2 Slice A, or claims that P-007/P-008/P-009/P-011 are complete.

Qualification evidence stays local engineering evidence until a separate production apply is authorized and read back.
