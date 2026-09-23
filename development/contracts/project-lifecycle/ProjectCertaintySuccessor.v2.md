# Project Certainty Successor v2

Status: IMPLEMENTATION CANDIDATE / NOT DEPLOYED / NO PRODUCTION AUTHORITY

## Purpose

Project schema v2 retires `unconfirmed | confirmed` as an active product taxonomy and as a gate for whether a Canonical Project can own current work.

A Project is a Project once it is created by an authorized Clued workflow. Recognition confidence may be retained as backend metadata, but it never grants or denies Project eligibility.

## Contract

1. New Project mutations use `project_schema_version: 2`.
2. `certainty_status` is not accepted in v2 mutation input and is not exposed as a public list filter.
3. `recognition_confidence`, when supplied, is optional metadata in the inclusive range `0..1`; it is not an authorization, Currentness, lifecycle or five-view admission signal.
4. An effective Project may own Canonical State/Task/Decision records when it exists for the owner, is not dismissed, is not merged away, and its lifecycle is active. Legacy `certainty_status` MUST NOT participate in that check.
5. Existing IDs, versions, Event/Receipt history and legacy certainty values are preserved. This successor does not bulk-rewrite historical rows merely to erase the old field.
6. The existing database `certainty_status` column remains temporarily as compatibility storage. New v2 creates store the compatibility value `confirmed` so old readers do not fail, but that stored value has no v2 product semantics.
7. Exact idempotent replays of already committed v1 requests continue to return their original Receipt/result because replay resolution precedes v2 shape validation.
8. The UI presents one Project collection organized by work progress. It does not ask the user to promote or confirm a Project.
9. Historical v1 migrations, receipts and evidence retain their original meaning. They are not rewritten to claim v2 semantics.
10. Deployment, production data migration, cleanup/removal of the legacy column, Project merge/split/delete behavior and broader product taxonomy changes are separate work.

## Compatibility / removal path

The legacy column may be physically removed only after all of the following have versioned successors:

- database functions and views;
- REST/MCP schemas and tool baselines;
- account UI;
- Bundle/Snapshot schemas;
- current tests and external consumers;
- production migration/readback evidence.

Until then it is a compatibility field, not current product truth.
