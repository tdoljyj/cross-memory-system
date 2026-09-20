# MPS-03 Repository Implementation Validation — 2026-09-20

Status: IMPLEMENTATION CANDIDATE / NON-PRODUCTION / REVALIDATION AFTER REVIEW FINDINGS

## Authority / scope
- Authorization package: CLUED-UCR-UVC-MPS-03-START-AUTH-v1-20260920
- Authorization Package Event: 837
- Owner Approval Event: 838
- MPS-03 Start Event: 839
- Formal base: bd80de6beed04a52b74f763baa7c274b5741fb1d
- Candidate package SHA-256: d9404c40322bfb78dea7b0015dbee012a49e2463c4a97be38d4b6fca09ca9ab9
- Production / deployment / release / budget / purchase: NOT AUTHORIZED
- MPS-04 / MPS-05 / Legacy: NOT STARTED
- M1-07 / PR #268: untouched

## MPS-03 acceptance
Command:
`python scripts/mps03/run_acceptance.py`

Result after independent-review fixes: 44/44 PASS, 0 fail, 0 skipped. Coverage includes entry authentication and four disjoint credential namespaces passed through separate process environments without credential-bearing arguments, full-stamp and digest verification of the Agent's observation, Native form replay/diff and default human-readable content, same-key HTML recovery after a durable create or confirmation loses its response even when later retries encounter caller or gateway-session 401, 403, or 409, bounded Agent JSON on gateway-session denial, user-readable HTML errors across all five Native pages while API errors remain JSON, deterministic PostgreSQL store conflicts mapped to HTTP 409 through the real gateway and Native form/API, invalid UTF-8 and non-canonical, empty, signed, comma-joined, duplicated, or non-ASCII Content-Length mapped to bounded entry errors, normalized request-key replay, immutable confirmation scope/purpose rejection, PostgreSQL outcome regression, DSN identity rejection, loopback-only gateway URL and binding, proxy-free and redirect-free gateway transport, non-object proposal rejection, redacted database timeout and gateway errors, cross-user replay error mapping, structured gateway outage response, and malformed confirmation stamp rejection.
Raw result: `evidence/mps03_acceptance.raw.txt`

An earlier local run had one `GATEWAY_UNAVAILABLE` error in the loopback proxy-isolation test. Its unchanged-code rerun passed; the failed raw run is preserved as `evidence/mps03_acceptance.transient_connection_failure.raw.txt` rather than counted as a pass. During this follow-up, a first focused boundary test also hit a transient `GATEWAY_UNAVAILABLE`; the unchanged-code focused rerun and full 44/44 acceptance both passed. The exact-head CI result must be checked separately.

Command:
`python scripts/mps03/capture_cross_entry_evidence.py`

Result: Native, canonical reference gateway, and Agent Adapter ran as three distinct processes; all three required local cross-entry chains PASS.
Qualification remains local-reference-backend; no real third-party host PASS is claimed.
Raw result: `evidence/cross_entry_evidence.raw.json`

The earlier 16/16, 22/22, 26/26, 31/31, 32/32, 35/35, 37/37, 39/39, 40/40, 42/42, and 43/43 runs belong to prior PR heads and are superseded by the new 44/44 raw result. Their historical CI results remain bound to those prior SHAs.

## CI runner policy

Command:
`python scripts/ci/validate_runner_budget_policy.py`

Result: PASS / `violations=[]`. The MPS-03 workflow uses the existing trusted self-hosted Windows Python 3.12 capability pool and top-level concurrency with cancel-in-progress. Its job now requires an owner-origin, same-repository PR or an owner-triggered manual run before candidate code reaches that pool; a skipped untrusted job is not a PASS.
Raw result: `evidence/runner_budget_policy.raw.json`

