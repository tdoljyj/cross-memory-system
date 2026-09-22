# Project Lifecycle Successor v0.1

Status: **OWNER DIRECTION ACCEPTED / SUCCESSOR DESIGN CANDIDATE / NOT DEPLOYED**  
Supersedes product semantics of: Project certainty as a user/business lifecycle axis  
Does not yet supersede: deployed v1 database/API compatibility fields until migration, review, deployment and attestation complete.

## Product rule

A Project is either recognized/created as a Project or it is not. `unconfirmed / confirmed` must not remain a user-facing or Canonical business lifecycle classification.

- When Clued determines that an item is a Project, it creates a Project automatically.
- Users may also create, rename, correct, merge, split, archive or delete/dismiss Projects through the applicable governed operation.
- Recognition confidence is backend metadata/evidence, not a Project lifecycle state.
- Work progress remains independent: `not_started / active / paused / completed / archived` (subject to the existing terminal-operation contract).
- A low-confidence mention that has not crossed the Project-recognition decision must remain source/evidence/candidate information; it must not create an “unconfirmed Project” category.

## Compatibility boundary

The deployed v1 schema currently contains `certainty_status`, `confirmed_at`, filters and invariants that require `confirmed` Projects for some five-view operations. Until the successor migration is deployed:

- do not pretend these physical fields have disappeared;
- do not add new product/UI semantics around them;
- do not silently bulk-promote legacy `unconfirmed` rows;
- do not weaken existing production authorization/currentness gates merely to hide the legacy field.

## Required migration

The implementation successor must version the Project contract and remove `certainty_status` from the public/product contract while preserving stable Project IDs and audit history.

Required work:

1. Inventory every live `unconfirmed` row with provenance and current dependencies.
2. Resolve each legacy row deterministically:
   - recognized Project → migrate as a Project while preserving ID/history/progress;
   - mention-only/non-project → retain provenance as Evidence/history and remove it from the active Project set through an auditable transition.
3. Stop accepting `certainty_status` in new Project create/update inputs.
4. Stop exposing/filtering Project lists by certainty.
5. Use recognition confidence/reason/source as metadata rather than lifecycle.
6. Remove “project_not_confirmed” as the semantic gate; replace it with effective-project/lifecycle/authorization/currentness checks.
7. Update Worker, account UI, MCP schemas/baselines, Bundle/Snapshot contracts and tests in one versioned successor.
8. Retain compatibility storage only as long as needed for rollout/rollback; a deprecated physical column must not be reinterpreted as current product truth.

## Active implementation surfaces discovered at successor start

At minimum the successor affects:

- `apps/clued-cloud/worker/projects.ts`
- `apps/clued-cloud/worker/continuity.ts`
- `apps/clued-cloud/app/page.tsx`
- Project/Record Supabase migrations and successor RPC definitions
- `scripts/user-memory-bundle.mjs`
- `scripts/two-level-snapshot.mjs`
- `schemas/user-memory-bundle-v1.schema.json` or its versioned successor
- MCP tools-list baseline and Project API/currentness tests

Historical migrations remain immutable history; the change is additive/successor-based.

## Acceptance gates

No production deployment until all are true:

- exact legacy-row inventory and migration disposition reviewed;
- new schema/API/MCP contract versioned;
- migration is transactional, replay-safe and rollback/compensation bounded;
- old and new clients have an explicit compatibility plan;
- Project/Record authorization, Currentness and projection tests pass;
- fresh-context review reports 0 BLOCKER / 0 MAJOR;
- deployment/readback is separately authorized.

This document starts the successor. It does not authorize applying a migration to production.
