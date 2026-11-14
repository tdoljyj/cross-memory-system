# KooYomi Self-hosted CI Compute Pool — Node Profiles

This directory is the canonical onboarding and lifecycle surface for trusted KooYomi self-hosted CI nodes.

The maintained operating requirements and dated runtime evidence are in [Runner configuration and operations](../../../docs/maintenance/runner-configuration-and-operations.md). The JSON inventory declares desired identity/capacity; it is not online state, complete host qualification or a grant to install/stop nodes.

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
| `node-governance/` | Node Resource Governance v1: `render.ps1` renders the node's one governance task from `config/node-governance-standard.json` and the host's `governance` block; `linux-sweep.sh` is its in-distribution sweep; `install.ps1` installs it (one UAC) and retires the old watchdog and cache worker |

## Current active hosts

The inventory currently declares two active physical hosts:

```text
company-primary / DESK-W-591
├─ clued-ci-company-win-01
├─ clued-ci-company-linux-01
├─ clued-ci-company-linux-02   (additional Linux slot)
├─ clued-ci-company-linux-03   (additional Linux slot)
└─ clued-ci-company-linux-04   (additional Linux slot)
   capacity: workstation-v1

home-primary / Turing
├─ clued-ci-home-win-01
└─ clued-ci-home-linux-01      (retired 2026-10-21; kept offline, not expected)
   capacity: compact-v1
```

Runtime online/busy state is intentionally **not** stored in Git. The inventory records desired identity and capabilities; GitHub remains the runtime status surface.

## Low-cost CI health monitor

`.github/workflows/clued-ci-health.yml` checks the pool once an hour on a small GitHub-hosted runner (hourly bounds the hosted-minute cost). The hosted runner is deliberate: a monitor scheduled on the pool it watches could not report a total pool outage. `.github/workflows/clued-ci-runner-heartbeat.yml` separately sends a no-checkout, exact-label route probe to each of the four matrix runners (`clued-ci-company-win-01`, `clued-ci-home-win-01`, `clued-ci-company-linux-01`, `clued-ci-company-linux-02`) every 15 minutes; the six active inventory entries additionally include company Linux03/04, which this matrix does not probe (company Linux slots route by their own `runner-company-linux-NN` label). The retired `clued-ci-home-linux-01` is neither probed nor expected; the home host's required checks now come from the resident independent-CI executor, which is not a GitHub runner and is not part of this inventory. A successful probe proves that the named runner can accept its complete required-label contract. The healthy path is entirely deterministic and never invokes a model.

The default path needs no extra secret. GitHub's workflow token can read workflow/job state but cannot list repository runner registrations, so the monitor falls back to the routes actually present in the heartbeat matrix. If a deliberately scoped `CI_HEALTH_GITHUB_TOKEN` secret with repository Administration read access is later supplied, the same script also uses the direct runner API for registered name, OS, labels, online, and busy state. The secretless heartbeat path remains the default and treats inability to call the administrative endpoint as an observation-mode choice, not as an anomaly.

The monitor preserves the current alert thresholds:

- observed inventory routes retain their exact required labels; with the optional read token, registered name and OS drift are checked directly as well;
- Windows and Linux capability-pool degradation is inferred from routability and queue delay; with the optional read token, current online/busy state is added and a single offline redundant runner is recorded without becoming a pool failure;
- startup delay must exceed five minutes at least twice in the same capability pool during the 24-hour lookback before it becomes an anomaly.

Startup latency is evaluated by the deterministic hourly schedule. Each scheduled run reads at most the 20 most recent general workflow runs plus the 20 most recent heartbeat runs and applies the two-occurrence rule; pull-request validation does not scan job history. Previously observed slow starts are carried forward from the machine-owned transport report until they leave the 24-hour window, so a busy repository cannot evict threshold evidence merely by creating newer runs. An exact runner route becomes unavailable only after two probes for that route each exceed five minutes. GitHub exposes `workflow_job` as a webhook event but not as a GitHub Actions workflow trigger, so the schedule plus repository-local heartbeat is the smallest secretless transport that covers the configured heartbeat routes without external infrastructure.

