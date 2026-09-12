# Clued Multi-Track Governance Projection

**Projection status:** `BOOTSTRAP SOURCE-BOUND CANDIDATE / NOT AUTHORITY / NOT FROZEN`

Source snapshot: `CLUED-CURRENT-PRIORITY-SNAPSHOT-v0.1.3-SOURCE-BOUND-20260912`

This directory is a repository projection of Clued's multi-track governance state.

## Read first

1. `current-frontier.md` — Current Priority Frontier
2. `tracks.md` — Programs / Priority Items and completion states
3. `source-registry.md` — 49/49 Item exact source / derivation registry
4. `cross-track-map.md` — hard dependency / typed impact map
5. `currentness.md` — Currentness / Authority reconciliation
6. `authority-currentness-contract.md` — Binding / Membership / Development Grant / Resource×Action / Currentness resolution contract
7. `fresh-agent-recovery-contract.md` — zero-memory recovery read order and fail-closed rules
8. `zero-memory-preflight.md` — current structural recovery score
9. `../../../../artifacts/priorities/current.json` — machine-readable Bootstrap Snapshot
10. `../../../../artifacts/priorities/source-registry.json` — machine-readable normalized source registry
11. `../../../../artifacts/priorities/bootstrap-context.json` — Track goals, typed impacts, parallel/resource rules and Bootstrap boundaries
12. `../../../../artifacts/priorities/authority-currentness-contract.json` — machine-readable runtime Authority / Currentness resolver contract
13. `../../../../artifacts/priorities/projection-watermark.json` — repository-side projection drift watermark

## Rules

- Canonical / Authority remains upstream.
- Local edits here do not create or modify Canonical priority reality.
- A mismatch against the expected projection watermark is `PRIORITY_PROJECTION_DRIFT`.
- Completed items remain visible with `✅`.
- `✅ COMPLETED` applies to the Priority Item's own completion contract and does not imply all downstream Runtime/product implementation is complete.
- The strict engineering frontier is `E-001 Kernel Phase 2 Real Closeout`.
- Bootstrap governance (`E-008`) may continue only as non-blocking parallel work.
- Owner-fixed source projections are persistent projections, not fabricated historical Event/Receipt objects.
- Repository projection grants no production, database, release, deployment, secret, budget or Canonical-write Authority.
- `READY`, Assignment, Priority and Repository visibility never substitute for authenticated Resource×Action Authority.

## Source provenance

`source-registry.json` now covers **49/49** Priority Items.

For each item a fresh Agent can resolve:

`primary source → exact SHA/Ref → authority state → supporting source chain → Receipt state`.

Receipt gaps remain explicit and never become invented Authority.

## Authority / Currentness

The Bootstrap contract reuses existing Clued runtime infrastructure rather than creating a second authorization system:

`Binding → Authorization → Membership → Development Grant / Scope → Effective Resource×Action → Currentness → Eligible Next Action`

A Repository-only Agent with no runtime credential must resolve to:

```text
Principal = NOT_RESOLVED
Runtime Authority = NOT_ESTABLISHED
Assignment Scope = NOT_RESOLVED
Eligible side-effect actions = []
```

## Current Zero-Memory status

Structural preflight is currently **21 / 25**.

Remaining four hard gaps:

1. authoritative PriorityReconciliation trigger/Receipt;
2. authoritative Replan registry;
3. Priority Snapshot CurrentnessReceipt / upstream dependency watermark verification;
4. real eligible-next-action computation under an authorized test identity.

Final ≥3 Agent Runtime Gate remains unpassed.