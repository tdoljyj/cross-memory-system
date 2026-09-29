# Clued Self-hosted CI Compute Pool — Node Profiles

This directory is the canonical onboarding and lifecycle surface for trusted Clued self-hosted CI nodes.

The operating model is:

```text
Runner Profile
    + Capacity Profile
    + Host Inventory
    + Lifecycle State
        ↓
Validated physical host
        ↓
Windows and/or Linux runner
        ↓
Capability-based GitHub Actions routing
```

Normal workflows target capabilities, never a physical computer name.

## Canonical files

| File | Purpose |
| --- | --- |
| `node-profiles.json` | Canonical runner profiles, capacity profiles, current host inventory, package pins and lifecycle states |
| `validate_node_profiles.py` | Static contract validator used by CI |
| `bootstrap-windows-runner.ps1` | Windows x64 onboarding |
| `bootstrap-linux-runner.sh` | WSL2/Linux x64 + native Docker onboarding |
| `apply-wsl-capacity-profile.ps1` | Applies only WSL memory/CPU/swap limits while preserving unrelated `.wslconfig` settings |
| `render-host-watchdog.ps1` | Renders the standardized host watchdog from the inventory and capacity profile |

## Current active hosts

The inventory currently declares two active physical hosts:

```text
company-primary / DESK-W-591
├─ clued-ci-company-win-01
├─ clued-ci-company-linux-01
└─ clued-ci-company-linux-02   (additional Linux slot)
   capacity: workstation-v1

home-primary / Turing
├─ clued-ci-home-win-01
└─ clued-ci-home-linux-01
   capacity: compact-v1
```

Runtime online/busy state is intentionally **not** stored in Git. The inventory records desired identity and capabilities; GitHub remains the runtime status surface.

## Low-cost CI health monitor

`.github/workflows/clued-ci-health.yml` checks the pool once an hour on a small GitHub-hosted runner (hourly bounds the hosted-minute cost). The hosted runner is deliberate: a monitor scheduled on the pool it watches could not report a total pool outage. `.github/workflows/clued-ci-runner-heartbeat.yml` separately sends a no-checkout, exact-label route probe to each of the five declared runners every 15 minutes (company Linux slots route by their own `runner-company-linux-NN` label). A successful probe proves that the named runner can accept its complete required-label contract. The healthy path is entirely deterministic and never invokes a model.

The default path needs no extra secret. GitHub's workflow token can read workflow/job state but cannot list repository runner registrations, so the monitor falls back to the four exact-label heartbeat routes. If a deliberately scoped `CI_HEALTH_GITHUB_TOKEN` secret with repository Administration read access is later supplied, the same script also uses the direct runner API for registered name, OS, labels, online, and busy state. The secretless heartbeat path remains the default and treats inability to call the administrative endpoint as an observation-mode choice, not as an anomaly.

The monitor preserves the current alert thresholds:

- all four active inventory routes retain their exact required labels; with the optional read token, registered name and OS drift are checked directly as well;
- Windows and Linux capability-pool degradation is inferred from routability and queue delay; with the optional read token, current online/busy state is added and a single offline redundant runner is recorded without becoming a pool failure;
- startup delay must exceed five minutes at least twice in the same capability pool during the 24-hour lookback before it becomes an anomaly.

Startup latency is evaluated by the deterministic hourly schedule. Each scheduled run reads at most the 20 most recent general workflow runs plus the 20 most recent heartbeat runs and applies the two-occurrence rule; pull-request validation does not scan job history. Previously observed slow starts are carried forward from the machine-owned transport report until they leave the 24-hour window, so a busy repository cannot evict threshold evidence merely by creating newer runs. An exact runner route becomes unavailable only after two probes for that route each exceed five minutes. GitHub exposes `workflow_job` as a webhook event but not as a GitHub Actions workflow trigger, so the schedule plus repository-local heartbeat is the smallest secretless transport that covers every workflow and all four exact routes without external infrastructure.

Each slow start records the runner that finally took it and a `wait_cause`, derived only from the collected jobs:

