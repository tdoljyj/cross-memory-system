# M1-07: Owner-root-pinned native owner successor

Status: OWNER ROOT PINNED SUCCESSOR / NOT INDEPENDENTLY REVIEWED / NOT ISSUED.
Predecessor exact head: `d58df9c4a1885512bd4dd9b94f121b6a84e25744`.
Formal base: `bd80de6beed04a52b74f763baa7c274b5741fb1d`.
Boundary Adoption Event: `833`; Successor Preparation Gate Event: `834`.
Scope is limited to Owner trust-root pinning and exact native source/binary rebinding.

## Production boundary

`m1_runtime_stability_pc.py` is permanently validation-only. The effectful
branch, context/process registration writers, closures, captures, process
controller and runtime installer have been removed, not renamed or concealed.
Replacing its legacy helper or replaying the old white-box loader cannot
install an implementation that is absent from the Python source.
`m1_runtime_stability_owner_boundary.py` is legacy launch-shape lint only;
`require_owner_process` unconditionally rejects. It is not an authority gate.
Both executable and script paths in that legacy lint now must be absolute.

The candidate replacement is `m1-runtime-owner`, a standalone Go executable.
It does not load Python, shared user libraries, plugins, callbacks or an RPC.
The production command does not accept a process, PID, wrapper, registry,
controller, runtime driver, issuer key or caller executable command.
No native library or Python extension is built or shipped.
Private owner state cannot be reached by Python object introspection.

Only successful full native policy validation, whole-profile signature check,
exact native source/binary binding, physical machine identity, exact package
integrity and atomic one-attempt claim can register a context. Only the native
start path registers its newly created process. All kill, graceful-stop,
liveness, RSS and cleanup operations resolve the retained original OS process
handle; diagnostic pid/label/scenario/start_index cannot redirect them.
The Windows implementation retains the handle returned by process creation,
not a later handle looked up from a supplied/reused PID. Graceful console
signalling uses only that internally retained creation-time process group.

## Issuer trust root pinned; execution authority remains unresolved

A digest inside caller JSON is not an independent authorization origin.
The native owner therefore verifies Ed25519 over the entire canonical JSON
profile excluding only `owner_signature`. The Owner-enrolled public key is
compiled into the native binary and is never accepted from JSON, argv or env.
Canonical format: UTF-8, sorted object keys, compact separators, no ASCII/HTML
escaping; duplicate keys and oversized input are rejected.

The enrolled Owner Ed25519 public-key SHA-256 fingerprint is
`7d8a39adb80276686ff052b65e074a8ea9e74f7eccbc44f4340b194fec342f9c`.
The corresponding private key remains Owner-only on `DESK-W-591` and is not
stored in this repository, profile, build log, argv, environment, CI artifact,
or any remote agent. Test-only keys remain isolated to `owner_test.go`.

Owner adoption of the native/signature boundary is recorded by Event `833`,
and successor preparation is authorized by Event `834`. This pinning does NOT
constitute Final Issuance: the successor profile remains non-issued, has no
Owner final execution authorization, and must pass Fresh-Context independent
review before any separately authorized issuance. Production child-binary
checks reject both the non-issued Candidate and an ISSUED-shaped profile that
lacks a valid Owner signature before context, attempt guard, output directory,
or model creation.

## Threat model

The boundary moves authority outside the importing Python interpreter.
A hostile importing Python program can replace its own code, but the shipped
Python code contains no effectful controller and cannot confer native rights.
This is not isolation from OS-account compromise, replacing the native binary,
modifying reviewed sources/toolchain, debugger/native-memory injection or
interference by another process that already has sufficient OS rights.
No accounts, ACLs, services, firewall, registry writes, deployment or production
changes are part of this remediation. No such protection is claimed as tested.
An independent reviewer must evaluate compatibility with the original contract;
these limits and the proposed contract must not be treated as self-approval.

## Fixed scope and future launch (NOT authorized here)

The model/package, DESK-W-591 identity, CPU-only threads=2, loopback:18087,
four scenarios, seven starts, one attempt, 1800-second wall budget and
128-MiB evidence budget remain fixed. No M1-08 or other model-program stage.
Future syntax, only after all separate gates:

```text
<absolute-native-owner.exe> --execute --profile <absolute-signed-issued-profile.json> --output-dir <absolute-new-output-directory>
```

