# Unified KooYomi Skill and connection authorization — candidate rollout

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
step, or old Worker release sequence as the active plan. A later production action
applied `20260907172309_retire_context_ownership_publication_v11.sql`; read-only
verification confirmed the old context table and owner RPC are absent. The prior
retention assumption in the historical supersession record is therefore no longer
the installed baseline. Never reapply or edit that published retirement migration.

The previously uninstalled v12/v13 candidates were resequenced after retirement. The successor
creates only its necessary `development_*_v14` storage and new RPC entry points.
It does not restore old Link, Acceptance, Publication or dual-consumer bridge
surfaces. Existing canonical project identities remain stable. Candidate/new
resources acquire new IDs from the service; do not manufacture old IDs or imply
the removed empty schema is still available. Both the full repository order and
the production-installed migration shape require an isolated upgrade check.

## Ownership and identity

### Issuer credential successor (P0-4 step 2b, implementation candidate)

Owner Decision `818a9b05-4115-4143-8874-da7bdf6f9c4b` selects identity/credential separation, a new
registration digest version, and independent rotation of the two issuer keys. Migration
`20261009070001_issuer_identity_credentials_v1.sql` is the implementation candidate, not evidence of production application.

`issuer_identities_v1` assigns a stable UUID to each existing authorization/storage issuer. Existing 64-hex
`token_hash`/`issuer_hash` PKs and FKs remain historical identity keys; they are not converted to cv1 and must not
be described as current credentials after cutover. Every old issuer-hash RPC authenticates through a dedicated
deterministic verifier resolver before reaching the existing private identity-only business implementation.
Raw-secret RPCs hash their secret and use the same resolver. Binding transaction-local internal proofs are not
issuer proofs. Existing RPC names, parameters and grants remain; private identity entries have no API grants.
The wrappers preserve the existing entry's denial vocabulary (including `authorization_issuer_required`);
the private resolver reports `issuer_credential_required`.

Two closed, fixed storage resolvers preserve existing recovery behavior without weakening fresh-operation
guards. Native policy transition still requires the current Native Owner and an active credential, but can
return only an exact historical Receipt after issuer revocation; changed input or a fresh operation remains
denied. Its transition table SHARE precedes the app-row SHARE lock. Onboarding sweep can use an active
credential of a revoked issuer only to expire that issuer's staged attempts under the original cleanup body;
it starts no onboarding or provider operation. Both recheck expiry after locks, reject retired credentials,
and expose no public bypass flag. Other entry points keep the strict resolver.

The first application gives existing issuers one legacy credential generation with a 24-hour maximum cutover
window. It is a backstop, not a grace period after successful rotation: retire the old generation immediately
after validating its replacement. Reapplication does not extend or revive it. New issuer provisioning creates
identity only; the offline database operator must explicitly stage and activate a separately generated verifier.
The legacy proof remains usable only while that initial credential generation is active and unexpired;
retirement or expiry removes its authentication capability even though its historical identity bytes remain.
This maximum 24-hour cutover window is independent of C1's minimum 24-hour observation after successful
gateway cutover. The resolver checks the wall clock after acquiring credential and issuer SHARE locks;
retirement waits for admitted transactions to release those locks. This is not a commit-time expiry check
after every later business lock wait. C1's observation and withdrawal order is defined in
DatabaseCallerAuthentication.v0.1 §6.2.
`issuer_function_sources_v1` is the versioned implementation source needed for deterministic reapplication;
it contains function definitions, not credential material or a seven-day rollback backup.

Requests present at migration keep their `/2` registration digest byte for byte. New requests use
`clued.storage-client-registration/3` with `issuer_id`; the private immutable request-version sidecar selects
the formula. Existing registrations and request links remain untouched. Redirect identity is computed on both
sides using `clued.storage-client-redirect-identity/2` and the stable UUID, retaining exact resource, scopes,
HTTPS redirect and ambiguity checks. A new DCR request can still inherit the one qualified old lineage.

Rotate `CLUED_AUTHORIZATION_ISSUER_TOKEN` first, then `CLUED_STORAGE_CONNECTOR_ISSUER`, each as a separate
operation under the applicable production approval. Generate a fresh random secret in the approved secret
store; compute its proof and `cv1:` verifier there. Pass only the verifier to the offline operator's
`issuer_credential_stage_v1(issuer_uuid, verifier)`, keep its returned generation, and call
`issuer_credential_activate_v1(issuer_uuid, generation)`. Update the matching Worker secret; verify prepare,
approval/replay/revoke for authorization, or refresh/onboard/queued recovery for storage. Then immediately call
`issuer_credential_retire_v1(issuer_uuid, previous_generation)` and prove the old credential is refused.
Do not proceed to the second key until the first key's positive and negative checks pass. Never set the
underlying issuer row's `revoked_at` in `authorization_issuers_v12` or `storage_oauth_apps_v1` for ordinary key
rotation: that would invalidate its existing authorizations. The UUID identity table has no `revoked_at`.
Each migration, Worker secret update and release needs its own exact production authorization. C1's
Owner-imported independent ES256 signing key is separate from both issuer secrets.

