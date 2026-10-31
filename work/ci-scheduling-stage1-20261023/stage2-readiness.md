# Stage 2 readiness: v0.9 node pool → Task617 Native External

Status: DESIGN PREPARATION ONLY. Task `98dbf336` owns this preparation; Task `6176fdcc` owns the original External/ACT acceptance. This file is neither a Stage 2 implementation approval nor Host/runtime qualification.

## Bound source and authority

- Canonical Decisions `da3dd87b-b2c4-4526-9503-dfcc69282416@1` and `b4cd00c5-32cd-4eec-a4fa-1c14416d4b98@1` were read through the authenticated service after resume. The first permits Stage 2 design preparation; the second fixes direction and requires each stage's separate design, review and execution authority.
- Exact v0.9 original: Markdown SHA256 `543d2660bc09322d7aaad7410b5a0db765468f47fd59cebd0d38a4c75559b3f4`; ZIP SHA256 `d87a58114b45dca119b3f6ccf48269a2df3ff3bb69ffdf6f66d238c598fd39be`. Relevant clauses: §3.4, §4, §7.2–§7.8, §9.2, §11.2, §12 and §15.
- Engineering baseline inspected: `c955068da0d06c75cc14f085f4a0a62a53269fd6`; this is the inspected Source, not a claim that main or production remains at that commit. Root rebinds the final delivery to actual main before any push or execution.
- Canonical Task `98dbf336@5`: new-file Stage 1 implementation/testing, with second-phase 3c + primary/standby C series required before merge; no machine, production, App/account, key or ruleset operations. Task `6176fdcc@114` remains incomplete.
- Cost rule: repository Runner Runbook §2.4 and Decision `325717a6-2e31-4710-942e-45299e62ca1a@1`. No new hosted fallback, paid registration, paid Windows guest or automatic charge is inferred from an existing subscription or public free tier.

## Exact bridge and exclusions

Whole-node hardening is required before DESK signs scans or claims the complete Stage 2 node qualification. It is not automatically a prerequisite for every bounded Task617 F-pr Actions job: Root must first check whether the original Task has a still-valid, exact disposable E1 execution route and accepted publisher boundary. Such a route may qualify only that job; it cannot sign scans or claim pool-wide readiness. This file neither establishes that route nor changes v0.9's chosen JIT design. The existing WSL/systemd prototype supplies no accepted E1 route.

