# R27 — issuance record: both capacity documents ISSUED at 90e2341

**State: `TWO_DOCUMENTS_ISSUED_NO_DATABASE_WRITE`.**

Reviewer identity requested: `/root/project_list_auth_fix`.
Base: `90e2341528ab7b7493c5e0306993c8196dd2ec2c`, head of `claude/nice-fermat-njqlmm`, fetched fresh.
Host stamp measured: `node=81925c0995b5 docker=18c2a16d6aa0 gh=f687dc937534 python3.11=f56a588548dd` (same session and host as R26; all four gates re-run there: 48/0 pins, runtime-pins 0 UNPROVEN, 314/314 manifest, 4/4 cross-pins).
Clock at issuance: `2026-09-13T02:15:38.154Z`. Window closes `2026-09-13T07:05:16Z`.
Issuing session: `session_015Tt97v7JR1XcGCwvZG7Npk` (the R26 session, continued).

## 1. The R26-F1 fix, verified before anything was issued

`7d904526` re-serialized both 160 approvals. Re-measured here from bytes:

| file | sha256 at 90e2341 | git blob | R26 §3 prediction |
| --- | --- | --- | --- |
| v1 | `d3a90e311d4a51785deccacca257514128cb0d3977a246d642a6ad505ae4942d` | `21c6bf0d…` | **byte-identical match** |
| v2 | `bc541370c238309730485e33f05b03ba44566fb4f6b83da9d657f7298b5a88e6` | `6d02472a…` | **byte-identical match** |

Both parse clean under the lifted `parseAuthenticatedAdministrativeJSON`;
`isDeepStrictEqual(4d73b18 value, 90e2341 value)` is **true** for both — no Owner-approved
content moved. The committed v2 equals the R26 fix candidate byte for byte, so this record's
predecessor is the independent verification of that fix, made in advance, and it held.

Also re-measured at 90e2341, unchanged: manifest self-digest `68133f2d…` (the controller
directory is untouched by the four new commits), `expected_ga.controller_digest`/`scope_digest`
`68133f2d…`/`115408c6…`, evidence sink `f8c2e3c0…`, bounded approval pin `fe114f08…`,
acceptance `capacity_delta` deep-equals the frozen constant, `capacity_materials` still `null`,
`repairs[7]` still pins `3b7b288c…` (R25-F1, now also declared inside the acceptance itself).

**The intent anchor is stale for the fourth time**: `capacity_materials_intent.approval.ref`
now pins `83a5924b…`, the pre-7d904526 bytes. As before it is non-live (0 references in any
controller `.mjs`) and its own `measured_at_commit` field says to re-measure before pinning.
The issued applicability binds the **measured** bytes `bc541370…`; a flip that copies the
intent forward instead fails at `CAPACITY_EXACT_APPROVAL` (`:117`) — reproduced below.

## 2. The two documents

Issued at their canonical paths in this directory, superseding the 133-era `3a58eb87`
documents in place (old bytes remain addressable as git blobs `d09a1bcc`/`7954c108` and are
named in each `supersedes` field):

| document | sha256 | git blob |
| --- | --- | --- |
| `Root6CurrentController4000000CapacityApplicability20260912.json` | `e7ec06c28bc9f1c4819618c00c95762025bbcf7bedc559e1b28ded0d05b31183` | `f21085e652c81b4195c68e30f2c9aaf4dba979e2` |
| `Root6Current043CapacityRepairAcceptance20260912.json` | `d3f643b4a9d793b7f0fd788b70fcf1088781bbf0e8661fc1b27df78411d7f1f0` | `4ca394474e6524eedaa482f20761330accb4e15a` |

Applicability: `approval_ref` → v2 `bc541370…`, `base_approval_ref` `fe114f08…`,
`base_proposal_sha256` `ea96914e…`, `capacity_proposal_ref` `e224c379…`, constraints/delta/
baseline lifted from the frozen constants (`:190`, `:113`, `:114`), digests `68133f2d…`/
`115408c6…`, sinks `33feb26a…` → `f8c2e3c0…`, `changed_source_refs` = 23 refs (manifest blob +
the 22 introduced `REPOSITORY_SOURCE` entries, every sha256 re-measured from working-tree
bytes, all uris and digests distinct — the set semantics R26 §4 settled).

043: `:140`-complete against that applicability — same 23 `changed_source_refs`, pins the
applicability's issued bytes `e7ec06c2…` and the corrected approval `bc541370…`, baseline
constants `ga_04377008…`/`b27286d6…`, digests `68133f2d…`/`115408c6…`. Its `reachability_note`
restates R25-F1: it stays unread until the flip repoints `repairs[7].ref` to `4ca39447…`.

