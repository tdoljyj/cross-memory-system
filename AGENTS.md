# Clued continuity and memory contract (v1.6)

This repository follows `Clued_单一数据源与两级五视图架构方案_v1.6`.

## Authority and storage

- The authenticated Clued service backed by Supabase is the only online Canonical Store.
- Repository `memory/` is a read-only, versioned export of one canonical snapshot. It is never a write target.
- `memory/manifest.json` and the files it hashes are one atomic publication unit. A snapshot is authoritative for current work only when `baseline_claim=current`, `source_verification=live_rechecked`, `views_complete=true`, and `status=ready`.
- `memory/index.json` is the only derived lookup index. Canonical Records, Projects, Events, Evidence and Receipts retain their stable service IDs.
- Never recreate the retired local dual-write model: no Chinese root five-file set, no `memory/objects/*.json` Memory Engine objects, no `object-index.json`, and no Markdown-to-Canonical reverse write.

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

1. Check `git ls-remote origin main` against local `HEAD` before relying on repository files.
2. If local is behind, fetch and merge (never rebase); if truly diverged, stop for semantic merge.
3. Run `sync-memory.ps1 -Pull -Access <scope>` on the Codex endpoint. `-Access NONE` must remain a zero-read/no-op path.
4. Run `python memory.py doctor`. A failed Manifest/hash/current-view check is blocking.

Version truth is the remote commit plus root `VERSION`, git tags, `memory/manifest.json`, and the M2 `current.json` pointer. Version checks are triggered by relevant requests; never schedule them periodically.

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
