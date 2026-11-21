# A fixed management fault wiring candidate

Status: repository candidate; installation and actual VM fault validation are
NOT_ISSUED. This companion does not qualify the complete AgentHost or M2. The
accepted fixture/observer at c639a160 are reused without changing Agent schemas.

## Package and installation boundary

`build_m2_a_fault_package.py --output <new-archive>` deterministically builds nine
ZIP members: manifest plus base-a.zip, fault_fixture.py, fault_observer.py,
management.py, fault_bridge.py, host-helper.ps1, fault-installer.py and
fault-plan.json. The nested original A archive remains SHA256
49d5c9dfb5f3e08f4eaa6f255ca2ff7f9e3d55bf4d8f6994119e007b6daad447.
Its old approval does not approve the companion. The final companion hash,
source commit, current prior receipt/ledger/backup pins and transport staging
method must be bound by a separate exact Owner approval before installation.

The root installer verifies the complete archive snapshot, fixed member set and
hashes. Its explicit `--install-approved` additionally requires
`--previous-package`, `--previous-approved-sha256`,
`--previous-receipt-sha256`, `--retained-ledger-sha256` and, when present,
`--retained-backup-sha256`. It reuses the unchanged strict original
`resume_after_rollback`; the existing same-instance ledger inode, all burned IDs,
legacy/v2 receipt chain and backup are preserved. Missing approval, unknown files,
drift, active targets or already burned fixed fault IDs fail before writes.
Failure after writes preserves partial paths; no retry or overwrite follows.

Original A code/config/cgroup are restored under their original contract. The
companion adds root-owned `/usr/local/lib/clued-m2-a-fault-fixture` (0755), four
fixed source files (0555), `/etc/clued-m2-a-fault/profile.json` (root0600 in0700),
and `/var/log/clued-m2-a-fault` (root0700, receipt/case logs0600). The fourth
source is the exact nested base installer. No executable input, role, mode or
command is supplied by Agent arguments. Dynamic imports suppress bytecode writes.

## Fixed management protocol

The only guest execution entry is:

```
/usr/bin/python3 -B -I -S /usr/local/lib/clued-m2-a-fault-fixture/management.py --run-fixed-batch
```

This root-only management entry validates its own fixed installed path, source
hashes, object identities, profile, retained receipt head/history and normal
executor source before importing or opening the original ledger. Agent tools
remain the three original closed schemas. A private management transport only
accepts exact start/revoke frames for these three fixed once-only IDs:

| Order | Case | Burned request ID |
| --- | --- | --- |
| 1 | timeout | m2-fault-20261004-timeout-01 |
| 2 | revoke | m2-fault-20261004-revoke-01 |
| 3 | disconnect | m2-fault-20261004-disconnect-01 |

The original Executor burns each ID in the original same-instance ledger before
launch. The fixed CgroupRunner subclass only substitutes the pinned fixture
command and observes trusted management controls; it reuses the native launch
role, inherited limits, cgroup attachment and complete cgroup stop/reap proof.
Readiness requires an actual live leader and descendant bound to boot UUID,
PID/start ticks, PGID/session and the original nonroot UID/GID. Timeout is the
actual existing deadline. Revoke is received after readiness. Disconnect is
actual socket EOF after the host closes the connection, never a JSON simulation.

No Agent or incoming frame may select the command, case, role, root, launcher or
arbitrary request ID. Extra/duplicate keys, oversized frames, wrong order and
uncertainty abort the batch and preserve evidence. There is no fault retry. After
the real third disconnect, exactly one predeclared audit connection retrieves
the three fixed root-owned logs; it cannot launch another fault.

The readonly console entry is `management.py --summarize-fixed-batch` with the
same Python isolation flags. It opens no ledger connection, listener or child.

## Evidence and honest qualification

Each case records actual trigger, before/after observations, original native
proof, stop-call interval and root-trigger-to-observation interval. Both intervals
must satisfy the existing strict 0<=elapsed<0.1s bound; late, partial, missing,
malformed or nonfinite evidence is UNKNOWN. Group observations alone cannot
substitute for entire-cgroup emptiness, reaped leader and unchanged identity.
The bridge validates closed summaries, process generations, fixed order and all
three complete case observations before returning numeric exit0. Root and host
monotonic clocks are different domains; no subtraction fabricates an end-to-end
Host revoke/disconnect latency qualification. All records retain NOT_ISSUED.

