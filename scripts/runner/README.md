# Clued self-hosted runner pre-job check

Task `869d2db7`, Owner Decision `b0c53143`. Every self-hosted runner that serves this repository runs `clued-runner-job-started.mjs` before each job, through the runner's `ACTIONS_RUNNER_HOOK_JOB_STARTED` setting. The check lives on the runner machine, outside the repository. A branch that edits a workflow therefore cannot remove it.

## What it allows

A job starts only when its run is one of the following:

- **On `main`:** a push, a schedule, `workflow_run`, `pull_request_target`, or a manual dispatch. A `pull_request_target` run counts only for a pull request into `main` (re-review 7, m1): it runs on `main`'s ref whatever the pull request's base, and a workflow may check out that base, which is the Agent's to edit when it is another branch.
- **A pull request into `main` that changes no file under `.github/workflows/`.** Each workflow keeps its `admission-gate` job, which waits for the Clued admission of the pull request.
- **A pull request into `main` that changes a workflow,** once `main`'s admission run of the same event as the job's run has succeeded.
  - That admission run is the newest `pull_request_target` run of `clued-work-admission.yml` on the head created no earlier than 15 seconds before the job's run. GitHub creates the runs of one event together. Skipped runs are left out: the admission job skips pull requests into other branches.
  - While that admission run is still going, the job waits for it (up to `CLUED_RUNNER_HOOK_WAIT_SECONDS`).
  - An older success on the same head does not count: for example after a force-push back to an admitted commit, or a pull request closed and reopened (even within seconds).
  - Only `main`'s code decides. `pull_request_target` runs the default branch's copy of the workflow whatever the pull request's base, and that copy checks out `main` and runs only for pull requests into `main` (re-review 6, B1). A branch's edited copy never runs on `pull_request_target`.
  - The run succeeds only when its admission step does. That is the same condition on which it posts the `clued-admission-verified` App check.
  - The check itself is not read: a fine-grained token cannot read the Checks API (Task `b979d5a2`). Unlike the check, a run does not name its pull request. Another pull request into `main` with the same head, whose event came within 15 seconds, can therefore stand in. Its admission run judged the same commit and the same workflow changes.
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
   - Grant Actions: read and Contents: read. Nothing else (Metadata: read comes with them).
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

   On Windows, the hook line points to `C:\ProgramData\CluedRunnerHook\clued-runner-job-started.ps1`, and the node line points to `externals\node20\bin\node.exe`.
4. **Check the output.** Watch one pull request run and one push to `main`. Each job log starts with a "Set up runner" section that shows `clued-runner-hook: ALLOW ...` or `WOULD REFUSE ...`.
5. **Turn on enforcement.** Set `CLUED_RUNNER_HOOK_ENFORCE=true` and restart the runner.
6. **Make the setting unreachable from jobs.** Every job runs as the runner's service account, including the ungated short checks that run a pull request's own code. On a standard install that account owns the runner directory and its `.env`, so a job can delete the hook line or set `CLUED_RUNNER_HOOK_ENFORCE=false`, and the next listener restart (a self-update, a service restart, a reboot) turns the check off for every later job (re-review 7, MAJOR-4). Do one of the following:
   - **Ephemeral runners (the only hard guarantee).** Register each runner with `--ephemeral` (or a just-in-time config) on a machine or VM that is reset after one job. A job then cannot leave anything behind for the next one.
   - **A hardened persistent runner (reduces the risk, not a guarantee; re-review 8, MINOR-4).** A job can still start a process that outlives it (on Windows, a scheduled task or a detached process escapes the job's cleanup), keep using the machine after its timeout, and read or change later jobs' work directories. These runners are Windows machines, where that is easiest.
     - Linux: put the five settings in a root-owned systemd drop-in (`/etc/systemd/system/<runner service>.d/clued-hook.conf`, one `Environment=` line each) instead of `.env`. Make the runner directory, `.env`, `.runner`, `.credentials*`, `bin/` and `externals/` owned by root and only readable by the service account; leave `_work/` and `_diag/` writable. Configure the runner with `--disableupdate` (a self-update needs to write `bin/`) and update it by hand. Set `kernel.yama.ptrace_scope` to 1 or more so a job cannot attach to the listener.
     - Windows: put the settings in the service's `Environment` value under `HKLM\SYSTEM\CurrentControlSet\Services\<runner service>` (administrators only). Give the service account Read on the runner folder except `_work` and `_diag`, and configure the runner with `--disableupdate`.
   - Either way, check after a restart that `clued-runner-hook: ALLOW ...` still appears in a job's "Set up runner" section.

   The token file stays readable by jobs: the check runs as the same account. It is a read-only token (Actions and Contents: read) for this repository, which the job's own `GITHUB_TOKEN` can already read.

## What it does not protect

- **Write access to the runner machine.** A job is an Agent's code on the runner machine. Without step 6, any job that runs a pull request's code (the ungated short checks below) can turn the check off for later jobs by editing `.env`. An Agent that can log in to the runner machine, or a job on a runner without step 6, can change or remove the check.
- **Non-workflow code.** A pull request that changes no workflow still runs its own code in the jobs `main` defines.
  - In the gated workflows, the heavy jobs wait for the admission gate.
  - The ungated short checks run anyway, even for a pull request no claim covers. These are the self-hosted workflows without an `admission-gate` job, for example `model-program-*`, `mps03-native-agent`, `multitrack-governance-projection`, `node-profile-policy`, `runner-budget-policy`, `gitleaks` and `trivy`; also `memory-publication-gate` (`pull_request_target`, once per pull request event into `main` that touches `memory/` or the snapshots, `main`'s verifier) and `public-mcp-gate-receipt` (`workflow_run`, `main`'s code), which runs each time `public-mcp-protocol`, `public-mcp-behavior`, `gitleaks` or `trivy` completes for a pull request run of the Owner's account, up to four times per push, with no claim.
  - Each of their self-hosted jobs has a timeout of 25 minutes or less, except `model-program-m0`. That file's hash is pinned in the frozen M0 manifest, so it keeps GitHub's 6-hour default. (`clued-integration-runtime-nightly` has 75 minutes, but runs on `main` only.)
  - The admission check refuses a pull request that adds a self-hosted job to an ungated workflow, moves a hosted job to a self-hosted runner, drops or raises a self-hosted job's timeout, or adds or changes its `strategy` (a matrix).
- **Draft pull requests.** The hourly re-verification skips drafts, so a draft's admission is not re-checked after its claim ends. A draft's runs still need an admission run of their own event.
- **`main`'s own runs.** Anyone who can dispatch workflows can start `main`'s workflows (for example `clued-integration-runtime-nightly.yml`). They run `main`'s code and are not metered. `main`'s code is not reviewed by a person: the ruleset requires no approval, and Agents merge their own pull requests once the checks pass. Admission asks the Owner (an Owner Grant on the exact head commit) for every change to the paths listed in WorkClaimAdmission §4.6: all of `.github/`, `scripts/ci/`, this directory, the release scripts and their dependencies, `.gitattributes` and `.gitmodules`, read both from the pull request and from its merge into `main` as it is now. A change to other code that a job runs (the Worker and app source, other scripts) reaches `main` without the Owner, and so does everything until the Owner sets `CLUED_OWNER_REVIEW_ENFORCE=true`.
