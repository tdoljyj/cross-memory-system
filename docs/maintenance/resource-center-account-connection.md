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

Not yet implemented/qualified: credential CAS refresh persistence, background
standing delegation, shared job/attempt execution, cloud provider effects, live
Google Web-client/root authorization qualification and formal entry cutover.
Connection `active` means credential connection only, never a qualified writer.
Do not enable the flag or promote this slice as a working multi-device writer.
Do not replace the current local entry, revive its disabled scheduler, delete old
journals, or clear unresolved effects. Production needs reviewed exact artifacts,
CI, the actual provider consent and bounded live qualification before cutover.

Tests: `resource-center-storage-vault.test.mjs` and the account fixture in
`resource-center-authority-db.test.mjs`, plus transport and authorization suites.
