# Clued Phase 2 — fixed non-production continuation authorization

State: **PENDING OWNER VERIFIED MERGE**. This file has no authority effect by itself.

## Approval action

The Owner approval action is the Owner (`tdoljyj`) merging the pull request that contains this exact file through GitHub's normal web merge path.

The approval is valid only if the resulting merge is independently read back from GitHub and confirms all of the following:

- `merged_by.login == "tdoljyj"`;
- merge committer is GitHub `web-flow`;
- GitHub commit verification reports `verified == true` and `reason == "valid"`;
- the exact blob bytes of this proposal and the accompanying approval record are present in that verified merge tree.

If any of these checks fail or are unknown, this proposal has **no authority effect**.

## Fixed window rule

To avoid consuming the authorization window before the Owner actually approves it:

- `not_before` = the verified Owner merge commit's authoritative GitHub `committed_at` timestamp;
- `expires_at` = exactly 24 hours after `not_before`;
- once the Owner merge exists, these two timestamps become exact immutable values for this window;
- the window does not roll, auto-renew, backdate, or extend on later reads or execution attempts.

A later canonical registration subject must materialize these two exact timestamps from the verified merge readback before any NW-01 database transaction is prepared.

## Exact scope

- Repository: `tdoljyj/cross-memory-system`
- Supabase project: `uscrdifznmlvczcekqpw`
- Control schema: `clued_control`
- Existing root set: `ctr_414bd3c724264a83894b0c55cf2ab878`
- Purpose: `SKILL_COEXISTENCE_QUALIFICATION`
- Environment: `ISOLATED_TEST`
- Existing issuer / Owner identity: `tdoljyj`
- Existing audience: `urn:clued:audience:skill-coexistence-qualification:uscrdifznmlvczcekqpw`
- No production authority.
- No paid-model authority.
- No new trust root or second root set.
- No scope expansion.
- No refund, reset, deletion, force-update, or automatic retry.
- No new budget capacity is granted by this approval. Existing charges, existing capacity and existing allocation limits remain unchanged.

## accepted_binding maintenance boundary

Reuse the already established and independently reviewed `NW-01` same-root maintenance mechanism. It may operate only after a new canonical continuation subject, its registration/store acceptances, and verified Owner signature evidence have been produced and independently checked.

For the single existing row in `clued_control.accepted_binding`, only these seven fields may change:

1. `not_before`
2. `expires_at`
3. `owner_approval_commit`
4. `subject_sha256`
5. `registration_acceptance_sha256`
6. `store_acceptance_sha256`
7. `signature_evidence_sha256`

Only the three exact binding CHECK constraints that pin window expiry, Owner approval commit, and subject SHA may be replaced with the new exact values.

`accepted_binding_immutable` may be temporarily disabled only for this table / this row / this exact guarded transaction and must be restored to its original enabled definition in the same transaction. Any mismatch or unknown state aborts and rolls back the whole transaction.

All prior Root, Status, GateAuthorization, GateResult, execution events, receipts, charges, sequence history, constraints, ACLs and unrelated rows must remain unchanged.

## Execution sequencing

This approval does **not** itself authorize immediate execution.

After the verified Owner merge:

1. independently read back the merge and exact proposal blobs;
2. derive the exact 24-hour window timestamps;
3. build a new canonical continuation registration subject and acceptance records;
4. obtain a second verified Owner merge over that exact subject;
5. generate and independently verify signature evidence;
6. prepare the exact fresh NW-01 transaction against the then-current database preimage;
7. independently review the new-window / new-preimage / new-candidate object;
8. only after PASS and all execution prerequisites are READY may `reserve_execution_budget` be called at the last responsible moment.

No preimage or candidate from the expired 2026-09-10/11 window may be reused as execution authority.
