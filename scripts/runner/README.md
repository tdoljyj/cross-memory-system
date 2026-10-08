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

While `CLUED_RUNNER_HOOK_ENFORCE` is not `true`, the check only prints a warning.

## Re-runs

MergeAdmission v0.1 §8, Owner Decisions `77216370` and `1b93760d`. A re-run is run attempt 2 or later. It replays its run's own event and workflow files.

- **`main`'s own runs** (push, schedule, `workflow_run`, `pull_request_target`, a manual dispatch on `main`) may be re-run, as before. That includes the admission workflow (`clued-work-admission.yml`). It runs `main`'s code and reads the pull request and `main` afresh every time, so it may be re-run without limit.
- **A manual dispatch on another branch** is never re-run. Dispatch again.
- **A pull request run** may be re-run only while the pull request is open, still into `main`, and its head is still the run's head (the hook reads the pull request from GitHub; any error refuses). Then:
  - The **`admission-gate` job** starts. The gate decides whether this attempt is within the policy's re-runs per head (the `reruns <n>` in the `clued-admission-verified` check's title).
  - **`gitleaks.yml` and `trivy.yml`** (required checks without a gate) may be re-run once: attempt 2 only.
  - **Every other job** starts only when this attempt's `admission-gate` job ran again and succeeded. "Re-run all jobs" does that. "Re-run failed jobs" and re-running a single job do not run a successful gate again: GitHub lists the earlier gate job in the new attempt, successful, but with the earlier attempt's start time. The hook therefore requires a gate job named exactly `admission-gate`, completed with success, that started no earlier than the attempt did (the run's `run_started_at`). A job list that GitHub does not return complete, or a time it cannot read, refuses.
  - A pull request that changes a workflow still needs a successful admission run of its event, on every attempt, exactly as for the first one. The newest admission run on the head decides, so after an Owner grant the run of the pull request body edit counts.
  - The run attempt the runner reports (`GITHUB_RUN_ATTEMPT`) and the one GitHub reports for the run must agree; otherwise the job is refused.
- **A refused re-run still uses up its attempt number.** The next re-run of the same run is one attempt later.
- **Never re-run an old head's run.** It is refused anyway, and its concurrency group can cancel the current head's run before any job starts.

**After an Owner grant for a protected change:** edit the pull request body, which runs admission again, and wait until `clued-admission-verified` is green on the head. Then use "Re-run all jobs" once on each gated workflow run of that head (and on `gitleaks` / `trivy` if they were refused). Until every runner has this version of the check (see below), a re-run refused at "Set up runner" means a runner still has the old one: fall back to closing and reopening the pull request once.

## Updating the check

The installed copy does not follow the repository. To update it:

1. After the change is merged, copy only `clued-runner-job-started.mjs` from that merged `main` commit to every runner, over the installed copy (the directory of Install step 2 below). The wrappers (`.sh`, `.ps1`), the App key and the `.env` lines stay as they are. The runner starts the script afresh for every job, so no restart is needed.
2. Confirm each runner's version: every `ALLOW` / `REFUSE` line ends with `[hook <version>]` (this version: `merge-admission-step2`). The runner heartbeat (`clued-ci-runner-heartbeat`, every 15 minutes on `main`) shows it in each runner's "Set up runner" section.

A runner not yet updated refuses every re-run of a pull request run. That is safe; fall back to closing and reopening the pull request.

## Install (once per runner machine, by the Owner)

1. **Create the hook's read-only GitHub App** (once, shared by all runners; Owner Decision `d8bc893c`).
   - In the Owner account: Settings → Developer settings → GitHub Apps → New GitHub App. Turn the webhook off. Repository permissions: Actions: read and Contents: read, nothing else (Metadata: read comes with them). Let it be installed on this account only.
   - Install it on this repository only (Only select repositories). Note the App ID, then generate a private key (a `.pem` file).
   - The hook calls GitHub as this App, on the App's own rate limit. It must not share a limit with the Owner's account: on 2026-10-07 an Agent's script spent the Owner's hourly limit, which the hook's personal token shared, and every pull request job was refused.
   - Never use the clued-admission App here. It posts the admission checks, and every job can read the key on a runner; the hook refuses its App id. Do not use a second account's token either: a collaborator on a personal repository can always push.
2. **Copy the check into a directory the runner's service account can read but not write.**
   - Linux or WSL2, as root:

     ```sh
     install -d -m 755 /opt/clued-runner-hook
     install -m 644 scripts/runner/clued-runner-job-started.mjs /opt/clued-runner-hook/
     install -m 755 scripts/runner/clued-runner-job-started.sh /opt/clued-runner-hook/
     install -m 640 -o root -g <runner group> <downloaded key>.pem /opt/clued-runner-hook/app.pem
     ```

   - Windows: copy the `.mjs` and `.ps1` files to `C:\ProgramData\CluedRunnerHook\`. Copy the key to `app.pem` in the same folder. In the folder's security settings, give the runner service account Read only.
   - Copy the files from a reviewed `main` commit, and note that commit. The installed copy does not follow the repository; update it by copying again.
3. **Add these lines to the runner's `.env` file** (in the runner directory), then restart the runner service.

   ```
   ACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/clued-runner-hook/clued-runner-job-started.sh
   CLUED_RUNNER_HOOK_NODE=<runner directory>/externals/node20/bin/node
   CLUED_RUNNER_HOOK_REPOSITORY=tdoljyj/cross-memory-system
   CLUED_RUNNER_HOOK_APP_ID=<the App ID>
   CLUED_RUNNER_HOOK_APP_KEY_FILE=/opt/clued-runner-hook/app.pem
   CLUED_RUNNER_HOOK_ENFORCE=false
   ```

   On Windows, the hook line points to `C:\ProgramData\CluedRunnerHook\clued-runner-job-started.ps1`, the node line points to `externals\node20\bin\node.exe`, and the key line to `C:\ProgramData\CluedRunnerHook\app.pem`.

   A runner installed before the App reads a token file instead (`CLUED_RUNNER_HOOK_TOKEN_FILE`). The hook uses it only when no App is configured. When moving a runner to the App, replace that line with the two App lines, then delete the token file and revoke the token.
4. **Check the output.** Watch one pull request run and one push to `main`. Each job log starts with a "Set up runner" section that shows `clued-runner-hook: ALLOW ...` or `WOULD REFUSE ...`, ending with the hook's version (`[hook merge-admission-step2]`).
5. **Turn on enforcement.** Set `CLUED_RUNNER_HOOK_ENFORCE=true` and restart the runner.
6. **Make the setting unreachable from jobs.** Every job runs as the runner's service account, including the ungated short checks that run a pull request's own code. On a standard install that account owns the runner directory and its `.env`, so a job can delete the hook line or set `CLUED_RUNNER_HOOK_ENFORCE=false`, and the next listener restart (a self-update, a service restart, a reboot) turns the check off for every later job (re-review 7, MAJOR-4). Do one of the following:
   - **Ephemeral runners (the only hard guarantee).** Register each runner with `--ephemeral` (or a just-in-time config) on a machine or VM that is reset after one job. A job then cannot leave anything behind for the next one.
   - **A hardened persistent runner (reduces the risk, not a guarantee; re-review 8, MINOR-4).** A job can still start a process that outlives it (on Windows, a scheduled task or a detached process escapes the job's cleanup), keep using the machine after its timeout, and read or change later jobs' work directories. These runners are Windows machines, where that is easiest.
     - Linux: put the hook settings in a root-owned systemd drop-in (`/etc/systemd/system/<runner service>.d/clued-hook.conf`, one `Environment=` line each) instead of `.env`. Make the runner directory, `.env`, `.runner`, `.credentials*`, `bin/` and `externals/` owned by root and only readable by the service account; leave `_work/` and `_diag/` writable. Configure the runner with `--disableupdate` (a self-update needs to write `bin/`) and update it by hand. Set `kernel.yama.ptrace_scope` to 1 or more so a job cannot attach to the listener.
     - Windows: put the settings in the service's `Environment` value under `HKLM\SYSTEM\CurrentControlSet\Services\<runner service>` (administrators only). Give the service account Read on the runner folder except `_work` and `_diag`, and configure the runner with `--disableupdate`.
   - Either way, check after a restart that `clued-runner-hook: ALLOW ...` still appears in a job's "Set up runner" section.

   The App key stays readable by jobs: the check runs as the same account. With it a job can mint only what the App holds, read access (Actions and Contents) to this repository, which the job's own `GITHUB_TOKEN` can already read. A job could also spend the App's rate limit, which would refuse later jobs until it resets; it cannot spend the Owner account's.

## What it does not protect

- **Write access to the runner machine.** A job is an Agent's code on the runner machine. Without step 6, any job that runs a pull request's code (the ungated short checks below) can turn the check off for later jobs by editing `.env`. An Agent that can log in to the runner machine, or a job on a runner without step 6, can change or remove the check.
- **Non-workflow code.** A pull request that changes no workflow still runs its own code in the jobs `main` defines.
  - In the gated workflows, the heavy jobs wait for the admission gate.
  - The ungated short checks run anyway, even for a pull request no claim covers. These are the self-hosted workflows without an `admission-gate` job, for example `model-program-*`, `mps03-native-agent`, `multitrack-governance-projection`, `node-profile-policy`, `runner-budget-policy`, `gitleaks` and `trivy`; also `memory-publication-gate` (`pull_request_target`, once per pull request event into `main` that touches `memory/` or the snapshots, `main`'s verifier) and `public-mcp-gate-receipt` (`workflow_run`, `main`'s code), which runs each time `public-mcp-protocol`, `public-mcp-behavior`, `gitleaks` or `trivy` completes for a pull request run of the Owner's account, up to four times per push, with no claim.
  - Each of their self-hosted jobs has a timeout of 25 minutes or less, except `model-program-m0`. That file's hash is pinned in the frozen M0 manifest, so it keeps GitHub's 6-hour default. (`clued-integration-runtime-nightly` has 75 minutes, but runs on `main` only.)
  - The admission check refuses a pull request that adds a self-hosted job to an ungated workflow, moves a hosted job to a self-hosted runner, drops or raises a self-hosted job's timeout, or adds or changes its `strategy` (a matrix).
- **Re-runs on GitHub-hosted jobs.** The check runs only on self-hosted runners. A hosted job of a gated workflow (for example the `untrusted-hosted` jobs) runs in "Re-run failed jobs" on the gate's earlier output, and gitleaks or trivy jobs on hosted runners re-run without a count.
- **The API's lag of a few seconds.** The check reads the pull request's head and the attempt's jobs from GitHub's API, which can trail a push or a job's end by a few seconds. A re-run of the old head started just after a push can pass the current-head test in that window. A fresh gate job still shown as running is waited for (up to `CLUED_RUNNER_HOOK_WAIT_SECONDS`).
- **Cancelling by re-running an old head.** A re-run of an old head's run joins its concurrency group when it is queued, before any job starts, and can cancel the current head's run. The check refuses the old run's jobs but cannot undo the cancel.
- **Draft pull requests.** The hourly re-verification skips drafts, so a draft's admission is not re-checked after its claim ends. A draft's runs still need an admission run of their own event.
- **`main`'s own runs.** Anyone who can dispatch workflows can start `main`'s workflows (for example `clued-integration-runtime-nightly.yml`). They run `main`'s code and are not metered. `main`'s code is not reviewed by a person: the ruleset requires no approval, and Agents merge their own pull requests once the checks pass. Admission asks the Owner (an Owner Grant on the exact head commit) for every change to the paths listed in WorkClaimAdmission §4.6: all of `.github/`, `scripts/ci/`, this directory, the release scripts and their dependencies, `.gitattributes` and `.gitmodules`, read both from the pull request and against `main`'s current tip; such a pull request must contain that tip. A change to other code that a job runs (the Worker and app source, other scripts) reaches `main` without the Owner, and so does everything until the Owner sets `CLUED_OWNER_REVIEW_ENFORCE=true`.
