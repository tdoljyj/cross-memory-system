# Clued continuity and memory contract (v1.6)

This repository follows `Clued_单一数据源与两级五视图架构方案_v1.6`.

## Authority and storage

- The authenticated Clued service backed by Supabase is the only online Canonical Store.
- Repository `memory/` is a read-only, versioned export of one canonical snapshot. It is never a write target.
- `memory/manifest.json` and the files it hashes are one atomic publication unit. A snapshot proves only its recorded as-of boundary. A current-claimed snapshot requires `baseline_claim=current`, `source_verification=live_rechecked`, `views_complete=true`, and `status=ready`, but still does not establish online Current Truth. A legitimate historical/offline or incomplete snapshot follows its own manifest, authorization and integrity contract and must retain its historical/incomplete qualification.
- `memory/index.json` is the only derived lookup index. Canonical Records, Projects, Events, Evidence and Receipts retain their stable service IDs.
- Never recreate the retired local dual-write model: no Chinese root five-file set, no `memory/objects/*.json` Memory Engine objects, no `object-index.json`, and no Markdown-to-Canonical reverse write.

## Snapshot tenancy

- Repository `memory/` is a single-user snapshot, not a system-wide or multi-user export.
- Expected owner identity and bundle scope come only from the committed endpoint trust policy `config/clued-endpoint-trust.json`; do not duplicate account hints or owner identifiers in active instructions.
- Readers must verify the snapshot Manifest against that independent trust policy before using the snapshot.
- Other users must be accessed through authenticated Clued APIs or separate user-scoped exports; never treat or overwrite this root snapshot as another user's data.

## Memory Router

Default access is `NONE`. Decide before reading.

- T0: generic, non-personal work. Read nothing.
- T1: identity, preferences, cross-session history, or memory-system maintenance. Read the smallest relevant part of `memory/profile.md` and the required views.
- T2: active project work. Read Global priority, then exact Project `state.md`, `task.md`, and `decision.md`.
- T3: uncertain relevance. Light-read only State/Task/Decision.
- T4: explicit “remember this”. Write once through authenticated Clued M1 tools with `authority=user_explicit` and user confirmation; do not edit Markdown.

For online current work, resolve the effective Project by canonical project ID through the authenticated service and its Currentness contract. The deployed v1 Project schema may still expose legacy `certainty_status`; treat it as compatibility metadata, not as the product's organization model. The approved successor direction is `development/contracts/project-lifecycle/ProjectLifecycleSuccessor.v0.1.md` and is not production until its migration is reviewed, deployed and attested. The paths below are read-only snapshot lookup locations, not online Current Truth:

1. `memory/global/state.md`, `task.md`, `decision.md` for cross-project priority.
2. `memory/projects/{canonical_project_id}/state.md`, `task.md`, `decision.md` for the selected project.
3. `archive.md` and `log.md` only when historical evidence is required.
4. `memory/profile.md` only when identity or preferences materially affect the answer.

State/Task/Decision/Archive/Log remain the two-level Standard Work Projection. State references Task IDs; Task owns executable text; active Event truth carriers are evaluated separately from the historical Log view. Checkpoint and snapshot validity never bypass live currentness or action authorization.

Always report `sources_read` for an authoritative current-status answer. Treat `objects/legacy/` and legacy Event envelopes as compatibility history, not current truth.

## Read-before-alignment

For T1–T4, “latest/current”, audit, or implementation work:

1. Run `sync-memory.ps1 -AlignAndVerify -Access <scope>` exactly once on the Codex endpoint before relying on repository files. The unified request entry resolves `origin/main` to one concrete Commit SHA with one real `git ls-remote`; `-Access NONE` remains a zero-read/no-op path.
2. The same invocation passes that SHA explicitly to an isolated Git-object source. It may fetch that exact object without moving the development worktree HEAD, Index, or files, then classifies equal / Remote Ahead / Local Ahead / true divergence. True divergence emits a Git Conflict Packet and stops; the read path never merges, rebases, or overwrites the development worktree.
3. Every new request, independent retry, or new process runs `align-and-verify` again. Never cache or reuse PASS evidence across requests, Sessions, processes, devices, or Agents; never substitute mtime, a tracking ref, or an old SHA for the remote query.
4. `sync-memory.ps1 -AlignAndVerify` 已在同一 Python 进程、同一 RequestVerificationContext 中完成 mirror 与 doctor。成功后不得在同一请求中再次运行 `python memory.py doctor`。独立执行 doctor 属于新的 doctor-only 请求，必须创建新的 Context 并重新校验。

Version truth is the remote commit plus root `VERSION`, git tags, `memory/manifest.json`, and the M2 `current.json` pointer. Version checks are triggered by relevant requests; never schedule them periodically.

## Request-local verification context

