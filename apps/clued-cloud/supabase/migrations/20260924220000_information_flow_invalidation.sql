-- Information Flow M0-D slice S5: knowledge lineage, Evidence withdrawal,
-- record_evidence_status and proactive invalidation fan-out.
-- Contract: development/contracts/information-flow/M0DCloseout.v0.1.md (frozen,
-- Decision 825aa822-7cb2-4239-a3a1-0989200ef068), sections 4.1, 4.3.3, 5.1,
-- 6.3, 6.4, 7 (E2E-03, 04, 05, 14) and 8 (M0D-B01, M0D-B05).
--
-- record_mutation_core, record_mutation_with_terminal_guard,
-- evidence_ingest_core and the M1 receipt core are reused, never forked.
-- No Canonical Record and no public.clued_evidence row is ever modified or
-- deleted here: withdrawal state lives in clued_private.evidence_withdrawals,
-- per-version flags in clued_private.record_evidence_status and lineage
-- edges in clued_private.knowledge_lineage. Every trigger below writes only
-- lineage flags or manifest stale flags. The withdrawal is a Native two-step
-- confirmation (receipt-core family evidence_withdraw, row-version CAS on the
-- withdrawal row) reusing the S4 native_confirmation_tokens table with
-- action='evidence_withdraw'. No MCP tool, OAuth case or Binding reaches it.
--
-- Lock order (deadlock analysis):
-- * Every writer of clued_memories through M1, of knowledge_lineage, of
--   record_evidence_status and of evidence_withdrawals holds the exclusive
--   currentness lock (currentness_user_lock) before it locks manifest rows.
--   Compiles and Native revalidation hold that key in shared mode, so these
--   writers never overlap a compile. Writers lock manifests in id order.
-- * Knowledge proposals take the per-user withdrawal lock in shared mode and
--   never the currentness lock; the withdrawal takes currentness, then the
--   withdrawal lock in exclusive mode. Proposals hold nothing a withdrawal
--   waits for.
-- * Binding reduction (clued_authorization_manage_v12) holds the Binding row
--   FOR UPDATE; S4 revalidation locks manifest -> Binding FOR SHARE. The
--   Binding/authorization triggers therefore never wait on a manifest row:
--   they lock with SKIP LOCKED and never take the currentness lock. A row
--   skipped this way is held by a revalidation (which re-reads the reduced
--   scopes and marks the manifest inputs_changed) or by an exclusive
--   currentness writer (which marks it itself); a holder that rolls back
--   leaves the row live, and revalidation still returns STALE (disclosed).
-- * Maintenance DML hazard (A03): the S5 triggers on public.clued_memories
--   take currentness_user_lock inside the row write, including for
--   note/profile_fact rows whose writers otherwise never take it. Any
--   maintenance DML on public.clued_memories outside the M1 wrapper (for
--   example a service_role or admin direct UPDATE/DELETE) must first call
--   clued_private.currentness_user_lock(<user_id>) for every affected user;
--   otherwise it can lock a Record row and then wait on the currentness lock
--   while an M1 writer holds currentness and waits on that row (deadlock).
-- Additive only: no column of an existing table is altered.

-- ---------------------------------------------------------------------------
-- 1. Tables and indexes
-- ---------------------------------------------------------------------------

-- Terminal in MVP-0: one row per withdrawn Evidence. version exists so the
-- CAS is uniform (base 0 = no row yet; the insert creates version 1).
create table clued_private.evidence_withdrawals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  evidence_id uuid not null,
  status text not null default 'withdrawn' check (status='withdrawn'),
  version integer not null default 1 check (version>=1),
  reason text not null check (char_length(reason) between 1 and 1000),
  -- Snapshot for audit; the Evidence row itself is never modified.
  evidence_content_hash text not null check (evidence_content_hash ~ '^[0-9a-f]{64}$'),
  withdrawn_receipt_id uuid not null unique references public.clued_audit_receipts(id),
  token_id uuid not null unique references clued_private.native_confirmation_tokens(id),
  withdrawn_session_id text,
  withdrawn_at timestamptz not null default now(),
  -- Counts and sha256 digests of the sorted dependent lists (no id lists).
  fanout jsonb not null check (jsonb_typeof(fanout)='object'),
  foreign key (user_id,evidence_id) references public.clued_evidence(user_id,id) on delete cascade,
  unique (user_id,evidence_id)
);

-- One row per (Record version, withdrawn Evidence). No FK to clued_memories:
-- the table is additive and never touches the Record.
create table clued_private.record_evidence_status (
  user_id uuid not null references auth.users(id) on delete cascade,
  record_id uuid not null,
  record_version bigint not null check (record_version>=1),
  evidence_id uuid not null,
  status text not null default 'evidence_withdrawn' check (status='evidence_withdrawn'),
  withdrawal_id uuid not null references clued_private.evidence_withdrawals(id) on delete cascade,
  flagged_by text not null check (flagged_by in ('withdrawal','record_write')),
  -- The evidence_withdraw Receipt, or the Receipt that wrote the version.
  flagged_receipt_id uuid references public.clued_audit_receipts(id),
  flagged_at timestamptz not null default now(),
  primary key (record_id,record_version,evidence_id)
);
create index record_evidence_status_record_idx
  on clued_private.record_evidence_status(user_id,record_id,record_version);

-- Lineage edges of promoted Authority Knowledge, seeded only from
-- candidate_promotions. lineage_stale never reverts; only a new promotion
-- produces a new, clean lineage.
create table clued_private.knowledge_lineage (
  user_id uuid not null references auth.users(id) on delete cascade,
  knowledge_record_id uuid not null,
  knowledge_version bigint not null check (knowledge_version>=1),
  source_record_id uuid not null,
  source_version bigint not null check (source_version>=1),
  rule_id text not null check (rule_id in ('knowledge.consolidate.v1','knowledge.dedup.v1','knowledge.cross_record_fact.v1')),
  evidence_ids uuid[] not null default '{}',
  candidate_id uuid not null,
  promotion_record_receipt_id uuid not null references clued_private.candidate_promotions(receipt_id),
  seeded_by text not null check (seeded_by in ('promotion','backfill')),
  lineage_stale boolean not null default false,
  stale_reason text check (stale_reason is null or stale_reason in ('source_updated','source_closed',
    'source_superseded','source_deleted','source_evidence_withdrawn','evidence_withdrawn','backfill_source_changed')),
  stale_at timestamptz,
  stale_receipt_id uuid references public.clued_audit_receipts(id),
  version integer not null default 1 check (version>=1),
  created_at timestamptz not null default now(),
  primary key (knowledge_record_id,knowledge_version,source_record_id),
  check (lineage_stale=(stale_reason is not null and stale_at is not null))
);
create index knowledge_lineage_source_idx
  on clued_private.knowledge_lineage(user_id,source_record_id,source_version) where not lineage_stale;

-- Keeps the Binding trigger's early exit a partial-index probe.
create index context_pack_manifests_binding_live_idx
  on clued_private.context_pack_manifests(binding_id) where not stale;

