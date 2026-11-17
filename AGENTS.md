# BeamingFace continuity and memory contract (v1.6)

The current product brand is BeamingFace. Existing Clued/clued protocol, Skill, schema, component, repository and storage identifiers remain compatible; see [the branding maintenance note](docs/maintenance/beamingface-branding.md).

This repository follows `Clued_单一数据源与两级五视图架构方案_v1.6`.

## Agent contract

Every Agent working in this repository follows [protocol/agent/agent-contract.md](protocol/agent/agent-contract.md), the single normative contract for using BeamingFace: start, read order, capture of material outcomes, write discipline, error handling and checkpoint. The BeamingFace service serves the same text at `/clued-agent.md`. This file adds repository rules only; do not restate the contract here.

In Claude Code, `.claude/settings.json` runs `scripts/hooks/clued_capture_guard.py` as a Stop hook that enforces the contract's §3 and §5 (BUG-20260924-001 L3). It blocks a stop once per finding and state: a material outcome (merged PR, including through `gh api`, push to main, applied migration, deployed edge function), also inside a subagent, with no committed BeamingFace write about it after it, committed BeamingFace writes with no checkpoint after them, a human message since the last committed write that looks like an Owner decision, or an Owner answer to a question (AskUserQuestion, the channel for Owner decisions) with no committed BeamingFace write after it. A rejected, failed or unanswered write settles nothing, an Event (`clued_append_event`, `clued_event_append`) never settles an Owner decision or answer, and a write about an outcome names its PR number or merge commit, migration or function. `CLUED_CAPTURE_GUARD=off` disables it.

## Authority and storage

- The authenticated BeamingFace service backed by Supabase is the only online Canonical Store.
- Repository `memory/` is a read-only, versioned export of one canonical snapshot. It is never a write target.
- `memory/manifest.json` and the files it hashes are one atomic publication unit. A snapshot proves only its recorded as-of boundary. A current-claimed snapshot requires `baseline_claim=current`, `source_verification=live_rechecked`, `views_complete=true`, and `status=ready`, but still does not establish online Current Truth. A legitimate historical/offline or incomplete snapshot follows its own manifest, authorization and integrity contract and must retain its historical/incomplete qualification.
- `memory/index.json` is the only derived lookup index. Canonical Records, Projects, Events, Evidence and Receipts retain their stable service IDs.
- Never recreate the retired local dual-write model: no Chinese root five-file set, no `memory/objects/*.json` Memory Engine objects, no `object-index.json`, and no Markdown-to-Canonical reverse write.

## Snapshot tenancy

- Repository `memory/` is a single-user snapshot, not a system-wide or multi-user export.
- Expected owner identity and bundle scope come only from the committed endpoint trust policy `config/clued-endpoint-trust.json`; do not duplicate account hints or owner identifiers in active instructions.
- Readers must verify the snapshot Manifest against that independent trust policy before using the snapshot.
- Other users must be accessed through authenticated BeamingFace APIs or separate user-scoped exports; never treat or overwrite this root snapshot as another user's data.

## Memory Router

Default access is `NONE`. Decide before reading.

- T0: generic, non-personal work. Read nothing.
- T1: identity, preferences, cross-session history, or memory-system maintenance. Read the smallest relevant part of `memory/profile.md` and the required views.
- T2: active project work. Read Global priority, then exact Project `state.md`, `task.md`, and `decision.md`.
- T3: uncertain relevance. Light-read only State/Task/Decision.
- T4: writes. A material outcome (an Owner decision, finished or newly agreed work, a correction) or an explicit “remember this” is written once through authenticated BeamingFace M1 tools in the same turn, with the record type and authority the contract's Capture section assigns. `authority=user_explicit` goes with `user_confirmed: true` when the claim is the Owner's own words in this conversation; the flag records that source and is not a step to ask the Owner again. Do not edit Markdown.