- `runner_occupied`: other jobs kept that runner busy for all but at most the threshold of the wait. The entry lists them in `occupied_by`, for example a long Linux job ahead of that runner's exact-route heartbeat. (`public-mcp-gate-receipt` used to poll for up to an hour on a Windows runner; it now evaluates once each time a required check completes.)
- `runner_idle_while_work_queued`: the runner ran no collected job for longer than the threshold while other jobs it could serve (their labels are a subset of its required labels) each waited that long. It was offline or suspended, not busy. When at least two such jobs are seen for one runner, `RUNNER_IDLE_WHILE_WORK_QUEUED` is raised for that runner.
- `unassigned`: the job is still queued. `unexplained`: neither pattern applies, or the runner is not in the inventory.

Jobs from runs outside the collected window are invisible, so causes are best-effort evidence, not proof. They are carried forward with the slow start. For a Linux runner flagged `runner_idle_while_work_queued`, read the host watchdog log (`C:\clued-ci\logs\watchdog-<host_id>.log`) for `Capacity suspend` / `Capacity resume` lines in that interval before looking elsewhere: the watchdog deliberately stops an idle Linux runner when host memory or disk crosses the profile's danger threshold.

Threshold-reaching anomalies are published to the dedicated draft PR head `automation/clued-ci-health-event`, with title `[Clued CI Health] anomaly event transport` and labels `ci-health-anomaly-event` plus `do-not-merge`. Its body carries a prominent `DO NOT MERGE` warning. The evidence lives at `.github/ci-health-events/latest.json`. Identical anomaly fingerprints are a no-op; recovery closes the PR; a later anomaly reopens it and restores the warning and labels. Retiring the transport means closing the PR and deleting its branch without merging. Transport commits use `[skip ci]` so the alert path does not add load to the unhealthy pool.

For ChatGPT Work, bootstrap the dedicated anomaly PR first, then create an event-triggered task on the web or supported mobile app. Restrict its GitHub trigger to this repository, the exact anomaly PR, title, and label, and select **commit updates only**. The saved prompt must re-read the structured evidence, verify the exact head branch, and require `status=ANOMALY` plus `notify_model=true` before analysis. Ordinary PR activity, reviews, comments, merges, transport closure/recovery, and unchanged fingerprints must not enter analysis.

After saving the Work task, run the transport once with `--force-event` to publish a single commit update for an already-open current anomaly. This is only a bootstrap/replay control; normal scheduled runs omit it and retain fingerprint deduplication.

The Scheduled Task UI can explicitly choose a model and reasoning effort when those choices are available to the account/workspace. Select `gpt-6-luna` with low reasoning if the Work task offers it, then verify the saved task. This repository cannot set or verify that ChatGPT-side choice, so do not claim the model is fixed unless the saved task actually shows it.

An explicit OpenAI API fallback is included but disabled by default. Set repository variable `CLUED_CI_HEALTH_ANALYSIS_MODE=openai_api` and add an `OPENAI_API_KEY` secret only after deliberately choosing API billing. That path calls `gpt-6-luna` with low reasoning, and it still runs only for `notify_model=true`. The repository does not create, infer, or require an API key for the default ChatGPT Work transport.

Do not leave the ChatGPT Work path active when deliberately switching to `openai_api`; one anomaly should have one analysis owner.


## Current qualification status

The two-host/four-runner pool is operational and qualification-complete through P14A, with Turing cold boot additionally qualified in P14B.

- P7 dual Windows parallelism: PASS — Actions run `35411176126`
- P8 dual Linux/Docker parallelism: PASS — Actions run `35413330672`
- P14A company → home failover: PASS — run `35420799275`, exact commit `1bebc816da05da5d11073e366754ed8f768c1d0f`
- P14A home → company failover: PASS — run `35421162688`, exact commit `586929dd64e9c48346291dd7f60bb50ac25a8c62`
- P14B Turing cold boot: PASS — post-boot P7 attempt 3 and P8 attempt 5 both succeeded
- DESK-W-591 cold boot: DEFERRED / NOT TESTED

Known operational notes: GitHub runner online/offline status can lag behind the actual runner session, so scheduler/job evidence and local watchdog state are authoritative for failover qualification. Turing's post-boot Runner/Docker qualification is PASS, but containerized scanners that must download external databases still require separate proxy-egress hardening. Full historical evidence and troubleshooting notes are intentionally kept outside this repository in the Clued资料中心.

## Runner profiles

### windows-general-v1

Required:

- Windows x64
- Git for Windows
- Python 3.12
- custom labels: `clued,pool-general,trust-internal,site-<site>,cap-python312`
- Node.js 24 is optional; advertise `cap-node24` only after verification
- login-started runner priority: `BelowNormal`

