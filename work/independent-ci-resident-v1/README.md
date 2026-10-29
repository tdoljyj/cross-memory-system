# independent-ci-resident-v1 (DRAFT, not installed)

Design and draft implementation of a resident executor for the TURING independent CI, so ordinary PR batches no longer need a per-batch Owner UAC prompt, without weakening any gate.
KooYomi Task `79c32815`. Owner decisions: Decision `0d84ddbb`.

- Read first: [DESIGN.md](DESIGN.md) (Chinese).
- Nothing here has been installed or run on a host.
- The Windows and Linux scripts are dry-run by default. Their `-Apply` / `--apply` modes need a reviewed plan hash, an elevated Owner token or root, and Source v2 (DESIGN.md §7).

Offline checks (temp directories only, no host, no network, no secret):

```bash
node --test test/*.test.mjs
python -I -B -m unittest discover -s test -p "test_*.py"
node drill/offline-drill.mjs
```

Windows-only offline checks (PowerShell 5.1; each needs a NEW empty scratch directory):

```bash
powershell -NoProfile -File windows/test-resident-windows.ps1 -Scratch <new dir>
powershell -NoProfile -File windows/test-install-carry.ps1 -Scratch <new dir with a short path>
powershell -NoProfile -File windows/test-job-host.ps1 -Scratch <new dir> [-Wsl]
```

`test-install-carry.ps1` builds fake earlier installs with 64-hex record names. Give it a short scratch path, for example under `%TEMP%`, so the paths stay under the 260-character limit of Windows PowerShell 5.1.

The failure table, the Source-independent executed heads and the status, PR page and notification features of the quota redesign's phase 1 are described in DESIGN.md §16 (Task `12ada80e`).

Phase 2, step 1 (Task `6451a55d`) is described in DESIGN.md §17. It covers the executor's own run queue (`state\queue\queue.json`), the waits and back-off, the release cap, the budgets read from the ledger, the circuit breaker and supersession.

Phase 2, step 2 (Task `6451a55d`) is described in DESIGN.md §18. It covers parking at points A and B, stage 8 as tries, the Owner's drain request before a reinstall, and policy `/5`.

Phase 2, step 3a (Task `6451a55d`, Owner decision `0bb98194`) is described in DESIGN.md §19. Before writing a green, stage 8 now reads main's branch rules and GitHub's test merge of the PR. It records every merge-slot green in the green ledger (`state\v2\green-ledger`). A PR that GitHub has already merged as tested counts as success. The train stays off.

Primary/standby C6 (Task `6444f88a`) is described in DESIGN.md §20. It adds the intake pause: any Owner session can hold new batches for at most two hours (`tools/rearm-tool.mjs request-intake-pause`), without touching a batch that runs or is parked. Each request names a holder, and a holder may lift only its own hold. status.json `/3` shows the holds.

Phase 2, step 3b (Task `6451a55d`, sub-Task `a3548216`) is described in DESIGN.md §21. Job contract `/3` adds the tested commit S to the job identity. With the train off, S is the head itself, so the workspaces and tests are the same as before.

