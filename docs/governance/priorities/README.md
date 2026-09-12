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
7. `runtime-capability-status.md` — authoritative Multi-Track Runtime implementation/discovery status
8. `fresh-agent-recovery-contract.md` — zero-memory recovery read order and fail-closed rules
9. `zero-memory-preflight.md` — structural safe-answer coverage
10. `../../../../artifacts/priorities/current.json` — machine-readable Bootstrap Snapshot
11. `../../../../artifacts/priorities/source-registry.json` — normalized source registry
12. `../../../../artifacts/priorities/bootstrap-context.json` — Track goals, typed impacts, parallel/resource rules and Bootstrap boundaries
13. `../../../../artifacts/priorities/runtime-capability-status.json` — runtime implementation/discovery state
14. `../../../../artifacts/priorities/authority-currentness-contract.json` — runtime Authority / Currentness resolver contract
15. `../../../../artifacts/priorities/projection-watermark.json` — repository-side projection drift watermark
16. `../../../../artifacts/priorities/bootstrap-currentness-assessment.json` — fail-closed Priority Snapshot currentness assessment
17. `../../../../artifacts/priorities/bootstrap-next-action-assessment.json` — fail-closed next-action assessment

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

`source-registry.json` covers **49/49** Priority Items.

For each Item a fresh Agent can resolve:

`primary source → exact SHA/Ref → authority state → supporting source chain → Receipt state`.

Receipt gaps remain explicit and never become invented Authority.

## Authority / Currentness

Multi-Track reuses existing Clued runtime infrastructure:

`Binding → Authorization → Membership → Development Grant / Scope → Effective Resource×Action → Currentness → Eligible Next Action`

A Repository-only Agent with no runtime credential must resolve to:

```text
Principal = NOT_RESOLVED
Runtime Authority = NOT_ESTABLISHED
Assignment Scope = NOT_RESOLVED
Eligible side-effect actions = []
```

## Runtime capability truth

Authoritative Multi-Track PriorityReconciliation / Replan Runtime is currently `NOT_IMPLEMENTED / NOT DISCOVERABLE` in the read-only discovery scope.

Therefore:

```text
latest PriorityReconciliationReceipt = NOT_AVAILABLE
authoritative Replan Registry = NOT_IMPLEMENTED / NOT DISCOVERABLE
open Replan Proposals = UNKNOWN, not []
```

## Zero-Memory status

```text
STRUCTURAL SAFE-ANSWER COVERAGE = 25 / 25 PASS
FINAL ≥3 AGENT RUNTIME GATE = NOT RUN
```

`25/25` means every recovery question has a truthful machine-readable answer path, including `UNKNOWN / NOT_IMPLEMENTED / FAIL_CLOSED` where appropriate. It does **not** mean Multi-Track Runtime or the final automated multi-Agent Gate has passed.