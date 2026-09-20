# M1-08 Runtime Lifecycle Native Owner — Implementation Candidate

This directory is the standalone native Effectful Owner candidate for Clued First-Party Model M1-08 Runtime Lifecycle Smoke.

## MAJOR-01 through MAJOR-09 remediation r1

Repair baseline: `015eecb50f86d6ab59228e91b12f7007e88f9387`. This is a
**source candidate**, not an independently accepted successor. The previous
Windows qualification hashes and logs apply only to the previous source. They
must not be reused as qualification for this revision.

The local author-side checks use Go 1.23.2 on Linux and a simulated platform.
Windows cross-compilation is NOT Windows-native execution evidence. The pinned
Go 1.27.1 Windows toolchain still requires native qualification and reproducible
builds. No finding is formally closed solely by this source change.

## Authority state

- Implementation base: `3d8a4c88373f5a54831b40d34c0ad89281d02ac1`
- Contract blob: `f422d4da73deb1cafb6c00468602c8309d896786`
- Candidate profile blob reviewed at the base: `51b0083f74dd12318b7cdcdf3b939d31723de787`
- This source tree grants **no effectful authority**.
- `issuerPublicKeyHex` and `issuerPublicKeySHA256` are intentionally empty. Therefore an implementation-preparation binary fails closed before execution. Owner trust-root selection/enrollment and a separately reviewed binding successor are required before Final Issuance.
- No code in this implementation preparation authorizes creation of the real Attempt Guard, lifecycle test root, model load, llama-server start, install, upgrade, rollback, M1-09, training, promotion, activation, release, production deployment, or PR merge.

## Boundary

The shipped executable is a standalone Go process. Runtime input is data-only: the CLI accepts only an absolute issued-profile path in one of two fixed forms (`--validate-only --profile ...` or `--execute --profile ...`). It accepts no command, executable, argv extension, environment map, CWD, endpoint, PID, handle, process object, factory, callback, root path, test flag, or evidence directory from the caller.

The child launch envelope is derived internally from the verified active slot. The child environment is rebuilt from empty and contains exactly four variables: `SystemRoot`, `WINDIR`, `TEMP`, and `TMP`. `SystemRoot/WINDIR` are obtained only from `GetWindowsDirectoryW`; `TEMP/TMP` are the exact profile-owned test path. `PATH` and all unlisted variables are absent. The Windows launcher revalidates the envelope immediately before `StartProcess` and retains the original creation-time OS process handle.

## Lifecycle implementation

The fixed production sequence is:

1. verify exact issued profile, whole-profile Owner signature, source/binary bindings, device identity, source payload, the separately provisioned guard-parent evidence hash plus signed live directory identity (handle-resolved canonical path, NTFS volume, file ID, owner/ACL digest), absence preconditions, and free loopback port;
2. atomically `CREATE_NEW` the persistent one-shot Attempt Guard as the first profile-owned filesystem write;
3. create only exact test/evidence directories;
4. materialize and verify revision A, publish transition 1, probe A;
5. materialize and verify revision B, publish transition 2, probe B;
6. reverify A, publish transition 3, probe A rollback;
7. reattest source payload, stop all owned processes, remove only the verified test-owned lifecycle tree, retain guard/evidence, and verify closeout.

Before A activation, a partial A slot is removed only when every remaining entry is proven to be within the exact allowed slot shape and free of reparse escape, ADS and hardlinks, and matches a handle-derived entry in this attempt's creation ledger; otherwise it is retained for forensics. Before B activation, verified A must remain active and the same safe-partial cleanup rule applies to B. If A was activated but its install probe fails, `current.json` is removed iff it still resolves to the exact unverified transition-1 A; the runtime root and evidence are retained. Upgrade probe failure may only publish transition `3 RECOVERY B->A recovery_of=2`, then terminal failure. Rollback probe failure may only publish transition `4 RECOVERY A->B recovery_of=3`, then terminal failure. No other transition graph is accepted.

