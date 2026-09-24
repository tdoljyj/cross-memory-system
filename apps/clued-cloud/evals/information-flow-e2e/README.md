# Information Flow M0-D E2E harness (S6)

Runbook for contract `development/contracts/information-flow/M0DCloseout.v0.1.md`
section 7 (E2E-01…15) and gates M0D-B06…B08. Local qualification only: no
production access, no deploy, no model or provider calls.

## Transport

- **Worker:** the continuity handler (`../public-mcp/worker.ts`) bundled with
  `wrangler deploy --dry-run --outdir <tmp> --config evals/information-flow-e2e/wrangler.jsonc`
  and run in Miniflare (workerd) in a child process (`worker-host.mjs`). Every
  Worker `fetch()` goes through `gateway-ledger.mjs` (Miniflare
  `outboundService`): only the loopback Supabase gateway is forwarded; anything
  else is answered with HTTP 599 and recorded.
- **Stack (tier T1):** the Supabase CLI 2.115.0 stack with db, Kong, PostgREST
  and GoTrue. The harness resets the database through the full migration chain.
  Tier T2 (Kong replaced by a path router) is not implemented; a shim tier is
  not qualification evidence.
- **Principals:** two GoTrue accounts (owner U, foreign V) with real JWTs, and
  Agent Bindings minted through `clued_authorization_prepare_v12` /
  `clued_authorization_approve_v12` over PostgREST with U's JWT. Only the v12
  issuer row is a database fixture.
- **Channels:** every step records `worker_rest`, `worker_mcp`,
  `postgrest_direct`, `gotrue`, `db_fixture_setup`, `db_observer_readonly` or
  `process_control`. Fixtures are setup only; the observer is read-only and used
  only for internal state with no transport read route.
- **Isolation:** every harness Node process (the orchestrator, each Worker host,
  the phase-B process and its host, and `wrangler` through `NODE_OPTIONS`) loads
  `isolation-guard.cjs`, which refuses any non-loopback connection and any
  loopback port listed in `IFE2E_DENY_PORTS` (for example a local egress proxy;
  `none` if there is none). Each process writes its ledger on every connection,
  so a SIGKILLed Worker host still leaves one. The Supabase and Docker CLIs are
  Go binaries and cannot load the guard; they get an allowlisted environment
  without proxy variables or credentials and talk only to the local stack.
- **Database locality:** the observer and fixture connections accept only
  loopback, a Unix socket or the db container's Docker bridge subnet read at
  runtime, and must match the identity recorded right after `db reset`.

## Run locally

```bash
cd apps/clued-cloud
npx --yes supabase@2.115.0 start -x realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor
# Node 24.19.0; no provider/cloud credentials in the environment (the run fails closed otherwise).
IFE2E_DENY_PORTS=none npm run test:information-flow:e2e -- --evidence-dir /tmp/ife2e
npm run information-flow:e2e:verify -- --dir /tmp/ife2e [--against <committed evidence dir>]
npx --yes supabase@2.115.0 stop --no-backup
```

The run waits for the real 5-minute confirmation-token TTL (E2E-02, E2E-15), so
it takes about 8–12 minutes. `--ttl-wait-ms` shortens the wait for debugging only;
such a run is not evidence. The wait re-arms until the wall clock (which the
db container shares and token expiry is judged on) reaches the due time, so a
backward clock step during the wait cannot wake it early. E2E-08 restarts the db, PostgREST, GoTrue and Kong
containers and runs phase B in a new process (`continuity-phase-b.mjs`).

## Reproducibility

Run the harness twice at the same commit, then
`node evals/information-flow-e2e/reproducibility.mjs --committed <evidence dir> --cross-check <second run dir>`.
It writes `reproducibility.json` with both runs' per-row normalized digests.
`verify-evidence.mjs --against` fails when digests or code trees differ.

The normalized digest keeps channel, method, target template, HTTP status,
extracted values, assertion ids/expected values/pass and the result. It drops
step ledgers, request/response hashes, durations, assertion observed values,
notes and the environment; it replaces ids, digests, timestamps, PIDs and
PostgreSQL system identifiers and sorts arrays. Byte integrity of each file
comes from `SHA256SUMS` (the seal), not from the normalized digest.

## Evidence

Committed evidence lives in
`artifacts/clued-validation/information-flow-m0d/<code-tree-short>/`
(sealed with `scripts/information-flow/m0d-seal.mjs`). Evidence files carry
digests and extracts only; tokens, JWTs and passwords are never written.
"Reproducible" means equal normalized digests at the same code tree.
