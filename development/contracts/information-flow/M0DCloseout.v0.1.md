# Information Flow MVP-0 M0-D Closeout Contract v0.1

Status: **FROZEN v0.1 (Owner freeze 2026-09-23) / IMPLEMENTATION OF SLICES S1–S6 ON LOCAL/CI ONLY / NO PRODUCTION, DEPLOYMENT, RELEASE OR BUDGET AUTHORIZATION**
Owner task: Canonical Task `45fb2ae7-e698-4ec0-8107-7b2a7fea4d35`
Writer: AGENT_WRITTEN
Canonical Event / Receipt: the freeze is recorded by a Canonical Decision that cites this file's commit and SHA-256 (the digest is deliberately not written inside the file). OD decisions: Decision `ef229e68-bff5-4dca-9b7f-159a08096748` / Receipt `dc4f356f-1653-4345-8c42-dabd2807e1ad`. Freeze rule: the freeze Decision is written only after the Owner rules on §3 and the Fresh-Context review passes. The Owner writes it through the Native account session, or an Agent writes it only after explicit in-conversation Owner confirmation that is quoted in the Decision. The implementing Agent never freezes on its own initiative. The same standard applies to the OD-1…OD-5 Decisions, to an OD-4 record that accepts local qualification as closure, and to any amendment of the M0-C plan. Where an Agent writes one, the Decision records the writing Receipt's `binding_id` and the quoted confirmation, and it is disclosed as Agent-written under the `OPEN_BY_OD-5` limitation. OD-1(a) additionally requires the Owner to state the budget in their own words. Once S3 is available, the OD-4 local-closure acceptance and any M0-C amendment (the decisions that complete the Task) must additionally be `human_confirmed=true` through a Native marker.
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

**Recorded 2026-09-23:** Canonical Decision `ef229e68-bff5-4dca-9b7f-159a08096748`, Event 1240, Receipt `dc4f356f-1653-4345-8c42-dabd2807e1ad`, bound to contract commit `39af780`.
- OD-1: **(b)** model-free
- OD-2: Part B separate result **allowed**
- OD-3: **isolated candidate store**
- OD-5: general M1 **unchanged**, registered `OPEN_BY_OD-5`
- OD-4: stands as written.

The Decision was written by an Agent with the Owner's popup answers quoted, which is within the `OPEN_BY_OD-5` disclosure. The Owner then froze the contract in a separate confirmation (see header).

- **OD-1 — model evaluation path.**
  - (a) Separately authorize M0-C Window B: Provider, exact model ID, parameters, No-Training/Retention facts, and `max_total_usd`. Part A then waits for Primary Model PASS.
  - (b) Go **model-free**. Part B runs with the M0-B extractor disabled. Candidate Information comes only from the deterministic capture in §5.1, and every claim excludes model quality. A01, A03 and A04 (parent regression, closure, seal) still run, but A02 stays **unmet**: the frozen M0-C §21 precondition is not rewritten. MVP-0 therefore stays open, and the result is `PART_B_RUNTIME_ACCEPTED_MODEL_FREE` (§10). Only a separate, Receipt-backed Owner amendment of the M0-C plan could allow MVP-0 to close without Primary Model PASS. Model extraction becomes a later successor gated by Window B.
  - (c) Defer M0-D. The verdict is `DEFERRED`, never a pass.
- **OD-2 — closeout shape.**
  - Either close MVP-0 only on Part A + Part B together, or accept a Part-B-only result (§10 label) while Part A waits for OD-1(a).
- **OD-3 — candidate storage.**
  - Recommended: a new isolated private candidate store (§4.2).
  - The alternative, reusing M1 Records with `authority=inferred`, is **not eligible** until an admission guard exists and passes its own gate. Inferred `state`/`task` Records are `active` and currently advance Currentness, so candidates would leak into current truth.
- **OD-4 — environment.**
  - Part B qualifies on local/embedded PostgreSQL with the full migration chain and non-production principals only.
  - Any clued-prod apply is a separate, explicitly authorized step with its own pre-apply backup and read-back. Until that read-back exists, verdicts carry `_LOCAL_QUALIFIED`.
  - Task 45fb2ae7's criterion "truly connected to the Canonical Store" is **not** met by a `_LOCAL_QUALIFIED` verdict. The Task can be completed only after an authorized production apply and read-back, or if the Owner explicitly records that local qualification is accepted as closure.
