# Component versioning v0.4 candidate: nothing per-PR is stored

Defect C (2026-11-15). Pending Owner decision: it supersedes Decision
`c7b074ea` item 2 (2026-11-08: "component versions are no longer raised by hand
in each PR; on merge a program raises them and regenerates, checked by
pinned-registries"), whose implementation is v0.3 (Task 342c). Item 1 of
`c7b074ea` (mechanical files do not take part in claim conflicts) stays. It
replaces the stored digest of v0.2 §1 and the "files and version change
together" rule of v0.1 §2 / v0.2 §3. Decision `967df3da` is not superseded:
every component still has a version, the service still reports them, and a
session is still told when what it holds is not current (§3 below keeps that
true on hosts without a checkout). Everything else in v0.2 (placement,
Contract/Skill separation, numeric version ordering, `VERSION` and release
tags, `source_commit`) stays.

## 1. Why

`main` takes in only a head that contains its tip (`strict`, Owner Decision
`9e2511fe`). Each merge therefore leaves every other queued PR behind, and the
next one has to take main in. Under v0.3 that was never a plain merge: every PR
stored values derived from its own content, so a plain merge either conflicted
or was wrong and a builder had to run again:

- `content_sha256` per component: any two PRs that touch a component change the
  same line (the only conflicts of PR #1124 against main `0b5b4003`);
- the automatic patch bump against the base: a per-PR counter, so after every
  merge each queued PR touching that component had to be bumped again, its
  marker rewritten, and the Source pins of the marker file re-pinned (a
  two-line test change in #1124 rewrote six generated files each time, two of
  them protected `scripts/ci` files).

From 2026-11-08 to 2026-11-15, 61 of the 80 merges into `main` changed
`config/clued-components.json` and 56 changed
`scripts/ci/clued-merge-reconcile-source.json`.

## 2. Rule

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
5. A generated "path -> hash" registry (`clued-merge-reconcile-source.json`)
   is written with `scripts/ci/registry-layout.mjs`: an empty line after every
   entry, so changes to two different files are never adjacent lines and git
   merges them. Its readers parse JSON and are unchanged.

## 3. Publishing the Skill

A host without a checkout (claude.ai, Codex outside the repository) can only
compare version numbers. So the scripted Skill publishing entries refuse to
publish Skill files that differ from what their version meant when it first
reached the checkout's first-parent history
(`clued_components.unreleased_change`): `scripts/update_clued_skills.py`
(install, not `--check`) and `plugins/kooyumi/build_bundle.py --out`. Same
number, other content never ships from them; the publisher bumps first. A
shallow checkout or an uncommitted bump is refused, not guessed. The Claude
Code plugin copy is versioned by commit and needs no gate. Not covered: a
person uploading the `skills/clued` folder to claude.ai by hand.

## 4. What still conflicts

Taking main into a queued PR is a plain merge (what GitHub's update-branch
does) with nothing to regenerate, except when both sides changed the same real
input. For the Source pin registries that means the same pinned file: its pin
line differs on both sides, the merge conflicts and the registry generator has
to run once. Removing the stored table altogether would change its verifier,
`scripts/ci/clued-merge-reconcile-source.mjs`, which the registered initial
control Source pins byte for byte (`MERGE_RECONCILE_CONTROL_SOURCE`); that needs
a successor control Source and is not part of this change. The same holds for
`REQUIRED_SELECTOR_SOURCE` in `clued-required-applicability.mjs` (it pins one
file, `ci-required-selection.mjs`).

## 5. Only the front takes main in

The resident's PR page used to tell every behind PR "请合入最新 main 并推送"
after each merge, so N queued PRs produced O(N²) merge-only heads (Task
`570bd3e3` reached GenericWorkClaim §10.4's 40 heads in 24 h on 2026-11-15; #1123
alone had three heads that only took main in). Now
(`work/independent-ci-resident-v1/src/pr-status.mjs`) a behind PR that a train
run of the last 30 minutes saw is not the front is told to wait; the front is
still told to take main in. Each PR then needs at most one merge-only head, at
its turn, and that head is a plain merge: O(N).

Degraded case: when no train run of the last 30 minutes named a front (the
train is stopped, its facts are unreadable or stale), every behind PR is asked
to take main in, as before, and O(N²) heads come back for that time. That is
the safe direction: a PR is never left waiting for a front that nobody computes.

Taking main into the front is still a new head under `strict`. Owner Decisions
`9e2511fe` item 3 and `78a3052f` item 2 already authorize a robot to update a
BEHIND front's branch (`clued-merge-executor`, update-branch, merge method;
protected-layer PRs not yet); it is not implemented in this change. §10.4's 40
heads per Task per 24 h needs no change: at most one merge-only head per merge
remains, and the cap is there to stop runaway loops.
