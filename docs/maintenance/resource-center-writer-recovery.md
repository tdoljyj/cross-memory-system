# Resource Center writer recovery

Applies to the candidate `clued.resource-center-write/1` create-only writer.
This runbook does not qualify production Drive storage or general filesystem tools.
Do not mutate real Resource Center files to test recovery.

## Host bootstrap

Provision a fixed local recovery journal **before** enabling the writer. Confirm
its initial file and directory entry are durable, the volume honors flushes,
the Host owns its parent/file, and no Agent or other process can replace or write
them. Use one process writer per journal. The runtime store requires an existing
regular single-link file; it never creates one. These checks do not install ACLs.
Feed its `persist_recovery` callback to the writer client. No durable store means
no prepare/start. Tickets contain correlation only, never tokens or admission.

The runtime appends and flushes the ticket before the first service request.
Partial/corrupt records and duplicate keys fail closed. Preserve a damaged journal
for operator investigation; do not truncate it or infer that an unreadable key
never reached the service. Recover complete prior records only under a separately
reviewed repair, retaining original bytes.

## Lost responses and uncertain effects

1. Keep mutations closed. Never replay a `start` result or retry a filesystem
   effect merely because its response was lost.
2. Read the saved ticket and use Host-only `inspect_recovery`. It returns journal
   state only and grants no execution. If the writer is revoked/expired, this
   call is unavailable; a new writer cannot inspect the old writer's intents.
3. An authorized service operator resolves the exact profile/request key/hash and
   original writer ID and uses administrative `inspect`, with a CURRENT Owner
   decision. This path permits a revoked profile without reactivating it.
4. `prepared` may be cancelled by administrative CAS using a new CURRENT Owner
   decision even if the profile or original Decision is revoked. This cannot
   authorize execution; `cancel` rejects started/uncertain states.
   `started`/`uncertain` never expire into a
   free slot. A confirmed existing effect follows the exact provider verification
   and Canonical finalization path, not a second effect.

## Proven no-effect settlement

For a started/uncertain operation that actually did not execute:

1. Stop **all** executors holding that writer credential. Verify termination and
   drain/cancel queued provider calls. Token revocation alone cannot retract an
   already delivered execution permit. Retain exact supervisor/provider evidence.
2. Revoke the original writer through its receipt-backed admin contract.
3. After termination/drain, verify exact destination/provider identity and absence
   of the effect. If this cannot be established, retain the fence.
4. Obtain a new CURRENT Owner recovery Decision in the same project, recording
   the evidence and these exact `type_fields`:
   `resource_center_recovery_intent_id`, `resource_center_recovery_request_sha256`,
   `executor_terminated: true`,
   `provider_absence_verified_after_termination: true`, and `rationale`.
   These are operator/Owner attestations, not automatic OS isolation proof.
5. The service-role administrative journal may call `settle_no_effect`, passing
   that Decision as both `source_decision_id` and `recovery_decision_id`, the exact
   original writer/profile/intent/hash, current intent `base_version`, and a stable
   idempotency key. It emits a Receipt/Event and terminal `cancelled` outcome with
   `verified_no_effect`. The public writer endpoint rejects this action.

No recovery reactivates old credentials, profiles or Decisions. Do not rotate a
profile to evade a fence: prepare serializes by user/provider root and refuses
when any profile for that root has an unresolved intent, including revoked ones.

## Qualification boundary

Temporary local tests and injected Drive metadata are not real Drive acceptance.
Before enabling production writes, qualify the dedicated Google OAuth connection,
provider operation/postcondition, restricted Host tool inventory, durable journal,
and rollback/recovery on temporary objects. Until then, production stays read-only.

### Drive visibility prerequisite

`drive.file` can read app-created or individually authorized files, but a parent
folder grant does not prove visibility of files created by other applications.
Neither an empty list nor `incompleteSearch: false` proves their absence. Do not
use this scope alone to qualify path uniqueness, absence recovery, or a complete
parent/sibling watcher. Exact-ID diagnostic reads remain available.

The official metadata path requires a Host-owned `get_credential` callback
returning `{ access_token, scope }` together from the actual OAuth grant. The
Google Host factory forwards this as `get_drive_credential`. Requested scopes,
caller-declared scopes and static visibility flags are not grant evidence.
Token-only legacy bootstrap fails namespace lookup closed. Pagination uses one
credential snapshot; every subsequent lookup checks the current grant again.

The least broader metadata grant is `drive.metadata.readonly`. It reveals
account-wide file metadata and therefore requires separate explicit Owner
consent; this code change does not request it or expand the existing connection.
No metadata grant authorizes writing file content. Even with it, account/root
identity, permission visibility, concurrent name conflicts, provider semantics,
Host isolation and the durable journal still require qualification. In particular,
Drive's same-generated-ID `409` prevents duplicate object creation on retry,
not same-name creation with another ID. Do not enable the writer from that test.