- **OD-5 — human confirmation for promotion.**
  - Today, M1 lets any Agent Binding write `authority=user_explicit` if it sends `user_confirmed=true`. The flag is self-attested (`20260825171129_clued_m1_runtime_contracts.sql:246,327`).
  - For Part B promotion this contract requires a **new** guard (§4.3.2). Whether the same guard should also tighten general M1 writes is a separate Owner decision; this contract does not change existing M1 behavior.
  - Consequence while OD-5 stays open: a bound Agent can still write Authority Information directly through the public `clued_record_mutate`, bypassing Candidate, promotion and the token. It could also write a Decision that appears to accept a Context Policy; §6.1 therefore requires the Native token for policy acceptance. Such directly written Records are classified as Agent-authored (§6.3) and are excluded from the default policy (E2E-12). This bypass is registered as known limitation `OPEN_BY_OD-5` (A03), recorded as observed by E2E-11, and every PASS label in §10 carries the qualifier "Agent authority confined only on the Information Flow path".

## 4. Object model

### 4.1 Tiers

| Tier | Carrier | Authority | Can enter an MSCP? |
|---|---|---|---|
| Candidate Information | Candidate store row (§4.2) conforming to M0-A `candidate-information.v1` | none | Only when the Context Policy explicitly allows `candidate` and the item carries a visible `CANDIDATE` label. Default: no. |
| Authority Information | Existing M1 Canonical Record created through the M1 mutation wrapper (§4.3) | Only with the §4.3.2 Native token, for every record type; authority no higher than the Evidence supports | Yes, if `human_confirmed` (§6.3). Every type must also be unflagged in `record_evidence_status` (§6.4); `state/task/decision` additionally pass the Currentness fence, and `note`/`profile_fact` must be `active`. |
| Candidate Knowledge | Derived assertion over ≥1 Authority Information record (consolidation, dedup, cross-record fact); a store row with lineage. Created only through the knowledge-proposal surfaces in §5.1, never by intake | none | Same rule as Candidate Information |
| Authority Knowledge | M1 `note` Record whose `type_fields.knowledge` carries lineage: source Record IDs + versions, rule id, Evidence IDs | Only with the §4.3.2 Native token; rule-derived knowledge is `inferred` with a `confidence` | Yes, only while every lineage source still passes §6.4 |

- No new Canonical Record type and no second Canonical Store. The Authority tiers reuse the M1 mutation, Event and Receipt contract.
- Currentness triggers only cover `state`, `task` and `decision` (`20260922092355_bug_20260922_002_currentness_core.sql:223`). So Authority Knowledge (`note`) is **not** Currentness-tracked, and its validity comes only from the lineage mechanism in §6.4 (slice S5).

### 4.2 Candidate store (recommended form for OD-3)

- An additive migration creates `clued_private.information_candidates` and `clued_private.knowledge_candidates`.
  - Owner-scoped with RLS.
  - No table grants to `anon`, `authenticated` or `service_role`.
  - Access only through definer RPCs.
- Required columns:
  - `id`, `user_id`, `scope`, `tier`;
  - `payload`, validated against `candidate-information.v1` or a knowledge schema. The M0-A schema is vendored into the repository as a byte-identical copy pinned to its M0-A file digest and checked by the parent adapter; the parent bytes are never modified;
  - `source_kind` (`native_ui` | `agent_binding`), `binding_id` (nullable);
  - `evidence_ids`, `input_digest`, `idempotency_key`;
  - `status` (`pending` / `promoted` / `rejected` / `conflict` / `withdrawn` / `expired`);
  - `promoted_record_id` + `promoted_version`;
  - `decided_by`, `decided_at`, `expires_at`;
  - a Receipt reference for each transition.
- `(user_id, idempotency_key)` is unique. Reusing a key with a different digest is rejected with an M1-style rejected Receipt.
- Candidate rows never appear as current truth in Currentness, Frontier, MTPE, the five views, search or export.

