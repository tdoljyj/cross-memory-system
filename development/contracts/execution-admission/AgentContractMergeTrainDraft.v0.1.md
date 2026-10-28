# Agent Contract: merge train changes, draft v0.1 (not published)

Status: **DRAFT. Not published and not normative.** The live contract is [protocol/agent/agent-contract.md](../../../protocol/agent/agent-contract.md) (version 53 on main `f0a401d4`), and Agents follow it, served by BeamingFace, until a new version is published. This file only proposes the text that changes when the resident executor's merge train is on. It does not change the live contract file and is not a contract component.

Publication: KooYomi publishes a new contract version only after the Owner accepts this draft and grants the publication (Owner Decision `72ed7fb4`). That happens at step 6 of the phase-2 design, before the Owner turns `strict` off at step 7. The version number is assigned at publication, not here.

说明（给 Owner）：这份草稿把额度第二期设计 v0.5 §5.8、§5.11 要求的 Agent 合同改动写成可以直接放进合同的英文条文。它只是草稿，进仓库不等于发布；发布要 Owner 接受并发 Grant，由 KooYomi 发新版本。改动的核心：列车开着、`strict` 关掉以后，PR 准备好就入队，不必先等 CI 变绿，也不为列车把 main 合进分支；当了车头、PR 页面显示“正在测”之后才开 auto-merge，只用 merge 方式；PR 页面提示“你仍是车头：请合 main”时照做。

Sources: phase-2 design v0.5 (Drive `10_E_工程与平台/CI基础设施/常驻执行器额度第二期_含合并列车_设计说明_v0.5_20261022.md`, sha256 `bd20941b0cf89b0819790a00357a1b2e79965718cee44d5d24c86123fc6d64cb`) §5.2, §5.8, §5.10, §5.11; [MergeAdmission v0.2](MergeAdmission.v0.2.md) (candidate); Task `a1d93067`.

## How to read this draft

- Each change names the live text it replaces, by section and opening words, and gives the replacement text. Live text not named here stays as it is.
- When the train applies: the proposed text ties the train rules to one signal an Agent can read, the `main` ruleset's `strict` setting. The Owner turns `strict` off only while the train runs and after the full sweep (MergeAdmission v0.2). While `strict` is on, the live merge-queue rules keep working with the train running: a head that contains the tip of `main` is tested as itself. So Agents switch to the train rules exactly when `strict` goes off, and back when the Owner turns it on again (rollback, emergency or disaster).

## Change 1: §1.7, the merge paragraph

Live text (§1.7, paragraph beginning "When a merge slot is required"):

> When a merge slot is required, join its queue only for a ready PR whose required merge approval exists; only its head merges. Follow Appendix A.6 for refreshing main, opt-in, queue and CI timing, dependent PRs and release of the slot. Disable auto-merge when a required CI check fails or merge is refused; leave the queue as A.6 requires or when work stops; never hold the slot while awaiting something else. Skipped gated jobs do not count as passed.

Proposed text:

> When a merge slot is required, join its queue only for a ready PR whose required merge approval exists; only its head merges. Follow Appendix A.6 for refreshing main, opt-in, queue and CI timing, dependent PRs and release of the slot. Where the merge train applies (Appendix A.6), join without waiting for CI and without bringing main in for the train, follow the pull request page when it asks you to act, enable auto-merge only once your pull request is the train front and being tested, and merge only with the merge method. Disable auto-merge when a required CI check fails or merge is refused; leave the queue as A.6 requires or when work stops; never hold the slot while awaiting something else. Skipped gated jobs do not count as passed.

## Change 2: Appendix A.6, first bullet

Live text (A.6, first bullet):

