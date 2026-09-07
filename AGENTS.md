# Clued continuity and memory contract (v1.6)

This repository follows `Clued_单一数据源与两级五视图架构方案_v1.6`.

## Authority and storage

- The authenticated Clued service backed by Supabase is the only online Canonical Store.
- Repository `memory/` is a read-only, versioned export of one canonical snapshot. It is never a write target.
- `memory/manifest.json` and the files it hashes are one atomic publication unit. A snapshot is authoritative for current work only when `baseline_claim=current`, `source_verification=live_rechecked`, `views_complete=true`, and `status=ready`.
- `memory/index.json` is the only derived lookup index. Canonical Records, Projects, Events, Evidence and Receipts retain their stable service IDs.
- Never recreate the retired local dual-write model: no Chinese root five-file set, no `memory/objects/*.json` Memory Engine objects, no `object-index.json`, and no Markdown-to-Canonical reverse write.

## Snapshot tenancy

- Repository `memory/` is a single-user snapshot, not a system-wide or multi-user export.
- Supabase project: `clued-prod`.
- Owner label: `primary-owner`.
- Account hint: `175***@qq.com`.
- Owner ref: `owner_0e58f3caef99d95912279cee`.
- Readers must verify `memory/manifest.json.owner_ref` before using this snapshot.
- Other users must be accessed through authenticated Clued APIs or separate user-scoped exports; never treat or overwrite this root snapshot as another user's data.

## Memory Router

Default access is `NONE`. Decide before reading.

- T0: generic, non-personal work. Read nothing.
- T1: identity, preferences, cross-session history, or memory-system maintenance. Read the smallest relevant part of `memory/profile.md` and the required views.
- T2: active project work. Read Global priority, then exact Project `state.md`, `task.md`, and `decision.md`.
- T3: uncertain relevance. Light-read only State/Task/Decision.
- T4: explicit “remember this”. Write once through authenticated Clued M1 tools with `authority=user_explicit` and user confirmation; do not edit Markdown.

For current work, resolve the confirmed Project by canonical project ID. Read:

1. `memory/global/state.md`, `task.md`, `decision.md` for cross-project priority.
2. `memory/projects/{canonical_project_id}/state.md`, `task.md`, `decision.md` for the selected project.
3. `archive.md` and `log.md` only when historical evidence is required.
4. `memory/profile.md` only when identity or preferences materially affect the answer.

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

Superseded and archived facts remain in Canonical history. Do not delete them to express a correction. Failed business mutations must not be represented as successful state.

## Git and endpoint discipline

- No force push, reset, rebase, or local-over-remote overwrite.
- Dirty-worktree gates remain mandatory for repository implementation, commit, push, and every write path. Only the isolated read-only Mirror path may bypass a dirty development worktree, and it must not read, copy, stage, or modify dirty worktree files.
- Each endpoint edits only its own consumer configuration. Cross-endpoint exchange goes through the Canonical Store and versioned repository snapshot.
- `sync-memory.ps1` / `sync-memory.py` only pull and atomically mirror the read-only snapshot. Their business-memory push path must fail closed.
- Script/document changes use normal Git commits with `AI@machine` authorship, fetch+merge before push, and post-push `merge-base --is-ancestor` verification.
- `artifacts/clued-two-level-snapshots/published/{snapshot_version}` is immutable. Formal readers follow `artifacts/clued-two-level-snapshots/current.json`; repository `memory/` must byte-match that pointed Bundle at its cutover commit.
<!-- BEGIN CLUED PHASE2 GOVERNANCE PROJECTION -->

本区块由已绑定的治理来源生成；候选、未定和历史状态保持原含义。它不授予权限，不写入业务 Canon，不宣告接受、冻结或实现。

来源集合摘要：`c7b4bf64ed6a802d3d1461eefcfddca327e494fa23d2e04c7fd2905674d40c02`；事实模型摘要：`cb0accfb9446a91d9fcddd289e1d39334e35081ca95292eda1df5686a259be73`。

| 治理事实 | 来源值 |
|---|---|
| 投影性质 | PREPARATION_ONLY_NOT_STEP7_GATE |
| Step 4 原状态 | PREPARATION_ONLY_NOT_STEP4_ACCEPTANCE |
| 管理 Owner（仅任务管理） | current Clued project owner in the authenticated user conversation |
| Namespace 候选组数 | 10 |
| Step 5 原状态 | PREPARATION_ONLY_NOT_STEP5_ACCEPTANCE |
| 稳定 Map | CANDIDATE_TARGET_MAP_V0_1_1 |
| 本候选新增 Alias 数 | 0 |
| 架构直接前序（原引用对象） | {"axis":"architecture","bytes":168491377,"filename":"Clued_Phase2_三项设计候选_完整审查包_v0.2.4_20260905.zip","members":440,"sha256":"4aae92c37813772e983a14537be52ca8b428af666e644b72d40084ccd592d68b","version":"v0.2.4"} |
| 历史命名空间不得签发当前状态 | true |
| Step 6 原状态 | SOURCE_BINDING_CANDIDATE_NOT_ACCEPTANCE |
| 聚合 ID 不另行发行，见逐消费者绑定 | [null,null,null] |
| 来源绑定行数（不等于新运行验收数） | 18 |
| Step 4 / 5 / 6 Decision 来源状态 | ["ACCEPTED_FOR_STEP4_ADMINISTRATIVE_SCOPE","ACCEPTED_FOR_CURRENT_SCOPED_IDENTITY_CONTRACTS","ACCEPTED_FOR_SOURCE_PRESERVING_TYPED_BINDINGS"] |
| 已选上游引用一致性 | SELECTED_LINEAGE_MATCHES |

| 版本轴 | 来源身份 |
|---|---|
| product | Clued-v1.6 |
| architecture | v0.2.5 |
| mapping | v0.1.1 |
| schema | {"core_definition":"1.0.0-local-rc-v15","model_schema_definition":"2.0.0-local-rc-v15-model"} |
| artifact | per-entry path/bytes/sha256 |
| skill | v0.1.5 |
| runtime | null |
| candidate_revision | v0.2.7.1 |
| migration_revision | null |
| protocol | {"definition_version":"1.0.0-local-rc-v15","path_namespace":"protocol/continuity/v1","schema_version":"clued.protocol-manifest/1"} |

未绑定 Decision 不被解释为接受；无实际消费者证据的准备行不被解释为运行接线完成。新增 Alias 为零不证明历史或外部别名已经全量枚举。

<!-- END CLUED PHASE2 GOVERNANCE PROJECTION -->