References: [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
and [pre-generated IDs](https://developers.google.com/workspace/drive/api/guides/create-file).

### Create postcondition and credential bootstrap

`createGoogleDrivePilotCredential` refreshes only an already-consented exact
`drive.file` + `drive.metadata.readonly` grant through Google's fixed token
endpoint. The Host supplies an encrypted loader, never a tool payload. Refresh
is single-flight. Changed grants, invalid replies, failed storage and revocation
close the credential getter; provider error bodies are not logged. A rotated
refresh token requires a durable Host-owned persistence callback before use.
No callback installs an OS boundary or makes same-user DPAPI inaccessible to
other processes running as that user.

`createGoogleDriveCreatePostconditionVerifier` is a Host-only callback for the
durable writer. It verifies the exact created path under a pinned root, all
ancestor IDs/versions, unique name, provider ID/version, parent and type. It
polls only for a not-yet-visible created object, with a finite deadline. A
conflict, moved object, credential failure or changed version never permits
retrying the filesystem effect. Files require exact UTF-8 byte count and Drive
SHA-256 metadata; missing checksums fail closed instead of downloading content
or silently using a weaker digest. File creation uses one exclusive handle,
checks local object identity/link count and flushes the handle before returning.

These helpers still require actual provider acceptance and an isolated Host.
They do not offer an atomic cross-provider transaction or prevent an unrelated
raw-OS writer from racing the mount. A failed postcondition leaves the existing
durable fence intact for operator reconciliation. Do not enable real Resource
Center mutation from unit tests or a temporary provider probe alone.

### Native-ID candidate and disabled mounted writer

`createResourceCenterGoogleDriveWriterToolHost` is deliberately unavailable:
same path/name/hash cannot prove a local created object's Drive identity when
another client races synchronization. It throws before any provider call. Do
not relax the mounted provider's unknown link-count check to enable it.

`createResourceCenterGoogleDriveNativeWriterToolHost` is the create-only
candidate. After the durable Canonical start, it generates one Drive ID and
appends/fsyncs its exact intent/binding/ID to a separate, preprovisioned private
provider-attempt journal before the sole storage POST. The same Host clock is
checked after credential refresh immediately before that POST; expiration
leaves the durable fence intact. Authority is resolved again after prepare/start,
so intermediate ancestor changes cannot replace the originally admitted identity.
The postcondition requires the generated ID, not merely a matching name/hash.

On response loss, read the saved provider attempt and inspect that exact ID,
path, ancestry, type, size and SHA-256 under current authorization. No recovered
attempt grants execution or automatic retry. A missing result does not by itself
prove absence: retain the fence until the recovery contract above is satisfied.
This is not atomic same-name exclusion against unrelated Google clients and is
not whole-Host qualification. Actual isolated tool inventory, rollback and the
temporary real Host/Worker/Canonical receipt chain are still required.

### Account cloud settlement-only recovery (pending deployment acceptance)

`apps/clued-cloud/worker/storage-cloud-recovery.ts` is a private composition,
not a public authorization endpoint. It accepts only a connection/job reference;
its trusted RPC must authenticate the Owner and fixed issuer and pin the original
job, intent, request digest, provider attempt, credential generation and journal
CAS on both load and settlement. The component does not supply that DB contract.

It decrypts only the exact account/connection/provider/client/generation envelope
and performs GET-only Drive metadata verification of the original provider ID.
It never invokes the normal executor, obtains a new admission, refreshes OAuth,
generates an object ID, retries the effect or falls back to ordinary job loading.
Expired credentials require a separate human-authorized credential recovery.
An inspection failure or lost settlement response leaves the result unknown;
inspect the original durable job rather than repeat its provider effect.

One bounded deadline covers RPC loading, provider reads and the settlement reply.
A late load/read cannot initiate settlement. Once settlement has been sent, a
timeout cannot undo a transaction already delivered to the database: its original
job/intent and immutable receipt remain the source of truth. Return only the
verified receipt reference, never credentials or upstream diagnostic payloads.

The candidate `clued_storage_native_recovery_v1` RPC supplies the native-Owner
plus fixed-issuer DB boundary. It serializes the original job and provider root,
permits settlement for active or reauthorization-required connections, and rejects
revoked connections. Its CAS fingerprint binds the entire loaded descriptor,
encrypted credential, original provider attempt, connection version/state, job
digest, profile version, native session and issuer. It is not a bearer capability:
both calls independently recheck current authority, and settlement reuses the
original Artifact/journal/Event/Receipt transaction. The old automatic recovery
wrapper stays active-only. All private helpers have API execution revoked.

After an unknown settlement reply, native `recovery_inspect` reads only the
original job's durable status and receipt. It remains readable by the same live
Owner and issuer after connection revocation, exposes no credentials and cannot
dispatch or settle an effect. Do not rerun the writer or infer failure from a
missing reply. Do not treat a CAS fingerprint as permission to write.

The candidate native Web route `POST /v1/storage/recovery` accepts only
`action: inspect|settle`, `connection_id` and the original `job_id`. Both account
and Google management flags must be enabled; the new-job/executor flags are not
required for historical inspection or settlement. It preserves the live native
JWT, adds only the fixed server issuer, and never calls the normal executor.
`inspect` returns a validated status/receipt whitelist without requiring vault
keys. `settle` uses only the GET-only factory above. All results are no-store;
an unknown settlement is not automatically retried. The account page requires
reading the original status before explicit settlement confirmation, clears stale
controls when IDs change, and discards late results after account changes.

Neither this route nor the migration qualifies a provider root, restores grants
or delegations, or performs credential-only OAuth. An expired credential still
requires the separate human recovery contract; do not substitute ordinary OAuth
completion (which activates a connection). Integrated acceptance and reviewed
deployment remain required. Unit/transport tests alone are not production
recovery evidence.
