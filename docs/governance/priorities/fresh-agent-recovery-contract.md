# Fresh-Agent Multi-Track Recovery Contract

**Status:** `BOOTSTRAP CONTRACT CANDIDATE / NOT AUTHORITY / NOT FROZEN`

This contract defines the minimum repository-side recovery path for a fresh Agent with no private chat memory.

## 1. Read order

A fresh Agent should read, in order:

1. repository root `README.md`;
2. `docs/governance/priorities/README.md`;
3. `artifacts/priorities/current.json`;
4. `artifacts/priorities/source-registry.json`;
5. `artifacts/priorities/bootstrap-context.json`;
6. `artifacts/priorities/runtime-capability-status.json`;
7. `artifacts/priorities/authority-currentness-contract.json`;
8. `artifacts/priorities/projection-watermark.json`;
9. `artifacts/priorities/bootstrap-currentness-assessment.json`;
10. `artifacts/priorities/bootstrap-next-action-assessment.json`;
11. `docs/governance/priorities/current-frontier.md`;
12. `docs/governance/priorities/tracks.md`;
13. `docs/governance/priorities/source-registry.md`;
14. `docs/governance/priorities/cross-track-map.md`;
15. `docs/governance/priorities/currentness.md`;
16. `docs/governance/priorities/authority-currentness-contract.md`;
17. `docs/governance/priorities/runtime-capability-status.md`;
18. `docs/governance/priorities/zero-memory-preflight.md`.

Repository recovery is only a projection recovery step. It does not replace authenticated Canonical / Authority resolution.

## 2. What the Agent may recover from the repository projection

The Agent should be able to recover:

- the four current Clued Tracks;
- each Track's purpose;
- current Programs / Priority Items;
- `✅ / ◐ / 🔎 / ⛔ / ○ / ⏳ / ↘ / ☐` status;
- Current Priority Frontier;
- why items are currently prioritized;
- exact normalized source / derivation chain for every registered Priority Item;
- hard dependencies and blockers;
- non-hard cross-track impacts;
- known resource conflicts and conditional parallelism;
- the fact that completed items remain in governance history;
- whether an authoritative Multi-Track Reconciliation / Replan runtime is implemented or not;
- how runtime Principal / Binding / Membership / Development Grant / Resource×Action must be resolved;
- repository Projection drift state;
- the safe fail-closed answer when upstream Currentness is not proven;
- the safe fail-closed answer when no legal side-effect next action can be established;
- that repository projection carries no execution Authority.

## 3. What MUST NOT be guessed from the repository

The Agent must not guess:

- current authenticated Principal;
- current Binding / Membership / Development Grant values;
- current Resource×Action + selector/scope grant;
- production / database / release / deployment / secret / budget Authority;
- a missing Canonical Event / Receipt;
- `CURRENT` when Currentness is only `UNKNOWN`;
- that an unimplemented authoritative Replan Registry is equivalent to an empty authoritative registry;
- whether a high-priority item is legally executable by this Agent;
- whether a Candidate revision has become Current without exact Authority evidence.

If any of these are required, the Agent must resolve them through authenticated Clued Authority / Currentness interfaces.

## 4. Authority / scope rule

`Priority != Assignment != Authority`.

The runtime resolution path is:

```text
Authenticate
↓
Resolve Binding
↓
Resolve Authorization Status
↓
Resolve Project Membership / Access
↓
Resolve Development Grant / Context Scope
↓
Resolve effective Resource × Action
↓
Verify relevant Currentness
↓
Compute eligible next action
```

Repository-only safe result:

```text
Principal = NOT_RESOLVED
Runtime Authority = NOT_ESTABLISHED
Assignment Scope = NOT_RESOLVED
Eligible side-effect actions = []
```

## 5. Eligible next action rule

A next side-effect action is eligible only when all of the following hold:

```text
Current Priority Frontier
∩ legal item state
∩ dependency satisfied
∩ resource available
∩ Development Grant / Assignment Scope
∩ effective Resource × Action
∩ environment match
∩ currentness = CURRENT
```

If Authority or Currentness is unknown:

```text
status = INDETERMINATE_FAIL_CLOSED
eligible_side_effect_actions = []
```

The Agent may continue only with explicitly safe read-only analysis/drafting allowed by its existing repository access.

## 6. Currentness rule

Repository Projection integrity and upstream Canonical Currentness are separate.

- `projection-watermark.json` can detect local projection drift;
- it cannot prove upstream Priority Snapshot Currentness;
- `bootstrap-currentness-assessment.json` currently resolves the Priority Snapshot as `UNKNOWN / FAIL_CLOSED` until an authoritative CurrentnessReceipt / dependency-watermark verification exists.

This is the correct answer, not a failure to answer.

## 7. Reconciliation / Replan rule

Current read-only discovery finds no discoverable authoritative Multi-Track PriorityReconciliation / Replan runtime in production or `main`.

Therefore the safe Bootstrap answer is:

```text
PriorityReconciliation Runtime = NOT_IMPLEMENTED / NOT DISCOVERABLE
Latest PriorityReconciliationReceipt = NOT_AVAILABLE
Authoritative Replan Registry = NOT_IMPLEMENTED / NOT DISCOVERABLE
Open Replan Proposals = UNKNOWN (not [])
```

When Runtime is implemented, these bootstrap answers must be replaced by real authoritative registry/receipt reads.

## 8. Current strict engineering interpretation

The current repository projection states:

- `E-001 Kernel Phase 2 Real Closeout` is the strict Engineering mainline;
- `E-008 Multi-Track Bootstrap Governance` may continue only as non-blocking parallel work;
- Foundational Research may continue independently when it does not consume the same constrained engineering resource;
- Product / Brand / Business design work may continue as low-cost parallel work but must not delay E-001.

This is a Priority projection, not an execution grant.

## 9. Completion rule

`✅ COMPLETED` is not equivalent to “code exists” or “an Agent said done”.

A completed Priority Item must satisfy its applicable completion contract, exact target identity, required verification / gates, evidence and receipt / closeout semantics.

## 10. Zero-memory test rule

The Bootstrap repository now targets **25/25 safe-answer structural coverage**. This means every standard recovery question has an explicit truthful answer path, including `UNKNOWN / NOT_IMPLEMENTED / FAIL_CLOSED` where appropriate.

It does **not** mean the final Runtime gate has passed.

Final Zero-Memory validation still requires at least three dynamically selected qualified fresh-context Agent Runs under legitimate test Authority / Currentness inputs. Model / provider identity is not hardcoded.

The orchestration, comparison and evidence collection should be automated. The user must not be required to manually open multiple Agent sessions, copy prompts, collect screenshots or compare outputs.