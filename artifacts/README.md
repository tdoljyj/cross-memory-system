# Artifacts retention boundary

`artifacts/` stores machine-verifiable evidence, published repository snapshots, migration evidence and validation outputs that must remain bound to repository code or review history.

It is **not** a general document archive and it is not an online Canonical Store.

## New artifact policy

For new evidence:

1. Keep small, reviewable manifests, receipts, hashes, summaries and deterministic fixtures in Git when they are required by tests, review or release.
2. Prefer GitHub Release assets, governed object storage, or the Clued document center for large raw archives/binaries that do not need to be checked out on every clone.
3. When bytes live outside Git, keep an immutable locator plus SHA-256, byte count, producer/version and authority/status boundary in Git.
4. Do not duplicate the same large source/evidence bytes under multiple repository paths merely to preserve stages.
5. Historical artifacts already committed are grandfathered until an explicit migration proves they can be externalized without breaking reproducibility, audit or fixed-path consumers.

A filename containing `final`, `accepted`, `current` or `baseline` does not make the artifact current authority. Interpret every artifact with its manifest, source binding, version and successor history.