Python `--execute` is permanently rejected. Native `--execute` with the current
Candidate is rejected. Default/validate-only readbacks never start a server.

## Build and author-side regression

Go >=1.23 is required; use an approved local toolchain. No third-party Go modules,
auto-toolchain download or automatic dependency installation is allowed by the
build/test commands. `source-manifest.json` hashes all production source inputs.
The build helper checks the manifest and writes binary/build receipt outside
the repository. The NON-ISSUED successor binds the exact development binary
SHA-256 for independent review; that binding does not make the profile ISSUED
and does not grant effectful execution authority.

```text
python -B scripts/model-program/build_m1_07_native_owner.py --go <approved-go.exe> --output <outside-repository-directory>
python -B -m unittest tests.test_model_program_m1_07_profile_candidate -v
```

Tests use `CLUED_M107_GO` to select a compiler, `CLUED_M107_GOCACHE` for an
outside-repository cache, and `CLUED_M107_TEST_LOG_DIR` for raw native outputs.
Those are test/build settings only; they do not exist in native authority input.
Missing compiler is a test FAILURE, never an automatic skip.

All original 48 Python test names are retained. Eleven original lifecycle
cases are explicitly migrated to real native-controller assertions using fake
OS/process/HTTP objects, not relabelled tests of the refusing Python facade.
`test-migration.json` is the traceability map, not proof by name retention.
The old trusted-owner loader is now used only to assert that it cannot install
an effectful runtime. Additional tests cover all original-handle control paths,
signed authorization, fixed arguments, exact Owner-root fingerprint pinning,
unsigned-ISSUED rejection and a seven-start MOCK-ONLY sequence. Native unit tests do not start a real process/server, bind
a port, load a model or make real HTTP requests. Production child-binary tests
exercise rejection paths only. Actual Windows process lifecycle and real M1-07
qualification remain NOT EXECUTED; do not infer them from mocks or compilation.

## Final gate

The r5 native/signature boundary has been Owner-adopted via Event `833`, and
Event `834` authorizes preparation of this pinned-root successor only. The
modifier cannot issue an independent Fresh-Context verdict. Candidate status,
authority effect and issued flag remain
BLOCKED_PENDING_REVIEW_AND_FINAL_ISSUANCE / NONE / PROFILE_PREPARATION_ONLY / false.
Fresh-Context independent review of the exact successor head is still required.
No Owner Final Issuance, PR merge, model execution, M1-08, training, production
or release is authorized or performed by this successor.


## Owner-root successor r1 targeted remediation

Fresh-Context review of exact successor head `aa127d5d0623cce921cb90643ec620ace2b70a1f`
found 0 BLOCKER / 3 MAJOR. This r1 changes only those three boundaries and
does not expand M1-07 execution authority.

1. **Runtime configuration authority is closed.** The native owner no longer
   passes `os.Environ()` to llama-server. The child receives only
   `SystemRoot`, `WINDIR`, `TEMP`, and `TMP`. Therefore
   `PROGRAMDATA` / `APPDATA` config.ini discovery and all inherited
   `LLAMA_ARG_*` / token variables are absent. Signed fixed argv is the sole
   llama-server configuration source.
2. **Source-to-binary build provenance is closed.** The build helper rejects
   inherited `GOFLAGS` before creating an output directory, uses
   `GOENV=off`, `GOWORK=off`, an empty `GOEXPERIMENT`, local toolchain,
   offline module settings, and CGO disabled. The build receipt records the
   effective build environment and target.
3. **Runtime implementation identity is closed over the exact release tree.**
   Before any attempt guard, output directory, or server start, the native owner
   verifies the exact b11033 Windows Vulkan release ZIP and then cryptographically
   compares every extracted runtime file against that ZIP, rejecting extra,
   missing, non-regular, size-drifted, or digest-drifted files. This covers
   `llama-server-impl.dll`, `llama.dll`, `llama-common.dll`, GGML backend
   DLLs, and the remainder of the exact runtime release tree rather than only
   the 9 KiB launcher.

r1 exact identities:

- remediation predecessor: `aa127d5d0623cce921cb90643ec620ace2b70a1f`
- native source manifest SHA-256:
  `ecf1279eb8e8e443af5b0fc3bff7d94e4e1147203d314dc07970ef9667b887d5`
- development native binary SHA-256:
  `398045c9166189383506135302152dc11dbad4cf7ee032edb5b85aa398560aed`
