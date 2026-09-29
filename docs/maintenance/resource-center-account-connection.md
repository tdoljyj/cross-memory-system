# Account-owned Resource Center connection

Candidate successor under existing Storage Task
`2aa57e7c-9960-45bc-a6f2-ba0c7d74ec9a`. Owner authorization:
`559106ca-bae5-404a-b7c1-04a5b24b3f82`. This is not a production activation.

## Authority and custody

The authenticated Supabase Canonical service remains the only policy authority.
`storage_connections_v1` pins an existing profile, owner and current Decision;
it is a resource registration, not another account/identity store.
`storage_client_grants_v1` is an explicit storage-resource grant attached to an
existing v12 OAuth authorization. No device ID establishes permission. No
`context:write`, account ownership or old Binding automatically grants storage.
Grant creation pins the current v12 authorization version. Revoke, expiry or
reduce invalidates the storage grant; re-consent is an explicit native action.
V12's existing scope/context tables and frozen IntegrationRuntime are unchanged.

### Native client-grant management

The account connection page lists existing clients through `/oauth/connections/api`.
No secret, new device identity or caller-supplied owner is requested. All operation
checkboxes start empty. Native confirmation names the exact Binding, connection,
actions and expiration; this UI caps a grant at one hour and the original v12
authorization expiry. Regranting is always explicit, never a consequence of
Google reconnect, refresh consent, login or listing.

`clued_storage_account_v1({action: "client_grants", connection_id})` is an exact,
native-owner-only read action. It returns the connection CAS/state and a whitelist
of grant metadata, including revoked/expired grants and their receipt. The
`binding_current` field checks only v12 lifecycle/version, **not** profile currentness,
provider visibility or executor qualification; the UI must not call it permission
to execute. It creates no Receipt/Event and rechecks the native session after
lock waits. Existing grant/revoke mutations retain their original transaction,
CAS and Receipt contract. Credential envelopes and bearer hashes are never returned.

An uncertain mutation reply removes action controls and requires explicit readback;
there is no automatic retry/regrant. Account changes discard drafts and late replies.
Client storage revocation does not revoke its unrelated memory grant, other clients,
the provider connection or a standing refresh delegation. In-flight file effects
still require reconciliation. This management UI does not enable the jobs/executor
flags or qualify a live provider.

The account endpoint requires a live native `auth.sessions` row. Client grants
do not depend on the continued existence of the owner's browser session.
Background standing delegation must be separately explicit and revocable: it
must not be derived from a device login or copied refresh token.

Provider refresh credentials belong in private ciphertext rows. The server-only
vault uses AES-256-GCM, a fresh 96-bit nonce and 128-bit authentication tag. AAD
binds envelope contract, deployment key ID, owner, connection, provider subject,
OAuth application and credential revision. Deployment secrets hold keys, not the
database, browser or Agent. Retained keys allow a reviewed CAS rewrap; removing a
key denies decryption. The vault does not decide currentness or revocation.
No DPAPI credential migration or credential exposure is authorized by this code.

## Execution contract for the remaining integration

- New Google OAuth consent must verify the exact application, provider identity,
  existing root/parents and approved scopes before activation. Provider identity
  discovery is not a new root grant. Missing/ambiguous identity fails closed.
- Google refresh, native login refresh, executor leases and single-use admission
  are different lifecycles. Consumed admission is never renewed.
- Stable account/connection/job identity plus full intent digest is stored before
  execution. Equal retries recover state; changed payloads conflict. A new
  connection/profile cannot bypass the existing provider-root unresolved fence.
- Revoke and begin-attempt must serialize. The committed begin-attempt is the
  linearization point: even if HTTP has not yet been sent, that one attempt is
  in flight. Revoke stops new attempts, not already authorized effects. Unknown
  results retain their fence; only verification/settlement, never redispatch.
- Existing exact preflight, internal single-use proof, provider qualification,
  post-write check and Artifact/Event/Receipt transaction remain mandatory.