| Requirement | Stage 2 contract | Task617 consequence |
| --- | --- | --- |
| DESK-W-591 | Whole-node conversion, not one extra runner: scheduler, privileged environment manager, issuer, and unprivileged fetcher; Linux uses E1 Hyper-V plus E3 hardened scanner containers. | A real Actions listener can run as F-pr inside a disposable E1 guest. It needs a fresh qualification for its exact image, Source, Host and hook. |
| DESK hardening | Before DESK signs scans, drain and deregister company-linux-01..04 and company-win-01; retire old CluedCI-Linux and its watchdog under the exact migration plan. Every heartbeat and scan start rechecks services/distros. | An additional isolated test VM alone cannot establish the full hardened-node designation. Migration safety and rollback belong to Task `98dbf336`; original External acceptance stays Task `6176fdcc`. |
| Windows | First test E4 Windows Sandbox, including service/System execution and mapped output; E1-Windows only after $0 licensing is verified. If neither qualifies, Stage 2 fallback is home-win-01 on TURING. | Linux External qualification can be designed independently. A Windows fallback does not make DESK non-hardened in Stage 2; `site-company` Windows routing still needs an exact successor. Capacity and licensing are UNKNOWN here. |
| Signing identity | TPM/CNG P-256 identity and separate ECDH encryption identity; DPAPI fallback is visible to Owner. Job certificate binds node/profile/image/environment, cleanup predecessor, repository/PR/H/T/S/Source/role/attempt, combination, nonce and lease generation/expiry. | Reuse strict context checks, but replace the prototype's operator-written receipt binding with real current authority and verified node/lease evidence. A syntactically valid receipt never grants execution. |
| Owner pin | Each publisher's protected approved-node list pins identity/encryption keys and scan eligibility. Server state can only narrow it. The JIT Worker carries the same Owner-accepted list. | Native active status or a DB row alone cannot qualify a node, issue JIT config or authorize publication. Revocation updates all copies; old accepted versions cannot restore a revoked node. |
| DESK keys | DESK is not an App5368905 publisher and never holds the JIT Administration key or disaster/production keys. The issuer still has its own node/encryption keys and per-node hook/pool-read App keys. | “DESK does not hold publisher keys” must not be misread as “DESK has no keys.” None of these private keys enters the Actions guest. |
| JIT isolation | Separate Cloudflare user/email + MFA, separate free account without shared members, single dependency-free reviewed Worker, Owner-only deployment/key handling, no existing account-wide token coverage. | This is a new delivery. The old prototype does not supply it. Main Worker, DB, CI Secrets, publisher hosts and Agent sessions receive no JIT key or deployment token. |
| JIT challenge | Worker owns challenge/expiry/replay/rate limits and pinned node list, verifies node signature, independently reads the queued GitHub run and assigns the unique run label/group. No Kooyumi token is accepted or forwarded. | The accepted job must be tied to a real run/attempt/job and observed runner ID. Unknown registration/POST outcome is recovered by readback, never by creating a replacement identity blindly. |
| Per-job hook | Hook runs before every job from immutable tools/image, using one-hour token with explicit read permissions and repository restriction. `GITHUB_TOKEN` and JIT response remain job-scoped. | Preserve the native pre-step denial test, including always/failure steps and child-process shutdown. Guest receives no App private key, Owner keyring or production connection. |
| Publishers | Company primary + TURING are the two proposed App5368905 publishers; until company primary is actually installed, TURING remains the publisher. In Stage 2 only the current ci-admission ACTIVE publisher consumes encrypted requests; STANDBY does not. Upgrade the same Source STANDBY → planned switch → other node. | This CI publisher identity is distinct from Task617 External App5164952 and from a production deployment publisher. A suitable External publisher needs its own exact accepted Source/Role and current authority. |
| Green/UNKNOWN | Stage 2–3 uses the union of publisher-local write-ahead journal and server mirror; permanent publication keys and original-attempt recovery remain. Z2/N-main/depth2–3 activation is Stage 4. | No CI green, queue state, local test or server key substitutes for Task617 register → idle → publish → revoke and original-journal reconciliation. |
| F-secret | Existing trusted hosted route remains outside this pool, per Decision `b4cd00c5`. | Do not move DB/production/disaster credentials into a generic runner to unblock External. Any Task617 secret-bearing leg needs its separately scoped trusted consumer. |

## Reuse exact code evidence, without inheriting qualification

Prototype directory (old Source worktree): `work/handover-protection/free-entry-adapter-20261023/host-runner/`.
Six-program package SHA256: `c89d3d20b1f0c217a161de4f405b064197c7bf1669bb0b7273cead34285c961c`; reviewed subject SHA256: `56c7e0bbf21986f5e322656f7b80ad50ecf15ee5dc5d9079a37c444b2f112e48`.
Its R3 result is LIMITED_PASS_CODE_ONLY with 21 Windows policy tests; actual Host, BPF/network, JIT field shape, Native job and secret/DB behavior were not qualified.

