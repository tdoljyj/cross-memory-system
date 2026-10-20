# Storage external registration v0.1

Status: implementation candidate; not a production qualification.

## Problem and scope

Verified Kooyumi create/modify jobs already maintain their Artifact registration.
Edits through Google Drive or a local Drive sync folder bypass that settlement.
The registry can consequently retain an old name/path/version or omit a new item.
Owner requested automatic maintenance and repair of the existing exploration folder
in Task `68ed5cab-1132-4588-9b3f-799cc7821e21` on 2026-10-20.

This successor adds program-owned metadata reconciliation inside an already
authorized managed root. It does not write Drive content, grant access, update
document text or promote document claims to Canonical truth. It does not update
the resource-center main entry, which the Owner separately deferred.

## Intended behavior

- Kooyumi jobs continue to settle registration in their existing transaction.
- Changes made directly in Drive are discovered by a background bounded scan.
  Users and Agents do not submit a registration per item. Until a scan commits,
  existing foreground operations retain their stale-registration rejection.
- Stable provider IDs identify existing objects. Rename/move changes paths of
  the same Artifact and its registered descendants atomically, keeping IDs,
  governance, source Decisions and history. Content edits refresh the observed
  provider version without overwriting file contents.
- An unregistered ordinary child of a currently registered ordinary folder is
  automatically adopted under the existing full Drive scope and modify grant.
  A registered file moved into new nested parents within the scanned folder
  brings that verified parent chain into the same parent-first transaction.
  Root/track creation and governance registration retain their existing paths.
- Shared/access-changed, missing, trashed, ambiguous, revoked, isolated or
  out-of-root objects do not get silently adopted or reauthorized. The program
  records a bounded diagnostic and permits unrelated work to continue.

## Observation and commit

The Native storage page exposes a per-connection default-Off switch. Turning it
on requires the existing current full-scope/modify/normal-use authority and
records its own consent Event/Receipt; it grants no additional Drive access.
Turning it off fences in-flight scans at commit. Reconnection or policy change
also invalidates an already issued observation plan.

The server builds a plan from current account, connection, policy, runtime,
root, registry and Decision versions. A browser/Agent cannot supply an owner,
path, privilege or an authenticated program identity. Program calls use the
existing authenticated issuer and database-gateway boundary.

Before observing, the existing demand-renewal service checks the typed
`external_registration` operation against current consent and the exact folder.
It can renew an expiring credential only under the existing renewal delegation;
an Off renewal switch never triggers a token exchange. The scan reloads its
plan and current credential version afterwards. OAuth renewal uses its existing
POST token exchange; registration observations themselves remain GET-only.

The observer has GET-only Drive access. For each bounded plan it independently
reads exact IDs, complete parent namespaces, ownership and permissions twice.
Paths are derived from observed parent IDs and names back to the pinned root.
Duplicates, shortcuts, unsupported names, partial pagination, cycles, changed
observations and missing permissions fail closed. An ancestor rename never
justifies trusting unobserved registered descendants.

The commit rechecks current authorization, revocations, work claims, unfinished
provider jobs and conflict isolation. It locks the affected rows in a fixed
order, compares the exact plan/CAS versions, and commits all affected paths and
versions in one transaction with a new Event/Receipt. A failed receipt rolls
back every change. Replays return only their original result and do not repeat
updates; obsolete observations never restore revoked state or overwrite newer
registry updates. An unchanged scan creates no registration mutation.
The conflict check holds the existing ordered work-claim locks through the
transaction, so a new or expanded claim cannot slip between check and update.
Lock contention is bounded to 250 ms and aborts the batch for a later retry.

Active-path uniqueness uses a deferrable, initially immediate exclusion
constraint with the PostgreSQL `btree_gist` extension (UUID/text equality).
The batch defers it only while applying path changes and checks it again before
the Event/Receipt. Thus a swap of two names succeeds atomically; actual duplicate
paths roll the whole batch back. Existing writers retain immediate checks. A
separate ordinary partial B-tree index preserves path lookup access. The existing
active provider-ID uniqueness and table row shape are unchanged. Deployment
requires the extension; it is available on the target Supabase database.

The existing scheduled invocation reserves at most two directories, with a
five-minute minimum revisit interval. Each observation covers at most 256
objects; a directory rename that exceeds this bound is refused atomically.
The profile registry is bounded to 5,000 entries. Independent file metadata
reads use at most six concurrent requests; total observation time is bounded.
Reservations advance before provider work, so one inaccessible folder cannot
starve other folders. Failures produce a fixed diagnostic visible in the Native
status, without provider errors, names or credentials in logs. Completed or
expired operational plans are retained for one day and cleaned in bounded
batches; Canonical Events and Receipts are retained. The implementation uses
the existing Worker cron and database, with no new paid provider, queue, bucket,
runner, workflow or increased CI budget. Runtime scans remain off until consent.

## Acceptance

Exercise real disposable PostgreSQL and mocked Drive transport: external file
creation, file content edit, file rename/move, directory rename with registered
descendants and unregistered physical children, stable-ID preservation, replay,
simultaneous edits, partial pagination, duplicate names, wrong ownership,
permission changes, move outside root, revoke/isolation/work-claim conflicts,
receipt rollback and bounded retry after transport failure. Verify no Drive
write and no file-body read occurs in reconciliation. Release requires exact
reviewed source, applicable CI and the configured production publisher.
