# M2 restricted entry �� non-production candidate

This candidate implements a closed `listTools` / `callTool` Host surface using
the existing `AllowedRootPolicy`. It does not install an executor, register a
connection, launch processes, change VM permissions or issue domain authority.
Default transport is `NOT_CONFIGURED`; qualification is always `NOT_ISSUED`.
The newline-delimited stdio pilot supports initialize/tools/list/tools/call with
MCP-shaped responses and bounded frames. It has no SDK/VM transport or automatic
installation; deployed MCP interoperability remains unqualified. Run locally:
`node kernel/host/m2-restricted-entry-stdio.mjs` (all execution fails closed).

## Fixed contract

Host-selected A maps to `m2-a`, `/srv/clued-m2/probe/a-input` (read) and
`/srv/clued-m2/probe/a-work` (create only). R maps to `m2-r`, `r-input` (read)
and `r-output` (create only) under the same base. H/G/root roles are unavailable.
The Agent can only call `m2_read_input`, `m2_write_output`,
`m2_run_empty_probe`. Exact argument schemas forbid UID, role, root, command,
shell, probe definition and transport injection. Paths are strict relative
ASCII paths; input names and SHA-256 values come from the Host's frozen manifest.
No overwrite, traversal, link/mount escape or identity drift is admitted.

An injected transport is a trusted development contract fixture until separately
qualified. Its `withFile(request, callback, signal)` must capture verified file
handles, supply full `AllowedRootPolicy` resolution and a fresh `recheck`, and
hold the same handles / serialization boundary through callback completion.
`read(limit, signal)` must bound actual reads; `create(content, signal)` must be
exclusive, handle-bound, atomic and abort-fenced. Input handles must remain
read-only. OS enforcement and durable frozen input identity are required;
returning invented resolution metadata is never sufficient qualification.
`runEmptyProbe(binding, signal)` accepts only the fixed public empty-marker job,
returns only `EMPTY_MARKER_OK`, and cannot expose arbitrary commands/stdout.

Requests are serialized and IDs single-use within the Host instance (256 maximum).
No cross-restart replay guarantee is claimed: deployment requires a durable
executor job ledger and Host-instance identity. The monotonic lease is at most
60 seconds, per-call timeout at most 5 seconds. Revocation, expiry and timeout
abort the request and invalidate the entire entry. `stopAndConfirm` must prove
executor termination; absent/failed/bounded-out confirmation returns
`EXECUTION_STOP_UNCONFIRMED` with execution state `UNKNOWN`. JavaScript cannot
kill an uncooperative executor or undo an already committed output. Exceptions
return sanitized errors and invalidate the entry; they never claim zero effects.
Call success and stop confirmation must also pass monotonic deadline checks;
blocked timer callbacks do not admit a late result or late confirmation.

## External preconditions and precise pending installation

Current Windows Codex still has general host tools. This candidate does not
remove them and cannot alone qualify a restricted Agent. A fresh Agent Host
must expose the complete three-tool allowlist, with no shell, Hyper-V/VHDX,
keyboard control, generic filesystem tools, other-role access or management
Agent delegation channel. Owner remains the trusted administrator.

Before any installation request, supply and review the concrete missing adapter:
offline guest transport bound to fixed m2-a or m2-r, root-owned fixed-job launcher,
verified read-only input handles and private output handles, resource/time limits,
termination confirmation and durable replay ledger. Guest runtime availability
has since been inspected as recorded below; transport remains unverified. No
Node/Python/client/SSH/network install is implied.
Supply an exact complete-tool Host profile plus OS boundary enforcement and
rollback/revocation procedure. Those installation differences are NOT_CONFIGURED
and are not installed by this change. There is no approval to install guessed
permissions, credentials, arbitrary root launcher or a new platform.

