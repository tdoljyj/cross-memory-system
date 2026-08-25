# Clued Kernel R5.1 Final Beta Candidate Report

## Verdict

`CLUED KERNEL BETA CANDIDATE`

The mandatory K4–K7 fast-close path is complete. The product candidate is
`3aa1cad752933bde624274e2c4ec0fb8be556fd2` on local branch
`r5.1-fast-close`, with parent
`756a9546d03e7cbf901bf6a15b851bca7453a28f`. The tested worktree was clean.

This report is evidence only. No push, merge, tag, Release, deployment, real
Binding backend switch, or semantic-recall enablement was performed.

## Scope and change boundary

- Baseline: `4be850a2691dc42329d760c18a67fc63d2db08b3`.
- K3 product commit `567222dccd8f51b2314b460876a4de9812aa0c74`
  remains reachable from the candidate.
- Product delta: 25 files, limited to `clued/r51`, R5.1 tests, and R5.1
  receipts/limitations documents, plus K7 privacy assertions in the existing
  K2 tests.
- Production Binding identifiers, binding stores, and `sync.config` were not
  changed or contacted.
- Old R4 evidence, holdout, and Shadow workflows were not replayed.

K7 found and fixed one real PostgreSQL contract mismatch before declaring the
candidate: Cloud FTS excluded `SECRET`, while the frozen database enum uses
`SECRET_BLOCKED`. The final SQL excludes both values. K7 also made the existing
`log_error_verbosity = 'terse'` contract mandatory in static and real
PostgreSQL tests, preventing a test environment from silently omitting that
privacy control.

## Gate results

| Gate | Receipt product head | Result | Hard violations |
|---|---|---:|---:|
| K4 Sync + Security | `aa23b0db88394386887ecc2ff30ea608391de3b3` | PASS | 0 |
| K5 Recall + Lifecycle | `e126c147651620e195e945c0a24ede57bf12e296` | PASS | 0 |
| K6 Install + Doctor + Pilot | `c94a4f0063055c677e1b3ad5077fb7c5ded79998` | PASS | 0 |
| K7 Final Practical Review | `3aa1cad752933bde624274e2c4ec0fb8be556fd2` | PASS | 0 |

All K4–K6 receipt heads exist and are ancestors of the final product candidate.

## BE-01 through BE-06 mapping

| Enhancement | Implementation and proof | Result |
|---|---|---:|
| BE-01 transactional activation | `activation.py`; install/update/repair/disable/enable/uninstall, crash recovery and forced rollback tests | PASS |
| BE-02 capability probes | `probe.py`; read-only real probes, adapter selection and failure isolation | PASS |
| BE-03 generation-safe cache | `recall.py`; content/provider identity manifest, interrupted-generation rejection and cold/incremental equivalence | PASS |
| BE-04 evidence levels | PREVIEW/VERIFIED/AUDIT machine-enforced boundaries, completeness and freshness fields | PASS |
| BE-05 strict telemetry | event/key allowlist, bucketed values, DNT/CI/disabled/no-key checks on every send | PASS |
| BE-06 idempotency | caller-scoped content-free receipts, response-loss recovery, pending replay and conflict/tombstone races | PASS |

## Final verification

- Complete matrix: 47 test files, 678 passed, 0 failed, 0 errors, 0 skipped.
- Critical smoke on the same candidate: 71 passed; stable rerun PASS.
- One noncanonical 15-process parallel run made the Recall Trace timing test
  exceed its budget because of host contention. The timing suite was then run
  in isolation twice and passed both times; all functional assertions had
  remained green.
- PostgreSQL 15.19: K2 21/21 PASS and K3 18/18 PASS.
- Real PostgreSQL FTS qualification: expected visible row 1/1, blocked secret
  row excluded, server log body/object-ID marker matches 0.
- Repository secret scan: 519 tracked files, 0 matches.
- Dependency baseline: `pip check` PASS; R5.1 runtime has 0 third-party imports
  and no package manifest introducing a new runtime dependency.
- Install forced-update rollback: PASS; previous managed content preserved.
- Small backup/restore with deletion-ledger-first replay: PASS; no deleted
  object resurrection; failed restore blocks normal reads.
- Controlled Pilot: 20/20 PASS, data loss 0, unexplained errors 0.
- Temporary PostgreSQL databases 0, managed roles 0, final log body matches 0;
  the isolated cluster was stopped and deleted.

## Performance and cost

| Workload | Result |
|---|---:|
| 1,000 synthetic sync events | 0.064830 s; Outbox remaining 0 |
| 1,000 warm recall queries over 100 objects | p95 0.0799 ms; max 0.522 ms |
| 20-operation controlled Pilot | 0.057447 s |
| External paid-service cost | USD 0 |

No external paid API, staging service, or production system was used.

## Known limitations retained for Beta

- Semantic recall remains disabled; optional S1 was not executed.
- The graphical Installer shell is deferred. CLI and AI Conversation use the
  same verified `KernelService`.
- Cross-device qualification used isolated logical device profiles on one
  Windows host, not two physical computers.
- The real FTS SQL ran against PostgreSQL 15.19; its Python DB-API
  parameterization/error-redaction contract is covered by the deterministic
  provider test because R5.1 intentionally adds no PostgreSQL Python driver.
- Production multi-region RPO/RTO, complete break-glass operations, and a real
  Binding backend switch remain outside this Beta gate.

None of these limitations implies data loss, privilege bypass, secret leakage,
or inability to roll back.

## Authorization boundary

K7 PASS does not authorize publication or activation. Push, merge, tag,
Release, staging/production deployment, and real Binding backend switching
still require the separate authorization specified by the execution plan.
