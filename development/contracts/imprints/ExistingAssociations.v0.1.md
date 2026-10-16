# Existing imprint associations v0.1 — engineering proposal

Owner Decision fc0df1e0-5f60-4eb7-a14e-b58775d3a1cc@1 authorizes step 3
under Task d5dee826-27d7-452b-8948-48fe8ae8a961. This contract is an
implementation proposal, not a new Owner acceptance or release receipt.

## Purpose and reuse

Find an existing formal Task or Decision for a saved imprint and let the
signed-in owner explicitly associate it for reading, without creating another
Task, copying its body, merging identities, or granting execution authority.
Reuse the qualified imprint read RPCs, exact source namespaces, selection
fences, organization metadata tables, CAS, M1 audit Receipts, and detail reader.
Existing Canonical `relations` and Raw `body.relations` remain source data;
the new owner reading associations are a separate organization property and
must never be interpreted as governance/execution-intent relations.

## Bounded first version

- Both user and Context directories use the same picker. Targets are current,
  active schema-1 Canonical Tasks/Decisions in the source's exact scope. Context
  targets additionally belong to the exact owned Context's project; no Raw
  candidate is presented as an accepted Task/Decision.
- Source Canonical Records must be active/current schema-1; source Raw Records
  must be ACTIVE in the exact owned Context, and may remain candidate/UNKNOWN.
- Candidate lookup uses existing authorized reads, deterministic local textual
  ranking and bounded pagination. Every candidate shows the original title,
  type, snippet and identity. Exact and partial matches are explained. No
  match, partial coverage, interrupted read and ambiguous matches are distinct.
- Matching never writes. The owner selects a candidate, reviews the exact
  source/target, and confirms. Repeated selection of the same target is a no-op;
  a different request key does not create a second association. A settled replay
  returns its original outcome after current owner/access checks; it does not
  reapply a mutation. A distinct-key duplicate add has no metadata/Event change.
- A separate `associations` property on existing organization rows stores
  target identity and the version at confirmation. It has its own CAS/version
  and Receipt, separate from the existing classification version/Receipt.
  Classification upserts retain all association fields; association updates
  retain all existing classification fields/provenance. For the sole first-row
  case (no organization row), existing NOT NULL/CHECK constraints require empty
  domains, classification version 1 and a Receipt: the read DTO's old 0 becomes
  1, association version becomes 1, with no manual-clear or auto provenance.
  A concurrent classification CAS 0 must conflict and refresh, not lose labels.
  No second body, lifecycle or permission store.
- One narrow Native RPC revalidates the signed-in owner, current source and
  target versions, exact scope/project and eligibility under locks,
  then atomically updates association metadata with an audit Event/Receipt.
  It accepts only the exact declared fields. Unknown/foreign targets use a
  non-disclosing unavailable outcome. No Agent OAuth/tool grant is added.
  Lock order is owner authorization guard, exact Context/project guard when
  applicable, idempotency lock, source/target rows, organization row. All
  Canonical source/target IDs lock in ascending UUID order, never caller-role
  order; a Raw source locks before its Canonical target (Raw targets excluded).
  Preserve compatibility with existing M1 and classification writers.
  Canonical targets have project scope, not Context environment identity:
  environment validation belongs to the exact Source Context only.
- Existing read functions are wrapped, not copied: retain their qualification,
  filters/pagination/coverage DTOs and append only authorized owner associations.
  Target access/currentness is rechecked at read and on opening details. An
  invalid/inaccessible existing target contributes only an unavailable count:
  show "some associations unavailable/invalid", no old title/snippet/target ID,
  and do not silently represent the source as having no associations.
- Native association reads use the existing read recovery; mutation uses one
  attempt with stable payload hash/key. A stale account, scope, Context, source,
  candidate or late read cannot initiate a write or publish a success.
- A link is a pointer to the original current object; it is not an immutable
  copy of the target version. Confirmation version is provenance only. Deleted,
  revoked, inaccessible or noncurrent targets are withheld from active picks;
  historical association evidence remains in immutable Receipts.

## Acceptance and exclusions

Verify unique match, ambiguous choice, no match, partial/unavailable lookup,
duplicate confirmation, same-key concurrency/replay, A-to-B/B-to-A concurrent
associations, concurrent classification and atomic rollback, first-row
initialization/classification-CAS-0 race, source/target CAS conflict, cross-user/project/Context
and anonymous refusal, preserved source bodies/versions/lifecycles/domains and
auto provenance, namespace collision, retry hash mismatch, late/account-switch
fences, reload and original-ID detail/updated-target reading in both directories.
Use dedicated synthetic runtime fixtures only and clean them through normal
lifecycle operations. Existing project/Context metadata and permissions stay.

No automatic task/decision creation, extraction, destructive semantic merge,
historical indexing/backfill, external source search, model inference or
cross-Host real-time synchronization. Prior production ledger rows remain with
Task e91a8ebc/PR853's lawful holder; verify actual merge/Receipts without SQL reapply.
