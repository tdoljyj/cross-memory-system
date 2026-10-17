# Dedicated production publisher VM: preparation and qualification

This runbook describes the version 1.0.0 foundation in
[`clued-production-vm.ps1`](../../scripts/runner/clued-production-vm.ps1),
[`production-publisher-profile.json`](../../scripts/ci/self-hosted/production-publisher-profile.json)
and [`clued-production-vm-guest-init.sh`](../../scripts/runner/clued-production-vm-guest-init.sh).
It prepares an independently inspected base and disposable **qualification**
VMs. It does not yet implement production startup, Actions runner registration,
production credential delivery, workflow routing, or publisher qualification.

The profile deliberately has `production_qualified: false`,
`qualification: null` and `network_status: UNVERIFIED`. `NewJob -Purpose
production` and production `Start` are refused in this revision. A VM boot,
successful baseline check, local test result, route label, sealed disk or human
edited Boolean does not change those boundaries.

## Host and execution boundary

The reviewed endpoint is `DESK-W-591`, rooted at
`D:\CluedProductionPublisher`, owned by `clued-production-publisher-v1`.
It is separate from ordinary persistent CI runners and existing qualification
VMs. The script creates neither a replacement Host account nor credentials.
Actual Hyper-V permissions must already exist for the executing Host identity.

Mutating actions and `ReadStatus` require a **fresh, 64-bit system Windows
PowerShell Desktop 5.1** process. PowerShell 7 is refused. The script explicitly
imports the system Utility, Management, Security, CIM and Hyper-V module
manifests. CIM/Hyper-V may resolve to the exact reviewed Windows GAC DLLs;
arbitrary modules, inherited user search paths and already loaded incompatible
modules do not qualify. After loading those dependencies, automatic module
loading is disabled in that process. This does not alter Host configuration.
`Plan` is read-only and does not initialize Hyper-V.

For example, from the checked-out source:

```powershell
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
  -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File scripts/runner/clued-production-vm.ps1 -Action Plan
```

The dedicated root ACL disables inheritance and permits only the actual
creating SID, SYSTEM and Administrators. Later operations recheck that owner
and ACL. An absolute normalized managed path is required; sibling prefixes,
traversal, alternate data streams, reparse points and hard-linked managed files
are rejected. File identity uses metadata-only `CreateFileW`, shared with
Hyper-V's live handles, so a running VHD is inspected without reading its
contents or weakening link checks. A named Host mutex serializes lifecycle
operations. No operation may target another VM merely because its name looks
similar: the manifest binds its UUID, exact name, owner note, Host SID and
instance directory.

Each VM uses Generation 2, four virtual processors, fixed 8 GiB RAM, a 64 GiB
virtual disk limit, Secure Boot with the Microsoft UEFI CA template, disabled
checkpoints, no automatic startup and graceful shutdown. Creation disables and
reads back the Guest Service Interface. Device checks allow only the recorded
managed disk/DVD paths, one adapter on the pre-existing `Default Switch`, no
Fibre Channel HBA and no assignable device. They do not create switches, alter
Host networking, add Host directory mounts or expose the Host Docker socket.

`Default Switch` is an existing NAT connection, **not a verified egress policy**.
The checks above do not prove that the Guest cannot reach Host/private network
services. Isolation qualification must independently test actual devices,
integration services, Host mounts/sockets, network reachability and the chosen
credential boundary. Do not treat a runner label or a successful DHCP lease as
that evidence.

### Observed controller isolation failure

The 2026-10-18 read-only inspection recorded in
`trace/vm-ci-host-isolation-readonly.json`, SHA-256
`5f8a643197d4b83ccf2577b5b570d6d6aa43dcd9d8735f081256536e367ff988`,
returned `QUALIFICATION_BLOCKED`. From the actual ordinary Linux CI user
`runner` in `CluedCI-Linux`, Windows interop launched a Windows process as
`DESK-W-591\Windows`: the same Host principal that owns the publisher root,
and a member of Hyper-V Administrators. WSL interop was enabled, `D:` was
mounted read/write, and the publisher root's metadata and ACL were actually
readable from that CI context. A separate Guest and directory ACL therefore
do not separate the publisher controller from ordinary CI on this endpoint.

