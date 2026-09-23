# artifacts/

`artifacts/` contains bounded machine-verifiable evidence, migration/validation material and versioned repository snapshot publications.

It is **not** an online Canonical Store and file presence does not establish Current Truth, deployment or acceptance.

Prefer small Manifest/Receipt/hash/locator evidence over repeated opaque raw payloads. Published snapshot paths governed as immutable remain subject to their publication contract.

For new large or opaque artifacts, follow [Repository Artifact Retention Contract v0.1](../development/contracts/repository/ArtifactRetention.v0.1.md). Existing evidence is not deleted merely because it is old or large; cleanup requires proving that no live contract, test, rollback, audit or fixed-path consumer still depends on it.
