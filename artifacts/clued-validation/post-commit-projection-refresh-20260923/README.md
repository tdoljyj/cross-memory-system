# Evidence — post-commit projection refresh (2026-09-23)

## Authority read

- Global session resume and required reconcile were performed first. Global
  remained `STALE`, with unresolved `global.priority_frontier` and
  `global.__aggregate__`; stale values were not treated as current work.
- Project `0597aa60-9b98-4da6-a4ab-63d7705b632f` was resumed and reconciled to
  `CURRENT`.
- Exact authoritative inputs were read as Decision
  `477a5812-f8e1-4cf6-819b-078ca30ac107` v2 and Task
  `9c3effaa-7162-47c3-85da-0039415eb262` v8.
- Repository alignment completed before inspection. Implementation baseline was
  `cb79aac5dac90c183ad1db059a706a68b584ec8b`.

## Evidence map

| Requirement | Evidence |
| --- | --- |
| Atomic invalidation + queue | Migration trigger on `projection_invalidation_heads`; transaction rollback semantics; database scenario |
| Restricted independent Builder | Exact projection grant checks; read-only Binding; normal mutation rejection |
| Latest full source vector + exact CAS | Claim/apply lease fields and recomputed `projection_source_snapshot`; concurrent update scenario |
| Conflict discard + merge latest | `CAS_CONFLICT` attempt and reset to the latest head; v4 scenario |
| Idempotency and coalescing | One primary-keyed job per user/scope/key; v1→v2→v3 and duplicate enqueue scenarios |
| Bounded retry + diagnostics | Four-attempt cap, exponential delay, attempt ledger, expired-lease scenario |
| Fail closed | Resolved revision advances only inside successful apply; stale read scenario |
| No recursion | Projection-derived record exclusion and unchanged invalidation revision assertion |
| Recovery + cross-host consistency | v5 lease expiry/retry/rebuild followed by two independent resume Bindings |
| Transport isolation | Raw Builder token never enters RPC body; only SHA-256 token hash is sent |

## Results

- Projection suite: 3 passed, 0 failed.
- Context v2 regression: 90 passed, 0 failed, 5 environment-dependent symlink
  cases skipped.
- Migration-chain regression: 2 passed, 0 failed.
- TypeScript typecheck: passed.
- Changed-file ESLint: passed.
- Repository lint wrapper could not start because this Windows host has no
  `/bin/bash`; the same ESLint command was run directly and passed.
- `git diff --check`: passed.

## Fresh-context review checklist

1. Read repository and `apps/clued-cloud` instructions, then use the installed
   Clued engineering workflow.
2. Run one `-AlignAndVerify -Access MULTI` and verify remote ancestry before
   treating the checkout as current.
3. Resume/reconcile Global and project
   `0597aa60-9b98-4da6-a4ab-63d7705b632f`; re-read the exact Decision v2 and
   Task v8. Stop if they are superseded or non-current.
4. Review the migration, Worker runner, and the two focused tests. Confirm the
   implementation still names only the two approved projection keys.
5. Run the commands in the implementation document and verify the resulting
   commit is an ancestor of the remote branch.
6. Treat deployment, secret creation, grants, cron configuration, release, and
   production readback as separate, ungranted work.

