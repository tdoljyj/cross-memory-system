# Resource Center create-only daily entry

This is the successor launcher for the accepted native-create writer. It does
not qualify the ordinary Codex tool set or arbitrary OS/Google clients.

## Install and qualify

The operator bundles `apps/clued-cloud/scripts/resource-center-daily-runner.mjs`
using `build-resource-center-daily-runner.mjs`, provisions an owner-private state
directory, a pre-existing `jobs.jsonl` ledger and the two existing journals, and installs a fixed launcher with the
exact bundle hash and host configuration hash. Neither hash comes from a job.
Pin the Python consumer, isolation probe and bubblewrap binary separately. The
fixed WSL distro must support the tested namespace and capability restrictions.
`install-resource-center-daily-runner.mjs` is an operator-only fresh-install
entry. Supply reviewed source hashes and a fixed Host config, never job data.
It refuses an existing destination, fsyncs initial journals, reopens/checks them
in a separate process, and pins their file identities in the config. Missing or
replaced journals are not recreated. Its launchers remain `.disabled.ps1` until
review/CI and live profile qualification are complete. Both launcher and runner
require the pinned activation marker, which is absent while staged. Activation
renames `activation.pending.json` to `activation.json` and the exact launchers;
it does not change their pinned contents. The installer
does not implement upgrades, resets or credential renewal. This establishes the
existing Host/NTFS fsync contract, not an arbitrary hardware power-loss warranty.
Do not install a writable root, credentials, host temporary directory or shell
tool into the consumer. The only broker manifest is the two official schemas.

The Host configuration selects exact registered root/provider IDs, allowed
track names, boundary scan roots, DPAPI credential files, journals and runtime
pins. Provision through the existing receipt-backed admin contracts, from a
CURRENT Owner Decision for the precise root. Never reuse revoked test bindings.
Re-read provider IDs/versions **after** Google Picker authorization. A user's
`canAddChildren` does not prove that `drive.file` authorizes this app; explicitly
check `isAppAuthorized` for each existing writable parent. Do not auto-register
manually discovered directories or treat selecting the root as subtree consent.

## Submit a job

The installed fixed launcher reads one UTF-8 JSON object from stdin:

```json
{"job_id":"11111111-1111-4111-8111-111111111111","tool":"clued_resource_center_mutate","arguments":{"operation":"create","target_kind":"file","destination_path":"<registered-root>/<track>/<topic>/new.md","content":"Owner-requested content"}}
```

Reuse the same job ID for a retry of the same request. A successful replay returns
the old Receipt without another mutation. A changed request under that ID,
partial ledger, crash lock or unknown effect fails closed. A lost start/reservation
reply remains unresolved even when the Host reports zero provider side effects.
File and directory-entry durability of the three initial journal files must be
qualified at provisioning. Runtime only appends/fsyncs the pre-existing ledger;
even a lost crash-lock directory entry cannot discard its pending job. Never delete a job
or lock to retry an uncertain write; follow the recovery runbook with the
original job/ticket/intent/generated ID. Tickets and provider attempts retain
`job_id` correlation. Operator-owned state must be outside consumer-writable
paths; a root/profile rotation is not recovery.

After the existing recovery procedure has finalized the **original** Canonical
intent, the operator-only `Repair-CluedResourceCenter.ps1` accepts exactly
`{"job_id":"<original UUID>","request_key":"<original ticket UUID>"}` on stdin.
It requires the old executor to have exited, matches the stored job/ticket/profile
and request hash, and performs authenticated **inspect only** with the original
writer. Only a committed final result plus its Receipt allows an append-only
`reconciled` ledger row and release of the executor fence. It cannot prepare,
start, finalize or perform a Drive mutation, and is absent from the consumer tool
manifest. Unstarted/missing/expired/unproven intents remain closed for separate
operator investigation. No automatic unlock or credential rollover is recovery.

Only task-authorized new UTF-8 text files (up to 1 MiB) and necessary topic/asset
collection directories are supported. No replacement, move, rename or deletion.
The caller supplies no profile, authority, token, script or content-file path.
Directory creation through the writer finalizes a registered Artifact; existing
manually created directories require separate exact authorization/registration.
Do not create status directories or new root track categories automatically.

## Expiry, stop and rollback

Reader bindings expire within 30 days; writer bindings expire within 24 hours
under the unchanged server policy. This launcher refuses new work with less than
10 minutes left. It cannot renew credentials or access administrator secrets.
An authorized operator may renew on the same profile only after checking old
intents, preserving journals and ensuring no executor is running. New credentials
do not resume an old writer's uncertain intent. The service fence remains in
force across profiles. Do not increase expiry or clear a fence for convenience.

To disable, revoke the exact writer and profile through their receipt-backed
admin contracts; disable the installed entry. Do not remove journals. Any cleanup
of the one explicitly approved acceptance object is an operator action bound to
that exact generated ID, not a new general-purpose delete tool. Existing files,
ordinary RDP and account ACLs remain unchanged.