| Existing component | Reusable part | Required successor under Task `98dbf336` / `6176fdcc` |
| --- | --- | --- |
| `runner_spec.py` | Exact repository/event/workflow/ref/head/phase binding, strict JIT shape, ephemeral name/ID consistency, expiry checks and negative fixtures. | Bind Stage 1 generation/currentness, node certificate and actual API job identity. The prototype expects manual root inbox delivery and is not the JIT challenge broker. |
| `bootstrap.py`, `job-started.py/.sh` | One-job listener setup, fixed hook configuration, fail-stop signal and same-unit supervisor contract. | Run inside accepted E1; carry one-hour restricted hook token, verify immutable settings and test rejected pre-step/always/failure behavior on the actual runner version. |
| `entry.py`, `probe.py` | Exclusive intent creation, fixed paths, no-argument disabled mode, bounded terminal/cgroup observation, credential-file retirement and unknown-start refusal. | Environment-manager E1 create/start/stop/remove and signed cleanup-chain adapters. systemd restrictions inside WSL are not a Hyper-V E1 boundary and cannot qualify DESK. |
| Exact Source registration capsule | Two-registry idle candidate and independent registration-only review; candidate workflow/profile byte binding. | Verify actual merged Source/Role at execution. New pool workflow/hook/JIT changes invalidate any affected whole-set proof and need the corresponding precise successor. |
| Stage 1 new core | Tables/private CAS/nonce/keys/quota/train/drop contracts and Native proposal/confirmation surfaces after their accepted delivery. | Separately reviewed node-signature transport/caller boundary; no blanket expansion of GW80/CI8. Inert crypto helpers or a pending Native proposal do not activate transport. |

## PR880 public Source interface and conflict resolution

Read-only GitHub observation: PR880 is open, head `e3b7d53effcd50d92b348434f7f1f63a094d6748`; its body and code are candidate evidence, not current production acceptance.
Relevant files: `scripts/runner/clued-production-vm.ps1`, `clued-production-vm-guest-init.sh`, `scripts/ci/self-hosted/production-publisher-profile.json`, and `.github/workflows/clued-production-publisher-host-qualification.yml`.

- The foundation exposes bounded build/qualification lifecycle actions with UUID/Host SID/path/ACL/device identity, a Host-wide lock, exact Off/provider/config-residue readback and quarantine on uncertainty. Reuse its design/tests where exact dependencies match; do not call it or copy its private paths/configuration here.
- Its Source explicitly refuses production creation/start and does not implement Actions registration, JIT delivery or production credential delivery. Default Switch NAT is expressly UNVERIFIED egress, so it is not an allowlist or private-network isolation proof.
- Conflict A: its actual Host-principal workflow targets the company Windows runner, while Stage 2 removes company-win-01. Before retirement, agree an accepted replacement qualification carrier that observes the actual new subject; a label rename or configured StartName cannot prove the runtime token.
- Conflict B: PR-code VMs and a production-publisher Guest share DESK's physical Host. Bind separate non-admin Windows principals, VM management rights, protected roots, networks and capacity reservations; prove ordinary CI cannot access/control the publisher boundary. An E1 guest alone does not repair a shared Host principal.
- Preserve separate qualification roots and ownership. Never repurpose the production publisher or execute its fixed deployment entry as a test/External runner. Production VM lifecycle evidence proves only its recorded nonproduction subject, not a new pool guest or Task617 publication.

## Next bounded deliveries and review evidence

Each row remains within the existing owning Task; this preparation creates no new Task, claim, account or resource.

