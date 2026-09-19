# M1-07 MAJOR-04 round 4: isolated owner boundary

Status: remediation candidate; independent review required. No execution authority.
Starting head: `8db4e5e8c9fd7d95813141077f62a6f761427dbc` (PR #268).
Scope: MAJOR-04 only. No M1-08, model load, scenario execution, issuance or release.

## What changed

An imported Python module is now a validation-only facade. It does not install
any live context registry, ownership registry, registration factory, process
controller, callback receiver, execution RPC, or activation token. Public
context/process types are non-authoritative diagnostic placeholders. Even a
copied real owner's metadata or object cannot enable their start/kill methods.

The effectful implementation is installed only in a fresh, standalone CPython
owner process directly executing the exact reviewed script with `-I -S`.
Bootstrap verifies the actual Windows executable and command line through
native APIs; `__name__`, `sys.argv`, `sys.orig_argv`, environment variables,
public booleans and closure secrecy are not authority. No callable installer
is exposed by the import facade. A spoofed `__main__`/argv in a `-c` or runpy
host remains an unprivileged facade.

The helper is included in exact source/blob/hash bindings. It returns no
capability. Authorization still requires the full profile check, independently
bound Owner authorization, exact code identity, physical device check and
one-attempt claim. Registry membership never replaces those checks.

## Process ownership inside the trusted owner

Only the actual start path creates and registers wrappers. Registries compare
exact context and wrapper object identity and retain the original Popen plus
captures. The caller-visible pid, label, scenario and start_index are diagnostic.
Kill/stop/metrics/cleanup target that retained original process, not those fields.
No external command accepts a PID, Popen, wrapper, registry, callback or Python
object. Context and ownership objects never cross the owner process boundary.

## Threat model and limits

Python closures and registries are NOT a same-interpreter security sandbox.
This change removes untrusted callers from the owner interpreter instead of
renaming or hiding its writers. No untrusted Python/plugin/user callback may
be loaded into the owner process. Inputs are JSON profile data and paths only.

The owner interpreter, standard library and reviewed files must be trusted.
Replacing code/dependencies, monkeypatching the running owner, changing its
files, native memory access, debugger/process injection, or compromising the
OS account is outside this mechanism. `-I -S` hardens interpreter startup; it
is NOT OS privilege separation. No OS account, ACL, service, deployment or
production change has been performed or authorized by this remediation.

## Launch contract (NOT authorized by this document)

After separate independent review and Owner Final Issuance, the supported
shape is a direct launch using absolute paths, in this exact order:

```text
<python.exe> -I -S <exact-reviewed-script> --execute --profile <exact-issued-profile> --output-dir <new-output-directory>
```

The current candidate remains `BLOCKED_PENDING_REVIEW_AND_FINAL_ISSUANCE`,
`effectful_authority_issued=false`, `NONE / PROFILE_PREPARATION_ONLY`.
A direct launch with that candidate must reject before context creation,
attempt-guard creation, output directory creation, Popen or scenario execution.
Default invocation and ordinary imports remain validate-only.

## Verification rules

Retain the original profile/lifecycle unit tests and their mock-only process
controls. The trusted owner unit fixture explicitly substitutes the native
startup check solely inside the test loader; this is NOT external-boundary
proof and there is no shipped test-mode flag. External negative tests import
the unmodified facade without that substitution. Separate real child Python
interpreters test spoofed name/argv rejection and direct candidate rejection.
They must not start a real llama-server, load a model or execute a scenario.

Positive controls must prove that the original internally registered fake
Popen alone is controlled, including after all visible wrapper fields change.
Test counts are author-side evidence, not an independent closure verdict.
Only a fresh-context reviewer of the new exact head may close MAJOR-04.