The inspection did not write to the root, call the VM API from CI, execute a
container, or read credentials/job tokens. Complete Linux sudo policy and the
Windows listener process owner remained unknown; a configured service account
alone was not substituted for an observed process identity. Docker-root
capability was an inference from the actual group and root-daemon socket,
not a performed container action. Preserve those limits instead of claiming
a destructive exploit or a negative access test that did not run.

Before production qualification, separate the ordinary CI Windows/WSL Host
principal from the publisher controller, or use a dedicated Host that ordinary
CI cannot administer. Coordinate any migration with the actual CI holder;
do not stop jobs, alter their environment or introduce a paid fallback
implicitly. After the boundary changes, repeat actual CI-identity negative
tests for publisher-root access, Hyper-V control, Host interop, credentials
and disposal. Merely disabling an integration setting temporarily, changing
a Linux username, assigning a route label or passing Guest baseline checks
does not resolve the observed shared-principal boundary.

## Authenticate the input image before attaching it

The observed input on 2026-10-18 was the official Ubuntu release image:

- [Ubuntu 24.04 amd64 cloud image, release 20260926](https://cloud-images.ubuntu.com/releases/noble/release-20260926/ubuntu-24.04-server-cloudimg-amd64.img).
- Format: QCOW2; downloaded image size: `625612288` bytes.
- Image SHA-256: `6a81c37564db9b1ee84e141922625e1d7c5b389b99bb3c572e0243607d5bb4d2`.
- `SHA256SUMS` was authenticated with its detached signature and the exact
  Ubuntu image publisher fingerprint
  `D2EB44626FDDC30B513D5BB71A5D6C4C7DB87C81`.

Preserve the signed manifest, signature result, exact selected filename and
computed digest together. A digest copied from this runbook is an index to the
observed artifact; it does not authenticate a new download. Reject signature,
filename, size, format or digest disagreement before VM creation. The `.img`
filename alone does not imply a raw disk. This path did not use the separately
investigated Azure VHD archive.

The observed conversion used portable, extracted `qemu-img` 11.1.0 from the
20260811 Windows installer linked by the official QEMU download site to
`qemu.weilnetz.de`. The installer was not installed on the Host. Its recorded
published SHA-512 was:

```text
5bcf9eed634e8575a37b74f445af41a2fe4106da512d0c30c368301d4c105037fdfab40a5287367a28a957624cddebbc8c07e16c88ab6634f554cdf3d16bf543
```

Explicit conversion arguments were `-f qcow2 -O vhdx -o
subformat=dynamic,block_size=2097152`. A format-explicit `qemu-img compare`
then observed equal virtual disk content. The resulting imported VHDX SHA-256
was `1634f7136bb9ae49edb6e257571208b7b59295134d43b76eb5bd482658dc8713`.
The source/tool/signature observations were captured in the local
`trace/image-authenticity.json` report, SHA-256
`c48fdbfa1973512b01a394a8e55762be157e22abbec7c1f4f8fee5faced5307b`.
Retain the actual conversion arguments, tool/binary identity, source and output
digests, compare result and source verification with the build handoff.

Only a pinned `.vhdx` or `.iso` inside the dedicated `artifacts` directory may
be attached. The Host lifecycle checks its actual SHA-256; an imported VHDX
must have no parent and fit the reviewed virtual disk limit. It copies the
artifact into the new build instance, verifies the copy, then grows that
**copy** to 64 GiB when necessary. The original authenticated artifact remains
distinct from the subsequently modified build disk.

## Build and inspect a base

| Action | Required input and resulting boundary |
| --- | --- |
| `CreateBuild` | Allocates a new UUID, reserved directory, owned VM and instance manifest; no disk or registration is inherited. |
| `AttachBase` | Exact instance UUID and pinned standalone VHDX; attaches a private build copy. |
| `PrepareBuildVM` | Alternative empty-disk preparation, optionally with one pinned installation ISO; it does not install an OS. |
| `AttachSeed` | Exact instance UUID and pinned ISO, attached once to a VM without an existing DVD. Never include registration or production credentials. |
| `Start` | Requires a fully Off usable instance with one recorded boot disk and matching devices; qualification purpose only. |
| `ReadStatus` | Rechecks instance/VM identity and devices and returns explicit unqualified status. It does not inspect Guest internals. |
| `Stop` | Graceful shutdown followed by an actual Off readback; failure or uncertain shutdown quarantines the instance. |
| `RetireBuild` | Off, exact owned build VM only; verifies provider removal and preserves the failed build disk read-only, pinned seed and evidence with recorded hashes. It never deletes the retained build artifacts. |
| `SealBase` | Off build VM, actual Guest manifest readback and independently evidenced seal observation bound to the stopped disk. Creates a new immutable base generation. |

The current build used a credential-free NoCloud seed to invoke the exact
reviewed Guest initializer. The Host observed serial output without sending
Guest commands through the serial channel. A serial producer must itself be
bound to the exact VM/port and actual service process. On this endpoint the
observed producer was `vmcompute`, not `vmwp`; a process-name assumption is
insufficient. The local observation was recorded in
`qualification-serial-identity.json`.

Inside a fresh Ubuntu 24.04 amd64 Hyper-V Guest, root runs
`clued-production-vm-guest-init.sh --prepare-base` exactly once. Root is needed
for base installation; it is not the job identity. Preparation validates the
official Ubuntu apt sources and unmodified Ubuntu archive keyring, refuses
known Host-share/network filesystems, and installs the fixed package list
from signed repositories. It creates `clued-release-runner` with a locked
password, `nologin` shell and exactly its own group plus the **Guest-local**
Docker group. No sudo rules are added. Docker membership can control the
disposable Guest; it is not a claim of an unprivileged Linux sandbox.

The runner archive is pinned to `2.337.0`, SHA-256
`70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613`.
The initializer verifies the archive and all extracted bytes, modes and
ownership, and rejects unexplained extra runner files. It does not execute,
register or start the runner. No Host credentials, GitHub registration token,
production Binding or production secret is accepted. Node is intentionally
not installed here; the later reviewed workflow selects its own Node version.

Successful preparation writes
`/opt/clued-production-publisher/base-manifest.json`, schema
`clued.production-vm-guest-base/1`. It remains
`state: nonproduction/unqualified`, `production_qualified: false`,
`template_sealed: false`, `runner_configured: false` and
`script_provisioned_credentials: false`. A leftover preparation marker without
a successful manifest is an incomplete base, not permission to rerun against
unknown partial state. Replace the failed build through its governed cleanup
and a new instance rather than treating it as fresh.

Run `--check-only` in the actual Guest and preserve its JSON output. This mode
does not start services, execute the runner, download packages or rewrite the
manifest. It independently rechecks live OS/virtualization, apt trust,
installed versions, archive/content identity, actual UID/groups/password and
sudo denial, no runner registration/service/process/known credential paths,
and the local Docker socket/root. It compares those observations with the
prepared manifest instead of echoing its claims. Known-path checks are not an
exhaustive proof that arbitrary secrets do not exist elsewhere.

Preparation deliberately leaves unknown cloud-init/SSH/user data untouched.
Before sealing, the Host must separately inspect and sanitize its known seed,
initial-access material, cloud-init instance state, machine identity and SSH
template identity as appropriate. Record what was actually checked; do not
create a `PASS` solely from an empty template or an operator Boolean. Preserve
the actual manifest bytes and their SHA-256 after readback. A local path alone
is not evidence available to another endpoint.

`SealBase` requires a `clued.production-vm-seal-observation/1` observation
inside the dedicated `evidence` directory. It binds the exact instance UUID,
VM UUID, Host SID, Guest manifest SHA-256 and stopped disk SHA-256, with a
timestamp no older than two hours and no more than one minute in the future.
Each of these checks must occur once with `PASS` and a concrete evidence hash:
`guest_manifest_readback`, `guest_check_only`, `no_runner_registration`,
`no_credential_residue`, `no_host_mount_or_socket`, and `guest_shutdown`.
The Guest manifest also needs all eight required baseline checks. The Host
then copies the exact stopped disk into a new base UUID, checks its digest,
marks the copy read-only and records the manifest/observation hashes.
The sealed base still has `production_qualified: false`.

## Disposable qualification jobs and retirement

`NewJob -Purpose qualification -BaseId <actual-base-uuid>` rechecks the exact
sealed base owner, disk digest and read-only attribute, creates a new VM UUID
and a new differencing VHDX, and binds both to that base generation. It refuses
another active job or any unresolved quarantine. A retired disk is never
reused. Base changes require a new authenticated, inspected generation.

After a job, stop it gracefully and observe Off before `RetireJob`. Retirement
revalidates the exact owned VM, devices and reserved configuration directory.
It uses the standard local `root/virtualization/v2` provider's
`Msvm_VirtualSystemManagementService.DestroySystem` against that VM UUID.
A synchronous success or a correctly bound completed asynchronous job is
followed by CIM absence, independent `Get-VM -Id` absence, and absence of the
exact VM GUID configuration footprint. The configuration check uses the
owned VM's `Virtual Machines` directory and matches the complete GUID,
including a GUID directory or any extension. A residual configuration file
cannot be hidden by provider absence. Build disks, seeds, logs and unrelated
GUIDs remain untouched; retirement never deletes the instance directory to
manufacture this result.
Only after verified VM removal is the exact instance's `job.vhdx` deleted and
its absence verified. The manifest and provider retirement evidence remain.

`Start` requires both the requested and saved purpose to be `qualification`,
and the saved `production_qualified` value to be an explicit false Boolean.
The lifecycle uses an owner/ACL-checked `Global` mutex shared by Windows
sessions. Its protected ACL permits only the exact controller SID, SYSTEM
and Administrators. An existing mutex with a different owner or ACL is
refused rather than adopted.

Do not regard a deletion request, provider timeout, missing output or a
catch-all `Get-VM` exception as successful removal. The recognized exact
ObjectNotFound result is distinct from a provider/access failure. If retirement
or evidence persistence fails, retain the original error and treat the
instance as quarantined/unknown until exact inspection resolves it. The script
does not recursively remove the publisher root, unrelated disks, build bases
or another VM; it does not restart `vmms`, force power-off, repair provider
permissions or switch identities to get past a denial. `Quarantine` records
the state; it does not stop a running VM or prove durable persistence if the
manifest write itself fails.

The observed implementation history must remain in the handoff: the first
`CreateBuild` failed when Windows PowerShell 5.1 bound an ordinary `$null` to
`File.Replace` as an empty backup path. The implementation now uses CLR
`NullString`; the original `vm-create-attempt-1.json` is retained. A subsequent
`Remove-VM` attempt returned a null-reference error under the attempted
PowerShell invocations;
the exact standard CIM removal and independent absence observation were
recorded in `vm-incomplete-retirement-cim.json`. A running-disk metadata open
also required correction rather than dropping link checks. After the
metadata-only shared-handle correction, actual running-VM `ReadStatus`
observed matching devices, recorded in `vm-running-status-e5606983.json`.
These are bounded Host observations, not production acceptance.

## Qualification and release remain separate gates

All unfinished integration, trusted pre-job/Host consumers, real execution,
cancellation, retirement and independent qualification described below remain
within original Task d745ea6e. Preserve their actual blockers and recovery
conditions there; this runbook does not open replacement Tasks or claim that
offline fixture results complete those operations.

The nonproduction PR consumers have separate, exact Host and Guest Sources.
This phase installs only
[Host qualification](../../.github/workflows/clued-production-publisher-host-qualification.yml).
The full Guest Source stays registered and tested in
[the Source catalogue](../../scripts/ci/clued-publisher-qualification-sources.json);
its workflow is installed only when the trusted controller, pre-step barrier
and JIT runner can actually take its jobs. Neither workflow existed on main
before this phased installation; no existing gate is removed. Extra queued
qualification runs still block the final native merge barrier, so Source-only
acceptance must not create an unusable Guest queue or count as runtime acceptance.
Both Sources preserve the canonical G4 admission gate, accept only an
Owner-authored same-repository pull request to main, and check out its exact
candidate head after admission from trusted base source. Their shared fixed
[case](../../scripts/ci/self-hosted/publisher-qualification-case.json) and
[runner](../../scripts/ci/self-hosted/run-publisher-qualification-case.mjs)
have no arbitrary executable, script, path or target input. Their Source
purpose is production_publisher_nonproduction_PR_qualification and their
classification is qualification_only; actual compiler/role registration and
protected admission remain separate requirements. The former dispatch-only
combined workflow was removed.

An immutable installed barrier before step scheduling and trusted Host one-job registration,
launch and retirement consumer remain **hard external prerequisites** before
any Guest step, including checkout. The job-side observer does not implement
or replace them. A normal started hook returning a failure alone is insufficient:
the runner can still evaluate explicit always/failure steps. Rejection and
cancellation must not reach step scheduling; this remains unqualified.
The job-side observer requires a root-owned, runner-group 0640 launch record
binding exact run/attempt/job/runner, qualification UUID and finite case,
actual execution merge SHA/ref/workflow_ref, and separate PR number/head/base
SHAs. It never changes GITHUB_SHA to pretend the merge is the candidate head.
The Host principal probe likewise reads and cross-checks the real bounded PR
event; its S4U child reports preserve the original observed context instead
of claiming a new authenticated runtime observation.

The fixed Guest cases return success (0), synthetic failure (23), or wait at
most ten minutes for the Host to request and independently observe native job
cancellation. A completed wait returns 24 and fails the cancellation trial.
Failure/cancellation are qualification evidence, outside requiredSuccess.
Per-PR concurrency cancellation of stale source is not, by itself, the
controlled cancellation proof. No production environment, secret, artifact
or cache upload is used. See the
[principal isolation runbook](ci-publisher-principal-isolation.md#两个真实-pr-资格入口与固定-case)
for exact public target UUIDs, case fields and S4U cleanup limitations.

The current repository production entry remains
[`clued-cloud-production-release.yml`](../../.github/workflows/clued-cloud-production-release.yml).
It still declares GitHub-hosted `ubuntu-24.04`; this foundation does not silently
reroute it or justify a paid fallback. Before using this VM route for release,
implement and review the one-job registration/removal consumer, actual
per-job reset and cleanup, network/device isolation tests, restricted workflow
routing, designated release identity and least-privilege credential delivery.
Prove them on the exact source/profile/runtime/base generation and bind the
evidence in an independently reviewed qualification. Do not copy environment
secrets to the Host or base image to make a trial work.

Publisher qualification grants no `release.production` or
`migration.production` authority. Preserve the
[Owner credential contract](../../development/contracts/owner-authorization/OwnerCredential.v0.1.md#61-生产发布与生产迁移),
the designated release-door Binding, `clued-release` environment/main-only
restriction, exact 40-character source commit, claim/admission and protected
change approval, serialized release, and applicable current Owner Grants.
Do not borrow another Task's Grant or substitute the engineering MCP Binding
for the designated consumer. The approved workflow consumes the applicable
Grant at its own door before the production mutation.

Keep the full release cohort and its seven proofs: preflight,
currentness-attestation, served-agent-contract, pdf-extractor, connect-build,
connect-postflight and production-postflight. Preserve fresh database/SQL and
ledger checks, required authorized migration/backup sequencing, exact live
source verification, the PDF/main/Connect Worker cohort, healthy heartbeat
and current projection checks. A local VM lifecycle test cannot replace any
of these. Follow the
[existing production release runbook](../../apps/clued-cloud/docs/production-release.md)
and actual workflow implementation for the operation; this document does not
create a direct local deployment or database-administrator path.

Local tests (including the observed ten-case Host boundary suite) and a
successful Ubuntu 24.04.5 boot/DHCP observation do not prove that base
preparation finished, the image was sealed, production qualification passed
or any production action occurred. In the first actual Guest preparation,
package installation, runner download/hash/extraction and the preceding
guards passed, but preparation exited 1 at the sudo inspection with
`runner has sudo rules, or sudo authorization could not be checked`. Its
failure trap powered the Guest off; no successful base manifest or seal was
accepted. The subsequent credential-free diagnostic boot observed exit code
`0`, stdout exactly `User clued-release-runner is not allowed to run sudo on
clued-base-qualification.` plus one newline, and empty stderr. Hostname
resolution succeeded, the user had exactly its own group plus `docker`, and
the password status was `L`. Thus the base script's requirement for exit code
`1` rejected an explicitly denied account; it did not demonstrate a sudo
grant. The corrected pure predicate accepts code `0` or `1` only together
with the exact target-user denial line and empty stderr. Empty output, allowed
commands, warnings, another user, additional lines and other exit codes remain
rejected. The original partial image remains failed; preparation must run on
a new build rather than repair sudo/hosts or call the partial image fresh.
Report each later milestone only from its actual evidence. Retain the
original failure, diagnostic response, correction and any successful retry.

The fourth clean build, instance `65b47415-38f6-4916-b9f4-80bf9ddaf15f`,
completed preparation, the separate read-only eight-check inspection and
known-path sanitization, then powered off. The Host read back the original
manifest/check/sanitization bytes from its exact VM serial endpoint and
separately checked the Off VM, owned devices and stopped disk. Nonproduction
base `e1740f7c-f4bf-4faa-9989-ebbfa4423d34` was sealed and read back read-only;
its disk SHA-256 is
`3ced3cc4e8765c9a57cd4e01ea7cd04b7296c940b103bbd1023220ea05db8771`.
This establishes a baseline image, not publisher qualification. Ordinary CI
still has the recorded same-Windows-principal isolation failure. The actual
cross-session lock canary was also not qualified: the one current-user S4U
attempt returned access denied, its exact task was confirmed absent, and no
Session 0 callback was observed. Two real processes in Session 1 verified
mutual exclusion, which does not substitute for a cross-session observation.

The next new build passed the corrected sudo predicate and stopped later at
the service-file absence check. Its filtered `systemctl list-unit-files
actions.runner.*.service --no-legend --no-pager` returned code `1` with empty
stdout/stderr. A separate read-only diagnostic observed the complete service
inventory returning code `0`, empty stderr, 235 successfully parsed rows and
no Actions runner unit. The complete stdout was hashed inside the Guest;
unrelated service names were not emitted. Neither result authorized treating
an arbitrary code `1` or an empty failed command as safe absence.

Both preparation and final observation now call the same strict service
guard. It reads the complete `--type=service --no-legend --no-pager --full`
inventory with fixed locale and no colors, requires code `0`, empty stderr,
a nonempty parseable set of service rows and no `actions.runner.*.service`
match. Timeout, output over 64 KiB, malformed/duplicate rows, unknown state or
preset, and any real command failure reject. This replaces both the shell
precheck that previously tested only empty stdout and the later Python
`check_output` that incorrectly treated the known zero-match status as an
exception. Preserve the failed build and its diagnostic evidence; qualify
the correction on a new instance rather than rerunning partial preparation.

The same bounded helper also makes the fresh-account precondition explicit:
`getent passwd clued-release-runner` must return the documented missing-key
code `2` with empty stdout/stderr. Code `0` means an existing account and is
refused; other codes, warnings, timeouts or excess output remain unknown and
are refused. This closes the earlier shell negation that accepted every
nonzero result. The [Linux man-pages getent exit-status contract](https://man7.org/linux/man-pages/man1/getent.1.html#EXIT_STATUS)
distinguishes missing keys from invalid arguments/databases. The account
precondition and service inventory each have a ten-second command deadline;
account stdout and all stderr are capped at 4 KiB. This check does not query
shadow data or create/repair an account.

## Handoff and evidence retention

Git contains the reviewed scripts/profile/runbook and reproducible nonsecret
checks. Build disks, private Host manifests, downloaded tools and local serial
or lifecycle observations stay in their governed artifact/evidence locations;
do not commit disk images, credentials or raw logs with unknown contents.
Cross-endpoint handoff uses the exact Git commit plus controlled artifacts,
hashes, scope, time boundary and qualification/release receipts. A report
existing under this machine's trace directory does not mean it was uploaded,
shared, accepted or readable on another device. Revalidate changed source,
profile, runtime, base, authorization and network state before reuse.
