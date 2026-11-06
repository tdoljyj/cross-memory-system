# Install batching plan (Task 09052ffe) — PLAN ONLY, nothing here is implemented

Goal: every change that needs the resident layer or Source reinstalled/upgraded rides in as few install batches as possible; each batch costs the Owner
one Decision, one UAC (full reinstall only) and one Grant, and is announced with its contents in advance. This note is the method and the first
cut of the list (as of 2026-11-04, generation 7 installed). The classes below come from the code (cited); the per-task classes are read from the
task texts and must be confirmed against the actual diff before a batch is cut (see "Confirm" at the end).

## 1. What a change costs: three install classes (from the code, not from habit)

| Class | What it touches | Path | Owner cost |
|---|---|---|---|
| **R** (frozen channel) | the upgrader's own files: `windows/upgrade-apply.ps1` (`UPGRADER_WINDOWS` in `tools/build-package.mjs`), `windows/UpgraderServiceHost.cs`, `upgrader/src/*` and the resident modules it imports; the layout, ACLs, accounts, SDDLs, privileges, `secrets\`, node identity/profile; the upgrader service | **full reinstall** — an in-place plan is refused with `UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL` (`upgrader/src/plan.mjs`, `CHANNEL_ROOTS`, the upgrader manifest pin) | Decision + UAC + Grant |
| **U** (in-place) | resident `src/*.mjs`, the content-addressed `resident\<sha>\windows\*` tools (`install-resident.ps1`, `verify-resident.ps1`, `rearm-tool`, new Owner tools), `bin\ResidentServiceHost.cs` / `SwapBroker.cs` and the Source v2 Windows C# (recompiled by `Compile`), `config\policy.json` / `companion.json`, the Linux bundle and role hashes | **in-place upgrade** (stage, drain, switch, verify, rollback by the installed `upgrade-apply.ps1`) | Decision + Grant (no UAC) |
| **T** (tooling only) | `reinstall/`, `rollout/`, `tools/` that run on the build side or are used by the NEXT reinstall launcher (`reinstall/launcher/*`, `build*.ps1`) | nothing is installed; takes effect when the next package/launcher is built | none by itself |

Consequences:
1. One class-R change forces the whole batch to be a full reinstall. Then EVERY pending class-U/T change should ride in that batch too (the UAC is already paid).
2. Without a class-R change the batch is an in-place upgrade; class-R changes wait and are collected for the next reinstall.
3. Therefore the first question for every pending item is "does it touch a frozen file?", and the list is ordered by that, not by task priority.

## 2. The pending list (first cut; tentative classes)

| Task | Change | Class | Needs | Notes |
|---|---|---|---|---|
| `42fe5ae4` | `upgrade-apply.ps1`: stable-digest drift refusal, `UPGRADE_APPLY_UNEXPECTED` carries exception type + line | **R** | gen 8 tooling branch | the only class-R item in `claude/gen8-upgrade-tooling`; it is its own commit so it can be left out |
| `695d31cc` | `windows/test-upgrade-system.ps1` (LocalSystem Compile test) | U | the Owner runs it once (one UAC) before a Source v2 Windows / channel change | not installed; run from the checkout |
| `5bf421b0` | `ResidentScmV2.cs` `InstallTimeIdentityAllowed` (PR #976, merged) | U (Source v2 Windows C#) | DESK/TURING redo DRAFT with the new C, Owner accepts C/S, Grant | code done; the rest is the acceptance sequence |
| `3da6fd81`, `f0194b75` | launcher/verify fixes for Chinese Windows, empty live ledger | T (+U for `verify-resident.ps1`) | next reinstall launcher | already in the tree at generation 7 (PR #982); open: Restart Manager covers files, not directory handles |
| `1abde401` | `windows/replace-heartbeat-token.ps1` | U | Owner runs it elevated, no reinstall | needs a token issued with `f2e9a8c6` to be useful |
| `f2e9a8c6` | Clued server: `ci:heartbeat` scope (migration, OAuth, front end) | not resident | separate PR, independent review (auth core) | blocks issuing heartbeat-only connections; unrelated to the install classes |
| `c59e697c` / gen 8 | three scans in parallel (`src/executor.mjs`) | U | in-place | other session |
| `1e05b2d8` | production scan-start cutover (resident back to Native mode, takeover/upgrade rotation) | U (+ Owner-run activation) | in-place + Native activation | other session; keep it in the SAME Grant as the scans |
| `867250db`, `4d3aaa64`, `8e1f07d3`, `576231fa` | generation 6/7 fixes | U | installed with gen 6/7 | done once those generations are installed |
| `4012c1b9`, `4aedda54`, `a3701d3d` (3c-2), `463e8148` | resident layer items still in the backlog | U (confirm: any `windows\*.cs` host change is still U, only `upgrade-apply.ps1` is R) | next in-place batch | |
| `f995d832`, `25ac6c5f` | node install lists / new-node preparation | T / R if they change ACLs or accounts | next reinstall | confirm per diff |

## 3. Batches

Rule: **never start a reinstall batch for a class-U change, and never leave a known class-R item out of a reinstall that is happening anyway.**

* **Batch 8 (decide first; two options, both are one Grant for the Owner):**
  * **8A, in-place (recommended if nothing else is class R):** drop the `42fe5ae4` `upgrade-apply.ps1` commit; ship the parallel scans, the scan-start cutover, `1abde401`, `695d31cc`, the launcher/verify tooling. One Decision, one Grant, no UAC. `42fe5ae4`'s drift check and failure detail wait for the next reinstall (R1).
  * **8B, full reinstall:** keep the `42fe5ae4` commit; the batch becomes a reinstall (UAC) and carries every class-U/T item above plus the reinstall tooling fixes (`3da6fd81`, `f0194b75`) as the launcher that performs it. Choose this only if a reinstall is wanted anyway (an ACL/account/secrets change is pending, or the Owner prefers one reinstall now over two later).
* **R1 (next reinstall, collects class R):** `42fe5ae4` if not in 8B, anything touching ACLs/accounts/privileges/secrets, the node preparation items, a repinned runner stable digest after a deliberate runner reconfiguration.
* **Later in-place batches:** merge-train and standby items (`a3701d3d` 3c-2, `5ff707c5`), each announced with its contents; a batch is cut when a pending item has been waiting more than one week or one pending item is urgent.

Why not simply "one reinstall for everything now": a reinstall also drains and re-qualifies both nodes; the in-place path keeps the previous generation for rollback and needs no UAC. The plan optimizes the number of UACs, not the number of batches.

## 4. Process

1. One list (this file or its KooYomi copy), one row per pending change: task id, files, class, which node(s), blocking dependency, status. A change is added when its PR is opened, not when it merges.
2. Class is computed from the diff, not from the task text: any path in the class-R column of section 1 → R. (A small script over `git diff --name-only <installed>..<candidate>` against the frozen set is the obvious automation; not built here.)
3. Before a batch is announced: list contents by row, the class, what the Owner must do (Decision / UAC / Grant), the rollback story, and the verification that will be run.
4. After a batch: record the installed generation, package hash, the result (`verify-resident`), and move rows to done. The list in KooYomi must match what is installed (acceptance of 09052ffe).

## 5. Confirm before cutting a batch

* The classes in section 2 are tentative. Confirm each against the actual diff (section 4.2), especially the rows marked "confirm".
* Whether the scan-start cutover (`1e05b2d8`) needs a policy/config change that is class R is not known from the task text.
* The KooYomi copy of this list is for the Owner/coordinator to publish; this session does not write to KooYomi.
