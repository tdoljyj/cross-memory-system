# Clued Multi-Track Governance Projection

**Projection status:** `BOOTSTRAP SOURCE-BOUND CANDIDATE / NOT AUTHORITY / NOT FROZEN`

Source snapshot: `CLUED-CURRENT-PRIORITY-SNAPSHOT-v0.1.3-SOURCE-BOUND-20260912`

This directory is a repository projection of Clued's multi-track governance state.

## Read first

- `current-frontier.md` — Current Priority Frontier
- `tracks.md` — Programs / Priority Items and completion states
- `cross-track-map.md` — hard dependency / impact map
- `currentness.md` — Currentness / Authority reconciliation
- `fresh-agent-recovery-contract.md` — zero-memory recovery read order and fail-closed rules
- `zero-memory-preflight.md` — current structural recovery score
- `../../../../artifacts/priorities/current.json` — machine-readable current Bootstrap Snapshot
- `../../../../artifacts/priorities/bootstrap-context.json` — Track goals, typed impacts, parallel/resource rules, Replan/currentness/authority boundaries

## Rules

- Canonical / Authority remains upstream.
- Local edits here do not create or modify Canonical priority reality.
- A mismatch against the source snapshot is `PRIORITY_PROJECTION_DRIFT`.
- Completed items remain visible with `✅`.
- `✅ COMPLETED` applies to the Priority Item's own completion contract and does not imply all downstream Runtime/product implementation is complete.
- The strict engineering frontier is `E-001 Kernel Phase 2 Real Closeout`.
- Bootstrap governance (`E-008`) may continue only as non-blocking parallel work.
- Owner-fixed source projections are stored under `docs/governance/source-projections/`; they are persistent projections, not fabricated historical Event/Receipt objects.
- Repository projection grants no production, database, release, deployment, secret, budget or Canonical-write Authority.

## Current Zero-Memory status

Structural preflight is currently **16 / 25**.

Repository projection can now recover Track goals, Programs, completion state, Priority Frontier, why, hard dependencies/blockers, typed non-hard impacts, conditional parallelism/resource conflicts and normalized forbidden-action boundaries.

Remaining hard gaps are concentrated in authenticated Principal Authority / Scope, CurrentnessReceipt / Canonical watermark, authoritative Replan/Reconciliation state and eligible-next-action resolution.
