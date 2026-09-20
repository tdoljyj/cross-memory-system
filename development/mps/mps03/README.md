# MPS-03 Native + Third-party Agent entry (non-production)

Scope: `CLUED-UCR-UVC-MPS-03-START-AUTH-v1-20260920` (Events 837/838/839).

This directory contains the two bounded MPS-03 entry implementations and the thin PostgreSQL bridge. It does **not** start MPS-04/MPS-05/Legacy, change the 69 formal scenarios, deploy, release, or grant production authority.

## Authority and Current

- Native and Agent are separate HTTP processes and establish separate sessions.
- Caller-provided principal/role labels are not authority. An entry credential is mapped to a server-side principal at gateway startup.
- Resource × Action permission is still resolved by the existing MPS context-pack/authorization state; list/history/proposal reads do not bypass it.
- Neither entry stores a local Current. They re-read the shared gateway.
- Agent exposes read/propose/continue only; Native exposes create/read/confirm/history/context only.

## Durable mutation boundary

`mps02b_pg_gateway.py` is hard-guarded to `clued-auth-test/uscrdifznmlvczcekqpw` and requires `MPS03_ALLOW_NONPROD_WRITE=MPS03_NONPROD_WRITE_APPROVED`. Confirmation reuses only the existing formal primitives recorded in `MPS02B_PRIMITIVE_BINDING.json`; MPS-02A/02B SQL is intentionally not copied here.

The installed MPS-02B primitive set requires an existing Object/Current before a MutationIntent can be issued. Native create therefore establishes a server-side bootstrap basis and the formal `operation=create` intent inside one database transaction, while the durable request/outcome/Receipt commit still goes through `mps_commit_mutation`. The adapter takes the same formal request advisory lock before bootstrap, so same-key retries serialize before any basis is created. Same request + same payload replays the formal durable result; the same request + different payload fails `IDEMPOTENCY_CONFLICT`. The internal bootstrap revision uses a reserved sentinel payload so it cannot collide with the final user-content revision digest, and the bootstrap adoption is not exposed as user history. No second request/outcome/Receipt store is introduced.

## Test-only reference backend

The SQLite reference gateway lives only at `tests/mps03/reference_gateway.py`. It is for local cross-process acceptance and is **not** a deployable or authoritative backend. Local reference PASS is never a live `clued-auth-test` PASS and never a G5/G7 aggregate claim.

## Local checks

```bash
python scripts/mps03/run_acceptance.py
python scripts/mps03/capture_cross_entry_evidence.py
```

Live PostgreSQL execution additionally requires an authorized non-production DSN, `psql`, exact target ID, user/principal bindings, entry secrets, and the explicit non-production write guard.