## Qualification tests

`remediation_test.go` executes the actual `run`, materialization, publication,
recovery, partial cleanup and success cleanup functions using tiny non-model
payloads and simulated processes/HTTP. It checks all three committed-failure
recoveries, pre-commit and unknown outcomes, wrong probe content, final Current
mutation, both capture gates, consumed Guard errors, expiry and reserved
forensic capacity. Test constructors are compiled only into test binaries.
`authorize` rejects any non-reviewed payload or layout, and admitted contexts
bind the private attestation values. `canonical-vectors.json` contains Python
standard-library golden bytes checked independently by Go.

`owner_test.go` exercises fixed CLI rejection, candidate non-execution, deliberately unbound trust root, environment-pollution resistance, exact launch derivation, transition-graph rejection, exact temp names, current-manifest fault points (old-or-new complete bytes), handle-resolved path escape/reparse rejection, guard-parent live-identity drift, append-target substitution, process ownership anti-forgery, reviewed-candidate semantic binding, strict JSON, and loopback-only request construction.

`platform_windows_test.go` adds Windows-only checks for exact launch-envelope validation, native current replacement, NTFS named ADS rejection, hardlink detection, reparse-point rejection, trusted Windows-directory resolution, and handle-resolved directory identity. These tests use only test-owned temporary paths and never use the M1-08 production guard/test/source paths.

`remediation_windows_test.go` adds actual native handle-retention, relative
Guard creation, immutable payload, no-overwrite/cross-directory rejection,
readonly replacement failure, and old-reader/new-name replacement tests.
No `Skipf` is allowed to count as qualification: the build helper parses the
per-test JSON log and rejects skipped/missing required tests.

The fixed qualification root is
`C:\Users\Public\Clued\Qualification\M1-08-Owner`. It must already exist and
be Owner-controlled; this helper never provisions it. Output must be a new,
single child such as `r1_build_01`. All compiler caches and temporary files are
beneath that output. Namespace aliases, overlap with the repository or any
`ModelProgram\M1` path, and reparse/handle-path drift are rejected. The receipt
records measured path identities and explicitly does not claim host-wide
absence of effects it did not observe.

Run `python -B build.py --toolchain-archive <exact-go1.27.1-windows-amd64.zip> --output C:\Users\Public\Clued\Qualification\M1-08-Owner\r1_build_01` to verify the exact Contract/Profile objects, source manifest, complete official Go toolchain archive/tree and compiler/linker identities; then run non-effectful tests/vet, compile the Windows test binary, and build the Windows owner executable with the source-manifest SHA-256 injected into the binary. The helper reconstructs its build environment without caller `PATH`/`GOFLAGS` and never executes the owner binary.

## Native implementation notes

Filesystem mutation is handle-relative. Guard-parent and directory handles are
retained, immutable source/slot files are pinned across attestation and use,
and deletion requires the identity recorded at creation. Unknown partial files
are retained, not adopted by filename. Native Current publication uses
`NtSetInformationFile(FileRenameInformationEx = 65)` with a same-directory
simple name; no delete-then-rename, copy fallback, unsupported ReplaceFile flag
or access-check-bypass information class is used. Publication reports
NOT_COMMITTED / COMMITTED / UNKNOWN separately from overall function success.

The effective deadline is the earlier of signed expiry and the wall-time cap.
Guard creation, materialization, chunked I/O and launch have explicit checks.
After failure or expiry, only owned-process shutdown and bounded forensic
reporting remain; failed recovery is reported, never recast as success.
Successful closeout is emitted only by the shared finalizer after lifecycle
completion, owned-process cleanup, listener and deadline checks.

The native API and filesystem failure guarantees remain subject to the required
Windows tests. Cross-compilation and simulated fault injection do not prove
power-loss consistency, kernel/driver behavior, or immunity to a malicious
administrator/Owner who changes the reviewed environment.
