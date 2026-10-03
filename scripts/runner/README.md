# Clued self-hosted runner pre-job check

Task `869d2db7`, Owner Decision `b0c53143`. Every self-hosted runner that serves this repository runs `clued-runner-job-started.mjs` before each job, through the runner's `ACTIONS_RUNNER_HOOK_JOB_STARTED` setting. The check lives on the runner machine, outside the repository. A branch that edits a workflow therefore cannot remove it.

## What it allows

A job starts only when its run is one of the following:

- **On `main`:** a push, a schedule, `workflow_run`, `pull_request_target`, or a manual dispatch.
- **A pull request into `main` that changes no file under `.github/workflows/`.** Each workflow keeps its `admission-gate` job, which waits for the Clued admission of the pull request.
- **A pull request into `main` that changes a workflow,** once the base-branch admission run for that pull request and head has succeeded. That run is `clued-work-admission.yml` on `pull_request_target`; it executes `main`'s code, which checks the workflow change.
- **A manual dispatch on another branch that changes no workflow compared with `main`.** The workflow keeps its dispatch gate, which needs a Clued admission run for the dispatched commit.

Everything else is refused before any step runs: pushes to other branches, pull requests into other branches, and other events.

While `CLUED_RUNNER_HOOK_ENFORCE` is not `true`, the check only prints a warning.

## Install (once per runner machine, by the Owner)

1. **Create a read-only token.**
   - Use a fine-grained GitHub token for this repository only.
   - Grant Contents: read, Actions: read and Pull requests: read. Nothing else.
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

## What it does not protect

- **Write access to the runner machine.** An Agent that can write the runner machine, its `.env` file, or this directory can change or remove the check. Keep Agents off the runner machines, or keep these files out of their reach.
- **Non-workflow code.** A pull request that changes no workflow still runs its own code in the existing jobs. Those jobs are the ones `main` defines, and their heavy steps wait for the admission gate.
