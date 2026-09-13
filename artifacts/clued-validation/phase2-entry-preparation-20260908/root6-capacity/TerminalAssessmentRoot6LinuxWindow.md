# Terminal assessment — the run cannot proceed without one Owner action

Reviewer `/root`, session `session_01WPz5vCshFyH6j4TZiiE2Rh`. Written 2026-09-13T01:47Z,
5h18m before the window closes at 2026-09-13T07:05:16Z.

## The position

Three sessions were set to work in parallel on the capacity leg. All three stopped
short of issuing, independently, for reasons that turned out to be the same reason
seen from different angles.

| session | verdict |
|---|---|
| `session_019Xz1px5xGCFwmbTVsc43z1` | refused at `2e4c6a8` — subject declared 133, approvals pinned 389fee9b |
| `session_017iY1oKT4HCLhcNzisKBC1Q` (D) | refused at `d408432` — *"need Owner PR claude/nice-fermat-njqlmm → main before docs"* |
| this session | qualification issued; runtime acceptance **PREPARED, not accepted** |

The first session's blockers have all been cleared since it wrote. D's have not.

## What is done and sound

- Controller frozen at `68133f2d`, 314 manifest entries. All three source-reference
  ceilings read 160; the diff from `389fee9b` is those three literals and nothing
  else, verified character by character.
- The source set closes at **142 distinct blobs** — 153 `REPOSITORY_SOURCE` entries
  resolving to 141, plus the manifest's own blob. 142 ≤ 160 at every site. R22-F2 closed.
- Host gates, all reproduced here: `check-digest-pins` 48/0; `selftest-runtime-pins`
  14 ok / 0 UNPROVEN / 9 not covered / census 73 over 56; `selftest-cross-pins` 4/4
  plus restore, 6 cross-pins 0 failures; `verify-manifest-against-host`
  ALL_ENTRIES_VERIFIED 314/314 with 6/6 cross-pins; trusted entry reaches
  `BOUNDED_STDIN_INPUT_REQUIRED` bound to `68133f2d`. Host stamp matches the Owner's.
- **`ScopedRoot5FinalControllerQualification.json` — ACCEPTED**, `e7cfb30b`.
- Both 160 approvals are sound: `capacity_delta` deep-equals the controller's frozen
  literal, and `ref(capacity_proposal_ref)` passes. R24-F1a and R25-F3 closed.

## What blocks, and who can clear it

**R24-F2 — the Linux controller is in no Owner merge. This is the critical path.**

Of the 153 `REPOSITORY_SOURCE` paths the manifest declares, 22 are absent from
`origin/main` — the entire controller directory. The manifest itself is absent. So is
the 160 approval. The 131 present are byte-identical, so this is absence, not drift.

`verifyOwnerMergeArtifact` needs the artifact to be a `100644` blob in the tree of a
two-parent `web-flow` commit with a verified signature and exactly one merged PR based
on `main`, merged by `tdoljyj`. Consequently:

- `verifySourcePublication` fails at `EXACT_REGULAR_STATIC_ARTIFACT` on the manifest,
  before the 22 are ever reached.
- `capacity_materials.approval.publication` has no real `commitSha`.
- `capacity_materials.applicability.publication` will have none when that lands.

**No session can clear this.** Last Owner merge: `2c3a6f9`, PR #161, 2026-09-12T09:30Z
— over 16 hours ago. Eight merges happened on 09-12; none since.

The two dependent blockers, both waiting behind it:

- **R24-F1b** — no capacity applicability at 160/`68133f2d`. Needs
  `/root/project_list_auth_fix`. Two sessions declined; D declined specifically
  because issuing before the merge yields a document that goes stale silently.
- **R25-F1** — `bounded_series_materials.repairs[7]` pins the 043 repair at its
  pre-re-issue bytes `3b7b288c`. `readBlobRef` addresses by content hash, so once that
  document is re-issued the ref resolves the superseded blob and the failure surfaces
  at `INDEPENDENT_IDENTIFIED_ERROR_AND_FIX_BEFORE_NEXT_ATTEMPT` (`context.mjs:223`)
  without naming the stale pin. Found by D against this session's document. Cannot be
  pre-filled.

## The only order that works

1. **Owner merges `claude/nice-fermat-njqlmm` into `main` by pull request.** Not a
   push, not a squash — the gate names two parents, `web-flow`, and a merged PR.
2. Issue the applicability at 160/`68133f2d` as `/root/project_list_auth_fix`, binding
   `approval_ref` to the v2 approval declared in this acceptance's
   `capacity_materials_intent`. **Re-measure first** — those bytes have moved three
   times tonight.
3. Re-issue the 043 repair against `68133f2d` and both refs.
4. Owner merges again, so steps 2–3 are pinnable.
5. Flip the acceptance: fill `capacity_materials`, re-measure `repairs[7]`, set
   `accepted_at`, re-pin `binding.controller_sha256` and
   `binding.qualification_sha256` — both changed.
6. Only then the four Owner-authorized actions.

Steps 1 and 4 are two separate Owner merges. In 5h18m that is tight but not
impossible; without step 1 it is not tight, it is impossible.

## The honest summary

Nothing here is broken. The controller is sound, the ceiling is fixed, the source set
closes, the host gates pass, and the qualification is issued. The chain is one
Owner-side action short of being completable, and it has been one Owner-side action
short for over sixteen hours while three sessions worked in parallel on the leg behind
it. Parallelism did not help, because the dependency was never between the sessions.

## Not done

No merge. No database write, no generation registration, no budget reservation, no
600-second run. Every boundary given to this session was held.
