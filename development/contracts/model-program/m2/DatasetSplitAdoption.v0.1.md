# DatasetSplit v0.1 owner-adopted definition baseline

The Owner accepted the exact PR #441 definition/schema candidate on 2026-10-01
06:15 UTC and authorized non-production registration and wiring verification.
Existing Canonical Decision `b8c1d482-9eb4-4bc5-8dd1-372b0d55174e` v1, scope
`project:0597aa60-9b98-4da6-a4ab-63d7705b632f`, committed Receipt
`45a657d9-ba34-437e-b17c-2d792ce5c692`, records this adoption. It was independently
read back as CURRENT in the implementation session. Quote Evidence
`1257e89f-d6b6-4015-8712-0bab340cc1b4` binds the supplied six-byte UTF-8 quote
`同意`; its context and exact adopted object are in the Canonical Decision.

This is **Owner definition adoption**, not an M2-00 Domain Authority Receipt,
data admission, Kernel Gate result, or M2 PASS. The new engineering reference
issues no Receipt and performs no Canonical mutation. Offline verification cannot
establish currentness, revocation, or the validity of an arbitrary external receipt.

## Exact source and derived versions

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Adopted source `DatasetSplitDefinition.candidate.json` | 4481 | `2c8e0196c4338cf9d0c6758eb78c8d57a05a2363aacb694f1c305c602b1288ba` |
| Adopted source `schemas/DatasetSplit.candidate.schema.json` | 5835 | `f0359d6846fa6bff94994c145f7d7077132dc077054fe1b011edaf6c3789d95d` |
| Derived `DatasetSplitDefinition.v0.1.json` | 5566 | `f51cefe8eccd0faa75b45e78380e5b389ed266ca4034b511a85f51771f2d4f77` |
| Derived `schemas/DatasetSplit.v0.1.schema.json` | 6268 | `062860afd3dc16fa9ee1de27582439701a67b7c5976ad45981a7cca3e515468f` |
| Owner adoption reference `DatasetSplitOwnerAdoption.v0.1.json` | 2155 | `d60a2b463e9a6a53a9d3a82032acd3b31c2fd5f78df96ee7043ef1af489baa45` |

The source files and their recorded candidate status remain unchanged historical
bytes. Their direction-only Decision v1 and Receipt remain historical adoption
context, not a claim that the older direction receipt adopted the machine schema.
The separate exact adoption above is the authoritative Owner decision. The primary
Task execution intent still references its unchanged original governance source.

The derived definition is `clued.model-program.DatasetSplit / v0.1`, owned by
MODEL PROGRAM. Its parent/purpose vocabulary, use masks, fixed-candidate policy,
partition isolation and unsupported cross-fitting behavior are identical to the
adopted source. Derivation changes only version/status metadata, the schema
reference and added source/adoption provenance. The validator reconstructs this
exact derivation and rejects additional semantic changes.

The v0.1 instance schema changes its schema/version identity, replaces the former
null `dataset_split_ref` with the exact v0.1 definition reference, and uses
`OWNER_ADOPTED_BASELINE_BOUND_DOMAIN_RECEIPT_PENDING`. The accepted
`candidate_definition_ref` remains required as source provenance. Every other
field and constraint is retained. The owner-adopted manifest adds one exact Owner
adoption reference digest and points to the v0.1 split schema. It still has
`SYNTHETIC_OFFLINE_CANDIDATE` status and `authority_effect=NONE`; it is not a frozen
real Dataset. The fixture reuses the same public test data, never secret Holdout.

## Verify and remaining gates

```sh
python scripts/model-program/validate_m2_adopted_definition.py
python -m unittest tests.test_model_program_m2_adopted_definition -v
# Both must exit 1 until their separate prerequisites are actually available:
python scripts/model-program/validate_m2_adopted_definition.py --require-domain-authority
python scripts/model-program/validate_m2_adopted_definition.py --require-live-currentness
```

The validator uses only installed local schemas. It first verifies raw source,
derived artifact and recorded adoption identity, validates the concrete manifest
and split references, then projects only that verified version envelope into the
existing synthetic validator. All source/license, membership, lineage, duplicate,
use/exposure, fixed-candidate and selection guards are retained. Input is not
mutated; no real-data adapter, inference or training path is introduced.

`domain_authority_receipt_ref=null` remains mandatory. Existing Canonical MCP
exposes ordinary Owner Decision/Receipt capture, but no verified DatasetSplit
Domain Authority Receipt issuer has been established in this bounded workflow.
Such a receipt also needs applicable original M0-A/B/C formal-parent checks and
existing domain/Kernel authority. Do not substitute this Decision, byte checker,
or local JSON for it. Exact domain-receipt issuance/verification is a remaining
capability gate; its absence does not block the Owner-adopted synthetic wiring.

Actual data permission, PII/Secret detection, near-dedup, erasure, exposure tracking,
protected Holdout, fixed real outputs and deterministic scoring, M1-09 thresholds,
Frozen Dataset and independent Data Gate/M2-13 remain separate unmet gates. No
training, data use, paid compute, merge, deployment or M2 PASS is authorized here.
