# Vendored IF-MVP0-C security fixtures

Byte-identical copies of the eight security fixtures (`corpus/security/SEC-001`
… `SEC-008`: `input.json` segment, `output.json` candidate document,
`expectation.json`) from the frozen M0-C parent
`Clued_Information_Flow_M0C_Frozen_0.3.2-m0c_r3` (release
`information-flow-m0-frozen-archive-20260908`, transport zip SHA-256
`06c1eb9414b09e367a96e267cd96dca3d94044ef02ccd9bd59a458ec8dacaed9`; delivery root, i.e. parent
`SHA256SUMS` SHA-256
`d46ae622dc19d2355a92af4b0eacdd15756a8eeeb775c0a6bff0e9c5537fb7c1`).
`SHA256SUMS.m0c-subset` holds the matching lines of the parent's own
`SHA256SUMS`, unchanged. Never edit these files.

Contract `../../M0DCloseout.v0.1.md` §5.2 reuses the SEC-001…008 texts as
runtime inputs (E2E-06). They are checked by
`apps/clued-cloud/tests/information-flow-intake-transport-db.test.mjs`.