alter table clued_private.evidence_withdrawals enable row level security;
alter table clued_private.record_evidence_status enable row level security;
alter table clued_private.knowledge_lineage enable row level security;
revoke all on table clued_private.evidence_withdrawals,
  clued_private.record_evidence_status, clued_private.knowledge_lineage
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Guard triggers
-- ---------------------------------------------------------------------------

-- Withdrawal and flag rows are immutable. Delete is not blocked so the
-- auth.users cascade still works; no role holds a grant that could delete.
create function clued_private.invalidation_row_immutable_v1()
returns trigger language plpgsql set search_path='' as $$
begin
  raise exception 'invalidation_row_immutable' using errcode='55000';
end $$;
create trigger evidence_withdrawals_immutable before update
  on clued_private.evidence_withdrawals for each row
  execute function clued_private.invalidation_row_immutable_v1();
create trigger record_evidence_status_immutable before update
  on clued_private.record_evidence_status for each row
  execute function clued_private.invalidation_row_immutable_v1();

-- The only permitted update is live -> stale with a reason, a timestamp and
-- a version bump; every other column is fixed.
create function clued_private.knowledge_lineage_guard_v1()
returns trigger language plpgsql set search_path='' as $$
declare v_mutable text[]:=array['lineage_stale','stale_reason','stale_at','stale_receipt_id','version'];
begin
  if not old.lineage_stale and new.lineage_stale
    and new.stale_reason is not null and new.stale_at is not null
    and new.version=old.version+1
    and (to_jsonb(new)-v_mutable) is not distinct from (to_jsonb(old)-v_mutable) then
    return new;
  end if;
  raise exception 'knowledge_lineage_immutable' using errcode='55000';
end $$;
create trigger knowledge_lineage_guard before update
  on clued_private.knowledge_lineage for each row
  execute function clued_private.knowledge_lineage_guard_v1();

-- ---------------------------------------------------------------------------
-- 3. Helpers
-- ---------------------------------------------------------------------------

-- Replaces the S2 stub (contract 5.1, 6.4). The exact version is flagged when
-- a record_evidence_status row exists or its source_refs cite withdrawn
-- Evidence (defence in depth for a version written after the withdrawal).
-- CREATE OR REPLACE keeps the signature and the revoked ACL. No row locks.
create or replace function clued_private.record_evidence_unflagged_v1(p_user_id uuid,p_record_id uuid,p_version bigint)
returns boolean language sql stable security definer set search_path='' as $$
  select not exists(select 1 from clued_private.record_evidence_status s
      where s.user_id=p_user_id and s.record_id=p_record_id and s.record_version=p_version)
    and not exists(select 1 from public.clued_memories m
      join clued_private.evidence_withdrawals w on w.user_id=p_user_id and w.evidence_id=any(m.source_refs)
      where m.user_id=p_user_id and m.id=p_record_id and m.version=p_version)
$$;

-- Authority Knowledge for compiles (Owner decision, option A): at least one
-- lineage row for the exact version and none of them stale. Missing rows mean
-- false (fail closed). Non-locking; used on the compile path.
create function clued_private.knowledge_lineage_current_v1(p_user_id uuid,p_record_id uuid,p_version bigint)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from clued_private.knowledge_lineage l
      where l.user_id=p_user_id and l.knowledge_record_id=p_record_id and l.knowledge_version=p_version)
    and not exists(select 1 from clued_private.knowledge_lineage l
      where l.user_id=p_user_id and l.knowledge_record_id=p_record_id and l.knowledge_version=p_version
        and l.lineage_stale)
$$;

-- Per-user withdrawal lock: exclusive for withdrawal issue/consume, shared
-- for knowledge proposals (closes the propose-after-scan race).
create function clued_private.evidence_withdrawal_lock_v1(p_user_id uuid,p_shared boolean)
returns void language plpgsql volatile security definer set search_path='' as $$
begin
  if p_shared then
    perform pg_catalog.pg_advisory_xact_lock_shared(
      pg_catalog.hashtextextended('clued-evidence-withdrawal:'||p_user_id::text,0));
  else
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('clued-evidence-withdrawal:'||p_user_id::text,0));
  end if;
end $$;

-- Marks the given live manifests stale in id order. With p_skip_locked a row
-- another transaction holds is skipped instead of waited for (Binding path).
-- The first stale reason is final (S4 guard).
create function clued_private.pack_manifest_mark_stale_v1(p_ids uuid[],p_reason text,p_skip_locked boolean)
returns integer language plpgsql volatile security definer set search_path='' as $$
declare v_locked uuid[]; v_n integer;
begin
  if p_ids is null or cardinality(p_ids)=0 then return 0; end if;
  if p_skip_locked then
    select array_agg(s.id) into v_locked from (select m.id from clued_private.context_pack_manifests m
      where m.id=any(p_ids) and not m.stale order by m.id for update skip locked) s;
  else
    select array_agg(s.id) into v_locked from (select m.id from clued_private.context_pack_manifests m
      where m.id=any(p_ids) and not m.stale order by m.id for update) s;
  end if;
  if v_locked is null then return 0; end if;
  update clued_private.context_pack_manifests set stale=true,stale_reason=p_reason,
      stale_at=clock_timestamp(),version=version+1
    where id=any(v_locked) and not stale;
  get diagnostics v_n=row_count;
  return v_n;
end $$;

-- Every live manifest of the user whose sources list one of p_ids (Record or
-- candidate ids as text). The collection takes no lock (GIN probe).
create function clued_private.pack_manifest_stale_v1(p_user_id uuid,p_ids text[],p_reason text,p_skip_locked boolean)
returns integer language plpgsql volatile security definer set search_path='' as $$
declare v_ids uuid[];
begin
  if p_ids is null or cardinality(p_ids)=0 then return 0; end if;
  select array_agg(distinct m.id) into v_ids
    from unnest(p_ids) x(id)
    join clued_private.context_pack_manifests m
      on m.sources @> jsonb_build_array(jsonb_build_object('id',x.id))
    where m.user_id=p_user_id and not m.stale;
  return clued_private.pack_manifest_mark_stale_v1(v_ids,p_reason,p_skip_locked);
end $$;

-- Stale every live manifest of one Binding whose authorization no longer
-- covers it. Never takes the currentness lock; SKIP LOCKED only.
create function clued_private.pack_manifest_binding_stale_v1(p_binding_id uuid,p_deleted boolean)
returns integer language plpgsql volatile security definer set search_path='' as $$
declare v_b public.clued_agent_bindings%rowtype; v_scopes text[]; v_reason text; v_ids uuid[];
begin
  if p_binding_id is null or not exists(select 1 from clued_private.context_pack_manifests m
      where m.binding_id=p_binding_id and not m.stale) then
    return 0;
  end if;
  if p_deleted then
    v_reason:='binding_deleted';
  else
    select * into v_b from public.clued_agent_bindings b where b.id=p_binding_id;
    if not found or v_b.revoked_at is not null or not ('context:read'=any(v_b.scopes))
      or exists(select 1 from clued_private.authorizations_v12 a
        where a.binding_id=p_binding_id and a.revoked_at is not null) then
      v_reason:='binding_revoked';
    else
      begin
        v_scopes:=clued_private.binding_read_scopes_v2(v_b.user_id,p_binding_id);
      exception when others then
        v_reason:='binding_revoked';
      end;
      if v_reason is null then
        -- NULL means unrestricted: nothing was reduced.
        if v_scopes is null then return 0; end if;
        select array_agg(m.id order by m.id) into v_ids from clued_private.context_pack_manifests m
          where m.binding_id=p_binding_id and not m.stale and not (m.effective_scopes <@ v_scopes);
        return clued_private.pack_manifest_mark_stale_v1(v_ids,'binding_scope_reduced',true);
      end if;
    end if;
  end if;
  select array_agg(m.id order by m.id) into v_ids from clued_private.context_pack_manifests m
    where m.binding_id=p_binding_id and not m.stale;
  return clued_private.pack_manifest_mark_stale_v1(v_ids,v_reason,true);
