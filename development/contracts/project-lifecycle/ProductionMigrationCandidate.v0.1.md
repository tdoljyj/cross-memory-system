# Project Lifecycle Successor — Production Migration Candidate v0.1

Status: **INDEPENDENTLY REVIEWABLE CANDIDATE / NOT APPLIED / NOT DEPLOYED**

Accepted direction: `ProjectLifecycleSuccessor.v0.1.md`

Candidate base: `5394a69803bcd6d5c2bea3d0c9af6efb694f55a9`

Candidate branch: `feat/project-lifecycle-successor-v2`

Candidate PR: `https://github.com/tdoljyj/cross-memory-system/pull/297`

The candidate head is the protected PR head resolved by GitHub at review/apply authorization time. It is intentionally not embedded in this file because a commit cannot truthfully contain its own hash. The apply authorization must bind that resolved head, this exact base, and the migration checksum.

This candidate contains no production schema apply, Worker deployment, release, secret/binding change or production data migration. Its migration must remain unapplied until the separate Production Gate below is authorized and satisfied.

## Candidate surfaces

- additive migration: `apps/clued-cloud/supabase/migrations/20260924120000_project_lifecycle_successor_v2.sql`
- read-only production inventory: `apps/clued-cloud/supabase/preflight/project_lifecycle_v2_inventory.sql`
- Project Lifecycle v2 Worker REST/MCP routing and frozen tools baseline
- one-list account UI with independent Project progress
- Canonical Export v2, User Memory Bundle v2 and Snapshot v6
- backward reader support for Project v1 / Snapshot v5
- database, authorization, Currentness, UI/API, Bundle/Snapshot and MCP tests

Historical migrations are unchanged.

## Deterministic legacy disposition

Every existing `clued_projects` row receives exactly one immutable private disposition. Precedence is deterministic and identical in the read-only preflight and migration test:

1. legacy `confirmed` or `confirmed_at` → `recognized_project`;
2. canonical Project mutation Event → `recognized_project`;
3. canonical Project-scoped Record → `recognized_project`;
4. confirmed Project mention → `recognized_project`;
5. otherwise → `evidence_only`.

`evidence_only` rows remain byte-preserved in the legacy table and appear in Canonical Export history, but are excluded from the v2 active Project set. They do not reserve a product Project name: a later v2 recognition decision creates a new stable Project ID instead of mutating or promoting the evidence row. No existing Project ID is rewritten. The disposition ledger records the original compatibility state, reason, source, confidence, evidence references, basis counts and a content hash over those material fields; update/delete is rejected.

The bounded v1 compatibility path is explicit and separately audited: a post-cutover v1 `unconfirmed` create remains `evidence_only` even though its atomic mutation has a Receipt. A later v1 confirmation keeps the same Project ID and appends one immutable private recognition fact bound to the new confirmation Receipt; it never rewrites the original disposition. The v2 active Project set changes only after that explicit confirmation. Regression tests cover the full v1 create → hidden from v2 → v1 confirm → visible in v2 sequence.

The currently authenticated owner-level Clued list returned zero `unconfirmed` rows on 2026-09-23. That is scoped evidence for that authorization only, not a substitute for the full production preflight.

## Public v2 contract

- Project create means Project creation; there is no unconfirmed Project product category.
- `project_schema_version = 2` is required.
- `certainty_status`, `confirmed_at` and certainty filtering are absent from v2 inputs/outputs.
- optional recognition `confidence / reason / source / source_refs` is stored only in the private disposition/evidence plane.
- progress remains `not_started / active / paused / completed / archived`.
- Record and extension-Event writes resolve the effective Project and require a recognized, non-dismissed, non-merged active lifecycle row.
- existing authorization resolution, CAS, immutable Receipt/Event, Currentness invalidation and stable Project IDs remain in force.

## Rollout and compatibility boundary

The migration adds v2 RPCs/views and keeps v1 RPCs/physical fields for one bounded rollback window. The candidate Worker routes the unchanged public MCP tool names and account endpoints to v2 RPCs. This supports the safe order:

1. review exact branch diff and CI;
2. run and approve the read-only production inventory;
3. separately authorize and apply the transactional migration;
4. verify v2 RPCs while the old Worker can still use the bounded v1 path: unconfirmed creates remain evidence-only, explicit v1 confirmation appends recognition, and already-recognized Project mutations keep their stable IDs;
5. separately authorize and deploy the candidate Worker/UI;
6. verify live MCP schema, authorization, Currentness and Project reads/writes;
7. remove v1 RPC grants/physical fields only in a later separately reviewed cleanup.

If schema apply fails, PostgreSQL rolls the migration back. After a successful schema apply but before Worker cutover, the old Worker continues using the bounded v1 behavior above; a Receipt alone never promotes an unconfirmed row. After Worker cutover, rollback can restore the prior Worker while leaving additive v2 objects dormant. No rollback path deletes or rewrites legacy Project rows or audit history.

The migration version `20260924120000` is strictly later than the base branch's `20260924110000_mtpe_universal_intake_auto_priority.sql`. The authorized production path therefore uses the normal ordered Supabase migration history and must not require `--include-all` to insert an older missing migration. The preflight and apply Gate must reject any target whose migration history no longer has this file as the next ordered candidate.

## Production Gate

Production remains blocked until all items are attached to the exact candidate head:

1. Fresh-Context review reports `0 BLOCKER / 0 MAJOR`.
2. The read-only preflight is run against the exact production database target; every legacy `unconfirmed` row and proposed disposition is reviewed, with row count and result digest retained privately.
3. Database backup/PITR and migration transaction boundaries are confirmed for the target.
4. G4 database, Project v2, Currentness, authorization, projection, MCP protocol/behavior/baseline, Bundle/Snapshot, typecheck/lint/build and security checks are green.
5. Exact base/head, migration checksum, PR and required checks are bound in the apply authorization.
6. Schema apply, Worker deployment, live readback/canary, release and any binding/secret change each receive their own applicable authorization.

Passing this candidate does not itself authorize any production action.
