# R24-F1 — the capacity supplement chain is incomplete at 160 / 68133f2d

Reviewer `/root`. Host `node=81925c0995b5 docker=18c2a16d6aa0 gh=f687dc937534 python3.11=f56a588548dd`.
Reviewed at `b7e9a30ad075af94fd111be99ba2979b9f056910`, not at `5cf9596`.

## What was asked, and what was actually issued

Issue two documents against manifest `68133f2d` under `bootstrap/root6-runtime-v19/`.

- `ScopedRoot5FinalControllerQualification.json` — **issued, ACCEPTED**, sha256 `000cb210…`
- `ExactRoot5FinalPreentryControllerRuntimeAcceptance.json` — **issued PREPARED, NOT ACCEPTED**, sha256 `ef0db373…`

The ceiling problem that stopped the previous two sessions is genuinely fixed. A
different link in the same chain is not.

## The commit to check out was stale

The task named `5cf9596`. By the time this session fetched, the branch head was
`b7e9a30`, two commits further on, and both of those commits bear directly on this
work:

- `b68d74f` re-pointed three capacity documents at `68133f2d`
- `b7e9a30` closed R23-F1, the cross-pin selftest sandbox

Working at `5cf9596` would have re-derived a finding already fixed and missed a
fix already made. The freeze point is unaffected: the manifest is byte-identical
at both commits, and none of the four files changed between them is a manifest
entry. Verified, not assumed.

## What holds

- All three ceiling sites read 160. The diff from the superseded freeze `389fee9b`
  is those three literals and nothing else — verified character by character on the
  `capacityDelta` line, not by reading.
- 153 `REPOSITORY_SOURCE` entries resolve to 141 distinct git blobs; the manifest's
  own blob is not among them; 142 in total. 142 ≤ 160 at every site. R22-F2 closed.
- `check-digest-pins` 48 literals / 0 unexplained. `selftest-runtime-pins` 14 ok /
  0 UNPROVEN / 9 not covered / census 73 over 56. `verify-manifest-against-host`
  ALL_ENTRIES_VERIFIED 314/314 with 6/6 cross-pins. Trusted entry reaches
  `BOUNDED_STDIN_INPUT_REQUIRED` bound to `68133f2d`.
- R23-F1 closed: the committed `selftest-cross-pins.mjs` now derives its sandbox
  from the manifest, runs, and gives 4/4 plus the restore case. Before `b7e9a30`
  this reviewer could only obtain 4/4 by patching a private copy, which is not the
  same as having the proof on the committed file.

## What does not hold

`checkCapacityAdministration` needs three documents. One is right, one is wrong in
a small way, one does not exist.

| leg | required | actual |
|---|---|---|
| approval, `capacity_delta` | 160 | **160 — correct** |
| approval, `capacity_proposal_ref.uri` | `https://api.github.com/…/git/blobs/<40 hex>` | **a repository path** |
| applicability | 160, `controller_digest` `68133f2d` | **does not exist** (newest is 133 / `3a58eb87`) |
| 043 repair acceptance | `68133f2d`, the 160 refs | **`3a58eb87`, the 133 refs** |

**R24-F1a.** Both `Root6LinuxController160SourceRefApproval20260913{,.v2}.json` write
a repository path into `capacity_proposal_ref.uri`. The controller's `ref()`
predicate requires a GitHub API blob URI, so `CAPACITY_APPROVAL_REFERENCE_AND_TIME`
throws. The 133 predecessor has the correct form, so this is a regression
introduced when the 160 approvals were emitted; `b68d74f` corrected the `sha256`
inside that ref but left the `uri` in the wrong shape. `capacity_delta` itself is
correct in both.

**R24-F1b.** No capacity applicability exists at 160 / `68133f2d`. `b68d74f`
re-pointed the proposal and the two approvals; the applicability was not among
them. This is the leg with no candidate blob at all — there is nothing a runtime
acceptance could name, so the acceptance cannot be completed by any choice of
values.

**R24-F1c.** `Root6Current043CapacityRepairAcceptance20260912.json` still pins
`3a58eb87` and the 133 approval and applicability. It must be re-issued after the
applicability, because `changed_source_refs` has to deep-equal the applicability's.

Omitting `capacity_materials` is not an escape: `context.mjs:248`
`NEW_CAPACITY_CONSUMER_REQUIRES_REAL_SUPPLEMENT` and `context.mjs:281`
`NEW_CAPACITY_CONSUMER_REQUIRES_ACTUAL_SUPPLEMENT` make it mandatory on this path.

All four rows above were checked mechanically against the controller's own frozen
`capacityDelta` and its own `ref()` predicate, both lifted out of `context.mjs`
source at run time rather than transcribed into the checker.

## Why the acceptance was issued PREPARED rather than ACCEPTED

An accepted document here would have to assert `capacity_delta` 160 while pinning
materials that say 133 and name a different controller. That is not an incomplete
document, it is a false one — the same failure the two preceding sessions refused,
one link further down. PREPARED makes it fail at
`EXACT_RUNTIME_ACCEPTANCE_METADATA_REQUIRED` (`context.mjs:71`), attributably,
rather than at `CAPACITY_ONLY_EXPLICIT_DELTA` after loading.

Everything determinable is already filled in: `68133f2d`, the 142-blob
`source_ref`, `capacity_delta` at 160, and a self-pin to the qualification issued
alongside it. Accepting it later is a small, mechanical edit.

## Order of repair

1. R24-F1a — fix `capacity_proposal_ref.uri` in both 160 approvals.
2. R24-F1b — issue the applicability at 160 / `68133f2d`, naming the chosen approval.
3. R24-F1c — re-issue the 043 repair acceptance against `68133f2d` and both refs.
4. Owner merge to main, so `verifyOwnerMergeArtifact` can pin all of them.
5. Flip the acceptance to `ACCEPTED_EXACT_PREENTRY_CONTROLLER_RUNTIME`, fill
   `capacity_materials`, set `accepted_at`.

Steps 1–3 need `independent_reviewer` `/root/project_list_auth_fix`, a different
identity from the `/root` these two documents are issued under, and `b49588f` put
that re-issue on a deliberately separate track. This session did not do them:
doing so would collapse the independence that separation exists to provide, which
is the same shape as the nine conditions-that-could-not-fail already closed.

## Also note

`binding.controller_sha256` and `binding.qualification_sha256` both have to be
re-pinned by the Owner — the controller digest changed, and so did the
qualification's bytes (`000cb210…`). No database access was used by this session.

`source_owner_merge` is null. A real `verifySourcePublication` still has never run
end to end, and could not be run here: it needs the Owner merge and the live
binding.

## Not done

No database write, no generation registration, no budget reservation, no
600-second run, no merge.