For carried delays whose occupation is unresolved, the hourly scan re-reads their exact runs to recover runner assignment and collects older runs anchored around their wait windows. This recovery adds at most `--max-runs` job-list requests (20 in the workflow), with nearby waits sharing an hourly anchor. Fresh job objects replace historical entries, so a queued job is not invented as completed/successful. The bounded sample can still miss occupation; missing evidence never proves online/idleness or an outage.

Each slow start records the runner that finally took it and a `wait_cause`, derived only from the collected jobs:

- `runner_occupied`: observed jobs cover that runner's wait except at most 30 seconds of dispatch grace (or the configured threshold if lower). The entry lists them in `occupied_by`, for example a long Linux job ahead of that runner's exact-route heartbeat.
- `runner_idle_while_work_queued`: no collected job covers a long wait while other compatible jobs (their labels are a subset of its required labels) also queued. This is missing occupation evidence, not verified online/idleness. At least two such jobs raise `RUNNER_IDLE_WHILE_WORK_QUEUED` for investigation, without asserting offline, suspension or a pool outage.
- `unassigned`: the job is still queued. `unexplained`: neither pattern applies, or the runner is not in the inventory.

Jobs from runs outside the collected window are invisible, so causes are best-effort evidence, not proof. They are carried forward with the slow start. For a Linux runner flagged `runner_idle_while_work_queued`, read the node governance log (`C:\ProgramData\Clued\node-governance\logs\governance-<host_id>.log`) for `Capacity suspend` / `Capacity resume` lines in that interval before looking elsewhere: the watchdog deliberately stops an idle Linux runner when host memory or disk crosses the profile's danger threshold.

The existing 300-second / two-occurrence / 24-hour gate is unchanged. Repeated waits fully explained by occupation are `classification=capacity_pressure`, `severity=info`; any unexplained or unassigned wait keeps `classification=startup_delay_needs_investigation`, `severity=warning`. Both retain evidence and transport notification. The classification participates in the anomaly key/fingerprint so a change from capacity pressure to unknown waiting is not lost to deduplication. Timestamps and individual delay fluctuations still do not churn the fingerprint. `idle_seconds` measures time not covered by sampled jobs; it must never be presented as proof that a runner was online and idle.

Threshold-reaching anomalies are published to the dedicated draft PR head `automation/clued-ci-health-event`, with title `[Clued CI Health] anomaly event transport` and labels `ci-health-anomaly-event` plus `do-not-merge`. Its body carries a prominent `DO NOT MERGE` warning. The evidence lives at `.github/ci-health-events/latest.json`. Identical anomaly fingerprints are a no-op; recovery closes the PR; a later anomaly reopens it and restores the warning and labels. Retiring the transport means closing the PR and deleting its branch without merging. Transport commits use `[skip ci]` so the alert path does not add load to the unhealthy pool.

For ChatGPT Work, bootstrap the dedicated anomaly PR first, then create an event-triggered task on the web or supported mobile app. Restrict its GitHub trigger to this repository, the exact anomaly PR, title, and label, and select **commit updates only**. The saved prompt must re-read the structured evidence, verify the exact head branch, and require `status=ANOMALY` plus `notify_model=true` before analysis. Ordinary PR activity, reviews, comments, merges, transport closure/recovery, and unchanged fingerprints must not enter analysis.

After saving the Work task, run the transport once with `--force-event` to publish a single commit update for an already-open current anomaly. This is only a bootstrap/replay control; normal scheduled runs omit it and retain fingerprint deduplication.

The `Clued CI Health Anomaly` Work task uses platform runtime defaults for model and reasoning effort: both are **unfixed**. Do not select or claim a specific model for that task. This repository cannot set or verify ChatGPT-side model fields. Its Work path does not use the OpenAI API and must not request or create an API key.

An explicit OpenAI API fallback is included but disabled by default. Set repository variable `CLUED_CI_HEALTH_ANALYSIS_MODE=openai_api` and add an `OPENAI_API_KEY` secret only after deliberately choosing API billing. That path calls `gpt-6-luna` with low reasoning, and it still runs only for `notify_model=true`. The repository does not create, infer, or require an API key for the default ChatGPT Work transport.

