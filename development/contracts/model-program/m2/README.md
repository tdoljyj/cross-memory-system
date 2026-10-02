# M2 synthetic dataset foundation candidate

## Bounded offline pipeline candidate

`OfflinePipeline.candidate.json` binds deterministic source-class C fixtures,
finite input/Gold scrub rules, normalized exact and lexical connected-component
deduplication, language/domain/risk/quality labels, adopted DatasetSplit v0.1
references, and contamination comparisons against the known public fixture corpus.
No external corpus is ingested. All generated samples stay in DEVELOPMENT.

Run `python scripts/model-program/validate_m2_offline_pipeline.py` and
`python -m unittest tests.test_model_program_m2_offline_pipeline -v`.
The existing M2 CI discovery includes these tests. The fixed
`tests/fixtures/model-program-m2/offline-pipeline-saved-outputs.json` is an
author-generated synthetic scoring fixture, never a model evaluation result.
Two scoring passes bind the same input, contract, implementation and saved bytes;
`offline-pipeline-evidence.json` records the reproducible result and digests.

Finite rules and token Jaccard are bounded preparation tools, not complete privacy
or semantic duplicate clearance. Gold is not independently reviewed, public
fixtures are not protected holdout material, and no frozen Eval/Threshold,
IndependentDataGate or DomainAuthorityReceipt is issued. M2 remains NOT_ISSUED.

The additional [domain-recognition contract and read-only adapter candidate](DatasetSplitDomainRecognition.candidate.md)
exercise producer, scoped permission and existing M1 Record/Event/Receipt bindings
with a synthetic service double. Run
`python scripts/model-program/validate_m2_domain_recognition.py` and
`python -m unittest tests.test_model_program_m2_domain_recognition -v`.
No real producer/permission is registered: `--require-domain-authority` must fail.
This does not change the adopted definition or issue a Domain Authority Receipt.

The current definition baseline is the Owner-adopted
`clued.model-program.DatasetSplit / v0.1`. See
[DatasetSplitAdoption.v0.1.md](DatasetSplitAdoption.v0.1.md) for exact source and
derived digests, the real Canonical adoption Receipt, and the separate pending
Domain Authority Receipt gate. Verify its non-production synthetic wiring with:

```sh
python scripts/model-program/validate_m2_adopted_definition.py
python -m unittest tests.test_model_program_m2_adopted_definition -v
```

The original candidate artifacts and commands below remain reproducible historical
source checks. Their `NOT_ADOPTED` result describes that candidate path; the new
v0.1 path reports Owner baseline adoption while keeping domain receipt and actual
data authority pending. Neither path issues M2 PASS or performs live Canonical reads.

This is an independently executable, offline first slice for plan **v1.0.1**, SHA-256
`a918f42e6e9de160f7b14a95afafeae9022ddcc189b3663e768aa197110118a4`.
It prepares part of M2-01/02/08/09; it does **not** close those tasks or issue M2 PASS.

## Run

Use Python 3.12 and `jsonschema==4.25.1`, matching the existing CI pin. Its
transitive `referencing` package resolves the installed local Draft 2020-12 schema:

```sh
python3 scripts/model-program/validate_m2_dataset_foundation.py
python3 scripts/model-program/validate_m2_split_mapping.py
python3 scripts/model-program/validate_m2_dataset_split.py
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
- A machine DatasetSplit candidate with four parent boundaries and six purposes,
  exact definition/schema/direction-source bindings and declared fixed-candidate
  evaluation references; fit and selection remain isolated development partitions

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

See [DatasetSplitDefinition.candidate.md](DatasetSplitDefinition.candidate.md) for
the new machine contract and the recorded direction-only Decision/Receipt.
`DatasetSplitDomainDecision.candidate.md` remains the unchanged v0.1 proposal source;
its historical unchosen-Owner wording does not override the later Canonical Decision.
The historical candidate schema/definition path remains **not adopted**. The separate command
`python3 scripts/model-program/validate_m2_dataset_split.py --require-adoption`
must fail with `DOMAIN_ADOPTION_REQUIRED`; ordinary candidate success supplies no
data-use or training permission.

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
The bounded original-parent investigation and one-decision proposal are in
[DatasetSplitDomainDecision.candidate.md](DatasetSplitDomainDecision.candidate.md).

The existing M1 harness CI also runs the M2 checks and tests. Storage, Canonical,
runtime and device configuration remain outside this candidate work package.


## Offline dataset and evaluation revision binding

The synthetic offline pipeline seals separate dataset and evaluation revisions.
Dataset identity includes raw/curated content, split index, candidate Gold and
scrub/dedup/contamination evidence. The evaluation revision binds that dataset,
implementation, contract, scorer and renderer. Saved synthetic outputs must name
both exact revision digests; missing, stale or cross-dataset bindings fail closed.
The CLI verifies the committed evidence package against a fresh deterministic
replay (or the explicit `--evidence` path), including saved-output bytes and scores.
Missing evidence, a wrong digest or a rewritten package fails with exit code 1.

These are local candidate content identities, not trusted attestations or an
independent freeze. Independent Gold, protected holdout, actual model evaluation,
frozen thresholds, DataGate and domain authority remain unissued/unverified.
Regenerate changed synthetic fixtures and evidence together before validation;
recomputing a digest alone does not pass source-bound package verification.

## Synthetic withdrawal propagation

`validate_m2_withdrawal.py` replays a complete caller-declared synthetic event set
against the existing pre-withdrawal foundation fixture. Events bind the exact
baseline, source revision and raw snapshot. Withdrawal, deletion and license
invalidation propagate through the validated sample DAG, including cross-source
derivatives. The impact report retains historical identities, lists affected
snapshots/splits and direct/derived invalid samples, and preserves unaffected
sample IDs. Any invalid member makes the original dataset unavailable and requires
an explicit rebuild; the retained subset is never silently issued as a new dataset.
Repeated identical events are idempotent; conflicting IDs, missing bindings,
invalid lineage and stale or rewritten reports fail closed.

```sh
python scripts/model-program/validate_m2_withdrawal.py
python scripts/model-program/validate_m2_withdrawal.py --require-available
python -m unittest tests.test_model_program_m2_withdrawal -v
```

The first command emits impact evidence. The second must exit 1 for the committed
withdrawal fixture. `--impact PATH` verifies a saved report by full deterministic
replay, including unavailable state. An empty event set only leaves an unchanged
candidate; it never grants training or data-use authority. This is a pure offline
candidate for plan sections 11 and 19.2, not an authenticated withdrawal log,
physical erasure service, model-impact review or untraining claim. Event completeness
is caller-declared; omitting a real event cannot be detected by this synthetic tool.
No actual data, weight, source registry, frozen revision or online authority changes.
The existing baseline validator still rejects already withdrawn/private sources.
Independent Gold, protected holdout, threshold freeze, DataGate and real domain
authority remain unissued; M2 is NOT_ISSUED.
