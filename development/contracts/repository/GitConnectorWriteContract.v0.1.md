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

#292 修订（ADR 0018 §8 第 5 条；Owner 2026-11-17 授权准备启用）：合入 main 只有两条路：一是经 PR 由 GitHub 合并（`train.landing=github-merge` 时）；二是合并列车以 App 5368905 把它测过、并在推送前逐项实时准入过的提交快进推上 main（`train.landing=push` 时）。main 主规则集的 bypass 名单只含 App 5368905；“main 只许快进”规则集的 bypass 名单为空；其它任何人或自动化都不得直接推 main。所有变更仍经 PR 审核；connector 与本地 Agent 不得自行调用列车落地端口。push 仅在 ADR 0018 §8 前提齐备后启用，以下历史读取不证明生产已启用。

每个进 main 的变更仍必须是一个打开的、准入过的 PR 的 head；变的只是谁执行合并。任何 bypass 名单永不含 Owner、Admin 或任何 Agent 可用的身份；App 5368905 的私钥不得供 Agent 使用，其私钥泄露等同 main 写权限泄露，须立即撤销该 App 的 bypass 和 Contents/Workflows 权限。“main 只许快进”规则集的 bypass 名单始终为空，其它任何人或自动化不得直推 main；该规则集不构成私钥泄露后的写权限隔离。

GitHub enforces this with repository ruleset `24182890` (`main write policy (#292)`) on the default branch. As read from GitHub on 2026-10-28:

- pull request required, 0 approving reviews (the Owner is the only maintainer and cannot approve their own PR);
- six required status checks, `gitleaks`, `trivy`, `contract-placement`, `kooyumi-work-admission`, `kooyumi-admission-verified` and `kooyumi-merge-slot`, each pinned to integration `5368905`, the independent CI App (Owner Decisions `89945332`, `4fedfc84`). Only the independent CI publishes them; outside the Owner's disaster switch in that runbook, hosted jobs are executors and never publish a required check ([docs/maintenance/independent-ci.md](../../../docs/maintenance/independent-ci.md)). A required check is never left without an integration, because then any workflow could post a passing check of the same name. A path-filtered check must never be required, because a PR that does not touch its paths would wait for it forever;
- `clued-cloud-quality` (lint, typecheck, build and the database-free unit tests; added 2026-10-07, Task 5077b641) has no path filter and keeps one check name on both runner paths. The Owner may add it to the required checks once the independent CI publishes it, pinned to `5368905` like the six; it is not required yet;
- `strict_required_status_checks_policy` is `true`: a branch must contain the tip of `main` before it merges;
- allowed merge methods are merge, squash and rebase; linear history is not required (the repository merges with merge commits);
- force pushes and branch deletion blocked;
- 历史读取时 bypass 为空。push 上线配置：主规则集 bypass 仅 App `5368905`，与必需检查 `kooyumi-train-landed@5368905` 同一次保存；独立“main 只许快进”规则集的 bypass 为空，保留禁止删除、禁止非快进和 S 上三项 Actions 必需检查。Owner/Admin 与其它自动化不得 bypass。

The repository is private and owned by a personal account, so GitHub's native merge queue is not available; repository settings have `allow_auto_merge` on and `allow_update_branch` off.

Historical planned change (merge train, [MergeAdmission v0.2](../execution-admission/MergeAdmission.v0.2.md), a candidate the Owner has not accepted yet): the Owner sets `strict_required_status_checks_policy` to `false` and the allowed merge methods to merge only once all of these hold (MergeAdmission v0.2 §3.3):

- the resident executor's merge train is on;
- its full sweep in train mode has found no other green `kooyumi-merge-slot`;
- the step-6 contracts have landed: MergeAdmission v0.2 is accepted, and KooYomi has published the new agent contract after the Owner's acceptance and Grant.

该历史计划由 Owner 一次保存或先改合并方式；当时不改必需检查与 bypass。push 后继方案改按 ADR 0018 §8，保持 strict=true，船队统一策略 `FLEET_TRAIN` 随通用包下发，取代一次 UAC 写策略。列车关闭时 strict 同样保持 true。只有 Owner 改规则集；Agent 不为自己的 PR 改 strict、合并方式或必需检查，也不请求 Owner 为自己的 PR 改这些设置。

A second ruleset blocks deletion and force pushes on `model-program/*`, because M1-07/M1-08 evidence exists only on those branches.

Emergency or recovery: when a required check cannot run (for example the independent CI is offline for a long time) or `main` must be repaired, the Owner temporarily disables the ruleset in the repository settings, makes the change, re-enables the ruleset and records what was done and why on the related issue. An Agent never disables the ruleset or asks for it to be disabled in order to finish its own task.

While the ruleset is disabled there are no required checks, so every open pull request with auto-merge on merges at once. The Owner therefore takes the steps below. They were added on 2026-10-28 with the merge-train contracts. Pausing the executor and turning off auto-merge apply from then on, whether or not the train is on. The stage-10 and `strict` items apply while the train is on (`train.enabled=on`).

1. Before disabling:
   - pause the resident executor with a PAUSE request (contract `clued.independent-ci.resident-pause/1` in its `requests\` directory; only the elevated Owner resumes it), so it publishes no new green. The intake pause is not enough: it lets a running batch, or one parked before stage 8, publish a green. The runbook gives the command, which works until step 3c-2 adds one to the rearm tool, and says how to confirm the pause (`state\PAUSED.json` appears). Wait until the status shows the executor paused with no batch running. If the executor cannot be reached (for example in a disaster), skip this;
   - when the train is on, let train maintenance (stage 10) run once, so it revokes the train front's green `kooyumi-merge-slot`, if any, and reads the revocation back. Step 3c-2 must let stage 10 (revocation and sweep only) run while the executor is paused (phase-2 design §4.3); until it does, treat the revocation as not done;
   - turn off auto-merge on every open pull request with the Owner script in [docs/maintenance/independent-ci.md](../../../docs/maintenance/independent-ci.md) (list, review, disable, list again until empty), and list once more just before disabling;
   - when the train is on and the executor cannot be reached, or the front's green could not be revoked and read back, set `strict` back to `true` first, keep it `true` after re-enabling, and turn it off again only after the full sweep of step 3. When `main` is repaired forward, the new tip contains the old one, so with `strict` on a green that was not revoked can only merge a head that contains the old tip too, which lands the tree it was tested on.
2. Disable the ruleset, repair `main`, re-enable the ruleset and read it back. Repair `main` forward only, with new commits such as reverts. While the train is on, never force `main` back to an older commit: older merged heads that carry six green checks would then be outside `main`, and a new pull request from one of them could merge before the sweep. If a rewind cannot be avoided, set `strict` back to `true` and the admission state `CLUED_MERGE_ADMISSION_STATE` to `frozen` before disabling (MergeAdmission v0.1 §4.1 item 2; Agents do not merge or enable auto-merge in `frozen`), and keep both until the full sweep is done. Switching to `frozen` for the whole time the ruleset is disabled is recommended in any case, because the auto-merge script cannot stop anyone from enabling auto-merge again or merging by hand afterwards.
3. After re-enabling, and before the train resumes, run a full sweep, not an incremental one: `main` moved outside the train, so every older green, including any not revoked before disabling, is revoked, and the train starts again from the new tip of `main`. Then resume the executor with the installed `rearm-resident.ps1 -Request Resume` (elevated); until then the independent CI stays stopped.

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