Primary/standby C5 (Task `ade5df89`) is described in [DESIGN.md §23](DESIGN.md#23-主备-c5pr-页面节点状态接班核对与双活停机task-ade5df89). It covers each node's PR status, standby reminders, bounded takeover checks, and the dual-active intake hold with its three release conditions. These are advisory; the service-side ci-admission role and C4's GitHub read-back remain the publication controls.

The companion job host (Task `8e1f07d3`) is described in DESIGN.md §24. Every companion child now runs in a job object of the companion's own (`windows/CompanionJobHost.cs`, compiled at install into `bin\CluedCompanionJobHost.exe`). A child that outlives its time limit is ended with exactly that job, so the mailbox lane goes on, and a stage-0 failure is released without asking the companion for anything. The service's own runner still never kills a child. `test-job-host.ps1` compiles the host and runs `test/job-host.test.mjs` with its live cases; `-Wsl` adds the real wsl, PowerShell and git chains.

Primary/standby C7 (Task `088ab175`) is described in [DESIGN.md §30](DESIGN.md#30-主备-c7节点身份与-standby-安装). The install plan is `/7` (`/6` before DESIGN.md §33) and the receipt `/5`: they carry the node identity (node name, App key id and public-key fingerprint, ci-admission token fingerprint and connection id, the formal qualification refs; ids and fingerprints only), and no role is assumed, so a node installed on a new connection is STANDBY until the role probe says otherwise. `install-resident.ps1` has two optional parameters, `-AppPrivateKeyFile` and `-CiAdmissionTokenFile`: a given file is fingerprinted with the package's pinned `node.exe`, must match the record's pin, and is then placed create-only for `.\clued-control` alone (nothing is overwritten or deleted, the downloaded copy is yours to delete). `ciPrincipalRoleRef` now means the Owner decision that the connection MAY hold ci-admission. Merging this code is not an install. The company node's install checklist also includes Task `f995d832` (WSL host tuning, [linux/host-tuning/README.md](linux/host-tuning/README.md)).

The three fixes for the first HALT of the reinstalled TURING resident (2026-10-29) are in [DESIGN.md §33](DESIGN.md#33-r4-首次-halt-的三项修复): companion.json's Source scripts must lie under `source\<ciSourceManifestSha256>\` (checked at the package build, at the companion's start and by `verify-resident.ps1`); the install appends one READ_CONTROL entry (`0x120080`, this folder only, the same as the Owner's) for the resident service to `C:\ProgramData\CluedIndependentCI` (plan `parentAcl`, step `parent-acl`, checked by verify); and the Windows archive's own refusal code is carried into the HALT facts, the terminal record and the receipts.

The in-place upgrade channel (Task `018da927`), resident side, is described in [DESIGN.md §34](DESIGN.md#34-原地升级通道常驻层接线). status.json is `/7` (the reader still takes `/5` and `/6`): `versions` shows what both sides run, whether they agree and the upgrader's operation, and five new notices become Windows notifications. While the two sides disagree (`consistent` false, never on "unknown") the executor holds new batches (intake holder `version-skew`), and the first Linux stage refuses with `UPGRADE_VERSION_SKEW`. The upgrader lifts its own pause through `owner\` only (`upgrade-resumed`). `service-start` names the generation; a changed one adds `resident-upgraded`. The companion runs a third lane for the upgrade mailbox (`upgrade\mailbox\`), with strictly checked arguments for the frozen root tool, and refreshes the Linux version facts. `tools/build-package.mjs` writes package `/4` (layout, state compatibility, acceptance, the Linux section with the upgrade tool, the signer and an optional Source v2 bundle, and the upgrader section); `--fresh-install --upgrader-config <file>` adds the upgrader's install targets, which only a fresh install takes. `tools/rearm-tool.mjs inspect` shows the upgrade.

Batch 3 (Decision `ca70ea31`) adds four sections. [DESIGN.md §35](DESIGN.md#35-归档保留与瘦身trivy-缓存回收c-余量提醒无心跳不量-linuxtask-4aedda54task-018da927-子项-bc): formal-spool retention (each class keeps its newest 20 GiB and at least 10, an Owner keep list protects archives, Linux through the mailbox request `archive-prune`), slimmer success archives, the trivy cache reclaim, the C: reminder, no Linux measurement without a companion heartbeat, and `verify-resident.ps1`'s verdict (Tasks `4aedda54`, `018da927`). §36: risk tiers of the daily budgets; a stage-1 burn that proves it published nothing counts as an evaluation, not an execution, with the interim 48/96 unchanged (Task `12ada80e`). §37: a batch resumed from parking point A gets a second bundle (`build-bundle.ps1 -Rebundle`, mailbox request `rebuild-bundle`) before its workspace, and the status page marks every batch at A (Task `4012c1b9`). §38: step 3c-2a, S != H end to end, merged from its paused branch; what is left for 3c-2b is listed there (Task `a3701d3d`).
