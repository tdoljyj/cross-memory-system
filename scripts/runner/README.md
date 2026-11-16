# KooYomi self-hosted runner pre-job check

## Private handover rollout candidate

The `work-handover-current-epoch-v1` hook is a staged successor. Install only the reviewed, merged script after the service's execution-current observation RPC is deployed. The hook reads configuration from the repository's trusted default branch using its existing read-only App. PR code and job environment cannot replace that configuration. No KooYomi CI Binding, private lease key, receiving key or admission App credential belongs on a runner.

The `work-handover-current-epoch-proxy-v1` successor also uses the runner's existing HTTP/HTTPS proxy settings. When those settings are present, it enables Node's built-in proxy support in one child process before reading credentials or making requests. The runtime must support `--use-env-proxy`; unsupported runtimes, invalid proxy values and an explicit Node proxy opt-out refuse. Existing wrappers, proxy settings, TLS validation, credentials and gate rules are preserved. Install this successor from its reviewed merged source, then repeat actual job-start qualification; the earlier installed copy's digest does not qualify this version.

The `work-handover-current-epoch-proxy-dispatch-v1` successor adds `clued-handover-external-qualification.yml` and `clued-handover-disposable-idle.yml` to the fixed branch-dispatch list, matching the admission script. Each workflow keeps its dispatch admission gate and its own job conditions; the runner still requires identical default-branch workflow files and a current execution epoch, and refuses branch-dispatch re-runs. Proxy routing is unchanged. Its exact script digest requires separate Source acceptance; an earlier accepted source or installed digest does not qualify this successor.

Preserve the installed script as the previous version, replace only the script, and retain the existing wrappers, App key, protected settings and runner account. Do not loosen folder permissions. The installed copy does not follow Git automatically. After the successor has exact Source acceptance and is merged, install from that merged source and confirm `[hook work-handover-current-epoch-proxy-dispatch-v1]` from actual job-start logs on every registered runner before treating the fleet as qualified.

Qualification must include a current PR and a gated branch dispatch; stale epoch, unavailable observation and unknown configuration must refuse before job steps. Test the trusted publication begin/finish path and pending revocation with actual stopped runs and revoked required App checks, including an uncertain publication. A cancellation request alone is insufficient. The default-branch revoker must drain the durable contexts, both bounded queues and every historical head, retaining unproved publications as open.

Keep the service execution policy staged throughout installation. Activate only in a separately reviewed exact-source migration after all publication paths and independent runners are qualified, existing claims and queued work are accounted for, and the production authorization gate admits that migration. Unit tests and the page's default-On setting do not activate enforcement. After activation, repeat an actual voluntary receiving flow and prove that the old session cannot authorize a new head or start new queued execution while original provider recovery and settlement remain available.

Task `869d2db7`, Owner Decision `b0c53143`. Every self-hosted runner that serves this repository runs `clued-runner-job-started.mjs` before each job, through the runner's `ACTIONS_RUNNER_HOOK_JOB_STARTED` setting. The check lives on the runner machine, outside the repository. A branch that edits a workflow therefore cannot remove it.

## What it allows

### Late Native admission successor (defect B, 2026-11-15)