- A T1–T4, audit, status, doctor, or repository implementation request creates exactly one in-memory `RequestVerificationContext` after `align-and-verify`. `NONE`/T0 creates no Context and performs zero Git and zero Memory reads.
- Pass the Context and its resolved Remote Head SHA explicitly through the full `align-and-verify → mirror → doctor` call chain in one Python process. Never serialize it or reuse its PASS across requests, retries, Sessions, processes, devices, or Agents.
- Reuse is allowed only within the same request and trust boundary after rechecking path identity and ACL, streaming Manifest content identity, the Current Pointer, root `VERSION`, git HEAD/tags/repository identity, owner/scope, authorization evidence, TTL/clock, and validator versions. Any change invalidates the evidence and requires full validation or fails closed.
- Repository source, copy candidate, and local mirror are separate boundaries. A PASS at one boundary never replaces the independent source or target hash validation at another boundary.
- Expected Owner Ref and Bundle Scope come from the committed endpoint trust policy `config/clued-endpoint-trust.json`, independently of the Bundle and optional caller environment. Missing or changed trust policy, missing Manifest owner/scope, or a mismatch fails closed.
- An authoritative result must bind a complete Source Envelope to one currently valid successful Bundle Evidence: exact boundary, evidence ID, sources read, source versions, freshness (`current`, `historical`, or explicit `degraded` with reason), and the request-local verification summary. Zero validation, failed/invalidated Evidence, or an absent/mismatched boundary can never produce `authoritative=true`.

## Isolated local mirror and Backup policy

- Non-`NONE` reads obtain `memory/` from the single resolved Remote Commit through an isolated Git archive. They never copy from or modify development worktree files; a dirty development worktree may be bypassed for reads only.
- Repository source, Candidate, and active local Mirror are independently fully validated in the same request Context. Candidate construction, validation, deterministic Generation selection, logical atomic switch, rollback, retention, and audit are serialized by one cross-process exclusive lock per target Mirror.
- A no-op is allowed only for the same Snapshot Generation while the stored canonical path, directory/volume identity, ACL/read-only fingerprint, Manifest, Snapshot Version, and content evidence still match. Any change invalidates no-op evidence and requires full validation or fails closed.
- Different Snapshots are ordered by the intrinsic deterministic tuple `build_epoch`, numeric Canonical Version, and Snapshot Version. Thread or process lock acquisition order cannot downgrade the active Mirror.
- Local Backup retention follows `config/clued-local-mirror-backup-policy.json`. Backup is created only after a real replacement; policy decisions and switch/no-op events use `clued.local-mirror-audit.v1`. Legal Hold blocks deletion, Erasure is audited and deletes only when eligible, and deletion rechecks that the target is not the active Mirror, Candidate, or the minimum verified LKG.
- Mirror Generation and request-local PASS Evidence are never reused across requests, processes, devices, or Agents. The local Mirror is a read-only derived consumer cache, not a Canonical Store or publication pointer.

## Canonical writes

