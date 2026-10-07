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

GitHub enforces this with a repository ruleset on the default branch:

- pull request required, 0 approving reviews (the Owner is the only maintainer and cannot approve their own PR);
- required status checks `gitleaks`, `trivy` and `clued-work-admission` (GitHub Actions) and `clued-admission-verified` and `clued-merge-slot` (the clued-admission App), as read from the ruleset on 2026-10-07; `docs/maintenance/main-admission-self-test-deadlock.md` lists the first four. `gitleaks` and `trivy` have no path filter and keep the same check name on the trusted and untrusted runner paths. A path-filtered check must never be required, because a PR that does not touch its paths would wait for it forever;
- `clued-cloud-quality` (lint, typecheck, build and the database-free unit tests; added 2026-10-07, Task 5077b641) is also path-filter-free and keeps one check name on both runner paths, so the Owner may add it to the required checks; it is not required yet;
- force pushes and branch deletion blocked; linear history not required (the repository merges with merge commits);
- empty bypass list. Agents act with the Owner's GitHub identity, so any Owner or Admin bypass would also let Agents bypass.

A second ruleset blocks deletion and force pushes on `model-program/*`, because M1-07/M1-08 evidence exists only on those branches.

Emergency or recovery: when a required check cannot run (for example every self-hosted runner is offline) or `main` must be repaired, the Owner temporarily disables the ruleset in the repository settings, makes the change, re-enables the ruleset and records what was done and why on the related issue. An Agent never disables the ruleset or asks for it to be disabled in order to finish its own task.

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
