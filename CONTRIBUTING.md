# Contributing

This file adds repository practice on top of [AGENTS.md](./AGENTS.md) and the [Clued Agent Contract](./protocol/agent/agent-contract.md). Where they differ, the contract wins.

## Who contributes

The Owner, and Agents acting with the Owner's GitHub identity. CI cannot tell them apart, so every rule below applies to both. Local endpoints author commits as `AI@machine`; connector-authored commits carry the authenticated GitHub actor.

## What belongs here

Code, protocols and contracts, ADRs, schemas and migrations, tests and fixtures, runbooks, Skills, build and deployment configuration, current execution control and machine-verifiable evidence live in this repository. Product research, strategy, business, brand and visual material, reports, meeting notes, historical reviews and office documents go to Google Drive: see the README section [Documentation & Release Boundary](./README.md#documentation--release-boundary--文档与发布边界) and [docs/EXTERNAL_DOCUMENT_ARCHIVE.md](./docs/EXTERNAL_DOCUMENT_ARCHIVE.md).

## Main 的两条合入路径

合入 main 只有两条路：一是经 PR 由 GitHub 合并（`train.landing=github-merge` 时）；二是合并列车以 App 5368905 把它测过、并在推送前逐项实时准入过的提交快进推上 main（`train.landing=push` 时）。main 主规则集的 bypass 名单只含 App 5368905；“main 只许快进”规则集的 bypass 名单为空；其它任何人或自动化都不得直接推 main。此为 ADR 0018 §8 第 5 条对 #292 的修订，push 仅在上线前提齐备后启用；所有改动仍经 PR 审核。Agent 只推功能分支，正常 commit，push 前 fetch + merge，不得 force push、reset 或 rebase。详见 [GitConnectorWriteContract v0.1](./development/contracts/repository/GitConnectorWriteContract.v0.1.md)。

每个进 main 的变更仍必须是一个打开的、准入过的 PR 的 head；变的只是谁执行合并。任何 bypass 名单永不含 Owner、Admin 或任何 Agent 可用的身份；App 5368905 的私钥不得供 Agent 使用，其私钥泄露等同 main 写权限泄露，须立即撤销该 App 的 bypass 和 Contents/Workflows 权限。

## Work claims

Claim the active Task with `clued_work_claim` before editing files, running an install, build or test, starting CI or opening a pull request ([agent contract](./protocol/agent/agent-contract.md) §1.7). Native owns the PR-to-Task association: each PR has one Task, and a Task may have several PRs. Keep the current claim live, cover the actual paths and authorize each exact repository/head/target with the current private holder key. A known PR may be associated in that authorization; otherwise qualified CI discovers it from exactly one valid current authorization. No second authorization is required merely to add the discovered PR number. An absent, ambiguous or stale authorization waits or refuses; body text, actor identity and commit trailers never select the Task or default its scope to Global. Claim and scope lines in the PR or commit may document the work. Until the Native, Worker and Source successors are formally installed together, follow the actually served contract; this branch is an implementation candidate, not evidence of activation.

After a reclaim or handover, the PR follows its Task's current claim. Old keys and head authorizations do not revive: authorize the planned exact head with the new current key. Use the installed preflight to inspect the Native projection without changing it; `--head` is the full planned SHA, which may precede the push:

```bash
node scripts/ci/pr-repush-preflight.mjs --repo <owner>/<name> --pr <n> --head $(git -C <branch checkout> rev-parse HEAD) [--claim <claim_id>] [--scope project:<id>]
```

Scope comes from Native; an explicit `--scope` constrains the result and never defaults to Global. `--claim` is an optional diagnostic comparison. Exit 0 confirms the binding projection, not permission to execute or merge. Exit 1 reports a confirmed conflict or inactive/closed relation; exit 2 means unconfirmed input or transport; exit 3 means discovery, exact-head authorization or handover is pending. An initial unknown relation does not require an already active PR binding before a normal authorized push or PR creation: qualified CI must observe the actual open PR to activate it. A read-only preflight cannot do that.

`--body-governs` is retired. Updating or removing explanatory text does not change Native identity. A new head still needs its own exact authorization and full admission, including current scope, write set, fence and execution epoch. A normal lease renewal alone does not invalidate that identity or consume a rescan.

The `kooyumi-work-admission` check judges each pull request by its layer and the Owner's state ([MergeAdmission v0.1](./development/contracts/execution-admission/MergeAdmission.v0.1.md) §3–§5; the table is [config/merge-admission-policy.json](./config/merge-admission-policy.json)). The `kooyumi-admission-verified` title shows both: `<VERDICT> [<state> · <layer> · reruns <n>]`.

- **Layer**, the strictest of the pull request's paths: `protected` (next section); `docs`: `docs/**`, `development/contracts/**/*.md`, `development/authority-index/**/*.md`, root `*.md`, and `skills/**/*.md`; `code`: everything else.
- **State**, the repository variable `CLUED_MERGE_ADMISSION_STATE`, which only the Owner changes: `normal` (also when unset) requires a claim and the merge slot in every layer and allows one re-run per head, two for `docs`; `efficiency` only advises the claim and the merge slot for `code` and `docs` and allows them two re-runs; `frozen` (also for an unknown value or a bad policy file) judges every layer as `protected`, and only the Owner merges.

Take the merge slot before the final round where it is required. The slot is a first-in, first-out queue per branch (MergeAdmission §13 step 4): bring the default branch in and push, then renew the claim with the `merge:<owner>/<name>:<branch>` ref; it never conflicts, `merge_queue` shows the claim's place, and only the head of the queue holds the slot. While waiting, renew about once an hour to keep the lease and do nothing for the merge. Where the clued-admission App has Contents: write and Pull requests: write, the `clued-merge-executor` workflow brings the default branch into the queue head, and turns on auto-merge for it when its body has the line `Clued-Auto-Merge: <head sha>` naming that head (add it only once the merge of that head is approved; a later change other than bringing the default branch in needs a new line) and it is up to date and admitted and every CI workflow that ran on that head passed with its gated jobs run (MergeAdmission §13 step 5; Task 114d43cf). When GitHub can already merge such a head and every CI workflow ran and passed on it, with no job skipped, the executor merges it itself, bound to that head (Task ff476b06); the holder records that merge in BeamingFace on its next resume. Where the `clued-merge-slot-ci` workflow runs, CI keeps the head's slot while it runs on the pull request's head (90 minutes past each report, 30 once the four CI required checks pass), a CI required check that fails after the claim became head gives it back at once, takes the claim out of the queue and fails `kooyumi-merge-slot`, and the policy's `merge_slot_hard_cap_minutes` (120, counted from becoming head) ends it whatever CI does; the holder no longer renews only to keep it. Once the Owner turns on "Allow auto-merge", auto-merge may be enabled in `normal` and `efficiency`, only while the pull request's claim holds the merge slot; never in `frozen` (`kooyumi-merge-slot` fails while it is on). Re-run only with "Re-run all jobs" on the pull request's current head, as often per workflow run as the title's `reruns <n>` allows and only once that check is green; skipped gated jobs have not passed, and a refused re-run turns its run red ([agent contract](./protocol/agent/agent-contract.md) §1.7). If a re-run is refused at "Set up runner" or with "re-runs are not admitted" (a run from before this rule), close and reopen the pull request once instead. Admission is always enforced: until step 6 of MergeAdmission §13 (2026-10-09) the repository variables `CLUED_WORK_ADMISSION_ENFORCE` and `CLUED_OWNER_REVIEW_ENFORCE` could make the claim and merge slot, and the Owner grant, advisory outside `frozen`; they are no longer read. Only the policy itself advises (the `efficiency` state for the code and docs layers), and the rollback is the `frozen` state and the main ruleset's Owner emergency steps.

## Protected paths and Owner grants

The protected layer is `CORE_PROTECTED_PATHS` in [scripts/ci/merge-admission-policy.mjs](./scripts/ci/merge-admission-policy.mjs) (`.github/**`, `scripts/ci/**`, `scripts/runner/**`, `apps/clued-cloud/scripts/**`, `apps/clued-cloud/package.json`, `apps/clued-cloud/package-lock.json`, `apps/clued-cloud/wrangler*.jsonc`, `apps/clued-cloud/app/supabase-public-config.ts`, `.gitattributes`, `**/.gitattributes`, `.gitmodules`, `.npmrc`, `**/.npmrc`), plus [config/merge-admission-policy.json](./config/merge-admission-policy.json) and the paths its `layers.protected.paths` adds. Its rules are a code constant that no state relaxes. A pull request into `main` that changes one of them, or changes one against the current tip of `main`, must contain that tip and is admitted only with an Owner Grant of `repo.protected_change` that names its exact head commit; in `frozen` every pull request is treated this way. Push first: the check opens the request itself and answers `owner_review_required` with its link; give the Owner that link as returned. After the grant, edit the pull request body, which runs admission again, and wait until `kooyumi-admission-verified` is green on the head. Then use "Re-run all jobs" once on each gated workflow run of that head, and on `gitleaks` or `trivy` if they were refused. Until every self-hosted runner has the updated start hook ([scripts/runner/README.md](./scripts/runner/README.md)), a re-run refused at "Set up runner" means: close and reopen the pull request once instead. Every new head commit needs its own grant, except a head that only merges `main` into an approved one, and only when neither that merge nor `main` changed a protected file the pull request also changes (and never in `frozen`); otherwise the merged head needs a new grant.

## Local checks

From `apps/clued-cloud` (Node 22.22 or newer, see `engines` in [package.json](./apps/clued-cloud/package.json)): `npm ci`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test:unit` (`tests/rendered-html.test.mjs` reads the built server bundle, so build first). The database suites (`npm run test:db`, or a named suite such as `npm run test:work:claims`) start an embedded PostgreSQL, which needs a non-root OS user and libicu. Python checks run from the repository root as the workflows do:

```sh
python3 -m unittest tests.test_clued_components tests.test_clued_version_check -v
python3 -m unittest tests.test_clued_capture_guard tests.test_clued_work_claim_guard -v
python3 -m unittest scripts/ci/test_clued_release_tags.py -v
python3 scripts/ci/check_design_refs.py
python3 scripts/ci/check_active_doc_links.py
```

Finish with `git diff --check`.

## CI overview

- `clued-cloud-tests` ([clued-required-tests.yml](./.github/workflows/clued-required-tests.yml)) runs lint, the migration ledger, typecheck, build and the unit tests on every pull request and every push to `main`, plus App 5368905 bot pushes to `clued-train/staging`, with no path filter; `ci-suites` in the same workflow runs the repository suites the changed paths select. Staging uses the verified first parent T as its trusted checkout and CI base.
- Path-filtered heavy gates run only when their paths change, for example `Clued G4 Database Gate` ([clued-g4-database.yml](./.github/workflows/clued-g4-database.yml)); `design-refs` and `active-doc-links` guard the contracts and the entry documents.
- 六项独立 CI 必需检查 `gitleaks`、`trivy`、`contract-placement`、`kooyumi-work-admission`、`kooyumi-admission-verified`、`kooyumi-merge-slot` 均钉 App `5368905`；三项仓库/应用必需检查 `ci-suites`、`clued-cloud-tests`、`migration-verify` 钉 GitHub Actions `15368`。启用 push 落地时，主规则集再加永不发布的 `kooyumi-train-landed@5368905`，与 App bypass 同一次保存，另设无 bypass 的“main 只许快进”规则集（ADR 0018 §8）。带路径过滤的检查不能设为必需检查。
- A gated workflow runs its heavy jobs only after its `admission-gate` job has read the `kooyumi-work-admission` result. Jobs run on self-hosted runners when the actor is the repository owner and the head is in this repository, otherwise on GitHub-hosted runners, under one check name.

## Commit messages

As in `git log`: an imperative summary line; a body that says what changed and why and names the Task or Owner Decision it serves (`Task 5077b641`); then the trailers at the end, `Clued-Work-Claim`, `Clued-Work-Scope` for a non-Global Task, and the `Co-Authored-By` and session trailers of the Agent.

## Dependabot pull requests

[.github/dependabot.yml](./.github/dependabot.yml) opens weekly npm updates. GitHub Actions versions are raised by hand when needed. There is no bot exemption; the Owner's web-UI pull requests use the same admission boundary. An Agent must claim the active Task with the actual changed paths and authorize the exact bot PR head using its own current holder key. Native association and full CI admission are required; pasting claim text grants neither. Protected changes must contain the tip of `main` and have the exact-head `repo.protected_change` Owner Grant requested by the check. After approval, rerun through the existing workflow. Migration `20261002190000` lifts a Task's claim cap, not admission requirements. Dependabot runs on the GitHub-hosted runner path.