Do not leave the ChatGPT Work path active when deliberately switching to `openai_api`; one anomaly should have one analysis owner.


## Current qualification status

The following P7/P8/P14 evidence concerns the historical four-runner subjects. It is not blanket qualification of today's six active inventory entries, later service-account/hook changes, or a current host readback. Revalidate its exact scope under the maintained runbook before using it for a change.

- P7 dual Windows parallelism: PASS — Actions run `35411176126`
- P8 dual Linux/Docker parallelism: PASS — Actions run `35413330672`
- P14A company → home failover: PASS — run `35420799275`, exact commit `1bebc816da05da5d11073e366754ed8f768c1d0f`
- P14A home → company failover: PASS — run `35421162688`, exact commit `586929dd64e9c48346291dd7f60bb50ac25a8c62`
- P14B Turing cold boot: PASS — post-boot P7 attempt 3 and P8 attempt 5 both succeeded
- DESK-W-591 cold boot: DEFERRED / NOT TESTED

Known operational notes: GitHub runner online/offline status can lag behind the actual runner session, so scheduler/job evidence and local watchdog state are authoritative for failover qualification. Turing's post-boot Runner/Docker qualification is PASS, but containerized scanners that must download external databases still require separate proxy-egress hardening. Full historical evidence and troubleshooting notes are intentionally kept outside this repository in the KooYomi 资料中心.

## Runner profiles

### windows-general-v1

Required:

- Windows x64
- Git for Windows
- Python 3.12
- custom labels: `clued,pool-general,trust-internal,site-<site>,cap-python312`
- Node.js 24 is optional; advertise `cap-node24` only after verification
- dedicated standard `clued-runner` account and automatic Windows service; the host watchdog reports that service and never starts a personal-account listener

The Windows bootstrap resolves Python and optional Node shims, but is a base installer rather than proof of the final dedicated-account/ACL/disable-update contract. Validate the actual service account and service-visible native runtimes before activation; personal WindowsApps aliases or an interactive terminal are not service evidence.

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

The bootstrap installs `KillMode=control-group`; stopping a service can terminate all its descendants. The current watchdog's busy check is best-effort and has a dispatch race, so it is not a safe-draining guarantee. Follow the runbook's scheduling isolation, repeat local/API checks and supervised maintenance requirements.

## Capacity profiles

### compact-v1

For approximately 16 GB personal hosts:

```text
WSL memory      6 GB
WSL processors  3
WSL swap        2 GB
capacity suspend: host free memory < 1.5 GB (disk: the governance standard)
capacity resume:  host free memory >= 2.5 GB
```

### workstation-v1

For 64 GB-class workstations:

```text
WSL memory      28 GB
WSL processors  16
WSL swap        8 GB
capacity suspend: host free memory < 6 GB (disk: the governance standard)
capacity resume:  host free memory >= 10 GB
```

Capacity suspension attempts to detect idle Linux runners, but its sampling is not atomic with dispatch or service stop. A newly assigned job can be terminated by `KillMode=control-group`; unreadable listener logs do not prevent suspension. Follow the runbook's restrictions on new deployment and safe draining; do not treat this mechanism as a guarantee that active jobs survive.

## Runner package pin

New onboarding currently uses:

```text
GitHub Actions Runner: 2.337.0
Windows x64 SHA-256:
1150692afa94e71f872017e254ea55b6eece1eece3fe7e3a6d4c93d0a1b85cfc

Linux x64 SHA-256:
70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613
```

Both bootstrap paths verify the package hash before extraction. The historical inventory and base bootstrap permit automatic updates, while the protected persistent-runner standard requires administrator-managed updates with `--disableupdate`. This is an implementation gap, not an accepted hardened configuration; see runbook sections 2.3 and 12.

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

`-RestartWsl` shuts down the user's WSL VM. Do **not** use it until all affected distributions and other workloads, including non-CI work, are identified and drained, the entire supervision chain is stopped, and the shutdown scope is authorized. Follow runbook sections 6.4, 7 and 8; the default writes configuration without restarting WSL.

