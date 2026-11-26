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
5. The reconcile registration stores the fixed workflow and Role. The
   controller verifies the source closure against its checkout's HEAD (§4).

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
input. R9's historical registrations can still conflict when both branches change
the same admission inputs. The reconcile verifier compares closure membership
and raw file bytes with `git ls-tree -r -z HEAD` before the controller loads
credentials. It rejects a stored `files` field. The fixed workflow and Role
digests remain independently reviewed. The initial control Source still
authenticates the historical verifier and test by their original Git objects.

`REQUIRED_SELECTOR_SOURCE` hashes the sibling selector at module load. The
baseline selector must match both digests before applicability can be issued.
Ordinary merges, reverts and batch commits need no generated closure or selector pins.

## 5. Only the front takes main in

The resident's PR page used to tell every behind PR "请合入最新 main 并推送"
after each merge, so N queued PRs produced O(N²) merge-only heads (Task
`570bd3e3` reached GenericWorkClaim §10.4's 40 heads in 24 h on 2026-11-15; #1123
alone had three heads that only took main in). Now
(`work/independent-ci-resident-v1/src/pr-status.mjs`, Task `484bddac`) the page
never asks for a hand merge: every behind head gets one pending line, "落后 main
N 个提交：轮到时机器人合入 main，不用手工合（没开自动合入的先开）", whatever the
train summary says, and the robot (`clued-front-main-merge`) takes main into a
PR only when it is the front. Each PR then needs at most one merge-only head, at
its turn, and that head is a plain merge: O(N). There is no degraded case that
asks every behind PR to take main in any more (that fallback, used whenever the
summary was stale or named no front, was where the 34 hand merges came from).

Taking main into the front is still a new head under `strict`; the robot does it
under Owner Decisions `9e2511fe` item 3 and `78a3052f` item 2, protected-layer
PRs included since 2026-11-22 (resident DESIGN §65.6, §80). §10.4's 40 heads per
Task per 24 h needs no change: at most one merge-only head per merge remains,
and the cap is there to stop runaway loops.