### 4.3 Promotion rules

1. **One definer RPC per promotion.** `clued_candidate_promote_v1` calls `clued_private.record_mutation_with_terminal_guard`, the wrapper the public record-mutate entries use (Decision supersede uses `decision_supersede_core` and is not a promotion path). The wrapper takes `currentness_user_lock` before the Receipt and row locks (`20260922140000_context_v2_terminal_restore_guard.sql:46-53`). The call uses CAS/idempotency and the candidate's `evidence_ids` as `source_refs`. The authority rule is:
   - `user_explicit`: only when the Native user selects it at step 2.
   - `observed`: requires ≥1 Evidence ID whose `content_hash` the intake RPC computed server-side over the submitted bytes (§5.1). Caller-asserted hashes from the generic `evidence_ingest_core` path (`20260825171129_clued_m1_runtime_contracts.sql:908-915`) do not qualify.
   - `inferred`: requires a `confidence`.
   - `imported`: never.
   - **Record body mapping.** The Record's `record_type` and `type_fields` come from a closed per-tier mapping of the M0-A `item_type`, not from the payload. Priority and MTPE-relevant keys are stripped: `intake_kind`, actionable `note_kind`/`state_kind`, `execution_bucket`, `priority`, `current_frontier_blocking` and the other keys read by `20260924110000_mtpe_universal_intake_auto_priority.sql:78-109`. They are set only if the Native user sets them explicitly at step 2.
   - The confirmation-view digest (§4.3.2) covers the **final** Record body (type, title, content, `type_fields`, authority) exactly as it will be written.
   - The candidate transition and the Record write commit in one transaction; a failure leaves the candidate `pending`.
   - Neither the wrapper, `record_mutation_core` nor `clued_private.evidence_ingest_core` may be re-implemented or forked.
   - Provenance: the M1 Receipt holds a single `binding_id`, and a Native-confirmed promotion writes it as null. So a new additive side table, `clued_private.candidate_promotions`, keyed by Receipt ID, stores the originating principal (the candidate's `binding_id` or `native_ui`), the confirming principal and the token ID. An Agent-originated candidate is never promoted as if it had no origin.
2. **Human confirmation guard (new; OD-5).** Promotion is accepted only with a single-use confirmation token obtained in a separate step.
   - **Issue:** `POST /v1/intake/{id}/confirmation` (Native account session only) returns a token bound to user, candidate id, input digest and the digest of the confirmation view the UI renders. The TTL is 5 minutes, and the session must have authenticated within the last 15 minutes.
   - **Consume:** `POST /v1/intake/{id}/promote` passes the token to `clued_candidate_promote_v1`. The definer RPC itself (not only the Worker) verifies and consumes it: single use, every binding, TTL, and `auth_time` within 15 minutes. It records the token in `candidate_promotions`. Issue and consume can never happen in the same request. A direct PostgREST call with the user's JWT but no valid token is rejected.
   - **Residual limit (disclosed, A03):** the guard proves a recently authenticated Native account session that performed a two-step confirmation. It cannot prove that a person, not a script holding that session, pressed the button. Contract text says "human" only in this sense.
   - A Binding principal is rejected for `user_explicit` promotion regardless of `user_confirmed`.
   - **Every** promotion requires the Native token, whatever the record type or authority. A Binding can submit candidates and read packs, but cannot promote anything. So, **on the Information Flow path**, Agent input never becomes Authority Information or Authority Knowledge without a human. The direct M1 path is the disclosed `OPEN_BY_OD-5` exception.
3. **Knowledge promotion.** Candidate Knowledge → Authority Knowledge follows the same path, including the Native token. At promotion time, every lineage source must still be at **exactly** the proposed version and still `human_confirmed`. It must also be CURRENT (`state/task/decision`) or active and unflagged (other types). Otherwise the candidate moves to `conflict`.
4. **Terminal transitions.** Reject, conflict and expiry are explicit transitions with a Receipt. A rejected Candidate is never silently re-proposed with the same digest.
5. **Untrusted content is data.** Agent output, pasted text and tool output cannot choose their own tier, authority, scope, target Record ID, `record_type` or priority/MTPE `type_fields`.
6. **MTPE effect (disclosed).** A promoted Record syncs into `mtpe_intake_projection` through the existing trigger (`20260924110000_mtpe_universal_intake_auto_priority.sql:291`), so it can affect Frontier selection. That is the intended outcome of human-confirmed promotion. It happens only through fields the Native user saw in the confirmation digest.

## 5. Runtime ingestion

### 5.1 Entry points

| Entry | Transport | Identity |
|---|---|---|
| Native UI | Account-session REST route (new `/v1/intake`) | Authenticated human; may obtain a confirmation token |
| Third-party Agent | MCP tool `clued_intake_submit` on an Agent Binding with `context:write` | Binding principal; can never confirm or promote |

The complete new transport surface. B02 freezes the MCP baseline against exactly this list:

| Surface | Native account session (REST) | Agent Binding (MCP) |
|---|---|---|
| Submit Candidate Information | `POST /v1/intake` | `clued_intake_submit` |
| Propose Candidate Knowledge | `POST /v1/knowledge/candidates` | `clued_knowledge_propose` |
| List own candidates | `GET /v1/intake` | `clued_intake_list` (own binding's candidates only) |
| Issue confirmation token (step 1) | `POST /v1/intake/{id}/confirmation`, `POST /v1/knowledge/candidates/{id}/confirmation` | none |
| Promote with token (step 2) / reject | `POST /v1/intake/{id}/promote`, `POST /v1/knowledge/candidates/{id}/promote`, `…/reject` | none |
| Compile / read MSCP | `POST /v1/context/pack` | `clued_context_pack` |
| Accept Context Policy | `POST /v1/context/policies/confirmation` (step 1), `POST /v1/context/policies` (step 2, token) | none |
| Withdraw Evidence | `POST /v1/evidence/{id}/withdrawal/confirmation` (step 1), `POST /v1/evidence/{id}/withdrawal` (step 2, token) | none |
| Withdraw own candidate (status `withdrawn`) | `POST /v1/intake/{id}/withdraw` | `clued_intake_withdraw` (own binding's candidates only) |

Candidate Knowledge proposals:
- The caller supplies explicit source Record IDs + versions, a rule id from the closed set `knowledge.consolidate.v1` / `knowledge.dedup.v1` / `knowledge.cross_record_fact.v1`, the derived assertion text, and Evidence IDs.
- The **route**, not the payload, assigns tier `candidate_knowledge`.
- Every source must be `human_confirmed` Authority Information that the caller is authorized to read, CURRENT or active, and unflagged; otherwise the proposal is rejected.
- MVP-0 has no automatic rule engine or model derivation. Proposals are explicit and deterministic, and promotion still needs the Native token.

`/v1/intake/*`, `/v1/knowledge/*`, `/v1/context/policies*` and `/v1/evidence/*/withdrawal*` are added to the Worker post-commit refresh list (`mayInvalidateApprovedProjection`, `worker/continuity.ts:545-551`), so promotions that invalidate Global projections are rebuilt. `/mcp` is already on that list.

Both entries call one definer RPC, `clued_intake_submit_v1`. It:

- validates scope against the Binding's `context_keys`;
- records Evidence by calling `clued_private.evidence_ingest_core`, never a second implementation. For intake the RPC computes `content_hash` and size itself over the submitted bytes, binds them to `input_digest`, and uses `storage_ref=intake:{candidate_id}` (the bytes live in the candidate payload). A caller-supplied hash is ignored;
- writes Candidate rows by deterministic capture only (OD-1b), using the envelope fields the caller supplied explicitly;
- emits `extension:information_flow:candidate_submitted` with `audit_visibility=audit_only`, written only through `clued_private.append_event_core` / `m1_append_event_row`.

Why that Event cannot shadow State/Task:
- The current `m1_append_event_row` (`20260922001800_k_cont_target_ref_read_boundary.sql:126`, body :175-176) stores `event_type='action'` and puts the extension name only in `canonical_event_type`, with `event_schema_version=1`.
- The typed branch then looks up the registry by `event_type='action'`. Registry keys must match `^extension:` (`20260922092355_bug_20260922_002_currentness_core.sql:68`), so the lookup never matches and the trigger returns before any truth carrier is created (:170-174).
- Audit-only carriers would in any case stay outside the `visibility='work_log'` shadow check (:194, :372).
- The regression test asserts both stored columns (`event_type`, `canonical_event_type`) **and** that no `event_truth_carriers` row exists for the Event.
- These `extension:information_flow:*` Events are audit trail only and never carry state. Candidate, withdrawal and policy state lives only in the `clued_private` tables. Because the public `clued_event_append` accepts any `^extension:` name, a Binding can forge an Event with the same name; a negative test proves that such an Event changes no candidate, withdrawal or policy state. A regression test asserts the event type stays unregistered unless a reviewed change adds it.

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
- A policy is bound to the approving Decision's ID, **version** and Receipt. It is usable only while that exact version is the Decision's current version, is CURRENT, and has a Native marker. Any update, supersede, close or shadowing of the Decision makes compiles under the policy fail closed until a new Native acceptance. Under OD-5 this lets a Binding cause denial of service but not a policy change; the DoS is registered in A03.
- Acceptance happens only through `POST /v1/context/policies` with a Native confirmation token. That route writes the approving Decision through the M1 wrapper `record_mutation_with_terminal_guard` with `binding_id=null`, `authority=user_explicit`, and stores the policy row in the same transaction. A Decision written by a Binding cannot activate a policy.
- The default policy includes only items with `human_confirmed=true` (§6.3). Agent-authored Records (for example E2E-11 bypass writes) are excluded unless a policy explicitly allows them, and then they carry an `AGENT_AUTHORED` label.
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
- the complete Source Envelope: for each item, Canonical ID, version, scope, type, tier, `writer_principal`, `human_confirmed`, Evidence IDs/hashes, and currentness or lineage status;
  - `writer_principal` comes from the Receipt that wrote the item's current version. A non-null `binding_id` means Agent-authored.
  - `human_confirmed=true` only from a positive marker for that exact version: a `candidate_promotions` row with a consumed Native token, or a `clued_private.native_write_markers` row (Receipt ID, `actor=native_account_session`, immutable). Markers are written in the same transaction by the account-session RPCs: `clued_user_record_mutate` (`/v1/records`), the `/v1/decisions/supersede` entry, and every new Native route in §5.1. S3 extends those RPCs additively. There is **no backfill**: Records written before S3 read `human_confirmed=false` until re-confirmed, and this limit is registered in A03. A null `binding_id` alone never counts, because migration, legacy, import and maintenance writes also have null bindings, and `binding_id` is `on delete set null`. Missing or unknown means false;
- `authoritative=false` whenever the pack contains any `CANDIDATE` or `AGENT_AUTHORED` item, or has `degraded` freshness;
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
- **Scope of these flags.** `lineage_stale` and `evidence_withdrawn` affect MSCP compilation only. The Record still reads CURRENT/active in Currentness, search, export and the five views until it is re-promoted, re-sourced or closed through the M1 wrapper. This divergence is disclosed and registered as a known limitation (A03).
- **Plain Authority notes** (`note`/`profile_fact` without `type_fields.knowledge`) are valid for compiles while `active` and not flagged `evidence_withdrawn`.
- **Compile-time recheck.** Every compile re-evaluates each lineage source's Currentness (`state/task/decision`) or active status. A source that is `STALE`, `SHADOWED_BY_ACTIVE_EVENT` or `PROJECTION_REQUIRED` excludes the dependent knowledge from that compile, even without a version change.
- **Authority Knowledge lineage.** A new additive `clued_private.knowledge_lineage` table holds the lineage edges and a `lineage_stale` flag. A trigger sets that flag when a lineage source changes or is withdrawn. The trigger writes **only** to `knowledge_lineage`; it never modifies the Canonical `note` Record. The Record itself changes only through a Receipt-backed re-promotion or close via `record_mutation_with_terminal_guard`. Lineage-stale knowledge is excluded from current compiles until then.
- **Evidence withdrawal (new; S5).** `public.clued_evidence` has no withdrawal state today (`20260825171129_clued_m1_runtime_contracts.sql:75-89`). S5 adds an additive Evidence withdrawal transition, owner-only, through a Native route and a definer RPC. Withdrawal state lives in a side table `clued_private.evidence_withdrawals` (Evidence rows are never modified or deleted). The transition writes an M1 Receipt with `operation_family='evidence_withdraw'`, using the existing M1 receipt/idempotency core (not a fork), with CAS on the withdrawal row, and emits `extension:information_flow:evidence_withdrawn` through `append_event_core` (audit-only, same no-carrier rule as §5.1). It fans out to:
  - candidates;
  - lineage;
  - pack manifests;
  - promoted Records whose `source_refs` cite the withdrawn Evidence. These get an `evidence_withdrawn` flag in the additive `clued_private.record_evidence_status` table; the Canonical Record itself is not modified. Flagged Records are excluded from current compiles until they are re-promoted or re-sourced through the M1 wrapper.

## 7. Runtime E2E scenarios (Part B)

Every scenario runs through the **local Worker transport** (`/mcp` and the `/v1/*` routes in §5.1), backed by local PostgreSQL with the full migration chain. It uses two real principals with real tokens: an account session and an Agent Binding. Direct database calls do not count as passing evidence. Each scenario produces machine evidence.

| ID | Scenario | Pass condition |
|---|---|---|
| E2E-01 | Native capture → Candidate → human token confirm → Authority Information → MSCP consumed by the third-party Agent | The pack contains the promoted Record at its exact version, with the Evidence hash |
| E2E-02 | Agent capture → Candidate → the Binding tries to promote: (i) via `POST /v1/intake/{id}/promote` with its Binding token and `authority=user_explicit` + `user_confirmed=true`; (ii) the same route to `note` as `observed`; (iii) a direct call to `clued_candidate_promote_v1` | (i)/(ii) rejected at Worker authentication (HTTP 401/403, logged, no RPC runs); (iii) `clued_candidate_promote_v1` is granted only to the Worker's account-session path, never to Binding-callable roles, so a direct Binding call fails with a permission error (42501) and no Receipt; MCP exposes no promotion tool; Candidate stays `pending`; a token issued and consumed in one request, or an expired token, is rejected; a later Native token confirmation succeeds; a replayed or foreign token is rejected |
| E2E-03 | The Agent proposes Candidate Knowledge (`clued_knowledge_propose`, `knowledge.consolidate.v1`) over two human-confirmed Authority Records → Native token promotion → one source updated | Its `knowledge_lineage` row is flagged `lineage_stale` (the Record itself is unchanged), dependent manifests become stale, and a recompile excludes it |
| E2E-04 | Evidence withdrawal | The dependent Candidate, knowledge lineage, pack manifest and promoted Record (flagged `evidence_withdrawn`) are invalidated, and a recompile excludes them; the Evidence row and the Record body are unchanged |
| E2E-05 | Binding scope reduction | The next compile omits the reduced scope, and the existing manifest fails revalidation |
| E2E-06 | Injection payloads (SEC-001…008 texts) through both entries | Tier, scope, authority and target unchanged; zero external actions |
| E2E-07 | Submit, kill the process before the response, retry with the same key; then retry with a different digest | A single Candidate; the digest conflict is rejected with a Receipt |
| E2E-08 | Restart/continuity: a new process and new session resume from the Canonical Store only | The same pending Candidates, and a recomputed pack digest equal to the stored manifest; no local cache used as truth |
| E2E-09 | No-model mode | Zero model/provider calls counted; claims carry `model_extraction=NOT_EVALUATED` |
| E2E-10 | Global-projection and MTPE interaction | Candidate submit/transition leaves `mtpe_intake_projection` and Frontier unchanged, and does not invalidate or shadow Global projections; a promotion whose payload carried stripped MTPE keys yields a Record without them; promotion to `state/task/decision` does (via `touch_currentness`); promotion to `note` does not |
| E2E-11 | OD-5 bypass probe: a bound Agent calls public `clued_record_mutate` with `authority=user_explicit` and `user_confirmed=true` | Recorded as **observed behavior**, not a pass: while OD-5 is open the write succeeds, and the result is filed under `OPEN_BY_OD-5`; runs only on a disposable local database with a synthetic principal; if OD-5 is later decided, the expectation flips to rejection |
| E2E-12 | Default-policy exclusion of Agent-authored Records: compile the default policy after the E2E-11 bypass write and after a Binding writes an `observed` `note` directly | Neither Record appears in the pack; with an explicit opt-in policy they appear labeled `AGENT_AUTHORED` and the pack is `authoritative=false` |
| E2E-13 | `human_confirmed` negative cases: a Record written by a migration/maintenance path with a null `binding_id`, and an Agent-authored Record whose Binding row is later deleted | Both are `human_confirmed=false` and excluded from the default pack |
| E2E-14 | Positive marker and forged Events: write a Record through Native `/v1/records` after S3; a Binding appends a forged `extension:information_flow:evidence_withdrawn` Event | The Native Record is `human_confirmed=true`; the forged Event changes no withdrawal, candidate or policy state |
| E2E-15 | Direct PostgREST call to `clued_candidate_promote_v1` with a valid user JWT but no/expired/reused token; an `observed` promotion whose Evidence hash was caller-asserted | All rejected by the RPC with a rejected Receipt; candidate stays `pending` |

## 8. Gates

### Part A

| Gate | Requirement |
|---|---|
| M0D-A01 PARENTS | All three delivery roots re-verified on Node 24.19.0 through the adapter, and each parent's own entry exits zero. Dependencies are installed outside each parent root, which the parents' README permits and M0-C verify requires |
| M0D-A02 MODEL PRECONDITION | Passes **only** with Primary Model PASS (OD-1a). Under OD-1(b) it stays `UNMET` and MVP-0 stays open; under OD-1(c) it is `DEFERRED` |
| M0D-A03 CLOSURE | Dependency locks, digests and the known-limitations register are complete: `OPEN_BY_OD-5`, the session-not-person confirmation limit (§4.3.2), and the MSCP-only scope of lineage/withdrawal flags (§6.4), no Native-marker backfill (§6.3), Binding-driven DoS under OD-5 (event shadowing or Decision edits can exclude any pack item or disable a policy; §6.1, §6.3), and the different confirmation strength of direct Native `/v1/records` writes (marker, no two-step token) versus promotion (two-step token). Zero parent bytes modified |
| M0D-A04 SEAL | MVP-0 manifest + SHA256SUMS over the closeout evidence |

### Part B

| Gate | Requirement |
|---|---|
| M0D-B01 SCHEMA | Only additive migrations, covering every new table (`information_candidates`, `knowledge_candidates`, `context_policies`, `context_pack_manifests`, `knowledge_lineage`, `candidate_promotions`, `native_write_markers`, `record_evidence_status`, `evidence_withdrawals`). On local PostgreSQL: RLS and grants verified, `db:lint`, `test:authorization:migrations`, and `test:production:release-gate` (the offline unit test only; `apps/clued-cloud/scripts/production-release-gate.mjs --pre-deploy` reads production and belongs to the separately authorized apply) |
| M0D-B02 INTAKE | Both entries satisfy §5.2, including E2E-06 and E2E-07. The `mcp:tools:freeze` baseline diff adds exactly the five MCP tools listed in §5.1 and changes nothing else, and is approved in the S2 PR. The REST routes match the same table |
| M0D-B03 PROMOTION | §4.3 proven by E2E-01, 02, 03 and 15, including the new confirmation guard; E2E-11 observation filed |
| M0D-B04 CONTEXT | Policy, compiler and MSCP determinism and fail-closed cases; E2E-01, 05, 12, 13 and 14; token counts labeled per §6.2 |
| M0D-B05 INVALIDATION | E2E-03, 04 and 05, with the lineage and Evidence-withdrawal migrations |
| M0D-B06 CONTINUITY | E2E-08 |
| M0D-B07 REGRESSION | These pass: `test:context:v2`, `test:projection:refresh`, `test:mtpe:intake`, `db:test:m1`, `db:test:v2`, `test:p5:postgres`, `test:project:lifecycle:v2`, `test:authorization:*`, `mcp:tools:verify` against the refrozen baseline, and the parent adapter. Environmental baseline failures are listed with proof that they fail identically on main |
| M0D-B08 ISOLATION | Zero production writes, zero model/provider calls (unless OD-1a), zero cost |
| M0D-B09 REVIEW | A Fresh-Context, read-only final review reports 0 BLOCKER / 0 MAJOR. It runs in a session distinct from the implementer that has not seen earlier review rounds, and the review report records the input commit and file digests |

### Canonical write families

The new transitions (candidate submit/promote/reject, knowledge propose/promote, policy acceptance, Evidence withdrawal) all write through the existing M1 receipt/idempotency core and, where they create or change Records, through `record_mutation_with_terminal_guard`. They are still new write families that AGENTS.md "Canonical writes" does not list. Freezing this contract requires a matching AGENTS.md amendment in the S1 PR that names these operations and their CAS rules: candidate and withdrawal rows use a row `version` CAS, and Records use the M1 `base_version`.

## 9. Implementation slices (after freeze)

1. **S1** Candidate store migration, RPC and tests (B01).
2. **S2** Intake and knowledge-proposal entries: REST routes and MCP tools per §5.1, refresh-list update, and tools baseline refreeze (B02).
3. **S3** Promotion RPC, `candidate_promotions` and `native_write_markers` tables, and the two-step confirmation token guard (B03).
4. **S4** Migration for `context_policies` and `context_pack_manifests`, service Compiler (B01, B04).
5. **S5** Lineage, `evidence_withdrawals`, `record_evidence_status`, and invalidation fan-out (B05).
6. **S6** E2E harness, continuity, regression and final review (B06–B09).

Part A runs alongside the slices once OD-1 is recorded. Each slice is its own PR with CI and review, and no slice merges before its gate passes.

## 10. Verdict labels

`<env>` is `_LOCAL_QUALIFIED` until a separately authorized production apply has been read back. After that it is omitted. While OD-5 is open, every PASS label also carries the qualifier "Agent authority confined only on the Information Flow path".

- `PASS / CLUED_INFORMATION_FLOW_M0D_MVP0_CLOSED<env>` — Part A + Part B, with Primary Model PASS.
- `PASS / CLUED_INFORMATION_FLOW_M0D_PART_B_RUNTIME_ACCEPTED_MODEL_FREE<env>` — OD-1(b): Part B complete, and A01/A03/A04 pass; A02 unmet, so MVP-0 stays open.
- `PASS / CLUED_INFORMATION_FLOW_M0D_PART_B_RUNTIME_ACCEPTED<env>` — the OD-2 Part-B-only result under OD-1(a) while Primary Model PASS is pending: Part B complete, A01/A03/A04 pass, A02 pending; MVP-0 stays open.
- `DEFERRED / CLUED_INFORMATION_FLOW_M0D_MODEL_PRECONDITION_UNMET` — OD-1(c).
- `BLOCKED / CLUED_INFORMATION_FLOW_M0D_GAPS_FOUND`
- `FAIL / CLUED_INFORMATION_FLOW_M0D_AUTHORITY_OR_ISOLATION_VIOLATION`

Task 45fb2ae7 stays open under both `PART_B_RUNTIME_ACCEPTED*` labels, `DEFERRED`, and any `_LOCAL_QUALIFIED` label unless the Owner records OD-4 local-closure acceptance. It completes only with `MVP0_CLOSED`.

## 11. Does not authorize

- production migration, deployment or release;
- Provider/model calls, or any budget;
- purchase;
- changes to M0-A/B/C bytes;
- promotion of real user data during qualification;
- changes to the general M1 `user_confirmed` semantics (OD-5);
- MTPE/Frontier rule or code changes (human-confirmed promotions do feed MTPE through the existing trigger; §4.3.6);
- entry to Phase 2 Slice A, or claims that P-007/P-008/P-009/P-011 are complete.

Qualification evidence stays local engineering evidence until a separate production apply is authorized and read back.