For online current work, resolve the effective Project by canonical project ID through the authenticated service and its Currentness contract. The deployed v1 Project schema may still expose legacy `certainty_status`; treat it as compatibility metadata, not as the product's organization model. The approved successor direction is `development/contracts/project-lifecycle/ProjectLifecycleSuccessor.v0.1.md` and is not production until its migration is reviewed, deployed and attested. The paths below are read-only snapshot lookup locations, not online Current Truth:

1. `memory/global/state.md`, `task.md`, `decision.md` for cross-project priority.
2. `memory/projects/{canonical_project_id}/state.md`, `task.md`, `decision.md` for the selected project.
3. `archive.md` and `log.md` only when historical evidence is required.
4. `memory/profile.md` only when identity or preferences materially affect the answer.

State/Task/Decision/Archive/Log remain the two-level Standard Work Projection. State references Task IDs; Task owns executable text; active Event truth carriers are evaluated separately from the historical Log view. Checkpoint and snapshot validity never bypass live currentness or action authorization.

Always report `sources_read` for an authoritative current-status answer. Treat `objects/legacy/` and legacy Event envelopes as compatibility history, not current truth.

## Read-before-alignment

When a request reads repository `memory/` snapshot files (the T1–T3 snapshot lookups above, or a `memory/` audit or doctor), and only then:

1. Run the unified entry exactly once before reading `memory/`: `sync-memory.ps1 -AlignAndVerify -Access <scope>` on Windows/Codex endpoints, `python3 sync-memory.py align-and-verify <scope>` on Linux and macOS. The unified request entry resolves `origin/main` to one concrete Commit SHA with one real `git ls-remote`; `-Access NONE` remains a zero-read/no-op path.
2. The same invocation passes that SHA explicitly to an isolated Git-object source. It may fetch that exact object without moving the development worktree HEAD, Index, or files, then classifies equal / Remote Ahead / Local Ahead / true divergence. True divergence emits a Git Conflict Packet and stops; the read path never merges, rebases, or overwrites the development worktree.
3. Every new request, independent retry, or new process runs `align-and-verify` again. Never cache or reuse PASS evidence across requests, Sessions, processes, devices, or Agents; never substitute mtime, a tracking ref, or an old SHA for the remote query.
4. `sync-memory.ps1 -AlignAndVerify` 已在同一 Python 进程、同一 RequestVerificationContext 中完成 mirror 与 doctor。成功后不得在同一请求中再次运行 `python memory.py doctor`。独立执行 doctor 属于新的 doctor-only 请求，必须创建新的 Context 并重新校验。

Version truth is the remote commit plus root `VERSION`, git tags, `memory/manifest.json`, and the M2 `current.json` pointer. Version checks are triggered by relevant requests; never schedule them periodically.

## Request-local verification context

- A request that reads repository `memory/` snapshot files, or a doctor request, creates exactly one in-memory `RequestVerificationContext` after `align-and-verify`. `NONE`/T0 creates no Context and performs zero Git and zero Memory reads.
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
- Use stable idempotency keys, CAS base versions for mutation, authenticated scope, exact canonical IDs, and the authority the contract's Capture section assigns to the record's main claim.
- Successful Canonical writes already emit Event and immutable Receipt in the same contract. Never perform a second Markdown or Git business write.
- Refresh a repository snapshot only through Receipt-backed `clued_canonical_export`, deterministic build/validate, expected-current CAS publish, then the root cutover pipeline.
- Information Flow write surfaces (candidates, S3 promotion, S4 Context Policy, S5 Evidence withdrawal and invalidation) follow [development/contracts/information-flow/NativeWriteSurfaces.v0.1.md](development/contracts/information-flow/NativeWriteSurfaces.v0.1.md). A candidate is never a Canonical Record or current truth; the confirmation-gated promotion, Context Policy and withdrawal steps are Native account-session RPCs only, never MCP tools, OAuth cases or Bindings.

Superseded and archived facts remain in Canonical history. Do not delete them to express a correction. Failed business mutations must not be represented as successful state.

## Git and endpoint discipline