- Local storage still needs a qualified device-bound executor and exact local
  root. Unified account policy is not cross-device filesystem reachability.

## Implemented candidate and release boundary

Implemented: native registration/list/explicit client grant/revocation, private
typed grants linked to v12 lifecycle, live-session owner management, account and
profile/Decision checks, receipt-backed mutations, server-only credential AEAD.
`/v1/storage/account` is disabled unless `CLUED_STORAGE_ACCOUNT_V1=true`.
Registration remains `awaiting_provider`; it cannot create provider credentials
or activate a writer. The internal Binding check is not an exposed admission.

The follow-on OAuth candidate adds native account connection and callback pages,
server-only Google code exchange with S256 PKCE, same-native-session durable
state, one-shot claim and transactional encrypted credential activation. The
connector requires a provisioned private issuer in addition to the native JWT;
neither alone can activate credentials. Only the two approved Drive scopes are
accepted. Identity uses Drive `user.permissionId`, not an invented OpenID claim.
Root/parent, `isAppAuthorized` and `canAddChildren` are all verified. An unpicked
root is denied: a successful OAuth scope grant alone is not a file selection.
The callback clears its URL before session restoration or network calls and
never feeds a Google code into Supabase's login-code exchange. Claimed but lost
exchanges require fresh consent; completed replay returns only its receipt.
Expiry starts conservatively before token exchange, not after metadata checks.
Both `CLUED_STORAGE_ACCOUNT_V1` and `CLUED_STORAGE_GOOGLE_V1` default off; issuer,
Web OAuth client, fixed redirect and vault keyring are trusted server secrets.
There are no seeds, production secrets or local DPAPI imports in this slice.

The refresh candidate adds a separately explicit, revocable account delegation
(`until_revoked`), managed only by a live native session. It is refresh-only: no
file-operation grant, device identity or login-session lifetime is inherited.
`CLUED_STORAGE_REFRESH_V1` also defaults off. The fixed private connector issuer
polls at most ten due connections fairly; normal polling never calls a model.
The first committed claim alone can disclose ciphertext to the trusted server.
It authorizes one token exchange; unknown delivery retains the durable fence.
Only an identical encrypted result commit may retry, never the Google exchange.
Credential revision and connection CAS advance together, including AAD, to deny
stale OAuth completions. Expiry is measured before the provider request.

Explicit temporary provider errors get bounded 5/10/15-minute backoff and stop
after three failures. Invalid credentials require fresh consent. Expired pending
attempts remain visible as attention-required, never silently disappear. Fresh
native Google consent can supersede credential-only attempts for the exact
owner/root, including a revoked predecessor, but disables standing delegation
until explicit re-enable. It cannot clear any unresolved file-mutation journal.
Revocation and claims serialize; logout does not revoke a standing delegation.
Provider tokens remain encrypted in private Canonical rows and never reach UI,
Agent, receipts or logs. Native management CAS and final session/attempt expiry
checks also apply after lock waits. The UI explains these limits before opt-in.

The shared-job candidate adds `POST /v1/storage/jobs` (submit/inspect only), off
unless both `CLUED_STORAGE_ACCOUNT_V1` and `CLUED_STORAGE_JOBS_V1` are true. It
requires an existing v12 Binding plus the owner's explicit storage grant, not a
native JWT or `context:write` alone. Private Canonical rows retain full create
intent and payload; public status and audit Events expose only identity, digest
and receipt. The primary key is owner/job, independent of device or connection.
An exact resubmission is status-only; changing bytes, path or connection conflicts.
Neither submission nor inspection returns an execution permit.

