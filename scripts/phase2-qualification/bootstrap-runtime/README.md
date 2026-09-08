# Bootstrap Windows process-tree engineering candidate

**ENGINEERING CANDIDATE — NOT QUALIFIED.** This is a new, separate increment under the independently verified Owner delegation in PR20, merge `4f722ea9d78488b749c15d27fe9145e9d9f9d2c2`. It does not change the frozen `ec72de31` controller or `c1a15d48` AppContainer probe, issue a Profile/GA, execute a Skill, or claim a PQUAL/Entry PASS.

`NativeHost.cs` contains a fixed synthetic child and one fixed descendant. The host starts the child suspended, assigns it to an unnamed Windows Job, checks membership, and only then resumes it. The Job has kill-on-close, a two-process limit and no breakaway flags. Both children check their AppContainer and Job context. Their executable/arguments are fixed by the host; this is not an OS-wide executable allowlist.

The host persists a local Intent before changing a profile/ACL or starting the child. It requests an AppContainer with no capabilities, copies only its own executable into its disposable profile, and supplies an explicit environment. The child performs a dedicated-directory synthetic write, a read of one newly created owner-only canary, and a connection attempt to the host's synthetic loopback listener. It never opens a real credential, business record, model endpoint or public network endpoint. The parent credential canary is explicitly present; the child observes its absence.

`engineering_check.py` compiles only that source using the existing x64 .NET Framework compiler. It reserves one exclusive local slot before creating native hosts. The checks retain real handles to the two live processes before either writing STOP or killing only the native host. They verify those same handles become signalled. In the interrupted case, the missing result remains **UNKNOWN**; there is no re-dispatch. A separate cleanup record follows observed termination. Profile cleanup and ACL restoration target only that run's generated profile and synthetic canary. Original evidence and failures remain intact.

## Actual observations

| Evidence | Observed outcome |
| --- | --- |
| `evidence/JobTree01.json` | Initial new Job implementation: parent/child/descendant token and exact Job membership, two-process tree terminated on engineering deadline, profile removed, canary ACL restored. Earlier source digest is preserved in the index. |
| `evidence/StopCrashAttempt01.json` | STOP caused real whole-tree termination, exit 77 and cleanup. Host crash also terminated both retained process handles; the first recovery attempt failed exact DACL read-back because `SetFileSecurityW` omitted the auto-inherited control flag. UNKNOWN and failure were preserved. |
| `evidence/StopCrashAttempt01Cleanup.json` | After the already observed termination, only the original failed run's synthetic ACL was reconciled using `SetNamedSecurityInfoW`; exact original SDDL read-back matched. No child operation was re-executed. |
| `evidence/HostCrashAttempt02.json` | Only the changed failure path was rerun. Kill-on-close terminated the exact two-process tree; missing result stayed UNKNOWN; profile removal and exact original ACL read-back succeeded. |

All observed child tokens were AppContainer with capability count zero. The forbidden synthetic canary read returned Windows access-denied 5. The host positive loopback control connected, while the AppContainer attempt **timed out**. Timeout is explicitly **not network-denial proof**. The EXE reports the unmanifested .NET compatibility OS version `6.2.9200.0`; the actual host PowerShell OS observation is `10.0.26200.0`, not an inferred downgrade.

The two final-source builds have separate hashes because the existing compiler does not produce deterministic PE bytes. Every report binds the actual build it ran. This is engineering evidence for these exact observations, not a claim that all observations occurred on a single accepted executable.

## Fixed entry and limits

Run from the repository with the existing host Python:

```powershell
python -I -S scripts/phase2-qualification/bootstrap-runtime/engineering_check.py --fixed-engineering-checks
```

`--host-crash-check` is the one fixed fault check used after the cleanup fix. All other arguments, including `--formal`, return BLOCKED before compiling or starting a process. The checks require the effective host permission and current Owner scope; do not schedule them or rerun old successful evidence merely for freshness. Generated builds and raw run journals remain under ignored `work/`. An uncertain path retains its reservation; no expiry-based release or broad PID cleanup occurs.

The exclusive slot is real local engineering coordination. Its stated seconds and zero-paid/model fields are **not** the Owner's aggregate budget ledger, formal reservation, current revocation status, or remote persistence. The native fixed child has bounded waits and the outer check applies process timeouts; neither constitutes an accepted renewable GA supervisor.

## Remaining acceptance gaps

- Network timeout is insufficient for actual denial; ordinary AppContainer also has standard shared OS access, so one canary denial does not prove an exact filesystem/executable allowlist.
- No accepted Profile, exact Skill subject binding/execution, R05–R10 chain, signed GA, independently fresh current generations/revocation, or per-side-effect authorization is connected here.
- Local fsync/read-back is real but is not the required remote durable Intent/result sink. No GitHub credential is supplied to a child, and no repository write path is added.
- Owner aggregate time/evidence accounting, remote reservation, formal stop/revocation chain, accepted idempotency/reconciliation and complete crash recovery before an active-tree record remain unimplemented. An earlier interruption stays UNKNOWN with capacity retained for independent review.
- The synthetic crash reconciliation trusts the coordinator's retained handles and generated local resource journal. It is not a general attacker-resistant recovery API or a formal authorization source.

The designated independent assessor is `/root/project_list_auth_fix`. Only its real acceptance plus complete prerequisites could support a later coordinator-issued GA. This directory cannot authorize itself.

## Platform basis

Microsoft documents child Job inheritance, whole-Job termination and kill-on-close in [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), and the process cap in [JOBOBJECT_BASIC_LIMIT_INFORMATION](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information). AppContainer capability and access boundaries follow [AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation). These documents explain the intended APIs; the reports above separately record what actually happened on this host.
