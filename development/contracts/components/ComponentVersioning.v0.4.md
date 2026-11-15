# Component versioning v0.4 candidate: nothing per-PR is stored

Defect C (2026-11-15). Successor to v0.2 §1 and §3 and to v0.3 (Task 342c).
Pending Owner decision: it supersedes Decision `967df3da`'s "a content change
ships as edit, bump, update, commit" and v0.3's automatic per-PR bump.
Everything else in v0.2 (placement, Contract/Skill separation, numeric version
ordering, `VERSION` and release tags, `source_commit`) stays.

## Why

`main` takes in only a head that contains its tip (`strict`, Owner Decision
`9e2511fe`). Each merge therefore leaves every other queued PR behind, and the
next one has to take main in. Under v0.3 that was never a plain merge: every PR
stored values derived from its own content, so a plain merge either conflicted
or was wrong and a builder had to run again:

- `content_sha256` per component: any two PRs that touch a component change the
  same line (the real conflict of 2026-11-15, PR #1124 against main `0b5b4003`);
- the automatic patch bump against the base: a per-PR counter, so after every
  merge each queued PR touching that component had to be bumped again, its
  marker rewritten, and the Source pins of the marker file re-pinned (a
  two-line test change in #1124 rewrote six generated files each time, two of
  them protected `scripts/ci` files).

52 of the 70 merges into `main` from 2026-11-08 to 2026-11-15 changed
`config/clued-components.json`.

## Rule

1. A component's version is a release label. It changes only when someone
   raises it on purpose (`clued_components.py bump`), never automatically and
   never as a condition for merging a content change. It never goes down.
2. What a component's files are is their content digest (v0.2 §1 formula),
   computed from the files whenever it is needed (`versions`, the
   version-check hook comparing an installed Skill copy with the checkout). It
   is never stored; `check` refuses a stored `content_sha256`.
3. The deployed whole is identified by `source_commit`, as before.
4. `component-version-integration.py` regenerates only the mechanical outputs
   of a PR's own change (registries, pins, the generated version module, the
   plugin copy). It sets no version.

Consequence: a PR's own change still regenerates its own outputs, but taking
main into a queued PR is a plain merge (what GitHub's update-branch does) with
nothing to regenerate, unless both sides changed the same real input.

## Only the front takes main in

The resident's PR page used to tell every behind PR "请合入最新 main 并推送"
after each merge, so N queued PRs produced O(N²) merge-only heads (Task
`570bd3e3` reached GenericWorkClaim §10.4's 40 heads in 24 h on 2026-11-15; #1123
alone had three heads that only took main in). With this change
(`work/independent-ci-resident-v1/src/pr-status.mjs`) a behind PR that a train
run of the last 30 minutes did not see at the front is told to wait; the front,
or any PR when no front is known, is still told to take main in. Each PR then
needs at most one merge-only head, at its turn, and that head is a plain merge
(GitHub's update-branch) with nothing to regenerate: O(N).

## What is not in this change

Taking main into the front is still a new head under `strict` (Owner Decision
`9e2511fe`: GitHub merges only a head that contains main's tip, so the tested
trial merge alone cannot be merged). Making that head without a person is the
merge-queue and admission side (DESIGN §65.6 executor with update-branch, head
authorization carried over a plain main merge), not versioning. §10.4's 40
heads per Task per 24 h needs no change: at most one merge-only head per merge
remains, and the cap is there to stop runaway loops.
