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
isolated partitions only; preregistered cross-fitting is not implemented (Task `1502fd80`).

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

## Gold provenance and accepted M1 reference candidate

`validate_m2_gold_reference.py` binds the accepted M1-09 v1.0.2 matrix at
`c454d8dfe6b8a216eb2eee5fda39550ea2ac0f82` to its exact Git blob
`4d86c3e6852f0190e2a19a4226182453850fab94`. The fixture is a byte-preserved
read-only machine source snapshot, not a new M1 registry or acceptance decision.
The matrix's pre-review wording stays unchanged; later acceptance is recorded
in Canonical State `50f24568-fd32-4632-8cb7-aa7ac31f84df` v2. Offline checks do
not independently establish currentness. M1 is a PC reference baseline, never
a teacher-quality winner, M2 quality threshold or fresh execution permission.

Every synthetic label binds its exact rule/source revision, input, answer, Gold
revision, annotator and adjudication evidence. Unresolved/disputed labels, stale
evidence, missing sources and same-identity reviews fail closed for consumption.
The named annotator/reviewer are synthetic role stand-ins; differing strings do
not authenticate independent people or runs. These arithmetic examples do not
create Clued Core Gold. Real Gold, domain permission, independent review,
holdout lock and threshold references remain null.

Upstream source checks reuse the pinned `frozen-parent-adapter.mjs`, with all
three original parent roots; missing parents cannot fall back to the toy rule.
The candidate normalized upstream leaf interface is not an adopted M0-C format
or semantic mapping. Original packages are never modified. Source-byte checks
alone issue no domain or data authority.

```sh
python scripts/model-program/validate_m2_gold_reference.py
python scripts/model-program/validate_m2_gold_reference.py --require-formal-gold
python -m unittest tests.test_model_program_m2_gold_reference -v
```

The formal command must exit 1. No actual annotation, independent adjudication,
protected holdout, threshold freeze or DataGate is issued; no M1/model run,
credentials, permissions, training, paid inference or production changes occur.


## First Core pilot: development candidates only

Owner approved preparation of 72 fresh source-class C synthetic cases on
2026-10-02 06:16:20 UTC (Decision `ad2ba16d-e0f7-480d-ba69-36b417e1b65a`,
Receipt `aa9209df-72ce-47e8-b2c5-e8e806193d82`). `CoreSyntheticPilot.candidate.json`
reserves 18 cases each for utterance cards, card chains, imprints and Context:
six per domain per development/qualification/final-holdout boundary. Only the
24 development candidates are materialized. No qualification or holdout content,
seed, answer, or generator is included; they remain NOT_GENERATED until actual
independent custody/access controls and review roles are admitted. A same-account
agent, process, directory or public fixture is not a protected holdout.

`core-development-candidate.json` contains six explicit single-claim extraction
cases (fact/preference/decision/task/status/uncertain), six directed local dependency
suggestions, six two-source agreement/conflict cases, and six declared Context
match/stale/unknown/scope-mismatch/revoked/missing-grant cases. Every row binds
its input, answer candidate, source and deterministic rule. Source IDs are fictional
provenance labels, not service Evidence IDs. Model and tool calls are zero.

The existing frozen-parent adapter reverified all A/B/C roots and their 35/12/159
original files in this request. The original release ZIP hashes matched. The
utterance input and candidate output bind the byte-identical vendored M0-A schemas;
the other three domain mappings are local candidate rules, not adopted Core
taxonomy or a formal M0-C Gold revision. The upstream extractor keeps source
quotes exact and treats assistant claims as claims, not verified external facts.
This pilot preserves those boundaries, suggestions and conflicts. It covers a
small structured subset rather than full Core semantics, safety or product E2E.
The offline validator does not attest live currentness or formal parent lock.

Role slots remain unassigned and all formal authority references are null.
The current authenticated development-context list returned no readable contexts;
this is scoped capability evidence, not proof that none exist globally. Existing
Native membership/authorization routes can be reused only after actual principals,
resource versions, actions and revocation checks are verified. Owner can review
the visible dev candidates via the established conversation/Canonical decision
path; that is not yet an independent Gold or holdout-custody grant. No new account,
credential, permission, ACL or storage root is installed by this package.

Run `python scripts/model-program/validate_m2_core_synthetic_pilot.py` to reproduce
the 24-case candidate check; `--require-formal-gold` fails closed. Review/source/
answer tampering and rehashed revisions are rejected. There is no held-out
generation switch. No model execution is authorized. Independent semantic review,
full Core mapping, protected split generation, Gold, thresholds and DataGate remain
separate gates; M2 remains NOT_ISSUED.


