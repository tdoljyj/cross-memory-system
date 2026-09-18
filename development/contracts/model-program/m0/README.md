# Clued Model Program M0 Foundation — targeted repair successor candidate

Bound plan: `v1.0.1` / `a918f42e6e9de160f7b14a95afafeae9022ddcc189b3663e768aa197110118a4`.

This candidate is a NON-PRODUCTION M0 foundation successor to reviewed commit `83772fc14f07421ac62e045ad7ffc92106e00850`. It does not authorize or perform model download, training, real-model evaluation, promotion, activation, production deployment/traffic/database/secret mutation, G1 cutover, machine RC seal, G7A, or G7P.

Key repair properties:

- M0-00 governance is an explicit digest chain: independent plan-review receipt → PlanReviewAttestation → Owner Adoption → Current Readiness Recheck → NON-PRODUCTION M0 Authorization;
- required typed inputs are locally resolvable exact copies or explicit repository evidence references;
- Requirement Trace and Kernel Gate Mapping are hash-bound and their MODEL rows are compared structurally;
- Gate Set validation rejects bare IDs, fake definition-set digests, version/content drift and unregistered gates;
- Draft 2020-12 JSON Schemas are executed before semantic validators for schema-bound qualification cases;
- Tier-set Manifest/Readiness, Object Authority and Independent M6 Review have explicit machine validators;
- negative fixtures are executed through validators with exact error codes and unknown validators fail closed;
- SHA256SUMS is closed-world: every M0 contract/schema/registry/governance/evidence/release/upstream file plus validator, fixtures, tests and workflow must be present exactly once.

Validation:

```bash
python -m pip install --disable-pip-version-check jsonschema==4.25.1
python scripts/model-program/validate_m0_foundation.py
python -m unittest tests.test_model_program_m0 -v
```

A green CI run is implementation evidence only. Final M0 acceptance still requires a fixed successor commit and a fresh-context, read-only reviewer who did not modify that successor.