| Gate | Owning Task | Concrete delivery / evidence needed |
| --- | --- | --- |
| D0 Stage 1 | `98dbf336` | Exact independent-reviewed implementation, real concurrent tests, current-main/required dependency proof, normal PR admission and merged identity; deployment and node transport remain separately gated. |
| D1 detailed Stage 2 | `98dbf336` | Small Source manifest for processes/IPC, E1 image and cleanup chain, git import checks, observation schema, TPM identity, pinned-list update/rollback, JIT challenge, monitor and Native caller adapters; independent review of the exact complete subject. |
| D2 prerequisites | `98dbf336` | First obtain exact readonly Host/OS/Hyper-V/TPM/principals/services/distros/capacity inventory and relevant PR880 evidence identity. P-1/P-3/P-5/P-6 actual qualification uses its separately bounded execution entry; an inventory grant cannot run install/VM tests. Windows P-4/P-4b only decides its route. Unknown capacity, token scope, policy or fee remains UNKNOWN. |
| D3 zero-additional-cost | `98dbf336` | Actual separate-account quota/CPU and baseline usage, storage/egress/retention/overflow behavior; actual Actions fee/budget/account state; no silent paid tier. Stage 1 public-price model alone is insufficient. |
| D4 node rollout | `98dbf336` | Exact accepted install/image package, current Host target/paths/principals, drain/no-new-work proof, retirement/rollback order and retained evidence. Before DESK scan eligibility: all five old listeners absent and old distro/watchdog retired; cleanup/hardening rechecked on every relevant start. |
| D5 publisher/JIT trust | `98dbf336` | Owner-accepted node list hash/version and image/input provenance; Native two-step node approval; both publisher packages and safe switch evidence; Owner-provisioned isolated JIT Worker, hook/pool-read/monitor Apps, exact privileges and revocation list. No private material in receipts or engineering files. |
| E0 first Native job | `6176fdcc` | Original accepted workflow/head/Source/Role and dispatch door; genuine GitHub run/attempt/job + unique JIT runner/environment IDs; successful and denied hook cases; no old identity fabricated or borrowed. |
| E1 External chain | `6176fdcc` | Exact bounded External publisher capability for App5164952; register → idle → publish → revoke on the original subject; real check IDs/status/readback, handover epoch/fence rejection and late/UNKNOWN original-journal settlement. |
| E2 ACT/closeout | `6176fdcc` | Disposable DB/external consumers within their accepted boundary, actual ACT and cleanup/revocation proof, all original journals reconciled and final live acceptance. Stage 1/2 engineering PASS cannot close this Task. |

Dependency graph (arrows are gates, not authorization):

```text
3c + C-series merged → D0 accepted Stage 1
                         └→ D1 exact Stage 2 design/review
D1 → D2 actual prerequisites + PR880 carrier/Host-boundary decision
D1 → D3 actual $0 account/resource boundary
D2 + D3 + exact execution authority → D4 node rollout
D4 + D5 pinned publisher/JIT trust → E0 (new pool route)
or: independently valid exact Task617 E1 route + its existing authority → E0
E0 + exact External Source/Role/consumer authority → E1 → E2
```

## Finite execution requests to prepare for review

These are request packages to assemble under Task `98dbf336` / `6176fdcc`, not requests submitted by this document. Existing accepted scope is re-used where its exact subject still applies; no blanket re-approval is implied.

1. **Readonly Host inventory** — exact DESK machine, fixed metadata/readonly probes and public evidence sink; explicit no secrets/private publisher configuration. Bind each probe and failure behavior; this request excludes install, VM creation/start and workload tests.
2. **DESK qualification/install/migration** — exact P-item tests and process/image/script hashes, new paths/accounts/VMs, five old listeners, distro/watchdog, drain/restart/rollback and retention list; no whole-host unconstrained command authority.
3. **Owner trust provisioning** — exact new JIT/pool-read/monitor Apps, separate Cloudflare identity/account/Worker and approved-node list. Owner retains JIT private/deployment material and isolated login; no Agent receives those credentials.
4. **Publisher Source/pin update** — exact packages on the two specified publishers, old/new list hashes, STANDBY-first order, planned switch and original journals; no ruleset, release or deployment authority bundled into it.
5. **Task617 runtime acceptance** — exact temporary node/VM, native workflow/head/phases, App5164952 bounded publisher and disposable DB/external subject, run/attempt limits, evidence/cleanup/revocation conditions and no paid fallback.

No machine probe, install, VM action, DB operation, App/account creation, key handling, ruleset change, dispatch, publication, ACT or billable action was performed to prepare this file. Actual capability/fee items above remain UNKNOWN until their bound evidence exists.