- exact runtime asset SHA-256:
  `8ca91d4621fcac8799245f01a6467e9c09eba7b8d3be161a382048dc5c839db2`
- Owner public-root fingerprint remains:
  `7d8a39adb80276686ff052b65e074a8ea9e74f7eccbc44f4340b194fec342f9c`

Final author-side r1 verification: focused 59/59 PASS; four M1 validators
PASS; full M1 88/88 PASS; native Go 100 leaf cases PASS / 0 failed; go vet
PASS. Adversarial runtime-tree tests reject same-size content drift, extra
files and missing files. Inherited `GOFLAGS=-overlay=...` is rejected before
build output creation. The exact NON-ISSUED Candidate returns exit 3 /
`PROFILE_NOT_ISSUED` with no output directory; an ISSUED-shaped unsigned
profile returns exit 3 / `OWNER_SIGNATURE_ALGORITHM` with no output directory;
observed Windows llama-server process count remains 0 -> 0 -> 0.

This remains **NOT FINAL ISSUANCE**. No Owner private key was read or used, no
real M1-07 scenario ran, no llama-server/model was started, and PR #268 remains
outside r1 merge authority.


## Owner-root successor r2 build-provenance remediation

Same-session technical pre-review of r1 exact head
`ffff2580f1c3fb9453fef9bd517cd5e12b01226e` found one remaining MAJOR:
the build helper verified the eight manifest-listed production files but still
executed `go build .` in the original package directory. An unmanifested
`extra.go` was therefore accepted by Go and changed the produced binary while
the receipt still reported the r1 manifest digest.

r2 changes only that build-provenance boundary:

1. The package directory has an exact allowed entry set: eight manifest-bound
   production inputs, two named test files, and two named non-build metadata
   files. Extra, missing, directory, symlink/reparse-like non-regular, or other
   entries fail before output directory creation.
2. The build helper itself is now byte/SHA-256/Git-blob bound by
   `source-manifest.json`, and Candidate records the helper path/SHA and
   provenance semantics.
3. After verification, the helper writes only the already-verified production
   bytes into a fresh temporary `verified-source` snapshot and runs
   `go build` from that snapshot, not from the repository directory. This
   closes both unmanifested build inputs and the verify-then-build directory
   substitution window.
4. The Go environment remains fail-closed and now also uses fresh isolated
   `GOCACHE`, `GOMODCACHE`, and `GOTMPDIR` in addition to
   `GOENV=off`, empty `GOFLAGS`, `GOWORK=off`, empty
   `GOEXPERIMENT`, local toolchain, offline proxy/sumdb and CGO disabled.

r2 exact identities:

- remediation predecessor:
  `ffff2580f1c3fb9453fef9bd517cd5e12b01226e`
- validated code candidate head:
  `d680d2635a2dd42cca84becaec298c2babf470df`
- Candidate SHA-256:
  `30b52405c5a3297eed29b545074010c098e3041c34e838120e2be42b570e4363`
- native source manifest SHA-256:
  `335a998f3acbb70cddecf02cb2de644264146164508133dccc3299255bbdd36d`
- build helper SHA-256:
  `52ef67351c3f976593c4332f47ca1805340de40df6f3cce22b2a38f9feded1b2`
- development native binary SHA-256:
  `ce44ea928b8e124c91e7694b84090c279e171e37471b9bb9a453aabf66dfc28a`
- external build receipt SHA-256:
  `40c4a2e751ed33c42d8537e2f9a9b7a220a09b39f3256d613b9b9a4487269153`

Adversarial closure proof: a repository-external copy with an unmanifested
`extra.go` returns nonzero, reports `native source directory set drift`,
and creates no output directory. The clean snapshot build succeeds and matches
the exact Candidate binary.

Final author-side r2 verification: focused 61/61 PASS; four M1 validators PASS;
full M1 90/90 PASS; native Go 100 leaf cases PASS / 0 failed; go vet PASS.
The exact NON-ISSUED Candidate returns exit 3 / `PROFILE_NOT_ISSUED` with no
output; an ISSUED-shaped unsigned profile returns exit 3 /
`OWNER_SIGNATURE_ALGORITHM` with no output; Windows llama-server process
count remains 0 -> 0 -> 0.

This remains **NOT FINAL ISSUANCE**. No Owner private key was read or used, no
real M1-07 scenario ran, no llama-server/model was started, and PR #268 remains
outside r2 merge authority.
