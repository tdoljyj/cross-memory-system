# DatasetSplit machine contract candidate v0.1

This is a reviewable model-domain definition candidate, not a published domain
enum or adopted authority. `DatasetSplitDefinition.candidate.json` has identity
`clued.model-program.DatasetSplit / v0.1-candidate`. The sealed domain reference
binds its original UTF-8/LF bytes and the standalone instance schema. The manifest
binds that domain reference; every split binds the same exact definition digest.

| Candidate parent boundary | Candidate logical purpose IDs |
| --- | --- |
| `TRAINING` | `training` |
| `DEVELOPMENT` | `development`, `calibration_fit`, `selection_policy_validation` |
| `QUALIFICATION` | `qualification` |
| `FINAL_HOLDOUT` | `final_holdout` |

These identifiers are local candidate vocabulary. They do not claim to be the
existing authoritative enum that plan §11.10 requires binding before formal M2.
Fit and selection may share the development parent but may not share a partition,
sample, declared isolation group or lineage across partitions. Cross-fitting is
outside this minimum candidate. Selection-exposed calibration samples fail closed.

Each instance contains split identity/revision, exact candidate-definition ref,
parent/purpose, experiment scope, consumers/use mask, declared exposures,
membership and erasure-propagation reference. Sample/source/revision and grouping
remain in the enclosing manifest. Qualification and final Holdout additionally
require a candidate digest plus calibrator, threshold policy, workflow, scorer,
prompt and schema revisions. They use only their respective synthetic verifier;
declared prior exposure/relabeling is rejected. These are metadata bindings, not
attestation of a real fixed candidate, actual erasure or protected data access.

## Accepted direction and authority boundary

The Owner's 2026-10-01 direction assent is captured through the existing Canonical
Store: Decision `46d3e8e1-81f7-43af-aa46-11a37a1fd584` v1, Receipt
`fd2576dc-a0c2-4769-aab8-b8d88abd967a`, quote Evidence
`900b52e3-ff19-46b9-a214-421b66a3b7a8` (33 UTF-8 bytes, SHA-256
`53cdbb01ccff8875b0b110d507c5316dd169724b3a284b2818086bcdc117f211`).
The corresponding direction document v0.1 at commit `7cdda75a` remains unchanged:
6,957 bytes, SHA-256 `182767f2be090681420ab43f75639158420a2a42cecc8efedfcaad5ed6e85ef1`.
This identifies the direction's source, not acceptance of every paragraph or of
the new machine schema. The earlier decision document is a fixed proposal source;
its unchosen-Owner wording is historical. Current acceptance is the Canonical
Decision above, not a rewritten copy of that source.

`DatasetSplitDomainReference.candidate.json` is a typed engineering reference to
those real existing receipts. It issues no receipt and performs no Canonical write.
The offline validator verifies the installed references/bytes, without a live
currentness/revocation read. It keeps `domain_authority_receipt_ref=null`,
`domain_adoption_status=NOT_ADOPTED`, formal refs null and mapping `UNRESOLVED`.
`--require-adoption` exits nonzero with `DOMAIN_ADOPTION_REQUIRED`. A direction
receipt, boolean, arbitrary UUID or accepted-looking JSON cannot bypass this gate.

After independent review, exact machine-definition adoption must be captured
through the existing authority mechanism, read back with its current scope and
version, and bound to the definition/schema bytes and affected parent sources.
That is a separate, explicit subject from direction assent. The current candidate
has no formal-adoption path and cannot authorize data use, training, model calls,
paid compute, production deployment, merge or M2 PASS. An applicable M2-00 receipt
also requires its other formal-parent checks; this definition alone cannot supply it.

## Verify

Run the three M2 validator CLIs and the existing M2 unittest discovery listed in
the README. New tests cover wrong parents/purposes, missing instance identities,
changed definition/schema/direction digests, fake adoption, incomplete evaluation
bindings, calibration/selection contamination, qualification exposure and the
explicit missing-adoption exit. Existing synthetic checks remain required.
