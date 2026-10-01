# M2 synthetic dataset foundation candidate

This is an independently executable, offline first slice for plan **v1.0.1**, SHA-256
`a918f42e6e9de160f7b14a95afafeae9022ddcc189b3663e768aa197110118a4`.
It prepares part of M2-01/02/08/09; it does **not** close those tasks or issue M2 PASS.

## Run

Use Python 3.12+ and the existing `jsonschema` dependency (Draft 2020-12):

```sh
python3 scripts/model-program/validate_m2_dataset_foundation.py
python3 scripts/model-program/validate_m2_split_mapping.py
python3 -m unittest discover -s tests -p 'test_model_program_m2_*.py' -v
python3 -m unittest discover -s tests -p 'test_model_program_m1_harness.py' -v
```

The first command is deterministic and read-only. It accepts an optional local
`--fixture` JSON path; it performs no downloads, storage writes, model calls,
training, deployment, or paid work. Success means
`PASS_SYNTHETIC_OFFLINE_CHECKS_ONLY`, with `m2_verdict=NOT_ISSUED` and
`training_or_data_use_authorized=false`.

## Included checks

- Closed candidate schemas for source/license metadata, sample lineage and
  split metadata, and selection-report bindings
- Source/snapshot/sample/manifest digests, exact split membership, unique IDs,
  acyclic parent references, and no cross-split lineage
- Fail-closed rejection of public, commercial, product-feedback, enterprise,
  prohibited, unknown-license, withdrawn, or declared private/secret inputs
- Exact content duplicates and cross-split declared source-session,
  source-project, and semantic-near-duplicate groups
- Declared holdout-use and consumer isolation, exposure/old-fixture relabeling
  rejection, calibration-fit/selection separation, and selection-report checks
  that reject holdout inputs even when the report contains only score digests
- Repeated identical metadata validation, strict duplicate-key/non-finite JSON
  rejection, sanitized error codes, and positive/negative unit tests

## Explicit limits

The six arithmetic samples are public-to-the-reviewer **test fixtures**. The
holdout-marked fixture exercises policy logic; it is not an unseen or secret
holdout. Source declarations and exposure records are caller-supplied test data,
not independently attested facts or authorization. The checker does not detect
undeclared private data, secrets, prior exposure, or semantic similarity. It checks
declared near-duplicate groups, not a real near-duplicate detector. Digest checks
detect inconsistencies within the supplied candidate; a caller can rewrite a
candidate and recompute its digest. No trusted frozen identity or authority is
created. Parse/scrub/erasure/scorer revision markers are not implementations.

The six `purpose_description` strings are the plan's logical-use descriptions.
They are **not** a replacement DatasetSplit enum. Every candidate split has
`dataset_split_ref=null` and `domain_mapping_status=UNRESOLVED`. Per-use booleans
are local synthetic guard inputs, not a published data-domain contract. The
calibration/selection implementation is deliberately conservative: it accepts
isolated partitions only; preregistered cross-fitting is not implemented.

M0-A Taxonomy/Schema, M0-B Prompt/Config, and M0-C Gold/Threshold/Harness remain
read-only upstream domains. This slice does not copy, modify, execute, or
reinterpret those definitions. Use the existing
`scripts/information-flow/frozen-parent-adapter.mjs` for original-byte identity
checks. Its `PASS_SOURCE_BINDING_ONLY` result is not model acceptance or a Domain
Authority Receipt. Formal packages remain external dependencies; do not commit
them under this directory.

## Remaining gates

1. Resolve the authoritative DatasetSplit/domain mapping and complete the
   applicable M2-00 Domain Authority Receipt after original-byte checks
2. Independently review actual source licenses, use scope, opt-in/withdrawal,
   tenant isolation and erasure; this fixture allowance grants none of them
3. Implement actual ingestion, parsing, scrub, near-dedup, curation, exposure
   tracking and protected holdout access through approved domain contracts
4. Bind upstream Gold, frozen Eval/scorer/renderer/schema/policy revisions and
   saved actual outputs, then perform deterministic scoring replay
5. Bind M1-09 before M2-11 thresholds; complete Frozen Dataset, independent
   Data Gate and M2-13 against M1 PASS before any formal M2 verdict

The source-bound mapping proposal and domain-owner decision are documented in
[DatasetSplitMapping.candidate.md](DatasetSplitMapping.candidate.md). Its local
synthetic profiles bind each purpose to the full use mask and holdout flag; they
retain UNRESOLVED domain mapping and grant no data-use authority.

The existing M1 harness CI also runs the M2 checks and tests. Storage, Canonical,
runtime and device configuration remain outside this candidate work package.