end $$;

-- ---------------------------------------------------------------------------
-- 4. Invalidation triggers (write only lineage flags or manifest stale flags)
-- ---------------------------------------------------------------------------

-- Seeding on promotion (closes the S3 residual). Runs in the promotion
-- transaction after the Record write; S3 knowledge_lineage_ok_v1 holds the
-- sources FOR SHARE, and any drift fails the promotion as a whole.
create function clued_private.knowledge_lineage_seed_v1()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_k clued_private.knowledge_candidates%rowtype; v_src jsonb; v_version bigint;
begin
  select * into v_k from clued_private.knowledge_candidates k where k.id=new.candidate_id and k.user_id=new.user_id;
  if not found or jsonb_typeof(v_k.sources) is distinct from 'array' or jsonb_array_length(v_k.sources)=0 then
    raise exception 'knowledge_lineage_seed_mismatch' using errcode='XX000';
  end if;
  for v_src in select x from jsonb_array_elements(v_k.sources) x loop
    if jsonb_typeof(v_src) is distinct from 'object' or jsonb_typeof(v_src->'id') is distinct from 'string'
      or (v_src->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or jsonb_typeof(v_src->'version') not in ('number','string')
      or (v_src->>'version') !~ '^[1-9][0-9]{0,17}$' then
      raise exception 'knowledge_lineage_seed_mismatch' using errcode='XX000';
    end if;
    select m.version into v_version from public.clued_memories m
      where m.user_id=new.user_id and m.id=(v_src->>'id')::uuid;
    if v_version is distinct from (v_src->>'version')::bigint then
      raise exception 'knowledge_lineage_seed_mismatch' using errcode='XX000';
    end if;
    insert into clued_private.knowledge_lineage(user_id,knowledge_record_id,knowledge_version,source_record_id,
      source_version,rule_id,evidence_ids,candidate_id,promotion_record_receipt_id,seeded_by)
    values(new.user_id,new.record_id,new.record_version,(v_src->>'id')::uuid,(v_src->>'version')::bigint,
      v_k.rule_id,v_k.evidence_ids,v_k.id,new.receipt_id,'promotion');
  end loop;
  return null;
end $$;
create trigger information_flow_lineage_seed after insert
  on clued_private.candidate_promotions for each row
  when (new.candidate_tier='knowledge')
  execute function clued_private.knowledge_lineage_seed_v1();

-- A source Record update, close, supersede or delete: manifests that list
-- the Record go stale first (so the direct reason wins), then live lineage
-- rows over it are flagged (which stales manifests listing the knowledge).
-- It never writes clued_memories: the knowledge Record is untouched.
create function clued_private.record_source_change_v1()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_manifests boolean; v_lineage boolean; v_reason text;
begin
  v_manifests:=exists(select 1 from clued_private.context_pack_manifests m
    where m.sources @> jsonb_build_array(jsonb_build_object('id',old.id::text))
      and m.user_id=old.user_id and not m.stale);
  v_lineage:=exists(select 1 from clued_private.knowledge_lineage l
    where l.user_id=old.user_id and l.source_record_id=old.id and not l.lineage_stale);
  if not v_manifests and not v_lineage then return null; end if;
  if tg_op='DELETE' then
    v_reason:='source_deleted';
  elsif new.lifecycle_status='superseded' then
    v_reason:='source_superseded';
  elsif (old.lifecycle_status='active' and new.lifecycle_status is distinct from 'active')
    or (old.archived_at is null and new.archived_at is not null)
    or (old.merged_into_record_id is null and new.merged_into_record_id is not null) then
    v_reason:='source_closed';
  else
    v_reason:='source_updated';
  end if;
  -- Re-entrant: every M1 Record writer already holds it. Order: currentness
  -- -> manifests (id order) -> lineage.
  perform clued_private.currentness_user_lock(old.user_id);
  if v_manifests then
    perform clued_private.pack_manifest_stale_v1(old.user_id,array[old.id::text],v_reason,false);
  end if;
  if v_lineage then
    update clued_private.knowledge_lineage set lineage_stale=true,stale_reason=v_reason,
        stale_at=clock_timestamp(),version=version+1
      where user_id=old.user_id and source_record_id=old.id and not lineage_stale;
  end if;
  return null;
end $$;
create trigger information_flow_source_change after update
  on public.clued_memories for each row
  when (old.version is distinct from new.version
    or old.lifecycle_status is distinct from new.lifecycle_status
    or old.archived_at is distinct from new.archived_at
    or old.merged_into_record_id is distinct from new.merged_into_record_id
    or old.title is distinct from new.title
    or old.content is distinct from new.content
    or old.closure_summary is distinct from new.closure_summary
    or old.type_fields is distinct from new.type_fields
    or old.source_refs is distinct from new.source_refs
    or old.canonical_scope is distinct from new.canonical_scope
    or old.project_id is distinct from new.project_id
    or old.record_type is distinct from new.record_type)
  execute function clued_private.record_source_change_v1();
create trigger information_flow_source_delete after delete
  on public.clued_memories for each row
  execute function clued_private.record_source_change_v1();

-- A flagged Record version flags lineage in both directions: as a source
-- (source_evidence_withdrawn) and as the knowledge Record itself
-- (evidence_withdrawn, its own cited Evidence).
create function clued_private.knowledge_lineage_evidence_flag_v1()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  update clued_private.knowledge_lineage set lineage_stale=true,stale_reason='source_evidence_withdrawn',
      stale_at=clock_timestamp(),stale_receipt_id=new.flagged_receipt_id,version=version+1
    where user_id=new.user_id and source_record_id=new.record_id and source_version=new.record_version
      and not lineage_stale;
  update clued_private.knowledge_lineage set lineage_stale=true,stale_reason='evidence_withdrawn',
      stale_at=clock_timestamp(),stale_receipt_id=new.flagged_receipt_id,version=version+1
    where user_id=new.user_id and knowledge_record_id=new.record_id and knowledge_version=new.record_version
      and not lineage_stale;
  return null;
end $$;
create trigger information_flow_lineage_evidence_flag after insert
  on clued_private.record_evidence_status for each row
  execute function clued_private.knowledge_lineage_evidence_flag_v1();

-- Lineage stale -> every live manifest listing the knowledge Record.
create function clued_private.knowledge_lineage_manifest_stale_v1()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform clued_private.pack_manifest_stale_v1(new.user_id,array[new.knowledge_record_id::text],'lineage_stale',false);
  return null;
end $$;
create trigger information_flow_lineage_manifest_stale after update
  on clued_private.knowledge_lineage for each row
  when (not old.lineage_stale and new.lineage_stale)
  execute function clued_private.knowledge_lineage_manifest_stale_v1();

-- A Record version written after a withdrawal that still cites the
-- withdrawn Evidence is flagged at write time (any writer; M1 is unchanged).
create function clued_private.record_evidence_status_on_write_v1()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from clued_private.evidence_withdrawals w
      where w.user_id=new.user_id and w.evidence_id=any(new.source_refs)) then
    return null;
  end if;
  perform clued_private.currentness_user_lock(new.user_id);
  insert into clued_private.record_evidence_status(user_id,record_id,record_version,evidence_id,withdrawal_id,
    flagged_by,flagged_receipt_id)
  select new.user_id,new.id,new.version,w.evidence_id,w.id,'record_write',
    case when exists(select 1 from public.clued_audit_receipts r where r.id=new.receipt_id) then new.receipt_id end
  from clued_private.evidence_withdrawals w
  where w.user_id=new.user_id and w.evidence_id=any(new.source_refs)
  on conflict do nothing;
  return null;
