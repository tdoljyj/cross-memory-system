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
Decision ID. `mode: open_window` sets the secret to `true` for at most five
minutes and then always sets it back to `false`; `mode: open` sets it to `true`
until a `mode: close` run; `mode: close` closes it immediately and is the
emergency stop. Since Owner Decision `4a1f8617` (2026-10-03) both write gates
stay on (`execution_enabled` true and the Worker gate opened with `mode: open`),
and the Owner's levels on the storage page decide what agents may write. It uses the existing
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
registry needs the directory check and a CAS `artifact_update`.
A registered directory may also hold `provider_sharing_digest` (SHA-256 of its
Drive `shared` flag and sorted `permissionIds`). For the managed root and the
destination parent, a recorded digest replaces the Drive version comparison:
ordinary Drive activity no longer blocks writes, while a sharing or permission
change is denied (`root_sharing_changed`, `parent_sharing_changed`; `*_sharing_unavailable`
when Drive returned no sharing fields). Without a digest the exact version is
still required. Files keep the exact version. The directory check returns each
directory's digest; recording it is an Owner-approved `artifact_update` with
`provider_sharing_digest`. Failed preflight records a
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

Paths (`destination_path`, `source_path`, and `clued_storage_upload_begin`'s
`destination_path`) may be relative to the registered root (`90_待归类/x.md`, the
form `clued_storage_browse` resolve uses) or the full path under it. Migration
`20260930233000_storage_relative_paths_v1.sql` canonicalizes them to the full
path under the connection profile's `managed_root` before the request digest,
so the job, receipt and staging row bind the full path and both forms give the
same digest. Empty, `.` or `..` segments, a trailing `/`, a backslash or the
root itself return `storage_path_invalid`; an absolute path outside the root
returns `storage_path_outside_root`. Both are refused at submit / upload_begin,
before any row exists (StorageNormalUse.v0.1 §5.3).

Transport regression tests use a synthetic RPC/provider. They do not prove a
live Owner storage grant, qualified cloud runtime/root, manual OAuth recovery or
real file acceptance. Keep production jobs/executor flags off until those gates
pass; this increment alone does not complete the account storage entry.

## Read access (StorageFullCapability.v0.1 P1, database layer)

Migration `20260930010000_storage_read_access_v1.sql` adds the read level from
`development/contracts/storage/StorageFullCapability.v0.1.md` §3.3, §5.1 and §5.5.
It is closed by default: `storage_oauth_apps_v1.read_enabled` defaults to false,
no read access row is seeded, and `read_content` cannot be enabled before P2.

- `storage_read_access_v1` holds the read classes for one connection, bound to its
  active account policy. It is separate from the write policy, so toggling read
  never changes the policy row, its digest, `auth_generation` or queued jobs.
  Disconnect or policy revocation stops reads; a read access row never revives.
- `storage_read_client_denies_v1` removes one read class for one client lineage.
  The whole-storage client deny still applies to reads.
- `storage_read_receipts_v1` records every admitted read: an `intent` row commits
  with the admission, before any provider request, and `finalize` records counts.
  It stores no body, file names or search terms, only a Worker-computed HMAC.
- `public.clued_storage_read_v1(issuer, binding hash, input)` is the Worker-only
  transport (`anon`): `admit` runs the read evaluator and returns the sealed
  credential descriptor; `finalize` closes the same Binding's receipt.
- `public.clued_storage_read_access_v1(input)` is native Owner control
  (`authenticated` with a live session): `status`, `set_classes` (CAS on
  `read_generation`, disclosure `clued.storage-read-disclosure/1`) and
  `deny_class` (CAS on the deny generation).

The read evaluator takes lineage guard S, then the root advisory **shared**, then
the same identity/policy row locks as the write evaluator, without a job lock.
Disconnect, policy revoke and read toggles (root X) and client revoke or class
deny (lineage X) serialize with it; the admit commit is the linearization point.

The migration itself adds no MCP tool, Worker route or Google call.

### `clued_storage_browse` (P1 Worker tool)

`worker/storage-read-agent.ts` adds the read-only MCP tool `clued_storage_browse`
(`list`, `stat`, `search`, `resolve`). It is listed and callable only when
`CLUED_STORAGE_ACCOUNT_V1`, `CLUED_STORAGE_GOOGLE_V1` and `CLUED_STORAGE_READ_V1`
are all `true`, independent of the write/job flags. It also needs the secrets
`CLUED_STORAGE_READ_RECEIPT_KEYS` (`{"current":"k1","keys":{"k1":"<base64 32 bytes>"}}`)
and `CLUED_STORAGE_READ_CURSOR_KEY` (base64 32 bytes), plus the existing issuer,
vault and Google client ID.

- Every call is admitted by `clued_storage_read_v1` first; the intent receipt is
  committed before any Google request and finalized in `finally`.
- Google access is metadata-only through the existing batch transport (no
  `alt=media`, no scope change). Root scope is the provider-ID parent chain;
  a multi-parent object with any chain outside the root, missing objects and
  outside objects all return `not_found_in_scope`.
- Search walks only the root subtree breadth-first and never reports how many
  results were filtered. `next_cursor` is AES-GCM sealed and bound to the
  connection, read generation, root, operation and condition HMAC; folders
  carried in a cursor are re-checked on the page that uses them.
- The condition HMAC is domain-separated by connection ID (each connection
  belongs to exactly one owner), with the key ID stored on the receipt.
- Cursors are also bound to the admitted Binding. A search that had to drop
  folders (queue limit 256) seals `lossy` into every later cursor, so no later
  page reports `complete: true`.
- Each call has a budget of 50 Google batch requests. Search stops early with a
  cursor; list, stat and resolve fail closed. Folders with more than 10,000
  children cannot be listed in P1.
- Known P1 limitation: shared-drive objects are not detected by `driveId`; the
  registered root must be in My Drive, as the existing connection flow requires.

Production application, the read switch, the secrets and the Owner's first
`set_classes` each need separate Owner approval.

### P1 rollout runbook

Each step needs its own Owner approval, in this order. If a step fails, stop and
report; never skip ahead or retry with different inputs.

1. **Production migration.** Apply `20260930010000_storage_read_access_v1.sql`
   byte-for-byte to the production database.
   - Before: the migration is not registered and `storage_read_access_v1` does not exist.
   - After: the registered statement's SHA-256 equals the repository file.
   - Check ACLs: `clued_storage_read_v1` is `anon` only and
     `clued_storage_read_access_v1` is `authenticated` only.
   - Check the closed state: every `storage_oauth_apps_v1.read_enabled` is false,
     and the three new tables are empty.
2. **Production release.** Dispatch the Clued Cloud production release on `main`
   and confirm the post-deploy attestation names the released commit. After this,
   `/v1/storage/read-access` and the page control exist, but the read tool is
   still hidden, because `CLUED_STORAGE_READ_V1` is unset.
3. **Read keys.** Run `Clued Storage read config` with `provision_keys` and the
   authorizing Decision ID. It creates the two keys only if they are missing, and
   never prints them.
4. **Owner enables read.** On `/storage/connections`, choose "读取 Agent 查看设置",
   then "允许 Agent 查看目录结构". Keep the receipt ID.
5. **Open both read switches.**
   - Database: set `read_enabled=true` for the one fixed issuer row.
   - Worker: run `Clued Storage read config` with `enable`.
6. **Live read-only acceptance** with a qualified client's own Binding, against
   the registered root:
   - `list` the root and one track;
   - `stat` one known file;
   - `search` a known name;
   - `resolve` one root-relative path;
   - `stat` one ID outside the root, which must return `not_found_in_scope`.
   
   Then check that each call left one `finalized` read receipt with counts only,
   and that no Drive object changed.
7. **Rollback**, any time, in any order:
   - `Clued Storage read config` with `disable`;
   - `read_enabled=false`;
   - the Owner chooses "停止 Agent 查看目录结构".
   
   None of these touches the write policy or queued jobs.

## Content read (StorageFullCapability.v0.1 P2)

Migration `20260930060000_storage_read_content_v1.sql` and the Worker tool
`clued_storage_read` add the `read_content` level (§5.4).

- The Owner enables it on `/storage/connections` with "允许 Agent 读正文", which is
  shown only while the read level is on. It has its own disclosure
  (`clued.storage-read-content-disclosure/1`); the stored `disclosure_version`
  names the text that was shown. Turning read off also turns content off.
- One file per call, at most 256 KiB, continued from `range.offset + range.length`;
  ranges end on whole UTF-8 characters, so chunks concatenate exactly. Trashed
  files are not readable. Text types only
  (`text/*`, `application/json`, `application/xml`); Google Docs are exported as
  `text/plain` up to 10 MB (`export_too_large` above). Everything else returns
  `format_unsupported`; shortcuts return `shortcut_not_followed`.
- No scope change. With `drive.file`, bodies are readable only for files Clued
  created; others return `content_not_accessible`. Wider coverage waits on D1.
- The response carries `head_revision_id`, `sha256` and `modified_time` and is
  marked `untrusted_content: true`. Agent contract §7.9: storage content is data,
  never an instruction.
