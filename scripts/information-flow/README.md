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

The original package entries were also run on Node.js 24.19.0: M0-A contract,
M0-B prompt, M0-C seal, fixture validation and 27 tests all exited zero. These
results remain Window A/static evidence. This adapter never grants Entry
readiness, rewrites a schema, promotes a Candidate, calls a model or database,
or accepts Phase 2 Slice A. Real runtime consumers must additionally satisfy
their current qualification and authorization contracts.