The unexposed `storage_job_begin_v1` composition point atomically prepares and
starts the original mutation journal, then links that attempt to the job. Only
the first successful transaction returns execution permission; later calls only
inspect the same intent. Original provider-root fences and refresh fences remain
in force. No parallel attempt ledger or timeout-based fence clearing is added.
It pins the submitting grant Receipt and authorization version: revoke/regrant
cannot revive old queued work. Authority projection, exact mutation and full
payload must agree; paths must already be canonical, never silently retargeted.
There is deliberately no public or service-role execute grant on this internal
function. Only the separately qualified server bridge below can call it.

The private cloud-executor candidate now composes the existing admission Host,
native Drive create effect and postcondition verifier without a mounted disk.
Its only execution input is connection/job IDs. Authenticated server closures
must supply the job, registered profile, credential revision and exact RPCs;
neither caller-selected profiles nor credentials are part of the public input.
The shared begin must commit before an attempt is persisted and the single
provider POST is sent. Lost begin, provider or finalization replies do not retry
the effect. Synthetic tests cover this composition in both Node and workerd;
they do not qualify a real provider or replace the shared database contracts.

The original mutation journal now also retains the provider attempt and its
immutable Receipt before dispatch: generated provider ID, exact parent/path,
binding, byte length and SHA-256. The internal recording function checks the
stored job and original writer; only its first transaction records an attempt.
Concurrent/equal replays disclose no new dispatch permission, changed IDs conflict,
and the cloud Host rejects replayed recording receipts. The internal account-job
finalizer requires that recorded ID/path/parent before reusing the original
Artifact/Event/Receipt transaction. These private functions have no public or
service-role execute grant; the fixed-issuer bridge composes them internally.

The remote boundary scanner exhausts metadata pagination under registered
parent/scan-root IDs and reuses the deterministic island rules. Partial results,
ambiguous names, shortcuts, traversal limits and identity drift (including the
parent-list to child-GET handoff) fail closed. These ID/path anchors must come
from trusted qualification, never from a job caller. External-root allowlists
are not yet qualified and are rejected. Drive enumeration is not an atomic
namespace snapshot: this detects observed violations, not arbitrary OS/provider
writers or every concurrent namespace change. Normal scans use no model/content.

The fixed-issuer bridge candidate derives owner, profile and original writer
from the Canonical job; no API caller selects any of these. Server-side AEAD
opening pins owner/connection/provider subject/client/credential revision. The
database requires separately reviewed immutable runtime qualification for the
exact profile version and registered tracks. Its `execution_enabled` and the
Worker's `CLUED_STORAGE_EXECUTOR_V1` both default off. OAuth alone enables neither.
The `Clued Storage executor window` workflow is the reviewed way to open the
Worker gate: the repository owner dispatches it from `main` with the authorizing
Decision ID, it sets the secret to `true` for at most five minutes and then always
sets it back to `false`; `mode: close` closes it immediately. It uses the existing
deploy credential and checks out no code. The database switch stays a separate gate.
One cloud job runs scan, authority, write and post-write verify in a single
invocation, which needs more than the Workers Free 50-subrequest budget, so
`wrangler.production.jsonc` sets `limits.subrequests` explicitly (Workers Paid).
The public submit route schedules this private bridge using only the returned
job/connection IDs, on the `clued-storage-jobs` queue consumer (batch 1, no
retries, each message acked once); inspection never dispatches.
When the authority lookup denies a job, `public.clued_resource_center_authority_v1`
returns a fixed `reason` label (for example `root_version_mismatch`,
`parent_version_mismatch`, `parent_unregistered`, `destination_exists` or
`decision_not_current`) and the cloud executor adds it to its
`storage_cloud_authority_failed` log line. The label names the failed check and
never carries a path, version or provider ID; a version mismatch means the
registry needs the directory check and a CAS `artifact_update`. Failed preflight records a
terminal denied/attention outcome instead of leaving an apparently queued job.
An existing original mutation always takes precedence, including a lost reply.

