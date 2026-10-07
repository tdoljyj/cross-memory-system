-- CLUED-GOV-MTPE-001 · M0 阶段 P1 · schema migration (UP)
-- 授权: 批准 Event 661 / Receipt f3e59ffb-d7bb-4c92-8137-633c951d1496
-- 迁址: Event 670 / Receipt 7db69dc1-0301-4d28-8492-2400495e9e58
create schema if not exists mtpe_m0;
create schema if not exists mtpe_m0_test;

comment on schema mtpe_m0 is
  'MTPE M0 governance domain. Projection/staging domain, NOT Canonical. Mandatory back-references. Bound to approval Event 661.';
comment on schema mtpe_m0_test is
  'MTPE M0 test domain. Fixtures and test cases only. Zero write privilege on mtpe_m0 (enforced by role grants below).';

do $mtpe$
declare
  s text;
begin
  foreach s in array array['mtpe_m0', 'mtpe_m0_test'] loop

    execute format($f$
      create type %I.item_state as enum (
        'NOT_STARTED','READY','IN_PROGRESS','WAITING','BLOCKED',
        'VERIFYING','DEFERRED','COMPLETED','CANCELLED'
      )$f$, s);

    execute format($f$
      create type %I.relation_type as enum (
        'DEPENDS_ON','BLOCKS','RESOURCE_COMPETES_WITH',
        'UNLOCKS','INFORMS','CONSTRAINS','VALIDATES','SUPERSEDES',
        'CONFLICTS_WITH','USES_RESULT_OF','PRODUCTION_APPLICABLE_TO'
      )$f$, s);

    execute format($f$
      create type %I.verdict_value as enum (
        'CURRENT','SUPERSEDED','HISTORICAL','CANCELLED','UNKNOWN'
      )$f$, s);

    execute format($f$
      create type %I.object_classification as enum (
        'GOVERNANCE_OBJECT','NON_GOVERNANCE'
      )$f$, s);

    execute format($f$
      create type %I.governance_category as enum (
        'FROZEN_BASELINE','EXECUTION_PLAN','APPROVAL_PACKAGE',
        'FORMAL_DECISION_OR_AUTHORIZATION','ACCEPTANCE_OR_REVIEW_REPORT',
        'INVENTORY_OR_REGISTRY_PROJECTION'
      )$f$, s);

    execute format($f$
      create type %I.source_kind as enum (
        'canonical_event','receipt','approval_event','checkpoint',
        'canonical_record','canonical_project','log_entry',
        'drive_file','drive_file_native'
      )$f$, s);

    execute format($f$
      create type %I.authority_value as enum (
        'OWNER_DECISION','AUTHORIZED','USER_EXPLICIT','AGENT_WRITTEN','SYSTEM'
      )$f$, s);

    execute format($f$
      create type %I.currentness_value as enum (
        'VERIFIED_AT_WATERMARK','STALE','UNPROVABLE'
      )$f$, s);

    execute format($f$
      create type %I.drift_status as enum ('OPEN','RESOLVED')$f$, s);

    execute format($f$
      create type %I.snapshot_kind as enum ('ENUMERATION','VERDICT')$f$, s);

    execute format($f$
      create type %I.initiative_kind as enum ('PROGRAM','INITIATIVE')$f$, s);

    execute format($f$
      create table %I.inventory_activation (
        id              uuid primary key default gen_random_uuid(),
        diff_digest     text        not null,
        approval_event  text        not null,
        approval_receipt text       not null,
        activated_at    timestamptz not null default now(),
        note            text,
        constraint inventory_activation_digest_len
          check (length(diff_digest) = 64)
      )$f$, s);

    execute format($f$
      create table %I.workspace (
        id          uuid primary key default gen_random_uuid(),
        key         text not null unique,
        name        text not null,
        note        text,
        created_at  timestamptz not null default now()
      )$f$, s);

    execute format($f$
      create table %I.governance_profile (
        id                            uuid primary key default gen_random_uuid(),
        workspace_id                  uuid not null references %I.workspace(id) on delete restrict,
        key                           text not null,
        name                          text not null,
        batching_window_seconds       integer not null default 300,
        reconciliation_timeout_seconds integer not null default 1800,
        attributes                    jsonb  not null default '{}'::jsonb,
        created_at                    timestamptz not null default now(),
        unique (workspace_id, key),
        constraint governance_profile_window_positive
          check (batching_window_seconds > 0 and reconciliation_timeout_seconds > 0)
      )$f$, s, s);

    execute format($f$
      create table %I.track (
        id                    uuid primary key default gen_random_uuid(),
        governance_profile_id uuid not null references %I.governance_profile(id) on delete restrict,
        key                   text not null,
        name                  text not null,
        purpose               text,
        track_scope           text,
        owner                 text,
        priority_policy       jsonb not null default '{}'::jsonb,
        automation_policy     jsonb not null default '{}'::jsonb,
        success_metrics       jsonb not null default '{}'::jsonb,
        resource_profile      jsonb not null default '{}'::jsonb,
        cross_track_relations jsonb not null default '{}'::jsonb,
        attributes            jsonb not null default '{}'::jsonb,
        created_at            timestamptz not null default now(),
        unique (governance_profile_id, key)
      )$f$, s, s);

    execute format($f$
      create table %I.subtrack (
        id          uuid primary key default gen_random_uuid(),
        track_id    uuid not null references %I.track(id) on delete restrict,
        key         text not null,
        name        text not null,
        attributes  jsonb not null default '{}'::jsonb,
        created_at  timestamptz not null default now(),
        unique (track_id, key)
      )$f$, s, s);

    execute format($f$
      create table %I.program_initiative (
        id          uuid primary key default gen_random_uuid(),
        track_id    uuid not null references %I.track(id) on delete restrict,
        subtrack_id uuid references %I.subtrack(id) on delete restrict,
        kind        %I.initiative_kind not null,
        key         text not null,
        name        text not null,
        attributes  jsonb not null default '{}'::jsonb,
        created_at  timestamptz not null default now(),
        unique (track_id, key)
      )$f$, s, s, s, s);

    execute format($f$
      create table %I.priority_item (
        id                    uuid primary key default gen_random_uuid(),
        program_initiative_id uuid not null references %I.program_initiative(id) on delete restrict,
        key                   text not null,
        title                 text not null,
        state                 %I.item_state not null default 'NOT_STARTED',
        item_type             text not null,
        criticality           text,
        attributes            jsonb not null default '{}'::jsonb,
        created_at            timestamptz not null default now(),
        unique (program_initiative_id, key)
      )$f$, s, s, s);

    execute format($f$
      create table %I.item_relation (
        id            uuid primary key default gen_random_uuid(),
        from_item_id  uuid not null references %I.priority_item(id) on delete cascade,
        to_item_id    uuid not null references %I.priority_item(id) on delete cascade,
        relation_type %I.relation_type not null,
        attributes    jsonb not null default '{}'::jsonb,
        created_at    timestamptz not null default now(),
        unique (from_item_id, to_item_id, relation_type),
        constraint item_relation_no_self_loop check (from_item_id <> to_item_id),
        constraint item_relation_m0_implemented_only
          check (relation_type in ('DEPENDS_ON','BLOCKS','RESOURCE_COMPETES_WITH'))
      )$f$, s, s, s, s);

    execute format($f$
      create table %I.snapshot_meta (
        id                uuid primary key default gen_random_uuid(),
        kind              %I.snapshot_kind not null,
        digest            text not null,
        canonical_version integer not null,
        object_count      integer not null,
        source_counts     jsonb not null,
        query_params      jsonb not null,
        integrity_check   jsonb not null default '{}'::jsonb,
        supersedes_id     uuid references %I.snapshot_meta(id),
        created_at        timestamptz not null default now(),
        constraint snapshot_meta_digest_len check (length(digest) = 64),
        constraint snapshot_meta_counts_nonneg check (object_count >= 0)
      )$f$, s, s, s);

    execute format($f$
      create table %I.verdict_table (
        id                  uuid primary key default gen_random_uuid(),
        snapshot_id         uuid not null references %I.snapshot_meta(id) on delete restrict,
        object_key          text not null,
        object_title        text,
        object_source_kind  %I.source_kind not null,
        object_source_id    text not null,
        classification      %I.object_classification not null,
        governance_category %I.governance_category,
        verdict             %I.verdict_value,
        evidence_ref        text,
        evidence_note       text,
        supersedes_object_key text,
        decided_at          timestamptz not null default now(),
        activation_id       uuid references %I.inventory_activation(id),
        unique (snapshot_id, object_key),
        constraint verdict_classification_consistency check (
          (classification = 'GOVERNANCE_OBJECT'
             and verdict is not null and governance_category is not null)
          or
          (classification = 'NON_GOVERNANCE'
             and verdict is null and governance_category is null)
        ),
        constraint verdict_positive_evidence check (
          verdict is null
          or verdict = 'UNKNOWN'
          or (evidence_ref is not null and length(btrim(evidence_ref)) > 0)
        ),
        constraint verdict_superseded_points_to_successor check (
          verdict is distinct from 'SUPERSEDED'
          or (supersedes_object_key is not null and length(btrim(supersedes_object_key)) > 0)
        )
      )$f$, s, s, s, s, s, s, s);

    execute format($f$
      create table %I.registry_entry (
        id              uuid primary key default gen_random_uuid(),
        verdict_id      uuid not null unique references %I.verdict_table(id) on delete restrict,
        object_key      text not null unique,
        object_title    text,
        governance_category %I.governance_category not null,
        source_kind     %I.source_kind      not null,
        source_id       text                not null,
        source_version  text                not null,
        source_digest   text                not null,
        authority       %I.authority_value  not null,
        currentness     %I.currentness_value not null,
        observed_at     timestamptz         not null,
        activation_id   uuid references %I.inventory_activation(id),
        created_at      timestamptz not null default now(),
        constraint registry_backref_nonempty check (
          length(btrim(source_id)) > 0
          and length(btrim(source_version)) > 0
          and length(btrim(source_digest)) > 0
        ),
        constraint registry_current_implies_verified check (
          currentness = 'VERIFIED_AT_WATERMARK'
        )
      )$f$, s, s, s, s, s, s, s);

    execute format($f$
      create table %I.drift_record (
        id              uuid primary key default gen_random_uuid(),
        kind            text not null,
        status          %I.drift_status not null default 'OPEN',
        detail          jsonb not null default '{}'::jsonb,
        back_reference  text not null,
        resolution_ref  text,
        opened_at       timestamptz not null default now(),
        resolved_at     timestamptz,
        constraint drift_resolved_needs_ref check (
          status = 'OPEN'
          or (resolution_ref is not null and resolved_at is not null)
        )
      )$f$, s, s);

    execute format($f$
      create table %I.rejected_write_audit (
        id           bigserial primary key,
        target_table text not null,
        reason       text not null,
        payload      jsonb not null,
        rejected_at  timestamptz not null default now()
      )$f$, s);

    execute format('create index verdict_table_verdict_idx on %I.verdict_table (verdict)', s);
    execute format('create index verdict_table_classification_idx on %I.verdict_table (classification)', s);
    execute format('create index verdict_table_activation_idx on %I.verdict_table (activation_id)', s);
    execute format('create index registry_entry_activation_idx on %I.registry_entry (activation_id)', s);
    execute format('create index registry_entry_source_idx on %I.registry_entry (source_kind, source_id)', s);
    execute format('create index drift_record_status_idx on %I.drift_record (status)', s);
    execute format('create index item_relation_to_idx on %I.item_relation (to_item_id)', s);

    execute format($f$
      create view %I.v_audit_coverage as
      select sm.id                as snapshot_id,
             sm.digest            as snapshot_digest,
             sm.object_count      as denominator,
             count(vt.id)         as judged,
             count(*) filter (where vt.classification = 'GOVERNANCE_OBJECT') as governance_objects,
             count(*) filter (where vt.classification = 'NON_GOVERNANCE')    as non_governance,
             count(*) filter (where vt.verdict = 'UNKNOWN')                  as residual_unknown,
             count(*) filter (where vt.verdict = 'CURRENT')                  as current_objects
      from %I.snapshot_meta sm
      left join %I.verdict_table vt on vt.snapshot_id = sm.id
      where sm.kind = 'ENUMERATION'
      group by sm.id, sm.digest, sm.object_count
      $f$, s, s, s);

    execute format($f$
      create view %I.v_audit_verdict_correspondence as
      select sm.id as snapshot_id,
             sm.object_count                      as denominator,
             count(distinct vt.object_key)        as distinct_objects,
             count(vt.id)                         as rows_total,
             (count(vt.id) = count(distinct vt.object_key)) as no_duplicates,
             (count(distinct vt.object_key) = sm.object_count) as one_to_one
      from %I.snapshot_meta sm
      left join %I.verdict_table vt on vt.snapshot_id = sm.id
      where sm.kind = 'ENUMERATION'
      group by sm.id, sm.object_count
      $f$, s, s, s);

    execute format($f$
      create view %I.v_audit_registry_backref as
      select count(*) as total,
             count(*) filter (
               where source_id is not null and source_version is not null
                 and source_digest is not null and observed_at is not null
             ) as complete_backref,
             count(*) filter (where currentness = 'VERIFIED_AT_WATERMARK') as verified_at_watermark
      from %I.registry_entry
      $f$, s, s);

    execute format($f$
      create view %I.v_audit_staging_state as
      select 'verdict_table'::text as tbl,
             count(*) as rows_total,
             count(*) filter (where activation_id is null) as staged,
             count(*) filter (where activation_id is not null) as activated
      from %I.verdict_table
      union all
      select 'registry_entry'::text,
             count(*),
             count(*) filter (where activation_id is null),
             count(*) filter (where activation_id is not null)
      from %I.registry_entry
      $f$, s, s, s);

    execute format($f$
      create view %I.v_audit_structure as
      select
        (select count(*) from information_schema.tables
          where table_schema = %L
            and table_name in ('workspace','governance_profile','track',
                               'subtrack','program_initiative','priority_item')) as layer_tables,
        (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid
          join pg_namespace n on n.oid = t.typnamespace
          where n.nspname = %L and t.typname = 'item_state') as item_states,
        (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid
          join pg_namespace n on n.oid = t.typnamespace
          where n.nspname = %L and t.typname = 'relation_type') as relation_types,
        3 as relation_types_implemented,
        8 as relation_types_reserved
      $f$, s, s, s, s);

    execute format($f$
      create view %I.v_audit_open_drift as
      select id, kind, back_reference, opened_at
      from %I.drift_record where status = 'OPEN'
      $f$, s, s);

  end loop;