`required-tests-late-admission-v1` / component `1.0.3` keeps every rule of
`work-handover-native-admission-retry-v1`. Native admits a pull request only when it is the
train's front, often long after the push. For a pull request that changes a
workflow every job of attempt 1 then waits `CLUED_RUNNER_HOOK_WAIT_SECONDS` and
is refused in "Set up runner" ("Native admission absent"); the companion's one
"Re-run all jobs" after the admission (resident DESIGN §56.5) was refused as
well, because Native admitted attempt 1 only, and a new commit had to be pushed
by hand (#1121 run `43720693841`, #1122 run `43720708199`). The attempt-1 rule
is there because such a pull request writes its own `admission-gate`, so the
gate's re-run rules are its own to forge and the hook alone bounds how often it
runs. It keeps that bound but counts real runs, not attempt numbers: a later
attempt starts when every job of every earlier attempt of the run ran nothing,
that is, was skipped or failed only in the runner's own setup ("Set up job",
or this hook's "Set up runner", which always comes right after it) with every
later step skipped but "Complete job". A job list that cannot be read in full
counts as having run. One admitted head still runs once. The gate
(`clued-work-admission.mjs#diedInSetup`) and the companion's copy
(`env-failure.mjs`) count a refused "Set up runner" as a setup death too, so
the companion asks for that one re-run by itself.

A runner still on an older version refuses the re-run as before (fail closed).
It changes no workflow file, so its own pull request is not caught by the
defect it fixes; the lost-run dispatch successor (#1122) builds on it.

Rollout, on each registered runner (no per-runner variant; nothing in the
repository reaches into the runners): keep the installed
`clued-runner-job-started.mjs` as `.prev`, copy the merged file over it (Linux
`/opt/clued-runner-hook/`, Windows `C:\ProgramData\CluedRunnerHook\`), leave
wrappers, key and settings alone, and confirm
`[hook required-tests-late-admission-v1]` in a "Set up runner" log.

### Transient-read successor candidate (Task 5cee3629)

`work-handover-native-admission-retry-v1` / component `1.0.2` keeps every rule
of `work-handover-native-admission-v1` and changes only how a passing network
fault is read. On 2026-11-05 a single cut read of the `kooyumi-work-admission`
check refused a job although the head was admitted. Now a read that fails with
a network error, is cut off while its reply is read, runs past its own time
bound (30 seconds; 10 seconds for the `execution_current` observation), or gets
a 500/502/503/504 answer (from GitHub or the Clued RPC) is tried again, up to
three attempts per call with 2 and 5 seconds between them. Only reads are tried
again: GET requests, and the two POSTs their callers mark as reads (the hook
App's installation-token mint and the read-only `execution_current`
observation). A 401, 403, 404, 429 or a malformed answer is final at once, as
before. While the hook waits for the Native check, the legacy admission run or
a re-run's `admission-gate` job, a poll that still fails transiently counts as
"not settled yet" until `CLUED_RUNNER_HOOK_WAIT_SECONDS` ends by the clock;
then the last failure refuses. A Native check is judged at the time its pages
were read. All reads of one job start end within twice the wait plus two
minutes. Nothing is admitted on a failure. `qualify-native-admission-retry-candidate.mjs
--candidate` repeats the 1.0.1 cases and adds synthetic network cuts. The
1.0.1 file and its qualifier stay unchanged for rollback.

This file is under `scripts/runner/**`, a protected path: merging it needs an
Owner Grant. As for every successor, it then needs exact Source acceptance,
merged-source installation on every registered runner under the protected
machine procedure, and actual job-start logs showing
`[hook work-handover-native-admission-retry-v1]` before the fleet counts as
qualified.

### Native producer successor candidate (Task 169fd456 / PR #979 prerequisite)

`work-handover-native-admission-v1` / component `1.0.1` fixes the stale
producer dependency exposed by run `41390462699`: Native admission succeeded,
but the installed hook waited for the manually disabled legacy workflow.
This source is a candidate, not an accepted installed version. The existing
accepted-source qualifier registry stays unchanged until exact Source
acceptance and merged-source qualification. The old immutable source remains.

For a workflow-changing PR, the hook reads GitHub's state of the exact
`clued-work-admission.yml` workflow. `active` retains the legacy event-bound
run rule below; only `disabled_manually` selects Native. Unknown state, API
failure or missing permission refuses. Native reads all check pages and uses
the newest `kooyumi-work-admission` check from App `5368905` on the exact
head, binding its Native external id, repository/PR summary, timestamps and
the still-open PR's current head/default branch. A newer refusal or pending
check cannot be hidden by an older success. Native admits attempt 1 only;
the current execution-epoch observation remains required afterwards.

Only this Native branch requests `checks: read` in the hook's own read-only
App installation token, scoped to this repository. Both admission publishing
Apps (`5164952`, `5368905`) are forbidden as hook identities. No publishing
key, job token, write permission or personal-token fallback repairs a failed
App mint. The hook App's GitHub permission approval, exact successor Source
acceptance, merged source and protected-machine deployment exception must be
resolved before rollout. Keep wrappers, secrets, environment, services and
protection settings unchanged; preserve the exact old public hook for rollback.
Candidate tests and byte equality do not establish live PR/dispatch qualification.

A job starts only when its run is one of the following:

- **On `main`:** a push, a schedule, `workflow_run`, `pull_request_target`, or a manual dispatch. A `pull_request_target` run counts only for a pull request into `main` (re-review 7, m1): it runs on `main`'s ref whatever the pull request's base, and a workflow may check out that base, which is the Agent's to edit when it is another branch.
- **A pull request into `main` that changes no file under `.github/workflows/`.** Each workflow keeps its `admission-gate` job, which waits for the KooYomi admission of the pull request.
- **A pull request into `main` that changes a workflow,** once `main`'s admission run of the same event as the job's run has succeeded.
  - That admission run is the newest `pull_request_target` run of `clued-work-admission.yml` on the head created no earlier than 15 seconds before the job's run. GitHub creates the runs of one event together. Skipped runs are left out: the admission job skips pull requests into other branches.
  - While that admission run is still going, the job waits for it (up to `CLUED_RUNNER_HOOK_WAIT_SECONDS`, default 480). The same setting also bounds, separately, the wait for a re-run's `admission-gate` job (see Re-runs), so a heavy job of a re-run of a pull request that changes a workflow can wait up to twice that, plus at most two minutes of reads (component 1.0.2).
  - An older success on the same head does not count: for example after a force-push back to an admitted commit, or a pull request closed and reopened (even within seconds).
  - Only `main`'s code decides. `pull_request_target` runs the default branch's copy of the workflow whatever the pull request's base, and that copy checks out `main` and runs only for pull requests into `main` (re-review 6, B1). A branch's edited copy never runs on `pull_request_target`.
  - The run succeeds only when its admission step does. That is the same condition on which it posts the `clued-admission-verified` App check.
  - The check itself is not read: a fine-grained token cannot read the Checks API (Task `b979d5a2`). Unlike the check, a run does not name its pull request. Another pull request into `main` with the same head, whose event came within 15 seconds, can therefore stand in. Its admission run judged the same commit and the same workflow changes.
- **A manual dispatch on another branch of `clued-connection-authorization.yml`, `clued-g4-database.yml`, `information-flow-e2e.yml`, `clued-handover-external-qualification.yml` or `clued-handover-disposable-idle.yml`,** when the branch's `.github/workflows` directory is exactly `main`'s (same files, same object ids).
  - A branch behind `main` must merge `main` first.
  - These workflows keep their dispatch gate, which needs a KooYomi admission run for the dispatched commit.
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
  - **A workflow without an `admission-gate` job** (the short checks, such as `node-profile-policy`) may be re-run once (attempt 2) on the current head, like `gitleaks` and `trivy`, when its file at the head is `main`'s, byte for byte, and `main`'s copy has no `admission-gate` job (Task `26cced7e`, Owner Decision `661f8c36`). A pull request that changes a workflow has every job of its first run refused until its admission run succeeds; this lets its short checks run once more on the same head. A copy the pull request changed is not re-run.
  - **Every other job** starts only when this attempt's `admission-gate` job ran again and succeeded. "Re-run all jobs" does that. "Re-run failed jobs" and re-running a single job do not run a successful gate again: GitHub lists the earlier gate job in the new attempt, successful, but with the earlier attempt's start time. The hook therefore requires exactly one job of the attempt named `admission-gate`, carrying the `self-hosted` label (every gate job runs on a self-hosted runner), completed with success, that started no earlier than the attempt did (the run's `run_started_at`). A second job with that name, or a gate job without the label, refuses. A gate job of this attempt that has not started yet or not completed is waited for (up to `CLUED_RUNNER_HOOK_WAIT_SECONDS`) and refused if it still has not at the end. A job list that GitHub does not return complete, or a time it cannot read, refuses.
  - A pull request that changes a workflow still needs a successful admission run of its event, on every attempt, exactly as for the first one. The newest admission run on the head decides, so after an Owner grant the run of the pull request body edit counts.
  - The run attempt the runner reports (`GITHUB_RUN_ATTEMPT`) and the one GitHub reports for the run must agree; otherwise the job is refused.
- **A refused re-run still uses up its attempt number.** The next re-run of the same run is one attempt later.
- **Never re-run an old head's run.** It is refused anyway, and its concurrency group can cancel the current head's run before any job starts.

**After an Owner grant for a protected change:** edit the pull request body, which runs admission again, and wait until `clued-admission-verified` is green on the head. Under contract v39, use "Re-run all jobs" once on each gated workflow run of that current head (and on `gitleaks` / `trivy` and, from `merge-admission-ungated-rerun`, any other ungated short check if they were refused). Closing and reopening once is an exception only when the "Set up runner" log identifies a hook older than `merge-admission-step2`, or an old gate explicitly refuses with "re-runs are not admitted". A 403 from the current hook requires the permission repair below; a "Set up runner" refusal alone does not establish an old hook.

## Updating the check: merge it into main (the loader)

Owner Decision 2026-11-16 (review `REVIEW-fable-runner-hook-20261116`). Runners keep only
`clued-runner-hook-loader.mjs`, installed under the hook's own name `clued-runner-job-started.mjs`,
so the wrappers, `.env`/drop-in/registry settings, App key, folder rights and services stay as they
are. At every job start the loader:

1. mints a token of the hook's own read-only App (`contents: read`, this repository only; the two
   admission publishing Apps are refused);
2. reads `scripts/runner/clued-runner-job-started.mjs` from the default branch
   (`CLUED_RUNNER_HOOK_DEFAULT_BRANCH`, else `main`), never from a pull request ref; network faults,
   time-outs and 500-504 are tried again (3 attempts, 2 s and 5 s apart), any other answer is final;
3. checks the bytes against the git blob id GitHub names for them, prints
   `clued-runner-hook-loader: main blob <sha1> sha256 <hex> [loader <version>]`, and imports them from
   memory (never written where a job could swap them);
4. calls the hook's `main(env, fetch, { sourceSha256 })`; the hook prints its usual
   `[hook <version>]` line, and its `clued-r9-pre-job` `source_sha256` is the loaded bytes'.

Whatever fails (no repository or App configured, main unreadable, other bytes, a hook that throws or
has no `main`) refuses the job when `CLUED_RUNNER_HOOK_ENFORCE` is true, and only warns otherwise.
A hook change is rolled out by merging it (a protected path: Owner Grant); rollback is a revert.
The loader is the one file still installed on runners: its bytes are pinned in its test and its
component (`hook.runner-loader`), so changing it is a deliberate decision with its own install round.
No per-version immutable copy of the hook is added any more; the earlier ones stay for their pins.

### Installing the loader (once per hook folder; `install-hook-loader.mjs`)

The same idempotent command on every host; the folder comes from the platform (Linux
`/opt/clued-runner-hook`, Windows `C:\ProgramData\CluedRunnerHook`). It refuses a loader whose
sha256 is not the one given, keeps the installed file as `clued-runner-job-started.mjs.prev`,
overwrites the file in place (owner, mode and ACL unchanged; no restart), checks that the file has
the expected sha256 and imports as the loader, and puts `.prev` back when that check fails. Run
again, it reports `ALREADY`. `--rollback` puts `.prev` back. One JSON line (`--result <file>` also
writes it, for an elevated run whose window closes).

`<L>` is the merged `scripts/runner/clued-runner-hook-loader.mjs`, `<H>` its sha256 (the pin in
`clued-runner-hook-loader.test.mjs`). One round, in this order (stop at the first failure; a
production failure is not retried, `--rollback` restores the old hook with no restart):

1. DESK, WSL distribution `CluedCI-Linux` (root by default there, no UAC; its four Linux runners
   share the one folder):
   `wsl.exe -d CluedCI-Linux -u root -- <node> <repo>/scripts/runner/install-hook-loader.mjs --loader <L> --sha256 <H>`
   (`<node>`: the runners' own node, as in the drop-in's `CLUED_RUNNER_HOOK_NODE`; `<repo>` and
   `<L>` as `/mnt/...` paths). Then wait for the next job on those runners (the 15-minute heartbeat)
   and find `[loader 1.0.0]` and the merged `[hook <version>]` in its "Set up runner" log before
   going on.
2. DESK Windows, one UAC:
   `Start-Process -Verb RunAs -Wait <node.exe> -ArgumentList '<repo>\scripts\runner\install-hook-loader.mjs','--loader','<L>','--sha256','<H>','--result','<result.json>'`;
   read `<result.json>` (`INSTALLED` or `ALREADY`).
3. TURING Windows, one UAC: the same command (started there through Desktop Commander), the same check.

Done when a heartbeat run shows `[loader 1.0.0]` and the same `source_sha256` on all six runners.
The old hook's leftover copies and temporary files in `/opt/clued-runner-hook/` may then be removed.

### Candidate shadow check (design only; a later pull request, it changes a workflow)

With the loader, a hook merged into main is at once every runner's hook, and a broken one would refuse
every job, the revert's required checks included. So a pull request that changes
`scripts/runner/clued-runner-job-started*.mjs` gets one more required step in `clued-required-tests.yml`,
on a Linux and on a Windows runner: run the pull request's candidate hook with this job's real
environment and App (`node <candidate> ` with `CLUED_RUNNER_HOOK_ENFORCE=false`, judging only), and
require that it exits 0 and prints `clued-runner-hook: ALLOW` for this very job. A hook that crashes,
cannot mint its token or refuses an admitted job then fails before it is merged. Tests to write with it:
a candidate that throws on import, one that refuses the job and one that needs a permission the App lacks
each fail the step; the unchanged hook passes; a pull request that does not touch the hook skips the step;
the step runs the candidate from the candidate checkout, not from main. It is merged only after defect B's
fix is live (it changes a workflow).

### Before the loader (history)

The installed copy does not follow the repository. To roll out a new version, keep the installed copy, copy the merged `scripts/runner/clued-runner-job-started.mjs` over it on every runner, and confirm the new `[hook <version>]` in a "Set up runner" log on each (steps 3 and 4 below). The `work-handover-current-epoch-proxy-dispatch-v1` source candidate above requires its own exact Source acceptance and merged-source installation, followed by actual PR and gated dispatch job-start qualification. The earlier `merge-admission-ungated-rerun` version (Task `26cced7e`) changed only which re-runs start, needed no new App permission, workflow or contract change, and a runner still on `merge-admission-step2-pr-read` kept refusing the ungated re-runs.

`merge-admission-step2-pr-read` was rolled out in this order:

1. **Grant the hook App Pull requests: read and approve that permission for its repository installation.** Keep Actions: read and Contents: read. Do this before installing the new check: GitHub refuses a token request for a permission the installation has not been granted. Keep the installation limited to this repository.
2. **Merge the repair into `main` in two PRs, tracked by Task `fb97ebd5`.** The [gate guard](../ci/clued-work-admission.mjs) requires the new exact gate digest to be registered first. The first PR registers that digest and changes the hook token request while keeping all workflow files at their base version. After it merges, a second PR adds `pull-requests: read` only to the ten `admission-gate` job tokens; other jobs and workflow-wide permissions do not need an increase. Both PRs belong to the same root Task.
3. **Copy the new check to every runner, keeping the old one.** On each runner, first keep the installed `clued-runner-job-started.mjs` for rollback (for example as `clued-runner-job-started.mjs.prev` in the same directory), then copy only `clued-runner-job-started.mjs` from the merged `main` commit over the installed copy (the directory of Install step 2 below). The wrappers (`.sh`, `.ps1`), the App key and the `.env` lines stay as they are. The runner starts the script afresh for every job, so no restart is needed.
4. **Confirm the version on each runner.** Every `ALLOW` / `REFUSE` line ends with `[hook <version>]`. Find `[hook merge-admission-step2-pr-read]` in a "Set up runner" log of a job on each runner; the runner heartbeat (`clued-ci-runner-heartbeat`, every 15 minutes on `main`) shows it in each runner's "Set up runner" section.
5. **Verify one live re-run of a new pull request run that includes the corrected workflow permissions.** Select a run created by a new PR event on the current head after the added job permission is present, for example after actually merging the corrected `main` into the PR branch and pushing that merge. Do not create an empty commit just to get a new run. After that head's admission is green, use "Re-run all jobs" within its allowed attempts, and check both the hook's pull request read and the gate's read. Re-running an older run replays its original workflow and job permissions even when the gate checks out newer code. The failed PR #630 design-refs run 37761411890 attempt 2 is spent; do not use its attempt 3 for this verification.

The original `merge-admission-step2` rollout required all runners to be updated before releasing agent contract v39. This permission correction uses the already released v39 contract.

**Rollback:** put the kept old copy back over `clued-runner-job-started.mjs` on each runner (no restart needed), and confirm its older `[hook ...]` version in a "Set up runner" log.

An installed hook older than `merge-admission-step2` refuses every pull request re-run; that explicit old-hook exception may use one close and reopen. The original `merge-admission-step2` hook instead needs the App permission and corrected token request above when its pull request read returns 403. Keep "Re-run all jobs" as the normal v39 path after qualification.

**Runs from before the merge.** A re-run uses its original event's workflow files, job permissions and `base.sha`; checking out newer gate code does not raise its `GITHUB_TOKEN` permissions. A run from before the original step-2 merge can explicitly refuse with "re-runs are not admitted": merge `main` into the branch and push the real change, or use the one-close-and-reopen exception for that old gate. For this PR-read permission correction, follow Updating step 5 and verify a new current-head PR run whose workflow includes the added permission; an older run cannot validate the corrected gate permissions.

**Live re-run qualification.** The first live re-run on 2026-10-08 ([PR #630, design-refs run 37761411890, attempt 2](https://github.com/tdoljyj/cross-memory-system/actions/runs/37761411890/attempts/2)) was refused at "Set up runner": the hook's `GET /repos/{owner}/{repo}/pulls/{n}` returned 403. The gate and its dependent jobs did not run. That attempt is spent.

The hook App and the single-repository token it mints now require Actions: read, Contents: read and Pull requests: read. Each workflow's `admission-gate` job needs the matching `pull-requests: read` permission for its `GITHUB_TOKEN`, because the gate independently checks the pull request's current head.

The corrected permission path and `GITHUB_JOB` being present in the hook environment still require a successful live re-run. Without `GITHUB_JOB`, the hook takes the gate for a heavy job and waits for itself until refusal. A failed pull request read continues to refuse with "cannot read the pull request"; fixtures or a skipped gate do not prove live qualification.

## Install (once per runner machine, by the Owner)

1. **Create the hook's read-only GitHub App** (once, shared by all runners; Owner Decision `d8bc893c`).
   - In the Owner account: Settings → Developer settings → GitHub Apps → New GitHub App. Turn the webhook off. Repository permissions: Actions: read, Contents: read and Pull requests: read, nothing else (Metadata: read comes with them). Let it be installed on this account only.
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
4. **Check the output.** Watch one pull request run and one push to `main`. Each job log starts with a "Set up runner" section that shows `clued-runner-hook: ALLOW ...` or `WOULD REFUSE ...`, ending with the hook's version (`[hook merge-admission-step2-pr-read]`).
5. **Turn on enforcement.** Set `CLUED_RUNNER_HOOK_ENFORCE=true` and restart the runner.
6. **Make the setting unreachable from jobs.** Every job runs as the runner's service account, including the ungated short checks that run a pull request's own code. On a standard install that account owns the runner directory and its `.env`, so a job can delete the hook line or set `CLUED_RUNNER_HOOK_ENFORCE=false`, and the next listener restart (a self-update, a service restart, a reboot) turns the check off for every later job (re-review 7, MAJOR-4). Do one of the following:
   - **Ephemeral runners (the only hard guarantee).** Register each runner with `--ephemeral` (or a just-in-time config) on a machine or VM that is reset after one job. A job then cannot leave anything behind for the next one.
   - **A hardened persistent runner (reduces the risk, not a guarantee; re-review 8, MINOR-4).** A job can still start a process that outlives it (on Windows, a scheduled task or a detached process escapes the job's cleanup), keep using the machine after its timeout, and read or change later jobs' work directories. These runners are Windows machines, where that is easiest.
     - Linux: put the hook settings in a root-owned systemd drop-in (`/etc/systemd/system/<runner service>.d/clued-hook.conf`, one `Environment=` line each) instead of `.env`. Make the runner directory, `.env`, `.runner`, `.credentials*`, `bin/` and `externals/` owned by root and only readable by the service account; leave `_work/` and `_diag/` writable. Configure the runner with `--disableupdate` (a self-update needs to write `bin/`) and update it by hand. Set `kernel.yama.ptrace_scope` to 1 or more so a job cannot attach to the listener.
     - Windows: put the settings in the service's `Environment` value under `HKLM\SYSTEM\CurrentControlSet\Services\<runner service>` (administrators only). Give the service account Read on the runner folder except `_work` and `_diag`, and configure the runner with `--disableupdate`.
   - Either way, check after a restart that `clued-runner-hook: ALLOW ...` still appears in a job's "Set up runner" section.

   The App key stays readable by jobs: the check runs as the same account. With it a job can mint only what the App holds, read access (Actions, Contents and Pull requests) to this repository. The gate's own `GITHUB_TOKEN` has the corresponding read permissions. A job could also spend the App's rate limit, which would refuse later jobs until it resets; it cannot spend the Owner account's.

## What it does not protect

- **Write access to the runner machine.** A job is an Agent's code on the runner machine. Without step 6, any job that runs a pull request's code (the ungated short checks below) can turn the check off for later jobs by editing `.env`. An Agent that can log in to the runner machine, or a job on a runner without step 6, can change or remove the check.
- **Non-workflow code.** A pull request that changes no workflow still runs its own code in the jobs `main` defines.
  - In the gated workflows, the heavy jobs wait for the admission gate.
  - The ungated short checks run anyway, even for a pull request no claim covers. These are the self-hosted workflows without an `admission-gate` job, for example `model-program-*`, `multitrack-governance-projection`, `node-profile-policy`, `gitleaks` and `trivy`; also `memory-publication-gate` (`pull_request_target`, once per pull request event into `main` that touches `memory/` or the snapshots, `main`'s verifier) and `public-mcp-gate-receipt` (`workflow_run`, `main`'s code), which runs each time `public-mcp-protocol`, `public-mcp-behavior`, `gitleaks` or `trivy` completes for a pull request run of the Owner's account, with no claim: four times per push, and once more each time one of those runs completes again after a re-run, including a re-run the check refuses (re-runs are allowed since `merge-admission-step2`, so there is no fixed upper bound per push).
  - Each of their self-hosted jobs has a timeout of 25 minutes or less, except `model-program-m0`. That file's hash is pinned in the frozen M0 manifest, so it keeps GitHub's 6-hour default. (`clued-integration-runtime-nightly` has 75 minutes, but runs on `main` only.)
  - The admission check refuses a pull request that adds a self-hosted job to an ungated workflow, moves a hosted job to a self-hosted runner, drops or raises a self-hosted job's timeout, or adds or changes its `strategy` (a matrix).
- **Re-runs on GitHub-hosted jobs.** The check runs only on self-hosted runners. A hosted job of a gated workflow (for example the `untrusted-hosted` jobs) runs in "Re-run failed jobs" on the gate's earlier output, and gitleaks or trivy jobs on hosted runners re-run without a count.
- **The API's lag of a few seconds.** The check reads the pull request's head and the attempt's jobs from GitHub's API, which can trail a push or a job's end by a few seconds. A re-run of the old head started just after a push can pass the current-head test in that window. A gate job of this attempt still shown as not started or not completed is waited for (up to `CLUED_RUNNER_HOOK_WAIT_SECONDS`).
- **Cancelling by re-running an old head.** A re-run of an old head's run joins its concurrency group when it is queued, before any job starts, and can cancel the current head's run. The check refuses the old run's jobs but cannot undo the cancel.
- **Draft pull requests.** The hourly re-verification skips drafts, so a draft's admission is not re-checked after its claim ends. A draft's runs still need an admission run of their own event.
- **`main`'s own runs.** Anyone who can dispatch workflows can start `main`'s workflows (for example `clued-integration-runtime-nightly.yml`). They run `main`'s code and are not metered. `main`'s code is not reviewed by a person: the ruleset requires no approval, and Agents merge their own pull requests once the checks pass. Admission asks the Owner (an Owner Grant on the exact head commit) for every change to the paths listed in WorkClaimAdmission §4.6: all of `.github/`, `scripts/ci/`, this directory, the release scripts and their dependencies, `.gitattributes` and `.gitmodules`, read both from the pull request and against `main`'s current tip; such a pull request must contain that tip. A change to other code that a job runs (the Worker and app source, other scripts) reaches `main` without the Owner. (Until Merge Admission step 6, 2026-10-09, so did everything while the repository variable `CLUED_OWNER_REVIEW_ENFORCE` was not `true`; it is no longer read.)

The numeric `hook.runner-job-started` component binds only the immutable versioned source. The primary hook is its distribution copy and must match every raw byte; a CRLF-normalized component digest cannot replace this check. The qualifier has its own numeric `script.runner-handover-qualifier` version. Its CLI selects a frozen exact digest/source path/version record without fetching Git history; actual Git-object provenance is checked separately during local acceptance and independent review. Missing source objects remain unavailable, and six isolated verdicts never establish installed or live qualification.
