# Contributing

This file adds repository practice on top of [AGENTS.md](./AGENTS.md) and the [Clued Agent Contract](./skills/clued/references/agent-contract.md). Where they differ, the contract wins.

## Who contributes

The Owner, and Agents acting with the Owner's GitHub identity. CI cannot tell them apart, so every rule below applies to both. Local endpoints author commits as `AI@machine`; connector-authored commits carry the authenticated GitHub actor.

## What belongs here

Code, protocols and contracts, ADRs, schemas and migrations, tests and fixtures, runbooks, Skills, build and deployment configuration, current execution control and machine-verifiable evidence live in this repository. Product research, strategy, business, brand and visual material, reports, meeting notes, historical reviews and office documents go to Google Drive: see the README section [Documentation & Release Boundary](./README.md#documentation--release-boundary--文档与发布边界) and [docs/EXTERNAL_DOCUMENT_ARCHIVE.md](./docs/EXTERNAL_DOCUMENT_ARCHIVE.md).

## Every change is a pull request

Every change reaches `main` through a merged pull request, whatever its size or type (tdoljyj/cross-memory-system#292). Nobody pushes `main` directly, and nobody merges locally and pushes the merge commit: merge the pull request on GitHub after its CI passes. Branches take normal commits, fetch and merge before push, and never a force push, reset or rebase. The `main` ruleset and the connector write flow are in [GitConnectorWriteContract v0.1](./development/contracts/repository/GitConnectorWriteContract.v0.1.md).

## Work claims

Claim the active Task with `clued_work_claim` before editing files, running an install, build or test, starting CI or opening a pull request ([agent contract](./skills/clued/references/agent-contract.md) §1.7). Put `Clued-Work-Claim: <claim_id>` in the pull request body and as a trailer of the head commit, and add `Clued-Work-Scope: project:<id>` when the Task is not Global. The `clued-work-admission` check verifies the claim against the pull request's changed paths; while the repository variable `CLUED_WORK_ADMISSION_ENFORCE` is unset it is advisory, and once it is on it rejects a pull request whose claim is missing, expired, superseded or too narrow. Keep the claim live until the pull request merges, and take the merge slot before the final round. Start from [.github/pull_request_template.md](./.github/pull_request_template.md).

## Protected paths and Owner grants

A pull request into `main` that changes `.github/**`, `scripts/ci/**`, `scripts/runner/**`, `apps/clued-cloud/scripts/**`, `apps/clued-cloud/package.json`, `apps/clued-cloud/package-lock.json`, `apps/clued-cloud/wrangler*.jsonc`, `apps/clued-cloud/app/supabase-public-config.ts`, `.npmrc`, `.gitattributes` or `.gitmodules` (`PROTECTED_PATHS` in [scripts/ci/clued-work-admission.mjs](./scripts/ci/clued-work-admission.mjs)) must contain the current tip of `main` and, with `CLUED_OWNER_REVIEW_ENFORCE` on, is admitted only with an Owner Grant of `repo.protected_change` that names its exact head commit. Push first: the check opens the request itself and answers `owner_review_required` with its link; give the Owner that link as returned. After the grant, edit the pull request to re-admit it, then close and reopen it once so the gated jobs run on that head. Every new head commit needs its own grant, except a head that only merges `main` into an approved one, and only when neither that merge nor `main` changed a protected file the pull request also changes; otherwise the merged head needs a new grant.

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

- `clued-cloud-quality` ([clued-cloud-quality-gate.yml](./.github/workflows/clued-cloud-quality-gate.yml)) runs lint, typecheck and the unit tests on every pull request and every push to `main`, with no path filter.
- Path-filtered heavy gates run only when their paths change, for example `Clued connection authorization candidate` ([clued-connection-authorization.yml](./.github/workflows/clued-connection-authorization.yml)) and `Clued G4 Database Gate` ([clued-g4-database.yml](./.github/workflows/clued-g4-database.yml)); `design-refs` and `active-doc-links` guard the contracts and the entry documents.
- The `main` ruleset (`main write policy (#292)`, read on 2026-10-07) requires five checks: `gitleaks`, `trivy` and `clued-work-admission` from GitHub Actions, and `clued-admission-verified` and `clued-merge-slot` from the clued-admission App; the recovery steps are in [docs/maintenance/main-admission-self-test-deadlock.md](./docs/maintenance/main-admission-self-test-deadlock.md) (written when the fifth check was not yet required). A path-filtered check is never required, because a pull request that does not touch its paths would wait for it forever.
- A gated workflow runs its heavy jobs only after its `admission-gate` job has read the `clued-work-admission` result. Jobs run on self-hosted runners when the actor is the repository owner and the head is in this repository, otherwise on GitHub-hosted runners, under one check name.

## Commit messages

As in `git log`: an imperative summary line; a body that says what changed and why and names the Task or Owner Decision it serves (`Task 5077b641`); then the trailers at the end, `Clued-Work-Claim`, `Clued-Work-Scope` for a non-Global Task, and the `Co-Authored-By` and session trailers of the Agent.

## Dependabot pull requests

[.github/dependabot.yml](./.github/dependabot.yml) opens weekly npm and GitHub Actions updates. They carry no Clued work claim and change protected paths, so once `CLUED_WORK_ADMISSION_ENFORCE` is on, `clued-work-admission` rejects them with `claim_trailer_missing` until the Owner admits them; there is no bot exemption (the Owner's own web-UI pull requests are treated the same). To admit one: an Agent claims the active Task with a `write_set` that covers the changed files, the Owner pastes `Clued-Work-Claim: <claim_id>` into the pull request body (editing the body reruns the check), the pull request must contain the tip of `main`, and with `CLUED_OWNER_REVIEW_ENFORCE` on the Owner approves the `repo.protected_change` grant that the check requests for the exact head. Then edit, close and reopen the pull request as above. The work-claim exemption of migration `20261002190000` lifts a Task's claim cap; it is not an admission exemption. Dependabot is not the repository owner, so its pull requests run on the GitHub-hosted runner path.
