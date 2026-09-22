# Minimal post-commit projection refresh

Status: implementation and local validation complete; not deployed.

## Authority and scope

This implementation is constrained by the authoritative online records read on
2026-09-23:

- Context Architecture v2 Decision
  `477a5812-f8e1-4cf6-819b-078ca30ac107` v2.
- MTPE Universal Intake M0 Task
  `9c3effaa-7162-47c3-85da-0039415eb262` v8.

Only `global.priority_frontier` and `global.__aggregate__` are handled. The
change does not redefine Canonical truth, make a projection authoritative in
place of its source Task, or authorize production deployment, release, budget,
or procurement.

## Runtime contract

1. Existing Canonical mutation triggers advance an invalidation head in the
   same transaction as the write. A new after-row trigger coalesces that head
   into one job per approved projection in that same transaction.
2. The Worker merely wakes the queue after successful mutation-shaped requests.
   Queue state is durable in Postgres, so request completion is not the work
   completion boundary.
3. The Builder uses a separate Binding token supplied only as
   `CLUED_PROJECTION_BUILDER_TOKEN`. Its Binding must have `context:read`, a
   private exact-key Projection Builder grant, wildcard context visibility, and
   no delegated authorization restrictions. It cannot call normal Canonical
   mutation RPCs.
4. Claim records an exact invalidation revision and digest of the latest full
   source vector. Apply re-locks the user, rebuilds the source vector, and
   compares both values before changing either projection.
5. A mismatch records `CAS_CONFLICT`, discards the stale generation, resets the
   job to the latest invalidation revision, and coalesces subsequent triggers.
6. A successful Frontier generation binds the exact Task ID, Task version,
   scope, render rule, source vector, generation, and receipt. Aggregate is
   admitted only after required projections are current and no legacy unknown
   carrier remains.
7. Lease expiry and rebuild errors are diagnostic attempts with bounded retry.
   No error path advances `resolved_through_revision`; reads therefore remain
   `STALE` or `UNKNOWN` and cannot expose the old projection as `CURRENT`.
8. Derived projection records are excluded from Frontier candidates and their
   updates do not advance the same projection head, preventing recursion.

The `scheduled` entry point is a recovery hook for due durable jobs. The Worker
configuration includes a one-minute trigger; claim/apply still follows the
database's per-job delay and retry cap. This source change alone performs no
deployment.

## Validation

Run from `apps/clued-cloud`:

```text
npm run test:projection:refresh
npm run test:context:v2
npm run test:authorization:migrations
npm run typecheck
npx eslint worker/continuity.ts worker/index.ts tests/worker-continuity-loader.mjs tests/projection-refresh-pipeline-db.test.mjs tests/projection-refresh-transport.test.mjs
```

The database scenario covers rapid v1→v2→v3 coalescing, duplicate enqueue,
unauthorized writers, a read-only Builder, stale read hiding, concurrent CAS
conflict, latest-revision recovery, no same-projection recursion, aggregate
reconciliation, lease-expiry failure, bounded retry, and consistent current
reads through two independent host Bindings. The transport scenarios verify
conflict draining, hashed credential use, and an inert unconfigured Builder.

## Deployment prerequisites intentionally left undone

- Apply the migration through the separately authorized production process.
- Create a dedicated read-only Binding and exact Builder grants for the two
  approved keys; store its raw token only in the Worker secret.
- Verify that the one-minute recovery trigger is active in the deployed Worker.
- Run production canary/readback and capture deployment receipts under a new
  authorization. None of these actions are authorized by this change.

