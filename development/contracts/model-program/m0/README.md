# Clued Model Program M0 Foundation — targeted repair candidate

Bound plan: `v1.0.1` / `a918f42e6e9de160f7b14a95afafeae9022ddcc189b3663e768aa197110118a4`.

This candidate implements the M0 program foundation only. It does not authorize or perform model download, training, real-model evaluation, promotion, activation, production deployment/traffic/database/secret mutation, G1 cutover, machine RC seal, G7A, or G7P.

Key repair properties:

- required typed inputs are locally resolvable exact copies or explicit repository evidence references;
- the exact Kernel Gate Mapping and Requirement Trace are machine-readable inputs;
- M0-13 produces a real static readback verification object;
- negative fixtures are passed through validators and must be rejected with exact error codes;
- M0-04/06/10/11/14 expose separate schemas/contracts instead of relying on one prose-like pack;
- the candidate manifest covers the implementation, validator, fixtures, tests and CI workflow, excluding only itself by explicit design.

Validation:

```bash
python scripts/model-program/validate_m0_foundation.py
python -m unittest tests.test_model_program_m0 -v
```

A green CI run is implementation evidence only. Final M0 acceptance requires a fixed candidate and a fresh-context, read-only reviewer who did not modify the candidate.