The Windows bootstrap resolves the exact verified Python executable and writes local `python.cmd` / `python3.cmd` shims under `C:\clued-ci\tools`. If Node.js 24 is present it also pins `node.cmd`. This avoids WindowsApps aliases, UAC installer behavior, and runtime drift.

### linux-docker-wsl2-v1

Required:

- Linux x64 under WSL2
- systemd running
- Git
- native Linux Docker Engine
- runner user belongs to the `docker` group
- custom labels: `clued,pool-general,trust-internal,site-<site>,Linux,cap-docker-linux,runtime-wsl2`
- GitHub Runner installed as a systemd service
- Windows-side WSL keepalive/watchdog

Docker Desktop WSL integration is not part of the CI capability contract. A node advertising `cap-docker-linux` must have a working native Linux engine.

## Capacity profiles

### compact-v1

For approximately 16 GB personal hosts:

```text
WSL memory      6 GB
WSL processors  3
WSL swap        2 GB
capacity suspend: host free memory < 2 GB or C: free < 40 GB
capacity resume:  host free memory >= 3.5 GB and C: free >= 55 GB
watchdog interval 30 s
```

### workstation-v1

For 64 GB-class workstations:

```text
WSL memory      28 GB
WSL processors  16
WSL swap        8 GB
capacity suspend: host free memory < 6 GB or C: free < 50 GB
capacity resume:  host free memory >= 10 GB and C: free >= 80 GB
watchdog interval 60 s
```

Capacity suspension waits until the Linux runner is idle. An active job is never deliberately killed by the watchdog.

## Runner package pin

New onboarding currently uses:

```text
GitHub Actions Runner: 2.337.0
Windows x64 SHA-256:
1150692afa94e71f872017e254ea55b6eece1eece3fe7e3a6d4c93d0a1b85cfc

Linux x64 SHA-256:
70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613
```

Both bootstrap paths verify the package hash before extraction. Registered runners remain eligible for GitHub automatic runner updates.

A bootstrap-version change must update `node-profiles.json` and the affected bootstrap script in the same reviewed change; the validator rejects version or digest drift.

## Lifecycle

The allowed host lifecycle is:

```text
planned
  ↓
enrolling
  ↓
validated
  ↓
active
  ↓
draining
  ↓
maintenance
  ↓
active

or

draining → retired
```

### planned

Choose:

- unique `host_id`
- physical hostname
- site: `home`, `company`, or `other`
- capacity profile
- Windows/Linux runner profiles
- unique runner names

Add the desired host to `node-profiles.json` first.

### enrolling

On the target Windows host, apply its WSL budget:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\ci\self-hosted\apply-wsl-capacity-profile.ps1 -HostId home-primary
```

This preserves unrelated WSL settings such as mirrored networking and proxy behavior. It writes a timestamped backup before changing `.wslconfig`.

Do **not** use `-RestartWsl` until all CI jobs on that physical host are drained.

Bootstrap Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\ci\self-hosted\bootstrap-windows-runner.ps1 `
  -Site home `
  -RunnerName clued-ci-home-win-02
```

Bootstrap Linux from inside the target WSL distribution:

```bash
bash scripts/ci/self-hosted/bootstrap-linux-runner.sh \
  --site home \
  --name clued-ci-home-linux-02
```

The Linux bootstrap requires native Docker and installs the runner as a systemd service.

Never paste a registration token into chat, a committed file, screenshots, logs, or shell history. Use the interactive hidden prompt.

### validated

Before activation, prove the advertised capabilities:

- Windows: checkout + Python 3.12 + optional Node 24
- Linux: checkout + `docker version` + `docker info` + create/remove a disposable volume
- verify GitHub runner labels match the profile and site
- verify Windows and Linux jobs can run concurrently when both runners are present
- verify the physical host remains responsive under the assigned capacity profile

Render the standardized watchdog:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\ci\self-hosted\render-host-watchdog.ps1 `
  -HostId home-primary `
  -InstallStartup `
  -StartNow
```

For an existing host, the inventory's `watchdog_path`, runner roots, launchers, WSL distro/user and Linux systemd unit are used.

### active

An active node may accept trusted internal CI according to its capability labels.

A machine being temporarily offline is not a governance failure. Pool availability is determined by whether required capability pools still have online capacity.