end $$;
create trigger information_flow_record_evidence_on_insert after insert
  on public.clued_memories for each row
  when (cardinality(coalesce(new.source_refs,'{}'::uuid[]))>0)
  execute function clued_private.record_evidence_status_on_write_v1();
create trigger information_flow_record_evidence_on_update after update
  on public.clued_memories for each row
  when ((old.version is distinct from new.version or old.source_refs is distinct from new.source_refs)
    and cardinality(coalesce(new.source_refs,'{}'::uuid[]))>0)
  execute function clued_private.record_evidence_status_on_write_v1();

-- Binding scope reduction, revoke or delete (contract 6.4). Every reduce and
-- revoke through clued_authorization_manage_v12 bumps authorizations_v12;
-- raw Bindings are covered by the clued_agent_bindings triggers.
create function clued_private.pack_manifest_binding_change_v1()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' then
    perform clued_private.pack_manifest_binding_stale_v1(old.id,true);
  else
    perform clued_private.pack_manifest_binding_stale_v1(new.id,false);
  end if;
  return null;
end $$;
create function clued_private.pack_manifest_authorization_change_v1()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform clued_private.pack_manifest_binding_stale_v1(new.binding_id,false);
  return null;
end $$;
create trigger information_flow_manifest_binding_change after update
  on public.clued_agent_bindings for each row
  when (old.scopes is distinct from new.scopes or old.context_keys is distinct from new.context_keys
    or old.revoked_at is distinct from new.revoked_at)
  execute function clued_private.pack_manifest_binding_change_v1();
create trigger information_flow_manifest_binding_delete after delete
  on public.clued_agent_bindings for each row
  execute function clued_private.pack_manifest_binding_change_v1();
create trigger information_flow_manifest_authorization_change after update
  on clued_private.authorizations_v12 for each row
  when (old.version is distinct from new.version or old.revoked_at is distinct from new.revoked_at)
  execute function clued_private.pack_manifest_authorization_change_v1();

