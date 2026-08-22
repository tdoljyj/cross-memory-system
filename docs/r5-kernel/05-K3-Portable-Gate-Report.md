# K3 Portable Gate Report — PASS

- Date: 2026-08-23
- Tested product commit: `567222dccd8f51b2314b460876a4de9812aa0c74`
- Aligned pre-rebaseline head: `138ce2295f17e67347f55f7cb47a2bad0e1f38a5`
- PostgreSQL: 15.19
- Status: `K3_GATE_PASS`

## Evidence-chain repair

The historical K0 object
`951078fc173809547ed377bfe326c68b9e476ac9` was never stored on a durable
remote ref and was omitted from the handover Bundle. It is retained only as
unavailable audit metadata. No byte content or ancestry claim was fabricated.

The immutable v1 contract remains unchanged. Additive contract v1.1 anchors
the historical claim and debt-closure evidence to reachable commits and makes
only durable objects executable prerequisites.

## Verification

- Environment probe: 7/7 PASS under compliant desktop permissions.
- K1 portable contract: 9/9 PASS.
- K2 static contract: 16/16 PASS.
- K2 PostgreSQL: 20/20 PASS.
- K3 PostgreSQL: 18/18 PASS.
- Full matrix execution: 43 files executed.
- Environment-independent suites: 38/38 PASS in the complete background run.
- Five current-tree compliant reruns: 5/5 files PASS.
- Qualified aggregate: 43/43 files PASS.
- Candidate secret scan: 0 hits.
- PostgreSQL logging: `none / panic / 0 / 0`.
- Independent clean-clone adjudication at `ad8f912deefdfaecdf99ff3cd6a9f34d5957be9e`: 5/5 qualification files PASS; clean worktree.

The complete background run's four failures were execution-environment or
pre-fix assertions: sandbox permissions, frozen-v1 immutability, PostgreSQL
logging configuration, and locale-sensitive error text. Each affected suite,
plus the changed K1 suite, was rerun on the final tree in the compliant
environment and passed.

## Portability

Completion produces an annotated durable tag and a verified
`git bundle --all` with a SHA-256 manifest. Future gates depend only on the
receipt's `required_commit_objects` and never on workstation-local objects.
