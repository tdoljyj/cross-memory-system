# Scan-start cutover policy preparation

The hosted relay and its qualification controller (Task `169fd456`) are removed
(`work/independent-ci-resident-v1/DESIGN.md` §76, §77). What stays here is the
offline preparation of the Native scan-start policy, which the local formal roles
can use without the relay (`src/scan-start-v1/`, `NATIVE_SCAN_START_REQUIRED`).
Its hosted qualification branch (`hostedQualificationPolicy`, `hosted_head_sha`)
mirrors the database policy shape and goes with the database migration that
removes the hosted scan-start door (§77, follow-up).

## Offline scan-start cutover policy preparation

Run `node work/independent-ci-resident-v1/qualification/scan-start-cutover-plan.mjs --repo PATH --commit EXACT_40HEX --out NEW_FILE`.
Optional exact inputs: `--owner-user-id`, `--project-id`, `--source-manifest-sha256`,
`--qualification-head-sha`, `--qualification-hold-evidence-sha256` and
`--expected-registry-sha256` (raw-file SHA256, not the structural digest).
The builder reads immutable Git objects, verifies both hosted closures and adds
Native-only contract-placement from the existing trusted workflow table.

Every output is inactive `DRAFT_NOT_ACCEPTED_NOT_ACTIVATED` / `NOT_INSTALLABLE`.
Unknown identities, Source or held head are listed, never guessed. Primary
`policy` is Native-only: all hosted flags are false. A separate
`hostedQualificationPolicy` exists only for a specified exact H; CP stays
Native-only. Unknown H yields no hosted payload. `allHeadsPolicy` is always null.
An input H or hold-evidence hash does not prove a live installed hold.

Owner/Source and three-role acceptance, qualified-consumer handover, Native-only
proof, installed exact-H hold, actual L1-L4 and coordinated provider/relay
activation remain separate gates. Never enable hosted globally while relay is
false, release an unknown hold, rescan an old H, or reset caps/costs. Protected
old credential copies and failure evidence stay; no secrets, database, network
or production switches are accessed. The tool grants no live qualification.
