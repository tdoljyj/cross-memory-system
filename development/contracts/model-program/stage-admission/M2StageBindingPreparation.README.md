# M2 stage-binding preparation

This successor preparation and the remaining real-freeze/DataGate work belong to original Task `1502fd80-8ff8-4adc-b4f5-da6d462f4f8a`.

`python -B scripts/model-program/prepare_m2_stage_binding.py REQUEST.json` validates only source-bound metadata and the accepted purpose/role/stage/time rules. The contract is `M2StageBindingPreparation.v0.1.json` in this directory.

The five fixtures below `tests/fixtures/model-stage-admission/pr441-e76a7/` preserve exact bytes from commit `e76a7db7edc6b47b5a719e165f688621efa9580a` as **SourceCopiedRead**. The preparer hashes them and never imports or executes them. This new preparation entry is not installed into the PR441 runtime and does not change its frozen definition, schema or split mapping, M0 or M1.

Results remain `PREPARATION_VALIDATION`, execution/authority `NONE`, and M2/M3, DataGate and DomainAuthorityReceipt `NOT_ISSUED`. Local references, candidate JSON and successful policy tests cannot attest a real freeze or issue permission.

Weight learning requires `TRAINING/training`. M2 qualification uses its fixed M1-reference/deterministic baseline; the future product final holdout uses its own final product candidate. Their results cannot cross into selection. C4 still requires real reserved source/group/sampling/size/custody/access evidence frozen before selection; that freeze and independent DataGate remain unproven here. No samples, questions or holdout are generated or consumed.

Pure checks: `python -B -m unittest discover -s tests -p test_model_stage_binding_preparation.py` (27 cases).
