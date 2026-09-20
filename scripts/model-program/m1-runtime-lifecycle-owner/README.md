# M1-08 Runtime Lifecycle Native Owner — Implementation Candidate

This directory is the standalone native Effectful Owner candidate for Clued First-Party Model M1-08 Runtime Lifecycle Smoke.

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

Before A activation, a partial A slot is removed only when every remaining entry is proven to be within the exact allowed slot shape and free of reparse escape; otherwise it is retained for forensics. Before B activation, verified A must remain active and the same safe-partial cleanup rule applies to B. If A was activated but its install probe fails, `current.json` is removed iff it still resolves to the exact unverified transition-1 A; the runtime root and evidence are retained. Upgrade probe failure may only publish transition `3 RECOVERY B->A recovery_of=2`, then terminal failure. Rollback probe failure may only publish transition `4 RECOVERY A->B recovery_of=3`, then terminal failure. No other transition graph is accepted.

## Qualification tests

`owner_test.go` exercises fixed CLI rejection, candidate non-execution, deliberately unbound trust root, environment-pollution resistance, exact launch derivation, transition-graph rejection, exact temp names, current-manifest fault points (old-or-new complete bytes), handle-resolved path escape/reparse rejection, guard-parent live-identity drift, append-target substitution, process ownership anti-forgery, reviewed-candidate semantic binding, strict JSON, and loopback-only request construction.

`platform_windows_test.go` adds Windows-only checks for exact launch-envelope validation, native current replacement, NTFS named ADS rejection, hardlink detection, reparse-point rejection, trusted Windows-directory resolution, and handle-resolved directory identity. These tests use only test-owned temporary paths and never use the M1-08 production guard/test/source paths.

Run `python -B build.py --toolchain-archive <exact-go1.27.1-windows-amd64.zip> --output C:\Users\Public\Clued\Validation\M108-owner-qualification\<new-name>` to verify the exact Contract/Profile objects, source manifest, complete official Go toolchain archive/tree and compiler/linker identities; then run non-effectful tests/vet, compile the Windows test binary, and build the Windows owner executable with the source-manifest SHA-256 injected into the binary. The helper reconstructs its build environment without caller `PATH`/`GOFLAGS` and never executes the owner binary.


## MAJOR-01 through MAJOR-09 remediation candidate

This successor remains unissued, with an empty issuer root and no execution
authority. The accepted Contract/Profile bytes are unchanged. Source changes
require a new manifest and new qualification, followed by independent review.

The write path uses retained directory handles and native relative opens. Each
created file/directory receives an in-memory volume/file-ID provenance record;
cleanup reopens a DELETE-capable handle and compares that record before any
removal. Persistent Guard/evidence deletion is forbidden. Payload read leases
remain live through use. Current publication uses one native same-volume NTFS
rename, not ReplaceFileW or a delete/rename sequence, with explicit committed,
not-committed, and unknown outcomes. This is not a power-loss durability claim.

Post-commit validation, evidence, and probe errors enter the same bounded
recovery branch. Unknown state is retained rather than labelled uncommitted.
Destructive success cleanup requires the exact recorded final 3N bytes and
transition semantics. Failure finalization reports process cleanup, listener,
remaining paths, and evidence errors without overwriting the original failure.
Capture exhaustion does not consume the reserved forensic budget. Signed expiry
clamps normal execution; expiry never authorizes a new start or extends the
allowed lifecycle. Safety termination/reporting is separate from business work.

Qualification output is restricted to a NEW direct child of
`C:\Users\Public\Clued\Validation\M108-owner-qualification`. The CLI does not
accept an alternate root. Build temporary/cache paths stay below that output;
existing ancestry is opened without reparse following and pinned during build.
Use `python -I -B build.py --toolchain-archive <reviewed-zip> --output
C:\Users\Public\Clued\Validation\M108-owner-qualification\<new-name>`.
The build parses per-test JSON and rejects skipped/unfinished/failing tests;
it also runs the Python namespace tests, vet, and compilation. It never runs
`m1-08-owner.exe`. Receipt filesystem statements describe the controlled build,
not a substitute for independent live production-runtime observation.

`remediation_test.go` uses small inert payloads and fake child processes through
the production lifecycle functions. On Windows its filesystem delegates to the
actual native filesystem adapter. Test-only payload sizes, faults, and adapters
are absent from the CLI and are not execution authorization. The native test
suite requires NTFS ADS/hardlinks and reparse fixture availability.

The reparse test uses a test-owned directory junction when Windows does not
grant symlink privilege; only the trusted absolute cmd.exe creates that inert
fixture. It never launches the owner or any model executable. A missing reparse
fixture remains a qualification failure, not a skip.
