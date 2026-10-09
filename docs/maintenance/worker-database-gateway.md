# Worker database gateway: staged rollout

Clued Task `9a4d6d2c`; Owner Decision `818a9b05-4115-4143-8874-da7bdf6f9c4b`.
This runbook describes the accepted development direction. A merged migration,
passing local test or configured secret does not prove a production rollout.
Production migration and release use the existing exact-resource Owner doors.

## Stage 1: add the role and switch the Worker

`20261009070002_worker_gateway_transition_v1.sql` adds the NOLOGIN,
non-superuser, non-BYPASSRLS `clued_worker_gateway` role and its explicit RPC
EXECUTE grants. `authenticator` receives `SET` membership without `ADMIN` or
`INHERIT`. PostgreSQL also automatically grants a non-superuser `postgres`
creator an administrative membership from the bootstrap superuser (OID 10):
`ADMIN true`, `INHERIT false`, `SET false`. The migration accepts only this exact
management relationship and rejects changed options, other holders or grantors.
The gateway receives no membership in another role, direct table privileges,
private-schema USAGE or function ownership.
Table and column access combines schema USAGE with object ACLs. PUBLIC SELECT
on statistics views inside an inaccessible schema does not admit a table read;
direct gateway ACLs are still rejected even when the schema is inaccessible.
Sequence privileges remain globally rejected: an OID can reach `nextval`
without a schema-name lookup. No statistics-extension removal or object-name
allowlist is used to admit the gateway.
Existing `anon`, user-session and P5 paths retain their grants at this stage.
The G6 role guard and removal of `anon` belong to stage 2.

Before dispatching an authorized production migration, verify the precise
merged commit, migration file, current production target and the existing
release workflow's migration ledger admission. Do not apply production SQL
through a direct administrator connection as a substitute for that workflow.

The Worker needs `CLUED_DB_GATEWAY_TOKEN` before publishing code that requires
it. Missing or blank gateway credentials reject gateway calls; there is no
fallback to the publishable key. `apikey` remains the publishable key.
Explicit human-session and P5 JWTs remain separate from the gateway JWT.

### Owner signing-key preparation

The rollout order is: apply the admitted stage-1 role migration, import the
dedicated signing key and mint its JWT, verify the actual Data API role,
configure the Worker secret, publish the admitted Worker version, verify all
five entrances, then begin the observation window. Key generation may be
prepared earlier, but role verification cannot pass before the role exists.

Use the production project's Supabase **JWT signing keys** page. Generate a
dedicated ES256 signing key through the pinned CLI and its actual help or
wizard. Keep its private material in Owner-approved secure host storage; do
not save it in this repository, a PR, a Clued record, logs or chat attachments.
Import that dedicated key and move it to the verification-only **Previously
used** state. Do not rotate the current key used by Supabase Auth for users.

Mint a JWT with that imported key and its `kid`, the project's expected issuer
and audience, `role = clued_worker_gateway`, and the one-year expiry accepted
by the design. Verify the target Data API accepts the actual key and role;
do not infer acceptance from a successful import. Store only the resulting
JWT as the Worker secret through the admitted production configuration path.
The private signing key is not a Worker secret. Never print either value.

The CLI's `gen bearer-jwt --help` documents `--role`, `--sub`, `--exp`,
`--valid-for` and `--payload`; the actual secure signing-key selection must
be verified when minting, rather than assuming it signs with the imported key.
There is no requirement to grant the gateway a user's identity or the
`service_role` role.

### Release and evidence

Request `migration.production` for the exact merged migration file, and
`release.production` for the exact commit to publish. Use the configured
production release workflow after its normal admission. Record each completed
outcome in Clued before starting the next production action.

Verify all five request entrances:

- `continuity.ts` gateway calls, including Projection Builder refresh RPCs;
- `delegated-oauth.ts` Binding calls;
- `delegated-oauth.ts` failure-cleanup issuer revocation;
- queued storage dispatch;
- storage access-digest backfill.

Also verify explicit human-session and P5 paths remain correctly isolated,
normal Binding and issuer checks still apply, and missing or invalid gateway
credentials fail closed. Confirm production's effective request timeout; a
role-setting row alone is not evidence of the timeout a real request uses.

Retain only non-secret evidence: exact source commit, migration history,
release run/receipt, signing-key ID, verified request role, RPC, timestamp,
status and correlation ID. Do not log Authorization headers, JWTs, Binding
proofs, issuer proofs or raw secrets.

## Stage 2: observe, then remove old execution privileges

Task `9a4d6d2c` owns this later stage. Start its observation window only after
stage 1's migration, configured credential, release and path verification
have all succeeded. Observe for at least 24 hours, covering MCP, OAuth refresh
and cleanup, storage background jobs and projection refresh. An unexercised
path has no passing evidence; verify it through an authorized normal operation
before closing the stage.

Stage 2 needs its own reviewed migration and precise production authorization.
Remove Worker-only execution from `anon`, and retain exactly the RPC set
actually called directly by `scripts/ci/**` and `scripts/hooks/**`. Check
effective privileges, including PUBLIC and inherited access, rather than
only direct ACL rows. Shared CI/Worker RPCs retain both roles. User-session
functions keep their existing authentication boundary.

G6 remains SECURITY DEFINER. `current_user` inside it is its owner, not the
authenticated caller; `session_user` is the PostgREST login role. Its stage-2
guard must use the verified PostgREST request's transaction role and prove
the real gateway passes while wrong roles and forged input fail. The Worker
overwrites `__transport_source_commit`; its compiled SHA still needs the
existing independent deployment attestation. That SHA is not a secret or
an authentication credential.

## Failure and recovery

Before stage 2, existing `anon` grants remain available. A failed gateway
release can return to the exact previously accepted Worker version through
the authorized release procedure; do not create a runtime fallback that
silently switches a gateway request to `anon`.

After stage 2, a revoked or leaked credential is not restored by a software
rollback. Issue a new admitted credential or perform a reviewed forward fix.
Emergency role-grant removal and signing-key revocation need their actual
authority. Supabase Auth/Data API/Storage/Realtime do not rely on the external
JWKS cache for revocation; the roughly 20-minute cache discussion applies to
external consumers and must not be stated as a fixed Data API delay.

References: [database authentication design](../../development/contracts/database-access/DatabaseCallerAuthentication.v0.1.md),
[Supabase signing keys](https://supabase.com/docs/guides/auth/signing-keys),
[PostgREST transaction role](https://docs.postgrest.org/en/stable/references/transactions.html#request-role-and-search-path).
