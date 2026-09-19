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
