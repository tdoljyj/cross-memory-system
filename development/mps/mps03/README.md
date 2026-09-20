# MPS-03 Native + Third-party Agent entry (non-production)

Scope: `CLUED-UCR-UVC-MPS-03-START-AUTH-v1-20260920` (Events 837/838/839).

This directory contains the two bounded MPS-03 entry implementations and the thin PostgreSQL bridge. It does **not** start MPS-04/MPS-05/Legacy, change the 69 formal scenarios, deploy, release, or grant production authority.

## Authority and Current

- Native and Agent are separate HTTP processes and establish separate sessions.
- Caller-provided principal/role labels are not authority. An entry credential is mapped to a server-side principal at gateway startup.
- Every Native request requires HTTP Basic authentication (`native` as username); every Agent request requires a Bearer credential. Set distinct `MPS03_NATIVE_ACCESS_SECRET` and `MPS03_AGENT_ACCESS_SECRET` of at least 32 characters in the respective entry processes. These caller credentials must differ from the gateway `--entry-secret`. Native writes reject cross-origin browser requests. Both listeners are restricted to loopback; a third-party Agent Host must connect through a separately authenticated TLS ingress or tunnel terminating on loopback.
- Resource × Action permission is still resolved by the existing MPS context-pack/authorization state; list/history/proposal reads do not bypass it.
- Neither entry stores a local Current. They re-read the shared gateway.
- Agent exposes read/propose/continue only; Native exposes create/read/confirm/history/context only.
- Agent proposals must carry the exact `observed_state_stamp` from a prior Agent read. A newer Current fails closed instead of silently rebasing the recommendation.

## Durable mutation boundary

`mps02b_pg_gateway.py` is hard-guarded to `clued-auth-test/uscrdifznmlvczcekqpw` and requires `MPS03_ALLOW_NONPROD_WRITE=MPS03_NONPROD_WRITE_APPROVED`. Confirmation reuses only the existing formal primitives recorded in `MPS02B_PRIMITIVE_BINDING.json`; MPS-02A/02B SQL is intentionally not copied here.

The installed MPS-02B primitive set requires an existing Object/Current before a MutationIntent can be issued. Native create therefore establishes a server-side bootstrap basis and the formal `operation=create` intent inside one database transaction, while the durable request/outcome/Receipt commit still goes through `mps_commit_mutation`. The adapter takes the same formal request advisory lock before bootstrap, so same-key retries serialize before any basis is created. Same request + same payload replays the formal durable result; the same request + different payload fails `IDEMPOTENCY_CONFLICT`. The internal bootstrap revision uses a reserved sentinel payload so it cannot collide with the final user-content revision digest, and the bootstrap adoption is not exposed as user history. No second request/outcome/Receipt store is introduced.

Create requires a nonempty `title` and an object `body` without a second `title` key, so different accepted request payloads cannot collapse to the same canonical content. If the formal commit does not return `committed`, the bootstrap transaction fails and rolls back rather than leaving an invisible Current.

PostgreSQL write responses return the immutable committed outcome and its revision/adoption IDs. Read the object separately to obtain the latest Current and state stamp; a write replay never substitutes later Current data into an earlier Receipt response.

## Test-only reference backend

The SQLite reference gateway lives only at `tests/mps03/reference_gateway.py`. It is for local cross-process acceptance and is **not** a deployable or authoritative backend. Local reference PASS is never a live `clued-auth-test` PASS and never a G5/G7 aggregate claim.

## Local checks

```bash
python scripts/mps03/run_acceptance.py
python scripts/mps03/capture_cross_entry_evidence.py
```

Live PostgreSQL execution additionally requires an authorized non-production DSN, `psql`, exact target ID, user/principal bindings, entry secrets, and the explicit non-production write guard.