- No force push, reset, rebase, or local-over-remote overwrite.
- Dirty-worktree gates remain mandatory for repository implementation, commit, push, and every write path. Only the isolated read-only Mirror path may bypass a dirty development worktree, and it must not read, copy, stage, or modify dirty worktree files.
- Each endpoint edits only its own consumer configuration. Cross-endpoint exchange goes through the Canonical Store and versioned repository snapshot.
- `sync-memory.ps1` / `sync-memory.py` only pull and atomically mirror the read-only snapshot. Their business-memory push path must fail closed.
- 合入 main 只有两条路：一是经 PR 由 GitHub 合并（`train.landing=github-merge` 时）；二是合并列车以 App 5368905 把它测过、并在推送前逐项实时准入过的提交快进推上 main（`train.landing=push` 时）。main 主规则集的 bypass 名单只含 App 5368905；“main 只许快进”规则集的 bypass 名单为空；其它任何人或自动化都不得直接推 main。此为 ADR 0018 §8 第 5 条对 #292 的修订；push 仅在该节上线前提齐备后启用，所有改动仍经 PR 审核。规则集合同见 `development/contracts/repository/GitConnectorWriteContract.v0.1.md`。
- Local-worktree Git writes push feature branches only. They use normal commits, fetch+merge before push, and post-push `merge-base --is-ancestor` verification. Local endpoints author as `AI@machine`; hosted agents are identified by their authenticated host identity and attribution trailers.
- GitHub/API connector writes follow `development/contracts/repository/GitConnectorWriteContract.v0.1.md`: bind the exact remote head, write through a branch with blob-SHA CAS, fail closed on conflict, review the exact diff, and open a PR. Connector-authored commits are identified by the authenticated GitHub actor rather than a fabricated `AI@machine` author.
- `artifacts/clued-two-level-snapshots/published/{snapshot_version}` is immutable. Formal readers follow `artifacts/clued-two-level-snapshots/current.json`; repository `memory/` must byte-match that pointed Bundle at its cutover commit.

## Development costs and execution

Existing and future development, CI, checks, merge/release controls and operations follow the [cost and migration rules in the Runner Runbook, section 2.4](docs/maintenance/runner-configuration-and-operations.md#24-现有与未来任务的费用原则迁移与防回流). Read that section before adding or changing an execution route, automation, artifact, cache, package, storage or transfer dependency.

New jobs must use qualified self-hosted resources. Prefer self-owned or verified non-billable alternatives for every potentially chargeable official capability; never silently fall back to paid execution because of queues or failures. Existing hosted routes are migration debt, and historical hosted-only notes do not authorize new charges. Any unavoidable paid item needs its specific reason, cost and explicit prior Owner authorization under that Runbook.

Keep development, checks, merge, release, recovery, isolation and retained evidence working while migrating. Complete the affected validation before retiring the old path or setting budgets to zero; this policy does not itself grant production, billing or Source/Role changes.

## External document placement

- Git 只承载与代码、协议/合同、ADR、Schema/Migration、测试/Fixture、Runbook、Skill、当前执行控制和可复现机器证据直接绑定的工程资料。
- 产品研究、战略、商业、品牌、视觉、汇报、会议/对话整理、历史评审/验收/Closeout 长报告及非构建用 Office/PDF/ZIP 统一放 Google Drive，不再提交到主仓库。
- 当前计划与确定基线目录：<https://drive.google.com/drive/folders/1Owx0Ow4RQY0CbYB5aDQ8RMXLNTA6EyT0>。
- 当前总索引：<https://drive.google.com/file/d/13TE41MmUMnMZ19imQlR5UtrIVEEaGDps/view?usp=drivesdk>。必须保留索引中的 Frozen / Fixed / Candidate / Historical / Open 边界；Drive 副本不会自行产生 Authority。
- 历史迁移位置与校验信息见 `docs/EXTERNAL_DOCUMENT_ARCHIVE.md`。
- 禁止新增会把上述叙事资料或冻结副本重新物化到 `docs/` 的归档工作流；仓库只保留短指针、机器合同和可执行证据。