-- ---------------------------------------------------------------------------
-- 5. Backfill: lineage for knowledge promoted before S5. Derived from the
-- immutable promotion markers (not a Native-marker backfill; contract 6.3).
-- A source that drifted before S5 is flagged backfill_source_changed.
-- ---------------------------------------------------------------------------
with src as materialized (
  select p.user_id,p.record_id,p.record_version,p.receipt_id,k.id candidate_id,k.rule_id,k.evidence_ids,
    case when jsonb_typeof(s)='object' and jsonb_typeof(s->'id')='string'
        and (s->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then (s->>'id')::uuid end source_id,
    case when jsonb_typeof(s->'version') in ('number','string') and (s->>'version') ~ '^[1-9][0-9]{0,17}$'
      then (s->>'version')::bigint end source_version
  from clued_private.candidate_promotions p
  join clued_private.knowledge_candidates k on k.id=p.candidate_id and k.user_id=p.user_id
  cross join lateral jsonb_array_elements(case when jsonb_typeof(k.sources)='array' then k.sources
    else '[]'::jsonb end) s
  where p.candidate_tier='knowledge'
)
insert into clued_private.knowledge_lineage(user_id,knowledge_record_id,knowledge_version,source_record_id,
  source_version,rule_id,evidence_ids,candidate_id,promotion_record_receipt_id,seeded_by,
  lineage_stale,stale_reason,stale_at)
select s.user_id,s.record_id,s.record_version,s.source_id,s.source_version,s.rule_id,s.evidence_ids,
  s.candidate_id,s.receipt_id,'backfill',d.drifted,
  case when d.drifted then 'backfill_source_changed' end,case when d.drifted then now() end
from src s
cross join lateral (select not exists(select 1 from public.clued_memories m
  where m.user_id=s.user_id and m.id=s.source_id and m.version=s.source_version) drifted) d
where s.source_id is not null and s.source_version is not null
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 6. Anchor patches of S2/S3/S4 functions. Each anchor must occur exactly
-- once; drift stops the migration. CREATE OR REPLACE keeps the grants.
-- ---------------------------------------------------------------------------
do $migration$
declare body text;
  -- S2 knowledge_propose_core_v1.
  propose_loop text:=$a$    for v_x in select value from jsonb_array_elements(v_evidence) loop$a$;
  propose_lock text:=$a$    -- S5: serialize with Evidence withdrawal (shared; the withdrawal is exclusive).
    perform clued_private.evidence_withdrawal_lock_v1(p_user_id,true);
$a$;
  propose_ev text:=$a$        raise exception 'knowledge_evidence_not_found' using errcode='P0002';
      end if;$a$;
  propose_ev_new text:=$a$        raise exception 'knowledge_evidence_not_found' using errcode='P0002';
      end if;
      if exists(select 1 from clued_private.evidence_withdrawals w
          where w.user_id=p_user_id and w.evidence_id=(v_x#>>'{}')::uuid) then
        raise exception 'knowledge_evidence_withdrawn' using errcode='55000';
      end if;$a$;
  propose_hc text:=$a$      if clued_private.record_human_confirmed_v1(p_user_id,v_rec.id,v_rec.version) is not true then$a$;
  propose_shape text:=$a$      -- S5 (contract 4.1, 5.1): sources must be Authority Information.
      if v_rec.record_type='note' and v_rec.type_fields->>'note_kind'='knowledge' and v_rec.type_fields ? 'knowledge' then
        raise exception 'knowledge_source_not_information' using errcode='22023';
      end if;
$a$;
  -- S3 knowledge_lineage_ok_v1 and S4 context_knowledge_lineage_v1.
  lineage_hc text:=$a$    if clued_private.record_human_confirmed_v1(p_user_id,v_rec.id,v_rec.version) is not true then$a$;
  lineage_shape text:=$a$    -- S5 (contract 4.1, 5.1): sources must be Authority Information.
    if v_rec.record_type='note' and v_rec.type_fields->>'note_kind'='knowledge' and v_rec.type_fields ? 'knowledge' then
      return 'knowledge_source_not_information';
    end if;
$a$;
  -- S4 context_pack_compile_v1.
  compile_anchor text:=$a$            then clued_private.context_knowledge_lineage_v1(p_user_id,m.type_fields->'knowledge'->'sources') is null$a$;
  compile_new text:=$a$            then clued_private.knowledge_lineage_current_v1(p_user_id,m.id,m.version)
              and clued_private.context_knowledge_lineage_v1(p_user_id,m.type_fields->'knowledge'->'sources') is null$a$;
  n integer;
begin
  body:=pg_get_functiondef('clued_private.knowledge_propose_core_v1(uuid,uuid,jsonb,text)'::regprocedure);
  if (length(body)-length(replace(body,propose_loop,'')))/length(propose_loop)<>1
    or (length(body)-length(replace(body,propose_ev,'')))/length(propose_ev)<>1
    or (length(body)-length(replace(body,propose_hc,'')))/length(propose_hc)<>1
    or strpos(body,'evidence_withdrawal_lock_v1')>0 or strpos(body,'knowledge_source_not_information')>0 then
    raise exception 'knowledge_propose_core_definition_mismatch';
  end if;
  execute replace(replace(replace(body,propose_loop,propose_lock||propose_loop),propose_ev,propose_ev_new),
    propose_hc,propose_shape||propose_hc);

  body:=pg_get_functiondef('clued_private.knowledge_lineage_ok_v1(uuid,jsonb)'::regprocedure);
  if (length(body)-length(replace(body,lineage_hc,'')))/length(lineage_hc)<>1
    or strpos(body,'knowledge_source_not_information')>0 then
    raise exception 'knowledge_lineage_ok_definition_mismatch';
  end if;
  execute replace(body,lineage_hc,lineage_shape||lineage_hc);

  body:=pg_get_functiondef('clued_private.context_knowledge_lineage_v1(uuid,jsonb)'::regprocedure);
  if (length(body)-length(replace(body,lineage_hc,'')))/length(lineage_hc)<>1
    or strpos(body,'knowledge_source_not_information')>0 then
    raise exception 'context_knowledge_lineage_definition_mismatch';
  end if;
  execute replace(body,lineage_hc,lineage_shape||lineage_hc);

  body:=pg_get_functiondef('clued_private.context_pack_compile_v1(uuid,uuid,uuid,jsonb,text[])'::regprocedure);
  if (length(body)-length(replace(body,compile_anchor,'')))/length(compile_anchor)<>1
    or strpos(body,'knowledge_lineage_current_v1')>0 then
    raise exception 'context_pack_compile_definition_mismatch';
  end if;
  execute replace(body,compile_anchor,compile_new);
end $migration$;

-- ---------------------------------------------------------------------------
-- 7. Evidence withdrawal (Native two-step; receipt-core family evidence_withdraw)
-- ---------------------------------------------------------------------------

-- The confirmation view: the Evidence descriptor, the CAS base and the
-- reason. The fan-out set is deliberately not digested (a Binding write
-- would otherwise make every token stale); it is computed under locks at
-- consume time. NULL when the Evidence is not the user's.
create function clued_private.evidence_withdrawal_view_v1(
  p_user_id uuid,p_evidence_id uuid,p_base_version bigint,p_reason text
) returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('action','evidence_withdraw',
    'evidence',jsonb_build_object('id',e.id,'evidence_type',e.evidence_type,'content_hash',e.content_hash,
      'size_bytes',e.size_bytes,'mime_type',e.mime_type,'storage_ref',e.storage_ref,'recorded_at',e.recorded_at),
    'base_version',p_base_version,'reason',p_reason)
  from public.clued_evidence e where e.user_id=p_user_id and e.id=p_evidence_id
$$;

-- The dependents of one Evidence (contract 6.4): current Records of any
-- type and writer citing it, pending candidates citing it (or, for
-- knowledge, citing such a Record) and live lineage over those versions.
-- Expired-but-pending candidates are included. Compares ids as text: no
-- cast of agent-writable candidate JSON.
create function clued_private.evidence_withdrawal_effects_v1(p_user_id uuid,p_evidence_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_records jsonb; v_ids text[];
begin
  select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'version',m.version) order by m.id),'[]'::jsonb),
      coalesce(array_agg(m.id::text order by m.id),'{}'::text[])
    into v_records,v_ids
    from public.clued_memories m where m.user_id=p_user_id and p_evidence_id=any(m.source_refs);
  return jsonb_build_object('records',v_records,
    'information_candidates',(select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'version',c.version)
        order by c.id),'[]'::jsonb)
      from clued_private.information_candidates c
      where c.user_id=p_user_id and c.status='pending' and p_evidence_id=any(c.evidence_ids)),
    'knowledge_candidates',(select coalesce(jsonb_agg(jsonb_build_object('id',k.id,'version',k.version)
        order by k.id),'[]'::jsonb)
      from clued_private.knowledge_candidates k
      where k.user_id=p_user_id and k.status='pending'
        and (p_evidence_id=any(k.evidence_ids) or exists(select 1 from jsonb_array_elements(
          case when jsonb_typeof(k.sources)='array' then k.sources else '[]'::jsonb end) s
          where jsonb_typeof(s)='object' and s->>'id'=any(v_ids)))),
    'knowledge',(select coalesce(jsonb_agg(jsonb_build_object('knowledge_record_id',x.knowledge_record_id,
        'knowledge_version',x.knowledge_version) order by x.knowledge_record_id,x.knowledge_version),'[]'::jsonb)
      from (select distinct l.knowledge_record_id,l.knowledge_version from clued_private.knowledge_lineage l
        join public.clued_memories m on m.user_id=p_user_id and p_evidence_id=any(m.source_refs)
         and ((m.id=l.source_record_id and m.version=l.source_version)
           or (m.id=l.knowledge_record_id and m.version=l.knowledge_version))
        where l.user_id=p_user_id and not l.lineage_stale) x));
end $$;

