# MPS-04 GitHub Provider (non-production)

Owner authorized this bounded sequencing exception on 2026-09-21. The provider
only reads the bound GitHub repository via GET, registers an exact canonical
Observation/Drift record, and shows `Clued Current=A / GitHub head=B` in Native.
It never changes GitHub or Clued Current automatically. Current can move to B
only after the user explicitly adopts that exact observation through the
existing MPS-02B CAS/idempotency/Receipt boundary. Ignore records the exact
decision without changing Current. This work does not merge a PR, claim G6
PASS before independent review, or start MPS-05.

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

The immutable adopted Revision content must include
`repository` and `adopted_exact_commit`. A read of that Current first passes the
existing Resource × Action and object-ownership checks. The server then reads
the bound ref, compares it against that exact adopted commit, and re-reads
Current before registration so a concurrent adoption is reported as stale. The
canonical observation binds object, Revision, Adoption, repository, ref, exact
A/B commits, ancestry, source digest, and candidate Revision. Native exposes
separate Adopt and Ignore actions only for an OPEN, canonically registered
observation. Stale confirmation, replay conflict, or missing source evidence
fails closed.

Run local checks:

```text
python -m unittest discover -s tests/mps04 -p test_*.py -v
python scripts/mps03/run_acceptance.py
```

The owner-origin, same-repository MPS CI job also runs these tests and,
for PRs only, calls the real private GitHub API with the job's ephemeral
`contents: read` token. It binds A and B to the PR base/head exact SHAs and
rejects a branch move during the run. The CI token is not copied to a local
runtime or persisted.

Before any formal gate result, run the exact PR head against the real
non-production Canonical Service and private GitHub read-only credential.
Capture exact A/B identity, canonical Observation/Drift registration, explicit
Ignore with unchanged Current, explicit Adopt with Revision/Adoption/Receipt,
and idempotent retry. Local mocked tests are not live evidence; G6 requires a
fresh independent review of the immutable evidence package.
