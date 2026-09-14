# Status27 completion

The package already contains the final P2-signed artifacts:

- `Status27SignatureEvidence.json`: SHA-256 `54a8dfdeb553266ddc83842d523869ab65488d73f2356645a87a3a3ce26664e4`
- `Status27Generation.json`: SHA-256 `186879980141db38eb14bd9ee5ced915c9ab37f91d290e822addd22288c5e485`

The signature evidence binds the exact P2 merge and unsigned payload; the full Status points only to
that signature evidence. It contains no P3 coordinate or full-Status back-reference.

Verify deterministically:

```sh
node work/recovery-root9/postbudget-cas-p3/build-status27-completion.mjs \
  --repo-root "$PWD" \
  --p2-publication-evidence work/recovery-root9/postbudget-cas-p3/P2PublicationEvidence.verified.json \
  --verify-only
node work/recovery-root9/postbudget-cas-p3/status27-completion-negative-tests.mjs --repo-root "$PWD"
```

These commands are offline and perform zero live writes.