- Record create/update/close/restore/reclassification: `clued_record_mutate`.
- Decision replacement: `clued_decision_supersede`.
- Project lifecycle: `clued_project_mutate`.
- Evidence: `clued_evidence_ingest`; extension Events: `clued_event_append`.
- Use stable idempotency keys, CAS base versions for mutation, authenticated scope, exact canonical IDs, and the minimum authority supported by evidence.
- Successful Canonical writes already emit Event and immutable Receipt in the same contract. Never perform a second Markdown or Git business write.
- Refresh a repository snapshot only through Receipt-backed `clued_canonical_export`, deterministic build/validate, expected-current CAS publish, then the root cutover pipeline.
- Information Flow candidates (`development/contracts/information-flow/M0DCloseout.v0.1.md`): `clued_intake_submit` / `clued_user_intake_submit`, `clued_intake_withdraw` / `clued_user_intake_withdraw` and `clued_knowledge_propose` / `clued_user_knowledge_propose` write only isolated `clued_private` candidate rows through the M1 receipt/idempotency core (`intake_submit`, `intake_withdraw`, `knowledge_propose`; candidate rows use row-version CAS). A candidate is never a Canonical Record or current truth.
- Information Flow promotion (S3): `clued_candidate_confirmation_issue_v1` (step 1), `clued_candidate_promote_v1` (step 2) and `clued_candidate_reject_v1` are Native account-session RPCs only (`authenticated`, `authorization_owner_v12`; REST `POST /v1/intake/{id}/confirmation|promote|reject` and `POST /v1/knowledge/candidates/{id}/confirmation|promote|reject`; never an MCP tool, OAuth case or Binding). Promote and reject are receipt-core families `candidate_promote` / `candidate_reject` with candidate row-version CAS (`base_version` = candidate `version`). Issuing writes no Receipt: it stores only the hash of a single-use token (5-minute TTL, session authenticated within 15 minutes) bound to user, tier, candidate id and version, input digest, Native choices, pre-allocated Record id, session and the confirmation-view digest of the final Record body. Promotion consumes that token in the same transaction as the Record create, which goes only through `record_mutation_with_terminal_guard` (inner `record_mutation` Receipt; Record CAS is the M1 `base_version`), and records provenance in `clued_private.candidate_promotions`. Account-session writes through `/v1/records` and direct-session `/v1/decisions/supersede` also write `clued_private.native_write_markers`; `human_confirmed` is true only from those markers for the exact version (no backfill). S5 adds Evidence withdrawal as the same kind of receipt-core family.
- Information Flow Context Policy (S4): `clued_context_policy_confirmation_issue_v1` (step 1, REST `POST /v1/context/policies/confirmation`) and `clued_context_policy_accept_v1` (step 2, REST `POST /v1/context/policies`) are Native account-session RPCs only (`authenticated`, `authorization_owner_v12`; never an MCP tool, OAuth case or Binding). Acceptance is the receipt-core family `context_policy_accept`; its CAS is the policy lineage `base_policy_version` (the active `policy_version` for the `task_class`, 0 for a new lineage) and the approving Decision's M1 `base_version`. Issuing writes no Receipt and stores only the hash of a single-use token in `clued_private.native_confirmation_tokens` (5-minute TTL, session authenticated within 15 minutes, bound to user, action, `task_class`, lineage version, session and the view digest over the normalized `clued.context-policy.v1` document and the final Decision body). Acceptance writes the approving Decision only through `record_mutation_with_terminal_guard` (`binding_id=null`, `authority=user_explicit`), its `native_write_markers` row and the `clued_private.context_policies` row in one transaction. A policy is usable only while that exact Decision version is the current version, is CURRENT and is Native-marked; any update, supersede, close or shadowing fails compiles closed until a new Native acceptance. Compiles (`clued_context_pack` / `POST /v1/context/pack`) write only derived `clued_private.context_pack_manifests` rows (digests, source versions, stale flag; no pack bodies, no Receipt). A manifest or pack is never Canonical truth or an online fallback. Policies are never Markdown or repository files.

Superseded and archived facts remain in Canonical history. Do not delete them to express a correction. Failed business mutations must not be represented as successful state.

## Git and endpoint discipline

- No force push, reset, rebase, or local-over-remote overwrite.
- Dirty-worktree gates remain mandatory for repository implementation, commit, push, and every write path. Only the isolated read-only Mirror path may bypass a dirty development worktree, and it must not read, copy, stage, or modify dirty worktree files.
- Each endpoint edits only its own consumer configuration. Cross-endpoint exchange goes through the Canonical Store and versioned repository snapshot.
- `sync-memory.ps1` / `sync-memory.py` only pull and atomically mirror the read-only snapshot. Their business-memory push path must fail closed.
- Local-worktree Git writes use normal commits with `AI@machine` authorship, fetch+merge before push, and post-push `merge-base --is-ancestor` verification.
- GitHub/API connector writes follow `development/contracts/repository/GitConnectorWriteContract.v0.1.md`: bind the exact remote head, write through a branch with blob-SHA CAS, fail closed on conflict, review the exact diff, and use a PR for engineering/schema/workflow changes. Connector-authored commits are identified by the authenticated GitHub actor rather than a fabricated `AI@machine` author.
- `artifacts/clued-two-level-snapshots/published/{snapshot_version}` is immutable. Formal readers follow `artifacts/clued-two-level-snapshots/current.json`; repository `memory/` must byte-match that pointed Bundle at its cutover commit.

## External document placement

- Git 只承载与代码、协议/合同、ADR、Schema/Migration、测试/Fixture、Runbook、Skill、当前执行控制和可复现机器证据直接绑定的工程资料。
- 产品研究、战略、商业、品牌、视觉、汇报、会议/对话整理、历史评审/验收/Closeout 长报告及非构建用 Office/PDF/ZIP 统一放 Google Drive，不再提交到主仓库。
- 当前计划与确定基线目录：<https://drive.google.com/drive/folders/1Owx0Ow4RQY0CbYB5aDQ8RMXLNTA6EyT0>。
- 当前总索引：<https://drive.google.com/file/d/13TE41MmUMnMZ19imQlR5UtrIVEEaGDps/view?usp=drivesdk>。必须保留索引中的 Frozen / Fixed / Candidate / Historical / Open 边界；Drive 副本不会自行产生 Authority。
- 历史迁移位置与校验信息见 `docs/EXTERNAL_DOCUMENT_ARCHIVE.md`。
- 禁止新增会把上述叙事资料或冻结副本重新物化到 `docs/` 的归档工作流；仓库只保留短指针、机器合同和可执行证据。
