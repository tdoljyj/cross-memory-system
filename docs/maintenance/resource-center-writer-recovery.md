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