> Take the merge slot before you merge into the default branch, unless `efficiency` waives it (see [Appendix A.5](#appendix-a5)).

Proposed text:

> Take the merge slot before you merge into the default branch, unless `efficiency` waives it (see [Appendix A.5](#appendix-a5)). Where the merge train applies, `efficiency` never waives it: every layer merges only as the train front.

## Change 3: Appendix A.6, new last sub-bullet "Merge train"

Add after the live sub-bullet "Merge dependent pull requests one at a time…", as the last sub-bullet of A.6's first bullet:

> - **Merge train.** The merge train applies while the default branch's ruleset has `strict` off: read `GET /repos/<owner>/<name>/rules/branches/<branch>`; the `required_status_checks` rule has `strict_required_status_checks_policy` set to `false`. The Owner turns `strict` off only while the repository's resident executor runs the train. While `strict` is on, the sub-bullets above apply unchanged, even if the train runs. Where the train applies, these rules replace the sub-bullets above wherever they differ:
>   - The train is the merge queue itself, and its head is the train front. Only the front is tested for merging: the resident executor tests GitHub's test merge of your head with the current tip of the default branch, and publishes the required checks on your head. The checks say that this merge result passed.
>   - Join the queue as soon as the pull request is ready and its merge approved where approval is needed. Do not wait for CI to turn green first, and do not bring the default branch in or push for the train. CI runs when your pull request is the front, unless the pull request page says the repository also tests pull requests that are not the front. A `protected`-layer pull request must still contain the tip ([Appendix A.5](#appendix-a5)).
>   - The resident executor writes its messages to you on the pull request page as an info-only commit status, `resident-queue/<node> (info only)` (`resident-queue (info only)` on older installs). This is its only channel to you, so read it whenever you renew or check the pull request, and act on it:
>     - "you are still the front: bring main in and push before <time>": merge the default branch in and push before that time; the new head stays the front. KooYomi enforces that time: renewals cannot extend the front's slot past it;
>     - "get the Owner grant or the quota, then join again": do so, and join again;
>     - "not enough front time for a run": let the slot lapse, then join again at the back.
>   - Enable auto-merge only after the pull request page shows that your pull request is the front and is being tested, and only with the merge method: `gh pr merge --auto --merge`. Never enable it when you join: while the ruleset is disabled in an emergency, every pull request with auto-merge on merges at once, and a waiting pull request has not been tested yet. Without auto-merge, merge yourself once all required checks are green, with the merge method and pinned to the head (the merge API's `sha`). Squash and rebase are never used. In `frozen`, the live rules apply: do not merge or enable auto-merge.
>   - Ask the Owner any "ask before merging" question before your pull request becomes the front, or at the latest before you enable auto-merge.
>   - A new head on the front pull request withdraws the old head's green `kooyumi-merge-slot` and must be tested again, so push to the front only when the pull request page asks you to or the change needs it. Never push a pull request back to an older commit, reopen a pull request, or open a new one from an older commit to reuse its checks: the train withdraws such greens.
>   - When a test of the front fails, KooYomi takes the claim out of the queue and sends you a CI failure notice ([Appendix A.3](#appendix-a3)): fix the cause, push, and join again at the back.
>   - After your pull request merges, the resident executor gives the slot back with its CI identity. You still record the merge in BeamingFace and release the claim. The hosted `clued-merge-executor` workflow and the `Clued-Auto-Merge` body line do not apply: the executor never merges or brings the default branch in.
>   - Waiting stays as above: do nothing for the merge, and renew about once an hour to keep your lease. Merge dependent pull requests one at a time: the second waits in the queue, and brings the default branch in only if the pull request page asks.
>   - Never change the ruleset's `strict`, its merge methods or its required checks, never disable the ruleset, and never turn off auto-merge on another holder's pull request. The Owner's emergency and disaster steps cover these (`development/contracts/repository/GitConnectorWriteContract.v0.1.md`, `docs/maintenance/independent-ci.md`).

The links to `#appendix-a3` and `#appendix-a5` in the proposed text point at the live contract's anchors; they resolve once the text sits in the contract file.

## Not changed by this draft

- Claims, the claim and scope trailers in the pull request body and head commit, the CI head meter, protected-change grants, reruns and manual workflows (§1.7, Appendices A.1–A.5, A.7, A.8).
- The queue's FIFO order, the 45-minute slot clock, renewals that keep a waiting entry's place, and leaving the queue (Appendix A.6, as far as Change 3 does not replace them).
- KooYomi server behaviour. Train version 1 needs no server change (design v0.5 §5.8). The optional server follow-ups there, a full queue read and a car status field, would need their own contract text when they ship.

## Review and publication checklist

1. Independent review of this draft together with MergeAdmission v0.2 (rule `01d4ba7d`).
2. Owner acceptance of the text, recorded as a Decision.
3. Owner Grant for the publication; KooYomi publishes the new version, and `config/clued-components.json` and the served `/clued-agent.md` follow the normal contract release path.
4. Only then does the Owner turn `strict` off (design step 7).
