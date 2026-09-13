# R24-F2 — the Linux controller is not on main, so no Owner-merge-pinned check can pass

Reviewer `/root`. Measured at `f6f9f8c` against `origin/main` at `2c3a6f9`, 2026-09-13T01:12Z.

## The measurement

| | |
|---|---|
| `REPOSITORY_SOURCE` paths the manifest declares | 153 |
| present on `origin/main` | 131 |
| **absent from `origin/main`** | **22** |
| of the 131 present, byte-mismatched | 0 |
| manifest itself on `origin/main` | **no** |

The 22 absent paths are the entire
`scripts/phase2-qualification/control-context-verifier-root6-linux-successor`
directory. There is no drift — only absence. The controller has never been merged.

The 160 capacity approval is also absent. Only the superseded 133 applicability is
on main, which is why the earlier drafts could pin a `publication.commitSha` at all:
`01ea7675` merged the 133 approval, `ad3d589c` the 133 applicability.

## Why it blocks everything Owner-pinned

`verifyOwnerMergeArtifact` (`trusted-github.mjs:33-52`) requires the artifact to be
a `100644` blob in the tree of a commit that has two parents, committer `web-flow`,
a verified valid signature, exactly one merged PR with base `main`, and
`merged_by.login === 'tdoljyj'`. Nothing about the Linux controller satisfies the
tree condition, because it is not in any merged tree.

- `verifySourcePublication` fails at its first Owner call — `EXACT_REGULAR_STATIC_ARTIFACT`
  on the manifest path — before it ever reaches
  `SAME_EXACT_CLOSED_SOURCE_IN_BOTH_TREES` for the 22.
- `capacity_materials.approval.publication` has no real `commitSha`: the v2 approval
  is not on main.
- `capacity_materials.applicability.publication` will have none either, the moment
  that document is issued.

## Consequence for the flip

The runtime acceptance cannot be flipped to `ACCEPTED_EXACT_PREENTRY_CONTROLLER_RUNTIME`
even if the applicability lands this minute, because two of its publication
descriptors would have to name a merge commit that does not exist. This is a second
blocker, independent of R24-F1, and it is the one on the critical path:

> R24-F1 needs another session. **R24-F2 needs the Owner.**

## What has to happen

Merge `claude/nice-fermat-njqlmm` into `main` by pull request, as with #153–#161.
A direct push or a squash will not do: the gate names two parents, `web-flow`, and a
merged PR with base `main`.

Last Owner merge observed: `2c3a6f9`, PR #161, 2026-09-12T09:30:13Z — about 15.5
hours before this measurement. Eight such merges happened on 2026-09-12; none since.
The window closes 2026-09-13T07:05:16Z, and `context.mjs:191` pins `root6Expiry` to
that same instant, so the controller enforces it.

## Why this was not caught earlier

Every Owner-merge-pinned check in this controller has been reasoned about across
rounds and never once executed against a tree that actually contains the controller,
because no such tree has ever been merged. That is the same shape as the nine
conditions-that-could-not-fail already closed, and it is recorded here as the
eleventh rather than repaired: repairing it is an Owner action.

`source_owner_merge` has been `null` in every draft at this path. That was correct
and was recorded, but it was recorded as a pending step rather than as the blocker
it is.

## Not done

No merge. No database write, no generation registration, no budget reservation, no
600-second run. The merge boundary is explicit and this session did not cross it.