Both documents pass the lifted `parseAuthenticatedAdministrativeJSON` on their exact issued
bytes, so the loader that rejected the pre-fix approvals accepts these by the same measured
gate. Cross-checks on disk after writing: `043.capacity_applicability_ref.sha256` equals the
applicability file's measured sha256; `accepted_at 2026-09-13T02:15:38.154Z` ≥ v2
`approved_at 2026-09-12T23:41:49Z`; `changed_source_refs` deep-equal across the two.

## 3. Verification of the issued bytes — the R26 §5 procedure, re-run as the issuance

Predicates lifted verbatim from `context.mjs` source slices (the `capacityAdministration`
IIFE plus `check`, `time`, `checkCapacityApprovalTime`, `generation`, `root6Expiry`), a
simulated flipped subject (`capacity_materials` filled with the two issued refs), and a
synthetic `GENERATION_REGISTERED` body encoding exactly the declared preconditions
(`not_before 2026-09-12T07:05:16Z`, `expires_at 2026-09-13T07:05:16Z` — outside-repository
claims, restated as preconditions inside the applicability):

```
full checkCapacityAdministration over the ISSUED bytes -> ACTUAL_043_BLOCKED_TERMINAL_REQUIRED
   (:122, :124, :125, checkCapacityApprovalTime, :129, :130, :131, :132, :133, :134, :135 all
    passed; the stop is the live-store 043 receipt, whose bytes exist only in the control plane)
same harness with the pre-fix 83a5924b bytes (what the stale intent still pins)
                                                        -> ADMIN_JSON_UNIQUE_CANONICAL_VALUES

twelve negative controls, each moving the failure to its named gate:
  approval delta 159 (subject re-pinned)     -> REAL_EXACT_CAPACITY_APPROVAL_REQUIRED   (:124)
  approval delta 159 (subject not re-pinned) -> CAPACITY_EXACT_APPROVAL                 (:117)
  subject capacity_delta 159                 -> EXACT_CAPACITY_SUBJECT_AND_LOADED_SET   (:122)
  approval bytes altered, ref unchanged      -> CAPACITY_EXACT_APPROVAL                 (:117)
  subject pins sha the applicability lacks   -> EXACT_INDEPENDENT_CAPACITY_APPLICABILITY (:129)
  reviewer -> /root                          -> EXACT_INDEPENDENT_CAPACITY_APPLICABILITY (:129)
  applicability delta 159                    -> CAPACITY_ONLY_EXPLICIT_DELTA            (:130)
  forbidden scope_unchanged key              -> CAPACITY_ONLY_EXPLICIT_DELTA            (:130)
  accepted_at before approved_at             -> CAPACITY_ACCEPTANCE_TIME                (:131)
  controller_digest -> old 3a58eb87          -> CAPACITY_EXACT_CURRENT_CONTROLLER_SCOPE (:132)
  duplicated changed_source_refs uri         -> CAPACITY_EXACT_CHANGED_SOURCE_REFS      (:135)
  registered not_before after approved_at    -> CAPACITY_APPROVAL_CURRENT_ROOT5_TIME    (:44-46)

isApprovedCapacityRepair(issued 043, 043 attempt, c) = true                             (:140)
  old controller_digest / superseded applicability ref / short changed_source_refs /
  scope_unchanged present / wrong reviewer   -> all false
```

## 4. What remains, none of it this document's to do

1. **Owner merge** of `claude/nice-fermat-njqlmm` (with this branch integrated) into `main`
   — R24-F2, the critical path, unchanged.
2. **Flip edit**, one atomic change, every ref re-measured from merged bytes and none copied
   from `capacity_materials_intent`: fill `capacity_materials` with
   `{approval: bc541370…, applicability: e7ec06c2…}` plus their real Owner-merge publications;
   repoint `repairs[7].ref` to `d3f643b4…`/blob `4ca39447…` with its publication (R25-F1);
   set `state ACCEPTED_EXACT_PREENTRY_CONTROLLER_RUNTIME` and `accepted_at`; re-pin the
   binding digests.
3. Live-store facts remain assertions until the gate runs end to end: the registered body's
   window, the 043 receipt `b27286d6…`, the budget line. If any contradicts the declared
   preconditions, the applicability says of itself that it does not apply.

## 5. Boundaries

No database write, no `append_event`, no generation registration, no budget reservation, no
600-second run, no merge to `main`, no new trust root, signing identity, paid or model budget,
production authority, refund, or capacity beyond `source_refs_maximum` 160. Changes on this
branch: the two issued documents and this record, nothing else. These documents grant no
authority (`authority_effect NONE` in both); they become consumable only through the Owner
merge and the flip edit described above.
