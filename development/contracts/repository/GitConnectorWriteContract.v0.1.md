# Git Connector Write Contract v0.1

Status: **OWNER-APPROVED REPOSITORY WRITE BOUNDARY**  
Scope: authenticated GitHub/API connector writes to `tdoljyj/cross-memory-system`  
Authority effect: repository-write procedure only; no production, deployment, merge, release, schema-apply or Canonical business authority.

## Purpose

Local-worktree Git rules do not map one-to-one onto GitHub Contents/API writes. Connector-native writes therefore use an explicit compare-and-swap workflow instead of pretending to have a local worktree, local author identity, fetch/merge state or post-push shell verification.

## Required flow

1. Read the exact current target-branch commit SHA at the start of the write request.
2. Create a dedicated branch from that exact SHA for every change, including documentation. Direct writes to `main` are not allowed (see Main branch policy).
3. Fetch every file to be modified from that branch and bind its current blob SHA.
4. Update one path serially using the exact blob SHA. A stale SHA, HTTP 409 or branch movement is a conflict, not a retry hint.
5. On conflict, re-read the branch/head and changed file, reconcile the new bytes, and only then issue a new CAS write. Never overwrite unseen changes.
6. New files are created only after verifying the path does not already exist on the branch.
7. After all writes, compare the original base SHA to the branch head and inspect the complete changed-file set. Unrelated changes fail the handoff.
8. Open a PR. Merge/deploy/release remains a separate action and requires the applicable review, CI and authority.

## Main branch policy

Owner decision for tdoljyj/cross-memory-system#292: every change reaches `main` through a merged PR. There is no exception for trivial documentation. This applies to connector writes, local worktrees (Codex and other endpoints) and automation alike. A local merge commit pushed to `main` is a direct write, even if it merges a PR branch; merge on GitHub instead.

GitHub enforces this with repository ruleset `24182890` (`main write policy (#292)`) on the default branch. As read from GitHub on 2026-10-28:

- pull request required, 0 approving reviews (the Owner is the only maintainer and cannot approve their own PR);
- six required status checks, `gitleaks`, `trivy`, `contract-placement`, `kooyumi-work-admission`, `kooyumi-admission-verified` and `kooyumi-merge-slot`, each pinned to integration `5368905`, the independent CI App (Owner Decisions `89945332`, `4fedfc84`). Only the independent CI publishes them; hosted jobs are executors and never publish a required check ([docs/maintenance/independent-ci.md](../../../docs/maintenance/independent-ci.md)). A required check is never left without an integration, because then any workflow could post a passing check of the same name. A path-filtered check must never be required, because a PR that does not touch its paths would wait for it forever;
- `clued-cloud-quality` (lint, typecheck, build and the database-free unit tests; added 2026-10-07, Task 5077b641) is also path-filter-free and keeps one check name on both runner paths, so the Owner may add it to the required checks; it is not required yet;
- `strict_required_status_checks_policy` is `true`: a branch must contain the tip of `main` before it merges;
- allowed merge methods are merge, squash and rebase; linear history is not required (the repository merges with merge commits);
- force pushes and branch deletion blocked;
- empty bypass list. Agents act with the Owner's GitHub identity, so any Owner or Admin bypass would also let Agents bypass.

The repository is private and owned by a personal account, so GitHub's native merge queue is not available; repository settings have `allow_auto_merge` on and `allow_update_branch` off.

Planned change (merge train, [MergeAdmission v0.2](../execution-admission/MergeAdmission.v0.2.md), a candidate the Owner has not accepted yet): once the resident executor's merge train is on and its full sweep has found no other green `kooyumi-merge-slot`, the Owner sets `strict_required_status_checks_policy` to `false` and the allowed merge methods to merge only. The required checks and the empty bypass list do not change. Until then, and whenever the train is off, `strict` stays `true`. Only the Owner changes the ruleset; an Agent never changes `strict`, the merge methods or the required checks, and never asks the Owner to change them for its own pull request.

A second ruleset blocks deletion and force pushes on `model-program/*`, because M1-07/M1-08 evidence exists only on those branches.

Emergency or recovery: when a required check cannot run (for example the independent CI is offline for a long time) or `main` must be repaired, the Owner temporarily disables the ruleset in the repository settings, makes the change, re-enables the ruleset and records what was done and why on the related issue. An Agent never disables the ruleset or asks for it to be disabled in order to finish its own task.

While the ruleset is disabled there are no required checks, so every open pull request with auto-merge on merges at once. The Owner therefore takes these steps first:

1. Before disabling:
   - pause the resident executor, so it publishes no new green;
   - when the merge train is on, let train maintenance (stage 10) run once (it still runs while the executor is paused), so it revokes the train front's green `kooyumi-merge-slot`, if any, and reads the revocation back;
   - turn off auto-merge on every open pull request with the Owner script in [docs/maintenance/independent-ci.md](../../../docs/maintenance/independent-ci.md) (list, review, disable, list again until empty). Do this whether or not the train is on;
   - when the train is on and the executor cannot be reached, or the front's green could not be revoked and read back, set `strict` back to `true` first, keep it `true` after re-enabling, and turn it off again only after the full sweep of step 3. With `strict` on, a green that was not revoked can only merge a head that already contains the tip of `main`, which lands the tree it was tested on.
2. Disable the ruleset, repair `main`, re-enable the ruleset and read it back.
3. After re-enabling, and before the train resumes, run a full sweep, not an incremental one: `main` moved outside the train, so every older green, including any not revoked before disabling, is revoked, and the train starts again from the new tip of `main`.

Switching the required checks to other sources (the disaster procedure in [docs/maintenance/independent-ci.md](../../../docs/maintenance/independent-ci.md)) follows the same first steps; the pause and the revocation need the executor, which is often offline in a disaster. While the train is on, the Owner always sets `strict` back to `true` before changing any source. On recovery from such a switch the Owner disables the re-enabled hosted workflow, pins the six checks back to `5368905`, runs a full sweep, and only then turns `strict` off again.

## Identity and provenance

- Connector-created commits use the authenticated GitHub actor supplied by the platform. Do not fabricate an `AI@machine` Git author when the connector cannot set it.
- The PR body or handoff records the base SHA, scope, relevant validation and any conflict/reconciliation that occurred.
- A connector commit proves only that the authenticated repository actor performed the write. It does not itself prove product, production or Canonical authority.

## Prohibited behavior

- force-moving `main`, reset/rebase-overwrite semantics, or local-over-remote replacement;
- retrying a failed/stale file update with a guessed SHA;
- parallel updates to the same path;
- treating a successful API write as CI PASS, merge approval, deployment approval or production acceptance;
- bypassing a required PR because the connector technically has permission to write `main`;
- merging locally and pushing the merge commit to `main`.

## Closeout

A connector-native repository change is complete only when the exact branch head and diff are known and the required PR/CI/review boundary has been satisfied. Production and Canonical changes remain governed by their own contracts.