If verification fails, stop that key's cutover. Keep the new generation and the bounded old generation's
observed state, diagnose once, and repair forward. Do not reactivate a retired generation, recover a proof
from historical receipts, or return to direct identity-as-proof authentication. Record exact generations,
Worker deployment and rejection evidence through KooYomi without storing either secret or proof.

`skills/clued/SKILL.md` is the single maintained entry, with operation-specific
references. It grants no privileges. A human retains their existing Supabase
identity. Each independently consented OAuth grant has its own KooYomi Binding,
even when the same client identifier is reused. Permissions are exact
resource/action/environment tuples, and a workflow label never expands them.

The maintained OAuth component is pinned to
`@cloudflare/workers-oauth-provider` 0.10.3. Human Supabase sessions stay on the
KooYomi account/consent path. The component encrypts the per-connection internal
Binding secret in provider props. Only a hash is stored by the KooYomi database.

## Actual targets and prerequisites

Production is Worker `clued-cloud`, with its public site at `https://kooyomi.com`, backed by
Supabase project `ccxsikzwxlolxqlosril` (`clued-prod`). The compatible
`kooyumi.pixelgrav.com` and `clued.pixelgrav.com` MCP/OAuth origins retain their
own resource, issuer and Binding identities. The repository Sites project
`appgprj_6a8a7bff59548191b5250e5c28b8c80c` is a different publishing target.
Do not deploy this change to Sites as a substitute for the production Worker.

Read-only inspection on 2026-09-08 found the new gateway flag disabled and no
`OAUTH_KV` or authorization issuer binding on the production Worker. The active
Supabase project uses PostgreSQL 17. Its recorded migration history includes
M1, log bridges, search, context v1.1 and its later retirement; it does not include the old P5
workspace membership migration. Therefore an unrestricted migration push that
fills every repository gap is not an acceptable rollout command. Map the actual
installed migrations by content and dependency, and select only the reviewed
new successor migrations. Do not run P5/P6 workflows or copy production private
records into a test project.

The hosted test environment approved for this rollout (September 2026) was
Supabase project `uscrdifznmlvczcekqpw` (clued-auth-test) and Worker
`clued-auth-test` at `https://clued-auth-test.tdoljef.workers.dev`, with 19
reviewed migrations and separate Auth, OAuth KV, issuer and callback
configuration. That is no longer its state. The Supabase project is now the
node drill's test project: `.github/workflows/clued-drill-test-sync.yml`
(`scripts/drill-test-sync.mjs`) rebuilds its application schema from
production's applied migration list and brings it up to date after every
production release run; its accounts in `auth` are kept, everything the
September migrations created is not. The Worker `clued-auth-test` still holds
its September version, is not used by anything and does not match the rebuilt
database.
The inactive restore project remains a separate resource; it was not resumed
or repurposed for these tests. Local PostgreSQL fixtures remain distinct from
the hosted and real ChatGPT evidence recorded below. Production activation
has not been authorized by this test work.

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
| Private issuer identity | Independent nonsecret 64-hex identity key in `authorization_issuers_v12.token_hash`, exact `{origin}/mcp` resource, descriptive name and active status; never store a new credential proof as its identity |
| Issuer credential generation | After the identity/credential successor is installed, stage and activate only `cv1:` + SHA256(`clued.credential-verifier.v1:` + SHA256(secret)); use the offline database operator, never an API-role bypass. See [KooYomi provisioning](kooyumi-issuer-provision.md) |
| `CLUED_DEVELOPMENT_CONTEXT_V14` | Explicitly enable the new development tools; the retired `CONTEXT_OWNERSHIP_V11` flag does not enable them |
| Auth redirect allowlist | Include the exact approved origin `/?type=recovery` and the reviewed account/invitation verification callbacks |

Do not copy credentials across environments. OAuth consent starts with every
eligible action selected (the Owner can untick any before approving) and a
30-day lifetime; lifetime choices are 1, 7, 30, 90 or 365 days, and the
database refuses an expiry beyond 365 days (migration
`20261004140000_authorization_expiry_365.sql`). Access tokens last 15 minutes,
the refresh token lives exactly as long as the chosen lifetime, and database
expiry/revocation remains authoritative on every protected call and refresh.

The browser build uses `VITE_CLUED_SUPABASE_URL` and
`VITE_CLUED_SUPABASE_PUBLISHABLE_KEY`. Supply both for the approved environment;
when both are absent the existing production public configuration remains the
compatibility default. The build rejects incomplete pairs, non-public keys and
invalid origins before emitting assets. The Worker settings do not configure
these browser values. Match both sides to the same environment and verify the
resulting artifact. Never expose an issuer, service-role or secret key through
Vite. One shared browser client handles explicit recovery/verification callbacks
once and removes callback credentials from the URL before network processing.

