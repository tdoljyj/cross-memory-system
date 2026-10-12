# M2-10 saved-output replay connection — source candidate

This connects a fixed saved snapshot to caller-owned scorer, projector, metrics
and renderer implementations. It supplements the reviewed PR745 numerical
component. It does not replace the existing Domain, permission, Source reader,
model invocation or independent qualification consumer.

## Use

`run_saved(snapshot, binding, split, consumer, scorer, projector, metrics, renderer)`
returns a JSON report, its exact rendered bytes, and two replay digest sets.
It checks the full registered request set before executing callbacks. Runtime
failures and absent measurements stay in that set. Snapshot identity binds
original output bytes, input digest, terminal status, usage and split identity.
Scorer and projector must retain the original identity and measurements.

The caller supplies the existing complete DatasetSplit object; additional
frozen fields are retained and sealed. Purpose values come from the adopted
DatasetSplit definition, not a newly registered domain. Selection cannot
consume qualification or final-Holdout results. The existing known selection
consumer cannot disguise its purpose with a false flag; selection exposure
cannot be relabelled unseen.

Source, policy, dataset/evaluation and split references are consistency
carriers. They are not proof of actual data authority, lawful access, actual
Source bytes or callback purity. The original caller must verify those facts
before use. Callbacks must only process saved outputs; no inference, model
call or generator is provided here.

Two complete evaluations use independent copies of the same frozen snapshot
and policy. Score, report and rendered-byte digests must all agree. The
renderer must represent the complete report without changed content,
duplicate keys or nonfinite numbers.

## Evidence and missing inputs

The existing plan §22.5 evidence classifications are preserved. Specification
examples remain specification examples. A test exercising the API's live
mode with mock references is not an actual model measurement. Missing live
Gold cannot be replaced by example labels. Missing Gold, Threshold or Profile
is reported as `EXTERNAL_INPUT_REQUIRED`; a carried reference remains
`REFERENCE_CARRIED_NOT_AUTHORITY_VERIFIED`.

Invocation currency exponents keep the existing v2 range. Positive saved
cost cannot become zero through conversion; incompatible unit/price profiles
are not averaged. Missing usage cannot be invented by a projector.

Every report remains a candidate replay with qualification `NOT_ISSUED`.
Actual Gold, Threshold, source-pool licensing/privacy/isolation, DomainAuthority,
sensitive Host69, five suites, three decision workflows and independent DataGate
remain required. The complete C1/C2/C3 and M3-M7 goal is unchanged.

## Local verification and repository integration

The candidate uses the unchanged metric module from merged PR745. Run from the
repository root:

```text
python -m unittest tests.test_model_program_m2_saved_report_runner -v
```

The reviewed two-file source passed 22 independent specification cases. This
README is an integration guide, not additional test evidence. Repository
integration loads the same metric source from its repository path and appends
these cases to the existing M2 source-fixture suite, preserving all old cases,
fixed SourceLock inputs, workflow and Role definitions. Normal
Source review, claim, applicable CI and FIFO/platform merge still apply.

No actual model, training, data generation, Native grant or production operation
has been performed by this candidate.