Only after separately authorized connection and empty-marker OS qualification
may the transport move beyond candidate fixtures. Qualification must exercise
real unreachable host tools, root, other roles, host mounts/FDs and networking,
and prove actual timeout/revoke termination and durable replay rejection.
No real holdout/48 rows, model calls, model training, Gold/DataGate or formal M2
acceptance is included. Tests validate candidate contract logic only, not VM,
OS isolation, complete Agent tools or deployed MCP interoperability.

Validation: `node --test tests/m2-restricted-entry-candidate.test.mjs`.

## Python offline adapter primitives (candidate, not connected)

The 2026-10-03 read-only guest preflight observed Python 3.13.5, no `node`
command, Hyper-V/VSOCK kernel module configuration, and no visible VSOCK
listeners. This is runtime evidence only; offline transport remains
`NOT_CONFIGURED`. The Windows runner's existing `C:\clued-ci\tools\python.cmd`
resolves Python 3.12.10. No runtime installation is required for candidate tests.

`kernel/host/m2-restricted-entry-python-candidate.py` supplies a deliberately
narrow Linux file/ledger component, not a replacement Agent Host or runnable
server. Production role resolution uses only the fixed A/R account/root map.
The internal directory primitive takes fixture roots for Linux unit tests;
it must never be exposed as an Agent tool or accept roots from transport frames.
Fixed input handles require the already approved root-owned mode-0750 directory
and root-owned mode-0640 files with the role's primary GID; input handles reject
every create operation. Output requires a role-owned mode-0700 directory and
matching effective UID. No VM ACL change is needed for these existing profiles.
Ancestor ownership, immutable read-only inputs, local filesystem/mount policy,
exclusive broker access and cross-process revocation serialization remain
installation prerequisites; they are not proven by this constructor.

Only a single ASCII filename is accepted (nested paths fail closed). Reads use
`O_NOFOLLOW`, a held descriptor, regular/single-link/owner/device checks, bounded
bytes, before/after metadata and frozen digest verification. Outputs are staged
privately, fsynced, then linked create-only from `/proc/self/fd` to retain the
actual open file identity; existing targets including symlinks fail. Directory
fsync precedes return. Cancellation is checked immediately before the synchronous
commit; a separate process cannot revoke it safely without the future broker's
serialization boundary. An exception after link may leave committed output and
must invalidate the entry rather than claim zero effects.

The trusted broker must pre-provision a private SQLite database with
`CREATE TABLE burns(instance TEXT NOT NULL, request TEXT NOT NULL,
PRIMARY KEY(instance,request))`, delete journal mode and local durable storage.
Runtime opens an existing database only, sets `synchronous=EXTRA`, verifies
effective synchronous value `3` and `journal_mode=delete` on every open/reopen,
and uses `BEGIN IMMEDIATE` with explicit `INSERT OR ABORT`. The statement policy
overrides provisioned PK `ON CONFLICT IGNORE`/`REPLACE` so duplicate IDs are
rejected without replacing the original row across connections/restarts. It caps
each trusted Host instance at 256 IDs. Instance IDs and ledger path are broker
configuration, never tool arguments. The broker must burn IDs before every
dispatch, including failed operations, and prevent arbitrary new instance IDs
from evading replay limits. This component is not yet wired into the JS Host.

