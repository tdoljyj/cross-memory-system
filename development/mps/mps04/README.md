# MPS-04 early D-007 candidate (non-production)

Owner authorized this bounded sequencing exception on 2026-09-21 while MPS-03
remains open. This candidate only observes the bound GitHub repository via GET
and shows D-007's `Clued Current=A / GitHub head=B` distinction in Native.
It does not merge PRs, change GitHub, change Clued Current, register a canonical
Drift record, claim G4/G6 PASS, or start MPS-05.

The non-production PostgreSQL gateway defaults to provider observation **off**.
Set `MPS04_PROVIDER_MODE=GITHUB_READ_ONLY` to enable it; the repository is fixed
server-side to `tdoljyj/cross-memory-system`, `MPS04_GITHUB_REF` must explicitly
name the bound test branch (there is no implicit `main` default), and
`MPS04_GITHUB_TOKEN` must be a fine-grained, repository-scoped credential with
Contents read-only access to that private repository; the gateway refuses to
start observation mode without it. Never commit or log this token.
The existing MPS-03 non-production target and authorization guards still apply.
No token is accepted from an Agent or Native request. Redirects, invalid exact
commits, unknown ancestry, missing comparison evidence and unavailable GitHub
all fail closed.

For this candidate, the immutable adopted Revision content must include
`repository` and `adopted_exact_commit`. A read of that Current first passes the
existing Resource × Action and object-ownership checks. The server then reads
the bound ref, compares it against that exact adopted commit, and re-reads
Current before returning so a concurrent adoption is reported as stale. The observation
includes the exact A/B identities, ancestry, source URL, and a file-name sample;
it is not persisted. No write route exists in this module.

Run local candidate checks:

```text
python -m unittest discover -s tests/mps04 -p test_*.py -v
python scripts/mps03/run_acceptance.py
```

Before any formal gate upgrade, run D-007 against the real non-production
Canonical Service and private GitHub read-only credential, capture exact
Revision/Adoption A and provider B, prove Current remains A, and obtain a fresh
independent G4 review. MPS-04/G6 additionally requires the complete frozen
contract, including canonical Observation/Drift registration and explicit
Adopt/Ignore behavior. Local mocked tests are not live evidence.