## Development invitation and recovery contracts

After the installed retirement, apply reviewed successors in order:
`20260907173030_clued_development_context_runtime_v14.sql`,
`20260907173031_clued_connection_authorization_v12.sql`, then
`20260907173032_clued_project_invitations_v13.sql`. The v13 invitation and
membership tables reference the existing canonical project/context IDs and do
not require the retired P5 membership schema. Human context management uses `clued_development_owner_v14` at
`/v1/development/owner`; only owner-list/context-create are exposed by its page.
MCP `clued_context` uses `clued_development_call_v14`, with explicit
`development_history` for reading development records. The old `/v1/contexts`
routes and direct OAuth business JWT path cannot activate this successor.
Human-only `clued_project_access_v13` supports list, invitation inspect/create/accept/revoke,
and member reduce/revoke through `/oauth/projects/api`. Invitation acceptance
requires the intended verified email, original one-time token and CAS version.
Only its hash is retained in the database; lost create responses retain the
original idempotency key and must not claim a recoverable token. Membership
revocation and re-invitation cannot revive an old Binding.

An invited developer uses their own stable Supabase subject. Context mutations
retain both the real actor and resource owner in the existing Record/Event/
Receipt contract. Reader/editor membership grants no publication, administrative
or private personal-memory authority. Closing records is separate consent from
writing. Context-only `clued_session_resume` returns `scoped_context_ready` and
`session_checkpoint_supported=false`, with exact authorized context metadata;
it creates no personal session, snapshot or checkpoint. The Skill follows the
returned next operation instead of manufacturing personal Global access.

Platform administrator registration is offline and distinct from account
recovery and project permissions. Only the actual database owner of the
SECURITY INVOKER procedures may call:

- `clued_private.platform_admin_bootstrap_v13(subject, evidence_ref, reason)`:
  one-time initialization at version 1.
- `clued_private.platform_admin_recover_v13(subject, base_version, evidence_ref,
  reason)`: CAS replacement by a different existing, verified and active subject.

Both append an audit with actual database operator/session, old/new subjects,
version, evidence and reason. `anon`, `authenticated` and `service_role` have no
execute privilege. These procedures create no OAuth grant, membership or memory
access. Running them requires a separately authorized exact subject and evidence;
this candidate does not initialize any production administrator.

## Compatibility and cutover

Applying the v1.2 connection migration disables the legacy broad Supabase OAuth
business entry points. This is an intentional compatibility break: old
connections must complete fresh consent. No automatic grant of all previous
permissions and no user/client-pair inference is allowed.

1. Complete the successor implementation and affected local checks; review the
   exact candidate commit, migration files/hashes, installed baseline, and gates.
2. Preserve the completed hosted-test evidence below and finish the remaining
   real-browser scenarios, including partial consent, cancellation and expiry.
   Verify host isolation and complete Skill behavior separately; successful
   OAuth and tool discovery alone do not establish those properties.
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
KooYomi connection. The provider validates the client/token first; KooYomi commits
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


### Hosted test evidence — 2026-09-08

The authorized test run has the following recorded evidence. These identifiers
bind the results to the tested candidate and test environment; they do not
approve production changes or declare the complete A01–A24 suite passed.

| Scope | Recorded result |
|---|---|
| Candidate and CI | `ab9c974c7b80c737d31b18a100423e12f79d16c1`; all six CI checks passed |
| Hosted test database | Supabase `uscrdifznmlvczcekqpw`; 19 reviewed migrations installed |
| Hosted Worker | `clued-auth-test`; tested Worker version `dd233d1b-a02f-403a-ae3c-aaa105049639` |
| Human identity and recovery | Both approved QQ and Gmail test identities completed real email confirmation; the QQ identity completed password recovery and subsequent login |
| Real ChatGPT Web | Actual Clued login and consent, MCP tool discovery, and development-record reading completed; the read result has screenshot evidence and a precise database cross-check |
| Exact record readback | Development record `b2f82377-d38c-41f2-8840-7ea3fa1193d2`, version `1`, matching record count `1` |
| ChatGPT connection | Binding `cdc80ac1-b107-4b8c-8bac-313777d1e404`; development-operation rows attributed to this Binding: `0`, consistent with the observed read-only run |
| Remote HTTP contracts | Read/write isolation, receipt-backed idempotent replay, invitation acceptance and wrong-recipient rejection, membership revocation, connection reduction/revocation, and rejection of refresh after revocation passed |

The HTTP write/replay evidence and the real ChatGPT read evidence are separate:
the latter does not claim a ChatGPT-originated write. Remaining real-browser
partial-consent/cancellation scenarios, host isolation and complete installed
Skill behavior still require their own evidence. The production authorization
and cutover requirements above remain unchanged; P6 remains stopped.