[SQLite's synchronous documentation](https://www.sqlite.org/pragma.html#pragma_synchronous)
requires EXTRA's additional journal-directory sync for DELETE-mode durability.
EXTRA still requires qualification of the actual filesystem, storage and failure
behavior. Clean close/reopen tests prove replay rejection and effective settings,
not power-loss durability. No simultaneous-burn, power-loss or TOCTOU fault
qualification is claimed. Existing root-owned 750/640 input positive behavior
also remains unqualified; file IO fixtures use role-owned 700/400 profiles.

`run_empty_probe` always rejects `LAUNCHER_NOT_CONFIGURED`. No listener, module
load, SSH, process launcher or stop acknowledgement is implemented or implied.
All entry qualification remains `NOT_ISSUED`. Minimum later approval must name
the exact installed broker/role routing, protected ledger/roots, root-owned
fixed empty launcher and enforced termination, chosen offline transport plus
any Hyper-V registration, and complete three-tool Agent Host with its revocation
and uninstall procedure. Candidate code tests do not authorize that installation.

Validation: `python3 -m unittest discover -s tests -p test_m2_restricted_entry_python_candidate.py -v`. Windows executes ledger
tests but explicitly skips Linux handle tests; the existing Linux candidate CI
runs the complete public-fixture suite without installing Python.

Local Python 3.12.10 candidate evidence: ten ledger/schema tests passed and
eight Linux-only handle tests explicitly skipped; both new Python files passed
`py_compile`, and the four-file change passed `git diff --check`. Linux handle
evidence must come from the exact-head CI run, not these Windows results.

## A-only deployable executor package (uninstalled)

Owner accepted the independent A-only executor stage. The package does not make
the current Windows Codex Host restricted: its general tools and the entire
Windows management host remain outside the executor qualification and trusted
TCB. It cannot be used as an untrusted Agent's A/R authorization channel; VSOCK
CID/port selects routing, not a Windows caller identity. No R endpoint is included.

The broker exposes only three operations. It burns the installed root-private
ledger ID before dispatch, fixes A UID/GID/roots and the public marker digest,
drops supplemental groups, passes no management FD and runs only the installed
empty launcher or fixed read/write worker under isolated Python startup. Frames
are bounded to 98304 bytes; output content to 65536 bytes. Duplicate JSON keys,
role/root/command/launcher/instance injection and additional operations fail closed.
Default broker/bridge/installer entry points deny activation. Explicit installed
entry points are deployment actions requiring separate Owner approval.

The foreground root supervisor uses one pre-provisioned cgroup v2, with 64MiB,
8-task and 20% CPU limits; it does not create or enable parent controllers. There
is no systemd unit, daemon or autostart. It uses a single-threaded native spawn
path, attaches the child to the fixed group before dropping root, and admits no
caller executable. Revoke, disconnect or timeout sends `cgroup.kill`; STOPPED
requires unchanged group identity, `populated=0` and the reaped leader within
100ms. Missing/late/failed proof returns UNKNOWN and permanently revokes entry.
Kernel syscalls can block; a bridge timeout itself never proves guest stop or
zero effects. Already committed output is not rolled back or misreported.

Build: `python3 scripts/model-program/build_m2_a_executor_package.py --output
<local-package.zip>`. Its ZIP/manifest hashes are deterministic with normalized
LF bytes, no hash cycle or activation. The bounded archive contains code,
installer and [exact installation plan](AExecutorInstall.candidate.json).
Installer requires Owner root, the externally approved archive SHA and an
explicit apply/rollback flag. It rejects existing targets, changed public marker
and unavailable cgroup controllers; it never overwrites roles/roots or starts
processes. Rollback refuses a populated group or changed installed code and
retains the ledger. Partial installation failure must be inspected, not retried
over existing paths. Windows code/profile ACL verification and named GUID
registration are separate Owner actions, not performed by the package builder.

Candidate tests run real SQLite replay, framing, package verification and the
fixed public launcher. Dispatcher timeout/revoke and native cgroup/transport
evidence use explicitly named mocks, not OS qualification. Installation, actual
root750/640 positive reads, UID/GID drop, AF_HYPERV/AF_VSOCK connection, cgroup
resource/descendant-kill/disconnect behavior and storage-fault durability still
need separately approved VM tests after independent exact-head code review.
Qualification remains NOT_ISSUED. No models, protected rows or production are used.

The separate [fixed descendant stop qualification candidate](AStopQualification.candidate.md)
adds uninstalled management-only fixtures and identity-bound stop observations.
It reuses the existing cgroup stop proof, preserves all Agent schemas and the
approved package, and keeps real same-user sandbox observations separate from
native VM qualification. Real installation and fault cases remain pending
under Task `1502fd80`; default fixture activation is denied.
