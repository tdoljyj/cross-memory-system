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

1. verify exact issued profile, whole-profile Owner signature, source/binary bindings, device identity, source payload, guard parent, absence preconditions, and free loopback port;
2. atomically `CREATE_NEW` the persistent one-shot Attempt Guard as the first profile-owned filesystem write;
3. create only exact test/evidence directories;
4. materialize and verify revision A, publish transition 1, probe A;
5. materialize and verify revision B, publish transition 2, probe B;
6. reverify A, publish transition 3, probe A rollback;
7. reattest source payload, stop all owned processes, remove only the verified test-owned lifecycle tree, retain guard/evidence, and verify closeout.

Upgrade probe failure may only publish transition `3 RECOVERY B->A recovery_of=2`, then terminal failure. Rollback probe failure may only publish transition `4 RECOVERY A->B recovery_of=3`, then terminal failure. No other transition graph is accepted.

## Qualification tests

`owner_test.go` exercises fixed CLI rejection, candidate non-execution, deliberately unbound trust root, environment-pollution resistance, exact launch derivation, transition-graph rejection, exact temp names, current-manifest fault points (old-or-new complete bytes), path escape/symlink rejection, process ownership anti-forgery, strict static scope binding, whole-profile signature protection, strict JSON, and loopback-only request construction.

`platform_windows_test.go` adds Windows-only checks for exact launch-envelope validation, native current replacement, NTFS named ADS rejection, and reparse-point rejection. These tests use only test-owned temporary paths and never use the M1-08 production guard/test/source paths.

Run `python build.py --output <absolute-path>` to verify the exact source manifest, run non-effectful tests/vet, compile the Windows test binary, and build the Windows owner executable with the source-manifest SHA-256 injected into the binary. The build script never executes the owner binary.
