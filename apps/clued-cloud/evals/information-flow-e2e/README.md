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
- **Isolation:** every harness Node process is started with
  `--require ./evals/information-flow-e2e/isolation-guard.cjs`, which refuses any
  non-loopback connection and any loopback port listed in `IFE2E_DENY_PORTS`.

## Run locally

```bash
cd apps/clued-cloud
npx --yes supabase@2.115.0 start -x realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor
# Node 24.19.0; no provider/cloud credentials in the environment (the run fails closed otherwise).
npm run test:information-flow:e2e -- --evidence-dir /tmp/ife2e
npm run information-flow:e2e:verify -- --dir /tmp/ife2e [--against <committed evidence dir>]
npx --yes supabase@2.115.0 stop --no-backup
```

The run waits for the real 5-minute confirmation-token TTL (E2E-02, E2E-15), so
it takes about 8–12 minutes. `--ttl-wait-ms` shortens the wait for debugging only;
such a run is not evidence. E2E-08 restarts the db, PostgREST, GoTrue and Kong
containers and runs phase B in a new process (`continuity-phase-b.mjs`).

## Evidence

Committed evidence lives in
`artifacts/clued-validation/information-flow-m0d/<code-tree-short>/`
(sealed with `scripts/information-flow/m0d-seal.mjs`). Evidence files carry
digests and extracts only; tokens, JWTs and passwords are never written.
"Reproducible" means equal normalized digests at the same code tree.
