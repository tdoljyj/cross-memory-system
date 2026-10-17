# main admission self-test deadlock

Applies when `clued-work-admission` cannot admit any pull request into `main`
because the admission script's own self-test fails on `main`. A fix pull request
cannot admit itself, so the Owner unlocks one merge with a temporary ruleset
bypass. First occurrence: 2026-10-05, #552 → #553 (Owner Decision `7e006aa4`).

## Why it deadlocks

`.github/workflows/clued-work-admission.yml` runs on `pull_request_target` and
checks out the **default branch**. It runs `main`'s copy of
`scripts/ci/clued-work-admission.test.mjs` (and the other self-tests in that
step) before it evaluates the claim. When that self-test fails on `main`:

- the admission step is skipped and the clued-admission App posts
  `clued-admission-verified` = NOT ADMITTED on every pull request;
- a pull request that fixes the self-test is evaluated with `main`'s broken copy,
  so it is refused too;
- the `main write policy (#292)` ruleset (id `24182890`) requires
  `clued-work-admission` and `clued-admission-verified` and has no bypass actors,
  so nothing can merge.

Typical cause: a pull request changes something the self-test pins (for example a
new gated workflow that the hard-coded lists in `clued-work-admission.test.mjs`
do not name). That pull request itself passes, because its admission ran
`main`'s older self-test.

## Symptoms

- `clued-work-admission` fails on every pull request, and its log shows the
  self-test step failing (`# fail N`) followed by `ADMISSION_OUTCOME: skipped`.
- `clued-admission-verified` reads `NOT ADMITTED` with an empty verdict.
- The same failure appears on pull requests that do not touch `scripts/ci/`.

## Confirm

Run the self-test on `main` itself. The deadlock is confirmed only if `main`
fails the same tests:

```sh
git fetch origin main
git worktree add /tmp/main-check origin/main
cd /tmp/main-check && node --test scripts/ci/clued-work-admission.test.mjs
```

If `main` passes, the failure belongs to the pull request; do not use this runbook.

## Unlock

1. **Fix pull request.** Branch from `origin/main`, fix only what the self-test
   needs, show it passing locally on top of `main`, and open the pull request
   with a work claim as usual. gitleaks and trivy must pass on it.
   Comment on the pull request that it cannot admit itself and why.
2. **Snapshot the ruleset** before anyone changes it:
   `gh api repos/tdoljyj/cross-memory-system/rulesets/24182890 > ruleset-before.json`.
3. **Owner adds a temporary bypass.** Settings → Rules → Rulesets →
   `main write policy (#292)` → Bypass list → add `Repository admin`
   (`For pull requests only` where offered). Save.
4. **Owner merges the fix pull request by hand** with
   "Merge without waiting for requirements to be met (bypass rules)".
5. **Owner removes the bypass** in the same ruleset and saves.
6. **Verify the restore** (Agent):

   ```sh
   gh api repos/tdoljyj/cross-memory-system/rulesets/24182890 > ruleset-after.json
   ```

   Then compare `rules` and every other field except `updated_at` with
   `ruleset-before.json`. `bypass_actors` must be `[]`.
   The four required checks and their sources must be unchanged:
   `gitleaks`, `trivy` and `clued-work-admission` from GitHub Actions
   (`integration_id` 15368), and `clued-admission-verified` from the
   clued-admission App (`integration_id` 5164952).
7. **Re-admit blocked pull requests.** Merge `main` into each one, run the
   self-test locally, push. Admission runs again on `main`'s fixed copy.

## Never

- Never remove or edit the required checks to get past the deadlock.
  `clued-admission-verified` is bound to the clued-admission App. If it is re-added
  with the wrong source, any workflow could post a passing check of that name, and
  the gate would be quietly disabled.
- While the bypass exists, an Agent merges nothing and pushes nothing to `main`.
  Agents use the Owner's GitHub identity, so the bypass applies to them too.
  Only the Owner merges, and only the fix pull request.
- Never re-run admission or push an empty commit to "kick" it. It will keep failing
  until `main` carries the fix.

## Record

- Record the Owner's unlock decision in KooYomi before the bypass is added.
- Record each merge, with its merge commit, as soon as it happens.
- Record the verified restore with the closure of the fix Task.