### draining

Before maintenance or retirement:

1. stop scheduling new work to the node by removing the relevant capability label or stopping its listener/service;
2. allow any current job to finish;
3. confirm GitHub reports the runner idle/offline as intended;
4. only then restart WSL, update runtimes, move files, or remove registration.

Never terminate an in-progress CI job merely to perform routine maintenance.

### maintenance / upgrade

For runner-package upgrades:

1. update the package version/digest contract in a reviewed PR;
2. let `node-profile-policy` validate both bootstrap pins;
3. canary one node;
4. run capability smoke tests;
5. roll the same profile to the remaining matching nodes.

For Python, Node, Docker, WSL, capacity, or watchdog changes, do the same canary-first sequence.

### retired

Retirement is deliberate:

1. drain the runner;
2. stop its watchdog/startup entry;
3. remove the GitHub runner registration using a one-time removal token or repository Settings;
4. remove local runner credentials/workspace only after registration removal;
5. change the host inventory state to `retired` or remove the runner entry in a reviewed PR.

Do not reuse a retired runner name for a different physical host.

## Watchdog behavior

The rendered watchdog is intentionally conservative:

- restores the Windows listener if it exits;
- keeps the declared WSL distro alive;
- restores native Docker and the Linux systemd runner;
- gives the Windows runner `BelowNormal` process priority;
- suspends Linux CI only after the current Linux job is idle and host memory/disk crosses the profile's danger threshold. It inspects the runner only when a suspend is due. A `Runner.Worker` process, sampled twice a few seconds apart, marks the runner busy; so does a listener log whose last event is `Running job:`. A missing or unreadable listener log no longer holds the suspend back. When WSL cannot be queried, the suspend is deferred. Each deferral reason is logged once per low-capacity episode;
- resumes Linux CI after the profile's recovery threshold is satisfied;
- never changes GitHub Secrets, production deployment authority, DNS, database state, or production traffic.

## Add a Linux slot on an existing host

A host with spare WSL capacity can run more than one Linux runner in the same distro. Each extra slot is declared under the host's `additional_linux_runners` with its own `name`, `root`, `service_unit` and a `route_label` of the form `runner-<site>-linux-NN`; it shares the primary runner's `distro`, `user`, watchdog and Docker engine. While its `state` is `enrolling`, the health monitor treats it as known but not required and the watchdog leaves it alone.

Jobs that bind fixed host ports (`public-mcp-protocol` and `public-mcp-behavior` share port 8787 and the default local Supabase ports) take the host-wide `host-port-lock.sh ... public-mcp-ports` lock, so two slots on one host never run them at the same time. Other Linux jobs use free or run-isolated ports and run in parallel.

Enroll the slot inside the host's WSL distro as the runner user, using a fresh registration token from GitHub → Settings → Actions → Runners → New self-hosted runner:

```bash
bash scripts/ci/self-hosted/bootstrap-linux-runner.sh --site company \
  --name clued-ci-company-linux-02 --root "$HOME/actions-runner-02" \
  --extra-labels runner-company-linux-02
```

Then, in one change: set the slot's `state` to `active`, give the primary runner on the same host its own `route_label` (add that label to the primary runner in GitHub's runner settings first), add both route labels to the heartbeat matrix, and re-render the host watchdog with `render-host-watchdog.ps1 -HostId <host>` so it also supervises the new service.

## Add a third or fourth device

Adding a node should not require workflow edits.

Example desired names:

```text
clued-ci-home-win-02
clued-ci-home-linux-02
clued-ci-company-win-02
clued-ci-company-linux-02
```

The procedure is always:

```text
inventory entry
→ node-profile-policy PASS
→ capacity profile
→ OS/runtime prerequisites
→ runner bootstrap
→ watchdog
→ capability smoke
→ mark active
```

If a new device introduces a genuinely new capability such as macOS, GPU/model evaluation, release signing, or ephemeral cloud execution, add a new Runner Profile instead of overloading an existing label.

## Validate locally

From the repository root:

```powershell
python scripts/ci/self-hosted/validate_node_profiles.py
```

Linux:

```bash
python3 scripts/ci/self-hosted/validate_node_profiles.py
bash -n scripts/ci/self-hosted/bootstrap-linux-runner.sh
```

The repository CI runs the same contract validation for every change under this directory.