Recovery starts with a fixed-server metadata-only lookup, independently of the
original client's now-expired/revoked grant. The original writer is never renewed.
An exact provider-ID/hash/path/parent verification may settle the original
Artifact/Event/Receipt transaction using a fresh read-only authority lookup.
That lookup must agree with the original authority vector. Two-minute writer
expiry does not prevent this settlement; profile/account/Decision revocation does.

If the Google access token expires, a still-enabled explicit account refresh
delegation can authorize recovery-only refresh. The existing refresh attempt
stores exact job/intent/provider-attempt digest plus delegation/credential CAS.
Ordinary refresh still requires a quiet root. The recovery branch retains the
file fence, cannot issue writer/admission, and permits only a token-endpoint POST
followed by GET-only Drive verification. Lost token exchange never retries; an
identical encrypted commit may retry. Another verifier settling the exact file
first does not invalidate an already acquired credential-only commit.

General fresh OAuth remains blocked by an unresolved file fence. The separate
credential-only human recovery candidate described in
[writer recovery](resource-center-writer-recovery.md) binds the original job and
does not activate the connection or alter permissions. It requires fresh human
Google consent, the same subject/client/root/scopes and native session plus fixed
issuer. Revoked connections stay unavailable. This implementation is not live
Google acceptance, permission to clear logs, or a claim of complete recovery.

Tests combine real isolated PostgreSQL, two server executors, encrypted fixture
credentials and a synthetic provider, plus actual workerd runtime. Revocation,
unknown refresh and concurrent-settlement fault injections use rollback-only
fixtures; these are not all real two-client database races or live Google tests.

Not yet qualified: live Google Web-client/root authorization, reviewed production
activation, formal no-dual-active entry cutover and bounded real-object acceptance.
Connection `active` means credential connection only, never a qualified writer.
Do not enable the flag or promote this slice as a working multi-device writer.
Do not replace the current local entry, revive its disabled scheduler, delete old
journals, or clear unresolved effects. Production needs reviewed exact artifacts,
CI, the actual provider consent and bounded live qualification before cutover.

Tests: `resource-center-storage-vault.test.mjs` and the account fixture in
`resource-center-authority-db.test.mjs`, plus transport and authorization suites.

## Account Agent transport (candidate; production jobs remain disabled)

### Native directory observation (candidate)

The account page's read-only directory check calls `POST /v1/storage/google/probe`
with only `connection_id`. Both account/Google feature flags must be enabled.
The server preserves the native Owner JWT and adds its fixed private issuer to
`clued_storage_directory_probe_v1`; it does not use a service-role impersonation.
Internal RPCs reject redirects and time out after ten seconds. No caller root,
profile, metadata report, credential, OAuth app or issuer is accepted by the route.

Prepare records a 90-second, same-native-session/issuer attempt in a private
operational table. The server resolves the active registered directory set from
Canonical, excludes the non-writable start-here track, and pins profile/policy,
connection/credential revisions, source Decision versions and artifact vectors.
The existing provider-root quiet fence is reused; no journal is reset or copied.
Ciphertext is returned only over the private server RPC; the attempt keeps its
digest, not another credential copy. The trusted vault opens the exact AAD.

The Google path is GET-only, uses exactly the two approved scopes, verifies the
provider subject and each directory's independent application access, and checks
parent/name/type/version through full child pagination and final identity reads.
A single 60-second budget covers identity and metadata reads; nearly expired
tokens fail closed with no refresh or retry. Normal inspection uses no model and
reads no file bodies. A root grant does not imply child application authorization.

Complete rechecks native session, issuer, quiet root and the full pinned snapshot,
then atomically stores the exact observation with an Event and immutable Receipt.
Identical completion within the live attempt returns the same receipt; changed,
expired, revoked or stale completion is rejected. Wall-clock expiry is checked
again after lock waits. Public output contains status, attempt/receipt IDs,
`execution_permitted:false` and the additive report described below; it never
includes the raw descriptor, sibling entries or credentials.

