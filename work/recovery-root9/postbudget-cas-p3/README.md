# Root9 post-budget CAS P3 publication candidate

Status: `OFFLINE PASS / NOT SEALED / NOT APPLIED`

This package publishes the real P2-signed Status27 artifacts and an atomic, append-only Root9 repair.
It performs no live operation by itself.

## Frozen chain

- P2 merge/tree: `20d6ec1e62eebed26e56bc2e4f52eed87704e8ab` /
  `54c448837711086bcf0e334de4c6acc97c1f338f`
- P2 evidence SHA-256: `dec179df0626c5f22bb33a979336430dd136c8a54895666bae2ce4b2b0eae887`
- Status27 signature evidence: `54a8dfdeb553266ddc83842d523869ab65488d73f2356645a87a3a3ce26664e4`
- Full Status27: `186879980141db38eb14bd9ee5ced915c9ab37f91d290e822addd22288c5e485`
- Canonical S: `c3fd1848edbd0b186cb0ba259cb3e8d739bcb3f0dac25754985133de68813a06`
- Pending budget remains event 102, 600 seconds / 134217728 bytes.

The one-way chain is P2 publication evidence → signature evidence → full Status27. P3 publishes
those existing bytes; no P3→signature→Status cycle and no P4 are required.

## Offline verification

Run from a complete P2+P3 repository checkout:

```sh
node work/recovery-root9/postbudget-cas-p3/verify-stage-p3.mjs --repo-root "$PWD"
node work/recovery-root9/postbudget-cas-p3/stage-p3-negative-selftest.mjs
node work/recovery-root9/postbudget-cas-p3/verify-full-reserve-gate.mjs
node work/recovery-root9/postbudget-cas-p3/verify-seq102-inheritance.mjs
node work/recovery-root9/postbudget-cas-p3/status27-completion-negative-tests.mjs --repo-root "$PWD"
sha256sum -c work/recovery-root9/postbudget-cas-p3/SHA256SUMS.txt
```

The package is self-contained for the exact live `reserve_gate` preimage and P2 fixtures.

## Post-merge seal and one live submission

1. Owner merges the exact P3 payload into `main`.
2. Produce final P3 publication evidence from the real two-parent Verified merge.
3. A fresh independent reviewer emits an actual `PASS_NO_BLOCKERS` object with B0/M0/m0.
   The included review template has no authority and cannot pass.
4. Publish those two exact JSON bytes as Git blobs on a dedicated postmerge evidence branch; do not
   merge them into `main`. Read both blobs back and recompute SHA-256 and Git blob SHA-1.
5. Run `reserve_gate.preflight-catalog-token.readonly.sql` and `preflight_readonly.sql`. Continue
   only on exact PASS.
6. Seal the six Gate inputs with `build-full-reserve-gate.mjs`: P3 URI/SHA, review URI/SHA,
   correction-evidence PostgreSQL-jsonb SHA, and pre-catalog SHA. Insert its exact sealed wrapper in
   the already-present first transaction position and seal all CAS/readback placeholders.
7. Independently re-run all checks, then submit the SQL exactly once.

The transaction first replaces `clued_control.reserve_gate(text,text)` under exact source,
catalog, owner/config and ACL pins, then appends Status27 and events 103/104, and updates only
`execution_current.sequence` 102→104. Any failure rolls back the function replacement and all
CAS writes. It never refunds, adds capacity, creates another allocation, changes pending sequence
102 or changes charged totals 11106 / 2470030259.

For any uncertain response, do not resubmit. Follow `UNKNOWN_RESPONSE_PROTOCOL.md` and perform
read-only exact classification first.
