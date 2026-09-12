# Currentness & Authority Reconciliation

**Projection only — not Authority.**

## E-010 Cross-Host / Thin-Open currentness

The earlier X-grade identity conflict is resolved at the design-revision layer:

- exact v0.2.4 candidate exists;
- its fresh-context independent final review is `PASS / MAJOR 0 / MINOR 0`;
- reviewed target SHA-256: `9b3de9eabc503b0036cfc79bacded5a4160b2a5896e20362fdbeb7d3a97cbf5f`;
- Owner governance state subsequently fixes v0.2.4 as the adopted current design baseline;
- a post-decision persistent projection is stored under `docs/governance/source-projections/2026-09-12/`.

What remains unresolved is **not the design revision identity**. The remaining gap is the exact authoritative Canonical freeze Event / Receipt, which this repository projection does not fabricate.

Safe state:

```text
E-010 design milestone = ✅ COMPLETED
adopted design revision = v0.2.4
independent review = PASS
exact reviewed SHA = 9b3de9eabc503b0036cfc79bacded5a4160b2a5896e20362fdbeb7d3a97cbf5f
Canonical freeze Event / Receipt = NOT MATERIALIZED IN THIS PROJECTION
runtime implementation = NOT IMPLIED
production/publication authority = NOT IMPLIED
```

## Live Authority infrastructure mapping

A read-only inspection of active `clued-prod` confirms reusable Authority / Scope infrastructure already exists:

- Binding resolver: `public.clued_resolve_binding(...)`;
- Authorization status: `public.clued_authorization_status_v12(...)`;
- Project access: `public.clued_project_access_v13(...)`;
- Effective Resource×Action: `clued_private.authorization_effective_actions_v13(...)`;
- Project membership: `clued_private.project_memberships_v13`;
- Authorization entries: `clued_private.authorization_entries_v12`;
- Development assignment/scope: `clued_private.development_grants_v14`;
- Development space/version cursor: `clued_private.development_spaces_v14`.

Therefore Multi-Track reuses existing Authority and Development Grant semantics instead of creating a second permission/assignment system.

Exact resolver contract:

- human-readable: `authority-currentness-contract.md`;
- machine-readable: `artifacts/priorities/authority-currentness-contract.json`.

## Currentness is multi-domain

Read-only production inspection also confirms several distinct version domains exist. Examples include:

- `clued_audit_receipts.canonical_version`;
- `clued_context_heads.version`;
- Development Space / Grant version/cursor;
- repository memory snapshot Canonical/version pointer;
- Multi-Track Priority Snapshot identity.

These counters are **not interchangeable**.

Currentness therefore uses:

```text
Dependency Manifest
+
Scope-specific Watermarks
+
Exact Source Identity
+
Authority / Grant / Policy version where applicable
```

A matching Repository Projection watermark only proves projection integrity; it does not prove upstream Canonical Currentness.

## Projection watermark

`artifacts/priorities/projection-watermark.json` binds the expected blob SHA values for the current Bootstrap projection inputs.

If a tracked blob differs:

`repository_projection_currentness = STALE_OR_MUTATED`

until regeneration / revalidation.

This is deliberately separate from:

`canonical_currentness = CURRENT|STALE|UNKNOWN`.

## Source materialization status

Persistent source projections are now available for:

- Multi-Track v0.2.1 Owner-fixed semantics;
- Foundational Research long-term strategy;
- Visual Territory 02.4B-R1;
- Cross-Host / Thin-Open v0.2.4 post-review Owner freeze.

These projection files do **not** fabricate historical Canonical Events or Receipts.

## Remaining Authority / Currentness gaps

The Bootstrap projection still does not possess runtime values for:

- current authenticated Principal;
- current Binding / Membership / Development Grant values;
- current effective Resource×Action result;
- this Priority Snapshot's authoritative CurrentnessReceipt;
- authoritative Replan Proposal registry;
- latest PriorityReconciliationReceipt / trigger_event;
- exact Canonical Event / Receipt normalization for every historical baseline.

Unknown values remain `UNKNOWN`, and high-risk actions fail closed.

## Zero-memory structural preflight

Current structural maturity: **`20 / 25`**.

The remaining five questions require either complete Canonical provenance or actual authenticated runtime resolution:

- exact source/Event/Receipt normalization;
- latest authoritative Priority Reconciliation trigger/receipt;
- authoritative Replan registry;
- Priority Snapshot CurrentnessReceipt;
- real eligible-next-action computation.