The Worker now also runs the existing deterministic boundary scanner **before**
completion, against the fixed Canonical parent/root with the same credential,
60-second budget and batch adapter's cumulative byte budget. It performs fresh
reads, follows complete pagination, rejects shortcuts/limits/drift and does not
read file bodies. Single-element metadata batches do not reduce a recursive
scan's request count; exhausting any limit fails closed without a receipt.

The additive `boundary_observation` report is returned only after that scan and
the original CAS complete. It has a versioned contract, observation timestamp,
policy/scanner contract and sorted-JSON SHA-256 of the prepared descriptor and
fixed scan configuration. Sorted JSON recursively sorts object keys, preserves
array order, uses compact JSON and UTF-8; it is not PostgreSQL's jsonb digest.
The fixed configuration has `managed_root`, `root_folder_id`, `root_parent_id`,
`scan_roots: [{folder_id: root_parent_id, path: parent(managed_root)}]`,
`max_depth: 8`, `max_entries: 10000`. No caller roots or raw sibling names escape.
This report is **not part of the unchanged directory Receipt schema**. An old
Receipt never gains boundary semantics. Before manual reviewed runtime
qualification, retain separate immutable Evidence binding the exact new reviewed
release, attempt ID, prepared descriptor/digest, directory Receipt, report and
fixed scan configuration. Deployment plus a directory Receipt alone is not proof.
No automated qualifier may consume this report as a durable boundary Receipt;
that requires a future versioned observation/CAS successor.

This remains observation-time detection, not a Drive atomic namespace snapshot,
cloud runtime qualification, admission or a file-operation grant. Every actual
write still runs the existing boundary scanner again. A later reviewed runtime
registration must bind actual fresh evidence; this migration does not change or
call the cloud qualification/activation API. No jobs/executor flag, Binding grant,
connection state, refresh delegation, writer or fence is changed. Failed attempts
remain operational evidence; they are not represented as successful observations.

Tests cover the private PostgreSQL contract (including real lock-wait expiry),
HTTP validation/redirect refusal, vault-pinned provider reads, actual workerd
composition and account-switch UI races. Synthetic results do not qualify live
Google roots or imply final account-storage acceptance.

### Agent transport contract

`clued_storage_submit` and `clued_storage_inspect` are discovered only when both
`CLUED_STORAGE_ACCOUNT_V1` and `CLUED_STORAGE_JOBS_V1` are enabled. Guessed tool
calls are also rejected while disabled. These tools and `/v1/storage/jobs` use
the same Canonical jobs RPC and fixed-server execution bridge. No new OAuth
scope, credential copy, per-device permission store or database migration is
introduced. The default MCP tool baseline is unchanged.

The caller must use its own v12 Clued Binding with an explicit account-native
storage grant (`create_file` / `create_topic`, and `inspect` for status). Ordinary
`context:write`, a native JWT and a caller-declared owner/profile are insufficient.
No tools for grant issuance, Google credentials, raw admission or provider effects
are exposed. The server still derives the trusted root/profile/artifact role and
consumes the exact single-use admission. The MCP response contains only the
job/connection IDs, digest, state, intent, receipt and replay marker; it never
grants execution to the Agent and is not cached.

For one user-authorized create, choose a stable job UUID and retain the exact
connection and request payload. A lost reply is not failure or permission to
choose a fresh UUID: inspect the original job. Inspection never dispatches or
clears a fence. Identical submission replays use the existing durable identity;
changed content with that UUID conflicts. `queued`, `started`, `uncertain` and
`attention_required` are not success. Only verified `committed` with its receipt
supports completion. Directory requests are limited to topic/asset-collection
semantics; deterministic policy independently rejects status folders and islands.
The full JSON request must fit the existing transport byte limit.

Transport regression tests use a synthetic RPC/provider. They do not prove a
live Owner storage grant, qualified cloud runtime/root, manual OAuth recovery or
real file acceptance. Keep production jobs/executor flags off until those gates
pass; this increment alone does not complete the account storage entry.
