# Durable storage execution entry v0.1

This contract applies to new resource writes after the exact entry migration is
accepted and applied. A source commit or local test does not enable production.

## Normal use

App and MCP requests continue through their existing authorized storage jobs.
The service records the job before permitting a provider effect. Clients receive
no new permission, confirmation step, token or execution field. Account-policy
and legacy cloud jobs retain their separate authorization and recovery contracts.

An independent writer can inspect and legitimately settle its historical work,
but cannot prepare or start another effect outside a durable cloud job. In
particular, an old prepared intent receives no new execution permission. It can
be inspected or cancelled. Existing started/uncertain work keeps its identity,
original Receipt and existing settlement requirements. No migration creates
historical jobs, execution proofs, cancellation claims or successful outcomes.

The old Native daily writer is an independent writer. Its new-write mode is
retired by this database boundary; it must not fall back to another provider
writer. Its inspection/settlement path remains subject to the original rules.
A future daily submitter must use a normal authorized job client. An rcw writer
credential is not a normal Binding and cannot be upgraded by an Agent.

## Private transaction protocol

Only the two existing issuer-authenticated cloud coordinator cores create a
private row, in the original begin branch, from locked canonical job, connection,
profile, root and writer identities. A caller-supplied job ID, request-key prefix,
CloudWriterID, role label or GUC cannot issue this row. No public issue RPC exists.
The private permit table and all five helpers remain owner-only with RLS and an
empty function search path; public caller identities and grants are unchanged.

The same database transaction advances these finite phases:

1. `coordinator`: identity and complete prepare digest bound, no execution.
2. `prepare`: only after the original begin checks, exact internally composed
   journal input bound to the existing writer/authority and canonical Decision.
3. `preparing` → `prepared`: journal entry checks input; relation INSERT guard
   binds the actual new intent, version, row hash and pending Receipt once.
4. `start`: original prepared result and committed Receipt match that row.
5. `starting` → `started`: exact start input, original prepared row, version
   change and new pending Receipt match at the actual relation UPDATE.
6. Original job linkage and final currentness checks complete, then the private
   permit is removed before returning the normal start result.

The journal guard checks both the complete received-payload hash and the existing
M1 operation/payload hash with its normal idempotency-field treatment. It does not
weaken or replace the Receipt contract. Existing conflict, authorization, root,
currentness and provider-attempt guards continue to execute.

No permit survives into another transaction, job or execution attempt. Replay
returns stored job state without issuing a provider capability. Ordinary refusal,
prepare/start failure, linkage failure and final revalidation failure roll back
the original transaction. The coordinator does not create permits for recovery,
provider-attempt recording, reports or historical settlement.

## Validation and limits

Real disposable PostgreSQL tests must exercise genuine account-policy and legacy
job flows, historical upgrade/inspection/cancellation, direct writer and journal
denial, private stage/identity mismatches, role ACLs, atomic failures and replay.
Historical fixtures run their original assertions before actually installing the
new migration and checking the current boundary; they do not skip its upgrade.
The existing authority CI imports the current entry tests through a resource-
center test entry, without introducing another execution route or paid service.

This boundary prevents new untracked effects. It does not prove that an old
external Host has stopped or drained its queue, replace legacy I12 evidence,
activate a paused Drive/Desktop channel, diagnose a historical timeout or settle
unknown work by assertion. Such facts require their own actual evidence.