On prior head `8e6467a96c458851fee128cc8b1ad28c45dba452`, Trivy first stalled while downloading the vulnerability database; a failed-job retry completed that scan and the secrets scan, but the misconfiguration scan exhausted its default deadline while its default `mirror.gcr.io` checks bundle source timed out. The scoped CI follow-up selects Trivy's official GHCR checks bundle source for both runner lanes. Scanner types, HIGH/CRITICAL threshold, pinned image, and `--exit-code 1` remain unchanged. This local note does not claim the follow-up CI result; the exact-head GitHub run must be checked separately.

## Existing affected Clued authorization regression
Commands:
- `npm.cmd run typecheck` — PASS
- `npm.cmd run test:authorization:transport` — 25/25 PASS
- `npm.cmd run test:authorization:database` — initial 50/51 because Windows teardown rmdir EBUSY; immediate retry 51/51 PASS
- `npm.cmd run test:authorization:invitations` — 19/19 PASS
- `npm.cmd run test:authorization:migrations` — 2/2 PASS
- `npm.cmd run test:authorization:integration` — 1/1 PASS
- `npm.cmd run test:authorization:pages` — 55/55 PASS

Successful regression total on the previous PR implementation head: 153/153 PASS, 0 skipped. The scoped follow-up changes are confined to MPS-03 Python entry/bridge/test/evidence paths; those existing Clued authorization suites have not been rerun for this follow-up.
The initial database teardown EBUSY raw log is preserved and not hidden; retry raw log is preserved separately.

## Live target and local DB gate
A previous real connection to `clued-auth-test/uscrdifznmlvczcekqpw` verified all five formal MPS primitives by read-only inspection. A previous PostgreSQL validation executed the formal create + same-request replay path inside an explicit transaction and then ROLLBACKed it; the formal create committed inside the test transaction, replay returned the same Receipt, and zero durable validation rows were left behind. **These results predate the present bridge fixes and are not current-head live bridge validation.**
No durable MPS-03 HTTP bridge write was executed.
No real third-party Agent Host was invoked.
Production `clued-prod` was not touched.
Live target fact record: `evidence/live_target_validation.json`
Rollback validation raw result: `evidence/live_postgres_rollback_validation.raw.json`

The prior Docker environment check reported the daemon unavailable; that historical result remains in `evidence/local_docker_gate_environment.raw.txt`. Docker was available for this follow-up. The new `scripts/mps03/validate_local_postgres.py` ran a disposable PostgreSQL 17 container with no network and exercised the Python bridge against the supplied MPS-02A/02B SQL. It verified create/replay including leading/trailing-space normalization to the exact original Receipt, different-payload conflict, rejection of changed confirmation scope/purpose without a durable outcome or Current advance, Agent proposal/Native confirm with distinct allowed authorization generations for Agent read/propose and Native read/update, a second user being denied list, read, history, proposal, confirmation, and same-key create replay on the first user's object, a later Current change followed by exact replay of the old outcomes, stale and altered Agent observation rejection, a confirmation interleaved between ContextPack issuance and exact Revision fetch without mixing stamp and body, repeated pending suggestions reusing the same immutable ChangeSet with fresh intents, re-adoption of an earlier exact Revision, exclusion of another workflow's formal intent from Native listing and confirmation, and rollback of a bootstrap create when the formal commit returned a non-committed result. Raw result: `evidence/local_postgres_adapter_validation.raw.json`. A transient container initialization race on the first follow-up attempt was fixed in the local test harness; the recorded successful rerun used the final harness and removed its container on exit.

**Qualification limit:** the supplied historical MPS-02B SQL calls nonstandard `pg_catalog.jsonb_object_length`. A clean PostgreSQL 17 instance lacks that function, so this local adapter run used an explicit test-only compatibility shim. It is not an unmodified formal MPS-02B G4 PASS. Read-only queries against the named `clued-auth-test` target confirmed its installed `mps_register_change_set` does not reference that missing function; see `evidence/live_target_primitive_readcheck_20260920.json`. No live MPS-03 HTTP bridge write was executed in this follow-up.

## Claim boundary
This evidence does NOT claim G7 Aggregate PASS, full 69 E2E PASS, deployment, release/GA, production traffic/write, or downstream MPS authority.