## Fixed Windows helper

The PowerShell7.2 helper is inert when dot-sourced and denies direct CLI use. Its
explicit install/run/remove functions require OwnerApproved, exact package SHA
and, after install, independently approved receipt SHA. Each operation also
requires the independently approved host-only runtime-package SHA. It pins
DESK-W-591 and VM9d775385-4546-4450-a77f-08cdf4f696b6, offline1CPU/2GiB,
`C:\Program Files\CluedM2Fault\host-a`, and the separate protected
`python-3.14.8-amd64` runtime under that anchor. The existing service GUID remains
0000ac45-facb-11e6-bd58-64006a7986d3. The two-member runtime package contains the
fixed official archive plus its closed 37-member hash manifest; it is never put
inside the bounded nine-member guest companion. Source signature verification
requires the independent fixed-release verifier receipt; hashing alone does not
verify the publisher.

Collision aborts. New directories/files and the fixed registry key receive
BA/SYSTEM ownership and a protected management DACL atomically at creation.
Exact OS ancestors admit TrustedInstaller ownership with effective mutation
rights checked; inherit-only ACEs do not grant rights on their current object.
Other owners, effective generic write/all, replacement rights, reparse points,
hardlinks, runtime-member drift and unknown members fail closed. The helper
does not modify any existing parent ACL. The fixed Windows/System32 dependency
directories are checked and receipt-bound; OS dynamic DLL dependencies remain
a trusted OS boundary rather than complete AgentHost qualification.

Before launch the helper rejects inherited nonempty DLL search state, verifies
the entire runtime including stdlib ZIP and `_pth`, uses a protected fixed
working directory, clears the inherited environment, and supplies only fixed
SystemRoot/WINDIR/System32 PATH and protected TEMP/TMP. Python uses `-B -I -S`.

The helper retains Process.Handle before WaitForExit, accepts only an integer
exit code and preserves null/getter/timeout as UNKNOWN. Successful stderr is
separately validated fixed host audit, not an unexamined success signal. An
independent root summary remains required; exit0 alone never proves guest STOPPED.
Console input binds actual process start identity/session, HWND/title, foreground
and fresh screenshot/root confirmation. Each key rechecks the binding; an already
foreground window skips activation. One direct activation logs its return; there
is no AttachThreadInput or arbitrary guest command parameter.

Host stage/receipt/audit remain under `host-a/fault-stage-<full-companion-SHA>`.
Matched cleanup validates every deletion target before deletion, removes only
the three installed host files, 37 runtime files, empty runtime directory and
exact GUID, then independently reads absences. Stage, receipts/audit, anchor,
host directory, private temporary directory and parent ACL remain; failure
causes no repeat deletion. DVD is
untouched. This helper does not create an ISO, change DVD media, load hv_sock or
alter guest network. A future staging/module/mount action is outside its scope
and must name exact targets and matching read-post cleanup in the runtime packet.

Guest `--rollback-approved` validates all companion and original A targets,
hashes/identities/member sets, retained chain and empty cgroup/limits before first
unlink. It removes matching code/config/cgroup and retains both original DATA and
companion LOG, receipts, burns, backups and public markers.

## Verification matrix

| Subject | Current evidence | Remaining boundary |
| --- | --- | --- |
| Fixed frames, readiness, actual socket close/audit order | Repository socketpair/closed-stream regressions | Actual fixed VM transport |
| Same-instance resume, rollback, drift and burns | Cross-platform package tests; POSIX temporary fixtures in existing Linux CI | Actual exact installation approval/current pins |
| Numeric exit/null, handle ordering, bounded summary | Harmless local Windows subprocesses and negative regressions | Actual pinned bridge invocation |
| Foreground/root/per-key guards and matched cleanup | Mocked local helper tests | Fresh observed fixed VM/root and exact approval |
| Native cgroup timing, complete AgentHost/M2 | NOT_ISSUED | Real permitted evidence; no protected48/model calls here |

Existing Linux workflow discovers companion Python tests through the original A
test entry; runner/workflow definitions are unchanged. Windows-only helper tests
run locally and are reported separately. No protected qualification24/holdout24,
Gold independent answers, model invocation, training, main merge or production
publication occurs in this engineering scope.
