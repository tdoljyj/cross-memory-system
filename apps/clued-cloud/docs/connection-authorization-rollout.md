# Unified Clued Skill and connection authorization — candidate rollout

Status: implementation candidate. This document does not activate production,
accept the entire A01–A24 suite, publish a TM19 subject, or restart P6.
The user-approved design is v1.1; its Canonical decision is
`a7c41761-6a79-443d-ac24-10506ed5c11b`, receipt
`f75fd2f6-6ef6-4ac2-88c8-51b05518cf54`.

## Supersession relationship

The earlier `context-ownership-publication-v11` publication/acceptance sequence is
`SUPERSEDED_BEFORE_ACTIVATION` by
`docs/execution-plans/context-ownership-publication-v11/SupersessionDecision_20260908.json`.
Do not resume its old dual-consumer publication checklist, old Grant-minting release
step, or old Worker release sequence as the active plan. Its already-applied
`context_*_v11` schema is retained as a reusable successor dependency because the
2026-09-08 production check found all ten v1.1 business tables empty. Retention of
that schema is not evidence of an activated user capability, and supersession does
not authorize destructive rollback. This successor remains an implementation
candidate and must satisfy its own authorization, runtime, evidence and production
gates.

## Ownership and identity

`skills/clued/SKILL.md` is the single maintained entry, with operation-specific
references. It grants no privileges. A human retains their existing Supabase
identity. Each independently consented OAuth grant has its own Clued Binding,
even when the same client identifier is reused. Permissions are exact
resource/action/environment tuples, and a workflow label never expands them.

The maintained OAuth component is pinned to
`@cloudflare/workers-oauth-provider` 0.10.3. Human Supabase sessions stay on the
Clued account/consent path. The component encrypts the per-connection internal
Binding secret in provider props. Only a hash is stored by the Clued database.

## Actual targets and prerequisites

Production is Worker `clued-cloud` at `https://clued.pixelgrav.com`, backed by
Supabase project `ccxsikzwxlolxqlosril` (`clued-prod`). The repository Sites project
`appgprj_6a8a7bff59548191b5250e5c28b8c80c` is a different publishing target.
Do not deploy this change to Sites as a substitute for the production Worker.

Read-only inspection on 2026-09-08 found the new gateway flag disabled and no
`OAUTH_KV` or authorization issuer binding on the production Worker. The active
Supabase project uses PostgreSQL 17. Its recorded migration history includes
M1, log bridges, search and context v1.1; it does not include the old P5
workspace membership migration. Therefore an unrestricted migration push that
fills every repository gap is not an acceptable rollout command. Map the actual
installed migrations by content and dependency, and select only the reviewed
new successor migrations. Do not run P5/P6 workflows or copy production private
records into a test project.

The only other discovered Supabase project is an inactive restore project.
It is not an approved staging database and must not be resumed or repurposed
without an explicit target/cost decision. Local PostgreSQL fixtures prove
specific behavior, not a live Supabase/ChatGPT deployment.

## Configuration contract

The new Worker path is enabled only when `CLUED_DELEGATED_OAUTH_V12` equals
`true`. Missing configuration while enabled fails closed. Before enabling it,
configure these on the same reviewed Worker version:

| Setting | Required value / handling |
|---|---|
| `CLUED_OAUTH_ORIGIN` | Exact HTTPS origin, no path or trailing slash; production is `https://clued.pixelgrav.com` |
| `SUPABASE_URL` | The approved environment's Supabase API URL |
| `SUPABASE_PUBLISHABLE_KEY` | Publishable key for that same environment; never a service-role key |
| `OAUTH_KV` | Dedicated OAuth provider namespace for that environment |
| `CLUED_AUTHORIZATION_ISSUER_TOKEN` | Fresh server-only random credential, generated and stored through the approved secret channel; never commit it or paste it into chat |
| Private issuer row | SHA256 of that credential, exact `{origin}/mcp` resource, descriptive name, active status |
| `CONTEXT_OWNERSHIP_V11` | Existing context feature must be enabled for the development context tools |
| Auth redirect allowlist | Include the exact approved origin `/?type=recovery` and the reviewed account/invitation verification callbacks |

Do not copy credentials across environments. OAuth consent defaults to no
selected actions; lifetime choices are 1, 7 or 30 days, access tokens last
15 minutes, and database expiry/revocation remains authoritative on every
protected call and refresh.

## Compatibility and cutover

Applying the v1.2 connection migration disables the legacy broad Supabase OAuth
business entry points. This is an intentional compatibility break: old
connections must complete fresh consent. No automatic grant of all previous
permissions and no user/client-pair inference is allowed.

1. Complete the successor implementation and affected local checks; review the
   exact candidate commit, migration files/hashes, installed baseline, and gates.
2. Use separately approved test identities and resources on an approved hosted
   test environment. Complete real ChatGPT Web OAuth, partial consent, recovery,
   expiry, role changes, concurrent connections and write/Receipt verification.
3. Prepare a concrete production change packet: exact Worker artifact/version,
   migration order and hashes, expected current versions, KV/secret targets,
   test evidence, affected old connections, owner and maintenance window.
4. Obtain the production authorization required by `apps/clued-cloud/AGENTS.md`
   for the actual Schema/Binding/Secret/deploy actions. Do not turn metadata read
   access or a draft PR into that approval. Run the existing trusted publication
   gates if the accepted subject requires them.
5. Apply only the approved migrations and configured Worker through the reviewed
   maintenance sequence. A brief explicit closed interval is preferable to an
   unverified overlap that grants broad access. Verify the installed state and
   perform the approved non-private test before declaring the cutover complete.

There is no rollback that re-enables the retired broad OAuth paths. Keep the
new database revocation checks, revoke the candidate issuer if needed, and use
a reviewed maintenance/fail-closed Worker until a corrected candidate is ready.
Restoring Skill files affects instructions only and must never restore revoked
business permissions. Previously returned data cannot be recalled by revocation.

A standard OAuth token revocation conservatively revokes the entire associated
Clued connection. The provider validates the client/token first; Clued commits
its immediate database denial before KV deletion or a success response. A
missing trusted grant reference or failed database revocation produces an error,
not a success acknowledgement. Other independently consented connections remain
available. Refresh downscoping keeps the requested token scope smaller than the
original grant; neither refresh nor provider KV staleness restores database rights.

## Evidence and limits

Run the dedicated `test:authorization:*` scripts. The transport suite uses the
actual pinned component and controlled HTTP responses. The database suite runs
actual SQL transactions. The integration suite joins provider, MCP transport,
and the fully migrated isolated database, verifies one Record/Event/Receipt for
an idempotent retry, and checks independent connections after revocation. The
page suite exercises actual compiled components with controlled identity/network
responses. None substitutes for real ChatGPT Web, real email verification,
Supabase Auth policy, Cloudflare runtime/KV, installed host Skill discovery, or
production acceptance. The full repository migration-chain check does not
license deploying migrations absent from the real production history.