end
$mtpe$;

do $perm$
begin
  if not exists (select 1 from pg_roles where rolname = 'mtpe_m0_test_role') then
    create role mtpe_m0_test_role nologin;
  end if;
end
$perm$;

grant usage on schema mtpe_m0_test to mtpe_m0_test_role;
grant select, insert, update, delete on all tables in schema mtpe_m0_test to mtpe_m0_test_role;
grant usage, select on all sequences in schema mtpe_m0_test to mtpe_m0_test_role;
alter default privileges in schema mtpe_m0_test
  grant select, insert, update, delete on tables to mtpe_m0_test_role;

grant usage on schema mtpe_m0 to mtpe_m0_test_role;
grant select on all tables in schema mtpe_m0 to mtpe_m0_test_role;
revoke insert, update, delete, truncate, references, trigger
  on all tables in schema mtpe_m0 from mtpe_m0_test_role;
revoke create on schema mtpe_m0 from mtpe_m0_test_role;
alter default privileges in schema mtpe_m0
  revoke insert, update, delete, truncate on tables from mtpe_m0_test_role;

revoke all on schema mtpe_m0 from public;
revoke all on all tables in schema mtpe_m0 from public;

revoke all on schema mtpe_m0, mtpe_m0_test from anon, authenticated;
revoke all on all tables in schema mtpe_m0 from anon, authenticated;
revoke all on all tables in schema mtpe_m0_test from anon, authenticated;