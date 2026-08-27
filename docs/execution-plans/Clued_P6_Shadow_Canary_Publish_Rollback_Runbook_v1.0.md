# Clued P6 Shadow, Canary, Publish, and Rollback Runbook v1.0

## Authority and status boundary

- Authorization: `AUTHORIZATION / P6_LOCAL_IMPLEMENTATION_ONLY`
- Fixed baseline: `59ce5224b18bad502184a26e8c00f9e51521e41e`
- Candidate branch: `codex/p6-shadow-canary-publish-rollback-r2`
- Highest status this runbook can support: `PASS / P6_IMPLEMENTATION_CANDIDATE_READY_FOR_INDEPENDENT_REVIEW`
- This runbook does not authorize or claim G6-3B, production Shadow, real Canary, merge, deployment, production database or Pointer operations, Tag, Release, 100% promotion, or legacy-path retirement.

All commands below are offline or isolated. Use temporary export roots and two same-seed temporary PostgreSQL databases. Never point these commands at a production Worker, Supabase project, Binding, Snapshot root, or `current.json`.

## Frozen implementation surface

The P6 release gate permits changes only to the following existing files:

- `apps/clued-cloud/scripts/two-level-snapshot.mjs`
- `apps/clued-cloud/scripts/m2-snapshot-store.mjs`
- `apps/clued-cloud/tests/two-level-snapshot.test.mjs`
- `apps/clued-cloud/worker/records.ts`
- `apps/clued-cloud/worker/continuity.ts`
- `apps/clued-cloud/worker-env.d.ts`
- `apps/clued-cloud/package.json`

It also permits the new P6 implementation, test, runbook, and evidence files named by `tests/test_p6_release.py`. The gate rejects Migration, `wrangler.jsonc`, `VERSION`, memory, P5 evidence, `.openai/hosting.json`, formal Snapshot Pointer, and published Snapshot changes.

## Implemented local contracts

Snapshot publication and rollback use one coordination lock, mandatory Expected-Current input, and CAS under the lock. Lock staleness is measured from the trusted local wall clock and filesystem mtime, never from the caller's business timestamp. Every acquisition has an opaque owner token. Acquire, stale takeover, and release are serialized by a short-held transition guard that is never automatically taken over; an orphaned guard therefore fails closed for operator inspection instead of risking split ownership. Transition-guard acquisition retries `EEXIST` everywhere and the transient `EPERM` produced by ordinary create/delete contention only on Windows; permanent permission errors such as `EACCES` are not swallowed, and exhausted contention returns the stable `publication_lock_transition_busy` contract. Under that guard, release removes only the lock bearing its owner token, so an earlier holder cannot release a successor's lock and already-removed cleanup does not surface `ENOENT`. M2 reuses this single implementation instead of maintaining a second lock algorithm. Immutable snapshot staging is validated before promotion. Pointer updates use temp-write, file sync, rename, and directory sync. The formal entry point reads Pointer, immutable snapshot, and Manifest back after switching. A readback or post-switch audit failure restores the old Pointer and reconciles the persistent store before releasing the lock. The base CLI cannot activate or roll back without Expected-Current (`NONE` is explicit only for an initial empty Pointer).

The Shadow comparator uses deterministic normalization and classifications. Volatile Receipt/Event/Evidence identifiers and timestamps are normalized; operational IDs embedded in a business result are normalized without dropping business timestamps such as `updated_at`. Canonical identity, version, Snapshot, authority, scope, business result, conflict, source, and audit semantics remain comparison inputs. Unknown semantic envelope fields are retained in a dedicated shape and any mismatch increments `unclassified_difference_count`, causing fail-closed. Old-reject/new-accept is always a hard difference. G6-3A uses fixed synthetic fixtures and two same-seed temporary databases only.

The Canary implementation contains the frozen 0%, 1%, 5%, 25%, 50%, and 100% state machine, minimum observation/sample gates, stop conditions, and two-consecutive-severe-window automatic rollback decision. It is implementation code only: `production_enabled` remains false and no traffic configuration is present.

Worker integration accepts the optional Cloudflare Workers Version Metadata binding and ScriptVersion-shaped attribution data. Affinity recognizes the Cloudflare version-key header, a secure same-origin cookie, or a caller-supplied session key. Response decoration is default-off and requires the explicit `P6_RELEASE_CONTROL_ENABLED` runtime input; no deployment configuration enables it in this candidate. This repository does not create a Binding or Transform Rule because deployment authority is not established and production configuration is outside this authorization.

