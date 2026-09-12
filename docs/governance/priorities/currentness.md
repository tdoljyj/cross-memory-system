# Currentness & Authority Reconciliation

**Projection only — not Authority.**

## Source provenance normalization

Multi-Track now has a normalized Source Registry:

- human-readable: `source-registry.md`;
- machine-readable: `artifacts/priorities/source-registry.json`;
- coverage: **49 / 49 Priority Items**.

Each Item can now resolve to:

`primary source → exact SHA/Ref → authority state → supporting source chain → Canonical Receipt state`.

Missing Receipts remain explicit (`PENDING`, `NOT_NORMALIZED`, `PARTIALLY_UNAVAILABLE`, etc.) and are never fabricated.

This closes the **structural** provenance question (`ZM12`), but does not claim every historical source already has a materialized Canonical Event/Receipt.

## E-010 Cross-Host / Thin-Open currentness

The earlier X-grade identity conflict is resolved at the design-revision layer:

- exact v0.2.4 candidate exists;
- its fresh-context independent final review is `PASS / MAJOR 0 / MINOR 0`;
- reviewed target SHA-256: `9b3de9eabc503b0036cfc79bacded5a4160b2a5896e20362fdbeb7d3a97cbf5f`;
- Owner governance state subsequently fixes v0.2.4 as the adopted current design baseline;
- a post-decision persistent projection is stored under `docs/governance/source-projections/2026-09-12/`.

What remains unresolved is **not the design revision identity**. The remaining gap is the exact authoritative Canonical freeze Event / Receipt, which this repository projection does not fabricate.

## Live Authority infrastructure mapping

Read-only inspection of active `clued-prod` confirms reusable Authority / Scope infrastructure already exists:

- Binding resolver: `public.clued_resolve_binding(...)`;
- Authorization status: `public.clued_authorization_status_v12(...)`;
- Project access: `public.clued_project_access_v13(...)`;
- Effective Resource×Action: `clued_private.authorization_effective_actions_v13(...)`;
- Project membership: `clued_private.project_memberships_v13`;
- Authorization entries: `clued_private.authorization_entries_v12`;
- Development assignment/scope: `clued_private.development_grants_v14`;
- Development space/version cursor: `clued_private.development_spaces_v14`.

Therefore Multi-Track reuses existing Authority and Development Grant semantics instead of creating a second permission/assignment system.

## Currentness is multi-domain

Currentness does not use one universal version number.

Known version/watermark domains include:

- Canonical mutation/audit Receipt `canonical_version`;
- Context Head `version`;
- Development Space / Grant version/cursor;
- repository memory snapshot Canonical/version pointer;
- Multi-Track Priority Snapshot identity.

Formal model:

```text
Dependency Manifest
+
Scope-specific Watermarks
+
Exact Source Identity
+
Authority / Grant / Policy version where applicable
```

A matching Repository Projection watermark proves projection integrity only; it does not prove upstream Canonical Currentness.

## Projection watermark

`artifacts/priorities/projection-watermark.json` binds expected blob identities for the Bootstrap projection.

If a tracked blob differs:

`repository_projection_currentness = STALE_OR_MUTATED`

until regeneration/revalidation.

This remains distinct from:

`canonical_currentness = CURRENT | STALE | UNKNOWN`.

## Remaining formal Currentness / Reconciliation gaps

After Source Registry normalization, remaining hard gaps are now four:

1. authoritative latest `trigger_event + PriorityReconciliationReceipt`;
2. authoritative Replan Proposal registry;
3. this Priority Snapshot's authoritative CurrentnessReceipt / dependency-watermark verification;
4. real eligible-next-action computation under an authenticated authorized test identity.

Historical Event/Receipt normalization can continue incrementally, but missing historical receipts no longer prevent a fresh Agent from identifying the exact source and its unresolved Receipt state.

Unknown values remain `UNKNOWN`, and high-risk actions fail closed.

## Zero-memory structural preflight

Current structural maturity: **`21 / 25`**.

Final runtime Gate remains unpassed.