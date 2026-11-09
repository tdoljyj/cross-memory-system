# M5-b physical acceptance and one-UAC maintenance proposal

Status: engineering proposal; neither a new authorization nor an adopted hard CI gate.

The disposable physical test passed on 2026-11-09: import, Linux probe and a
separate second batch-login heartbeat all returned zero. The exact tested
hashes, preserved failed attempts and acceptance limits are recorded in
`work/independent-ci-resident-v1/windows/M5B-PHYSICAL-IMPORT-ACCEPTANCE.md`.
This does not qualify the formal supervisor, a reboot/logoff scenario or both
machines' new packages. The one-UAC implementation remains a separate candidate
until its current source passes review and its authorized physical acceptance.

## Actual failure and required acceptance

The R3 installer passed its simulated tests but the WSL client treated quoted
leading options as Linux commands. A .NET receiver correctly parsed those same
arguments, so that fixture did not reproduce WSL's native parser. The fix needs
an actual Windows batch-account test as well as the raw-command-line regression.

The disposable test uses the real registrar's import XML, encoded script and
password registration method. A newly created ordinary account must never log
on interactively. Import and `/bin/true` must succeed; a second real batch logon
must verify the same SID, hive, profile, distribution registration and another
Linux probe. Its test heartbeat is explicitly separate from the installed
resident supervisor and authenticated production heartbeat qualification.

Record the exact source and executable hashes, task readbacks, real exit codes,
timestamps and preserved diagnostics. Compile-only, task registration alone,
the launcher's exit code, file presence and an unchanged old heartbeat are not
acceptance. Failed attempts and once markers remain available. A changed source
needs its own relevant acceptance; a mechanical publication/version change must
be identified explicitly rather than presented as an already tested new binary.

Proposed future merge gate: changes affecting installation, reinstall, account
creation, Task Scheduler logon or WSL invocation attach a machine-readable
disposable physical run and its logs to the exact candidate. Missing, stale or
unrelated evidence is not PASS. This gate awaits the Owner's policy decision;
this proposal does not add a CI route, billable resource or bypass existing CI.

## Smallest one-UAC route

Keep the normal launcher unable to stop the whole WSL VM by default. An explicit
maintenance run must have a current actual Owner authorization for the exact
node, package, service stop/start and all affected WSL use. A UUID, boolean,
review PASS or old-package permission alone is insufficient.

Use the existing elevated `Invoke-Child` route from
`work/independent-ci-resident-v1/reinstall/launcher/template.ps1::Step-CompanionHeadless`; it does not request
another `RunAs`. Extend the installed rearm/companion maintenance guard rather
than creating another service, RPC, SQL migration or App permission.

1. Bind the node, installed receipt, package, Source, rearm hash, account, disk,
   running WSL inventory and original service/PAUSED state to one operation.
2. Drain upgrades, ledger, broker and train work. Stop Upgrader then Resident
   through SCM, await natural exit, then stop the idle Broker. Verify the
   original runner is stopped and the relevant process tree is empty. Do not
   reuse the force-kill tail of `Step-Quiesce`.
3. Keep that same administrator process waiting for a short-lived nonce-bound
   Host attestation delivered through an Owner-private, non-guest-writable
   directory. Root reads the actual authorization and complete current GitHub
   inventory using its authorized Host tools. Bind the attestation to operation,
   PID/start time, node, package, authorization version, PAUSED hash and WSL set.
4. Check file handles/final paths, ACLs, freshness, exact subject and once state;
   store the accepted bytes under administrator protection. Immediately before
   stopping WSL, recheck local quiet and the covered WSL inventory. All affected
   runners must be proved unable to accept new jobs. A momentary API zero does
   not establish that property. Unknown, incomplete, queued, active or other
   nonterminal runs refuse maintenance.
5. Pass the existing maintenance flag only through those checks, and repeat
   checks in rearm/the final WSL release guard. First test whether the VHD is
   already free. If a shutdown is necessary, persist an intent before issuing
   the fixed command once; retain its actual result, inventory and exclusive
   file-open postcondition.
6. Use move/import/registration and new-process qualification. A context-bound
   failure retains manual recovery state; neither its synchronous path nor the
   SYSTEM fallback may force-stop the task or clear an unresolved operation.
   Check actual installed Source and receipt-bound configuration contents,
   qualification and a fresh restore authorization before restoring only
   originally running services this operation stopped, in Broker → Resident →
   Upgrader order. Preserve the original pause. Do not automatically issue
   Resume or change startup types.

PAUSED and `status.current=null` are insufficient: the executor can still run
revocation, role probes, revoke-only trains and between-batch archives. The
current service has no wired GitHub maintenance inventory route; its App port
does not request Actions read. Do not claim it can provide such proof or read
the Owner's gh credentials to fill the gap. The proposed file carries a trusted
Owner/Root Host attestation, not an independent machine proof. Nonces and ACLs
prevent mixups and other-account modification, not a compromised trusted Host.

## Failure and recovery

Before stop: refuse without shutdown or migration. After service stop but before
move: restore only proven unchanged original states. An unknown shutdown result
retains its intent and a machine-wide administrator-protected active latch,
which blocks a new operation even with a different nonce/evidence directory.
The latch closes only after proven safe completion and restoration; missing,
unreadable or incomplete closure proof holds the SYSTEM recovery path. A move or
qualification failure retains the only disk, registration export, move record,
diagnostics and partial files; do not automatically unregister or delete them.
Restore services only when proved safe, otherwise report the precise paused or
stopped state. Process interruption may require a later UAC; one UAC is the
normal successful path, not a promise after a crash.
