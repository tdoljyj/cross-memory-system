# Resource Center restricted automatic renewal

Opt-in successor to the create-only daily Host. This is revocable standing
delegation: each reader/writer/renewer credential lasts at most 24 hours, but
same-scope generations may continue while the original and renewal Owner
Decisions remain CURRENT at their pinned versions. It is not permanent keys,
generic administration, new storage permissions, or whole-Host isolation.

## Contract

Service-role-only enrollment pins an existing profile/version and exact
reader/writer IDs. No profile, Artifact, OAuth scope or writer is created.
The dedicated `clued_rcr_` credential can rotate in the last two hours, inspect
its generation, or stop. It indirectly delegates the same create-only writer
authority and therefore stays in Host secret storage, never consumer input.
Stable Binding IDs retain their original source Decisions. An enrollment marker
and additive authority/write guard prevent revoked grants reverting to legacy.

Rotation locks provider root, profile, then grant, re-reads grants/clock, checks
the original and renewal Decisions/versions and the provider-root unresolved
intent fence. Dependent Decision rows are share-locked in ID order against
close/update/supersede. Currentness Core is evaluated at admission; subsequent
authority/write calls recheck it, including later active Event changes. There
is no cached authorization inside the token. A single transaction changes all
three credential hashes/expiry and appends immutable generation Event/Receipt.
Hash values are bearer-equivalent and are absent from responses and receipts.

The Host acquires its lifecycle lock before loading credentials. It also takes
the original executor lock and checks the original jobs ledger: any pending,
unreconciled, corrupt or cross-profile entry blocks rotation. It durably appends
and reopens a complete DPAPI-sealed pending generation before HTTP. Lost replies
reuse exactly that request, never mint another generation. The previous token
can recover only that latest exact rotation until the successor expires, subject
to live grant/Decision checks. An independent successor status check precedes
local activation. Revocation racing after that check still denies at every
server authority/write boundary.

The sealed append-only journal is identity-pinned, has monotonic sequences, and
never truncates incomplete rows. Pending rotation denies ordinary jobs. Five
bounded attempts use persisted backoff; expiry, crash locks or exhausted retries
require operator attention. No log/fence reset, provider retry or automatic
resurrection is a renewal operation. A machine offline beyond credential expiry
requires manual reauthorization; this intentionally does not hold a permanent
bootstrap secret. Normal checks and renewal invoke no model.

## Installation and rollback

Bundle the reviewed daily runner. `installDailyHost` with `existing_host` pins
the previously accepted config, preserves its exact profile, credential paths,
consumer runtime and all three state journal identities. Stage a fresh Host
directory; do not use fresh-install journals as an upgrade. Provision a separate
owner-private DPAPI journal containing generation zero and pin its file identity.

Only after independent review, CI and live service qualification: hold the old
executor/lifecycle boundary, check no unresolved work, disable the OLD activation
marker (retain it), enroll the exact pair and write/readback the sealed state,
then enable the successor activation and launchers. There must not be two active
launchers, one outside the lifecycle lock. Run a read-only boundary scan and a
no-op not-due renewal; validate a full rollover separately with temporary
credentials/objects. Keep old logs and credentials private for evidence/recovery.

The operator may register the pinned `Renew-CluedResourceCenter.ps1` with Windows
Task Scheduler under the same interactive user, least privilege, every 15 minutes
and at logon. No password, administrator rights, RDP changes or ACL changes are
required. Use hidden PowerShell, scrubbed environment and the fixed pinned
launcher, never a model wakeup or script supplied by a job. A local error raises
one user notification per unresolved incident; successful rotation clears only
that notification marker. Task failures/crash locks require operator attention.

`Stop-CluedResourceCenter.ps1` first fsyncs a monotonic local stop marker, then atomically
revokes the server grant and current pair, even after expiry/lost delivery.
Historical receipts cannot reactivate it. Stop must remain possible with an
executor fence; it does not clear that fence or settle effects. If the network
is down, local writes remain shut and server revocation is explicitly unconfirmed:
retry stop or use the authenticated administrative revocation contract. Stop reads
only the immutable first sealed record and does not take the lifecycle lock: even
a crash lock or interrupted later journal row cannot block attenuation. The old
renewal credential retained there can only stop/recover its exact historical
rotation, never mint another generation. The stop marker prevents all subsequent
local jobs and renewals without deleting or changing any existing lock.

Disable the scheduled task to stop future wakeups. Do not roll back to old
expired/revoked credentials or remove enrollment to restore access. A failed
upgrade remains closed; manual recovery uses the original journals and accepted
authorization. Existing files and wider Storage hardening are out of scope.
