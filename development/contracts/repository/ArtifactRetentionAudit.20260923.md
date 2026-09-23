# Repository Retention Audit — 2026-09-23

Status: **READ-ONLY INVENTORY / NO DELETION AUTHORITY**  
Base inspected: `main@d0547478f20bcf95647a656f582caf200874dc3f`

## Tree shape

At the audited base:

- tracked files: approximately **7,036**
- raw tracked bytes: approximately **99.05 MiB**
- `artifacts/`: approximately **46.71 MiB**
- `docs/`: approximately **21.26 MiB**
- `scripts/`: approximately **14.36 MiB**
- `work/`: approximately **6.06 MiB**
- tracked ZIPs: **24**, approximately **27.35 MiB**

These numbers describe the current tree, not full Git-history pack size.

## Large opaque evidence probe

The largest opaque archives were checked for repository references before any cleanup proposal.

| Artifact | Approx. size | Reference observation | Disposition |
|---|---:|---|---|
| `NamingInventory-5fad76d-CI.zip` | 5.93 MiB | referenced by retained naming Evidence/Post-CI indexes | retain pending externalization rewrite |
| `OriginalEvidence.zip` (recorded-intent recovery) | 5.34 MiB | referenced by runtime-evidence README / retention metadata | retain |
| `ReferencedSourceBytes.zip` | 5.27 MiB | referenced by Step 8 source indexes, receipts, adjudication and independent review | retain |
| `Step8ValidatorEvidence_20260907.zip` | 3.38 MiB | referenced by validators, receipts, review and tests | retain |
| `NamingInventory-d7f9b29-CI.zip` | 3.19 MiB | referenced by retained naming EvidenceIndex | retain pending externalization rewrite |
| `Evidence.zip` (runtime evidence families) | 1.15 MiB class | referenced by manifests/review/verification material | retain |

## Finding

There is no safe “delete the biggest files” shortcut. Several of the largest archives participate in exact-byte or fixed-path evidence chains. Removing them without updating their immutable/external binding model would damage reproducibility or historical verification.

## Action taken

- New artifacts are governed by `ArtifactRetention.v0.1.md`.
- New opaque/binary artifacts above the review threshold require an explicit Git-retention reason.
- `work/` and `artifacts/` now have explicit non-authority README boundaries.
- Existing large evidence remains unchanged in this PR.

## Future cleanup method

A later cleanup may externalize a retained archive only when it:

1. uploads the exact bytes to an immutable/versioned artifact surface;
2. records byte count and SHA-256;
3. rewrites every live locator/Manifest/test consumer to the external binding or a retained local fixture as appropriate;
4. independently verifies that no fixed-path consumer remains;
5. removes the Git copy only in a separate reviewed change.

This audit is evidence for retention decisions, not permission to remove historical files.
