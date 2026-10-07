# M2 scoped consumer integration candidate

Engineering write set for Task `1502fd80-8ff8-4adc-b4f5-da6d462f4f8a`; Owner rule
`07696647-1557-4b0d-9eed-c1f698f4b011@v1`, public Receipt
`7313df9c-b97f-4d90-beb6-f43d32cf469c`. It is a rule reference, not execution or
DomainAuthority. This directory and scripts are candidate implementation until
the root agent reviews the exact diff, admits the write set and integrates it.
No installation, merge or fresh CI acceptance is claimed here.

`scripts/model-program/validate_m2_scoped_successor.py` supplies four explicit
scoped entry points. All locations are derived from the repository root; no
host username, absolute workspace, private model output or local evidence ZIP
is required. The 26 pinned e76 source/schema/definition/self-contained fixture
files live under `tests/fixtures/model-stage-admission/pr441-e76a7`. Existing
five copied files are byte-identical; the original v0.1 inputs are not rewritten.
`SourceLock.e76a7.json` checks every raw size, SHA256 and Git blob identity.
Current repository preparer and preparation contract are separately byte-pinned.

Each invocation owns a `VerificationContext` and private ModuleType graph. The
exact old source bytes are compiled with a module-local builtins import resolver
for the seven old intra-M2 module names. The implementation never mutates
`sys.modules`, `sys.path`, another Context or an original function. Standard
external library imports use Python's ordinary import locking. Recursive legacy
imports fail closed and discard the incomplete module; current frozen scripts
do not depend on dataclass global registration.

The envelope discriminator is `clued.model-m2-scoped-consumer-envelope/1`:

- `v0.1` has exactly schema_version/version/consumer/payload and calls the old
  validator unchanged.
- `v0.2` also requires exact Owner rule, preparation-contract SHA, one
  experiment scope_id and exact stage_bindings coverage. Unknown fields and
  versions never fall back.

M2 qualification binds M1/fixed reference; final holdout binds a frozen product
candidate. Weight learning requires TRAINING. Candidate snapshot, allowed uses,
scope, pool-before-selection and candidate-before-materialization ordering are
checked before the unchanged old source/license, schema/reference, isolation,
exposure, membership, lineage and selection guards. Protected reports cannot
flow back to selection. Input payloads are defensively copied; old files remain
unchanged. Single-purpose v0.2 tests derive only in-memory manifest metadata from
existing public fixture contents, not new questions or samples.

Live capabilities are unconfigured. `--require-domain-authority` and
`--require-live-currentness` fail before source-context creation. Every offline
result has execution_ready=false, actual_execution=NONE, authority_effect=NONE,
DomainReceipt/DataGate/M2/M3 NOT_ISSUED and actual_pool_freeze_verified=false.
There is no backend argument, receipt writer, generator or model invocation.

The dependency lock matches existing protected M0/M1 CI jsonschema4.25.1 and
Python3.12. Six packages have official wheel hashes; rpds has Windows amd64 and
Linux x86_64 manylinux2014 hashes. Normal rpds schema dependency loading is
engineering validation, not a BLAS/DLL/model probe. Install into the CI job's
isolated environment:

```text
python -m pip --isolated install --require-hashes --only-binary=:all: --index-url https://pypi.org/simple -r development/contracts/model-program/stage-admission/m2-scoped-successor/requirements.ci.lock.txt
python -m unittest tests.test_model_program_m2_scoped_consumer -v
```

Tests include genuine full old definitions/schemas and both complete fixtures,
all six scoped purposes, malformed roles/uses/parents/time/exposure/isolation,
unavailable live authority, duplicate JSON, import-cycle failure, separate
Context identities, eight concurrent requests and relocated repo paths. No
schema/definition/backend double substitutes the genuine regression. A test-only
cycle subclass exercises the resolver failure path without editing frozen code.

The existing M0/M1 checks do not automatically run this new test module. Fresh
coverage requires the separately prepared, root-reviewed M2 CI candidate.
Windows local pure regression is evidence for that platform only; Linux/fresh CI
must be observed after authorized integration. This candidate changes no
protected workflow, SQL, M0/M1 frozen bytes, training output or cloud release.
