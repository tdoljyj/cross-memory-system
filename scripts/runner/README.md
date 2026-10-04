# Clued self-hosted runner pre-job check

Task `869d2db7`, Owner Decision `b0c53143`. Every self-hosted runner that serves this repository runs `clued-runner-job-started.mjs` before each job, through the runner's `ACTIONS_RUNNER_HOOK_JOB_STARTED` setting. The check lives on the runner machine, outside the repository. A branch that edits a workflow therefore cannot remove it.

## What it allows

A job starts only when its run is one of the following:

- **On `main`:** a push, a schedule, `workflow_run`, `pull_request_target`, or a manual dispatch.
- **A pull request into `main` that changes no file under `.github/workflows/`.** Each workflow keeps its `admission-gate` job, which waits for the Clued admission of the pull request.
- **A pull request into `main` that changes a workflow,** once its head carries a successful `clued-admission-verified` check from the `clued-admission` GitHub App.
  - The check must be posted after the job's run was created, and the newest such check decides. An older success on the same head does not count: for example after a force-push back to an admitted commit, a reopened pull request, or a second pull request with the same head.
  - Only `main`'s admission run can post that check. The App key lives in the `clued-admission` environment, which deploys from `main` only.
  - That run executes `main`'s current code, which checks the workflow change.
  - A workflow run's `pull_requests` list is not used. It names every open pull request with the same head, not the one that triggered the run.
- **A manual dispatch on another branch of `clued-connection-authorization.yml`, `clued-g4-database.yml` or `information-flow-e2e.yml`,** when the branch's `.github/workflows` directory is exactly `main`'s (same files, same object ids).
  - A branch behind `main` must merge `main` first.
  - These workflows keep their dispatch gate, which needs a Clued admission run for the dispatched commit.
  - Other dispatchable workflows have no gate, so they run on `main` only.

Everything else is refused before any step runs: pushes to other branches, pull requests into other branches, and other events.

**Re-runs.** A re-run of a pull request or branch dispatch run (run attempt 2 or later) is refused, including "Re-run failed jobs". A re-run replays its run's own workflow file and event, which may come from before the gates existed. Push a new commit instead. `main`'s own runs may be re-run.

While `CLUED_RUNNER_HOOK_ENFORCE` is not `true`, the check only prints a warning.

## Install (once per runner machine, by the Owner)

1. **Create a read-only token.**
   - Use a fine-grained GitHub token for this repository only.
   - Grant Contents: read, Actions: read, Checks: read and Pull requests: read. Nothing else.
2. **Copy the check into a directory the runner's service account can read but not write.**
   - Linux or WSL2, as root:

     ```sh
     install -d -m 755 /opt/clued-runner-hook
     install -m 644 scripts/runner/clued-runner-job-started.mjs /opt/clued-runner-hook/
     install -m 755 scripts/runner/clued-runner-job-started.sh /opt/clued-runner-hook/
     printf '%s\n' '<token>' > /opt/clued-runner-hook/token
     chown root:<runner group> /opt/clued-runner-hook/token
     chmod 640 /opt/clued-runner-hook/token
     ```

   - Windows: copy the `.mjs` and `.ps1` files to `C:\ProgramData\CluedRunnerHook\`. Write the token to `token` in the same folder. In the folder's security settings, give the runner service account Read only.
   - Copy the files from a reviewed `main` commit, and note that commit. The installed copy does not follow the repository; update it by copying again.
3. **Add these lines to the runner's `.env` file** (in the runner directory), then restart the runner service.

   ```
   ACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/clued-runner-hook/clued-runner-job-started.sh
   CLUED_RUNNER_HOOK_NODE=<runner directory>/externals/node20/bin/node
   CLUED_RUNNER_HOOK_REPOSITORY=tdoljyj/cross-memory-system
   CLUED_RUNNER_HOOK_TOKEN_FILE=/opt/clued-runner-hook/token
   CLUED_RUNNER_HOOK_ENFORCE=false
   ```

   The check trusts the `clued-admission` App with id `5164952`. If the App is ever replaced, add `CLUED_RUNNER_HOOK_ADMISSION_APP_ID=<new id>`.

   On Windows, the hook line points to `C:\ProgramData\CluedRunnerHook\clued-runner-job-started.ps1`, and the node line points to `externals\node20\bin\node.exe`.
4. **Check the output.** Watch one pull request run and one push to `main`. Each job log starts with a "Set up runner" section that shows `clued-runner-hook: ALLOW ...` or `WOULD REFUSE ...`.
5. **Turn on enforcement.** Set `CLUED_RUNNER_HOOK_ENFORCE=true` and restart the runner.

## What it does not protect

- **Write access to the runner machine.** An Agent that can write the runner machine, its `.env` file, or this directory can change or remove the check. Keep Agents off the runner machines, or keep these files out of their reach.
- **Non-workflow code.** A pull request that changes no workflow still runs its own code in the jobs `main` defines.
  - In the gated workflows, the heavy jobs wait for the admission gate.
  - The ungated short checks run anyway, even for a pull request no claim covers. These are the self-hosted workflows without an `admission-gate` job, for example `model-program-*`, `mps03-native-agent`, `multitrack-governance-projection`, `node-profile-policy`, `runner-budget-policy`, `gitleaks` and `trivy`.
  - Each of their self-hosted jobs has a timeout of 25 minutes or less, except `model-program-m0`. That file's hash is pinned in the frozen M0 manifest, so it keeps GitHub's 6-hour default. (`clued-integration-runtime-nightly` has 75 minutes, but runs on `main` only.)
  - The admission check refuses a pull request that adds a self-hosted job to an ungated workflow, moves a hosted job to a self-hosted runner, or drops or raises a self-hosted job's timeout.
- **Draft pull requests.** The hourly re-verification skips drafts, so a draft's admission is not re-checked after its claim ends. A draft's runs still need a check posted after they were created.
- **`main`'s own runs.** Anyone who can dispatch workflows can start `main`'s workflows (for example `clued-integration-runtime-nightly.yml`). They run `main`'s reviewed code and are not metered.
