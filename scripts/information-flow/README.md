# Frozen Information Flow parents

The read-only v1 adapter binds the recovered IF-MVP0-A/B/C parents to their
existing delivery roots without moving or rewriting frozen bytes. It verifies
the original checksum-list digest, exact file set, all file digests and path
containment. Dependencies and generated reports must remain outside each parent.

Obtain the private release `information-flow-m0-frozen-archive-20260908` from
`tdoljyj/cross-memory-system`. The M0-C transport ZIP retains its original SHA-256
`06c1eb9414b09e367a96e267cd96dca3d94044ef02ccd9bd59a458ec8dacaed9`.
The recovered A/B ZIPs are new transport containers of unchanged frozen files;
their delivery identities are the original SHA256SUMS digests, not ZIP filenames.

Set `M0A_ROOT`, `M0B_ROOT` and `M0C_ROOT` to the extracted parent directories, then:

```
node scripts/information-flow/frozen-parent-adapter.mjs
node --test tests/information-flow-parent-adapter.test.mjs
```

Without all three roots the integration tests explicitly skip; CI unit tests do
not replace the complete recovered-package run. The local 2026-09-08 integration
run passed all five tests with zero skips. An independent agent repeated that
run and checked all three original delivery roots.

Historical note: a local 2026-09-08 run reported that the original package
entries passed on Node.js 24.19.0. That report is not independently evidenced
here; the 2026-09-23 re-verification (`development/contracts/information-flow/
evidence/parent-reverification-20260923.json`) ran on Node.js 22.22.2. The
M0D-A01 rerun on Node.js 24.19.0 is `m0d-part-a.mjs` below: the M0-C
`node --test` entry is nondeterministic (its `runner-records` test can read a
truncated child stdout), so every attempt is recorded and the result is
`PASS_WITH_DISCLOSED_NONDETERMINISM` when an attempt fails only on that test.
These results remain Window A/static evidence. This adapter never grants Entry
readiness, rewrites a schema, promotes a Candidate, calls a model or database,
or accepts Phase 2 Slice A. Real runtime consumers must additionally satisfy
their current qualification and authorization contracts.

## M0-D closeout scripts (S6)

All require Node.js 24.19.0 and write machine evidence under
`artifacts/clued-validation/information-flow-m0d/<code-tree>/`.

- `m0d-part-a.mjs --zips <dir> --work <dir outside repo> --out <json> [--attempts 3]`:
  M0D-A01. Verifies the release SHA256SUMS and transport ZIPs, extracts the
  parents outside the repository, binds them with the adapter, runs each
  parent's entry in a copy (dependencies installed beside the copy, never in a
  parent root) and re-binds the roots afterwards.
- `m0d-regression.mjs --out <json> --pg-user <user> [--supabase-bin <cli>]`:
  M0D-B07 suites against the local Supabase stack; embedded-PostgreSQL suites
  run as the unprivileged user. A failing suite is compared with the same
  suite at the baseline commits (from `git archive`), each proven to be an
  ancestor of `origin/main`. The Owner acceptance of a baseline failure is
  read from the A03 register (`owner_decisions`).
- `m0d-bundle-observation.mjs --out <json> --e2e-evidence <dir>`: local
  workerd bundle size and timing observation (register L14); never uses the
  production wrangler config.
- `m0d-seal.mjs closure|review-input|seal|verify --dir <evidence dir>`:
  M0D-A03 closure, the B09 review input package, the A04 closeout manifest
  plus `SHA256SUMS`, and verification (including that the sealing commit only
  touches the evidence directory). Review rounds live in
  `b09-review.rounds/NN.json` and are added only in the sealing commit.