-- Step 1: issue a single-use token bound to user, action, Evidence id, base
-- version, session and the view digest. No Receipt: issuing is not a
-- Canonical write; the token row (hash only) is the audit.
create function clued_private.evidence_withdrawal_confirmation_issue_core_v1(p_user_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_evidence uuid; v_base bigint; v_reason text; v_existing clued_private.evidence_withdrawals%rowtype;
  v_view jsonb; v_digest text; v_raw text; v_token_id uuid; v_expires timestamptz;
  v_auth_time timestamptz:=clued_private.native_auth_time_v1(); v_now timestamptz; v_error text;
begin
  if v_auth_time is null or v_auth_time<clock_timestamp()-interval '15 minutes' then
    return jsonb_build_object('status','rejected','error_code','reauthentication_required','authoritative',false);
  end if;
  begin
    if exists(select 1 from jsonb_object_keys(p_input) k where k not in ('evidence_id','base_version','reason')) then
      raise exception 'evidence_withdrawal_confirmation_unknown_field' using errcode='22023';
    end if;
    if jsonb_typeof(p_input->'evidence_id') is distinct from 'string'
      or (p_input->>'evidence_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or not clued_private.context_policy_uint_v1(p_input->'base_version',0,1000000000) then
      raise exception 'invalid_evidence_withdrawal_input' using errcode='22023';
    end if;
    if not clued_private.intake_is_str_v1(p_input->'reason',1,1000) or btrim(p_input->>'reason')='' then
      raise exception 'evidence_withdrawal_reason_required' using errcode='22023';
    end if;
    v_evidence:=(p_input->>'evidence_id')::uuid;
    v_base:=(p_input->>'base_version')::bigint;
    v_reason:=p_input->>'reason';
    -- A foreign user's Evidence is invisible.
    if not exists(select 1 from public.clued_evidence e where e.user_id=p_user_id and e.id=v_evidence) then
      raise exception 'evidence_not_found' using errcode='P0002';
    end if;
    -- Lock order: currentness (entry) -> withdrawal lock -> withdrawal row -> token.
    perform clued_private.evidence_withdrawal_lock_v1(p_user_id,false);
    select * into v_existing from clued_private.evidence_withdrawals w
      where w.user_id=p_user_id and w.evidence_id=v_evidence for update;
    if v_existing.id is not null and v_base=v_existing.version then
      raise exception 'evidence_already_withdrawn' using errcode='55000';
    elsif coalesce(v_existing.version,0)<>v_base then
      raise exception 'evidence_withdrawal_version_conflict' using errcode='40001';
    end if;
    v_view:=clued_private.evidence_withdrawal_view_v1(p_user_id,v_evidence,v_base,v_reason);
    v_digest:=clued_private.m1_sha256(v_view);
    update clued_private.native_confirmation_tokens set revoked_at=clock_timestamp()
      where user_id=p_user_id and action='evidence_withdraw' and subject_key=v_evidence::text
        and consumed_at is null and revoked_at is null;
    v_raw:='clued_cwt_'||encode(extensions.gen_random_bytes(32),'hex');
    v_now:=clock_timestamp();
    insert into clued_private.native_confirmation_tokens(user_id,action,subject_key,subject_version,native_choices,
      confirmation_view,view_digest,token_hash,session_id,auth_time,issued_at,expires_at)
    values(p_user_id,'evidence_withdraw',v_evidence::text,v_base,jsonb_build_object('reason',v_reason),v_view,v_digest,
      encode(extensions.digest(convert_to(v_raw,'UTF8'),'sha256'),'hex'),
      nullif(auth.jwt()->>'session_id',''),v_auth_time,v_now,v_now+interval '5 minutes')
    returning id,expires_at into v_token_id,v_expires;
    return jsonb_build_object('status','issued','confirmation_token',v_raw,'token_id',v_token_id,
      'expires_at',v_expires,'evidence_id',v_evidence,'base_version',v_base,'confirmation_view',v_view,
      'view_digest',v_digest,'authoritative',false,
      -- Informational only; not digested. The fan-out is computed at consume.
      -- Each list is capped at 100 entries; counts are always complete.
      'effects_preview',(select jsonb_object_agg(e.k,(select coalesce(jsonb_agg(v order by o),'[]'::jsonb)
          from jsonb_array_elements(e.v) with ordinality a(v,o) where o<=100))
        ||jsonb_build_object('counts',jsonb_object_agg(e.k,jsonb_array_length(e.v)),
          'truncated',bool_or(jsonb_array_length(e.v)>100))
        from jsonb_each(clued_private.evidence_withdrawal_effects_v1(p_user_id,v_evidence)) e(k,v)));
  exception when sqlstate '22023' or sqlstate '23514' or sqlstate '40001' or sqlstate '42501'
      or sqlstate 'P0002' or sqlstate '55000' then
    get stacked diagnostics v_error=message_text;
    return jsonb_build_object('status','rejected','error_code',v_error,'authoritative',false);
  end;
end $$;

-- Step 2: consume the token and withdraw in one transaction: the withdrawal
-- row, dependent candidates -> conflict, manifest stale flags, the
-- record_evidence_status flags (whose trigger flags lineage), the audit-only
-- Event and the Receipt. No Record and no Evidence row is written.
create function clued_private.evidence_withdraw_core_v1(
  p_user_id uuid,p_input jsonb,p_received_payload_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts%rowtype; v_token clued_private.native_confirmation_tokens%rowtype;
  v_token_id uuid; v_evidence uuid; v_base bigint; v_existing clued_private.evidence_withdrawals%rowtype;
  v_ev public.clued_evidence%rowtype; v_view jsonb; v_effects jsonb; v_withdrawal_id uuid:=gen_random_uuid();
  v_record_ids text[]; v_candidates jsonb:='[]'; v_x record; v_version integer;
  v_base_versions jsonb; v_committed jsonb; v_stale integer; v_ids text[]; v_refs jsonb; v_event_id text;
  v_cand_base jsonb; v_fanout jsonb; v_cap integer:=100;
  v_result jsonb; v_error text; v_state text;
begin
  v_receipt:=clued_private.m1_begin_receipt(p_user_id,null,'evidence_withdraw',p_input,p_received_payload_hash);
  if v_receipt.status<>'pending' then
    -- Single use also covers an idempotency rejection (S3 D4).
    if v_receipt.status='rejected' and v_receipt.error_code in ('IDEMPOTENCY_KEY_CONFLICT','REQUEST_HASH_MISMATCH')
        and jsonb_typeof(p_input->'confirmation_token')='string' then
      update clued_private.native_confirmation_tokens set consumed_at=clock_timestamp(),
          consumed_receipt_id=v_receipt.id,consume_outcome='rejected'
        where user_id=p_user_id and action='evidence_withdraw'
          and token_hash=encode(extensions.digest(convert_to(p_input->>'confirmation_token','UTF8'),'sha256'),'hex')
          and consumed_at is null and revoked_at is null;
    end if;
    return coalesce(v_receipt.canonical_result,clued_private.m1_result_envelope(v_receipt))
      ||jsonb_build_object('replayed',v_receipt.related_receipt_id is null);
  end if;
  begin
    -- Single use: locate a presented live token before any shape check, so
    -- a malformed request also burns it (the handler below).
    if jsonb_typeof(p_input->'confirmation_token')='string' then
      select t.id into v_token_id from clued_private.native_confirmation_tokens t
        where t.user_id=p_user_id and t.action='evidence_withdraw'
          and t.token_hash=encode(extensions.digest(convert_to(p_input->>'confirmation_token','UTF8'),'sha256'),'hex');
    end if;
    if exists(select 1 from jsonb_object_keys(p_input) k where k not in
        ('idempotency_key','request_hash','evidence_id','base_version','confirmation_token','view_digest')) then
      raise exception 'evidence_withdraw_unknown_field' using errcode='22023';
    end if;
    if jsonb_typeof(p_input->'evidence_id') is distinct from 'string'
      or (p_input->>'evidence_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or not clued_private.context_policy_uint_v1(p_input->'base_version',0,1000000000)
      or coalesce(p_input->>'view_digest','') !~ '^[0-9a-f]{64}$' then
      raise exception 'invalid_evidence_withdrawal_input' using errcode='22023';
    end if;
    if jsonb_typeof(p_input->'confirmation_token') is distinct from 'string' then
      raise exception 'confirmation_token_required' using errcode='42501';
    end if;
    v_evidence:=(p_input->>'evidence_id')::uuid;
    v_base:=(p_input->>'base_version')::bigint;
    -- Lock order: currentness (entry) -> Receipt -> withdrawal lock ->
    -- withdrawal row -> token -> candidates (id order) -> candidate tokens ->
    -- manifests (id order) -> record_evidence_status -> lineage.
    perform clued_private.evidence_withdrawal_lock_v1(p_user_id,false);
    select * into v_existing from clued_private.evidence_withdrawals w
      where w.user_id=p_user_id and w.evidence_id=v_evidence for update;
    select * into v_token from clued_private.native_confirmation_tokens t
      where t.user_id=p_user_id
        and t.token_hash=encode(extensions.digest(convert_to(p_input->>'confirmation_token','UTF8'),'sha256'),'hex')
      for update;
    if not found then raise exception 'confirmation_token_invalid' using errcode='42501'; end if;
    v_token_id:=v_token.id;
    if v_token.consumed_at is not null then raise exception 'confirmation_token_reused' using errcode='42501'; end if;
    if v_token.revoked_at is not null then raise exception 'confirmation_token_revoked' using errcode='42501'; end if;
    if v_token.expires_at<=clock_timestamp() then raise exception 'confirmation_token_expired' using errcode='42501'; end if;
    if v_token.issued_xact=pg_current_xact_id() then
      raise exception 'confirmation_token_same_request' using errcode='42501';
    end if;
    if v_token.action<>'evidence_withdraw' or v_token.subject_key<>v_evidence::text
      or v_token.subject_version<>v_base or v_token.view_digest<>p_input->>'view_digest'
      or v_token.session_id is distinct from nullif(auth.jwt()->>'session_id','') then
      raise exception 'confirmation_token_binding_mismatch' using errcode='42501';
    end if;
    if not clued_private.native_session_fresh_v1() then
      raise exception 'reauthentication_required' using errcode='42501';
    end if;
    if v_existing.id is not null and v_base=v_existing.version then
      raise exception 'evidence_already_withdrawn' using errcode='55000';
    elsif coalesce(v_existing.version,0)<>v_base then
      raise exception 'evidence_withdrawal_version_conflict' using errcode='40001';
    end if;
    select * into v_ev from public.clued_evidence e where e.user_id=p_user_id and e.id=v_evidence;
    if not found then raise exception 'evidence_not_found' using errcode='P0002'; end if;
    -- Recompute the view from the token's stored choices: any drift in the
    -- Evidence descriptor makes the confirmed view stale.
    v_view:=clued_private.evidence_withdrawal_view_v1(p_user_id,v_evidence,v_base,v_token.native_choices->>'reason');
    if v_view is null or clued_private.m1_sha256(v_view)<>v_token.view_digest then
      raise exception 'confirmation_view_stale' using errcode='40001';
    end if;

    -- Lock the dependent pending candidates (id order), then compute the
    -- fan-out under the locks. New knowledge proposals wait on the
    -- withdrawal lock; Information candidates only cite their own
    -- submission's new Evidence.
    select coalesce(array_agg(m.id::text order by m.id),'{}'::text[]) into v_record_ids
      from public.clued_memories m where m.user_id=p_user_id and v_evidence=any(m.source_refs);
    perform 1 from clued_private.information_candidates c
      where c.user_id=p_user_id and c.status='pending' and v_evidence=any(c.evidence_ids)
      order by c.id for update;
    perform 1 from clued_private.knowledge_candidates k
      where k.user_id=p_user_id and k.status='pending'
        and (v_evidence=any(k.evidence_ids) or exists(select 1 from jsonb_array_elements(
          case when jsonb_typeof(k.sources)='array' then k.sources else '[]'::jsonb end) s
          where jsonb_typeof(s)='object' and s->>'id'=any(v_record_ids)))
      order by k.id for update;
    v_effects:=clued_private.evidence_withdrawal_effects_v1(p_user_id,v_evidence);

    -- The fan-out itself is uncapped. Audit surfaces (the withdrawal row, the
    -- Event and the Receipt) carry only counts and sha256 digests of each
    -- sorted list; only the caller's supplemental echoes (capped) lists.
    select coalesce(jsonb_agg(c order by c->>'tier',c->>'id'),'[]'::jsonb) into v_cand_base from (
      select jsonb_build_object('tier','information','id',x->>'id','version',(x->>'version')::integer) c
        from jsonb_array_elements(v_effects->'information_candidates') x
      union all select jsonb_build_object('tier','knowledge','id',x->>'id','version',(x->>'version')::integer)
        from jsonb_array_elements(v_effects->'knowledge_candidates') x) y;
    v_fanout:=jsonb_build_object(
      'records',jsonb_build_object('count',jsonb_array_length(v_effects->'records'),
        'digest',clued_private.m1_sha256(v_effects->'records')),
      'candidates',jsonb_build_object('count',jsonb_array_length(v_cand_base),
        'information',jsonb_array_length(v_effects->'information_candidates'),
        'knowledge',jsonb_array_length(v_effects->'knowledge_candidates'),
        'digest',clued_private.m1_sha256(v_cand_base)),
      'knowledge',jsonb_build_object('count',jsonb_array_length(v_effects->'knowledge'),
        'digest',clued_private.m1_sha256(v_effects->'knowledge')));
    insert into clued_private.evidence_withdrawals(id,user_id,evidence_id,reason,evidence_content_hash,
      withdrawn_receipt_id,token_id,withdrawn_session_id,fanout)
    values(v_withdrawal_id,p_user_id,v_evidence,v_token.native_choices->>'reason',v_ev.content_hash,v_receipt.id,
      v_token.id,nullif(auth.jwt()->>'session_id',''),v_fanout);
    -- The Receipt carries the withdrawal-row CAS only; each candidate's
    -- row-version CAS is its candidate_transitions row bound to this Receipt.
    v_base_versions:=jsonb_build_object('evidence_withdrawal:'||v_evidence::text,0);
    v_committed:=jsonb_build_object('evidence_withdrawal:'||v_evidence::text,1);

    -- Dependent candidates -> conflict (S3 transition: row-version bump,
    -- transition row bound to this Receipt), and their live tokens revoked.
    for v_x in select 'information' tier,(c->>'id')::uuid id,(c->>'version')::integer version
        from jsonb_array_elements(v_effects->'information_candidates') c
      union all select 'knowledge',(c->>'id')::uuid,(c->>'version')::integer
        from jsonb_array_elements(v_effects->'knowledge_candidates') c
      order by 1,2 loop
      v_version:=clued_private.candidate_transition_v1(p_user_id,v_x.tier,v_x.id,'conflict',v_receipt.id,null,null);
      update clued_private.candidate_confirmation_tokens set revoked_at=clock_timestamp()
        where candidate_tier=v_x.tier and candidate_id=v_x.id and consumed_at is null and revoked_at is null;
      v_candidates:=v_candidates||jsonb_build_array(jsonb_build_object('tier',v_x.tier,'id',v_x.id,'version',v_version));
    end loop;

    -- Manifests first, so the stale reason is deterministic.
    v_ids:=v_record_ids
      ||array(select c->>'id' from jsonb_array_elements(v_candidates) c)
      ||array(select k->>'knowledge_record_id' from jsonb_array_elements(v_effects->'knowledge') k);
    v_stale:=clued_private.pack_manifest_stale_v1(p_user_id,v_ids,'evidence_withdrawn',false);

    -- Flag every current Record version citing the Evidence; the insert
    -- trigger flags lineage (source_evidence_withdrawn / evidence_withdrawn).
    insert into clued_private.record_evidence_status(user_id,record_id,record_version,evidence_id,withdrawal_id,
      flagged_by,flagged_receipt_id)
    select p_user_id,(r->>'id')::uuid,(r->>'version')::bigint,v_evidence,v_withdrawal_id,'withdrawal',v_receipt.id
      from jsonb_array_elements(v_effects->'records') r
    on conflict do nothing;

    update clued_private.native_confirmation_tokens set consumed_at=clock_timestamp(),
      consumed_receipt_id=v_receipt.id,consume_outcome='committed' where id=v_token.id;
    -- System and Evidence refs only: Record refs on an audit Event could
    -- reach Currentness.
    v_fanout:=v_fanout||jsonb_build_object('stale_manifests',v_stale);
    v_refs:=jsonb_build_array(
      jsonb_build_object('role','primary','kind','system','id','evidence_withdrawal:'||v_withdrawal_id::text),
      jsonb_build_object('role','evidence','kind','evidence','id',v_evidence::text),
      -- Binds the Receipt to the Event's fan-out summary.
      jsonb_build_object('role','target','kind','system',
        'id','evidence_withdrawal_fanout:'||clued_private.m1_sha256(v_fanout)));
    v_event_id:=clued_private.m1_append_event_row(p_user_id,null,v_receipt.id,v_receipt.canonical_version,
      'extension:information_flow:evidence_withdrawn',v_refs,'global',null,
      jsonb_build_object('evidence_id',v_evidence,'withdrawal_id',v_withdrawal_id,'token_id',v_token.id,
        'fanout',v_fanout),
      'evidence_withdraw:'||(p_input->>'idempotency_key'),v_receipt.request_sha256,'success','audit_only',
      array[v_evidence],'[]',null);
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,'committed',v_refs,v_base_versions,v_committed,
      array[v_event_id],array[v_evidence],null);
    return v_result||jsonb_build_object('replayed',false,'supplemental',jsonb_build_object(
      'outcome','withdrawn','evidence_id',v_evidence,'withdrawal_id',v_withdrawal_id,'withdrawal_version',1,
      'fanout',v_fanout,
      -- Echoed lists are capped; the totals and digests are in fanout.
      'conflicted_candidates',(select coalesce(jsonb_agg(c order by o),'[]'::jsonb)
        from jsonb_array_elements(v_candidates) with ordinality a(c,o) where o<=v_cap),
      'flagged_records',(select coalesce(jsonb_agg(c order by o),'[]'::jsonb)
        from jsonb_array_elements(v_effects->'records') with ordinality a(c,o) where o<=v_cap),
      'stale_lineage',(select coalesce(jsonb_agg(c order by o),'[]'::jsonb)
        from jsonb_array_elements(v_effects->'knowledge') with ordinality a(c,o) where o<=v_cap),
      'list_cap',v_cap,
      'truncated',greatest(jsonb_array_length(v_candidates),jsonb_array_length(v_effects->'records'),
        jsonb_array_length(v_effects->'knowledge'))>v_cap,
      'stale_manifests',v_stale));
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    -- Single use: any attempt that presented a live token burns it. The
    -- block's subtransaction has rolled back, so this update persists.
    if v_token_id is not null and v_error not in ('confirmation_token_reused','confirmation_token_revoked') then
      update clued_private.native_confirmation_tokens set consumed_at=clock_timestamp(),
        consumed_receipt_id=v_receipt.id,consume_outcome='rejected'
        where id=v_token_id and consumed_at is null and revoked_at is null;
    end if;
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,
      case when v_state in ('22023','23505','23514','40001','42501','P0002','55000') then 'rejected' else 'failed' end,
      '[]','{}','{}','{}','{}',v_error);
    return v_result||jsonb_build_object('replayed',false);
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Revokes
-- ---------------------------------------------------------------------------
revoke all on function clued_private.invalidation_row_immutable_v1(),
  clued_private.knowledge_lineage_guard_v1(),
  clued_private.record_evidence_unflagged_v1(uuid,uuid,bigint),
  clued_private.knowledge_lineage_current_v1(uuid,uuid,bigint),
  clued_private.evidence_withdrawal_lock_v1(uuid,boolean),
  clued_private.pack_manifest_mark_stale_v1(uuid[],text,boolean),
  clued_private.pack_manifest_stale_v1(uuid,text[],text,boolean),
  clued_private.pack_manifest_binding_stale_v1(uuid,boolean),
  clued_private.knowledge_lineage_seed_v1(),
  clued_private.record_source_change_v1(),
  clued_private.knowledge_lineage_evidence_flag_v1(),
  clued_private.knowledge_lineage_manifest_stale_v1(),
  clued_private.record_evidence_status_on_write_v1(),
  clued_private.pack_manifest_binding_change_v1(),
  clued_private.pack_manifest_authorization_change_v1(),
  clued_private.evidence_withdrawal_view_v1(uuid,uuid,bigint,text),
  clued_private.evidence_withdrawal_effects_v1(uuid,uuid),
  clued_private.evidence_withdrawal_confirmation_issue_core_v1(uuid,jsonb),
  clued_private.evidence_withdraw_core_v1(uuid,jsonb,text)
  from public,anon,authenticated,service_role;

-- ---------------------------------------------------------------------------
-- 9. Native account-session entries (never an MCP tool, OAuth case or Binding)
-- ---------------------------------------------------------------------------
create function public.clued_evidence_withdrawal_confirmation_issue_v1(p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12();
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if jsonb_typeof(p_input) is distinct from 'object' then
    raise exception 'invalid_evidence_withdrawal_input' using errcode='22023';
  end if;
  -- Same lock order as the withdrawal: currentness -> withdrawal -> token.
  perform clued_private.currentness_user_lock(v_owner);
  return clued_private.evidence_withdrawal_confirmation_issue_core_v1(v_owner,p_input);
end $$;

create function public.clued_evidence_withdraw_v1(p_input jsonb,p_received_payload_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12();
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if jsonb_typeof(p_input) is distinct from 'object' then
    raise exception 'invalid_evidence_withdrawal_input' using errcode='22023';
  end if;
  -- First, as in the M1 wrapper: currentness -> receipt -> rows.
  perform clued_private.currentness_user_lock(v_owner);
  return clued_private.evidence_withdraw_core_v1(v_owner,p_input,p_received_payload_hash);
end $$;

revoke all on function public.clued_evidence_withdrawal_confirmation_issue_v1(jsonb),
  public.clued_evidence_withdraw_v1(jsonb,text)
  from public,anon,service_role;
grant execute on function public.clued_evidence_withdrawal_confirmation_issue_v1(jsonb),
  public.clued_evidence_withdraw_v1(jsonb,text)
  to authenticated;

notify pgrst,'reload schema';
