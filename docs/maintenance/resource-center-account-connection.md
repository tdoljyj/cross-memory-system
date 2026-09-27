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
function. It is not yet a cloud executor and cannot be advertised as one.

The private cloud-executor candidate now composes the existing admission Host,
native Drive create effect and postcondition verifier without a mounted disk.
Its only execution input is connection/job IDs. Authenticated server closures
must supply the job, registered profile, credential revision and exact RPCs;
neither caller-selected profiles nor credentials are part of the public input.
The shared begin must commit before an attempt is persisted and the single
provider POST is sent. Lost begin, provider or finalization replies do not retry
the effect. Synthetic tests cover this composition in both Node and workerd;
they do not qualify a real provider or replace the shared database contracts.

The remote boundary scanner exhausts metadata pagination under registered
parent/scan-root IDs and reuses the deterministic island rules. Partial results,
ambiguous names, shortcuts, traversal limits and identity drift (including the
parent-list to child-GET handoff) fail closed. These ID/path anchors must come
from trusted qualification, never from a job caller. External-root allowlists
are not yet qualified and are rejected. Drive enumeration is not an atomic
namespace snapshot: this detects observed violations, not arbitrary OS/provider
writers or every concurrent namespace change. Normal scans use no model/content.

Not yet implemented/qualified: fixed-issuer cloud RPC/credential wiring, live
Google Web-client/root authorization qualification and formal entry cutover.
Connection `active` means credential connection only, never a qualified writer.
Do not enable the flag or promote this slice as a working multi-device writer.
Do not replace the current local entry, revive its disabled scheduler, delete old
journals, or clear unresolved effects. Production needs reviewed exact artifacts,
CI, the actual provider consent and bounded live qualification before cutover.

Tests: `resource-center-storage-vault.test.mjs` and the account fixture in
`resource-center-authority-db.test.mjs`, plus transport and authorization suites.