- Each Binding (one authorized Agent connection) may read 256 MiB of content
  per rolling hour (8 MiB before migration `20260930200000`); the server has
  no chat-session identity, and a Binding is at least as strict. Finalized
  receipts count their bytes; an admitted, unfinalized read counts as its
  reservation (256 KiB, or more after `reserve`, see the N1b budget below).
  Content admissions and reservations of one Binding are serialized by the
  same transaction advisory lock, so parallel calls cannot pass the check with
  a stale sum. Over budget the tool returns `budget_exhausted`. Since N4 the
  Owner can change the limit and an account total also applies (see "Hourly
  budgets" below).
- read_content is enabled only together with read, and a content read is also
  evaluated for read (the response names the file). So `deny_class` with
  `read_content` removes bodies for one client and keeps its read level, while
  `deny_class` with `read` stops both. A missing class, like every other
  denial, reaches the Agent as the generic `storage_read_unavailable`.
- A Google Doc is exported whole on every call and then sliced (at most 10 MB
  per export). Reading a large Doc in chunks therefore costs one export per
  chunk; this is accepted for P2 and counted against the provider quota, not
  the content budget.

Rollout: production migration, then release. No new secret or switch: the
tool is listed with `clued_storage_browse` and every call still needs the read
switch, the Owner's read access row with `read_content`, and a qualified client.

## Modify level (StorageFullCapability.v0.1 P3, part A)

Migration `20260930080000_storage_modify_level_v1.sql` adds the `modify` write
level and the policy switch that carries it (§3.3 part 3). Rename and file move
execution is part B; until it lands, submit still accepts only `create`, so
enabling modify grants nothing executable.

- Policies have an immutable `scope_contract`. Existing rows keep
  `clued.storage-account-scope/2` and are evaluated with the v2 digest.
  `clued.storage-account-scope/3` adds the policy's own action set to the
  digest: the create set, optionally plus `modify`.
- The evaluator accepts `modify` and, like every action, requires it to be in
  the active policy's action set.
- The Owner switches it on `/storage/connections` with "允许 Agent 改名和移动文件"
  (native RPC `clued_storage_write_access_v1`, route `/v1/storage/write-access`,
  disclosure `clued.storage-modify-disclosure/1`, CAS on `policy_generation`).
- Changing the level replaces the policy: the old one is revoked, a new
  `/3` policy is activated with `consent_source=native_level_change`, and the
  connection's `auth_generation` goes up by one. The source Decision and
  expiry are copied.
- An unresolved intent (prepared, started or uncertain) may have a provider
  effect: it blocks the switch with `storage_root_has_unresolved_mutation` and
  keeps its policy. Jobs of this connection that are still queued have no
  effect; the switch cancels them with the same `storage_dispatch_outcome`
  receipt (`denied`, key `cloud-dispatch-outcome:<job_id>`) the Worker would
  write, so a job that can never be dispatched cannot block the Owner. Work
  admitted under the old policy is never re-authorized. If the current
  policy's scope has drifted, the switch returns `storage_owner_scope_changed`
  instead of re-consenting it.
- In the same transaction the active read access moves to the new policy
  (same classes, disclosure and consent receipt, `read_generation`+1), so
  browse and content reads are not interrupted.

Rollout: production migration, then release. No new secret or switch; the
page shows the toggle only when the write-access status loads, and read
settings stay usable if it does not.

## Rename and file move (StorageFullCapability.v0.1 P3, part B)

Migration `20260930100000_storage_modify_execution_v1.sql` and the executor
changes run rename and file move on the existing account-policy job chain.
There is no new permission path: submit evaluates the `modify` level (part A),
then the same begin, provider attempt, verified record and verified settle
steps run with operation-specific checks.

- `clued_storage_submit` accepts
  `{operation: "rename" | "move", target_kind: "file", source_path,
  destination_path, source_file_version}`. A rename keeps the parent folder
  and changes the name; a move keeps the name and changes the folder.
  Directories are not moved (P6).
- `source_file_version` is the Drive version the Agent last saw with
  `clued_storage_browse` stat. A file that changed since is refused before any
  reservation (`SOURCE_VERSION_MISMATCH` in the executor log; the job is
  reported `denied`). The Artifact authority also requires the registered
  source at that exact version, so only files Clued registered can be changed.
  A file whose Drive version advanced after registration is therefore refused
  even with a fresh stat (authority reason `source_mismatch`); it fails closed
  until the Owner re-registers it with `artifact_update`.
- An existing destination name, a destination outside the root or in a status
  directory, and a missing modify level are refused with zero provider updates.
- The executor records `clued.storage-modify-attempt/1` (file ID, both paths,
  both parents, and the content identity: size, head revision, checksums)
  before the single `files.update` call, and re-reads the source before and
  after that durable flush. Drive has no conditional update; the verifier
  re-reads afterwards and requires the same content identity, so a concurrent
  edit is left fenced (`DRIVE_POSTCONDITION_CONTENT_CHANGED`) instead of being
  settled. Only stored files with a head revision and a checksum qualify;
  Google-native documents do not.
- The verifier proves `clued.storage-rename-verified/1` or
  `clued.storage-move-verified/1`:
  - the file is the only entry of its new name, with exactly the destination
    parent;
  - the ancestor chain has the same folder IDs (folder versions are not
    pinned, since Drive may advance them when children change);
  - its content identity is unchanged;
  - for a rename, the old name no longer lists it; for a move, its only
    parent is the destination;
  - two reads agree on its version.
  A version that jumps by more than one is recorded, not treated as failure.
- Settlement updates the same Artifact by CAS on the version the authority saw
  (`artifact_update`); it never registers a second Artifact. As for create,
  the Artifact's `source_decision_id` becomes the writer's Decision. The plain
  journal `finalize` stays create-only. The journal accepts a rename or move
  intent from any writer binding, but only the account-policy executor can
  settle one (by verified settlement), and only after the modify evaluation.
- An uncertain outcome (for example a lost update reply) leaves the intent
  fenced. Scheduled and native recovery load rename and move descriptors,
  re-verify by GET only, and settle through the same verified record; they
  never repeat the update.

Rollout: production migration, then release. Execution still needs the write
switches (`execution_enabled` plus the executor window) and the Owner's modify
level.


## Replace, revision protection and revert (StorageFullCapability.v0.1 P4)

Migration `20260930120000_storage_overwrite_v1.sql` and the executor changes
run replace on the same account-policy job chain, under a separate
`overwrite` level (Owner Decision `cc671d13`: its own switch and disclosure,
K = 10 Clued-pinned revisions per file).

- Policies may carry `overwrite` next to `modify`. The Owner turns it on at
  `/storage/connections` with "允许 Agent 覆盖文件内容" (disclosure
  `clued.storage-overwrite-disclosure/1`). The switch toggles one level per
  call; queued jobs are cancelled and read access moves exactly as for modify.
- `clued_storage_submit` accepts `{operation: "replace", target_kind: "file",
  destination_path, destination_file_version}` plus exactly one of
  `content` (UTF-8, at most 1 MiB) or `restore_job_id`. The target must be a
  file Clued registered, at the version the Agent last saw; a stale version is
  refused before any reservation (`DESTINATION_VERSION_MISMATCH`). The target
  must be a text file (`text/*`, JSON or XML) of at most 1 MiB with a sha256,
  so its kept content can be reverted (`REPLACE_TARGET_UNSUPPORTED`
  otherwise).
- A revert is a replace with `restore_job_id`: the committed replace job of
  the same file whose kept previous revision is restored. The executor
  downloads that revision and requires its size, sha256 and md5 to equal the
  pin before uploading. A released pin, another file's job or an unknown job
  is refused as unavailable.
- Before the first provider write the executor records
  `clued.storage-replace-attempt/1`: file, previous content identity, the
  head revision to keep, the new content's size and sha256, the restore job
  and the older Clued pins to release. It re-reads the file after that
  durable flush, then: sets the head revision `keepForever=true` (skipped
  when the Owner already keeps it), uploads the new bytes, and tries to set
  each released revision `keepForever=false`. A file
  that already has 200 kept revisions (Drive's limit) is refused
  (`REVISION_KEEP_LIMIT`) instead of skipping protection.
- The verifier proves `clued.storage-replace-verified/1`: same file ID, name,
  parent and ancestor folder IDs; a new head revision whose size and sha256
  are the new content's (a sha256 Drive publishes late is re-read); a stable
  version over two reads; the previous revision kept forever with the
  previous size and md5. It reads each listed release and reports as released
  only those Drive shows unkept; releases never block settlement.
- Settlement updates the same Artifact by CAS (`artifact_update`) and adds a
  row to `storage_revision_pins_v1`. At most 10 Clued pins per file stay
  pinned; each replace tries to release all but the newest 9, and each row
  observed released names the settlement receipt. A release that failed
  stays pinned and is listed again by the next replace. A head the Owner had
  already kept is recorded `owner_kept`: restorable, never released, not
  counted. Other revisions the Owner kept in Drive are never touched.
- Residual (T13): Drive has no conditional upload. An outside edit landing
  between the executor's last re-read and the upload is overwritten without
  a Clued pin; Drive's own revision history still holds it.
- A lost upload reply leaves the intent fenced. Scheduled and native recovery
  load replace descriptors, re-verify by GET only and settle through the same
  verified record; they never upload again.

Rollout: production migration, then release. Execution needs the write
switches (`execution_enabled` plus the executor window) and the Owner's
overwrite level.

## Trash and untrash (StorageFullCapability.v0.1 P5)

Migration `20261001130000_storage_destructive_p5.sql` and the executor changes
run trash and untrash on the same account-policy job chain, under a separate
`destructive` level (Owner Decisions `ba02734a` and `7f9daf68`). Every
existing function is changed by an anchored patch with an exact hit count.

- Policies may carry `destructive` next to `modify` and `overwrite`. The
  Owner turns it on at `/storage/connections` with "允许 Agent 把文件移入回收站"
  (disclosure `clued.storage-destructive-disclosure/1`; turning it off stores
  `clued.storage-destructive-disabled/1`). The switch toggles one level per
  call; queued jobs are cancelled and read access moves exactly as for modify.
  The page shows the toggle only when the write-access status names the
  destructive disclosure, so a page released before the migration is applied
  shows only the earlier levels.
- `clued_storage_submit` accepts `{operation: "trash" | "untrash",
  target_kind: "file" | "directory", source_path, source_file_version,
  source_file_id}`. The Worker records them as the Artifact authority's
  `delete` and `restore`; the job, intent, receipts and proofs use those
  names. One item per job, named by its Drive file ID, path and version: a
  different item at the same path is refused (the authority, the executor
  and the attempt check all compare the ID). Files the Owner uploaded by hand
  are not registered, so they cannot be trashed (P7).
- Trash: the source is an active registered item at the version the Agent
  last saw (`source_file_version`, refused before any reservation when
  stale). In place, its folder must be its registered, current parent
  (provider identity `source_parent_id`). A governance item needs
  `delete_authority` (authority reason `delete_authority_required`);
  identical bytes are never a reason. The provider effect is one
  `files.update {trashed: true}`; Clued never calls `files.delete`.
  Settlement (`artifact_trash`, CAS on the Artifact version) moves the
  Artifact to state `trashed` and records the trashed item's Drive version.
  The settlement Event states that Google permanently deletes a trashed item
  30 days later.
- Empty directories: a registered directory may be trashed and untrashed
  only when it is empty. The authority refuses a track (`track_forbidden`,
  also refused at submit) and any directory with a registered item under it
  (`directory_not_empty`). The executor additionally asks Drive for any
  child at all, trashed children included (a namespace-visible listing;
  `drive.file` alone would hide other apps' files), before any reservation
  (job reason `DIRECTORY_NOT_EMPTY`), again after the durable attempt and
  before the update, and the verifier requires it still empty afterwards.
  Drive has no conditional update: a child added in the moments between the
  last check and the update would be trashed with the folder; the verifier
  then fails and the intent stays fenced for the Owner.
- Untrash: the source is an item Clued trashed (Artifact state `trashed`) at
  its registered version; the Agent stats the trashed item by ID for the
  version. The executor descriptor names its Drive ID (`untrash_source`) only
  when exactly one trashed row matches the job's ID, path and version,
  because Drive never lists a trashed item by name. In place, its original
  folder must still be registered and current and its name must be free.
- Name conflict (Decision `7f9daf68`): an in-place untrash whose name is
  taken is refused with `restore_name_conflict` at submit (a registered item
  holds the path) or job reason `RESTORE_NAME_CONFLICT` at execution (Drive
  shows another item with that name). The Agent must ask the user and never
  choose: the untrash tool then takes either `restore_folder` (another
  registered folder, same name; stored as `restore_mode: "folder"` with the
  final `destination_path`) or `restore_name` (the original name with
  `" (n)"` before the extension, n 1..99, in the original folder;
  `restore_mode: "suffix"`). Files only. The effect is one `files.update`
  with `trashed: false` plus `addParents/removeParents` or the new name;
  settlement (`artifact_untrash`) returns the same Artifact to `active` at
  its final path.
- Ownership (§3.4 item 6): before any reservation the executor reads the
  item's `ownedByMe` and `capabilities.canTrash` / `canUntrash`. An item
  someone else owns, or one Drive will not let this account trash, is denied
  with `PROVIDER_OWNER_REQUIRED` (the job's `reason_code`); there is no other
  attempt.
- Limit and batch confirmation (§3.4 item 4, D4, N = 5; Decision
  `7f9daf68`): the server has no session or task identity, so the unit is
  the client registration lineage on one connection over any 24 hours.
  Trash jobs refused before any reservation (including jobs cancelled by a
  level change), and jobs covered by a batch item, do not count. From the
  sixth trash job on, submit refuses with `owner_batch_confirmation_required`
  and no job exists. The Agent then calls `clued_storage_trash_batch` once
  with every remaining item (1–50; each Drive ID, path and version; RPC
  `clued_storage_trash_batch_v1`, destructive level required). Every item is
  matched against the registry or the whole batch is refused
  (`storage_trash_batch_item_unavailable`); the same `batch_id` and items
  return the batch's status (`pending`, `confirmed`, `expired`, `voided`),
  other items under that `batch_id` are refused. At most 5 batches may wait
  for the Owner per client lineage and connection; a sixth is refused with
  `storage_trash_batch_pending_limit` before any receipt is written. The Owner opens
  `/storage/connections` → "读取回收站确认", sees each pending batch with every
  item's action, path, Drive ID and version, and presses "全部确认" once
  (native RPC `clued_storage_trash_confirmation_v1`, route
  `/v1/storage/trash-confirmation`, CAS on `policy_generation`, profile
  version checked; refused while any item changed). The Agent then submits
  the same trash jobs again. A confirmed batch is valid 24 hours (a pending
  one also expires after 24 hours), only for the requesting client lineage
  and only while the policy active at the request stays active (any level
  change replaces the policy and voids it); each trash item covers one job,
  and an item whose job is later refused before any reservation is free
  again. Untrash needs no confirmation; untrash items are shown only. The
  page lists the newest 20 batches and says so when there are more. Events
  carry Drive IDs and versions, never paths; the paths stay in the Owner's
  private rows and are bound by the receipts' request hashes.
- The executor records `clued.storage-destructive-attempt/1` (Drive ID,
  source path and version, final folder, optional relocation, content
  identity or null for a directory) before the single update and re-reads
  the item after that durable flush. The verifier proves
  `clued.storage-trash-verified/1` or `clued.storage-untrash-verified/1`
  (checks: identity, ancestors, stable state, trashed/untrashed, expected
  parent, name vacated/unique name, content unchanged or `empty` for a
  directory). A version that jumps by more than one is recorded, not
  treated as failure.
- A lost update reply leaves the intent fenced. Scheduled and native recovery
  load trash and untrash descriptors, re-verify by GET only and settle
  through the same verified record; they never repeat the update.
- Submit reads the registry for trash/untrash hints (track refusal,
  `restore_name_conflict`) only after the evaluator has authenticated the
  Binding and the destructive level, so an unauthorized token always gets
  `storage_policy_denied`.
- Follow-up (not in P5): Google permanently deletes a trashed item 30 days
  after trashing. Clued does not reconcile that purge yet; the Artifact
  stays `trashed` and a later untrash fails closed at the provider identity
  check. A sweep that marks purged items is a separate change.

Rollout: production migration, then release. Execution needs the write
switches (`execution_enabled` plus the executor window) and the Owner's
destructive level.

## Directory move (StorageFullCapability.v0.1 P6)

Migration `20261002080000_storage_directory_move_p6.sql` and the executor
changes move one registered directory, with everything under it, on the same
account-policy job chain under a separate `modify_subtree` level (Owner
Decisions `c47efe38` and `746fd078`). Every existing function is changed by
an anchored patch with an exact hit count.

- Policies may carry `modify_subtree` after `modify`, `overwrite` and
  `destructive` (`clued_private.storage_write_actions_v1` accepts the create
  set plus any of them in that order). The Owner turns it on at
  `/storage/connections` with "允许 Agent 移动整个文件夹" (disclosure
  `clued.storage-subtree-disclosure/1`; turning it off stores
  `clued.storage-modify_subtree-disabled/1`). The page shows the toggle only
  when the write-access status names `subtree_disclosure_version`.
- `clued_storage_submit` accepts `{operation: "move", target_kind:
  "directory", source_path, destination_path, source_file_version,
  source_file_id}`: the same name in another registered folder, never into
  the directory itself or below it. Submit refuses a track (a direct child of
  the root) and every other shape with `storage_job_input_invalid` before a
  job exists. The `modify` level alone does not allow it.
- The authority matches the registered directory by Drive ID and sharing
  state (Drive advances a folder's version when its children change; the
  Agent's observed version is still checked against Drive before any
  reservation). It requires the directory's folder to be its registered
  parent as Drive reports it, a destination folder other than the root
  (`track_forbidden`), nothing registered at or under the destination
  (`destination_exists`), at most 500 registered items under the directory
  (`subtree_too_large`), and both folders with exactly the same sharing state
  and the same access: every permission with its type, role, domain,
  discoverability and expiry (`googleDriveAccessDigest`, read with
  `permissions(...)`; `sharing_differs`). The executor refuses a difference
  before any reservation with job reason `DIRECTORY_SHARING_DIFFERS`, so the
  moved subtree's inherited access never changes, not even a role. When Drive
  does not return every permission of the directory or a folder (it omits
  them where the account cannot share), the move is refused with
  `DIRECTORY_ACCESS_UNAVAILABLE`.
- Before any reservation the executor also re-reads the server's sample of
  registered descendants by Drive ID; one renamed, moved or deleted in Drive
  outside Clued is refused with job reason `SUBTREE_DRIFT` and no effect. The
  effect repeats that check before and after the durable attempt.
- In-flight work under the subtree (T14) is excluded by the single writer
  per profile: no other intent can be prepared, started or uncertain while
  the move is, and the move cannot start while another one is. A queued job
  that still names an old path fails its own provider lookup with no effect.
- The executor records `clued.storage-subtree-move-attempt/1` (the
  directory, both folders, both paths and up to 10 registered descendants the
  server chose, shallowest first, as the durable start returned them under
  its locks; the attempt must match the registry then and the verified record
  checks the stored attempt) before the one `files.update`
  (`addParents`/`removeParents`, empty body). The verifier proves
  `clued.storage-directory-move-verified/1`: the directory is the only entry
  of its name in the destination, is gone from its old folder, keeps its
  sharing and access, each sampled descendant still sits at its relative path by Drive
  ID, and its version is stable across two reads.
- Settlement (`artifact_subtree_move`, accepted only as the verified
  settlement of a directory move intent whose recorded proof names exactly
  that directory, path and Drive version; never a free path rewrite through
  the administrative RPC) changes the directory's path and
  observed Drive version by CAS on its version, and the path of every active
  or trashed item under it, in the one settlement transaction. Revoked rows
  keep their old path as history.
- P6.1 (Decision `e5e99da8`, migration
  `20261002090000_storage_directory_move_descendants_v1.sql`): Drive advances
  the version of every item under a folder each time the folder moves (P6
  acceptance, Note `23d63403`). The durable start returns every active or
  trashed registered descendant (`subtree_registry`, at most 500; a trashed
  item may share its path with an active one). Before the attempt the
  executor reads them by Drive ID, each on its own (batched when the Worker
  has the batch reader, a failing batch halved until the unreadable item is
  isolated, after every chunk was read once, at most 40 batch requests;
  otherwise up to 50, eight at a time), within 15 s and keeping the last 10 s
  of the admission, and records in the attempt
  (`descendants`) those exactly as registered: same version, name, kind,
  state and folder chain, with each file's size and sha256. After the move
  the verifier reads them again and the proof (`descendant_versions`) names
  the new version of each one still in place with the same content and a
  version not lower than before; those reads have their own budget (a third
  of the verifier's, at most 10 s; a quarter in the Owner's native recovery)
  and as much again is kept before the verifier's deadline, so a slow or
  unreadable item never costs the proof. The settlement sets those versions by CAS on the recorded
  version. Anything else keeps its registered version and stays refused for
  file-level writes, as before; a partial refresh logs
  `storage_subtree_refresh_partial` with counts only. An attempt stored before
  this migration (no `descendants`) keeps its attempt, proof and settlement
  input exactly as recorded and is settled with no refresh.
  Residual: an external change that keeps the content (sharing, a lock, a
  description) made to a descendant between the read before the move and the
  verifier's read is absorbed into the refreshed version.
- P6.2 (Decision `06b54716`, migration
  `20261002130000_storage_directory_sharing_digest_v1.sql`): a directory
  Clued creates is registered with a sharing digest when its sharing equals
  its destination folder's as the provider identity recorded it (the create
  verifier reads it; the proof carries `provider_sharing_digest`, accepted
  only for a directory and only as that folder's digest), so it is matched
  by sharing, not by a Drive version that later moves advance. A directory
  move's settlement records, on the source and destination folders that have
  no digest yet, the digest the provider identity recorded for each, only
  while the folder's registered Drive version is the one the identity
  recorded (`source_parent_version`, new in the identity, and
  `destination_parent_version`): the authority matches the source folder by
  ID alone, and a folder registered at an older version changed in Drive
  since Clued last checked it. A folder that already has a digest is not
  changed. A proof that carries a digest for a file, or for a folder whose
  identity has none, is refused (`storage_verified_mismatch`).
  Release order: apply the migration before releasing the Worker. The old
  executor works against the new database (no digest in its proofs, no
  `source_parent_version`, so no source-folder digest); the new executor
  against the old database has every directory create refused at its
  verified record after the Drive effect, leaving the intent fenced; its
  recovery succeeds only after the migration is applied.
  Residual: the create verifier reads the new folder's sharing after its
  version checks, and the identity reads a folder's version and sharing in
  separate calls. A sharing change between them can only make the recorded
  digest differ from Drive, so later writes are refused, never widened.
- A lost update reply leaves the intent fenced, and the single writer then
  blocks other writes on that root until it is resolved. Scheduled recovery
  never lists or loads a directory move; the Owner's native recovery
  (`/storage/admin`, route `/v1/storage/recovery`) re-verifies it by GET only
  and settles through the same verified record, never repeating the update.

Rollout: production migration, then release. Execution needs the write
switches (`execution_enabled` plus the executor window) and the Owner's
modify_subtree level. For P6.1, keep both off between the migration and the
release: the executor and the database disagree on the attempt during that
window, and a directory move started in it is refused after its durable start
and stays for inspection.

### Release of a started job with no provider attempt

Owner Decision `d9d6db4c`, Task `0ea9a51c`, migration
`20261002170000_storage_release_unattempted_v1.sql`. The P6.2 acceptance
(Note `77019762`) left a directory move `started` after a Drive metadata read
in its pre-effect authority check failed in transit: Drive was never changed,
yet the single writer refused every later write on the root and the Owner's
level switch (`storage_root_has_unresolved_mutation`).

- Every account-policy cloud effect records its exact provider attempt
  (`storage_job_provider_attempt_v2`) before its first Drive write, and that
  record requires the journal, locked for update, to be `started`. A journal
  without an attempt has never reached Drive; once it is cancelled no attempt
  can be recorded, so no Drive write can follow.
- `public.clued_storage_release_unattempted_v1` (fixed connector issuer,
  `{action: release}`) cancels at most 3 `started`/`uncertain` journals of
  account-policy cloud jobs with no attempt, no attempt Receipt and no verified
  record, whose admission expired at least 60 s ago. Each runs under the job and
  root locks with its own Receipt (`storage_unattempted_release`) and Event
  (`extension:storage:unattempted_released`); `final_result` is
  `{outcome: released_unattempted, reason_code: NO_PROVIDER_ATTEMPT}`. The
  job's status reads `cancelled` with that reason code, and the inspect tool
  adds a fixed hint.
- The Worker's scheduled run calls it every minute
  (`runStorageUnattemptedReleaseScheduled`). It reads and writes the database
  only, so it runs with the storage account, Google and jobs flags and does not
  need the executor switch: a stuck root clears without opening a window.
- Before the durable start, the executor reads the provider identity again,
  at most twice, when a Drive metadata read fails in transit (timeout, failed
  request, unreadable answer); an error status is final. The pre-effect check
  is never retried: it runs on the admission's time, and its failure leaves a
  job with no attempt, which the release clears. A final failure logs its fixed
  code (`DRIVE_METADATA_TIMEOUT` and others) instead of
  `PROVIDER_IDENTITY_UNAVAILABLE`.
- Each release candidate runs in its own subtransaction with a 2 s lock
  timeout: one that fails is rolled back alone and skipped; at most 10 are
  looked at per call.
- Residual: no per-effect unit test yet pins "the attempt record precedes the
  first Drive write" for every effect; the directory-move DB fixture covers it
  end to end for moves.
- The level switch stays refused while a job is unresolved (the job settles
  against the policy it was admitted under); the storage page now says so
  (reason `storage_root_busy`).
- Release order: the migration first. The old Worker never calls the release;
  the new Worker against the old database gets an error from the release call
  and logs `storage_unattempted_release_unavailable`.

### Unsettled attempted jobs no longer lock the root (BUG-20261007-005)

Clued Task `c9733a6e`, migration `20261007200000_storage_recovery_deadlock_v1.sql`.
On 2026-10-07 a binary create on the account-policy connection `Clued_资料中心`
recorded its provider attempt and never settled; the file never reached Drive.
Scheduled recovery looked at it only during the 10 minutes after the attempt,
the ordinary credential refresh waits for a quiet root, and the recovery-only
refresh accepted legacy connections only. The access token expired an hour
later and every read of the connection answered `storage_read_unavailable`,
with no alert. Nothing could settle the job: once this change is released, the
next scheduled recovery settles it as `PROVIDER_EFFECT_ABSENT` and reads recover.

- **Recovery keeps trying.** `clued_storage_scheduled_recovery_v2` keeps a job
  due after its first 10 minutes, with backoff stored in
  `clued_private.storage_recovery_backoff_v1` (2, 4, 8 ... minutes, at most 60).
  Jobs inside their first 10 minutes are listed first. `load` no longer has an
  upper age bound.
- **Recovery-only refresh for account-policy connections.**
  `clued_storage_refresh_worker_v1` accepts `recovery_job_id` for an
  account-policy connection when the job is an attempted, unsettled cloud job
  admitted under the connection's still-active policy
  (`clued_private.storage_account_recovery_refresh_v1`, the same checks as
  the scheduled `load`). Like the legacy branch it skips only the quiet-root
  check, keeps the file fence and issues no writer, admission or Drive write.
  The scheduled recovery asks `createStorageCloudRecovery` to report an
  expiring credential (`credential_expiring`) before any Drive read, runs that
  refresh once and loads the job again.
- **Absent effects are settled.** When the post-write verification of a create
  fails, the recovery reads Drive (GET only) for the generated file ID and for
  any file tagged `appProperties.clued_intent_id` with the intent, trashed
  files included (`kernel/host/resource-center-google-drive-absence.mjs`).
  A 404 for the ID and an empty, complete tag search is a proof
  (`clued.storage-create-absent/1`); anything else is not.
  `public.clued_storage_recovery_absent_v1` then re-runs every `load` check
  and accepts only a create whose admission expired and whose attempt was
  recorded at least 10 minutes earlier: every create request is dispatched
  before its admission expires and is bounded at 120 s, and the resumable
  session URI is never persisted, so nothing can complete the upload later.
  The journal becomes `cancelled` with `{outcome: released_not_effected,
  reason_code: PROVIDER_EFFECT_ABSENT}`, its own Receipt
  (`storage_absent_release`) and Event (`extension:storage:absent_released`).
  `clued_storage_inspect` reports the reason code with a fixed hint. A lost
  reply is answered from the journal (`replayed: true`).
- **No silent stall.** The refresh `due` call skips a connection whose root
  has an unresolved journal (its claim would be refused anyway) and returns
  the count as `root_busy`; the Worker logs `storage_refresh_root_busy`. A read
  with an expired sealed token still answers `storage_read_unavailable`, now
  with a fixed hint that the connection's Google access has expired.
  Scheduled recovery logs `storage_recovery_released_not_effected`.
- **Release order.** The migration first. The old Worker ignores `root_busy`
  and never calls the new function; the new Worker against the old database
  gets an error from the absence call (the job stays fenced, as before) and a
  refused `recovery_job_id` refresh for account-policy connections.
- **Residual.** A rename, move, replace, trash or untrash whose effect cannot
  be proven still waits for the Owner's native recovery; only a create can be
  proven absent by its generated ID and tag.

### Queued jobs are dispatched again and never stay queued (BUG-20261008-001)

Clued Task `f7a4dd7d`, migration `20261008000000_storage_queued_dispatch_v1.sql`,
Worker module `apps/clued-cloud/worker/storage-queued-dispatch.ts`.
On 2026-10-07 four text creates on `Clued_资料中心` were submitted while the
root was fenced by the unsettled binary job of BUG-20261007-005. Submit queued
them; the one dispatch after submit was refused at `load`
(`storage_root_has_unresolved_mutation`); the Worker reports a dispatch outcome
only after a successful `load`; and nothing listed a queued job again. They
stayed `queued` with no intent and no reason for more than six hours, while the
same requests submitted after the root settled ran within 90 seconds.

- **Dispatched again.** `public.clued_storage_queued_sweep_v1` (fixed connector
  issuer, `{action: due, dispatch: bool}`) lists at most 3 queued jobs (no
  intent, no dispatch outcome) of active account-policy connections whose root
  has no unresolved journal: 90 seconds after submit, then with backoff (2, 4,
  8 ... minutes, at most 60) counted on the job (`redispatch_attempts`,
  `redispatch_at`). A job on a fenced root is counted as `root_busy` and keeps
  its backoff. Listing counts as the attempt, so a dispatch that is lost or
  refused again still advances the backoff. The Worker's scheduled run
  (`runStorageQueuedSweepScheduled`) dispatches each listed job exactly as after
  submit: the job queue when bound, else in place. A listed job that already
  started only answers its status at `load`; a second `begin` replays.
- **Settled after 2 hours.** The same call settles at most 3 text jobs still
  queued 2 hours after submit as `attention_required` with reason
  `DISPATCH_NOT_STARTED`, through the executor report's own Receipt operation
  and idempotency key (`storage_dispatch_outcome`,
  `cloud-dispatch-outcome:<job>`) and Event, so a late report and the timeout
  cannot both commit. `clued_storage_inspect` adds a fixed hint: nothing was
  changed, submit again under a new `job_id` if still wanted. A binary job keeps
  its own 12-hour cancellation (`staging_expired`). The settlement runs with the
  storage account, Google and both jobs flags; dispatch also needs the executor
  switch and an execution-enabled issuer.
- **Refused at submit when the root is stuck.** A root whose unresolved journal
  outlived its admission by 60 seconds (`clued_private.storage_root_stuck_v1`,
  the unattempted release's threshold) refuses a new submit before any Receipt
  or job with `{status: rejected, error_code: storage_root_busy}`; the MCP tool
  answers a fixed `storage_root_busy` message. A submit while a job is still
  inside its admission queues as before. A replay of an existing job is answered
  from its history.
- **Diagnosable load refusals.** The cloud executor logs a refused `load` as
  `STORAGE_ROOT_BUSY` or `STORAGE_JOB_LOAD_REFUSED` instead of `UNSPECIFIED`.
  The scheduled run logs `storage_queued_sweep` with counts, or
  `storage_queued_sweep_unavailable`.
- **The four jobs of 2026-10-07.** Once released, the first sweep settles each
  job older than 2 hours as `DISPATCH_NOT_STARTED`; none of them runs, so the
  files already written under the same names are not touched.
- **Release order.** The migration first. The old Worker never calls the sweep
  and its submit path passes the new refusal through as `storage_job_unavailable`;
  the new Worker against the old database logs `storage_queued_sweep_unavailable`
  every minute until the migration is applied.

## Full scope and adopt (StorageFullCapability.v0.1 P7)

Owner Decisions `c47efe38`, `746fd078` and `6dc1cf20`, Task `7a8dcb8a`,
migration `20261002200000_storage_adopt_p7.sql`. Adopt registers one existing
item that Clued did not create, where it is, so that the existing levels can
change it like an item Clued created.

**Full scope profile.**

- `full` = `drive.file` + `drive.metadata.readonly` + `drive.readonly` +
  `drive`, in both scope modules (`scopeProfileCovers` orders legacy < normal
  < full). The connection row and the OAuth attempt allow `full`.
- Full includes normal: normal use, content search and binary upload accept a
  full credential (`clued_private.storage_scope_covers_v1`).
- The storage page offers "允许管理已有文件" once the server reports
  `full_scope` and `full_scope_disclosure_version` (normal-use status). It
  confirms `clued.storage-full-scope-disclosure/1` and starts connection
  consent with `full_scope: {disclosure_version}`: the attempt records
  `requested_scope_profile = full` and the disclosure. It upgrades the Google
  grant only; no write level or read access changes. It is refused at 90
  counted refresh tokens, like a normal-use upgrade.
- A plain reconnect of a full connection requests the full set with no new
  disclosure; a lower connection cannot request full without it
  (`storage_oauth_denied`).
- Complete accepts the requested profile or any lower one (the Owner may
  untick a scope) and records what Google granted. The callback page says
  whether managing existing files is allowed.
- To withdraw the grant, the Owner removes Clued in the Google account's
  third-party access settings; this ends every Clued connection of that Google
  account. "撤回全部文件读取授权" does not exist yet, and the full-scope
  disclosure never points to it.
- Before Google's verification of the `drive` scope, only test users can grant
  it. If the consent page refuses the scope, add it to the OAuth consent
  screen's data access list in the Google Cloud console; that is a console
  change, not a code change.

**Adopt job.**

- Submit: `{operation: adopt, target_kind: file|directory, source_path,
  source_file_id}` under the `modify` level. Before any job exists the
  database refuses a connection whose credential is not full
  (`adopt_scope_upgrade_required`), an item registered (active or trashed) at
  that path or a Drive ID registered in any state, revoked included
  (`adopt_already_registered`: an item the Owner removed from Clued returns
  only through the administrative path), and the root's own children (tracks;
  `storage_job_input_invalid`).
- Authority: the item's folder must be registered, current, matched like any
  destination folder (Drive version or sharing digest) and `ordinary`
  (`governance_forbidden` otherwise: items under governance folders keep the
  administrative registration path). A directory is adopted only when its
  sharing digest equals its folder's (`sharing_differs`), so content written
  into it later inherits nothing its folder does not grant. A file's own
  sharing is not checked (Decision `6dc1cf20` does not ask for it): a later
  replace writes into a file shared however the Owner shared it.
- Executor, before any reservation: `ADOPT_SCOPE_UPGRADE_REQUIRED` (the
  credential is not full), `PROVIDER_OWNER_REQUIRED` (not owned by this
  Google account), `ADOPT_TARGET_UNSUPPORTED` (a shortcut, trashed, in
  several folders, or not the named kind), `DIRECTORY_SHARING_DIFFERS`.
- Adopt writes nothing to Drive. Its attempt
  (`clued.storage-adopt-attempt/1`) names the item, its folder and the Drive
  version the authority saw; the proof (`clued.storage-adopt-verified/1`)
  shows the same item, path and version (read twice), the only one of its
  name, owned by this account, not a shortcut and, for a directory, with its
  folder's sharing. Settlement registers an `ordinary` Artifact
  (`delete_authority = false`; a directory with its sharing digest) through
  `artifact_register`; the settle Event names the observation (`adopted`).
- Unchanged-ness is judged by the Drive version (it advances on any content
  or metadata change), read at the identity, in the effect and twice in the
  verifier; no revision or checksum is recorded for the adopt itself. Later
  operations record their own content identity in their attempts.
- An adopt that fails verification (for example the item is being edited)
  leaves its journal started, and the single writer blocks other writes on the
  root until the release below cancels it (about 90 s after the start, plus the
  minute cadence). An item that keeps changing cannot be adopted.
- An adopt that has not committed 60 s after its admission expired is
  released by the scheduled release with
  `{outcome: released_no_effect, reason_code: ADOPT_NOT_SETTLED}`, with or
  without an attempt or proof. Scheduled recovery never loads an adopt.
- Without the full credential, Drive refuses writes to an item this app did
  not create or open. For rename, move, replace, trash, untrash and directory
  move, the executor reads `isAppAuthorized` of the item (from the identity it
  already resolved for the durable start) when the credential is not full and
  refuses `SCOPE_UPGRADE_REQUIRED` before the durable start when Drive reports
  `false`, so a downgraded connection never fences the root by changing such an
  item. Residual: the destination folder is not checked. Moving or creating
  into an adopted folder Clued did not create, after a downgrade, may still be
  refused by Drive after the attempt and stay fenced for recovery.

Rollout: production migration, then release. The old Worker never submits an
adopt and treats a full credential as having no profile, so connections stay
below full until the release; the Owner then re-authorizes Google from the
storage page. Acceptance needs the write switches (`execution_enabled` plus
the executor window) and the Owner's modify level (destructive to test
trash).

## Scope profiles (StorageNormalUse.v0.1 N0a)

Migration `20260930140000_storage_scope_profile_v1.sql` and the Worker and
kernel changes lay the scope foundation for normal use. Nothing changes for
existing connections: every row is `legacy` / `text/1`, the consent page still
requests only the legacy set, and nothing can create `normal/1` yet.

- The only accepted Google scope sets live in
  `apps/clued-cloud/worker/storage-google-scopes.ts` and its kernel mirror
  `kernel/host/resource-center-google-scopes.mjs`:
  `legacy` = `drive.file` + `drive.metadata.readonly`; `normal` = legacy +
  `drive.readonly`. `scopeProfile()` compares the deduplicated, sorted set
  exactly; a set with `drive`, `drive.metadata`, anything unknown or a missing
  member has no profile and is refused. A CI test fails when a scope URL
  literal appears anywhere else (tests, the local pilot credential and prose
  excepted) or when the two modules differ.
- OAuth `complete` accepts either profile, seals the granted normalized set
  (not a constant) and records `storage_connections_v1.provider_scope_profile`
  in the same update that advances `credential_version`. A `complete` without
  the field (a Worker released before the migration) records `legacy`.
- Refresh never changes the profile: a token reply with a `scope` whose
  profile differs from the sealed one fails as `provider_rejected`, and the
  connection needs fresh consent (`reauthorization_required`).
- Credential recovery requests exactly the sealed profile's set, and both the
  Worker and the database refuse a grant of the other profile; the credential
  is unchanged.
- Executor, recovery, probe and read agent accept either profile. The read
  admission returns `provider_scope_profile` and the read access
  `content_profile`; the read agent refuses (`storage_read_unavailable`) a
  sealed set whose profile differs from the row. Until N1 a `normal` token
  reads bodies exactly like `drive.file`: before any media or export request
  the read agent requires `isAppAuthorized === true` from metadata
  (`content_not_accessible` otherwise).
- `storage_read_access_v1.content_profile` (`text/1` | `normal/1`) is
  immutable with the row; moving read access to a new write policy copies it.

Rollout: production migration first, then release (the released read agent
requires both admission fields). Rollback of the release alone is safe: the
previous Worker ignores the new fields and writes no profile.

## Normal use on an existing connection (StorageNormalUse.v0.1 N1a)

Migration `20260930160000_storage_normal_use_n1a.sql` with the Worker and page
changes. Existing connections keep working unchanged until the Owner turns on
"正常使用"; nothing upgrades automatically (Q10).

- **Re-consent.** On a `legacy` connection the page shows the
  `clued.storage-normal-use-disclosure/1` text and then starts Google consent to
  the normal set on the same connection (`/v1/storage/google/start` with
  `normal_use.disclosure_version`). The attempt records the requested profile,
  `normal_use_requested`, the disclosure version, the read generation at
  prepare and the delegation carry snapshot. `complete` accepts only the
  requested profile or `legacy`; `normal` granted -> the same transaction writes
  `{read, read_content}` + `normal/1` read access (unless the read access
  changed since prepare); `legacy` granted -> only the credential is replaced
  and the callback says "未授予……正常使用未开启". A plain reconnect requests
  the profile the row records, so it never downgrades by itself; if the Owner
  unticks the scope while reconnecting a `normal` connection, the credential
  follows what Google granted (`legacy`) and the callback shows the same
  message (it compares `requested_scope_profile` with `provider_scope_profile`).
  A carried delegation is reset like `refresh_manage` enable (`failures=0`,
  due now). A replayed `claim` also returns the current profile and, for a
  normal-use attempt, the current `normal_use_enabled`.
- **No revoke on upgrade (Q11).** The `complete` UPDATE overwrites
  `credential_envelope`; no other table holds an envelope (the DB fixture scans
  every text/jsonb/bytea column in `public` and `clued_private` for fragments
  of every replaced envelope). Overwritten row versions stay in the heap until
  VACUUM and in PITR backups for their retention period; the old refresh token
  stays valid at Google, but Clued keeps no decryptable copy of it.
- **Busy root.** Prepare calls `storage_root_quiet_v1` once for an early
  answer and complete checks it again; the page maps it to `storage_root_busy`
  ("稍后再试"). Any refusal rolls back: the old credential and connection stay.
  Queued jobs read the current `credential_version` at `load`; a job loaded
  before and prepared after a credential change fails closed on the version
  check (no provider request).
- **Delegation carry.** `public.clued_storage_oauth_v1` is now the outermost
  wrapper (the 211632 dispatcher is `clued_private.storage_oauth_dispatch_v1`).
  For a connection-purpose `complete` it locks owner||root, the connection and
  the delegation row (in that order) and, after the inner wrappers disabled
  every delegation of the root, re-enables this connection's delegation only
  when it was enabled before and subject, OAuth client and root equal the
  prepare snapshot and the completed row (same issuer). It writes its own
  receipt `storage_refresh_delegation_carry` and Event
  `extension:storage:refresh_delegation_carry`.
- **Refresh-token count.** Every OAuth claim (any purpose) inserts one row into
  `storage_refresh_token_issuance_v1` before the token exchange. The count is
  per owner x provider subject x OAuth client (claims whose subject is unknown
  count for every subject). The page warns at 50. At 90 only a normal-use
  re-consent (prepare with `normal_use`) is refused (`refresh_token_limit`); a
  plain reconnect and credential recovery are counted but never refused, so an
  Owner is not locked out while "撤回全部文件读取授权" (the revoke slice, which
  will write `cleared_at`) does not exist. The page and callback tell the Owner
  to contact a maintainer instead of pointing to that control.
- **Operator step: resetting the refresh-token count.** Only after the Owner
  has removed Clued's access for that Google account at
  <https://myaccount.google.com/permissions> (which invalidates every refresh
  token of that account x client; each affected connection then needs a plain
  reconnect), run in the production SQL editor, with the owner ID, the Google
  provider subject from the connection row and the OAuth client ID:

  ```sql
  update clued_private.storage_refresh_token_issuance_v1
     set cleared_at = clock_timestamp()
   where owner_id = '<owner uuid>' and oauth_client_id = '<oauth client id>'
     and cleared_at is null and (provider_subject = '<provider subject>' or provider_subject is null);
  ```

  Confirm with `clued_storage_normal_use_v1` `status` (the page's "读取正常使用
  设置") that `refresh_token_count` is 0 and record the change in the ops log.
  Never clear rows without that Google-side removal: the count exists because
  Google silently drops the oldest tokens past its limit.
- **Native RPC `clued_storage_normal_use_v1`** (`/v1/storage/normal-use`):
  `status` (both profiles, CAS base, token count), `enable` (needs a `normal`
  credential, otherwise `reconsent_required` and no write) and `disable`
  (back to `{read}` / `text/1`, Q8; the Google grant is not narrowed). Both
  are CAS on `read_generation` and carry the disclosure version. `set_classes`
  refuses to keep `read_content` on a `normal/1` row
  (`storage_normal_use_managed`) instead of silently rewriting it as `text/1`.
- **Reads (§3).** With a `normal` credential and `normal/1`, any in-root
  text/JSON/XML file and Google Doc is readable; otherwise the read agent
  requires `isAppAuthorized` from metadata before any body request and answers
  `scope_upgrade_required`. All body requests go through one content gateway
  that only accepts IDs that passed the root check in the same call. After the
  body is fetched the whole ancestor chain is walked again with an empty cache
  (bytes dropped on failure); if the budget cannot hold that re-check, no body
  is requested (`storage_read_unavailable`).
- **Full-text search (§5.2).** `clued_storage_browse` `search` with `text`
  queries `fullText contains` per in-root folder and intersects the hits with
  the scoped child list; the admission (`content_search`) requires `normal/1`,
  a `normal` credential and the `read_content` class (per-client deny applies).
  Responses carry `text_index: "provider"`. A search round (child list, then
  the full-text batch) is all or nothing: when the call's 50-request budget
  runs out inside a round, the page ends with `complete: false` and a cursor
  that repeats that folder chunk; only a page that cannot finish its first
  round answers `storage_read_unavailable`.
  A Drive batch that times out or answers 429/5xx is retried once (250-750 ms
  jitter, counted in the same budget, within the call's 25 s deadline); if it
  still fails after round 1, search treats it like budget exhaustion
  (`complete: false` + cursor). Round 1, list/stat/resolve/read and the
  ancestor walk still fail closed. Workers logs carry only
  `{event: "storage_read_drive_transient", code, outcome}` (retried /
  absorbed / fatal); the qualification probe and executor never retry.
- **Known follow-up (PR #418 review, minor 4).** The disclosure names the root
  by the registered profile's `managed_root` path, not by the folder name read
  from Drive; a folder renamed in Drive keeps showing the registered path.
- **Boundary island rule and Owner material (StorageNormalUse §3.1).** Both
  credential profiles list the whole Drive's metadata (`legacy` has always
  held `drive.metadata.readonly`). The write-path boundary scan flagged any
  Clued-named entry outside the managed root, so the Owner's own `Clued_*`
  docs and folders, or another tool's, in My Drive denied every write job
  with `UNAUTHORIZED_WORKSPACE_MUTATION` before any intent. Per Clued Decision
  `fd94bd2f`, only that island rule now counts entries the Clued app created
  or opened (`isAppAuthorized === true`; a missing field still counts).
  Listings stay unfiltered: duplicate names, shortcuts, root impersonation,
  depth and entry limits, and the identity and postcondition absence and
  uniqueness checks see every entry and fail exactly as before.
  Another active root of the same owner under the same Drive parent (an N0
  onboarded root beside `Clued_资料中心`) is not an island either (Decision
  `b18eff80`, migration `20261002070000_storage_registered_sibling_roots_v1`):
  the job descriptors (account-policy v2 and legacy v1) and the
  directory-probe descriptor carry `registered_sibling_roots`,
  the owner's other active profiles' `root_folder_id`s with the same
  `root_parent_id`, and the scanner skips exactly those folder IDs when they
  are listed directly in the managed root's parent. A same-name folder with
  another ID, a revoked profile's root and other owners' roots still count.
  More than 64 such roots under one parent fails closed
  (`DRIVE_BOUNDARY_PROFILE_UNQUALIFIED`); the list is read when the job or
  probe is loaded.
  Diagnose
  from Worker logs: `storage_cloud_denied` (a deny, e.g.
  `UNAUTHORIZED_WORKSPACE_MUTATION`) or `storage_cloud_unavailable` (the job
  becomes `attention_required`; fixed codes such as `DRIVE_BOUNDARY_*`,
  `CLOUD_MUTATION_SHAPE_INVALID`, `STORAGE_CREDENTIAL_*`, else `UNSPECIFIED`).
  Neither event carries IDs, paths or provider text.
  In account-policy mode the same fixed code is also stored in the database
  (migration `20260930230000_storage_dispatch_reason_v1`): the job's
  `dispatch_outcome` is `{status, reason:{code, findings?}}`, where `findings`
  (a denial only, at most 10, each `{path, reason}`) are the boundary scan's
  offending paths, e.g. `select dispatch_outcome from
  clued_private.storage_jobs_v1 where job_id=...`. `clued_storage_inspect`
  shows only `reason_code`; the paths stay in the Owner's rows. A Worker
  released before the migration falls back to the plain `{status}`.

Before N1 acceptance (§2.4 items 7-8, not verifiable here): verify with a real
Google account whether revoking the legacy token invalidates the normal one and
the account's other connections, and the refresh-token limit behaviour; record
the results here. Submit the Google restricted-scope verification (§2.5).
Rollout: production migration first, then release (the new Worker sends
`requested_scope_profile` and expects the new wrapper).

## Common formats in clued_storage_read (StorageNormalUse.v0.1 N1b)

Worker and kernel, plus the budget migration
`20260930200000_storage_read_budget_n4.sql`; no secret or switch. Applies only with a
`normal` credential and `normal/1` read access; otherwise reads behave as in
N1a (text bodies only, `format_unsupported` for other formats).

- **Office text.** docx / xlsx / pptx (by Drive mimeType, or by extension when
  the type is generic such as `application/octet-stream`) and Google Sheets
  (exported as xlsx, 10 MB export cap) are returned as extracted text
  (`extracted_as: "text/plain"`): xlsx / Sheets as CSV per sheet under
  `# Sheet: <name>`, pptx per slide under `# Slide <n>`. Byte ranges address
  that extracted text with the same 256 KiB and UTF-8 rules as text files; each
  call re-downloads and re-extracts up to `offset + length` (at most 8 MiB of
  text; an offset past 8 MiB is an empty chunk with `eof: true` when the whole
  text is shorter, `archive_limit_exceeded` otherwise). Chunks are separate
  reads: callers compare `head_revision_id` (`modified_time` for Google Docs,
  Sheets and Slides) across calls. `text_length` appears only once the
  extraction finished. Files up to 10 MiB are downloaded whole; larger files use
  range mode (tail, central directory, needed parts; 256 KiB read-ahead blocks,
  each one request of the call's 50-request budget: `request_limit_exceeded`
  with a hint to read a smaller `offset + length`; at most 32 MiB provider
  bytes per call: `binary_too_large`). Worker memory (128 MB isolate): range
  mode caches at most four 256 KiB read-ahead blocks (a larger read is never
  cached) and drops them once the central directory is parsed; xlsx sheets are
  streamed row by row and parsing stops as soon as the text budget is spent
  (at most 65 536 out-of-order cells are buffered, `archive_limit_exceeded`
  beyond; a cell for a row already emitted is `document_invalid`). Sheet names
  in `# Sheet:` headers have CR/LF replaced by spaces; relationship targets are
  percent-decoded. Zip and XML limits are those of
  `kernel/host/resource-center-zip-reader.mjs` and `-xml-sax.mjs` (§4.3); any
  DOCTYPE, a damaged archive or an encrypted Office file is `document_invalid`.
  Google Slides are exported as `text/plain` like Docs.
- **Images.** png / jpeg / gif / webp up to 5 MiB and 8000 px on the long edge
  are returned as an MCP `image` content item after the metadata text item;
  `structuredContent` carries only `image: {mime_type, width, height, bytes}`,
  never the base64. The magic bytes decide the type (`declared_mime_type` when
  Drive disagrees). Larger images (by size, Drive `imageMediaMetadata`, or the
  decoded header) return `reason: "image_too_large"` with metadata and no bytes.
- **PDF text** (`apps/clued-cloud/worker/storage-read-pdf.ts`, contract §4.5
  PDF paragraph). PDFs up to 20 MiB are downloaded whole in one request into a
  buffer of exactly the Drive `size` and sent to the separate PDF extractor
  Worker, which runs pdf.js (`pdfjs-dist`, pinned exact, legacy build,
  in-thread worker, no canvas, no font loading, no network). `page_start` (default 1) and `page_count` (1–20, default 20) pick
  pages; each page is `# Page N` plus its text, and `offset` / `length` address
  that text like Office text. Responses carry `page_count`, `pages`,
  `next_page_start`, `text_layer` (`none` = scan, no OCR) and, when a page's
  text is glyph codes (font without a Unicode map) or a needed CJK CMap is not
  bundled, `text_unreliable` (that page's text is omitted). Password-protected
  or damaged files are `document_invalid`; larger files return
  `reason: "pdf_too_large"` with no body request. A PDF above 256 KiB reserves
  `min(size, 5 MiB)` before the download. pdf.js and the CMaps live only in the
  extractor Worker (about 1.2 MiB gzip) and load on its first PDF read.
  Every call downloads the whole file again (page ranges and offset
  continuations included): up to 20 MiB of provider bytes per call that the
  content budget does not count (it counts delivered text only; the
  provider-byte dimension is N4).
  Hostile files: pdf.js has no decoded-size limit, so the build patches the
  pinned worker (`apps/clued-cloud/build/pdfjs-decode-guard.mjs`, applied by
  `scripts/build-pdf-extractor.mjs` and by the esbuild test bundles) to call a per-extraction
  guard: at most 16 MiB of decoded-buffer allocations per stream (a decoded
  stream stays under 8 MiB) and 48 MiB per call, 4 000 000 content-stream
  tokens, 200 000 new cached names, strings / names / arrays up to 256 Ki
  elements, and no synchronous BrotliDecode decoding (a native
  `DecompressionStream` brotli path is counted like Flate); past any of them the read fails with
  `archive_limit_exceeded`. Page text is streamed and cancelled once the call's
  text limit or deadline is passed. The extraction deadline is what remains of
  the call's 25 s Drive signal minus 5 s for the scope recheck (at most 10 s;
  under 1 s left is `storage_read_unavailable`). A time cut ends the selection
  at a whole page; a continuation whose offset lies past that cut is
  `storage_read_unavailable` with `next_page_start` and a hint to restart from
  there. Allocation / stack failures inside pdf.js are
  `storage_read_unavailable`, not `document_invalid`. Embedded font programs
  (FontFile / FontFile2 / FontFile3) are never read or converted: text comes
  from Encoding / Differences / ToUnicode, and a call past 200 000 text items is
  `archive_limit_exceeded`. Cross-reference entries (xref tables and streams,
  reconstruction) are capped at 400 000 per call, an xref stream with zero entry
  width or a range longer than its data and an object stream whose `/N` exceeds
  a quarter of its decoded bytes are refused, a ToUnicode map above code 0x10000
  is built sparse, and a CMap may declare at most 1 024 codespace ranges with
  characters x ranges scanned capped at 32 Mi per call. The extractor refuses to
  parse PDFs if the patched worker's `CLUED_PDF_DECODE_GUARD` or
  `CLUED_PDF_FONT_PROGRAMS` marker is missing, and its marker then reports
  `decode_guard: false`, which the main Worker refuses.
  `tests/resource-center-storage-read-pdf-bounds.test.mjs` runs deflate bombs
  in a child with `--max-old-space-size=64`.
- **PDF extractor Worker** (Owner decision `7210e5a5`, contract §4.5
  "隔离"). pdf.js never runs in the main Worker `clued-cloud`: a PDF read sends
  the file and four options (`page_start`, `page_count`, `max_text_bytes`,
  `time_ms`) through the service binding `PDF_EXTRACTOR` (RPC,
  `worker/storage-read-pdf-client.ts`) to the Worker `clued-storage-pdf`
  (`wrangler.pdf-extractor.jsonc`; entry `worker/storage-pdf-extractor.ts`,
  built by `scripts/build-pdf-extractor.mjs` into `dist/pdf-extractor/index.js`).
  The extractor has no bindings, vars or secrets, no workers.dev route or
  preview URL, only the `nodejs_als` compatibility flag, and
  `limits.cpu_ms: 10000` (enforced only on Workers Paid / Standard usage; on
  Workers Free a Worker gets 10 ms of CPU per invocation and the extractor is
  unusable). Before any body request the main Worker calls `marker()`: a
  missing binding, a failed or slow (5 s) marker call, another contract, a
  version other than `PDF_EXTRACTOR_VERSION` or the one before it
  (`clued.storage-pdf-extractor/1`, version 1, so today only 1), or a pdf.js
  without the patch markers is `storage_read_unavailable` with a fixed hint,
  and the read never falls back to parsing in the main Worker. If the
  `extract` call itself fails with an error that names a resource limit
  (memory, CPU) or does not return within `time_ms` + 2 s, that read fails
  once as `archive_limit_exceeded` with the "will stop the same way" hint; any
  other failed call (dropped connection, redeploy, unknown) is
  `storage_read_unavailable` with the normal retry hint. Neither is retried.
  Results are rebuilt field by field and refused above 16 Mi UTF-16 units of
  text. One user extraction runs per extractor isolate at a time; a second
  waits up to 2 s (at most half its `time_ms`, taken off that time) and is
  then refused as busy (`storage_read_unavailable`, "retry in a few seconds").
  The public check route never takes that slot: the extractor's `check()`
  parses its own fixed check PDF under a separate slot of one (a concurrent
  check is answered busy at once), and the main Worker serves the last OK
  check result per isolate for 60 s (a failure for 5 s) with one check in
  flight; no query parameter bypasses the cache. The check response reports
  the extractor's own marker (`extractor.contract` / `.version` from
  `check()`) and `checked_at` of the round trip it reports.
  **Rollback:** when `PDF_EXTRACTOR_VERSION` changed in the release being
  rolled back, roll back the extractor (`clued-storage-pdf`) and the main
  Worker together, to the same commit. The main Worker accepts only its own
  version and the one before it, so a version bump must keep the previous
  main Worker able to read the new extractor's results (otherwise rename the
  contract), and an extractor two versions apart fails every PDF read closed.
  Deploy order: the production release workflow deploys the extractor
  (`npx wrangler deploy --config wrangler.pdf-extractor.jsonc`) with the same
  `CLUED_CLOUDFLARE_DEPLOY_TOKEN_V2` before the main Worker, and after both are
  live `scripts/verify-pdf-extractor.mjs` requires
  `GET /v1/storage/pdf-extractor/check` (the extractor's fixed built-in
  one-page PDF through the binding) to return 200 with the expected text and
  exactly the repository's extractor version, retrying 8 times 10 s apart to
  outlast the route's 60 s cache (evidence `release-evidence/pdf-extractor.json`). The
  token's existing Workers Scripts Edit covers creating and updating the new
  script, its subdomain settings, CPU limit and the service binding; no new
  permission is expected. When the request, result or guard semantics change,
  bump `PDF_EXTRACTOR_VERSION` in `worker/storage-read-pdf-common.ts` (both
  Workers ship from the same commit). Local `vite dev` has no extractor
  binding, so PDF reads fail closed there.
  Upgrading `pdfjs-dist`: bump the exact version, run
  `node scripts/generate-pdf-cmaps.mjs`, re-check the patch anchors in
  `build/pdfjs-decode-guard.mjs` (the build fails when one does not match), and
  rerun `tests/resource-center-storage-read-pdf.test.mjs`,
  `tests/resource-center-storage-read-pdf-bounds.test.mjs` (the first fails
  when the CMap module does not match the installed version) and
  `tests/resource-center-storage-pdf-extractor.test.mjs` (both Workers under
  workerd with a real service binding).
- **Metadata only.** Zip and other archives, video (with
  `media_metadata` or `processing: true`), audio, HEIC/TIFF/BMP, legacy
  .doc/.xls/.ppt, ODF, other Google types and other binaries return
  `delivered_as: "none"`, `reason: "format_unsupported"` and a fixed `hint`;
  no body request is made. Folders remain an error.
- **Budget** (migration `20260930200000_storage_read_budget_n4.sql`, §7.2).
  256 MiB of delivered content per Binding per rolling hour, text and images
  together. Admission reserves 256 KiB on the read receipt; after metadata
  classification and before any body or media request, an image read calls
  `clued_storage_read_v1` action `reserve` on the SAME receipt with its file
  size (at most 5 MiB). `reserve` takes the admission's per-Binding advisory
  lock, counts every other receipt of the window (finalized: `byte_count`;
  unfinalized: `reserved_bytes`, default 256 KiB) and either raises
  `storage_read_receipts_v1.reserved_bytes` or returns
  `storage_read_budget_exhausted` (the Worker then makes no body request and
  finalizes 0 bytes). Reservations only grow, only on a read_content intent of
  the caller's own Binding younger than 10 minutes; finalize settles to the
  delivered bytes, releasing the unused part. Text and Office reads (at most
  256 KiB per call) and legacy / text/1 reads never call `reserve`. The
  account total and Owner-adjustable values are N4 (see "Hourly budgets"
  below); the provider-byte dimension is still open.
- **Rollout order.** Apply `20260930180000_storage_binary_upload_n3.sql` (N3)
  and `20260930200000_storage_read_budget_n4.sql` to production BEFORE the
  next Worker release that contains N1b: the N1b Worker calls `reserve` for
  images above 256 KiB, which an older database rejects as
  `storage_read_input_invalid` (the image read then fails closed with
  `storage_read_unavailable`, no bytes delivered).
- **Deferred.** PDFs above 20 MiB (range loading), raw download links
  (`resource_link`), Drive thumbnail builder and Cloudflare Images
  downscaling (thumbnail host pattern must be measured first; Images needs the
  monthly counter column), zip listing / entries, ODF, `resource_link` raw
  download. (The owner-level read budget landed in N4.)

## Binary upload (StorageNormalUse.v0.1 N3)

Migration `20260930180000_storage_binary_upload_n3.sql`, the Worker staging
module (`apps/clued-cloud/worker/storage-staging.ts`) and the kernel changes
let an Agent create a binary file (at most 20 MiB) through an encrypted
staging object. Everything is off until `CLUED_STORAGE_BINARY_V1=true`, and it
runs only in account-policy mode (`CLUED_STORAGE_JOBS_V2=true`).

- **Gate** (§6.1): every binary step — `clued_storage_upload_begin`, the PUT,
  `clued_storage_submit` and execution admission (until the provider attempt
  is recorded) — needs `create_file` in the active write policy, active read
  access with `content_profile = normal/1` including `read_content`, and
  `provider_scope_profile = normal`. Otherwise `storage_binary_upload_disabled`
  and no effect. Text `create` is unchanged.
- **Types** (§6.3): the destination extension must map to exactly the declared
  MIME (png, jpg/jpeg, gif, webp, pdf, zip, docx, xlsx, pptx, odt, ods, odp;
  the same table is in the kernel module and
  `clued_private.storage_binary_mime_v1`). Legacy Office (doc, xls, ppt: CFB
  containers, whose macro storages cannot be checked without walking arbitrary
  sectors), macro-enabled, executable, script, HTML/XHTML/SVG and Google-native
  types are never accepted in binary form (HTML/SVG only as text `content`,
  stored `text/plain`). The first chunk is refused on `MZ`, ELF, Mach-O / fat
  or `#!`, and must carry the MIME's magic (CFB magic matches no accepted type).
  After staging (`validating`) the archive is read **by range** (tail, a central
  directory of at most 2 MiB, and only the XML parts below, each at most
  1 MiB): entries named `vbaProject.bin` and ODF `Basic/` / `Scripts/` folders
  are refused; `[Content_Types].xml` (required for docx / xlsx / pptx) and
  every `*.rels` part are decoded strictly — UTF-8 only (a UTF-8 BOM is fine;
  a UTF-16 / UTF-32 BOM, any NUL byte, invalid UTF-8 or a declaration naming
  another encoding is refused), no DOCTYPE / ENTITY / CDATA, no character
  references (`&#…;`), only the five predefined entities (resolved) — and any
  content type or relationship type naming `vbaProject` (incl. the signature),
  `vbaData`, `activeX`, a (intl) macro sheet, `keyMapCustomizations` or a
  `macroEnabled` type refuses the file whatever the part is called (relationship
  `Target` values are data and not matched). At most **1024** `*.rels` parts
  are read (`RELS_PARTS_MAX`); a package with more is refused. A damaged or
  encrypted archive is refused too. Every refusal is `content_type_mismatch`.
- **Signed PUT URL** (MAJOR-2): `upload_begin` inserts a
  `clued_private.storage_staging_v1` row (`issued`, 10 minutes) and reserves the
  declared size against the hourly upload budget (by default 256 MiB per Binding, 1 GiB
  per owner, Owner-adjustable since N4; at most 60 staging rows per Binding and 200 per owner per rolling
  hour, released rows included) in the same transaction. It returns
  `upload_url = https://<host>/storage/staging/<staging_id>` and a separate
  `upload_token` that the client sends as the `X-Clued-Upload-Token` header:
  `curl -T <file> -H "Content-Type: <mime>" -H "X-Clued-Upload-Token: <upload_token>" "<upload_url>"`.
  The token never appears in a URL, so request-URL logging (Workers invocation
  logs) cannot record it; any query string on the PUT is refused, and the Worker
  never logs request headers. The token is HMAC-SHA256 under
  `CLUED_STORAGE_STAGING_URL_KEY` over owner, connection, Binding, staging_id,
  sha256, size, MIME and expiry, in canonical unpadded base64url only. The
  endpoint accepts that signature only (a request carrying `Authorization` is
  refused), checks that `Content-Length` and `Content-Type` equal the declared
  values *before* using the URL, then claims it once (`issued → receiving` CAS;
  a second PUT gets `upload_url_used`) and re-evaluates the row's Binding and
  the gate. (Contract §5.3 / §6.2 still describe `?t=<token>` and the doc / xls
  / ppt types; this implementation deliberately narrows both, pending a
  contract amendment.)
  *Header logging*: `wrangler.production.jsonc` enables Workers Logs with
  `invocation_logs: true` (head sampling 1, persisted), and invocation logs
  do record request metadata **including request headers**. Cloudflare redacts
  a header value to `REDACTED` when its (case-insensitive) name is `cookie` /
  `set-cookie` or contains `auth`, `key`, `secret`, `token` or `jwt`;
  `X-Clued-Upload-Token` contains `token` (a unit test pins the name), so its
  value is redacted, and `Authorization` is refused on this route anyway. The
  URL's staging_id (32 hex digits) is itself redacted by the URL heuristic.
  Request bodies (the file, or inline `content_base64`) are never in invocation
  logs. The staging module never calls `console.*` (also pinned by a test),
  every `console.*` elsewhere in the Worker logs fixed event objects, never a
  request or its headers, and no Tail Worker / Logpush is configured. Never
  rename the header to a name without one of those substrings, and never add a
  Tail Worker that calls `getUnredacted()`. Before enabling, still confirm once
  in the Workers Logs UI that a test PUT shows the header as `REDACTED`.
- **Staging encryption** (m-l): 64 KiB AES-256-GCM chunks under
  `K = HKDF-SHA256(master, salt = staging_id ‖ ":" ‖ key_salt, info = "clued.storage-staging/1")`,
  where `key_salt` is 128 random bits drawn by the database for each staging
  row (immutable; handed to the Worker by `receive` and in the execution
  descriptor), so no two rows ever share a key even if a `staging_id` recurred,
  nonce = 96-bit big-endian chunk index, AAD = owner ‖ connection ‖ staging_id
  ‖ chunk index ‖ final flag. The master keyring `CLUED_STORAGE_STAGING_KEYS`
  is separate from the credential vault; the row records `key_id`. The R2 key
  is `staging/<staging_id>` (no file name). The digest is computed while
  streaming; a mismatch deletes the object and rejects the row.
- **Bounded memory** (Workers isolates are 128 MB and serve concurrent
  requests): no path holds a staged object whole. The PUT encrypts 64 KiB at a
  time into the R2 write stream; every read is a ranged R2 get of at most 4
  chunks (≈ 256 KiB), decrypted chunk by chunk with an incremental sha256. The
  `validating` stage runs a full streaming decrypt + sha256 pass over what R2
  holds, then the archive checks by range. Peak per request is a few MiB (the
  central directory cap plus one XML part), independent of file size.
  *Subrequests*: range reads during validation are window-aligned (4 chunks)
  and served through a 4-window LRU, and the `.rels` parts are read in
  local-header order, so each 256 KiB window of the archive is fetched about
  once: validation costs roughly one R2 get per 256 KiB of archive (≈ 80 for
  20 MiB) plus the tail and central directory, whatever the number of parts,
  and the verify pass another ≈ 80. That stays far below the Workers Paid
  subrequest limit; a test pins a 400-`.rels` package at window count + 1
  gets.
- **Inline**: `clued_storage_submit` with `content_base64` (inside the existing
  1 MiB MCP body, about 700 KiB of file) runs the same begin / encrypted
  staging / validation in the request and submits the resulting `staging_id`.
  The database derives the inline `staging_id` from (Binding token, connection,
  `job_id`), so a retried submit of the same job reuses its row: `ready` /
  `consumed` rows are not staged again (the submit then replays the job), no
  second reservation is taken, and other content under the same `job_id` is
  refused (`storage_job_input_invalid`). A retry that finds the row `rejected`
  / `expired` gets `staging_expired` and needs a new `job_id`. Once the row has
  been purged (7-day retention, below), an inline begin whose `job_id` already
  names a storage job of this owner is refused (`storage_job_input_invalid`):
  the same derived `staging_id` is never staged a second time.
- **Submit** stores `{create, file, destination_path, content_ref: {staging_id,
  sha256, size, mime_type}}`; the request digest covers `content_ref`. The
  staging row must be `ready`, unexpired and of the same Binding, connection,
  path, MIME and sha256; it becomes `consumed` by that job (single use). The
  submit event of a binary job records `upload_bytes` (text jobs carry no such
  key).
- **Execution** (§6.4): before any reservation the executor runs one full
  streaming pass over the staged object (ranged reads, per-chunk AEAD, running
  sha256) and requires size and sha256 to equal `content_ref`
  (`STORAGE_CONTENT_STAGING_MISMATCH`, no effect, no provider byte). The upload
  then streams the decrypted chunks again straight into the request body
  (`FixedLengthStream`, so Drive sees an exact `Content-Length`) while hashing;
  the final window is withheld unless the running digest matches again, so
  bytes that changed after the first pass never complete an upload body (the
  request fails as an unknown outcome and Drive finalises nothing).
  Independently, verification requires Drive's `sha256Checksum` to equal the
  declared sha256. Up to 5 MiB it uploads one multipart request with the
  declared MIME; above that it opens one resumable session and sends the whole
  body in a single PUT (no 308 chunk loop, so the redirect guard stays on). The
  session URI stays in memory. A lost reply is an unknown outcome: the journal
  stays fenced and recovery only reads (by the generated ID); nothing
  re-uploads.
- **Verification**: `clued.storage-create-verified/3` — size and sha256 from
  `content_ref`, `mimeType` equal to the declared MIME, and Drive's
  `sha256Checksum` equal to the declared sha256 (absent keeps polling, then
  times out; different is a mismatch). Text creates keep `/2`; the database
  refuses a `/2` proof for a binary job. Every live size / sha256 derivation
  from `mutation.content` (`storage_job_provider_attempt_v2`,
  `storage_verified_result_v2`) takes `content_ref` for a binary job (a test
  checks the function definitions).
- **Lifecycle** (cron, `runStorageStagingScheduled`): the sweep first cancels
  binary jobs not started within 12 hours (`denied`; job and root advisory
  locks, then the job row — the same order as submit / receive); only then
  does it touch staging rows, and those updates use `FOR UPDATE SKIP LOCKED`,
  so a row a concurrent receive / consume holds is left for the next minute
  and no lock cycle can form. An `issued` row unused for 10 minutes expires and
  releases its reservation (no byte arrived); a `ready` row not submitted
  within 1 hour expires (reservation kept); a `receiving` / `validating` row
  is rejected as stalled only after **2 hours** (well past the 10-minute URL
  TTL plus a slow 20 MiB upload). A Worker whose `received` / `validated`
  transition is refused (e.g. the row was swept meanwhile) deletes the object
  it wrote. The Worker deletes R2 objects the database lists as deletable
  (rejected / expired rows that received bytes, and consumed rows whose job
  started or was settled out) and records `object_deleted_at`.
- **Retention** (m1): the sweep deletes up to 200 staging rows per run that are
  terminal (`rejected` / `expired`, or `consumed` with its job started or
  settled out), have no R2 object left (`object_deleted_at` set, or no byte
  ever arrived) and are older than **7 days**. The immutability trigger allows
  exactly that delete and refuses every other. Staging rows reference
  `auth.users` and `clued_agent_bindings` without cascade; because every row
  becomes terminal within about 15 hours (10 min URL + 2 h stall + 1 h ready +
  12 h job start) and is purged 7 days later, an account or Binding erasure is
  delayed by at most that window, never blocked forever. Shortening it needs a
  reviewed migration; an erasure must never delete rows whose object may still
  exist.

Rollout (in order; nothing here is enabled by the migration alone):

1. Create the R2 bucket `clued-storage-staging` (private, no public access, no
   custom domain) with an object lifecycle rule that deletes objects older than
   **3 days** (backstop only; the cron deletes by database state).
   The binding was added separately, after the bucket existed (a deploy that
   binds a missing bucket fails as a whole); it is now in
   `wrangler.production.jsonc`. Before that, `wrangler.production.jsonc` had no
   `r2_buckets` entry. Without the binding the code fails closed
   (`storage_upload_unavailable`; binary jobs refused before any effect). A
   follow-up PR adds
   `"r2_buckets": [{ "binding": "CLUED_STORAGE_STAGING", "bucket_name": "clued-storage-staging" }]`
   only after the bucket exists. Binding preflight for that PR: confirm the
   bucket is listed (`wrangler r2 bucket list`) in the production account,
   has no public access / custom domain, and carries the 3-day lifecycle rule;
   then deploy and check that `clued_storage_upload_begin` no longer returns
   `storage_upload_unavailable` with the flag on for a test connection.
2. Set two new Worker secrets:
   - `CLUED_STORAGE_STAGING_URL_KEY`: base64url of 32 random bytes (URL HMAC key).
   - `CLUED_STORAGE_STAGING_KEYS`: `{"current_key_id":"<id>","keys":{"<id>":"<base64url 32 bytes>"}}`
     (at most 4 keys). Rotate by adding a key and switching `current_key_id`.
     Keep the old key for **at least 16 hours** after the switch (a row can
     still need it for 10 min URL + 2 h stall + 1 h ready + 12 h until its job
     starts), and remove it only when no row that names it still has an
     object, i.e. `select count(*) from clued_private.storage_staging_v1 where
     key_id = '<old id>' and object_deleted_at is null and bytes_received`
     returns 0. Recovery never reads the object, so it does not extend this.
   Missing bucket or either secret fails closed (`storage_upload_unavailable`,
   and binary jobs are refused before any effect).
3. Apply the production migration, then release the Worker.
4. Set `CLUED_STORAGE_BINARY_V1=true` (with `CLUED_STORAGE_JOBS_V2=true`) only
   after the binding PR from step 1 is deployed. The Owner still needs
   create_file plus normal use (N1) on the connection.

Rollback: unset `CLUED_STORAGE_BINARY_V1` (tools disappear, the PUT endpoint
returns 404, binary submits are refused). With the flag off the executor has
no staged-content loader, so a queued binary job is refused before any effect
(reported `attention_required`), and the staging sweep does not run: leftover
objects are removed by the bucket's 3-day lifecycle rule.

## Hourly budgets (StorageNormalUse.v0.1 N4)

Migration `20261001020000_storage_budgets_n4.sql`, the Worker route
`/v1/storage/budget` and the storage page control. No new secret or switch:
the route sits behind `CLUED_STORAGE_ACCOUNT_V1` like the other native Owner
controls, and the database enforces the configured values for every read and
upload admission as soon as the migration is applied.

- **Table** `clued_private.storage_budgets_v1` (§7.3): one active row per
  `(owner_id, connection_id)`. A row with a connection holds the per-Binding
  budgets used on that connection (`read_bytes_per_hour`,
  `upload_bytes_per_hour`, each 32 MiB – 2 GiB); the row with
  `connection_id IS NULL` holds the owner's account totals over all Bindings
  (each 32 MiB – 8 GiB). Values are whole MiB; the bounds are table checks as
  well as RPC checks. Rows are immutable: a change revokes the active row and
  inserts the next `budget_generation`, both under one Receipt. No row means
  the §7.1 default: per Binding 256 MiB read / 256 MiB upload, account 1 GiB
  read / 1 GiB upload.
- **RPC** `public.clued_storage_budget_v1` (native Owner session only, granted
  to `authenticated`; Binding tokens and the service role cannot call it):
  `status {connection_id}` returns the effective values, the CAS generations
  (0 = defaults), the defaults and the bounds. `set {scope: "connection",
  connection_id | scope: "account", base_generation, read_bytes_per_hour,
  upload_bytes_per_hour, idempotency_key}` is CAS on `budget_generation`;
  out-of-bounds values are `storage_budget_out_of_bounds` (no receipt), a
  stale base is `storage_owner_version_conflict`. Each change writes Receipt
  operation `storage_budget_v1` (versions keyed `storage_budget:<connection>`
  or `storage_budget:account`) and Event `extension:storage:budget_v1`
  (scope `project:<profile project>` for a connection, `profile` for the
  account). It never touches a connection, write policy, read access,
  `auth_generation`, client grant, deny, staging row or storage job.
- **Reads**: admission and `reserve` of `clued_storage_read_v1` now take an
  owner advisory lock (`storage-read-budget-owner:<owner>`) before the existing
  per-Binding lock and check two sums: the Binding's read_content receipts in
  the rolling hour against the per-Binding read budget of the connection being
  read, and all read_content receipts of the owner against the account read
  total (new in N4: §7.2 assigned the account total to N2, which had not built
  it). A Binding that reads several connections is still metered as one
  Binding; the limit applied is the one of the connection in the call.
- **Uploads**: `upload_begin` reserves through `storage_upload_budget_v2`
  (per-Binding upload budget of the connection, account upload total); the
  row caps (60 per Binding, 200 per owner per rolling hour) are unchanged.
  `storage_upload_budget_v1` lost its only caller and is dropped.
- **Immediate effect**: every admission reads the committed row, so a change
  applies to the next read or upload. Lowering a budget below what the window
  already used or reserved refuses new admissions until the rolling hour frees
  up; receipts, reservations and issued upload URLs are never rewritten.
- **Page**: under 正常使用, "读取额度设置" loads the status; each scope (每个已授权
  Agent on this connection, 账号合计) has read and upload selectors with the
  64 MiB / 256 MiB / 1 GiB presets and 自定义 (whole MiB within the scope's
  bounds, checked on the page and again by the database), saved after a
  confirmation and read back.
- **Not included**: the provider-download-bytes dimension (§7.1 row 2, 2× the
  read budget) — the Worker does not meter provider bytes per receipt yet, so
  it is neither enforced nor shown; `image_transforms_per_month` (§7.3) — the
  Cloudflare Images path is deferred, so the column is not added and `set`
  refuses the key; the "about N minutes" recovery hint in `budget_exhausted`
  (§7.2). The normal-use disclosure still says "默认每小时额度" (it names the
  defaults, which are unchanged), so its version is unchanged.

Rollout: apply the production migration byte for byte, then release the
Worker (the page and route need it). An older Worker keeps working against the
new database (the RPC signatures it calls are unchanged). Rollback of the page
alone: release the previous Worker; budgets already set stay enforced. To
return an owner to defaults, set the default values (a new generation).

## Self-service onboarding (StorageNormalUse.v0.1 N0)

The page `/storage/onboard` creates a new Google Drive connection from zero:
a new folder in My Drive (default `Clued_资料中心`) or an existing folder chosen
with Google Picker, 1–32 tracks (default `资料` / `项目` / `归档`), and the
pre-ticked "正常使用" and "后台自动续期授权" options. The click on
"确认并连接 Google Drive" confirms `clued.storage-onboard-disclosure/1`
(`worker/storage-onboard-disclosure.ts`); the Worker renders the same text and
binds its SHA-256 to the attempt and to the Owner Decision.

Migration `20261001040000_storage_onboard_n0.sql`:

- `clued_private.storage_onboard_attempts_v1` (30 minutes; holds the staged
  credential envelope until activation or expiry, the Drive effects and the
  orphans). `begin` creates no canonical row.
- `storage_oauth_attempts_v1.connection_id` is nullable; `purpose='onboard'`
  attempts have no connection. The outermost `public.clued_storage_oauth_v1`
  sends their claim / complete to `clued_private.storage_onboard_oauth_v1`
  (one-shot claim, counted in the refresh-token ledger).
- `public.clued_storage_onboard_v1(issuer secret, input)`: `begin`,
  `stage_credential`, `resume`, `effect_intent`, `effect_result`,
  `effect_stray`, `activate`, `fail`, `status`, `list`. `activate` creates in one transaction: Project →
  Decision (`user_explicit`, `user_confirmed`) → profile
  (`/clued-cloud/google-drive/<root_folder_id>`, `clued.storage-onboard/1`) and
  root artifact → track artifacts → `cloud_runtime` → connection → policy
  (`native_connection`) → read access (`normal/1` only if requested and granted,
  otherwise `{read}` `text/1`) → default refresh delegation (145426 shape).
  Any failure rolls every step back; the Worker then records `fail`, listing
  the created folders as orphans. Clued never deletes or trashes them; the page
  shows them as "已在 Drive 中创建但未启用".
- Expiry: `public.clued_storage_onboard_sweep_v1(issuer hash)`, called by the
  Worker cron every minute whenever `CLUED_STORAGE_ACCOUNT_V1` and
  `CLUED_STORAGE_GOOGLE_V1` are on (also with the onboard page switched off),
  expires attempts past their 30 minutes in its own transaction: the staged
  envelope is dropped, created folders stay orphans. A failure the Worker
  marks not retryable (for example `root_not_owned`) drops the envelope at
  once. Log event `storage_onboard_sweep_unavailable` (only while
  `CLUED_STORAGE_ONBOARD_V1=true`) means the sweep could not run.
- One run per attempt: `stage_credential` and `resume` issue a run token with
  a 5-minute lease; `resume` is refused (`onboard_run_active`) while the
  callback or another resume holds it. A folder a run created but could not
  record (`effect_stray`) is listed as an orphan, also on a completed attempt.
- `clued_resource_center_admin_v1(profile_register)` refuses the
  `/clued-cloud/` prefix.
- Gate (§2.5, Q9): only owners in `clued_private.storage_onboard_allowlist_v1`
  may begin, until the operator sets `storage_oauth_apps_v1.onboard_open=true`
  after Google verification (and CASA) passed. Nothing is seeded.
- Gate v2 (`20261001120000_storage_onboard_gate_v2.sql`, Owner Decision
  ba02734a): `begin` and `activate` require `storage_oauth_apps_v1.read_enabled`
  only. The executor switch `execution_enabled` gates storage write jobs and no
  longer gates onboarding.
- Lock order: `claim` takes onboard row -> OAuth attempt row -> per-owner lock;
  `activate` takes onboard row -> per-owner lock -> owner||root lock -> OAuth
  attempt row (inside the activation). Both start with the onboard row.

Owner configuration (names only; values never go in Git):

1. Google Cloud console, the project that owns the storage OAuth client:
   - Enable the **Google Picker API** (the Drive API is already enabled).
   - Create a **browser API key** restricted to the Google Picker API and to
     HTTP referrer `https://clued.pixelgrav.com/*`.
   - Note the **project number** (Picker App ID; without it the picked folder
     is not authorized for this app).
   - OAuth client (Web application): add `https://clued.pixelgrav.com` to
     **Authorized JavaScript origins** (Google Identity Services token client).
     The redirect URI is unchanged.
   - OAuth consent screen: add every allowlisted tester as a **test user**
     while the app is in Testing.
2. Worker vars (not secrets): `CLUED_STORAGE_ONBOARD_V1=true`,
   `CLUED_STORAGE_GOOGLE_PICKER_API_KEY`, `CLUED_STORAGE_GOOGLE_CLOUD_PROJECT_NUMBER`.
   Existing: `CLUED_STORAGE_ACCOUNT_V1`, `CLUED_STORAGE_GOOGLE_V1`,
   `CLUED_STORAGE_GOOGLE_CLIENT_ID`, `CLUED_STORAGE_GOOGLE_REDIRECT_URI`,
   `CLUED_STORAGE_REFRESH_V1` (needed for the default refresh delegation) and
   the secrets `CLUED_STORAGE_GOOGLE_CLIENT_SECRET`,
   `CLUED_STORAGE_CONNECTOR_ISSUER`, `CLUED_STORAGE_VAULT_KEYS`.
3. Database (operator, reviewed): `storage_oauth_apps_v1.read_enabled` true
   for the issuer (gate v2; `execution_enabled` is not needed); one row per tester in
   `clued_private.storage_onboard_allowlist_v1`.

Without the Picker values the page offers only "新建目录" and the Worker
refuses a picked root (`picker_unconfigured`). Without
`CLUED_STORAGE_REFRESH_V1` the refresh option is unavailable and the page says
the connection stops after about an hour. With the flag off the routes return
404 and the page says onboarding is not open.
