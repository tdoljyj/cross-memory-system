# M2-10 saved-output metric supplement — source candidate

This is model-program evaluation code preparation for the complete adopted
M0–M7 Task `1502fd80-8ff8-4adc-b4f5-da6d462f4f8a`. It supplements the existing
saved-output scorer with numeric aggregation required by plan §17.7. It is not
a replacement for that scorer, the complete Evaluation Harness, independent
Gold, a frozen Threshold, or any stage/product verdict.

Specification: complete v1.0.1-r1 plan, 356825 bytes, SHA-256
`a918f42e6e9de160f7b14a95afafeae9022ddcc189b3663e768aa197110118a4`.

## Existing implementation retained

The PR441 source at `e76a7db7edc6b47b5a719e165f688621efa9580a` already contains
`scripts/model-program/score_m2_core_saved_outputs.py`, blob
`76e5b197bc79a809b0366891d595c8e302ced4df`, 14271 bytes, SHA-256
`7a0a77880f6627325fbbac9390d8d880450703e8a2c7453bc95858d5e1f71ed3`.
It checks typed outputs, input-reference membership, original output hashes,
exact candidate comparison, and two deterministic replays for its fixed
synthetic development examples. That source is unchanged. This identifies an
immutable engineering input; it does not claim a current remote-main or
production state.

The supplement does not generate questions, create a Dataset, define Gold,
fit calibration or thresholds, invoke an executor/model, or issue a Receipt.
Its tests use hand-computed numerical specification examples. Any legitimate
saved-output integration must retain the existing source/input/output, split,
purpose, execution-profile and exposure bindings before projecting values
into these local arithmetic functions.

## Functions and intended integration

- `aggregate_metrics(rows, policy)` computes classification, probability,
  selective prediction, failure and observed measurement summaries.
- `quantiles(values, probabilities, method='LINEAR_R7')` computes the explicitly
  named interpolation convention.
- `ranking_metrics(queries, policy)` computes ranking only from explicitly
  supplied relevance gains, cutoff, discounts and selection-policy identity.

These Python argument structures are local arithmetic APIs, not a new model
Port protocol, Source Role or Gate. The caller must project already-validated
outcomes. Outcome strings map through an explicit policy; an unknown outcome
cannot become success. The exact predeclared request identities prevent a
caller from silently removing failed requests from the evaluated set.

| Adopted requirement | Code behavior to verify |
| --- | --- |
| §17.7 runtime failures | Preserve timeout, unavailable, budget, cancellation and invalidity counts; keep all registered requests |
| §17.7 class quality | Confusion matrix and each class's precision/recall; absent denominators are undefined |
| §17.7 probability | Sum-over-classes Brier, predeclared NLL epsilon and ECE bins; reject malformed probabilities |
| §17.7 selective prediction | All-request coverage and accepted-set frozen loss use separate denominators; zero accepted risk is undefined |
| §11.10 insufficient evidence | Missing Gold, insufficient samples and uncomputed confidence intervals remain explicit |
| §17.7 measurement | Missing latency/usage/cost remains missing; separate currencies; no simulated measurement |
| §11.8 reproducibility | Deterministic fixed-input aggregation, without mutating input or repeating inference |

The code reports arithmetic and missing evidence. It does not prove a reported
reference was actually read or supports a claim; the existing evidence
consumer must supply that proof. Schema/ref validity supplied to aggregation
cannot acquire more authority than its original evidence.

## Remaining full-scope work

All five §11.4 suites (Core, General Sanity, Safety & Privacy, Device & Runtime,
Product E2E), all three §17.9 workflows, independent licensed Gold, actual
source-pool privacy/license/deduplication and isolation, formal M0-A/B/C
dependencies/DomainAuthority, sensitive Host69, frozen Dataset/Threshold,
real fixed-output evaluation and independent DataGate remain required.

This candidate does not perform those measurements or their qualification.
The C1/C2/C3 qualification, J0, all three Stable/Activation results, full M6 and
the real M7 loop and independent final acceptance remain in the original goal.
Final-Holdout results must never become M3 selection input. No old M1, spent
experiment or device/VM authorization is reopened.

## Local verification

Use the existing Python interpreter, from the repository root:

```text
python -m unittest discover -s tests -p test_model_program_m2_saved_output_metrics.py -v
```

Actual results and reviewed source identities belong in the eventual source
review package. Tests alone do not freeze the policy or issue M2 PASS.

The existing M2 source-fixture CI suite appends these numerical specifications
through Python's standard `load_tests` hook. Its old tests remain in the suite;
an import or test failure remains a failure. Both existing CI commands run the
combined suite. Workflow, job/Role definitions, dependencies, SourceLock and the
four registered domain consumers retain their existing definitions.
