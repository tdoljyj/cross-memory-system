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
2. The same invocation passes that SHA explicitly to fetch/merge. If local is behind, it fetches and merges that exact SHA (never rebase); if truly diverged, it stops for semantic merge.
3. Every new request, independent retry, or new process runs `align-and-verify` again. Never cache or reuse PASS evidence across requests, Sessions, processes, devices, or Agents; never substitute mtime, a tracking ref, or an old SHA for the remote query.
4. Run `python memory.py doctor`. A failed Manifest/hash/current-view check is blocking.

Version truth is the remote commit plus root `VERSION`, git tags, `memory/manifest.json`, and the M2 `current.json` pointer. Version checks are triggered by relevant requests; never schedule them periodically.

## Request-local verification context

- A T1–T4, audit, status, doctor, or repository implementation request creates exactly one in-memory `RequestVerificationContext` after `align-and-verify`. `NONE`/T0 creates no Context and performs zero Git and zero Memory reads.
- Pass the Context and its resolved Remote Head SHA explicitly through the full `align-and-verify → mirror → doctor` call chain in one Python process. Never serialize it or reuse its PASS across requests, retries, Sessions, processes, devices, or Agents.
- Reuse is allowed only within the same request and trust boundary after rechecking path identity and ACL, streaming Manifest content identity, the Current Pointer, root `VERSION`, git HEAD/tags/repository identity, owner/scope, authorization evidence, TTL/clock, and validator versions. Any change invalidates the evidence and requires full validation or fails closed.
- Repository source, copy candidate, and local mirror are separate boundaries. A PASS at one boundary never replaces the independent source or target hash validation at another boundary.
- Expected Owner Ref and Bundle Scope come from the committed endpoint trust policy `config/clued-endpoint-trust.json`, independently of the Bundle and optional caller environment. Missing or changed trust policy, missing Manifest owner/scope, or a mismatch fails closed.
- An authoritative result must bind a complete Source Envelope to one currently valid successful Bundle Evidence: exact boundary, evidence ID, sources read, source versions, freshness (`current`, `historical`, or explicit `degraded` with reason), and the request-local verification summary. Zero validation, failed/invalidated Evidence, or an absent/mismatched boundary can never produce `authoritative=true`.

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
- Each endpoint edits only its own consumer configuration. Cross-endpoint exchange goes through the Canonical Store and versioned repository snapshot.
- `sync-memory.ps1` / `sync-memory.py` only pull and atomically mirror the read-only snapshot. Their business-memory push path must fail closed.
- Script/document changes use normal Git commits with `AI@machine` authorship, fetch+merge before push, and post-push `merge-base --is-ancestor` verification.
- `artifacts/clued-two-level-snapshots/published/{snapshot_version}` is immutable. Formal readers follow `artifacts/clued-two-level-snapshots/current.json`; repository `memory/` must byte-match that pointed Bundle at its cutover commit.