Use the reviewed installation procedure in runbook section 4.2. The [Windows base bootstrap](bootstrap-windows-runner.ps1) can start a personal-account listener without `-RunAsService`, and that flag alone does not select the required dedicated standard account. The [Linux base bootstrap](bootstrap-linux-runner.sh) requires sudo and installs/starts a service as the calling user; the final job account must have no sudo. Neither base script establishes the complete hardened activation contract. Do not activate a node until account, ACL, hooks, native runtimes and administrator-controlled updates are verified under an isolated route.

Never paste a registration token into chat, a committed file, screenshots, logs, or shell history. Use the interactive hidden prompt.

### validated

Before activation, prove the advertised capabilities:

- Windows: checkout + Python 3.12 + optional Node 24
- Linux: checkout + `docker version` + `docker info` + create/remove a disposable volume
- verify GitHub runner labels match the profile and site
- verify Windows and Linux jobs can run concurrently when both runners are present
- verify the physical host remains responsive under the assigned capacity profile

After capability validation and the authorized activation change, render a watchdog preview for the Linux entries whose effective state is `active`, without installing or starting supervision:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\ci\self-hosted\node-governance\render.ps1 `
  -HostId company-primary `
  -OutputPath "$env:TEMP\node-governance-company-primary.preview.ps1"
