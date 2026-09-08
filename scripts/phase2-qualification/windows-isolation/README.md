# Windows AppContainer capability probe

This bounded local experiment uses the existing Windows AppContainer APIs and
installed .NET Framework compiler. It does not install software, require a reboot,
create a trust root, execute a Skill, or qualify the controller. The original
`controller.py` remains unchanged and is not wired to this probe.

Microsoft documents per-user AppContainer creation and launching with explicit
security capabilities. This probe requests **zero capabilities** and creates a
random disposable profile. It uses only that profile's existing private folder,
one freshly created external synthetic canary, and a local loopback listener.
[CreateAppContainerProfile](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createappcontainerprofile),
[Launch an AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer).

## Actual observations

The second observation is `evidence/Attempt02.json`:

| Check | Observation |
|---|---|
| Actual OS token, parent and child independently queried | AppContainer true; capability count 0; matching temporary profile SID |
| Write fixed synthetic file in profile folder | Succeeded |
| Read external synthetic canary | Denied with Windows error 5 |
| Host positive-control connection to loopback listener | Connected |
| AppContainer connection to the same listener | Timed out; **not explicit network-denial proof** |
| Synthetic environment credential canary inherited | False |
| Stop exact child | Alive before stop; terminated and observed exit code 77 |
| Temporary profile deletion | HRESULT 0; profile folder absent |
| Temporary canary ACL restoration | Exact captured access-descriptor comparison true |

The network result deliberately remains inconclusive. No external network endpoint
was contacted, no firewall or loopback-exemption setting was changed, and there is
no claim that every network protocol or host resource has been excluded.

The first attempt also showed filesystem and token isolation, but its .NET ACL
write-back used an unmodified `FileSecurity` object and did not restore the exact
descriptor. That failure is preserved in `evidence/Attempt01.json`. Only its newly
created synthetic canary was subsequently deleted; `Attempt01Cleanup.json` records
the cleanup. The second attempt explicitly reapplied the captured descriptor and
verified restoration. Both profiles were successfully removed.

The probe's .NET Framework `Environment.OSVersion` reports the compatibility value
`6.2.9200.0`. The current PowerShell host separately reported Windows
`10.0.26200.0`; do not use the compatibility value as the actual Windows build.

## Limits

An ordinary AppContainer retains access to some system resources granted to
`ALL_APPLICATION_PACKAGES`; this experiment does not prove a strict single-directory
filesystem allowlist. Microsoft distinguishes this from the more restrictive LPAC
model. Changing to LPAC would require its own runtime-access investigation and was
not attempted here.
[TOKEN_INFORMATION_CLASS / TokenIsLessPrivilegedAppContainer](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ne-winnt-token_information_class).

This is a fixed child with no descendant creation. It demonstrates stopping that
process, not job-wide descendant containment, a revocation service, a durable
remote evidence sink or distributed recovery. The local administrator is not a
hostile actor covered by this probe. Neither a passing token check nor these
observations supply missing issuer authority, accepted Profile, per-action
authorization or independent controller qualification.

## Reproduction and cleanup

Compile `AppContainerProbe.cs` with the already installed compiler:

```powershell
& C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe /nologo /target:exe /platform:x64 /r:System.Web.Extensions.dll /out:DEDICATED_BUILD_DIRECTORY/SyntheticProbe.exe AppContainerProbe.cs
```

Create a fresh disposable local directory, then run
`SyntheticProbe.exe ABSOLUTE_FRESH_DIRECTORY`. This creates a per-user temporary
profile, launches one hidden fixed child with an explicit environment, then stops
it, removes its profile and restores the fresh canary's ACL. It writes immutable
JSON observations in the supplied directory. Inspect all observations; process
exit 0 means observation completed, **not isolation qualification PASS**.

If interrupted, retain evidence and verify that the specific child has stopped
before cleaning its specifically named temporary profile with the documented
`DeleteAppContainerProfile` API. Do not delete unrelated profiles or change global
security settings.
[DeleteAppContainerProfile](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-deleteappcontainerprofile).

Build outputs and fresh scratch directories are ignored under `work/`. No binary
is committed. Source, exact recorded executable hash and raw observation hashes
are bound by `evidence/EvidenceIndex.json`; this index is engineering evidence and
has `authorization_effect=NONE`.
