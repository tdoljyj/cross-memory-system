# A-only fixed descendant stop qualification candidate

Status: repository candidate only. Qualification: `NOT_ISSUED`.
Owner authorizes code, public fixtures, sandbox unit tests and existing draft
PR441 CI. This document grants no VM installation or fault injection.
Remaining real execution and qualification belong to Task `1502fd80`.

## Reuse and authority boundary

Reuse `CgroupRunner.stop`: the installed root supervisor sends `cgroup.kill`
and confirms unchanged cgroup identity, `populated=0` and reaped leader within
the existing `STOP_TIMEOUT=0.1` seconds. Do not substitute leader-only kill,
transport closure, marker text or an exit-code getter for that proof.

The existing empty marker launcher remains unchanged. The new
`m2-restricted-entry-a-fault-fixture.py` and read-only
`m2-restricted-entry-a-fault-observer.py` are excluded from the A package
builder. No installed profile, manifest, role, launcher or tool changes occur.
There is no installed management adapter for this candidate (Task `1502fd80`).

Only separately approved trusted management may select one of the finite
timeout, revoke or disconnect cases. Agent frames retain exactly the existing
three tools and schemas; `fault_case`, fixture, command, UID/GID, role, root,
launcher, timeout and `/proc` root overrides are forbidden. The management
launcher literal is `/usr/bin/python3 -B -I -S
/usr/local/lib/clued-m2-a-fault-fixture/fault_fixture.py
--fixed-management-fixture`. Its source/hash, root-owned path and installed
identity require independent review and separate exact Owner approval before
use (Task `1502fd80`). No arbitrary command or probe content is accepted.

The fixture forks exactly one child in its inherited group/session, accepts no
stdin or configuration, performs no file IO/network/role changes, ignores TERM,
and exits at a fixed ten-second safety ceiling. That ceiling bounds abandoned
test resources; it is not a new acceptance threshold. `FIXED_DESCENDANT_READY`
only announces readiness. Actual identities and liveness must be observed.

## Bound observations and fail-closed result

Trusted management holds its newly spawned process object and binds boot ID,
leader PID/start ticks, PGID/session and UID/GID. The leader must head its fresh
session/group. Readiness requires an observed live leader and at least one live
descendant, with two stable `/proc` group enumerations. Reads are bounded;
unreadable/malformed members, scan limits, boot changes, PID reuse, group churn
and tracked identity or group/session changes make observation incomplete.

After the existing runner's stop action, inspect both the whole bound group and
every previously observed member. A disappeared generation or zombie cannot
execute; any live group or tracked process rejects stop. Leader reaping and
whole-cgroup emptiness still require the existing native runner proof. The
entire stop plus independent observation must meet its unchanged 100ms bound.
Late, missing, exception or incomplete evidence yields `UNKNOWN`; the entry
remains revoked and qualification remains `NOT_ISSUED`. No zero-effect claim is
made, and already committed outputs are not rolled back.

## Evidence separation

Deterministic reducer tests use explicitly marked native-proof mocks. Linux
unit tests start only a bounded same-user subprocess group in the CI/test
sandbox: they observe a real child, exercise the existing Executor's timeout,
revoke and simulated disconnect paths, and kill that owned group. Without real
cgroup evidence those tests deliberately return `UNKNOWN`. A leader-only kill
test observes the surviving child. Windows skips these Linux-only sandbox
tests explicitly. None of these results proves guest role drop, cgroup limits,
VM transport, full Agent tool isolation or actual revoke/disconnect latency.

Real qualification remains pending under Task `1502fd80`. It requires a single
reviewed and Owner-approved execution packet covering all of the following:

| Required authorization/evidence | Exact boundary |
| --- | --- |
| New management fixture installation | Reviewed source/package SHA and root-owned fixed path; installer/profile successor reviewed separately; preserve retained ledger/receipts and six burns |
| Existing A boundary | Fixed VM, existing m2-a UID/GID and roots, approved resource limits; no other role, root, arbitrary executable or supplemental group |
| Three finite live fault cases | Trusted management timeout, revoke, disconnect only, each after actual descendant readiness; exact single-use request IDs burned before dispatch |
| Native stopping evidence | Bound group/cgroup identities, actual before/after process observations, reaped leader, populated=0, monotonic elapsed under existing bound; UNKNOWN fails closed |
| Windows bridge supervision | Acquire/retain process Handle before WaitForExit, obtain a numeric ExitCode; null/error is UNKNOWN, not nonzero; no automatic retry |
| Console input preflight | Same interactive session/desktop, fixed VM PID/HWND/title, actual root pixels, logged activation return and foreground identity; skip redundant activation; every key guard retained |
| Controlled cleanup | Exact matched objects only, independent post reads after deletes, no repeated deletion on an immediate assertion failure; retain audit bytes/inodes, stage, markers, backups and parent ACL |

Actual VM tests, complete three-tool AgentHost qualification, storage fault
durability and final M2 acceptance are still pending (Task `1502fd80`). No model,
training, Gold, protected qualification/holdout rows, production or main merge
is authorized here.