### Fixed-head semantic review corrections

The review of `ff66cc54163b9604bdc1c992cdb3141b8c699bc1` identified four
candidate semantics/evidence issues. Context now includes a visible, context-only
JSON policy message with expected scope and declared currentness/grant/revocation
requirements. Its canonical JSON digest is bound by the contract; missing or
changed policy is rejected. Answers derive from that input policy, not a hidden
target. It remains synthetic declared matching, never live authorization.

Imprint inputs state the same subject, named single-valued attribute and effective
time before comparing the two assistant claims. Missing, different or multivalued
premises return an ambiguous conflict (`null`) and preserve both claims rather
than inventing a contradiction. None establishes external truth.

Utterance `uncertainties` contains only semantic uncertainty: cases 01-05 are empty;
06 retains the meaning ambiguity of “更轻的呈现”. Production/review state stays in
`review`. The existing confidence value 0.5 is explicitly an uncalibrated schema
placeholder, not a model confidence estimate, calibration result or quality score.

`rule_implementation` binds the implementation path, revision and SHA-256 of the
complete raw Python file bytes, without newline/JSON normalization. Each source
and `evidence.rule_sha256` references those bytes, not a rule-name string. The
implementation contains no embedded self-hash or contract/fixture digest: the
contract binds implementation; samples bind both, so there is no hash cycle.
Changes require regenerated contract/fixture bindings. Three-domain mapping and
independent Gold/holdout/authority gates remain candidate/pending. Card-chain
direction, source quotes and non-execution semantics are retained.

### Input-only Core development envelope

`CoreInputEnvelope.candidate.json` and `validate_m2_core_input_envelope.py`
separate the 24 public development inputs from the author-visible source bundle.
The validator first reuses `validate_m2_core_synthetic_pilot.validate`, preserving
its exact semantics, license declarations, schema and raw rule-source bindings.
It then checks the committed `core-input-envelope.json` against a fresh projection:
sorted sample ID, domain, DEVELOPMENT partition, exact segment input and input
digest. The envelope binds the complete source bundle revision, source contract
and rule bytes. Candidate answers, review metadata and executable commands are
absent from each request. Adding them, changing input, relabelling a partition,
duplicating/reordering requests, or forging a binding fails even after rehashing.

Source message roles, including the visible Context policy's `system` role, are
untrusted task data. They supply no model system/developer authority and must not
be promoted into chat roles. This contract defines an offline input projection;
it contains no model adapter, prompt selection, dispatch or execution permission.
Its revision digest is a local fixture identity, not a service Receipt or grant.

```sh
python scripts/model-program/validate_m2_core_input_envelope.py
python scripts/model-program/validate_m2_core_input_envelope.py --require-call-admission
python -m unittest discover -s tests -p 'test_model_program_m2_core_input_envelope.py' -v
```

The ordinary command validates only this payload. The admission command always
exits 1 with `CORE_INPUT_CALL_ADMISSION_REQUIRED`: no exact model-call Profile,
formal domain permission or live authorization is bound. The CLI emits scope and
digests rather than payloads or answers. Existing M2 CI test discovery covers the
new regression suite without a workflow or runner change.

| Subject | Reproducible repository evidence | Remaining gate on original Task `1502fd80` |
| --- | --- | --- |
| Public Core dev inputs | 24 exact input projections; current source validator replay | Model prompt/adapter/Profile and exact execution authorization |
| Source lineage and license | Source-class C, declared synthetic review scope, source/rule/schema digests | Formal source issuer/currentness and applicable real-data license clearance |
| Split boundary | DEVELOPMENT only; other partitions and rehashed input substitutions rejected | Qualification 24 and holdout 24 remain NOT_GENERATED under Decision `ad2ba16d-e0f7-480d-ba69-36b417e1b65a` |
| Scoring replay | Existing offline pipeline's six public arithmetic/context fixtures and saved-output scorer | Actual model outputs, independent Gold and accepted evaluation revisions |
| Acceptance | Local deterministic candidate checks | Threshold freeze, independent DataGate and complete AgentHost qualification; M2 NOT_ISSUED |

The 72-case pilot is a preparation allocation, not 72 materialized samples or a
claim of final sample sufficiency. This addition leaves the reviewed 24 dev source
inputs/answers, three-domain limited semantics (Decision
`02660a88-1fbc-4ad7-9e84-501b8312e772`), existing scorer and protected-data boundary
unchanged. It issues no independent Gold, license, model or installation authority.