F26 makes canonical State/Task/Decision current authority and treats Log only as historical event evidence. Conflicts are retained and reported; they are never silently merged into a current view.

## Reproducible local verification

Run from the repository root at the candidate commit. Substitute the bundled Python executable available on the reviewer host for `<python>`.

```powershell
git merge-base --is-ancestor 59ce5224b18bad502184a26e8c00f9e51521e41e HEAD
git rev-list --merges 59ce5224b18bad502184a26e8c00f9e51521e41e..HEAD
git diff --check 59ce5224b18bad502184a26e8c00f9e51521e41e --
<python> tests/test_p6_release.py
```

Run the application gates from `apps/clued-cloud`:

```powershell
npm run typecheck
npm run lint
npm run build
node --test tests/two-level-snapshot.test.mjs
node --test tests/p5-cloud-contracts.test.mjs
node --test tests/p5-real-postgres.test.mjs
node --test tests/p6-shadow-canary.test.mjs
npm test
npm run p6:evidence:verify
```

The PostgreSQL tests start embedded local PostgreSQL instances, apply the repository's existing Migration chain, seed two isolated databases identically, dry-run the candidate inside a rolled-back transaction, replay writes, exercise RLS/GRANT and cross-tenant denial, verify Receipt/Event/Idempotency atomicity, and validate physical backup restore. They do not add or repair a Migration and do not connect to Supabase.

Run the repository Python regression suites with `<python>`:

```powershell
<python> -m unittest tests.test_p1_align_and_verify tests.test_p2_verification_context tests.test_p3_isolated_mirror tests.test_p4_canonical_first tests.test_v16_root_cutover tests.test_p6_release
```

## Fault-injection acceptance

F19 injects failures at staging copy/hash, immutable promotion, Pointer temp-write/file-sync/rename/directory-sync, formal readback, post-switch audit, and rollback readback. Every case must leave the old formal snapshot readable. The M2 case additionally proves Pointer and persistent-store reconciliation after an injected post-switch audit failure.

F26 supplies contradictory historical Log evidence and canonical current State. The normalized result must preserve State as current authority, retain the conflict explicitly, and keep Log historical-only.

The P6 gate also requires executable references for F01-F32 and re-hashes all frozen P5 JSONL evidence before accepting the candidate.

## Evidence and independent detached verification

The current replacement candidate's immutable evidence directory is `artifacts/clued-validation/p6/59ce5224-r4/`. Rejected predecessor directories `artifacts/clued-validation/p6/59ce5224/`, `artifacts/clued-validation/p6/59ce5224-r2/`, and `artifacts/clued-validation/p6/59ce5224-r3/` remain frozen and unchanged. `SHA256SUMS` covers every replacement evidence and instruction file and is verified by `npm run p6:evidence:verify`. Evidence creation is exclusive/create-once; regeneration requires a new empty isolated output directory, never overwriting any frozen set.

For independent verification, create a new detached worktree at the candidate commit, install dependencies from the unchanged lockfile, and rerun the commands above. Confirm that the baseline is an ancestor, the range contains no merge commit, the exact allowlist passes, and the frozen evidence hashes reproduce. Do not use `origin/main` as a moving substitute for the fixed baseline.

## Residual risks and authorization gates

- G6-3A can establish deterministic isolated equivalence only. G6-3B still requires separately authorized production traffic, 24-hour observation, at least 1,000 qualified production reads, production-version coverage, and production observability.
- Version Metadata and affinity code are present, but production Binding/Transform Rule configuration and actual routing behavior remain unverified.
- Canary transitions and automatic rollback decisions are deterministic local code paths; no real traffic percentage, Worker Version, production Pointer, or database was changed.
- Schema compatibility is supported by an unchanged Migration set, full-chain rebuild/restore tests, additive optional Worker inputs, and P5 regressions. Production compatibility still requires G6-P authorization.

Separate authorization remains mandatory:

- **G6-M:** fast-forward-only merge of the independently reviewed linear candidate.
- **G6-P:** production access, Worker version upload, production Shadow, real Canary, production database, Binding, traffic, or Pointer operations.
- **G6-R:** Tag, Release, 100% promotion, and old-path retirement.
