# R28 — flip record: the runtime acceptance is ACCEPTED at 160/68133f2d against the M1 Owner merge

**State: `RUNTIME_ACCEPTANCE_FLIPPED_NO_DATABASE_WRITE`.**

Reviewer identity: `/root` (the runtime acceptance's own independent_reviewer, per context.mjs:71).
Base: `f5f7bc444d16552167f216f5a67257147a86af64`, head of `claude/nice-fermat-njqlmm`, fetched fresh.
Owner merge M1: **`7c9f612b4c21a549eb4141096c64d8a2c02264af`** = head of `origin/main` at flip time.
Clock at flip: `2026-09-13T02:38:53.099Z`. Window closes `2026-09-13T07:05:16Z`.
Host: gh 2.63.2 installed this session to `/usr/local/bin/gh`, bytes
`f687dc937534f8aa77ff9d2362163c645b5a8cc78297ef1a642c74c56aa48618` (50098328 bytes) — the
HostProvisioning.json pin, so `GITHUB_CLI_BYTES_DRIFT` (trusted-github.mjs:13) holds. node
v22.22.2 at `/opt/node22/bin/node`.

## 1. M1 verified, not taken on report — the first true GitHub-side run of verifyOwnerMergeArtifact

The real `trusted-github.mjs` module (not a transcription) was imported and
`verifyOwnerMergeArtifact({commitSha: 7c9f612b…, artifactPath, raw})` executed over live
`gh api`, once per descriptor, with `raw` read locally from the M1 tree via `git cat-file`:

| descriptor | artifactPath (root6-capacity/) | sha256 | git blob | result |
| --- | --- | --- | --- | --- |
| approval v2 | `Root6LinuxController160SourceRefApproval20260913.v2.json` | `bc541370c238309730485e33f05b03ba44566fb4f6b83da9d657f7298b5a88e6` | `6d02472ab5ee79051e266d9f49fce977782f1b8a` | **PASS** |
| applicability | `Root6CurrentController4000000CapacityApplicability20260912.json` | `e7ec06c28bc9f1c4819618c00c95762025bbcf7bedc559e1b28ded0d05b31183` | `f21085e652c81b4195c68e30f2c9aaf4dba979e2` | **PASS** |
| 043 | `Root6Current043CapacityRepairAcceptance20260912.json` | `d3f643b4a9d793b7f0fd788b70fcf1088781bbf0e8661fc1b27df78411d7f1f0` | `4ca394474e6524eedaa482f20761330accb4e15a` | **PASS** |

Every sha256 and git blob id above was re-measured in this session from the bytes at
`7c9f612b…` — none copied from any briefing, prior record, or `capacity_materials_intent`.
They coincide with R27 §2's predictions, which is confirmation, not provenance.

Commit facts read via `gh api` inside the same check: parents `2c3a6f9` + `f5f7bc4`,
committer `web-flow`, `verification.verified === true`, `reason === 'valid'`; exactly one
merged PR with base `main`: **#162**, `merged === true`, `merged_by.login === 'tdoljyj'`,
`merged_at 2026-09-13T02:22:13Z`. The repository reads `private === true`
(`PRIVATE_REPOSITORY_REQUIRED`). The GitHub-side blobs round-tripped through `readBlobRef`
byte-for-byte against the local bytes (`GITHUB_BLOB_RAW_SHA`, `GITHUB_BLOB_ID` both exercised).

Negative controls (each moved the failure to its named gate):

```
single-parent commit f5f7bc4      -> OWNER_MERGE_VALID_SIGNATURE_REQUIRED
nonexistent artifactPath          -> EXACT_REGULAR_STATIC_ARTIFACT
raw with one byte appended        -> GITHUB_BLOB_RAW_SHA
```

## 2. The one atomic edit

`bootstrap/root6-runtime-v19/ExactRoot5FinalPreentryControllerRuntimeAcceptance.json`,
all in a single write (R25-F1's atomicity requirement):

1. **`accepted_subject.capacity_materials`** filled: exactly `{approval, applicability}`
   (:122), each `{ref:{uri,sha256}, publication:{commitSha,artifactPath}}` (:250), approval =
   v2 `bc541370…`/blob `6d02472a…`, applicability = `e7ec06c2…`/blob `f21085e6…`, both
   publications = `{7c9f612b…, canonical path}`.
2. **`repairs[7]`** repointed from the superseded `3b7b288c…` (blob `7954c108`) to the issued
   043 `d3f643b4…`/blob `4ca39447…`, publication = M1. R25-F1 closed by this line.
3. **`state`** → `ACCEPTED_EXACT_PREENTRY_CONTROLLER_RUNTIME` (byte-exact per :71);
   `independent_reviewer` stays `/root`. `accepted_at 2026-09-13T02:38:53.099Z`,
   `acceptance_issued true`, `acceptance_record.accepted true`, flip provenance recorded in
   `acceptance_record.m2_flip`.
4. `capacity_materials_intent` marked `FULFILLED_NOT_COPIED` — its approval pin (`83a5924b…`)
   was indeed stale a **fourth** time; the fulfillment note records the measured divergence.
   `known_open`: R24-F1 → `CLOSED_AT_f5f7bc4`, R24-F2 → `CLOSED_AT_7c9f612b`,
   R25-F1 → `CLOSED_BY_THIS_EDIT`, R25-F2 → `RESOLVED_BY_ISSUED_APPLICABILITY`, R26-F1 added
   as `CLOSED_AT_7d90452_VERIFIED_AT_f5f7bc4`. `not_accepted_because` renamed to
   `formerly_not_accepted_because` with the three blockers' resolutions.

**Byte-form repair, found and fixed in passing:** the PREPARED file failed
`parseAuthenticatedAdministrativeJSON` as it stood — its CJK text was written as `\uXXXX`
escapes, and escape normalization is outside the parser's whitespace-only tolerance
(first divergence at compact-offset 9985, in `revocation_epoch_vector`). Latent, not
blocking: the controller loads this file with plain `JSON.parse` (context.mjs:296). Fixed
here by re-serializing the whole document to `JSON.stringify(value,null,1)` with raw UTF-8 —
value-identical outside the intended edits (deep-equal audited per top-level key). This is
R26-F1's lesson applied to the acceptance's own bytes.

## 3. Post-flip verification — every check paired with a discriminator

Predicates lifted verbatim from `context.mjs` source slices (the `capacityAdministration`
IIFE :99-143 plus `check`, `time` :46, `checkCapacityApprovalTime` :40-45, `generation`,
`root6Expiry`), run over the **actual flipped file** and the **actual M1 bytes**, synthetic
`GENERATION_REGISTERED` body encoding the declared preconditions:

```
new bytes pass parseAuthenticatedAdministrativeJSON; old \uXXXX bytes -> ADMIN_JSON_UNIQUE_CANONICAL_VALUES
JSON.stringify(value,null,1)+'\n' round-trip is byte-stable
:71 holds on the flipped file; with the PREPARED state string it would not
full checkCapacityAdministration -> ACTUAL_043_BLOCKED_TERMINAL_REQUIRED
   (:122, :124, :125, checkCapacityApprovalTime, :129-:135 all passed; the stop is the
    live-store 043 receipt, exactly where R26 §5 and R27 §3 stopped)
  approval ref = the stale intent pin 83a5924b  -> CAPACITY_EXACT_APPROVAL          (:117)
  extra key in capacity_materials              -> EXACT_CAPACITY_SUBJECT_AND_LOADED_SET (:122)
  subject capacity_delta 159                   -> EXACT_CAPACITY_SUBJECT_AND_LOADED_SET (:122)
isApprovedCapacityRepair(issued 043, 043 attempt, c) = true            (:140)
isApprovedCapacityRepair(superseded 3b7b288c bytes, same attempt, c) = false
descriptor shapes: both capacity descriptors and all 8 repairs pass the actual()/keys() forms (:250, :268)
currentWindow (:72) holds; accepted_at >= the applicability's accepted_at
value-diff audit: nothing changed outside the intended paths
```

Freeze point: manifest self-digest `68133f2d…` and the controller directory's aggregate
sha256 (`30e0f89b1094d215…` over all files) identical before and after the edit. The 22
controller sources are untouched.

## 4. The flipped file

| | |
| --- | --- |
| sha256 | **`fb3893147d480e718889bd05c7d7b343d8330792a2232296033ab91c72898c88`** |
| git blob | `a5b9e31098cbe9da0ddd0d9cd562321862a36333` |
| bytes | 127644 |

`binding.runtime_acceptance_sha256` (historical-component-observations.mjs:12) must be
re-pinned to the sha256 above by whoever performs the database-side binding update;
`binding.controller_sha256` → `68133f2d…` and `binding.qualification_sha256` →
`000cb210…` per the required_before_actual_ga list. All three are database writes and were
**not** performed here. The qualification file needed no edit: its bytes still hash to
`e7cfb30b…`, exactly what `expected_ga.controller_qualification_ref` pins.

## 5. What was not verified

- Live control plane: the registered generation body, the 043 receipt bytes `b27286d6…`,
  the budget line. Asserted preconditions, not read; the gate stops there by design until
  the end-to-end run.
- This document's own publication: the flipped bytes are in no Owner merge yet. The next
  Owner merge (M2) makes `historical-component-observations.mjs:13` satisfiable; that merge
  is the Owner's, not this session's.
- `verifySourcePublication` end to end — unchanged from R25/R26/R27.

## 6. Boundaries

No database write, no `append_event`, no generation registration, no budget reservation, no
600-second run, no merge to `main`, no new trust root, signing identity, paid or model
budget, production authority, refund, or capacity beyond `source_refs_maximum` 160. The 22
controller source files are untouched (freeze digests above). Changes on this branch: the
flipped acceptance and this record, nothing else.
