# DatasetSplit mapping proposal and source boundary

This engineering candidate addresses the next offline part of M2-00/08/09.
It does not close these tasks. `DatasetSplitMapping.candidate.json` and its
validator bind plan v1.0.1 (356,825 original bytes, SHA-256
`a918f42e6e9de160f7b14a95afafeae9022ddcc189b3663e768aa197110118a4`),
§11.5–11.6 lines 2648–2670 and §11.10 lines 2709–2728. Line coordinates
include original line endings in the range digests. No original plan or formal
M0-A/B/C package is reproduced here.

## Mapping candidate

The proposed boundaries below are descriptions, not DatasetSplit enum values.
Every official `dataset_split_ref` remains null and mapping remains UNRESOLVED.
The Owner has accepted the four-boundary/development-isolation direction only.
The new [machine definition candidate](DatasetSplitDefinition.candidate.md) binds
that exact direction Decision/Receipt and adds local parent/purpose identities to
the synthetic manifest. It remains unadopted; these identifiers are not claimed
as a published domain enum.

| Plan logical purpose | Proposed existing boundary | Synthetic guard restriction |
| --- | --- | --- |
| Training | Existing training dataset | Weight learning only |
| Development | Existing development dataset | Prompt/architecture exploration and selection |
| Calibration fit | Isolated fit partition within existing development boundary | Calibration fit only |
| Selection/policy validation | Separate selection partition within existing development boundary | Selection only |
| Qualification | Existing qualification dataset for a fixed candidate | No training, tuning, calibration fit or selection |
| Final Holdout | Existing final holdout for a fixed candidate | No training, tuning, calibration fit or selection; final verifier only |

Placing fit and selection partitions within development is a proposal, inferred
from the plan's requirement to preserve training/development/qualification/final
isolation. The plan does not name their authoritative parent enum values. The
local profiles are deliberately restrictive: no cross-fitting, development is
treated as selection-exposed, and all six partitions remain separate. Allowed-use
booleans are test policy inputs; they do not permit any actual data or model use.

The new checks bind each purpose to its complete use mask and final-holdout flag.
They reject unknown purposes and qualification mislabeled as selection data.
Only development/selection reports can feed the synthetic selection checker.
Existing declared lineage, group, exposure and holdout guards still apply. This
does not implement privacy scanning, semantic deduplication, exposure attestation,
fixed-candidate qualification or protected holdout access.

## Original-byte check

Run `python scripts/model-program/validate_m2_split_mapping.py --plan <original>`
with the externally obtained original. It verifies full bytes and both ranges;
`PASS_SOURCE_BINDING_ONLY` proves that plan identity, not domain authority.
Without the original it explicitly reports `NOT_RUN_ORIGINAL_REQUIRED`; CI
checks the candidate only. Reconstructed summaries, changed line endings, BOMs,
missing files and arbitrary same-size text fail the source check.

## Domain-owner decision prepared

The repository search found no authoritative DatasetSplit definition. M0's
VocabularyObjectAuthorityRegistry declares M0-A/B/C as external read-only inputs;
the plan describes logical uses but explicitly declines to create an enum.
Historical package digest checks are not a Domain Authority Receipt and cannot
settle this mapping.

Further bounded source investigation verified all 35/12/159 declared files of
the original A/B/C release and located the ownership registry: Dataset registries
belong to MODEL PROGRAM. No DatasetSplit schema or Domain Authority Receipt
definition was found in those verified sources. These bounded findings support
treating the unresolved mapping as a candidate model-domain contract implementation
gap; they do not establish global absence or require rewriting IF parents.

See [DatasetSplitDomainDecision.candidate.md](DatasetSplitDomainDecision.candidate.md)
for the source scope, four data boundaries/six logical uses, recommended isolated
fit/selection partitions within development, and one precise Owner decision.
Any newly supplied authoritative definition takes precedence after verification.
The direction Decision is `46d3e8e1-81f7-43af-aa46-11a37a1fd584` v1; its real
Canonical mutation receipt records direction assent, not definition adoption.
Until exact definition adoption, independent review and a scoped existing-authority receipt
are bound, mapping remains UNRESOLVED. Approving further candidate work cannot
replace domain adoption or formal-package authority checks.

Before formal M2: original M0-A/B/C revalidation and Domain Authority Receipt;
actual license/privacy/erasure review; actual ingestion/curation/dedup and protected
holdout; Gold/scorer/renderer/policy bindings and saved-output replay; M1-09 before
M2-11; frozen dataset and independent Data Gate; M1 PASS plus full M2-13 review.

## CI and resource scope

The existing `model-program-m1-harness.yml` now runs M2 candidate validators and
tests in both trusted self-hosted and untrusted hosted jobs. Its existing pool,
actor guard, concurrency cancellation and dependency version remain intact.
The exact-byte-bound M0 workflow remains unchanged. These are serial lightweight
Python checks without DB, ports, model calls or shared Storage resources.
