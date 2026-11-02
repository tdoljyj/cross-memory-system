# Registered local cache maintenance 1.0.0

Task `0c51fb42-46bb-4900-8fa9-9be4f53a6d77`. One Python 3.12+ standard-library
program, one policy (`config/ci-resource-maintenance.json`), arbitrary registered
node IDs. No fleet-size constant, paid service, secret or central deletion agent.

## Deployment status and scope

This source has disposable filesystem tests on Windows and Linux. Scheduler
definitions are rendered and tested; production registration, actual boot/logoff
survival and multi-node pressure recovery still require deployment qualification.
An unregistered machine or old cache is **not** automatically enrolled or cleaned.
Production installation follows the existing exact-Source/Owner gates.

Supported: new leased npm, pip, generic rebuildable bytes and per-job temporary
generations, under the same **standard account** as their producers. npm diagnostic
logs, writer metadata, receipts and maintenance reports stay outside cache data.
These retained records need a separate archival policy; they are not bounded by
cache quotas. Docker image/build stores, resident archives, old arbitrary directories
and WSL VHDX are inventory-only future adapters. No global prune, service stop,
permission relaxation, credential copying or VHDX compaction is implemented.
Linux deletion reduces filesystem allocation; it does not promise Windows VHDX
or host-drive shrinkage. The existing capacity watchdog thresholds are unchanged.

## Provision any node

Provisioning supplies a stable registered node ID, a new private local root and
the accepted canonical-JSON registry digest. Account and environment isolation is
by distinct roots/bindings, never by a cache name alone. For example, using absolute
paths for `TOOL`, `POLICY` and `NEW_ROOT`:

```text
python -I -B TOOL/enroll.py --registry POLICY --registry-sha256 ACCEPTED_DIGEST --node-id REGISTERED_NODE --root NEW_ROOT
```

The command refuses an existing root. It creates four empty managed cache roots,
the private state root, a binding and a scheduler definition. It does not start
anything. A failed enrollment is inspected; do not erase it or relabel old data
as disposable. Repeated provisioning is not a destructive reset.

Linux: install the rendered `clued-cache-NODE.service` in this account's
`~/.config/systemd/user/`, then use `systemctl --user daemon-reload` and
`systemctl --user enable --now clued-cache-NODE.service`. Continuous operation
without a login requires the administrator-approved user-manager/linger setup;
verify that before claiming boot recovery. Never run the worker as root.

Windows: register the rendered XML using Task Scheduler under its exact account
SID, with least privilege and S4U. The task uses `pythonw.exe`, repeating time/logon triggers,
IgnoreNew and bounded restart-on-failure. It needs local storage; S4U has no network
or EFS access. Registration permissions and boot behavior must be verified on the
target machine. Review the rendered XML before installation; no password is saved.

The normal worker is single-instance, node-hash staggered and hourly. Pressure,
deferred work and lease contention retry within five minutes. Each pass is bounded
by time, file count, generation count and bytes. Entry/time budget exhaustion
preserves data and reports debt. It does not lower a safety threshold to hide debt.
`max_seconds` bounds scanning and starting another generation, not an in-progress
whole-generation deletion: that finishes under the exclusive lease rather than
being killed halfway through. It is a soft pass budget, not a hard process timeout.

## Producers must participate

All producers of an enrolled cache must use the common entry:

```text
python -I -B TOOL/maintenance.py --registry POLICY --registry-sha256 ACCEPTED_DIGEST --binding BINDING run --cache-id npm --timeout 1800 -- npm ci
```

Use `pip` for pip, `job-temp` for a process tree's temporary directory and `generic`
for a producer using `CLUED_CACHE_DIR`. No command or environment contents are
written to receipts. npm's cache/log overrides and pip's cache-dir override are
rejected. On Windows, invoke npm's installed `npm-cli.js` through `node.exe`;
`.cmd`/`.bat` shell launchers are deliberately refused by the containment entry.
The supervisor waits for the process family, including an orphan child; on timeout
it terminates only that family. Windows assigns a suspended child to a
private Job before resume; Linux requires child-subreaper support. Processes
delegated to Docker, WMI or unrelated services are **not** qualified by this adapter.
Uncooperative writers invalidate deployment qualification; do not enroll their root.

The producer holds a shared OS lease. Maintenance stops new intake with a bounded
drain marker and takes the exclusive lease after existing writers finish. It releases
the marker in `finally`. Unconfirmed/crashed writers keep a durable generation fence;
missing PID alone does not authorize removal. OS locks use a stable file that is
never deleted. Worker and catalog locks additionally serialize cycles and metadata.

## Plan, recovery and telemetry

`plan --out NEW_PLAN` reads metadata only. `apply --plan PLAN --plan-sha256 DIGEST`
rechecks node/binding/registry, expiry, candidate set, file identity and tree metadata
after drain. `once` is the same bounded local cycle used by the accepted worker.
No automatic plan generated for another registry or node is accepted. Unknown
entries, links/junctions, mounts, hardlinks, foreign owners, evidence-like file names,
private keys, tokens, logs and VHDX files are preserved and reported.
Every ancestor must also resist replacement by another account; a private leaf in
a replaceable shared parent is rejected. This check never changes an existing ACL.

Retirement first writes an immutable intent and quarantines the exact generation.
An interrupted operation remains quarantined and visible as unknown data; restart
does not blindly finish deleting it. Receipts are append-only. A partial pass reports
actual successful removals and failure, rather than claiming the whole plan succeeded.
Operator review of an unsettled writer/retirement is an exception workflow, not a
normal per-machine manual cache cleanup.

Set the runner account's `CLUED_CACHE_NODE_BINDING` to its binding path when deploying.
The existing compute-panel probe calls `probe.py`, which validates that registered
state and emits only a bounded public summary: node, time, state, bytes and deferred
count. No binding means `not-registered`; no report means `never-ran`; invalid or
stale reports are not healthy. The panel deduplicates shared-node bytes, shows debt
and uses its existing alert comments/@Owner route. No extra hosted job is added.

## Verification

```text
python -I -B -m unittest discover -s scripts/ci/self-hosted/resource-maintenance -p test_*.py -v
python -I -B tests/test_compute_panel.py
node --test scripts/ci/ci-required-selection.test.mjs
```

Tests use new temporary fixtures only. Cross-platform native cases explicitly skip
on the other OS; Windows junction and Linux symlink boundaries are tested on their
own platform. The new `resource-maintenance` required-suite selection runs after its
trusted selector is merged. Its first PR still uses the existing immutable base
selector, so local exact-source results are retained rather than letting a candidate
replace its own trusted selector. Existing required checks remain enforced.

Windows repetition uses the supported time-trigger pattern with an omitted
duration ([Microsoft schema](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-repetitiontype-complextype));
it does not require creating an administrator-only BootTrigger.
