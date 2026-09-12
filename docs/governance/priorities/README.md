# Clued Multi-Track Governance Projection

**Projection status:** `BOOTSTRAP SOURCE-BOUND CANDIDATE / NOT AUTHORITY / NOT FROZEN`

Source snapshot: `CLUED-CURRENT-PRIORITY-SNAPSHOT-v0.1.3-SOURCE-BOUND-20260912`

This directory is a repository projection of Clued's multi-track governance state.

## Read first

1. `current-frontier.md` — Current Priority Frontier
2. `tracks.md` — Programs / Priority Items and completion states
3. `cross-track-map.md` — hard dependency / typed impact map
4. `currentness.md` — Currentness / Authority reconciliation
5. `authority-currentness-contract.md` — human-readable Binding / Membership / Development Grant / Resource×Action resolution contract
6. `fresh-agent-recovery-contract.md` — zero-memory recovery read order and fail-closed rules
7. `zero-memory-preflight.md` — current structural recovery score
8. `../../../../artifacts/priorities/current.json` — machine-readable Bootstrap Snapshot
9. `../../../../artifacts/priorities/bootstrap-context.json` — Track goals, typed impacts, parallel/resource rules and Bootstrap boundaries
10. `../../../../artifacts/priorities/authority-currentness-contract.json` — machine-readable runtime Authority / Currentness resolver contract
11. `../../../../artifacts/priorities/projection-watermark.json` — repository-side projection drift watermark

## Rules

- Canonical / Authority remains upstream.
- Local edits here do not create or modify Canonical priority reality.
- A mismatch against the expected projection watermark is `PRIORITY_PROJECTION_DRIFT`.
- Completed items remain visible with `✅`.
- `✅ COMPLETED` applies to the Priority Item's own completion contract and does not imply all downstream Runtime/product implementation is complete.
- The strict engineering frontier is `E-001 Kernel Phase 2 Real Closeout`.
- Bootstrap governance (`E-008`) may continue only as non-blocking parallel work.
- Owner-fixed source projections are stored under `docs/governance/source-projections/`; they are persistent projections, not fabricated historical Event/Receipt objects.
- Repository projection grants no production, database, release, deployment, secret, budget or Canonical-write Authority.
- `READY`, Assignment, Priority and Repository visibility never substitute for authenticated Resource×Action Authority.

## Authority / Currentness

The Bootstrap contract reuses existing Clued runtime infrastructure rather than creating a second authorization system:

`Binding → Authorization → Project Membership → Development Grant / Scope → Effective Resource×Action → Currentness → Eligible Next Action`

A Repository-only Agent with no runtime credential must resolve to:

```text
Principal = NOT_RESOLVED
Runtime Authority = NOT_ESTABLISHED
Assignment Scope = NOT_RESOLVED
Eligible side-effect actions = []
```

## Current Zero-Memory status

Structural preflight is currently **20 / 25**.

Repository + resolver contracts can now recover or safely resolve:

- Track goals, Programs and completion state;
- Priority Frontier and Why;
- hard dependency / blocker;
- typed non-hard impacts;
- conditional parallelism / resource conflicts;
- Repository projection drift;
- exact runtime resolution path for Principal visibility, effective actions and Development Grant scope;
- normalized forbidden-action / fail-closed boundaries.

Remaining five gaps:

1. complete exact Canonical source/Event/Receipt normalization;
2. authoritative PriorityReconciliation trigger/receipt;
3. authoritative Replan registry;
4. Priority Snapshot CurrentnessReceipt / upstream dependency watermark verification;
5. real eligible-next-action computation under an authorized test identity.
