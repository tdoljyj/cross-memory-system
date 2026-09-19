# M1-07 / MAJOR-04 r5: native owner remediation candidate

Status: AUTHOR-SIDE REMEDIATION / NOT INDEPENDENT REVIEW / NOT ISSUANCE.
Starting blocked reviewed head: `15aea8fe4c7702a49ed1c722cea00857b091c5ad`.
Formal base: `bd80de6beed04a52b74f763baa7c274b5741fb1d`.
Scope remains MAJOR-04 and its absolute-launch-path MINOR only.

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

## Issuer trust and authority: intentionally unresolved

A digest inside caller JSON is not an independent authorization origin.
The native owner therefore additionally verifies Ed25519 over the entire
canonical JSON profile excluding only `owner_signature`. The public key is
compiled into the reviewed binary, never accepted from JSON, argv or env.
Canonical format: UTF-8, sorted object keys, compact separators, no ASCII/HTML
escaping; duplicate keys and oversized input are rejected.

**The production issuer public key is deliberately EMPTY in r5.** No real
Owner key, signature, issued successor or execution authority was created.
Test-only keys are ephemeral and exist only in `owner_test.go`, which is
excluded from the production binary. `go build` cannot enable test drivers.
Production rejects both the current Candidate and a fabricated ISSUED-shaped
profile before context, attempt-guard, output-directory or model creation.

This native/signature contract is PROPOSED, NOT OWNER-ADOPTED. Accepting it
requires independent review and explicit Owner contract adoption. A separately
approved and independently reviewed code successor must then pin the Owner's
trusted public key, rebind native source/binary identities and obtain a signed
issued profile. A review PASS on r5 alone cannot enable execution or bypass
that successor. Do not silently weaken this gate to make issuance easier.

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
the repository. The executable hash is DEVELOPMENT BUILD evidence, not an
issued profile or accepted runtime binary identity.

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
signed authorization, fixed arguments, no-key rejection and a seven-start
MOCK-ONLY sequence. Native unit tests do not start a real process/server, bind
a port, load a model or make real HTTP requests. Production child-binary tests
exercise rejection paths only. Actual Windows process lifecycle and real M1-07
qualification remain NOT EXECUTED; do not infer them from mocks or compilation.

## Final gate

MAJOR-04 remains NOT FORMALLY CLOSED. The modifier cannot issue an independent
Fresh-Context verdict. Candidate status, authority effect and issued flag remain
BLOCKED_PENDING_REVIEW_AND_FINAL_ISSUANCE / NONE / PROFILE_PREPARATION_ONLY / false.
No Owner Final Issuance, PR merge, model execution, M1-08, training, production
or release is authorized or performed by this candidate.