```

For each primary or additional Linux entry, the renderer uses its explicit `state`; only a missing `state` property inherits `host.state`. It selects entries whose effective state is `active` and refuses the host only when none are selected. Thus `host.state: validated` with an explicit `linux_runner.state: active` permits that entry in a preview; an entry inheriting `validated` remains excluded. This selection rule does not grant activation or deployment authority. Home-primary has had no active Linux runner since `clued-ci-home-linux-01` was retired, and its watchdog must stay stopped. On 2026-10-21 its scheduled task read Disabled, no watchdog process was running, and its Startup launcher had been renamed to `.task-backup` (the HKCU Run entry remains but points at the missing file).

The current main renderer's `-InstallStartup` uses Startup/HKCU Run; it does not install the no-console supervised scheduled task actually deployed on company-primary. PR #615's installer remains unmerged. Deployment must follow runbook section 5, including its restriction on enabling or expanding automatic service suspension before safe draining is implemented. WSL distributions belong to the user's account; SYSTEM is not a substitute.

### active

An active node may accept trusted internal CI according to its capability labels.

A machine being temporarily offline is not a governance failure. Pool availability is determined by whether required capability pools still have online capacity.

### draining

Before maintenance or retirement:

1. follow runbook section 7.1 to isolate every matching dispatch route; removing only a unique route label does not block general jobs, and stopping a service is not a draining method;
2. stop the verified supervision chain in an authorized, manually monitored maintenance window;
3. allow assigned and running jobs to finish, then repeat API, local Worker and listener checks, including a final read immediately before service stop;
4. stop only the verified idle target, then carry out the separately authorized maintenance. Shared WSL/Docker or VM-wide changes require all affected workloads to be in scope and drained.

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

## Node governance

One mechanism per node (Node Resource Governance v1; standard in `config/node-governance-standard.json`, one file for every node):

- **Declaration**: the host's `governance` block: `drives` (letters), `resident_distro`, `worktrees` (development roots, checked only), `overrides` (numbers of the standard only: `disk`, `budget`, `classes.<class>.<number>`; a node can neither add nor drop a rule). Memory levels stay in the capacity profile.
- **Task**: `Clued-Node-Governance`, one per node, for the Owner, Limited (it never elevates), at logon and daily 04:00, single instance, from `C:\ProgramData\Clued\node-governance\node-governance.ps1` (rendered by `node-governance/render.ps1 -HostId <host>`; render again after a change of the declaration or the standard and restart the task). Install or migrate with `node-governance/install.ps1 -HostId <host>` (one UAC: folder and ACL, render, register, one read-only round `-DryRun -MaxIterations 1`, and only then retire the old host watchdog and cache maintenance worker and start). `-WhatIf` prints the plan.
- **Levels** (every 60 s, per drive, fixed GiB whatever the drive size; a drive may override them under `overrides.drives.<letter>`): green; yellow below 30 GiB (alerts and pressure sweeps only); red below 10 GiB, held until 15 GiB. Yellow or red runs a pressure sweep (at most hourly) of what lives on that drive; red on the drive of the resident CI's WSL disk holds new resident batches; red on the runner disk stops the Linux runners after a pressure sweep (as the watchdog did); C: otherwise only alerts. Low memory stops the Linux runners without a sweep.
- **Sweeps** (only while no `Runner.Worker` runs, sampled twice): hourly the runners' `_work/_temp` and dangling Docker objects (dangling images, stopped containers older than 24 h, leftover `supabase_*` stacks included, and their unreferenced volumes; a running container is never removed); daily after 04:00 the old checkouts and tool versions, unused images, build cache, package caches above their limits, old temporary files, the scan cache and `fstrim`; on Windows this account's `%TEMP%`, npm/pip/NuGet caches and logs past their days. At most 16 objects and 60 s per call; the rest is debt (alerted after 3 rounds). Never through a link, never off its file system, never under a protected folder. The resident CI's distribution (the companion account's) is not swept here: its archives are the resident executor's own, between batches, and this task only reads the drive of its disk. Archived upgrade generations (class 12, SYSTEM/Administrators only) are pruned by `install.ps1` in its one elevation with the installed resident's tool (three newest plus the current one).
- **Checks** (daily): a WSL virtual disk swollen past max(20 GB, 25 %) of its file (compaction or, better, a sparse disk: to be measured on CluedDev-Linux first) and development worktrees untouched for 7 days are alerted, not changed.
- **Status**: `C:\ProgramData\Clued\node-governance\status.json` (contract `clued.node-governance-status/1`: level, `intake` = the resident disk's drive and level, drives, `linuxRunners` hold, virtual disks, debt, last actions), rewritten whole every probe; the executor, the PR page line and the compute panel read it. Alerts: one `ALERT` line and one notification per key (red every 30 minutes, others once a day, recovery once). `state\force-resume` clears a held Linux runner intent. `-DryRun` has its own log, state, status file (`status.dryrun.json`) and mutex.
- Busy sampling and stopping keep the watchdog's dispatch race: this is not a safe-draining guarantee (runbook sections 2.2 and 12). It never changes GitHub Secrets, production deployment authority, DNS, database state, or production traffic.

## Add a Linux slot on an existing host

A host with spare WSL capacity can run more than one Linux runner in the same distro. Each extra slot is declared under the host's `additional_linux_runners` with its own `name`, `root`, `service_unit` and a `route_label` of the form `runner-<site>-linux-NN`; it shares the primary runner's `distro`, `user`, watchdog and Docker engine. While its `state` is `enrolling`, the health monitor treats it as known but not required and the watchdog leaves it alone.

Both public MCP workflows allocate dynamic loopback MCP ports. The self-hosted behavior workflow still takes `host-port-lock.sh ... public-mcp-ports` for the shared default local Supabase ports and releases it in `if: always()` cleanup; protocol has no such lock. Other fixed-port consumers need their own accurate lock domain; dynamic MCP ports do not isolate shared databases or Docker workloads.

Enroll through runbook section 4.2 with a fresh registration token from GitHub → Settings → Actions → Runners → New self-hosted runner, the assigned independent root and exact route label. The base Linux script requires sudo and starts a listener; do not grant the existing no-sudo `runner` account sudo or expose an unhardened slot to production routes. Registration and service installation must preserve the dedicated job identity.

Then, in one change: set the slot's `state` to `active`, give the primary runner on the same host its own `route_label` (add that label to the primary runner in GitHub's runner settings first), add both route labels to the heartbeat matrix, and re-render the node governance task with `node-governance/render.ps1 -HostId <host>` so it also supervises the new service.

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
→ capability smoke
→ mark active
→ watchdog (rendered once the entry is active)
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
