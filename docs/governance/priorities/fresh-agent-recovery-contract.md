# Fresh-Agent Multi-Track Recovery Contract

**Status:** `BOOTSTRAP CONTRACT CANDIDATE / NOT AUTHORITY / NOT FROZEN`

This contract defines the minimum repository-side recovery path for a fresh Agent with no private chat memory.

## 1. Read order

A fresh Agent should read, in order:

1. repository root `README.md`;
2. `docs/governance/priorities/README.md`;
3. `artifacts/priorities/current.json`;
4. `artifacts/priorities/bootstrap-context.json`;
5. `docs/governance/priorities/current-frontier.md`;
6. `docs/governance/priorities/tracks.md`;
7. `docs/governance/priorities/cross-track-map.md`;
8. `docs/governance/priorities/currentness.md`.

Repository recovery is only a projection recovery step. It does not replace authenticated Canonical / Authority resolution.

## 2. What the Agent may recover from the repository projection

The Agent should be able to recover:

- the four current Clued Tracks;
- each Track's purpose;
- current Programs / Priority Items;
- `✅ / ◐ / 🔎 / ⛔ / ○ / ⏳ / ↘ / ☐` status;
- Current Priority Frontier;
- why items are currently prioritized;
- hard dependencies and blockers;
- non-hard cross-track impacts;
- known resource conflicts and conditional parallelism;
- the fact that completed items remain in governance history;
- the known E-010 Currentness gap;
- that repository projection carries no execution Authority.

## 3. What MUST NOT be guessed from the repository

The Agent must not guess:

- current authenticated Principal;
- current Resource×Action + selector/scope grant;
- production / database / release / deployment / secret / budget Authority;
- current Canonical Version or Event watermark when not explicitly verified;
- whether a high-priority item is legally executable by this Agent;
- whether an empty Bootstrap Replan Registry proves Canonical has no open Replan Proposal;
- whether a Candidate revision has become Current without exact Authority evidence.

If any of these are required, the Agent must resolve them through authenticated Clued Authority / Currentness interfaces.

## 4. Eligible next action rule

`Priority != Authority`.

A next action is eligible only when all of the following hold:

```text
Item is READY or explicitly assigned
+
Priority / assignment permits work now
+
Dependencies and blockers permit work
+
Required resource is available
+
Currentness is verified for the relevant dependency scope
+
Principal is authorized for Resource × Action + selector/scope
```

If Authority or Currentness is unknown, the Agent may continue only with work that is explicitly safe under the available scope, such as read-only inspection or non-authoritative drafting. High-risk or side-effecting action fails closed.

## 5. Current strict engineering interpretation

The current repository projection states:

- `E-001 Kernel Phase 2 Real Closeout` is the strict Engineering mainline;
- `E-008 Multi-Track Bootstrap Governance` may continue only as non-blocking parallel work;
- Foundational Research may continue independently when it does not consume the same constrained engineering resource;
- Product / Brand / Business design work may continue as low-cost parallel work but must not delay E-001.

This is a Priority projection, not an execution grant.

## 6. Completion rule

`✅ COMPLETED` is not equivalent to “code exists” or “an Agent said done”.

A completed Priority Item must satisfy its applicable completion contract, exact target identity, required verification / gates, evidence and receipt / closeout semantics.

## 7. Zero-memory test rule

Final Zero-Memory validation must use at least three dynamically selected qualified fresh-context Agent Runs. Model / provider identity is not hardcoded.

The orchestration, comparison and evidence collection should be automated. The user must not be required to manually open multiple Agent sessions, copy prompts, collect screenshots or compare outputs.

This repository-side contract is only the preparation layer for that final automated gate.